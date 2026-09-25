/**
 * bind_warp: turn high-level poses (yaw/pitch turn, scale, rotate, translate) into full
 * "warp:<id>.offsets" keyforms. This is the helper for Live2D-style head turns: bind a face warp
 * to AngleX/AngleY with a few poses instead of hand-writing every control point offset.
 *
 * Per control point p (rest position in the warp rect, setup space), in this order:
 *   1. yaw / pitch (pseudo-3D): u = normalized x across the rect in [-1, 1] (0 = centre column),
 *        phi = asin(clamp(0.98 u, -1, 1))       // angle on a virtual cylinder; 0.98 keeps edges off the asin pole
 *        u'  = sin(clamp(phi + yaw, -90°, 90°)) / 0.98
 *        x'  = centreX + u' · w/2               // yaw 0 => u' = u exactly (identity)
 *      Positive yaw turns toward +x: content shifts right and the far (+x) side compresses; points
 *      that would pass the limb stop there instead of folding over. Pitch does the same vertically
 *      with v and h (positive = look down, content shifts +y).
 *   2. scale about the pivot (default: rect centre),
 *   3. rotate about the pivot (degrees, clockwise-positive on screen),
 *   4. translate,
 *   5. optional raw "offsets" (sparse map or full list) added on top.
 * offset = final position − rest position.
 */
import { clamp, DEG } from '../core/math.js';
import { compactJson } from '../core/validate/text.js';
import { WarpSchema } from '../core/schema.js';
import { normalizeValue } from '../core/values.js';
import type { OpContext } from './context.js';
import { requireItem, resolveRaw } from './model.js';
import { validPoint } from './bones.js';
import { checkGrid, checkKeyFields, checkParams, checkValue, readAt, readInterpolation, upsertBinding } from './values.js';
import { clean, describe, type Fields, fmt, isObject, OpError, q } from './util.js';

/** High-level pose of a warp lattice for one keyform (all fields optional; none = rest). */
export interface WarpKeyPose {
  /** Pseudo-3D horizontal turn in degrees (positive = toward +x). The op accepts -90 < yaw < 90. */
  yaw?: number;
  /** Pseudo-3D vertical turn in degrees (positive = look down, toward +y). The op accepts -90 < pitch < 90. */
  pitch?: number;
  /** Uniform or [sx, sy] scale about the pivot (the op rejects 0). */
  scale?: number | [number, number];
  /** Rotation about the pivot, degrees clockwise. */
  rotate?: number;
  /** Pivot for scale/rotate in setup space. Default: rect centre. */
  pivot?: [number, number];
  /** Final translation in px. */
  translate?: [number, number];
}

/** Keeps the edge columns (|u| = 1) off the asin pole so they still move under a turn. */
const EDGE = 0.98;

/** Turn a normalized coordinate (-1..1 across the rect) by `deg` on a virtual cylinder. */
function turn(u: number, deg: number): number {
  const phi = Math.asin(clamp(u * EDGE, -1, 1));
  return Math.sin(clamp(phi + deg * DEG, -Math.PI / 2, Math.PI / 2)) / EDGE;
}

/**
 * Offsets (from rest) of every lattice control point for a pose: flat [dx0, dy0, dx1, dy1, ...],
 * row-major (index = row * (cols + 1) + col), rounded to 1e-4 px.
 */
export function warpPoseOffsets(rect: readonly [number, number, number, number], cols: number, rows: number, pose: WarpKeyPose): number[] {
  const [x0, y0, w, h] = rect;
  const cx = x0 + w / 2;
  const cy = y0 + h / 2;
  const [px, py] = pose.pivot ?? [cx, cy];
  const [sx, sy] = typeof pose.scale === 'number' ? [pose.scale, pose.scale] : (pose.scale ?? [1, 1]);
  const r = (pose.rotate ?? 0) * DEG;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const [tx, ty] = pose.translate ?? [0, 0];
  const out: number[] = [];
  for (let row = 0; row <= rows; row++) {
    for (let col = 0; col <= cols; col++) {
      const restX = x0 + (w * col) / cols;
      const restY = y0 + (h * row) / rows;
      const x = pose.yaw ? cx + (turn((restX - cx) / (w / 2), pose.yaw) * w) / 2 : restX;
      const y = pose.pitch ? cy + (turn((restY - cy) / (h / 2), pose.pitch) * h) / 2 : restY;
      const dx = (x - px) * sx;
      const dy = (y - py) * sy;
      out.push(clean(px + cos * dx - sin * dy + tx - restX, 4), clean(py + sin * dx + cos * dy + ty - restY, 4));
    }
  }
  return out;
}

