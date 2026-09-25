/**
 * "smooth" animation segments (SPEC §6): cubic Hermite curves whose key tangents come from the
 * neighbouring keys (Catmull-Rom with non-uniform key times), evaluated element-wise for numbers,
 * point lists, colors and path numbers.
 *
 * Tangent of key i (value units per second), with neighbours p = previous key, n = next key:
 *   both neighbours:        m_i = (v_n - v_p) / (t_n - t_p)
 *   first / last key only:  one-sided, m_i = slope of the adjacent segment
 *   single key:             0
 * A looping animation whose track is CLOSED (first key at t = 0 and last key at t = duration) wraps
 * the neighbours around the loop: key 0 and the last key are the same instant, so key 0's previous
 * neighbour is the second-to-last key shifted by -duration and the last key's next neighbour is key 1
 * shifted by +duration. Both ends then get the same tangent, so a walk whose last value equals its
 * first has continuous velocity across the seam. Any other track uses one-sided end tangents.
 */
import type { PathValue, Value } from '../types.js';

/** Relative tolerance for "first key at 0 / last key at duration" (float noise in authored times). */
const CLOSED_EPS = 1e-9;

function elements(v: Value): ArrayLike<number> {
  return Array.isArray(v) ? v : (v as PathValue).nums;
}

/** (b - a) / dt element-wise; 0 when dt is not positive (coincident keys). */
function slope(a: Value, b: Value, dt: number): number | number[] {
  const k = dt > 0 ? 1 / dt : 0;
  if (typeof a === 'number') return ((b as number) - a) * k;
  const ea = elements(a);
  const eb = elements(b);
  const out = new Array<number>(ea.length);
  for (let i = 0; i < ea.length; i++) out[i] = (eb[i] - ea[i]) * k;
  return out;
}

function zeroLike(v: Value): number | number[] {
  return typeof v === 'number' ? 0 : new Array<number>(elements(v).length).fill(0);
}

/** True when a looping track's keys span the whole loop (first at 0, last at duration). */
export function isClosedLoop(times: ArrayLike<number>, loop: boolean, duration: number): boolean {
  const n = times.length;
  if (!loop || n < 2) return false;
  const eps = CLOSED_EPS * Math.max(1, duration);
  return Math.abs(times[0]) <= eps && Math.abs(times[n - 1] - duration) <= eps;
}

/** Tangents for every key of a track (see the module comment). */
export function keyTangents(times: ArrayLike<number>, values: Value[], loop: boolean, duration: number): Array<number | number[]> {
  const n = times.length;
  const last = n - 1;
  const closed = isClosedLoop(times, loop, duration);
  const out: Array<number | number[]> = new Array(n);
  for (let i = 0; i < n; i++) {
    let pt: number | undefined;
    let pv: Value | undefined;
    let nt: number | undefined;
    let nv: Value | undefined;
    if (i > 0) {
      pt = times[i - 1];
      pv = values[i - 1];
    } else if (closed) {
      pt = times[last - 1] - duration;
      pv = values[last - 1];
    }
    if (i < last) {
      nt = times[i + 1];
      nv = values[i + 1];
    } else if (closed) {
      nt = times[1] + duration;
      nv = values[1];
    }
    if (pv !== undefined && nv !== undefined) out[i] = slope(pv, nv, nt! - pt!);
    else if (nv !== undefined) out[i] = slope(values[i], nv, nt! - times[i]);
    else if (pv !== undefined) out[i] = slope(pv, values[i], times[i] - pt!);
    else out[i] = zeroLike(values[i]);
  }
  return out;
}

/**
 * Cubic Hermite between a (tangent ma) and b (tangent mb) over a segment of `dt` seconds at progress
 * s in [0, 1]: h00·a + h10·dt·ma + h01·b + h11·dt·mb.
 */
export function hermiteValue(a: Value, b: Value, ma: number | number[], mb: number | number[], dt: number, s: number): Value {
  const s2 = s * s;
  const s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1;
  const h10 = (s3 - 2 * s2 + s) * dt;
  const h01 = -2 * s3 + 3 * s2;
  const h11 = (s3 - s2) * dt;
  if (typeof a === 'number') return h00 * a + h10 * (ma as number) + h01 * (b as number) + h11 * (mb as number);
  const ea = elements(a);
  const eb = elements(b);
  const ta = ma as number[];
  const tb = mb as number[];
  const nums = new Array<number>(ea.length);
  for (let i = 0; i < ea.length; i++) nums[i] = h00 * ea[i] + h10 * ta[i] + h01 * eb[i] + h11 * tb[i];
  if (Array.isArray(a)) return nums as Value;
  const p = a as PathValue;
  return { template: p.template, commands: p.commands, nums };
}
