/**
 * Access to the RAW model document: kinds and their sections, id lookups with did-you-mean errors,
 * insert positions, key-order-preserving field writes, per-item structural checks and property
 * address resolution without normalizing the whole model.
 */
import type { z } from 'zod';
import type { Address, Diagnostic, Model, ResolvedTarget, TargetKind } from '../core/types.js';
import {
  AnimationSchema,
  BindingSchema,
  BoneSchema,
  EllipseShapeSchema,
  FillSchema,
  ID_PATTERN,
  IkSchema,
  ImageShapeSchema,
  MeshShapeSchema,
  ModelSchema,
  ParameterSchema,
  PartSchema,
  PathShapeSchema,
  PhysicsSchema,
  PolygonShapeSchema,
  RectShapeSchema,
  SkinSchema,
  StrokeSchema,
  TextureSchema,
  WarpSchema,
} from '../core/schema.js';
import { AddressError, formatAddress, parseAddress, resolveTarget } from '../core/address.js';
import { structuralDiagnostics } from '../core/validate/structural.js';
import { referenceHint } from '../core/validate/text.js';
import { propertyListHint, targetHint } from './hints.js';
import { choiceHint, describe, type Fields, isObject, type JsonObject, OpError, q, toPointer } from './util.js';

export type Doc = JsonObject;
export type Item = JsonObject;

export const KIND_SECTIONS = {
  parameter: 'parameters',
  texture: 'textures',
  bone: 'bones',
  warp: 'warps',
  part: 'parts',
  binding: 'bindings',
  ik: 'ik',
  physics: 'physics',
  animation: 'animations',
} as const;

export type Kind = keyof typeof KIND_SECTIONS;
export type Section = (typeof KIND_SECTIONS)[Kind];
export const KINDS = Object.keys(KIND_SECTIONS) as Kind[];
export const SECTION_KIND = Object.fromEntries(KINDS.map((k) => [KIND_SECTIONS[k], k])) as Record<Section, Kind>;

/** Human noun per kind, for messages. */
export const NOUN: Record<Kind, string> = {
  parameter: 'parameter',
  texture: 'texture',
  bone: 'bone',
  warp: 'warp',
  part: 'part',
  binding: 'binding',
  ik: 'ik constraint',
  physics: 'physics group',
  animation: 'animation',
};

const ITEM_SCHEMA: Record<Section, z.ZodObject> = {
  parameters: ParameterSchema,
  textures: TextureSchema,
  bones: BoneSchema,
  warps: WarpSchema,
  parts: PartSchema,
  bindings: BindingSchema,
  ik: IkSchema,
  physics: PhysicsSchema,
  animations: AnimationSchema,
};

const SHAPE_SCHEMA: Record<string, z.ZodObject> = {
  ellipse: EllipseShapeSchema,
  rect: RectShapeSchema,
  polygon: PolygonShapeSchema,
  path: PathShapeSchema,
  mesh: MeshShapeSchema,
  image: ImageShapeSchema,
};

/** Top-level model keys in file order. */
export const MODEL_KEYS: readonly string[] = Object.keys(ModelSchema.shape);

/** Address kind -> model kind. */
export const ADDRESS_KIND: Record<TargetKind, Kind> = { param: 'parameter', bone: 'bone', warp: 'warp', part: 'part', ik: 'ik' };
/** Model kind -> address kind (only kinds that can be addressed). */
export const KIND_ADDRESS: Partial<Record<Kind, TargetKind>> = { parameter: 'param', bone: 'bone', warp: 'warp', part: 'part', ik: 'ik' };

export function parseKind(v: unknown, opName: string): Kind {
  if (typeof v === 'string' && Object.hasOwn(KIND_SECTIONS, v)) return v as Kind;
  if (v === 'meta') {
    throw new OpError(`${opName}: "meta" is not an item kind`, 'change meta fields with patch, e.g. {"op": "patch", "patch": [{"op": "replace", "path": "/meta/name", "value": "hero"}]}');
  }
  const got = typeof v === 'string' ? v : '';
  throw new OpError(`${opName}: unknown kind ${typeof v === 'string' ? q(v) : describe(v)}`, choiceHint(got, KINDS, 'kinds'));
}

