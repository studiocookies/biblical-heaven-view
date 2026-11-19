/** Shortcut strings look like "Mod+Shift+P". Mod is ⌘ on macOS and Ctrl elsewhere. */
const CODE_KEYS: Record<string, string> = {
  BracketLeft: '[', BracketRight: ']', Comma: ',', Period: '.', Slash: '/', Backslash: '\\',
  Equal: '=', Minus: '-', Semicolon: ';', Quote: "'", Backquote: '`', Enter: 'Enter', Escape: 'Escape',
  Space: 'Space', Tab: 'Tab', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
};

export function eventKey(e: KeyboardEvent): string | null {
  if (e.code.startsWith('Key')) return e.code.slice(3);
  if (e.code.startsWith('Digit')) return e.code.slice(5);
  if (/^F\d+$/.test(e.code)) return e.code;
  return CODE_KEYS[e.code] ?? null;
}

export function eventToShortcut(e: KeyboardEvent, mac: boolean): string | null {
  const key = eventKey(e);
  if (!key) return null;
  const parts: string[] = [];
  const mod = mac ? e.metaKey : e.ctrlKey;
  if (mod) parts.push('Mod');
  if (mac && e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

export function normalizeShortcut(s: string): string {
  const parts = s.split('+').map((p) => p.trim()).filter(Boolean);
  const key = parts.pop() ?? '';
  const order = ['Mod', 'Ctrl', 'Alt', 'Shift'];
  const mods = order.filter((m) => parts.some((p) => p.toLowerCase() === m.toLowerCase()));
  return [...mods, key.length === 1 ? key.toUpperCase() : key].join('+');
}

export function formatShortcut(s: string | undefined, mac: boolean): string {
  if (!s) return '';
  const map: Record<string, string> = mac
    ? { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Enter: '↩', Up: '↑', Down: '↓', Left: '←', Right: '→', Escape: '⎋' }
    : { Mod: 'Ctrl+', Ctrl: 'Ctrl+', Alt: 'Alt+', Shift: 'Shift+' };
  return s.split('+').map((p) => map[p] ?? p).join(mac ? '' : '');
}
