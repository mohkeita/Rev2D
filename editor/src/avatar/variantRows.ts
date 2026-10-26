/**
 * The "Drawn variants" section of Avatar mode without React: what each row says (state, tone, the
 * line under the name), which picture its thumbnail crops and how, which rows show before "All
 * variants", which variants the "Draw with AI" sheet suggests, and the preview pose that shows a
 * variant. Pure (tested in test/editor-avatar-variants.test.ts).
 */
import type { AvatarInfo, AvatarVariantStatus, AvatarVariantsInfo } from '../api.js';
import { VARIANT_IDS, type VariantId, type VariantGroup } from '../../../src/avatar/types.js';
import { VARIANTS } from '../../../src/avatar/variants-areas.js';

export type VariantState = AvatarVariantStatus['state'];
export type VariantTone = 'success' | 'warning' | 'danger' | 'tint' | 'neutral';

/** The badge tone of a state: green in use, orange out of date, red rejected, blue waiting for an import. */
export const STATE_TONE: Record<VariantState, VariantTone> = {
  accepted: 'success',
  stale: 'warning',
  rejected: 'danger',
  drawn: 'tint',
  requested: 'neutral',
  missing: 'neutral',
};

export interface VariantRowView {
  id: VariantId;
  group: VariantGroup;
  state: VariantState;
  tone: VariantTone;
  recommended: boolean;
  drawn: boolean;
  sprite: boolean;
  /**
   * The line under the name: why a drawing was rejected (with the hint), why a sprite is out of date,
   * how the accepted drawing measured (outside difference, share redrawn), or nothing.
   */
  detail:
    | { kind: 'reason'; text: string; hint?: string; code?: string; values?: Record<string, number | string> }
    | { kind: 'stale'; text: string }
    | { kind: 'check'; outside: number; inside: number }
    | { kind: 'drawn' | 'requested' | 'none' };
  /** The picture the thumbnail crops: the drawing when there is one, else the illustration; with a version for caches. */
  thumb: { file: string; version: string };
}

/** Signature of a project file in a GET /api/avatar listing ("" when it is not there). */
function versionOf(files: AvatarInfo['files'] | undefined, file: string): string {
  const f = files?.find((x) => x.path === file);
  return f ? `${f.size}-${Math.round(f.mtimeMs)}` : '';
}

/** One view per variant, in VARIANT_IDS order. */
export function variantRows(info: AvatarVariantsInfo, files: AvatarInfo['files'] | undefined, sourceFile: string): VariantRowView[] {
  return info.variants.map((v) => {
    let detail: VariantRowView['detail'];
    if (v.unreadable) detail = { kind: 'reason', text: v.unreadable, code: 'unreadable', values: {} };
    else if (v.rejection) {
      const r = v.rejection;
      detail = { kind: 'reason', text: r.reason, ...(r.hint ? { hint: r.hint } : {}), ...(r.code ? { code: r.code, values: r.values ?? {} } : {}) };
    }
    else if (v.state === 'stale') detail = { kind: 'stale', text: v.stale.join('; ') };
    else if (v.check) detail = { kind: 'check', outside: v.check.outsideDiff, inside: v.check.insideChanged };
    else if (v.state === 'drawn' || v.state === 'requested') detail = { kind: v.state };
    else detail = { kind: 'none' };
    const thumbFile = v.drawn && !v.unreadable ? v.file : sourceFile;
    return {
      id: v.id,
      group: v.group,
      state: v.state,
      tone: STATE_TONE[v.state],
      recommended: v.recommended,
      drawn: v.drawn,
      sprite: v.sprite,
      detail,
      thumb: { file: thumbFile, version: versionOf(files, thumbFile) },
    };
  });
}

/** The rows shown before "All variants": the recommended ones and every variant something happened to. */
export function splitRows(rows: readonly VariantRowView[]): { shown: VariantRowView[]; hidden: VariantRowView[] } {
  const shown = rows.filter((r) => r.recommended || r.state !== 'missing');
  return { shown, hidden: rows.filter((r) => !shown.includes(r)) };
}

/**
 * The CSS that crops `area` ([x, y, w, h] of a width x height picture) into a `box` px thumbnail:
 * the whole area fits (contain), centred. Null without an area.
 */
export function thumbCrop(area: readonly number[] | null, image: { width: number; height: number } | null, box: { width: number; height: number }): { backgroundSize: string; backgroundPosition: string } | null {
  if (!area || !image || area[2] <= 0 || area[3] <= 0) return null;
  const scale = Math.min(box.width / area[2], box.height / area[3]);
  const x = (box.width - area[2] * scale) / 2 - area[0] * scale;
  const y = (box.height - area[3] * scale) / 2 - area[1] * scale;
  const r = (v: number) => Math.round(v * 100) / 100;
  return { backgroundSize: `${r(image.width * scale)}px ${r(image.height * scale)}px`, backgroundPosition: `${r(x)}px ${r(y)}px` };
}

/**
 * What "Draw with AI" suggests: the recommended variants that are not in use, and every variant whose
 * drawing was rejected or whose sprite is out of date. All recommended ones in use and nothing to
 * redo: the next most useful ones (the half-closed eye, the half-open mouth).
 */
export function suggestedDrawIds(info: AvatarVariantsInfo | null): VariantId[] {
  const rows = info?.variants ?? [];
  const state = (id: VariantId) => rows.find((r) => r.id === id)?.state ?? 'missing';
  const ids = VARIANT_IDS.filter((id) => (VARIANTS[id].recommended && state(id) !== 'accepted') || state(id) === 'rejected' || state(id) === 'stale');
  if (ids.length) return ids;
  return (['eyes_half', 'mouth_a_half'] as const).filter((id) => state(id) !== 'accepted');
}

/** The preview pose (explicit parameter values) in which the sprite of a variant shows. */
export function variantPose(id: VariantId): Record<string, number> {
  const v = VARIANTS[id];
  if (v.eye === 'closed') return { EyeLOpen: 0, EyeROpen: 0 };
  if (v.eye === 'half') return { EyeLOpen: 0.45, EyeROpen: 0.45 };
  if (v.eye === 'smile') return { EyeLSmile: 1, EyeRSmile: 1 };
  if(v.eye==='wide')return {EyeWide:1};
  if(v.handForm!==undefined)return {[v.group==='handR'?'HandRForm':'HandLForm']:v.handForm};
  if(v.group==='brows')return {BrowLY:id==='brows_worried'?0.7:-0.7,BrowRY:id==='brows_worried'?0.7:-0.7};
  if(v.expression!==undefined)return {MouthShape:v.expression};
  return v.mouth?{ MouthOpen: v.mouth.open, MouthForm: v.mouth.form }:{};
}
