/**
 * Polygon triangulation: robust ear clipping, Delaunay improvement and optional `detail` refinement.
 *
 * Without `detail` a simple outline yields exactly its cleaned vertices and n - 2 triangles. With
 * `detail` the outline is resampled so no boundary edge exceeds it, a hexagonal lattice of interior
 * Steiner points is inserted, and Delaunay refinement removes the remaining long interior edges, so
 * every edge is at most `detail` long. Every result is a conforming, non-overlapping triangulation of
 * the polygon's area with positively oriented triangles (Delaunay, apart from the fixed boundary).
 */
import { GeometryError } from './errors.js';
import {
  cleanPolygon,
  extentOf,
  orient,
  orientTol,
  REL_EPS,
  reversePoints,
  signedArea,
  subdivideEdges,
  type Triangles,
} from './primitives.js';
import { TriMesh } from './trimesh.js';

/** Upper bound on the vertices `detail` refinement may create for one polygon (checked on an estimate up front). */
export const MAX_DETAIL_VERTICES = 262_144;
/** Hard stop for refinement, well above anything the up-front estimate lets through. */
const MAX_REFINED_VERTICES = 2 * MAX_DETAIL_VERTICES;
/** Lattice points closer than this fraction of `detail` to the outline are dropped. */
const BOUNDARY_CLEARANCE = 0.5;
const SQRT3_2 = Math.sqrt(3) / 2;

/**
 * Triangulate one polygon given in either winding (implicitly closed). Duplicate and collinear points
 * are removed first; outlines with fewer than 3 distinct points or ~zero area yield no triangles.
 */
export function triangulatePolygon(points: ArrayLike<number>, detail?: number): Triangles {
  const extent = extentOf(points);
  const eps = REL_EPS * extent;
  let ring = cleanPolygon(points, eps);
  const area = signedArea(ring);
  if (ring.length < 6 || Math.abs(area) <= eps * extent) return { positions: [], indices: [] };
  if (area < 0) ring = reversePoints(ring);
  if (detail !== undefined) {
    checkDetailBudget(ring, Math.abs(area), detail);
    ring = subdivideEdges(ring, true, detail);
  }
  const { triangles, simple } = earClip(ring, eps);
  // Slivers just above the area threshold can consist of flat vertices only and clip to nothing.
  if (triangles.length === 0) return { positions: [], indices: [] };
  // Self-intersecting outlines (unsupported) keep their plain ear clipping: its triangles overlap, so
  // Delaunay flips and refinement would only turn them inside out.
  if (!simple) return { positions: ring, indices: triangles };
  const mesh = new TriMesh(ring, triangles, eps);
  mesh.makeDelaunay();
  if (detail !== undefined) {
    mesh.insertPoints(latticePoints(ring, detail), detail);
    mesh.refine(detail, MAX_REFINED_VERTICES);
  }
  return mesh.toTriangles();
}

/**
 * Ear clipping of a positive, duplicate-free ring. Returns ring vertex indices, 3 per triangle, and
 * whether the outline behaved like a simple polygon (no forced ear, triangles tile its exact area).
 * An ear must be convex and thicker than `eps` (a distance), and contain no other vertex (boundary
 * inclusive, within eps), which keeps collinear vertices from ending up inside a triangle edge.
 */
