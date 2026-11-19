import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyEntry, emptyInsight, encodeProjectDir, findTranscript, listHistory, TranscriptTail } from '../../src/main/claude/transcript';

const user = (content: unknown, extra = {}) => ({ type: 'user', timestamp: '2026-10-10T10:00:00Z', message: { role: 'user', content }, ...extra });
const assistant = (content: unknown[], stop: string | null = null, model = 'claude-test-1') => ({ type: 'assistant', timestamp: '2026-10-10T10:00:01Z', message: { model, content, stop_reason: stop } });

describe('applyEntry', () => {
  it('derives model, turn state, tools and todos', () => {
    const st = emptyInsight();
    applyEntry(st, user('Fix the login bug'));
    expect(st.prompts).toBe(1);
    expect(st.turnState).toBe('working');
    applyEntry(st, assistant([{ type: 'tool_use', name: 'Edit', input: { file_path: '/repo/src/a.ts' } }], 'tool_use'), '/repo');
    expect(st.model).toBe('claude-test-1');
    expect(st.turnState).toBe('tool-pending');
    expect(st.events.at(-1)).toMatchObject({ kind: 'tool', label: 'Edit', detail: 'src/a.ts' });
    applyEntry(st, user([{ type: 'tool_result', content: 'ok' }]));
    expect(st.turnState).toBe('working');
    expect(st.prompts).toBe(1);
    applyEntry(st, assistant([{ type: 'tool_use', name: 'TodoWrite', input: { todos: [{ content: 'Write tests', status: 'in_progress' }] } }]));
    expect(st.todos).toEqual([{ content: 'Write tests', status: 'in_progress' }]);
    applyEntry(st, assistant([{ type: 'text', text: 'Done.' }], 'end_turn'));
    expect(st.turnState).toBe('idle');
    applyEntry(st, { type: 'ai-title', aiTitle: 'Login bug fix' });
    expect(st.title).toBe('Login bug fix');
  });
  it('ignores synthetic models, meta entries, sidechains and junk', () => {
    const st = emptyInsight();
    applyEntry(st, assistant([{ type: 'text', text: 'x' }], 'end_turn', '<synthetic>'));
    expect(st.model).toBeNull();
    applyEntry(st, user('<command-name>/clear</command-name>'));
    applyEntry(st, user('meta', { isMeta: true }));
    applyEntry(st, user('sub', { isSidechain: true }));
    expect(st.prompts).toBe(0);
    applyEntry(st, { type: 'assistant' });
    applyEntry(st, { nonsense: 1 });
  });
});

describe('transcript files', () => {
  it('encodes project directories like Claude Code', () => {
    expect(encodeProjectDir('/home/user/biblical-heaven-view')).toBe('-home-user-biblical-heaven-view');
    expect(encodeProjectDir('/Users/me/My App')).toBe('-Users-me-My-App');
  });
  it('tails appended lines incrementally and lists history', () => {
    const projects = fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-tx-'));
    const cwd = '/Users/me/proj';
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const dir = path.join(projects, encodeProjectDir(cwd));
    fs.mkdirSync(dir);
    const file = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(file, JSON.stringify(user('hello there')) + '\n');
    expect(findTranscript(projects, cwd, id)).toBe(file);

    const tail = new TranscriptTail(file, cwd);
    expect(tail.poll()).toBe(true);
    expect(tail.poll()).toBe(false);
    fs.appendFileSync(file, JSON.stringify(assistant([{ type: 'text', text: 'hi' }], 'end_turn')) + '\n{"type":"assi');
    expect(tail.poll()).toBe(true);
    expect(tail.state.model).toBe('claude-test-1');
    fs.appendFileSync(file, 'stant"}\n');
    tail.poll();
    expect(tail.state.prompts).toBe(1);

    const hist = listHistory(projects, cwd, new Set([id]));
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ claudeSessionId: id, title: 'hello there', startedInObsidian: true });
  });
});
