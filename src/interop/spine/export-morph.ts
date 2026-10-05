/**
 * Shape morphs for the Spine exporter. Spine meshes have a fixed topology, while a Rev2D part whose
 * shape fields are bound or animated (path `d`, ellipse radii, polygon points, ...) is rebuilt from
 * scratch every frame and may change its vertex count. A MorphPlan maps a fixed set of points, given
 * in setup space for the part's REFERENCE shape, to where they belong for any other value of the
 * shape (still in setup space, before the part's bone / warp / skin deformation):
 *
 * - ellipse, image, rect without radius: the exact affine map between the two shapes;
 * - rect with a corner radius: a nine-slice map (corners keep their radius ratio, exact for the outline);
 * - polygon, mesh: the shape's own points as control points;
 * - path: control points sampled at FIXED curve parameters of every command (the same command
 *   structure is guaranteed by the format), so point k of every state is the same curve parameter.
 *
 * With control points, a point inside a control triangle (the setup triangulation of the reference
 * outline, or the mesh's own triangles) keeps its barycentric coordinates; a point outside keeps its
 * position relative to the nearest control edge (fraction along it, signed distance in px from it),
 * so margins around the outline (anti-aliasing, strokes) keep their width.
 */
import { DEG } from '../../core/math.js';
import { parsePath, pathArgCount } from '../../core/path.js';
import type { Shape, TextureInfo } from '../../core/types.js';
import { earClip } from '../../core/geometry/triangulate.js';

type ShapeOf<T extends Shape['type']> = Extract<Shape, { type: T }>;

export interface MorphPlan {
  /** Positions of the bound points for `shape` (same type and structure as the reference). */
  map(shape: Shape, out: Float64Array): void;
}

// ----------------------------------------------------------------------------- path sampling

interface SampledSubpath {
  points: number[];
  closed: boolean;
}

/** Walk the commands of a path, calling `seg` for every drawing command with a point function. */
function walkPath(
  d: string,
  seg: (cmdIndex: number, kind: 'line' | 'curve' | 'arc', at: (u: number) => [number, number], size: number) => void,
  move: (x: number, y: number) => void,
  close: () => void,
): void {
  const { commands, nums } = parsePath(d);
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  let cx = 0;
  let cy = 0;
  let prev: 'cubic' | 'quad' | null = null;
  let open = false;
  let k = 0;
  commands.forEach((cmd, ci) => {
    const up = cmd.toUpperCase();
    const ox = cmd === up ? 0 : x;
    const oy = cmd === up ? 0 : y;
    const a = k;
    k += pathArgCount(cmd);
    if (up === 'M') {
      x = sx = ox + nums[a];
      y = sy = oy + nums[a + 1];
      move(x, y);
      open = true;
      prev = null;
      return;
    }
    if (up === 'Z') {
      close();
      open = false;
      x = sx;
      y = sy;
      prev = null;
      return;
    }
    if (!open) {
      move(x, y);
      open = true;
    }
    const x0 = x;
    const y0 = y;
    let curve: 'cubic' | 'quad' | null = null;
    switch (up) {
      case 'L':
      case 'H':
      case 'V': {
        const x1 = up === 'V' ? x : ox + nums[a];
        const y1 = up === 'H' ? y : up === 'V' ? oy + nums[a] : oy + nums[a + 1];
        seg(ci, 'line', (u) => [x0 + (x1 - x0) * u, y0 + (y1 - y0) * u], Math.hypot(x1 - x0, y1 - y0));
        x = x1;
        y = y1;
        break;
      }
      case 'C':
      case 'S': {
        let i = a;
        let c1x = x0;
        let c1y = y0;
        if (up === 'C') {
          c1x = ox + nums[i++];
          c1y = oy + nums[i++];
        } else if (prev === 'cubic') {
          c1x = 2 * x0 - cx;
          c1y = 2 * y0 - cy;
        }
        const c2x = ox + nums[i];
        const c2y = oy + nums[i + 1];
        const x1 = ox + nums[i + 2];
        const y1 = oy + nums[i + 3];
        const len = Math.hypot(c1x - x0, c1y - y0) + Math.hypot(c2x - c1x, c2y - c1y) + Math.hypot(x1 - c2x, y1 - c2y);
        seg(ci, 'curve', (u) => cubic(x0, y0, c1x, c1y, c2x, c2y, x1, y1, u), len);
        cx = c2x;
        cy = c2y;
        x = x1;
        y = y1;
        curve = 'cubic';
        break;
      }
      case 'Q':
      case 'T': {
        let i = a;
        let qx = x0;
        let qy = y0;
        if (up === 'Q') {
          qx = ox + nums[i++];
          qy = oy + nums[i++];
        } else if (prev === 'quad') {
          qx = 2 * x0 - cx;
          qy = 2 * y0 - cy;
        }
        const x1 = ox + nums[i];
        const y1 = oy + nums[i + 1];
        const len = Math.hypot(qx - x0, qy - y0) + Math.hypot(x1 - qx, y1 - qy);
        seg(ci, 'curve', (u) => {
          const m = 1 - u;
          return [m * m * x0 + 2 * m * u * qx + u * u * x1, m * m * y0 + 2 * m * u * qy + u * u * y1];
        }, len);
        cx = qx;
        cy = qy;
        x = x1;
        y = y1;
        curve = 'quad';
        break;
      }
      case 'A': {
        const x1 = ox + nums[a + 5];
        const y1 = oy + nums[a + 6];
        const arc = arcFunction(x0, y0, nums[a], nums[a + 1], nums[a + 2], nums[a + 3], nums[a + 4], x1, y1);
        seg(ci, arc ? 'arc' : 'line', arc?.at ?? ((u) => [x0 + (x1 - x0) * u, y0 + (y1 - y0) * u]), arc?.length ?? Math.hypot(x1 - x0, y1 - y0));
        x = x1;
        y = y1;
        break;
      }
    }
    prev = curve;
  });
}

