/**
 * patch: RFC 6902 JSON Patch (add, remove, replace, move, copy, test) with RFC 6901 pointers,
 * the fallback for edits no high-level op covers. Extension: inside an array of id'd items a
 * pointer segment may be an item id instead of an index ("/parts/mouth/opacity").
 */
import { didYouMean, formatQuotedList, referenceHint } from '../core/validate/text.js';
import type { OpContext } from './context.js';
import { itemKeys, KIND_SECTIONS, KINDS, MODEL_KEYS, setOrdered } from './model.js';
import { choiceHint, describe, fieldHint, type Fields, isObject, jsonEqual, type JsonObject, OpError, q, show } from './util.js';

const PATCH_OPS = ['add', 'remove', 'replace', 'move', 'copy', 'test'] as const;
type PatchOpName = (typeof PATCH_OPS)[number];

const PATCH_FIELDS: Record<PatchOpName, readonly string[]> = {
  add: ['path', 'value'],
  remove: ['path'],
  replace: ['path', 'value'],
  move: ['from', 'path'],
  copy: ['from', 'path'],
  test: ['path', 'value'],
};

/** A resolved location: the container and the key/index inside it. */
interface Slot {
  container: JsonObject | unknown[] | null;
  key: string | number;
  /** Canonical pointer (ids resolved to indexes). */
  pointer: string;
}

export function opPatch(ctx: OpContext, f: Fields): string {
  const list = f.array('patch', 'RFC 6902 operations');
  if (!list.length) throw new OpError('patch: "patch" is empty', 'e.g. [{"op": "replace", "path": "/meta/name", "value": "hero"}]');
  const done = list.map((p, j) => applyOne(ctx, p, j));
  return `applied ${done.length} patch operation${done.length === 1 ? '' : 's'}: ${done.join('; ')}`;
}

function applyOne(ctx: OpContext, p: unknown, j: number): string {
  if (!isObject(p)) throw new OpError(`patch[${j}] must be an object like {"op": "replace", "path": "/meta/name", "value": "hero"}, got ${describe(p)}`);
  const name = p.op;
  if (typeof name !== 'string' || !(PATCH_OPS as readonly string[]).includes(name)) {
    throw new OpError(`patch[${j}]: unknown JSON Patch op ${typeof name === 'string' ? q(name) : describe(name)}`, choiceHint(typeof name === 'string' ? name : '', PATCH_OPS, 'ops'));
  }
  const op = name as PatchOpName;
  const allowed = PATCH_FIELDS[op];
  for (const key of Object.keys(p)) {
    if (key !== 'op' && !allowed.includes(key)) throw new OpError(`patch[${j}] (${op}): unknown field ${q(key)}`, fieldHint(key, allowed));
  }
  const where = `patch[${j}] (${op} ${typeof p.path === 'string' ? p.path : '?'})`;
  const path = pointer(p.path, 'path', where);
  if ((op === 'add' || op === 'replace' || op === 'test') && !Object.hasOwn(p, 'value')) throw new OpError(`${where}: needs "value"`);

  switch (op) {
    case 'add': {
      const slot = locate(ctx, path, where, 'add');
      put(ctx, slot, structuredClone(p.value), 'add', where);
      return `add ${shown(slot)} = ${show(p.value, 48)}`;
    }
    case 'remove': {
      const slot = locate(ctx, path, where, 'existing');
      const old = take(slot, where);
      return `remove ${shown(slot)} (was ${show(old, 48)})`;
    }
    case 'replace': {
      const slot = locate(ctx, path, where, 'existing', 'replace');
      const old = read(ctx, slot);
      put(ctx, slot, structuredClone(p.value), 'replace', where);
      return `replace ${shown(slot)}: ${show(old, 40)} → ${show(p.value, 40)}`;
    }
    case 'test': {
      const slot = locate(ctx, path, where, 'existing');
      const actual = read(ctx, slot);
      if (!jsonEqual(actual, p.value)) throw new OpError(`${where}: test failed: ${shown(slot)} is ${show(actual)}, expected ${show(p.value)}`, 'the document is not in the state this patch expects; re-read it and rebuild the patch');
      return `test ${shown(slot)} ok`;
    }
    case 'move':
    case 'copy': {
      const fromPath = pointer(p.from, 'from', where);
      const from = locate(ctx, fromPath, where, 'existing');
      if (op === 'move' && fromPath.length < path.length && fromPath.every((s, k) => s === path[k])) {
        throw new OpError(`${where}: cannot move ${shown(from)} into its own child ${q(String(p.path))}`);
      }
      const value = op === 'move' ? take(from, where) : structuredClone(read(ctx, from));
      // Resolve the destination after removing the source (RFC 6902 §4.4).
      const to = locate(ctx, path, where, 'add');
      put(ctx, to, value, 'add', where);
      return `${op} ${shown(from)} → ${shown(to)}`;
    }
  }
}

/** Pointer for messages; the empty pointer (the whole document) would otherwise print as nothing. */
function shown(slot: Slot): string {
  return slot.pointer === '' ? '"" (the whole document)' : slot.pointer;
}

function pointer(raw: unknown, field: string, where: string): string[] {
  if (typeof raw !== 'string') throw new OpError(`${where}: "${field}" must be a JSON pointer string, got ${describe(raw)}`, 'e.g. "/parts/0/opacity" ("" is the whole document)');
  if (raw === '') return [];
  if (!raw.startsWith('/')) throw new OpError(`${where}: JSON pointer ${q(raw)} must start with "/"`, `did you mean ${q(`/${raw}`)}?`);
  const segs = raw
    .slice(1)
    .split('/')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  // Assigning "__proto__" replaces an object's prototype instead of adding a member.
  if (segs.includes('__proto__')) throw new OpError(`${where}: "__proto__" is not a valid member name`, 'no model object has such a member');
  return segs;
}

