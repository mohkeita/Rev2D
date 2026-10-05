/**
 * Curve math shared by motion3 import and export.
 *
 * A curve is a start point plus contiguous pieces, mirroring motion3.json segments:
 *   linear   value interpolates linearly from (t0, v0) to (t1, v1)
 *   step     holds v0 on [t0, t1), v1 from t1 on          (motion3 "stepped", Rev2D "step")
 *   inverse  v1 on the whole segment (jumps at its start) (motion3 "inverse stepped")
 *   bezier   cubic Bézier through (t0, v0), controls, (t1, v1). `byTime` = the Bézier parameter is the
 *            normalized time (how the Cubism SDK evaluates files with Meta.AreBeziersRestricted = true,
 *            whose handle times are fixed at 1/3 and 2/3 of the segment); otherwise the curve is the true
 *            Bézier in the (time, value) plane (AreBeziersRestricted = false: the SDK solves time -> u).
 * Evaluation (evalCurve) follows the Cubism runtime: the first piece whose end time is AFTER t is used
 * (so at a boundary the later piece wins and a zero-length piece is a jump); before the first point
 * the first piece is clamped, after the last point the last value holds.
 *
 * Rev2D side: a key's ease shapes the segment to the next key (SPEC §6.1): linear/step map exactly,
 * `smooth` (Catmull-Rom Hermite) and the polynomial named eases (quad, cubic, back, bounce) are exact
 * cubic Béziers with handles at 1/3 and 2/3, cubic-bezier eases [x1, y1, x2, y2] with x in [0, 1] are
 * exact true Béziers, and the remaining named eases (sine, elastic) are fitted with Hermite pieces.
 */
import { easeFn } from '../../core/easing.js';
import type { Ease } from '../../core/types.js';

export type Piece =
  | { kind: 'linear' | 'step' | 'inverse'; t0: number; v0: number; t1: number; v1: number }
  | { kind: 'bezier'; t0: number; v0: number; t1: number; v1: number; c1t: number; c1v: number; c2t: number; c2v: number; byTime: boolean };

export interface Curve {
  /** First point (also the start of pieces[0] when there are pieces). */
  t: number;
  v: number;
  pieces: Piece[];
}

/** Minimum spacing of Rev2D keys we generate, and the delay of a jump (duplicate key times are invalid). */
export const JUMP = 0.001;

const THIRD = 1 / 3;

// ----------------------------------------------------------------------------- evaluation

function cubic(p0: number, p1: number, p2: number, p3: number, u: number): number {
  const w = 1 - u;
  return w * w * w * p0 + 3 * w * w * u * p1 + 3 * w * u * u * p2 + u * u * u * p3;
}

/** Bézier parameter at time t (clamped to [0, 1]). */
export function bezierU(p: Extract<Piece, { kind: 'bezier' }>, t: number): number {
  const dt = p.t1 - p.t0;
  if (!(dt > 0) || t <= p.t0) return 0;
  if (t >= p.t1) return 1;
  if (p.byTime) return (t - p.t0) / dt;
  // Smallest root of x(u) = t in [0, 1]: bracket by scanning (x may be non-monotonic), then bisect.
  const f = (u: number) => cubic(p.t0, p.c1t, p.c2t, p.t1, u) - t;
  let lo = 0;
  let hi = 1;
  const n = 32;
  for (let i = 1; i <= n; i++) {
    const u = i / n;
    if (f(u) >= 0) {
      lo = (i - 1) / n;
      hi = u;
      break;
    }
  }
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) < 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Value of a piece at t (Cubism segment evaluation; t before t0 clamps). */
export function evalPiece(p: Piece, t: number): number {
  switch (p.kind) {
    case 'linear': {
      const dt = p.t1 - p.t0;
      if (!(dt > 0)) return p.v1;
      const s = Math.max(0, (t - p.t0) / dt);
      return p.v0 + (p.v1 - p.v0) * s;
    }
    case 'step':
      return p.v0;
    case 'inverse':
      return p.v1;
    case 'bezier':
      return cubic(p.v0, p.c1v, p.c2v, p.v1, bezierU(p, t));
  }
}

/** Value of a curve at t, exactly as the Cubism runtime evaluates a motion3 curve. */
export function evalCurve(c: Curve, t: number): number {
  if (c.pieces.length === 0) return c.v;
  for (const p of c.pieces) if (p.t1 > t) return evalPiece(p, t);
  return c.pieces[c.pieces.length - 1].v1;
}

