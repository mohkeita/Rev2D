/**
 * The editable geometry of an avatar spec, grouped the way the editor lists it: Head, Eyes, Mouth,
 * Face, Cheeks, Hair strands, Attachments, Body. One description drives the editor handles, the
 * overlay images (`rev2d avatar overlay`) and the list of landmarks a draft still misses.
 *
 * Everything here works on the RAW avatar.json document, which may be an unfinished draft: values
 * are looked up through JSON pointers (RFC 6901) and anything missing or malformed is simply "not
 * placed" (`placed: false`), never an exception.
 *
 *   describeAvatarParts(doc)  groups -> items (id, label, handle shape, cutsLayers, tip, required, placed)
 *   avatarLandmarks(doc)      the same geometry per JSON pointer (one entry per value an author writes)
 *   resolveShape(doc, shape)  a handle shape with its numbers read from the document, or null
 *   resolvePointer / setPointer / toSpecPointer   pointer plumbing for consumers that edit the document
 *
 * Conventions consumers rely on:
 * - Group colours are fixed and colour-blind friendly (Okabe-Ito hues plus a neutral grey).
 * - `cutsLayers` is true exactly for the items whose values are part of layerInputsHash (./hash.ts):
 *   moving them makes the layer images stale; everything else only needs a recompile.
 * - An ellipse's `radius` pointer addresses either [rx, ry] or a single number (a circle: the iris).
 * - Optional landmarks (iris, brows, ears, cheeks, shoulders, a cut-out's contact point) are listed
 *   even when absent, with `required: false` and `placed: false`, so the editor can offer to add them.
 */
import { ownValue, toPointer } from '../core/validate/diagnostics.js';
import type { AvatarPartGroup, AvatarPartGroupId, AvatarPartItem, HandleShape, ImageSide, SpecPointer } from './types.js';
import type { Vec2 } from './tools/geometry.js';

export interface AvatarPartItemInfo extends AvatarPartItem {
  /** False for optional landmarks: a spec is complete without them. */
  required: boolean;
  /** True when every value of the handle shape is present and well-formed in this document. */
  placed: boolean;
}

export interface AvatarPartGroupInfo extends AvatarPartGroup {
  items: AvatarPartItemInfo[];
}

export interface AvatarPartGroupMeta {
  id: AvatarPartGroupId;
  category: AvatarPartGroup['category'];
  label: string;
  description: string;
  color: string;
}

/** The groups in display order, with their fixed colours. */
export const AVATAR_PART_GROUPS: readonly AvatarPartGroupMeta[] = [
  {
    id: 'head',
    category: 'face',
    label: 'Head',
    description: 'What turns and tilts: the ellipse around the whole head, the neck pivot and the band where the head motion fades out.',
    color: '#56B4E9',
  },
  {
    id: 'eyes',
    category: 'face',
    label: 'Eyes',
    description: 'Per eye: the opening that closes when the eye blinks, and the region that holds its lashes and lids.',
    color: '#F0E442',
  },
  {
    id: 'mouth',
    category: 'face',
    label: 'Mouth',
    description: 'The closed-mouth line between both corners and the area an open mouth may change.',
    color: '#D55E00',
  },
  {
    id: 'face',
    category: 'face',
    label: 'Face',
    description: 'Face oval, nose tip and chin (optional brows and ears): where the head turn is strongest.',
    color: '#009E73',
  },
  { id: 'cheeks', category: 'face', label: 'Cheeks', description: 'Optional blush centres.', color: '#CC79A7' },
  {
    id: 'strands',
    category: 'hair',
    label: 'Hair strands',
    description: 'Locks of hair that sway with physics: polylines from the root to the tip.',
    color: '#E69F00',
  },
  {
    id: 'attachments',
    category: 'body',
    label: 'Attachments',
    description: 'Hanging accessories, wobbling buns and things in front of the face or body.',
    color: '#0072B2',
  },
  {id:'arms',category:'body',label:'Arms and hands',description:'Authored shoulders, elbows, wrists, glove cuts and arm outlines.',color:'#7F3C8D'},
  {id:'legs',category:'body',label:'Leg anchors',description:'Hips and planted feet for standing or seated figures.',color:'#303030'},
  {
    id: 'body',
    category: 'body',
    label: 'Body',
    description: 'Body sway pivot and fade band, the chest that breathes, optional shoulders.',
    color: '#BBBBBB',
  },
];

