/**
 * Overlay geometry helpers (pure): adaptive grid spacing, mesh edge extraction and bone glyphs.
 */

export interface GridSpacing {
  /** Model units between minor lines. */
  minor: number;
  /** Model units between labelled major lines (a multiple of minor). */
  major: number;
}

/**
 * Grid spacing on a 1-2-5 ladder: minor lines at least `minPx` CSS px apart at `zoom`; major lines on
 * the next nice number (10 -> 50, 20 -> 100, 50 -> 100), doubled until they are at least 4 * minPx
 * apart so their coordinate labels never collide.
 */
export function gridSpacing(zoom: number, minPx = 12): GridSpacing {
  const minor = niceCeil(minPx / Math.max(zoom, 1e-9));
  const mantissa = minor / 10 ** Math.floor(Math.log10(minor) + 1e-9);
  let major = Math.abs(mantissa - 5) < 1e-6 ? minor * 2 : minor * 5;
  while (major * zoom < minPx * 4) major *= 2;
  return { minor, major };
}

/** Smallest number >= v of the form {1, 2, 5} x 10^n. */
export function niceCeil(v: number): number {
  if (!(v > 0) || !Number.isFinite(v)) return 1;
  const exp = Math.floor(Math.log10(v));
  const base = 10 ** exp;
  for (const m of [1, 2, 5, 10]) {
    if (m * base >= v * (1 - 1e-9)) return m * base;
  }
  return 10 * base;
}

/** Multiples of `step` within [start, end] (inclusive), computed from integer indices (no drift). */
export function gridLines(start: number, end: number, step: number, maxLines = 2000): number[] {
  if (!(step > 0) || !(end >= start)) return [];
  const i0 = Math.ceil(start / step - 1e-9);
  const i1 = Math.floor(end / step + 1e-9);
  const out: number[] = [];
  for (let i = i0; i <= i1 && out.length < maxLines; i++) out.push(roundTo(i * step, step));
  return out;
}

/** Round away float noise relative to the step, e.g. 0.30000000000000004 -> 0.3. */
function roundTo(v: number, step: number): number {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  return Number(v.toFixed(Math.min(decimals, 12)));
}

/** Coordinate label for a grid line, with just enough decimals for the step. */
export function formatCoord(v: number, step: number): string {
  const decimals = step >= 1 ? 0 : Math.min(6, Math.ceil(-Math.log10(step) - 1e-9));
  const s = v.toFixed(decimals);
  return s === '-0' ? '0' : s;
}

/** Unique undirected edges of a triangle list as flat vertex index pairs [a0, b0, a1, b1, ...]. */
export function uniqueEdges(indices: ArrayLike<number>): Uint32Array {
  const seen = new Set<string>();
  const out: number[] = [];
  const add = (a: number, b: number): void => {
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(a, b);
  };
  for (let t = 0; t + 2 < indices.length; t += 3) {
    add(indices[t], indices[t + 1]);
    add(indices[t + 1], indices[t + 2]);
    add(indices[t + 2], indices[t]);
  }
  return Uint32Array.from(out);
}

/**
 * Outline edges of a triangle list: edges used by exactly one triangle, as flat index pairs. For
 * meshes whose duplicated vertices share positions (e.g. image grids), the result is still the
 * silhouette because interior edges appear twice.
 */
export function boundaryEdges(indices: ArrayLike<number>): Uint32Array {
  const count = new Map<string, [number, number, number]>();
  const add = (a: number, b: number): void => {
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    const e = count.get(key);
    if (e) e[2]++;
    else count.set(key, [a, b, 1]);
  };
  for (let t = 0; t + 2 < indices.length; t += 3) {
    add(indices[t], indices[t + 1]);
    add(indices[t + 1], indices[t + 2]);
    add(indices[t + 2], indices[t]);
  }
  const out: number[] = [];
  for (const [a, b, n] of count.values()) if (n === 1) out.push(a, b);
  return Uint32Array.from(out);
}

/**
 * Spine-style bone glyph in screen space: a kite from the joint to the tip, widest at 15% of the
 * length. Returns [jx, jy, sideA x, y, tx, ty, sideB x, y], or null when the bone is shorter than
 * `minLength` px (drawn as a joint marker only).
 */
export function boneGlyph(
  jx: number,
  jy: number,
  tx: number,
  ty: number,
  maxWidth = 7,
  minLength = 4,
): number[] | null {
  const dx = tx - jx;
  const dy = ty - jy;
  const len = Math.hypot(dx, dy);
  if (len < minLength) return null;
  const ux = dx / len;
  const uy = dy / len;
  const w = Math.min(maxWidth, len * 0.18);
  const bx = jx + dx * 0.15;
  const by = jy + dy * 0.15;
  // Normal (-uy, ux) points to one side.
  return [jx, jy, bx - uy * w, by + ux * w, tx, ty, bx + uy * w, by - ux * w];
}

/** Lattice polylines (rows then columns) of a warp's control points, as flat [x0,y0,...] lists. */
export function latticePolylines(points: ArrayLike<number>, cols: number, rows: number): number[][] {
  const stride = cols + 1;
  const lines: number[][] = [];
  for (let r = 0; r <= rows; r++) {
    const line: number[] = [];
    for (let c = 0; c <= cols; c++) line.push(points[(r * stride + c) * 2], points[(r * stride + c) * 2 + 1]);
    lines.push(line);
  }
  for (let c = 0; c <= cols; c++) {
    const line: number[] = [];
    for (let r = 0; r <= rows; r++) line.push(points[(r * stride + c) * 2], points[(r * stride + c) * 2 + 1]);
    lines.push(line);
  }
  return lines;
}
