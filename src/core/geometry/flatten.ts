/**
 * SVG path flattening: path data -> polylines (one per subpath) within a distance tolerance and a
 * maximum turn per segment.
 *
 * Supports M L H V C S Q T A Z, absolute and relative. Curves use Wang's formula (the number of
 * uniform parameter steps that keeps a Bézier within `tolerance` of its chords, adapted to each
 * curve's control polygon); arcs use the SVG endpoint -> center parameterization, including the
 * out-of-range radii scale-up rule. Both are then refined so that no segment turns more than about
 * MAX_SEGMENT_ANGLE (see pushCurve), so small curves, whose chords are within the distance tolerance
 * anyway, still look round when the part is scaled up or zoomed. Genuine cusps keep their sharp turn.
 */
import { DEG } from '../math.js';
import { parsePath, pathArgCount } from '../path.js';
import type { PathValue } from '../types.js';
import { GeometryError } from './errors.js';
import { arcSegments, dedupe, extentOf, REL_EPS } from './primitives.js';

export interface FlatSubpath {
  /** Flattened points [x0, y0, ...]; consecutive duplicates removed (and the closing point when `closed`). */
  points: number[];
  /** True when the subpath ended with Z/z. Open subpaths are still closed implicitly when filled. */
  closed: boolean;
}

/** Upper bound on the distance-tolerance steps of a single curve command (before angle refinement). */
const MAX_CURVE_SEGMENTS = 1024;
/** Largest turn per flattened curve / arc segment, in degrees (cusps excepted; see pushCurve). */
export const MAX_SEGMENT_ANGLE_DEG = 15;
/** MAX_SEGMENT_ANGLE_DEG in radians. */
export const MAX_SEGMENT_ANGLE = (MAX_SEGMENT_ANGLE_DEG * Math.PI) / 180;

/**
 * Flatten SVG path data. Subpaths with fewer than 2 distinct points are dropped.
 * Throws GeometryError on invalid path data or a non-positive tolerance.
 */
export function flattenPath(d: string, tolerance: number): FlatSubpath[] {
  if (!(tolerance > 0) || !Number.isFinite(tolerance)) {
    throw new GeometryError(`path tolerance must be a positive number, got ${tolerance}`);
  }
  let path: PathValue;
  try {
    path = parsePath(d);
  } catch (e) {
    throw new GeometryError(`invalid path data: ${(e as Error).message}`, { cause: e });
  }
  const { commands, nums } = path;
  if (!nums.every(Number.isFinite)) throw new GeometryError('invalid path data: numbers must be finite');

  const subpaths: FlatSubpath[] = [];
  let pts: number[] = [];
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  // Last control point of the previous curve, reflected by S/T.
  let ctrlX = 0;
  let ctrlY = 0;
  let prevCurve: 'cubic' | 'quad' | null = null;
  let k = 0;

  const flush = (closed: boolean) => {
    const clean = dedupe(pts, closed, REL_EPS * extentOf(pts));
    if (clean.length >= 4) subpaths.push({ points: clean, closed });
    pts = [];
  };

  for (const cmd of commands) {
    const up = cmd.toUpperCase();
    const ox = cmd === up ? 0 : x;
    const oy = cmd === up ? 0 : y;
    const a = k;
    k += pathArgCount(cmd);
    if (up === 'M') {
      flush(false);
      x = startX = ox + nums[a];
      y = startY = oy + nums[a + 1];
      pts.push(x, y);
      prevCurve = null;
      continue;
    }
    if (up === 'Z') {
      flush(true);
      x = startX;
      y = startY;
      prevCurve = null;
      continue;
    }
    // A drawing command right after Z starts a new subpath at the previous subpath's start.
    if (pts.length === 0) pts.push(x, y);
    let curve: 'cubic' | 'quad' | null = null;
    switch (up) {
      case 'L':
        x = ox + nums[a];
        y = oy + nums[a + 1];
        pts.push(x, y);
        break;
      case 'H':
        x = ox + nums[a];
        pts.push(x, y);
        break;
      case 'V':
        y = oy + nums[a];
        pts.push(x, y);
        break;
      case 'C':
      case 'S': {
        let i = a;
        let c1x = x;
        let c1y = y;
        if (up === 'C') {
          c1x = ox + nums[i++];
          c1y = oy + nums[i++];
        } else if (prevCurve === 'cubic') {
          c1x = 2 * x - ctrlX;
          c1y = 2 * y - ctrlY;
        }
        ctrlX = ox + nums[i];
        ctrlY = oy + nums[i + 1];
        const ex = ox + nums[i + 2];
        const ey = oy + nums[i + 3];
        cubicTo(pts, x, y, c1x, c1y, ctrlX, ctrlY, ex, ey, tolerance);
        x = ex;
        y = ey;
        curve = 'cubic';
        break;
      }
      case 'Q':
      case 'T': {
        let i = a;
        if (up === 'Q') {
          ctrlX = ox + nums[i++];
          ctrlY = oy + nums[i++];
        } else if (prevCurve === 'quad') {
          ctrlX = 2 * x - ctrlX;
          ctrlY = 2 * y - ctrlY;
        } else {
          ctrlX = x;
          ctrlY = y;
        }
        const ex = ox + nums[i];
        const ey = oy + nums[i + 1];
        quadTo(pts, x, y, ctrlX, ctrlY, ex, ey, tolerance);
        x = ex;
        y = ey;
        curve = 'quad';
        break;
      }
      case 'A': {
        const ex = ox + nums[a + 5];
        const ey = oy + nums[a + 6];
        arcTo(pts, x, y, nums[a], nums[a + 1], nums[a + 2], nums[a + 3] !== 0, nums[a + 4] !== 0, ex, ey, tolerance);
        x = ex;
        y = ey;
        break;
      }
    }
    prevCurve = curve;
  }
  flush(false);
  return subpaths;
}

