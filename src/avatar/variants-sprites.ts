import {pixelHull} from './image/hull.js';
/**
 * Sprites from accepted drawings (step 4 of ./variants.ts) and their bookkeeping in layers.json.
 *
 * A sprite layer is the drawing inside one edit area: the drawing's pixels with its alpha multiplied
 * by the area's editable coverage (opaque over the grown region / mouth ellipse, fading out over the
 * feather, where the drawing equals the illustration anyway), cropped to that coverage. Eye variants
 * give one sprite per eye ("sprite_eyes_closed_imageLeft"), mouth variants one ("sprite_mouth_a_mouth").
 * Placed at its rect over the base, a sprite shows exactly the drawing where the drawing differs.
 *
 * Layers drawn ABOVE a sprite (hair over the eyes, cut-out brows, a hand) are drawn over it again,
 * so where they cover the edit area the sprite holds what lies UNDER them: the drawing with their
 * rest-pose colour taken out ("un-mixed": D = A over U solved for U), or the base layer where they
 * are opaque. Then the composite at the sprite's pose is the drawing itself, the edges of hair and
 * brows are not darkened by a second copy, and a lock that sways away uncovers the base, as it does
 * without the sprite. The caller provides what is above (spriteBackdrop: a render of those layers).
 *
 * layers.json keeps, besides the sprite layers in `layers` and the accepted ids in `variants`:
 *
 *   "sprites": {
 *     "version": 1,
 *     "sprites":  [{id, group, layers: [{id, key, rect}], drawingHash, inputsHash, check: {...}}],
 *     "rejected": [{id, drawingHash, reason, hint, outsideDiff, insideChanged}]
 *   }
 *
 * `drawingHash` (the drawing's pixels) and `inputsHash` (the eye regions / mouth area it was cut with)
 * make a sprite stale when the drawing or the landmarks change. A rejected drawing never replaces an
 * accepted sprite: the earlier sprite stays until a drawing of that variant is accepted, or the
 * variant is removed. Pure and deterministic.
 */
import { Rig, buildRenderList } from '../core/rig.js';
import type { ImageRGBA, Model } from '../core/types.js';
import { renderImage } from '../render/raster.js';
import { pointInPolygon } from './image/polygon.js';
import { AVATAR_Z } from './builder.js';
import { extendEdges } from './image/inpaint.js';
import { maskBounds } from './image/mask.js';
import { pixelRect, type Rect } from './image/types.js';
import type { RectTuple } from './fields.js';
import { layerFile } from './layers.js';
import { VARIANT_IDS, type AvatarSpec, type LayerInfo, type LayersMeta, type VariantGroup, type VariantId } from './types.js';
import { variantEditAreas, variantInputsHash, isVariantId, VARIANTS, type VariantAreaKey, type VariantEditAreas } from './variants-areas.js';
import { checkVariantDrawing, type VariantCheckResult, type VariantRejectCode } from './variants-check.js';

/** layers.json key of the sprite bookkeeping (the id of the feature that shows them). */
export const SPRITES_META_KEY = 'sprites';



export interface SpriteLayerMeta {
  /** Convex pixel outline for rigid gloves, in source coordinates. */
  outline?:number[];
  /** Layer (and texture) id. */
  id: string;
  /** The edit area it was cut from: an eye ("imageLeft" / "imageRight") or "mouth". */
  key: VariantAreaKey;
  rect: RectTuple;
}

export interface SpriteRecord {
  id: VariantId;
  group: VariantGroup;
  layers: SpriteLayerMeta[];
  /** hashImage of the drawing the sprites were cut from. */
  drawingHash: string;
  /** variantInputsHash of the spec when they were cut. */
  inputsHash: string;
  /** LayersMeta.inputsHash of the layers they were cut over (the layers above them shape the cut); null when cut without a backdrop. */
  layersHash: string | null;
  /** The numbers of the check that accepted the drawing. */
  check: { outsideDiff: number; insideChanged: number; badShare: number; nearDiff: number; tolerance: number };
}

export interface SpriteRejection {
  id: VariantId;
  drawingHash: string | null;
  reason: string;
  hint?: string;
  /** VariantCheckResult.code and .values (for translated messages). */
  code?: VariantRejectCode;
  values?: Record<string, number | string>;
  outsideDiff: number | null;
  insideChanged: number | null;
}

