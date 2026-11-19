import { useEffect, useMemo, useRef, useState } from 'react';
import { api, isMac } from '../lib/api';
import { COMMANDS } from '../lib/commands';
import { basename, dirname } from '../lib/format';
import { formatShortcut } from '../lib/shortcuts';
import { useStore } from '../state/store';
import { Icon, type IconName } from './Icon';

interface Item {
  id: string;
  title: string;
  hint?: string;
  icon: IconName;
  kbd?: string;
  disabled?: boolean;
  run: () => void;
}

function score(q: string, text: string): number {
  if (!q) return 1;
  const t = text.toLowerCase();
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  let s = 0;
  for (const w of words) {
    const i = t.indexOf(w);
    if (i < 0) return -1;
    s += i === 0 ? 3 : t[i - 1] === ' ' ? 2 : 1;
  }
  return s;
}

export function Palette() {
  const mode = useStore((s) => s.paletteOpen);
  const projects = useStore((s) => s.projects);
  const sessions = useStore((s) => s.sessions);
  const titles = useStore((s) => s.sessionTitles);
  const projectId = useStore((s) => s.activeProjectId);
  const shortcuts = useStore((s) => s.settings?.shortcuts ?? {});
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [files, setFiles] = useState<string[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const close = () => useStore.setState({ paletteOpen: false });

  useEffect(() => {
    setQ('');
    setSel(0);
  }, [mode]);

  useEffect(() => {
    if (mode !== 'files' || !projectId) return;
    let alive = true;
    const t = setTimeout(() => void api.invoke('fs:search', projectId, q).then((r) => alive && setFiles(r)), q ? 60 : 0);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [mode, q, projectId]);

  const items: Item[] = useMemo(() => {
    if (mode === 'files') {
      return files.map((f) => ({ id: f, title: basename(f), hint: dirname(f), icon: 'file' as IconName, run: () => projectId && useStore.getState().openFile(projectId, f) }));
    }
    const cmds: Item[] = COMMANDS.map((c) => ({
      id: c.id,
      title: c.title,
      hint: c.group,
      icon: 'command' as IconName,
      kbd: formatShortcut(shortcuts[c.id], isMac),
      disabled: c.enabled ? !c.enabled() : false,
      run: () => void c.run(),
    }));
    const sess: Item[] = Object.values(sessions).map((s) => ({
      id: `tab:${s.id}`,
      title: `Go to ${titles[s.id] || s.title}`,
      hint: `${s.kind} · ${s.state}`,
      icon: s.kind === 'claude' ? 'claude' : 'terminal',
      run: () => useStore.getState().activateTab(s.id),
    }));
    const proj: Item[] = projects.map((p) => ({
      id: `proj:${p.id}`,
      title: `Switch to ${p.name}`,
      hint: p.root,
      icon: 'projects' as IconName,
      run: () => useStore.getState().selectProject(p.id),
    }));
    return [...cmds, ...sess, ...proj]
      .map((it) => [it, score(q, `${it.title} ${it.hint ?? ''}`)] as const)
      .filter(([, s]) => s >= 0)
      .sort((a, b) => b[1] - a[1] || Number(a[0].disabled) - Number(b[0].disabled))
      .map(([it]) => it);
  }, [mode, q, files, sessions, projects, titles, shortcuts, projectId]);

  useEffect(() => {
    void listRef.current?.querySelector(`[data-idx="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  if (!mode) return null;

  const choose = (it: Item | undefined) => {
    if (!it || it.disabled) return;
    close();
    it.run();
  };

  return (
    <div className="overlay" onMouseDown={close}>
      <div className="palette" role="dialog" aria-modal="true" aria-label={mode === 'files' ? 'Quick open' : 'Command palette'} onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-input-row">
          <Icon name={mode === 'files' ? 'search' : 'command'} size={15} />
          <input
            autoFocus
            className="palette-input"
            placeholder={mode === 'files' ? (projectId ? 'Search files by name…' : 'Open a project first') : 'Type a command, session or project…'}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setSel(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') close();
              else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSel((s) => Math.min(items.length - 1, s + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSel((s) => Math.max(0, s - 1));
              } else if (e.key === 'Enter') choose(items[sel]);
            }}
            aria-label="Search"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
          />
          <span className="palette-mode mono">{mode === 'files' ? 'FILES' : 'COMMANDS'}</span>
        </div>
        <div className="palette-list" id="palette-list" role="listbox" ref={listRef}>
          {items.length === 0 && <div className="palette-empty">No matches</div>}
          {items.slice(0, 80).map((it, i) => (
            <div
              key={it.id}
              data-idx={i}
              role="option"
              aria-selected={i === sel}
              aria-disabled={it.disabled}
              className={`palette-item ${i === sel ? 'is-sel' : ''} ${it.disabled ? 'is-disabled' : ''}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => choose(it)}
            >
              <Icon name={it.icon} size={14} />
              <span className="palette-title">{it.title}</span>
              {it.hint && <span className="palette-hint mono">{it.hint}</span>}
              <span className="flex-1" />
              {it.kbd && <span className="palette-kbd">{it.kbd}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
