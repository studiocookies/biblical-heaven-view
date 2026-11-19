import { useEffect, useRef } from 'react';
import { clock, duration } from '../lib/format';
import { activeSession, useStore, type BottomTab } from '../state/store';
import { IconButton, Provenance, Tabs } from './ui';

function Activity() {
  const session = useStore(activeSession);
  const insight = useStore((s) => (session ? s.insights[session.id] : undefined));
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Chromium's scrollIntoView can return a Promise; never hand it to React as a cleanup.
    void end.current?.scrollIntoView({ block: 'end' });
  }, [insight?.events.length]);

  if (!session) return <div className="bp-empty">No active session.</div>;
  if (session.kind !== 'claude') return <div className="bp-empty">The activity timeline is built from Claude Code transcripts; shell sessions don’t have one.</div>;
  if (!insight?.transcriptFound)
    return (
      <div className="bp-empty">
        Waiting for Claude Code to write this conversation’s transcript — it appears after the first prompt. <Provenance kind="transcript" />
      </div>
    );
  return (
    <div className="timeline">
      <div className="timeline-summary">
        <span>{insight.prompts} prompts</span>
        <span>{insight.toolCalls} tool calls</span>
        <span>turn: {insight.turnState.replace('-', ' ')}</span>
        <Provenance kind="transcript" />
      </div>
      {insight.events.map((e, i) => (
        <div key={i} className={`tl-row tl-${e.kind}`}>
          <span className="tl-time mono">{clock(e.at)}</span>
          <span className="tl-dot" />
          <span className="tl-label">{e.label}</span>
          {e.detail && <span className="tl-detail mono">{e.detail}</span>}
        </div>
      ))}
      <div ref={end} />
    </div>
  );
}

function Diagnostics() {
  const log = useStore((s) => s.log);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void end.current?.scrollIntoView({ block: 'end' });
  }, [log.length]);
  return (
    <div className="diag">
      {log.length === 0 && <div className="bp-empty">No events yet.</div>}
      {log.map((l, i) => (
        <div key={i} className={`diag-row diag-${l.level}`}>
          <span className="mono diag-time">{clock(l.at)}</span>
          <span className={`diag-level diag-level-${l.level}`}>{l.level}</span>
          <span className="diag-src mono">{l.source}</span>
          <span className="diag-msg mono">{l.message}</span>
        </div>
      ))}
      <div ref={end} />
    </div>
  );
}

function Processes() {
  const sessions = useStore((s) => s.sessions);
  const projects = useStore((s) => s.projects);
  const list = Object.values(sessions).sort((a, b) => b.startedAt - a.startedAt);
  if (!list.length) return <div className="bp-empty">No processes started by OBSIDIAN.</div>;
  return (
    <table className="proc-table">
      <thead>
        <tr>
          <th>State</th>
          <th>Kind</th>
          <th>PID</th>
          <th>Project</th>
          <th>Uptime</th>
          <th>Exit</th>
          <th>Command</th>
        </tr>
      </thead>
      <tbody>
        {list.map((s) => (
          <tr key={s.id}>
            <td>
              <span className="led" data-state={s.state === 'running' ? 'ok' : s.state === 'failed' ? 'err' : 'off'} /> {s.state}
            </td>
            <td>{s.kind}</td>
            <td className="mono">{s.pid ?? '—'}</td>
            <td>{projects.find((p) => p.id === s.projectId)?.name}</td>
            <td className="mono">{duration((s.endedAt ?? Date.now()) - s.startedAt)}</td>
            <td className="mono">{s.exitCode ?? (s.signal ? `sig ${s.signal}` : '—')}</td>
            <td className="mono proc-cmd" title={s.commandLine}>{s.commandLine || s.error}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function BottomPanel({ height }: { height: number }) {
  const tab = useStore((s) => s.bottomTab);
  const errors = useStore((s) => s.log.filter((l) => l.level === 'error').length);
  return (
    <section className="bottom-panel" style={{ height }} aria-label="Bottom panel">
      <div className="bp-head">
        <Tabs<BottomTab>
          ariaLabel="Bottom panel"
          value={tab}
          onChange={(bottomTab) => useStore.setState({ bottomTab })}
          tabs={[
            { id: 'activity', label: 'Activity' },
            { id: 'diagnostics', label: 'Diagnostics', badge: errors ? <span className="seg-badge tone-err">{errors}</span> : undefined },
            { id: 'process', label: 'Processes' },
          ]}
        />
        <span className="flex-1" />
        {tab === 'diagnostics' && <IconButton icon="trash" label="Clear diagnostics" size={13} onClick={() => useStore.setState({ log: [] })} />}
        <IconButton icon="close" label="Hide bottom panel" size={13} onClick={() => void useStore.getState().setSettings({ bottomOpen: false })} />
      </div>
      <div className="bp-body">
        {tab === 'activity' && <Activity />}
        {tab === 'diagnostics' && <Diagnostics />}
        {tab === 'process' && <Processes />}
      </div>
    </section>
  );
}
