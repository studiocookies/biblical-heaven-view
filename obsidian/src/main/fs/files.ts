import fs from 'node:fs';
import path from 'node:path';
import type { DirEntry, FileContent, ProjectChange } from '../../shared/types';
import { isInside } from '../validate';

const HIDDEN = new Set(['.git', '.DS_Store']);
const INDEX_SKIP = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'out', '.venv', 'venv', '__pycache__', 'target', '.cache', 'coverage', 'Pods', '.turbo']);
const MAX_READ = 1024 * 1024;

/** Resolves a validated relative path and ensures (after symlinks) it stays inside the root. */
export function resolveInside(root: string, rel: string): string {
  const realRoot = fs.realpathSync(root);
  const abs = path.resolve(realRoot, rel);
  const real = fs.realpathSync(abs);
  if (!isInside(realRoot, real)) throw new Error('Path resolves outside the project');
  return real;
}

export function listDir(root: string, rel: string): DirEntry[] {
  const dir = resolveInside(root, rel);
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const out: DirEntry[] = [];
  for (const e of entries) {
    if (HIDDEN.has(e.name)) continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    let type: DirEntry['type'] = e.isDirectory() ? 'dir' : 'file';
    if (e.isSymbolicLink()) {
      try {
        type = fs.statSync(path.join(dir, e.name)).isDirectory() ? 'dir' : 'symlink';
      } catch {
        type = 'symlink';
      }
    }
    out.push({ name: e.name, rel: childRel, type });
  }
  out.sort((a, b) => (a.type === 'dir') !== (b.type === 'dir') ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  return out.slice(0, 5000);
}

export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export function readFile(root: string, rel: string): FileContent {
  const abs = resolveInside(root, rel);
  const st = fs.statSync(abs);
  if (!st.isFile()) throw new Error('Not a regular file');
  const len = Math.min(st.size, MAX_READ);
  const fd = fs.openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    const binary = looksBinary(buf);
    return { rel, size: st.size, binary, truncated: st.size > MAX_READ, text: binary ? null : buf.toString('utf8') };
  } finally {
    fs.closeSync(fd);
  }
}

/** File index for quick-open. Built lazily, capped, invalidated by the watcher. */
const indexCache = new Map<string, string[]>();

function buildIndex(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [''];
  while (stack.length && out.length < 30000) {
    const rel = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (HIDDEN.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!INDEX_SKIP.has(e.name)) stack.push(r);
      } else if (e.isFile()) out.push(r);
    }
  }
  return out;
}

export function fuzzyScore(query: string, candidate: string): number {
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  let score = 0;
  let ci = 0;
  let streak = 0;
  for (const ch of q) {
    const found = c.indexOf(ch, ci);
    if (found < 0) return -1;
    streak = found === ci ? streak + 1 : 0;
    score += 1 + streak * 2 - Math.min(found - ci, 10) * 0.1;
    ci = found + 1;
  }
  const base = c.slice(c.lastIndexOf('/') + 1);
  if (base.includes(q)) score += 10;
  if (base.startsWith(q)) score += 5;
  return score - c.length * 0.01;
}

export function search(root: string, query: string, limit = 50): string[] {
  let idx = indexCache.get(root);
  if (!idx) {
    idx = buildIndex(root);
    indexCache.set(root, idx);
  }
  const q = query.trim();
  if (!q) return idx.slice(0, limit);
  return idx
    .map((p) => [p, fuzzyScore(q, p)] as const)
    .filter(([, s]) => s >= 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([p]) => p);
}

/** Watches a project root (FSEvents on macOS), debounced; reports changed directories only. */
export class ProjectWatcher {
  private watchers = new Map<string, { w: fs.FSWatcher; root: string }>();
  private pending = new Map<string, { dirs: Set<string>; git: boolean; timer: NodeJS.Timeout }>();

  constructor(private emit: (c: ProjectChange) => void) {}

  watch(projectId: string, root: string) {
    if (this.watchers.has(projectId)) return;
    try {
      const w = fs.watch(root, { recursive: true, persistent: false }, (_ev, file) => this.onEvent(projectId, root, file ? String(file) : ''));
      w.on('error', () => this.unwatch(projectId));
      this.watchers.set(projectId, { w, root });
    } catch {
      // recursive watch unsupported: the UI still offers manual refresh
    }
  }

  private onEvent(projectId: string, root: string, file: string) {
    const norm = file.split(path.sep).join('/');
    if (norm.startsWith('.git/objects') || norm.startsWith('.git/logs')) return;
    let p = this.pending.get(projectId);
    if (!p) {
      p = {
        dirs: new Set(),
        git: false,
        timer: setTimeout(() => {
          const done = this.pending.get(projectId)!;
          this.pending.delete(projectId);
          indexCache.delete(root);
          this.emit({ projectId, dirs: [...done.dirs].slice(0, 200), gitTouched: done.git });
        }, 450),
      };
      this.pending.set(projectId, p);
    }
    if (norm.startsWith('.git/') || norm === '.git') {
      p.git = true;
    } else {
      p.git = true; // working tree change → git status may change
      const d = path.posix.dirname(norm);
      p.dirs.add(d === '.' ? '' : d);
    }
  }

  unwatch(projectId: string) {
    const entry = this.watchers.get(projectId);
    entry?.w.close();
    this.watchers.delete(projectId);
  }

  closeAll() {
    for (const id of [...this.watchers.keys()]) this.unwatch(id);
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
  }
}
