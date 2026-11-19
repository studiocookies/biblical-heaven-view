import type {
  AgentDefinition,
  AppInfo,
  ClaudeInfo,
  DiffResult,
  DirEntry,
  FileContent,
  GitCommit,
  GitStatus,
  HistoryEntry,
  LiveAgent,
  Project,
  ProjectChange,
  Result,
  SessionInfo,
  SessionRecord,
  SessionSpec,
  Settings,
  Task,
  TranscriptInsight,
} from './types';

/** Invoke channels. Keys are the channel names; values are [args, return]. */
export interface InvokeMap {
  'app:info': [[], AppInfo];
  'app:revealUserData': [[], void];
  'claude:detect': [[force: boolean], ClaudeInfo];
  'claude:chooseExecutable': [[], ClaudeInfo];
  'claude:resetExecutable': [[], ClaudeInfo];
  'claude:liveAgents': [[], LiveAgent[] | null];
  'claude:history': [[projectId: string], HistoryEntry[]];
  'claude:agentDefinitions': [[projectId: string | null], AgentDefinition[]];

  'projects:list': [[], Project[]];
  'projects:add': [[], Project | null];
  'projects:remove': [[projectId: string], Project[]];
  'projects:touch': [[projectId: string], void];
  'projects:reveal': [[projectId: string, rel: string], void];

  'fs:list': [[projectId: string, rel: string], Result<DirEntry[]>];
  'fs:read': [[projectId: string, rel: string], Result<FileContent>];
  'fs:search': [[projectId: string, query: string], string[]];

  'git:status': [[projectId: string], GitStatus];
  'git:diff': [[projectId: string, path: string, staged: boolean], Result<DiffResult>];
  'git:log': [[projectId: string], GitCommit[]];
  'git:stage': [[projectId: string, paths: string[]], Result<null>];
  'git:unstage': [[projectId: string, paths: string[]], Result<null>];
  'git:discard': [[projectId: string, paths: string[]], Result<null>];
  'git:commit': [[projectId: string, message: string], Result<string>];

  'session:create': [[spec: SessionSpec], SessionInfo];
  'session:list': [[], SessionInfo[]];
  'session:kill': [[id: string], void];
  'session:dispose': [[id: string], void];
  'session:records': [[projectId: string | null], SessionRecord[]];
  'session:forgetRecord': [[claudeSessionId: string], void];
  'session:insight': [[id: string], TranscriptInsight | null];

  'settings:get': [[], Settings];
  'settings:set': [[patch: Partial<Settings>], Settings];
  'settings:chooseDefaultProjectDir': [[], Settings];

  'tasks:list': [[], Task[]];
  'tasks:save': [[tasks: Task[]], Task[]];

  'clipboard:write': [[text: string], void];
  'shell:openExternal': [[url: string], void];
}

/** Fire-and-forget renderer → main messages (high frequency). */
export interface SendMap {
  'session:write': [id: string, data: string];
  'session:resize': [id: string, cols: number, rows: number];
  'session:ack': [id: string, bytes: number];
  'app:visibility': [visible: boolean];
}

/** Main → renderer events. */
export interface EventMap {
  'session:data': [id: string, data: string];
  'session:update': [info: SessionInfo];
  'session:insight': [insight: TranscriptInsight];
  'agents:update': [agents: LiveAgent[] | null];
  'project:changed': [change: ProjectChange];
  'menu:command': [command: string];
}

export type InvokeChannel = keyof InvokeMap;
export type SendChannel = keyof SendMap;
export type EventChannel = keyof EventMap;

export interface ObsidianApi {
  invoke<C extends InvokeChannel>(channel: C, ...args: InvokeMap[C][0]): Promise<InvokeMap[C][1]>;
  send<C extends SendChannel>(channel: C, ...args: SendMap[C]): void;
  on<C extends EventChannel>(channel: C, listener: (...args: EventMap[C]) => void): () => void;
  platform: string;
}

export const INVOKE_CHANNELS: readonly InvokeChannel[] = [
  'app:info', 'app:revealUserData',
  'claude:detect', 'claude:chooseExecutable', 'claude:resetExecutable', 'claude:liveAgents',
  'claude:history', 'claude:agentDefinitions',
  'projects:list', 'projects:add', 'projects:remove', 'projects:touch', 'projects:reveal',
  'fs:list', 'fs:read', 'fs:search',
  'git:status', 'git:diff', 'git:log', 'git:stage', 'git:unstage', 'git:discard', 'git:commit',
  'session:create', 'session:list', 'session:kill', 'session:dispose', 'session:records',
  'session:forgetRecord', 'session:insight',
  'settings:get', 'settings:set', 'settings:chooseDefaultProjectDir',
  'tasks:list', 'tasks:save',
  'clipboard:write', 'shell:openExternal',
];
export const SEND_CHANNELS: readonly SendChannel[] = ['session:write', 'session:resize', 'session:ack', 'app:visibility'];
export const EVENT_CHANNELS: readonly EventChannel[] = [
  'session:data', 'session:update', 'session:insight', 'agents:update', 'project:changed', 'menu:command',
];
