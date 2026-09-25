/**
 * Fix-it hints for property addresses and values that set / bind / key reject: gradient fills,
 * missing strokes, unparseable setup paths, addresses without a property, property names other
 * tools use (color → fill, alpha → opacity, rx → shape.rx, ...) and values of the wrong type.
 *
 * Pure functions of the rejected input and the addressed raw item (no model access), so both the
 * address resolution (model.ts) and the value ops (values.ts) can use them.
 */
import type { Address, PathValue, ResolvedTarget, TargetKind } from '../core/types.js';
import { BONE_PROPS, IK_PROPS, PART_PROPS, SHAPE_FIELDS, WARP_PROPS } from '../core/address.js';
import { parseColor } from '../core/color.js';
import { formatPath, tryParsePath } from '../core/path.js';
import { fmt, isObject, type JsonObject, q } from './util.js';

/** Stands for "a colour" in hints when the op gave none that could be used. */
export const COLOR_PLACEHOLDER = '#rrggbb';

/** An example path for hints when the item has no usable one. */
const EXAMPLE_PATH = 'M0 0 L100 0 L50 80 Z';

/** One-line JSON in the style of the op examples: `{"a": [1, 2], "b": "x"}`. */
export function inlineJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(inlineJson).join(', ')}]`;
  if (isObject(v)) return `{${Object.entries(v).map(([k, x]) => `${q(k)}: ${inlineJson(x)}`).join(', ')}}`;
  return JSON.stringify(v) ?? String(v);
}

/** `{"op": "update", "kind": ..., "id": ..., "set": {<set>}}` */
export function updateOp(kind: string, id: string, set: string): string {
  return `{"op": "update", "kind": "${kind}", "id": ${q(id)}, "set": {${set}}}`;
}

/** The value as JSON when it is a colour string, else the placeholder. */
function colorJson(value: unknown): string {
  return JSON.stringify(typeof value === 'string' && parseColor(value) ? value : COLOR_PLACEHOLDER);
}

function shapeType(item: JsonObject): string {
  return isObject(item.shape) && typeof item.shape.type === 'string' ? item.shape.type : '';
}

/** Animatable properties of an addressable item: what set, bindings and animation tracks can address. */
export function addressProps(kind: TargetKind, item: JsonObject = {}): readonly string[] {
  switch (kind) {
    case 'bone':
      return BONE_PROPS;
    case 'ik':
      return IK_PROPS;
    case 'warp':
      return WARP_PROPS;
    case 'param':
      return [];
    case 'part': {
      const fields = SHAPE_FIELDS[shapeType(item)];
      return [...PART_PROPS, ...(fields ? Object.keys(fields).map((f) => `shape.${f}`) : ['shape.<field>'])];
    }
  }
}

export function isGradient(fill: unknown): fill is JsonObject {
  return isObject(fill) && fill.type !== 'solid';
}

// ----------------------------------------------------------------------------- targets

/**
 * A gradient-filled part whose fill (or a field of it) an op addresses: "set" can replace the fill,
 * edit the gradient or tint the part; bindings and tracks can only drive the tint (or a solid fill).
 */
export function gradientFillHint(opName: string, id: string, fill: JsonObject, value?: unknown): string {
  if (opName === 'set') {
    if (isObject(value)) return `replace the whole fill with ${updateOp('part', id, `"fill": ${inlineJson(value)}`)}`;
    const stops = Array.isArray(fill.stops) ? fill.stops : [[0, '#000000'], [1, '#ffffff']];
    return [
      `make the fill solid with ${updateOp('part', id, `"fill": ${colorJson(value)}`)}`,
      `edit the gradient with ${updateOp('part', id, `"fill.stops": ${inlineJson(stops)}`)}`,
      `or tint the whole part with {"op": "set", "target": "part:${id}.tint", "value": ${colorJson(value)}}`,
    ].join(', ');
  }
  const drivers = opName === 'key' ? 'animation tracks' : 'bindings';
  return `${drivers} drive solid fill colours only: make the fill solid first with ${updateOp('part', id, `"fill": ${colorJson(undefined)}`)}, or ${opName} "part:${id}.tint" instead (the tint multiplies the gradient's colours)`;
}

