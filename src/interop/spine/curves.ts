/**
 * Spine timeline curves <-> Rev2D eases.
 *
 * A Spine key's curve shapes the segment from that key to the next, like a Rev2D key's `ease`.
 * Spine 4.x stores a bezier per value channel as ABSOLUTE control points (time, value):
 * [cx1, cy1, cx2, cy2]; 3.x stores one NORMALIZED bezier (0..1 in time and value) for all channels.
 * Rev2D eases are normalized cubic-bezier(x1, y1, x2, y2), so an absolute Spine segment
 * (t0, v0) -> (t1, v1) converts exactly to
 *   x = (cx - t0) / (t1 - t0),  y = (cy - v0) / (v1 - v0)
 * which is invariant under the affine value mappings the importer applies (negated rotations, scaled
 * translations). A segment whose end values are equal but whose control values are not (a "bulge"
 * back to the same value) has no normalized form; it is split exactly (de Casteljau) into halves that
 * each have a value span. Both evaluate the same parametric curve, so the conversion is exact.
 */
import { EASINGS, cubicBezier } from '../../core/easing.js';
import type { Ease } from '../../core/types.js';
import type { SpineKeyBase } from './types.js';

/** Absolute bezier control points of one channel of one segment: [cx1, cy1, cx2, cy2] (time, value). */
export type Bezier = [number, number, number, number];
/** Shape of one channel of one segment. */
export type SegmentCurve = 'linear' | 'stepped' | Bezier;

const EPS = 1e-9;

// ----------------------------------------------------------------------------- reading

/**
 * Curve of channel `channel` for the segment starting at `key`, as absolute control points.
 * `span` = [t0, v0, t1, v1] of that channel's segment (used to denormalize 3.x curves).
 * `legacy` = the file is Spine 3.x (normalized array curves).
 */
export function readSegmentCurve(key: SpineKeyBase, channel: number, span: [number, number, number, number], legacy: boolean): SegmentCurve {
  const c = key.curve;
  if (c === undefined || c === 'linear') return 'linear';
  if (c === 'stepped') return 'stepped';
  const [t0, v0, t1, v1] = span;
  const denorm = (x1: number, y1: number, x2: number, y2: number): Bezier => [
    t0 + x1 * (t1 - t0),
    v0 + y1 * (v1 - v0),
    t0 + x2 * (t1 - t0),
    v0 + y2 * (v1 - v0),
  ];
  if (typeof c === 'number') return denorm(c, key.c2 ?? 0, key.c3 ?? 1, key.c4 ?? 1);
  if (!Array.isArray(c)) return 'linear';
  if (legacy) return c.length >= 4 ? denorm(c[0], c[1], c[2], c[3]) : 'linear';
  const o = channel * 4;
  if (c.length < o + 4) return 'linear';
  return [c[o], c[o + 1], c[o + 2], c[o + 3]];
}

// ----------------------------------------------------------------------------- evaluation

function bez(p0: number, p1: number, p2: number, p3: number, u: number): number {
  const m = 1 - u;
  return m * m * m * p0 + 3 * m * m * u * p1 + 3 * m * u * u * p2 + u * u * u * p3;
}

/**
 * Value of the absolute bezier segment (t0, v0) -(c)- (t1, v1) at time t (exact: solves x(u) = t by
 * bisection; control times are clamped into [t0, t1] like the Spine editor does).
 */
export function evalBezier(t0: number, v0: number, c: Bezier, t1: number, v1: number, t: number): number {
  if (t <= t0) return v0;
  if (t >= t1) return v1;
  const cx1 = Math.min(t1, Math.max(t0, c[0]));
  const cx2 = Math.min(t1, Math.max(t0, c[2]));
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (bez(t0, cx1, cx2, t1, mid) < t) lo = mid;
    else hi = mid;
  }
  return bez(v0, c[1], c[3], v1, (lo + hi) / 2);
}

/** Value of a segment curve at time t (stepped holds v0). */
export function evalSegment(t0: number, v0: number, curve: SegmentCurve, t1: number, v1: number, t: number): number {
  if (t <= t0) return v0;
  if (t >= t1) return v1;
  if (curve === 'stepped') return v0;
  if (curve === 'linear') return v0 + ((t - t0) / (t1 - t0)) * (v1 - v0);
  return evalBezier(t0, v0, curve, t1, v1, t);
}

/** Split the bezier at parameter u (de Casteljau): left and right halves as [t0, v0, c, t1, v1]. */
export function splitBezier(
  t0: number,
  v0: number,
  c: Bezier,
  t1: number,
  v1: number,
  u = 0.5,
): [[number, number, Bezier, number, number], [number, number, Bezier, number, number]] {
  const lerp = (a: number, b: number) => a + (b - a) * u;
  const ax = lerp(t0, c[0]);
  const ay = lerp(v0, c[1]);
  const bx = lerp(c[0], c[2]);
  const by = lerp(c[1], c[3]);
  const cx = lerp(c[2], t1);
  const cy = lerp(c[3], v1);
  const dx = lerp(ax, bx);
  const dy = lerp(ay, by);
  const ex = lerp(bx, cx);
  const ey = lerp(by, cy);
  const mx = lerp(dx, ex);
  const my = lerp(dy, ey);
  return [
    [t0, v0, [ax, ay, dx, dy], mx, my],
    [mx, my, [ex, ey, cx, cy], t1, v1],
  ];
}

