import { randomUUID } from 'node:crypto';
import path from 'node:path';
import * as pty from 'node-pty';
import type { ClaudeInfo, LiveAgent, Project, SessionInfo, SessionSpec, TranscriptInsight } from '../../shared/types';
import { loginShell, terminalEnv } from '../env';
import { buildClaudeArgs, displayCommand } from './args';
import { findTranscript, TranscriptTail } from './transcript';

const FLUSH_MS = 8;
const FLUSH_BYTES = 64 * 1024;
const HIGH_WATER = 1024 * 1024;
const LOW_WATER = 256 * 1024;
const KILL_GRACE_MS = 3000;

interface Live {
  info: SessionInfo;
  proc: pty.IPty | null;
  buffer: string;
  flushTimer: NodeJS.Timeout | null;
  unacked: number;
  paused: boolean;
  killTimer: NodeJS.Timeout | null;
  tail: TranscriptTail | null;
  cwd: string;
  lastTranscriptLookup: number;
}

export interface SessionEvents {
  data(id: string, data: string): void;
  update(info: SessionInfo): void;
  insight(insight: TranscriptInsight): void;
  claudeSessionKnown(info: SessionInfo): void;
}

export class SessionManager {
  private sessions = new Map<string, Live>();
  private transcriptTimer: NodeJS.Timeout | null = null;