/** The section array of a kind; created (at its canonical key position) when `create` is set. */
export function sectionItems(doc: Doc, kind: Kind, create: true): Item[];
export function sectionItems(doc: Doc, kind: Kind, create?: boolean): Item[] | undefined;
export function sectionItems(doc: Doc, kind: Kind, create = false): Item[] | undefined {
  const section = KIND_SECTIONS[kind];
  const arr = doc[section];
  if (arr === undefined) {
    if (!create) return undefined;
    const fresh: Item[] = [];
    setOrdered(doc, section, fresh, MODEL_KEYS);
    return fresh;
  }
  if (!Array.isArray(arr)) throw new OpError(`"${section}" is not an array (got ${describe(arr)})`, `fix it with patch: {"op": "replace", "path": "/${section}", "value": []}`);
  return arr as Item[];
}

export function idsOf(doc: Doc, kind: Kind): string[] {
  return (sectionItems(doc, kind) ?? []).flatMap((it) => (isObject(it) && typeof it.id === 'string' ? [it.id] : []));
}

export interface Located {
  items: Item[];
  index: number;
  item: Item;
}

export function findItem(doc: Doc, kind: Kind, id: string): Located | undefined {
  const items = sectionItems(doc, kind);
  if (!items) return undefined;
  const index = items.findIndex((it) => isObject(it) && it.id === id);
  return index < 0 ? undefined : { items, index, item: items[index] };
}

/** Find an item or fail with a did-you-mean hint. `role` phrases the lookup, e.g. 'parent bone'. */
export function requireItem(doc: Doc, kind: Kind, id: string, role: string = NOUN[kind]): Located {
  const found = findItem(doc, kind, id);
  if (found) return found;
  throw new OpError(`unknown ${role} ${q(id)}`, referenceHint(id, idsOf(doc, kind), `${NOUN[kind]}s`));
}

/** Label for messages: 'bone "arm"' or, for id-less bindings, 'binding part:mouth.opacity ← [Open]'. */
export function itemLabel(kind: Kind, item: Item): string {
  if (typeof item.id === 'string') return `${NOUN[kind]} ${q(item.id)}`;
  if (kind === 'binding') return `binding ${bindingSignature(item)}`;
  return NOUN[kind];
}

/** "part:mouth.opacity ← [Open]" */
export function bindingSignature(b: Item): string {
  const params = Array.isArray(b.params) ? b.params.map(String).join(', ') : '?';
  return `${String(b.target)} ← [${params}]`;
}

/** Canonical form of an address string (unparseable strings are returned as is). */
export function canonicalTarget(target: unknown): string | undefined {
  if (typeof target !== 'string') return undefined;
  try {
    return formatAddress(parseAddress(target));
  } catch {
    return target;
  }
}

export function sameParamSet(a: unknown, b: readonly string[]): boolean {
  if (!Array.isArray(a) || a.length !== b.length) return false;
  const set = new Set(b);
  return a.every((p) => typeof p === 'string' && set.has(p)) && new Set(a).size === set.size;
}

/**
 * Select the item an op addresses: by "id", or for bindings alternatively by "target" (+ "params").
 */
