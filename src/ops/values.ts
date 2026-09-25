/**
 * Value ops: set (setup values), bind / unbind (parameter keyforms), key / unkey (animation keys).
 * Values are checked with the same normalization the evaluator uses (normalizeValue), so a value
 * accepted here is one the rig can play.
 */
import type { Address, RawValue, ResolvedTarget } from '../core/types.js';
import { paramDefault, parseAddress } from '../core/address.js';
import { EASINGS } from '../core/easing.js';
import { tryParsePath } from '../core/path.js';
import { EaseSchema } from '../core/schema.js';
import { normalizeValue, ValueError } from '../core/values.js';
import { didYouMean, referenceHint } from '../core/validate/text.js';
import type { OpContext } from './context.js';
import { addressProps, addStrokeOp, booleanSetHint, gradientFillHint, inlineJson, isGradient, missingStrokeHint, updateOp, valueHint } from './hints.js';
import { valueJson } from './keyforms.js';
import {
  ADDRESS_KIND,
  bindingSignature,
  canonicalTarget,
  checkNewId,
  type Doc,
  findItem,
  idsOf,
  type Item,
  ItemGuard,
  itemKeys,
  KIND_ADDRESS,
  type Kind,
  nestedKeys,
  NOUN,
  requireItem,
  resolveRaw,
  type RawTarget,
  sameParamSet,
  sectionItems,
  setOrdered,
} from './model.js';
import { choiceHint, clean, describe, fieldHint, type Fields, fmt, isObject, OpError, q, show, toPointer } from './util.js';

const KEY_TIME_EPSILON = 1e-6;

const BIND_PARAM_ERROR = (a: Address, target: string): [string, string] => [
  `bindings cannot target a parameter (${q(target)})`,
  `bindings turn parameter values into property values: bind the property ${q(a.id)} should control, and drive ${q(a.id)} itself with animations ("key") or physics`,
];

/** Check a raw value against a resolved target; errors name the op field and hint at a valid value. */
export function checkValue(raw: unknown, target: ResolvedTarget, where: string): void {
  try {
    normalizeValue(raw as RawValue, target);
  } catch (e) {
    if (!(e instanceof ValueError)) throw e;
    throw new OpError(`${where}: ${e.message} for ${q(target.key)}`, e.hint ?? valueHint(raw, target));
  }
}

// ----------------------------------------------------------------------------- set

/**
 * "; note: ..." when bindings drive the property `key` (canonical address): their keyform values
 * are absolute, so a changed setup value does not show (one binding) or only enters through the
 * combination rule (several). Empty when nothing binds it.
 */
export function boundNote(doc: Doc, key: string): string {
  const bound = (sectionItems(doc, 'binding') ?? []).filter((b) => isObject(b) && canonicalTarget(b.target) === key);
  // Sparse point maps keep the setup value of every point they do not list: it still shows.
  const sparse = bound.some((b) => Array.isArray(b.keys) && b.keys.some((k) => isObject(k) && isObject(k.value)));
  if (!bound.length || sparse) return '';
  if (bound.length === 1) return `; note: binding ${bindingSignature(bound[0])} sets absolute values, so this setup value does not show while it exists (change the look with "bind")`;
  return `; note: ${bound.length} bindings (${bound.map(bindingSignature).join(', ')}) set absolute values; what shows is setup + Σ(keyform − setup) (change the look with "bind")`;
}

/** Animatable properties of an item (what `set`, bindings and tracks can address). */
export function animatableProps(kind: Kind, item: Item): readonly string[] {
  const addressKind = KIND_ADDRESS[kind];
  return addressKind ? addressProps(addressKind, item) : [];
}

/**
 * Errors `set` can explain better than the address resolver: fields that exist but are not
 * animatable (use update / rename), a stroke that does not exist yet, and gradient fills.
 * Anything else (typos, unknown items) is left to resolveRaw and its did-you-mean hints.
 */
