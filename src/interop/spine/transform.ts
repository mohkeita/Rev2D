/**
 * Spine setup-pose transform math and the Spine <-> Rev2D coordinate mapping.
 *
 * Matrices use Rev2D's Mat2D layout [a, b, c, d, tx, ty] (x' = a·x + c·y + tx, y' = b·x + d·y + ty):
 * (a, b) is the image of the local x axis, (c, d) of the local y axis.
 *
 * Spine bone local transform (y up, counter-clockwise degrees):
 *   x axis = scaleX · (cos(rotation + shearX), sin(rotation + shearX))
 *   y axis = scaleY · (cos(rotation + 90 + shearY), sin(rotation + 90 + shearY))
 * World transforms compose parent · local for "normal" inheritance; the other inheritance modes
 * replace the parent's linear part as described at spineWorldMatrix.
 *
 * Mapping to Rev2D (canvas pixels, y down, clockwise degrees) with the reflection F = diag(1, -1),
 * an extra uniform scale S and a canvas offset (ox, oy):
 *   canvas point      = C · spine world point,  C = translate(ox, oy) · S · F
 *   Rev2D bone world  = C · spineWorld · (S·F)⁻¹
 *   Rev2D bone local  = (S·F) · spineLocal · (S·F)⁻¹ = TRS(S·x, −S·y, −rotation, scaleX, scaleY)
 * (root bones additionally get the canvas offset). Vertices local to a bone map as (S·F) · v.
 */
import { DEG, invert, multiply } from '../../core/math.js';
import type { Mat2D } from '../../core/types.js';
import type { SpineInherit } from './types.js';

export interface SpineBoneLocal {
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  shearX: number;
  shearY: number;
  inherit: SpineInherit;
}

export interface SpineBoneNode extends SpineBoneLocal {
  /** Parent index (parents come first), -1 for a root bone. */
  parent: number;
}

/** Linear part of a Spine local transform (rotation, scale, shear), no translation. */
function localLinear(rotation: number, scaleX: number, scaleY: number, shearX: number, shearY: number): [number, number, number, number] {
  const rx = (rotation + shearX) * DEG;
  const ry = (rotation + 90 + shearY) * DEG;
  return [Math.cos(rx) * scaleX, Math.sin(rx) * scaleX, Math.cos(ry) * scaleY, Math.sin(ry) * scaleY];
}

/** Spine local matrix (translation, rotation, scale, shear) in Mat2D layout. */
export function spineLocalMatrix(b: Omit<SpineBoneLocal, 'inherit'>): Mat2D {
  const [a, bb, c, d] = localLinear(b.rotation, b.scaleX, b.scaleY, b.shearX, b.shearY);
  return [a, bb, c, d, b.x, b.y];
}

/**
 * World matrix of a bone from its parent's world matrix (null for a root) and its local values:
 * - normal: parent · local.
 * - onlyTranslation: the local linear part alone (only the position follows the parent).
 * - noRotationOrReflection: the parent's linear part without its rotation or reflection (its x-axis
 *   length along the parent's x axis and |det| / that length across it), in a frame turned by the
 *   parent's x-axis angle, then the local transform with that angle subtracted.
 * - noScale / noScaleOrReflection: the bone's x axis points where the parent maps the local rotation
 *   direction, with unit length; the y axis is perpendicular to it (mirrored for noScale when the
 *   parent is mirrored); then the local scale and shear apply.
 * The position is parent · (x, y) in every mode.
 */
