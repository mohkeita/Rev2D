/**
 * Model compilation: resolves every id reference once, orders bones/warps parents-first, precomputes
 * setup transforms, binding grids, sorted animation keys and static part geometry. Assumes a
 * schema-valid model; bad references, cycles and malformed grids throw descriptive Errors.
 */
import { BONE_PROPS, paramDefault, resolveTarget, suggest } from '../address.js';
import { parseColor } from '../color.js';
import { easeFn } from '../easing.js';
import type { BoneSegment } from '../geometry/index.js';
import { apply, fromTRS, invert, multiply } from '../math.js';
import type { Animation, Binding, Mat2D, Model, Part, RawValue, ResolvedTarget, Shape, TextureInfo, Value } from '../types.js';
import { normalizeValue } from '../values.js';
import {
  BONE_LENGTH,
  BONE_STRIDE,
  type CompiledAnimation,
  type CompiledBinding,
  type CompiledBone,
  type CompiledIk,
  type CompiledPart,
  type CompiledPhysics,
  type CompiledRig,
  type CompiledTrack,
  type CompiledWarp,
  type GeometryField,
  type ParentRef,
  type PostOp,
  type Slot,
  type SlotTarget,
} from './compiled.js';
import { keyTangents } from './curves.js';
import { buildGeometryEntry, dynamicGeometry } from './parts.js';
import { restLattice } from './warp.js';

const NO_PARENT: ParentRef = { kind: 'none' };
const NONNEG_SHAPE_FIELDS = new Set(['rx', 'ry', 'w', 'h', 'radius']);

export function compileRig(model: Model, textureSizes: Record<string, TextureInfo>): CompiledRig {
  return new RigCompiler(model, textureSizes).compile();
}

/** Message of an error including the `hint` carried by AddressError / ValueError. */
function describe(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const hint = (e as { hint?: unknown }).hint;
  return typeof hint === 'string' && hint ? `${e.message} (${hint})` : e.message;
}

function wrap<T>(where: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('Rig: ')) throw e;
    throw new Error(`Rig: ${where}: ${describe(e)}`, { cause: e });
  }
}

function indexById(items: readonly { id: string }[], kind: string): Map<string, number> {
  const map = new Map<string, number>();
  items.forEach((item, i) => {
    if (map.has(item.id)) throw new Error(`Rig: duplicate ${kind} id "${item.id}"`);
    map.set(item.id, i);
  });
  return map;
}

function lookup(map: Map<string, number>, id: string, kind: string, where: string): number {
  const i = map.get(id);
  if (i !== undefined) return i;
  const hint = suggest(id, [...map.keys()]);
  throw new Error(`Rig: ${where}: unknown ${kind} "${id}"${hint ? ` (${hint})` : ''}`);
}

/** Parents-first order of a forest given by `parentOf` (-1 = root). Throws on cycles. */
function topoOrder(ids: string[], parentOf: (i: number) => number, kind: string): number[] {
  const state = new Uint8Array(ids.length); // 0 = unvisited, 1 = on current path, 2 = ordered
  const order: number[] = [];
  for (let i = 0; i < ids.length; i++) {
    const path: number[] = [];
    for (let j = i; j >= 0 && state[j] !== 2; j = parentOf(j)) {
      if (state[j] === 1) {
        const cycle = path.slice(path.indexOf(j)).map((k) => ids[k]);
        throw new Error(`Rig: ${kind} parent cycle: ${[...cycle, ids[j]].join(' -> ')}`);
      }
      state[j] = 1;
      path.push(j);
    }
    for (let k = path.length - 1; k >= 0; k--) {
      state[path[k]] = 2;
      order.push(path[k]);
    }
  }
  return order;
}

class RigCompiler {
  private readonly textures: Record<string, TextureInfo>;
  private readonly paramIndex: Map<string, number>;
  private readonly boneIndex: Map<string, number>;
  private readonly warpIndex: Map<string, number>;
  private readonly partIndex: Map<string, number>;
  private readonly ikIndex: Map<string, number>;
  private readonly slots: Slot[] = [];
  private readonly slotByKey = new Map<string, number>();