/** Value at the end of the curve (after its last point). */
export function lastValue(c: Curve): number {
  return c.pieces.length ? c.pieces[c.pieces.length - 1].v1 : c.v;
}

export function lastTime(c: Curve): number {
  return c.pieces.length ? c.pieces[c.pieces.length - 1].t1 : c.t;
}

// ----------------------------------------------------------------------------- splitting

type Bezier = Extract<Piece, { kind: 'bezier' }>;

function casteljau(p0: number, p1: number, p2: number, p3: number, u: number): [number[], number[]] {
  const a = p0 + (p1 - p0) * u;
  const b = p1 + (p2 - p1) * u;
  const c = p2 + (p3 - p2) * u;
  const d = a + (b - a) * u;
  const e = b + (c - b) * u;
  const m = d + (e - d) * u;
  return [
    [p0, a, d, m],
    [m, e, c, p3],
  ];
}

/** Split a Bézier piece at parameter u (exact). */
export function splitBezierAtU(p: Bezier, u: number): [Bezier, Bezier] {
  const [lv, rv] = casteljau(p.v0, p.c1v, p.c2v, p.v1, u);
  let lt: number[];
  let rt: number[];
  if (p.byTime) {
    // The time parameterization is linear, so both halves keep handles at 1/3 and 2/3.
    const tm = p.t0 + (p.t1 - p.t0) * u;
    lt = [p.t0, p.t0 + (tm - p.t0) * THIRD, p.t0 + (tm - p.t0) * 2 * THIRD, tm];
    rt = [tm, tm + (p.t1 - tm) * THIRD, tm + (p.t1 - tm) * 2 * THIRD, p.t1];
  } else {
    [lt, rt] = casteljau(p.t0, p.c1t, p.c2t, p.t1, u);
  }
  const make = (t: number[], v: number[]): Bezier => ({ kind: 'bezier', t0: t[0], v0: v[0], c1t: t[1], c1v: v[1], c2t: t[2], c2v: v[2], t1: t[3], v1: v[3], byTime: p.byTime });
  return [make(lt, lv), make(rt, rv)];
}

/** Split a piece at time t0 < t < t1 into two pieces with the same values (exact). */
export function splitPiece(p: Piece, t: number): [Piece, Piece] {
  switch (p.kind) {
    case 'linear': {
      const vm = evalPiece(p, t);
      return [
        { kind: 'linear', t0: p.t0, v0: p.v0, t1: t, v1: vm },
        { kind: 'linear', t0: t, v0: vm, t1: p.t1, v1: p.v1 },
      ];
    }
    case 'step':
      return [
        { kind: 'linear', t0: p.t0, v0: p.v0, t1: t, v1: p.v0 },
        { kind: 'step', t0: t, v0: p.v0, t1: p.t1, v1: p.v1 },
      ];
    case 'inverse':
      return [
        { kind: 'inverse', t0: p.t0, v0: p.v0, t1: t, v1: p.v1 },
        { kind: 'linear', t0: t, v0: p.v1, t1: p.t1, v1: p.v1 },
      ];
    case 'bezier':
      return splitBezierAtU(p, bezierU(p, t));
  }
}

function shiftPiece(p: Piece, dt: number): Piece {
  const out = { ...p, t0: p.t0 + dt, t1: p.t1 + dt };
  if (out.kind === 'bezier') {
    out.c1t += dt;
    out.c2t += dt;
  }
  return out;
}

export function shiftCurve(c: Curve, dt: number): Curve {
  return { t: c.t + dt, v: c.v, pieces: c.pieces.map((p) => shiftPiece(p, dt)) };
}

function constant(t0: number, t1: number, v: number): Piece {
  return { kind: 'linear', t0, v0: v, t1, v1: v };
}

/** The curve restricted to [a, b] (pieces cut exactly at a and b; values outside hold as before). */
export function clipCurve(c: Curve, a: number, b: number): Curve {
  const out: Piece[] = [];
  for (let p of c.pieces) {
    if (p.t1 <= a) continue;
    if (p.t0 >= b) break;
    if (p.t0 < a) p = splitPiece(p, a)[1];
    if (p.t1 > b) {
      out.push(splitPiece(p, b)[0]);
      break;
    }
    out.push(p);
  }
  if (out.length) return { t: out[0].t0, v: out[0].v0, pieces: out };
  const v = c.t >= b ? c.v : evalCurve(c, Math.min(b, Math.max(a, c.t)));
  return { t: Math.max(a, Math.min(b, c.t)), v, pieces: [] };
}

