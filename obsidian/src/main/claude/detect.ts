import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AuthState, ClaudeCapabilities, ClaudeInfo } from '../../shared/types';
import { childEnv, mergedPath, resolveLoginPath } from '../env';

function run(file: string, args: string[], timeout = 15000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, env: childEnv(), maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      // exit code when the process ran; null when it timed out, was killed, or failed to spawn
      const raw = (err as { code?: unknown } | null)?.code;
      const code = !err ? 0 : typeof raw === 'number' ? raw : null;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

export function isExecutableFile(p: string): boolean {
  try {
    const real = fs.realpathSync(p);
    if (!fs.statSync(real).isFile()) return false;
    fs.accessSync(real, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function candidatePaths(pathVar: string, home = os.homedir()): string[] {
  const fromPath = pathVar.split(':').filter(Boolean).map((d) => path.join(d, 'claude'));
  const known = [
    path.join(home, '.local/bin/claude'),
    path.join(home, '.claude/local/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    path.join(home, '.npm-global/bin/claude'),
    path.join(home, '.bun/bin/claude'),
    path.join(home, '.volta/bin/claude'),
  ];
  return [...new Set([...fromPath, ...known])];
}

export function parseVersion(out: string): string | null {
  return out.match(/(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/)?.[1] ?? null;
}

/** Feature-detect flags from `claude --help` rather than assuming a version's surface. */
export function parseCapabilities(help: string, agentsHelp: string): ClaudeCapabilities {
  const has = (flag: string) => new RegExp(`(^|[\\s,])${flag.replace(/[-]/g, '\\-')}([\\s,<\\[]|$)`, 'm').test(help);
  return {
    sessionId: has('--session-id'),
    resume: has('--resume'),
    continue: has('--continue'),
    model: has('--model'),
    permissionMode: has('--permission-mode'),
    name: has('--name'),
    agentsJson: /--json/.test(agentsHelp),
    authStatusJson: /^\s+auth\b/m.test(help),
  };
}

/** Reads only whitelisted, non-secret fields from `claude auth status --json`. */
export function parseAuth(stdout: string): { auth: AuthState; projectsDirectory: string | null } {
  try {
    const start = stdout.indexOf('{');
    const o = JSON.parse(stdout.slice(start)) as Record<string, unknown>;
    const projectsDirectory = typeof o.projectsDirectory === 'string' ? o.projectsDirectory : null;
    if (o.loggedIn === true) {
      return {
        auth: {
          state: 'logged-in',
          method: typeof o.authMethod === 'string' ? o.authMethod : null,
          provider: typeof o.apiProvider === 'string' ? o.apiProvider : null,
        },
        projectsDirectory,
      };
    }
    if (o.loggedIn === false) return { auth: { state: 'logged-out' }, projectsDirectory };
  } catch {
    // fall through
  }
  return { auth: { state: 'unknown', reason: 'Could not read `claude auth status` output' }, projectsDirectory: null };
}

export function defaultProjectsDirectory(): string {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(base, 'projects');
}

let cached: ClaudeInfo | null = null;
const capsCache = new Map<string, ClaudeCapabilities>();

export function lastClaudeInfo(): ClaudeInfo | null {
  return cached;
}

export async function detectClaude(configuredPath: string | null, force = false): Promise<ClaudeInfo> {
  if (cached && !force && cached.path === (configuredPath ?? cached.path)) return cached;
  await resolveLoginPath();

  const info: ClaudeInfo = {
    found: false,
    path: null,
    source: null,
    version: null,
    capabilities: null,
    auth: { state: 'unknown', reason: 'Claude Code not found' },
    apiKeyEnvPresent: typeof process.env.ANTHROPIC_API_KEY === 'string' && process.env.ANTHROPIC_API_KEY.length > 0,
    projectsDirectory: defaultProjectsDirectory(),
    error: null,
    checkedAt: Date.now(),
  };

  if (configuredPath) {
    if (isExecutableFile(configuredPath)) {
      info.path = configuredPath;
      info.source = 'settings';
    } else {
      // An explicit choice is never silently replaced by a different binary.
      info.error = `The Claude Code executable set in Settings is missing or not executable: ${configuredPath}`;
      info.auth = { state: 'unknown', reason: 'Claude Code not found' };
      cached = info;
      return info;
    }
  }
  if (!info.path) {
    const pathDirs = mergedPath();
    const pathSet = new Set(pathDirs.split(':'));
    for (const c of candidatePaths(pathDirs)) {
      if (isExecutableFile(c)) {
        info.path = c;
        info.source = pathSet.has(path.dirname(c)) ? 'login-shell-path' : 'known-location';
        break;
      }
    }
  }
  if (!info.path) {
    info.error ??= 'Claude Code executable not found on PATH or in standard install locations.';
    cached = info;
    return info;
  }

  const ver = await run(info.path, ['--version']);
  info.version = parseVersion(ver.stdout) ?? parseVersion(ver.stderr);
  if (!info.version) {
    info.error = `\`${path.basename(info.path)} --version\` did not report a version (exit ${ver.code ?? 'timeout'}).`;
    cached = info;
    return info;
  }
  info.found = true;

  const capKey = `${info.path}@${info.version}`;
  let caps = capsCache.get(capKey);
  if (!caps) {
    const [help, agentsHelp] = await Promise.all([run(info.path, ['--help']), run(info.path, ['agents', '--help'])]);
    caps = parseCapabilities(help.stdout, agentsHelp.stdout + agentsHelp.stderr);
    capsCache.set(capKey, caps);
  }
  info.capabilities = caps;

  if (caps.authStatusJson) {
    const st = await run(info.path, ['auth', 'status', '--json'], 20000);
    const parsed = parseAuth(st.stdout);
    info.auth = parsed.auth;
    if (parsed.projectsDirectory) info.projectsDirectory = parsed.projectsDirectory;
  } else {
    info.auth = { state: 'unknown', reason: 'This Claude Code version has no `auth status` command' };
  }

  cached = info;
  return info;
}