export function spineWorldMatrix(parent: Mat2D | null, b: SpineBoneLocal): Mat2D {
  if (!parent) return spineLocalMatrix(b);
  const [pa, pb, pc, pd, ptx, pty] = parent;
  const tx = pa * b.x + pc * b.y + ptx;
  const ty = pb * b.x + pd * b.y + pty;
  switch (b.inherit) {
    case 'onlyTranslation': {
      const [a, bb, c, d] = localLinear(b.rotation, b.scaleX, b.scaleY, b.shearX, b.shearY);
      return [a, bb, c, d, tx, ty];
    }
    case 'noRotationOrReflection': {
      // Parent frame without rotation / reflection: x axis = parent's x axis, y axis perpendicular with |det| area.
      let qa = pa;
      let qb = pb;
      let qc: number;
      let qd: number;
      let prx: number;
      const s2 = pa * pa + pb * pb;
      if (s2 > 1e-4) {
        const s = Math.abs(pa * pd - pb * pc) / s2;
        qc = -pb * s;
        qd = pa * s;
        prx = Math.atan2(pb, pa) / DEG;
      } else {
        qa = 0;
        qb = 0;
        qc = pc;
        qd = pd;
        prx = Math.atan2(pd, pc) / DEG - 90;
      }
      const [la, lb, lc, ld] = localLinear(b.rotation - prx, b.scaleX, b.scaleY, b.shearX, b.shearY);
      return [qa * la + qc * lb, qb * la + qd * lb, qa * lc + qc * ld, qb * lc + qd * ld, tx, ty];
    }
    case 'noScale':
    case 'noScaleOrReflection': {
      const r = b.rotation * DEG;
      const cos = Math.cos(r);
      const sin = Math.sin(r);
      // Direction of the rotated local x axis in the parent frame, normalized.
      let za = pa * cos + pc * sin;
      let zb = pb * cos + pd * sin;
      const len = Math.hypot(za, zb);
      if (len > 1e-5) {
        za /= len;
        zb /= len;
      }
      let s = Math.hypot(za, zb);
      if (b.inherit === 'noScale' && pa * pd - pb * pc < 0) s = -s;
      const r2 = Math.PI / 2 + Math.atan2(zb, za);
      const zc = Math.cos(r2) * s;
      const zd = Math.sin(r2) * s;
      const [la, lb, lc, ld] = localLinear(0, b.scaleX, b.scaleY, b.shearX, b.shearY);
      return [za * la + zc * lb, zb * la + zd * lb, za * lc + zc * ld, zb * lc + zd * ld, tx, ty];
    }
    default: {
      const m = multiply(parent, spineLocalMatrix(b));
      return m;
    }
  }
}

/** Setup-pose world matrices (no constraints applied), in Spine skeleton space. Parents must come first. */
export function computeSpineWorlds(bones: readonly SpineBoneNode[]): Mat2D[] {
  const out: Mat2D[] = [];
  bones.forEach((b, i) => {
    if (b.parent >= i) throw new Error(`computeSpineWorlds: bone ${i} comes before its parent ${b.parent}`);
    out.push(spineWorldMatrix(b.parent >= 0 ? out[b.parent] : null, b));
  });
  return out;
}

/** C = translate(ox, oy) · scale · F: Spine skeleton space -> Rev2D canvas. */
export function spineToCanvas(scale: number, ox: number, oy: number): Mat2D {
  return [scale, 0, 0, -scale, ox, oy];
}

/** (S·F): a vector / local point in Spine units -> Rev2D local units (x·S, −y·S). */
export function spineToRev2dLocal(scale: number): Mat2D {
  return [scale, 0, 0, -scale, 0, 0];
}

/** Rev2D world matrix of a bone from its Spine world matrix: C · W · (S·F)⁻¹. */
export function rev2dWorldFromSpine(spineWorld: Mat2D, canvas: Mat2D, scale: number): Mat2D {
  return multiply(multiply(canvas, spineWorld), invert(spineToRev2dLocal(scale)));
}

/**
 * Rev2D local values of a bone with "normal" inheritance and no shear (exact): TRS(S·x, −S·y,
 * −rotation, scaleX, scaleY). Root bones get the canvas offset added by the caller.
 */
export function rev2dLocalFromSpine(b: Pick<SpineBoneLocal, 'x' | 'y' | 'rotation' | 'scaleX' | 'scaleY'>, scale: number) {
  return { x: b.x * scale, y: -b.y * scale, rotation: -b.rotation, scaleX: b.scaleX, scaleY: b.scaleY };
}

