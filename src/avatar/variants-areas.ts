/**
 * Drawn variants, the shared ground (see ./variants.ts for the whole flow): the variant table (what
 * each variant is, where it is shown), the tuning numbers, the edit areas (the geometry of the masks:
 * the request, the check and the sprite cut all use it) and the fingerprints that make sprites
 * stale. Pure and deterministic, browser-safe.
 */
import type { ImageRGBA } from '../core/types.js';
import { VISEME_SHAPES } from '../lipsync/types.js';
import { canonicalJson, fnv1a64 } from './hash.js';
import { dilateMask, featherMask } from './image/distance.js';
import { createMask, maskThreshold } from './image/mask.js';
import { polygonArea, polygonBounds, translatePoints } from './image/polygon.js';
import { ellipseMask, polygonMask } from './image/raster.js';
import { pixelRect, type Mask, type Rect } from './image/types.js';
import { VARIANT_IDS, type AvatarSpec, type ImageSide, type VariantGroup, type VariantId } from './types.js';

// ----------------------------------------------------------------------------- the table

/** Which edit area of a group a sprite layer belongs to: one per eye, or the mouth area. */
export type VariantAreaKey = ImageSide | 'mouth';

export interface VariantDef {
  id: VariantId;
  group: VariantGroup;
  /** English label, e.g. "Eyes closed". */
  label: string;
  /** A few words for messages: "both eyes closed", "the mouth saying \"a\"". */
  short: string;
  /** The variants that matter most (they replace the two deformations a mesh does worst). */
  recommended: boolean;
  /** Eye variants: the eye state the sprite shows. */
  eye?: 'closed' | 'half' | 'smile';
  /** Mouth variants: where on (MouthOpen, MouthForm) the sprite shows (the src/lipsync viseme table). */
  mouth?: { open: number; form: number };
  /** What the image generator draws inside the mask (English, without the constraints). */
  draw: string;
}

const EYE_KEEP =
  'Keep the eye corners, the eyebrows and any hair that crosses the eyes exactly where they are; draw both eyes the same way, mirrored to their sides of the face.';
const MOUTH_KEEP =
  'Keep the mouth corners about where they are; the lips keep their original colour and line weight, and the whole mouth stays inside the editable area (the nose and the chin do not change).';

