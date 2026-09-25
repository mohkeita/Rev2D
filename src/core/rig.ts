/**
 * Rig: compiled model + evaluation (parameters, animations, physics, bindings, bones, IK, warps,
 * part deformation) and render-list construction. Implementation lives in ./rig/:
 *   compiled.ts  index-resolved rig structures
 *   compile.ts   model -> compiled structures, static geometry
 *   sampling.ts  inputs, animation sampling, parameter evaluation, binding grids
 *   physics.ts   60 Hz pendulum chains
 *   ik.ts        one/two-bone IK
 *   warp.ts      lattice mapping
 *   parts.ts     part geometry (static / per effective values), skin weights, deformation
 *   paths.ts     bound SVG path values
 *   evaluate.ts  per-frame pipeline -> Pose
 *   events.ts    animation events
 *   render.ts    Pose -> RenderList
 */
import { suggest } from './address.js';
import { apply, multiply } from './math.js';
import type { Model, Pose, PoseOptions, RenderList, TextureInfo } from './types.js';
import type { CompiledPart, CompiledRig } from './rig/compiled.js';
import { compileRig } from './rig/compile.js';
import { evaluateFrame } from './rig/evaluate.js';
import { frameEvents, layerEventsBetween } from './rig/events.js';
import { physicsAt, type PhysicsState } from './rig/physics.js';
import { pointSkinWeights, skinPoints } from './rig/parts.js';
import { buildRenderListFor } from './rig/render.js';
import { layerTime, resolveInputs, type FrameInputs } from './rig/sampling.js';
import { mapThroughWarp } from './rig/warp.js';

export { mapThroughWarp };

export interface RigOptions {
  /** Texture sizes by id. Missing sizes fall back to Texture.width/height from the model. */
  textures?: Record<string, TextureInfo>;
}

export class Rig {
  readonly model: Model;
  /** @internal Index-resolved model used by the evaluator. */
  readonly compiled: CompiledRig;

  /** Compile a schema-valid model. Throws a descriptive Error on bad references, cycles or bad grids. */
  constructor(model: Model, opts: RigOptions = {}) {
    this.model = model;
    this.compiled = compileRig(model, opts.textures ?? {});
  }

  /**
   * Stateless evaluation at `opts.time`. Physics (when enabled) is simulated from rest over at most the
   * 60 s before `time` (from t=0 when time <= 60). Explicit `opts.params` win over animation and physics.
   */
  pose(opts: PoseOptions = {}): Pose {
    const c = this.compiled;
    const inputs = resolveInputs(c, opts);
    const physics = inputs.physics ? physicsAt(c, null, inputs) : null;
    return evaluateFrame(c, inputs, physics, frameEvents(inputs));
  }

  /** Stateful sequential playback (incremental physics, event crossing). */
  player(): Player {
    return new Player(this);
  }

