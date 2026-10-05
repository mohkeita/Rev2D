/**
 * Shared helpers of the Live2D converters: issue collection, JSON input parsing, target-model lookup
 * (parameters, parts, animations, physics), how imported animations are told apart from the model's
 * own, and small number / id utilities. Pure: no Node APIs.
 */
import { paramDefault, suggest } from '../../core/address.js';
import type { InteropFormat, InteropIssue, InteropReport } from '../types.js';

export type Json = Record<string, unknown>;

/** Collects issues and stats for one conversion; `prefix` is prepended to every `where`. */
export class Reporter {
  readonly issues: InteropIssue[] = [];
  readonly stats: Record<string, number> = {};

  warn(code: string, message: string, where?: string, hint?: string): void {
    this.push('warning', code, message, where, hint);
  }

  info(code: string, message: string, where?: string, hint?: string): void {
    this.push('info', code, message, where, hint);
  }

  /** Add an issue built elsewhere (e.g. replacedAnimationIssue). */
  add(issue: InteropIssue): void {
    this.issues.push(issue);
  }

  count(key: string, n = 1): void {
    this.stats[key] = (this.stats[key] ?? 0) + n;
  }

  /** Copy another report's issues (their `where` prefixed with `prefix: `) and add its stats. */
  merge(report: InteropReport, prefix?: string): void {
    for (const issue of report.issues) {
      const where = prefix ? (issue.where ? `${prefix}: ${issue.where}` : prefix) : issue.where;
      this.issues.push({ ...issue, ...(where !== undefined ? { where } : {}) });
    }
    for (const [k, v] of Object.entries(report.stats)) this.count(k, v);
  }

  report(format: InteropFormat, direction: 'import' | 'export'): InteropReport {
    return { format, direction, issues: this.issues, stats: this.stats };
  }

  private push(severity: InteropIssue['severity'], code: string, message: string, where?: string, hint?: string): void {
    this.issues.push({ severity, code, message, ...(where !== undefined ? { where } : {}), ...(hint !== undefined ? { hint } : {}) });
  }
}