/** Every drawn variant, in VARIANT_IDS order. */
export const VARIANTS: Readonly<Record<VariantId, VariantDef>> = {
  eyes_closed: {
    id: 'eyes_closed',
    group: 'eyes',
    label: 'Eyes closed',
    short: 'both eyes gently closed',
    recommended: true,
    eye: 'closed',
    draw: `Both eyes gently closed, as in a relaxed blink: each eye becomes one clean, slightly downward-curved lash line where the upper lid meets the lower lid, with the colour and thickness of the original lashes. The closed lids are eyelid skin that matches the surrounding skin tone exactly; no eye white, iris, pupil or highlight remains. ${EYE_KEEP}`,
  },
  eyes_half: {
    id: 'eyes_half',
    group: 'eyes',
    label: 'Eyes half closed',
    short: 'both eyes half closed',
    recommended: false,
    eye: 'half',
    draw: `Both eyes half closed (a relaxed, sleepy look): the upper lid with its lash line is lowered about halfway over the iris, the lower lid stays where it is, so only the lower half of the iris and of the eye white is visible; the gaze still points the same way. ${EYE_KEEP}`,
  },
  eyes_smile: {
    id: 'eyes_smile',
    group: 'eyes',
    label: 'Smiling eyes',
    short: 'both eyes closed in a happy smile',
    recommended: false,
    eye: 'smile',
    draw: `Both eyes closed in a happy smile: each eye becomes one upward-arched lash curve (an upside-down U, like "^ ^"), with the colour and thickness of the original lashes; the lids below it are skin that matches the surrounding skin tone, and no eye white or iris remains. ${EYE_KEEP}`,
  },
  mouth_a: {
    id: 'mouth_a',
    group: 'mouth',
    label: 'Mouth "a"',
    short: 'the mouth wide open saying "a"',
    recommended: true,
    mouth: { open: VISEME_SHAPES.a.open, form: VISEME_SHAPES.a.form },
    draw: `The mouth wide open as when saying a clear "a" (as in "father"): a large, rounded opening that shows the dark inside of the mouth, the tongue low at the bottom and perhaps the edge of the upper teeth. ${MOUTH_KEEP}`,
  },
  mouth_a_half: {
    id: 'mouth_a_half',
    group: 'mouth',
    label: 'Mouth "a", half open',
    short: 'the mouth half open saying a relaxed "a"',
    recommended: false,
    mouth: { open: 0.5, form: 0 },
    draw: `The mouth half open, as in a relaxed "a": about half the opening of a wide "ah", showing the dark inside of the mouth and a little of the tongue. ${MOUTH_KEEP}`,
  },
  mouth_i: {
    id: 'mouth_i',
    group: 'mouth',
    label: 'Mouth "i"',
    short: 'the mouth saying "i"',
    recommended: false,
    mouth: { open: VISEME_SHAPES.i.open, form: VISEME_SHAPES.i.form },
    draw: `The mouth saying "i" (as in "see"): the lips spread wide sideways with only a narrow opening, the teeth may show. ${MOUTH_KEEP}`,
  },
  mouth_u: {
    id: 'mouth_u',
    group: 'mouth',
    label: 'Mouth "u"',
    short: 'the mouth saying "u"',
    recommended: false,
    mouth: { open: VISEME_SHAPES.u.open, form: VISEME_SHAPES.u.form },
    draw: `The mouth saying "u" (as in "food"): the lips pushed forward and rounded into a small round opening, narrower than the closed mouth. ${MOUTH_KEEP}`,
  },
  mouth_e: {
    id: 'mouth_e',
    group: 'mouth',
    label: 'Mouth "e"',
    short: 'the mouth saying "e"',
    recommended: false,
    mouth: { open: VISEME_SHAPES.e.open, form: VISEME_SHAPES.e.form },
    draw: `The mouth saying "e" (as in "bed"): a medium opening with the lips spread a little sideways, the dark inside of the mouth visible. ${MOUTH_KEEP}`,
  },
  mouth_o: {
    id: 'mouth_o',
    group: 'mouth',
    label: 'Mouth "o"',
    short: 'the mouth saying "o"',
    recommended: false,
    mouth: { open: VISEME_SHAPES.o.open, form: VISEME_SHAPES.o.form },
    draw: `The mouth saying "o" (as in "go"): a rounded oval opening, taller than wide, with rounded lips and the dark inside of the mouth visible. ${MOUTH_KEEP}`,
  },
};

/** The variants drawn when nobody names any: closed eyes and the open mouth. */
export const RECOMMENDED_VARIANT_IDS: readonly VariantId[] = VARIANT_IDS.filter((id) => VARIANTS[id].recommended);

export function isVariantId(value: unknown): value is VariantId {
  return typeof value === 'string' && (VARIANT_IDS as readonly string[]).includes(value);
}

/** The variant ids of a group, in VARIANT_IDS order. */
export function variantsOfGroup(group: VariantGroup): VariantId[] {
  return VARIANT_IDS.filter((id) => VARIANTS[id].group === group);
}

// ----------------------------------------------------------------------------- tuning

/**
 * The numbers of the drawn-variant pipeline in one place. Areas: an eye's edit area is its region
 * grown by `eyeGrow` of the region's size (the square root of its area); the mouth's is the mouth
 * area ellipse grown by `mouthGrow` of its smaller radius; both fade out over `featherShare` of that
 * growth beyond it. Check: see ./variants-check.ts.
 */