const KEY_FIELDS = ['at', 'yaw', 'pitch', 'scale', 'rotate', 'pivot', 'translate', 'offsets'] as const;

function readPose(k: Record<string, unknown>, where: string): WarpKeyPose {
  const pose: WarpKeyPose = {};
  for (const field of ['yaw', 'pitch', 'rotate'] as const) {
    const v = k[field];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new OpError(`${where}.${field} must be a number of degrees, got ${describe(v)}`);
    // At ±90° every column (row) sits on the limb of the virtual cylinder: the lattice collapses.
    if (field !== 'rotate' && Math.abs(v) >= 90) {
      throw new OpError(
        `${where}.${field} must be between -90 and 90 degrees (exclusive), got ${v}`,
        `a turn of ±90° shows the lattice edge-on (every ${field === 'yaw' ? 'column' : 'row'} on the limb); head turns typically use 10 to 30`,
      );
    }
    pose[field] = v;
  }
  for (const field of ['pivot', 'translate'] as const) {
    const v = k[field];
    if (v === undefined) continue;
    if (!validPoint(v)) throw new OpError(`${where}.${field} must be [x, y], got ${describe(v)}`);
    pose[field] = v;
  }
  const s = k.scale;
  if (s !== undefined) {
    const ok = (typeof s === 'number' && Number.isFinite(s)) || validPoint(s);
    if (!ok) throw new OpError(`${where}.scale must be a number or [sx, sy], got ${describe(s)}`, 'e.g. "scale": 1.1 or [1.05, 0.95]');
    if (s === 0 || (Array.isArray(s) && s.includes(0))) throw new OpError(`${where}.scale must not be 0 (it collapses the lattice), got ${compactJson(s)}`, 'use 1 for no scaling, e.g. "scale": [1.05, 0.95]');
    pose.scale = s as number | [number, number];
  }
  return pose;
}

export function opBindWarp(ctx: OpContext, f: Fields): string {
  const { doc } = ctx;
  const warpId = f.string('warp', 'warp id');
  const { item } = requireItem(doc, 'warp', warpId);
  const parsed = WarpSchema.safeParse(item);
  if (!parsed.success) throw new OpError(`bind_warp: warp ${q(warpId)} is not valid (${parsed.error.issues[0].message} at ${parsed.error.issues[0].path.join('.') || 'the warp'})`, 'fix the warp first (rect [x, y, w, h] with positive w/h, integer cols/rows)');
  const { rect, cols, rows } = parsed.data;
  const params = checkParams(doc, f);
  const rawKeys = f.array('keys', '[{"at": [...], "yaw"?: deg, ...}]');
  if (!rawKeys.length) throw new OpError('bind_warp: "keys" is empty', 'give one pose per grid point, e.g. [{"at": [-30], "yaw": -25}, {"at": [0]}, {"at": [30], "yaw": 25}]');
  const target = `warp:${warpId}.offsets`;
  const { resolved } = resolveRaw(doc, target, 'bind_warp');

  const keys = rawKeys.map((k, j) => {
    const where = `bind_warp: keys[${j}]`;
    if (!isObject(k)) throw new OpError(`${where} must be an object like {"at": [0], "yaw": 20}, got ${describe(k)}`);
    checkKeyFields(k, KEY_FIELDS, where);
    const at = readAt(k.at, params, where);
    const value = warpPoseOffsets(rect, cols, rows, readPose(k, where));
    if (k.offsets !== undefined) {
      checkValue(k.offsets, resolved, `${where}.offsets`);
      const extra = normalizeValue(k.offsets as Parameters<typeof normalizeValue>[0], resolved) as number[];
      for (let i = 0; i < value.length; i++) value[i] = clean(value[i] + extra[i], 4);
    }
    return { at, value };
  });
  checkGrid('bind_warp', params, keys);

  let max = 0;
  let maxAt: number[] = keys[0].at;
  for (const k of keys) {
    for (let i = 0; i < k.value.length; i += 2) {
      const d = Math.hypot(k.value[i], k.value[i + 1]);
      if (d > max) {
        max = d;
        maxAt = k.at;
      }
    }
  }
  const points = (cols + 1) * (rows + 1);
  const detail = `; ${points} control points per keyform, largest displacement ${fmt(max)} px${max > 0 ? ` (at [${maxAt.join(', ')}])` : ''}`;
  return upsertBinding(
    doc,
    {
      target,
      key: target,
      params,
      keys,
      interpolation: readInterpolation(f),
      id: f.optString('id', 'binding id'),
      description: f.optString('description', 'note'),
    },
    detail,
  );
}
