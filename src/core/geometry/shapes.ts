/**
 * Per-shape geometry sources: outlines for ellipse / rect, and direct meshes for image / mesh shapes.
 */
import { clamp, DEG } from '../math.js';
import type { Shape, TextureInfo } from '../types.js';
import { assertFinite, GeometryError } from './errors.js';
import { arcSegments, orient, type Triangles } from './primitives.js';
import type { Contour } from './stroke.js';

type ShapeOf<T extends Shape['type']> = Extract<Shape, { type: T }>;

/** Fill triangles plus, for textured shapes, per-vertex uvs and the texture id. */
export interface FillMesh extends Triangles {
  uvs?: number[];
  texture?: string;
}

/** Everything compileGeometry needs from a shape: fill triangles and stroke outlines. */
export interface ShapeGeometry {
  fill: FillMesh | null;
  contours: Contour[];
}

/** Max deviation of rounded-rect corners from a true arc (px). */
const CORNER_TOLERANCE = 0.1;
const MAX_CORNER_SEGMENTS = 64;

/** Ellipse outline (positive orientation). Empty when a radius is zero. */
export function ellipseOutline(shape: ShapeOf<'ellipse'>): number[] {
  assertFinite('ellipse cx/cy/rx/ry/rotation', [shape.cx, shape.cy, shape.rx, shape.ry, shape.rotation]);
  const rx = Math.abs(shape.rx);
  const ry = Math.abs(shape.ry);
  if (rx === 0 || ry === 0) return [];
  const n = shape.segments ?? autoEllipseSegments(rx, ry);
  if (!Number.isInteger(n) || n < 3) throw new GeometryError(`ellipse segments must be an integer >= 3, got ${n}`);
  const cos = Math.cos(shape.rotation * DEG);
  const sin = Math.sin(shape.rotation * DEG);
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    const t = (2 * Math.PI * k) / n;
    const lx = rx * Math.cos(t);
    const ly = ry * Math.sin(t);
    out.push(shape.cx + lx * cos - ly * sin, shape.cy + lx * sin + ly * cos);
  }
  return out;
}

/** Default ellipse segment count: about one segment per 4 px of perimeter, within [16, 128]. */
function autoEllipseSegments(rx: number, ry: number): number {
  // Ramanujan's second approximation of the perimeter.
  const h = ((rx - ry) / (rx + ry)) ** 2;
  const perimeter = Math.PI * (rx + ry) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
  return clamp(Math.ceil(perimeter / 4), 16, 128);
}

/** Rectangle outline (positive orientation) with corner radius clamped to min(w, h) / 2. Empty when w or h is 0. */
export function rectOutline(x: number, y: number, w: number, h: number, radius: number): number[] {
  assertFinite('rect x/y/w/h/radius', [x, y, w, h, radius]);
  if (w < 0) {
    x += w;
    w = -w;
  }
  if (h < 0) {
    y += h;
    h = -h;
  }
  if (w === 0 || h === 0) return [];
  const r = clamp(radius, 0, Math.min(w, h) / 2);
  if (r === 0) return [x, y, x + w, y, x + w, y + h, x, y + h];
  const n = arcSegments(r, Math.PI / 2, CORNER_TOLERANCE, MAX_CORNER_SEGMENTS);
  // Corner centers with the unit direction where each quarter arc starts (top-left, clockwise on screen).
  const corners = [
    [x + r, y + r, -1, 0],
    [x + w - r, y + r, 0, -1],
    [x + w - r, y + h - r, 1, 0],
    [x + r, y + h - r, 0, 1],
  ];
  const out: number[] = [];
  for (const [cx, cy, ux, uy] of corners) {
    for (let i = 0; i <= n; i++) {
      // Exact endpoints keep the straight edges exactly axis-aligned.
      const a = (Math.PI / 2) * (i / n);
      const c = i === n ? 0 : Math.cos(a);
      const s = i === n ? 1 : Math.sin(a);
      // Rotate u towards the next corner's start direction (u rotated by +90°: (-uy, ux)).
      out.push(cx + r * (c * ux - s * uy), cy + r * (c * uy + s * ux));
    }
  }
  return out;
}

/** Textured (cols+1)×(rows+1) grid over [x, y, w, h]; vertex i = row·(cols+1) + col. */
export function imageGeometry(shape: ShapeOf<'image'>, textures: Record<string, TextureInfo>): ShapeGeometry {
  const { texture, crop, cols, rows, x, y } = shape;
  if (!Number.isInteger(cols) || cols < 1 || !Number.isInteger(rows) || rows < 1) {
    throw new GeometryError(`image cols/rows must be integers >= 1, got ${cols}x${rows}`);
  }
  const textureSize = (why: string): TextureInfo => {
    const info = Object.hasOwn(textures, texture) ? textures[texture] : undefined;
    if (!info) throw new GeometryError(`unknown texture "${texture}" (its size is needed ${why})`);
    if (!(info.width > 0 && info.height > 0)) throw new GeometryError(`texture "${texture}" has invalid size ${info.width}x${info.height}`);
    return info;
  };
  let w = shape.w;
  let h = shape.h;
  if (w === undefined || h === undefined) {
    const size = crop ? { width: crop[2], height: crop[3] } : textureSize('for the default image w/h');
    w ??= size.width;
    h ??= size.height;
  }
  let u0 = 0;
  let v0 = 0;
  let u1 = 1;
  let v1 = 1;
  if (crop) {
    const size = textureSize('to map the crop rectangle to uvs');
    u0 = crop[0] / size.width;
    v0 = crop[1] / size.height;
    u1 = (crop[0] + crop[2]) / size.width;
    v1 = (crop[1] + crop[3]) / size.height;
  }
  assertFinite('image x/y/w/h/crop', [x, y, w, h, u0, v0, u1, v1]);

  const positions: number[] = [];
  const uvs: number[] = [];
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      positions.push(x + (w * c) / cols, y + (h * r) / rows);
      uvs.push(u0 + ((u1 - u0) * c) / cols, v0 + ((v1 - v0) * r) / rows);
    }
  }
  // Keep triangles positive when w or h is negative (mirrored image).
  const flip = w * h < 0;
  const indices: number[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i00 = r * (cols + 1) + c;
      const i01 = i00 + cols + 1;
      if (flip) indices.push(i00, i01 + 1, i00 + 1, i00, i01, i01 + 1);
      else indices.push(i00, i00 + 1, i01 + 1, i00, i01 + 1, i01);
    }
  }
  return {
    fill: { positions, indices, uvs, texture },
    contours: [{ points: rectOutline(x, y, w, h, 0), closed: true }],
  };
}