export const AVATAR_PART_GROUP_IDS: readonly AvatarPartGroupId[] = AVATAR_PART_GROUPS.map((g) => g.id);

// ----------------------------------------------------------------------------- pointers

/** JSON pointer for path segments, e.g. ["hair", "strands", 0, "nodes"] -> "/hair/strands/0/nodes". */
export function toSpecPointer(segments: readonly PropertyKey[]): SpecPointer {
  return toPointer(segments);
}

/** Segments of a JSON pointer ("" = the root = no segments). */
export function pointerSegments(pointer: SpecPointer): string[] {
  if (pointer === '') return [];
  return pointer
    .slice(1)
    .split('/')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/** The value a pointer addresses in a raw document; undefined when any step is missing. */
export function resolvePointer(doc: unknown, pointer: SpecPointer): unknown {
  let value = doc;
  for (const seg of pointerSegments(pointer)) value = ownValue(value, seg);
  return value;
}

/**
 * Set the value a pointer addresses, in place. Missing containers on the way are created as
 * objects (as arrays when the next segment is an array index); `undefined` deletes the key.
 * Throws when a step leads through a value that is not a container.
 */
export function setPointer(doc: Record<string, unknown> | unknown[], pointer: SpecPointer, value: unknown): void {
  const segs = pointerSegments(pointer);
  if (segs.length === 0) throw new Error('setPointer: cannot replace the document root');
  let container: Record<string, unknown> = doc as Record<string, unknown>;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    let next = Object.hasOwn(container, seg) ? container[seg] : undefined;
    if (next === undefined || next === null) {
      next = /^\d+$/.test(segs[i + 1]) ? [] : {};
      container[seg] = next;
    }
    if (typeof next !== 'object') throw new Error(`setPointer: ${toPointer(segs.slice(0, i + 1))} is not an object or array`);
    container = next as Record<string, unknown>;
  }
  const last = segs[segs.length - 1];
  if (value === undefined) {
    if (Array.isArray(container)) container.splice(Number(last), 1);
    else delete container[last];
  } else {
    container[last] = value;
  }
}

// ----------------------------------------------------------------------------- reading values

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** [x, y] of finite numbers, else null. */
export function readVec(v: unknown): Vec2 | null {
  return Array.isArray(v) && v.length === 2 && finite(v[0]) && finite(v[1]) ? [v[0], v[1]] : null;
}

/** [rx, ry] (both > 0), or a single positive number as a circle; else null. */
export function readRadius(v: unknown): Vec2 | null {
  if (finite(v)) return v > 0 ? [v, v] : null;
  const r = readVec(v);
  return r && r[0] > 0 && r[1] > 0 ? r : null;
}

/** A flat list of finite numbers (any length, possibly odd), else null. */
export function readPoints(v: unknown): number[] | null {
  const flat = Array.isArray(v) ? v.flat() : v;
  return Array.isArray(flat) && flat.every(finite) ? (flat as number[]) : null;
}

export type ResolvedShape =
  | { type: 'point'; at: Vec2 }
  | { type: 'ellipse'; center: Vec2; radius: Vec2; rotation: number }
  | { type: 'polygon' | 'polyline'; points: number[] }
  | { type: 'band'; range: Vec2 }
  | { type: 'segment'; a: Vec2; b: Vec2 };

/**
 * A handle shape with its numbers read from the document; null when a value is missing or
 * malformed. Point lists keep their complete points (a dangling last value is dropped) and need at
 * least one point; an absent or malformed ellipse rotation counts as 0.
 */
export function resolveShape(doc: unknown, shape: HandleShape): ResolvedShape | null {
  switch (shape.type) {
    case 'point': {
      const at = readVec(resolvePointer(doc, shape.at));
      return at ? { type: 'point', at } : null;
    }
    case 'ellipse': {
      const center = readVec(resolvePointer(doc, shape.center));
      const radius = readRadius(resolvePointer(doc, shape.radius));
      if (!center || !radius) return null;
      const rotation = shape.rotation !== undefined ? resolvePointer(doc, shape.rotation) : 0;
      return { type: 'ellipse', center, radius, rotation: finite(rotation) ? rotation : 0 };
    }
    case 'polygon':
    case 'polyline': {
      const points = readPoints(resolvePointer(doc, shape.points));
      if (!points || points.length < 2) return null;
      return { type: shape.type, points: points.length % 2 ? points.slice(0, -1) : points };
    }
    case 'band': {
      const range = readVec(resolvePointer(doc, shape.range));
      return range ? { type: 'band', range } : null;
    }
    case 'segment': {
      const a = readVec(resolvePointer(doc, shape.a));
      const b = readVec(resolvePointer(doc, shape.b));
      return a && b ? { type: 'segment', a, b } : null;
    }
  }
}