export const VARIANT_TUNING = {
  eyeGrow: 0.08,
  mouthGrow: 0.05,
  minGrow: 1.5,
  featherShare: 0.6,
  minFeather: 2,
  /** The ring around an edit area where a colour step would show as a seam: this many feather widths, at least 4 px. */
  nearFeathers: 2,
  minNear: 4,
  /** Default of spec.build.variantTolerance: the mean difference (0-255) allowed outside the mask. */
  tolerance: 2,
  /** A pixel counts as changed when its mean channel difference exceeds this (0-255). */
  changed: 12,
  /** ... and as badly changed beyond this. */
  bad: 40,
  /** Share of the editable core (of each eye, for eye variants) that must change. */
  minInsideChange: 0.02,
  /** Most share of the pixels outside the mask that may change badly (a new element, a repainted area). */
  maxBadShare: 0.005,
  /** The mean difference in the ring around the edit areas may be this many times the tolerance. */
  nearFactor: 2.5,
  /** Source pixels with an alpha below this are transparent background: a generator that fills it in is noted, not rejected. */
  backgroundAlpha: 8,
  /** Largest global shift (px) and zoom (share) the check looks for to explain a rejection. */
  maxShift: 8,
  maxZoom: 0.08,
} as const;

/** Version of the edit-area geometry: part of variantInputsHash, so a change of the rules makes old sprites stale. */
export const VARIANT_AREA_VERSION = 1;

// ----------------------------------------------------------------------------- edit areas

export interface VariantArea {
  key: VariantAreaKey;
  /** Window of the image holding the area, its soft edge and the seam ring (whole pixels, inside the image). */
  rect: Rect;
  /** Editable coverage inside `rect`: 1 = may change (the core), fading to 0 over the feather. */
  mask: Mask;
  /** 1 in the ring of `near` px outside the editable coverage (where seams would show), else 0; inside `rect`. */
  ring: Mask;
  /** Px the landmark polygon / ellipse was grown by, and the width of the soft edge beyond. */
  grow: number;
  feather: number;
  /** The landmark shape the area grows from, for messages: [x0, y0, x1, y1] of the region / ellipse bounds. */
  bounds: [number, number, number, number];
}

export interface VariantEditAreas {
  group: VariantGroup;
  width: number;
  height: number;
  areas: VariantArea[];
}

const round2 = (v: number) => Math.round(v * 100) / 100;

function areaFrom(key: VariantAreaKey, width: number, height: number, bounds: Rect, grow: number, feather: number, raster: (w: number, h: number, ox: number, oy: number) => Mask): VariantArea {
  const near = Math.max(VARIANT_TUNING.minNear, VARIANT_TUNING.nearFeathers * feather);
  const rect = pixelRect(bounds, Math.ceil(grow + feather + near) + 2, width, height);
  const shape = raster(rect.width, rect.height, rect.x, rect.y);
  const mask = featherMask(grow > 0 ? dilateMask(shape, grow) : shape, feather, 'outward');
  // The seam ring: everything within `near` px of any editable pixel, minus the editable pixels.
  const any = maskThreshold(mask, 1e-3);
  const reach = dilateMask(any, near);
  const ring = createMask(rect.width, rect.height);
  for (let i = 0; i < ring.data.length; i++) ring.data[i] = reach.data[i] >= 0.5 && mask.data[i] <= 1e-3 ? 1 : 0;
  return {
    key,
    rect,
    mask,
    ring,
    grow: round2(grow),
    feather: round2(feather),
    bounds: [round2(bounds.x), round2(bounds.y), round2(bounds.x + bounds.width), round2(bounds.y + bounds.height)],
  };
}

/** The bounds of a rotated ellipse. */
function ellipseBounds(cx: number, cy: number, rx: number, ry: number, rotation: number): Rect {
  const r = (rotation * Math.PI) / 180;
  const ex = Math.sqrt((rx * Math.cos(r)) ** 2 + (ry * Math.sin(r)) ** 2);
  const ey = Math.sqrt((rx * Math.sin(r)) ** 2 + (ry * Math.cos(r)) ** 2);
  return { x: cx - ex, y: cy - ey, width: 2 * ex, height: 2 * ey };
}

/**
 * The edit areas of a group: both eye regions (slightly grown, feathered) for eye variants, the
 * mouth area ellipse for mouth variants. Requests, the check and the sprite cut all use these.
 */
