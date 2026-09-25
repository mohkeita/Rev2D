/**
 * Per-frame evaluation (SPEC §9): parameters -> property combination -> bones -> IK -> warps -> parts.
 */
import { clamp01 } from '../color.js';
import { applyToPoints, multiply, rotationOf, scaleOf } from '../math.js';
import type { BonePose, IkPose, Mat2D, PartPose, PathValue, PhysicsPose, Pose, RGBA, Value, WarpPose } from '../types.js';
import { ValueAccumulator, valueToJSON } from '../values.js';
import {
  BONE_LENGTH,
  BONE_ROTATION,
  BONE_SCALE_X,
  BONE_SCALE_Y,
  BONE_STRIDE,
  BONE_X,
  BONE_Y,
  type CompiledPart,
  type CompiledRig,
  type GeometryEntry,
  type Slot,
} from './compiled.js';
import { solveIk, updateWorlds } from './ik.js';
import { deformBatch, dynamicGeometry, type DeformContext } from './parts.js';
import { snapArcFlags } from './paths.js';
import { writePhysicsOutputs, type PhysicsState } from './physics.js';
import { evaluateBinding, evaluateParams, type Contribution, type FrameInputs } from './sampling.js';
import { mapPointsThroughWarp } from './warp.js';

/** Geometry used by each part (index-aligned with the producing rig's parts) for every evaluated pose. */
const poseGeometry = new WeakMap<Pose, { rig: CompiledRig; geometry: GeometryEntry[] }>();

/** Geometry `pose` was evaluated with, if `c` produced it (undefined for clones and other rigs' poses). */
export function geometryOfPose(pose: Pose, c: CompiledRig): GeometryEntry[] | undefined {
  const link = poseGeometry.get(pose);
  return link && link.rig === c ? link.geometry : undefined;
}

/** Final (combined, post-processed) values of all touched slots; undefined = untouched (setup). */
function combineSlots(c: CompiledRig, params: Float64Array, contributions: Contribution[]): Array<Value | undefined> {
  const accs: Array<ValueAccumulator | undefined> = new Array(c.slots.length);
  const acc = (s: number) => (accs[s] ??= new ValueAccumulator(c.slots[s].setup));
  for (const b of c.bindings) acc(b.slot).add(evaluateBinding(b, params));
  for (const k of contributions) acc(k.slot).add(k.value, k.weight);
  return accs.map((a, s) => (a ? postProcess(c.slots[s], a.result()) : undefined));
}

function postProcess(slot: Slot, v: Value): Value {
  switch (slot.post) {
    case 'color': {
      const c = v as RGBA;
      return [clamp01(c[0]), clamp01(c[1]), clamp01(c[2]), clamp01(c[3])];
    }
    case 'unit':
      return clamp01(v as number);
    case 'bool':
      return (v as number) >= 0.5 ? 1 : 0;
    case 'nonneg':
      return Math.max(0, v as number);
    case 'path':
      return snapArcFlags(v as PathValue);
    default:
      return v;
  }
}

interface PartState {
  opacity: Float64Array;
  z: Float64Array;
  visible: Float64Array;
  tint: RGBA[];
}

/**
 * Evaluate a full frame. `physics` (already advanced to the frame's step) overwrites its output params,
 * except those given explicitly.
 */
export function evaluateFrame(
  c: CompiledRig,
  inputs: FrameInputs,
  physics: PhysicsState | null,
  events: Pose['events'],
): Pose {
  // 1-5: parameters (physics outputs are clamped as they are written; explicit values are re-applied).
  const params = new Float64Array(c.params.ids.length);
  const contributions: Contribution[] = [];
  evaluateParams(c, inputs, inputs.time, params, contributions);
  const physicsPose: Record<string, PhysicsPose> = physics ? writePhysicsOutputs(c, physics, inputs, params) : {};

  // 6: bound/animated properties.
  const slotValues = combineSlots(c, params, contributions);
  const local = c.boneSetup.slice();
  const warpOffsets: Array<number[] | undefined> = new Array(c.warps.length);
  const ikMix = Float64Array.from(c.ik, (k) => k.mix);
  const partState: PartState = {
    opacity: Float64Array.from(c.parts, (p) => p.opacity),
    z: Float64Array.from(c.parts, (p) => p.z),
    visible: Float64Array.from(c.parts, (p) => (p.visible ? 1 : 0)),
    tint: c.parts.map((p) => [...p.tint] as RGBA), // copies: poses must not alias compiled state
  };
  const properties: Pose['properties'] = {};
  slotValues.forEach((v, s) => {
    if (v === undefined) return;
    const slot = c.slots[s];
    properties[slot.key] = valueToJSON(v, slot.valueType);
    const t = slot.target;
    switch (t.kind) {
      case 'bone':
        local[t.index * BONE_STRIDE + t.field] = v as number;
        break;
      case 'warp':
        warpOffsets[t.index] = v as number[];
        break;
      case 'ik':
        ikMix[t.index] = v as number;
        break;
      case 'part':
        if (t.prop === 'tint') partState.tint[t.index] = v as RGBA;
        else partState[t.prop][t.index] = v as number;
        break;
      case 'geometry':
        break; // consumed when building part geometry
    }
  });

  // 7-8: bones and IK.
  const world: Mat2D[] = new Array(c.bones.length);
  updateWorlds(c.bones, c.boneOrder, local, world);
  const ikPose: Record<string, IkPose> = {};
  c.ik.forEach((k, i) => {
    ikPose[k.id] = solveIk(k, ikMix[i], c.bones, local, world);
  });
  const boneDeform = c.bones.map((b, i) => multiply(world[i], b.invSetupWorld));

  // 9: warps.
  const warpPoints = evaluateWarps(c, warpOffsets, boneDeform);

  // 10: parts.
  const deform: DeformContext = { boneDeform, warps: c.warps, warpPoints };
  const geometry = c.parts.map((cp) => partGeometry(c, cp, slotValues));
  const parts: Record<string, PartPose> = {};
  const visibleParts: number[] = [];
  c.parts.forEach((cp, i) => {
    const pose = partPose(cp, geometry[i], deform, partState, i);
    parts[cp.id] = pose;
    if (pose.visible) visibleParts.push(i);
  });
  // 11: draw order by (z, array index).
  visibleParts.sort((x, y) => partState.z[x] - partState.z[y] || x - y);

  const pose: Pose = {
    time: inputs.time,
    params: Object.fromEntries(c.params.ids.map((id, i) => [id, params[i]])),
    bones: bonePoses(c, local, world),
    warps: Object.fromEntries(
      c.warps.map((w, i): [string, WarpPose] => [w.id, { points: Float32Array.from(warpPoints[i]), cols: w.cols, rows: w.rows }]),
    ),
    parts,
    drawOrder: visibleParts.map((i) => c.parts[i].id),
    properties,
    events,
    ik: ikPose,
    physics: physicsPose,
  };
  poseGeometry.set(pose, { rig: c, geometry });
  return pose;
}