// ----------------------------------------------------------------------------- item definitions

export type LandmarkRole = 'at' | 'center' | 'radius' | 'rotation' | 'points' | 'range' | 'a' | 'b';

interface ItemDef {
  id: string;
  label: string;
  shape: HandleShape;
  cutsLayers?: boolean;
  tip: string;
  required?: boolean;
  /** Names of single values, when "<label> centre" / "<label> (first point)" would be unclear. */
  roleLabels?: Partial<Record<LandmarkRole, string>>;
  /** Placement tips of single values (default: the item's tip). */
  roleTips?: Partial<Record<LandmarkRole, string>>;
}

const SIDES: readonly ImageSide[] = ['imageLeft', 'imageRight'];
const SIDE_TEXT: Record<ImageSide, string> = { imageLeft: 'image left', imageRight: 'image right' };

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function headItems(): ItemDef[] {
  return [
    {
      id: 'head.ellipse',
      label: 'Head ellipse',
      shape: { type: 'ellipse', center: '/head/center', radius: '/head/radius' },
      cutsLayers: true,
      tip: 'Cover the WHOLE head with all hair and head accessories; avoid the shoulders where possible.',
      roleTips: {
        center: 'horizontally on the face centre, vertically slightly above the eyes',
        radius: 'large enough to cover the whole head with all hair and head accessories; avoid the shoulders where possible',
      },
    },
    {
      id: 'head.pivot',
      label: 'Neck pivot',
      shape: { type: 'point', at: '/head/pivot' },
      tip: 'Centre of the neck, above the collarbone: the head tilts around it.',
    },
    {
      id: 'head.neck',
      label: 'Neck band',
      shape: { type: 'band', range: '/head/neck' },
      tip: 'yStart just below the chin, yEnd near the collarbone: the head moves fully above yStart and not at all below yEnd.',
    },
  ];
}

function eyeItems(): ItemDef[] {
  return SIDES.flatMap((side): ItemDef[] => {
    const base = `/face/eyes/${side}`;
    const name = `Eye (${SIDE_TEXT[side]})`;
    return [
      {
        id: `eyes.${side}.opening`,
        label: `${name}: opening`,
        shape: { type: 'polygon', points: `${base}/opening` },
        cutsLayers: true,
        tip: 'Trace the visible eye white + iris INSIDE the lashes: 14-20 points, starting at the outer corner and going over the top. Use a zoomed 5 px grid; no lashes, no skin.',
      },
      {
        id: `eyes.${side}.region`,
        label: `${name}: region`,
        shape: { type: 'polygon', points: `${base}/region` },
        cutsLayers: true,
        tip: 'A polygon 10-20 px OUTSIDE the lashes and the lower lid line: every lash, lid and crease stroke of this eye, and no hair where avoidable.',
      },
      {
        id: `eyes.${side}.iris`,
        label: `${name}: iris`,
        shape: { type: 'ellipse', center: `${base}/iris/center`, radius: `${base}/iris/radius` },
        required: false,
        tip: 'Optional: centre and radius of the iris circle (improves the gaze parameters).',
      },
    ];
  });
}

function mouthItems(): ItemDef[] {
  return [
    {
      id: 'mouth.corners',
      label: 'Mouth corners',
      shape: { type: 'segment', a: '/face/mouth/imageLeft', b: '/face/mouth/imageRight' },
      tip: 'Both ends of the closed-mouth line: the corner on the image left, then the corner on the image right.',
      roleLabels: { a: 'Mouth corner (image left)', b: 'Mouth corner (image right)' },
      roleTips: { a: 'the end of the mouth line on the image left', b: 'the end of the mouth line on the image right' },
    },
    {
      id: 'mouth.area',
      label: 'Mouth area',
      shape: { type: 'ellipse', center: '/face/mouth/area/center', radius: '/face/mouth/area/radius', rotation: '/face/mouth/area/rotation' },
      cutsLayers: true,
      tip: 'An ellipse a little larger than the lips: room for an open mouth, not reaching the chin or the nose.',
      roleTips: {
        center: 'the middle of the lips',
        radius: 'a little larger than the lips: room for an open mouth, not reaching the chin or the nose',
      },
    },
  ];
}