/** Parse a Live2D JSON file given as text (BOM allowed) or as an already parsed object. */
export function parseJsonInput(input: string | Json, what: string): Json {
  let value: unknown = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input.charCodeAt(0) === 0xfeff ? input.slice(1) : input);
    } catch (e) {
      throw new Error(`${what}: invalid JSON (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  if (!isObject(value)) throw new Error(`${what}: expected a JSON object, got ${describe(value)}`);
  return value;
}

export function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  if (typeof v === 'string') return `the string ${JSON.stringify(v.length > 40 ? v.slice(0, 40) + '...' : v)}`;
  return typeof v === 'object' ? 'an object' : `${typeof v} ${String(v)}`;
}

/** A finite number, or undefined. */
export function finite(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Short number for messages. */
export function fmt(n: number): string {
  const r = Number(n.toFixed(4));
  return Object.is(r, -0) ? '0' : String(r);
}

export function q(s: string): string {
  return JSON.stringify(s);
}

/** Round to `digits` decimals for written files (no -0). */
export function round(n: number, digits = 6): number {
  const r = Number(n.toFixed(digits));
  return Object.is(r, -0) ? 0 : r;
}

/** UTF-8 byte length (motion3 TotalUserDataSize counts bytes). */
export function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}

const ID_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** A valid Rev2D id derived from `s` (invalid characters become "_"), or `fallback`. */
export function sanitizeId(s: string, fallback: string): string {
  if (ID_RE.test(s)) return s;
  let out = s.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  if (!out || !/[A-Za-z0-9]/.test(out)) return fallback;
  if (!/^[A-Za-z_]/.test(out)) out = `_${out}`;
  return out;
}

/** `base`, or `base_2`, `base_3`, ... whichever is not in `taken` (the chosen id is added to it). */
export function uniqueId(base: string, taken: Set<string>): string {
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
  taken.add(id);
  return id;
}

/** "did you mean ...?" or undefined. */
export function didYouMean(got: string, options: string[]): string | undefined {
  return suggest(got, options) ?? undefined;
}

// ----------------------------------------------------------------------------- imported animations

/**
 * How the description of an animation written by a Live2D import starts: a motion3.json on its own, a
 * motion listed by a model3.json, an exp3.json. An import that replaces an existing animation (same id)
 * tells by it whether that animation came from an earlier import or was made in Rev2D.
 */
export const IMPORTED_MOTION = 'Imported from a Live2D motion3.json';
export const IMPORTED_MODEL3_MOTION = 'Live2D motion "';
export const IMPORTED_EXPRESSION = 'Live2D expression (exp3.json)';

/** Whether a (raw) animation was written by a Live2D import and still carries its description. */
export function isLive2dImport(animation: unknown): boolean {
  if (!isObject(animation) || typeof animation.description !== 'string') return false;
  const d = animation.description;
  return d.startsWith(IMPORTED_MOTION) || d.startsWith(IMPORTED_MODEL3_MOTION) || d.startsWith(IMPORTED_EXPRESSION);
}

/**
 * The issue for an import that replaces the existing animation `id`: expected (info) when an earlier
 * Live2D import wrote it, a warning when it was made in Rev2D, because its tracks and events are lost.
 */
export function replacedAnimationIssue(id: string, imported: boolean, where?: string): InteropIssue {
  const at = where !== undefined ? { where } : {};
  if (imported) {
    return { severity: 'info', code: 'live2d-animation-replaced', message: `animation ${q(id)} of an earlier Live2D import is replaced`, ...at };
  }
  return {
    severity: 'warning',
    code: 'live2d-animation-replaced',
    message: `animation ${q(id)} already exists and was not written by a Live2D import: the imported animation replaces it (its tracks and events are no longer in the model)`,
    ...at,
    hint: `to keep it, rename it first ({"op":"rename","kind":"animation","from":${q(id)},"to":${q(`${id}_own`)}}) and import again, or give a single motion3 / exp3 file another animation id (CLI --id, MCP id)`,
  };
}

// ----------------------------------------------------------------------------- target model

export interface ParamInfo {
  id: string;
  min: number;
  max: number;
  default: number;
  description?: string;
  group?: string;
}

/** What the converters need to know about the Rev2D model an import targets (raw or normalized JSON). */
export interface ModelInfo {
  params: Map<string, ParamInfo>;
  paramIds: string[];
  parts: Map<string, { description?: string }>;
  partIds: string[];
  animationIds: string[];
  /** Animations an earlier Live2D import wrote (see isLive2dImport). */
  importedAnimationIds: Set<string>;
  physics: Array<{ id: string; outputs: string[] }>;
}

export function modelInfo(model: Record<string, unknown> | undefined): ModelInfo | undefined {
  if (!model) return undefined;
  const params = new Map<string, ParamInfo>();
  for (const p of arrayOf(model.parameters)) {
    if (!isObject(p) || typeof p.id !== 'string') continue;
    const min = finite(p.min) ?? 0;
    const max = finite(p.max) ?? 0;
    params.set(p.id, {
      id: p.id,
      min,
      max,
      default: paramDefault({ min, max, default: finite(p.default) }),
      ...(typeof p.description === 'string' ? { description: p.description } : {}),
      ...(typeof p.group === 'string' ? { group: p.group } : {}),
    });
  }
  const parts = new Map<string, { description?: string }>();
  for (const p of arrayOf(model.parts)) {
    if (isObject(p) && typeof p.id === 'string') parts.set(p.id, typeof p.description === 'string' ? { description: p.description } : {});
  }
  const animationIds = arrayOf(model.animations).flatMap((a) => (isObject(a) && typeof a.id === 'string' ? [a.id] : []));
  const importedAnimationIds = new Set(arrayOf(model.animations).flatMap((a) => (isObject(a) && typeof a.id === 'string' && isLive2dImport(a) ? [a.id] : [])));
  const physics = arrayOf(model.physics).flatMap((g) =>
    isObject(g) && typeof g.id === 'string'
      ? [{ id: g.id, outputs: arrayOf(g.outputs).flatMap((o) => (isObject(o) && typeof o.param === 'string' ? [o.param] : [])) }]
      : [],
  );
  return { params, paramIds: [...params.keys()], parts, partIds: [...parts.keys()], animationIds, importedAnimationIds, physics };
}

export function arrayOf(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