function precheckSet(doc: Doc, target: string, value: unknown): void {
  let address: Address;
  try {
    address = parseAddress(target);
  } catch {
    return;
  }
  if (address.kind === 'param' || address.kind === 'warp') return;
  const kind = ADDRESS_KIND[address.kind];
  const item = findItem(doc, kind, address.id)?.item;
  if (!item) return;
  const { id, prop } = address;
  const path = prop.join('.');
  if (kind === 'part' && (path === 'stroke.width' || path === 'stroke.color') && item.stroke === undefined) {
    throw new OpError(`set: part ${q(id)} has no stroke, so ${q(target)} has no setup value yet`, missingStrokeHint(id, prop[1], value));
  }
  if (kind === 'part' && path === 'fill' && isGradient(item.fill)) {
    throw new OpError(`set: part ${q(id)} has a ${String(item.fill.type)} gradient fill; "set" only changes solid fill colours`, gradientFillHint('set', id, item.fill, value));
  }
  if (animatableProps(kind, item).includes(path)) return;
  // A field of a solid fill ("fill.color"): the colour is addressed as "fill" (resolveRaw says so).
  if (kind === 'part' && prop[0] === 'fill' && prop.length > 1 && !isGradient(item.fill)) return;
  const container = prop.length === 2 && isObject(item[prop[0]]) ? (item[prop[0]] as Item) : {};
  const fields = prop.length === 1 ? itemKeys(kind) : prop.length === 2 ? (nestedKeys(kind, [prop[0]], container) ?? []) : [];
  if (!fields.includes(prop[prop.length - 1])) return;
  const what = `set: ${q(path)} of ${NOUN[kind]} ${q(id)} is not an animatable property ("set" changes setup values of properties that bindings and animations drive)`;
  if (path === 'id') {
    throw new OpError(what, `use rename, which also rewrites every reference: {"op": "rename", "kind": "${kind}", "from": ${q(id)}, "to": ${JSON.stringify(value)}}`);
  }
  if (kind === 'part' && path === 'stroke' && (typeof value === 'string' || typeof value === 'number')) {
    // A colour or a width for the whole stroke: the stroke property it was meant for.
    const sub = typeof value === 'string' ? 'color' : 'width';
    const add = item.stroke === undefined ? ` (or add a stroke with ${addStrokeOp(id, sub, value)})` : '';
    throw new OpError(what, `did you mean ${q(`part:${id}.stroke.${sub}`)}?${add}`);
  }
  throw new OpError(what, `use update: ${updateOp(kind, id, `${JSON.stringify(path)}: ${inlineJson(value)}`)}`);
}

/** "was ..." for a setup value that is not written in the file yet. */
function unsetPhrase(ctx: OpContext, t: RawTarget): string {
  const { address, item, resolved } = t;
  const shape = isObject(item.shape) ? item.shape : undefined;
  const field = address.prop[1];
  if (address.kind === 'part' && shape?.type === 'image' && (field === 'w' || field === 'h')) {
    // Image size defaults to the crop / texture size, not to the resolver's 0.
    const dim = field === 'w' ? 'width' : 'height';
    if (Array.isArray(shape.crop)) return `unset, default: the crop ${dim}, ${show(shape.crop[field === 'w' ? 2 : 3])}`;
    const size = typeof shape.texture === 'string' ? ctx.textures[shape.texture] : undefined;
    return `unset, default: the texture ${dim}${size ? `, ${size[dim]}` : ''}`;
  }
  return `unset, default ${show(setupJson(resolved))}`;
}

export function opSet(ctx: OpContext, f: Fields): string {
  const { doc } = ctx;
  const target = f.string('target', 'property address, e.g. "bone:arm.rotation"');
  const value = f.required('value', 'the new setup value');
  precheckSet(doc, target, value);
  const t = resolveRaw(
    doc,
    target,
    'set',
    (a) => [
      `parameters have no setup value to "set" (${q(target)})`,
      `change the default with {"op": "update", "kind": "parameter", "id": ${q(a.id)}, "set": {"default": <value>}}, or animate it with "key"`,
    ],
    value,
  );
  const { resolved, address, item, kind } = t;
  if (address.kind === 'warp') {
    throw new OpError(
      `set: warp offsets have no setup value (${q(target)}); the rest lattice is the warp rect`,
      `move the lattice with {"op": "update", "kind": "warp", "id": ${q(address.id)}, "set": {"rect": [x, y, w, h]}}, or deform it with "bind" / "bind_warp"`,
    );
  }
  let written: unknown;
  switch (resolved.valueType) {
    case 'path':
      // The setup path defines the command structure, so any valid path is accepted here.
      if (typeof value !== 'string' || !tryParsePath(value)) throw new OpError(`set: ${q(t.key)} needs a valid SVG path string, got ${describe(value)}`, 'e.g. "M0 0 L100 0 L50 80 Z"');
      written = value;
      break;
    case 'boolean':
      if (typeof value !== 'boolean') throw new OpError(`set: ${q(t.key)} needs true or false, got ${describe(value)}`, booleanSetHint(value));
      written = value;
      break;
    case 'points':
      try {
        checkValue(value, resolved, 'set');
      } catch (e) {
        if (!(e instanceof OpError) || !Array.isArray(value) || value.length === (resolved.setup as number[]).length) throw e;
        const field = `shape.${address.prop.slice(1).join('.')}`;
        throw new OpError(
          e.message,
          `${e.hint}; to change the number of points use update: {"op": "update", "kind": "part", "id": ${q(address.id)}, "set": {${JSON.stringify(field)}: [...]}} (bindings and tracks on it must then match)`,
        );
      }
      // Sparse maps are expanded: the setup value is always a full list.
      written = normalizeValue(value as RawValue, resolved);
      break;
    default:
      checkValue(value, resolved, 'set');
      written = value;
  }
  const guard = new ItemGuard(doc, kind, item);
  const old = writeSetup(item, address, written);
  guard.check(`set ${t.key}`);
  const was = old === undefined ? unsetPhrase(ctx, t) : show(old);
  return `set ${t.key} = ${show(written)} (was ${was})${boundNote(doc, t.key)}`;
}

