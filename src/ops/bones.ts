/**
 * Bone transforms on the raw document: local TRS with schema defaults, setup world transforms
 * (SPEC §3.2: world = parentWorld · translate · rotate · scale, no IK), TRS decomposition and
 * world-preserving reparenting.
 */
import type { Mat2D } from '../core/types.js';
import { apply, DEG, fromTRS, identity, invert, multiply } from '../core/math.js';
import { formatQuotedList, referenceHint } from '../core/validate/text.js';
import { canonicalTarget, type Doc, findItem, idsOf, type Item, itemKeys, sectionItems, setOrdered } from './model.js';
import { clean, fmt, fmtPoint, isObject, OpError, q } from './util.js';

export const TRS_FIELDS = ['x', 'y', 'rotation', 'scaleX', 'scaleY'] as const;
export type TrsField = (typeof TRS_FIELDS)[number];
export type Trs = Record<TrsField, number>;

const DEFAULTS: Trs = { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 };

/** Local TRS of a raw bone (missing fields take their schema defaults). */
export function boneTrs(bone: Item): Trs {
  const out = { ...DEFAULTS };
  for (const f of TRS_FIELDS) {
    const v = bone[f];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new OpError(`bone ${q(String(bone.id))} has a non-numeric "${f}" (${JSON.stringify(v)})`, `fix it first, e.g. {"op": "update", "kind": "bone", "id": ${q(String(bone.id))}, "set": {"${f}": ${DEFAULTS[f]}}}`);
    }
    out[f] = v;
  }
  return out;
}

export function trsMatrix(t: Trs): Mat2D {
  return fromTRS(t.x, t.y, t.rotation, t.scaleX, t.scaleY);
}

export function parentOf(bone: Item): string | undefined {
  return typeof bone.parent === 'string' ? bone.parent : undefined;
}

/** The bone `id` as a parent; a warp id gets a precise error (bones can only hang from bones). */
export function requireBoneParent(doc: Doc, id: string): Item {
  const found = findItem(doc, 'bone', id);
  if (found) return found.item;
  const bones = idsOf(doc, 'bone');
  if (findItem(doc, 'warp', id)) {
    throw new OpError(
      `${q(id)} is a warp, but a bone's parent must be a bone`,
      `warps deform parts and other warps and cannot carry bones; ${bones.length ? `known bones: ${formatQuotedList(bones, 10)}` : 'no bones are defined'}`,
    );
  }
  throw new OpError(`unknown parent bone ${q(id)}`, referenceHint(id, bones, 'bones'));
}

/** Setup world transform of a bone (identity for `undefined` = model space). Used for parent frames. */
export function setupWorld(doc: Doc, id: string | undefined): Mat2D {
  let m = identity();
  const seen = new Set<string>();
  for (let cur = id; cur !== undefined; ) {
    if (seen.has(cur)) throw new OpError(`bone parent cycle through ${q(cur)}`, 'remove "parent" from one of the bones in the cycle');
    seen.add(cur);
    const item = requireBoneParent(doc, cur);
    m = multiply(trsMatrix(boneTrs(item)), m);
    cur = parentOf(item);
  }
  return m;
}

/**
 * Inverse of the setup world transform of `parent` (the frame a child bone's local values live
 * in). Fails when that frame has collapsed to zero scale, since no local value maps into it.
 * `action` and `fallback` phrase the error for the calling op.
 */
export function invertParentWorld(doc: Doc, parent: string | undefined, action: string, fallback: string): Mat2D {
  const m = setupWorld(doc, parent);
  if (parent === undefined || Math.abs(m[0] * m[3] - m[1] * m[2]) > 1e-12) return invert(m);
  // Name the first bone up the chain whose own scale is zero (the product can also underflow).
  let culprit = parent;
  for (let cur: string | undefined = parent; cur !== undefined; ) {
    const bone = requireBoneParent(doc, cur);
    const t = boneTrs(bone);
    if (Math.abs(t.scaleX * t.scaleY) < 1e-12) {
      culprit = cur;
      break;
    }
    cur = parentOf(bone);
  }
  throw new OpError(
    `cannot ${action} the frame of bone ${q(parent)}: its setup world transform has zero scale (collapsed by bone ${q(culprit)})`,
    `${fallback}, or give ${q(culprit)} a non-zero scaleX and scaleY first`,
  );
}

/** Setup-space point -> local position under `parent` (bone id or undefined for root). */
export function worldToLocal(doc: Doc, parent: string | undefined, world: [number, number]): [number, number] {
  const inverse = invertParentWorld(doc, parent, 'convert a world position into', 'give local "x"/"y" instead of "world"');
  const [x, y] = apply(inverse, world[0], world[1]);
  return [clean(x), clean(y)];
}

