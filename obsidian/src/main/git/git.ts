import { execFile } from 'node:child_process';
import type { DiffResult, GitCommit, GitFileChange, GitStatus } from '../../shared/types';
import { childEnv } from '../env';

const MAX_DIFF = 2 * 1024 * 1024;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function git(cwd: string, args: string[], timeout = 20000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=off', '-c', 'color.ui=never', ...args],
      {
        cwd,
        timeout,
        maxBuffer: MAX_DIFF + 1024 * 1024,
        // Never block on credential prompts; don't take optional locks that would contend with Claude's own git use.
        env: childEnv({ GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' }),
      },
      (err, stdout, stderr) => {
        const raw = (err as { code?: unknown } | null)?.code;
        resolve({ code: !err ? 0 : typeof raw === 'number' ? raw : null, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
  });
}

/** Parses `git status --porcelain=v2 --branch -z`. */
export function parseStatusV2(out: string): Omit<GitStatus, 'isRepo' | 'error' | 'updatedAt'> {
  const res: Omit<GitStatus, 'isRepo' | 'error' | 'updatedAt'> = {
    branch: null,
    detached: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    files: [],
  };
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (!line) continue;
    if (line.startsWith('# branch.head ')) {
      const head = line.slice(14);
      if (head === '(detached)') res.detached = true;
      else res.branch = head;
    } else if (line.startsWith('# branch.upstream ')) {
      res.upstream = line.slice(18);
    } else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+) -(\d+)/);
      if (m) {
        res.ahead = Number(m[1]);
        res.behind = Number(m[2]);
      }
    } else if (line.startsWith('1 ') || line.startsWith('2 ') || line.startsWith('u ')) {
      const kind = line[0];
      const fieldCount = kind === '1' ? 8 : kind === '2' ? 9 : 10;
      const fields = splitN(line, fieldCount);
      const xy = fields[1];
      const p = fields[fieldCount];
      const change = mkChange(p, xy[0], xy[1], kind === 'u');
      if (kind === '2') change.origPath = parts[++i];
      res.files.push(change);
    } else if (line.startsWith('? ')) {
      res.files.push({ path: line.slice(2), index: '?', worktree: '?', staged: false, unstaged: true, untracked: true, conflicted: false });
    }
  }
  return res;
}

function splitN(line: string, n: number): string[] {
  const out: string[] = [];
  let rest = line;
  for (let k = 0; k < n; k++) {
    const sp = rest.indexOf(' ');
    if (sp < 0) break;
    out.push(rest.slice(0, sp));
    rest = rest.slice(sp + 1);
  }
  out.push(rest);
  return out;
}

function mkChange(path: string, x: string, y: string, conflicted: boolean): GitFileChange {
  return {
    path,
    index: x,
    worktree: y,
    staged: !conflicted && x !== '.',
    unstaged: conflicted || y !== '.',
    untracked: false,
    conflicted,
  };
}

const inflight = new Map<string, Promise<GitStatus>>();

export function status(cwd: string): Promise<GitStatus> {
  const existing = inflight.get(cwd);
  if (existing) return existing;
  const p = (async (): Promise<GitStatus> => {
    const r = await git(cwd, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal']);
    if (r.code !== 0) {
      const notRepo = /not a git repository/i.test(r.stderr);
      return {
        isRepo: false,
        branch: null,
        detached: false,
        upstream: null,
        ahead: 0,
        behind: 0,
        files: [],
        error: notRepo ? null : r.stderr.trim().split('\n')[0] || 'git status failed',
        updatedAt: Date.now(),
      };
    }
    return { isRepo: true, ...parseStatusV2(r.stdout), error: null, updatedAt: Date.now() };
  })().finally(() => inflight.delete(cwd));
  inflight.set(cwd, p);
  return p;
}

export async function diff(cwd: string, file: string, staged: boolean, untracked: boolean): Promise<DiffResult> {
  const args = untracked
    ? ['diff', '--no-ext-diff', '--no-index', '--', '/dev/null', file]
    : ['diff', '--no-ext-diff', ...(staged ? ['--cached'] : []), '--', file];
  const r = await git(cwd, args);
  // --no-index exits 1 when files differ; that's success here.
  if (r.code !== 0 && !(untracked && r.code === 1)) throw new Error(r.stderr.trim() || 'git diff failed');
  const truncated = r.stdout.length > MAX_DIFF;
  return { path: file, staged, untracked, text: truncated ? r.stdout.slice(0, MAX_DIFF) : r.stdout, truncated };
}

export async function log(cwd: string, n = 30): Promise<GitCommit[]> {
  const r = await git(cwd, ['log', `-n${n}`, '--format=%H%x1f%h%x1f%s%x1f%an%x1f%ct%x1e']);
  if (r.code !== 0) return [];
  return r.stdout
    .split('\x1e')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((rec) => {
      const [hash, short, subject, author, ct] = rec.split('\x1f');
      return { hash, short, subject, author, date: Number(ct) * 1000 };
    });
}

async function mutate(cwd: string, args: string[]): Promise<void> {
  const r = await git(cwd, args, 60000);
  if (r.code !== 0) throw new Error(r.stderr.trim() || r.stdout.trim() || `git ${args[0]} failed`);
}

export const stage = (cwd: string, paths: string[]) => mutate(cwd, ['add', '--', ...paths]);
export const unstage = (cwd: string, paths: string[]) => mutate(cwd, ['restore', '--staged', '--', ...paths]);
/** Restores tracked files in the working tree. Untracked files are never deleted. */
export const discard = (cwd: string, paths: string[]) => mutate(cwd, ['restore', '--worktree', '--', ...paths]);

export async function commit(cwd: string, message: string): Promise<string> {
  await mutate(cwd, ['commit', '-m', message]);
  const r = await git(cwd, ['rev-parse', '--short', 'HEAD']);
  return r.stdout.trim();
}