function setupJson(r: ResolvedTarget): unknown {
  return valueJson(r.setup, r.valueType);
}

/** Write a setup value into the raw item; returns the previous raw value. */
function writeSetup(item: Item, address: Address, value: unknown): unknown {
  const [head, ...rest] = address.prop;
  if (address.kind !== 'part') {
    const old = item[head];
    setOrdered(item, head, value, itemKeys(address.kind === 'ik' ? 'ik' : 'bone'));
    return old;
  }
  if (head === 'shape') {
    const shape = item.shape as Item;
    const field = rest.join('.');
    const old = shape[field];
    setOrdered(shape, field, value, nestedKeys('part', ['shape'], shape));
    return old;
  }
  if (head === 'stroke') {
    const stroke = item.stroke as Item;
    const old = stroke[rest[0]];
    stroke[rest[0]] = value;
    return old;
  }
  if (head === 'fill' && isObject(item.fill)) {
    // Solid fill object: keep its form and replace the colour.
    const old = item.fill.color;
    item.fill.color = value;
    return old;
  }
  const old = item[head];
  setOrdered(item, head, value, itemKeys('part'));
  return old;
}

// ----------------------------------------------------------------------------- bind

export interface BindingSpec {
  target: string;
  /** Canonical address of `target`. */
  key: string;
  params: string[];
  keys: Array<{ at: number[]; value: unknown }>;
  interpolation?: string;
  /** Always linear: a replaced binding's "step" interpolation is dropped instead of kept. */
  forceLinear?: boolean;
  id?: string;
  description?: string;
}

export function opBind(ctx: OpContext, f: Fields): string {
  const { doc } = ctx;
  const target = f.string('target', 'property address, e.g. "part:mouth.shape.ry"');
  const t = resolveRaw(doc, target, 'bind', (a) => BIND_PARAM_ERROR(a, target));
  const relative = f.optBoolean('relative', 'key values are offsets from the current setup value') ?? false;
  const setup = relative ? relativeBase(ctx, t, 'bind') : undefined;
  const params = checkParams(doc, f);
  const rawKeys = f.array('keys', '[{"at": [...], "value": ...}]');
  if (!rawKeys.length) throw new OpError('bind: "keys" is empty', 'give at least one keyform, e.g. [{"at": [0], "value": 0}, {"at": [1], "value": 1}]');
  const keys = rawKeys.map((k, j) => {
    const where = `bind: keys[${j}]`;
    if (!isObject(k)) throw new OpError(`${where} must be {"at": [...], "value": ...}, got ${describe(k)}`);
    checkKeyFields(k, ['at', 'value'], where);
    const at = readAt(k.at, params, where);
    if (!Object.hasOwn(k, 'value')) {
      throw new OpError(`${where} needs "value" (${relative ? 'the offset from the setup value' : 'the absolute property value'} at this keyform)`);
    }
    if (setup === undefined) {
      checkValue(k.value, t.resolved, `${where}.value`);
      return { at, value: structuredClone(k.value) };
    }
    return { at, value: addOffset(setup, k.value, t, `${where}.value`) };
  });
  checkGrid('bind', params, keys);
  const detail = setup === undefined ? '' : `; relative: stored ${relativeSummary(setup, keys)}`;
  return upsertBinding(
    doc,
    {
      target,
      key: t.key,
      params,
      keys,
      interpolation: readInterpolation(f),
      id: f.optString('id', 'binding id'),
      description: f.optString('description', 'note'),
    },
    detail,
  );
}

// ----------------------------------------------------------------------------- relative values