  constructor(
    private readonly model: Model,
    textureSizes: Record<string, TextureInfo>,
  ) {
    this.textures = {};
    for (const t of model.textures) {
      if (t.width !== undefined && t.height !== undefined) this.textures[t.id] = { width: t.width, height: t.height };
    }
    Object.assign(this.textures, textureSizes);
    this.paramIndex = indexById(model.parameters, 'parameter');
    this.boneIndex = indexById(model.bones, 'bone');
    this.warpIndex = indexById(model.warps, 'warp');
    this.partIndex = indexById(model.parts, 'part');
    this.ikIndex = indexById(model.ik, 'ik constraint');
    indexById(model.textures, 'texture');
    indexById(model.physics, 'physics group');
    indexById(model.animations, 'animation');
  }

  compile(): CompiledRig {
    const { model } = this;
    const params = this.compileParams();
    const { bones, boneOrder, boneSetup } = this.compileBones();
    const { warps, warpOrder } = this.compileWarps(bones);
    const bindings = model.bindings.map((b, i) => this.compileBinding(b, i));
    const animations = new Map(model.animations.map((a) => [a.id, this.compileAnimation(a)] as const));
    const ik = this.compileIk(bones, boneOrder);
    const physics = this.compilePhysics();
    // Parts last: their geometry is static only if no binding/track touches shape, fill or stroke.
    const parts = this.compileParts(bones);
    return {
      model,
      textures: this.textures,
      params,
      bones,
      boneOrder,
      boneSetup,
      warps,
      warpOrder,
      parts,
      partIndex: this.partIndex,
      slots: this.slots,
      bindings,
      animations,
      ik,
      physics,
    };
  }

  private param(id: string, where: string): number {
    return lookup(this.paramIndex, id, 'parameter', where);
  }

  private bone(id: string, where: string): number {
    return lookup(this.boneIndex, id, 'bone', where);
  }

  private compileParams(): CompiledRig['params'] {
    const ps = this.model.parameters;
    return {
      ids: ps.map((p) => p.id),
      index: this.paramIndex,
      min: Float64Array.from(ps, (p) => p.min),
      max: Float64Array.from(ps, (p) => p.max),
      defaults: Float64Array.from(ps, paramDefault),
    };
  }

  private compileBones(): { bones: CompiledBone[]; boneOrder: number[]; boneSetup: Float64Array } {
    const src = this.model.bones;
    const parents = src.map((b) => (b.parent == null ? -1 : this.bone(b.parent, `bone "${b.id}" parent`)));
    const boneOrder = topoOrder(
      src.map((b) => b.id),
      (i) => parents[i],
      'bone',
    );
    const boneSetup = new Float64Array(src.length * BONE_STRIDE);
    const worlds: Mat2D[] = new Array(src.length);
    for (const i of boneOrder) {
      const b = src[i];
      boneSetup.set([b.x, b.y, b.rotation, b.scaleX, b.scaleY, b.length], i * BONE_STRIDE);
      const local = fromTRS(b.x, b.y, b.rotation, b.scaleX, b.scaleY);
      worlds[i] = parents[i] >= 0 ? multiply(worlds[parents[i]], local) : local;
    }
    const bones = src.map((b, i): CompiledBone => {
      const w = worlds[i];
      const [x1, y1] = apply(w, b.length, 0);
      const segment: BoneSegment = { x0: w[4], y0: w[5], x1, y1 };
      return { id: b.id, parent: parents[i], setupWorld: w, invSetupWorld: invert(w), segment };
    });
    return { bones, boneOrder, boneSetup };
  }

  private resolveParent(id: string | null | undefined, bones: CompiledBone[], where: string): ParentRef {
    if (id == null) return NO_PARENT;
    const b = this.boneIndex.get(id);
    const w = this.warpIndex.get(id);
    // SPEC §2: bones and warps share one id namespace for `parent`. The validator reports every shared id
    // (duplicate-id); the rig only fails once such an id is actually referenced as a parent.
    if (b !== undefined && w !== undefined) {
      throw new Error(`Rig: ${where}: parent "${id}" is ambiguous (a bone and a warp share this id; rename one of them)`);
    }
    if (b !== undefined) return { kind: 'bone', index: deformerBone(bones, b, where) };
    if (w !== undefined) return { kind: 'warp', index: w };
    const hint = suggest(id, [...this.boneIndex.keys(), ...this.warpIndex.keys()]);
    throw new Error(`Rig: ${where}: unknown parent "${id}" (not a bone or warp)${hint ? ` (${hint})` : ''}`);
  }