export function selectItem(doc: Doc, kind: Kind, f: Fields): Located {
  if (kind === 'binding' && !f.has('id')) {
    if (!f.has('target')) throw new OpError(`${f.name}: select the binding with "id" or "target"`, 'e.g. "target": "part:mouth.opacity" (+ "params": ["Open"] when several bindings share it)');
    const target = canonicalTarget(f.string('target', 'address of the bound property'));
    const params = f.has('params') ? f.paramList('params') : undefined;
    const items = sectionItems(doc, 'binding') ?? [];
    const matches = items.flatMap((b, index) =>
      isObject(b) && canonicalTarget(b.target) === target && (!params || sameParamSet(b.params, params)) ? [index] : [],
    );
    if (matches.length === 1) return { items, index: matches[0], item: items[matches[0]] };
    if (matches.length > 1) {
      throw new OpError(
        `${f.name}: ${matches.length} bindings target ${q(target!)}: ${matches.map((i) => `${toPointer(['bindings', i])} (${bindingSignature(items[i])})`).join(', ')}`,
        'add "params" to pick one',
      );
    }
    const targets = [...new Set(items.flatMap((b) => (isObject(b) && typeof b.target === 'string' ? [b.target] : [])))];
    throw new OpError(`${f.name}: no binding targets ${q(target!)}${params ? ` with params [${params.join(', ')}]` : ''}`, referenceHint(target!, targets, 'binding targets'));
  }
  const id = f.string('id', `id of the ${NOUN[kind]}`);
  return requireItem(doc, kind, id);
}

/** Check a new id: pattern, uniqueness within its kind, and the shared bone/warp namespace. */
export function checkNewId(doc: Doc, kind: Kind, id: unknown, opName: string): void {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new OpError(
      `${opName}: invalid ${NOUN[kind]} id ${typeof id === 'string' ? q(id) : describe(id)}`,
      'ids use letters, digits, _ and - and must not start with a digit, e.g. "leftArm"',
    );
  }
  const existing = findItem(doc, kind, id);
  if (existing) {
    throw new OpError(
      `${NOUN[kind]} ${q(id)} already exists (${toPointer([KIND_SECTIONS[kind], existing.index])})`,
      `ids are unique per kind: pick another id (e.g. ${q(freeId(doc, kind, id))}), or use "update" to change the existing one`,
    );
  }
  const other = kind === 'bone' ? 'warp' : kind === 'warp' ? 'bone' : undefined;
  if (other) {
    const clash = findItem(doc, other, id);
    if (clash) {
      throw new OpError(
        `${q(id)} is already used by ${other} ${toPointer([KIND_SECTIONS[other], clash.index])}`,
        `bones and warps share one id namespace (either can be a "parent"); use e.g. ${q(freeId(doc, kind, `${id}${kind === 'warp' ? 'Warp' : 'Bone'}`))}`,
      );
    }
  }
}