/** Setup value a relative binding adds its offsets to: a number or a flat point list. */
type RelativeBase = number | number[];

/**
 * The current setup value of a numeric or point-list target, for relative keyforms. Colours, paths
 * and booleans have no meaningful offset and are rejected with the absolute alternative.
 */
function relativeBase(ctx: OpContext, t: RawTarget, opName: string): RelativeBase {
  const { resolved, address, item } = t;
  if (resolved.valueType === 'points') return (resolved.setup as number[]).slice();
  if (resolved.valueType !== 'number') {
    const what = resolved.valueType === 'color' ? 'a colour' : resolved.valueType === 'path' ? 'an SVG path' : 'a boolean';
    throw new OpError(
      `${opName}: "relative" offsets need a numeric or point-list property, but ${q(t.key)} is ${what}`,
      `drop "relative" and give absolute values (keyform values are absolute), e.g. "value": ${inlineJson(setupJson(resolved))} is the current setup value`,
    );
  }
  // An omitted image w/h is drawn with the crop / texture size, which the item alone does not know.
  const shape = isObject(item.shape) ? item.shape : undefined;
  const field = address.prop[1];
  if (address.kind === 'part' && shape?.type === 'image' && (field === 'w' || field === 'h') && shape[field] === undefined && !Array.isArray(shape.crop)) {
    const size = typeof shape.texture === 'string' ? (ctx.textures[shape.texture] ?? textureSize(ctx.doc, shape.texture)) : undefined;
    const dim = size?.[field === 'w' ? 'width' : 'height'];
    if (dim === undefined) {
      throw new OpError(
        `${opName}: ${q(t.key)} is unset and the size of texture ${show(shape.texture)} is unknown, so there is no setup value to add offsets to`,
        `set it first: {"op": "set", "target": ${q(t.key)}, "value": <px>}, or give absolute values without "relative"`,
      );
    }
    return dim;
  }
  return resolved.setup as number;
}

function textureSize(doc: Doc, id: string): { width: number; height: number } | undefined {
  const tex = findItem(doc, 'texture', id)?.item;
  return tex && typeof tex.width === 'number' && typeof tex.height === 'number' ? { width: tex.width, height: tex.height } : undefined;
}

/** setup + offset as an absolute keyform value (a sparse offset map stays sparse). */
function addOffset(setup: RelativeBase, offset: unknown, t: RawTarget, where: string): unknown {
  if (typeof setup === 'number') {
    if (typeof offset !== 'number' || !Number.isFinite(offset)) throw new OpError(`${where}: expected a number (offset from the setup value ${fmt(setup)}), got ${describe(offset)}`);
    return clean(setup + offset);
  }
  // Same shape rules as absolute point values: full list of the right length, or a sparse map.
  checkValue(offset, t.resolved, where);
  if (Array.isArray(offset)) return (offset as number[]).map((d, i) => clean(setup[i] + d, 4));
  return Object.fromEntries(
    Object.entries(offset as Record<string, [number, number]>).map(([k, [dx, dy]]) => {
      const i = Number(k);
      return [k, [clean(setup[i * 2] + dx, 4), clean(setup[i * 2 + 1] + dy, 4)]];
    }),
  );
}

/** "keyforms 100, 130 (setup 100 + offsets)" for the message of a relative bind. */
function relativeSummary(setup: RelativeBase, keys: Array<{ value: unknown }>): string {
  if (typeof setup === 'number') return `absolute keyforms ${keys.map((k) => show(k.value)).join(', ')} (setup ${fmt(setup)} + offsets)`;
  return `absolute keyforms (setup points + offsets${keys.every((k) => isObject(k.value)) ? ', sparse maps kept sparse' : ''})`;
}

// ----------------------------------------------------------------------------- bind_linear

