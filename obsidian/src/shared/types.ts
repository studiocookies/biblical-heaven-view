// The complete contract between the sandboxed renderer and the main process.
// Every request type here is validated in src/main/validate.ts before use.

export type SessionKind = 'claude' | 'shell';
export type LaunchMode = 'new' | 'resume' | 'continue' | 'picker';

/** Permission modes OBSIDIAN is willing to pass. Bypass modes are deliberately absent. */
export const SAFE_PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'manual'] as const;
export type SafePermissionMode = (typeof SAFE_PERMISSION_MODES)[number];

export interface Project {
  id: string;
  name: string;
  root: string;
  addedAt: number;
  lastOpenedAt: number;
}

export interface ClaudeCapabilities {
  sessionId: boolean;
  resume: boolean;
  continue: boolean;
  model: boolean;
  permissionMode: boolean;
  name: boolean;
  agentsJson: boolean;
  authStatusJson: boolean;
}

export type AuthState =
  | { state: 'unknown'; reason: string }
  | { state: 'logged-in'; method: string | null; provider: string | null }
  | { state: 'logged-out' };

export interface ClaudeInfo {
  found: boolean;
  path: string | null;
  source: 'settings' | 'login-shell-path' | 'known-location' | null;
  version: string | null;
  capabilities: ClaudeCapabilities | null;
  auth: AuthState;
  /** True when ANTHROPIC_API_KEY is present in the environment sessions inherit. Value is never read. */
  apiKeyEnvPresent: boolean;
  projectsDirectory: string | null;
  error: string | null;
  checkedAt: number;
}

export interface SessionSpec {
  kind: SessionKind;
  projectId: string;
  mode: LaunchMode;
  /** Claude session UUID to resume (mode === 'resume'). */
  resumeId?: string;
  model?: string;
  permissionMode?: SafePermissionMode;
  title?: string;
  cols: number;
  rows: number;
}

export type ProcessState = 'starting' | 'running' | 'exited' | 'failed';

export interface SessionInfo {
  id: string; // OBSIDIAN tab id
  kind: SessionKind;
  projectId: string;
  title: string;
  /** Claude Code conversation UUID, when known. */
  claudeSessionId: string | null;
  mode: LaunchMode;
  requestedModel: string | null;
  permissionMode: SafePermissionMode | null;
  pid: number | null;
  state: ProcessState;
  exitCode: number | null;
  signal: number | null;
  error: string | null;
  startedAt: number;
  endedAt: number | null;
  /** Human readable argv (no env) for diagnostics. */
  commandLine: string;
}

export interface ActivityEvent {
  at: number;
  kind: 'prompt' | 'tool' | 'reply' | 'result' | 'system';
  label: string;
  detail?: string;
}

export interface TodoItem {
  content: string;
  status: string;
}

export interface TranscriptInsight {
  sessionId: string; // OBSIDIAN tab id
  transcriptFound: boolean;
  model: string | null;
  turnState: 'idle' | 'working' | 'tool-pending' | 'unknown';
  prompts: number;
  toolCalls: number;
  todos: TodoItem[] | null;
  events: ActivityEvent[];
  updatedAt: number;
}

export interface LiveAgent {
  sessionId: string;
  pid: number | null;
  cwd: string | null;
  kind: string | null;
  status: string | null;
  name: string | null;
  startedAt: number | null;
}

export interface SessionRecord {
  claudeSessionId: string;
  projectId: string;
  title: string;
  createdAt: number;
  lastActiveAt: number;
  requestedModel: string | null;
}

export interface HistoryEntry {
  claudeSessionId: string;
  title: string | null;
  modifiedAt: number;
  sizeBytes: number;
  startedInObsidian: boolean;
}

export interface DirEntry {
  name: string;
  rel: string;
  type: 'dir' | 'file' | 'symlink';
}

export interface FileContent {
  rel: string;
  size: number;
  binary: boolean;
  truncated: boolean;
  text: string | null;
}

export interface GitFileChange {
  path: string;
  origPath?: string;
  index: string; // X
  worktree: string; // Y
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
}

export interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFileChange[];
  error: string | null;
  updatedAt: number;
}

export interface GitCommit {
  hash: string;
  short: string;
  subject: string;
  author: string;
  date: number;
}

export interface DiffResult {
  path: string;
  staged: boolean;
  untracked: boolean;
  text: string;
  truncated: boolean;
}

export interface AgentDefinition {
  name: string;
  description: string | null;
  model: string | null;
  scope: 'project' | 'user';
  file: string;
}

export interface Task {
  id: string;
  projectId: string | null;
  title: string;
  done: boolean;
  createdAt: number;
  updatedAt: number;
}

export type LayoutPreset = 'balanced' | 'focus' | 'wide-terminal';

export interface Settings {
  claudePath: string | null;
  defaultProjectDir: string | null;
  layout: LayoutPreset;
  leftWidth: number;
  rightWidth: number;
  bottomHeight: number;
  leftOpen: boolean;
  rightOpen: boolean;
  bottomOpen: boolean;
  terminalFontSize: number;
  terminalLineHeight: number;
  optionIsMeta: boolean;
  contrast: 'standard' | 'high';
  reducedMotion: 'system' | 'on' | 'off';
  backgroundImagery: boolean;
  restoreSessions: 'none' | 'list';
  defaultModel: string;
  defaultPermissionMode: SafePermissionMode;
  liveStatusPolling: boolean;
  shortcuts: Record<string, string>;
  onboarded: boolean;
}

export interface AppInfo {
  version: string;
  platform: string;
  arch: string;
  osRelease: string;
  electron: string;
  userDataPath: string;
}

export interface ProjectChange {
  projectId: string;
  dirs: string[];
  gitTouched: boolean;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