export function earClip(ring: ArrayLike<number>, eps: number): { triangles: number[]; simple: boolean } {
  const n = ring.length >> 1;
  const tris: number[] = [];
  if (n < 3) return { triangles: tris, simple: true };
  const prev = new Int32Array(n);
  const next = new Int32Array(n);
  const alive = new Uint8Array(n).fill(1);
  let perimeter = 0;
  for (let i = 0; i < n; i++) {
    prev[i] = i === 0 ? n - 1 : i - 1;
    next[i] = i === n - 1 ? 0 : i + 1;
    perimeter += Math.hypot(ring[2 * next[i]] - ring[2 * i], ring[2 * next[i] + 1] - ring[2 * i + 1]);
  }
  const turn = (a: number, b: number, c: number) =>
    orient(ring[2 * a], ring[2 * a + 1], ring[2 * b], ring[2 * b + 1], ring[2 * c], ring[2 * c + 1]);
  /** turn(a, b, c), or 0 when the triangle is thinner than eps. */
  const solidTurn = (a: number, b: number, c: number) =>
    orientTol(ring[2 * a], ring[2 * a + 1], ring[2 * b], ring[2 * b + 1], ring[2 * c], ring[2 * c + 1], eps);
  const grid = new VertexGrid(ring);

  const isEar = (a: number, b: number, c: number): boolean => {
    if (!(solidTurn(a, b, c) > 0)) return false;
    const ax = ring[2 * a];
    const ay = ring[2 * a + 1];
    const bx = ring[2 * b];
    const by = ring[2 * b + 1];
    const cx = ring[2 * c];
    const cy = ring[2 * c + 1];
    const minX = Math.min(ax, bx, cx);
    const maxX = Math.max(ax, bx, cx);
    const minY = Math.min(ay, by, cy);
    const maxY = Math.max(ay, by, cy);
    // turn(p, q, v) >= -eps·|pq| <=> v is on the inner side of p-q or within eps of its line.
    const tolAB = -eps * Math.hypot(bx - ax, by - ay);
    const tolBC = -eps * Math.hypot(cx - bx, cy - by);
    const tolCA = -eps * Math.hypot(ax - cx, ay - cy);
    return !grid.some(minX, minY, maxX, maxY, (v) => {
      if (!alive[v] || v === a || v === b || v === c) return false;
      const vx = ring[2 * v];
      const vy = ring[2 * v + 1];
      if (vx < minX || vx > maxX || vy < minY || vy > maxY) return false;
      // A vertex touching the ear's base corners (self-touching outline) does not block it.
      if ((vx === ax && vy === ay) || (vx === cx && vy === cy)) return false;
      return turn(a, b, v) >= tolAB && turn(b, c, v) >= tolBC && turn(c, a, v) >= tolCA;
    });
  };

  /**
   * Fallback after a full lap without an ear (self-touching, self-intersecting or numerically
   * degenerate outlines): the first flat vertex (collinear or spike, no area to lose), else the most
   * convex one, else -1 when nothing with positive area is left.
   */
  const fallbackVertex = (from: number): { v: number; emit: boolean } => {
    let best = -1;
    let bestTurn = 0;
    let v = from;
    do {
      const t = solidTurn(prev[v], v, next[v]);
      if (t === 0) return { v, emit: false };
      if (t > bestTurn) {
        bestTurn = t;
        best = v;
      }
      v = next[v];
    } while (v !== from);
    return { v: best, emit: true };
  };

  let doubleArea = 0; // of the emitted triangles
  const emit = (a: number, b: number, c: number) => {
    tris.push(a, b, c);
    doubleArea += turn(a, b, c);
  };

  let remaining = n;
  let cur = 0;
  let misses = 0;
  let forced = false;
  while (remaining > 3) {
    let keep = true;
    if (!isEar(prev[cur], cur, next[cur])) {
      if (++misses < remaining) {
        cur = next[cur];
        continue;
      }
      const pick = fallbackVertex(cur);
      if (pick.v < 0) break;
      cur = pick.v;
      keep = pick.emit;
      forced ||= pick.emit;
    }
    const a = prev[cur];
    const c = next[cur];
    if (keep) emit(a, cur, c);
    next[a] = c;
    prev[c] = a;
    alive[cur] = 0;
    remaining--;
    misses = 0;
    // Continue at the neighbour whose ear would add the shorter diagonal. Always moving on to `c`
    // fans out from `a` along collinear runs (subdivided edges), which is slow to clip (ever wider
    // ears to test) and a poor start for Delaunay flips; this zigzags across instead.
    const pa = prev[a];
    const nc = next[c];
    const viaA = (ring[2 * pa] - ring[2 * c]) ** 2 + (ring[2 * pa + 1] - ring[2 * c + 1]) ** 2;
    const viaC = (ring[2 * a] - ring[2 * nc]) ** 2 + (ring[2 * a + 1] - ring[2 * nc + 1]) ** 2;
    cur = viaA < viaC ? a : c;
  }
  if (remaining === 3 && solidTurn(prev[cur], cur, next[cur]) > 0) emit(prev[cur], cur, next[cur]);
  // Simple (or merely self-touching) outlines are tiled by their ears up to the slivers (thinner than
  // eps) dropped as flat; a larger mismatch means the outline crosses itself.
  const simple = !forced && Math.abs(doubleArea - 2 * signedArea(ring)) <= 2 * eps * perimeter;
  return { triangles: tris, simple };
}

/** Uniform grid over a ring's vertices (about one per cell) for bounding-box queries. */
class VertexGrid {
  private readonly x0: number;
  private readonly y0: number;
  private readonly cell: number;
  private readonly cols: number;
  private readonly rows: number;
  /** Vertices of cell k are items[start[k] .. start[k + 1]). */
  private readonly start: Int32Array;
  private readonly items: Int32Array;