/** Hold the first / last value out to a and b with constant pieces. */
export function extendCurve(c: Curve, a: number, b: number): Curve {
  const pieces = [...c.pieces];
  const start = c.t;
  if (start > a) pieces.unshift(constant(a, start, c.v));
  const end = lastTime(c);
  if (end < b) pieces.push(constant(end, b, lastValue(c)));
  return pieces.length ? { t: pieces[0].t0, v: pieces[0].v0, pieces } : c;
}

/**
 * A looping curve on [0, d] shifted by `offset` with wrap-around: the result at t is the input at
 * (t - offset) mod d. The seam may be a jump (the encoder writes a zero-length stepped segment).
 */
export function rotateLoop(c: Curve, d: number, offset: number): Curve {
  const o = ((offset % d) + d) % d;
  if (o < 1e-9 || d - o < 1e-9) return c;
  const full = extendCurve(clipCurve(c, 0, d), 0, d);
  const cut = d - o;
  const head = clipCurve(full, 0, cut); // plays at [o, d]
  const tail = clipCurve(full, cut, d); // plays at [0, o]
  const pieces = [...shiftCurve(tail, -cut).pieces, ...shiftCurve(head, o).pieces];
  return { t: 0, v: pieces.length ? pieces[0].v0 : c.v, pieces };
}

// ----------------------------------------------------------------------------- motion3 segments

export type DecodeResult = { ok: true; curve: Curve } | { ok: false; error: string; at: number };

/** Decode a motion3 "Segments" array. `restricted` = Meta.AreBeziersRestricted. */
export function decodeSegments(s: unknown, restricted: boolean): DecodeResult {
  if (!Array.isArray(s)) return { ok: false, error: 'Segments is not an array', at: -1 };
  for (let i = 0; i < s.length; i++) {
    if (typeof s[i] !== 'number' || !Number.isFinite(s[i])) return { ok: false, error: `Segments[${i}] is not a finite number`, at: i };
  }
  const a = s as number[];
  if (a.length < 2) return { ok: false, error: 'Segments needs at least the first point (time, value)', at: 0 };
  const curve: Curve = { t: a[0], v: a[1], pieces: [] };
  let t = a[0];
  let v = a[1];
  let i = 2;
  while (i < a.length) {
    const type = a[i];
    const need = type === 1 ? 6 : 2;
    if (type !== 0 && type !== 1 && type !== 2 && type !== 3) return { ok: false, error: `unknown segment type ${type} at Segments[${i}] (0 linear, 1 bezier, 2 stepped, 3 inverse stepped)`, at: i };
    if (i + need >= a.length) return { ok: false, error: `segment at Segments[${i}] is cut short (type ${type} needs ${need} numbers)`, at: i };
    const t1 = type === 1 ? a[i + 5] : a[i + 1];
    const v1 = type === 1 ? a[i + 6] : a[i + 2];
    if (t1 < t) return { ok: false, error: `segment at Segments[${i}] ends at t=${t1}, before its start t=${t}`, at: i };
    if (type === 1) {
      curve.pieces.push({ kind: 'bezier', t0: t, v0: v, c1t: a[i + 1], c1v: a[i + 2], c2t: a[i + 3], c2v: a[i + 4], t1, v1, byTime: restricted });
    } else {
      curve.pieces.push({ kind: type === 0 ? 'linear' : type === 2 ? 'step' : 'inverse', t0: t, v0: v, t1, v1 });
    }
    t = t1;
    v = v1;
    i += need + 1;
  }
  return { ok: true, curve };
}

export interface Encoded {
  segments: number[];
  segmentCount: number;
  /** First point 1 + linear 1 + bezier 3 + stepped 1 + inverse stepped 1 per segment. */
  pointCount: number;
  /** Every Bézier segment has its handles at 1/3 and 2/3 of its time span (or no Béziers at all). */
  restrictedOk: boolean;
  bezierCount: number;
}

/** Tolerance (fraction of the segment span) for "handle at 1/3 / 2/3". */
const THIRDS_TOL = 1e-6;

export function handlesAtThirds(p: Bezier, relTol = THIRDS_TOL): boolean {
  if (p.byTime) return true;
  const dt = p.t1 - p.t0;
  const tol = relTol * Math.max(dt, 1e-9);
  return Math.abs(p.c1t - (p.t0 + dt * THIRD)) <= tol && Math.abs(p.c2t - (p.t0 + dt * 2 * THIRD)) <= tol;
}

