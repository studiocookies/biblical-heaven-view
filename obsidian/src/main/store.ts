import fs from 'node:fs';
import path from 'node:path';
import type { Project, SessionRecord, Settings, Task } from '../shared/types';

export const DEFAULT_SHORTCUTS: Record<string, string> = {
  'session.newClaude': 'Mod+T',
  'session.newShell': 'Mod+Shift+T',
  'session.close': 'Mod+W',
  'session.next': 'Mod+Shift+]',
  'session.prev': 'Mod+Shift+[',
  'palette.open': 'Mod+Shift+P',
  'file.quickOpen': 'Mod+P',
  'project.open': 'Mod+O',
  'view.toggleLeft': 'Mod+B',
  'view.toggleRight': 'Mod+Alt+B',
  'view.toggleBottom': 'Mod+J',
  'view.settings': 'Mod+,',
  'view.home': 'Mod+Shift+H',
  'terminal.clear': 'Mod+K',
  'terminal.find': 'Mod+F',
  'terminal.zoomIn': 'Mod+=',
  'terminal.zoomOut': 'Mod+-',
};

export const DEFAULT_SETTINGS: Settings = {
  claudePath: null,
  defaultProjectDir: null,
  layout: 'balanced',
  leftWidth: 268,
  rightWidth: 340,
  bottomHeight: 200,
  leftOpen: true,
  rightOpen: true,
  bottomOpen: false,
  terminalFontSize: 13,
  terminalLineHeight: 1.2,
  optionIsMeta: false,
  contrast: 'standard',
  reducedMotion: 'system',
  backgroundImagery: true,
  restoreSessions: 'list',
  defaultModel: '',
  defaultPermissionMode: 'default',
  liveStatusPolling: true,
  shortcuts: DEFAULT_SHORTCUTS,
  onboarded: false,
};

interface Files {
  settings: Settings;
  projects: Project[];
  sessions: SessionRecord[];
  tasks: Task[];
}

const DEFAULTS: Files = { settings: DEFAULT_SETTINGS, projects: [], sessions: [], tasks: [] };

/**
 * Small JSON store. One file per collection, atomic writes (tmp + rename), mode 0600.
 * Nothing here ever contains credentials or terminal output.
 */
export class Store {
  private cache = new Map<keyof Files, unknown>();
  private timers = new Map<keyof Files, NodeJS.Timeout>();

  constructor(private dir: string) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  private file(key: keyof Files) {
    return path.join(this.dir, `${key}.json`);
  }

  get<K extends keyof Files>(key: K): Files[K] {
    if (this.cache.has(key)) return this.cache.get(key) as Files[K];
    let value: Files[K] = structuredClone(DEFAULTS[key]);
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(key), 'utf8'));
      if (key === 'settings') {
        const merged = { ...DEFAULT_SETTINGS, ...raw };
        merged.shortcuts = { ...DEFAULT_SHORTCUTS, ...(raw.shortcuts ?? {}) };
        value = merged as Files[K];
      } else if (Array.isArray(raw)) {
        value = raw as Files[K];
      }
    } catch {
      // missing or corrupt → defaults (a corrupt file is left in place until the next write)
    }
    this.cache.set(key, value);
    return value;
  }

  set<K extends keyof Files>(key: K, value: Files[K]) {
    this.cache.set(key, value);
    clearTimeout(this.timers.get(key));
    this.timers.set(key, setTimeout(() => this.flushOne(key), 150));
  }

  private flushOne(key: keyof Files) {
    this.timers.delete(key);
    const target = this.file(key);
    const tmp = `${target}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.cache.get(key), null, 2), { mode: 0o600 });
      fs.renameSync(tmp, target);
    } catch (err) {
      console.error(`[store] failed to write ${key}:`, (err as Error).message);
    }
  }

  flush() {
    for (const key of [...this.timers.keys()]) {
      clearTimeout(this.timers.get(key));
      this.flushOne(key);
    }
  }
}
