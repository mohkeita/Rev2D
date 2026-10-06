/**
 * ModelBuilder: the Rev2D model under construction while an avatar compiles. Feature modules add
 * parameters, textures, warps, parts, bindings, physics and animations through it; it keeps ids
 * unique, declares only the parameters that are asked for (in one standard order), makes the draw
 * order explicit (every part carries a z; the parts array is written back to front) and produces
 * the raw model document. Pure and deterministic.
 */
import type { ModelInput } from '../core/types.js';
import { ID_PATTERN } from '../core/schema.js';
import type { LayerInfo } from './types.js';
import { fieldOffsets, latticeOf, makeLattice, type Field, type Lattice, type LatticeLimits, type RectTuple, type SparseOffsets } from './fields.js';

type Items<K extends keyof ModelInput> = NonNullable<ModelInput[K]> extends Array<infer T> ? T : never;
export type ParameterInput = Items<'parameters'>;
export type TextureInput = Items<'textures'>;
export type WarpInput = Items<'warps'>;
export type PartInput = Items<'parts'>;
export type BindingInput = Items<'bindings'>;
export type PhysicsInput = Items<'physics'>;
export type AnimationInput = Items<'animations'>;

/** A bug in a feature module (duplicate id, unknown reference): never caused by a user's spec. */
export class AvatarBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AvatarBuildError';
  }
}

/**
 * The Live2D standard parameters an avatar may declare (ids, ranges and signs of docs/SPEC.md §3.1,
 * so Live2D motions drive avatars). Their order here is their order in the built model.
 * `L` is the character's left: the eye on the IMAGE RIGHT.
 */
export const STANDARD_PARAMETERS = {
  AngleX: { min: -30, max: 30, default: 0, group: 'Head', description: 'Head turn: + toward the screen right.' },
  AngleY: { min: -30, max: 30, default: 0, group: 'Head', description: 'Head pitch: + looks up.' },
  AngleZ: { min: -30, max: 30, default: 0, group: 'Head', description: 'Head tilt: + clockwise on screen.' },
  EyeLOpen: { min: 0, max: 1, default: 1, group: 'Eyes', description: "The character's left eye (image right): 0 closed, 1 open." },
  EyeROpen: { min: 0, max: 1, default: 1, group: 'Eyes', description: "The character's right eye (image left): 0 closed, 1 open." },
  EyeLSmile: { min: 0, max: 1, default: 0, group: 'Eyes', description: "The character's left eye (image right): 1 = smiling eye." },
  EyeRSmile: { min: 0, max: 1, default: 0, group: 'Eyes', description: "The character's right eye (image left): 1 = smiling eye." },
  EyeBallX: { min: -1, max: 1, default: 0, group: 'Eyes', description: 'Gaze: + toward the screen right.' },
  EyeBallY: { min: -1, max: 1, default: 0, group: 'Eyes', description: 'Gaze: + up.' },
  BrowLY: { min: -1, max: 1, default: 0, group: 'Brows', description: "The character's left brow (image right): + raised, - lowered." },
  BrowRY: { min: -1, max: 1, default: 0, group: 'Brows', description: "The character's right brow (image left): + raised, - lowered." },
  MouthOpen: { min: 0, max: 1, default: 0, group: 'Mouth', description: '0 closed, 1 fully open.' },
  MouthForm: { min: -1, max: 1, default: 0, group: 'Mouth', description: '-1 narrow / round, 0 neutral, +1 wide / smile.' },
  Cheek: { min: 0, max: 1, default: 0, group: 'Face', description: 'Blush strength.' },
  BodyAngleX: { min: -10, max: 10, default: 0, group: 'Body', description: 'Body sway: + leans toward the screen right.' },
  Breath: { min: 0, max: 1, default: 0, group: 'Body', description: '0 exhaled, 1 inhaled.' },
} as const satisfies Record<string, Omit<ParameterInput, 'id'>>;

export type StandardParameterId = keyof typeof STANDARD_PARAMETERS;

const STANDARD_ORDER = Object.keys(STANDARD_PARAMETERS);

/** Most grid cells per side of an image part (the limit of the model format). */
const MAX_IMAGE_CELLS = 64;

/**
 * Draw order of the generated parts (the `z` of a part; ties keep the order they were added in).
 * Each feature owns the range from its entry up to the next one, so features written in parallel
 * never collide: e.g. the eye layers use 20 .. 26, drawn eye sprites 27 .. 29.
 */
