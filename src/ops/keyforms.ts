/**
 * Raw keyform values read the way the rig evaluates bindings (SPEC §5): where a parameter value
 * falls on a grid axis, and linear blends of two raw values of one target written back as JSON.
 * Used when a parameter is removed with cascade, so its bindings keep the look they had at the
 * parameter's default.
 */
import { formatColor, mixColor } from '../core/color.js';
import { formatPath } from '../core/path.js';
import type { PathValue, RawValue, ResolvedTarget, RGBA, Value, ValueType } from '../core/types.js';
import { lerpValue, normalizeValue } from '../core/values.js';
import { clean, isObject } from './util.js';

/** A normalized value as JSON (booleans as true/false, colours as hex). */
export function valueJson(v: Value, type: ValueType): unknown {
  switch (type) {
    case 'number':
      return clean(v as number);
    case 'boolean':
      return (v as number) >= 0.5;
    case 'color':
      return formatColor(v as RGBA);
    case 'path':
      return formatPath(v as PathValue);
    case 'points':
      return (v as number[]).map((n) => clean(n, 4));
  }
}

/** Rounding of values written by lerpRaw (hex colours, 3-decimal paths, 4-decimal points). */
const ROUNDING: Record<ValueType, number> = { number: 1e-6, boolean: 1e-6, points: 1e-4, path: 1e-3, color: 1 / 255 };

/** Equal up to the rounding lerpRaw applies when writing JSON. */
export function valuesClose(a: Value, b: Value, type: ValueType): boolean {
  const flat = (v: Value): readonly number[] => (typeof v === 'number' ? [v] : Array.isArray(v) ? v : (v as PathValue).nums);
  const fa = flat(a);
  const fb = flat(b);
  return fa.length === fb.length && fa.every((x, i) => Math.abs(x - fb[i]) <= ROUNDING[type]);
}

/** Position of a parameter value on a sorted grid axis: blend `frac` of the way from `lo` to `hi`. */
export interface AxisPosition {
  lo: number;
  hi: number;
  frac: number;
}

/** Same bracketing as the evaluator: clamped at the ends; `step` holds the lower grid value. */
export function axisPosition(axis: readonly number[], p: number, step: boolean): AxisPosition {
  const last = axis.length - 1;
  if (p <= axis[0]) return { lo: axis[0], hi: axis[0], frac: 0 };
  if (p >= axis[last]) return { lo: axis[last], hi: axis[last], frac: 0 };
  let i = 0;
  while (axis[i + 1] <= p) i++;
  if (step || axis[i] === p) return { lo: axis[i], hi: axis[i], frac: 0 };
  return { lo: axis[i], hi: axis[i + 1], frac: (p - axis[i]) / (axis[i + 1] - axis[i]) };
}

function isSparse(v: unknown): v is Record<string, unknown> {
  return isObject(v);
}

/**
 * `a + (b - a) · t` for two raw values of `target`, as JSON. Two sparse point maps give a sparse
 * map over the union of their indexes; any other point pair gives a full list. Throws ValueError
 * when a value does not fit the target.
 */
export function lerpRaw(a: unknown, b: unknown, t: number, target: ResolvedTarget): unknown {
  // Exact ends keep the authored value (and its form) untouched.
  if (t === 0 || t === 1) {
    normalizeValue((t === 0 ? a : b) as RawValue, target);
    return structuredClone(t === 0 ? a : b);
  }
  const va = normalizeValue(a as RawValue, target);
  const vb = normalizeValue(b as RawValue, target);
  switch (target.valueType) {
    case 'number':
      return clean(lerpValue(va, vb, t) as number);
    case 'boolean':
      return (lerpValue(va, vb, t) as number) >= 0.5;
    case 'color':
      return formatColor(mixColor(va as RGBA, vb as RGBA, t));
    case 'path':
      return formatPath(lerpValue(va, vb, t) as PathValue);
    case 'points': {
      const full = lerpValue(va, vb, t) as number[];
      if (!isSparse(a) || !isSparse(b)) return full.map((n) => clean(n, 4));
      const indexes = [...new Set([...Object.keys(a), ...Object.keys(b)])].map(Number).sort((x, y) => x - y);
      return Object.fromEntries(indexes.map((i) => [String(i), [clean(full[i * 2], 4), clean(full[i * 2 + 1], 4)]]));
    }
  }
}

/** Value of a one-parameter binding at `p` (raw JSON), or undefined when its keys are not usable. */
export function sample1D(keys: unknown[], p: number, step: boolean, target: ResolvedTarget): unknown {
  const byAt = new Map<number, unknown>();
  for (const k of keys) {
    if (isObject(k) && Array.isArray(k.at) && typeof k.at[0] === 'number' && Object.hasOwn(k, 'value')) byAt.set(k.at[0], k.value);
  }
  if (!byAt.size) return undefined;
  const axis = [...byAt.keys()].sort((x, y) => x - y);
  const { lo, hi, frac } = axisPosition(axis, p, step);
  return lerpRaw(byAt.get(lo), byAt.get(hi), frac, target);
}
