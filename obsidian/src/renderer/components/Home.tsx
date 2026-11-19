import { api, isMac } from '../lib/api';
import { runCommand } from '../lib/commands';
import { timeAgo } from '../lib/format';
import { formatShortcut } from '../lib/shortcuts';
import { activeProject, useStore } from '../state/store';
import { Icon, type IconName } from './Icon';
import { OrbitRings, Starfield } from './Starfield';
import { Button, Provenance } from './ui';

function Instrument({ label, state, value, detail, children }: { label: string; state: string; value: string; detail?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="instrument">
      <div className="instrument-head">
        <span className="led" data-state={state} />
        <span className="instrument-label">{label}</span>
      </div>
      <div className="instrument-value">{value}</div>
      {detail && <div className="instrument-detail">{detail}</div>}
      {children && <div className="instrument-actions">{children}</div>}
    </div>
  );
}

function LaunchButton({ icon, title, sub, onClick, disabled, kbd, primary }: { icon: IconName; title: string; sub: string; onClick: () => void; disabled?: boolean; kbd?: string; primary?: boolean }) {
  return (
    <button className={`launch ${primary ? 'is-primary' : ''}`} onClick={onClick} disabled={disabled}>
      <span className="launch-icon">
        <Icon name={icon} size={18} />
      </span>
      <span className="launch-text">
        <span className="launch-title">{title}</span>
        <span className="launch-sub">{sub}</span>
      </span>
      {kbd && <span className="launch-kbd">{kbd}</span>}
    </button>
  );
}