export const AVATAR_Z = {
  /** The base image (the whole illustration with the moving layers cut out and filled). */
  base: 0,
  /** Blush ellipses: over the skin, under the eyes and the hair. */
  cheeks: 10,
  /** Eye layers: white underlay, eyeball, lids and lashes. */
  eyes: 20,
  /** Drawn eye sprites (closed / half / smile). */
  eyeSprites: 27,
  /** The mouth patch and the mouth interior. */
  mouth: 30,
  /** Drawn mouth sprites. */
  mouthSprites: 37,
  /** Brow layers, should a feature cut them (the default brows are bindings on the base lattice). */
  brows: 40,
  /** Hair layers: bangs lie over eyes and brows. */
  hair: 50,
  /** Pendulums and other attachments that hang on the head or body. */
  attachments: 60,
  /** Cut-outs in front of everything (a hand over the chin). */
  cutouts: 70,
} as const;

/** A warp added to the model, with its rest lattice. */
export interface WarpHandle {
  id: string;
  lattice: Lattice;
}

/** One keyform of bindField: the parameter values and the displacement field there (omit = rest). */
export interface FieldKey {
  at: number[];
  field?: Field;
}

export interface ModelMeta {
  name: string;
  width: number;
  height: number;
  fps?: number;
  description?: string;
}

export interface WarpOptions extends LatticeLimits {
  id: string;
  /** Parent warp (default: none = model space). */
  parent?: string;
  rect: RectTuple;
  /** Target cell size in px; or give cols / rows. */
  cell?: number;
  cols?: number;
  rows?: number;
  description?: string;
}

export class ModelBuilder {
  private readonly meta: ModelMeta;
  private readonly parameters = new Map<string, ParameterInput>();
  private readonly textures = new Map<string, TextureInput>();
  private readonly warps = new Map<string, WarpInput>();
  private readonly lattices = new Map<string, Lattice>();
  private readonly parts = new Map<string, PartInput>();
  private readonly bindings: BindingInput[] = [];
  private readonly bindingIds = new Set<string>();
  private readonly physicsGroups = new Map<string, PhysicsInput>();
  private readonly animations = new Map<string, AnimationInput>();

  constructor(meta: ModelMeta) {
    this.meta = meta;
  }

  private checkId(kind: string, id: string, taken: boolean): void {
    if (!ID_PATTERN.test(id)) throw new AvatarBuildError(`${kind} id "${id}" is not a valid id (letters, digits, _ and -; not starting with a digit)`);
    if (taken) throw new AvatarBuildError(`${kind} id "${id}" is used twice: every generated ${kind} needs its own id`);
  }

  // --------------------------------------------------------------------------- parameters

  /**
   * Declare a parameter and return its id. A standard id ("AngleX", "EyeLOpen", ...) takes its
   * definition from STANDARD_PARAMETERS; anything else needs the full definition. Declaring the
   * same parameter again is fine (features share AngleX); a different definition is an error.
   * Declare a parameter only when something drives a binding with it.
   */
  parameter(param: StandardParameterId | ParameterInput): string {
    if (typeof param === 'string' && !Object.hasOwn(STANDARD_PARAMETERS, param)) throw new AvatarBuildError(`"${param}" is not a standard parameter: pass its full definition {id, min, max, default}`);
    const def: ParameterInput = typeof param === 'string' ? { id: param, ...STANDARD_PARAMETERS[param] } : param;
    const known = this.parameters.get(def.id);
    if (known) {
      if (known.min !== def.min || known.max !== def.max || (known.default ?? 0) !== (def.default ?? 0)) {
        throw new AvatarBuildError(`parameter "${def.id}" is declared twice with different ranges`);
      }
      return def.id;
    }
    this.checkId('parameter', def.id, false);
    this.parameters.set(def.id, def);
    return def.id;
  }

  hasParameter(id: string): boolean {
    return this.parameters.has(id);
  }

  /** Ids of the declared parameters, in the order they will be written. */
  parameterIds(): string[] {
    return this.sortedParameters().map((p) => p.id);
  }

  private sortedParameters(): ParameterInput[] {
    const rank = (id: string) => {
      const i = STANDARD_ORDER.indexOf(id);
      return i < 0 ? STANDARD_ORDER.length : i;
    };
    // Array.prototype.sort is stable: custom parameters keep their declaration order.
    return [...this.parameters.values()].sort((a, b) => rank(a.id) - rank(b.id));
  }

