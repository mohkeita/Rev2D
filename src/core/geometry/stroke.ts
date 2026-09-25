/**
 * Stroke tessellation: outlines -> triangle mesh.
 *
 * Each segment becomes a quad spanning the stroke band; joins fill the wedge left open on the outer
 * side of each turn (round fan, miter with limit 4 falling back to bevel, or bevel). Open polylines
 * get butt caps. Overlapping triangles on the inner side of turns are expected. All emitted triangles
 * are positively oriented.
 */
import type { Stroke } from '../types.js';
import { arcSegments, dedupe, extentOf, REL_EPS, signedArea, type Triangles } from './primitives.js';

export interface Contour {
  points: number[];
  /** Closed loops get a join at every vertex; open polylines get butt caps. */
  closed: boolean;
  /**
   * Side of the filled interior relative to the direction of travel: 1 = algebraic left (-dy, dx),
   * -1 = right. Omitted: derived from the sign of the (implicitly closed) outline's area.
   */
  interior?: 1 | -1;
}

export type StrokeStyle = Pick<Stroke, 'width' | 'join' | 'align'>;

/** SVG miter limit: miters longer than 4 × the stroke width become bevels. */
const MITER_LIMIT = 4;
/** Max deviation of round joins from a true arc (px). */
const JOIN_TOLERANCE = 0.1;
const MAX_JOIN_SEGMENTS = 64;
/** Turns smaller than this (rad) need no join. */
const MIN_TURN = 1e-9;

export function strokeContours(contours: readonly Contour[], style: StrokeStyle): Triangles {
  const out: Triangles = { positions: [], indices: [] };
  for (const contour of contours) strokeContour(contour, style, out);
  return out;
}

function strokeContour(contour: Contour, style: StrokeStyle, out: Triangles): void {
  const extent = extentOf(contour.points);
  const eps = REL_EPS * extent;
  const pts = dedupe(contour.points, contour.closed, eps);
  const n = pts.length >> 1;
  if (n < 2) return;
  const area = signedArea(pts);
  const side = contour.interior ?? (Math.abs(area) <= eps * extent ? 0 : Math.sign(area));
  const [lo, hi] = bandOffsets(style, side);

  const segments = contour.closed ? n : n - 1;
  const dirs = new Float64Array(2 * segments);
  for (let s = 0; s < segments; s++) {
    const a = 2 * s;
    const b = s === n - 1 ? 0 : a + 2;
    const dx = pts[b] - pts[a];
    const dy = pts[b + 1] - pts[a + 1];
    const len = Math.hypot(dx, dy);
    const ux = dx / len;
    const uy = dy / len;
    dirs[2 * s] = ux;
    dirs[2 * s + 1] = uy;
    // Quad between the offset lines lo and hi along the left normal (-uy, ux).
    const base = out.positions.length >> 1;
    out.positions.push(
      pts[a] - uy * lo, pts[a + 1] + ux * lo,
      pts[b] - uy * lo, pts[b + 1] + ux * lo,
      pts[b] - uy * hi, pts[b + 1] + ux * hi,
      pts[a] - uy * hi, pts[a + 1] + ux * hi,
    );
    out.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  const first = contour.closed ? 0 : 1;
  const last = contour.closed ? n - 1 : n - 2;
  for (let v = first; v <= last; v++) {
    const inSeg = v === 0 ? segments - 1 : v - 1;
    emitJoin(out, pts[2 * v], pts[2 * v + 1], dirs[2 * inSeg], dirs[2 * inSeg + 1], dirs[2 * v], dirs[2 * v + 1], lo, hi, style.join);
  }
}

/**
 * Offsets [lo, hi] of the stroke band along the left normal. `side` is where the interior lies
 * (1 left, -1 right, 0 unknown: inside/outside then fall back to center).
 */
function bandOffsets(style: StrokeStyle, side: number): [number, number] {
  const w = style.width;
  if (style.align === 'center' || side === 0) return [-w / 2, w / 2];
  const towardInterior = style.align === 'inside' ? side : -side;
  return towardInterior > 0 ? [0, w] : [-w, 0];
}

/** Fill the wedge on the outer side of the turn at (px, py) from direction d0 to d1. */
function emitJoin(
  out: Triangles,
  px: number,
  py: number,
  d0x: number,
  d0y: number,
  d1x: number,
  d1y: number,
  lo: number,
  hi: number,
  join: StrokeStyle['join'],
): void {
  const theta = Math.atan2(d0x * d1y - d0y * d1x, d0x * d1x + d0y * d1y);
  if (Math.abs(theta) < MIN_TURN) return;
  // A U-turn's bevel has no area (the segment quads already end flat); only round joins add a cap.
  if (join !== 'round' && Math.PI - Math.abs(theta) < MIN_TURN) return;
  // A positive turn opens a gap on the right (negative offsets), a negative turn on the left.
  const outer = theta > 0 ? -1 : 1;
  const r = outer > 0 ? hi : -lo;
  if (r <= 0) return;
  // Unit offset directions at the end of the incoming and the start of the outgoing segment.
  const ax = -outer * d0y;
  const ay = outer * d0x;
  const bx = -outer * d1y;
  const by = outer * d1x;
  const center = out.positions.length >> 1;
  out.positions.push(px, py, px + r * ax, py + r * ay);
  // Triangles (center, i, i+1) sweep with the turn; flip them for negative turns to stay positive.
  const fan = (i: number) => {
    if (theta > 0) out.indices.push(center, i, i + 1);
    else out.indices.push(center, i + 1, i);
  };
  if (join === 'round') {
    const k = arcSegments(r, theta, JOIN_TOLERANCE, MAX_JOIN_SEGMENTS);
    for (let i = 1; i <= k; i++) {
      const phi = (theta * i) / k;
      const c = Math.cos(phi);
      const s = Math.sin(phi);
      out.positions.push(px + r * (ax * c - ay * s), py + r * (ax * s + ay * c));
      fan(center + i);
    }
  } else if (join === 'miter' && 1 / Math.cos(theta / 2) <= MITER_LIMIT) {
    const m = r / (1 + ax * bx + ay * by);
    out.positions.push(px + m * (ax + bx), py + m * (ay + by), px + r * bx, py + r * by);
    fan(center + 1);
    fan(center + 2);
  } else {
    out.positions.push(px + r * bx, py + r * by);
    fan(center + 1);
  }
}