/**
 * Setup-space rotation (degrees, the direction of the bone's +x axis on screen) -> local rotation
 * under `parent`. Exact for any parent frame, including rotated, non-uniformly scaled and mirrored
 * ones: the bone's local +x direction is the world direction mapped back through the parent's
 * setup world transform. A bone with negative `scaleX` points the other way along its axis, so it
 * gets 180° more.
 */
export function worldRotationToLocal(doc: Doc, parent: string | undefined, worldRotation: number, scaleX: number): number {
  const inverse = invertParentWorld(doc, parent, 'convert a world rotation into', 'give local "rotation" instead of "worldRotation"');
  const c = Math.cos(worldRotation * DEG);
  const s = Math.sin(worldRotation * DEG);
  const flip = scaleX < 0 ? -1 : 1;
  const dx = flip * (inverse[0] * c + inverse[2] * s);
  const dy = flip * (inverse[1] * c + inverse[3] * s);
  const local = Math.atan2(dy, dx) / DEG;
  // Pick the equivalent angle closest to the plain difference (exact for rotation-only parents).
  const m = setupWorld(doc, parent);
  const parentRotation = Math.atan2(m[1], m[0]) / DEG;
  const mirrored = m[0] * m[3] - m[1] * m[2] < 0;
  const near = (mirrored ? parentRotation - worldRotation : worldRotation - parentRotation) + (flip < 0 ? 180 : 0);
  return clean(unwrapNear(local, near));
}

/** Setup-space rotation of a bone's +x axis, from its parent frame and local rotation / scaleX. */
export function localRotationToWorld(doc: Doc, parent: string | undefined, rotation: number, scaleX: number): number {
  const m = multiply(setupWorld(doc, parent), trsMatrix({ x: 0, y: 0, rotation, scaleX, scaleY: 1 }));
  return clean(Math.atan2(m[1], m[0]) / DEG);
}

export interface Decomposed extends Trs {
  /** True when the matrix has shear, which a TRS bone cannot represent (result is approximate). */
  sheared: boolean;
}

/**
 * Split an affine matrix into translate · rotate · scale (rotation from the x axis). A matrix has
 * two such splits (scaleX s, rotation r) and (-s, r + 180°, -scaleY); the one whose scaleX has the
 * sign of `nearScaleX` is returned, with the rotation closest to `nearRotation`, so a frame change
 * that only moves a mirrored bone keeps it mirrored.
 */
export function decompose(m: Mat2D, nearRotation = 0, nearScaleX = 1): Decomposed {
  const [a, b, c, d, tx, ty] = m;
  let scaleX = Math.hypot(a, b);
  let r = scaleX > 1e-12 ? Math.atan2(b, a) / DEG : 0;
  let scaleY = d * Math.cos(r * DEG) - c * Math.sin(r * DEG);
  const shear = a * c + b * d;
  if (nearScaleX < 0) {
    scaleX = -scaleX;
    scaleY = -scaleY;
    r += 180;
  }
  return {
    x: tx,
    y: ty,
    rotation: unwrapNear(r, nearRotation),
    scaleX,
    scaleY,
    sheared: Math.abs(shear) > 1e-9 * Math.max(1, Math.abs(scaleX * scaleY)),
  };
}

/** The angle equivalent to `deg` (mod 360) closest to `near`. */
export function unwrapNear(deg: number, near: number): number {
  return deg + 360 * Math.round((near - deg) / 360);
}

export function validNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function validPoint(v: unknown): v is [number, number] {
  return Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
}

/** Write TRS values; fields that are absent and equal their default stay absent. */
export function writeTrs(bone: Item, t: Trs): void {
  const order = itemKeys('bone');
  for (const f of TRS_FIELDS) {
    const v = clean(t[f]);
    if (Object.hasOwn(bone, f) || v !== DEFAULTS[f]) setOrdered(bone, f, v, order);
  }
}

function describeTrsChange(before: Trs, after: Trs): string {
  const parts: string[] = [];
  if (clean(before.x) !== clean(after.x) || clean(before.y) !== clean(after.y)) parts.push(`local ${fmtPoint(before.x, before.y)} → ${fmtPoint(after.x, after.y)}`);
  for (const f of ['rotation', 'scaleX', 'scaleY'] as const) if (clean(before[f]) !== clean(after[f])) parts.push(`${f} ${fmt(before[f])} → ${fmt(after[f])}`);
  return parts.length ? parts.join(', ') : 'local transform unchanged';
}