  constructor(ring: ArrayLike<number>) {
    const n = ring.length >> 1;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < ring.length; i += 2) {
      minX = Math.min(minX, ring[i]);
      maxX = Math.max(maxX, ring[i]);
      minY = Math.min(minY, ring[i + 1]);
      maxY = Math.max(maxY, ring[i + 1]);
    }
    this.x0 = minX;
    this.y0 = minY;
    // About one vertex per cell of the bounding box (at most ~4n cells, even for very thin boxes).
    const w = maxX - minX;
    const h = maxY - minY;
    this.cell = Math.max(Math.sqrt((w * h) / n), Math.max(w, h) / (4 * n)) || 1;
    this.cols = Math.floor((maxX - minX) / this.cell) + 1;
    this.rows = Math.floor((maxY - minY) / this.cell) + 1;
    this.start = new Int32Array(this.cols * this.rows + 1);
    this.items = new Int32Array(n);
    const cellOf = new Int32Array(n);
    for (let v = 0; v < n; v++) {
      cellOf[v] = this.row(ring[2 * v + 1]) * this.cols + this.col(ring[2 * v]);
      this.start[cellOf[v] + 1]++;
    }
    for (let k = 0; k < this.cols * this.rows; k++) this.start[k + 1] += this.start[k];
    const fill = this.start.slice(0, -1);
    for (let v = 0; v < n; v++) this.items[fill[cellOf[v]]++] = v;
  }

  /** True when `test` holds for some vertex in a cell overlapping the box. */
  some(minX: number, minY: number, maxX: number, maxY: number, test: (v: number) => boolean): boolean {
    const c0 = this.col(minX);
    const c1 = this.col(maxX);
    for (let r = this.row(minY), r1 = this.row(maxY); r <= r1; r++) {
      for (let k = r * this.cols + c0, k1 = r * this.cols + c1; k <= k1; k++) {
        for (let i = this.start[k]; i < this.start[k + 1]; i++) if (test(this.items[i])) return true;
      }
    }
    return false;
  }

  private col(x: number): number {
    return Math.min(this.cols - 1, Math.max(0, Math.floor((x - this.x0) / this.cell)));
  }

  private row(y: number): number {
    return Math.min(this.rows - 1, Math.max(0, Math.floor((y - this.y0) / this.cell)));
  }
}

function checkDetailBudget(ring: number[], area: number, detail: number): void {
  let perimeter = 0;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    perimeter += Math.hypot(ring[i] - ring[j], ring[i + 1] - ring[j + 1]);
  }
  const estimate = perimeter / detail + area / (detail * detail * SQRT3_2);
  if (estimate > MAX_DETAIL_VERTICES) {
    throw new GeometryError(
      `detail ${detail} is too fine for this shape (~${Math.round(estimate)} vertices, limit ${MAX_DETAIL_VERTICES}); use a larger detail`,
    );
  }
}

/**
 * Interior Steiner points: a hexagonal lattice with spacing `spacing`, anchored at the ring's area
 * centroid (so symmetric shapes get symmetric lattices whatever their outline sampling), clipped to
 * the positive ring (even-odd scanlines) and kept BOUNDARY_CLEARANCE·spacing away from it. Rows
 * alternate direction so consecutive insertions stay close together.
 */
export function latticePoints(ring: number[], spacing: number): number[] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  // Area centroid, relative to the first point for precision far from the origin.
  const [x0, y0] = [ring[0], ring[1]];
  let cross = 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    minX = Math.min(minX, ring[i]);
    maxX = Math.max(maxX, ring[i]);
    minY = Math.min(minY, ring[i + 1]);
    maxY = Math.max(maxY, ring[i + 1]);
    const [ax, ay, bx, by] = [ring[j] - x0, ring[j + 1] - y0, ring[i] - x0, ring[i + 1] - y0];
    const c = ax * by - bx * ay;
    cross += c;
    sx += (ax + bx) * c;
    sy += (ay + by) * c;
  }
  const cx = x0 + sx / (3 * cross);
  const cy = y0 + sy / (3 * cross);
  const rowStep = spacing * SQRT3_2;
  const firstRow = Math.ceil((minY - cy) / rowStep);
  const lastRow = Math.floor((maxY - cy) / rowStep);
  const grid = new SegmentGrid(ring, spacing, minX, minY, maxX);
  const scanlines = new Scanlines(ring, cy, rowStep, firstRow, lastRow);
  const clearance = BOUNDARY_CLEARANCE * spacing;
  const out: number[] = [];
  const row: number[] = [];
  for (let j = firstRow; j <= lastRow; j++) {
    const y = cy + j * rowStep;
    const shift = (j & 1) === 0 ? 0 : spacing / 2;
    const xs = scanlines.crossings(j, y);
    row.length = 0;
    for (let s = 0; s + 1 < xs.length; s += 2) {
      for (let i = Math.ceil((xs[s] - cx - shift) / spacing); ; i++) {
        const x = cx + shift + i * spacing;
        if (x > xs[s + 1]) break;
        if (!grid.anyWithin(x, y, clearance)) row.push(x, y);
      }
    }
    const reverse = ((j - firstRow) & 1) === 1;
    for (let i = 0; i < row.length; i += 2) {
      const k = reverse ? row.length - 2 - i : i;
      out.push(row[k], row[k + 1]);
    }
  }
  return out;
}