/** The update that adds a stroke to a part, using `value` for stroke property `prop` when it fits. */
export function addStrokeOp(id: string, prop: string, value?: unknown): string {
  const color = prop === 'color' && typeof value === 'string' && parseColor(value) ? JSON.stringify(value) : '"#000000"';
  const width = prop === 'width' && typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 2;
  return updateOp('part', id, `"stroke": {"color": ${color}, "width": ${width}}`);
}

/** A stroke property of a part without a stroke: the update that adds one. */
export function missingStrokeHint(id: string, prop: string, value?: unknown): string {
  return `add the stroke with ${addStrokeOp(id, prop, value)}`;
}

/** A path part whose setup path does not parse: the update that replaces it. */
export function badPathHint(opName: string, id: string, d: string, value?: unknown): string {
  const head = `its setup path ${q(d.length > 40 ? `${d.slice(0, 40)}…` : d)} does not parse`;
  if (opName === 'set' && typeof value === 'string' && tryParsePath(value)) return `${head}; replace it with ${updateOp('part', id, `"shape.d": ${q(value)}`)}`;
  return `${head}; fix it first, e.g. ${updateOp('part', id, `"shape.d": ${q(EXAMPLE_PATH)}`)}`;
}

/**
 * A better hint for an address the resolver rejected, or the resolver's own hint (`resolverHint`).
 * Known causes (gradient fill, missing stroke, broken setup path) get the op that fixes them; an
 * unknown property that is another tool's name for a Rev2D property gets "did you mean".
 */
export function targetHint(opName: string, address: Address, item: JsonObject, resolverHint: string | undefined, value?: unknown): string | undefined {
  const { kind, id, prop } = address;
  if (kind === 'part') {
    if (prop[0] === 'fill' && isGradient(item.fill)) return gradientFillHint(opName, id, item.fill, value);
    if (prop[0] === 'stroke' && prop.length === 2 && item.stroke === undefined && (prop[1] === 'color' || prop[1] === 'width')) {
      return missingStrokeHint(id, prop[1], value);
    }
    const shape = isObject(item.shape) ? item.shape : undefined;
    if (prop.join('.') === 'shape.d' && shape?.type === 'path' && typeof shape.d === 'string' && !tryParsePath(shape.d)) return badPathHint(opName, id, shape.d, value);
  }
  if (resolverHint?.startsWith('did you mean')) return resolverHint;
  const alias = propertyAlias(kind, item, prop);
  if (!alias) return resolverHint;
  return `did you mean ${q(`${kind}:${id}.${alias}`)}?${resolverHint ? ` (${resolverHint})` : ''}`;
}

/** Property names other tools and AI authors use (normalized: lowercase, no - _ or spaces). */
const PROP_ALIASES: Record<TargetKind, Record<string, string>> = {
  param: {},
  bone: { rot: 'rotation', rotate: 'rotation', angle: 'rotation', r: 'rotation', len: 'length', size: 'length', sx: 'scaleX', sy: 'scaleY', posx: 'x', posy: 'y' },
  warp: { offset: 'offsets', points: 'offsets', lattice: 'offsets', grid: 'offsets', controlpoints: 'offsets', deform: 'offsets' },
  ik: { weight: 'mix', strength: 'mix', influence: 'mix', amount: 'mix', blend: 'mix' },
  part: {
    color: 'fill',
    colour: 'fill',
    fillcolor: 'fill',
    fillcolour: 'fill',
    'fill.color': 'fill',
    'fill.colour': 'fill',
    alpha: 'opacity',
    transparency: 'opacity',
    zindex: 'z',
    depth: 'z',
    order: 'z',
    layer: 'z',
    hidden: 'visible',
    show: 'visible',
    visibility: 'visible',
    strokecolor: 'stroke.color',
    strokecolour: 'stroke.color',
    'stroke.colour': 'stroke.color',
    linecolor: 'stroke.color',
    outlinecolor: 'stroke.color',
    strokewidth: 'stroke.width',
    linewidth: 'stroke.width',
    outlinewidth: 'stroke.width',
    thickness: 'stroke.width',
    tintcolor: 'tint',
  },
};

