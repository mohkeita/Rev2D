/**
 * IK constraints (SPEC §7): one-bone aim and two-bone law-of-cosines, with optional stretch and
 * (two-bone) softness. Rotations are solved in each bone's parent frame (so scaled or mirrored parents
 * are handled exactly), then blended by `mix` using the shortest angular delta; stretch scales the
 * bones' local scaleX, blended by `mix` too. World matrices of the chain and its descendants are
 * refreshed, and every solve reports its diagnostics (IkPose).
 */
import { DEG, apply, fromTRS, multiply, wrapDeg } from '../math.js';
import type { IkPose, Mat2D } from '../types.js';
import {
  BONE_LENGTH,
  BONE_ROTATION,
  BONE_SCALE_X,
  BONE_SCALE_Y,
  BONE_STRIDE,
  BONE_X,
  BONE_Y,
  type CompiledBone,
  type CompiledIk,
} from './compiled.js';

const EPS = 1e-9;
/** A solved tip within this distance of the target (px) counts as reached. */
const REACHED_TOLERANCE = 0.01;
const IDENTITY: Mat2D = [1, 0, 0, 1, 0, 0];

export function localMatrix(local: Float64Array, b: number): Mat2D {
  const o = b * BONE_STRIDE;
  return fromTRS(local[o + BONE_X], local[o + BONE_Y], local[o + BONE_ROTATION], local[o + BONE_SCALE_X], local[o + BONE_SCALE_Y]);
}

/** Local matrix of bone `b` with its rotation and scaleX replaced. */
function localWith(local: Float64Array, b: number, rotation: number, scaleX: number): Mat2D {
  const o = b * BONE_STRIDE;
  return fromTRS(local[o + BONE_X], local[o + BONE_Y], rotation, scaleX, local[o + BONE_SCALE_Y]);
}

/** Recompute world matrices for `order` (parents first). */
export function updateWorlds(bones: CompiledBone[], order: number[], local: Float64Array, world: Mat2D[]): void {
  for (const b of order) {
    const m = localMatrix(local, b);
    const p = bones[b].parent;
    world[b] = p >= 0 ? multiply(world[p], m) : m;
  }
}

/** Soft distance (SPEC §7): targets beyond maxReach - s are pulled in along a quadratic ease-out. */
export function softDistance(dist: number, maxReach: number, softness: number): number {
  const s = Math.min(softness, maxReach);
  if (!(s > 0)) return dist;
  const x = dist - (maxReach - s);
  if (x <= 0) return dist;
  return x >= 2 * s ? maxReach : dist - (x * x) / (4 * s);
}

/**
 * Solve `ik` with the given mix, updating local rotations / scales and the affected world matrices in
 * place. Returns the constraint's diagnostics (computed even when mix <= 0, which changes nothing).
 */
export function solveIk(ik: CompiledIk, mix: number, bones: CompiledBone[], local: Float64Array, world: Mat2D[]): IkPose {
  const target = world[ik.target];
  const tx = target[4];
  const ty = target[5];
  const solve = ik.bones.length === 1 ? solveOne(ik, tx, ty, bones, local, world) : solveTwo(ik, tx, ty, bones, local, world);
  const m = mix > 0 ? Math.min(1, mix) : 0;
  let changed = false;
  if (m > 0) {
    for (const [b, rotation, scaleX] of solve.full) {
      const o = b * BONE_STRIDE;
      const dr = wrapDeg(rotation - local[o + BONE_ROTATION]);
      const sx = local[o + BONE_SCALE_X];
      if (dr !== 0) local[o + BONE_ROTATION] += m * dr;
      if (scaleX !== sx) local[o + BONE_SCALE_X] = sx + m * (scaleX - sx);
      changed ||= dr !== 0 || scaleX !== sx;
    }
  }
  if (changed) updateWorlds(bones, ik.update, local, world);

  const last = ik.bones[ik.bones.length - 1];
  const [tipX, tipY] = apply(world[last], local[last * BONE_STRIDE + BONE_LENGTH], 0);
  const pose: IkPose = {
    reached: Math.hypot(solve.tip[0] - tx, solve.tip[1] - ty) <= REACHED_TOLERANCE,
    error: Math.hypot(tipX - tx, tipY - ty),
    distance: solve.distance,
    maxReach: solve.maxReach,
    extension: solve.maxReach > EPS ? solve.distance / solve.maxReach : 0,
  };
  if (ik.bones.length === 2) {
    const bend = interiorAngle(world[ik.bones[0]], world[ik.bones[1]], tipX, tipY);
    if (bend !== null) pose.bend = bend;
  }
  if (ik.stretch) pose.stretch = 1 + m * (solve.stretch - 1);
  return pose;
}

