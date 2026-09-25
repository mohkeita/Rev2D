/**
 * Property addresses: "kind:id.prop.sub" — the one grammar used by bindings, animation tracks,
 * CLI `--set`, ops and MCP tools.
 *
 *   param:AngleX               parameter value (animation tracks only)
 *   bone:head.rotation         bone x | y | rotation | scaleX | scaleY | length
 *   warp:face.offsets          warp control point offsets (points)
 *   part:mouth.opacity         part opacity | z | tint | visible | fill | stroke.color | stroke.width
 *   part:mouth.shape.ry        any bindable shape field (see SHAPE_FIELDS)
 *   ik:armIk.mix               IK mix
 */
import type { Address, Model, ResolvedTarget, Shape, TargetKind, TextureInfo, Value, ValueType } from './types.js';
import { parseColor } from './color.js';
import { tryParsePath } from './path.js';

const KINDS: TargetKind[] = ['param', 'bone', 'warp', 'part', 'ik'];

export const BONE_PROPS = ['x', 'y', 'rotation', 'scaleX', 'scaleY', 'length'] as const;
export const WARP_PROPS = ['offsets'] as const;
export const PART_PROPS = ['opacity', 'z', 'tint', 'visible', 'fill', 'stroke.color', 'stroke.width'] as const;
export const IK_PROPS = ['mix'] as const;

/** Bindable fields per shape type and their value types. */
export const SHAPE_FIELDS: Record<string, Record<string, ValueType>> = {
  ellipse: { cx: 'number', cy: 'number', rx: 'number', ry: 'number', rotation: 'number' },
  rect: { x: 'number', y: 'number', w: 'number', h: 'number', radius: 'number' },
  polygon: { points: 'points' },
  path: { d: 'path' },
  mesh: { vertices: 'points' },
  image: { x: 'number', y: 'number', w: 'number', h: 'number' },
};

export class AddressError extends Error {
  constructor(
    message: string,
    public hint?: string,
  ) {
    super(message);
  }
}

export function parseAddress(s: string): Address {
  const colon = s.indexOf(':');
  if (colon < 0) throw new AddressError(`address "${s}" has no kind prefix`, `use "kind:id.prop", kinds: ${KINDS.join(', ')}`);
  const kind = s.slice(0, colon) as TargetKind;
  if (!KINDS.includes(kind)) {
    throw new AddressError(`unknown address kind "${kind}"`, suggest(kind, KINDS) ?? `kinds: ${KINDS.join(', ')}`);
  }
  const rest = s.slice(colon + 1);
  const [id, ...prop] = rest.split('.');
  if (!id) throw new AddressError(`address "${s}" has an empty id`);
  if (kind === 'param' && prop.length) throw new AddressError(`param addresses have no property: use "param:${id}"`);
  if (kind !== 'param' && prop.length === 0) {
    throw new AddressError(`address "${s}" needs a property, e.g. "${kind}:${id}.${defaultProp(kind)}"`);
  }
  return { kind, id, prop };
}

export function formatAddress(a: Address): string {
  return a.prop.length ? `${a.kind}:${a.id}.${a.prop.join('.')}` : `${a.kind}:${a.id}`;
}

function defaultProp(kind: TargetKind): string {
  return kind === 'bone' ? 'rotation' : kind === 'warp' ? 'offsets' : kind === 'part' ? 'opacity' : 'mix';
}

export interface ResolveTargetOptions {
  /**
   * Known texture sizes by id (e.g. decoded images). They take precedence over Texture.width/height in
   * the model and supply the setup value of an image shape's omitted `w`/`h`.
   */
  textures?: Record<string, TextureInfo>;
}

/**
 * Resolve an address against a normalized model: checks existence, the property, and returns the
 * value type and setup value. Throws AddressError with a did-you-mean hint on failure.
 *
 * The setup value of an omitted image `w`/`h` is what the image is drawn with: the crop size, else the
 * texture size (from `opts.textures`, else the model's Texture.width/height), else 0 when unknown.
 */
