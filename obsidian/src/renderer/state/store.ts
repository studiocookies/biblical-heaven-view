import { create } from 'zustand';
import type {
  ClaudeInfo,
  GitStatus,
  LiveAgent,
  Project,
  SessionInfo,
  SessionSpec,
  Settings,
  Task,
  TranscriptInsight,
} from '../../shared/types';
import { api } from '../lib/api';

export type Nav = 'home' | 'projects' | 'sessions' | 'agents' | 'files' | 'git' | 'settings';
export type RightTab = 'tasks' | 'files' | 'git' | 'context';
export type BottomTab = 'activity' | 'diagnostics' | 'process';

export type Tab =
  | { id: string; type: 'session'; sessionId: string }
  | { id: string; type: 'file'; projectId: string; rel: string }
  | { id: string; type: 'diff'; projectId: string; path: string; staged: boolean };

export interface LogEntry {
  at: number;
  level: 'info' | 'warn' | 'error';
  source: string;
  message: string;
}

export interface Toast {
  id: number;
  level: 'info' | 'warn' | 'error' | 'ok';
  message: string;
}

interface State {
  ready: boolean;
  settings: Settings | null;
  claude: ClaudeInfo | null;
  detecting: boolean;
  projects: Project[];
  activeProjectId: string | null;
  sessions: Record<string, SessionInfo>;
  sessionTitles: Record<string, string>; // from terminal OSC title
  attention: Record<string, boolean>; // bell while not focused
  insights: Record<string, TranscriptInsight>;
  liveAgents: LiveAgent[] | null;
  tabs: Tab[];
  activeTabId: string | null;
  center: 'home' | 'settings' | 'tabs';
  nav: Nav;
  rightTab: RightTab;
  bottomTab: BottomTab;
  git: Record<string, GitStatus>;
  tasks: Task[];
  log: LogEntry[];
  toasts: Toast[];
  paletteOpen: false | 'commands' | 'files';
  findOpen: boolean;
  composerOpen: boolean;
  fsVersion: Record<string, number>; // bumps per project when the watcher reports changes
  changedDirs: Record<string, string[]>;

  // actions
  init(): Promise<void>;
  setSettings(patch: Partial<Settings>): Promise<void>;
  detect(force?: boolean): Promise<ClaudeInfo>;
  addProject(): Promise<Project | null>;
  selectProject(id: string): void;
  removeProject(id: string): Promise<void>;
  startSession(partial: Partial<SessionSpec> & { kind: SessionSpec['kind'] }): Promise<SessionInfo | null>;
  killSession(id: string): Promise<void>;
  closeTab(id: string): Promise<void>;
  activateTab(id: string): void;
  cycleTab(dir: 1 | -1): void;
  openFile(projectId: string, rel: string): void;
  openDiff(projectId: string, path: string, staged: boolean): void;
  refreshGit(projectId?: string | null): Promise<void>;
  saveTasks(tasks: Task[]): Promise<void>;
  addLog(level: LogEntry['level'], source: string, message: string): void;
  toast(level: Toast['level'], message: string): void;
  set(partial: Partial<State>): void;
}

let toastSeq = 1;
/** Terminal size of the active terminal, used for new sessions so the first frame is right. */
export const termSize = { cols: 120, rows: 36 };