export interface SpritesMeta {
  version: 1;
  sprites: SpriteRecord[];
  rejected: SpriteRejection[];
}

export function spriteLayerId(id: VariantId, key: VariantAreaKey): string {
  return `sprite_${id}_${key}`;
}

function isRect(v: unknown): v is RectTuple {
  return Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
}

/** The sprite bookkeeping of a layers.json, validated (entries that do not fit are dropped); null when there is none. */
export function spritesMeta(meta: LayersMeta | null | undefined): SpritesMeta | null {
  const raw = meta?.[SPRITES_META_KEY];
  if (raw === null || typeof raw !== 'object') return null;
  const m = raw as Partial<SpritesMeta>;
  const sprites = (Array.isArray(m.sprites) ? m.sprites : []).filter(
    (s): s is SpriteRecord =>
      s !== null &&
      typeof s === 'object' &&
      isVariantId(s.id) &&
      Array.isArray(s.layers) &&
      s.layers.every((l) => l !== null && typeof l === 'object' && typeof l.id === 'string' && typeof l.key === 'string' && isRect(l.rect) && (l.outline===undefined || Array.isArray(l.outline)&&l.outline.length>=6&&l.outline.length%2===0&&l.outline.every(v=>typeof v==='number'&&Number.isFinite(v)))) &&
      typeof s.drawingHash === 'string' &&
      typeof s.inputsHash === 'string',
  );
  const rejected = (Array.isArray(m.rejected) ? m.rejected : []).filter((r): r is SpriteRejection => r !== null && typeof r === 'object' && isVariantId(r.id) && typeof r.reason === 'string');
  return { version: 1, sprites: sprites.map((x) => ({ ...x, layersHash: typeof x.layersHash === 'string' ? x.layersHash : null })), rejected };
}

const byVariant = (a: { id: VariantId }, b: { id: VariantId }) => VARIANT_IDS.indexOf(a.id) - VARIANT_IDS.indexOf(b.id);

/** Write the bookkeeping back: sprite layers last in `layers` (in variant order), `variants` = the accepted ids. */
function withSprites(meta: LayersMeta, sprites: SpriteRecord[], rejected: SpriteRejection[]): LayersMeta {
  const sorted = [...sprites].sort(byVariant);
  // Every layer whose id starts with "sprite_" belongs to this bookkeeping ("sprite" is a reserved id).
  const others = meta.layers.filter((l) => !l.id.startsWith('sprite_'));
  const spriteLayers: LayerInfo[] = sorted.flatMap((s) => s.layers.map((l) => ({ id: l.id, file: layerFile(l.id), rect: [...l.rect] as RectTuple })));
  const out: LayersMeta = { ...meta, layers: [...others, ...spriteLayers], variants: sorted.map((s) => s.id) };
  if (sorted.length || rejected.length) out[SPRITES_META_KEY] = { version: 1, sprites: sorted, rejected: [...rejected].sort(byVariant) } satisfies SpritesMeta;
  else delete out[SPRITES_META_KEY];
  return out;
}

export interface CutSprites {
  layers: SpriteLayerMeta[];
  /** Layer images by LayerInfo.file ("textures/sprite_mouth_a_mouth.png"). */
  images: Record<string, ImageRGBA>;
}

/**
 * What lies over the sprites of a group at rest: `above` is a render of the layers drawn above them
 * (transparent where there are none) over the window `rect` of the image; `base` is the full-size
 * base layer, which a sprite shows where those layers are opaque.
 */
export interface SpriteBackdrop {
  rect: Rect;
  above: ImageRGBA;
  base: ImageRGBA;
}

/** Parts with a z above this are drawn over the sprites of the group (AVATAR_Z: eye sprites 27..29, mouth sprites 37..39). */
export function spriteTopZ(group: VariantGroup): number {
  return group === 'eyes' ? AVATAR_Z.eyeSprites + 2 : group === 'mouth' ? AVATAR_Z.mouthSprites + 3 : group === 'brows' ? AVATAR_Z.hair + 3 : AVATAR_Z.arms + 2;
}

/**
 * The hair in front of each eye (the eye feature's "<eye>_front": an opaque copy of the hair over the
 * eye with a matte rim, moved by the hair feature). With eye sprites it is drawn ABOVE them (the
 * sprites feature lifts it to EYE_FRONT_Z), so it keeps swaying over a drawn closed eye; the backdrop
 * of eye sprites counts it whatever its z in the model it is rendered from.
 */