  constructor(private events: SessionEvents, private appVersion: string, private projectsDir: () => string | null) {}

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => s.info);
  }

  get(id: string): SessionInfo | null {
    return this.sessions.get(id)?.info ?? null;
  }

  hasRunningClaude(): boolean {
    for (const s of this.sessions.values()) if (s.info.kind === 'claude' && s.info.state === 'running') return true;
    return false;
  }

  runningCount(): number {
    let n = 0;
    for (const s of this.sessions.values()) if (s.info.state === 'running' || s.info.state === 'starting') n++;
    return n;
  }

  create(spec: SessionSpec, project: Project, claude: ClaudeInfo): SessionInfo {
    const id = randomUUID().replace(/-/g, '').slice(0, 16);
    const info: SessionInfo = {
      id,
      kind: spec.kind,
      projectId: project.id,
      title: spec.title || (spec.kind === 'claude' ? 'Claude Code' : 'Shell'),
      claudeSessionId: null,
      mode: spec.mode,
      requestedModel: spec.model ?? null,
      permissionMode: spec.permissionMode ?? null,
      pid: null,
      state: 'starting',
      exitCode: null,
      signal: null,
      error: null,
      startedAt: Date.now(),
      endedAt: null,
      commandLine: '',
    };
    const live: Live = {
      info,
      proc: null,
      buffer: '',
      flushTimer: null,
      unacked: 0,
      paused: false,
      killTimer: null,
      tail: null,
      cwd: project.root,
      lastTranscriptLookup: 0,
    };
    this.sessions.set(id, live);

    let file: string;
    let args: string[];
    const banner: string[] = [];
    try {
      if (spec.kind === 'claude') {
        if (!claude.found || !claude.path || !claude.capabilities) {
          throw new Error(claude.error ?? 'Claude Code was not detected. Open Settings → Claude Code to locate it.');
        }
        const built = buildClaudeArgs(spec, claude.capabilities, randomUUID);
        file = claude.path;
        args = built.args;
        info.claudeSessionId = built.claudeSessionId;
        banner.push(...built.warnings);
      } else {
        const sh = loginShell();
        if (!sh) throw new Error('No login shell found in /etc/shells.');
        file = sh;
        args = ['-l'];
      }
      info.commandLine = displayCommand(file, args);
      const proc = pty.spawn(file, args, {
        name: 'xterm-256color',
        cols: spec.cols,
        rows: spec.rows,
        cwd: project.root,
        env: terminalEnv(this.appVersion),
      });
      live.proc = proc;
      info.pid = proc.pid;
      info.state = 'running';
      for (const w of banner) this.queue(live, `\x1b[38;2;233;189;114m[OBSIDIAN] ${w}\x1b[0m\r\n`);
      proc.onData((d) => this.queue(live, d));
      proc.onExit(({ exitCode, signal }) => this.onExit(live, exitCode, signal ?? null));
    } catch (err) {
      info.state = 'failed';
      info.error = (err as Error).message;
      info.endedAt = Date.now();
    }
    this.events.update(info);
    if (info.claudeSessionId) this.events.claudeSessionKnown(info);
    this.ensureTranscriptPolling();
    return info;
  }

  private queue(live: Live, data: string) {
    live.buffer += data;
    if (live.buffer.length >= FLUSH_BYTES) return this.flush(live);
    if (!live.flushTimer) live.flushTimer = setTimeout(() => this.flush(live), FLUSH_MS);
  }

  private flush(live: Live) {
    if (live.flushTimer) clearTimeout(live.flushTimer);
    live.flushTimer = null;
    if (!live.buffer) return;
    const chunk = live.buffer;
    live.buffer = '';
    live.unacked += chunk.length;
    this.events.data(live.info.id, chunk);
    if (!live.paused && live.unacked > HIGH_WATER && live.proc && live.info.state === 'running') {
      live.paused = true;
      live.proc.pause();
    }
  }

  /** Renderer reports how many characters xterm has finished parsing. */
  ack(id: string, chars: number) {
    const live = this.sessions.get(id);
    if (!live) return;
    live.unacked = Math.max(0, live.unacked - chars);
    if (live.paused && live.unacked < LOW_WATER && live.proc) {
      live.paused = false;
      live.proc.resume();
    }
  }

  write(id: string, data: string) {
    const live = this.sessions.get(id);
    if (!live?.proc || live.info.state !== 'running') return;
    live.proc.write(data);
  }

  resize(id: string, cols: number, rows: number) {
    const live = this.sessions.get(id);
    if (!live?.proc || live.info.state !== 'running') return;
    try {
      live.proc.resize(cols, rows);
    } catch {
      // the process may have exited between the check and the call
    }
  }

  private onExit(live: Live, exitCode: number, signal: number | null) {
    this.flush(live);
    if (live.killTimer) clearTimeout(live.killTimer);
    live.killTimer = null;
    live.info.state = 'exited';
    live.info.exitCode = exitCode;
    live.info.signal = signal || null;
    live.info.endedAt = Date.now();
    live.proc = null;
    const quick = live.info.endedAt - live.info.startedAt < 4000;
    if (live.info.kind === 'claude' && quick && exitCode !== 0 && !signal) {
      live.info.error =
        'Claude Code exited right after starting. Check the output above — common causes are a missing login (run `claude auth login` in a shell tab), an unsupported flag, or a resume id with no saved conversation.';
    }
    live.tail?.poll();
    this.events.update(live.info);
  }

  /** Terminates only the process OBSIDIAN spawned for this tab: SIGHUP, then SIGKILL after a grace period. */
  kill(id: string) {
    const live = this.sessions.get(id);
    if (!live?.proc || live.info.state !== 'running') return;
    const proc = live.proc;
    try {
      proc.kill('SIGHUP');
    } catch {
      // already gone
    }
    live.killTimer = setTimeout(() => {
      if (live.proc === proc) {
        try {
          proc.kill('SIGKILL');
        } catch {
          // already gone
        }
      }
    }, KILL_GRACE_MS);
  }

  dispose(id: string) {
    const live = this.sessions.get(id);
    if (!live) return;
    this.kill(id);
    if (live.flushTimer) clearTimeout(live.flushTimer);
    this.sessions.delete(id);
  }

  /** Called on quit. Resolves once every child has exited or been force-killed. */
  async killAll(): Promise<void> {
    const running = [...this.sessions.values()].filter((s) => s.proc);
    for (const s of running) this.kill(s.info.id);
    const deadline = Date.now() + KILL_GRACE_MS + 500;
    while (Date.now() < deadline && running.some((s) => s.proc)) await new Promise((r) => setTimeout(r, 50));
    if (this.transcriptTimer) clearInterval(this.transcriptTimer);
    this.transcriptTimer = null;
  }

  /** Match `claude agents --json` entries to our PTYs by pid to learn session ids for --continue / picker. */
  applyLiveAgents(agents: LiveAgent[]) {
    for (const live of this.sessions.values()) {
      if (live.info.kind !== 'claude' || live.info.state !== 'running' || !live.info.pid) continue;
      const match = agents.find((a) => a.pid === live.info.pid);
      if (match && match.sessionId && match.sessionId !== live.info.claudeSessionId && /^[0-9a-f-]{36}$/i.test(match.sessionId)) {
        live.info.claudeSessionId = match.sessionId.toLowerCase();
        live.tail = null;
        live.lastTranscriptLookup = 0;
        this.events.update(live.info);
        this.events.claudeSessionKnown(live.info);
      }
    }
  }

  insight(id: string): TranscriptInsight | null {
    const live = this.sessions.get(id);
    if (!live) return null;
    return this.toInsight(live);
  }

  private toInsight(live: Live): TranscriptInsight {
    const st = live.tail?.state;
    return {
      sessionId: live.info.id,
      transcriptFound: !!live.tail,
      model: st?.model ?? null,
      turnState: st?.turnState ?? 'unknown',
      prompts: st?.prompts ?? 0,
      toolCalls: st?.toolCalls ?? 0,
      todos: st?.todos ?? null,
      events: st?.events.slice(-120) ?? [],
      updatedAt: Date.now(),
    };
  }

  transcriptTitle(id: string): string | null {
    return this.sessions.get(id)?.tail?.state.title ?? null;
  }

  private ensureTranscriptPolling() {
    if (this.transcriptTimer) return;
    this.transcriptTimer = setInterval(() => this.pollTranscripts(), 1500);
  }

  private pollTranscripts() {
    const dir = this.projectsDir();
    let active = 0;
    for (const live of this.sessions.values()) {
      if (live.info.kind !== 'claude') continue;
      if (live.info.state !== 'running') continue;
      active++;
      if (!live.tail && live.info.claudeSessionId && dir) {
        const now = Date.now();
        if (now - live.lastTranscriptLookup < 4000) continue;
        live.lastTranscriptLookup = now;
        const file = findTranscript(dir, live.cwd, live.info.claudeSessionId);
        if (file) live.tail = new TranscriptTail(file, path.resolve(live.cwd));
      }
      if (live.tail?.poll()) this.events.insight(this.toInsight(live));
    }
    if (active === 0 && this.transcriptTimer) {
      clearInterval(this.transcriptTimer);
      this.transcriptTimer = null;
    }
  }
}
