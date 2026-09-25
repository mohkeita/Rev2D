/**
 * Bilinear lattice mapping used by warp deformers (SPEC §3.3). A point is located in the REST rect,
 * then re-expressed with the same (u, v) inside the deformed cell. Points outside the rect use the
 * nearest edge cell's bilinear formula, which extrapolates linearly.
 */

type Rect = readonly [number, number, number, number];

/** Map a single setup-space point through a deformed lattice. `points` is row-major [x0,y0,...]. */
export function mapThroughWarp(
  points: ArrayLike<number>,
  cols: number,
  rows: number,
  rect: Rect,
  x: number,
  y: number,
): [number, number] {
  const out: [number, number] = [0, 0];
  mapPoint(points, cols, rows, rect, x, y, out, 0);
  return out;
}

/** Map a flat point list through a deformed lattice into `out` (may alias `src`). */
export function mapPointsThroughWarp(
  points: ArrayLike<number>,
  cols: number,
  rows: number,
  rect: Rect,
  src: ArrayLike<number>,
  out: Float32Array | Float64Array,
): void {
  for (let i = 0; i + 1 < src.length; i += 2) mapPoint(points, cols, rows, rect, src[i], src[i + 1], out, i);
}

function mapPoint(
  points: ArrayLike<number>,
  cols: number,
  rows: number,
  rect: Rect,
  x: number,
  y: number,
  out: { [i: number]: number },
  o: number,
): void {
  const u = ((x - rect[0]) / rect[2]) * cols;
  const v = ((y - rect[1]) / rect[3]) * rows;
  const c = u < 0 ? 0 : u >= cols ? cols - 1 : Math.floor(u);
  const r = v < 0 ? 0 : v >= rows ? rows - 1 : Math.floor(v);
  const fu = u - c;
  const fv = v - r;
  const i00 = (r * (cols + 1) + c) * 2;
  const i10 = i00 + 2;
  const i01 = i00 + (cols + 1) * 2;
  const i11 = i01 + 2;
  const w00 = (1 - fu) * (1 - fv);
  const w10 = fu * (1 - fv);
  const w01 = (1 - fu) * fv;
  const w11 = fu * fv;
  out[o] = w00 * points[i00] + w10 * points[i10] + w01 * points[i01] + w11 * points[i11];
  out[o + 1] = w00 * points[i00 + 1] + w10 * points[i10 + 1] + w01 * points[i01 + 1] + w11 * points[i11 + 1];
}

/** Rest lattice points of a warp in setup space (row-major). */
export function restLattice(rect: Rect, cols: number, rows: number): Float64Array {
  const out = new Float64Array((cols + 1) * (rows + 1) * 2);
  let k = 0;
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      out[k++] = rect[0] + (rect[2] * c) / cols;
      out[k++] = rect[1] + (rect[3] * r) / rows;
    }
  }
  return out;
}
