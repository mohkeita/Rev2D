/**
 * Spine mesh + texture region of one Rev2D part.
 *
 * The part (fill and stroke, paint only: tint and opacity go to the slot color) is rasterized alone
 * into its own image. The Spine mesh covering that image is built so that it deforms like the part:
 * - the part's own fill triangles (the same vertices the rig deforms, `detail` refinement included),
 * - a ring around the fill boundary, as wide as the stroke's outer extent plus a margin for the
 *   anti-aliased edge (the ring shares the boundary vertices, so nothing overlaps),
 * - a band around every stroked outline that has no filled area (stroke-only parts, open strokes).
 * The hull (outer boundary loop) comes first in the vertex list, as the Spine format requires.
 */
import { compileGeometry } from '../../core/geometry/index.js';
import { flattenPath } from '../../core/geometry/flatten.js';
import { subdivideEdges } from '../../core/geometry/primitives.js';
import { ellipseOutline, meshBoundary, rectOutline } from '../../core/geometry/shapes.js';
import type { CompiledGeometry, DrawItem, ImageRGBA, Part, Stroke, TextureInfo } from '../../core/types.js';
import { renderImage } from '../../render/raster.js';

export interface Outline {
  points: number[];
  closed: boolean;
}

export interface PartGeometry {
  geometry: CompiledGeometry;
  /** Stroke outlines (setup space), as the stroke tessellation sees them. */
  outlines: Outline[];
  /** The fill paints something (a texture, or some vertex with alpha > 0). */
  fillVisible: boolean;
  /** Stroke with a positive width, if any. */
  stroke: Stroke | null;
}

/** Geometry of a part with its effective (reference) shape and paint. */
export function partGeometry(part: Part, textures: Record<string, TextureInfo>): PartGeometry {
  const geometry = compileGeometry(part, { textures });
  const fill = geometry.fill;
  let fillVisible = false;
  if (fill && fill.indices.length) {
    if (fill.texture !== undefined) fillVisible = true;
    else for (let i = 3; i < fill.colors.length; i += 4) if (fill.colors[i] > 1e-4) fillVisible = true;
  }
  const stroke = part.stroke && part.stroke.width > 0 && geometry.stroke ? part.stroke : null;
  return { geometry, outlines: stroke ? outlinesOf(part) : [], fillVisible, stroke };
}

function outlinesOf(part: Part): Outline[] {
  const s = part.shape;
  const detail = 'detail' in s ? s.detail : undefined;
  let raw: Outline[];
  switch (s.type) {
    case 'ellipse':
      raw = [{ points: ellipseOutline(s), closed: true }];
      break;
    case 'rect':
      raw = [{ points: rectOutline(s.x, s.y, s.w, s.h, s.radius), closed: true }];
      break;
    case 'polygon':
      raw = [{ points: s.points.slice(), closed: true }];
      break;
    case 'path':
      raw = flattenPath(s.d, s.tolerance).map((sp) => ({ points: sp.points, closed: sp.closed }));
      break;
    case 'mesh':
      return meshBoundary(s.vertices, s.triangles).map((c) => ({ points: c.points, closed: c.closed }));
    case 'image':
      return [];
  }
  return detail === undefined ? raw : raw.map((o) => ({ points: subdivideEdges(o.points, o.closed, detail), closed: o.closed }));
}

/** How far the stroke reaches outside the outline (miter joins aside). */
function strokeOuter(stroke: Stroke | null): number {
  if (!stroke) return 0;
  return stroke.align === 'center' ? stroke.width / 2 : stroke.align === 'outside' ? stroke.width : 0;
}

export interface CoverMesh {
  /** Reference setup-space positions, hull first. */
  positions: number[];
  triangles: number[];
  /** Number of hull vertices (the first ones). */
  hull: number;
}

const MITER_LIMIT = 3;

/** Unit normal of the algebraic right side of p -> q ((dy, -dx) / len), or null for a zero-length edge. */
function rightNormal(px: number, py: number, qx: number, qy: number): [number, number] | null {
  const dx = qx - px;
  const dy = qy - py;
  const l = Math.hypot(dx, dy);
  return l > 1e-9 ? [dy / l, -dx / l] : null;
}

