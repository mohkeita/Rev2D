/**
 * Output helpers for the Spine exporter: number rounding, a deterministic JSON writer that keeps the
 * file readable (short values on one line, one timeline key or one bone per line) and the skeleton
 * hash.
 */

/** Round to `decimals` decimals; -0 becomes 0. */
export function round(v: number, decimals: number): number {
  const f = 10 ** decimals;
  const r = Math.round(v * f) / f;
  return r === 0 ? 0 : r;
}

/** Round every value of a list. */
export function roundAll(values: ArrayLike<number>, decimals: number): number[] {
  const out = new Array<number>(values.length);
  for (let i = 0; i < values.length; i++) out[i] = round(values[i], decimals);
  return out;
}

const INLINE_WIDTH = 120;

/**
 * Serialize JSON with tab indentation: the top-level sections one per line, arrays of objects one
 * element per line, anything else on one line when it is short (<= 120 characters); arrays of
 * primitives always stay on one line.
 */
export function writeSpineJson(value: unknown): string {
  return write(value, 0) + '\n';
}

function write(v: unknown, depth: number): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  const pad = '\t'.repeat(depth + 1);
  const end = '\t'.repeat(depth);
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    if (v.every((x) => x === null || typeof x !== 'object')) return inline(v);
    if (depth > 1 && fitsInline(v, INLINE_WIDTH)) return inline(v);
    return `[\n${v.map((x) => pad + write(x, depth + 1)).join(',\n')}\n${end}]`;
  }
  const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
  if (entries.length === 0) return '{}';
  if (depth > 0 && fitsInline(v, INLINE_WIDTH)) return inline(v);
  return `{\n${entries.map(([k, x]) => `${pad}${JSON.stringify(k)}: ${write(x, depth + 1)}`).join(',\n')}\n${end}}`;
}

/**
 * Whether inline(v) is at most `max` characters, without building it for large values (a lower bound
 * of the length that stops as soon as it passes `max`; exact once the value is known to be small).
 */
function fitsInline(v: unknown, max: number): boolean {
  let budget = max;
  const walk = (x: unknown): boolean => {
    if (budget < 0) return false;
    if (x === null || typeof x !== 'object') {
      budget -= 1;
      return budget >= 0;
    }
    const items = Array.isArray(x) ? x : Object.values(x as Record<string, unknown>);
    budget -= 2 + items.length;
    for (const item of items) if (!walk(item)) return false;
    return budget >= 0;
  };
  return walk(v) && inline(v).length <= max;
}

/** One-line form with spaces after separators in objects (like Spine's own exports). */
function inline(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return v.every((x) => x === null || typeof x !== 'object') ? JSON.stringify(v) : `[ ${v.map(inline).join(', ')} ]`;
  const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
  if (!entries.length) return '{}';
  return `{ ${entries.map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`).join(', ')} }`;
}

/**
 * Deterministic 11-character hash of the skeleton text (FNV-1a 64 bit, base64), in the spirit of the
 * `skeleton.hash` Spine writes so tools can tell exports apart.
 */
export function skeletonHash(text: string): string {
  // 64-bit arithmetic in four 16-bit limbs (little-endian): offset basis 0xcbf29ce484222325, prime
  // 0x100000001b3 = 0x1b3 + 0x100 << 32. Same result as BigInt arithmetic, much faster on large files.
  let h0 = 0x2325;
  let h1 = 0x8422;
  let h2 = 0x9ce4;
  let h3 = 0xcbf2;
  for (let i = 0; i < text.length; i++) {
    h0 ^= text.charCodeAt(i);
    const t0 = h0 * 0x1b3;
    const t1 = h1 * 0x1b3 + (t0 >>> 16);
    const t2 = h2 * 0x1b3 + h0 * 0x100 + (t1 >>> 16);
    const t3 = h3 * 0x1b3 + h1 * 0x100 + (t2 >>> 16);
    h0 = t0 & 0xffff;
    h1 = t1 & 0xffff;
    h2 = t2 & 0xffff;
    h3 = t3 & 0xffff;
  }
  const bytes = new Uint8Array([h3 >>> 8, h3 & 0xff, h2 >>> 8, h2 & 0xff, h1 >>> 8, h1 & 0xff, h0 >>> 8, h0 & 0xff]);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      out += alphabet[(acc >> bits) & 63];
    }
  }
  if (bits > 0) out += alphabet[(acc << (6 - bits)) & 63];
  return out;
}