  private compileWarps(bones: CompiledBone[]): { warps: CompiledWarp[]; warpOrder: number[] } {
    const src = this.model.warps;
    const warps = src.map(
      (w): CompiledWarp => ({
        id: w.id,
        parent: this.resolveParent(w.parent, bones, `warp "${w.id}"`),
        rect: [w.rect[0], w.rect[1], w.rect[2], w.rect[3]],
        cols: w.cols,
        rows: w.rows,
        rest: restLattice(w.rect, w.cols, w.rows),
      }),
    );
    const warpOrder = topoOrder(
      warps.map((w) => w.id),
      (i) => {
        const parent = warps[i].parent;
        return parent.kind === 'warp' ? parent.index : -1;
      },
      'warp',
    );
    return { warps, warpOrder };
  }

  // --------------------------------------------------------------------------- slots

  /** Slot for a non-parameter address (created on first use). */
  private slot(target: ResolvedTarget): number {
    const existing = this.slotByKey.get(target.key);
    if (existing !== undefined) return existing;
    const { address } = target;
    const prop = address.prop.join('.');
    let slotTarget: SlotTarget;
    let post: PostOp = 'none';
    switch (address.kind) {
      case 'bone': {
        const field = (BONE_PROPS as readonly string[]).indexOf(prop);
        slotTarget = { kind: 'bone', index: this.boneIndex.get(address.id)!, field };
        if (field === BONE_LENGTH) post = 'nonneg';
        break;
      }
      case 'warp':
        slotTarget = { kind: 'warp', index: this.warpIndex.get(address.id)! };
        break;
      case 'ik':
        slotTarget = { kind: 'ik', index: this.ikIndex.get(address.id)! };
        post = 'unit';
        break;
      case 'part': {
        const index = this.partIndex.get(address.id)!;
        if (prop === 'opacity' || prop === 'z' || prop === 'visible' || prop === 'tint') {
          slotTarget = { kind: 'part', index, prop };
          if (prop === 'opacity') post = 'unit';
        } else {
          const field = prop as GeometryField;
          slotTarget = { kind: 'geometry', index, field };
          const shapeField = field.startsWith('shape.') ? field.slice('shape.'.length) : null;
          if (field === 'stroke.width' || (shapeField && NONNEG_SHAPE_FIELDS.has(shapeField))) post = 'nonneg';
          if (shapeField) this.requireImageSize(this.model.parts[index], shapeField);
        }
        break;
      }
      default:
        throw new Error(`unexpected ${address.kind} target`);
    }
    if (target.valueType === 'color') post = 'color';
    else if (target.valueType === 'boolean') post = 'bool';
    else if (target.valueType === 'path') post = 'path';
    const index = this.slots.length;
    this.slots.push({
      key: target.key,
      valueType: target.valueType,
      setup: target.setup,
      pointCount: target.pointCount,
      post,
      target: slotTarget,
    });
    this.slotByKey.set(target.key, index);
    return index;
  }

  /**
   * An omitted image `w`/`h` without a crop takes the texture size as its setup value (resolveTarget
   * reports 0 when the size is unknown, which would silently collapse the image once bound).
   */
  private requireImageSize(part: Part, field: string): void {
    const shape = part.shape;
    if (shape.type !== 'image' || (field !== 'w' && field !== 'h') || shape[field] !== undefined || shape.crop) return;
    if (!Object.hasOwn(this.textures, shape.texture)) {
      throw new Error(`size of texture "${shape.texture}" is unknown (needed as the setup value of image ${field})`);
    }
  }

  private normalize(raw: RawValue, slot: Slot | ResolvedTarget, where: string): Value {
    return wrap(where, () => normalizeValue(raw, slot));
  }

  // --------------------------------------------------------------------------- bindings