/** Interior angle (degrees) at the middle joint between the root joint and the tip; null if degenerate. */
function interiorAngle(aw: Mat2D, bw: Mat2D, tipX: number, tipY: number): number | null {
  const ux = aw[4] - bw[4];
  const uy = aw[5] - bw[5];
  const vx = tipX - bw[4];
  const vy = tipY - bw[5];
  if (Math.hypot(ux, uy) < EPS || Math.hypot(vx, vy) < EPS) return null;
  return Math.abs(Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)) / DEG;
}

interface FullSolve {
  /** [bone, full local rotation, full local scaleX] for every chain bone (mix = 1). */
  full: Array<[number, number, number]>;
  /** World tip of the full (mix = 1) solution. */
  tip: [number, number];
  distance: number;
  maxReach: number;
  /** Stretch factor of the full solution (1 = none). */
  stretch: number;
}

function parentWorld(bones: CompiledBone[], world: Mat2D[], b: number): Mat2D {
  const p = bones[b].parent;
  return p >= 0 ? world[p] : IDENTITY;
}

/**
 * Local rotation (degrees) that makes bone `b`'s +x axis point along world direction (dx, dy), given
 * its parent's world matrix `pw`. Null when the direction or the parent frame is degenerate.
 */
function aimRotation(pw: Mat2D, local: Float64Array, b: number, dx: number, dy: number): number | null {
  if (Math.hypot(dx, dy) < EPS) return null;
  const det = pw[0] * pw[3] - pw[1] * pw[2];
  if (Math.abs(det) < 1e-12) return null;
  // Direction in the parent frame (inverse of the linear part).
  const lx = (pw[3] * dx - pw[2] * dy) / det;
  const ly = (-pw[1] * dx + pw[0] * dy) / det;
  const rot = Math.atan2(ly, lx) / DEG;
  return local[b * BONE_STRIDE + BONE_SCALE_X] < 0 ? rot + 180 : rot;
}

/** World length of bone `b` for a given world matrix. */
function worldLength(local: Float64Array, b: number, w: Mat2D): number {
  return local[b * BONE_STRIDE + BONE_LENGTH] * Math.hypot(w[0], w[1]);
}

/** One bone: aim +x at the target; with stretch, scale x so the tip reaches an out-of-reach target. */
function solveOne(ik: CompiledIk, tx: number, ty: number, bones: CompiledBone[], local: Float64Array, world: Mat2D[]): FullSolve {
  const b = ik.bones[0];
  const o = b * BONE_STRIDE;
  const w = world[b];
  const pw = parentWorld(bones, world, b);
  const length = local[o + BONE_LENGTH];
  const distance = Math.hypot(tx - w[4], ty - w[5]);
  const rotation = aimRotation(pw, local, b, tx - w[4], ty - w[5]) ?? local[o + BONE_ROTATION];
  const sx = local[o + BONE_SCALE_X];
  // Reach along the solved direction (equals the current world length unless the parent shears / scales non-uniformly).
  const maxReach = worldLength(local, b, multiply(pw, localWith(local, b, rotation, sx)));
  const stretch = ik.stretch && maxReach > EPS && distance > maxReach ? distance / maxReach : 1;
  const fullWorld = multiply(pw, localWith(local, b, rotation, sx * stretch));
  return { full: [[b, rotation, sx * stretch]], tip: apply(fullWorld, length, 0), distance, maxReach, stretch };
}

/**
 * Two bones: law of cosines on l1 = |parent joint -> child joint| and l2 = child length × world x
 * scale, for the (softened) target distance. With stretch, the solution for the soft distance is
 * scaled by stretch = distance / soft distance (no softness: distance / maxReach beyond reach) via the
 * first bone's scaleX (inherited by the child) and the child's scaleX, corrected so the child's world
 * length is exactly stretch × l2.
 */
