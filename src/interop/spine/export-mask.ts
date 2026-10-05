/**
 * Clipping polygons for the Spine exporter. A Rev2D mask clips to the coverage of the mask part (its
 * fill and stroke weighted by paint and texture alpha), a Spine clipping attachment to one polygon.
 * The polygon is the 50% alpha contour of the mask part rendered alone (marching squares with linear
 * interpolation), simplified with Douglas-Peucker. This covers vector outlines, strokes and texture
 * alpha alike.
 */
import type { ImageRGBA } from '../../core/types.js';

export interface ContourResult {
  /** Largest contour in image pixel coordinates (pixel centers at +0.5), or null when empty. */
  polygon: number[] | null;
  /** Area of the largest contour and of all others (px²), to report masks with several regions. */
  area: number;
  otherArea: number;
}

/**
 * Contours of the alpha channel at `level` (0..1). Returns the largest loop (by area). The image is
 * treated as transparent outside its bounds, so every loop closes.
 */
export function alphaContour(img: ImageRGBA, level = 0.5): ContourResult {
  const W = img.width + 2;
  const H = img.height + 2;
  const f = new Float32Array(W * H);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) f[(y + 1) * W + x + 1] = img.data[(y * img.width + x) * 4 + 3] / 255;
  }
  const val = (x: number, y: number) => f[y * W + x];
  // Crossing points on grid edges: horizontal edge (x,y)-(x+1,y) id 2*(y*W+x), vertical (x,y)-(x,y+1) id 2*(y*W+x)+1.
  const pos = new Map<number, [number, number]>();
  const crossing = (x0: number, y0: number, x1: number, y1: number, id: number): number => {
    if (!pos.has(id)) {
      const a = val(x0, y0);
      const b = val(x1, y1);
      const t = Math.abs(b - a) > 1e-9 ? (level - a) / (b - a) : 0.5;
      // Grid node (x, y) is the center of image pixel (x - 1, y - 1): image coordinate x - 0.5.
      pos.set(id, [x0 + (x1 - x0) * t - 0.5, y0 + (y1 - y0) * t - 0.5]);
    }
    return id;
  };
  const next = new Map<number, number>();
  for (let y = 0; y + 1 < H; y++) {
    for (let x = 0; x + 1 < W; x++) {
      const c = [val(x, y) >= level, val(x + 1, y) >= level, val(x + 1, y + 1) >= level, val(x, y + 1) >= level];
      if (c[0] === c[1] && c[1] === c[2] && c[2] === c[3]) continue;
      // Edge crossings: 0 top, 1 right, 2 bottom, 3 left.
      const edgeId = (e: number): number => {
        switch (e) {
          case 0:
            return crossing(x, y, x + 1, y, 2 * (y * W + x));
          case 1:
            return crossing(x + 1, y, x + 1, y + 1, 2 * (y * W + x + 1) + 1);
          case 2:
            return crossing(x, y + 1, x + 1, y + 1, 2 * ((y + 1) * W + x));
          default:
            return crossing(x, y, x, y + 1, 2 * (y * W + x) + 1);
        }
      };
      const corner: Array<[number, number]> = [
        [x, y],
        [x + 1, y],
        [x + 1, y + 1],
        [x, y + 1],
      ];
      const cut = (e1: number, e2: number, cornerIdx: number) => {
        // Orient so that the inside is on the left on screen (y down): left of d is (d.y, -d.x).
        const p = pos.get(edgeId(e1))!;
        const q = pos.get(edgeId(e2))!;
        const dx = q[0] - p[0];
        const dy = q[1] - p[1];
        const [cx, cy] = corner[cornerIdx];
        const side = (cx - 0.5 - p[0]) * dy - (cy - 0.5 - p[1]) * dx;
        const inside = c[cornerIdx];
        if (side > 0 === inside) next.set(edgeId(e1), edgeId(e2));
        else next.set(edgeId(e2), edgeId(e1));
      };
      const edges = [0, 1, 2, 3].filter((e) => c[e] !== c[(e + 1) % 4]);
      if (edges.length === 2) {
        // Corner shared by the two crossed edges, if adjacent; otherwise any corner decides.
        const [e1, e2] = edges;
        const shared = (e2 - e1 === 1 ? e2 : e1 === 0 && e2 === 3 ? 0 : -1) as number;
        cut(e1, e2, shared >= 0 ? shared : 0);
      } else {
        // Saddle: the center value decides which corners connect.
        const center = (val(x, y) + val(x + 1, y) + val(x + 1, y + 1) + val(x, y + 1)) / 4 >= level;
        if (c[0] === center) {
          // Corners 1 and 3 are cut off.
          cut(0, 1, 1);
          cut(2, 3, 3);
        } else {
          cut(3, 0, 0);
          cut(1, 2, 2);
        }
      }
    }
  }
  const loops: number[][] = [];
  const seen = new Set<number>();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const loop: number[] = [];
    let id: number | undefined = start;
    while (id !== undefined && !seen.has(id)) {
      seen.add(id);
      const p = pos.get(id)!;
      loop.push(p[0], p[1]);
      id = next.get(id);
    }
    if (loop.length >= 6) loops.push(loop);
  }
  let best: number[] | null = null;
  let bestArea = 0;
  let total = 0;
  for (const l of loops) {
    const a = Math.abs(polygonArea(l));
    total += a;
    if (a > bestArea) {
      bestArea = a;
      best = l;
    }
  }
  return { polygon: best, area: bestArea, otherArea: total - bestArea };
}

export function polygonArea(p: ArrayLike<number>): number {
  let a = 0;
  const n = p.length >> 1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += p[2 * i] * p[2 * j + 1] - p[2 * j] * p[2 * i + 1];
  }
  return a / 2;
}

/** Douglas-Peucker simplification of a closed polygon. */
export function simplifyClosed(p: number[], tolerance: number): number[] {
  const n = p.length >> 1;
  if (n <= 4) return p.slice();
  // Split at the vertex farthest from vertex 0.
  let far = 0;
  let farD = -1;
  for (let i = 1; i < n; i++) {
    const d = (p[2 * i] - p[0]) ** 2 + (p[2 * i + 1] - p[1]) ** 2;
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[far] = 1;
  const stack: Array<[number, number]> = [
    [0, far],
    [far, n],
  ];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const bi = b % n;
    const ax = p[2 * a];
    const ay = p[2 * a + 1];
    const ex = p[2 * bi] - ax;
    const ey = p[2 * bi + 1] - ay;
    const l = Math.hypot(ex, ey);
    let worst = -1;
    let worstD = tolerance;
    for (let i = a + 1; i < b; i++) {
      const x = p[2 * i] - ax;
      const y = p[2 * i + 1] - ay;
      const d = l > 1e-12 ? Math.abs(ex * y - ey * x) / l : Math.hypot(x, y);
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(p[2 * i], p[2 * i + 1]);
  return out;
}

/** Simplify until at most `maxPoints` remain (tolerance grows by 1.5x per round). */
export function simplifyTo(p: number[], tolerance: number, maxPoints: number): number[] {
  let tol = tolerance;
  let out = simplifyClosed(p, tol);
  while (out.length / 2 > maxPoints) {
    tol *= 1.5;
    out = simplifyClosed(p, tol);
  }
  return out;
}
