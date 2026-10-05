/**
 * Key reduction for baked (sampled) Spine timelines. The samples are split into the fewest segments
 * (greedy, longest first) that reproduce every sample within a tolerance per channel, each segment
 * either linear or a cubic Bézier:
 * - 'channels' (bone, color timelines): one curve per channel, Spine 4 absolute control points;
 * - 'shared' (deform timelines): one percent curve for all channels, like Spine's deform keys.
 * Curves keep their control times at 1/3 and 2/3 of the segment, so the curve is a cubic polynomial in
 * time and fits by linear least squares. A fit is accepted only if it stays within the tolerance both
 * as an exact cubic (Rev2D importer, editor) and as the 10-segment polyline Spine runtimes evaluate,
 * and only if it stays within the value range of each pair of neighbouring samples between them (so it
 * cannot swing where no sample checks it).
 */

export interface Segment {
  /** Frame index where the segment starts (its key). */
  from: number;
  /** Frame index where it ends (the next key). */
  to: number;
  /**
   * null = linear. 'channels': [cy1, cy2] per channel (absolute values), 'shared': [y1, y2] (percent).
   * 'stepped': the start value holds until the next key (a step change of the source between the two
   * frames, see fitSegments' `jumps`).
   */
  curve: number[] | 'stepped' | null;
}

export type CurveMode = 'channels' | 'shared';

/** Consecutive failed fits before a short segment stops growing. */
const MAX_MISSES = 3;
/** Segment length (frames) from which the end is searched exponentially instead of frame by frame. */
const GALLOP_FROM = 6;

/** A step interval changes a channel this many times faster than its neighbouring intervals. */
const JUMP_RATE = 8;

const B = (t: number): [number, number, number, number] => {
  const m = 1 - t;
  return [m * m * m, 3 * m * m * t, 3 * m * t * t, t * t * t];
};

/** Spine runtimes evaluate a Bézier as the polyline through u = 0, 0.1, ..., 1 (x(u) is linear here). */
function polyline(a: number, c1: number, c2: number, b: number, t: number): number {
  const u = Math.min(9.999999, Math.max(0, t * 10));
  const k = Math.floor(u);
  const f = u - k;
  const v0 = bez(a, c1, c2, b, k / 10);
  const v1 = bez(a, c1, c2, b, (k + 1) / 10);
  return v0 + (v1 - v0) * f;
}

function bez(a: number, c1: number, c2: number, b: number, t: number): number {
  const w = B(t);
  return w[0] * a + w[1] * c1 + w[2] * c2 + w[3] * b;
}

/** Least squares [c1, c2] of v(t) = a·B0 + c1·B1 + c2·B2 + b·B3 through (ts, vs). */
function fitCubic(ts: number[], vs: number[], a: number, b: number): [number, number] {
  let s11 = 0;
  let s12 = 0;
  let s22 = 0;
  let r1 = 0;
  let r2 = 0;
  for (let k = 0; k < ts.length; k++) {
    const w = B(ts[k]);
    const r = vs[k] - w[0] * a - w[3] * b;
    s11 += w[1] * w[1];
    s12 += w[1] * w[2];
    s22 += w[2] * w[2];
    r1 += w[1] * r;
    r2 += w[2] * r;
  }
  const det = s11 * s22 - s12 * s12;
  if (Math.abs(det) > 1e-12 * Math.max(1, s11 * s22)) return [(r1 * s22 - r2 * s12) / det, (s11 * r2 - s12 * r1) / det];
  // One interior sample: a symmetric control pair.
  const c = s11 + 2 * s12 + s22 > 1e-12 ? (r1 + r2) / (s11 + 2 * s12 + s22) : (a + b) / 2;
  return [c, c];
}

class Fitter {
  /** Per-channel tolerance as an array (hot loops). */
  private readonly tols: Float64Array;

  constructor(
    readonly times: ArrayLike<number>,
    readonly values: ArrayLike<number>,
    readonly dims: number,
    readonly tol: (d: number) => number,
    readonly mode: CurveMode,
    readonly curves: boolean,
  ) {
    this.tols = Float64Array.from({ length: dims }, (_, d) => tol(d));
  }

  private v(k: number, d: number): number {
    return this.values[k * this.dims + d];
  }

  /** Linear segment within tolerance? */
  linear(i: number, j: number): boolean {
    const { times, dims, values, tols } = this;
    const span = times[j] - times[i];
    const io = i * dims;
    const jo = j * dims;
    for (let k = i + 1; k < j; k++) {
      const f = span > 0 ? (times[k] - times[i]) / span : 0;
      const ko = k * dims;
      for (let d = 0; d < dims; d++) {
        const a = values[io + d];
        if (Math.abs(a + (values[jo + d] - a) * f - values[ko + d]) > tols[d]) return false;
      }
    }
    return true;
  }

