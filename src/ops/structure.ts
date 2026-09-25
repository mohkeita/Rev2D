/**
 * Structural ops: add, update, remove, rename, move. Each returns the result message or throws
 * OpError; the caller provides atomicity (a failed op discards the whole batch).
 */
import type { Mat2D } from '../core/types.js';
import { paramDefault } from '../core/address.js';
import { apply, multiply } from '../core/math.js';
import { formatList } from '../core/validate/text.js';
import {
  boneTrs,
  invertParentWorld,
  isBoneAncestor,
  parentOf,
  reexpressBone,
  setupWorld,
  TRS_FIELDS,
  validNumber,
  validPoint,
  worldRotationToLocal,
  worldToLocal,
} from './bones.js';
import { changeLines } from './diff.js';
import { Cascade } from './cascade.js';
import type { OpContext } from './context.js';
import {
  checkNewId,
  type Doc,
  findItem,
  insertIndex,
  type Item,
  ItemGuard,
  itemKeys,
  itemLabel,
  KIND_ADDRESS,
  KIND_SECTIONS,
  type Kind,
  nestedKeys,
  NOUN,
  parseKind,
  requireItem,
  sectionItems,
  selectItem,
  setOrdered,
} from './model.js';
import { findRefs, pointerOf, renameRef } from './refs.js';
import { animatableProps, boundNote } from './values.js';
import { describe, type Fields, fmt, fmtPoint, isObject, type JsonObject, OpError, q, show, toPointer } from './util.js';

const KIND_HELP = 'parameter | texture | bone | warp | part | binding | ik | physics | animation';

// ----------------------------------------------------------------------------- add

export function opAdd(ctx: OpContext, f: Fields): string {
  const { doc } = ctx;
  const kind = parseKind(f.required('kind', KIND_HELP), 'add');
  const item = structuredClone(f.object('value', `the ${NOUN[kind]} object as it appears in the model file`)) as Item;
  if (kind !== 'binding' && item.id === undefined) {
    throw new OpError(`add: the ${NOUN[kind]} in "value" has no "id"`, 'give it a unique id: letters, digits, _ and -, not starting with a digit, e.g. "leftArm"');
  }
  if (item.id !== undefined) checkNewId(doc, kind, item.id, 'add');

  let worldRotation: number | undefined;
  if (kind === 'bone' && Object.hasOwn(item, 'world')) {
    const world = item.world;
    if (!validPoint(world)) throw new OpError(`add bone: "world" must be [x, y] in setup space, got ${describe(world)}`);
    if (Object.hasOwn(item, 'x') || Object.hasOwn(item, 'y')) {
      throw new OpError('add bone: give either "world" or local "x"/"y", not both', '"world" is converted to local x/y under the parent');
    }
    const [x, y] = worldToLocal(doc, parentOf(item), world);
    replaceKey(item, 'world', { x, y });
  }
  if (kind === 'bone' && Object.hasOwn(item, 'worldRotation')) {
    const w = item.worldRotation;
    if (!validNumber(w)) throw new OpError(`add bone: "worldRotation" must be a number of degrees (setup space, clockwise), got ${describe(w)}`);
    if (Object.hasOwn(item, 'rotation')) {
      throw new OpError('add bone: give either "worldRotation" or local "rotation", not both', '"worldRotation" is converted to local rotation under the parent');
    }
    const scaleX = validNumber(item.scaleX) ? item.scaleX : 1;
    worldRotation = w;
    replaceKey(item, 'worldRotation', { rotation: worldRotationToLocal(doc, parentOf(item), w, scaleX) });
  }

  const items = sectionItems(doc, kind, true);
  const index = insertIndex(items, f, kind, false);
  items.splice(index, 0, item);
  new ItemGuard(doc, kind, item, true).check(`add ${NOUN[kind]}`);
  const added = describeAdded(ctx, kind, item, toPointer([KIND_SECTIONS[kind], index]));
  return worldRotation === undefined ? added : `${added}, rotation ${fmt(item.rotation as number)} (world rotation ${fmt(worldRotation)})`;
}

/** Replace `key` in place (same position) by the given entries. */
function replaceKey(obj: JsonObject, key: string, entries: Record<string, unknown>): void {
  const all = Object.entries(obj);
  for (const k of Object.keys(obj)) delete obj[k];
  for (const [k, v] of all) {
    if (k === key) Object.assign(obj, entries);
    else obj[k] = v;
  }
}

