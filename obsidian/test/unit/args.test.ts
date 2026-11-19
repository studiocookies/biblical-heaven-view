import { describe, expect, it } from 'vitest';
import { buildClaudeArgs, displayCommand } from '../../src/main/claude/args';
import type { ClaudeCapabilities, SessionSpec } from '../../src/shared/types';

const caps: ClaudeCapabilities = { sessionId: true, resume: true, continue: true, model: true, permissionMode: true, name: true, agentsJson: true, authStatusJson: true };
const spec = (s: Partial<SessionSpec>): SessionSpec => ({ kind: 'claude', projectId: 'p1', mode: 'new', cols: 80, rows: 24, ...s });
const fixedId = () => '11111111-2222-4333-8444-555555555555';

describe('buildClaudeArgs', () => {
  it('assigns a session id to new sessions', () => {
    const r = buildClaudeArgs(spec({}), caps, fixedId);
    expect(r.args).toEqual(['--session-id', fixedId()]);
    expect(r.claudeSessionId).toBe(fixedId());
  });
  it('resumes, continues, and opens the picker', () => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    expect(buildClaudeArgs(spec({ mode: 'resume', resumeId: id }), caps, fixedId).args).toEqual(['--resume', id]);
    expect(buildClaudeArgs(spec({ mode: 'continue' }), caps, fixedId).args).toEqual(['--continue']);
    expect(buildClaudeArgs(spec({ mode: 'picker' }), caps, fixedId).args).toEqual(['--resume']);
  });
  it('passes model and non-default permission mode, never bypass flags', () => {
    const r = buildClaudeArgs(spec({ model: 'opus', permissionMode: 'plan' }), caps, fixedId);
    expect(r.args).toContain('--model');
    expect(r.args).toContain('plan');
    expect(r.args.join(' ')).not.toMatch(/dangerously|bypass/);
    expect(buildClaudeArgs(spec({ permissionMode: 'default' }), caps, fixedId).args).not.toContain('--permission-mode');
  });
  it('drops unsupported flags with warnings', () => {
    const old = { ...caps, sessionId: false, model: false };
    const r = buildClaudeArgs(spec({ model: 'opus' }), old, fixedId);
    expect(r.args).toEqual([]);
    expect(r.claudeSessionId).toBeNull();
    expect(r.warnings.length).toBe(2);
    expect(() => buildClaudeArgs(spec({ mode: 'continue' }), { ...caps, continue: false }, fixedId)).toThrow();
  });
});

describe('displayCommand', () => {
  it('quotes for display', () => {
    expect(displayCommand('/usr/bin/claude', ['--name', "it's mine"])).toBe(`/usr/bin/claude --name 'it'\\''s mine'`);
  });
});