function cubic(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, u: number): [number, number] {
  const m = 1 - u;
  const a = m * m * m;
  const b = 3 * m * m * u;
  const c = 3 * m * u * u;
  const d = u * u * u;
  return [a * x0 + b * x1 + c * x2 + d * x3, a * y0 + b * y1 + c * y2 + d * y3];
}

/** SVG elliptical arc (endpoint parameterization -> center parameterization); null = draw a line. */
function arcFunction(
  x1: number,
  y1: number,
  rxIn: number,
  ryIn: number,
  phiDeg: number,
  large: number,
  sweep: number,
  x2: number,
  y2: number,
): { at: (u: number) => [number, number]; length: number } | null {
  if (x1 === x2 && y1 === y2) return null;
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0) return null;
  const phi = phiDeg * DEG;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx2 = (x1 - x2) / 2;
  const dy2 = (y1 - y2) / 2;
  const x1p = cos * dx2 + sin * dy2;
  const y1p = -sin * dx2 + cos * dy2;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coef = (large >= 0.5 !== sweep >= 0.5 ? 1 : -1) * Math.sqrt(Math.max(0, den > 0 ? num / den : 0));
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (sweep < 0.5 && dt > 0) dt -= 2 * Math.PI;
  else if (sweep >= 0.5 && dt < 0) dt += 2 * Math.PI;
  return {
    at: (u) => {
      if (u >= 1) return [x2, y2];
      const th = t1 + dt * u;
      const ex = rx * Math.cos(th);
      const ey = ry * Math.sin(th);
      return [cx + ex * cos - ey * sin, cy + ex * sin + ey * cos];
    },
    length: Math.abs(dt) * Math.max(rx, ry),
  };
}

/** Samples per drawing command of a path, from its geometry (at least what `flattenPath` needs visually). */
function commandSampleCounts(d: string): Map<number, number> {
  const out = new Map<number, number>();
  walkPath(
    d,
    (ci, kind, _at, size) => {
      let n = 1;
      if (kind === 'curve') n = Math.min(48, Math.max(4, Math.ceil(size / 3)));
      else if (kind === 'arc') n = Math.min(96, Math.max(6, Math.ceil(size / 3)));
      out.set(ci, n);
    },
    () => {},
    () => {},
  );
  return out;
}