function parentPhrase(doc: Doc, parent: unknown): string {
  if (typeof parent !== 'string') return 'in model space';
  if (findItem(doc, 'bone', parent)) return `under bone ${q(parent)}`;
  if (findItem(doc, 'warp', parent)) return `under warp ${q(parent)}`;
  return `under ${q(parent)}`;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function describeAdded(ctx: OpContext, kind: Kind, item: Item, pointer: string): string {
  const { doc } = ctx;
  const head = `added ${itemLabel(kind, item)} as ${pointer}`;
  const len = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  switch (kind) {
    case 'bone': {
      const parent = parentOf(item);
      const x = typeof item.x === 'number' ? item.x : 0;
      const y = typeof item.y === 'number' ? item.y : 0;
      if (parent === undefined) return `${head}: root bone at ${fmtPoint(x, y)}`;
      let world = '';
      try {
        const w = setupWorld(doc, parent);
        const [wx, wy] = apply(w, x, y);
        world = ` (world ${fmt(wx)}, ${fmt(wy)})`;
      } catch {
        // Parent chain not resolvable yet (e.g. the parent is added later in the batch).
      }
      return `${head} under ${q(parent)} at local ${fmtPoint(x, y)}${world}`;
    }
    case 'parameter': {
      if (typeof item.min !== 'number' || typeof item.max !== 'number') return head;
      const rest = paramDefault({ min: item.min, max: item.max, default: typeof item.default === 'number' ? item.default : undefined });
      return `${head} (range ${fmt(item.min)}..${fmt(item.max)}, default ${fmt(rest)}${item.default === undefined ? ' implicit' : ''})`;
    }
    case 'texture': {
      const size = typeof item.id === 'string' ? ctx.textures[item.id] : undefined;
      return `${head} (path ${show(item.path, 48)}${size ? `, ${size.width}×${size.height}` : ''})`;
    }
    case 'warp': {
      const cols = typeof item.cols === 'number' ? item.cols : 2;
      const rows = typeof item.rows === 'number' ? item.rows : 2;
      return `${head} ${parentPhrase(doc, item.parent)} (${cols}×${rows} cells over rect ${show(item.rect)}, ${(cols + 1) * (rows + 1)} control points)`;
    }
    case 'part': {
      const shape = isObject(item.shape) ? String(item.shape.type) : '?';
      const skin = isObject(item.skin) && Array.isArray(item.skin.bones) ? `skinned to [${item.skin.bones.join(', ')}]` : parentPhrase(doc, item.parent);
      return `${head} (${shape}) ${skin}`;
    }
    case 'binding':
      return `${head} (${count(len(item.keys), 'keyform')})`;
    case 'ik':
      return `${head} (bones [${Array.isArray(item.bones) ? item.bones.join(', ') : '?'}] → target ${show(item.target)})`;
    case 'physics':
      return `${head} (${count(len(item.inputs), 'input')}, ${count(len(item.outputs), 'output')}, ${count(len(item.segments) || 1, 'segment')})`;
    case 'animation':
      return `${head} (${show(item.duration)} s, ${item.loop === false ? 'once' : 'looping'}, ${count(len(item.tracks), 'track')})`;
  }
}

// ----------------------------------------------------------------------------- update

export function opUpdate(ctx: OpContext, f: Fields): string {
  const { doc } = ctx;
  const kind = parseKind(f.required('kind', KIND_HELP), 'update');
  const { item } = selectItem(doc, kind, f);
  const set = f.object('set', '{"<field.path>": value, ...}; null deletes a field');
  const label = itemLabel(kind, item);
  const keys = Object.keys(set);
  if (!keys.length) throw new OpError('update: "set" is empty', 'e.g. "set": {"opacity": 0.5, "shape.rx": 20}');
  if (Object.hasOwn(set, 'id') && (item.id !== undefined || set.id === null)) {
    throw new OpError('update cannot change ids', `use {"op": "rename", "kind": "${kind}", "from": ${q(String(item.id))}, "to": "<newId>"}; it also updates every reference`);
  }
  // Only items without an id (bindings) can get one here; nothing references them yet.
  if (Object.hasOwn(set, 'id')) checkNewId(doc, kind, set.id, 'update');
  const keepWorld = f.optBoolean('keepWorld', 'bones: keep the setup world pose when the parent changes') ?? false;
  if (keepWorld && kind !== 'bone') {
    throw new OpError('update: "keepWorld" applies to bones only', 'parts and warps are authored in setup space, so reparenting them never moves their rest pose');
  }
  for (const k of ['world', 'worldRotation']) {
    if (kind !== 'bone' && Object.hasOwn(set, k)) throw new OpError(`update: "${k}" is only for bones`, `set the ${NOUN[kind]}'s own fields instead`);
  }

  const guard = new ItemGuard(doc, kind, item);
  /** Change lines per updated field path (empty = the value did not change). */
  const changes = new Map<string, string[]>();
  const isBone = kind === 'bone';
  const oldParent = isBone ? parentOf(item) : undefined;
  const parentChanges = isBone && Object.hasOwn(set, 'parent') && (set.parent ?? undefined) !== oldParent;
  if (isBone && parentChanges && typeof set.parent === 'string') {
    const id = String(item.id);
    if (isBoneAncestor(doc, id, set.parent)) {
      throw new OpError(`update: parenting ${q(id)} to ${q(set.parent)} would create a cycle`, `${q(set.parent)} is ${set.parent === id ? 'the bone itself' : `a descendant of ${q(id)}`}`);
    }
  }
  if (keepWorld && parentChanges) {
    // The recomputed transform and the remapped keyforms only fit together without explicit values.
    const explicit = [...TRS_FIELDS, 'world', 'worldRotation'].find((k) => Object.hasOwn(set, k));
    if (explicit) {
      throw new OpError(
        `update: "keepWorld" recomputes x, y, rotation, scaleX and scaleY, so ${q(explicit)} cannot be set in the same update`,
        `reparent first: {"op": "update", "kind": "bone", "id": ${q(String(item.id))}, "set": {"parent": ${JSON.stringify(set.parent)}}, "keepWorld": true}, then change the transform in a second op`,
      );
    }
  }
  const oldParentWorld: Mat2D | undefined = keepWorld && parentChanges ? setupWorld(doc, oldParent) : undefined;
  // A plain reparent keeps the local values, so the bone jumps: say where to (and how not to).
  const oldJoint = parentChanges && !keepWorld && !Object.hasOwn(set, 'world') ? tryJointWorld(doc, item) : undefined;

  const derived = new Set(isBone ? ['world', 'worldRotation'] : []);
  for (const path of keys) {
    if (derived.has(path)) continue;
    const [before, after] = applyField(kind, item, path, set[path]);
    changes.set(path, changeLines(path, before, after));
  }

  const newJoint = oldJoint && tryJointWorld(doc, item);
  if (oldJoint && newJoint && Math.hypot(newJoint[0] - oldJoint[0], newJoint[1] - oldJoint[1]) > 1e-6) {
    const lines = changes.get('parent')!;
    lines[lines.length - 1] += ` (its local transform is kept, so its joint moves from world ${fmtPoint(...oldJoint)} to ${fmtPoint(...newJoint)}; "keepWorld": true keeps it in place)`;
  }

  const extra: string[] = [];
  if (keepWorld) {
    if (!oldParentWorld) {
      extra.push('keepWorld had no effect (parent unchanged)');
    } else {
      const inverse = invertParentWorld(doc, parentOf(item), 'keep the setup world pose in', 'reparent without "keepWorld"');
      extra.push(`kept the setup world pose (${reexpressBone(doc, item, multiply(inverse, oldParentWorld))})`);
    }
  }

  if (isBone && Object.hasOwn(set, 'world')) {
    const world = set.world;
    if (!validPoint(world)) throw new OpError(`update bone: "world" must be [x, y] in setup space, got ${describe(world)}`);
    if (Object.hasOwn(set, 'x') || Object.hasOwn(set, 'y')) throw new OpError('update bone: give either "world" or "x"/"y", not both');
    const before = boneTrs(item);
    const [x, y] = worldToLocal(doc, parentOf(item), world);
    const order = itemKeys('bone');
    setOrdered(item, 'x', x, order);
    setOrdered(item, 'y', y, order);
    const moved = before.x !== x || before.y !== y;
    changes.set('world', moved ? [`world → ${fmtPoint(world[0], world[1])} (local ${fmtPoint(before.x, before.y)} → ${fmtPoint(x, y)})`] : []);
  }

  if (isBone && Object.hasOwn(set, 'worldRotation')) {
    const w = set.worldRotation;
    if (!validNumber(w)) throw new OpError(`update bone: "worldRotation" must be a number of degrees (setup space, clockwise), got ${describe(w)}`);
    if (Object.hasOwn(set, 'rotation')) throw new OpError('update bone: give either "worldRotation" or "rotation", not both', '"worldRotation" is converted to local rotation under the parent');
    const before = boneTrs(item);
    const rotation = worldRotationToLocal(doc, parentOf(item), w, before.scaleX);
    setOrdered(item, 'rotation', rotation, itemKeys('bone'));
    changes.set('worldRotation', rotation !== before.rotation ? [`rotation ${fmt(before.rotation)} → ${fmt(rotation)} (world rotation ${fmt(w)})`] : []);
  }

  guard.check(`update ${label}`);
  return `updated ${label}: ${changeSummary(changes, extra)}${boundNotes(doc, kind, item, keys)}`;
}

/** "a 1 → 2, b deleted (was 3); unchanged: c" or "unchanged (c already had that value)". */
function changeSummary(changes: Map<string, string[]>, extra: string[]): string {
  const lines = [...changes.values()].flat();
  const same = [...changes].flatMap(([path, l]) => (l.length ? [] : [path]));
  if (!lines.length && !extra.length) return `unchanged (${same.join(', ')} already had ${same.length === 1 ? 'that value' : 'those values'})`;
  return `${[...lines, ...extra].join(', ')}${same.length ? `; unchanged: ${same.join(', ')}` : ''}`;
}

/** Notes for updated fields whose setup value bindings override (see boundNote). */
function boundNotes(doc: Doc, kind: Kind, item: Item, paths: string[]): string {
  const addressKind = KIND_ADDRESS[kind];
  if (!addressKind || kind === 'warp' || typeof item.id !== 'string') return '';
  const animatable = animatableProps(kind, item);
  return paths
    .filter((p) => animatable.includes(p))
    .map((p) => boundNote(doc, `${addressKind}:${item.id}.${p}`))
    .join('');
}

/** Setup world position of a bone's joint, or undefined while its parent chain is not valid. */
function tryJointWorld(doc: Doc, bone: Item): [number, number] | undefined {
  try {
    const { x, y } = boneTrs(bone);
    return apply(setupWorld(doc, parentOf(bone)), x, y);
  } catch {
    return undefined;
  }
}

/** Apply one dotted-path assignment (null deletes). Returns the [before, after] values (undefined = unset). */
function applyField(kind: Kind, item: Item, path: string, value: unknown): [unknown, unknown] {
  const segs = path.split('.');
  // "__proto__" would replace the object's prototype instead of adding a field.
  if (segs.some((s) => s === '' || s === '__proto__')) throw new OpError(`update: invalid field path ${q(path)}`, 'use dotted field names, e.g. "shape.rx" or "stroke.width"');
  let container: unknown = item;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    const next = childOf(container, seg, path);
    if (next === undefined) {
      if (value === null) return [undefined, undefined];
      if (Array.isArray(container)) throw new OpError(`update: ${q(segs.slice(0, i + 1).join('.'))} is out of range`);
      const fresh: JsonObject = {};
      setOrdered(container as JsonObject, seg, fresh, nestedKeys(kind, segs.slice(0, i), container as JsonObject));
      container = fresh;
    } else if (next === null || typeof next !== 'object') {
      throw new OpError(`update: cannot set ${q(path)} because ${q(segs.slice(0, i + 1).join('.'))} is ${describe(next)}`, `replace the whole ${q(segs.slice(0, i + 1).join('.'))} value instead`);
    } else {
      container = next;
    }
  }
  const last = segs[segs.length - 1];
  const old = childOf(container, last, path);
  if (Array.isArray(container)) {
    const index = arrayIndex(container, last, path, value === null);
    if (value === null) throw new OpError(`update: null cannot delete array element ${q(path)}`, 'replace the whole array, or use patch {"op": "remove"}');
    container[index] = structuredClone(value);
    return [old, value];
  }
  const obj = container as JsonObject;
  if (value === null) {
    if (!Object.hasOwn(obj, last)) return [undefined, undefined];
    delete obj[last];
    return [old, undefined];
  }
  setOrdered(obj, last, structuredClone(value), nestedKeys(kind, segs.slice(0, -1), obj));
  return [old, value];
}