/**
 * Re-express `bone` in a new parent frame so its setup world pose is unchanged:
 * newLocal = frameChange · oldLocal, where frameChange = inverse(newParentWorld) · oldParentWorld.
 * Keyform values of bindings and animation tracks on the bone's x/y/rotation/scaleX/scaleY are
 * remapped the same way (each value treated as an alternative setup value), so the motion they
 * produce is kept; values that cannot be remapped exactly (the new frame mixes x and y, or
 * introduces shear) are remapped per component and reported as approximate.
 * Returns a message fragment describing the change.
 */
export function reexpressBone(doc: Doc, bone: Item, frameChange: Mat2D): string {
  const before = boneTrs(bone);
  const after = decompose(multiply(frameChange, trsMatrix(before)), before.rotation, before.scaleX);
  // Keep the rotation offset stable across keyforms: new = old + (after - before) modulo 360.
  const rotationShift = after.rotation - before.rotation;
  writeTrs(bone, after);
  const notes: string[] = [describeTrsChange(before, after)];
  if (after.sheared) notes.push('approximate: the new parent frame shears this bone (non-uniform parent scale with rotation), shear dropped');

  const id = String(bone.id);
  const remapped: string[] = [];
  const approximate = new Set<string>();
  const remap = (field: TrsField, v: unknown): unknown => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return v;
    // A scaleX keyform keeps its own sign (a flip stays a flip); others follow the new setup split.
    const m = decompose(multiply(frameChange, trsMatrix({ ...before, [field]: v })), field === 'rotation' ? v + rotationShift : after.rotation, field === 'scaleX' ? v : after.scaleX);
    const exact =
      !m.sheared &&
      TRS_FIELDS.every((g) => g === field || Math.abs((g === 'rotation' ? unwrapNear(m[g], after[g]) : m[g]) - after[g]) < 1e-6);
    if (!exact) approximate.add(`bone:${id}.${field}`);
    return clean(m[field]);
  };
  forEachTransformKeyform(doc, id, (field, holder, key) => {
    holder[key] = remap(field, holder[key]);
    remapped.push(`bone:${id}.${field}`);
  });
  if (remapped.length) {
    const counts = new Map<string, number>();
    for (const r of remapped) counts.set(r, (counts.get(r) ?? 0) + 1);
    notes.push(`remapped ${[...counts].map(([k, n]) => `${n} keyform value${n === 1 ? '' : 's'} of ${k}`).join(', ')}`);
  }
  if (approximate.size) {
    notes.push(`WARNING: ${[...approximate].join(', ')} could only be remapped approximately (the new parent frame mixes axes); check the motion`);
  }
  return notes.join('; ');
}

/** Visit every numeric keyform value (bindings `keys[].value`, tracks `keys[].v`) on a bone's TRS fields. */
function forEachTransformKeyform(doc: Doc, boneId: string, visit: (field: TrsField, holder: Item, key: string) => void): void {
  const fieldOf = (target: unknown): TrsField | undefined => {
    const canon = canonicalTarget(target);
    if (canon === undefined || !canon.startsWith(`bone:${boneId}.`)) return undefined;
    const prop = canon.slice(`bone:${boneId}.`.length);
    return (TRS_FIELDS as readonly string[]).includes(prop) ? (prop as TrsField) : undefined;
  };
  for (const b of sectionItems(doc, 'binding') ?? []) {
    const field = isObject(b) ? fieldOf(b.target) : undefined;
    if (field && Array.isArray(b.keys)) for (const k of b.keys) if (isObject(k)) visit(field, k, 'value');
  }
  for (const a of sectionItems(doc, 'animation') ?? []) {
    if (!isObject(a) || !Array.isArray(a.tracks)) continue;
    for (const t of a.tracks) {
      const field = isObject(t) ? fieldOf(t.target) : undefined;
      if (field && Array.isArray(t.keys)) for (const k of t.keys) if (isObject(k)) visit(field, k, 'v');
    }
  }
}

/** True when `ancestor` is `id` or one of its bone ancestors (cycle-safe). */
export function isBoneAncestor(doc: Doc, ancestor: string, id: string): boolean {
  const seen = new Set<string>();
  for (let cur: string | undefined = id; cur !== undefined && !seen.has(cur); ) {
    if (cur === ancestor) return true;
    seen.add(cur);
    const found = findItem(doc, 'bone', cur);
    cur = found ? parentOf(found.item) : undefined;
  }
  return false;
}
