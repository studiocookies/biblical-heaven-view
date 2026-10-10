import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let loginPath: string | null = null;
let resolving: Promise<string | null> | null = null;

/** The user's login shell, only if it is a registered shell in /etc/shells. */
export function loginShell(): string | null {
  const candidate = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  try {
    const shells = fs
      .readFileSync('/etc/shells', 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    if (shells.includes(candidate) && fs.existsSync(candidate)) return candidate;
    return shells.find((s) => s.endsWith('/zsh') && fs.existsSync(s)) ?? shells.find((s) => fs.existsSync(s)) ?? null;
  } catch {
    return fs.existsSync(candidate) ? candidate : null;
  }
}

/**
 * Apps launched from Finder/Dock inherit launchd's minimal PATH, which usually misses
 * ~/.local/bin, Homebrew and npm globals. Ask the login shell once for its PATH (only PATH,
 * nothing else from the environment is read).
 */
export function resolveLoginPath(): Promise<string | null> {
  if (loginPath !== null) return Promise.resolve(loginPath);
  if (resolving) return resolving;
  const shell = loginShell();
  if (!shell || process.platform === 'win32') return Promise.resolve(null);
  const marker = '__OBSIDIAN_PATH__';
  resolving = new Promise((resolve) => {
    execFile(
      shell,
      ['-ilc', `printf '${marker}%s${marker}' "$PATH"`],
      { timeout: 6000, env: { ...process.env, OBSIDIAN_RESOLVING_ENV: '1' }, maxBuffer: 1024 * 1024 },
      (_err, stdout) => {
        const m = String(stdout ?? '').match(new RegExp(`${marker}(.*?)${marker}`, 's'));
        loginPath = m && m[1] ? m[1].trim() : '';
        resolve(loginPath || null);
      },
    );
  });
  return resolving;
}

export function mergedPath(): string {
  const extra = [
    path.join(os.homedir(), '.local/bin'),
    path.join(os.homedir(), '.claude/local'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  const parts = [...(loginPath ? loginPath.split(':') : []), ...(process.env.PATH ?? '').split(':'), ...extra];
  return [...new Set(parts.filter(Boolean))].join(':');
}

const STRIP = ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'OBSIDIAN_RESOLVING_ENV'];

/** Environment for child processes. Inherits the user's environment (needed for auth/keychain). */
export function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
  for (const k of STRIP) delete env[k];
  env.PATH = mergedPath();
  if (!env.LANG) env.LANG = 'en_US.UTF-8';
  return { ...env, ...extra };
}

export function terminalEnv(version: string): Record<string, string> {
  return childEnv({
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'OBSIDIAN',
    TERM_PROGRAM_VERSION: version,
  });
}