export function opBindLinear(ctx: OpContext, f: Fields): string {
  const { doc } = ctx;
  const target = f.string('target', 'address of a numeric property, e.g. "bone:footL.y"');
  const t = resolveRaw(doc, target, 'bind_linear', (a) => BIND_PARAM_ERROR(a, target));
  const paramId = f.string('param', 'parameter id');
  const param = requireItem(doc, 'parameter', paramId).item;
  const scale = f.number('scale', 'property units per parameter unit');
  if (t.resolved.valueType !== 'number') {
    throw new OpError(
      `bind_linear: ${q(t.key)} is ${t.resolved.valueType === 'points' ? 'a point list' : `a ${t.resolved.valueType} value`}; bind_linear drives numeric properties`,
      t.resolved.valueType === 'points'
        ? `use bind with "relative": true and per-point offsets, e.g. {"op": "bind", "target": ${q(t.key)}, "params": [${q(paramId)}], "relative": true, "keys": [{"at": [0], "value": {}}, {"at": [1], "value": {"0": [0, 10]}}]}`
        : 'use bind with absolute keyform values',
    );
  }
  const min = typeof param.min === 'number' ? param.min : undefined;
  const max = typeof param.max === 'number' ? param.max : undefined;
  let at: [number, number];
  if (f.has('at')) {
    const raw = f.raw('at');
    if (!Array.isArray(raw) || raw.length !== 2 || !raw.every((v) => typeof v === 'number' && Number.isFinite(v)) || raw[0] >= raw[1]) {
      throw new OpError(`bind_linear: "at" must be [low, high] with low < high (the two parameter values to key), got ${show(raw)}`, `e.g. "at": [${min ?? -1}, ${max ?? 1}] (default: the parameter range)`);
    }
    at = raw as [number, number];
  } else {
    if (min === undefined || max === undefined || !(min < max)) {
      throw new OpError(`bind_linear: parameter ${q(paramId)} has no usable range (min ${show(param.min)}, max ${show(param.max)})`, 'give "at": [low, high] explicitly, or fix the parameter range');
    }
    at = [min, max];
  }
  const setup = relativeBase(ctx, t, 'bind_linear') as number;
  const keys = at.map((p) => ({ at: [p], value: clean(setup + scale * p) }));
  const rest = min !== undefined && max !== undefined ? paramDefault({ min, max, default: typeof param.default === 'number' ? param.default : undefined }) : 0;
  const restOffset = scale * rest;
  const warning =
    Math.abs(restOffset) > 1e-9
      ? `; WARNING: at the parameter default ${paramId}=${fmt(rest)} the value is ${fmt(setup + restOffset)}, not the setup value ${fmt(setup)}, so the rest pose moves (use a parameter whose default is 0, or bind explicit keys)`
      : '';
  const formula = `; ${t.key} = ${fmt(setup)} ${scale < 0 ? '-' : '+'} ${fmt(Math.abs(scale))} × ${paramId} (${keys.map((k) => `${fmt(k.at[0])} → ${fmt(k.value)}`).join(', ')})`;
  return upsertBinding(
    doc,
    {
      target,
      key: t.key,
      params: [paramId],
      keys,
      forceLinear: true,
      id: f.optString('id', 'binding id'),
      description: f.optString('description', 'note'),
    },
    `${formula}${warning}`,
  );
}

/** Parameter ids of a bind op: each must exist, no duplicates. */
export function checkParams(doc: Doc, f: Fields): string[] {
  const params = f.paramList('params');
  const seen = new Set<string>();
  for (const p of params) {
    if (seen.has(p)) throw new OpError(`${f.name}: parameter ${q(p)} is listed twice in "params"`);
    seen.add(p);
    requireItem(doc, 'parameter', p);
  }
  return params;
}

export function readInterpolation(f: Fields): string | undefined {
  const v = f.optString('interpolation', '"linear" or "step"');
  if (v !== undefined && v !== 'linear' && v !== 'step') throw new OpError(`${f.name}: unknown interpolation ${q(v)}`, choiceHint(v, ['linear', 'step']));
  return v;
}

/** "at" of one key: a number list with one value per parameter (a bare number for one parameter). */
export function readAt(raw: unknown, params: string[], where: string): number[] {
  const at = typeof raw === 'number' ? [raw] : raw;
  if (!Array.isArray(at) || at.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
    throw new OpError(`${where}.at must be a list of numbers (one per parameter), got ${describe(raw)}`, `e.g. "at": [${params.map(() => 0).join(', ')}]`);
  }
  if (at.length !== params.length) {
    throw new OpError(`${where}.at has ${at.length} value(s) but there are ${params.length} parameter(s) (${params.join(', ')})`, `one value per parameter, in "params" order, e.g. "at": [${params.map(() => 0).join(', ')}]`);
  }
  return at as number[];
}

export function checkKeyFields(k: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(k)) {
    if (!allowed.includes(key)) throw new OpError(`${where}: unknown field ${q(key)}`, fieldHint(key, allowed));
  }
}