function freeId(doc: Doc, kind: Kind, base: string): string {
  const taken = new Set([...idsOf(doc, kind), ...(kind === 'bone' || kind === 'warp' ? idsOf(doc, kind === 'bone' ? 'warp' : 'bone') : [])]);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}${n}`)) return `${base}${n}`;
}

/**
 * Insert position from "index" | "before" | "after". `items` must not contain the item being
 * moved. Returns `items.length` (append) when none is given and `required` is false.
 */
export function insertIndex(items: Item[], f: Fields, kind: Kind, required: boolean, selfId?: string): number {
  const given = (['index', 'before', 'after'] as const).filter((k) => f.has(k));
  if (given.length > 1) throw new OpError(`${f.name}: give only one of "index", "before", "after" (got ${given.join(', ')})`);
  if (given.length === 0) {
    if (required) throw new OpError(`${f.name} needs one of "index", "before", "after"`, 'e.g. "index": 0 (first) or "after": "<id>"');
    return items.length;
  }
  if (given[0] === 'index') {
    const index = f.number('index', 'position');
    if (!Number.isInteger(index) || index < 0 || index > items.length) {
      throw new OpError(`${f.name}: index ${index} is out of range`, `use an integer from 0 to ${items.length} (${items.length} = last)`);
    }
    return index;
  }
  const anchor = f.string(given[0], `id of a ${NOUN[kind]}`);
  if (anchor === selfId) throw new OpError(`${f.name}: cannot place ${q(anchor)} ${given[0]} itself`);
  const at = items.findIndex((it) => isObject(it) && it.id === anchor);
  if (at < 0) {
    const ids = items.flatMap((it) => (isObject(it) && typeof it.id === 'string' ? [it.id] : []));
    throw new OpError(`${f.name}: unknown ${NOUN[kind]} ${q(anchor)} in "${given[0]}"`, referenceHint(anchor, ids, `${NOUN[kind]}s`));
  }
  return given[0] === 'before' ? at : at + 1;
}

// ----------------------------------------------------------------------------- key order

/** Canonical key order of an item section (schema field order). */
export function itemKeys(kind: Kind): readonly string[] {
  return Object.keys(ITEM_SCHEMA[KIND_SECTIONS[kind]].shape);
}

/** Key order of each fill object form, by its "type" (solid, linear, radial). */
const FILL_KEYS: Record<string, readonly string[]> = Object.fromEntries(
  FillSchema.options.flatMap((o) => {
    if (!('shape' in o)) return [];
    const type = (o.shape as { type?: { value?: unknown } }).type?.value;
    return typeof type === 'string' ? [[type, Object.keys(o.shape)]] : [];
  }),
);

/** Canonical key order of a nested object inside an item, or undefined when unknown. */
export function nestedKeys(kind: Kind, path: readonly string[], container: JsonObject): readonly string[] | undefined {
  if (path.length === 0) return itemKeys(kind);
  if (kind !== 'part' || path.length !== 1) return undefined;
  if (path[0] === 'shape' && typeof container.type === 'string' && SHAPE_SCHEMA[container.type]) return Object.keys(SHAPE_SCHEMA[container.type].shape);
  if (path[0] === 'fill' && typeof container.type === 'string' && Object.hasOwn(FILL_KEYS, container.type)) return FILL_KEYS[container.type];
  if (path[0] === 'stroke') return Object.keys(StrokeSchema.shape);
  if (path[0] === 'skin') return Object.keys(SkinSchema.shape);
  return undefined;
}

/**
 * Set `obj[key]`, keeping existing key order. A new key is inserted at its canonical position
 * (before the first existing key that comes after it in `order`), else appended.
 */
export function setOrdered(obj: JsonObject, key: string, value: unknown, order?: readonly string[]): void {
  const rank = order ? order.indexOf(key) : -1;
  if (Object.hasOwn(obj, key) || rank < 0) {
    obj[key] = value;
    return;
  }
  const keys = Object.keys(obj);
  const at = keys.findIndex((k) => order!.indexOf(k) > rank);
  if (at < 0) {
    obj[key] = value;
    return;
  }
  const tail = keys.slice(at).map((k) => [k, obj[k]] as const);
  for (const [k] of tail) delete obj[k];
  obj[key] = value;
  for (const [k, v] of tail) obj[k] = v;
}

// ----------------------------------------------------------------------------- structural checks

/** Structural (schema) errors inside one item, as model diagnostics with pointers and hints. */
export function itemIssues(doc: Doc, kind: Kind, item: Item): Diagnostic[] {
  const section = KIND_SECTIONS[kind];
  const own = ITEM_SCHEMA[section].safeParse(item);
  if (own.success) return [];
  const index = (sectionItems(doc, kind) ?? []).indexOf(item);
  const prefix = toPointer([section, index]);
  const parsed = ModelSchema.safeParse(doc);
  const diags = parsed.success
    ? []
    : structuralDiagnostics(parsed.error.issues, doc).filter((d) => d.severity === 'error' && (d.path === prefix || d.path.startsWith(`${prefix}/`)));
  if (diags.length) return diags;
  // Fallback when the model-level pass attributes the problem elsewhere (e.g. a collapsed union).
  return own.error.issues.map((issue) => ({
    severity: 'error' as const,
    code: `schema-${issue.code.replace(/_/g, '-')}`,
    message: issue.message,
    path: toPointer([section, index, ...issue.path]),
  }));
}

/**
 * Snapshot of an item's structural errors before an edit; `check` fails the op when the edit
 * introduced new ones (pre-existing problems elsewhere in the item are not blamed on the op).
 */
export class ItemGuard {
  private readonly before: Set<string>;
  constructor(
    private readonly doc: Doc,
    private readonly kind: Kind,
    private readonly item: Item,
    fresh = false,
  ) {
    this.before = new Set(fresh ? [] : itemIssues(doc, kind, item).map(issueKey));
  }

  check(label: string): void {
    const added = itemIssues(this.doc, this.kind, this.item).filter((d) => !this.before.has(issueKey(d)));
    if (!added.length) return;
    const d = added[0];
    const more = added.length > 1 ? ` (+${added.length - 1} more problem${added.length > 2 ? 's' : ''})` : '';
    throw new OpError(`${label}: ${d.message} at ${d.path}${more}`, d.hint);
  }
}

function issueKey(d: Diagnostic): string {
  return `${d.path}\u0000${d.code}\u0000${d.message}`;
}

// ----------------------------------------------------------------------------- addresses

export interface RawTarget {
  address: Address;
  /** Canonical address string. */
  key: string;
  resolved: ResolvedTarget;
  kind: Kind;
  item: Item;
  index: number;
}

/**
 * Resolve a property address against the raw document. Only the addressed item is normalized, so
 * unrelated problems elsewhere in the model do not block the op. `paramError` rejects param:
 * addresses with the [message, hint] it returns.
 */
export function resolveRaw(
  doc: Doc,
  target: unknown,
  opName: string,
  paramError?: (address: Address) => [string, string],
  /** The value the op writes, used to make hints concrete. */
  value?: unknown,
): RawTarget {
  if (typeof target !== 'string') throw new OpError(`${opName}: "target" must be an address string, got ${describe(target)}`, 'e.g. "bone:head.rotation" or "part:mouth.shape.ry"');
  let address: Address;
  try {
    address = parseAddress(target);
  } catch (e) {
    if (!(e instanceof AddressError)) throw e;
    throw new OpError(`${opName}: invalid target ${q(target)}: ${e.message}`, e.hint ?? missingPropertyHint(doc, target));
  }
  if (address.kind === 'param' && paramError) {
    const [message, hint] = paramError(address);
    throw new OpError(`${opName}: ${message}`, hint);
  }
  const kind = ADDRESS_KIND[address.kind];
  const { item, index } = requireItem(doc, kind, address.id);
  const section = KIND_SECTIONS[kind];
  const parsed = ITEM_SCHEMA[section].safeParse(item);
  if (!parsed.success) {
    const d = itemIssues(doc, kind, item)[0];
    throw new OpError(`${opName}: ${NOUN[kind]} ${q(address.id)} is not valid (${d ? `${d.message} at ${d.path}` : 'schema error'})`, `fix it first (e.g. with update), then retry`);
  }
  const mini = { parameters: [], bones: [], warps: [], parts: [], ik: [], [section]: [parsed.data] } as unknown as Model;
  try {
    return { address, key: formatAddress(address), resolved: resolveTarget(mini, address), kind, item, index };
  } catch (e) {
    if (!(e instanceof AddressError)) throw e;
    throw new OpError(`${opName}: invalid target ${q(target)}: ${e.message}`, targetHint(opName, address, item, e.hint, value));
  }
}

/** For "kind:id" without a property: the properties of that item (or of the kind). */
function missingPropertyHint(doc: Doc, target: string): string | undefined {
  const colon = target.indexOf(':');
  const kind = target.slice(0, colon) as TargetKind;
  const id = target.slice(colon + 1);
  if (colon < 0 || !Object.hasOwn(ADDRESS_KIND, kind) || !id || id.includes('.')) return undefined;
  return propertyListHint(kind, id, findItem(doc, ADDRESS_KIND[kind], id)?.item);
}
