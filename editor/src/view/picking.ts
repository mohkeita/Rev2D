/**
 * Viewport picking (pure): parts by point-in-triangle over the render list (top-most first), bones
 * by distance to their joint (or body) in screen-scaled model units.
 */

/** The subset of a core DrawItem that picking needs. */
export interface PickItem {
  partId: string;
  positions: ArrayLike<number>;
  indices: ArrayLike<number>;
  /** Clip geometry: the item is only visible inside the union of these (outside with maskInvert). */
  masks?: readonly PickItem[];
  maskInvert?: boolean;
}

export interface PickBone {
  id: string;
  x: number;
  y: number;
  tip: readonly [number, number];
}

/** True when (px, py) lies inside or on the edge of triangle abc (either winding). */
export function pointInTriangle(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): boolean {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/** True when any triangle of the item contains (x, y). */
export function itemContains(item: PickItem, x: number, y: number): boolean {
  const p = item.positions;
  const idx = item.indices;
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const a = idx[t] * 2;
    const b = idx[t + 1] * 2;
    const c = idx[t + 2] * 2;
    if (pointInTriangle(x, y, p[a], p[a + 1], p[b], p[b + 1], p[c], p[c + 1])) return true;
  }
  return false;
}

/**
 * True when the item's mask lets (x, y) through (always, for unmasked items). Geometry only: mask
 * alpha is ignored. A present but EMPTY mask list is zero coverage: nothing passes (everything, with
 * maskInvert).
 */
export function maskAllows(item: PickItem, x: number, y: number): boolean {
  if (!item.masks) return true;
  const inside = item.masks.some((m) => itemContains(m, x, y));
  return item.maskInvert ? !inside : inside;
}

/**
 * Part ids visible under (x, y), top-most first, each id once. Items are in draw order (back to
 * front), so the list is scanned backwards. Parts in `hidden` (preview visibility) and points
 * clipped away by a part's mask are skipped.
 */
export function pickParts(items: readonly PickItem[], x: number, y: number, hidden?: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (hidden?.has(item.partId) || out.includes(item.partId)) continue;
    if (itemContains(item, x, y) && maskAllows(item, x, y)) out.push(item.partId);
  }
  return out;
}

export function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Bone under (x, y): the closest joint within `radius`, else the closest bone body (joint->tip
 * segment) within radius / 2. Ties go to the later bone (drawn on top). Radius is in model units, so
 * callers pass (screen pixels / zoom).
 */
export function pickBone(bones: readonly PickBone[], x: number, y: number, radius: number): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const b of bones) {
    const d = Math.hypot(x - b.x, y - b.y);
    if (d <= radius && d <= bestD) {
      best = b.id;
      bestD = d;
    }
  }
  if (best) return best;
  const bodyRadius = radius / 2;
  for (const b of bones) {
    const d = distanceToSegment(x, y, b.x, b.y, b.tip[0], b.tip[1]);
    if (d <= bodyRadius && d <= bestD) {
      best = b.id;
      bestD = d;
    }
  }
  return best;
}

/**
 * Click cycling: clicking the same spot again walks down the stack of parts under the cursor.
 * Returns the hit after `current` (wrapping), or the top hit when `current` is not in the stack.
 */
export function cyclePick(hits: readonly string[], current: string | null, sameSpot: boolean): string | null {
  if (hits.length === 0) return null;
  if (!sameSpot || current === null) return hits[0];
  const i = hits.indexOf(current);
  return i < 0 ? hits[0] : hits[(i + 1) % hits.length];
}
