/**
 * Placing landmarks by hand (pure): a landmark that is not in the document yet gets a sensible
 * starting shape where the person clicks, sized from the illustration; hair strands and
 * attachments are added and removed as whole entries.
 *
 *   placeItem(doc, item, at, image)        the item's values written around `at` (image px)
 *   addStrand(doc, at, image)              a new strand {id, nodes, width} hanging down from `at`
 *   addAttachment(doc, kind, at, image)    a new pendulum / jiggle / cut-out around `at`
 *   removeItemValue(doc, item)             an optional landmark taken out again (null: required)
 *   removeEntry(doc, pointer)              a strand / attachment removed
 *
 * The shapes follow what the spec asks for (an eye opening of 16 points starting at the outer
 * corner and going over the top, regions around it, ...); the person then drags them into place.
 */
import type { AvatarPartItemInfo, SpecPointer } from '../../../src/avatar/index.js';
import { pointerSegments, resolvePointer, setPointer, toSpecPointer } from '../../../src/avatar/parts.js';
import { r1, type SpecDoc, type Vec2 } from './geometry.js';

export interface ImageSize {
  width: number;
  height: number;
}

export type AttachmentKind = 'pendulum' | 'jiggle' | 'cutout';

/** A ring of `n` points around (cx, cy), starting at angle `from` (radians) and turning by `dir`. */
function ring(cx: number, cy: number, rx: number, ry: number, n: number, from = Math.PI, dir: 1 | -1 = 1): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = from + dir * ((i / n) * Math.PI * 2);
    out.push(r1(cx + Math.cos(a) * rx), r1(cy + Math.sin(a) * ry));
  }
  return out;
}

function clampTo(image: ImageSize, [x, y]: Vec2): Vec2 {
  return [r1(Math.min(image.width, Math.max(0, x))), r1(Math.min(image.height, Math.max(0, y)))];
}

function vec(x: number, y: number): Vec2 {
  return [r1(x), r1(y)];
}

/** The polygon an item gets: its size relative to the shorter image side `s`. */
function polygonFor(id: string, x: number, y: number, s: number): number[] {
  const m = /^eyes\.(imageLeft|imageRight)\.(opening|region)$/.exec(id);
  if (m) {
    // Over the top from the OUTER corner: image left -> start on the left, image right -> on the right.
    const left = m[1] === 'imageLeft';
    return m[2] === 'opening' ? ring(x, y, s * 0.045, s * 0.022, 16, left ? Math.PI : 0, left ? 1 : -1) : ring(x, y, s * 0.07, s * 0.045, 12, left ? Math.PI : 0, left ? 1 : -1);
  }
  return ring(x, y, s * 0.05, s * 0.06, 8, -Math.PI / 2);
}

/** The polyline an item gets (brows: across, slightly arched; strands: hanging down). */
function polylineFor(id: string, x: number, y: number, s: number): number[] {
  if (id.startsWith('face.brows.')) {
    const w = s * 0.07;
    return [r1(x - w / 2), r1(y + s * 0.006), r1(x - w / 6), r1(y - s * 0.004), r1(x + w / 6), r1(y - s * 0.004), r1(x + w / 2), r1(y + s * 0.006)];
  }
  const len = s * 0.16;
  return [r1(x), r1(y), r1(x + s * 0.01), r1(y + len / 2), r1(x), r1(y + len)];
}

/**
 * The document with `item` placed around image point `at` (its missing values written; values that
 * are already there stay). Placing one shoulder places both (they are a pair): the other one is
 * mirrored about the image centre.
 */
export function placeItem(doc: SpecDoc, item: AvatarPartItemInfo, at: Vec2, image: ImageSize): SpecDoc {
  const next = structuredClone(doc);
  const s = Math.min(image.width, image.height);
  const [x, y] = clampTo(image, at);
  const put = (pointer: SpecPointer, value: unknown) => {
    if (resolvePointer(next, pointer) === undefined || resolvePointer(next, pointer) === null || item.placed === false) setPointer(next, pointer, value);
  };
  const shape = item.shape;
  switch (shape.type) {
    case 'point': {
      if (item.id.startsWith('body.shoulders.')) {
        const other = item.id.endsWith('imageLeft') ? 1 : 0;
        const list = resolvePointer(next, '/body/shoulders');
        const keep = Array.isArray(list) ? list : [];
        const mirrored = vec(image.width - x, y);
        const pair: Vec2[] = other === 1 ? [vec(x, y), (keep[1] as Vec2) ?? mirrored] : [(keep[0] as Vec2) ?? mirrored, vec(x, y)];
        setPointer(next, '/body/shoulders', pair);
        break;
      }
      put(shape.at, vec(x, y));
      break;
    }
    case 'segment': {
      const half = item.id.startsWith('mouth.') ? s * 0.04 : s * 0.05;
      if (item.id.startsWith('mouth.')) {
        put(shape.a, vec(x - half, y));
        put(shape.b, vec(x + half, y));
      } else {
        // A pendulum: pivot above, tip below.
        put(shape.a, vec(x, y - half));
        put(shape.b, vec(x, y + half));
      }
      break;
    }
    case 'ellipse': {
      const id = item.id;
      put(shape.center, vec(x, y));
      if (id.endsWith('.iris')) put(shape.radius, r1(s * 0.018));
      else if (id === 'head.ellipse') put(shape.radius, vec(s * 0.24, s * 0.27));
      else if (id === 'face.oval') put(shape.radius, vec(s * 0.15, s * 0.19));
      else if (id === 'mouth.area') put(shape.radius, vec(s * 0.06, s * 0.035));
      else if (id === 'body.chest') put(shape.radius, vec(s * 0.16, s * 0.08));
      else put(shape.radius, vec(s * 0.05, s * 0.05));
      if (shape.rotation !== undefined && resolvePointer(next, shape.rotation) === undefined) setPointer(next, shape.rotation, 0);
      break;
    }
    case 'polygon':
      put(shape.points, polygonFor(item.id, x, y, s));
      break;
    case 'polyline':
      put(shape.points, polylineFor(item.id, x, y, s));
      break;
    case 'band': {
      const h = item.id === 'body.fade' ? s * 0.25 : s * 0.08;
      put(shape.range, [r1(y), r1(Math.min(image.height, y + h))]);
      break;
    }
  }
  return next;
}