/** Keys must cover the full Cartesian grid of the distinct "at" values (SPEC §5). */
export function checkGrid(opName: string, params: string[], keys: Array<{ at: number[] }>): void {
  const seen = new Map<string, number>();
  keys.forEach((k, j) => {
    const id = k.at.map(String).join(',');
    const prev = seen.get(id);
    if (prev !== undefined) throw new OpError(`${opName}: keys[${j}] repeats "at" [${k.at.join(', ')}] (same as keys[${prev}])`, 'each grid point needs exactly one keyform');
    seen.set(id, j);
  });
  const axes = params.map((_, d) => [...new Set(keys.map((k) => k.at[d]))].sort((a, b) => a - b));
  const total = axes.reduce((n, axis) => n * axis.length, 1);
  if (seen.size === total) return;
  const missing: string[] = [];
  const idx = axes.map(() => 0);
  for (;;) {
    const combo = idx.map((k, d) => axes[d][k]);
    if (!seen.has(combo.map(String).join(','))) missing.push(`[${combo.join(', ')}]`);
    if (missing.length >= 6) break;
    let d = axes.length - 1;
    while (d >= 0 && ++idx[d] === axes[d].length) idx[d--] = 0;
    if (d < 0) break;
  }
  const grid = params.map((p, d) => `${p} {${axes[d].join(', ')}}`).join(' × ');
  throw new OpError(
    `${opName}: keys do not form a full grid: ${grid} needs ${total} keys, got ${seen.size}`,
    `add keys with "at": ${missing.join(', ')}${total - seen.size > missing.length ? ', …' : ''}`,
  );
}

/** Add the binding, or replace the one with the same target and parameter set. */
export function upsertBinding(doc: Doc, spec: BindingSpec, detail = ''): string {
  const items = sectionItems(doc, 'binding', true);
  const index = items.findIndex((b) => isObject(b) && canonicalTarget(b.target) === spec.key && sameParamSet(b.params, spec.params));
  const old = index >= 0 ? items[index] : undefined;
  const id = spec.id ?? (typeof old?.id === 'string' ? old.id : undefined);
  if (spec.id !== undefined && spec.id !== old?.id) checkNewId(doc, 'binding', spec.id, 'bind');
  const description = spec.description ?? (typeof old?.description === 'string' ? old.description : undefined);
  // Like id and description, a replaced binding keeps its interpolation unless a new one is given.
  const kept = spec.forceLinear ? undefined : typeof old?.interpolation === 'string' ? old.interpolation : undefined;
  const interpolation = spec.interpolation ?? kept;
  const binding: Item = {
    ...(id !== undefined ? { id } : {}),
    target: spec.target,
    params: spec.params,
    keys: spec.keys,
    ...(interpolation !== undefined ? { interpolation } : {}),
    ...(description !== undefined ? { description } : {}),
  };
  const n = spec.keys.length;
  const keyforms = `${n} keyform${n === 1 ? '' : 's'}`;
  if (old) {
    items[index] = binding;
    new ItemGuard(doc, 'binding', binding, true).check('bind');
    const was = Array.isArray(old.keys) ? old.keys.length : 0;
    const kept = spec.interpolation === undefined && interpolation !== undefined && interpolation !== 'linear' ? `; interpolation ${q(interpolation)} kept` : '';
    return `replaced binding ${bindingSignature(binding)} at ${toPointer(['bindings', index])} (${keyforms}, was ${was}${kept})${detail}`;
  }
  items.push(binding);
  new ItemGuard(doc, 'binding', binding, true).check('bind');
  return `added binding ${bindingSignature(binding)} as ${toPointer(['bindings', items.length - 1])} (${keyforms})${detail}`;
}

// ----------------------------------------------------------------------------- unbind

export function opUnbind(ctx: OpContext, f: Fields): string {
  const { doc } = ctx;
  const target = f.string('target', 'address of the bound property');
  const key = canonicalTarget(target);
  const params = f.has('params') ? f.paramList('params') : undefined;
  const items = sectionItems(doc, 'binding') ?? [];
  const onTarget = items.filter((b) => isObject(b) && canonicalTarget(b.target) === key);
  const matches = params ? onTarget.filter((b) => sameParamSet(b.params, params)) : onTarget;
  if (!matches.length) {
    if (onTarget.length) {
      throw new OpError(
        `unbind: no binding on ${q(target)} is driven by exactly [${params!.join(', ')}]`,
        `bindings on it: ${onTarget.map((b) => `[${Array.isArray(b.params) ? b.params.join(', ') : '?'}]`).join(', ')}`,
      );
    }
    const targets = [...new Set(items.flatMap((b) => (isObject(b) && typeof b.target === 'string' ? [b.target] : [])))];
    throw new OpError(`unbind: no binding targets ${q(target)}`, referenceHint(target, targets, 'binding targets'));
  }
  // Pointers as they were before the op (splicing shifts the later ones).
  const removed = matches.map((b) => `${bindingSignature(b)} (was ${toPointer(['bindings', items.indexOf(b)])})`);
  for (const b of matches) items.splice(items.indexOf(b), 1);
  return `removed ${removed.length === 1 ? 'binding' : `${removed.length} bindings:`} ${removed.join(', ')}`;
}