export const EYE_FRONT_PARTS: readonly string[] = ['eyeL_front', 'eyeR_front'];
/** Where the sprites feature puts EYE_FRONT_PARTS when eye sprites exist: above the eye sprites, below the mouth. */
export const EYE_FRONT_Z = AVATAR_Z.eyeSprites + 2.5;

/** Whether a part of the model is drawn over the sprites of the group (its z, or the hair in front of the eyes). */
export function drawnAboveSprites(part: { id: string; z?: number }, group: VariantGroup): boolean {
  return (part.z ?? 0) > spriteTopZ(group) || (group === 'eyes' && EYE_FRONT_PARTS.includes(part.id));
}

/** The smallest rectangle around the group's edit areas. */
function editWindow(edit: VariantEditAreas): Rect {
  let x0 = edit.width;
  let y0 = edit.height;
  let x1 = 0;
  let y1 = 0;
  for (const a of edit.areas) {
    x0 = Math.min(x0, a.rect.x);
    y0 = Math.min(y0, a.rect.y);
    x1 = Math.max(x1, a.rect.x + a.rect.width);
    y1 = Math.max(y1, a.rect.y + a.rect.height);
  }
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : pixelRect({ x: 0, y: 0, width: edit.width, height: edit.height }, 0, edit.width, edit.height);
}

/**
 * Render what lies over the sprites of a group at rest: the model's parts with a z above
 * spriteTopZ(group), over the window of the group's edit areas. `textures` must hold the images of
 * those parts (by texture id); `base` is the base layer image.
 */
export function spriteBackdrop(model: Model, textures: Record<string, ImageRGBA>, base: ImageRGBA, edit: VariantEditAreas): SpriteBackdrop {
  const rect = editWindow(edit);
  const above = new Set(model.parts.filter((p) => drawnAboveSprites(p, edit.group)).map((p) => p.id));
  const rig = new Rig(model);
  const list = buildRenderList(rig, rig.pose({ physics: false }));
  const draws = list.draws.filter((d) => above.has(d.partId));
  const image = renderImage({ ...list, background: [0, 0, 0, 0], draws }, textures, { viewBox: [rect.x, rect.y, rect.width, rect.height], supersample: 1 });
  return { rect, above: image, base };
}

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * The colour a sprite pixel needs so that the layers above, drawn over it, give the drawing's pixel
 * (straight RGBA8 at `o`): U = (D - a F) / (1 - a) on premultiplied colour, fading to the base pixel
 * where the layers above are (nearly) opaque. Writes straight RGBA 0..255 into out[0..3].
 */
function unmix(d: Uint8ClampedArray, o: number, above: ImageRGBA, ai: number, base: ImageRGBA, out: number[]): void {
  const a = above.data[ai + 3] / 255;
  if (!(a > 0)) {
    out[0] = d[o];
    out[1] = d[o + 1];
    out[2] = d[o + 2];
    out[3] = d[o + 3];
    return;
  }
  const t = smooth(0.95, 0.99, a);
  const k = 1 - a;
  const dA = d[o + 3] / 255;
  // Un-mixed, premultiplied 0..1, clamped to what a pixel can hold.
  let uA = k > 1e-6 ? Math.min(1, Math.max(0, (dA - a) / k)) : 0;
  const u = [0, 0, 0];
  for (let c = 0; c < 3; c++) u[c] = k > 1e-6 ? Math.min(uA, Math.max(0, ((d[o + c] / 255) * dA - (above.data[ai + c] / 255) * a) / k)) : 0;
  // ... fading toward the base pixel under (nearly) opaque layers.
  const bA = base.data[o + 3] / 255;
  uA = uA * (1 - t) + bA * t;
  for (let c = 0; c < 3; c++) u[c] = u[c] * (1 - t) + (base.data[o + c] / 255) * bA * t;
  out[3] = Math.round(uA * 255);
  for (let c = 0; c < 3; c++) out[c] = uA > 1e-6 ? Math.round(Math.min(1, u[c] / uA) * 255) : 0;
}

/**
 * Cut the sprite layers of an (accepted) drawing: one per edit area of its group. With a backdrop
 * (spriteBackdrop), what lies under the layers drawn above the sprite is un-mixed (see the file
 * comment); without one the drawing's pixels are used as they are.
 */

