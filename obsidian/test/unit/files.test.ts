import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fuzzyScore, listDir, readFile, resolveInside, search } from '../../src/main/fs/files';
import { Store } from '../../src/main/store';

describe('project filesystem access', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-fs-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, 'src', 'main.ts'), 'export {}\n');
  fs.writeFileSync(path.join(root, 'README.md'), '# hi\n');
  fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([1, 0, 2, 3]));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-out-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'nope');
  fs.symlinkSync(outside, path.join(root, 'escape'));

  it('lists directories first and hides .git', () => {
    const names = listDir(root, '').map((e) => e.name);
    expect(names[0]).toBe('escape');
    expect(names).toContain('src');
    expect(names).not.toContain('.git');
  });
  it('reads text, flags binary', () => {
    expect(readFile(root, 'README.md').text).toBe('# hi\n');
    expect(readFile(root, 'bin.dat').binary).toBe(true);
  });
  it('blocks symlink escapes', () => {
    expect(() => resolveInside(root, 'escape/secret.txt')).toThrow(/outside/);
    expect(() => listDir(root, 'escape')).toThrow(/outside/);
  });
  it('quick-open search ranks basename matches', () => {
    expect(search(root, 'main')[0]).toBe('src/main.ts');
    expect(fuzzyScore('zz', 'abc')).toBe(-1);
  });
});

describe('Store', () => {
  it('persists atomically with 0600 permissions and merges defaults', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-store-'));
    const s = new Store(dir);
    expect(s.get('settings').terminalFontSize).toBe(13);
    s.set('settings', { ...s.get('settings'), terminalFontSize: 15 });
    s.flush();
    const file = path.join(dir, 'settings.json');
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600');
    const s2 = new Store(dir);
    expect(s2.get('settings').terminalFontSize).toBe(15);
    expect(s2.get('settings').shortcuts['session.newClaude']).toBe('Mod+T');
    fs.writeFileSync(path.join(dir, 'tasks.json'), '{corrupt');
    expect(new Store(dir).get('tasks')).toEqual([]);
  });
});
