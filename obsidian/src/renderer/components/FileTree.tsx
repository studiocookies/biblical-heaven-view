import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import type { DirEntry, GitFileChange } from '../../shared/types';
import { api } from '../lib/api';
import { useStore } from '../state/store';
import { Icon } from './Icon';

type Listing = { entries: DirEntry[] | null; error: string | null };

const expandedByProject = new Map<string, Set<string>>();

export function gitBadge(c: GitFileChange | undefined): { letter: string; tone: string } | null {
  if (!c) return null;
  if (c.conflicted) return { letter: '!', tone: 'err' };
  if (c.untracked) return { letter: 'U', tone: 'ok' };
  const code = c.worktree !== '.' && c.worktree !== '?' ? c.worktree : c.index;
  const tone = code === 'D' ? 'err' : code === 'A' ? 'ok' : 'warn';
  return { letter: code === '.' ? 'M' : code, tone };
}

export function FileTree({ projectId, filter = '' }: { projectId: string; filter?: string }) {
  const [listings, setListings] = useState<Record<string, Listing>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => expandedByProject.get(projectId) ?? new Set(['']));
  const git = useStore((s) => s.git[projectId]);
  const changed = useStore((s) => s.changedDirs[projectId]);
  const version = useStore((s) => s.fsVersion[projectId] ?? 0);
  const openFile = useStore((s) => s.openFile);
  const activeTabId = useStore((s) => s.activeTabId);

  const load = useCallback(
    async (rel: string) => {
      const res = await api.invoke('fs:list', projectId, rel);
      setListings((l) => ({ ...l, [rel]: res.ok ? { entries: res.value, error: null } : { entries: null, error: res.error } }));
    },
    [projectId],
  );

  useEffect(() => {
    setListings({});
    const exp = expandedByProject.get(projectId) ?? new Set(['']);
    setExpanded(exp);
    for (const rel of exp) void load(rel);
  }, [projectId, load]);

  // Watcher reported changes: re-list only directories that are expanded.
  useEffect(() => {
    if (!changed || version === 0) return;
    const dirs = new Set(changed);
    for (const rel of expanded) if (dirs.has(rel) || dirs.size === 0) void load(rel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const toggle = (rel: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(rel)) next.delete(rel);
      else {
        next.add(rel);
        if (!listings[rel]) void load(rel);
      }
      expandedByProject.set(projectId, next);
      return next;
    });
  };

  const changes = useMemo(() => {
    const m = new Map<string, GitFileChange>();
    const dirs = new Set<string>();
    for (const f of git?.files ?? []) {
      m.set(f.path, f);
      let d = f.path;
      while (d.includes('/')) {
        d = d.slice(0, d.lastIndexOf('/'));
        dirs.add(d);
      }
    }
    return { m, dirs };
  }, [git]);

  const f = filter.trim().toLowerCase();
  const root = listings[''];
  if (!root) return <div className="tree-loading">Scanning…</div>;
  if (root.error) return <div className="tree-error">{root.error}</div>;

  const renderLevel = (rel: string, depth: number): React.ReactNode => {
    const l = listings[rel];
    if (!l) return <div className="tree-row tree-muted" style={{ paddingLeft: 10 + depth * 13 }}>…</div>;
    if (l.error) return <div className="tree-row tree-error" style={{ paddingLeft: 10 + depth * 13 }}>{l.error}</div>;
    const entries = f ? l.entries!.filter((e) => e.type === 'dir' || e.name.toLowerCase().includes(f)) : l.entries!;
    if (!entries.length) return depth > 0 ? <div className="tree-row tree-muted" style={{ paddingLeft: 10 + depth * 13 }}>empty</div> : null;
    return entries.map((e) => (
      <TreeRow
        key={e.rel}
        entry={e}
        depth={depth}
        open={expanded.has(e.rel)}
        active={activeTabId === `file:${projectId}:${e.rel}`}
        badge={e.type === 'dir' ? (changes.dirs.has(e.rel) ? { letter: '•', tone: 'warn' } : null) : gitBadge(changes.m.get(e.rel))}
        onToggle={toggle}
        onOpen={(rel) => openFile(projectId, rel)}
      >
        {e.type === 'dir' && expanded.has(e.rel) ? renderLevel(e.rel, depth + 1) : null}
      </TreeRow>
    ));
  };

  return (
    <div className="tree" role="tree" aria-label="Project files">
      {renderLevel('', 0)}
    </div>
  );
}

const TreeRow = memo(function TreeRow({
  entry,
  depth,
  open,
  active,
  badge,
  onToggle,
  onOpen,
  children,
}: {
  entry: DirEntry;
  depth: number;
  open: boolean;
  active: boolean;
  badge: { letter: string; tone: string } | null;
  onToggle: (rel: string) => void;
  onOpen: (rel: string) => void;
  children: React.ReactNode;
}) {
  const isDir = entry.type === 'dir';
  return (
    <>
      <button
        className={`tree-row ${active ? 'is-active' : ''}`}
        style={{ paddingLeft: 8 + depth * 13 }}
        role="treeitem"
        aria-expanded={isDir ? open : undefined}
        onClick={() => (isDir ? onToggle(entry.rel) : onOpen(entry.rel))}
        title={entry.rel}
      >
        <span className="tree-caret">{isDir && <Icon name={open ? 'chevronDown' : 'chevronRight'} size={11} />}</span>
        <Icon name={isDir ? (open ? 'folderOpen' : 'folder') : 'file'} size={14} className={isDir ? 'tree-icon-dir' : 'tree-icon-file'} />
        <span className={`tree-name ${badge ? `tone-${badge.tone}` : ''}`}>{entry.name}</span>
        {entry.type === 'symlink' && <span className="tree-tag">link</span>}
        {badge && <span className={`tree-badge tone-${badge.tone}`}>{badge.letter}</span>}
      </button>
      {children}
    </>
  );
});