/**
 * Encode a curve as motion3 Segments. A curve without pieces becomes a constant linear segment over
 * [0, duration] (single-point curves are not handled by the Cubism runtime). A value jump between
 * pieces becomes a zero-length stepped segment.
 */
export function encodeSegments(c: Curve, duration: number, digits = 6): Encoded {
  const r = (n: number) => {
    const x = Number(n.toFixed(digits));
    return Object.is(x, -0) ? 0 : x;
  };
  const pieces = c.pieces.length ? c.pieces : [constant(Math.min(0, c.t), Math.max(duration, c.t, 1e-3), c.v)];
  const seg: number[] = [r(pieces[0].t0), r(pieces[0].v0)];
  let points = 1;
  let count = 0;
  let restrictedOk = true;
  let bezierCount = 0;
  let prevV = pieces[0].v0;
  for (const p of pieces) {
    if (Math.abs(p.v0 - prevV) > 1e-12 * Math.max(1, Math.abs(prevV))) {
      seg.push(2, r(p.t0), r(p.v0));
      points++;
      count++;
    }
    if (p.kind === 'bezier') {
      bezierCount++;
      const thirds = handlesAtThirds(p);
      if (!thirds) restrictedOk = false;
      const dt = p.t1 - p.t0;
      const c1t = p.byTime ? p.t0 + dt * THIRD : p.c1t;
      const c2t = p.byTime ? p.t0 + dt * 2 * THIRD : p.c2t;
      seg.push(1, r(c1t), r(p.c1v), r(c2t), r(p.c2v), r(p.t1), r(p.v1));
      points += 3;
    } else {
      seg.push(p.kind === 'linear' ? 0 : p.kind === 'step' ? 2 : 3, r(p.t1), r(p.v1));
      points++;
    }
    count++;
    prevV = p.v1;
  }
  return { segments: seg, segmentCount: count, pointCount: points, restrictedOk, bezierCount };
}

// ----------------------------------------------------------------------------- Rev2D keys -> pieces

type NamedEase = Exclude<Ease, readonly number[]>;

interface EaseModel {
  f: (s: number) => number;
  /** Derivative; omitted = numeric. */
  df?: (s: number) => number;
  /** Points where the ease changes formula (pieces are split there). */
  kinks?: number[];
  /** Every piece between kinks is a polynomial of degree <= 3, so one Hermite cubic is exact. */
  exact: boolean;
}

const c1 = 1.70158;
const c2 = c1 * 1.525;
const c3 = c1 + 1;
const HALF_PI = Math.PI / 2;
const BOUNCE_N = 7.5625;
const BOUNCE_D = 2.75;

const EASE_MODELS: Partial<Record<NamedEase, EaseModel>> = {
  inQuad: { f: (s) => s * s, df: (s) => 2 * s, exact: true },
  outQuad: { f: (s) => 1 - (1 - s) * (1 - s), df: (s) => 2 * (1 - s), exact: true },
  inOutQuad: { f: (s) => (s < 0.5 ? 2 * s * s : 1 - Math.pow(-2 * s + 2, 2) / 2), df: (s) => (s < 0.5 ? 4 * s : 4 * (1 - s)), kinks: [0.5], exact: true },
  inCubic: { f: (s) => s * s * s, df: (s) => 3 * s * s, exact: true },
  outCubic: { f: (s) => 1 - Math.pow(1 - s, 3), df: (s) => 3 * (1 - s) * (1 - s), exact: true },
  inOutCubic: { f: (s) => (s < 0.5 ? 4 * s * s * s : 1 - Math.pow(-2 * s + 2, 3) / 2), df: (s) => (s < 0.5 ? 12 * s * s : 3 * Math.pow(2 - 2 * s, 2)), kinks: [0.5], exact: true },
  inBack: { f: (s) => c3 * s * s * s - c1 * s * s, df: (s) => 3 * c3 * s * s - 2 * c1 * s, exact: true },
  outBack: { f: (s) => 1 + c3 * Math.pow(s - 1, 3) + c1 * Math.pow(s - 1, 2), df: (s) => 3 * c3 * (s - 1) * (s - 1) + 2 * c1 * (s - 1), exact: true },
  inOutBack: {
    f: (s) => (s < 0.5 ? (Math.pow(2 * s, 2) * ((c2 + 1) * 2 * s - c2)) / 2 : (Math.pow(2 * s - 2, 2) * ((c2 + 1) * (s * 2 - 2) + c2) + 2) / 2),
    df: (s) => {
      if (s < 0.5) return 12 * (c2 + 1) * s * s - 4 * c2 * s;
      const w = 2 * s - 2;
      return 3 * (c2 + 1) * w * w + 2 * c2 * w;
    },
    kinks: [0.5],
    exact: true,
  },
  outBounce: {
    f: (s) => {
      if (s < 1 / BOUNCE_D) return BOUNCE_N * s * s;
      if (s < 2 / BOUNCE_D) return BOUNCE_N * (s - 1.5 / BOUNCE_D) ** 2 + 0.75;
      if (s < 2.5 / BOUNCE_D) return BOUNCE_N * (s - 2.25 / BOUNCE_D) ** 2 + 0.9375;
      return BOUNCE_N * (s - 2.625 / BOUNCE_D) ** 2 + 0.984375;
    },
    df: (s) => {
      if (s < 1 / BOUNCE_D) return 2 * BOUNCE_N * s;
      if (s < 2 / BOUNCE_D) return 2 * BOUNCE_N * (s - 1.5 / BOUNCE_D);
      if (s < 2.5 / BOUNCE_D) return 2 * BOUNCE_N * (s - 2.25 / BOUNCE_D);
      return 2 * BOUNCE_N * (s - 2.625 / BOUNCE_D);
    },
    kinks: [1 / BOUNCE_D, 2 / BOUNCE_D, 2.5 / BOUNCE_D],
    exact: true,
  },
  inSine: { f: (s) => 1 - Math.cos(s * HALF_PI), df: (s) => HALF_PI * Math.sin(s * HALF_PI), exact: false },
  outSine: { f: (s) => Math.sin(s * HALF_PI), df: (s) => HALF_PI * Math.cos(s * HALF_PI), exact: false },
  inOutSine: { f: (s) => -(Math.cos(Math.PI * s) - 1) / 2, df: (s) => HALF_PI * Math.sin(Math.PI * s), exact: false },
  outElastic: { f: (s) => easeFn('outElastic')(s), exact: false },
};