export function cutVariantSprites(id: VariantId, drawing: ImageRGBA, edit: VariantEditAreas, backdrop?: SpriteBackdrop, hand?:{source:ImageRGBA;arm:NonNullable<AvatarSpec['arms']>[number]}): CutSprites {
  const layers: SpriteLayerMeta[] = [];
  const images: Record<string, ImageRGBA> = {};
  const px = [0, 0, 0, 0];
  for (const area of edit.areas) {
    const local = maskBounds(area.mask, 1 / 512);
    if (!local) continue;
    const x0 = area.rect.x + local.x;
    const y0 = area.rect.y + local.y;
    const { width: w, height: h } = local;
    const img: ImageRGBA = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const m = area.mask.data[(y + local.y) * area.rect.width + x + local.x];
        if (!(m > 0)) continue;
        const gx = x + x0;
        const gy = y + y0;
        const so = (gy * drawing.width + gx) * 4;
        const ax = backdrop ? gx - backdrop.rect.x : -1;
        const ay = backdrop ? gy - backdrop.rect.y : -1;
        if (backdrop && ax >= 0 && ay >= 0 && ax < backdrop.above.width && ay < backdrop.above.height) {
          unmix(drawing.data, so, backdrop.above, (ay * backdrop.above.width + ax) * 4, backdrop.base, px);
        } else {
          px[0] = drawing.data[so];
          px[1] = drawing.data[so + 1];
          px[2] = drawing.data[so + 2];
          px[3] = drawing.data[so + 3];
        }
        if(hand){
          const h=hand.arm.hand,inside=h.outline?pointInPolygon(h.outline,gx+0.5,gy+0.5):Math.hypot(gx+0.5-h.center[0],gy+0.5-h.center[1])<=h.radius+2;
          const changed=[0,1,2,3].some(c=>Math.abs(drawing.data[so+c]-hand.source.data[so+c])>2);
          if(!inside&&!changed)px[3]=0;
        }
        const o = (y * w + x) * 4;
        img.data[o] = px[0];
        img.data[o + 1] = px[1];
        img.data[o + 2] = px[2];
        img.data[o + 3] = Math.round(px[3] * Math.min(1, m));
      }
    }
    const layerId = spriteLayerId(id, area.key);
    images[layerFile(layerId)] = extendEdges(img, 2);
    layers.push({ id: layerId, key: area.key, rect: [x0, y0, w, h],...(hand?{outline:pixelHull(img,x0,y0)}:{}) });
  }
  return { layers, images };
}

export interface BuildSpritesOptions {
  /** What lies over the sprites of each group (spriteBackdrop); without one the drawing is used as it is. */
  backdrops?: Partial<Record<VariantGroup, SpriteBackdrop>>;
}

export interface BuildSpritesResult {
  /** Images of the NEW sprite layers, by LayerInfo.file (kept sprites are not repeated: their files exist). */
  images: Record<string, ImageRGBA>;
  /** The metadata with the sprites: layers, variants and the "sprites" key updated. */
  meta: LayersMeta;
  /** One check per drawing, in variant order. */
  checks: VariantCheckResult[];
  /** Drawings accepted (and cut) now. */
  accepted: VariantId[];
  /** Drawings rejected now. */
  rejected: VariantId[];
  /** Rejected drawings whose earlier sprite stays in place. */
  kept: VariantId[];
  /** Sprite layers of earlier drawings that the new ones replace and that no longer exist (delete their files). */
  dropped: LayerInfo[];
}

/**
 * Check every drawing and cut the accepted ones into sprites; the metadata keeps every other sprite
 * as it was (a rejected drawing never replaces an accepted sprite).
 */