export function resolveTarget(model: Model, addr: string | Address, opts: ResolveTargetOptions = {}): ResolvedTarget {
  const address = typeof addr === 'string' ? parseAddress(addr) : addr;
  const key = formatAddress(address);
  const prop = address.prop.join('.');
  const fail = (msg: string, options: string[], got: string): never => {
    throw new AddressError(msg, suggest(got, options) ?? (options.length ? `valid: ${options.join(', ')}` : undefined));
  };

  switch (address.kind) {
    case 'param': {
      const p = model.parameters.find((q) => q.id === address.id);
      if (!p) fail(`unknown parameter "${address.id}"`, model.parameters.map((q) => q.id), address.id);
      return { address, key, valueType: 'number', setup: paramDefault(p!) };
    }
    case 'bone': {
      const b = model.bones.find((q) => q.id === address.id);
      if (!b) fail(`unknown bone "${address.id}"`, model.bones.map((q) => q.id), address.id);
      if (!(BONE_PROPS as readonly string[]).includes(prop)) fail(`bone has no property "${prop}"`, [...BONE_PROPS], prop);
      return { address, key, valueType: 'number', setup: (b as any)[prop] as number };
    }
    case 'warp': {
      const w = model.warps.find((q) => q.id === address.id);
      if (!w) fail(`unknown warp "${address.id}"`, model.warps.map((q) => q.id), address.id);
      if (prop !== 'offsets') fail(`warp has no property "${prop}"`, [...WARP_PROPS], prop);
      const count = (w!.cols + 1) * (w!.rows + 1);
      return { address, key, valueType: 'points', setup: new Array(count * 2).fill(0), pointCount: count };
    }
    case 'ik': {
      const k = model.ik.find((q) => q.id === address.id);
      if (!k) fail(`unknown ik constraint "${address.id}"`, model.ik.map((q) => q.id), address.id);
      if (prop !== 'mix') fail(`ik has no property "${prop}"`, [...IK_PROPS], prop);
      return { address, key, valueType: 'number', setup: k!.mix };
    }
    case 'part': {
      const part = model.parts.find((q) => q.id === address.id);
      if (!part) fail(`unknown part "${address.id}"`, model.parts.map((q) => q.id), address.id);
      const p = part!;
      if (address.prop[0] === 'shape') {
        const fields = SHAPE_FIELDS[p.shape.type];
        const field = address.prop.slice(1).join('.');
        const vt = fields[field];
        if (!vt) fail(`${p.shape.type} shape has no bindable field "${field}"`, Object.keys(fields), field);
        const raw = (p.shape as any)[field];
        if (vt === 'points') {
          const arr = (raw as number[]).slice();
          return { address, key, valueType: 'points', setup: arr, pointCount: arr.length / 2 };
        }
        if (vt === 'path') {
          const pv = tryParsePath(raw as string);
          if (!pv) throw new AddressError(`part "${p.id}" has an invalid path`);
          return { address, key, valueType: 'path', setup: pv };
        }
        const setup = (raw as number | undefined) ?? (p.shape.type === 'image' ? imageSize(model, p.shape, field, opts) : undefined);
        return { address, key, valueType: 'number', setup: setup ?? 0 };
      }
      switch (prop) {
        case 'opacity':
          return { address, key, valueType: 'number', setup: p.opacity };
        case 'z':
          return { address, key, valueType: 'number', setup: p.z };
        case 'visible':
          return { address, key, valueType: 'boolean', setup: p.visible ? 1 : 0 };
        case 'tint':
          return { address, key, valueType: 'color', setup: parseColor(p.tint) ?? [1, 1, 1, 1] };
        case 'fill': {
          const f = p.fill ?? '#ffffff';
          const c = typeof f === 'string' ? f : f.type === 'solid' ? f.color : null;
          if (c === null) throw new AddressError(`part "${p.id}" fill is a gradient; only solid fills are bindable`);
          return { address, key, valueType: 'color', setup: parseColor(c) ?? [1, 1, 1, 1] };
        }
        case 'stroke.color':
        case 'stroke.width': {
          if (!p.stroke) throw new AddressError(`part "${p.id}" has no stroke`, 'add a "stroke" object first');
          return prop === 'stroke.color'
            ? { address, key, valueType: 'color', setup: parseColor(p.stroke.color) ?? [0, 0, 0, 1] }
            : { address, key, valueType: 'number', setup: p.stroke.width };
        }
      }
      return fail(`part has no property "${prop}"`, [...PART_PROPS, ...Object.keys(SHAPE_FIELDS[p.shape.type]).map((f) => `shape.${f}`)], prop);
    }
  }
}

/** Default size of an image shape along `field` ('w' | 'h'): crop size, else texture size; undefined if unknown. */
function imageSize(model: Model, shape: Extract<Shape, { type: 'image' }>, field: string, opts: ResolveTargetOptions): number | undefined {
  if (field !== 'w' && field !== 'h') return undefined;
  if (shape.crop) return field === 'w' ? shape.crop[2] : shape.crop[3];
  const id = shape.texture;
  // Own properties only: texture ids like "constructor" must not hit Object.prototype.
  const known = opts.textures && Object.hasOwn(opts.textures, id) ? opts.textures[id] : undefined;
  // Partial models (ops resolve single items) may lack the textures section.
  const texture = known ?? (model.textures as Model['textures'] | undefined)?.find((t) => t.id === id);
  return field === 'w' ? texture?.width : texture?.height;
}

export function paramDefault(p: { min: number; max: number; default?: number }): number {
  const d = p.default ?? 0;
  return Math.min(p.max, Math.max(p.min, d));
}

// ----------------------------------------------------------------------------- suggestions

export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1].toLowerCase() === b[j - 1].toLowerCase() ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[n];
}

/** "did you mean X?" for the closest option, or null when nothing is close. */
export function suggest(got: string, options: string[]): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const o of options) {
    const d = levenshtein(got, o);
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  if (best === null) return null;
  const limit = Math.max(2, Math.floor(Math.max(got.length, best.length) / 3));
  // Never suggest a word that differs in every character (e.g. "a" -> "ik").
  return bestD <= limit && bestD < Math.max(got.length, 1) ? `did you mean "${best}"?` : null;
}

export type { Value };