/**
 * Raw mesh as given (vertex order preserved, so explicit skin weights still line up). `uvs` are only
 * meaningful with a `texture` and are ignored without one.
 */
export function meshGeometry(shape: ShapeOf<'mesh'>): ShapeGeometry {
  const { vertices, triangles, uvs, texture } = shape;
  if (vertices.length % 2 !== 0) throw new GeometryError(`mesh vertices must be [x0, y0, x1, y1, ...] (odd length ${vertices.length})`);
  assertFinite('mesh vertices', vertices);
  const n = vertices.length / 2;
  if (triangles.length % 3 !== 0) throw new GeometryError(`mesh triangles must have 3 indices per triangle (length ${triangles.length})`);
  for (const i of triangles) {
    if (!Number.isInteger(i) || i < 0 || i >= n) {
      throw new GeometryError(`mesh triangle index ${i} is out of range (the mesh has ${n} vertices)`);
    }
  }
  const fill: FillMesh = { positions: vertices.slice(), indices: triangles.slice() };
  if (texture !== undefined) {
    if (!uvs) throw new GeometryError(`textured mesh needs "uvs" (one [u, v] per vertex) to sample "${texture}"`);
    if (uvs.length !== vertices.length) {
      throw new GeometryError(`mesh uvs length ${uvs.length} must equal vertices length ${vertices.length}`);
    }
    assertFinite('mesh uvs', uvs);
    fill.uvs = uvs.slice();
    fill.texture = texture;
  }
  return { fill, contours: meshBoundary(vertices, triangles) };
}

/**
 * Boundary of a triangle mesh: edges used by exactly one triangle, chained into loops (or open chains
 * for non-manifold input). Each triangle is taken with positive orientation, so the interior is on
 * the algebraic left of every boundary edge (holes included).
 */
export function meshBoundary(vertices: readonly number[], triangles: readonly number[]): Contour[] {
  const n = vertices.length / 2;
  const uses = new Map<number, number>();
  const directed: number[] = [];
  for (let t = 0; t + 2 < triangles.length; t += 3) {
    const a = triangles[t];
    let b = triangles[t + 1];
    let c = triangles[t + 2];
    if (orient(vertices[2 * a], vertices[2 * a + 1], vertices[2 * b], vertices[2 * b + 1], vertices[2 * c], vertices[2 * c + 1]) < 0) {
      [b, c] = [c, b];
    }
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      if (p === q) continue;
      const key = Math.min(p, q) * n + Math.max(p, q);
      uses.set(key, (uses.get(key) ?? 0) + 1);
      directed.push(p, q);
    }
  }
  const from: number[] = [];
  const to: number[] = [];
  const outgoing = new Map<number, number[]>();
  const incoming = new Map<number, number[]>();
  for (let i = 0; i < directed.length; i += 2) {
    const p = directed[i];
    const q = directed[i + 1];
    if (uses.get(Math.min(p, q) * n + Math.max(p, q)) !== 1) continue;
    const e = from.length;
    from.push(p);
    to.push(q);
    pushTo(outgoing, p, e);
    pushTo(incoming, q, e);
  }
  const used = new Uint8Array(from.length);
  const take = (list: number[] | undefined): number => {
    const e = list?.find((k) => !used[k]) ?? -1;
    if (e >= 0) used[e] = 1;
    return e;
  };

  const contours: Contour[] = [];
  for (let e0 = 0; e0 < from.length; e0++) {
    if (used[e0]) continue;
    used[e0] = 1;
    const start = from[e0];
    let chain = [start, to[e0]];
    let end = to[e0];
    while (end !== start) {
      const e = take(outgoing.get(end));
      if (e < 0) break;
      end = to[e];
      chain.push(end);
    }
    const closed = end === start;
    if (closed) chain.pop();
    else {
      // Open chain: extend backwards from the start as far as possible.
      const before: number[] = [];
      for (let e = take(incoming.get(start)); e >= 0; e = take(incoming.get(from[e]))) before.push(from[e]);
      chain = before.reverse().concat(chain);
    }
    const points: number[] = [];
    for (const v of chain) points.push(vertices[2 * v], vertices[2 * v + 1]);
    contours.push({ points, closed, interior: 1 });
  }
  return contours;
}

function pushTo(map: Map<number, number[]>, key: number, value: number): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