/** How a segment's ease was converted (for the report). */
export interface EaseConversion {
  ease: string;
  /** Number of Bézier pieces used for the segment. */
  pieces: number;
  /** Maximum deviation from the Rev2D curve in value units (0 when exact). */
  maxError: number;
  exact: boolean;
}

/**
 * Slope of f at the left (or right) end of [a, b] from two points strictly inside the interval, so a
 * value special-cased at an end (outElastic at 1) or a kink just outside does not distort it.
 */
function numericSlope(f: (s: number) => number, a: number, b: number, atRight: boolean): number {
  const h = (b - a) * 1e-4;
  return atRight ? (f(b - h) - f(b - 2 * h)) / h : (f(a + 2 * h) - f(a + h)) / h;
}

/** Linear pieces through n + 1 samples of ease f between (t0, v0) and (t1, v1); max error from midpoints. */
function sampleEase(f: (s: number) => number, t0: number, v0: number, t1: number, v1: number, n: number): { pieces: Piece[]; maxError: number } {
  const dt = t1 - t0;
  const dv = v1 - v0;
  const value = (k: number) => (k === 0 ? v0 : k === n ? v1 : v0 + dv * f(k / n));
  const pieces: Piece[] = [];
  let maxError = 0;
  for (let k = 0; k < n; k++) {
    const a = value(k);
    const b = value(k + 1);
    pieces.push({ kind: 'linear', t0: t0 + (dt * k) / n, v0: a, t1: t0 + (dt * (k + 1)) / n, v1: b });
    for (let m = 1; m < 4; m++) {
      const s = (k + m / 4) / n;
      maxError = Math.max(maxError, Math.abs(v0 + dv * f(s) - (a + ((b - a) * m) / 4)));
    }
  }
  return { pieces, maxError };
}

/**
 * Hermite cubic pieces (handles at 1/3, 2/3) approximating ease f from (t0, v0) to (t1, v1): split at
 * kinks, then bisect until the maximum error is at most `tol` (value units) or 64 pieces per interval.
 */
