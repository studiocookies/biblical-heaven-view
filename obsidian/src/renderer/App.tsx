import { useEffect, useRef, useState } from 'react';
import { Rail, StatusBar, TitleBar } from './components/Chassis';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Icon } from './components/Icon';
import { IntelPanel } from './components/IntelPanel';
import { Palette } from './components/Palette';
import { Sidebar } from './components/Sidebar';
import { Resizer } from './components/ui';
import { Workspace } from './components/Workspace';
import { api, isMac } from './lib/api';
import { runCommand } from './lib/commands';
import { eventToShortcut, normalizeShortcut } from './lib/shortcuts';
import { disposeTerminal, writeToTerminal } from './lib/terminals';
import { useStore } from './state/store';

function useIpcWiring() {
  useEffect(() => {
    const gitTimers = new Map<string, number>();
    const offs = [
      api.on('session:data', (id, data) => writeToTerminal(id, data)),
      api.on('session:update', (info) => {
        const prev = useStore.getState().sessions[info.id];
        useStore.setState((s) => (s.tabs.some((t) => t.id === info.id) ? { sessions: { ...s.sessions, [info.id]: info } } : {}));
        const log = useStore.getState().addLog;
        if (prev?.state !== info.state) {
          if (info.state === 'exited') log(info.exitCode === 0 ? 'info' : 'warn', 'session', `${info.kind} pid ${info.pid ?? '?'} exited (code ${info.exitCode ?? '—'}${info.signal ? `, signal ${info.signal}` : ''})`);
          if (info.state === 'failed') log('error', 'session', info.error ?? 'failed to start');
          if (info.error && info.state === 'exited') log('error', 'session', info.error);
        }
        if (prev && !prev.claudeSessionId && info.claudeSessionId) log('info', 'session', `Detected Claude session id ${info.claudeSessionId} for pid ${info.pid}`);
        // Claude may have changed files when a session ends.
        if (info.state !== 'running') void useStore.getState().refreshGit(info.projectId);
      }),
      api.on('session:insight', (insight) => useStore.setState((s) => ({ insights: { ...s.insights, [insight.sessionId]: insight } }))),
      api.on('agents:update', (agents) => useStore.setState({ liveAgents: agents })),
      api.on('project:changed', (change) => {
        useStore.setState((s) => ({
          fsVersion: { ...s.fsVersion, [change.projectId]: (s.fsVersion[change.projectId] ?? 0) + 1 },
          changedDirs: { ...s.changedDirs, [change.projectId]: change.dirs },
        }));
        if (change.gitTouched && !gitTimers.has(change.projectId)) {
          // throttle git status to at most once a second per project
          gitTimers.set(
            change.projectId,
            window.setTimeout(() => {
              gitTimers.delete(change.projectId);
              void useStore.getState().refreshGit(change.projectId);
            }, 1000),
          );
        }
      }),
      api.on('menu:command', (cmd) => {
        if (cmd === 'app.visible') api.send('app:visibility', true);
        else if (cmd === 'app.hidden') api.send('app:visibility', false);
        else runCommand(cmd, 'menu');
      }),
    ];
    const onVis = () => api.send('app:visibility', !document.hidden);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      offs.forEach((off) => off());
      document.removeEventListener('visibilitychange', onVis);
      gitTimers.forEach((t) => clearTimeout(t));
    };
  }, []);
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      if (!s.settings) return;
      if (e.key === 'Escape' && s.paletteOpen) {
        s.set({ paletteOpen: false });
        return;
      }
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod) return;
      // ⌘1…⌘9 select tabs
      if (/^Digit[1-9]$/.test(e.code) && !e.shiftKey && !e.altKey) {
        const tab = s.tabs[Number(e.code.slice(5)) - 1];
        if (tab) {
          e.preventDefault();
          e.stopPropagation();
          s.activateTab(tab.id);
        }
        return;
      }
      const pressed = eventToShortcut(e, isMac);
      if (!pressed) return;
      const norm = normalizeShortcut(pressed);
      const hit = Object.entries(s.settings.shortcuts).find(([, sc]) => normalizeShortcut(sc) === norm);
      if (!hit) return;
      // Inside text fields keep native editing shortcuts (copy/paste/select-all are never bound here).
      e.preventDefault();
      e.stopPropagation();
      runCommand(hit[0], 'keyboard');
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
}