/** Sample a path with `counts` uniform parameter steps per drawing command (same structure => same point count). */
function samplePath(d: string, counts: Map<number, number>): SampledSubpath[] {
  const subs: SampledSubpath[] = [];
  let cur: SampledSubpath | null = null;
  walkPath(
    d,
    (ci, _kind, at) => {
      const n = counts.get(ci) ?? 1;
      for (let i = 1; i <= n; i++) {
        const [px, py] = at(i / n);
        cur!.points.push(px, py);
      }
    },
    (x, y) => {
      cur = { points: [x, y], closed: false };
      subs.push(cur);
    },
    () => {
      if (cur) cur.closed = true;
      cur = null;
    },
  );
  return subs;
}

// ----------------------------------------------------------------------------- control structures

type Binding =
  | { kind: 'tri'; i0: number; i1: number; i2: number; b0: number; b1: number; b2: number }
  | { kind: 'edge'; a: number; b: number; s: number; d: number }
  | { kind: 'fixed'; x: number; y: number };

interface Control {
  /** Reference control points (flat). */
  points: Float64Array;
  /** Control triangles (indices into points). */
  triangles: number[];
  /** Control edges as index pairs (outline edges, used for points outside every triangle). */
  edges: number[];
}

/** Bind reference points to a control structure. */
function bindPoints(ctl: Control, pts: ArrayLike<number>): Binding[] {
  const P = ctl.points;
  const out: Binding[] = [];
  const tris: Array<{ i0: number; i1: number; i2: number; det: number }> = [];
  for (let t = 0; t + 2 < ctl.triangles.length; t += 3) {
    const i0 = ctl.triangles[t];
    const i1 = ctl.triangles[t + 1];
    const i2 = ctl.triangles[t + 2];
    const det = (P[2 * i1] - P[2 * i0]) * (P[2 * i2 + 1] - P[2 * i0 + 1]) - (P[2 * i2] - P[2 * i0]) * (P[2 * i1 + 1] - P[2 * i0 + 1]);
    if (Math.abs(det) > 1e-9) tris.push({ i0, i1, i2, det });
  }
  for (let p = 0; p + 1 < pts.length; p += 2) {
    const x = pts[p];
    const y = pts[p + 1];
    let best: Binding | null = null;
    let bestMin = -1e-7;
    for (const tr of tris) {
      const ax = P[2 * tr.i0];
      const ay = P[2 * tr.i0 + 1];
      const b1 = ((x - ax) * (P[2 * tr.i2 + 1] - ay) - (P[2 * tr.i2] - ax) * (y - ay)) / tr.det;
      const b2 = ((P[2 * tr.i1] - ax) * (y - ay) - (x - ax) * (P[2 * tr.i1 + 1] - ay)) / tr.det;
      const b0 = 1 - b1 - b2;
      const m = Math.min(b0, b1, b2);
      if (m >= bestMin) {
        bestMin = m;
        best = { kind: 'tri', i0: tr.i0, i1: tr.i1, i2: tr.i2, b0, b1, b2 };
      }
    }
    if (!best) {
      let bestD = Infinity;
      for (let e = 0; e + 1 < ctl.edges.length; e += 2) {
        const a = ctl.edges[e];
        const b = ctl.edges[e + 1];
        const ax = P[2 * a];
        const ay = P[2 * a + 1];
        const ex = P[2 * b] - ax;
        const ey = P[2 * b + 1] - ay;
        const l2 = ex * ex + ey * ey;
        if (l2 < 1e-18) continue;
        const s = ((x - ax) * ex + (y - ay) * ey) / l2;
        const sc = Math.min(1, Math.max(0, s));
        const dist = Math.hypot(x - ax - sc * ex, y - ay - sc * ey);
        if (dist < bestD - 1e-12) {
          bestD = dist;
          best = { kind: 'edge', a, b, s, d: (ex * (y - ay) - ey * (x - ax)) / Math.sqrt(l2) };
        }
      }
    }
    out.push(best ?? { kind: 'fixed', x, y });
  }
  return out;
}

