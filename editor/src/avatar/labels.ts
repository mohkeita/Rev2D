/**
 * Names and placement tips of the avatar parts in the editor's language (pure). describeAvatarParts
 * gives English labels; the editor maps every item id PATTERN to a message key of the "avatar"
 * namespace (test/editor-avatar.test.ts checks that every pattern has one in en / ko / ja).
 *
 *   itemKeys(item, doc)     {label, tip, vars} message keys of an item
 *   itemLabel / itemTip     the translated texts
 *   groupLabel / groupDescription / categoryLabel / handleLabel
 */
import type { AvatarPartGroupId, AvatarPartItemInfo } from '../../../src/avatar/index.js';
import { resolvePointer } from '../../../src/avatar/parts.js';
import type { MessageKey, MessageVars, Translate } from '../i18n/index.js';
import type { HandleRole } from './geometry.js';
import { entryPointer } from './placement.js';

export type PartCategory = 'face' | 'hair' | 'body';

const GROUP_LABEL: Record<AvatarPartGroupId, MessageKey> = {
  arms:'avatar.group.arms', legs:'avatar.group.legs',
  head: 'avatar.group.head',
  eyes: 'avatar.group.eyes',
  mouth: 'avatar.group.mouth',
  face: 'avatar.group.face',
  cheeks: 'avatar.group.cheeks',
  strands: 'avatar.group.strands',
  attachments: 'avatar.group.attachments',
  body: 'avatar.group.body',
};

const GROUP_DESC: Record<AvatarPartGroupId, MessageKey> = {
  arms:'avatar.group.arms.desc', legs:'avatar.group.legs.desc',
  head: 'avatar.group.head.desc',
  eyes: 'avatar.group.eyes.desc',
  mouth: 'avatar.group.mouth.desc',
  face: 'avatar.group.face.desc',
  cheeks: 'avatar.group.cheeks.desc',
  strands: 'avatar.group.strands.desc',
  attachments: 'avatar.group.attachments.desc',
  body: 'avatar.group.body.desc',
};

const CATEGORY: Record<PartCategory, MessageKey> = { face: 'avatar.category.face', hair: 'avatar.category.hair', body: 'avatar.category.body' };

export const groupLabel = (t: Translate, id: AvatarPartGroupId): string => t(GROUP_LABEL[id]);
export const groupDescription = (t: Translate, id: AvatarPartGroupId): string => t(GROUP_DESC[id]);
export const categoryLabel = (t: Translate, c: PartCategory): string => t(CATEGORY[c]);

export interface ItemKeys {
  label: MessageKey;
  tip: MessageKey;
  vars: MessageVars;
  /** `side` is a message key too (translated before use). */
  side?: MessageKey;
}

const FIXED: Record<string, [MessageKey, MessageKey]> = {
  'head.ellipse': ['avatar.item.head.ellipse', 'avatar.tip.head.ellipse'],
  'head.pivot': ['avatar.item.head.pivot', 'avatar.tip.head.pivot'],
  'head.neck': ['avatar.item.head.neck', 'avatar.tip.head.neck'],
  'mouth.corners': ['avatar.item.mouth.corners', 'avatar.tip.mouth.corners'],
  'mouth.area': ['avatar.item.mouth.area', 'avatar.tip.mouth.area'],
  'face.oval': ['avatar.item.face.oval', 'avatar.tip.face.oval'],
  'face.nose': ['avatar.item.face.nose', 'avatar.tip.face.nose'],
  'face.chin': ['avatar.item.face.chin', 'avatar.tip.face.chin'],
  'body.pivot': ['avatar.item.body.pivot', 'avatar.tip.body.pivot'],
  'body.fade': ['avatar.item.body.fade', 'avatar.tip.body.fade'],
  'body.chest': ['avatar.item.body.chest', 'avatar.tip.body.chest'],
};

const EYE: Record<string, [MessageKey, MessageKey]> = {
  opening: ['avatar.item.eye.opening', 'avatar.tip.eye.opening'],
  region: ['avatar.item.eye.region', 'avatar.tip.eye.region'],
  iris: ['avatar.item.eye.iris', 'avatar.tip.eye.iris'],
};

const SIDE: Record<string, MessageKey> = { imageLeft: 'avatar.side.imageLeft', imageRight: 'avatar.side.imageRight' };

/** The kind of the attachment an item belongs to (read from the document), or null. */
function attachmentKind(item: AvatarPartItemInfo, doc: unknown): string | null {
  const entry = entryPointer(item);
  const kind = entry ? resolvePointer(doc, `${entry}/kind`) : undefined;
  return typeof kind === 'string' ? kind : null;
}

/**
 * The message keys of an item. `vars.id` carries a strand's or attachment's id as written in the
 * file; `side` the key of "Left" / "Right" (image sides).
 */