/** Wang's formula: uniform steps keeping a Bézier within `tol`, given degree·(degree-1)/8 · max |second difference|. */
function bezierSegments(scaledSecondDiff: number, tol: number): number {
  return Math.min(MAX_CURVE_SEGMENTS, Math.max(1, Math.ceil(Math.sqrt(scaledSecondDiff / tol))));
}

/** Most sub-steps one tolerance step is split into for MAX_SEGMENT_ANGLE. */
const MAX_REFINE = 64;
/** Bisection depth limit for sub-steps whose turn is concentrated (cusps turn 180° in no time). */
const MAX_BISECT = 6;
/**
 * A sub-step is bisected only when it turns more than MAX_SEGMENT_ANGLE by this factor, so the equal
 * split of a nearly uniform curve (e.g. a cubic quarter circle, 15.3° per sixth) is not doubled.
 */
const BISECT_SLACK = 1.1;

/** Unsigned angle (radians) between two directions; 0 when either is zero. */
function turnBetween(ax: number, ay: number, bx: number, by: number): number {
  if ((ax === 0 && ay === 0) || (bx === 0 && by === 0)) return 0;
  return Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by));
}

type CurveAt = (t: number, p: [number, number]) => void;

/**
 * Push the points of a curve `at(t)` for t in (0, 1], ending exactly at (ex, ey): `n` uniform steps
 * (from the distance tolerance), each split into ceil(turn / MAX_SEGMENT_ANGLE) equal sub-steps by the
 * turn of the curve's tangent across it, and sub-steps that still turn more than BISECT_SLACK times
 * that (curvature concentrated in one part of the step) bisected. Tangents are short central
 * differences, which also handles degenerate end derivatives (a control point on its endpoint).
 */
function pushCurve(out: number[], n: number, at: CurveAt, ex: number, ey: number): void {
  const p: [number, number] = [0, 0];
  const h = 1e-4 / n;
  const tangent = (t: number): [number, number] => {
    at(Math.max(0, t - h), p);
    const x = p[0];
    const y = p[1];
    at(Math.min(1, t + h), p);
    return [p[0] - x, p[1] - y];
  };
  const emit = (t: number) => {
    if (t >= 1) return; // the exact endpoint is pushed last
    at(t, p);
    out.push(p[0], p[1]);
  };
  /** Points of (t0, t1] given the tangents at both ends. */
  const refine = (t0: number, t1: number, d0: [number, number], d1: [number, number], depth: number): void => {
    if (depth < MAX_BISECT && turnBetween(d0[0], d0[1], d1[0], d1[1]) > MAX_SEGMENT_ANGLE * BISECT_SLACK) {
      const tm = (t0 + t1) / 2;
      const dm = tangent(tm);
      refine(t0, tm, d0, dm, depth + 1);
      refine(tm, t1, dm, d1, depth + 1);
    } else {
      emit(t1);
    }
  };
  let d0 = tangent(0);
  for (let i = 0; i < n; i++) {
    const t0 = i / n;
    const t1 = (i + 1) / n;
    const d1 = tangent(t1);
    const k = Math.min(MAX_REFINE, Math.max(1, Math.ceil(turnBetween(d0[0], d0[1], d1[0], d1[1]) / MAX_SEGMENT_ANGLE - 1e-9)));
    let a = t0;
    let da = d0;
    for (let j = 1; j <= k; j++) {
      const b = j === k ? t1 : t0 + ((t1 - t0) * j) / k;
      const db = j === k ? d1 : tangent(b);
      refine(a, b, da, db, 0);
      a = b;
      da = db;
    }
    d0 = d1;
  }
  out.push(ex, ey);
}

