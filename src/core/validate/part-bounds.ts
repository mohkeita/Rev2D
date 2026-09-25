/**
 * Setup-space bounds of a part's drawn geometry, computed from its outline the way the geometry
 * compiler builds it (ellipse / rect outlines, polygon points, flattened path, mesh vertices used by a
 * triangle, image rect), grown by the stroke's outward extent. Used by the `part-outside-warp` check.
 */
import type { Part, Shape, Texture } from '../types.js';
import { flattenPath } from '../geometry/index.js';
import { ellipseOutline, rectOutline } from '../geometry/shapes.js';

/** Axis-aligned box [minX, minY, maxX, maxY]. */
export type Box = [number, number, number, number];

/**
 * Bounds of `part` in setup space including its stroke, or null when it draws no geometry or the size
 * is unknown (an image without `w`/`h`/`crop` whose texture declares no size). The stroke adds half its
 * width (`align: "center"`), its full width (`"outside"`) or nothing (`"inside"`) on every side; miter
 * joins at sharp corners can reach a little further.
 */
export function partSetupBounds(part: Part, textures: readonly Texture[]): Box | null {
  let box: Box | null;
  try {
    box = shapeBounds(part.shape, textures);
  } catch {
    return null; // geometry the compiler rejects is reported by other checks
  }
  if (box === null) return null;
  const stroke = part.stroke;
  if (stroke && stroke.width > 0) {
    const grow = stroke.align === 'inside' ? 0 : stroke.align === 'outside' ? stroke.width : stroke.width / 2;
    box = [box[0] - grow, box[1] - grow, box[2] + grow, box[3] + grow];
  }
  return box;
}

function shapeBounds(shape: Shape, textures: readonly Texture[]): Box | null {
  switch (shape.type) {
    case 'ellipse':
      return pointsBounds(ellipseOutline(shape));
    case 'rect':
      return pointsBounds(rectOutline(shape.x, shape.y, shape.w, shape.h, shape.radius));
    case 'polygon':
      return pointsBounds(shape.points);
    case 'path': {
      let box: Box | null = null;
      for (const sub of flattenPath(shape.d, shape.tolerance)) box = union(box, pointsBounds(sub.points));
      return box;
    }
    case 'mesh': {
      const used: number[] = [];
      for (const i of shape.triangles) used.push(shape.vertices[i * 2], shape.vertices[i * 2 + 1]);
      return pointsBounds(used);
    }
    case 'image': {
      const texture = textures.find((t) => t.id === shape.texture);
      const w = shape.w ?? shape.crop?.[2] ?? texture?.width;
      const h = shape.h ?? shape.crop?.[3] ?? texture?.height;
      if (w === undefined || h === undefined) return null;
      return [Math.min(shape.x, shape.x + w), Math.min(shape.y, shape.y + h), Math.max(shape.x, shape.x + w), Math.max(shape.y, shape.y + h)];
    }
  }
}

/** Bounds of a flat point list [x0, y0, ...]; null when it has no (finite) point. */
export function pointsBounds(points: ArrayLike<number>): Box | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 1 < points.length; i += 2) {
    const x = points[i];
    const y = points[i + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return minX <= maxX ? [minX, minY, maxX, maxY] : null;
}

function union(a: Box | null, b: Box | null): Box | null {
  if (a === null) return b;
  if (b === null) return a;
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}