export interface Decomposed {
  x: number;
  y: number;
  /** Angle of the x axis in degrees (atan2 convention of the matrix's own space). */
  rotation: number;
  /** Length of the x axis (> 0). */
  scaleX: number;
  /** Signed extent of the y axis perpendicular to the x axis (det / scaleX; negative = mirrored). */
  scaleY: number;
  /** Angle from the perpendicular of the x axis to the actual y axis, degrees (0 = no shear). */
  shear: number;
}

/** Decompose an affine matrix into translation, rotation, scale and residual shear. */
export function decomposeMatrix(m: Mat2D): Decomposed {
  const [a, b, c, d, x, y] = m;
  const scaleX = Math.hypot(a, b);
  const rotation = Math.atan2(b, a) / DEG;
  const det = a * d - b * c;
  const scaleY = scaleX > 1e-12 ? det / scaleX : Math.hypot(c, d);
  // Expected y axis: x axis turned +90° (in the matrix space), scaled by scaleY.
  let shear = 0;
  if (scaleX > 1e-12 && Math.abs(scaleY) > 1e-12) {
    const ex = (-b / scaleX) * Math.sign(scaleY);
    const ey = (a / scaleX) * Math.sign(scaleY);
    shear = Math.atan2(ex * d - ey * c, ex * c + ey * d) / DEG;
  }
  return { x, y, rotation, scaleX, scaleY, shear };
}


/** Singular value decomposition of a 2x2 linear map: m = R(phi) · diag(sx, sy) · R(theta) (degrees; sy < 0 when m mirrors). */
export interface Svd2 {
  phi: number;
  sx: number;
  sy: number;
  theta: number;
}

/**
 * SVD of the linear part [a, b, c, d] (Mat2D layout: (a, b) = image of x, (c, d) = image of y) in the
 * rotation-scale-rotation form. `prevPhi`: when the scales are (nearly) equal the split between the
 * two rotations is free; keep phi there (default 0).
 */
export function svd2(a: number, b: number, c: number, d: number, prevPhi = 0): Svd2 {
  // Column-major [[a, c], [b, d]]: E, F, G, H of the classic closed form.
  const E = (a + d) / 2;
  const F = (a - d) / 2;
  const G = (b + c) / 2;
  const H = (b - c) / 2;
  const Q = Math.hypot(E, H);
  const R = Math.hypot(F, G);
  const a2 = Math.atan2(H, E);
  if (R <= 1e-12 * Math.max(1, Q)) {
    // Uniform scale (no shear): any split works; keep phi.
    const phi = prevPhi;
    return { phi, sx: Q, sy: Q, theta: a2 / DEG - phi };
  }
  const a1 = Math.atan2(G, F);
  return { phi: (a2 + a1) / 2 / DEG, sx: Q + R, sy: Q - R, theta: (a2 - a1) / 2 / DEG };
}

/**
 * The SVD among the equivalent forms (phi + 90k with the scales swapped for odd k, theta - 90k) whose
 * angles are closest to `prev` (continuity between samples), angles unwrapped next to prev's.
 */
export function svd2Near(m: [number, number, number, number], prev: Svd2): Svd2 {
  const base = svd2(m[0], m[1], m[2], m[3], prev.phi);
  const unwrap = (v: number, near: number) => v + 360 * Math.round((near - v) / 360);
  let best: Svd2 = base;
  let bestCost = Infinity;
  for (let k = 0; k < 4; k++) {
    const odd = k % 2 === 1;
    const cand: Svd2 = { phi: unwrap(base.phi + 90 * k, prev.phi), sx: odd ? base.sy : base.sx, sy: odd ? base.sx : base.sy, theta: 0 };
    // Keep phi + theta (the total rotation) exact while theta stays near prev.theta.
    cand.theta = unwrap(base.phi + base.theta - cand.phi, prev.theta);
    const cost = Math.abs(cand.phi - prev.phi) + Math.abs(cand.theta - prev.theta) + 100 * (Math.abs(cand.sx - prev.sx) + Math.abs(cand.sy - prev.sy));
    if (cost < bestCost) {
      bestCost = cost;
      best = cand;
    }
  }
  return best;
}