function evalBindings(binds: Binding[], Q: ArrayLike<number>, out: Float64Array): void {
  binds.forEach((b, k) => {
    let x: number;
    let y: number;
    if (b.kind === 'tri') {
      x = b.b0 * Q[2 * b.i0] + b.b1 * Q[2 * b.i1] + b.b2 * Q[2 * b.i2];
      y = b.b0 * Q[2 * b.i0 + 1] + b.b1 * Q[2 * b.i1 + 1] + b.b2 * Q[2 * b.i2 + 1];
    } else if (b.kind === 'edge') {
      const ax = Q[2 * b.a];
      const ay = Q[2 * b.a + 1];
      const ex = Q[2 * b.b] - ax;
      const ey = Q[2 * b.b + 1] - ay;
      const l = Math.hypot(ex, ey);
      x = ax + b.s * ex;
      y = ay + b.s * ey;
      if (l > 1e-12) {
        x += (-ey / l) * b.d;
        y += (ex / l) * b.d;
      }
    } else {
      x = b.x;
      y = b.y;
    }
    out[2 * k] = x;
    out[2 * k + 1] = y;
  });
}

/** Ear-clip a closed loop of control points (indices into `P`), dropping consecutive duplicates. */
function triangulateLoop(P: ArrayLike<number>, loop: number[], out: number[]): void {
  const idx: number[] = [];
  for (const i of loop) {
    const last = idx[idx.length - 1];
    if (last !== undefined && Math.abs(P[2 * i] - P[2 * last]) < 1e-9 && Math.abs(P[2 * i + 1] - P[2 * last + 1]) < 1e-9) continue;
    idx.push(i);
  }
  while (idx.length > 1 && Math.abs(P[2 * idx[0]] - P[2 * idx[idx.length - 1]]) < 1e-9 && Math.abs(P[2 * idx[0] + 1] - P[2 * idx[idx.length - 1] + 1]) < 1e-9) idx.pop();
  if (idx.length < 3) return;
  let area = 0;
  for (let i = 0; i < idx.length; i++) {
    const a = idx[i];
    const b = idx[(i + 1) % idx.length];
    area += P[2 * a] * P[2 * b + 1] - P[2 * b] * P[2 * a + 1];
  }
  if (Math.abs(area) < 1e-9) return;
  if (area < 0) idx.reverse();
  const ring: number[] = [];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const i of idx) {
    ring.push(P[2 * i], P[2 * i + 1]);
    minX = Math.min(minX, P[2 * i]);
    maxX = Math.max(maxX, P[2 * i]);
    minY = Math.min(minY, P[2 * i + 1]);
    maxY = Math.max(maxY, P[2 * i + 1]);
  }
  const eps = 1e-9 * Math.max(1, maxX - minX, maxY - minY);
  const { triangles } = earClip(ring, eps);
  for (const t of triangles) out.push(idx[t]);
}

class ControlMorph implements MorphPlan {
  private readonly binds: Binding[];
  constructor(
    ctl: Control,
    points: ArrayLike<number>,
    private readonly controlOf: (shape: Shape) => ArrayLike<number> | null,
  ) {
    this.binds = bindPoints(ctl, points);
  }
  map(shape: Shape, out: Float64Array): void {
    const Q = this.controlOf(shape);
    if (!Q) {
      // Degenerate state (e.g. an unparsable path): collapse onto the fixed fallbacks.
      this.binds.forEach((b, k) => {
        out[2 * k] = b.kind === 'fixed' ? b.x : 0;
        out[2 * k + 1] = b.kind === 'fixed' ? b.y : 0;
      });
      return;
    }
    evalBindings(this.binds, Q, out);
  }
}

class AffineMorph implements MorphPlan {
  constructor(
    private readonly points: ArrayLike<number>,
    private readonly frame: (shape: Shape) => [number, number, number, number, number, number],
    private readonly invRef: [number, number, number, number, number, number],
  ) {}
  map(shape: Shape, out: Float64Array): void {
    const f = this.frame(shape);
    const r = this.invRef;
    // m = f · r
    const a = f[0] * r[0] + f[2] * r[1];
    const b = f[1] * r[0] + f[3] * r[1];
    const c = f[0] * r[2] + f[2] * r[3];
    const d = f[1] * r[2] + f[3] * r[3];
    const e = f[0] * r[4] + f[2] * r[5] + f[4];
    const g = f[1] * r[4] + f[3] * r[5] + f[5];
    const p = this.points;
    for (let i = 0; i + 1 < p.length; i += 2) {
      out[i] = a * p[i] + c * p[i + 1] + e;
      out[i + 1] = b * p[i] + d * p[i + 1] + g;
    }
  }
}