function useRootAttributes() {
  const settings = useStore((s) => s.settings);
  useEffect(() => {
    const root = document.documentElement;
    if (!settings) return;
    root.dataset.contrast = settings.contrast;
    if (settings.reducedMotion === 'on') root.dataset.motion = 'reduce';
    else if (settings.reducedMotion === 'off') root.dataset.motion = 'full';
    else delete root.dataset.motion;
    root.dataset.platform = isMac ? 'mac' : 'other';
  }, [settings]);
}

/** Free xterm instances whose tabs were closed. */
function useTerminalCleanup() {
  const tabs = useStore((s) => s.tabs);
  const known = useRef(new Set<string>());
  useEffect(() => {
    const now = new Set(tabs.filter((t) => t.type === 'session').map((t) => t.id));
    for (const id of known.current) if (!now.has(id)) disposeTerminal(id);
    known.current = now;
  }, [tabs]);
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.level}`}>
          <Icon name={t.level === 'error' ? 'warning' : t.level === 'ok' ? 'check' : 'info'} size={14} />
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  );
}

export function App() {
  const ready = useStore((s) => s.ready);
  const settings = useStore((s) => s.settings);
  const [leftW, setLeftW] = useState<number | null>(null);
  const [rightW, setRightW] = useState<number | null>(null);
  const [winW, setWinW] = useState(window.innerWidth);
  useEffect(() => {
    const onResize = () => setWinW(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useIpcWiring();
  useShortcuts();
  useRootAttributes();
  useTerminalCleanup();
  useEffect(() => {
    void useStore.getState().init();
  }, []);

  if (!ready || !settings) {
    return (
      <div className="boot">
        <span className="led" data-state="busy" /> Initializing OBSIDIAN…
      </div>
    );
  }
  // Side panels yield to the terminal on small windows: shrink proportionally to their minimums.
  const wantL = settings.leftOpen ? (leftW ?? settings.leftWidth) : 0;
  const wantR = settings.rightOpen ? (rightW ?? settings.rightWidth) : 0;
  const room = Math.max(0, winW - 80 - 460); // chassis rail + margins, terminal minimum
  const over = wantL + wantR - room;
  let lw = wantL;
  let rw = wantR;
  if (over > 0 && wantL + wantR > 0) {
    lw = Math.max(settings.leftOpen ? 200 : 0, Math.round(wantL - (over * wantL) / (wantL + wantR)));
    rw = Math.max(settings.rightOpen ? 260 : 0, Math.round(wantR - (over * wantR) / (wantL + wantR)));
  }

  return (
    <div className="chassis mat-brushed">
      <TitleBar />
      <div className="deck">
        <Rail />
        <div className="bay bezel">
          {settings.leftOpen && (
            <>
              <div className="bay-left" style={{ width: lw }}>
                <ErrorBoundary region="Navigator">
                  <Sidebar />
                </ErrorBoundary>
              </div>
              <Resizer
                axis="x"
                label="Resize navigator"
                onDelta={(d) => setLeftW((w) => Math.min(600, Math.max(180, (w ?? settings.leftWidth) + d)))}
                onEnd={() => leftW && void useStore.getState().setSettings({ leftWidth: Math.round(leftW) })}
              />
            </>
          )}
          <ErrorBoundary region="Workspace">
            <Workspace />
          </ErrorBoundary>
          {settings.rightOpen && (
            <>
              <Resizer
                axis="x"
                label="Resize intelligence panel"
                onDelta={(d) => setRightW((w) => Math.min(720, Math.max(240, (w ?? settings.rightWidth) - d)))}
                onEnd={() => rightW && void useStore.getState().setSettings({ rightWidth: Math.round(rightW) })}
              />
              <div className="bay-right" style={{ width: rw }}>
                <ErrorBoundary region="Intelligence panel">
                  <IntelPanel />
                </ErrorBoundary>
              </div>
            </>
          )}
        </div>
      </div>
      <StatusBar />
      <ErrorBoundary region="Command palette">
        <Palette />
      </ErrorBoundary>
      <Toasts />
    </div>
  );
}