// ----------------------------------------------------------------------------- key / unkey

const EASE_NAMES = Object.keys(EASINGS);

function readEase(f: Fields): unknown {
  if (!f.has('ease')) return undefined;
  const ease = f.raw('ease');
  if (EaseSchema.safeParse(ease).success) return ease;
  if (typeof ease === 'string') throw new OpError(`key: unknown ease ${q(ease)}`, choiceHint(ease, EASE_NAMES, 'eases'));
  throw new OpError(`key: "ease" must be an ease name or a cubic-bezier [x1, y1, x2, y2], got ${describe(ease)}`, `names: ${EASE_NAMES.join(', ')}`);
}

interface TrackRef {
  animation: Item;
  track: Item;
  keys: unknown[];
}

function findTrack(animation: Item, key: string): Item | undefined {
  const tracks = Array.isArray(animation.tracks) ? animation.tracks : [];
  return tracks.find((t): t is Item => isObject(t) && canonicalTarget(t.target) === key);
}

function keyTime(k: unknown): number | undefined {
  return isObject(k) && typeof k.t === 'number' ? k.t : undefined;
}

export function opKey(ctx: OpContext, f: Fields): string {
  const { doc } = ctx;
  const animId = f.string('animation', 'animation id');
  const target = f.string('target', '"param:<id>" or a property address');
  const t = f.number('t', 'key time in seconds');
  if (t < 0) throw new OpError(`key: t must be >= 0, got ${t}`);
  if (!f.has('v')) throw new OpError('key needs "v" (the absolute value at time t)', 'e.g. "v": 0.5');
  const v = f.raw('v');
  const ease = readEase(f);
  const duration = f.optNumber('duration', 'animation length in seconds (creates the animation)');
  const loop = f.optBoolean('loop', 'loop flag for a new animation');
  const rt: RawTarget = resolveRaw(doc, target, 'key');
  checkValue(v, rt.resolved, 'key: "v"');

  let animation = findItem(doc, 'animation', animId)?.item;
  let created = false;
  if (!animation) {
    if (duration === undefined) {
      const near = didYouMean(animId, idsOf(doc, 'animation'));
      const create = `pass "duration" (seconds) to create it, e.g. {"op": "key", "animation": ${q(animId)}, "target": ${q(target)}, "t": ${fmt(t)}, "v": ${show(v)}, "duration": ${fmt(Math.max(1, t))}}`;
      throw new OpError(`key: unknown animation ${q(animId)}`, near ? `${near} To create ${q(animId)} instead, ${create}` : create);
    }
    if (duration <= 0) throw new OpError(`key: "duration" must be > 0, got ${duration}`);
    checkNewId(doc, 'animation', animId, 'key');
    animation = { id: animId, duration, ...(loop !== undefined ? { loop } : {}), tracks: [] };
    sectionItems(doc, 'animation', true).push(animation);
    created = true;
  } else {
    const updateHint = (field: string, value: unknown) => `drop "${field}" from key ops on an existing animation, or change it with {"op": "update", "kind": "animation", "id": ${q(animId)}, "set": {"${field}": ${JSON.stringify(value)}}}`;
    if (duration !== undefined && duration !== animation.duration) throw new OpError(`key: animation ${q(animId)} already exists with duration ${show(animation.duration)}`, updateHint('duration', duration));
    if (loop !== undefined && loop !== (animation.loop ?? true)) throw new OpError(`key: animation ${q(animId)} already exists with loop ${show(animation.loop ?? true)}`, updateHint('loop', loop));
  }
  const length = animation.duration;
  if (typeof length !== 'number') throw new OpError(`key: animation ${q(animId)} has no numeric "duration"`, `set one with {"op": "update", "kind": "animation", "id": ${q(animId)}, "set": {"duration": 2}}`);
  if (t > length + KEY_TIME_EPSILON) {
    throw new OpError(
      `key: t=${fmt(t)} is after the end of animation ${q(animId)} (duration ${fmt(length)})`,
      created
        ? `pass a "duration" of at least ${fmt(t)} to create the animation long enough`
        : `extend it first: {"op": "update", "kind": "animation", "id": ${q(animId)}, "set": {"duration": ${fmt(t)}}}`,
    );
  }

  const guard = new ItemGuard(doc, 'animation', animation, created);
  if (!Array.isArray(animation.tracks)) setOrdered(animation, 'tracks', [], itemKeys('animation'));
  let track = findTrack(animation, rt.key);
  const newTrack = !track;
  if (!track) {
    track = { target, keys: [] };
    (animation.tracks as unknown[]).push(track);
  }
  if (!Array.isArray(track.keys)) track.keys = [];
  const keys = track.keys as unknown[];
  const notes: string[] = [];
  if (!isSorted(keys)) {
    keys.sort((a, b) => (keyTime(a) ?? 0) - (keyTime(b) ?? 0));
    notes.push('sorted the existing keys by t');
  }
  const same = keys.findIndex((k) => {
    const kt = keyTime(k);
    return kt !== undefined && Math.abs(kt - t) <= KEY_TIME_EPSILON;
  });
  let action: string;
  if (same >= 0) {
    const old = keys[same] as Item;
    const replaced: Item = { t: old.t, v: structuredClone(v) };
    const keptEase = ease === undefined ? old.ease : ease;
    if (keptEase !== undefined) replaced.ease = structuredClone(keptEase);
    keys[same] = replaced;
    action = `replaced the key at t=${fmt(t)} (v ${show(old.v)} → ${show(v)}${ease === undefined && old.ease !== undefined ? `, ease ${show(old.ease)} kept` : ''})`;
  } else {
    const key: Item = { t, v: structuredClone(v), ...(ease !== undefined ? { ease: structuredClone(ease) } : {}) };
    const at = keys.findIndex((k) => (keyTime(k) ?? -Infinity) > t);
    keys.splice(at < 0 ? keys.length : at, 0, key);
    action = `added a key at t=${fmt(t)} (v ${show(v)}${ease !== undefined ? `, ease ${show(ease)}` : ''})`;
  }
  guard.check(`key ${animId}`);
  const where = `${newTrack ? 'new track' : 'track'} ${rt.key} of animation ${q(animId)}`;
  const createdNote = created ? `; created animation ${q(animId)} (duration ${fmt(duration!)} s)` : '';
  return `${action} on ${where}, now ${keys.length} key${keys.length === 1 ? '' : 's'}${createdNote}${notes.length ? `; ${notes.join('; ')}` : ''}`;
}