function faceItems(): ItemDef[] {
  return [
    {
      id: 'face.oval',
      label: 'Face oval',
      shape: { type: 'ellipse', center: '/face/center', radius: '/face/radius' },
      tip: 'Skin only: from the hairline to the chin and from cheek to cheek.',
      roleTips: {
        center: 'roughly between the eyes and the nose tip',
        radius: 'skin only: horizontally from cheek to cheek, vertically from the hairline to the chin',
      },
    },
    { id: 'face.nose', label: 'Nose tip', shape: { type: 'point', at: '/face/nose' }, tip: 'The tip of the nose.' },
    { id: 'face.chin', label: 'Chin', shape: { type: 'point', at: '/face/chin' }, tip: 'The tip of the chin.' },
    ...SIDES.map(
      (side): ItemDef => ({
        id: `face.brows.${side}`,
        label: `Brow (${SIDE_TEXT[side]})`,
        shape: { type: 'polyline', points: `/face/brows/${side}` },
        required: false,
        tip: 'Optional: 3-5 points along the brow. Leave the brows out when hair hides them.',
      }),
    ),
    ...SIDES.map(
      (side): ItemDef => ({
        id: `face.ears.${side}`,
        label: `Ear (${SIDE_TEXT[side]})`,
        shape: { type: 'point', at: `/face/ears/${side}` },
        required: false,
        tip: 'Optional: the centre of a visible ear (ears move less than the face centre when the head turns).',
      }),
    ),
  ];
}

function cheekItems(): ItemDef[] {
  return SIDES.map(
    (side): ItemDef => ({
      id: `cheeks.${side}`,
      label: `Cheek (${SIDE_TEXT[side]})`,
      shape: { type: 'point', at: `/face/cheeks/${side}` },
      required: false,
      tip: 'Optional: the centre of the blush on this cheek.',
    }),
  );
}

/** A readable, unique key for list entries: their id when it is a usable string, else "#<index>". */
function entryKeys(entries: readonly unknown[]): string[] {
  const seen = new Set<string>();
  return entries.map((e, i) => {
    const id = isObject(e) && typeof e.id === 'string' && e.id !== '' ? e.id : `#${i}`;
    const key = seen.has(id) ? `${id}#${i}` : id;
    seen.add(key);
    return key;
  });
}

function strandItems(doc: unknown): ItemDef[] {
  const strands = resolvePointer(doc, '/hair/strands');
  if (!Array.isArray(strands)) return [];
  const keys = entryKeys(strands);
  return strands.flatMap((s, i): ItemDef[] =>
    isObject(s)
      ? [
          {
            id: `strand.${keys[i]}`,
            label: `Strand "${keys[i]}"`,
            shape: { type: 'polyline', points: `/hair/strands/${i}/nodes` },
            cutsLayers: true,
            tip: 'From the ROOT of the lock (on the head) to its TIP: 2-6 points, entirely on hair.',
          },
        ]
      : [],
  );
}

function attachmentItems(doc: unknown): ItemDef[] {
  const list = resolvePointer(doc, '/attachments');
  if (!Array.isArray(list)) return [];
  const keys = entryKeys(list);
  return list.flatMap((a, i): ItemDef[] => {
    if (!isObject(a)) return [];
    const base = `/attachments/${i}`;
    const id = `attachment.${keys[i]}`;
    switch (a.kind) {
      case 'pendulum':
        return [
          {
            id: `${id}.outline`,
            label: `Pendulum "${keys[i]}": outline`,
            shape: { type: 'polygon', points: `${base}/outline` },
            cutsLayers: true,
            tip: 'A polygon around the whole hanging object (tassel, earring, ribbon end).',
          },
          {
            id: `${id}.swing`,
            label: `Pendulum "${keys[i]}": pivot to tip`,
            shape: { type: 'segment', a: `${base}/pivot`, b: `${base}/tip` },
            tip: 'From the pivot (where it hangs from; this point stays fixed) to the tip (its free end).',
            roleLabels: { a: `Pendulum "${keys[i]}": pivot`, b: `Pendulum "${keys[i]}": tip` },
            roleTips: { a: 'where the object hangs from (this point stays fixed)', b: 'the free end of the object' },
          },
        ];
      case 'jiggle':
        return [
          {
            id: `${id}.ellipse`,
            label: `Jiggle "${keys[i]}"`,
            shape: { type: 'ellipse', center: `${base}/center`, radius: `${base}/radius` },
            tip: 'An ellipse around the whole springy mass (e.g. a hair bun, without its ribbons).',
          },
        ];
      case 'cutout':
        return [
          {
            id: `${id}.outline`,
            label: `Cut-out "${keys[i]}": outline`,
            shape: { type: 'polygon', points: `${base}/outline` },
            cutsLayers: true,
            tip: 'A polygon around everything that lies IN FRONT (e.g. a hand and forearm over the chin).',
          },
          {
            id: `${id}.contact`,
            label: `Cut-out "${keys[i]}": contact`,
            shape: { type: 'point', at: `${base}/contact` },
            required: false,
            tip: 'Optional: where it touches the head (e.g. a fingertip on the chin); that end follows the head a little.',
          },
        ];
      default:
        return [];
    }
  });
}

