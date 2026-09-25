/**
 * Stable, diff-friendly JSON formatting for model files.
 * Objects break across lines; arrays of primitives (point lists, key times, "at" tuples) stay on one
 * line (wrapped at `width`) so geometry does not explode into one number per line. Numbers are
 * rounded to `precision` decimals to avoid float noise from computed edits.
 */
export interface FormatOptions {
  indent?: number;
  width?: number;
  precision?: number;
}

export function formatModelJson(value: unknown, opts: FormatOptions = {}): string {
  const indent = opts.indent ?? 2;
  const width = opts.width ?? 100;
  const precision = opts.precision ?? 4;
  return write(value, 0) + '\n';

  function num(n: number): string {
    if (!Number.isFinite(n)) return 'null';
    const r = Number(n.toFixed(precision));
    return Object.is(r, -0) ? '0' : String(r);
  }

  function prim(v: unknown): string | null {
    if (v === null) return 'null';
    if (typeof v === 'number') return num(v);
    if (typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
    return null;
  }

  function write(v: unknown, depth: number): string {
    const p = prim(v);
    if (p !== null) return p;
    const pad = ' '.repeat((depth + 1) * indent);
    const end = ' '.repeat(depth * indent);
    if (Array.isArray(v)) {
      if (v.length === 0) return '[]';
      const prims = v.map(prim);
      if (prims.every((s) => s !== null)) {
        const oneLine = `[${prims.join(', ')}]`;
        if (oneLine.length + depth * indent <= width) return oneLine;
        // Wrap primitive arrays, keeping pairs together for even-length numeric lists (points).
        const step = v.length % 2 === 0 && v.every((x) => typeof x === 'number') ? 2 : 1;
        const lines: string[] = [];
        let line = '';
        for (let i = 0; i < prims.length; i += step) {
          const chunk = prims.slice(i, i + step).join(', ');
          if (line && pad.length + line.length + chunk.length + 2 > width) {
            lines.push(line + ',');
            line = chunk;
          } else {
            line = line ? `${line}, ${chunk}` : chunk;
          }
        }
        lines.push(line);
        return `[\n${lines.map((l) => pad + l).join('\n')}\n${end}]`;
      }
      // Small objects (e.g. keys {t, v, ease}) fit on one line when short.
      const items = v.map((x) => write(x, depth + 1));
      return `[\n${items.map((s) => pad + s).join(',\n')}\n${end}]`;
    }
    if (typeof v === 'object') {
      const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
      if (entries.length === 0) return '{}';
      const compact = tryCompactObject(entries);
      if (compact && compact.length + depth * indent <= width) return compact;
      const body = entries.map(([k, x]) => `${pad}${JSON.stringify(k)}: ${write(x, depth + 1)}`);
      return `{\n${body.join(',\n')}\n${end}}`;
    }
    return 'null';
  }

  /** One-line form for flat objects whose values are primitives or short primitive arrays. */
  function tryCompactObject(entries: Array<[string, unknown]>): string | null {
    const parts: string[] = [];
    for (const [k, x] of entries) {
      let s = prim(x);
      if (s === null && Array.isArray(x) && x.length <= 8) {
        const ps = x.map(prim);
        if (ps.every((q) => q !== null)) s = `[${ps.join(', ')}]`;
      }
      if (s === null) return null;
      parts.push(`${JSON.stringify(k)}: ${s}`);
    }
    return `{ ${parts.join(', ')} }`;
  }
}
