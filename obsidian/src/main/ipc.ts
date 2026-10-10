import { app, BrowserWindow, clipboard, dialog, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { InvokeChannel, InvokeMap, SendChannel } from '../shared/api';
import type { ClaudeInfo, Project, Result, SessionInfo, SessionRecord, Settings } from '../shared/types';
import { AgentPoller, fetchLiveAgents, listAgentDefinitions } from './claude/agents';
import { detectClaude, isExecutableFile, lastClaudeInfo } from './claude/detect';
import { SessionManager } from './claude/sessions';
import { listHistory } from './claude/transcript';
import { listDir, ProjectWatcher, readFile, resolveInside, search } from './fs/files';
import * as git from './git/git';
import type { Store } from './store';
import * as v from './validate';

export interface Context {
  store: Store;
  window: () => BrowserWindow | null;
  isTrustedSender: (e: IpcMainEvent | IpcMainInvokeEvent) => boolean;
  onShortcutsChanged: (s: Settings) => void;
}

export interface Services {
  sessions: SessionManager;
  poller: AgentPoller;
  watcher: ProjectWatcher;
  claudeInfo: () => ClaudeInfo | null;
}

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const err = (e: unknown): Result<never> => ({ ok: false, error: e instanceof Error ? e.message : String(e) });

export function registerIpc(ctx: Context): Services {
  const { store } = ctx;
  let windowVisible = true;

  const send = (channel: string, ...args: unknown[]) => {
    const w = ctx.window();
    if (w && !w.isDestroyed()) w.webContents.send(channel, ...args);
  };

  const project = (projectId: unknown): Project => {
    const pid = v.id(projectId, 'projectId');
    const p = store.get('projects').find((x) => x.id === pid);
    if (!p) throw new v.ValidationError('Unknown project');
    return p;
  };

  const upsertRecord = (info: SessionInfo, title?: string | null) => {
    if (!info.claudeSessionId) return;
    const records = store.get('sessions').slice();
    const i = records.findIndex((r) => r.claudeSessionId === info.claudeSessionId);
    const now = Date.now();
    const base: SessionRecord =
      i >= 0
        ? records[i]
        : { claudeSessionId: info.claudeSessionId, projectId: info.projectId, title: info.title, createdAt: now, lastActiveAt: now, requestedModel: info.requestedModel };
    const next = { ...base, lastActiveAt: now, title: title || base.title };
    if (i >= 0) records[i] = next;
    else records.unshift(next);
    store.set('sessions', records.sort((a, b) => b.lastActiveAt - a.lastActiveAt).slice(0, 300));
  };

  const recordTouch = new Map<string, number>();
  const sessions = new SessionManager(
    {
      data: (id, data) => send('session:data', id, data),
      update: (info) => send('session:update', info),
      insight: (ins) => {
        send('session:insight', ins);
        const info = sessions.get(ins.sessionId);
        const title = sessions.transcriptTitle(ins.sessionId);
        const last = recordTouch.get(ins.sessionId) ?? 0;
        if (info && Date.now() - last > 30000) {
          recordTouch.set(ins.sessionId, Date.now());
          upsertRecord(info, title);
        }
      },
      claudeSessionKnown: (info) => upsertRecord(info),
    },
    app.getVersion(),
    () => lastClaudeInfo()?.projectsDirectory ?? null,
  );

  const poller = new AgentPoller(
    () => windowVisible && store.get('settings').liveStatusPolling && sessions.hasRunningClaude() && !!lastClaudeInfo()?.capabilities?.agentsJson,
    () => lastClaudeInfo()?.path ?? null,
    (agents) => {
      if (agents) sessions.applyLiveAgents(agents);
      send('agents:update', agents);
    },
  );

  const watcher = new ProjectWatcher((change) => send('project:changed', change));

  const detect = (force: boolean) => detectClaude(store.get('settings').claudePath, force);

  type Handler<C extends InvokeChannel> = (...args: InvokeMap[C][0]) => InvokeMap[C][1] | Promise<InvokeMap[C][1]>;
  function handle<C extends InvokeChannel>(channel: C, fn: Handler<C>) {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (!ctx.isTrustedSender(event)) throw new Error('Untrusted sender');
      return (fn as (...a: unknown[]) => unknown)(...args);
    });
  }
  function on(channel: SendChannel, fn: (...args: unknown[]) => void) {
    ipcMain.on(channel, (event, ...args) => {
      if (!ctx.isTrustedSender(event)) return;
      try {
        fn(...args);
      } catch {
        // malformed fire-and-forget message: drop it
      }
    });
  }

  // ── app ────────────────────────────────────────────────────────────────
  handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    electron: process.versions.electron,
    userDataPath: app.getPath('userData'),
  }));
  handle('app:revealUserData', () => shell.showItemInFolder(path.join(app.getPath('userData'), 'settings.json')));

  // ── claude ─────────────────────────────────────────────────────────────
  handle('claude:detect', (force) => detect(v.bool(force, 'force')));
  handle('claude:chooseExecutable', async () => {
    const w = ctx.window();
    const res = await dialog.showOpenDialog(w!, {
      title: 'Locate the Claude Code executable',
      defaultPath: path.join(os.homedir(), '.local', 'bin'),
      properties: ['openFile', 'showHiddenFiles', 'treatPackageAsDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return detect(false);
    const chosen = res.filePaths[0];
    if (!isExecutableFile(chosen)) {
      await dialog.showMessageBox(w!, { type: 'error', message: 'That file is not executable.', detail: chosen });
      return detect(false);
    }
    store.set('settings', { ...store.get('settings'), claudePath: chosen });
    return detect(true);
  });
  handle('claude:resetExecutable', () => {
    store.set('settings', { ...store.get('settings'), claudePath: null });
    return detect(true);
  });
  handle('claude:liveAgents', async () => {
    const info = lastClaudeInfo();
    if (!info?.capabilities?.agentsJson || !info.path) return null;
    const agents = await fetchLiveAgents(info.path);
    if (agents) sessions.applyLiveAgents(agents);
    return agents;
  });
  handle('claude:history', (projectId) => {
    const p = project(projectId);
    const dir = lastClaudeInfo()?.projectsDirectory;
    if (!dir) return [];
    const ids = new Set(store.get('sessions').map((r) => r.claudeSessionId));
    return listHistory(dir, p.root, ids);
  });
  handle('claude:agentDefinitions', (projectId) => listAgentDefinitions(projectId === null ? null : project(projectId).root));

  // ── projects ───────────────────────────────────────────────────────────
  handle('projects:list', () => store.get('projects'));
  handle('projects:add', async () => {
    const w = ctx.window();
    const res = await dialog.showOpenDialog(w!, {
      title: 'Open a project folder',
      defaultPath: store.get('settings').defaultProjectDir ?? os.homedir(),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    const root = res.filePaths[0];
    const projects = store.get('projects').slice();
    const existing = projects.find((p) => p.root === root);
    const now = Date.now();
    if (existing) {
      existing.lastOpenedAt = now;
      store.set('projects', projects);
      return existing;
    }
    const created: Project = { id: randomUUID().replace(/-/g, '').slice(0, 12), name: path.basename(root) || root, root, addedAt: now, lastOpenedAt: now };
    store.set('projects', [created, ...projects]);
    return created;
  });
  handle('projects:remove', (projectId) => {
    const pid = v.id(projectId, 'projectId');
    watcher.unwatch(pid);
    const next = store.get('projects').filter((p) => p.id !== pid);
    store.set('projects', next);
    return next;
  });
  handle('projects:touch', (projectId) => {
    const p = project(projectId);
    store.set('projects', store.get('projects').map((x) => (x.id === p.id ? { ...x, lastOpenedAt: Date.now() } : x)));
    watcher.watch(p.id, p.root);
  });
  handle('projects:reveal', (projectId, rel) => {
    const p = project(projectId);
    shell.showItemInFolder(resolveInside(p.root, v.relPath(rel)));
  });

  // ── filesystem ─────────────────────────────────────────────────────────
  handle('fs:list', (projectId, rel) => {
    try {
      return ok(listDir(project(projectId).root, v.relPath(rel)));
    } catch (e) {
      return err(e);
    }
  });
  handle('fs:read', (projectId, rel) => {
    try {
      return ok(readFile(project(projectId).root, v.relPath(rel)));
    } catch (e) {
      return err(e);
    }
  });
  handle('fs:search', (projectId, query) => search(project(projectId).root, v.str(query, 'query', 200)));

  // ── git ────────────────────────────────────────────────────────────────
  handle('git:status', (projectId) => git.status(project(projectId).root));
  handle('git:log', (projectId) => git.log(project(projectId).root));
  handle('git:diff', async (projectId, file, staged) => {
    try {
      const p = project(projectId);
      const rel = v.relPath(file);
      const st = await git.status(p.root);
      const change = st.files.find((f) => f.path === rel);
      return ok(await git.diff(p.root, rel, v.bool(staged, 'staged'), !!change?.untracked));
    } catch (e) {
      return err(e);
    }
  });
  handle('git:stage', async (projectId, paths) => {
    try {
      await git.stage(project(projectId).root, v.pathList(paths));
      return ok(null);
    } catch (e) {
      return err(e);
    }
  });
  handle('git:unstage', async (projectId, paths) => {
    try {
      await git.unstage(project(projectId).root, v.pathList(paths));
      return ok(null);
    } catch (e) {
      return err(e);
    }
  });
  handle('git:discard', async (projectId, paths) => {
    try {
      const p = project(projectId);
      const list = v.pathList(paths);
      const st = await git.status(p.root);
      const untracked = list.filter((x) => st.files.find((f) => f.path === x)?.untracked);
      if (untracked.length) throw new Error('OBSIDIAN never deletes untracked files. Remove them in Finder if you really want them gone.');
      // Confirmation is shown by the main process so it cannot be skipped by the renderer.
      const w = ctx.window();
      const choice = await dialog.showMessageBox(w!, {
        type: 'warning',
        buttons: ['Discard Changes', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: `Discard uncommitted changes in ${list.length === 1 ? list[0] : `${list.length} files`}?`,
        detail: `This restores the working-tree copy from the index and cannot be undone.\n\n${list.slice(0, 15).join('\n')}${list.length > 15 ? '\n…' : ''}`,
      });
      if (choice.response !== 0) return err(new Error('Cancelled'));
      await git.discard(p.root, list);
      return ok(null);
    } catch (e) {
      return err(e);
    }
  });
  handle('git:commit', async (projectId, message) => {
    try {
      return ok(await git.commit(project(projectId).root, v.commitMessage(message)));
    } catch (e) {
      return err(e);
    }
  });

  // ── sessions ───────────────────────────────────────────────────────────
  handle('session:create', async (rawSpec) => {
    const spec = v.sessionSpec(rawSpec);
    const p = project(spec.projectId);
    const info = spec.kind === 'claude' ? await detect(false) : (lastClaudeInfo() ?? (await detect(false)));
    const created = sessions.create(spec, p, info);
    watcher.watch(p.id, p.root);
    if (created.kind === 'claude' && created.state === 'running') poller.kick();
    return created;
  });
  handle('session:list', () => sessions.list());
  handle('session:kill', (id) => sessions.kill(v.id(id)));
  handle('session:dispose', (id) => sessions.dispose(v.id(id)));
  handle('session:records', (projectId) => {
    const all = store.get('sessions');
    return projectId === null ? all : all.filter((r) => r.projectId === v.id(projectId, 'projectId'));
  });
  handle('session:forgetRecord', (claudeSessionId) => {
    const sid = v.uuid(claudeSessionId);
    store.set('sessions', store.get('sessions').filter((r) => r.claudeSessionId !== sid));
  });
  handle('session:insight', (id) => sessions.insight(v.id(id)));

  on('session:write', (id, data) => {
    const sid = v.id(id);
    const text = v.str(data, 'data', 1024 * 1024);
    sessions.write(sid, text);
    if (text.includes('\r')) poller.nudge();
  });
  on('session:resize', (id, cols, rows) => sessions.resize(v.id(id), v.int(cols, 'cols', 10, 1000), v.int(rows, 'rows', 4, 500)));
  on('session:ack', (id, n) => sessions.ack(v.id(id), v.int(n, 'ack', 0, 64 * 1024 * 1024)));
  on('app:visibility', (visible) => {
    windowVisible = v.bool(visible, 'visible');
    if (windowVisible && sessions.hasRunningClaude()) poller.kick();
  });

  // ── settings / tasks ───────────────────────────────────────────────────
  handle('settings:get', () => store.get('settings'));
  handle('settings:set', (patch) => {
    const clean = v.settingsPatch(patch);
    const next = { ...store.get('settings'), ...clean };
    store.set('settings', next);
    if (clean.shortcuts) ctx.onShortcutsChanged(next);
    if (clean.liveStatusPolling) poller.kick();
    return next;
  });
  handle('settings:chooseDefaultProjectDir', async () => {
    const res = await dialog.showOpenDialog(ctx.window()!, { title: 'Default project directory', properties: ['openDirectory', 'createDirectory'] });
    if (!res.canceled && res.filePaths[0]) store.set('settings', { ...store.get('settings'), defaultProjectDir: res.filePaths[0] });
    return store.get('settings');
  });
  handle('tasks:list', () => store.get('tasks'));
  handle('tasks:save', (tasks) => {
    const clean = v.tasks(tasks);
    store.set('tasks', clean);
    return clean;
  });

  // ── misc ───────────────────────────────────────────────────────────────
  handle('clipboard:write', (text) => clipboard.writeText(v.str(text, 'text', 10 * 1024 * 1024)));
  handle('shell:openExternal', (url) => shell.openExternal(v.externalUrl(url)));

  return { sessions, poller, watcher, claudeInfo: lastClaudeInfo };
}