/** A unique id among the entries of a list ("strand1", "strand2", ...). */
export function uniqueEntryId(doc: unknown, listPointer: SpecPointer, base: string): string {
  const list = resolvePointer(doc, listPointer);
  const used = new Set(Array.isArray(list) ? list.map((e) => (e && typeof e === 'object' ? (e as { id?: unknown }).id : null)).filter((v): v is string => typeof v === 'string') : []);
  for (let n = 1; ; n++) if (!used.has(`${base}${n}`)) return `${base}${n}`;
}

/** Append an entry to a list (created when missing); returns the document and the entry's index. */
function append(doc: SpecDoc, listPointer: SpecPointer, entry: Record<string, unknown>): { doc: SpecDoc; index: number } {
  const next = structuredClone(doc);
  const list = resolvePointer(next, listPointer);
  const items = Array.isArray(list) ? list : [];
  if (!Array.isArray(list)) setPointer(next, listPointer, items);
  items.push(entry);
  return { doc: next, index: items.length - 1 };
}

/** A new hair strand hanging down from `at`: {doc, id} (its item id is "strand.<id>"). */
export function addStrand(doc: SpecDoc, at: Vec2, image: ImageSize): { doc: SpecDoc; id: string } {
  const s = Math.min(image.width, image.height);
  const [x, y] = clampTo(image, at);
  const id = uniqueEntryId(doc, '/hair/strands', 'strand');
  return { doc: append(doc, '/hair/strands', { id, nodes: polylineFor('strand', x, y, s), width: r1(s * 0.04) }).doc, id };
}

/** A new attachment around `at`: {doc, id} (its items are "attachment.<id>.…"). */
export function addAttachment(doc: SpecDoc, kind: AttachmentKind, at: Vec2, image: ImageSize): { doc: SpecDoc; id: string } {
  const s = Math.min(image.width, image.height);
  const [x, y] = clampTo(image, at);
  const id = uniqueEntryId(doc, '/attachments', kind);
  const entry: Record<string, unknown> =
    kind === 'pendulum'
      ? { id, kind, outline: ring(x, y, s * 0.035, s * 0.07, 8, -Math.PI / 2), pivot: vec(x, y - s * 0.06), tip: vec(x, y + s * 0.06) }
      : kind === 'jiggle'
        ? { id, kind, center: vec(x, y), radius: vec(s * 0.05, s * 0.05) }
        : { id, kind, outline: ring(x, y, s * 0.06, s * 0.06, 8, -Math.PI / 2) };
  return { doc: append(doc, '/attachments', entry).doc, id };
}

/** The list entry (strand or attachment) an item belongs to: its pointer, e.g. "/hair/strands/2". */
export function entryPointer(item: AvatarPartItemInfo): SpecPointer | null {
  const pointers = Object.values(item.shape).filter((v): v is string => typeof v === 'string' && v.startsWith('/'));
  const segs = pointers.length ? pointerSegments(pointers[0]) : [];
  if (segs[0] === 'hair' && segs[1] === 'strands' && /^\d+$/.test(segs[2] ?? '')) return toSpecPointer(segs.slice(0, 3));
  if (segs[0] === 'attachments' && /^\d+$/.test(segs[1] ?? '')) return toSpecPointer(segs.slice(0, 2));
  return null;
}

/** Remove a strand or an attachment (the list keeps its other entries). */
export function removeEntry(doc: SpecDoc, pointer: SpecPointer): SpecDoc {
  const next = structuredClone(doc);
  setPointer(next, pointer, undefined);
  return next;
}

/**
 * Take an optional landmark out of the document (iris, brows, ears, cheeks, shoulders, a cut-out's
 * contact). Null for a required one: those can only be moved. Removing the last brow / ear / cheek
 * removes the group object; a shoulder removes both (they are a pair).
 */
export function removeItemValue(doc: SpecDoc, item: AvatarPartItemInfo): SpecDoc | null {
  if (item.required) return null;
  const next = structuredClone(doc);
  const id = item.id;
  const drop = (pointer: SpecPointer) => setPointer(next, pointer, undefined);
  if (id.startsWith('body.shoulders.')) drop('/body/shoulders');
  else if (/^eyes\.image(Left|Right)\.iris$/.test(id)) drop(id === 'eyes.imageLeft.iris' ? '/face/eyes/imageLeft/iris' : '/face/eyes/imageRight/iris');
  else if (id.startsWith('cheeks.')) {
    // Cheeks need both sides: removing one removes the blush.
    drop('/face/cheeks');
  } else if (/^face\.(brows|ears)\./.test(id)) {
    const [, group, side] = id.split('.');
    drop(`/face/${group}/${side}`);
    const rest = resolvePointer(next, `/face/${group}`);
    // Brows come in pairs (both are required by the schema once the group exists).
    if (group === 'brows' || !rest || (typeof rest === 'object' && Object.keys(rest as object).length === 0)) drop(`/face/${group}`);
  } else if (item.shape.type === 'point') drop(item.shape.at);
  else return null;
  return next;
}