function bodyItems(doc:unknown): ItemDef[] {
  return [
    {
      id: 'body.pivot',
      label: 'Body pivot',
      shape: { type: 'point', at: '/body/pivot' },
      tip: 'Middle of the lower torso, near (or below) the bottom of the image: the body sways around it.',
    },
    {
      id: 'body.fade',
      label: 'Body fade band',
      shape: { type: 'band', range: '/body/fade' },
      tip: 'yStart at the upper body (full sway above it), yEnd at the anchored bottom (no sway below it).',
    },
    {
      cutsLayers: Array.isArray(resolvePointer(doc,'/arms'))&&(resolvePointer(doc,'/arms') as unknown[]).length>0,
      id: 'body.chest',
      label: 'Chest',
      shape: { type: 'ellipse', center: '/body/chest/center', radius: '/body/chest/radius' },
      tip: 'An ellipse over the chest: the region that rises when breathing.',
    },
    ...SIDES.map(
      (side, i): ItemDef => ({
        id: `body.shoulders.${side}`,
        label: `Shoulder (${SIDE_TEXT[side]})`,
        shape: { type: 'point', at: `/body/shoulders/${i}` },
        required: false,
        tip: 'Optional: the centre of this shoulder (shoulders rise slightly with the breath; give both or none).',
      }),
    ),
  ];
}

function armItems(doc:unknown):ItemDef[] {
  const list=resolvePointer(doc,'/arms');if(!Array.isArray(list))return [];
  return list.flatMap((arm,i):ItemDef[]=>{if(!isObject(arm))return [];const base=`/arms/${i}`,id=`arms.${typeof arm.id==='string'?arm.id:i}`;
    return [
      ...['shoulder','elbow','wrist'].map((key):ItemDef=>({id:`${id}.${key}`,label:`${arm.id}: ${key}`,shape:{type:'point',at:`${base}/${key}`},cutsLayers:true,tip:'Place at the joint centre on the original arm drawing.'})),
      {id:`${id}.outline`,label:`${arm.id}: arm outline`,shape:{type:'polygon',points:`${base}/outline`},cutsLayers:true,required:false,tip:'Optional outline covering upper arm and forearm; exclude the glove.'},
      {id:`${id}.hand`,label:`${arm.id}: glove`,shape:{type:'ellipse',center:`${base}/hand/center`,radius:`${base}/hand/radius`},cutsLayers:true,tip:'Cover the original glove; keep the wrist touching the forearm.'},
      {id:`${id}.handOutline`,label:`${arm.id}: glove outline`,shape:{type:'polygon',points:`${base}/hand/outline`},cutsLayers:true,required:false,tip:'Optional polygon following the glove silhouette.'}
    ];});
}
function legItems(doc:unknown):ItemDef[] {
  if(!isObject(resolvePointer(doc,'/legs')))return [];
  return [{id:'legs.hips',label:'Hip pivot',shape:{type:'point',at:'/legs/hips'},cutsLayers:Array.isArray(resolvePointer(doc,'/arms'))&&(resolvePointer(doc,'/arms') as unknown[]).length>0,tip:'Centre of the hips; seated figures pivot here.'},
    ...[0,1].map((i):ItemDef=>({id:`legs.foot${i}`,label:`Planted foot ${i+1}`,shape:{type:'point',at:`/legs/feet/${i}`},tip:'Ground contact of each foot. Feet remain still during upper-body motion.'}))];
}

