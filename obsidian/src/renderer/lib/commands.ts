import { activeSession, useStore } from '../state/store';
import { api } from './api';
import { applyTerminalSettings, focusTerminal, getTerminal } from './terminals';

export interface Command {
  id: string;
  title: string;
  group: string;
  run: () => void | Promise<void>;
  enabled?: () => boolean;
}

const st = () => useStore.getState();
const activeSessionTab = () => {
  const s = st();
  const tab = s.tabs.find((t) => t.id === s.activeTabId);
  return tab?.type === 'session' ? s.sessions[tab.sessionId] ?? null : null;
};
const hasProject = () => !!st().activeProjectId;
const claudeReady = () => !!st().claude?.found;

function toggleLayout(key: 'leftOpen' | 'rightOpen' | 'bottomOpen') {
  const s = st().settings;
  if (s) void st().setSettings({ [key]: !s[key] });
}

function zoom(delta: number) {
  const s = st().settings;
  if (!s) return;
  const size = Math.min(28, Math.max(9, s.terminalFontSize + delta));
  void st().setSettings({ terminalFontSize: size }).then(applyTerminalSettings);
}

export const COMMANDS: Command[] = [
  { id: 'session.newClaude', title: 'New Claude Code Session', group: 'Session', run: () => void st().startSession({ kind: 'claude' }), enabled: () => hasProject() && claudeReady() },
  { id: 'session.newShell', title: 'New Shell Session', group: 'Session', run: () => void st().startSession({ kind: 'shell' }), enabled: hasProject },
  { id: 'session.continue', title: 'Continue Most Recent Conversation (claude --continue)', group: 'Session', run: () => void st().startSession({ kind: 'claude', mode: 'continue' }), enabled: () => hasProject() && !!st().claude?.capabilities?.continue },
  { id: 'session.picker', title: "Resume From Claude's History Picker (claude --resume)", group: 'Session', run: () => void st().startSession({ kind: 'claude', mode: 'picker' }), enabled: () => hasProject() && !!st().claude?.capabilities?.resume },
  { id: 'session.newPlan', title: 'New Claude Code Session in Plan Mode', group: 'Session', run: () => void st().startSession({ kind: 'claude', permissionMode: 'plan' }), enabled: () => hasProject() && !!st().claude?.capabilities?.permissionMode },
  { id: 'session.close', title: 'Close Tab', group: 'Session', run: () => { const id = st().activeTabId; if (id) void st().closeTab(id); }, enabled: () => !!st().activeTabId },
  { id: 'session.kill', title: 'End Session Process', group: 'Session', run: () => { const s = activeSessionTab(); if (s && window.confirm(`Send hang-up to "${s.title}" (pid ${s.pid})?`)) void st().killSession(s.id); }, enabled: () => activeSessionTab()?.state === 'running' },
  { id: 'session.interrupt', title: 'Interrupt Claude (send Esc)', group: 'Session', run: () => { const s = activeSessionTab(); if (s) { api.send('session:write', s.id, '\x1b'); focusTerminal(s.id); } }, enabled: () => activeSessionTab()?.kind === 'claude' && activeSessionTab()?.state === 'running' },
  { id: 'session.next', title: 'Next Tab', group: 'Session', run: () => st().cycleTab(1) },
  { id: 'session.prev', title: 'Previous Tab', group: 'Session', run: () => st().cycleTab(-1) },
  { id: 'composer.toggle', title: 'Toggle Prompt Composer', group: 'Session', run: () => st().set({ composerOpen: !st().composerOpen }), enabled: () => activeSessionTab()?.state === 'running' },

  { id: 'project.open', title: 'Open Project Folder…', group: 'Project', run: () => void st().addProject() },
  { id: 'file.quickOpen', title: 'Quick Open File…', group: 'Project', run: () => st().set({ paletteOpen: 'files' }), enabled: hasProject },
  { id: 'git.refresh', title: 'Refresh Git Status', group: 'Project', run: () => void st().refreshGit(), enabled: hasProject },
  { id: 'project.reveal', title: 'Reveal Project in Finder', group: 'Project', run: () => { const p = st().activeProjectId; if (p) void api.invoke('projects:reveal', p, ''); }, enabled: hasProject },

  { id: 'palette.open', title: 'Command Palette', group: 'View', run: () => st().set({ paletteOpen: 'commands' }) },
  { id: 'view.home', title: 'Mission Control', group: 'View', run: () => st().set({ center: 'home', nav: 'home' }) },
  { id: 'view.settings', title: 'Settings', group: 'View', run: () => st().set({ center: 'settings', nav: 'settings' }) },
  { id: 'view.toggleLeft', title: 'Toggle Navigator', group: 'View', run: () => toggleLayout('leftOpen') },
  { id: 'view.toggleRight', title: 'Toggle Intelligence Panel', group: 'View', run: () => toggleLayout('rightOpen') },
  { id: 'view.toggleBottom', title: 'Toggle Bottom Panel', group: 'View', run: () => toggleLayout('bottomOpen') },
  { id: 'view.diagnostics', title: 'Show Diagnostics', group: 'View', run: () => { void st().setSettings({ bottomOpen: true }); st().set({ bottomTab: 'diagnostics' }); } },
  { id: 'view.activity', title: 'Show Activity Timeline', group: 'View', run: () => { void st().setSettings({ bottomOpen: true }); st().set({ bottomTab: 'activity' }); } },
  { id: 'layout.balanced', title: 'Layout: Balanced', group: 'View', run: () => void st().setSettings({ layout: 'balanced', leftOpen: true, rightOpen: true }) },
  { id: 'layout.focus', title: 'Layout: Focus (terminal only)', group: 'View', run: () => void st().setSettings({ layout: 'focus', leftOpen: false, rightOpen: false, bottomOpen: false }) },
  { id: 'layout.wide', title: 'Layout: Wide Terminal', group: 'View', run: () => void st().setSettings({ layout: 'wide-terminal', leftOpen: true, rightOpen: false }) },

  { id: 'terminal.clear', title: 'Clear Terminal Scrollback', group: 'Terminal', run: () => { const s = activeSessionTab(); if (s) getTerminal(s.id)?.term.clear(); }, enabled: () => !!activeSessionTab() },
  { id: 'terminal.find', title: 'Find in Terminal', group: 'Terminal', run: () => st().set({ findOpen: true }), enabled: () => !!activeSessionTab() },
  { id: 'terminal.zoomIn', title: 'Increase Terminal Font Size', group: 'Terminal', run: () => zoom(1) },
  { id: 'terminal.zoomOut', title: 'Decrease Terminal Font Size', group: 'Terminal', run: () => zoom(-1) },

  { id: 'claude.redetect', title: 'Re-detect Claude Code', group: 'Claude', run: () => void st().detect(true) },
];

// A keystroke can be handled by the renderer and also reach a native menu accelerator.
// Menu-originated duplicates of a command the keyboard just ran are dropped; nothing else is.
let lastKeyboard = { id: '', at: 0 };

export function runCommand(id: string, source: 'keyboard' | 'menu' | 'ui' = 'ui') {
  const c = COMMANDS.find((x) => x.id === id);
  if (!c) return;
  const now = performance.now();
  if (source === 'menu' && lastKeyboard.id === id && now - lastKeyboard.at < 300) return;
  if (source === 'keyboard') lastKeyboard = { id, at: now };
  if (c.enabled && !c.enabled()) return;
  void c.run();
}

export { activeSession };
