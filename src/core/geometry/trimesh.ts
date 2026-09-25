/**
 * Half-edge triangle mesh used to improve and refine polygon triangulations.
 *
 * Triangle t owns half-edges 3t, 3t+1, 3t+2. Half-edge h runs from vertex tv[h] to tv[next(h)];
 * twin[h] is the opposite half-edge of the neighbouring triangle, or -1 on the polygon boundary.
 * Triangles are positively oriented (see primitives.ts). Boundary edges are never flipped or split,
 * so every operation keeps a conforming triangulation of the same polygon.
 *
 * All tolerances are distances (`eps`): a triangle counts as degenerate when it is thinner than eps,
 * whatever the size of the polygon, so small triangles in a very long outline behave like any other.
 */
import { orient, orientTol, type Triangles } from './primitives.js';

const nextHalfedge = (h: number): number => (h % 3 === 2 ? h - 2 : h + 1);
const prevHalfedge = (h: number): number => (h % 3 === 0 ? h + 2 : h - 1);

/** Relative threshold of the in-circle test, so cocircular points (circle outlines) never flip back and forth. */
const INCIRCLE_EPS = 1e-10;

export class TriMesh {
  private readonly xs: number[] = [];
  private readonly ys: number[] = [];
  private readonly tv: number[];
  private readonly twin: number[];
  /** A triangle incident to each vertex (-1 for ring vertices no triangle uses): jump targets for point location. */
  private readonly vertexTri: number[];
  /** Distances at or below this are zero. */
  private readonly eps: number;
  /** Triangle where the next point location starts (the one touched last). */
  private hint = 0;
  /** Vertex buckets, while `insertPoints` runs. */
  private buckets: VertexBuckets | null = null;
  /** Triangles changed by flips and splits, collected while `refine` runs. */
  private touched: number[] | null = null;

  /**
   * @param ring positive polygon outline (vertices 0..n-1 of the mesh)
   * @param triangles positive triangles over the ring's vertices, e.g. from ear clipping
   * @param eps distance tolerance (coincident points, degenerate triangles)
   */
  constructor(ring: ArrayLike<number>, triangles: number[], eps: number) {
    for (let i = 0; i + 1 < ring.length; i += 2) {
      this.xs.push(ring[i]);
      this.ys.push(ring[i + 1]);
    }
    this.eps = eps;
    this.tv = triangles.slice();
    this.twin = new Array<number>(this.tv.length).fill(-1);
    const n = this.xs.length;
    this.vertexTri = new Array<number>(n).fill(-1);
    const unmatched = new Map<number, number>();
    for (let h = 0; h < this.tv.length; h++) {
      const a = this.tv[h];
      const b = this.tv[nextHalfedge(h)];
      this.vertexTri[a] = (h / 3) | 0;
      const g = unmatched.get(b * n + a);
      if (g === undefined) {
        unmatched.set(a * n + b, h);
      } else {
        unmatched.delete(b * n + a);
        this.link(h, g);
      }
    }
  }

  /** Flip interior edges until the triangulation is (constrained) Delaunay. */
  makeDelaunay(): void {
    const stack: number[] = [];
    for (let h = 0; h < this.tv.length; h++) if (this.twin[h] > h) stack.push(h);
    this.legalize(stack);
  }

  /**
   * Insert interior points [x0, y0, ...] one by one, keeping the mesh Delaunay. Points outside the
   * polygon, on its boundary or on an existing vertex are ignored. `spacing` (about the distance
   * between neighbouring points) sizes the buckets that locate each point near an existing vertex, so
   * points across a concavity are found without scanning every triangle.
   */
  insertPoints(points: ArrayLike<number>, spacing: number): void {
    const buckets = new VertexBuckets(this.xs, this.ys, spacing);
    for (let v = 0; v < this.xs.length; v++) if (this.vertexTri[v] >= 0) buckets.add(v);
    this.buckets = buckets;
    for (let i = 0; i + 1 < points.length; i += 2) {
      const t = this.locate(points[i], points[i + 1]);
      if (t >= 0) this.insertInto(t, points[i], points[i + 1]);
    }
    this.buckets = null;
  }