function groupDefs(doc: unknown): Record<AvatarPartGroupId, ItemDef[]> {
  return {
    head: headItems(),
    eyes: eyeItems(),
    mouth: mouthItems(),
    face: faceItems(),
    cheeks: cheekItems(),
    strands: strandItems(doc),
    attachments: attachmentItems(doc),
    body: bodyItems(doc),
    arms: armItems(doc),
    legs: legItems(doc),
  };
}

function toItem(doc: unknown, def: ItemDef): AvatarPartItemInfo {
  return {
    id: def.id,
    label: def.label,
    shape: def.shape,
    cutsLayers: def.cutsLayers ?? false,
    tip: def.tip,
    required: def.required ?? true,
    placed: resolveShape(doc, def.shape) !== null,
  };
}

function groupPresent(id: AvatarPartGroupId, doc: unknown, items: readonly ItemDef[]): boolean {
  if (id === 'cheeks') return isObject(resolvePointer(doc, '/face/cheeks'));
  if (id === 'strands' || id === 'attachments' || id === 'arms' || id === 'legs') return items.length > 0;
  return true;
}

/**
 * The groups and items of a spec document (see the file comment). `present` is false for the
 * optional groups a document does not use: cheeks without "face.cheeks", strands / attachments
 * without entries.
 */
export function describeAvatarParts(doc: unknown): AvatarPartGroupInfo[] {
  const defs = groupDefs(doc);
  return AVATAR_PART_GROUPS.map((g) => ({
    ...g,
    present: groupPresent(g.id, doc, defs[g.id]),
    items: defs[g.id].map((d) => toItem(doc, d)),
  }));
}

// ----------------------------------------------------------------------------- landmarks (per pointer)

export interface AvatarLandmark {
  /** Where the value lives in the raw document. */
  pointer: SpecPointer;
  group: AvatarPartGroupId;
  /** Id of the item (AvatarPartItem.id) this value belongs to. */
  item: string;
  role: LandmarkRole;
  /** What the value is, e.g. "Head ellipse: centre". */
  label: string;
  /** How the value is written, e.g. "[x, y]". */
  form: string;
  /** How to place it. */
  tip: string;
  /** False for optional landmarks and for an ellipse's optional rotation. */
  required: boolean;
  /** True when changing the value makes the layer images stale. */
  cutsLayers: boolean;
}

const ROLE_FORMS: Record<LandmarkRole, string> = {
  at: '[x, y]',
  center: '[x, y]',
  radius: '[rx, ry]',
  rotation: 'degrees, clockwise',
  points: '[x0, y0, x1, y1, ...]',
  range: '[yStart, yEnd]',
  a: '[x, y]',
  b: '[x, y]',
};

const ROLE_SUFFIX: Partial<Record<LandmarkRole, string>> = { center: ': centre', radius: ': radius', rotation: ': rotation', a: ': start', b: ': end' };

function shapePointers(shape: HandleShape): Array<[LandmarkRole, SpecPointer]> {
  switch (shape.type) {
    case 'point':
      return [['at', shape.at]];
    case 'ellipse':
      return [['center', shape.center], ['radius', shape.radius], ...(shape.rotation !== undefined ? ([['rotation', shape.rotation]] as Array<[LandmarkRole, SpecPointer]>) : [])];
    case 'polygon':
    case 'polyline':
      return [['points', shape.points]];
    case 'band':
      return [['range', shape.range]];
    case 'segment':
      return [['a', shape.a], ['b', shape.b]];
  }
}

/** Every value of the editable geometry with its JSON pointer, in group and item order. */
export function avatarLandmarks(doc: unknown): AvatarLandmark[] {
  const defs = groupDefs(doc);
  const out: AvatarLandmark[] = [];
  for (const g of AVATAR_PART_GROUPS) {
    for (const def of defs[g.id]) {
      for (const [role, pointer] of shapePointers(def.shape)) {
        const circle = role === 'radius' && def.id.endsWith('.iris');
        out.push({
          pointer,
          group: g.id,
          item: def.id,
          role,
          label: def.roleLabels?.[role] ?? `${def.label}${ROLE_SUFFIX[role] ?? ''}`,
          form: circle ? 'radius in px' : ROLE_FORMS[role],
          tip: def.roleTips?.[role] ?? def.tip,
          required: (def.required ?? true) && role !== 'rotation',
          cutsLayers: def.cutsLayers ?? false,
        });
      }
    }
  }
  return out;
}
