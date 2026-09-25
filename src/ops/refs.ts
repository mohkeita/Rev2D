/**
 * Cross-references in the raw document: every place that refers to an item by id, so rename can
 * rewrite them and remove can refuse (listing JSON pointers) or cascade.
 */
import { parseAddress } from '../core/address.js';
import type { Address } from '../core/types.js';
import { type Doc, type Item, KIND_ADDRESS, KIND_SECTIONS, type Kind, type Section, sectionItems } from './model.js';
import { isObject, toPointer } from './util.js';

export type RefType =
  /** bones/warps/parts `parent` */
  | 'parent'
  /** parts `skin.bones[j]` */
  | 'skin'
  /** parts `mask[j]` */
  | 'mask'
  /** binding `target` (owner = binding) or track `target` (owner = animation, track set) */
  | 'target'
  /** binding `params[j]` */
  | 'binding-param'
  | 'ik-bone'
  | 'ik-target'
  | 'physics-input'
  | 'physics-output'
  /** image / mesh `shape.texture` */
  | 'texture';

export interface Ref {
  type: RefType;
  /** Path of the referencing value from the document root. */
  path: Array<string | number>;
  /** Section and object of the item that holds the reference. */
  section: Section;
  owner: Item;
  /** For track targets: the track object inside `owner` (an animation). */
  track?: Item;
  /** For physics refs: the input/output entry object. */
  entry?: Item;
}

export function pointerOf(ref: Ref): string {
  return toPointer(ref.path);
}

function addressOf(target: unknown): Address | undefined {
  if (typeof target !== 'string') return undefined;
  try {
    return parseAddress(target);
  } catch {
    return undefined;
  }
}

function each(doc: Doc, kind: Kind, fn: (item: Item, index: number) => void): void {
  (sectionItems(doc, kind) ?? []).forEach((item, i) => {
    if (isObject(item)) fn(item, i);
  });
}

/** Every reference to the item `id` of `kind`, in document order. */
export function findRefs(doc: Doc, kind: Kind, id: string): Ref[] {
  const refs: Ref[] = [];
  const add = (ref: Ref) => refs.push(ref);

  if (kind === 'bone' || kind === 'warp') {
    // Parents: bones only have bone parents; warps and parts have bone or warp parents.
    const parentKinds: Kind[] = kind === 'bone' ? ['bone', 'warp', 'part'] : ['warp', 'part'];
    for (const pk of parentKinds) {
      each(doc, pk, (item, i) => {
        if (item.parent === id) add({ type: 'parent', path: [KIND_SECTIONS[pk], i, 'parent'], section: KIND_SECTIONS[pk], owner: item });
      });
    }
  }
  if (kind === 'bone') {
    each(doc, 'part', (part, i) => {
      const skin = part.skin;
      if (isObject(skin) && Array.isArray(skin.bones)) {
        skin.bones.forEach((b, j) => {
          if (b === id) add({ type: 'skin', path: ['parts', i, 'skin', 'bones', j], section: 'parts', owner: part });
        });
      }
    });
    each(doc, 'ik', (ik, i) => {
      if (Array.isArray(ik.bones)) {
        ik.bones.forEach((b, j) => {
          if (b === id) add({ type: 'ik-bone', path: ['ik', i, 'bones', j], section: 'ik', owner: ik });
        });
      }
      if (ik.target === id) add({ type: 'ik-target', path: ['ik', i, 'target'], section: 'ik', owner: ik });
    });
  }
  if (kind === 'part') {
    each(doc, 'part', (part, i) => {
      if (Array.isArray(part.mask)) {
        part.mask.forEach((m, j) => {
          if (m === id) add({ type: 'mask', path: ['parts', i, 'mask', j], section: 'parts', owner: part });
        });
      }
    });
  }
  if (kind === 'texture') {
    each(doc, 'part', (part, i) => {
      if (isObject(part.shape) && part.shape.texture === id) add({ type: 'texture', path: ['parts', i, 'shape', 'texture'], section: 'parts', owner: part });
    });
  }
  if (kind === 'parameter') {
    each(doc, 'binding', (b, i) => {
      if (Array.isArray(b.params)) {
        b.params.forEach((p, j) => {
          if (p === id) add({ type: 'binding-param', path: ['bindings', i, 'params', j], section: 'bindings', owner: b });
        });
      }
    });
    each(doc, 'physics', (g, i) => {
      for (const [list, type] of [
        ['inputs', 'physics-input'],
        ['outputs', 'physics-output'],
      ] as const) {
        const entries = g[list];
        if (!Array.isArray(entries)) continue;
        entries.forEach((e, j) => {
          if (isObject(e) && e.param === id) add({ type, path: ['physics', i, list, j, 'param'], section: 'physics', owner: g, entry: e });
        });
      }
    });
  }

  // Address strings in binding and track targets.
  const addressKind = KIND_ADDRESS[kind];
  if (addressKind) {
    const matches = (target: unknown) => {
      const a = addressOf(target);
      return a !== undefined && a.kind === addressKind && a.id === id;
    };
    each(doc, 'binding', (b, i) => {
      if (matches(b.target)) add({ type: 'target', path: ['bindings', i, 'target'], section: 'bindings', owner: b });
    });
    each(doc, 'animation', (a, i) => {
      if (!Array.isArray(a.tracks)) return;
      a.tracks.forEach((t, j) => {
        if (isObject(t) && matches(t.target)) add({ type: 'target', path: ['animations', i, 'tracks', j, 'target'], section: 'animations', owner: a, track: t });
      });
    });
  }

  return sortByPath(refs);
}

/** Document order: section order of the model file, then numeric indexes. */
function sortByPath(refs: Ref[]): Ref[] {
  const rank = Object.values(KIND_SECTIONS) as string[];
  const cmp = (a: Ref, b: Ref): number => {
    const n = Math.max(a.path.length, b.path.length);
    for (let k = 0; k < n; k++) {
      const x = a.path[k];
      const y = b.path[k];
      if (x === y) continue;
      if (x === undefined) return -1;
      if (y === undefined) return 1;
      if (k === 0) return rank.indexOf(String(x)) - rank.indexOf(String(y));
      if (typeof x === 'number' && typeof y === 'number') return x - y;
      return String(x) < String(y) ? -1 : 1;
    }
    return 0;
  };
  return refs.sort(cmp);
}

/** Rewrite one reference to point at `to` (address strings keep their property path). */
export function renameRef(doc: Doc, ref: Ref, to: string): void {
  let holder: unknown = doc;
  for (const seg of ref.path.slice(0, -1)) holder = (holder as Record<string | number, unknown>)[seg];
  const key = ref.path[ref.path.length - 1];
  const container = holder as Record<string | number, unknown>;
  if (ref.type === 'target') {
    const a = addressOf(container[key])!;
    container[key] = a.prop.length ? `${a.kind}:${to}.${a.prop.join('.')}` : `${a.kind}:${to}`;
  } else {
    container[key] = to;
  }
}