function childOf(container: unknown, seg: string, path: string): unknown {
  if (Array.isArray(container)) {
    const i = arrayIndex(container, seg, path, true);
    return container[i];
  }
  const obj = container as JsonObject;
  return Object.hasOwn(obj, seg) ? obj[seg] : undefined;
}

function arrayIndex(arr: unknown[], seg: string, path: string, existing: boolean): number {
  const i = /^\d+$/.test(seg) ? Number(seg) : -1;
  const max = existing ? arr.length - 1 : arr.length;
  if (i < 0 || i > max) throw new OpError(`update: ${q(seg)} in ${q(path)} is not a valid index (the array has ${arr.length} items)`, `use 0..${max}`);
  return i;
}

// ----------------------------------------------------------------------------- remove

export function opRemove(ctx: OpContext, f: Fields): string {
  const { doc } = ctx;
  const kind = parseKind(f.required('kind', KIND_HELP), 'remove');
  const { item, index } = selectItem(doc, kind, f);
  const cascade = f.optBoolean('cascade', 'fix up / remove everything that references the item') ?? false;
  const label = itemLabel(kind, item);
  const pointer = toPointer([KIND_SECTIONS[kind], index]);
  const refs = typeof item.id === 'string' ? findRefs(doc, kind, item.id) : [];
  if (refs.length && !cascade) {
    throw new OpError(
      `cannot remove ${label}: it is referenced ${refs.length === 1 ? 'once' : `${refs.length} times`}: ${formatList(refs.map(pointerOf))}`,
      `pass "cascade": true to ${cascadePlan(kind, item)}, or change those references first`,
    );
  }
  const c = new Cascade(doc);
  c.remove(kind, item);
  return `removed ${label} (was ${pointer})${c.log.length ? `; cascade: ${c.log.join('; ')}` : ''}`;
}

