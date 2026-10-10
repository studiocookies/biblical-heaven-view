import fs from 'node:fs';
import path from 'node:path';
import type { ActivityEvent, HistoryEntry, TodoItem, TranscriptInsight } from '../../shared/types';

/*
 * Claude Code writes each conversation to <projectsDirectory>/<encoded cwd>/<sessionId>.jsonl.
 * The format is internal and undocumented, so everything here is best-effort and read-only:
 * unknown shapes are ignored, and nothing read here is persisted by OBSIDIAN.
 */

export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

export function findTranscript(projectsDir: string, cwd: string, sessionId: string): string | null {
  const direct = path.join(projectsDir, encodeProjectDir(cwd), `${sessionId}.jsonl`);
  if (fs.existsSync(direct)) return direct;
  // Fallback in case the directory encoding differs in this Claude Code version.
  try {
    const dirs = fs.readdirSync(projectsDir, { withFileTypes: true }).slice(0, 5000);
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const p = path.join(projectsDir, d.name, `${sessionId}.jsonl`);
      if (fs.existsSync(p)) return p;
    }
  } catch {
    // projects directory may not exist yet
  }
  return null;
}

export interface InsightState {
  model: string | null;
  turnState: TranscriptInsight['turnState'];
  prompts: number;
  toolCalls: number;
  todos: TodoItem[] | null;
  events: ActivityEvent[];
  title: string | null;
}

export const emptyInsight = (): InsightState => ({
  model: null,
  turnState: 'unknown',
  prompts: 0,
  toolCalls: 0,
  todos: null,
  events: [],
  title: null,
});

const MAX_EVENTS = 250;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

function toolDetail(name: string, input: Record<string, unknown>, cwd: string | null): string | undefined {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : undefined);
  const file = s('file_path') ?? s('notebook_path') ?? s('path');
  if (file) return cwd && file.startsWith(cwd + '/') ? file.slice(cwd.length + 1) : file;
  const v = s('description') ?? s('command') ?? s('pattern') ?? s('url') ?? s('query') ?? s('prompt') ?? s('subject');
  if (v) return clip(oneLine(v), 110);
  if (name === 'TodoWrite' && Array.isArray(input.todos)) return `${input.todos.length} items`;
  return undefined;
}

function parseTodos(input: Record<string, unknown>): TodoItem[] | null {
  if (!Array.isArray(input.todos)) return null;
  const out: TodoItem[] = [];
  for (const t of input.todos.slice(0, 200)) {
    if (t && typeof t === 'object' && typeof (t as any).content === 'string') {
      out.push({ content: clip((t as any).content, 300), status: typeof (t as any).status === 'string' ? (t as any).status : 'pending' });
    }
  }
  return out;
}

function ts(o: Record<string, unknown>): number {
  const t = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
  return Number.isFinite(t) ? t : Date.now();
}

/** Fold one transcript entry into the insight state. Pure apart from mutation of `st`. */
export function applyEntry(st: InsightState, o: Record<string, unknown>, cwd: string | null = null): void {
  const push = (e: ActivityEvent) => {
    st.events.push(e);
    if (st.events.length > MAX_EVENTS) st.events.splice(0, st.events.length - MAX_EVENTS);
  };
  const type = o.type;
  if (type === 'ai-title' && typeof o.aiTitle === 'string') {
    st.title = clip(oneLine(o.aiTitle), 120);
    return;
  }
  if (type === 'summary' && typeof o.summary === 'string' && !st.title) {
    st.title = clip(oneLine(o.summary), 120);
    return;
  }
  const msg = o.message as Record<string, unknown> | undefined;
  if (!msg || typeof msg !== 'object') return;
  const sidechain = o.isSidechain === true;

  if (type === 'user') {
    if (o.isMeta === true) return;
    const content = msg.content;
    if (typeof content === 'string') {
      if (sidechain || content.startsWith('<')) return; // command wrappers / system reminders
      st.prompts += 1;
      st.turnState = 'working';
      push({ at: ts(o), kind: 'prompt', label: 'Prompt', detail: clip(oneLine(content), 140) });
    } else if (Array.isArray(content)) {
      const hasResult = content.some((c) => c && typeof c === 'object' && (c as any).type === 'tool_result');
      const text = content.find((c) => c && typeof c === 'object' && (c as any).type === 'text' && typeof (c as any).text === 'string');
      if (hasResult) {
        if (!sidechain) st.turnState = 'working';
      } else if (text && !sidechain && !(text as any).text.startsWith('<')) {
        st.prompts += 1;
        st.turnState = 'working';
        push({ at: ts(o), kind: 'prompt', label: 'Prompt', detail: clip(oneLine((text as any).text), 140) });
      }
    }
    return;
  }

  if (type === 'assistant') {
    if (typeof msg.model === 'string' && msg.model && !msg.model.startsWith('<') && !sidechain) st.model = msg.model;
    const content = Array.isArray(msg.content) ? msg.content : [];
    let sawTool = false;
    let sawText = false;
    for (const c of content) {
      if (!c || typeof c !== 'object') continue;
      const block = c as Record<string, unknown>;
      if (block.type === 'tool_use' && typeof block.name === 'string') {
        sawTool = true;
        st.toolCalls += 1;
        const input = (block.input && typeof block.input === 'object' ? block.input : {}) as Record<string, unknown>;
        if (block.name === 'TodoWrite') {
          const todos = parseTodos(input);
          if (todos) st.todos = todos;
        }
        push({
          at: ts(o),
          kind: 'tool',
          label: sidechain ? `${block.name} (subagent)` : block.name,
          detail: toolDetail(block.name, input, cwd),
        });
      } else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() && !sidechain) {
        sawText = true;
        push({ at: ts(o), kind: 'reply', label: 'Reply', detail: clip(oneLine(block.text), 140) });
      }
    }
    if (sidechain) return;
    if (sawTool) st.turnState = 'tool-pending';
    else if (sawText) st.turnState = msg.stop_reason === 'end_turn' ? 'idle' : 'working';
  }
}