/** Other names for shape fields, per shape type (normalized keys). */
const SHAPE_ALIASES: Record<string, Record<string, string>> = {
  ellipse: { x: 'cx', y: 'cy', centerx: 'cx', centery: 'cy', radius: 'rx', radiusx: 'rx', radiusy: 'ry', angle: 'rotation', rot: 'rotation' },
  rect: { width: 'w', height: 'h', cornerradius: 'radius', r: 'radius' },
  image: { width: 'w', height: 'h' },
  polygon: { vertices: 'points', pts: 'points' },
  mesh: { points: 'vertices', verts: 'vertices', positions: 'vertices' },
  path: { path: 'd', data: 'd', svg: 'd' },
};

function normalize(s: string): string {
  return s.toLowerCase().replace(/[-_\s]/g, '');
}

/** The Rev2D property another name stands for, if the item has it. */
export function propertyAlias(kind: TargetKind, item: JsonObject, prop: readonly string[]): string | undefined {
  const valid = addressProps(kind, item);
  const path = prop.join('.');
  const alias = PROP_ALIASES[kind][normalize(path)];
  if (alias && valid.includes(alias)) return alias;
  if (kind !== 'part') return undefined;
  // Shape fields: missing "shape." prefix ("rx"), or another name for the field ("shape.x" on an ellipse).
  const type = shapeType(item);
  const fields = SHAPE_FIELDS[type] ?? {};
  const field = prop[0] === 'shape' ? prop.slice(1).join('.') : path;
  if (prop[0] !== 'shape' && Object.hasOwn(fields, field)) return `shape.${field}`;
  const shapeAlias = SHAPE_ALIASES[type]?.[normalize(field)];
  return shapeAlias && Object.hasOwn(fields, shapeAlias) ? `shape.${shapeAlias}` : undefined;
}

/** Address without a property ("bone:hand"): the properties it could have. */
export function propertyListHint(kind: TargetKind, id: string, item: JsonObject | undefined): string | undefined {
  if (kind === 'param') return undefined;
  const props = addressProps(kind, item);
  return item ? `properties of ${kind} ${q(id)}: ${props.join(', ')}` : `${kind} properties: ${props.join(', ')}`;
}

// ----------------------------------------------------------------------------- values

/** Hint for a value the value normalizer rejected without one. */
export function valueHint(raw: unknown, target: ResolvedTarget): string | undefined {
  switch (target.valueType) {
    case 'number': {
      if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) return `write the number without quotes: ${Number(raw)}`;
      const setup = typeof target.setup === 'number' && Number.isFinite(target.setup) ? target.setup : 0;
      return `a finite number, e.g. ${fmt(setup)} (the setup value)`;
    }
    case 'boolean':
      if (raw === 'true' || raw === 'false') return `write ${raw} without quotes`;
      return 'true or false (numbers work too: >= 0.5 is true)';
    case 'path': {
      const setup = target.setup as PathValue;
      return `the setup path with changed numbers, e.g. ${q(formatPath(setup))}`;
    }
    case 'points':
      return pointsHint(raw, target);
    default:
      return undefined;
  }
}

function pointsHint(raw: unknown, target: ResolvedTarget): string | undefined {
  const setup = target.setup as number[];
  const count = target.pointCount ?? setup.length / 2;
  const at = (i: number) => `[${fmt(setup[i * 2])}, ${fmt(setup[i * 2 + 1])}]`;
  if (!isObject(raw)) return `a list of ${count * 2} numbers [x0, y0, x1, y1, ...] or a sparse map {"<pointIndex>": [x, y]}`;
  for (const [k, v] of Object.entries(raw)) {
    const i = Number(k);
    if (!Number.isInteger(i) || i < 0 || i >= count) return `sparse map keys are point indices 0..${count - 1}, e.g. {"${count - 1}": ${at(count - 1)}}`;
    if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => typeof n === 'number' && Number.isFinite(n))) return `e.g. {"${k}": ${at(i)}} (its setup position)`;
  }
  return undefined;
}

/** `set` of a boolean property with a non-boolean value. */
export function booleanSetHint(value: unknown): string {
  if (value === 'true' || value === 'false') return `write ${value} without quotes`;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `write ${value >= 0.5} (setup values are booleans; bindings and tracks also take numbers, >= 0.5 = visible)`;
  }
  return 'write true or false';
}