  private compileBinding(b: Binding, i: number): CompiledBinding {
    const where = `bindings[${i}]${b.id ? ` "${b.id}"` : ''} (target "${b.target}")`;
    const target = wrap(where, () => resolveTarget(this.model, b.target, { textures: this.textures }));
    if (target.address.kind === 'param') {
      throw new Error(`Rig: ${where}: parameters cannot be binding targets (animate them with param: tracks)`);
    }
    const slot = wrap(where, () => this.slot(target));
    const params = b.params.map((p) => this.param(p, where));
    const dims = params.length;
    b.keys.forEach((k, ki) => {
      if (k.at.length !== dims) {
        throw new Error(`Rig: ${where}: keys[${ki}].at has ${k.at.length} values, expected ${dims} (one per parameter)`);
      }
    });
    const axes = params.map((_, d) => Float64Array.from(new Set(b.keys.map((k) => k.at[d]))).sort());
    const strides: number[] = [];
    let total = 1;
    for (const axis of axes) {
      strides.push(total);
      total *= axis.length;
    }
    const keyforms: Array<Value | undefined> = new Array(total);
    b.keys.forEach((k, ki) => {
      let idx = 0;
      for (let d = 0; d < dims; d++) idx += axes[d].indexOf(k.at[d]) * strides[d];
      if (keyforms[idx] !== undefined) throw new Error(`Rig: ${where}: duplicate key at [${k.at.join(', ')}]`);
      keyforms[idx] = this.normalize(k.value, this.slots[slot], `${where} keys[${ki}]`);
    });
    const missing = keyforms.findIndex((v) => v === undefined);
    if (missing >= 0) {
      const at = axes.map((axis, d) => axis[Math.floor(missing / strides[d]) % axis.length]);
      throw new Error(
        `Rig: ${where}: keys do not form a full grid (missing key at [${at.join(', ')}]; expected ${total} keys, got ${b.keys.length})`,
      );
    }
    return { slot, params, axes, strides, keyforms: keyforms as Value[], step: b.interpolation === 'step' };
  }

  // --------------------------------------------------------------------------- animations

  private compileAnimation(a: Animation): CompiledAnimation {
    const tracks = a.tracks.map((track, ti): CompiledTrack => {
      const where = `animation "${a.id}" tracks[${ti}] (target "${track.target}")`;
      const target = wrap(where, () => resolveTarget(this.model, track.target, { textures: this.textures }));
      const isParam = target.address.kind === 'param';
      const param = isParam ? this.paramIndex.get(target.address.id)! : -1;
      const slot = isParam ? -1 : wrap(where, () => this.slot(target));
      const norm: Slot | ResolvedTarget = isParam ? target : this.slots[slot];
      const keys = track.keys
        .map((k, ki) => ({ t: k.t, ease: k.ease, v: this.normalize(k.v, norm, `${where} keys[${ki}]`) }))
        .sort((x, y) => x.t - y.t);
      const times = Float64Array.from(keys, (k) => k.t);
      const values = keys.map((k) => k.v);
      const anySmooth = keys.some((k) => k.ease === 'smooth');
      const offset = track.offset ?? 0;
      if (!Number.isFinite(offset)) throw new Error(`Rig: ${where}: offset must be a finite number, got ${offset}`);
      return {
        param,
        slot,
        times,
        values,
        eases: keys.map((k) => (k.ease === 'step' ? null : easeFn(k.ease))),
        smooth: anySmooth ? Uint8Array.from(keys, (k) => (k.ease === 'smooth' ? 1 : 0)) : null,
        tangents: anySmooth ? keyTangents(times, values, a.loop, a.duration) : null,
        offset,
      };
    });
    const events = (a.events ?? [])
      .map((e) => (e.data === undefined ? { t: e.t, name: e.name } : { t: e.t, name: e.name, data: e.data }))
      .sort((x, y) => x.t - y.t);
    return { id: a.id, duration: a.duration, loop: a.loop, tracks, events };
  }

  // --------------------------------------------------------------------------- ik & physics

  private compileIk(bones: CompiledBone[], boneOrder: number[]): CompiledIk[] {
    return this.model.ik.map((k) => {
      const where = `ik "${k.id}"`;
      const chain = k.bones.map((id) => this.bone(id, where));
      if (chain.length === 2 && bones[chain[1]].parent !== chain[0]) {
        throw new Error(`Rig: ${where}: bone "${k.bones[1]}" must be a direct child of "${k.bones[0]}"`);
      }
      const affected = new Uint8Array(bones.length);
      const update: number[] = [];
      for (const b of boneOrder) {
        if (b === chain[0] || (bones[b].parent >= 0 && affected[bones[b].parent])) {
          affected[b] = 1;
          update.push(b);
        }
      }
      return {
        id: k.id,
        bones: chain,
        target: this.bone(k.target, `${where} target`),
        bendPositive: k.bendPositive,
        mix: k.mix,
        stretch: k.stretch ?? false,
        softness: Math.max(0, k.softness ?? 0),
        update,
      };
    });
  }