  /**
   * Where does the setup-space point (x, y) end up in `pose` when it is attached to `parent`? Uses exactly
   * the deformation the vertices of a part attached there receive:
   * - a bone id: world · setupWorld⁻¹ (rigid follow);
   * - a warp id: bilinear mapping through the deformed lattice (nested parent warps / bones included);
   * - a part id: that part's deformation. A skinned part blends its skin bones (linear blend skinning)
   *   with the weights the point would get as one of its vertices: auto weights from the distances to
   *   the bones' setup segments with the part's `falloff`, or the explicit row of the nearest setup mesh
   *   vertex. A part with `parent` maps like that parent; a part in model space leaves the point as is;
   * - null: model space (unchanged).
   * A bare id is looked up among bones and warps first, then parts (a part may share its id with a bone
   * or warp); prefix it with "part:", "bone:" or "warp:" to choose the kind explicitly.
   * Throws on an unknown or ambiguous id (with a did-you-mean hint) and on non-finite coordinates.
   */
  mapPoint(pose: Pose, parent: string | null, x: number, y: number): [number, number] {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`Rig.mapPoint: x and y must be finite numbers, got (${x}, ${y})`);
    if (parent == null) return [x, y];
    const c = this.compiled;
    const colon = parent.indexOf(':');
    const kind = colon < 0 ? null : parent.slice(0, colon);
    const id = colon < 0 ? parent : parent.slice(colon + 1);
    if (kind !== null && kind !== 'bone' && kind !== 'warp' && kind !== 'part') {
      throw new Error(`Rig.mapPoint: unknown parent kind "${kind}" in "${parent}" (use a bare id, or prefix it with "bone:", "warp:" or "part:")`);
    }
    const bone = kind === null || kind === 'bone' ? c.bones.findIndex((b) => b.id === id) : -1;
    const warp = kind === null || kind === 'warp' ? c.warps.findIndex((w) => w.id === id) : -1;
    if (bone >= 0 && warp >= 0) {
      throw new Error(`Rig.mapPoint: parent "${id}" is ambiguous (a bone and a warp share this id; rename one of them, or write "bone:${id}" / "warp:${id}")`);
    }
    if (bone >= 0) {
      const b = pose.bones[id];
      if (!b) throw new Error(`Rig.mapPoint: the pose has no bone "${id}" (pass a pose evaluated by this rig)`);
      return apply(multiply(b.world, c.bones[bone].invSetupWorld), x, y);
    }
    if (warp >= 0) {
      const w = pose.warps[id];
      if (!w) throw new Error(`Rig.mapPoint: the pose has no warp "${id}" (pass a pose evaluated by this rig)`);
      const cw = c.warps[warp];
      return mapThroughWarp(w.points, cw.cols, cw.rows, cw.rect, x, y);
    }
    const part = kind === null || kind === 'part' ? c.partIndex.get(id) : undefined;
    if (part !== undefined) return this.mapThroughPart(pose, c.parts[part], x, y);
    const noun = kind === null ? 'a bone, warp or part' : `a ${kind}`;
    const options = [
      ...(kind === null || kind === 'bone' ? c.bones.map((b) => b.id) : []),
      ...(kind === null || kind === 'warp' ? c.warps.map((w) => w.id) : []),
      ...(kind === null || kind === 'part' ? c.parts.map((p) => p.id) : []),
    ];
    const hint = suggest(id, options);
    throw new Error(`Rig.mapPoint: unknown parent "${parent}" (not ${noun} id)${hint ? ` (${hint})` : ''}`);
  }

  /** mapPoint through a part: linear blend skinning for a skinned part, else the part's parent. */
  private mapThroughPart(pose: Pose, cp: CompiledPart, x: number, y: number): [number, number] {
    const c = this.compiled;
    if (!cp.skin) {
      const parent = cp.parent;
      if (parent.kind === 'none') return [x, y];
      const id = parent.kind === 'bone' ? c.bones[parent.index].id : c.warps[parent.index].id;
      return this.mapPoint(pose, `${parent.kind}:${id}`, x, y);
    }
    const mats = cp.skin.bones.map((b) => {
      const id = c.bones[b].id;
      const bp = pose.bones[id];
      if (!bp) throw new Error(`Rig.mapPoint: the pose has no bone "${id}" (skin bone of part "${cp.id}"; pass a pose evaluated by this rig)`);
      return multiply(bp.world, c.bones[b].invSetupWorld);
    });
    const weights = pointSkinWeights(cp.skin, cp.source.shape, c.bones, x, y);
    const out = new Float64Array(2);
    skinPoints(mats, weights, [x, y], out);
    return [out[0], out[1]];
  }
}

export class Player {
  constructor(readonly rig: Rig) {}
  /** Current time of the physics state. */
  time = 0;
  private physics: PhysicsState | null = null;
  /** Unwrapped layer times of the previous update, keyed by layer slot ("index:animationId"). */
  private layerTimes = new Map<string, number>();

  reset(): void {
    this.time = 0;
    this.physics = null;
    this.layerTimes.clear();
  }

  /**
   * Evaluate at opts.time, stepping physics forward from the previous call. Resets if time goes
   * backwards; a jump forward of more than 60 s restarts physics from rest 60 s before the new time
   * (exactly like a stateless pose).
   */
  update(opts: PoseOptions): Pose {
    const c = this.rig.compiled;
    const inputs = resolveInputs(c, opts);
    if (inputs.time < this.time) this.reset();
    if (inputs.physics) this.physics = physicsAt(c, this.physics, inputs);
    const events = this.crossedEvents(inputs);
    this.time = inputs.time;
    return evaluateFrame(c, inputs, inputs.physics ? this.physics : null, events);
  }

  /**
   * Events crossed since the previous update, per layer. A layer seen for the first time (or whose own
   * clock jumped backwards) reports only the events exactly at its current time.
   */
  private crossedEvents(inputs: FrameInputs): Pose['events'] {
    const events: Pose['events'] = [];
    const next = new Map<string, number>();
    inputs.layers.forEach((layer, i) => {
      const key = `${i}:${layer.anim.id}`;
      const cur = layerTime(layer, inputs, inputs.time);
      layerEventsBetween(layer, this.layerTimes.get(key), cur, events);
      next.set(key, cur);
    });
    this.layerTimes = next;
    return events;
  }
}

export interface RenderListOptions {
  /** Override meta.background. */
  background?: string;
}

/**
 * Draw items for a pose: visible parts in draw order (fill, then stroke), colors = paint × tint with
 * alpha × tint alpha × opacity, masks attached as the mask parts' own paint geometry.
 * Positions are the pose's arrays; indices, uvs and mask colors are shared with the rig's compiled
 * geometry. Treat all arrays as read-only.
 */
export function buildRenderList(rig: Rig, pose: Pose, opts: RenderListOptions = {}): RenderList {
  return buildRenderListFor(rig.compiled, pose, opts.background);
}