export function buildSprites(spec: AvatarSpec, meta: LayersMeta, source: ImageRGBA, drawings: Partial<Record<VariantId, ImageRGBA>>, options: BuildSpritesOptions = {}): BuildSpritesResult {
  const before = spritesMeta(meta) ?? { version: 1 as const, sprites: [], rejected: [] };
  let sprites = [...before.sprites];
  let rejectedList = [...before.rejected];
  const images: Record<string, ImageRGBA> = {};
  const checks: VariantCheckResult[] = [];
  const accepted: VariantId[] = [];
  const rejected: VariantId[] = [];
  const kept: VariantId[] = [];
  const dropped: LayerInfo[] = [];
  const edits = new Map<VariantGroup, VariantEditAreas>();
  const editOf = (group: VariantGroup) => {
    let e = edits.get(group);
    if (!e) edits.set(group, (e = variantEditAreas(spec, group)));
    return e;
  };
  for (const id of VARIANT_IDS) {
    const drawing = drawings[id];
    if (!drawing) continue;
    const group = VARIANTS[id].group;
    const check = checkVariantDrawing(spec, source, id, drawing, { edit: editOf(group) });
    checks.push(check);
    rejectedList = rejectedList.filter((r) => r.id !== id);
    if (!check.ok) {
      rejected.push(id);
      rejectedList.push({
        id,
        drawingHash: check.drawingHash,
        reason: check.reason ?? 'rejected',
        ...(check.hint ? { hint: check.hint } : {}),
        ...(check.code ? { code: check.code, values: check.values ?? {} } : {}),
        outsideDiff: check.outsideDiff,
        insideChanged: check.insideChanged,
      });
      if (sprites.some((s) => s.id === id)) kept.push(id);
      continue;
    }
    const backdrop = options.backdrops?.[group];
    const arm=group.startsWith('hand')?spec.arms?.find(a=>a.id===(group==='handR'?'armR':'armL')):undefined;
    const cut = cutVariantSprites(id, drawing, editOf(group), backdrop,arm?{source,arm}:undefined);
    const old = sprites.find((s) => s.id === id);
    if (old) {
      const now = new Set(cut.layers.map((l) => l.id));
      for (const l of old.layers) if (!now.has(l.id)) dropped.push({ id: l.id, file: layerFile(l.id), rect: l.rect });
    }
    sprites = sprites.filter((s) => s.id !== id);
    sprites.push({
      id,
      group,
      layers: cut.layers,
      drawingHash: check.drawingHash,
      inputsHash: variantInputsHash(spec, group),
      layersHash: backdrop ? meta.inputsHash : null,
      check: { outsideDiff: check.outsideDiff, insideChanged: check.insideChanged, badShare: check.badShare, nearDiff: check.nearDiff, tolerance: check.tolerance },
    });
    Object.assign(images, cut.images);
    accepted.push(id);
  }
  return { images, meta: withSprites(meta, sprites, rejectedList), checks, accepted, rejected, kept, dropped };
}

/** Remove the sprites (and the remembered rejections) of these variants; returns their layers so their files can be deleted. */
export function removeSprites(meta: LayersMeta, ids: readonly VariantId[]): { meta: LayersMeta; removed: LayerInfo[] } {
  const sm = spritesMeta(meta);
  if (!sm) return { meta, removed: [] };
  const drop = new Set(ids);
  const removed: LayerInfo[] = [];
  for (const s of sm.sprites) if (drop.has(s.id)) for (const l of s.layers) removed.push({ id: l.id, file: layerFile(l.id), rect: l.rect });
  return {
    meta: withSprites(
      meta,
      sm.sprites.filter((s) => !drop.has(s.id)),
      sm.rejected.filter((r) => !drop.has(r.id)),
    ),
    removed,
  };
}

/** Remember rejections (e.g. drawings that cannot be read) without touching any sprite. */
export function rejectSprites(meta: LayersMeta, rejections: readonly SpriteRejection[]): LayersMeta {
  const sm = spritesMeta(meta) ?? { version: 1 as const, sprites: [], rejected: [] };
  const ids = new Set(rejections.map((r) => r.id));
  return withSprites(meta, sm.sprites, [...sm.rejected.filter((r) => !ids.has(r.id)), ...rejections]);
}

/**
 * Carry the sprites of the previous layers.json into a freshly built one (a rebuild of the layers
 * does not touch the drawings, so their sprites stay). `exists` tells whether a sprite file is still
 * on disk; sprites with a missing file are dropped. Returns the sprite layers carried and the
 * variants whose sprites are stale because the eye regions / the mouth area changed since they were cut.
 */