function fitEase(model: EaseModel, t0: number, v0: number, t1: number, v1: number, tol: number): { pieces: Piece[]; maxError: number } {
  const dt = t1 - t0;
  const dv = v1 - v0;
  const f = model.f;
  const df = (s: number, a: number, b: number) => (model.df ? model.df(s) : numericSlope(f, a, b, s > (a + b) / 2));
  const pieces: Piece[] = [];
  let maxError = 0;
  const bounds = [0, ...(model.kinks ?? []), 1];
  const emit = (a: number, b: number, depth: number): void => {
    const fa = a === 0 ? 0 : f(a);
    const fb = b === 1 ? 1 : f(b);
    // One-sided derivatives inside [a, b] (kinks have different slopes on each side).
    const da = df(a + (b - a) * 1e-12, a, b);
    const db = df(b - (b - a) * 1e-12, a, b);
    const w = b - a;
    const h1 = fa + (da * w) / 3;
    const h2 = fb - (db * w) / 3;
    let err = 0;
    if (!model.exact) {
      for (let i = 1; i < 16; i++) {
        const u = i / 16;
        const approx = cubic(fa, h1, h2, fb, u);
        err = Math.max(err, Math.abs(approx - f(a + w * u)) * Math.abs(dv));
      }
    }
    if (err > tol && depth < 6) {
      const m = (a + b) / 2;
      emit(a, m, depth + 1);
      emit(m, b, depth + 1);
      return;
    }
    maxError = Math.max(maxError, err);
    pieces.push({
      kind: 'bezier',
      t0: t0 + dt * a,
      v0: v0 + dv * fa,
      t1: t0 + dt * b,
      v1: v0 + dv * fb,
      c1t: t0 + dt * (a + w * THIRD),
      c1v: v0 + dv * h1,
      c2t: t0 + dt * (a + w * 2 * THIRD),
      c2v: v0 + dv * h2,
      byTime: true,
    });
  };
  for (let i = 0; i + 1 < bounds.length; i++) emit(bounds[i], bounds[i + 1], 0);
  // Exact end values.
  pieces[0] = { ...pieces[0], v0 } as Piece;
  pieces[pieces.length - 1] = { ...pieces[pieces.length - 1], v1 } as Piece;
  return { pieces, maxError };
}

export interface KeyIn {
  t: number;
  v: number;
  ease: Ease;
}

/**
 * Pieces of a Rev2D numeric track between its first and last key. `tangents` are the key tangents of
 * `smooth` segments (core/rig/curves keyTangents). `tol` = allowed error of fitted eases in value units
 * per unit of the segment's value change (e.g. 0.001 = 0.1 %).
 */
export function keysToCurve(keys: KeyIn[], tangents: Array<number | number[]> | null, tol: number, onEase: (i: number, c: EaseConversion) => void): Curve {
  const curve: Curve = { t: keys[0].t, v: keys[0].v, pieces: [] };
  for (let i = 0; i + 1 < keys.length; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    const dt = b.t - a.t;
    const dv = b.v - a.v;
    const ease = a.ease;
    if (!(dt > 0)) {
      curve.pieces.push({ kind: 'linear', t0: a.t, v0: a.v, t1: b.t, v1: b.v });
      continue;
    }
    if (ease === 'linear' || (dv === 0 && ease !== 'smooth' && ease !== 'step')) {
      // A segment between equal values is constant whatever its ease (except smooth, which can bulge).
      curve.pieces.push({ kind: 'linear', t0: a.t, v0: a.v, t1: b.t, v1: b.v });
    } else if (ease === 'step') {
      curve.pieces.push({ kind: 'step', t0: a.t, v0: a.v, t1: b.t, v1: b.v });
    } else if (ease === 'smooth') {
      const ma = (tangents?.[i] as number) ?? 0;
      const mb = (tangents?.[i + 1] as number) ?? 0;
      curve.pieces.push({ kind: 'bezier', t0: a.t, v0: a.v, t1: b.t, v1: b.v, c1t: a.t + dt * THIRD, c1v: a.v + (ma * dt) / 3, c2t: a.t + dt * 2 * THIRD, c2v: b.v - (mb * dt) / 3, byTime: true });
      onEase(i, { ease: 'smooth', pieces: 1, maxError: 0, exact: true });
    } else if (Array.isArray(ease)) {
      const [x1, y1, x2, y2] = ease as readonly number[];
      if (x1 >= 0 && x1 <= 1 && x2 >= 0 && x2 <= 1) {
        const thirds = Math.abs(x1 - THIRD) < 1e-3 && Math.abs(x2 - 2 * THIRD) < 1e-3;
        curve.pieces.push({
          kind: 'bezier',
          t0: a.t,
          v0: a.v,
          t1: b.t,
          v1: b.v,
          c1t: a.t + dt * (thirds ? THIRD : x1),
          c1v: a.v + dv * y1,
          c2t: a.t + dt * (thirds ? 2 * THIRD : x2),
          c2v: a.v + dv * y2,
          byTime: thirds,
        });
        // Handles written as 0.3333 / 0.6667 are snapped to exact thirds (a deviation of ~1e-4 of the change).
        const err = thirds && (x1 !== THIRD || x2 !== 2 * THIRD) ? maxBezierDeviation(ease as readonly number[], Math.abs(dv)) : 0;
        onEase(i, { ease: 'cubic-bezier', pieces: 1, maxError: err, exact: err === 0 });
      } else {
        // Not a CSS timing function (time handles outside 0..1): sampled like Rev2D evaluates it, 60 per second.
        const n = Math.max(8, Math.ceil(dt * 60));
        const fit = sampleEase(easeFn(ease), a.t, a.v, b.t, b.v, n);
        curve.pieces.push(...fit.pieces);
        onEase(i, { ease: 'cubic-bezier (x outside 0..1)', pieces: fit.pieces.length, maxError: fit.maxError, exact: false });
      }
    } else {
      const model = EASE_MODELS[ease];
      if (!model) {
        curve.pieces.push({ kind: 'linear', t0: a.t, v0: a.v, t1: b.t, v1: b.v });
        onEase(i, { ease, pieces: 1, maxError: Infinity, exact: false });
        continue;
      }
      const fit = fitEase(model, a.t, a.v, b.t, b.v, tol * Math.abs(dv));
      curve.pieces.push(...fit.pieces);
      onEase(i, { ease, pieces: fit.pieces.length, maxError: fit.maxError, exact: model.exact });
    }
  }
  return curve;
}