/** Offset direction at a vertex between two edge normals, scaled for a constant distance (miter-limited). */
function vertexOffset(n1: [number, number], n2: [number, number]): [number, number] {
  let nx = n1[0] + n2[0];
  let ny = n1[1] + n2[1];
  const l = Math.hypot(nx, ny);
  if (l < 1e-6) return n1;
  nx /= l;
  ny /= l;
  const cos = nx * n1[0] + ny * n1[1];
  const s = 1 / Math.max(cos, 1 / MITER_LIMIT);
  return [nx * s, ny * s];
}

/** Boundary loops (vertex indices) of a triangle list, each with the interior on its algebraic left. */
function boundaryLoops(pos: ArrayLike<number>, tri: ArrayLike<number>): number[][] {
  const uses = new Map<string, number>();
  const directed: Array<[number, number]> = [];
  for (let t = 0; t + 2 < tri.length; t += 3) {
    const a = tri[t];
    let b = tri[t + 1];
    let c = tri[t + 2];
    const o = (pos[2 * b] - pos[2 * a]) * (pos[2 * c + 1] - pos[2 * a + 1]) - (pos[2 * b + 1] - pos[2 * a + 1]) * (pos[2 * c] - pos[2 * a]);
    if (o === 0) continue;
    if (o < 0) [b, c] = [c, b];
    for (const [p, q] of [
      [a, b],
      [b, c],
      [c, a],
    ] as Array<[number, number]>) {
      const key = p < q ? `${p},${q}` : `${q},${p}`;
      uses.set(key, (uses.get(key) ?? 0) + 1);
      directed.push([p, q]);
    }
  }
  const out = new Map<number, number[]>();
  const edges: Array<[number, number]> = [];
  for (const [p, q] of directed) {
    if (uses.get(p < q ? `${p},${q}` : `${q},${p}`) !== 1) continue;
    const e = edges.length;
    edges.push([p, q]);
    const list = out.get(p);
    if (list) list.push(e);
    else out.set(p, [e]);
  }
  const used = new Uint8Array(edges.length);
  const loops: number[][] = [];
  for (let e0 = 0; e0 < edges.length; e0++) {
    if (used[e0]) continue;
    used[e0] = 1;
    const start = edges[e0][0];
    const loop = [start];
    let cur = edges[e0][1];
    while (cur !== start) {
      loop.push(cur);
      const e = out.get(cur)?.find((k) => !used[k]);
      if (e === undefined) break;
      used[e] = 1;
      cur = edges[e][1];
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

/**
 * The mesh covering everything a part draws, from its reference geometry. `margin` (px) is added
 * around every visible edge for anti-aliasing. Null when the part draws nothing.
 */
export function buildCoverMesh(pg: PartGeometry, margin: number): CoverMesh | null {
  const positions: number[] = [];
  const triangles: number[] = [];
  const fill = pg.geometry.fill;
  let ringLoops: number[][] = [];
  if (pg.fillVisible && fill) {
    positions.push(...fill.positions);
    triangles.push(...fill.indices);
    ringLoops = boundaryLoops(fill.positions, fill.indices);
    const width = strokeOuter(pg.stroke) + margin;
    const rings: number[][] = [];
    for (const loop of ringLoops) {
      const n = loop.length;
      const ring: number[] = [];
      for (let i = 0; i < n; i++) {
        const a = loop[(i + n - 1) % n];
        const b = loop[i];
        const c = loop[(i + 1) % n];
        const n1 = rightNormal(fill.positions[2 * a], fill.positions[2 * a + 1], fill.positions[2 * b], fill.positions[2 * b + 1]);
        const n2 = rightNormal(fill.positions[2 * b], fill.positions[2 * b + 1], fill.positions[2 * c], fill.positions[2 * c + 1]);
        const off = vertexOffset(n1 ?? n2 ?? [0, 0], n2 ?? n1 ?? [0, 0]);
        ring.push(positions.length >> 1);
        positions.push(fill.positions[2 * b] + off[0] * width, fill.positions[2 * b + 1] + off[1] * width);
      }
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        triangles.push(loop[i], loop[j], ring[j], loop[i], ring[j], ring[i]);
      }
      rings.push(ring);
    }
    ringLoops = rings;
  }
  // Bands around stroked outlines without a covering fill.
  const bandLoops: number[][] = [];
  if (pg.stroke) {
    const half = (pg.stroke.align === 'center' ? pg.stroke.width / 2 : pg.stroke.width) + margin;
    for (const o of pg.outlines) {
      if (pg.fillVisible && o.closed && Math.abs(loopArea(o.points)) > 1e-6) continue;
      if (pg.fillVisible && !o.closed && Math.abs(loopArea(o.points)) > 1e-6 * Math.max(1, perimeter(o.points))) continue;
      const loop = band(o, half, margin, positions, triangles);
      if (loop) bandLoops.push(loop);
    }
  }
  if (!triangles.length) return null;
  // Hull: the longest outer loop (ring or band outline).
  const loops = boundaryLoops(positions, triangles);
  let hull: number[] = [];
  let best = -1;
  for (const l of loops) {
    const pts: number[] = [];
    for (const v of l) pts.push(positions[2 * v], positions[2 * v + 1]);
    const a = Math.abs(loopArea(pts));
    if (a > best) {
      best = a;
      hull = l;
    }
  }
  return reorder(positions, triangles, hull);
}

/** Band quads along an outline; returns nothing useful but appends to positions/triangles. */
function band(o: Outline, half: number, extend: number, positions: number[], triangles: number[]): number[] | null {
  const pts: number[] = [];
  for (let i = 0; i + 1 < o.points.length; i += 2) {
    const n = pts.length;
    if (n >= 2 && Math.abs(pts[n - 2] - o.points[i]) < 1e-9 && Math.abs(pts[n - 1] - o.points[i + 1]) < 1e-9) continue;
    pts.push(o.points[i], o.points[i + 1]);
  }
  if (o.closed && pts.length >= 4 && Math.abs(pts[0] - pts[pts.length - 2]) < 1e-9 && Math.abs(pts[1] - pts[pts.length - 1]) < 1e-9) pts.splice(-2);
  const n = pts.length >> 1;
  if (n < 2) return null;
  const closed = o.closed && n >= 3;
  const segs = closed ? n : n - 1;
  const normals: Array<[number, number] | null> = [];
  for (let s = 0; s < segs; s++) {
    const j = (s + 1) % n;
    normals.push(rightNormal(pts[2 * s], pts[2 * s + 1], pts[2 * j], pts[2 * j + 1]));
  }
  const left: number[] = [];
  const right: number[] = [];
  for (let i = 0; i < n; i++) {
    const nin = closed ? normals[(i + segs - 1) % segs] : i > 0 ? normals[i - 1] : null;
    const nout = closed ? normals[i] : i < segs ? normals[i] : null;
    const off = vertexOffset(nin ?? nout ?? [0, 0], nout ?? nin ?? [0, 0]);
    let x = pts[2 * i];
    let y = pts[2 * i + 1];
    if (!closed && (i === 0 || i === n - 1)) {
      // Butt cap: extend the end along the tangent by the margin.
      const nn = (i === 0 ? nout : nin) ?? [0, 0];
      const tx = -nn[1];
      const ty = nn[0];
      const sign = i === 0 ? -1 : 1;
      x += tx * extend * sign;
      y += ty * extend * sign;
    }
    left.push(positions.length >> 1);
    positions.push(x - off[0] * half, y - off[1] * half);
    right.push(positions.length >> 1);
    positions.push(x + off[0] * half, y + off[1] * half);
  }
  for (let s = 0; s < segs; s++) {
    const j = (s + 1) % n;
    triangles.push(left[s], left[j], right[j], left[s], right[j], right[s]);
  }
  return left;
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

function perimeter(p: ArrayLike<number>): number {
  let s = 0;
  for (let i = 2; i + 1 < p.length; i += 2) s += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
  return s;
}

/** Put the hull loop first (in loop order), drop unused vertices, remap triangles. */
function reorder(positions: number[], triangles: number[], hull: number[]): CoverMesh {
  const n = positions.length >> 1;
  const usedV = new Uint8Array(n);
  for (const t of triangles) usedV[t] = 1;
  const map = new Int32Array(n).fill(-1);
  const out: number[] = [];
  const add = (v: number) => {
    if (map[v] >= 0) return;
    map[v] = out.length >> 1;
    out.push(positions[2 * v], positions[2 * v + 1]);
  };
  for (const v of hull) add(v);
  const hullCount = out.length >> 1;
  for (let v = 0; v < n; v++) if (usedV[v]) add(v);
  return { positions: out, triangles: triangles.map((t) => map[t]), hull: hullCount };
}

// ----------------------------------------------------------------------------- raster

export interface RegionBox {
  /** Setup-space top-left of the image. */
  x: number;
  y: number;
  /** Image size in pixels. */
  width: number;
  height: number;
  /** Image pixels per setup px. */
  scale: number;
}

/** Pixel box covering `positions` at `scale` (setup-space origin snapped to the pixel grid). */
export function regionBox(positions: ArrayLike<number>, scale: number): RegionBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 1 < positions.length; i += 2) {
    minX = Math.min(minX, positions[i]);
    maxX = Math.max(maxX, positions[i]);
    minY = Math.min(minY, positions[i + 1]);
    maxY = Math.max(maxY, positions[i + 1]);
  }
  const x = Math.floor(minX * scale) / scale;
  const y = Math.floor(minY * scale) / scale;
  return {
    x,
    y,
    width: Math.max(1, Math.ceil((maxX - x) * scale - 1e-9)),
    height: Math.max(1, Math.ceil((maxY - y) * scale - 1e-9)),
    scale,
  };
}

/** Region-relative texture coordinates of setup-space positions. */
export function regionUvs(positions: ArrayLike<number>, box: RegionBox): number[] {
  const out: number[] = new Array(positions.length);
  for (let i = 0; i + 1 < positions.length; i += 2) {
    out[i] = ((positions[i] - box.x) * box.scale) / box.width;
    out[i + 1] = ((positions[i + 1] - box.y) * box.scale) / box.height;
  }
  return out;
}

/** Render the part's fill and stroke (paint only, setup space) into the region box. */
export function rasterizePart(partId: string, pg: PartGeometry, box: RegionBox, textures: Record<string, ImageRGBA>, supersample = 4): ImageRGBA {
  const draws: DrawItem[] = [];
  for (const [kind, batch] of [
    ['fill', pg.geometry.fill],
    ['stroke', pg.geometry.stroke],
  ] as const) {
    if (!batch || !batch.indices.length) continue;
    if (kind === 'fill' && !pg.fillVisible) continue;
    const item: DrawItem = { partId, kind, positions: batch.positions, colors: batch.colors, indices: batch.indices, blend: 'normal' };
    if (batch.uvs) item.uvs = batch.uvs;
    if (batch.texture !== undefined) item.texture = batch.texture;
    draws.push(item);
  }
  return renderImage(
    { width: box.width, height: box.height, background: [0, 0, 0, 0], draws },
    textures,
    { viewBox: [box.x, box.y, box.width / box.scale, box.height / box.scale], scale: box.scale, background: [0, 0, 0, 0], supersample },
  );
}

/**
 * Texel density of a textured fill (texture pixels per setup px, area-weighted), 1 when untextured.
 * Used to rasterize image parts at their texture's resolution.
 */
export function texelDensity(pg: PartGeometry, textures: Record<string, TextureInfo>): number {
  const f = pg.geometry.fill;
  if (!f || !f.uvs || f.texture === undefined) return 1;
  const t = textures[f.texture];
  if (!t) return 1;
  let posArea = 0;
  let uvArea = 0;
  const p = f.positions;
  const u = f.uvs;
  for (let k = 0; k + 2 < f.indices.length; k += 3) {
    const a = f.indices[k];
    const b = f.indices[k + 1];
    const c = f.indices[k + 2];
    posArea += Math.abs((p[2 * b] - p[2 * a]) * (p[2 * c + 1] - p[2 * a + 1]) - (p[2 * c] - p[2 * a]) * (p[2 * b + 1] - p[2 * a + 1]));
    uvArea += Math.abs((u[2 * b] - u[2 * a]) * (u[2 * c + 1] - u[2 * a + 1]) - (u[2 * c] - u[2 * a]) * (u[2 * b + 1] - u[2 * a + 1]));
  }
  if (posArea < 1e-9) return 1;
  return Math.sqrt((uvArea * t.width * t.height) / posArea);
}