/**
 * Ring crossings of the scanlines y = y0 + j·step (j = firstRow..lastRow). Each edge is bucketed
 * under the rows its y range spans (plus one on either side, as the exact test below decides), so
 * a row only tests the few edges near it instead of the whole ring.
 */
class Scanlines {
  /** Edges (start index into the ring) of row k are items[start[k] .. start[k + 1]). */
  private readonly start: Int32Array;
  private readonly items: Int32Array;

  constructor(
    private readonly ring: number[],
    y0: number,
    step: number,
    private readonly firstRow: number,
    lastRow: number,
  ) {
    const rows = lastRow - firstRow + 1;
    const n = ring.length >> 1;
    const lo = new Int32Array(n);
    const hi = new Int32Array(n);
    this.start = new Int32Array(rows + 1);
    for (let e = 0; e < n; e++) {
      const ya = ring[2 * e + 1];
      const yb = ring[e === n - 1 ? 1 : 2 * e + 3];
      lo[e] = Math.max(0, Math.floor((Math.min(ya, yb) - y0) / step) - firstRow - 1);
      hi[e] = Math.min(rows - 1, Math.ceil((Math.max(ya, yb) - y0) / step) - firstRow + 1);
      for (let k = lo[e]; k <= hi[e]; k++) this.start[k + 1]++;
    }
    for (let k = 0; k < rows; k++) this.start[k + 1] += this.start[k];
    this.items = new Int32Array(this.start[rows]);
    const fill = this.start.slice(0, -1);
    for (let e = 0; e < n; e++) for (let k = lo[e]; k <= hi[e]; k++) this.items[fill[k]++] = e;
  }

  /** Sorted x coordinates where row j (at height y) crosses the ring (half-open rule). */
  crossings(j: number, y: number): number[] {
    const { ring } = this;
    const k = j - this.firstRow;
    const xs: number[] = [];
    for (let m = this.start[k]; m < this.start[k + 1]; m++) {
      const a = 2 * this.items[m];
      const b = a + 2 === ring.length ? 0 : a + 2;
      const ya = ring[a + 1];
      const yb = ring[b + 1];
      if (ya > y !== yb > y) xs.push(ring[a] + ((y - ya) * (ring[b] - ring[a])) / (yb - ya));
    }
    return xs.sort((p, q) => p - q);
  }
}

/** Uniform grid of the ring's edges for "is any edge within r" queries (r ≤ cell size). */
class SegmentGrid {
  private readonly cells = new Map<number, number[]>();
  private readonly stride: number;

  constructor(
    private readonly ring: number[],
    private readonly cell: number,
    private readonly x0: number,
    private readonly y0: number,
    maxX: number,
  ) {
    // One spare column on each side so neighbour lookups at the edges never alias another row.
    this.stride = Math.floor((maxX - x0) / cell) + 3;
    for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
      const c0 = this.col(Math.min(ring[i], ring[j]));
      const c1 = this.col(Math.max(ring[i], ring[j]));
      const r0 = this.row(Math.min(ring[i + 1], ring[j + 1]));
      const r1 = this.row(Math.max(ring[i + 1], ring[j + 1]));
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const key = r * this.stride + c + 1;
          const list = this.cells.get(key);
          if (list) list.push(j);
          else this.cells.set(key, [j]);
        }
      }
    }
  }

  anyWithin(x: number, y: number, r: number): boolean {
    const { ring } = this;
    const col = this.col(x);
    const row = this.row(y);
    const r2 = r * r;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const list = this.cells.get((row + dr) * this.stride + col + dc + 1);
        if (!list) continue;
        for (const j of list) {
          const i = j + 2 === ring.length ? 0 : j + 2;
          if (segmentDistance2(x, y, ring[j], ring[j + 1], ring[i], ring[i + 1]) < r2) return true;
        }
      }
    }
    return false;
  }

  private col(x: number): number {
    return Math.floor((x - this.x0) / this.cell);
  }

  private row(y: number): number {
    return Math.floor((y - this.y0) / this.cell);
  }
}

function segmentDistance2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2;
}