export function HomeView() {
  const claude = useStore((s) => s.claude);
  const detecting = useStore((s) => s.detecting);
  const settings = useStore((s) => s.settings);
  const projects = useStore((s) => s.projects);
  const project = useStore(activeProject);
  const git = useStore((s) => s.git);
  const { addProject, selectProject, startSession, detect, setSettings } = useStore.getState();
  const caps = claude?.capabilities;
  const sc = settings?.shortcuts ?? {};
  const recent = [...projects].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt).slice(0, 6);
  const authOk = claude?.auth.state === 'logged-in';

  const steps = [
    { done: !!claude?.found, label: 'Claude Code detected' },
    { done: authOk, label: 'Signed in to Claude' },
    { done: projects.length > 0, label: 'Project folder opened' },
  ];
  const showPreflight = settings && !settings.onboarded;

  return (
    <div className="home">
      <div className="home-hero">
        {settings?.backgroundImagery !== false && <Starfield horizon density={1} />}
        {settings?.backgroundImagery !== false && <OrbitRings className="home-orbits" />}
        <div className="home-hero-text">
          <div className="home-kicker mono">MISSION CONTROL</div>
          <h1 className="home-title">OBSIDIAN</h1>
          <p className="home-sub">A command station for Claude Code. Your CLI, your subscription, your permissions — in a better cockpit.</p>
        </div>
      </div>

      <div className="home-grid">
        {showPreflight && (
          <section className="panel preflight">
            <div className="panel-head">
              <span className="panel-title">Pre-flight checklist</span>
              <span className="flex-1" />
              <button className="link-btn" onClick={() => void setSettings({ onboarded: true })}>
                Dismiss
              </button>
            </div>
            <ol className="steps">
              {steps.map((s, i) => (
                <li key={s.label} className={s.done ? 'is-done' : ''}>
                  <span className="step-mark">{s.done ? <Icon name="check" size={12} /> : i + 1}</span>
                  {s.label}
                </li>
              ))}
            </ol>
            <p className="panel-note">
              OBSIDIAN runs the <span className="mono">claude</span> CLI you already use, in a real terminal. It never reads your credentials, never needs an API key, and never turns on automatic approvals.
            </p>
          </section>
        )}

        <section className="panel systems">
          <div className="panel-head">
            <span className="panel-title">Systems check</span>
            <span className="flex-1" />
            <Button variant="ghost" icon="refresh" onClick={() => void detect(true)} disabled={detecting}>
              {detecting ? 'Checking…' : 'Re-check'}
            </Button>
          </div>
          <div className="instruments">
            <Instrument
              label="Claude Code CLI"
              state={detecting ? 'busy' : claude?.found ? 'ok' : claude ? 'err' : 'off'}
              value={claude?.found ? `v${claude.version}` : detecting ? 'Detecting…' : 'Not found'}
              detail={
                claude?.found ? (
                  <>
                    <span className="mono">{claude.path}</span>
                    <br />
                    found via {claude.source === 'settings' ? 'your setting' : claude.source === 'login-shell-path' ? 'login shell PATH' : 'standard install location'}
                  </>
                ) : (
                  claude?.error
                )
              }
            >
              <Button variant="ghost" onClick={() => void api.invoke('claude:chooseExecutable').then((info) => useStore.setState({ claude: info }))}>
                Locate…
              </Button>
            </Instrument>
            <Instrument
              label="Authentication"
              state={authOk ? 'ok' : claude?.auth.state === 'logged-out' ? 'err' : claude?.found ? 'warn' : 'off'}
              value={authOk ? 'Signed in' : claude?.auth.state === 'logged-out' ? 'Not signed in' : 'Unknown'}
              detail={
                authOk && claude?.auth.state === 'logged-in' ? (
                  <>
                    method <span className="mono">{claude.auth.method ?? '?'}</span> · provider <span className="mono">{claude.auth.provider ?? '?'}</span> <Provenance kind="cli" />
                  </>
                ) : claude?.auth.state === 'logged-out' ? (
                  <>Start a Claude Code session and follow its sign-in prompt, or run <span className="mono">claude auth login</span> in a shell tab.</>
                ) : claude?.auth.state === 'unknown' ? (
                  claude.auth.reason
                ) : null
              }
            />
            <Instrument
              label="Live session status"
              state={caps?.agentsJson ? (settings?.liveStatusPolling ? 'ok' : 'warn') : claude?.found ? 'warn' : 'off'}
              value={caps?.agentsJson ? (settings?.liveStatusPolling ? 'Available' : 'Disabled') : 'Unavailable'}
              detail={caps?.agentsJson ? <>via <span className="mono">claude agents --json</span>, polled only while a session runs</> : 'Needs a Claude Code version with `claude agents --json`.'}
            />
            <Instrument
              label="Session control"
              state={caps ? (caps.sessionId && caps.resume ? 'ok' : 'warn') : 'off'}
              value={caps ? [caps.sessionId && 'ids', caps.resume && 'resume', caps.continue && 'continue', caps.model && 'model', caps.permissionMode && 'modes'].filter(Boolean).join(' · ') : '—'}
              detail="Feature-detected from claude --help"
            />
          </div>
          {claude?.apiKeyEnvPresent && (
            <div className="callout warn">
              <Icon name="warning" size={14} />
              <span>
                <span className="mono">ANTHROPIC_API_KEY</span> is set in OBSIDIAN’s environment. Claude Code may bill that key instead of your subscription. OBSIDIAN doesn’t read or change it.
              </span>
            </div>
          )}
          {claude && !claude.found && !detecting && (
            <div className="callout">
              <Icon name="info" size={14} />
              <div>
                <div>Install Claude Code, then press Re-check:</div>
                <code className="mono block">curl -fsSL https://claude.ai/install.sh | bash</code>
                <div className="muted">
                  or <span className="mono">npm install -g @anthropic-ai/claude-code</span>. You can run either in a shell tab (
                  <button className="link-btn" disabled={!project} onClick={() => void startSession({ kind: 'shell' })}>
                    open one
                  </button>
                  ).
                </div>
              </div>
            </div>
          )}
        </section>

        <section className="panel launchpad">
          <div className="panel-head">
            <span className="panel-title">Launch</span>
            {project && <span className="panel-sub mono">{project.root}</span>}
          </div>
          {!project ? (
            <div className="launch-empty">
              <p>Open a project folder to start a session in it.</p>
              <Button variant="primary" icon="plus" onClick={() => void addProject()}>
                Open Folder…
              </Button>
            </div>
          ) : (
            <div className="launch-grid">
              <LaunchButton primary icon="claude" title="New Claude Code session" sub={settings?.defaultModel ? `--model ${settings.defaultModel}` : 'default model'} kbd={formatShortcut(sc['session.newClaude'], isMac)} disabled={!claude?.found} onClick={() => void startSession({ kind: 'claude' })} />
              <LaunchButton icon="resume" title="Continue most recent" sub="claude --continue" disabled={!caps?.continue} onClick={() => runCommand('session.continue')} />
              <LaunchButton icon="history" title="Pick from history" sub="claude --resume" disabled={!caps?.resume} onClick={() => runCommand('session.picker')} />
              <LaunchButton icon="shield" title="Plan mode session" sub="--permission-mode plan" disabled={!caps?.permissionMode} onClick={() => runCommand('session.newPlan')} />
              <LaunchButton icon="terminal" title="Shell" sub="your login shell" kbd={formatShortcut(sc['session.newShell'], isMac)} onClick={() => void startSession({ kind: 'shell' })} />
            </div>
          )}
        </section>

        <section className="panel recents">
          <div className="panel-head">
            <span className="panel-title">Recent projects</span>
            <span className="flex-1" />
            <Button variant="ghost" icon="plus" onClick={() => void addProject()}>
              Open…
            </Button>
          </div>
          {recent.length === 0 ? (
            <div className="muted-row">Projects you open appear here. Nothing is scanned automatically.</div>
          ) : (
            <div className="recent-grid">
              {recent.map((p) => {
                const g = git[p.id];
                return (
                  <button key={p.id} className={`recent ${p.id === project?.id ? 'is-active' : ''}`} onClick={() => selectProject(p.id)} title={p.root}>
                    <Icon name="folder" size={16} />
                    <span className="recent-name">{p.name}</span>
                    <span className="recent-path mono">{p.root}</span>
                    <span className="recent-meta">
                      {g?.isRepo ? <span className="mono">{g.branch}</span> : null}
                      <span>{timeAgo(p.lastOpenedAt)}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
