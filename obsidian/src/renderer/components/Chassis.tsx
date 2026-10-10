import { useEffect, useState } from 'react';
import { isMac } from '../lib/api';
import { runCommand } from '../lib/commands';
import { duration, shortId } from '../lib/format';
import { formatShortcut } from '../lib/shortcuts';
import { activeProject, activeSession, useStore, type Nav } from '../state/store';
import { Icon, type IconName } from './Icon';
import { IconButton } from './ui';

function Wordmark() {
  return (
    <div className="wordmark" aria-label="OBSIDIAN">
      <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
        <defs>
          <linearGradient id="wm-g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#1d2a38" />
            <stop offset="1" stopColor="#05080c" />
          </linearGradient>
        </defs>
        <path d="M12 2.2 20.5 7v10L12 21.8 3.5 17V7z" fill="url(#wm-g)" stroke="#5b6670" strokeWidth="0.8" />
        <path d="M12 2.2v19.6M3.5 7 20.5 17M20.5 7 3.5 17" stroke="rgba(169,223,255,0.25)" strokeWidth="0.6" />
        <ellipse cx="12" cy="12" rx="9.8" ry="3.1" transform="rotate(-18 12 12)" fill="none" stroke="#a9dfff" strokeWidth="0.9" opacity="0.85" />
      </svg>
      <span className="wordmark-text engraved">OBSIDIAN</span>
    </div>
  );
}

export function TitleBar() {
  const claude = useStore((s) => s.claude);
  const detecting = useStore((s) => s.detecting);
  const project = useStore(activeProject);
  const git = useStore((s) => (s.activeProjectId ? s.git[s.activeProjectId] : undefined));
  const sessions = useStore((s) => s.sessions);
  const settings = useStore((s) => s.settings);
  const running = Object.values(sessions).filter((x) => x.state === 'running');
  const claudeRunning = running.filter((x) => x.kind === 'claude').length;

  const cliState = detecting ? 'busy' : !claude ? 'off' : claude.found ? 'ok' : 'err';
  const authState = claude?.auth.state === 'logged-in' ? 'ok' : claude?.auth.state === 'logged-out' ? 'err' : claude?.found ? 'warn' : 'off';

  return (
    <header className="titlebar mat-brushed">
      <div className={isMac ? 'traffic-space' : 'traffic-space-none'} />
      <Wordmark />
      <div className="screw-row" aria-hidden="true">
        <span className="screw" />
      </div>
      <div className="titlebar-center">
        {project ? (
          <div className="title-chip bezel-sm" title={project.root}>
            <Icon name="projects" size={13} />
            <span className="title-chip-name">{project.name}</span>
            {git?.isRepo && (
              <>
                <span className="title-chip-sep" />
                <Icon name="branch" size={13} />
                <span className="mono">{git.detached ? 'detached' : git.branch}</span>
                {git.files.length > 0 && <span className="title-chip-dirty" title={`${git.files.length} changed files (git status)`}>●{git.files.length}</span>}
              </>
            )}
          </div>
        ) : (
          <span className="engraved title-hint">No project open</span>
        )}
      </div>
      <div className="titlebar-right">
        <button className="gauge" onClick={() => runCommand('view.home')} title={claude?.path ?? claude?.error ?? 'Detecting Claude Code…'}>
          <span className="led" data-state={cliState} />
          <span className="gauge-label">CLI</span>
          <span className="gauge-value mono">{claude?.found ? claude.version : detecting ? '…' : 'missing'}</span>
        </button>
        <button className="gauge" onClick={() => runCommand('view.home')} title={claude?.auth.state === 'logged-in' ? `Signed in (${claude.auth.method ?? 'unknown method'})` : 'Authentication status from `claude auth status`'}>
          <span className="led" data-state={authState} />
          <span className="gauge-label">AUTH</span>
          <span className="gauge-value">{claude?.auth.state === 'logged-in' ? 'OK' : claude?.auth.state === 'logged-out' ? 'NONE' : '—'}</span>
        </button>
        <button className="gauge" onClick={() => useStore.setState({ nav: 'sessions' })} title="Running processes started by OBSIDIAN">
          <span className="led" data-state={claudeRunning ? 'busy' : running.length ? 'ok' : 'off'} />
          <span className="gauge-label">PROC</span>
          <span className="gauge-value mono">{running.length}</span>
        </button>
        <div className="titlebar-tools">
          <IconButton icon="panelLeft" label="Toggle navigator" active={settings?.leftOpen} onClick={() => runCommand('view.toggleLeft')} />
          <IconButton icon="panelBottom" label="Toggle bottom panel" active={settings?.bottomOpen} onClick={() => runCommand('view.toggleBottom')} />
          <IconButton icon="panelRight" label="Toggle intelligence panel" active={settings?.rightOpen} onClick={() => runCommand('view.toggleRight')} />
          <button className="palette-btn" onClick={() => runCommand('palette.open')} aria-label="Command palette">
            <Icon name="command" size={13} />
            <span>{formatShortcut(settings?.shortcuts['palette.open'], isMac)}</span>
          </button>
        </div>
      </div>
    </header>
  );
}

