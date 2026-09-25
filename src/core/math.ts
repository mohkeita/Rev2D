import type { Mat2D } from './types.js';

export const DEG = Math.PI / 180;

export function identity(): Mat2D {
  return [1, 0, 0, 1, 0, 0];
}

/** out = m * n (apply n first, then m). */
export function multiply(m: Mat2D, n: Mat2D): Mat2D {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function invert(m: Mat2D): Mat2D {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return identity();
  const id = 1 / det;
  return [
    m[3] * id,
    -m[1] * id,
    -m[2] * id,
    m[0] * id,
    (m[2] * m[5] - m[3] * m[4]) * id,
    (m[1] * m[4] - m[0] * m[5]) * id,
  ];
}

/** translate(x,y) * rotate(deg) * scale(sx,sy). */
export function fromTRS(x: number, y: number, rotationDeg: number, sx: number, sy: number): Mat2D {
  const r = rotationDeg * DEG;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c * sx, s * sx, -s * sy, c * sy, x, y];
}

export function apply(m: Mat2D, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Transform a flat point list into `out` (may alias `pts`). */
export function applyToPoints(m: Mat2D, pts: ArrayLike<number>, out: Float32Array | Float64Array | number[]): void {
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const x = pts[i];
    const y = pts[i + 1];
    out[i] = m[0] * x + m[2] * y + m[4];
    out[i + 1] = m[1] * x + m[3] * y + m[5];
  }
}

/** World rotation in degrees of the matrix x axis. */
export function rotationOf(m: Mat2D): number {
  return Math.atan2(m[1], m[0]) / DEG;
}

export function scaleOf(m: Mat2D): [number, number] {
  return [Math.hypot(m[0], m[1]), Math.hypot(m[2], m[3])];
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Normalize an angle in degrees to (-180, 180]. */
export function wrapDeg(a: number): number {
  let r = a % 360;
  if (r <= -180) r += 360;
  else if (r > 180) r -= 360;
  return r;
}
