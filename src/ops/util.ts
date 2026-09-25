/**
 * Small helpers shared by the op implementations: the op error type, number/value formatting for
 * messages, JSON utilities and typed readers for op fields.
 */
import { toPointer } from '../core/validate/diagnostics.js';
import { compactJson, didYouMean, q, suggestKey } from '../core/validate/text.js';
import { OP_CATALOG } from './catalog.js';

export { q, toPointer };

/** A failed op. `message` says what is wrong, `hint` how to fix it. */
export class OpError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

export type JsonObject = Record<string, unknown>;

export function isObject(v: unknown): v is JsonObject {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Deep JSON equality (object key order ignored). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    return ka.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]));
  }
  return false;
}

/** Round away float noise from computed values (1e-6), normalizing -0 to 0. */
export function clean(n: number, decimals = 6): number {
  const r = Number(n.toFixed(decimals));
  return Object.is(r, -0) ? 0 : r;
}

/** Number for messages: at most 3 decimals, no "-0". */
export function fmt(n: number): string {
  return String(clean(n, 3));
}

export function fmtPoint(x: number, y: number): string {
  return `(${fmt(x)}, ${fmt(y)})`;
}

/** Compact one-line JSON for messages, truncated to `max` characters. */
export function show(v: unknown, max = 60): string {
  if (v === undefined) return '(unset)';
  const s = JSON.stringify(v, (_k, x) => (typeof x === 'number' ? clean(x, 3) : x)) ?? String(v);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** did-you-mean when close, else the list of valid options. */
export function choiceHint(got: string, options: readonly string[], noun = 'valid'): string {
  const d = didYouMean(got, options);
  const list = `${noun}: ${options.join(', ')}`;
  return d ? `${d} (${list})` : list;
}

/**
 * Field names AI agents commonly use for op fields that are spelled differently here (keys are
 * normalized: lowercase, no separators). Edit distance cannot find these ("rotation" -> "rotate").
 */
const FIELD_ALIASES: Record<string, readonly string[]> = {
  rotation: ['rotate'],
  angle: ['rotate', 'yaw'],
  rot: ['rotate'],
  offset: ['translate', 'offsets'],
  move: ['translate'],
  shift: ['translate'],
  position: ['world', 'translate', 'index'],
  pos: ['world', 'translate'],
  origin: ['pivot'],
  center: ['pivot'],
  centre: ['pivot'],
  anchor: ['pivot'],
  turn: ['yaw'],
  tilt: ['pitch'],
  nod: ['pitch'],
  item: ['value'],
  object: ['value'],
  data: ['value'],
  changes: ['set'],
  fields: ['set'],
  props: ['set'],
  properties: ['set'],
  values: ['set'],
  name: ['id', 'to'],
  newid: ['to'],
  newname: ['to'],
  oldid: ['from'],
  param: ['params'],
  parameter: ['params'],
  parameters: ['params'],
  keyframes: ['keys'],
  frames: ['keys'],
  keyforms: ['keys'],
  time: ['t'],
  value: ['v', 'value'],
  val: ['v', 'value'],
  easing: ['ease'],
  anim: ['animation'],
  clip: ['animation'],
  length: ['duration'],
  looping: ['loop'],
  recursive: ['cascade'],
  force: ['cascade'],
  address: ['target'],
  property: ['target'],
  prop: ['target'],
  path: ['target'],
  ops: ['patch'],
  operations: ['patch'],
  type: ['kind'],
  section: ['kind'],
};

/** Hint for an unknown field: known alias, then edit distance, then the list of fields. */
export function fieldHint(got: string, allowed: readonly string[], noun = 'fields'): string {
  const word = got.toLowerCase().replace(/[-_\s]/g, '');
  const alias = Object.hasOwn(FIELD_ALIASES, word) ? FIELD_ALIASES[word].find((a) => allowed.includes(a)) : undefined;
  const match = alias ?? suggestKey(got, allowed);
  const list = `${noun}: ${allowed.join(', ')}`;
  return match ? `did you mean ${q(match)}? (${list})` : list;
}

// ----------------------------------------------------------------------------- op field readers

/** Reads typed fields of one op object and reports precise errors naming the op. */
export class Fields {
  constructor(
    readonly op: JsonObject,
    readonly name: string,
  ) {}

  has(key: string): boolean {
    return Object.hasOwn(this.op, key) && this.op[key] !== undefined;
  }

  raw(key: string): unknown {
    return this.has(key) ? this.op[key] : undefined;
  }

  required(key: string, what: string): unknown {
    if (!this.has(key)) throw new OpError(`${this.name} needs "${key}" (${what})`, exampleFor(this.name));
    return this.op[key];
  }

  string(key: string, what: string): string {
    const v = this.required(key, what);
    if (typeof v !== 'string' || v === '') throw new OpError(`${this.name}: "${key}" must be a non-empty string (${what}), got ${describe(v)}`);
    return v;
  }

  optString(key: string, what: string): string | undefined {
    return this.has(key) ? this.string(key, what) : undefined;
  }

  number(key: string, what: string): number {
    const v = this.required(key, what);
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new OpError(`${this.name}: "${key}" must be a number (${what}), got ${describe(v)}`);
    return v;
  }

  optNumber(key: string, what: string): number | undefined {
    return this.has(key) ? this.number(key, what) : undefined;
  }

  optBoolean(key: string, what: string): boolean | undefined {
    if (!this.has(key)) return undefined;
    const v = this.op[key];
    if (typeof v !== 'boolean') throw new OpError(`${this.name}: "${key}" must be true or false (${what}), got ${describe(v)}`);
    return v;
  }

  object(key: string, what: string): JsonObject {
    const v = this.required(key, what);
    if (!isObject(v)) throw new OpError(`${this.name}: "${key}" must be an object (${what}), got ${describe(v)}`, exampleFor(this.name));
    return v;
  }

  array(key: string, what: string): unknown[] {
    const v = this.required(key, what);
    if (!Array.isArray(v)) throw new OpError(`${this.name}: "${key}" must be an array (${what}), got ${describe(v)}`, exampleFor(this.name));
    return v;
  }

  /** Parameter id list; a single string is accepted as shorthand for a one-element list. */
  paramList(key: string): string[] {
    const v = this.required(key, 'parameter ids, e.g. ["AngleX"]');
    const list = typeof v === 'string' ? [v] : v;
    if (!Array.isArray(list) || list.length === 0 || list.some((p) => typeof p !== 'string' || p === '')) {
      throw new OpError(`${this.name}: "${key}" must be a non-empty list of parameter ids, got ${describe(v)}`, 'e.g. "params": ["AngleX"] or ["AngleX", "AngleY"]');
    }
    if (list.length > 3) throw new OpError(`${this.name}: a binding has 1 to 3 parameters, got ${list.length}`, 'split the effect into several bindings on the same target (their deltas add up)');
    return list as string[];
  }
}

/** `example: {...}` hint for an op name (from the catalogue). */
export function exampleFor(op: string): string | undefined {
  const entry = OP_CATALOG.find((d) => d.op === op);
  return entry ? `example: ${compactJson(entry.example)}` : undefined;
}

/** Short description of a JSON value for "got ..." phrases. */
export function describe(v: unknown): string {
  if (v === undefined) return 'nothing';
  if (v === null) return 'null';
  if (Array.isArray(v)) return `an array (${v.length} items)`;
  if (typeof v === 'string') return `string ${q(v.length > 40 ? `${v.slice(0, 40)}…` : v)}`;
  if (typeof v === 'object') return 'an object';
  return `${typeof v} ${String(v)}`;
}
