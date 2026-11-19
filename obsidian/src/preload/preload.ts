import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  SEND_CHANNELS,
  type EventChannel,
  type InvokeChannel,
  type ObsidianApi,
  type SendChannel,
} from '../shared/api';

// Only allow-listed channels cross the bridge. The renderer never sees ipcRenderer itself.
const invokeAllowed = new Set<string>(INVOKE_CHANNELS);
const sendAllowed = new Set<string>(SEND_CHANNELS);
const eventAllowed = new Set<string>(EVENT_CHANNELS);

const api: ObsidianApi = {
  invoke(channel: InvokeChannel, ...args: unknown[]) {
    if (!invokeAllowed.has(channel)) return Promise.reject(new Error(`Blocked channel ${channel}`));
    return ipcRenderer.invoke(channel, ...args);
  },
  send(channel: SendChannel, ...args: unknown[]) {
    if (!sendAllowed.has(channel)) return;
    ipcRenderer.send(channel, ...args);
  },
  on(channel: EventChannel, listener: (...args: any[]) => void) {
    if (!eventAllowed.has(channel)) return () => undefined;
    const wrapped = (_event: IpcRendererEvent, ...args: unknown[]) => listener(...args);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  platform: process.platform,
} as ObsidianApi;

contextBridge.exposeInMainWorld('obsidian', api);
