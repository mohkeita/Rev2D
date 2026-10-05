/** Helpers shared by the Spine importer/exporter: ids, colors, reports. */
import { ID_PATTERN } from '../../core/schema.js';
import type { RGBA } from '../../core/types.js';
import type { InteropFormat, InteropIssue, InteropReport } from '../types.js';

// ----------------------------------------------------------------------------- ids

/** Turn any name into a Rev2D id (^[A-Za-z_][A-Za-z0-9_-]*$). */
export function sanitizeId(name: string): string {
  let id = name.trim().replace(/[^A-Za-z0-9_-]+/g, '_');
  if (!id) id = '_';
  if (!/^[A-Za-z_]/.test(id)) id = `_${id}`;
  return id;
}

/** Allocates unique ids within one namespace, remembering what each source name became. */
export class IdAllocator {
  private used = new Set<string>();

  /** Reserve an id as-is (e.g. an id taken by another object of the namespace). */
  reserve(id: string): void {
    this.used.add(id);
  }

  has(id: string): boolean {
    return this.used.has(id);
  }

  /** Unique id for `name`: sanitized, then suffixed "-2", "-3", ... on collision. */
  allocate(name: string): string {
    const base = sanitizeId(name);
    let id = base;
    for (let n = 2; this.used.has(id); n++) id = `${base}-${n}`;
    this.used.add(id);
    if (!ID_PATTERN.test(id)) throw new Error(`IdAllocator: produced invalid id "${id}"`);
    return id;
  }
}

// ----------------------------------------------------------------------------- colors

/** Parse a Spine hex color "RRGGBB" or "RRGGBBAA" (no '#') into RGBA 0..1; null when invalid. */
export function parseSpineColor(hex: string | undefined | null): RGBA | null {
  if (typeof hex !== 'string') return null;
  const s = hex.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(s)) return null;
  const v = (i: number) => parseInt(s.slice(i, i + 2), 16) / 255;
  return [v(0), v(2), v(4), s.length === 8 ? v(6) : 1];
}

function hex2(v: number): string {
  return Math.round(Math.min(1, Math.max(0, v)) * 255)
    .toString(16)
    .padStart(2, '0');
}

/** RGBA 0..1 -> "#rrggbb" (alpha 1) or "#rrggbbaa". */
export function toCssColor(c: RGBA, withAlpha = c[3] < 1): string {
  return `#${hex2(c[0])}${hex2(c[1])}${hex2(c[2])}${withAlpha ? hex2(c[3]) : ''}`;
}

/** RGBA 0..1 -> Spine "RRGGBBAA" (or "RRGGBB" when `rgbOnly`). */
export function toSpineColor(c: RGBA, rgbOnly = false): string {
  return `${hex2(c[0])}${hex2(c[1])}${hex2(c[2])}${rgbOnly ? '' : hex2(c[3])}`;
}

export const WHITE: RGBA = [1, 1, 1, 1];

// ----------------------------------------------------------------------------- reports

export class ReportBuilder {
  readonly issues: InteropIssue[] = [];
  readonly stats: Record<string, number> = {};
  private seen = new Set<string>();

  constructor(
    readonly format: InteropFormat,
    readonly direction: 'import' | 'export',
  ) {}

  add(severity: InteropIssue['severity'], code: string, message: string, where?: string, hint?: string): void {
    const key = `${severity}|${code}|${message}|${where ?? ''}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const issue: InteropIssue = { severity, code, message };
    if (where !== undefined) issue.where = where;
    if (hint !== undefined) issue.hint = hint;
    this.issues.push(issue);
  }

  warn(code: string, message: string, where?: string, hint?: string): void {
    this.add('warning', code, message, where, hint);
  }

  info(code: string, message: string, where?: string, hint?: string): void {
    this.add('info', code, message, where, hint);
  }

  count(stat: string, n = 1): void {
    this.stats[stat] = (this.stats[stat] ?? 0) + n;
  }

  build(): InteropReport {
    const stats: Record<string, number> = {};
    for (const k of Object.keys(this.stats).sort()) stats[k] = this.stats[k];
    return { format: this.format, direction: this.direction, issues: this.issues, stats };
  }
}

/** Remove float noise from computed values (1e-9 grid; -0 becomes 0). */
export function clean(n: number): number {
  const r = Math.round(n * 1e9) / 1e9;
  return r === 0 ? 0 : r;
}

/** Short number for ids / messages: at most 3 decimals, no trailing zeros. */
export function fmt(n: number): string {
  const r = Math.round(n * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
}
