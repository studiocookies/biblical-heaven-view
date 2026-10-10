import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DiffResult, FileContent, SessionInfo } from '../../shared/types';
import { api, isMac } from '../lib/api';
import { runCommand } from '../lib/commands';
import { parseUnifiedDiff } from '../lib/diff';
import { basename, bytes, duration, shortId } from '../lib/format';
import { formatShortcut } from '../lib/shortcuts';
import { disposeTerminal, ensureTerminal, fitTerminal, focusTerminal, getTerminal, submitToTerminal } from '../lib/terminals';
import { useStore, type Tab } from '../state/store';
import { BottomPanel } from './BottomPanel';
import { ErrorBoundary } from './ErrorBoundary';
import { HomeView } from './Home';
import { Icon } from './Icon';
import { SettingsView } from './Settings';
import { Button, IconButton, Provenance, Resizer } from './ui';

// ── Tab bar ───────────────────────────────────────────────────────────────

function tabLabel(tab: Tab, sessions: Record<string, SessionInfo>, titles: Record<string, string>, insightTitle: (id: string) => string | undefined) {
  if (tab.type === 'session') {
    const s = sessions[tab.sessionId];
    return titles[tab.sessionId] || insightTitle(tab.sessionId) || s?.title || 'Session';
  }
  if (tab.type === 'file') return basename(tab.rel);
  return `Δ ${basename(tab.path)}${tab.staged ? ' (staged)' : ''}`;
}