export function variantEditAreas(spec: AvatarSpec, group: VariantGroup): VariantEditAreas {
  const { width, height } = spec.image;
  const T = VARIANT_TUNING;
  const areas: VariantArea[] = [];
  if (group === 'eyes') {
    for (const side of ['imageLeft', 'imageRight'] as const) {
      const region = spec.face.eyes[side].region;
      const size = Math.sqrt(Math.abs(polygonArea(region)));
      const grow = Math.max(T.minGrow, T.eyeGrow * size);
      const feather = Math.max(T.minFeather, T.featherShare * grow);
      areas.push(areaFrom(side, width, height, polygonBounds(region), grow, feather, (w, h, ox, oy) => polygonMask(w, h, translatePoints(region, -ox, -oy))));
    }
  } else {
    const { center, radius, rotation } = spec.face.mouth.area;
    const grow = Math.max(T.minGrow, T.mouthGrow * Math.min(radius[0], radius[1]));
    const feather = Math.max(T.minFeather, T.featherShare * grow);
    const bounds = ellipseBounds(center[0], center[1], radius[0], radius[1], rotation);
    areas.push(areaFrom('mouth', width, height, bounds, grow, feather, (w, h, ox, oy) => ellipseMask(w, h, center[0] - ox, center[1] - oy, radius[0], radius[1], rotation)));
  }
  return { group, width, height, areas };
}

/** The editable coverage of a group at the full image size (0 = must stay identical, 1 = may change). */
export function variantEditable(edit: VariantEditAreas): Mask {
  const out = createMask(edit.width, edit.height);
  for (const a of edit.areas) {
    for (let y = 0; y < a.rect.height; y++) {
      const src = y * a.rect.width;
      const dst = (y + a.rect.y) * edit.width + a.rect.x;
      for (let x = 0; x < a.rect.width; x++) {
        const v = a.mask.data[src + x];
        if (v > out.data[dst + x]) out.data[dst + x] = v;
      }
    }
  }
  return out;
}

/**
 * The edit mask an image generator gets, at the source size: OPAQUE black where the picture must
 * stay identical, TRANSPARENT where it may change (soft in between). The transparent pixels are
 * white, so tools that read a mask as "white = edit" (no alpha) understand it too.
 */
export function variantMaskImage(edit: VariantEditAreas): ImageRGBA {
  const editable = variantEditable(edit);
  const data = new Uint8ClampedArray(edit.width * edit.height * 4);
  for (let i = 0, j = 0; i < editable.data.length; i++, j += 4) {
    const e = Math.min(1, Math.max(0, editable.data[i]));
    const white = Math.round(e * 255);
    data[j] = white;
    data[j + 1] = white;
    data[j + 2] = white;
    data[j + 3] = 255 - white;
  }
  return { width: edit.width, height: edit.height, data };
}

/**
 * Fingerprint of everything an edit area of the group depends on (image size, eye regions or the
 * mouth area, the area rules): a sprite cut under another fingerprint is stale.
 */
export function variantInputsHash(spec: AvatarSpec, group: VariantGroup): string {
  const inputs =
    group === 'eyes'
      ? { imageLeft: spec.face.eyes.imageLeft.region, imageRight: spec.face.eyes.imageRight.region }
      : { area: spec.face.mouth.area };
  return fnv1a64(canonicalJson({ version: VARIANT_AREA_VERSION, group, image: [spec.image.width, spec.image.height], inputs }));
}

/**
 * A 64-bit fingerprint (16 hex digits) of an image's size and pixels: two FNV-1a style lanes over
 * the RGBA bytes. A redrawn variant has another fingerprint than the one its sprite was cut from.
 */
export function hashImage(img: ImageRGBA): string {
  let a = 0x811c9dc5 ^ img.width;
  let b = 0x9e3779b9 ^ img.height;
  const d = img.data;
  for (let i = 0; i < d.length; i++) {
    a = Math.imul(a ^ d[i], 0x01000193);
    b = Math.imul(b ^ d[i], 0x85ebca6b) ^ (b >>> 13);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

/** "variants/eyes_closed.png" and the request files of a variant, relative to the project. */
export function variantFiles(id: VariantId): { drawing: string; mask: string; prompt: string } {
  return { drawing: `variants/${id}.png`, mask: `variant-requests/${id}.mask.png`, prompt: `variant-requests/${id}.prompt.txt` };
}

export const VARIANT_README = 'variant-requests/README.md';
export const VARIANT_PREVIEW = 'variant-requests/preview.png';