function cascadePlan(kind: Kind, item: Item): string {
  const parent = typeof item.parent === 'string' ? q(item.parent) : 'model space';
  switch (kind) {
    case 'bone':
      return `reparent its children to ${parent} (child bones keep their world pose) and drop the skins, bindings, tracks and IK that use it`;
    case 'warp':
      return `reparent its children to ${parent} and remove the bindings/tracks on it`;
    case 'part':
      return 'drop it from masks and remove the bindings/tracks on it';
    case 'parameter':
      return 'remove its tracks, physics entries and single-parameter bindings (multi-parameter bindings drop it and keep the values they had at its default)';
    case 'texture':
      return 'remove the image parts that use it (meshes just lose texture + uvs)';
    default:
      return 'remove the bindings/tracks on it';
  }
}

// ----------------------------------------------------------------------------- rename

export function opRename(ctx: OpContext, f: Fields): string {
  const { doc } = ctx;
  const kind = parseKind(f.required('kind', KIND_HELP), 'rename');
  const from = f.string('from', `current ${NOUN[kind]} id`);
  const to = f.string('to', `new ${NOUN[kind]} id`);
  const { item } = requireItem(doc, kind, from);
  if (from === to) throw new OpError(`rename: "from" and "to" are both ${q(from)}`);
  checkNewId(doc, kind, to, 'rename');
  const refs = findRefs(doc, kind, from);
  for (const ref of refs) renameRef(doc, ref, to);
  item.id = to;
  const detail = refs.length ? `updated ${count(refs.length, 'reference')}: ${formatList(refs.map(pointerOf), 20)}` : 'nothing referenced it';
  return `renamed ${NOUN[kind]} ${q(from)} → ${q(to)}; ${detail}`;
}

// ----------------------------------------------------------------------------- move

export function opMove(ctx: OpContext, f: Fields): string {
  const { doc } = ctx;
  const kind = parseKind(f.required('kind', KIND_HELP), 'move');
  const { items, index, item } = selectItem(doc, kind, f);
  items.splice(index, 1);
  const to = insertIndex(items, f, kind, true, typeof item.id === 'string' ? item.id : undefined);
  items.splice(to, 0, item);
  const label = itemLabel(kind, item);
  const moved = to === index ? `${label} stays at index ${to}` : `moved ${label} from index ${index} to ${to}`;
  return `${moved}${kind === 'part' ? drawOrderNote(items, item) : ''}`;
}

/** Parts draw sorted by z first; say so when the array position alone does not decide the order. */
function drawOrderNote(parts: Item[], moved: Item): string {
  const zOf = (p: Item) => (typeof p.z === 'number' ? p.z : 0);
  const z = zOf(moved);
  const same = parts.filter((p) => isObject(p) && zOf(p) === z);
  if (same.length === parts.length) return '';
  const order = same.map((p) => String(p.id));
  return ` (parts draw by z first: among z=${fmt(z)} parts the order is now ${order.join(', ')})`;
}