  // --------------------------------------------------------------------------- textures

  /** Declare the texture of a layer (id = the layer id, path = its file) and return its id. Idempotent. */
  texture(layer: LayerInfo): string {
    const known = this.textures.get(layer.id);
    if (known) {
      if (known.path !== layer.file) throw new AvatarBuildError(`texture id "${layer.id}" is used for two files`);
      return layer.id;
    }
    this.checkId('texture', layer.id, false);
    this.textures.set(layer.id, { id: layer.id, path: layer.file, width: layer.rect[2], height: layer.rect[3] });
    return layer.id;
  }

  // --------------------------------------------------------------------------- warps

  /** Add a warp; its lattice has `cols` x `rows` cells, or cells of about `cell` px. */
  warp(options: WarpOptions): WarpHandle {
    const { id, parent, rect, description } = options;
    this.checkId('warp', id, this.warps.has(id));
    if (parent !== undefined && !this.warps.has(parent)) throw new AvatarBuildError(`warp "${id}": the parent warp "${parent}" does not exist (add parents first)`);
    let lattice: Lattice;
    if (options.cols !== undefined && options.rows !== undefined) lattice = latticeOf(rect, options.cols, options.rows);
    else if (options.cell !== undefined) lattice = makeLattice(rect, options.cell, options);
    else throw new AvatarBuildError(`warp "${id}" needs a cell size or cols and rows`);
    const warp: WarpInput = { id, rect: lattice.rect, cols: lattice.cols, rows: lattice.rows };
    if (parent !== undefined) warp.parent = parent;
    if (description !== undefined) warp.description = description;
    this.warps.set(id, warp);
    this.lattices.set(id, lattice);
    return { id, lattice };
  }

  hasWarp(id: string): boolean {
    return this.warps.has(id);
  }

  /** The handle of a warp added earlier (by any feature). */
  warpHandle(id: string): WarpHandle {
    const lattice = this.lattices.get(id);
    if (!lattice) throw new AvatarBuildError(`unknown warp "${id}"`);
    return { id, lattice };
  }

  // --------------------------------------------------------------------------- parts

  /** Add a part. `z` is required: see AVATAR_Z for the range of each feature. */
  part(part: PartInput & { z: number }): string {
    this.checkId('part', part.id, this.parts.has(part.id));
    if (part.parent !== undefined && !this.warps.has(part.parent)) throw new AvatarBuildError(`part "${part.id}": the parent warp "${part.parent}" does not exist`);
    if (!Number.isFinite(part.z)) throw new AvatarBuildError(`part "${part.id}" needs a finite z`);
    for (const m of part.mask ?? []) {
      if (!this.parts.has(m)) throw new AvatarBuildError(`part "${part.id}": the mask part "${m}" does not exist (add mask parts first)`);
    }
    this.parts.set(part.id, part);
    return part.id;
  }

  /**
   * Add the image of a layer as a part: declares the layer's texture and places it at the layer's
   * rect as a grid mesh. The grid is `cols` x `rows` when given; else cells of about `cell` px;
   * else, when the layer covers exactly its parent warp, the warp's own cells (every mesh vertex
   * is then a lattice point); else the parent's cell size. `id` defaults to the layer id.
   */
  imagePart(layer: LayerInfo, options: Omit<PartInput, 'id' | 'shape'> & { id?: string; z: number; cols?: number; rows?: number; cell?: number }): string {
    const { id = layer.id, cols, rows, cell, parent: parentId, ...rest } = options;
    const [x, y, w, h] = layer.rect;
    const parent = parentId !== undefined ? this.lattices.get(parentId) : undefined;
    const clampCells = (n: number) => Math.max(1, Math.min(MAX_IMAGE_CELLS, Math.round(n)));
    let grid: [number, number];
    if (cols !== undefined && rows !== undefined) grid = [clampCells(cols), clampCells(rows)];
    else if (cell !== undefined) grid = [clampCells(w / cell), clampCells(h / cell)];
    else if (parent && parent.rect[0] === x && parent.rect[1] === y && parent.rect[2] === w && parent.rect[3] === h) grid = [parent.cols, parent.rows];
    else if (parent) grid = [clampCells((w * parent.cols) / parent.rect[2]), clampCells((h * parent.rows) / parent.rect[3])];
    else grid = [1, 1];
    const shape = { type: 'image' as const, texture: this.texture(layer), x, y, w, h, cols: grid[0], rows: grid[1] };
    return this.part({ id, ...(parentId !== undefined ? { parent: parentId } : {}), shape, ...rest });
  }