export const useStore = create<State>((set, get) => ({
  ready: false,
  settings: null,
  claude: null,
  detecting: false,
  projects: [],
  activeProjectId: null,
  sessions: {},
  sessionTitles: {},
  attention: {},
  insights: {},
  liveAgents: null,
  tabs: [],
  activeTabId: null,
  center: 'home',
  nav: 'home',
  rightTab: 'context',
  bottomTab: 'activity',
  git: {},
  tasks: [],
  log: [],
  toasts: [],
  paletteOpen: false,
  findOpen: false,
  composerOpen: false,
  fsVersion: {},
  changedDirs: {},

  set: (partial) => set(partial),

  async init() {
    const [settings, projects, tasks, sessions] = await Promise.all([
      api.invoke('settings:get'),
      api.invoke('projects:list'),
      api.invoke('tasks:list'),
      api.invoke('session:list'),
    ]);
    const sorted = [...projects].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
    const activeProjectId = sorted[0]?.id ?? null;
    set({
      settings,
      projects,
      tasks,
      activeProjectId,
      sessions: Object.fromEntries(sessions.map((s) => [s.id, s])),
      tabs: sessions.map((s) => ({ id: s.id, type: 'session' as const, sessionId: s.id })),
      ready: true,
    });
    if (activeProjectId) {
      void api.invoke('projects:touch', activeProjectId);
      void get().refreshGit(activeProjectId);
    }
    void get().detect(false);
  },

  async setSettings(patch) {
    try {
      const settings = await api.invoke('settings:set', patch);
      set({ settings });
    } catch (e) {
      get().toast('error', `Could not save setting: ${(e as Error).message}`);
    }
  },

  async detect(force = false) {
    set({ detecting: true });
    try {
      const claude = await api.invoke('claude:detect', force);
      set({ claude });
      if (claude.found) {
        get().addLog('info', 'claude', `Detected Claude Code ${claude.version} at ${claude.path} (${claude.source}); auth: ${claude.auth.state}`);
      } else {
        get().addLog('warn', 'claude', claude.error ?? 'Claude Code not found');
      }
      return claude;
    } finally {
      set({ detecting: false });
    }
  },

  async addProject() {
    const p = await api.invoke('projects:add');
    if (!p) return null;
    const projects = await api.invoke('projects:list');
    set({ projects, activeProjectId: p.id });
    void api.invoke('projects:touch', p.id);
    void get().refreshGit(p.id);
    get().addLog('info', 'project', `Opened ${p.root}`);
    return p;
  },

  selectProject(id) {
    set({ activeProjectId: id });
    void api.invoke('projects:touch', id);
    void get().refreshGit(id);
  },

  async removeProject(id) {
    const projects = await api.invoke('projects:remove', id);
    set((s) => ({ projects, activeProjectId: s.activeProjectId === id ? (projects[0]?.id ?? null) : s.activeProjectId }));
  },

  async startSession(partial) {
    const s = get();
    const projectId = partial.projectId ?? s.activeProjectId;
    if (!projectId) {
      s.toast('warn', 'Open a project first — sessions always run inside a project folder.');
      return null;
    }
    const settings = s.settings!;
    const spec: SessionSpec = {
      kind: partial.kind,
      projectId,
      mode: partial.mode ?? 'new',
      resumeId: partial.resumeId,
      model: partial.kind === 'claude' ? (partial.model ?? (settings.defaultModel || undefined)) : undefined,
      permissionMode: partial.kind === 'claude' ? (partial.permissionMode ?? settings.defaultPermissionMode) : undefined,
      title: partial.title,
      cols: termSize.cols,
      rows: termSize.rows,
    };
    try {
      const info = await api.invoke('session:create', spec);
      set((st) => ({
        sessions: { ...st.sessions, [info.id]: info },
        tabs: [...st.tabs, { id: info.id, type: 'session', sessionId: info.id }],
        activeTabId: info.id,
        center: 'tabs',
      }));
      if (info.state === 'failed') {
        get().addLog('error', 'session', `${info.kind} session failed to start: ${info.error}`);
      } else {
        get().addLog('info', 'session', `Started ${info.kind} (${info.mode}) pid ${info.pid}: ${info.commandLine}`);
      }
      return info;
    } catch (e) {
      get().toast('error', (e as Error).message);
      get().addLog('error', 'session', (e as Error).message);
      return null;
    }
  },

  async killSession(id) {
    await api.invoke('session:kill', id);
    get().addLog('info', 'session', `Sent hang-up to session ${id}`);
  },

  async closeTab(id) {
    const s = get();
    const tab = s.tabs.find((t) => t.id === id);
    if (!tab) return;
    if (tab.type === 'session') {
      const info = s.sessions[tab.sessionId];
      if (info && (info.state === 'running' || info.state === 'starting')) {
        const ok = window.confirm(`End the running ${info.kind === 'claude' ? 'Claude Code' : 'shell'} session "${info.title}"?\n\nThe process will receive SIGHUP. Claude Code conversations stay resumable.`);
        if (!ok) return;
      }
      await api.invoke('session:dispose', tab.sessionId);
    }
    set((st) => {
      const idx = st.tabs.findIndex((t) => t.id === id);
      const tabs = st.tabs.filter((t) => t.id !== id);
      const activeTabId = st.activeTabId === id ? (tabs[Math.min(idx, tabs.length - 1)]?.id ?? null) : st.activeTabId;
      const sessions = { ...st.sessions };
      if (tab.type === 'session') delete sessions[tab.sessionId];
      return { tabs, activeTabId, sessions, center: tabs.length ? st.center : 'home' };
    });
  },

  activateTab(id) {
    set((st) => ({ activeTabId: id, center: 'tabs', attention: { ...st.attention, [id]: false } }));
    const tab = get().tabs.find((t) => t.id === id);
    if (tab?.type === 'session') {
      const info = get().sessions[tab.sessionId];
      if (info && info.projectId !== get().activeProjectId) get().selectProject(info.projectId);
    }
  },

  cycleTab(dir) {
    const { tabs, activeTabId } = get();
    if (!tabs.length) return;
    const i = tabs.findIndex((t) => t.id === activeTabId);
    get().activateTab(tabs[(i + dir + tabs.length) % tabs.length].id);
  },

  openFile(projectId, rel) {
    const id = `file:${projectId}:${rel}`;
    set((st) => ({
      tabs: st.tabs.some((t) => t.id === id) ? st.tabs : [...st.tabs, { id, type: 'file', projectId, rel }],
      activeTabId: id,
      center: 'tabs',
    }));
  },

  openDiff(projectId, path, staged) {
    const id = `diff:${projectId}:${staged ? 'i' : 'w'}:${path}`;
    set((st) => ({
      tabs: st.tabs.some((t) => t.id === id) ? st.tabs : [...st.tabs, { id, type: 'diff', projectId, path, staged }],
      activeTabId: id,
      center: 'tabs',
    }));
  },

  async refreshGit(projectId) {
    const pid = projectId ?? get().activeProjectId;
    if (!pid) return;
    try {
      const st = await api.invoke('git:status', pid);
      set((s) => ({ git: { ...s.git, [pid]: st } }));
    } catch (e) {
      get().addLog('warn', 'git', (e as Error).message);
    }
  },

  async saveTasks(tasks) {
    set({ tasks });
    try {
      await api.invoke('tasks:save', tasks);
    } catch (e) {
      get().toast('error', `Tasks not saved: ${(e as Error).message}`);
    }
  },

  addLog(level, source, message) {
    set((s) => ({ log: [...s.log.slice(-499), { at: Date.now(), level, source, message }] }));
  },

  toast(level, message) {
    const id = toastSeq++;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, level, message }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), level === 'error' ? 7000 : 4000);
  },
}));

export const activeProject = (s: State) => s.projects.find((p) => p.id === s.activeProjectId) ?? null;
export const activeSession = (s: State): SessionInfo | null => {
  const tab = s.tabs.find((t) => t.id === s.activeTabId);
  if (tab?.type === 'session') return s.sessions[tab.sessionId] ?? null;
  // fall back to the most recent session of the active project
  const list = Object.values(s.sessions).filter((x) => x.projectId === s.activeProjectId);
  return list.sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
};