function isSorted(keys: unknown[]): boolean {
  for (let i = 1; i < keys.length; i++) if ((keyTime(keys[i]) ?? 0) < (keyTime(keys[i - 1]) ?? 0)) return false;
  return true;
}

export function opUnkey(ctx: OpContext, f: Fields): string {
  const { doc } = ctx;
  const animId = f.string('animation', 'animation id');
  const target = f.string('target', 'track target address');
  const t = f.number('t', 'key time in seconds');
  const { item: animation } = requireItem(doc, 'animation', animId);
  const key = canonicalTarget(target)!;
  const found = locateTrack(animation, key, target, animId);
  const i = found.keys.findIndex((k) => {
    const kt = keyTime(k);
    return kt !== undefined && Math.abs(kt - t) <= KEY_TIME_EPSILON;
  });
  if (i < 0) {
    const times = found.keys.flatMap((k) => (keyTime(k) !== undefined ? [fmt(keyTime(k)!)] : []));
    throw new OpError(`unkey: track ${key} of animation ${q(animId)} has no key at t=${fmt(t)}`, `key times: ${times.join(', ') || 'none'}`);
  }
  const [old] = found.keys.splice(i, 1);
  const tail =
    found.keys.length === 0 ? removeTrack(found) : `${found.keys.length} key${found.keys.length === 1 ? '' : 's'} left`;
  return `removed the key at t=${fmt(t)} (v ${show((old as Item).v)}) from track ${key} of animation ${q(animId)}; ${tail}`;
}

function locateTrack(animation: Item, key: string, target: string, animId: string): TrackRef {
  const track = findTrack(animation, key);
  if (!track) {
    const targets = (Array.isArray(animation.tracks) ? animation.tracks : []).flatMap((t) => (isObject(t) && typeof t.target === 'string' ? [t.target] : []));
    throw new OpError(`animation ${q(animId)} has no track for ${q(target)}`, referenceHint(target, targets, 'track targets'));
  }
  return { animation, track, keys: Array.isArray(track.keys) ? track.keys : [] };
}

function removeTrack(found: TrackRef): string {
  const tracks = found.animation.tracks as unknown[];
  tracks.splice(tracks.indexOf(found.track), 1);
  return 'the track had no keys left and was removed';
}