  private compilePhysics(): CompiledPhysics[] {
    return this.model.physics.map((g) => {
      const where = `physics "${g.id}"`;
      const n = g.segments.length;
      return {
        id: g.id,
        inputs: g.inputs.map((inp) => ({ param: this.param(inp.param, `${where} input`), type: inp.type, weight: inp.weight })),
        outputs: g.outputs.map((out) => {
          if (out.segment >= n) {
            throw new Error(`Rig: ${where}: output segment ${out.segment} out of range (chain has ${n} segments)`);
          }
          return {
            param: this.param(out.param, `${where} output`),
            type: out.type,
            segment: out.segment < 0 ? n - 1 : out.segment,
            scale: out.scale,
          };
        }),
        lengths: g.segments.map((s) => s.length),
        masses: g.segments.map((s) => s.mass),
        gravity: g.gravity,
        damping: g.damping,
        stiffness: g.stiffness,
      };
    });
  }

  // --------------------------------------------------------------------------- parts

  private compileParts(bones: CompiledBone[]): CompiledPart[] {
    const geometrySlots: number[][] = this.model.parts.map(() => []);
    this.slots.forEach((s, i) => {
      if (s.target.kind === 'geometry') geometrySlots[s.target.index].push(i);
    });
    return this.model.parts.map((p, i): CompiledPart => {
      const where = `part "${p.id}"`;
      if (p.skin && p.parent !== undefined) {
        throw new Error(`Rig: ${where}: "skin" and "parent" are mutually exclusive`);
      }
      const skin = p.skin
        ? {
            bones: p.skin.bones.map((id) => deformerBone(bones, this.bone(id, `${where} skin`), `${where} skin`)),
            weights: p.skin.weights,
            falloff: p.skin.falloff,
          }
        : null;
      if (skin && skin.weights !== 'auto') checkExplicitWeights(p.shape, skin.weights, skin.bones.length, where);
      const masks = (p.mask ?? []).map((id) => {
        const m = lookup(this.partIndex, id, 'part', `${where} mask`);
        if (m === i) throw new Error(`Rig: ${where}: a part cannot mask itself`);
        return m;
      });
      const tint = parseColor(p.tint);
      if (!tint) throw new Error(`Rig: ${where}: invalid tint "${p.tint}"`);
      const cp: CompiledPart = {
        id: p.id,
        source: p,
        parent: this.resolveParent(p.parent, bones, where),
        skin,
        masks,
        maskInvert: p.maskInvert,
        blend: p.blend,
        visible: p.visible,
        opacity: p.opacity,
        z: p.z,
        tint,
        geometrySlots: geometrySlots[i],
        geometry: null,
        cache: [],
      };
      if (cp.geometrySlots.length === 0) {
        cp.geometry = wrap(where, () => buildGeometryEntry(p, skin, bones, this.textures));
      } else {
        // Dynamic part: building the rest geometry now reports a bad setup shape at construction
        // (not on the first pose) and warms the cache for the most common value set.
        const setup = cp.geometrySlots.map((s) => this.slots[s].setup);
        wrap(where, () => dynamicGeometry(cp, this.slots, setup, bones, this.textures));
      }
      return cp;
    });
  }
}

/**
 * Index of a bone that attaches setup-space geometry (part / warp parent, skin bone). Its deformation is
 * world · inverse(setupWorld), so the setup world must be invertible (no zero scale in the setup pose).
 */
function deformerBone(bones: CompiledBone[], index: number, where: string): number {
  const b = bones[index];
  const m = b.setupWorld;
  if (Math.abs(m[0] * m[3] - m[1] * m[2]) < 1e-12) {
    throw new Error(
      `Rig: ${where}: bone "${b.id}" has a degenerate setup transform (zero scale), so setup-space geometry cannot be attached to it (give it a non-zero setup scale and bind/animate the scale instead)`,
    );
  }
  return index;
}

function checkExplicitWeights(shape: Shape, rows: number[][], boneCount: number, where: string): void {
  if (shape.type !== 'mesh') {
    throw new Error(`Rig: ${where}: explicit skin weights require a mesh shape (use "auto" for ${shape.type})`);
  }
  const n = shape.vertices.length / 2;
  if (rows.length !== n) throw new Error(`Rig: ${where}: skin has ${rows.length} weight rows, mesh has ${n} vertices`);
  rows.forEach((row, v) => {
    if (row.length !== boneCount) {
      throw new Error(`Rig: ${where}: skin weight row ${v} has ${row.length} values, expected ${boneCount} (one per skin bone)`);
    }
  });
}
