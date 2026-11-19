import { useEffect, useState, type ReactNode } from 'react';
import { DEFAULT_SHORTCUTS } from '../../shared/defaults';
import type { AppInfo, SafePermissionMode, Settings as S } from '../../shared/types';
import { api, isMac } from '../lib/api';
import { COMMANDS } from '../lib/commands';
import { eventToShortcut, formatShortcut, normalizeShortcut } from '../lib/shortcuts';
import { applyTerminalSettings } from '../lib/terminals';
import { useStore } from '../state/store';
import { Button } from './ui';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="settings-section" id={`settings-${title.replace(/\W+/g, '-').toLowerCase()}`}>
      <h2 className="settings-h">{title}</h2>
      <div className="settings-card">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="settings-row">
      <div className="settings-label">
        <div>{label}</div>
        {hint && <div className="settings-hint">{hint}</div>}
      </div>
      <div className="settings-control">{children}</div>
    </div>
  );
}

function Toggle({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button role="switch" aria-checked={value} aria-label={label} className={`toggle ${value ? 'is-on' : ''}`} onClick={() => onChange(!value)}>
      <span className="toggle-knob" />
    </button>
  );
}

function Select<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <select className="input select" value={value} onChange={(e) => onChange(e.target.value as T)} aria-label={label}>
      {options.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  );
}

function ShortcutEditor({ settings, set }: { settings: S; set: (p: Partial<S>) => Promise<void> }) {
  const [capturing, setCapturing] = useState<string | null>(null);
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') return setCapturing(null);
      if (['Meta', 'Control', 'Shift', 'Alt'].includes(e.key)) return;
      const sc = eventToShortcut(e, isMac);
      if (!sc || !sc.includes('Mod')) return; // require ⌘ so shortcuts never steal terminal keys
      void set({ shortcuts: { ...settings.shortcuts, [capturing]: normalizeShortcut(sc) } });
      setCapturing(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capturing, settings.shortcuts, set]);

  const conflicts = new Map<string, number>();
  for (const v of Object.values(settings.shortcuts)) conflicts.set(v, (conflicts.get(v) ?? 0) + 1);

  return (
    <div className="shortcut-list">
      {Object.entries(settings.shortcuts).map(([id, sc]) => {
        const title = COMMANDS.find((c) => c.id === id)?.title ?? id;
        return (
          <div key={id} className="shortcut-row">
            <span>{title}</span>
            <span className="flex-1" />
            {(conflicts.get(sc) ?? 0) > 1 && <span className="tag tone-warn">conflict</span>}
            <button className={`kbd-btn ${capturing === id ? 'is-capturing' : ''}`} onClick={() => setCapturing(id)} aria-label={`Change shortcut for ${title}`}>
              {capturing === id ? 'Press keys…' : formatShortcut(sc, isMac)}
            </button>
          </div>
        );
      })}
      <div className="settings-hint">Shortcuts must include {isMac ? '⌘' : 'Ctrl'} so they never intercept keys meant for the terminal. Press Esc to cancel.</div>
    </div>
  );
}