function solveTwo(ik: CompiledIk, tx: number, ty: number, bones: CompiledBone[], local: Float64Array, world: Mat2D[]): FullSolve {
  const [a, b] = ik.bones;
  const aw = world[a];
  const bw = world[b];
  const jax = aw[4];
  const jay = aw[5];
  const oa = a * BONE_STRIDE;
  const ob = b * BONE_STRIDE;
  const rotA = local[oa + BONE_ROTATION];
  const rotB = local[ob + BONE_ROTATION];
  const sxA = local[oa + BONE_SCALE_X];
  const sxB = local[ob + BONE_SCALE_X];
  const distance = Math.hypot(tx - jax, ty - jay);
  // Segment 1: parent joint -> child joint (includes any child offset inside the parent frame).
  const l1 = Math.hypot(bw[4] - jax, bw[5] - jay);
  // Segment 2: child length, scaled by the child's world x scale.
  const l2 = worldLength(local, b, bw);
  const maxReach = l1 + l2;
  const soft = softDistance(distance, maxReach, ik.softness);
  let stretch = 1;
  if (ik.stretch && maxReach > EPS && soft > EPS && distance > soft + EPS) stretch = distance / soft;
  else if (ik.stretch && maxReach > EPS && distance > maxReach) stretch = distance / maxReach;

  const pw = parentWorld(bones, world, a);
  // The first bone's scaleX factor that makes l1 exactly stretch × l1: only the component of the
  // child joint offset along the bone (X) scales, the perpendicular one (Y) stays.
  let stretchA = stretch;
  if (stretch !== 1) {
    const X = Math.abs(local[ob + BONE_X]) * Math.hypot(aw[0], aw[1]);
    const Y = Math.abs(local[ob + BONE_Y]) * Math.hypot(aw[2], aw[3]);
    if (X > EPS) stretchA = Math.sqrt(Math.max(0, stretch * stretch * (X * X + Y * Y) - Y * Y)) / X;
  }
  const fullSxA = sxA * stretchA;
  if (distance < EPS) {
    // Target on the root joint: nothing to aim at.
    const tip = apply(bw, local[ob + BONE_LENGTH], 0);
    return { full: [[a, rotA, sxA], [b, rotB, sxB]], tip, distance, maxReach, stretch: 1 };
  }
  const ux = (tx - jax) / distance;
  const uy = (ty - jay) / distance;

  // The stretched first bone moves the child joint: measure l1 again in that configuration.
  const awS = multiply(pw, localWith(local, a, rotA, fullSxA));
  const bwS = multiply(awS, localMatrix(local, b));
  const l1s = Math.hypot(bwS[4] - jax, bwS[5] - jay);
  const l2s = l2 * stretch;
  const d = Math.min(l1s + l2s, Math.max(Math.abs(l1s - l2s), soft * stretch));
  const tipX = jax + ux * d;
  const tipY = jay + uy * d;

  let fullA = rotA;
  if (l1s >= EPS) {
    // Elbow: rotate the target direction by the law-of-cosines angle. bendPositive = the child bends
    // clockwise in its own (parent-bone) frame, so a mirrored frame flips the world bend side.
    const cosA = Math.max(-1, Math.min(1, (l1s * l1s + d * d - l2s * l2s) / (2 * l1s * d)));
    const mirrored = awS[0] * awS[3] - awS[1] * awS[2] < 0;
    const side = (ik.bendPositive ? 1 : -1) * (mirrored ? -1 : 1);
    const theta = -side * Math.acos(cosA);
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    const ex = ux * c - uy * s;
    const ey = ux * s + uy * c;
    const current = aimRotation(pw, local, a, bwS[4] - jax, bwS[5] - jay);
    const desired = aimRotation(pw, local, a, ex, ey);
    if (current !== null && desired !== null) fullA += desired - current;
  }

  // Child: aim at the (reach-clamped) tip from where the fully solved parent puts the child joint.
  const awFull = multiply(pw, localWith(local, a, fullA, fullSxA));
  const bwFull = multiply(awFull, localMatrix(local, b));
  const fullB = aimRotation(awFull, local, b, tipX - bwFull[4], tipY - bwFull[5]) ?? rotB;
  let fullSxB = sxB;
  if (stretch !== 1) {
    // Correct the child's scaleX so its world length is stretch × l2 whatever it inherits from the parent.
    const len = worldLength(local, b, multiply(awFull, localWith(local, b, fullB, sxB)));
    if (len > EPS) fullSxB = sxB * (l2s / len);
  }
  const bwSolved = multiply(awFull, localWith(local, b, fullB, fullSxB));
  const tip = apply(bwSolved, local[ob + BONE_LENGTH], 0);
  return { full: [[a, fullA, fullSxA], [b, fullB, fullSxB]], tip, distance, maxReach, stretch };
}