// ----------------------------------------------------------------------------- Spine -> Rev2D

/**
 * Normalized Rev2D ease of an absolute bezier segment: 'linear' when the curve is a straight line (or
 * the value is constant along it), the cubic-bezier otherwise, or null when the end values are equal
 * but the curve bulges (split it with splitBezier first).
 */
export function bezierToEase(t0: number, v0: number, c: Bezier, t1: number, v1: number): Ease | null {
  const dt = t1 - t0;
  const dv = v1 - v0;
  const x1 = dt > 0 ? Math.min(1, Math.max(0, (c[0] - t0) / dt)) : 0;
  const x2 = dt > 0 ? Math.min(1, Math.max(0, (c[2] - t0) / dt)) : 1;
  const scale = Math.max(1, Math.abs(v0), Math.abs(v1));
  if (Math.abs(dv) <= EPS * scale) {
    return Math.abs(c[1] - v0) <= EPS * scale && Math.abs(c[3] - v0) <= EPS * scale ? 'linear' : null;
  }
  const y1 = (c[1] - v0) / dv;
  const y2 = (c[3] - v0) / dv;
  if (Math.abs(x1 - y1) < 1e-9 && Math.abs(x2 - y2) < 1e-9) return 'linear';
  // Drop float noise (and -0) so identical curves serialize identically.
  const tidy = (v: number) => {
    const r = Math.round(v * 1e12) / 1e12;
    return r === 0 ? 0 : r;
  };
  return [tidy(x1), tidy(y1), tidy(x2), tidy(y2)];
}

/** One key of a scalar channel: value and the curve of the segment to the next key. */
export interface ChannelKey {
  t: number;
  v: number;
  curve: SegmentCurve;
}

/** A Rev2D key (ease omitted = linear). */
export interface EasedKey {
  t: number;
  v: number;
  ease?: Ease;
}

/** Segments shorter than this are never split (keys would collide after rounding). */
const MIN_SPLIT_DT = 2e-3;
const MAX_SPLIT_DEPTH = 6;

/**
 * Convert a scalar Spine channel to Rev2D keys, exactly: bezier segments become cubic-bezier eases,
 * bulging segments between equal values are split at their midpoint (adding keys), stepped
 * segments become 'step'. Returns the number of keys added by splitting in `split`.
 */
export function channelToKeys(keys: readonly ChannelKey[]): { keys: EasedKey[]; split: number } {
  const out: EasedKey[] = [];
  let split = 0;
  const pushBezier = (t0: number, v0: number, c: Bezier, t1: number, v1: number, depth: number) => {
    const ease = bezierToEase(t0, v0, c, t1, v1);
    if (ease !== null) {
      out.push(ease === 'linear' ? { t: t0, v: v0 } : { t: t0, v: v0, ease });
      return;
    }
    if (depth >= MAX_SPLIT_DEPTH || t1 - t0 < MIN_SPLIT_DT) {
      // Tiny or pathological: sample the curve at its midpoint and interpolate linearly.
      const tm = (t0 + t1) / 2;
      if (t1 - t0 >= MIN_SPLIT_DT) {
        out.push({ t: t0, v: v0 }, { t: tm, v: evalBezier(t0, v0, c, t1, v1, tm) });
        split++;
      } else {
        out.push({ t: t0, v: v0 });
      }
      return;
    }
    const [left, right] = splitBezier(t0, v0, c, t1, v1);
    split++;
    pushBezier(...left, depth + 1);
    pushBezier(...right, depth + 1);
  };
  keys.forEach((k, i) => {
    const next = keys[i + 1];
    if (!next) {
      out.push({ t: k.t, v: k.v });
      return;
    }
    if (k.curve === 'stepped') out.push({ t: k.t, v: k.v, ease: 'step' });
    else if (k.curve === 'linear' || next.t - k.t <= 0) out.push({ t: k.t, v: k.v });
    else pushBezier(k.t, k.v, k.curve, next.t, next.v, 0);
  });
  return { keys: out, split };
}

/**
 * The ease of a percent curve (Spine deform timelines and other vector keys interpolate with one
 * curve whose values run 0 -> 1): the curve's control values ARE the normalized y values.
 */
export function percentCurveToEase(t0: number, curve: SegmentCurve, t1: number): Ease | undefined {
  if (curve === 'linear') return undefined;
  if (curve === 'stepped') return 'step';
  const e = bezierToEase(t0, 0, curve, t1, 1);
  return e === 'linear' || e === null ? undefined : e;
}

// ----------------------------------------------------------------------------- Rev2D -> Spine

