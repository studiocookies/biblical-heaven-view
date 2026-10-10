import type { ClaudeCapabilities, SessionSpec } from '../../shared/types';

export interface BuiltArgs {
  args: string[];
  claudeSessionId: string | null;
  warnings: string[];
}

/**
 * Builds argv for an interactive Claude Code session from a validated spec.
 * Never emits bypass/skip-permission flags. Unsupported options are dropped with a warning.
 */
export function buildClaudeArgs(spec: SessionSpec, caps: ClaudeCapabilities, newId: () => string): BuiltArgs {
  const args: string[] = [];
  const warnings: string[] = [];
  let claudeSessionId: string | null = null;

  switch (spec.mode) {
    case 'new':
      if (caps.sessionId) {
        claudeSessionId = newId();
        args.push('--session-id', claudeSessionId);
      } else {
        warnings.push('This Claude Code version lacks --session-id; the session id will be detected later if possible.');
      }
      break;
    case 'resume':
      if (!caps.resume) throw new Error('This Claude Code version does not support --resume.');
      args.push('--resume', spec.resumeId!);
      claudeSessionId = spec.resumeId!;
      break;
    case 'continue':
      if (!caps.continue) throw new Error('This Claude Code version does not support --continue.');
      args.push('--continue');
      break;
    case 'picker':
      if (!caps.resume) throw new Error('This Claude Code version does not support --resume.');
      args.push('--resume');
      break;
  }

  if (spec.model) {
    if (caps.model) args.push('--model', spec.model);
    else warnings.push('--model is not supported by this Claude Code version; using its default model.');
  }
  if (spec.permissionMode && spec.permissionMode !== 'default') {
    if (caps.permissionMode) args.push('--permission-mode', spec.permissionMode);
    else warnings.push('--permission-mode is not supported; Claude Code will use its configured mode.');
  }
  if (spec.title && caps.name && spec.mode === 'new') args.push('--name', spec.title);

  return { args, claudeSessionId, warnings };
}

/** Quote argv for display only (diagnostics). Never executed. */
export function displayCommand(file: string, args: string[]): string {
  const q = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
  return [file, ...args].map(q).join(' ');
}