/** Max deviation between the CSS cubic-bezier ease and the same handles evaluated with x snapped to thirds. */
function maxBezierDeviation(ease: readonly number[], span: number): number {
  const fn = easeFn(ease as unknown as Ease);
  let err = 0;
  for (let i = 1; i < 32; i++) {
    const s = i / 32;
    err = Math.max(err, Math.abs(fn(s) - cubic(0, ease[1], ease[3], 1, s)));
  }
  return err * span;
}

// ----------------------------------------------------------------------------- pieces -> Rev2D keys

export interface RawKey {
  t: number;
  v: number;
  ease?: Ease;
}

export interface KeysResult {
  keys: RawKey[];
  /** Keys added at value extrema of flat Bézier segments (exact). */
  splitKeys: number;
  /** Segments sampled into linear keys (non-monotonic Bézier time handles). */
  sampledSegments: number;
  /** Jumps (inverse stepped segments, value discontinuities) delayed by JUMP seconds. */
  jumps: number;
}

const ALMOST = 1e-9;

/** Rev2D ease for a Bézier piece, 'split' when its end values are (nearly) equal, 'sample' when its time handles leave the segment. */
function bezierEase(p: Bezier): Ease | 'split' | 'sample' {
  const dt = p.t1 - p.t0;
  const dv = p.v1 - p.v0;
  const x1 = p.byTime ? THIRD : (p.c1t - p.t0) / dt;
  const x2 = p.byTime ? 2 * THIRD : (p.c2t - p.t0) / dt;
  if (!(x1 >= -ALMOST && x1 <= 1 + ALMOST && x2 >= -ALMOST && x2 <= 1 + ALMOST)) return 'sample';
  const span = Math.max(Math.abs(p.c1v - p.v0), Math.abs(p.c2v - p.v0), Math.abs(p.c1v - p.v1), Math.abs(p.c2v - p.v1), Math.abs(dv));
  if (span <= 1e-12 * Math.max(1, Math.abs(p.v0))) return 'linear';
  if (Math.abs(dv) < 1e-6 * span) return 'split';
  const y1 = (p.c1v - p.v0) / dv;
  const y2 = (p.c2v - p.v0) / dv;
  if (Math.abs(y1) > 1e3 || Math.abs(y2) > 1e3) return 'split';
  const cx1 = Math.min(1, Math.max(0, x1));
  const cx2 = Math.min(1, Math.max(0, x2));
  if (Math.abs(y1 - cx1) < ALMOST && Math.abs(y2 - cx2) < ALMOST) return 'linear';
  return [cx1, y1, cx2, y2];
}

/** Parameters in (0, 1) where the value of a Bézier piece has a local extremum. */
function valueExtrema(p: Bezier): number[] {
  const a = p.v1 - 3 * p.c2v + 3 * p.c1v - p.v0;
  const b = 2 * (p.c2v - 2 * p.c1v + p.v0);
  const c = p.c1v - p.v0;
  const roots: number[] = [];
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) roots.push(-c / b);
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      roots.push((-b - sq) / (2 * a), (-b + sq) / (2 * a));
    }
  }
  return roots.filter((u) => u > 1e-6 && u < 1 - 1e-6).sort((x, y) => x - y);
}