function invert6(m: [number, number, number, number, number, number]): [number, number, number, number, number, number] | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return null;
  const id = 1 / det;
  return [m[3] * id, -m[1] * id, -m[2] * id, m[0] * id, (m[2] * m[5] - m[3] * m[4]) * id, (m[1] * m[4] - m[0] * m[5]) * id];
}

function ellipseFrame(s: ShapeOf<'ellipse'>): [number, number, number, number, number, number] {
  const r = (s.rotation ?? 0) * DEG;
  const c = Math.cos(r);
  const n = Math.sin(r);
  return [c * s.rx, n * s.rx, -n * s.ry, c * s.ry, s.cx, s.cy];
}

function imageSize(s: ShapeOf<'image'>, textures: Record<string, TextureInfo>): [number, number] {
  let w = s.w;
  let h = s.h;
  if (w === undefined || h === undefined) {
    const t = textures[s.texture];
    w ??= s.crop ? s.crop[2] : (t?.width ?? 1);
    h ??= s.crop ? s.crop[3] : (t?.height ?? 1);
  }
  return [w, h];
}

/** Nine-slice map of one axis: breakpoints of the reference and of the target. */
function sliceAxis(v: number, a: number[], b: number[]): number {
  if (v <= a[0]) return b[0] + (v - a[0]);
  if (v >= a[3]) return b[3] + (v - a[3]);
  for (let k = 0; k < 3; k++) {
    if (v <= a[k + 1]) {
      const span = a[k + 1] - a[k];
      return span > 1e-12 ? b[k] + ((v - a[k]) / span) * (b[k + 1] - b[k]) : b[k];
    }
  }
  return b[3];
}

function rectBreaks(s: ShapeOf<'rect'>): { xs: number[]; ys: number[] } {
  let { x, y, w, h } = s;
  if (w < 0) {
    x += w;
    w = -w;
  }
  if (h < 0) {
    y += h;
    h = -h;
  }
  const r = Math.min(Math.max(0, s.radius ?? 0), Math.min(w, h) / 2);
  return { xs: [x, x + r, x + w - r, x + w], ys: [y, y + r, y + h - r, y + h] };
}

class RectMorph implements MorphPlan {
  private readonly ref: { xs: number[]; ys: number[] };
  constructor(
    ref: ShapeOf<'rect'>,
    private readonly points: ArrayLike<number>,
  ) {
    this.ref = rectBreaks(ref);
  }
  map(shape: Shape, out: Float64Array): void {
    const t = rectBreaks(shape as ShapeOf<'rect'>);
    const p = this.points;
    for (let i = 0; i + 1 < p.length; i += 2) {
      out[i] = sliceAxis(p[i], this.ref.xs, t.xs);
      out[i + 1] = sliceAxis(p[i + 1], this.ref.ys, t.ys);
    }
  }
}

/**
 * Plan the morph of `points` (setup space, reference shape `ref`) over the shape states `states`
 * (used to size path sampling so that every state is sampled finely). Returns null when the shape type
 * cannot morph (nothing to do).
 */