function bonePoses(c: CompiledRig, local: Float64Array, world: Mat2D[]): Record<string, BonePose> {
  const out: Record<string, BonePose> = {};
  c.bones.forEach((b, i) => {
    const w = world[i];
    const o = i * BONE_STRIDE;
    const length = local[o + BONE_LENGTH];
    const [scaleX, scaleY] = scaleOf(w);
    out[b.id] = {
      world: w,
      x: w[4],
      y: w[5],
      rotation: rotationOf(w),
      scaleX,
      scaleY,
      tip: [w[0] * length + w[4], w[1] * length + w[5]],
      local: {
        x: local[o + BONE_X],
        y: local[o + BONE_Y],
        rotation: local[o + BONE_ROTATION],
        scaleX: local[o + BONE_SCALE_X],
        scaleY: local[o + BONE_SCALE_Y],
        length,
      },
    };
  });
  return out;
}

/** Rest lattice + offsets (setup space), then deformed by the parent bone / warp (parents first). */
function evaluateWarps(c: CompiledRig, offsets: Array<number[] | undefined>, boneDeform: Mat2D[]): Float64Array[] {
  const out: Float64Array[] = new Array(c.warps.length);
  for (const i of c.warpOrder) {
    const w = c.warps[i];
    const pts = w.rest.slice();
    const off = offsets[i];
    if (off) for (let k = 0; k < pts.length; k++) pts[k] += off[k];
    const parent = w.parent;
    if (parent.kind === 'bone') {
      applyToPoints(boneDeform[parent.index], pts, pts);
    } else if (parent.kind === 'warp') {
      const pw = c.warps[parent.index];
      mapPointsThroughWarp(out[parent.index], pw.cols, pw.rows, pw.rect, pts, pts);
    }
    out[i] = pts;
  }
  return out;
}

/** Static geometry, or the (cached) geometry for this frame's effective shape/fill/stroke values. */
export function partGeometry(c: CompiledRig, cp: CompiledPart, slotValues: ArrayLike<Value | undefined>): GeometryEntry {
  if (cp.geometry) return cp.geometry;
  const values = cp.geometrySlots.map((s) => slotValues[s] ?? c.slots[s].setup);
  try {
    return dynamicGeometry(cp, c.slots, values, c.bones, c.textures);
  } catch (e) {
    throw new Error(`Rig: part "${cp.id}": cannot build geometry for the current pose: ${(e as Error).message}`, { cause: e });
  }
}

function partPose(cp: CompiledPart, entry: GeometryEntry, ctx: DeformContext, st: PartState, i: number): PartPose {
  const { fill, stroke } = entry.geometry;
  const fillPos = fill ? deformBatch(cp, fill.positions, entry.fillWeights, ctx) : null;
  const strokePos = stroke ? deformBatch(cp, stroke.positions, entry.strokeWeights, ctx) : null;
  const opacity = st.opacity[i];
  return {
    visible: cp.visible && st.visible[i] >= 0.5 && opacity > 0,
    opacity,
    z: st.z[i],
    tint: st.tint[i],
    bounds: bounds(fillPos, strokePos),
    fill: fillPos,
    stroke: strokePos,
  };
}

function bounds(...batches: Array<Float32Array | null>): [number, number, number, number] | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const pts of batches) {
    if (!pts) continue;
    for (let k = 0; k + 1 < pts.length; k += 2) {
      const x = pts[k];
      const y = pts[k + 1];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x0 === Infinity ? null : [x0, y0, x1 - x0, y1 - y0];
}