function escape(seg: string | number): string {
  return String(seg).replace(/~/g, '~0').replace(/\//g, '~1');
}

/**
 * Resolve a pointer to its container and key. Every parent must exist; the final segment must
 * exist for 'existing', and may be new (or "-" for arrays) for 'add'. `op` names the patch op
 * when a missing final member deserves an op-specific hint ("replace" -> use "add").
 */
function locate(ctx: OpContext, segs: string[], where: string, mode: 'add' | 'existing', op?: 'replace'): Slot {
  if (segs.length === 0) return { container: null, key: '', pointer: '' };
  let cur: unknown = ctx.doc;
  let at = '';
  for (let i = 0; i < segs.length - 1; i++) {
    const key = childKey(cur, segs[i], at, where, 'existing');
    cur = (cur as Record<string | number, unknown>)[key];
    at += `/${escape(key)}`;
  }
  const key = childKey(cur, segs[segs.length - 1], at, where, mode, op);
  return { container: cur as JsonObject | unknown[], key, pointer: `${at}/${escape(key)}` };
}

/** Key of one pointer segment inside `container` (validated for the mode). */
function childKey(container: unknown, seg: string, at: string, where: string, mode: 'add' | 'existing', op?: 'replace'): string | number {
  if (Array.isArray(container)) {
    if (seg === '-') {
      if (mode === 'add') return container.length;
      throw new OpError(`${where}: "-" (end of array) only works for adding`, `the last item of ${at || 'the document'} is /${container.length - 1}`);
    }
    if (/^(0|[1-9]\d*)$/.test(seg)) {
      const i = Number(seg);
      const max = mode === 'add' ? container.length : container.length - 1;
      if (i > max) {
        throw new OpError(`${where}: index ${i} is out of range for ${at || 'the document'} (${container.length} items)`, container.length ? `use 0..${max}${mode === 'add' ? ' or "-" to append' : ''}` : mode === 'add' ? 'use 0 or "-"' : 'the array is empty');
      }
      return i;
    }
    // Extension: an item id selects the item with that id.
    const ids = container.flatMap((it) => (isObject(it) && typeof it.id === 'string' ? [it.id] : []));
    const i = container.findIndex((it) => isObject(it) && it.id === seg);
    if (i >= 0 && mode === 'existing') return i;
    if (i >= 0) throw new OpError(`${where}: ${q(seg)} names an existing item of ${at}; to insert use a numeric index or "-"`);
    throw new OpError(`${where}: ${at}/${escape(seg)} does not exist`, ids.length ? referenceHint(seg, ids, 'ids') : `use an index 0..${container.length - 1}`);
  }
  if (!isObject(container)) throw new OpError(`${where}: ${at || 'the document'} is ${describe(container)}, so it has no member ${q(seg)}`);
  if (mode === 'existing' && !Object.hasOwn(container, seg)) {
    const keys = Object.keys(container);
    const target = `${at}/${escape(seg)}`;
    const typo = didYouMean(seg, keys);
    const hint =
      typo ??
      (op === 'replace'
        ? `"replace" only changes existing members; create it with {"op": "add", "path": ${q(target)}, "value": ...}${keys.length ? ` (existing keys: ${formatQuotedList(keys)})` : ''}`
        : keys.length
          ? referenceHint(seg, keys, 'keys')
          : `${at || 'the document'} is an empty object`);
    throw new OpError(`${where}: ${target} does not exist`, hint);
  }
  return seg;
}

function read(ctx: OpContext, slot: Slot): unknown {
  if (slot.container === null) return ctx.doc;
  return (slot.container as Record<string | number, unknown>)[slot.key];
}

/** Remove and return the value at an existing slot. */
function take(slot: Slot, where: string): unknown {
  if (slot.container === null) throw new OpError(`${where}: cannot remove the whole document`);
  if (Array.isArray(slot.container)) return slot.container.splice(slot.key as number, 1)[0];
  const old = slot.container[slot.key as string];
  delete slot.container[slot.key as string];
  return old;
}

function put(ctx: OpContext, slot: Slot, value: unknown, mode: 'add' | 'replace', where: string): void {
  if (slot.container === null) {
    if (!isObject(value)) throw new OpError(`${where}: the document must stay a JSON object, got ${describe(value)}`);
    // Replace the root in place so the batch keeps working on the same object.
    for (const k of Object.keys(ctx.doc)) delete ctx.doc[k];
    Object.assign(ctx.doc, value);
    return;
  }
  if (Array.isArray(slot.container)) {
    const i = slot.key as number;
    if (mode === 'add') slot.container.splice(i, 0, value);
    else slot.container[i] = value;
    return;
  }
  setOrdered(slot.container, slot.key as string, value, keyOrder(ctx, slot));
}

/** Canonical key order when adding a model-level key or a field of a top-level item. */
function keyOrder(ctx: OpContext, slot: Slot): readonly string[] | undefined {
  if (slot.container === ctx.doc) return MODEL_KEYS;
  const kind = KINDS.find((k) => {
    const items = ctx.doc[KIND_SECTIONS[k]];
    return Array.isArray(items) && items.includes(slot.container);
  });
  return kind && itemKeys(kind);
}
