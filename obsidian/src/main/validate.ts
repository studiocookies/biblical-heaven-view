import path from 'node:path';
import {
  SAFE_PERMISSION_MODES,
  type LayoutPreset,
  type SafePermissionMode,
  type SessionSpec,
  type Settings,
  type Task,
} from '../shared/types';

export class ValidationError extends Error {}

const fail = (msg: string): never => {
  throw new ValidationError(msg);
};

export function str(v: unknown, name: string, max = 4096): string {
  if (typeof v !== 'string') fail(`${name} must be a string`);
  if ((v as string).length > max) fail(`${name} is too long`);
  if ((v as string).includes('\0')) fail(`${name} contains a NUL byte`);
  return v as string;
}

export function bool(v: unknown, name: string): boolean {
  if (typeof v !== 'boolean') fail(`${name} must be a boolean`);
  return v as boolean;
}

export function int(v: unknown, name: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) fail(`${name} out of range`);
  return v as number;
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export function id(v: unknown, name = 'id'): string {
  const s = str(v, name, 64);
  if (!ID_RE.test(s)) fail(`${name} is malformed`);
  return s;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function uuid(v: unknown, name = 'uuid'): string {
  const s = str(v, name, 36);
  if (!UUID_RE.test(s)) fail(`${name} must be a UUID`);
  return s.toLowerCase();
}

/** Model aliases / names: letters, digits, dot, dash, underscore, brackets (e.g. "opus[1m]"). */
const MODEL_RE = /^[A-Za-z0-9._\-[\]]{1,80}$/;
export function model(v: unknown): string {
  const s = str(v, 'model', 80);
  if (!MODEL_RE.test(s)) fail('model name contains unsupported characters');
  return s;
}

export function permissionMode(v: unknown): SafePermissionMode {
  if (!SAFE_PERMISSION_MODES.includes(v as SafePermissionMode)) fail('permission mode not allowed');
  return v as SafePermissionMode;
}

/**
 * A path relative to a project root. Rejects absolute paths, traversal and odd separators.
 * The empty string means the root itself. Symlink escapes are checked separately with realpath.
 */
export function relPath(v: unknown, name = 'path'): string {
  const s = str(v, name, 2048);
  if (s === '' || s === '.') return '';
  if (path.isAbsolute(s) || s.includes('\\')) fail(`${name} must be relative`);
  const norm = path.posix.normalize(s);
  if (norm === '..' || norm.startsWith('../') || norm.split('/').includes('..')) fail(`${name} escapes the project`);
  return norm.replace(/\/+$/, '');
}

/** True when `child` is `parent` or inside it. Both must be absolute, resolved paths. */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function sessionSpec(v: unknown): SessionSpec {
  if (!v || typeof v !== 'object') fail('session spec must be an object');
  const o = v as Record<string, unknown>;
  const kind = o.kind;
  if (kind !== 'claude' && kind !== 'shell') fail('unknown session kind');
  const mode = o.mode;
  if (mode !== 'new' && mode !== 'resume' && mode !== 'continue' && mode !== 'picker') fail('unknown launch mode');
  const spec: SessionSpec = {
    kind: kind as SessionSpec['kind'],
    projectId: id(o.projectId, 'projectId'),
    mode: mode as SessionSpec['mode'],
    cols: int(o.cols, 'cols', 10, 1000),
    rows: int(o.rows, 'rows', 4, 500),
  };
  if (spec.kind === 'shell' && spec.mode !== 'new') fail('shell sessions only support mode "new"');
  if (spec.mode === 'resume') spec.resumeId = uuid(o.resumeId, 'resumeId');
  if (o.model !== undefined && o.model !== null && o.model !== '') spec.model = model(o.model);
  if (o.permissionMode !== undefined && o.permissionMode !== null) spec.permissionMode = permissionMode(o.permissionMode);
  if (o.title !== undefined && o.title !== null && o.title !== '') spec.title = str(o.title, 'title', 120);
  return spec;
}

const LAYOUTS: LayoutPreset[] = ['balanced', 'focus', 'wide-terminal'];

/** Validates a settings patch. Executable / directory paths are NOT settable from the renderer. */
export function settingsPatch(v: unknown): Partial<Settings> {
  if (!v || typeof v !== 'object') fail('settings patch must be an object');
  const o = v as Record<string, unknown>;
  const out: Partial<Settings> = {};
  for (const [k, val] of Object.entries(o)) {
    switch (k) {
      case 'layout':
        if (!LAYOUTS.includes(val as LayoutPreset)) fail('unknown layout');
        out.layout = val as LayoutPreset;
        break;
      case 'leftWidth': out.leftWidth = int(val, k, 180, 600); break;
      case 'rightWidth': out.rightWidth = int(val, k, 240, 720); break;
      case 'bottomHeight': out.bottomHeight = int(val, k, 100, 700); break;
      case 'leftOpen': out.leftOpen = bool(val, k); break;
      case 'rightOpen': out.rightOpen = bool(val, k); break;
      case 'bottomOpen': out.bottomOpen = bool(val, k); break;
      case 'terminalFontSize': out.terminalFontSize = int(val, k, 9, 28); break;
      case 'terminalLineHeight':
        if (typeof val !== 'number' || val < 1 || val > 2) fail('line height out of range');
        out.terminalLineHeight = val as number;
        break;
      case 'optionIsMeta': out.optionIsMeta = bool(val, k); break;
      case 'contrast':
        if (val !== 'standard' && val !== 'high') fail('unknown contrast');
        out.contrast = val as Settings['contrast'];
        break;
      case 'reducedMotion':
        if (val !== 'system' && val !== 'on' && val !== 'off') fail('unknown motion setting');
        out.reducedMotion = val as Settings['reducedMotion'];
        break;
      case 'backgroundImagery': out.backgroundImagery = bool(val, k); break;
      case 'restoreSessions':
        if (val !== 'none' && val !== 'list') fail('unknown restore setting');
        out.restoreSessions = val as Settings['restoreSessions'];
        break;
      case 'defaultModel': out.defaultModel = val === '' ? '' : model(val); break;
      case 'defaultPermissionMode': out.defaultPermissionMode = permissionMode(val); break;
      case 'liveStatusPolling': out.liveStatusPolling = bool(val, k); break;
      case 'onboarded': out.onboarded = bool(val, k); break;
      case 'shortcuts': {
        if (!val || typeof val !== 'object') fail('shortcuts must be an object');
        const sc: Record<string, string> = {};
        for (const [ck, cv] of Object.entries(val as Record<string, unknown>).slice(0, 100)) {
          sc[str(ck, 'shortcut command', 64)] = str(cv, 'shortcut', 40);
        }
        out.shortcuts = sc;
        break;
      }
      default:
        fail(`setting "${k}" cannot be changed here`);
    }
  }
  return out;
}

export function tasks(v: unknown): Task[] {
  if (!Array.isArray(v)) fail('tasks must be an array');
  if ((v as unknown[]).length > 2000) fail('too many tasks');
  return (v as unknown[]).map((t, i) => {
    if (!t || typeof t !== 'object') fail(`task ${i} malformed`);
    const o = t as Record<string, unknown>;
    return {
      id: id(o.id, 'task id'),
      projectId: o.projectId === null ? null : id(o.projectId, 'task projectId'),
      title: str(o.title, 'task title', 500),
      done: bool(o.done, 'task done'),
      createdAt: int(o.createdAt, 'createdAt', 0, Number.MAX_SAFE_INTEGER),
      updatedAt: int(o.updatedAt, 'updatedAt', 0, Number.MAX_SAFE_INTEGER),
    };
  });
}

export function commitMessage(v: unknown): string {
  const s = str(v, 'commit message', 10_000).trim();
  if (!s) fail('commit message is empty');
  return s;
}

export function pathList(v: unknown): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > 500) fail('paths must be a non-empty array');
  return (v as unknown[]).map((p) => {
    const r = relPath(p);
    if (!r) fail('path must not be the project root');
    return r;
  });
}

export function externalUrl(v: unknown): string {
  const s = str(v, 'url', 4096);
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return fail('invalid URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') fail('only http(s) links can be opened');
  return u.toString();
}