/** Incrementally reads appended lines from a transcript file. */
export class TranscriptTail {
  private offset = 0;
  private partial = '';
  readonly state = emptyInsight();

  constructor(readonly file: string, private cwd: string | null) {}

  /** Returns true when new entries were applied. */
  poll(): boolean {
    let size: number;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return false;
    }
    if (size < this.offset) {
      // file was rewritten (e.g. compaction); start over
      this.offset = 0;
      this.partial = '';
      Object.assign(this.state, emptyInsight());
    }
    if (size === this.offset) return false;
    const fd = fs.openSync(this.file, 'r');
    try {
      const len = Math.min(size - this.offset, 8 * 1024 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, this.offset);
      this.offset += len;
      const text = this.partial + buf.toString('utf8');
      const lines = text.split('\n');
      this.partial = lines.pop() ?? '';
      let changed = false;
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          applyEntry(this.state, JSON.parse(line), this.cwd);
          changed = true;
        } catch {
          // ignore malformed lines
        }
      }
      return changed;
    } finally {
      fs.closeSync(fd);
    }
  }
}

/** Lists conversations Claude Code has stored for a directory (newest first). */
export function listHistory(projectsDir: string, cwd: string, obsidianIds: Set<string>, limit = 60): HistoryEntry[] {
  const dir = path.join(projectsDir, encodeProjectDir(cwd));
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => /^[0-9a-f-]{36}\.jsonl$/i.test(n));
  } catch {
    return [];
  }
  const entries = names
    .map((n) => {
      try {
        const st = fs.statSync(path.join(dir, n));
        return { n, st };
      } catch {
        return null;
      }
    })
    .filter((x): x is { n: string; st: fs.Stats } => !!x)
    .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)
    .slice(0, limit);

  return entries.map(({ n, st }) => {
    const id = n.slice(0, 36).toLowerCase();
    return {
      claudeSessionId: id,
      title: readTitle(path.join(dir, n), st.size),
      modifiedAt: st.mtimeMs,
      sizeBytes: st.size,
      startedInObsidian: obsidianIds.has(id),
    };
  });
}

/** Reads a short title: the latest ai-title, else the first real prompt. Reads at most 256 KB. */
function readTitle(file: string, size: number): string | null {
  const CHUNK = 128 * 1024;
  const fd = fs.openSync(file, 'r');
  try {
    const read = (pos: number, len: number) => {
      const b = Buffer.alloc(len);
      fs.readSync(fd, b, 0, len, pos);
      return b.toString('utf8');
    };
    const head = read(0, Math.min(size, CHUNK));
    const tail = size > CHUNK ? read(Math.max(CHUNK, size - CHUNK), Math.min(CHUNK, size - CHUNK)) : '';
    const st = emptyInsight();
    for (const line of (head + '\n' + tail).split('\n')) {
      if (!line.includes('"ai-title"') && !line.includes('"summary"') && !(st.prompts === 0 && line.includes('"type":"user"'))) continue;
      try {
        applyEntry(st, JSON.parse(line));
      } catch {
        // partial line at a chunk boundary
      }
    }
    return st.title ?? st.events.find((e) => e.kind === 'prompt')?.detail ?? null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}
