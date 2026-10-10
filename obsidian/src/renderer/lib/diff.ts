export interface DiffLine {
  kind: 'add' | 'del' | 'ctx' | 'hunk' | 'meta';
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

/** Parses a unified diff into display lines with old/new line numbers. */
export function parseUnifiedDiff(text: string): { lines: DiffLine[]; added: number; removed: number; binary: boolean } {
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let added = 0;
  let removed = 0;
  let binary = false;
  let inHunk = false;
  for (const raw of text.split('\n')) {
    if (raw.startsWith('@@')) {
      const m = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        oldNo = Number(m[1]);
        newNo = Number(m[2]);
      }
      inHunk = true;
      out.push({ kind: 'hunk', text: raw, oldNo: null, newNo: null });
    } else if (!inHunk) {
      if (/^Binary files/.test(raw)) binary = true;
      if (raw) out.push({ kind: 'meta', text: raw, oldNo: null, newNo: null });
    } else if (raw.startsWith('+')) {
      added++;
      out.push({ kind: 'add', text: raw.slice(1), oldNo: null, newNo: newNo++ });
    } else if (raw.startsWith('-')) {
      removed++;
      out.push({ kind: 'del', text: raw.slice(1), oldNo: oldNo++, newNo: null });
    } else if (raw.startsWith('\\')) {
      out.push({ kind: 'meta', text: raw, oldNo: null, newNo: null });
    } else if (raw.startsWith('diff --git')) {
      inHunk = false;
      out.push({ kind: 'meta', text: raw, oldNo: null, newNo: null });
    } else if (raw !== '' || out.length) {
      out.push({ kind: 'ctx', text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ });
    }
  }
  while (out.length && out[out.length - 1].kind === 'ctx' && out[out.length - 1].text === '') out.pop();
  return { lines: out, added, removed, binary };
}
