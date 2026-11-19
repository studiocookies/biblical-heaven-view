import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentDefinition, LiveAgent } from '../../shared/types';
import { childEnv } from '../env';

export function parseLiveAgents(stdout: string): LiveAgent[] | null {
  try {
    const start = stdout.indexOf('[');
    if (start < 0) return null;
    const arr = JSON.parse(stdout.slice(start));
    if (!Array.isArray(arr)) return null;
    const s = (v: unknown) => (typeof v === 'string' ? v : null);
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    return arr
      .filter((a) => a && typeof a === 'object' && typeof a.sessionId === 'string')
      .slice(0, 500)
      .map((a) => ({
        sessionId: a.sessionId,
        pid: n(a.pid),
        cwd: s(a.cwd),
        kind: s(a.kind),
        status: s(a.status),
        name: s(a.name),
        startedAt: n(a.startedAt),
      }));
  } catch {
    return null;
  }
}

export function fetchLiveAgents(claudePath: string): Promise<LiveAgent[] | null> {
  return new Promise((resolve) => {
    execFile(claudePath, ['agents', '--json'], { timeout: 10000, env: childEnv(), maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) return resolve(null);
      resolve(parseLiveAgents(String(stdout)));
    });
  });
}

/**
 * Polls `claude agents --json` adaptively. It costs ~0.3 s of CPU per call, so it only runs while a
 * Claude session is alive and the window is visible, every 8 s, plus an on-demand nudge.
 */
export class AgentPoller {
  private timer: NodeJS.Timeout | null = null;
  private nudgeTimer: NodeJS.Timeout | null = null;
  private inFlight = false;
  last: LiveAgent[] | null = null;

  constructor(
    private shouldRun: () => boolean,
    private claudePath: () => string | null,
    private onResult: (agents: LiveAgent[] | null) => void,
  ) {}

  kick() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 8000);
    this.tick();
  }

  nudge(delay = 1500) {
    if (this.nudgeTimer) return;
    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = null;
      this.tick();
    }, delay);
  }

  async tick(): Promise<LiveAgent[] | null> {
    const p = this.claudePath();
    if (!this.shouldRun() || !p) {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      return this.last;
    }
    if (this.inFlight) return this.last;
    this.inFlight = true;
    try {
      this.last = await fetchLiveAgents(p);
      this.onResult(this.last);
      return this.last;
    } finally {
      this.inFlight = false;
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.nudgeTimer) clearTimeout(this.nudgeTimer);
    this.timer = this.nudgeTimer = null;
  }
}

/** Parses the YAML-ish frontmatter of a subagent definition file (name/description/model only). */
export function parseAgentFile(text: string): { name: string | null; description: string | null; model: string | null } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const out = { name: null as string | null, description: null as string | null, model: null as string | null };
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(name|description|model):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    (out as any)[kv[1]] = v.slice(0, 500) || null;
  }
  return out;
}

/** Subagent definitions from <project>/.claude/agents and ~/.claude/agents (read-only). */
export function listAgentDefinitions(projectRoot: string | null): AgentDefinition[] {
  const dirs: { dir: string; scope: AgentDefinition['scope'] }[] = [];
  if (projectRoot) dirs.push({ dir: path.join(projectRoot, '.claude', 'agents'), scope: 'project' });
  const userBase = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  dirs.push({ dir: path.join(userBase, 'agents'), scope: 'user' });
  const out: AgentDefinition[] = [];
  for (const { dir, scope } of dirs) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith('.md')).slice(0, 200);
    } catch {
      continue;
    }
    for (const n of names) {
      const file = path.join(dir, n);
      try {
        const fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(8192);
        const len = fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        const meta = parseAgentFile(buf.subarray(0, len).toString('utf8'));
        out.push({ name: meta.name ?? n.replace(/\.md$/, ''), description: meta.description, model: meta.model, scope, file });
      } catch {
        // unreadable file: skip
      }
    }
  }
  return out;
}
