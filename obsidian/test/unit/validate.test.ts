import { describe, expect, it } from 'vitest';
import * as v from '../../src/main/validate';

describe('relPath', () => {
  it('accepts normal relative paths', () => {
    expect(v.relPath('src/index.ts')).toBe('src/index.ts');
    expect(v.relPath('')).toBe('');
    expect(v.relPath('a/./b/')).toBe('a/b');
  });
  it('rejects traversal, absolute and backslash paths', () => {
    for (const bad of ['../etc/passwd', 'a/../../b', '/etc/passwd', 'a\\b', '..', 'x\0y']) {
      expect(() => v.relPath(bad)).toThrow();
    }
  });
});

describe('isInside', () => {
  it('detects containment', () => {
    expect(v.isInside('/a/b', '/a/b')).toBe(true);
    expect(v.isInside('/a/b', '/a/b/c')).toBe(true);
    expect(v.isInside('/a/b', '/a/bc')).toBe(false);
    expect(v.isInside('/a/b', '/a')).toBe(false);
  });
});

describe('sessionSpec', () => {
  const base = { kind: 'claude', projectId: 'abc123', mode: 'new', cols: 120, rows: 40 };
  it('accepts a valid spec', () => {
    expect(v.sessionSpec(base)).toMatchObject(base);
  });
  it('never accepts bypass permission modes', () => {
    expect(() => v.sessionSpec({ ...base, permissionMode: 'bypassPermissions' })).toThrow();
    expect(() => v.sessionSpec({ ...base, permissionMode: 'dontAsk' })).toThrow();
    expect(v.sessionSpec({ ...base, permissionMode: 'plan' }).permissionMode).toBe('plan');
  });
  it('requires a UUID for resume', () => {
    expect(() => v.sessionSpec({ ...base, mode: 'resume', resumeId: '--dangerously-skip-permissions' })).toThrow();
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    expect(v.sessionSpec({ ...base, mode: 'resume', resumeId: id }).resumeId).toBe(id);
  });
  it('rejects model names that could smuggle flags or shell syntax', () => {
    expect(() => v.sessionSpec({ ...base, model: 'opus; rm -rf ~' })).toThrow();
    expect(() => v.sessionSpec({ ...base, model: 'a b' })).toThrow();
    expect(v.sessionSpec({ ...base, model: 'opus[1m]' }).model).toBe('opus[1m]');
  });
  it('rejects unknown kinds and shell resume', () => {
    expect(() => v.sessionSpec({ ...base, kind: 'bash' })).toThrow();
    expect(() => v.sessionSpec({ ...base, kind: 'shell', mode: 'continue' })).toThrow();
    expect(() => v.sessionSpec({ ...base, projectId: '../x' })).toThrow();
  });
});

describe('settingsPatch', () => {
  it('refuses executable and directory paths from the renderer', () => {
    expect(() => v.settingsPatch({ claudePath: '/bin/sh' })).toThrow();
    expect(() => v.settingsPatch({ defaultProjectDir: '/' })).toThrow();
  });
  it('validates ranges', () => {
    expect(v.settingsPatch({ terminalFontSize: 14 })).toEqual({ terminalFontSize: 14 });
    expect(() => v.settingsPatch({ terminalFontSize: 400 })).toThrow();
    expect(() => v.settingsPatch({ defaultPermissionMode: 'bypassPermissions' })).toThrow();
  });
});

describe('externalUrl', () => {
  it('only allows http(s)', () => {
    expect(v.externalUrl('https://code.claude.com/docs')).toBe('https://code.claude.com/docs');
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'smb://x', 'not a url']) expect(() => v.externalUrl(bad)).toThrow();
  });
});

describe('pathList', () => {
  it('rejects the root and traversal', () => {
    expect(() => v.pathList([''])).toThrow();
    expect(() => v.pathList(['../x'])).toThrow();
    expect(() => v.pathList([])).toThrow();
    expect(v.pathList(['a.txt', 'dir/b.txt'])).toEqual(['a.txt', 'dir/b.txt']);
  });
});