  /**
   * Refine until no edge is longer than `maxLen` (boundary edges must already comply), or until the
   * mesh has `maxVertices` vertices (a safety bound; the result stays a valid triangulation). Long
   * edges are handled longest first: the circumcenter of an adjacent triangle is inserted when it lies
   * safely inside the polygon (in a Delaunay mesh it is > maxLen / 2 from every vertex, so triangles
   * stay well shaped), otherwise the edge is split at its midpoint. Work proceeds in rounds; each
   * round re-examines only the triangles the previous one changed, so long chains of dependent
   * insertions (e.g. near sharp corners) cost no more than the insertions themselves.
   */
  refine(maxLen: number, maxVertices: number): void {
    const limit2 = (maxLen * (1 + 1e-9)) ** 2;
    const { xs, ys, tv, twin } = this;
    const len2 = (h: number): number => {
      const a = tv[h];
      const b = tv[nextHalfedge(h)];
      return (xs[b] - xs[a]) ** 2 + (ys[b] - ys[a]) ** 2;
    };
    let long: number[] = [];
    for (let h = 0; h < tv.length; h++) if (twin[h] > h && len2(h) > limit2) long.push(h);
    const touched: number[] = [];
    this.touched = touched;
    while (long.length > 0 && xs.length < maxVertices) {
      // Longest first; repeated entries end up adjacent and are handled once.
      long.sort((p, q) => len2(q) - len2(p) || p - q);
      for (let i = 0; i < long.length && xs.length < maxVertices; i++) {
        const h = long[i];
        // Earlier insertions may have turned a listed slot into a different (possibly short) edge.
        if (h === long[i - 1] || twin[h] < 0 || len2(h) <= limit2) continue;
        if (this.insertCircumcenter(h) || this.insertCircumcenter(twin[h])) continue;
        const a = tv[h];
        const b = tv[nextHalfedge(h)];
        this.splitEdge(h, (xs[a] + xs[b]) / 2, (ys[a] + ys[b]) / 2);
      }
      long = [];
      for (const t of touched) {
        for (let h = 3 * t; h < 3 * t + 3; h++) {
          const g = twin[h];
          if (g >= 0 && len2(h) > limit2) long.push(Math.min(h, g));
        }
      }
      touched.length = 0;
    }
    this.touched = null;
  }

  toTriangles(): Triangles {
    const positions = new Array<number>(this.xs.length * 2);
    for (let i = 0; i < this.xs.length; i++) {
      positions[2 * i] = this.xs[i];
      positions[2 * i + 1] = this.ys[i];
    }
    return { positions, indices: this.tv.slice() };
  }

  // ------------------------------------------------------------------------------------ internals

  /** Insert (x, y), known to lie in triangle t. Returns false when it is skipped (vertex or boundary). */
  private insertInto(t: number, x: number, y: number): boolean {
    const { xs, ys, tv } = this;
    for (let e = 0; e < 3; e++) {
      const a = tv[3 * t + e];
      if (Math.hypot(x - xs[a], y - ys[a]) <= this.eps) return false;
    }
    for (let e = 0; e < 3; e++) {
      const h = 3 * t + e;
      const a = tv[h];
      const b = tv[nextHalfedge(h)];
      if (Math.abs(orient(xs[a], ys[a], xs[b], ys[b], x, y)) > this.eps * Math.hypot(xs[b] - xs[a], ys[b] - ys[a])) continue;
      if (this.twin[h] < 0) return false;
      this.splitEdge(h, x, y);
      return true;
    }
    this.splitTriangle(t, x, y);
    return true;
  }

