import type { ObsidianApi } from '../../shared/api';

declare global {
  interface Window {
    obsidian: ObsidianApi;
  }
}

export const api: ObsidianApi = window.obsidian;
export const isMac = api?.platform === 'darwin';