  /**
   * Half way between each neighbouring sample pair the curve stays within that pair's value range
   * (± tolerance) and within three times the tolerance of their linear interpolation: the sampler adds a
   * sample wherever the motion leaves that interpolation, so a curve that bows away from it between
   * sparse samples would be off where nothing checks it.
   */
  private between(i: number, j: number, d: number, curve: (u: number) => number): boolean {
    const mids = this.midpoints(i, j);
    for (let k = i; k < j; k++) if (!this.near(k, d, curve(mids[k - i]))) return false;
    return true;
  }

  /** Normalized segment positions (0..1) half way between neighbouring samples of segment i..j. */
  private midpoints(i: number, j: number): number[] {
    const { times } = this;
    const span = times[j] - times[i];
    const out: number[] = [];
    for (let k = i; k < j; k++) out.push(((times[k] + times[k + 1]) / 2 - times[i]) / span);
    return out;
  }

  /** Whether value v half way between samples k and k + 1 is acceptable for channel d (see between). */
  private near(k: number, d: number, v: number): boolean {
    const tol = this.tol(d);
    const a = this.v(k, d);
    const b = this.v(k + 1, d);
    if (v < Math.min(a, b) - tol || v > Math.max(a, b) + tol) return false;
    return Math.abs(v - (a + b) / 2) <= 3 * tol;
  }

  /** Curve of the segment, or null when none fits. */
  curve(i: number, j: number): number[] | null {
    if (!this.curves || j - i < 2) return null;
    const { times, dims } = this;
    const span = times[j] - times[i];
    if (!(span > 0)) return null;
    const ts: number[] = [];
    for (let k = i + 1; k < j; k++) ts.push((times[k] - times[i]) / span);
    if (this.mode === 'channels') {
      const out: number[] = [];
      for (let d = 0; d < dims; d++) {
        const a = this.v(i, d);
        const b = this.v(j, d);
        const vs = ts.map((_, n) => this.v(i + 1 + n, d));
        const [c1, c2] = fitCubic(ts, vs, a, b);
        const tol = this.tol(d);
        for (let n = 0; n < ts.length; n++) {
          if (Math.abs(bez(a, c1, c2, b, ts[n]) - vs[n]) > tol) return null;
          if (Math.abs(polyline(a, c1, c2, b, ts[n]) - vs[n]) > tol) return null;
        }
        if (!this.between(i, j, d, (u) => bez(a, c1, c2, b, u))) return null;
        out.push(c1, c2);
      }
      return out;
    }
    // Shared percent curve: progress of every intermediate frame along D = V_j - V_i.
    const { values, tols } = this;
    const io = i * dims;
    const jo = j * dims;
    const D = new Float64Array(dims);
    let dd = 0;
    for (let d = 0; d < dims; d++) {
      D[d] = values[jo + d] - values[io + d];
      dd += D[d] * D[d];
    }
    if (dd < 1e-18) return null;
    const ss = ts.map((_, n) => {
      const ko = (i + 1 + n) * dims;
      let s = 0;
      for (let d = 0; d < dims; d++) s += (values[ko + d] - values[io + d]) * D[d];
      return s / dd;
    });
    const [y1, y2] = fitCubic(ts, ss, 0, 1);
    for (let n = 0; n < ts.length; n++) {
      const ko = (i + 1 + n) * dims;
      const e = bez(0, y1, y2, 1, ts[n]);
      const p = polyline(0, y1, y2, 1, ts[n]);
      for (let d = 0; d < dims; d++) {
        const a = values[io + d];
        const want = values[ko + d];
        const tol = tols[d];
        if (Math.abs(a + e * D[d] - want) > tol || Math.abs(a + p * D[d] - want) > tol) return null;
      }
    }
    // Between the samples: the percent curve is shared, so evaluate it once per midpoint.
    const es = this.midpoints(i, j).map((u) => bez(0, y1, y2, 1, u));
    for (let k = i; k < j; k++) {
      const e = es[k - i];
      const ko = k * dims;
      const k1 = ko + dims;
      for (let d = 0; d < dims; d++) {
        const v = values[io + d] + e * D[d];
        const a = values[ko + d];
        const b = values[k1 + d];
        const tol = tols[d];
        if (v < Math.min(a, b) - tol || v > Math.max(a, b) + tol || Math.abs(v - (a + b) / 2) > 3 * tol) return null;
      }
    }
    return [y1, y2];
  }
}

