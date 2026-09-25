/**
 * Part geometry: compiling (static or per effective value set), skin weights and deformation of
 * setup-space batches into world space (skinning / parent bone / parent warp / none).
 */
import { compileGeometry, computeAutoWeights } from '../geometry/index.js';
import { applyToPoints } from '../math.js';
import type { Mat2D, Part, PathValue, RGBA, Shape, TextureInfo, Value } from '../types.js';
import { cloneValue } from '../values.js';
import type { CompiledBone, CompiledPart, CompiledSkin, CompiledWarp, GeometryEntry, GeometryField, Slot } from './compiled.js';
import { pathData } from './paths.js';
import { mapPointsThroughWarp } from './warp.js';

/** Max cached geometries per dynamic part (covers ping-pong between a few shapes, e.g. blinking). */
const CACHE_LIMIT = 16;

/** Compile `part` (already carrying effective values) and derive skin weights for its batches. */
export function buildGeometryEntry(
  part: Part,
  skin: CompiledSkin | null,
  bones: CompiledBone[],
  textures: Record<string, TextureInfo>,
): GeometryEntry {
  const geometry = compileGeometry(part, { textures });
  if (!skin) return { geometry, fillWeights: null, strokeWeights: null };
  const { fill, stroke } = geometry;
  if (skin.weights === 'auto') {
    const segs = skin.bones.map((b) => bones[b].segment);
    return {
      geometry,
      fillWeights: fill ? computeAutoWeights(fill.positions, segs, skin.falloff) : null,
      strokeWeights: stroke ? computeAutoWeights(stroke.positions, segs, skin.falloff) : null,
    };
  }
  // Explicit rows belong to the mesh vertices. The mesh fill batch maps 1:1 onto them; any other batch
  // (e.g. the stroke outline) takes the row of the nearest mesh vertex.
  const vertices = (part.shape as Extract<Shape, { type: 'mesh' }>).vertices;
  const rows = skin.weights;
  return {
    geometry,
    fillWeights: fill
      ? fill.positions.length === vertices.length
        ? flattenRows(rows, skin.bones.length)
        : nearestRows(fill.positions, vertices, rows, skin.bones.length)
      : null,
    strokeWeights: stroke ? nearestRows(stroke.positions, vertices, rows, skin.bones.length) : null,
  };
}

/**
 * Skin weights (one per skin bone) of a single setup-space point, derived exactly like those of the
 * part's vertices: auto weights from the distances to the skin bones' setup segments with the part's
 * falloff, or, for explicit rows, the row of the nearest setup mesh vertex.
 */
export function pointSkinWeights(skin: CompiledSkin, shape: Shape, bones: CompiledBone[], x: number, y: number): Float32Array {
  if (skin.weights === 'auto') {
    return computeAutoWeights([x, y], skin.bones.map((b) => bones[b].segment), skin.falloff);
  }
  return nearestRows([x, y], (shape as Extract<Shape, { type: 'mesh' }>).vertices, skin.weights, skin.bones.length);
}

function flattenRows(rows: number[][], nb: number): Float32Array {
  const out = new Float32Array(rows.length * nb);
  rows.forEach((row, v) => out.set(row, v * nb));
  return out;
}