function cubicTo(
  out: number[],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
  tol: number,
): void {
  const dd = Math.max(Math.hypot(x0 - 2 * x1 + x2, y0 - 2 * y1 + y2), Math.hypot(x1 - 2 * x2 + x3, y1 - 2 * y2 + y3));
  const n = bezierSegments(0.75 * dd, tol);
  pushCurve(
    out,
    n,
    (t, p) => {
      const mt = 1 - t;
      const b0 = mt * mt * mt;
      const b1 = 3 * mt * mt * t;
      const b2 = 3 * mt * t * t;
      const b3 = t * t * t;
      p[0] = b0 * x0 + b1 * x1 + b2 * x2 + b3 * x3;
      p[1] = b0 * y0 + b1 * y1 + b2 * y2 + b3 * y3;
    },
    x3,
    y3,
  );
}

function quadTo(out: number[], x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, tol: number): void {
  const n = bezierSegments(0.25 * Math.hypot(x0 - 2 * x1 + x2, y0 - 2 * y1 + y2), tol);
  pushCurve(
    out,
    n,
    (t, p) => {
      const mt = 1 - t;
      p[0] = mt * mt * x0 + 2 * mt * t * x1 + t * t * x2;
      p[1] = mt * mt * y0 + 2 * mt * t * y1 + t * t * y2;
    },
    x2,
    y2,
  );
}

/** SVG elliptical arc (implementation notes F.6.5 / F.6.6). */
function arcTo(
  out: number[],
  x1: number,
  y1: number,
  rxIn: number,
  ryIn: number,
  rotationDeg: number,
  largeArc: boolean,
  sweep: boolean,
  x2: number,
  y2: number,
  tol: number,
): void {
  if (x1 === x2 && y1 === y2) return; // identical endpoints: the arc is omitted
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0) {
    out.push(x2, y2); // zero radius: straight line
    return;
  }
  const cos = Math.cos(rotationDeg * DEG);
  const sin = Math.sin(rotationDeg * DEG);
  const hx = (x1 - x2) / 2;
  const hy = (y1 - y2) / 2;
  const x1p = cos * hx + sin * hy;
  const y1p = -sin * hx + cos * hy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const rx2 = rx * rx;
  const ry2 = ry * ry;
  const den = rx2 * y1p * y1p + ry2 * x1p * x1p;
  let coef = Math.sqrt(Math.max(0, (rx2 * ry2 - den) / den));
  if (largeArc === sweep) coef = -coef;
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const ux = (x1p - cxp) / rx;
  const uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx;
  const vy = (-y1p - cyp) / ry;
  const theta1 = Math.atan2(uy, ux);
  let delta = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  else if (sweep && delta < 0) delta += 2 * Math.PI;
  // Parametric steps: the chord error is at most the larger radius times the unit-circle error. Circular
  // arcs turn evenly, so MAX_SEGMENT_ANGLE caps the step; elliptical ones are refined where they turn faster.
  const n = arcSegments(Math.max(rx, ry), delta, tol, MAX_CURVE_SEGMENTS, MAX_SEGMENT_ANGLE);
  pushCurve(
    out,
    n,
    (s, p) => {
      const t = theta1 + delta * s;
      const ex = rx * Math.cos(t);
      const ey = ry * Math.sin(t);
      p[0] = cos * ex - sin * ey + cx;
      p[1] = sin * ex + cos * ey + cy;
    },
    x2,
    y2,
  );
}