export function SettingsView() {
  const settings = useStore((s) => s.settings);
  const claude = useStore((s) => s.claude);
  const { setSettings, detect } = useStore.getState();
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    void api.invoke('app:info').then(setInfo);
  }, []);
  if (!settings) return null;

  const setTerm = (p: Partial<S>) => void setSettings(p).then(applyTerminalSettings);

  return (
    <div className="settings">
      <div className="settings-inner">
        <h1 className="settings-title">Settings</h1>

        <Section title="Claude Code">
          <Row label="Executable" hint={claude?.found ? <span className="mono">{claude.path}</span> : claude?.error ?? 'Detecting…'}>
            <span className="tag">{settings.claudePath ? 'custom' : 'auto-detect'}</span>
            <Button onClick={() => void api.invoke('claude:chooseExecutable').then((c) => useStore.setState({ claude: c }))}>Choose…</Button>
            {settings.claudePath && <Button variant="ghost" onClick={() => void api.invoke('claude:resetExecutable').then((c) => useStore.setState({ claude: c }))}>Use auto-detect</Button>}
            <Button variant="ghost" icon="refresh" onClick={() => void detect(true)}>Re-detect</Button>
          </Row>
          <Row label="Default model" hint="Passed as --model for new sessions. Leave empty to let Claude Code decide (and switch any time with /model).">
            <input
              className="input"
              defaultValue={settings.defaultModel}
              placeholder="CLI default"
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v !== settings.defaultModel) void setSettings({ defaultModel: v });
              }}
              aria-label="Default model"
            />
          </Row>
          <Row label="Default permission mode" hint="Bypass modes are intentionally not offered. Claude Code still asks before anything its own rules require.">
            <Select<SafePermissionMode>
              label="Default permission mode"
              value={settings.defaultPermissionMode}
              onChange={(v) => void setSettings({ defaultPermissionMode: v })}
              options={[
                ['default', 'Default (ask)'],
                ['plan', 'Plan mode'],
                ['acceptEdits', 'Accept edits'],
                ['manual', 'Manual'],
              ]}
            />
          </Row>
          <Row label="Live session status" hint="Runs `claude agents --json` every 8 s while a Claude session is open and the window is visible (~0.3 s CPU each).">
            <Toggle label="Live session status" value={settings.liveStatusPolling} onChange={(v) => void setSettings({ liveStatusPolling: v })} />
          </Row>
        </Section>

        <Section title="Projects">
          <Row label="Default folder for Open…" hint={settings.defaultProjectDir ?? 'Home folder'}>
            <Button onClick={() => void api.invoke('settings:chooseDefaultProjectDir').then((s) => useStore.setState({ settings: s }))}>Choose…</Button>
          </Row>
        </Section>

        <Section title="Workspace">
          <Row label="Layout preset">
            <Select
              label="Layout preset"
              value={settings.layout}
              onChange={(layout) => {
                const panels = layout === 'focus' ? { leftOpen: false, rightOpen: false, bottomOpen: false } : layout === 'wide-terminal' ? { leftOpen: true, rightOpen: false } : { leftOpen: true, rightOpen: true };
                void setSettings({ layout, ...panels });
              }}
              options={[
                ['balanced', 'Balanced — navigator, terminal, intelligence'],
                ['wide-terminal', 'Wide terminal — navigator + terminal'],
                ['focus', 'Focus — terminal only'],
              ]}
            />
          </Row>
          <Row label="Navigator">
            <Toggle label="Navigator" value={settings.leftOpen} onChange={(v) => void setSettings({ leftOpen: v })} />
          </Row>
          <Row label="Intelligence panel">
            <Toggle label="Intelligence panel" value={settings.rightOpen} onChange={(v) => void setSettings({ rightOpen: v })} />
          </Row>
          <Row label="Bottom panel">
            <Toggle label="Bottom panel" value={settings.bottomOpen} onChange={(v) => void setSettings({ bottomOpen: v })} />
          </Row>
        </Section>

        <Section title="Terminal">
          <Row label="Font size" hint="SF Mono where available.">
            <input className="input range" type="range" min={9} max={24} value={settings.terminalFontSize} onChange={(e) => setTerm({ terminalFontSize: Number(e.target.value) })} aria-label="Terminal font size" />
            <span className="mono tag">{settings.terminalFontSize}px</span>
          </Row>
          <Row label="Line height">
            <input className="input range" type="range" min={1} max={1.6} step={0.05} value={settings.terminalLineHeight} onChange={(e) => setTerm({ terminalLineHeight: Number(e.target.value) })} aria-label="Terminal line height" />
            <span className="mono tag">{settings.terminalLineHeight.toFixed(2)}</span>
          </Row>
          <Row label="Use Option as Meta" hint="Turn on for Meta-key shortcuts; off lets ⌥ type special characters. Shift+Return always inserts a newline in Claude Code.">
            <Toggle label="Option as Meta" value={settings.optionIsMeta} onChange={(v) => setTerm({ optionIsMeta: v })} />
          </Row>
        </Section>

        <Section title="Appearance">
          <Row label="Contrast" hint="High contrast strengthens borders, secondary text and terminal minimum contrast.">
            <Select label="Contrast" value={settings.contrast} onChange={(v) => setTerm({ contrast: v })} options={[['standard', 'Standard'], ['high', 'High']]} />
          </Row>
          <Row label="Reduced motion">
            <Select label="Reduced motion" value={settings.reducedMotion} onChange={(v) => void setSettings({ reducedMotion: v })} options={[['system', 'Follow macOS'], ['on', 'Always reduce'], ['off', 'Full motion']]} />
          </Row>
          <Row label="Background imagery" hint="Starfield and planetary horizon on Mission Control. Never shown behind text you work with.">
            <Toggle label="Background imagery" value={settings.backgroundImagery} onChange={(v) => void setSettings({ backgroundImagery: v })} />
          </Row>
        </Section>

        <Section title="Sessions">
          <Row label="Previous conversations" hint="Show Claude Code conversations for the open project so they can be resumed. Nothing is ever resumed automatically.">
            <Select label="Previous conversations" value={settings.restoreSessions} onChange={(v) => void setSettings({ restoreSessions: v })} options={[['list', 'List for resuming'], ['none', 'Hide']]} />
          </Row>
        </Section>

        <Section title="Shortcuts">
          <ShortcutEditor settings={settings} set={setSettings} />
          <Button variant="ghost" icon="undo" onClick={() => void setSettings({ shortcuts: DEFAULT_SHORTCUTS })}>
            Reset to defaults
          </Button>
        </Section>

        <Section title="Data & Privacy">
          <div className="privacy">
            <p>OBSIDIAN stores four small JSON files (mode 600) in <span className="mono">{info?.userDataPath ?? '…'}</span>:</p>
            <ul>
              <li><b>settings.json</b> — the preferences on this page.</li>
              <li><b>projects.json</b> — folders you opened: name, path, timestamps.</li>
              <li><b>sessions.json</b> — for sessions started here: Claude session id, project, title, timestamps, requested model.</li>
              <li><b>tasks.json</b> — your manual tasks.</li>
            </ul>
            <p>
              It never saves terminal output, prompts, environment variables, or credentials. Claude Code’s own transcripts are read in memory to show model and activity, and are never copied. Authentication stays entirely inside Claude Code.
            </p>
            <Button icon="reveal" onClick={() => void api.invoke('app:revealUserData')}>
              Show in Finder
            </Button>
          </div>
        </Section>

        {info && (
          <div className="settings-foot mono">
            OBSIDIAN {info.version} · Electron {info.electron} · {info.platform} {info.arch} · kernel {info.osRelease}
          </div>
        )}
      </div>
    </div>
  );
}
