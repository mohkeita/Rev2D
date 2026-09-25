/** Plain-text formatting helpers for human/agent-readable command output. */

/** Aligned columns; the last column is not padded. */
export function table(rows: string[][], indent = '  '): string[] {
  if (rows.length === 0) return [];
  const cols = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, c) => Math.max(...rows.map((r) => (r[c] ?? '').length)));
  return rows.map((r) => (indent + r.map((cell, c) => (c === r.length - 1 ? cell : cell.padEnd(widths[c]))).join('  ')).trimEnd());
}

/** Compact number: at most `digits` decimals, no trailing zeros, no "-0". */
export function num(v: number, digits = 3): string {
  const r = Number(v.toFixed(digits));
  return Object.is(r, -0) ? '0' : String(r);
}

export function pair(p: readonly [number, number] | null | undefined, digits = 1): string {
  return p ? `(${num(p[0], digits)}, ${num(p[1], digits)})` : '-';
}

export function rect(r: readonly number[] | null | undefined, digits = 1): string {
  return r ? `[${r.map((v) => num(v, digits)).join(', ')}]` : '-';
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Short one-line rendering of a property value (long point lists are abbreviated). */
export function valueSummary(v: number | number[] | string): string {
  if (typeof v === 'number') return num(v);
  if (typeof v === 'string') return v.length > 60 ? `${v.slice(0, 57)}...` : v;
  if (v.length <= 8) return `[${v.map((x) => num(x, 2)).join(', ')}]`;
  return `[${v.slice(0, 6).map((x) => num(x, 2)).join(', ')}, ...] (${v.length} values)`;
}

/** Word-wrap a paragraph to `width` columns with a hanging indent. */
export function wrap(text: string, width: number, indent: string): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if (line && indent.length + line.length + 1 + w.length > width) {
      lines.push(indent + line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(indent + line);
  return lines;
}