  /**
   * Insert the circumcenter of the triangle owning half-edge h, unless it falls outside the polygon or
   * inside the diametral circle of a boundary edge of the triangle containing it (that would create a
   * sliver against the boundary).
   */
  private insertCircumcenter(h: number): boolean {
    const { xs, ys, tv, twin } = this;
    const t = (h / 3) | 0;
    const a = tv[3 * t];
    const b = tv[3 * t + 1];
    const c = tv[3 * t + 2];
    if (!(this.solidTurn(a, b, c) > 0)) return false;
    const bx = xs[b] - xs[a];
    const by = ys[b] - ys[a];
    const cx = xs[c] - xs[a];
    const cy = ys[c] - ys[a];
    const d = 2 * (bx * cy - by * cx);
    const b2 = bx * bx + by * by;
    const c2 = cx * cx + cy * cy;
    const x = xs[a] + (cy * b2 - by * c2) / d;
    const y = ys[a] + (bx * c2 - cx * b2) / d;
    const at = this.walk(t, x, y);
    if (at < 0) return false;
    for (let e = 0; e < 3; e++) {
      const g = 3 * at + e;
      if (twin[g] >= 0) continue;
      const p = tv[g];
      const q = tv[nextHalfedge(g)];
      const mx = (xs[p] + xs[q]) / 2;
      const my = (ys[p] + ys[q]) / 2;
      if ((x - mx) ** 2 + (y - my) ** 2 < ((xs[q] - xs[p]) ** 2 + (ys[q] - ys[p]) ** 2) / 4) return false;
    }
    return this.insertInto(at, x, y);
  }

  private link(a: number, b: number): void {
    this.twin[a] = b;
    if (b >= 0) this.twin[b] = a;
  }

  /** New vertex at (x, y), incident to triangle t. */
  private addVertex(x: number, y: number, t: number): number {
    const v = this.xs.length;
    this.xs.push(x);
    this.ys.push(y);
    this.vertexTri.push(t);
    this.buckets?.add(v);
    return v;
  }

  private addTriangle(a: number, b: number, c: number): number {
    this.tv.push(a, b, c);
    this.twin.push(-1, -1, -1);
    return this.tv.length / 3 - 1;
  }

  /** orient(a, b, c), or 0 when the triangle is thinner than eps. */
  private solidTurn(a: number, b: number, c: number): number {
    const { xs, ys } = this;
    return orientTol(xs[a], ys[a], xs[b], ys[b], xs[c], ys[c], this.eps);
  }

  /** True when d lies clearly inside the circumcircle of the positive triangle (a, b, c). */
  private inCircle(a: number, b: number, c: number, d: number): boolean {
    const { xs, ys } = this;
    const adx = xs[a] - xs[d];
    const ady = ys[a] - ys[d];
    const bdx = xs[b] - xs[d];
    const bdy = ys[b] - ys[d];
    const cdx = xs[c] - xs[d];
    const cdy = ys[c] - ys[d];
    const al = adx * adx + ady * ady;
    const bl = bdx * bdx + bdy * bdy;
    const cl = cdx * cdx + cdy * cdy;
    const det = adx * (bdy * cl - cdy * bl) - ady * (bdx * cl - cdx * bl) + al * (bdx * cdy - bdy * cdx);
    const scale = al + bl + cl;
    return det > INCIRCLE_EPS * scale * scale;
  }

