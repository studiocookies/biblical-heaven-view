import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as git from '../../src/main/git/git';

describe('parseStatusV2', () => {
  it('parses branch, changes, renames, untracked and conflicts', () => {
    const out = [
      '# branch.oid abc',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 aaa bbb src/file with space.ts',
      '1 A. N... 000000 100644 100644 000 ccc added.ts',
      '2 R. N... 100644 100644 100644 ddd eee R100 new name.ts',
      'old name.ts',
      'u UU N... 100644 100644 100644 100644 f1 f2 f3 conflict.ts',
      '? untracked.txt',
      '',
    ].join('\0');
    const s = git.parseStatusV2(out);
    expect(s.branch).toBe('main');
    expect(s.upstream).toBe('origin/main');
    expect([s.ahead, s.behind]).toEqual([2, 1]);
    expect(s.files.map((f) => f.path)).toEqual(['src/file with space.ts', 'added.ts', 'new name.ts', 'conflict.ts', 'untracked.txt']);
    expect(s.files[0]).toMatchObject({ staged: false, unstaged: true });
    expect(s.files[1]).toMatchObject({ staged: true, unstaged: false });
    expect(s.files[2].origPath).toBe('old name.ts');
    expect(s.files[3].conflicted).toBe(true);
    expect(s.files[4].untracked).toBe(true);
  });
  it('detects detached HEAD', () => {
    expect(git.parseStatusV2('# branch.head (detached)\0').detached).toBe(true);
  });
});

describe('git against a real repository', () => {
  it('reports accurate status and diffs, stages and commits', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-git-'));
    const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@example.com');
    g('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    g('add', '.');
    g('commit', '-qm', 'init');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
    fs.writeFileSync(path.join(dir, 'new.txt'), 'fresh\n');

    const st = await git.status(dir);
    expect(st.isRepo).toBe(true);
    expect(st.branch).toBe('main');
    expect(st.files.map((f) => [f.path, f.untracked])).toEqual([['a.txt', false], ['new.txt', true]]);

    const d = await git.diff(dir, 'a.txt', false, false);
    expect(d.text).toContain('+two');
    const u = await git.diff(dir, 'new.txt', false, true);
    expect(u.text).toContain('+fresh');

    await git.stage(dir, ['a.txt']);
    expect((await git.status(dir)).files.find((f) => f.path === 'a.txt')?.staged).toBe(true);
    const hash = await git.commit(dir, 'second');
    expect(hash).toMatch(/^[0-9a-f]{7,}$/);
    const log = await git.log(dir);
    expect(log[0].subject).toBe('second');

    fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
    await git.discard(dir, ['a.txt']);
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('one\ntwo\n');

    const notRepo = await git.status(os.tmpdir());
    expect(notRepo.isRepo).toBe(false);
  });
});