function nearestRows(positions: ArrayLike<number>, vertices: number[], rows: number[][], nb: number): Float32Array {
  const n = positions.length >> 1;
  const out = new Float32Array(n * nb);
  for (let v = 0; v < n; v++) {
    const x = positions[v * 2];
    const y = positions[v * 2 + 1];
    let best = 0;
    let bestD = Infinity;
    for (let k = 0; k < rows.length; k++) {
      const d = (vertices[k * 2] - x) ** 2 + (vertices[k * 2 + 1] - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    out.set(rows[best], v * nb);
  }
  return out;
}

/**
 * Geometry of a dynamic part for the given effective values (aligned with `cp.geometrySlots`).
 * Results are memoized per part in a small most-recent-first cache matched by exact value equality
 * (comparing numbers is ~100x cheaper per frame than building a string key for a large mesh).
 */
export function dynamicGeometry(
  cp: CompiledPart,
  slots: Slot[],
  values: Value[],
  bones: CompiledBone[],
  textures: Record<string, TextureInfo>,
): GeometryEntry {
  const { cache } = cp;
  for (let i = 0; i < cache.length; i++) {
    const hit = cache[i];
    if (!sameValues(hit.values, values)) continue;
    if (i > 0) {
      cache.splice(i, 1);
      cache.unshift(hit);
    }
    return hit.geometry;
  }
  const geometry = buildGeometryEntry(effectivePart(cp, slots, values), cp.skin, bones, textures);
  cache.unshift({ values: values.map(cloneValue), geometry });
  if (cache.length > CACHE_LIMIT) cache.pop();
  return geometry;
}

function sameValues(a: Value[], b: Value[]): boolean {
  for (let k = 0; k < a.length; k++) {
    const x = a[k];
    const y = b[k];
    if (typeof x === 'number') {
      if (x !== y) return false;
      continue;
    }
    const xs = Array.isArray(x) ? x : x.nums;
    const ys = Array.isArray(y) ? y : (y as PathValue).nums;
    if (xs.length !== ys.length) return false;
    for (let i = 0; i < xs.length; i++) if (xs[i] !== ys[i]) return false;
  }
  return true;
}

/** Copy of the part with bound/animated shape, fill and stroke fields replaced. */
function effectivePart(cp: CompiledPart, slots: Slot[], values: Value[]): Part {
  const src = cp.source;
  const shape: Record<string, unknown> = { ...src.shape };
  let fill = src.fill;
  const stroke = src.stroke ? { ...src.stroke } : undefined;
  cp.geometrySlots.forEach((s, k) => {
    const field = (slots[s].target as { field: GeometryField }).field;
    const v = values[k];
    if (field === 'fill') fill = colorString(v as RGBA);
    else if (field === 'stroke.color') stroke!.color = colorString(v as RGBA);
    else if (field === 'stroke.width') stroke!.width = v as number;
    else shape[field.slice('shape.'.length)] = slots[s].valueType === 'path' ? pathData(v as PathValue) : v;
  });
  return { ...src, shape: shape as Shape, fill, stroke };
}

/** Full-precision color string (formatColor would quantize to 8 bits). */
function colorString(c: RGBA): string {
  return `rgba(${c[0] * 255},${c[1] * 255},${c[2] * 255},${c[3]})`;
}

// ----------------------------------------------------------------------------- deformation

export interface DeformContext {
  /** Per bone: world · inverse(setupWorld). */
  boneDeform: Mat2D[];
  warps: CompiledWarp[];
  /** Deformed lattice points per warp (world space). */
  warpPoints: Float64Array[];
}

/** Deform a setup-space batch of `cp` into a new world-space array. */
export function deformBatch(
  cp: CompiledPart,
  src: Float32Array,
  weights: Float32Array | null,
  ctx: DeformContext,
): Float32Array {
  const out = new Float32Array(src.length);
  if (cp.skin) {
    skinPoints(cp.skin.bones.map((b) => ctx.boneDeform[b]), weights!, src, out);
    return out;
  }
  const parent = cp.parent;
  if (parent.kind === 'bone') {
    applyToPoints(ctx.boneDeform[parent.index], src, out);
  } else if (parent.kind === 'warp') {
    const w = ctx.warps[parent.index];
    mapPointsThroughWarp(ctx.warpPoints[parent.index], w.cols, w.rows, w.rect, src, out);
  } else {
    out.set(src);
  }
  return out;
}

/** Linear blend skinning. Weights are normalized per vertex; an all-zero row leaves the vertex in place. */
export function skinPoints(mats: Mat2D[], weights: Float32Array, src: ArrayLike<number>, out: Float32Array | Float64Array): void {
  const nb = mats.length;
  for (let v = 0, n = src.length >> 1; v < n; v++) {
    const x = src[v * 2];
    const y = src[v * 2 + 1];
    let sx = 0;
    let sy = 0;
    let sw = 0;
    for (let k = 0; k < nb; k++) {
      const w = weights[v * nb + k];
      if (w === 0) continue;
      const m = mats[k];
      sx += w * (m[0] * x + m[2] * y + m[4]);
      sy += w * (m[1] * x + m[3] * y + m[5]);
      sw += w;
    }
    if (Math.abs(sw) > 1e-12) {
      out[v * 2] = sx / sw;
      out[v * 2 + 1] = sy / sw;
    } else {
      out[v * 2] = x;
      out[v * 2 + 1] = y;
    }
  }
}