  /**
   * Lawson flips: for each queued half-edge, flip the shared edge while the opposite vertex lies in
   * the circumcircle. In exact arithmetic an edge never reappears once flipped away, so at most
   * n(n-1)/2 flips can happen; the budget only guards against floating-point pathologies.
   */
  private legalize(stack: number[]): void {
    const { tv, twin, vertexTri } = this;
    const n = this.xs.length;
    let budget = (n * (n - 1)) / 2 + 1;
    while (stack.length > 0) {
      const h = stack.pop()!;
      const g = twin[h];
      if (g < 0) continue;
      const h1 = nextHalfedge(h);
      const h2 = prevHalfedge(h);
      const g1 = nextHalfedge(g);
      const g2 = prevHalfedge(g);
      // Triangles (p, q, r) and (q, p, s) share the edge p-q.
      const p = tv[h];
      const q = tv[h1];
      const r = tv[h2];
      const s = tv[g2];
      if (!this.inCircle(p, q, r, s)) continue;
      // The flipped triangles (s, r, p) and (r, s, q) must both be proper (the quad is convex).
      if (!(this.solidTurn(s, r, p) > 0) || !(this.solidTurn(r, s, q) > 0)) continue;
      if (--budget < 0) return;
      // Re-use both slots for (s, r, p) and (r, s, q).
      const outerQR = twin[h1];
      const outerRP = twin[h2];
      const outerPS = twin[g1];
      const outerSQ = twin[g2];
      tv[h] = s;
      tv[h1] = r;
      tv[h2] = p;
      tv[g] = r;
      tv[g1] = s;
      tv[g2] = q;
      this.link(h, g);
      this.link(h1, outerRP);
      this.link(h2, outerPS);
      this.link(g1, outerSQ);
      this.link(g2, outerQR);
      // p now lies only in h's triangle, q only in g's (r and s are in both).
      vertexTri[p] = (h / 3) | 0;
      vertexTri[q] = (g / 3) | 0;
      this.touched?.push((h / 3) | 0, (g / 3) | 0);
      stack.push(h1, h2, g1, g2);
    }
  }

  /** Split triangle t at the interior point (x, y) into three. */
  private splitTriangle(t: number, x: number, y: number): void {
    const { tv, twin } = this;
    const h0 = 3 * t;
    const a = tv[h0];
    const b = tv[h0 + 1];
    const c = tv[h0 + 2];
    const outerBC = twin[h0 + 1];
    const outerCA = twin[h0 + 2];
    const v = this.addVertex(x, y, t);
    const t1 = 3 * this.addTriangle(b, c, v);
    const t2 = 3 * this.addTriangle(c, a, v);
    tv[h0 + 2] = v; // t becomes (a, b, v)
    this.vertexTri[c] = t1 / 3;
    this.link(t1, outerBC);
    this.link(t2, outerCA);
    this.link(h0 + 1, t1 + 2); // b-v
    this.link(t1 + 1, t2 + 2); // c-v
    this.link(t2 + 1, h0 + 2); // a-v
    this.touched?.push(t, t1 / 3, t2 / 3);
    this.hint = t;
    this.legalize([h0, t1, t2]);
  }

  /** Split the interior edge h (shared by (p, q, r) and (q, p, s)) at the point (x, y) on it. */
  private splitEdge(h: number, x: number, y: number): void {
    const { tv, twin, vertexTri } = this;
    const g = twin[h];
    const h1 = nextHalfedge(h);
    const h2 = prevHalfedge(h);
    const g1 = nextHalfedge(g);
    const g2 = prevHalfedge(g);
    const p = tv[h];
    const q = tv[h1];
    const r = tv[h2];
    const s = tv[g2];
    const outerQR = twin[h1];
    const outerPS = twin[g1];
    const th = (h / 3) | 0;
    const m = this.addVertex(x, y, th);
    const e = 3 * this.addTriangle(q, r, m);
    const f = 3 * this.addTriangle(p, s, m);
    tv[h1] = m; // (p, m, r)
    tv[g1] = m; // (q, m, s)
    vertexTri[p] = th;
    vertexTri[q] = (g / 3) | 0;
    this.link(e, outerQR);
    this.link(f, outerPS);
    this.link(h1, e + 1); // m-r
    this.link(g1, f + 1); // m-s
    this.link(h, f + 2); // p-m
    this.link(g, e + 2); // q-m
    this.touched?.push(th, (g / 3) | 0, e / 3, f / 3);
    this.hint = th;
    this.legalize([h2, e, g2, f]);
  }

  /**
   * Triangle containing (x, y), or -1 outside the polygon: walk from the last touched triangle; when
   * a concavity blocks the way, jump to a bucketed vertex near the point and walk from there; scan
   * all triangles as the last resort.
   */
  private locate(x: number, y: number): number {
    let t = this.walk(this.hint, x, y);
    if (t < 0 && this.buckets) {
      const v = this.buckets.near(x, y);
      if (v >= 0) t = this.walk(this.vertexTri[v], x, y);
    }
    return t >= 0 ? t : this.scan(x, y);
  }

