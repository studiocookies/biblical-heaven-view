import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal, type ITheme } from '@xterm/xterm';
import { api, isMac } from './api';
import { termSize, useStore } from '../state/store';

/*
 * xterm instances live outside React so they survive re-renders and tab switches.
 * Each session owns one Terminal; the active one is attached to a visible host element.
 */

export const TERMINAL_THEME: ITheme = {
  background: '#070b10',
  foreground: '#dfe7ee',
  cursor: '#a9dfff',
  cursorAccent: '#070b10',
  selectionBackground: 'rgba(109, 187, 238, 0.32)',
  selectionInactiveBackground: 'rgba(109, 187, 238, 0.16)',
  black: '#0d141d',
  red: '#f08080',
  green: '#75d6aa',
  yellow: '#e9bd72',
  blue: '#6dbbee',
  magenta: '#e7a0b6', // ANSI magenta rendered as rose so CLI output never reads as purple
  cyan: '#7fd3e0',
  white: '#c9d4de',
  brightBlack: '#56687a',
  brightRed: '#ffa3a3',
  brightGreen: '#9ae6c2',
  brightYellow: '#f3d397',
  brightBlue: '#a9dfff',
  brightMagenta: '#f2c0cf',
  brightCyan: '#a8e6ef',
  brightWhite: '#f4f8fb',
};

interface Entry {
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  webgl: WebglAddon | null;
  host: HTMLDivElement;
  pendingAck: number;
  ackTimer: number | null;
  lastCols: number;
  lastRows: number;
  disposers: (() => void)[];
}

const entries = new Map<string, Entry>();
let webglBudget = 8;

function flushAck(id: string, e: Entry) {
  e.ackTimer = null;
  if (e.pendingAck > 0) {
    api.send('session:ack', id, e.pendingAck);
    e.pendingAck = 0;
  }
}

export function getTerminal(id: string): Entry | undefined {
  return entries.get(id);
}

export function ensureTerminal(id: string): Entry {
  const existing = entries.get(id);
  if (existing) return existing;
  const settings = useStore.getState().settings;
  const host = document.createElement('div');
  host.className = 'xterm-host';
  const term = new Terminal({
    allowProposedApi: true,
    fontFamily: "'SF Mono', SFMono-Regular, ui-monospace, Menlo, Monaco, 'DejaVu Sans Mono', monospace",
    fontSize: settings?.terminalFontSize ?? 13,
    lineHeight: settings?.terminalLineHeight ?? 1.2,
    letterSpacing: 0,
    cursorBlink: true,
    cursorStyle: 'bar',
    cursorWidth: 2,
    scrollback: 10000,
    macOptionIsMeta: settings?.optionIsMeta ?? false,
    macOptionClickForcesSelection: true,
    rightClickSelectsWord: true,
    drawBoldTextInBrightColors: false,
    minimumContrastRatio: settings?.contrast === 'high' ? 7 : 4.5,
    theme: TERMINAL_THEME,
    smoothScrollDuration: 0,
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  const unicode = new Unicode11Addon();
  term.loadAddon(unicode);
  term.unicode.activeVersion = '11';
  term.loadAddon(
    new WebLinksAddon((_ev, uri) => {
      void api.invoke('shell:openExternal', uri).catch(() => undefined);
    }),
  );
  // Keep the host in the DOM from the start (parked offscreen) so xterm can measure fonts
  // even if output arrives before the React pane mounts.
  (document.getElementById('term-parking') ?? document.body).appendChild(host);
  term.open(host);

  const entry: Entry = { term, fit, search, webgl: null, host, pendingAck: 0, ackTimer: null, lastCols: 0, lastRows: 0, disposers: [] };

  if (webglBudget > 0) {
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
        entry.webgl = null;
      });
      term.loadAddon(webgl);
      entry.webgl = webgl;
      webglBudget--;
    } catch {
      // WebGL unavailable → DOM renderer
    }
  }

  // Keyboard: Shift+Enter inserts a newline in Claude Code (ESC CR, same as its /terminal-setup binding).
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type === 'keydown' && ev.key === 'Enter' && ev.shiftKey && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
      api.send('session:write', id, '\x1b\r');
      return false;
    }
    // Let app-level ⌘ shortcuts through; xterm doesn't need them.
    if (isMac && ev.metaKey) return false;
    return true;
  });

  const onData = term.onData((d) => api.send('session:write', id, d));
  const onBinary = term.onBinary((d) => api.send('session:write', id, d));
  const onTitle = term.onTitleChange((title) => {
    const clean = title.replace(/[\x00-\x1f]/g, '').slice(0, 120);
    useStore.setState((s) => ({ sessionTitles: { ...s.sessionTitles, [id]: clean } }));
  });
  const onBell = term.onBell(() => {
    const s = useStore.getState();
    if (s.activeTabId !== id || !document.hasFocus()) useStore.setState({ attention: { ...s.attention, [id]: true } });
  });
  entry.disposers.push(() => onData.dispose(), () => onBinary.dispose(), () => onTitle.dispose(), () => onBell.dispose());

  entries.set(id, entry);
  return entry;
}

/** Writes PTY output; acknowledges parsed characters so main can apply flow control. */
export function writeToTerminal(id: string, data: string) {
  const e = ensureTerminal(id);
  e.term.write(data, () => {
    e.pendingAck += data.length;
    if (e.pendingAck > 128 * 1024) flushAck(id, e);
    else if (e.ackTimer === null) e.ackTimer = window.setTimeout(() => flushAck(id, e), 40);
  });
}

export function fitTerminal(id: string) {
  const e = entries.get(id);
  if (!e || !e.host.isConnected || e.host.clientWidth < 20 || e.host.clientHeight < 20) return;
  try {
    e.fit.fit();
  } catch {
    return;
  }
  const { cols, rows } = e.term;
  termSize.cols = cols;
  termSize.rows = rows;
  if (cols !== e.lastCols || rows !== e.lastRows) {
    e.lastCols = cols;
    e.lastRows = rows;
    api.send('session:resize', id, cols, rows);
  }
}

export function disposeTerminal(id: string) {
  const e = entries.get(id);
  if (!e) return;
  if (e.ackTimer !== null) clearTimeout(e.ackTimer);
  e.disposers.forEach((d) => d());
  if (e.webgl) webglBudget++;
  e.term.dispose();
  e.host.remove();
  entries.delete(id);
}

export function applyTerminalSettings() {
  const s = useStore.getState().settings;
  if (!s) return;
  for (const [id, e] of entries) {
    e.term.options.fontSize = s.terminalFontSize;
    e.term.options.lineHeight = s.terminalLineHeight;
    e.term.options.macOptionIsMeta = s.optionIsMeta;
    e.term.options.minimumContrastRatio = s.contrast === 'high' ? 7 : 4.5;
    fitTerminal(id);
  }
}

export function focusTerminal(id: string) {
  entries.get(id)?.term.focus();
}

/** Sends text as a paste (bracketed when the CLI enabled it), then Enter. */
export function submitToTerminal(id: string, text: string) {
  const e = entries.get(id);
  if (!e) return;
  if (text.includes('\n')) e.term.paste(text);
  else api.send('session:write', id, text);
  window.setTimeout(() => api.send('session:write', id, '\r'), 60);
  e.term.focus();
}