const NAV: { id: Nav; icon: IconName; label: string }[] = [
  { id: 'home', icon: 'home', label: 'Home' },
  { id: 'projects', icon: 'projects', label: 'Projects' },
  { id: 'sessions', icon: 'sessions', label: 'Sessions' },
  { id: 'agents', icon: 'agents', label: 'Agents' },
  { id: 'files', icon: 'files', label: 'Files' },
  { id: 'git', icon: 'git', label: 'Git' },
  { id: 'settings', icon: 'settings', label: 'Settings' },
];

export function Rail() {
  const nav = useStore((s) => s.nav);
  const center = useStore((s) => s.center);
  const sessions = useStore((s) => s.sessions);
  const gitCount = useStore((s) => (s.activeProjectId ? s.git[s.activeProjectId]?.files.length ?? 0 : 0));
  const attention = useStore((s) => Object.values(s.attention).some(Boolean));
  const running = Object.values(sessions).filter((x) => x.state === 'running').length;

  const go = (id: Nav) => {
    const s = useStore.getState();
    if (id === 'home') useStore.setState({ nav: id, center: 'home' });
    else if (id === 'settings') useStore.setState({ nav: id, center: 'settings' });
    else {
      useStore.setState({ nav: id, center: s.center === 'tabs' || s.tabs.length === 0 ? s.center : 'tabs' });
      if (!s.settings?.leftOpen) void s.setSettings({ leftOpen: true });
    }
  };

  return (
    <nav className="rail mat-brushed-vertical" aria-label="Primary">
      {NAV.map((n) => {
        const active = nav === n.id || (n.id === 'home' && center === 'home' && nav === 'home');
        const badge = n.id === 'sessions' && running ? running : n.id === 'git' && gitCount ? gitCount : null;
        return (
          <button key={n.id} className={`rail-btn ${active ? 'is-active' : ''} ${n.id === 'settings' ? 'rail-bottom' : ''}`} onClick={() => go(n.id)} aria-current={active ? 'page' : undefined} title={n.label}>
            <span className="rail-well">
              <Icon name={n.icon} size={18} />
              {badge !== null && <span className="rail-badge mono">{badge}</span>}
              {n.id === 'sessions' && attention && <span className="rail-attn" aria-label="Session needs attention" />}
            </span>
            <span className="rail-label engraved">{n.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

export function StatusBar() {
  const project = useStore(activeProject);
  const session = useStore(activeSession);
  const insight = useStore((s) => (session ? s.insights[session.id] : undefined));
  const live = useStore((s) => s.liveAgents);
  const settings = useStore((s) => s.settings);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const liveStatus = session?.claudeSessionId ? live?.find((a) => a.sessionId === session.claudeSessionId)?.status : undefined;

  return (
    <footer className="statusbar mat-brushed">
      <span className="sb-item engraved mono" title={project?.root}>
        {project ? project.root : 'no project'}
      </span>
      <span className="flex-1" />
      {session && (
        <>
          <span className="sb-item engraved">
            <span className="led" data-state={session.state === 'running' ? (liveStatus === 'busy' ? 'busy' : 'ok') : session.state === 'failed' ? 'err' : 'off'} />
            {session.kind === 'claude' ? 'Claude Code' : 'Shell'} · {session.state}
            {session.state === 'running' && ` · ${duration(Date.now() - session.startedAt)}`}
          </span>
          {session.kind === 'claude' && <span className="sb-item engraved mono">model {insight?.model ?? session.requestedModel ?? 'not yet detected'}</span>}
          {session.claudeSessionId && <span className="sb-item engraved mono">sid {shortId(session.claudeSessionId)}</span>}
        </>
      )}
      <span className="sb-item engraved" title="Live status from `claude agents --json`">
        live status {settings?.liveStatusPolling ? (live ? 'on' : 'idle') : 'off'}
      </span>
    </footer>
  );
}