/**
 * Segments covering all frames. `values` holds `dims` numbers per frame (frame-major); `tol` is the
 * largest accepted absolute error (one for all channels or one per channel). tol <= 0 keeps every
 * frame as a linear key. `curves: false` allows only linear segments. `jumps[k]`: the source changes
 * by a step between frames k and k + 1 (sampled just before and at the step); where the values
 * differ there, that interval becomes a 'stepped' segment instead of a ramp, and no segment spans it.
 */
export function fitSegments(
  times: ArrayLike<number>,
  values: ArrayLike<number>,
  dims: number,
  tol: number | ArrayLike<number>,
  mode: CurveMode,
  curves = true,
  jumps?: ArrayLike<boolean>,
): Segment[] {
  const n = times.length;
  const out: Segment[] = [];
  if (n < 2) return out;
  const all = typeof tol === 'number' && !(tol > 0);
  const tolOf = typeof tol === 'number' ? () => tol : (d: number) => tol[d];
  const f = new Fitter(times, values, dims, tolOf, mode, curves && !all);
  const v = (k: number, d: number) => values[k * dims + d];
  const rate = (k: number, d: number) => (k >= 0 && k + 1 < n && times[k + 1] > times[k] ? Math.abs(v(k + 1, d) - v(k, d)) / (times[k + 1] - times[k]) : 0);
  // A marked interval is a step for a channel that changes there beyond tolerance and much faster than
  // on either side (a hold, then the new value); channels in continuous motion keep their curves.
  const jump = (k: number) => {
    if (!jumps?.[k]) return false;
    for (let d = 0; d < dims; d++) {
      if (Math.abs(v(k + 1, d) - v(k, d)) <= Math.max(tolOf(d), 1e-12)) continue;
      if (rate(k, d) > JUMP_RATE * Math.max(rate(k - 1, d), rate(k + 1, d))) return true;
    }
    return false;
  };
  let i = 0;
  while (i < n - 1) {
    if (jump(i)) {
      out.push({ from: i, to: i + 1, curve: 'stepped' });
      i++;
      continue;
    }
    if (all) {
      out.push({ from: i, to: i + 1, curve: null });
      i++;
      continue;
    }
    // Segments never span a step: the furthest end is the first marked jump after i.
    let maxTo = i + 1;
    while (maxTo < n - 1 && !jump(maxTo)) maxTo++;
    let best: Segment = { from: i, to: i + 1, curve: null };
    const fit = (j: number): boolean => {
      if (f.linear(i, j)) {
        best = { from: i, to: j, curve: null };
        return true;
      }
      const c = f.curve(i, j);
      if (c) best = { from: i, to: j, curve: c };
      return !!c;
    };
    // Short segments one frame at a time: a fit with one interior sample is under-determined and may
    // fail where a few more samples succeed, so give up only after MAX_MISSES failures in a row.
    let misses = 0;
    let j = i + 2;
    for (; j <= maxTo && j - i <= GALLOP_FROM; j++) {
      if (fit(j)) misses = 0;
      else if (++misses >= MAX_MISSES) break;
    }
    // Longer segments: grow the end exponentially while fits succeed, then bisect to the last one
    // that fits (log-many attempts instead of one per frame).
    if (misses === 0 && best.to === j - 1 && j <= maxTo) {
      let lo = best.to;
      let hi = -1;
      for (let step = 2; ; step *= 2) {
        const cand = Math.min(maxTo, lo + step);
        if (!fit(cand)) {
          hi = cand;
          break;
        }
        lo = cand;
        if (cand === maxTo) break;
      }
      if (hi > 0) {
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1;
          if (fit(mid)) lo = mid;
          else hi = mid;
        }
        // fit() leaves `best` at the last success only when that was the last call.
        if (best.to !== lo) fit(lo);
      }
    }
    out.push(best);
    i = best.to;
  }
  return out;
}

/** Kept frame indices of a segment list (every segment start plus the last end). */
export function segmentKeys(segments: readonly Segment[]): number[] {
  if (!segments.length) return [0];
  return [...segments.map((s) => s.from), segments[segments.length - 1].to];
}

/** Indices of the frames to keep for linear interpolation only (see fitSegments). */
export function reduceFrames(times: ArrayLike<number>, values: ArrayLike<number>, dims: number, tol: number | ArrayLike<number>): number[] {
  if (times.length <= 1) return times.length ? [0] : [];
  return segmentKeys(fitSegments(times, values, dims, tol, 'channels', false));
}
