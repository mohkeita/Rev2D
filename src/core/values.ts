/**
 * Value normalization, interpolation and combination.
 *
 * Combination rule (bindings + animation tracks on the same property):
 *     final = setup + Σ weight_i * (value_i - setup)
 * applied element-wise for points / colors / path numbers. Booleans are 0/1 numbers, final >= 0.5 => true.
 */
import type { PathValue, RawValue, ResolvedTarget, RGBA, Value, ValueType } from './types.js';
import { formatColor, parseColor } from './color.js';
import { formatPath, tryParsePath } from './path.js';

export class ValueError extends Error {
  constructor(
    message: string,
    public hint?: string,
  ) {
    super(message);
  }
}

function isSparse(raw: unknown): raw is Record<string, [number, number]> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw);
}

/** Convert a raw JSON value for `target` into its runtime form. Throws ValueError with a hint. */
export function normalizeValue(raw: RawValue, target: Pick<ResolvedTarget, 'valueType' | 'setup' | 'pointCount'>): Value {
  const { valueType } = target;
  switch (valueType) {
    case 'number':
      if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
      throw new ValueError(`expected a number, got ${describe(raw)}`);
    case 'boolean':
      if (typeof raw === 'boolean') return raw ? 1 : 0;
      if (typeof raw === 'number') return raw >= 0.5 ? 1 : 0;
      throw new ValueError(`expected true/false, got ${describe(raw)}`);
    case 'color': {
      if (typeof raw !== 'string') throw new ValueError(`expected a color string, got ${describe(raw)}`, 'e.g. "#ff8800" or "rgba(255,128,0,0.5)"');
      const c = parseColor(raw);
      if (!c) throw new ValueError(`invalid color "${raw}"`, 'use "#rrggbb", "#rrggbbaa" or "rgba(r,g,b,a)"');
      return c;
    }
    case 'path': {
      if (typeof raw !== 'string') throw new ValueError(`expected an SVG path string, got ${describe(raw)}`);
      const p = tryParsePath(raw);
      if (!p) throw new ValueError(`invalid SVG path "${raw.slice(0, 60)}"`);
      const setup = target.setup as PathValue;
      if (p.template !== setup.template) {
        throw new ValueError(
          `path structure differs from the setup path`,
          `keyform paths must use the same commands in the same order as the setup path: "${setup.template}" (got "${p.template}")`,
        );
      }
      return p;
    }
    case 'points': {
      const setup = target.setup as number[];
      const count = target.pointCount ?? setup.length / 2;
      if (Array.isArray(raw)) {
        if (raw.length !== count * 2 || raw.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
          throw new ValueError(
            `expected ${count * 2} numbers (${count} points), got ${Array.isArray(raw) ? raw.length : describe(raw)}`,
            `or use a sparse map {"<pointIndex>": [x, y]} to change only some points`,
          );
        }
        return (raw as number[]).slice();
      }
      if (isSparse(raw)) {
        const out = setup.slice();
        for (const [k, v] of Object.entries(raw)) {
          const idx = Number(k);
          if (!Number.isInteger(idx) || idx < 0 || idx >= count) {
            throw new ValueError(`point index ${k} out of range (0..${count - 1})`);
          }
          if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => typeof n === 'number' && Number.isFinite(n))) {
            throw new ValueError(`point ${k} must be [x, y]`);
          }
          out[idx * 2] = v[0];
          out[idx * 2 + 1] = v[1];
        }
        return out;
      }
      throw new ValueError(`expected a point list or sparse point map, got ${describe(raw)}`);
    }
  }
}

function describe(raw: unknown): string {
  if (Array.isArray(raw)) return `array(${raw.length})`;
  if (raw === null) return 'null';
  if (typeof raw === 'string') return `"${raw.length > 40 ? raw.slice(0, 40) + '…' : raw}"`;
  return typeof raw === 'object' ? 'object' : String(raw);
}

export function cloneValue(v: Value): Value {
  if (typeof v === 'number') return v;
  if (Array.isArray(v)) return v.slice() as Value;
  return { template: v.template, commands: v.commands, nums: v.nums.slice() };
}

/** Linear interpolation between two values of the same type. */
export function lerpValue(a: Value, b: Value, t: number): Value {
  if (typeof a === 'number') return a + ((b as number) - a) * t;
  if (Array.isArray(a)) {
    const bb = b as number[];
    const out = new Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = a[i] + (bb[i] - a[i]) * t;
    return out as Value;
  }
  const bp = b as PathValue;
  const nums = new Array(a.nums.length);
  for (let i = 0; i < nums.length; i++) nums[i] = a.nums[i] + (bp.nums[i] - a.nums[i]) * t;
  return { template: a.template, commands: a.commands, nums };
}

/** Weighted blend of several values: Σ w_i * v_i (weights should sum to 1). */
export function blendValues(values: Value[], weights: number[]): Value {
  if (typeof values[0] === 'number') {
    let sum = 0;
    for (let k = 0; k < values.length; k++) sum += (values[k] as number) * weights[k];
    return sum;
  }
  const out = cloneValue(values[0]);
  scaleInPlace(out, weights[0]);
  for (let k = 1; k < values.length; k++) addScaledInPlace(out, values[k], weights[k]);
  return out;
}

function scaleInPlace(v: Value, s: number): void {
  if (typeof v === 'number') throw new Error('scaleInPlace on number');
  const arr = Array.isArray(v) ? v : v.nums;
  for (let i = 0; i < arr.length; i++) arr[i] *= s;
}

function addScaledInPlace(acc: Value, v: Value, s: number): void {
  const a = Array.isArray(acc) ? acc : (acc as PathValue).nums;
  const b = Array.isArray(v) ? v : (v as PathValue).nums;
  for (let i = 0; i < a.length; i++) a[i] += b[i] * s;
}

/**
 * Accumulator for the combination rule. Start with `createAccumulator(setup)`, call `add` for every
 * contribution, then `result()`.
 */
export class ValueAccumulator {
  private acc: Value;
  private touched = false;
  constructor(private readonly setup: Value) {
    this.acc = cloneValue(setup);
  }
  add(value: Value, weight = 1): void {
    this.touched = true;
    const s = this.setup;
    if (typeof s === 'number') {
      this.acc = (this.acc as number) + weight * ((value as number) - s);
      return;
    }
    const a = Array.isArray(this.acc) ? this.acc : (this.acc as PathValue).nums;
    const v = Array.isArray(value) ? value : (value as PathValue).nums;
    const sv = Array.isArray(s) ? s : (s as PathValue).nums;
    for (let i = 0; i < a.length; i++) a[i] += weight * (v[i] - sv[i]);
  }
  /** Replace the accumulated value (used by parameter-style absolute overrides). */
  set(value: Value): void {
    this.touched = true;
    this.acc = cloneValue(value);
  }
  get changed(): boolean {
    return this.touched;
  }
  result(): Value {
    return this.acc;
  }
}

/** JSON-friendly representation (colors -> hex, paths -> string, booleans -> 0/1). */
export function valueToJSON(v: Value, type: ValueType): number | number[] | string {
  switch (type) {
    case 'color':
      return formatColor(v as RGBA);
    case 'path':
      return formatPath(v as PathValue);
    case 'points':
      return (v as number[]).map((n) => +n.toFixed(3));
    default:
      return +(v as number).toFixed(4);
  }
}