export function planMorph(ref: Shape, states: readonly Shape[], points: ArrayLike<number>, textures: Record<string, TextureInfo>): MorphPlan | null {
  switch (ref.type) {
    case 'ellipse': {
      const inv = invert6(ellipseFrame(ref));
      if (!inv) return null;
      return new AffineMorph(points, (s) => ellipseFrame(s as ShapeOf<'ellipse'>), inv);
    }
    case 'image': {
      const frame = (s: ShapeOf<'image'>): [number, number, number, number, number, number] => {
        const [w, h] = imageSize(s, textures);
        return [w, 0, 0, h, s.x, s.y];
      };
      const inv = invert6(frame(ref));
      if (!inv) return null;
      return new AffineMorph(points, (s) => frame(s as ShapeOf<'image'>), inv);
    }
    case 'rect':
      return new RectMorph(ref, points);
    case 'polygon': {
      const n = ref.points.length >> 1;
      const tris: number[] = [];
      triangulateLoop(ref.points, Array.from({ length: n }, (_, i) => i), tris);
      const edges: number[] = [];
      for (let i = 0; i < n; i++) edges.push(i, (i + 1) % n);
      const ctl: Control = { points: Float64Array.from(ref.points), triangles: tris, edges };
      return new ControlMorph(ctl, points, (s) => {
        const pts = (s as ShapeOf<'polygon'>).points;
        return pts.length === ref.points.length ? pts : null;
      });
    }
    case 'mesh': {
      const edges: number[] = [];
      const uses = new Map<string, number>();
      const tri = ref.triangles;
      for (let t = 0; t + 2 < tri.length; t += 3) {
        for (const [a, b] of [
          [tri[t], tri[t + 1]],
          [tri[t + 1], tri[t + 2]],
          [tri[t + 2], tri[t]],
        ]) {
          const key = a < b ? `${a},${b}` : `${b},${a}`;
          uses.set(key, (uses.get(key) ?? 0) + 1);
        }
      }
      for (const [key, n] of uses) {
        if (n !== 1) continue;
        const [a, b] = key.split(',').map(Number);
        edges.push(a, b);
      }
      const ctl: Control = { points: Float64Array.from(ref.vertices), triangles: tri.slice(), edges };
      return new ControlMorph(ctl, points, (s) => {
        const v = (s as ShapeOf<'mesh'>).vertices;
        return v.length === ref.vertices.length ? v : null;
      });
    }
    case 'path': {
      // Samples per command: the finest any state needs.
      const counts = new Map<number, number>();
      for (const s of [ref, ...states]) {
        let c: Map<number, number>;
        try {
          c = commandSampleCounts((s as ShapeOf<'path'>).d);
        } catch {
          continue;
        }
        for (const [k, n] of c) counts.set(k, Math.max(counts.get(k) ?? 1, n));
      }
      let refSubs: SampledSubpath[];
      try {
        refSubs = samplePath(ref.d, counts);
      } catch {
        return null;
      }
      const flat: number[] = [];
      const tris: number[] = [];
      const edges: number[] = [];
      for (const sub of refSubs) {
        const base = flat.length >> 1;
        const n = sub.points.length >> 1;
        flat.push(...sub.points);
        const loop = Array.from({ length: n }, (_, i) => base + i);
        triangulateLoop(flat, loop, tris);
        for (let i = 0; i + 1 < n; i++) edges.push(base + i, base + i + 1);
        if (n > 2) edges.push(base + n - 1, base);
      }
      const total = flat.length;
      const ctl: Control = { points: Float64Array.from(flat), triangles: tris, edges };
      return new ControlMorph(ctl, points, (s) => {
        let subs: SampledSubpath[];
        try {
          subs = samplePath((s as ShapeOf<'path'>).d, counts);
        } catch {
          return null;
        }
        const q: number[] = [];
        for (const sub of subs) q.push(...sub.points);
        return q.length === total ? q : null;
      });
    }
  }
}

// ----------------------------------------------------------------------------- areas

/** Filled area of a shape (used to pick the reference state of a morphing part). */
export function shapeArea(s: Shape, textures: Record<string, TextureInfo>): number {
  switch (s.type) {
    case 'ellipse':
      return Math.PI * Math.abs(s.rx * s.ry);
    case 'rect':
      return Math.abs(s.w * s.h);
    case 'image': {
      const [w, h] = imageSize(s, textures);
      return Math.abs(w * h);
    }
    case 'polygon':
      return Math.abs(loopArea(s.points));
    case 'mesh': {
      let a = 0;
      const v = s.vertices;
      for (let t = 0; t + 2 < s.triangles.length; t += 3) {
        const i = s.triangles[t] * 2;
        const j = s.triangles[t + 1] * 2;
        const k = s.triangles[t + 2] * 2;
        a += Math.abs((v[j] - v[i]) * (v[k + 1] - v[i + 1]) - (v[k] - v[i]) * (v[j + 1] - v[i + 1])) / 2;
      }
      return a;
    }
    case 'path': {
      let subs: SampledSubpath[];
      try {
        subs = samplePath(s.d, commandSampleCounts(s.d));
      } catch {
        return 0;
      }
      return subs.reduce((sum, sub) => sum + Math.abs(loopArea(sub.points)), 0);
    }
  }
}

function loopArea(p: ArrayLike<number>): number {
  let a = 0;
  const n = p.length >> 1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += p[2 * i] * p[2 * j + 1] - p[2 * j] * p[2 * i + 1];
  }
  return a / 2;
}
