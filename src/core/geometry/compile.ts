/**
 * compileGeometry: a part's shape + fill + stroke -> fill and stroke triangle batches in SETUP space.
 */
import type { CompiledGeometry, MeshBatch, Part, Shape, Stroke, TextureInfo } from '../types.js';
import { assertFinite, GeometryError } from './errors.js';
import { flattenPath, type FlatSubpath } from './flatten.js';
import { fillColors, paintColor, solidColors } from './paint.js';
import { appendTriangles, subdivideEdges, type Triangles } from './primitives.js';
import { ellipseOutline, imageGeometry, meshGeometry, rectOutline, type FillMesh, type ShapeGeometry } from './shapes.js';
import { strokeContours, type Contour } from './stroke.js';
import { triangulatePolygon } from './triangulate.js';

export interface GeometryContext {
  /** Texture sizes by id (needed by `image` shapes for default w/h and crop -> uv). */
  textures: Record<string, TextureInfo>;
}

/**
 * Compile a part's effective shape/fill/stroke (runtime overrides already applied by the rig) into
 * fill and stroke batches. Deterministic: the same part always yields identical arrays. Batches with
 * no triangles are returned as null. Throws GeometryError (prefixed with the part id) on unusable input.
 */
export function compileGeometry(part: Part, ctx: GeometryContext): CompiledGeometry {
  try {
    const geometry = shapeGeometry(part.shape, ctx);
    const fill = geometry.fill && geometry.fill.indices.length > 0 ? fillBatch(geometry.fill, part) : null;
    const stroke = part.stroke && part.stroke.width > 0 ? strokeBatch(geometry.contours, part.stroke) : null;
    return { fill, stroke };
  } catch (e) {
    if (e instanceof GeometryError) throw new GeometryError(`part "${part.id}": ${e.message}`, { cause: e });
    throw e;
  }
}

function shapeGeometry(shape: Shape, ctx: GeometryContext): ShapeGeometry {
  switch (shape.type) {
    case 'ellipse':
      return outlineGeometry([{ points: ellipseOutline(shape), closed: true }], shape.detail);
    case 'rect': {
      const points = rectOutline(shape.x, shape.y, shape.w, shape.h, shape.radius);
      return outlineGeometry([{ points, closed: true }], shape.detail);
    }
    case 'polygon':
      if (shape.points.length % 2 !== 0) {
        throw new GeometryError(`polygon points must be [x0, y0, x1, y1, ...] (odd length ${shape.points.length})`);
      }
      assertFinite('polygon points', shape.points);
      return outlineGeometry([{ points: shape.points, closed: true }], shape.detail);
    case 'path':
      return outlineGeometry(flattenPath(shape.d, shape.tolerance), shape.detail);
    case 'mesh':
      return meshGeometry(shape);
    case 'image':
      return imageGeometry(shape, ctx.textures);
  }
}

/** Fill every outline independently (implicitly closed); stroke each as given. */
function outlineGeometry(outlines: readonly FlatSubpath[], detail: number | undefined): ShapeGeometry {
  if (detail !== undefined && !(detail > 0 && Number.isFinite(detail))) {
    throw new GeometryError(`detail must be a positive number, got ${detail}`);
  }
  const fill: Triangles = { positions: [], indices: [] };
  for (const outline of outlines) appendTriangles(fill, triangulatePolygon(outline.points, detail));
  // With detail the stroke is subdivided too, so it bends as smoothly as the fill under deformation.
  const contours: Contour[] = outlines.map(({ points, closed }) => ({
    points: detail === undefined ? points : subdivideEdges(points, closed, detail),
    closed,
  }));
  return { fill, contours };
}

function fillBatch(mesh: FillMesh, part: Part): MeshBatch {
  const batch: MeshBatch = {
    positions: Float32Array.from(mesh.positions),
    colors: fillColors(part.fill, mesh.positions),
    indices: Uint32Array.from(mesh.indices),
  };
  if (mesh.texture !== undefined && mesh.uvs) {
    batch.uvs = Float32Array.from(mesh.uvs);
    batch.texture = mesh.texture;
  }
  return batch;
}

function strokeBatch(contours: readonly Contour[], stroke: Stroke): MeshBatch | null {
  if (!Number.isFinite(stroke.width)) throw new GeometryError(`stroke width must be finite, got ${stroke.width}`);
  const color = paintColor(stroke.color, 'stroke color');
  const mesh = strokeContours(contours, stroke);
  if (mesh.indices.length === 0) return null;
  return {
    positions: Float32Array.from(mesh.positions),
    colors: solidColors(color, mesh.positions.length >> 1),
    indices: Uint32Array.from(mesh.indices),
  };
}