export function carrySprites(
  previous: LayersMeta | null | undefined,
  meta: LayersMeta,
  spec: AvatarSpec,
  exists: (file: string) => boolean = () => true,
): { meta: LayersMeta; carried: LayerInfo[]; missing: VariantId[]; stale: VariantId[] } {
  const sm = spritesMeta(previous);
  if (!sm || !previous) return { meta, carried: [], missing: [], stale: [] };
  const missing: VariantId[] = [];
  const sprites = sm.sprites.filter((s) => {
    const ok = s.layers.every((l) => exists(layerFile(l.id)));
    if (!ok) missing.push(s.id);
    return ok;
  });
  const carried: LayerInfo[] = sprites.flatMap((s) => s.layers.map((l) => ({ id: l.id, file: layerFile(l.id), rect: l.rect })));
  const stale = sprites.filter((s) => s.inputsHash !== variantInputsHash(spec, s.group) || (s.layersHash !== null && s.layersHash !== meta.inputsHash)).map((s) => s.id);
  return { meta: withSprites(meta, sprites, sm.rejected), carried, missing, stale };
}

// ----------------------------------------------------------------------------- status

export type VariantState = 'missing' | 'requested' | 'drawn' | 'accepted' | 'rejected' | 'stale';

export interface VariantStatus {
  id: VariantId;
  group: VariantGroup;
  label: string;
  recommended: boolean;
  /**
   * One word: "accepted" (a current sprite), "stale" (a sprite whose drawing or landmarks changed
   * since it was cut: import again), "rejected" (the last import refused the current drawing),
   * "drawn" (a drawing that was not imported yet), "requested" (mask and prompt written, no
   * drawing), "missing" (nothing yet).
   */
  state: VariantState;
  /** variant-requests/<id>.mask.png exists. */
  requested: boolean;
  /** variants/<id>.png exists. */
  drawn: boolean;
  /** A sprite of this variant is in the model (it may be stale). */
  sprite: boolean;
  /** Why the sprite is stale. */
  stale: string[];
  /** The last rejection of the CURRENT drawing. */
  rejection: SpriteRejection | null;
  /** The numbers of the check that accepted the sprite's drawing. */
  check: SpriteRecord['check'] | null;
}

/**
 * The state of every variant. `files` tells, per variant, whether its request and its drawing
 * exist and the drawing's fingerprint (hashImage; null when it cannot be read).
 */
export function variantStatuses(
  spec: AvatarSpec | null,
  meta: LayersMeta | null,
  files: Partial<Record<VariantId, { requested: boolean; drawing: { hash: string | null } | null }>>,
): VariantStatus[] {
  const sm = spritesMeta(meta);
  return VARIANT_IDS.map((id) => {
    const def = VARIANTS[id];
    const f = files[id] ?? { requested: false, drawing: null };
    const sprite = sm?.sprites.find((s) => s.id === id) ?? null;
    const rejection = sm?.rejected.find((r) => r.id === id && f.drawing !== null && r.drawingHash === f.drawing.hash) ?? null;
    const stale: string[] = [];
    if (sprite) {
      if (spec && sprite.inputsHash !== variantInputsHash(spec, def.group)) stale.push(def.group==='eyes'?'the eye regions changed since the sprites were cut':def.group==='mouth'?'the mouth area changed since the sprite was cut':`the ${def.group} landmarks changed since the sprites were cut`);
      else if (meta && sprite.layersHash !== null && sprite.layersHash !== meta.inputsHash) stale.push('the layers over the sprite were rebuilt from other landmarks since it was cut');
      if (!f.drawing) stale.push(`variants/${id}.png is gone (import again to remove the sprite)`);
      else if (f.drawing.hash !== sprite.drawingHash && !rejection) stale.push(`variants/${id}.png changed since it was imported`);
    }
    const state: VariantState = rejection ? 'rejected' : sprite ? (stale.length ? 'stale' : 'accepted') : f.drawing ? 'drawn' : f.requested ? 'requested' : 'missing';
    return { id, group: def.group, label: def.label, recommended: def.recommended, state, requested: f.requested, drawn: f.drawing !== null, sprite: sprite !== null, stale, rejection, check: sprite?.check ?? null };
  });
}

/** The sprites of a group that the model shows: those with at least one layer in the layer list. */
export function shownSprites(meta: LayersMeta, group: VariantGroup): SpriteRecord[] {
  const sm = spritesMeta(meta);
  if (!sm) return [];
  const listed = new Set(meta.layers.map((l) => l.id));
  return sm.sprites.filter((s) => s.group === group && s.layers.some((l) => listed.has(l.id)));
}