  /** Visibility walk from triangle `start` towards (x, y); -1 when it would leave the polygon. */
  private walk(start: number, x: number, y: number): number {
    const { xs, ys, tv, twin } = this;
    let t = start;
    for (let steps = tv.length / 3; steps >= 0; steps--) {
      let across = -1;
      for (let e = 0; e < 3 && across < 0; e++) {
        const h = 3 * t + e;
        const a = tv[h];
        const b = tv[nextHalfedge(h)];
        if (orient(xs[a], ys[a], xs[b], ys[b], x, y) < 0) across = h;
      }
      if (across < 0) return t;
      if (twin[across] < 0) return -1;
      t = (twin[across] / 3) | 0;
    }
    return -1;
  }

  /** Linear search for a triangle containing (x, y) (boundary inclusive); -1 if none. */
  private scan(x: number, y: number): number {
    const { xs, ys, tv } = this;
    for (let t = 0; t < tv.length / 3; t++) {
      let inside = true;
      for (let e = 0; e < 3 && inside; e++) {
        const a = tv[3 * t + e];
        const b = tv[3 * t + ((e + 1) % 3)];
        const o = orient(xs[a], ys[a], xs[b], ys[b], x, y);
        inside = o >= -this.eps * Math.hypot(xs[b] - xs[a], ys[b] - ys[a]);
      }
      if (inside) return t;
    }
    return -1;
  }
}

/** The most recently added vertex of each cell of a uniform grid, to find a vertex near a point. */
class VertexBuckets {
  private readonly cells = new Map<number, number>();
  private readonly x0: number;
  private readonly y0: number;
  private readonly cols: number;
  private readonly rows: number;

  constructor(
    private readonly xs: readonly number[],
    private readonly ys: readonly number[],
    private readonly cell: number,
  ) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let v = 0; v < xs.length; v++) {
      minX = Math.min(minX, xs[v]);
      maxX = Math.max(maxX, xs[v]);
      minY = Math.min(minY, ys[v]);
      maxY = Math.max(maxY, ys[v]);
    }
    this.x0 = minX;
    this.y0 = minY;
    this.cols = Math.floor((maxX - minX) / cell) + 1;
    this.rows = Math.floor((maxY - minY) / cell) + 1;
  }

  add(v: number): void {
    this.cells.set(this.row(this.ys[v]) * this.cols + this.col(this.xs[v]), v);
  }

  /** The closest bucketed vertex in the nearest non-empty ring of cells around (x, y); -1 if none. */
  near(x: number, y: number): number {
    const c0 = this.col(x);
    const r0 = this.row(y);
    for (let ring = 0, rings = Math.max(this.cols, this.rows); ring <= rings; ring++) {
      let best = -1;
      let bestD = Infinity;
      for (let r = Math.max(0, r0 - ring), r1 = Math.min(this.rows - 1, r0 + ring); r <= r1; r++) {
        // Whole rows at the top and bottom of the ring, only its two end cells in between.
        const step = r === r0 - ring || r === r0 + ring ? 1 : 2 * ring;
        for (let c = c0 - ring; c <= c0 + ring; c += step) {
          if (c < 0 || c >= this.cols) continue;
          const v = this.cells.get(r * this.cols + c);
          if (v === undefined) continue;
          const d = (this.xs[v] - x) ** 2 + (this.ys[v] - y) ** 2;
          if (d < bestD) {
            bestD = d;
            best = v;
          }
        }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  private col(x: number): number {
    return Math.min(this.cols - 1, Math.max(0, Math.floor((x - this.x0) / this.cell)));
  }

  private row(y: number): number {
    return Math.min(this.rows - 1, Math.max(0, Math.floor((y - this.y0) / this.cell)));
  }
}