export function itemKeys(item: AvatarPartItemInfo, doc: unknown): ItemKeys {
  const id = item.id;
  const fixed = FIXED[id];
  if (fixed) return { label: fixed[0], tip: fixed[1], vars: {} };
  let m = /^arms\.(armR|armL)\.(shoulder|elbow|wrist|outline|hand|handOutline)$/.exec(id);
  if(m)return {label:'avatar.item.arm.'+m[2] as MessageKey,tip:'avatar.tip.arm',vars:{id:m[1]}};
  m=/^legs\.(hips|foot[01])$/.exec(id);
  if(m)return {label:m[1]==='hips'?'avatar.item.legs.hips':'avatar.item.legs.foot',tip:'avatar.tip.legs',vars:{id:m[1]}};
  m = /^eyes\.(imageLeft|imageRight)\.(opening|region|iris)$/.exec(id);
  if (m) return { label: EYE[m[2]][0], tip: EYE[m[2]][1], vars: {}, side: SIDE[m[1]] };
  m = /^face\.(brows|ears)\.(imageLeft|imageRight)$/.exec(id);
  if (m) return m[1] === 'brows' ? { label: 'avatar.item.face.brow', tip: 'avatar.tip.face.brow', vars: {}, side: SIDE[m[2]] } : { label: 'avatar.item.face.ear', tip: 'avatar.tip.face.ear', vars: {}, side: SIDE[m[2]] };
  m = /^cheeks\.(imageLeft|imageRight)$/.exec(id);
  if (m) return { label: 'avatar.item.cheek', tip: 'avatar.tip.cheek', vars: {}, side: SIDE[m[1]] };
  m = /^body\.shoulders\.(imageLeft|imageRight)$/.exec(id);
  if (m) return { label: 'avatar.item.body.shoulder', tip: 'avatar.tip.body.shoulder', vars: {}, side: SIDE[m[1]] };
  m = /^strand\.(.+)$/.exec(id);
  if (m) return { label: 'avatar.item.strand', tip: 'avatar.tip.strand', vars: { id: m[1] } };
  m = /^attachment\.(.+)\.(outline|swing|ellipse|contact)$/.exec(id);
  if (m) {
    const vars = { id: m[1] };
    const kind = attachmentKind(item, doc);
    if (m[2] === 'swing') return { label: 'avatar.item.pendulum.swing', tip: 'avatar.tip.pendulum.swing', vars };
    if (m[2] === 'ellipse') return { label: 'avatar.item.jiggle', tip: 'avatar.tip.jiggle', vars };
    if (m[2] === 'contact') return { label: 'avatar.item.cutout.contact', tip: 'avatar.tip.cutout.contact', vars };
    return kind === 'cutout' ? { label: 'avatar.item.cutout.outline', tip: 'avatar.tip.cutout.outline', vars } : { label: 'avatar.item.pendulum.outline', tip: 'avatar.tip.pendulum.outline', vars };
  }
  return { label: 'avatar.item.unknown', tip: 'avatar.tip.unknown', vars: { id } };
}

function vars(t: Translate, keys: ItemKeys): MessageVars {
  return keys.side ? { ...keys.vars, side: t(keys.side) } : keys.vars;
}

export function itemLabel(t: Translate, item: AvatarPartItemInfo, doc: unknown): string {
  const k = itemKeys(item, doc);
  return t(k.label, vars(t, k));
}

export function itemTip(t: Translate, item: AvatarPartItemInfo, doc: unknown): string {
  const k = itemKeys(item, doc);
  return t(k.tip, vars(t, k));
}

/** The name of one handle of an item, for the hover tooltip ("Point 5", "Centre", "Pivot"). */
export function handleLabel(t: Translate, item: AvatarPartItemInfo, role: HandleRole, index?: number): string | null {
  switch (role) {
    case 'vertex':
      return t('avatar.handle.vertex', { n: (index ?? 0) + 1 });
    case 'center':
      return t('avatar.handle.center');
    case 'radiusX':
      return item.id.endsWith('.iris') ? t('avatar.handle.radius') : t('avatar.handle.width');
    case 'radiusY':
      return t('avatar.handle.height');
    case 'rotation':
      return t('avatar.handle.rotation');
    case 'bandStart':
      return t('avatar.handle.bandStart');
    case 'bandEnd':
      return t('avatar.handle.bandEnd');
    case 'a':
      return item.id === 'mouth.corners' ? t('avatar.handle.cornerLeft') : t('avatar.handle.pivot');
    case 'b':
      return item.id === 'mouth.corners' ? t('avatar.handle.cornerRight') : t('avatar.handle.tip');
    case 'point':
      return null;
  }
}

/** Every item-id pattern the editor knows, with an example id (for the completeness test). */
export const ITEM_PATTERNS = [
  'head.ellipse',
  'head.pivot',
  'head.neck',
  'eyes.<side>.opening',
  'eyes.<side>.region',
  'eyes.<side>.iris',
  'mouth.corners',
  'mouth.area',
  'face.oval',
  'face.nose',
  'face.chin',
  'face.brows.<side>',
  'face.ears.<side>',
  'cheeks.<side>',
  'strand.<id>',
  'attachment.<id>.outline',
  'attachment.<id>.swing',
  'attachment.<id>.ellipse',
  'attachment.<id>.contact',
  'arms.<id>.shoulder', 'arms.<id>.elbow', 'arms.<id>.wrist', 'arms.<id>.outline', 'arms.<id>.hand', 'arms.<id>.handOutline', 'legs.hips', 'legs.foot0',
  'body.pivot',
  'body.fade',
  'body.chest',
  'body.shoulders.<side>',
] as const;