function bezierTime(p: Bezier, u: number): number {
  return p.byTime ? p.t0 + (p.t1 - p.t0) * u : cubic(p.t0, p.c1t, p.c2t, p.t1, u);
}

/**
 * Rev2D keys for a curve (times strictly increasing, at least JUMP apart). Before the first key the
 * first value holds, after the last the last value, like the Cubism runtime. `fps` sets the sampling
 * rate of segments that cannot be represented by an ease.
 */
export function curveToKeys(c: Curve, fps: number): KeysResult {
  const res: KeysResult = { keys: [{ t: c.t, v: c.v }], splitKeys: 0, sampledSegments: 0, jumps: 0 };
  const keys = res.keys;
  const lastKey = () => keys[keys.length - 1];
  const setEase = (ease: Ease) => {
    if (ease === 'linear') delete lastKey().ease;
    else lastKey().ease = ease;
  };
  const jumpTo = (t: number, v: number) => {
    if (keys.length === 1 && Math.abs(t - keys[0].t) < 1e-12) {
      // A jump at the very first point: the Cubism runtime already returns the later value there.
      keys[0].v = v;
      return;
    }
    setEase('step');
    keys.push({ t, v });
    res.jumps++;
  };
  const addBezier = (p: Bezier, depth: number): void => {
    const ease = bezierEase(p);
    if (ease === 'sample' || (ease === 'split' && depth >= 4)) {
      res.sampledSegments++;
      const n = Math.max(4, Math.ceil((p.t1 - p.t0) * fps));
      for (let k = 1; k <= n; k++) {
        const t = p.t0 + ((p.t1 - p.t0) * k) / n;
        keys.push({ t, v: k === n ? p.v1 : evalPiece(p, t) });
      }
      return;
    }
    if (ease === 'split') {
      const dt = p.t1 - p.t0;
      let us = valueExtrema(p).filter((u) => {
        const t = bezierTime(p, u);
        return t - p.t0 > 2 * JUMP && p.t1 - t > 2 * JUMP;
      });
      if (!us.length) us = dt > 4 * JUMP ? [0.5] : [];
      if (!us.length) {
        keys.push({ t: p.t1, v: p.v1 });
        return;
      }
      let rest = p;
      let consumed = 0;
      for (const u of us) {
        const local = (u - consumed) / (1 - consumed);
        const [left, right] = splitBezierAtU(rest, local);
        addBezier(left, depth + 1);
        res.splitKeys++;
        rest = right;
        consumed = u;
      }
      addBezier(rest, depth + 1);
      return;
    }
    setEase(ease);
    keys.push({ t: p.t1, v: p.v1 });
  };

  for (const p of c.pieces) {
    const last = lastKey();
    if (Math.abs(p.v0 - last.v) > 1e-9 * Math.max(1, Math.abs(last.v))) jumpTo(p.t0, p.v0);
    const dt = p.t1 - p.t0;
    if (!(dt > 0)) {
      // Zero-length segment: a jump to its end value.
      if (Math.abs(p.v1 - lastKey().v) > 1e-9 * Math.max(1, Math.abs(p.v1))) jumpTo(p.t1, p.v1);
      continue;
    }
    switch (p.kind) {
      case 'linear':
        setEase('linear');
        keys.push({ t: p.t1, v: p.v1 });
        break;
      case 'step':
        setEase('step');
        keys.push({ t: p.t1, v: p.v1 });
        break;
      case 'inverse':
        if (Math.abs(p.v1 - p.v0) > 1e-12) jumpTo(p.t0, p.v1);
        keys.push({ t: p.t1, v: p.v1 });
        break;
      case 'bezier':
        addBezier(p, 0);
        break;
    }
  }
  // Strictly increasing times, at least JUMP apart: a key too close to the previous one moves forward
  // (a jump happens JUMP s later); a key that repeats the previous value at the same time is dropped.
  const out: RawKey[] = [];
  for (const k of keys) {
    const prev = out[out.length - 1];
    if (prev && k.t < prev.t + JUMP - 1e-12) {
      if (Math.abs(k.v - prev.v) <= 1e-12 && (prev.ease === undefined || prev.ease === 'step')) {
        // Same point again: keep the later ease.
        if (k.ease === undefined) delete prev.ease;
        else prev.ease = k.ease;
        continue;
      }
      out.push({ ...k, t: prev.t + JUMP });
      continue;
    }
    out.push({ ...k });
  }
  res.keys = out;
  return res;
}