  hasPart(id: string): boolean {
    return this.parts.has(id);
  }

  /** A part added earlier, to adjust it (e.g. a later feature adds a mask). Undefined when absent. */
  findPart(id: string): PartInput | undefined {
    return this.parts.get(id);
  }

  // --------------------------------------------------------------------------- bindings

  /** Add a binding. Its parameters must be declared; a given id must be new. */
  bind(binding: BindingInput): void {
    for (const p of binding.params) {
      if (!this.parameters.has(p)) throw new AvatarBuildError(`binding on "${binding.target}": the parameter "${p}" is not declared (call model.parameter first)`);
    }
    if (binding.id !== undefined) {
      this.checkId('binding', binding.id, this.bindingIds.has(binding.id));
      this.bindingIds.add(binding.id);
    }
    this.bindings.push(binding);
  }

  /**
   * Bind displacement fields to a warp's offsets: one keyform per `keys` entry (a key without a
   * field is the rest keyform), each sampled at the lattice points and written as a sparse map of
   * the points that move. Bindings on one warp add up, so every motion gets its own binding.
   * Returns the keyform values (for stats and tests); nothing is added when no point moves at all.
   */
  bindField(warp: WarpHandle, binding: { id?: string; params: string[]; keys: FieldKey[]; pinEdges?: boolean; description?: string }): SparseOffsets[] {
    const values = binding.keys.map((k) => (k.field ? fieldOffsets(warp.lattice, k.field, { pinEdges: binding.pinEdges }) : {}));
    if (values.every((v) => Object.keys(v).length === 0)) return values;
    const b: BindingInput = {
      target: `warp:${warp.id}.offsets`,
      params: binding.params,
      keys: binding.keys.map((k, i) => ({ at: k.at, value: values[i] })),
    };
    if (binding.id !== undefined) b.id = binding.id;
    if (binding.description !== undefined) b.description = binding.description;
    this.bind(b);
    return values;
  }

  // --------------------------------------------------------------------------- physics, animations

  physics(group: PhysicsInput): string {
    this.checkId('physics', group.id, this.physicsGroups.has(group.id));
    for (const p of [...group.inputs, ...group.outputs]) {
      if (!this.parameters.has(p.param)) throw new AvatarBuildError(`physics "${group.id}": the parameter "${p.param}" is not declared`);
    }
    this.physicsGroups.set(group.id, group);
    return group.id;
  }

  animation(animation: AnimationInput): string {
    this.checkId('animation', animation.id, this.animations.has(animation.id));
    this.animations.set(animation.id, animation);
    return animation.id;
  }

  hasAnimation(id: string): boolean {
    return this.animations.has(id);
  }

  // --------------------------------------------------------------------------- result

  /** Counts for the build report. */
  stats(): Record<string, number> {
    let latticePoints = 0;
    for (const l of this.lattices.values()) latticePoints += (l.cols + 1) * (l.rows + 1);
    return {
      parameters: this.parameters.size,
      textures: this.textures.size,
      warps: this.warps.size,
      latticePoints,
      parts: this.parts.size,
      bindings: this.bindings.length,
      physics: this.physicsGroups.size,
      animations: this.animations.size,
    };
  }

  /** The raw model document (write it with formatModelJson). Parts are ordered back to front. */
  build(): Record<string, unknown> {
    const parts = [...this.parts.values()]
      .map((part, index) => ({ part, index }))
      .sort((a, b) => (a.part.z ?? 0) - (b.part.z ?? 0) || a.index - b.index)
      .map((p) => p.part);
    const meta: Record<string, unknown> = { name: this.meta.name, width: this.meta.width, height: this.meta.height, background: 'transparent', fps: this.meta.fps ?? 30 };
    if (this.meta.description !== undefined) meta.description = this.meta.description;
    const doc: Record<string, unknown> = { format: 'rev2d', version: 1, meta, parameters: this.sortedParameters() };
    if (this.textures.size) doc.textures = [...this.textures.values()];
    doc.warps = [...this.warps.values()];
    doc.parts = parts;
    doc.bindings = this.bindings;
    if (this.physicsGroups.size) doc.physics = [...this.physicsGroups.values()];
    if (this.animations.size) doc.animations = [...this.animations.values()];
    return doc;
  }
}
