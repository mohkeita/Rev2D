/**
 * Actions of avatar mode shared by its panels and the canvas: framing parts, placing and removing
 * landmarks, the context menu of a part, asking the AI about a part, and opening / creating avatar
 * projects (the session does the file work: Session.newAvatarProject; Session.openFile opens a
 * project by its avatar.json or folder).
 */
import type { AvatarPartGroupId, AvatarPartItemInfo } from '../../../src/avatar/index.js';
import { resolveShape } from '../../../src/avatar/parts.js';
import type { AvatarNewRequest } from '../api.js';
import type { MenuEntry } from '../design/index.js';
import { t, type Translate } from '../i18n/index.js';
import type { NewAvatarOutcome, Session } from '../state/session.js';
import type { Rect } from '../view/camera.js';
import { fixPartRequest, projectImagePath, startAi } from './ai.js';
import { shapeBounds } from './geometry.js';
import { groupLabel, itemLabel, itemTip } from './labels.js';
import { addAttachment, addStrand, entryPointer, placeItem, removeEntry, removeItemValue, type AttachmentKind } from './placement.js';
import { problemsByItem } from './problems.js';
import { avatarStore } from './store.js';

const PAD = 0.15;

/** Bounds of an item in image px, or null when it is not placed. */
export function itemRect(item: AvatarPartItemInfo): Rect | null {
  const s = avatarStore.get();
  const r = s.doc ? resolveShape(s.doc, item.shape) : null;
  return r ? shapeBounds(r, s.image?.width ?? 0) : null;
}

function padded(r: Rect): Rect {
  const px = Math.max(8, r[2] * PAD);
  const py = Math.max(8, r[3] * PAD);
  return [r[0] - px, r[1] - py, r[2] + px * 2, r[3] + py * 2];
}

/** Frame one item on the canvas. */
export function fitItem(id: string): void {
  const item = avatarStore.item(id);
  const r = item ? itemRect(item) : null;
  if (r) avatarStore.fit(padded(r));
}

/** Frame every placed item of a group. */
export function fitGroup(group: AvatarPartGroupId): void {
  const g = avatarStore.get().parts.find((p) => p.id === group);
  const rects = (g?.items ?? []).map(itemRect).filter((r): r is Rect => r !== null);
  if (!rects.length) return;
  const x0 = Math.min(...rects.map((r) => r[0]));
  const y0 = Math.min(...rects.map((r) => r[1]));
  const x1 = Math.max(...rects.map((r) => r[0] + r[2]));
  const y1 = Math.max(...rects.map((r) => r[1] + r[3]));
  avatarStore.fit(padded([x0, y0, x1 - x0, y1 - y0]));
}

/** Frame the selection (item, else group), else the illustration. */
export function fitSelection(): void {
  const sel = avatarStore.get().selection;
  if (sel.item) fitItem(sel.item);
  else if (sel.group) fitGroup(sel.group);
  else avatarStore.fit('image');
}

/** The placing target `what` ("<item id>", "strand", "attachment:<kind>") at image point `at`. */
export function placeAt(what: string, at: [number, number]): void {
  const s = avatarStore.get();
  if (!s.doc || !s.image) return;
  const size = { width: s.image.width, height: s.image.height };
  if (what === 'strand') {
    const r = addStrand(s.doc, at, size);
    if (avatarStore.edit(t('avatar.history.addStrand'), r.doc)) avatarStore.select(`strand.${r.id}`, 'strands');
  } else if (what.startsWith('attachment:')) {
    const kind = what.slice('attachment:'.length) as AttachmentKind;
    const r = addAttachment(s.doc, kind, at, size);
    const first = kind === 'jiggle' ? `attachment.${r.id}.ellipse` : `attachment.${r.id}.outline`;
    if (avatarStore.edit(t('avatar.history.addAttachment'), r.doc)) avatarStore.select(first, 'attachments');
  } else {
    const item = avatarStore.item(what);
    if (!item) return;
    if (avatarStore.edit(t('avatar.history.place', { item: itemLabel(t, item, s.doc) }), placeItem(s.doc, item, at, size))) avatarStore.select(item.id);
  }
  avatarStore.startPlacing(null);
}

/** Whether an item can be removed (an optional landmark, a strand, an attachment). */
export function canRemove(item: AvatarPartItemInfo): boolean {
  return entryPointer(item) !== null || (!item.required && item.placed);
}

export function removeItem(item: AvatarPartItemInfo): void {
  const s = avatarStore.get();
  if (!s.doc) return;
  const entry = entryPointer(item);
  const next = entry ? removeEntry(s.doc, entry) : removeItemValue(s.doc, item);
  if (avatarStore.edit(t('avatar.history.remove', { item: itemLabel(t, item, s.doc) }), next)) avatarStore.select(null);
}