function TabBar() {
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const center = useStore((s) => s.center);
  const sessions = useStore((s) => s.sessions);
  const titles = useStore((s) => s.sessionTitles);
  const attention = useStore((s) => s.attention);
  const live = useStore((s) => s.liveAgents);
  const claude = useStore((s) => s.claude);
  const shortcuts = useStore((s) => s.settings?.shortcuts);
  const projectId = useStore((s) => s.activeProjectId);
  const { activateTab, closeTab, startSession } = useStore.getState();
  const [menu, setMenu] = useState(false);

  return (
    <div className="tabbar" role="tablist" aria-label="Sessions and documents">
      <div className="tabbar-scroll">
        {tabs.map((t, i) => {
          const active = center === 'tabs' && t.id === activeTabId;
          const s = t.type === 'session' ? sessions[t.sessionId] : null;
          const status = s?.claudeSessionId ? live?.find((a) => a.sessionId === s.claudeSessionId)?.status : undefined;
          const led = s ? (s.state === 'running' ? (status === 'busy' ? 'busy' : 'ok') : s.state === 'failed' ? 'err' : 'off') : null;
          return (
            <div key={t.id} className={`tab ${active ? 'is-active' : ''} ${attention[t.id] ? 'has-attention' : ''}`} role="presentation">
              <button className="tab-main" role="tab" aria-selected={active} onClick={() => activateTab(t.id)} title={i < 9 ? `${formatShortcut('Mod+' + (i + 1), isMac)}` : undefined}>
                {led && <span className="led" data-state={led} />}
                <Icon name={t.type === 'session' ? (s?.kind === 'claude' ? 'claude' : 'terminal') : t.type === 'diff' ? 'diff' : 'file'} size={13} />
                <span className="tab-title">{tabLabel(t, sessions, titles, () => undefined)}</span>
              </button>
              <button className="tab-close" aria-label="Close tab" onClick={() => void closeTab(t.id)}>
                <Icon name="close" size={11} />
              </button>
            </div>
          );
        })}
      </div>
      <div className="tabbar-actions">
        <button
          className="new-tab"
          disabled={!projectId}
          onClick={() => void startSession({ kind: claude?.found ? 'claude' : 'shell' })}
          title={`New ${claude?.found ? 'Claude Code' : 'shell'} session (${formatShortcut(shortcuts?.['session.newClaude'], isMac)})`}
        >
          <Icon name="plus" size={14} />
          <span>{claude?.found ? 'Claude' : 'Shell'}</span>
        </button>
        <div className="menu-anchor">
          <IconButton icon="chevronDown" label="More session types" onClick={() => setMenu((m) => !m)} disabled={!projectId} />
          {menu && (
            <div className="menu" role="menu" onMouseLeave={() => setMenu(false)}>
              {[
                ['session.newClaude', 'New Claude Code session'],
                ['session.newPlan', 'New session in plan mode'],
                ['session.continue', 'Continue most recent (--continue)'],
                ['session.picker', 'Pick from Claude history (--resume)'],
                ['session.newShell', 'New shell'],
              ].map(([id, label]) => (
                <button key={id} role="menuitem" className="menu-item" onClick={() => { setMenu(false); runCommand(id); }}>
                  {label}
                  <span className="menu-kbd">{formatShortcut(shortcuts?.[id], isMac)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Session header ───────────────────────────────────────────────────────

function SessionHeader({ session }: { session: SessionInfo }) {
  const insight = useStore((s) => s.insights[session.id]);
  const live = useStore((s) => s.liveAgents);
  const project = useStore((s) => s.projects.find((p) => p.id === session.projectId));
  const git = useStore((s) => s.git[session.projectId]);
  const title = useStore((s) => s.sessionTitles[session.id]);
  const composerOpen = useStore((s) => s.composerOpen);
  const toast = useStore((s) => s.toast);
  const [, tick] = useState(0);
  useEffect(() => {
    if (session.state !== 'running') return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [session.state]);

  const liveAgent = session.claudeSessionId ? live?.find((a) => a.sessionId === session.claudeSessionId) : undefined;
  const isClaude = session.kind === 'claude';
  const model = insight?.model ?? null;

  return (
    <div className="session-header">
      <div className="sh-ident">
        <div className={`sh-kind ${isClaude ? 'is-claude' : ''}`}>
          <Icon name={isClaude ? 'claude' : 'terminal'} size={15} />
        </div>
        <div className="sh-titles">
          <div className="sh-title">{title || session.title}</div>
          <div className="sh-sub mono">
            {project?.name}
            {git?.isRepo && ` · ${git.branch ?? 'detached'}`}
            {session.claudeSessionId && (
              <button
                className="sh-sid"
                title={`Claude session ${session.claudeSessionId} — click to copy`}
                onClick={() => void api.invoke('clipboard:write', session.claudeSessionId!).then(() => toast('ok', 'Session id copied'))}
              >
                · sid {shortId(session.claudeSessionId)}
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="sh-gauges">
        {isClaude && (
          <div className="sh-gauge" title={model ? 'Model reported in the session transcript' : session.requestedModel ? 'Model requested with --model; not yet confirmed by a reply' : 'Claude Code chooses its default model; it is shown here after the first reply'}>
            <span className="sh-gauge-k">MODEL</span>
            <span className="sh-gauge-v mono">{model ?? session.requestedModel ?? 'awaiting first reply'}</span>
            <Provenance kind={model ? 'transcript' : session.requestedModel ? 'requested' : 'unavailable'} />
          </div>
        )}
        {isClaude && (
          <div className="sh-gauge" title="Status from `claude agents --json`">
            <span className="sh-gauge-k">STATUS</span>
            <span className="sh-gauge-v">{liveAgent?.status ?? (insight?.turnState && insight.turnState !== 'unknown' ? insight.turnState.replace('-', ' ') : '—')}</span>
            <Provenance kind={liveAgent ? 'live' : insight?.transcriptFound ? 'transcript' : 'unavailable'} />
          </div>
        )}
        {isClaude && session.permissionMode && session.permissionMode !== 'default' && (
          <div className="sh-gauge">
            <span className="sh-gauge-k">MODE</span>
            <span className="sh-gauge-v">{session.permissionMode}</span>
          </div>
        )}
        <div className="sh-gauge" title={session.commandLine}>
          <span className="sh-gauge-k">PROC</span>
          <span className="sh-gauge-v mono">
            {session.state === 'running' ? `pid ${session.pid} · ${duration(Date.now() - session.startedAt)}` : session.state === 'exited' ? `exited ${session.exitCode ?? ''}${session.signal ? ` sig ${session.signal}` : ''}` : session.state}
          </span>
        </div>
      </div>

      <div className="sh-actions">
        {isClaude && session.state === 'running' && (
          <Button variant="ghost" icon="interrupt" onClick={() => runCommand('session.interrupt')} title="Send Esc — Claude Code's interrupt key">
            Interrupt
          </Button>
        )}
        <IconButton icon="composer" label="Prompt composer" active={composerOpen} onClick={() => runCommand('composer.toggle')} disabled={session.state !== 'running'} />
        <IconButton icon="search" label="Find in terminal" onClick={() => runCommand('terminal.find')} />
        <IconButton icon="stop" label="End session process" onClick={() => runCommand('session.kill')} disabled={session.state !== 'running'} />
      </div>
    </div>
  );
}

// ── Terminal ─────────────────────────────────────────────────────────────

function TerminalPane({ sessionId, visible }: { sessionId: string; visible: boolean }) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const entry = ensureTerminal(sessionId);
    ref.current?.appendChild(entry.host);
    return () => {
      document.getElementById('term-parking')?.appendChild(entry.host);
    };
  }, [sessionId]);

  useEffect(() => {
    if (!visible || !ref.current) return;
    let frame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => fitTerminal(sessionId));
    });
    ro.observe(ref.current);
    requestAnimationFrame(() => {
      fitTerminal(sessionId);
      focusTerminal(sessionId);
    });
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, [visible, sessionId]);

  return <div ref={ref} className="terminal-pane" />;
}

function FindBar({ sessionId }: { sessionId: string }) {
  const [q, setQ] = useState('');
  const close = () => {
    useStore.setState({ findOpen: false });
    getTerminal(sessionId)?.search.clearDecorations();
    focusTerminal(sessionId);
  };
  const opts = { decorations: { matchOverviewRuler: '#6dbbee', activeMatchColorOverviewRuler: '#a9dfff', matchBackground: '#1f4a66', activeMatchBackground: '#2f6f9a' } };
  return (
    <div className="findbar">
      <Icon name="search" size={13} />
      <input
        autoFocus
        className="input"
        placeholder="Find in scrollback"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          getTerminal(sessionId)?.search.findNext(e.target.value, { incremental: true, ...opts });
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close();
          if (e.key === 'Enter') {
            const s = getTerminal(sessionId)?.search;
            if (e.shiftKey) s?.findPrevious(q, opts);
            else s?.findNext(q, opts);
          }
        }}
        aria-label="Find in terminal"
      />
      <IconButton icon="chevronDown" label="Next match" size={13} onClick={() => getTerminal(sessionId)?.search.findNext(q, opts)} />
      <IconButton icon="close" label="Close find" size={13} onClick={close} />
    </div>
  );
}

const SLASH = ['/help', '/status', '/model', '/compact', '/clear'];

function Composer({ session }: { session: SessionInfo }) {
  const [text, setText] = useState('');
  const send = (value: string) => {
    if (!value.trim()) return;
    submitToTerminal(session.id, value);
    setText('');
  };
  return (
    <div className="composer">
      <div className="composer-head">
        <span className="composer-title">Prompt composer</span>
        <span className="composer-note">Pastes into the running CLI, then presses Return — exactly as if you typed it.</span>
        <span className="flex-1" />
        {session.kind === 'claude' &&
          SLASH.map((c) => (
            <button key={c} className="chip mono" onClick={() => send(c)} title={`Send ${c} to Claude Code`}>
              {c}
            </button>
          ))}
        <IconButton icon="close" label="Close composer" size={13} onClick={() => useStore.setState({ composerOpen: false })} />
      </div>
      <div className="composer-body">
        <textarea
          className="input composer-input"
          rows={3}
          value={text}
          placeholder={session.kind === 'claude' ? 'Draft a longer prompt here. ⌘↩ to send.' : 'Command to run. ⌘↩ to send.'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send(text);
            }
            if (e.key === 'Escape') useStore.setState({ composerOpen: false });
          }}
          aria-label="Prompt composer"
        />
        <Button variant="primary" icon="send" onClick={() => send(text)} disabled={!text.trim()}>
          Send
        </Button>
      </div>
    </div>
  );
}

function ExitBanner({ session }: { session: SessionInfo }) {
  const claude = useStore((s) => s.claude);
  const insight = useStore((s) => s.insights[session.id]);
  const { startSession, closeTab, detect } = useStore.getState();
  const canResume = session.kind === 'claude' && !!session.claudeSessionId && !!claude?.capabilities?.resume && (insight?.transcriptFound ?? true);
  const restart = async (resume: boolean) => {
    const next = await startSession(
      resume && session.claudeSessionId
        ? { kind: 'claude', projectId: session.projectId, mode: 'resume', resumeId: session.claudeSessionId, title: session.title }
        : { kind: session.kind, projectId: session.projectId, title: session.title },
    );
    if (next && next.state === 'running') {
      disposeTerminal(session.id);
      await closeTab(session.id);
    }
  };
  return (
    <div className={`exit-banner ${session.state === 'failed' || session.error ? 'is-error' : ''}`} role="status">
      <Icon name={session.state === 'failed' || session.error ? 'warning' : 'info'} size={16} />
      <div className="exit-text">
        <div className="exit-title">
          {session.state === 'failed'
            ? 'Session could not start'
            : `Process exited${session.exitCode !== null ? ` with code ${session.exitCode}` : ''}${session.signal ? ` (signal ${session.signal})` : ''}`}
        </div>
        {session.error && <div className="exit-detail">{session.error}</div>}
        <div className="exit-detail mono">{session.commandLine}</div>
      </div>
      <div className="exit-actions">
        {session.state === 'failed' && session.kind === 'claude' && (
          <Button variant="ghost" icon="refresh" onClick={() => void detect(true)}>
            Re-detect
          </Button>
        )}
        {canResume && (
          <Button variant="primary" icon="resume" onClick={() => void restart(true)}>
            Resume conversation
          </Button>
        )}
        <Button variant={canResume ? 'default' : 'primary'} icon="play" onClick={() => void restart(false)}>
          Start new
        </Button>
        <Button variant="ghost" icon="close" onClick={() => void closeTab(session.id)}>
          Close
        </Button>
      </div>
    </div>
  );
}

function SessionView({ session, visible }: { session: SessionInfo; visible: boolean }) {
  const findOpen = useStore((s) => s.findOpen);
  const composerOpen = useStore((s) => s.composerOpen);
  return (
    <div className="session-view" style={{ display: visible ? 'flex' : 'none' }}>
      <SessionHeader session={session} />
      <div className="terminal-well">
        {visible && findOpen && <FindBar sessionId={session.id} />}
        <TerminalPane sessionId={session.id} visible={visible} />
      </div>
      {visible && composerOpen && session.state === 'running' && <Composer session={session} />}
      {(session.state === 'exited' || session.state === 'failed') && <ExitBanner session={session} />}
    </div>
  );
}

// ── Document viewers ─────────────────────────────────────────────────────

function FileView({ projectId, rel }: { projectId: string; rel: string }) {
  const [file, setFile] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const version = useStore((s) => s.fsVersion[projectId] ?? 0);
  const sessions = useStore((s) => s.sessions);
  const toast = useStore((s) => s.toast);

  useEffect(() => {
    void api.invoke('fs:read', projectId, rel).then((r) => (r.ok ? (setFile(r.value), setError(null)) : setError(r.error)));
  }, [projectId, rel, version]);

  const claudeSession = Object.values(sessions).find((s) => s.projectId === projectId && s.kind === 'claude' && s.state === 'running');
  const lines = useMemo(() => (file?.text ?? '').split('\n'), [file]);

  return (
    <div className="doc-view">
      <div className="doc-head">
        <Icon name="file" size={14} />
        <span className="mono doc-path">{rel}</span>
        {file && <span className="doc-meta">{bytes(file.size)}</span>}
        <span className="flex-1" />
        {claudeSession && (
          <Button
            variant="ghost"
            icon="claude"
            title="Types an @-mention of this file into the running Claude Code prompt (no Enter)"
            onClick={() => {
              api.send('session:write', claudeSession.id, `@${rel} `);
              useStore.getState().activateTab(claudeSession.id);
            }}
          >
            Mention in Claude
          </Button>
        )}
        <IconButton icon="copy" label="Copy path" size={13} onClick={() => void api.invoke('clipboard:write', rel).then(() => toast('ok', 'Path copied'))} />
        <IconButton icon="reveal" label="Reveal in Finder" size={13} onClick={() => void api.invoke('projects:reveal', projectId, rel)} />
      </div>
      {error && <div className="doc-error">{error}</div>}
      {file?.binary && <div className="doc-error">Binary file — not displayed.</div>}
      {file?.truncated && <div className="doc-warn">Showing the first 1 MB only.</div>}
      {file?.text !== null && file && (
        <div className="code-view" tabIndex={0} aria-label={`Contents of ${rel}`}>
          {lines.map((l, i) => (
            <div key={i} className="code-line">
              <span className="code-no">{i + 1}</span>
              <span className="code-text">{l || ' '}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DiffView({ projectId, path, staged }: { projectId: string; path: string; staged: boolean }) {
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const status = useStore((s) => s.git[projectId]);
  const { openFile, refreshGit, toast } = useStore.getState();
  const load = useCallback(() => {
    void api.invoke('git:diff', projectId, path, staged).then((r) => (r.ok ? (setDiff(r.value), setError(null)) : setError(r.error)));
  }, [projectId, path, staged]);
  useEffect(() => {
    load();
  }, [load, status?.updatedAt]);
  const parsed = useMemo(() => (diff ? parseUnifiedDiff(diff.text) : null), [diff]);
  const change = status?.files.find((f) => f.path === path);

  return (
    <div className="doc-view">
      <div className="doc-head">
        <Icon name="diff" size={14} />
        <span className="mono doc-path">{path}</span>
        <span className="tag">{staged ? 'staged' : diff?.untracked ? 'untracked' : 'working tree'}</span>
        {parsed && (
          <span className="doc-meta">
            <span className="tone-ok">+{parsed.added}</span> <span className="tone-err">−{parsed.removed}</span>
          </span>
        )}
        <Provenance kind="git" />
        <span className="flex-1" />
        {change && !staged && (
          <Button variant="ghost" icon="stage" onClick={() => void api.invoke('git:stage', projectId, [path]).then((r) => { if (!r.ok) toast('error', r.error); void refreshGit(projectId); })}>
            Stage
          </Button>
        )}
        {change && staged && (
          <Button variant="ghost" icon="unstage" onClick={() => void api.invoke('git:unstage', projectId, [path]).then((r) => { if (!r.ok) toast('error', r.error); void refreshGit(projectId); })}>
            Unstage
          </Button>
        )}
        <IconButton icon="file" label="Open file" size={13} onClick={() => openFile(projectId, path)} />
        <IconButton icon="refresh" label="Reload diff" size={13} onClick={load} />
      </div>
      {error && <div className="doc-error">{error}</div>}
      {diff?.truncated && <div className="doc-warn">Diff truncated at 2 MB.</div>}
      {parsed && parsed.lines.length === 0 && <div className="doc-empty">No differences{change ? '' : ' — this file is no longer changed'}.</div>}
      {parsed && parsed.binary && <div className="doc-warn">Binary file changed.</div>}
      {parsed && parsed.lines.length > 0 && (
        <div className="code-view diff-view" tabIndex={0} aria-label={`Diff of ${path}`}>
          {parsed.lines.map((l, i) => (
            <div key={i} className={`code-line diff-${l.kind}`}>
              <span className="code-no">{l.oldNo ?? ''}</span>
              <span className="code-no">{l.newNo ?? ''}</span>
              <span className="diff-sign">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>
              <span className="code-text">{l.text || ' '}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Workspace ────────────────────────────────────────────────────────────

export function Workspace() {
  const center = useStore((s) => s.center);
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const sessions = useStore((s) => s.sessions);
  const settings = useStore((s) => s.settings);
  const [bottomH, setBottomH] = useState<number | null>(null);
  const height = bottomH ?? settings?.bottomHeight ?? 200;

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const showTabs = center === 'tabs' && tabs.length > 0;

  return (
    <main className="workspace" aria-label="Workspace">
      <TabBar />
      <div className="workspace-body">
        {/* Session views stay mounted so terminals keep their state. */}
        {tabs
          .filter((t): t is Extract<Tab, { type: 'session' }> => t.type === 'session')
          .map((t) => {
            const s = sessions[t.sessionId];
            return s ? <SessionView key={t.id} session={s} visible={showTabs && activeTabId === t.id} /> : null;
          })}
        {showTabs && activeTab?.type === 'file' && <FileView key={activeTab.id} projectId={activeTab.projectId} rel={activeTab.rel} />}
        {showTabs && activeTab?.type === 'diff' && <DiffView key={activeTab.id} projectId={activeTab.projectId} path={activeTab.path} staged={activeTab.staged} />}
        {(center === 'home' || (center === 'tabs' && tabs.length === 0)) && <HomeView />}
        {center === 'settings' && <SettingsView />}
      </div>
      {settings?.bottomOpen && (
        <>
          <Resizer
            axis="y"
            label="Resize bottom panel"
            onDelta={(d) => setBottomH((h) => Math.min(700, Math.max(100, (h ?? settings.bottomHeight) - d)))}
            onEnd={() => bottomH && void useStore.getState().setSettings({ bottomHeight: Math.round(bottomH) })}
          />
          <ErrorBoundary region="Bottom panel">
            <BottomPanel height={height} />
          </ErrorBoundary>
        </>
      )}
      <div id="term-parking" aria-hidden="true" />
    </main>
  );
}