/** Convert a normalized cubic-bezier ease to absolute Spine control points for (t0, v0) -> (t1, v1). */
export function easeBezierToSpine(e: readonly [number, number, number, number], t0: number, v0: number, t1: number, v1: number): Bezier {
  const dt = t1 - t0;
  const dv = v1 - v0;
  return [t0 + e[0] * dt, v0 + e[1] * dv, t0 + e[2] * dt, v0 + e[3] * dv];
}

/**
 * Exact absolute bezier of a cubic Hermite segment (Rev2D 'smooth' ease with tangents m0, m1 in value
 * units per second): control points at one third of the segment along each tangent.
 */
export function hermiteToBezier(t0: number, v0: number, m0: number, t1: number, v1: number, m1: number): Bezier {
  const dt = t1 - t0;
  return [t0 + dt / 3, v0 + (m0 * dt) / 3, t1 - dt / 3, v1 - (m1 * dt) / 3];
}

/**
 * Cubic-bezier ease of the polynomial a1·u + a2·u² + a3·u³ with a1 + a2 + a3 = 1 (so it ends at 1):
 * x(u) = u with controls at 1/3 and 2/3, y controls are the Bernstein coefficients (a3 only fixes the end).
 */
function polyBezier(a1: number, a2: number): [number, number, number, number] {
  return [1 / 3, a1 / 3, 2 / 3, (2 * a1) / 3 + a2 / 3];
}

const BACK_C1 = 1.70158;

/**
 * Cubic-bezier forms of Rev2D's named eases. `exact` ones are polynomials of degree <= 3 (so the
 * bezier reproduces them exactly); the others are close fits (see namedEaseBezier for the error).
 * outElastic, outBounce and smooth have no single-bezier form here ('smooth' converts exactly with
 * hermiteToBezier once its tangents are known).
 */
const NAMED_BEZIERS: Partial<Record<string, { bezier: [number, number, number, number]; exact: boolean }>> = {
  linear: { bezier: [1 / 3, 1 / 3, 2 / 3, 2 / 3], exact: true },
  inQuad: { bezier: polyBezier(0, 1), exact: true }, // u²
  outQuad: { bezier: polyBezier(2, -1), exact: true }, // 2u − u²
  inCubic: { bezier: polyBezier(0, 0), exact: true }, // u³
  outCubic: { bezier: polyBezier(3, -3), exact: true }, // 3u − 3u² + u³
  inBack: { bezier: polyBezier(0, -BACK_C1), exact: true }, // c3·u³ − c1·u²
  outBack: { bezier: polyBezier(BACK_C1 + 3, -2 * BACK_C1 - 3), exact: true }, // 1 + c3·(u−1)³ + c1·(u−1)²
  inSine: { bezier: [0.12, 0, 0.39, 0], exact: false },
  outSine: { bezier: [0.61, 1, 0.88, 1], exact: false },
  inOutSine: { bezier: [0.37, 0, 0.63, 1], exact: false },
  inOutQuad: { bezier: [0.45, 0, 0.55, 1], exact: false },
  inOutCubic: { bezier: [0.65, 0, 0.35, 1], exact: false },
  inOutBack: { bezier: [0.68, -0.6, 0.32, 1.6], exact: false },
};

const errorCache = new Map<string, number>();

/**
 * Cubic-bezier form of a named Rev2D ease with its maximum deviation from the real ease (in units of
 * the segment's value span; 0 for exact forms). Null when there is none (outElastic, outBounce, step,
 * smooth).
 */
export function namedEaseBezier(name: string): { bezier: [number, number, number, number]; exact: boolean; maxError: number } | null {
  const entry = NAMED_BEZIERS[name];
  const ease = (EASINGS as Record<string, (t: number) => number>)[name];
  if (!entry || !ease) return null;
  let maxError = errorCache.get(name);
  if (maxError === undefined) {
    const fn = cubicBezier(...entry.bezier);
    maxError = 0;
    for (let i = 0; i <= 200; i++) maxError = Math.max(maxError, Math.abs(fn(i / 200) - ease(i / 200)));
    errorCache.set(name, maxError);
  }
  return { ...entry, maxError };
}

/**
 * Spine curve of a Rev2D ease on the segment (t0, v0) -> (t1, v1): undefined = linear (no curve
 * needed), 'stepped', absolute control points, or null when the ease has no bezier form within
 * `tolerance` value units (bake the segment by sampling). 'smooth' always returns null here (it needs
 * the neighbouring keys; use hermiteToBezier).
 */
export function easeToSpineCurve(
  ease: Ease | undefined,
  t0: number,
  v0: number,
  t1: number,
  v1: number,
  tolerance = 0,
): 'stepped' | Bezier | undefined | null {
  if (ease === undefined || ease === 'linear') return undefined;
  if (ease === 'step') return 'stepped';
  if (Array.isArray(ease)) return easeBezierToSpine(ease as [number, number, number, number], t0, v0, t1, v1);
  const named = namedEaseBezier(ease as string);
  if (!named) return null;
  if (!named.exact && named.maxError * Math.abs(v1 - v0) > tolerance) return null;
  return easeBezierToSpine(named.bezier, t0, v0, t1, v1);
}