/** Ask the AI about one part: a free-form job with a prompt naming it and what validation says. */
export async function askAiToFix(item: AvatarPartItemInfo): Promise<void> {
  const s = avatarStore.get();
  if (!s.ref || !s.doc) return;
  const problems = problemsByItem(s.doc, s.diagnostics).get(item.id) ?? [];
  const pointers = Object.entries(item.shape)
    .filter(([k]) => k !== 'type')
    .map(([, p]) => String(p));
  const lines = [
    t('avatar.ai.fixPrompt', { item: itemLabel(t, item, s.doc), id: item.id, pointers: pointers.join(', ') }),
    t('avatar.ai.fixTip', { tip: itemTip(t, item, s.doc) }),
    ...(problems.length ? [t('avatar.ai.fixProblems'), ...problems.map((d) => `- ${d.message}${d.hint ? ` (${d.hint})` : ''}`)] : []),
    ...(s.unsaved ? [t('avatar.ai.fixUnsaved')] : []),
  ];
  // The agent reads avatar.json from disk: what is shown must be there.
  if (s.unsaved && !(await avatarStore.save({ quiet: true }))) return;
  const image = s.image ? projectImagePath(s.ref, s.image.file) : undefined;
  const r = await startAi(fixPartRequest(s.ref.projectPath, lines.join('\n'), image), t('avatar.ai.unavailable'));
  if ('error' in r) toastError(r.error);
  else avatarStore.setAiJob({ id: r.jobId, kind: 'freeform', subject: item.id });
}

let toastSink: ((text: string) => void) | null = null;
/** Where errors of actions without a component are shown (the host sets it to the session's toasts). */
export function setActionToast(fn: ((text: string) => void) | null): void {
  toastSink = fn;
}
function toastError(text: string): void {
  toastSink?.(text);
}

/** The context menu of an item (parts list, canvas). */
export function itemMenu(tr: Translate, item: AvatarPartItemInfo, aiEnabled: boolean): MenuEntry[] {
  const s = avatarStore.get();
  const entries: MenuEntry[] = [];
  if (item.placed) entries.push({ id: 'fit', label: tr('avatar.menu.fit'), icon: 'fit', onSelect: () => fitItem(item.id) });
  else entries.push({ id: 'place', label: tr('avatar.menu.place'), icon: 'target', onSelect: () => avatarStore.startPlacing(item.id) });
  const group = s.parts.find((g) => g.items.some((i) => i.id === item.id));
  if (group) {
    const hidden = s.hidden.includes(group.id);
    entries.push({ id: 'toggle', label: hidden ? tr('avatar.menu.showGroup', { group: groupLabel(tr, group.id) }) : tr('avatar.menu.hideGroup', { group: groupLabel(tr, group.id) }), icon: hidden ? 'eye' : 'eyeOff', onSelect: () => avatarStore.toggleGroup(group.id) });
  }
  entries.push({ type: 'separator' });
  entries.push({ id: 'ai', label: tr('avatar.menu.askAi'), icon: 'sparkles', disabled: !aiEnabled, onSelect: () => void askAiToFix(item) });
  if (canRemove(item)) {
    entries.push({ type: 'separator' });
    entries.push({ id: 'remove', label: tr('avatar.menu.remove'), icon: 'trash', destructive: true, onSelect: () => removeItem(item) });
  }
  return entries;
}

// ------------------------------------------------------------------------------ projects

/** "New avatar from illustration…": the sheet (NewAvatarSheet) listens to this. */
type SheetListener = (open: boolean, file?: File | null) => void;
const sheetListeners = new Set<SheetListener>();

export function onNewAvatarSheet(fn: SheetListener): () => void {
  sheetListeners.add(fn);
  return () => sheetListeners.delete(fn);
}

/** Open the new-avatar sheet (optionally with a picture already chosen). */
export function openNewAvatarSheet(file?: File | null): void {
  for (const l of [...sheetListeners]) l(true, file ?? null);
}

/** Whether a workspace path names an avatar spec ("…/avatar.json"). */
export function isAvatarSpecPath(path: string): boolean {
  return /(^|[\\/])avatar\.json$/i.test(path);
}

/**
 * Create a project from the illustration chooser's result and open it (the server opens it without
 * a model). Asks first about unsaved edits the switch would lose.
 */
export function createAvatarProject(session: Session, req: AvatarNewRequest): Promise<NewAvatarOutcome> {
  return session.newAvatarProject(req);
}
