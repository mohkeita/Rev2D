/**
 * Inputs the geometry compiler rejects although they are schema-valid, checked up front so that a
 * model validation accepts can always be built into a Rig:
 *   - `detail` so fine that refinement would exceed MAX_DETAIL_VERTICES for an outline
 *     (the triangulator's estimate: perimeter/detail + area/(detail²·√3/2), see geometry/triangulate.ts);
 *   - SVG path numbers that overflow to Infinity (e.g. "1e999").
 */
import type { Shape } from '../types.js';
import { flattenPath } from '../geometry/index.js';
import { ellipseOutline, rectOutline } from '../geometry/shapes.js';
import { MAX_DETAIL_VERTICES } from '../geometry/triangulate.js';

const SQRT3_2 = Math.sqrt(3) / 2;

export interface DetailOverrun {
  detail: number;
  /** Estimated vertex count of the largest outline. */
  estimate: number;
  /** Smallest detail that keeps every outline within the budget. */
  minDetail: number;
}

/** Outlines that `detail` refines, built exactly as the geometry compiler builds them. */
function refinedOutlines(shape: Shape): ArrayLike<number>[] {
  switch (shape.type) {
    case 'ellipse':
      return [ellipseOutline(shape)];
    case 'rect':
      return [rectOutline(shape.x, shape.y, shape.w, shape.h, shape.radius)];
    case 'polygon':
      return [shape.points];
    case 'path':
      return flattenPath(shape.d, shape.tolerance).map((s) => s.points);
    default:
      return [];
  }
}

/**
 * The vertex-budget overrun of a shape's `detail`, or null when it fits (or has no detail).
 * Only call it for shapes that passed the shape checks (paths parse, polygons have even length).
 */
export function detailOverrun(shape: Shape): DetailOverrun | null {
  const detail = 'detail' in shape ? shape.detail : undefined;
  if (detail === undefined) return null;
  let estimate = 0;
  let minDetail = 0;
  for (const ring of refinedOutlines(shape)) {
    if (ring.length < 6) continue;
    let perimeter = 0;
    let twiceArea = 0;
    for (let i = 0, j = ring.length - 2; i + 1 < ring.length; j = i, i += 2) {
      perimeter += Math.hypot(ring[i] - ring[j], ring[i + 1] - ring[j + 1]);
      twiceArea += ring[j] * ring[i + 1] - ring[i] * ring[j + 1];
    }
    const area = Math.abs(twiceArea) / 2;
    if (area === 0) continue; // degenerate outlines are not triangulated, so never refined
    const vertices = perimeter / detail + area / (detail * detail * SQRT3_2);
    if (vertices <= MAX_DETAIL_VERTICES) continue;
    // Positive root of N·d² − perimeter·d − area/(√3/2) = 0: the smallest detail within budget N.
    const n = MAX_DETAIL_VERTICES;
    estimate = Math.max(estimate, vertices);
    minDetail = Math.max(minDetail, (perimeter + Math.sqrt(perimeter * perimeter + (4 * n * area) / SQRT3_2)) / (2 * n));
  }
  return estimate > 0 ? { detail, estimate, minDetail } : null;
}

export { MAX_DETAIL_VERTICES };

/** Matches every SVG path number token (same grammar as path.ts). */
const PATH_NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;

/** The first number literal in SVG path data that overflows to ±Infinity, or null. */
export function overflowingPathNumber(d: string): string | null {
  for (const [token] of d.matchAll(PATH_NUMBER)) if (!Number.isFinite(parseFloat(token))) return token;
  return null;
}
