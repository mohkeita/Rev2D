/**
 * The face features (../features/eyes.ts, mouth.ts, brows.ts, cheeks.ts) on the repository's own
 * test illustration (test/fixtures/avatar-hana.ts, half size: 256 x 320), built with the skeleton and
 * these features only, so the tests do not depend on hair or attachments:
 *
 *   - the rest pose is the illustration; the model validates; no folds; deterministic;
 *   - closed eyes: no iris or eye-white pixel inside either opening, the other eye untouched by a
 *     wink, half-open shows about half of the opening, the brow does not move;
 *   - gaze moves the iris in the direction of each parameter sign;
 *   - the mouth: MouthOpen darkens the mouth area and leaves the chin outline in place, the six
 *     lip-sync shapes differ, MouthForm moves the corners;
 *   - brows rise and sink without moving the eyes; the blush follows Cheek;
 *   - compile copes with missing metadata.
 */
import { describe, expect, it } from 'vitest';
import { formatModelJson } from '../../core/format.js';
import { Rig, buildRenderList } from '../../core/rig.js';
import type { ImageRGBA, Model } from '../../core/types.js';
import { validateModel } from '../../core/validate.js';
import { VISEME_SHAPES } from '../../lipsync/types.js';
import { renderImage } from '../../render/index.js';
import { hanaIllustration } from '../../../test/fixtures/avatar-hana.js';
import { compileModel } from '../compile.js';
import type { BrowsMeta } from '../features/brows.js';
import { blushColor } from '../features/cheeks.js';
import { EYE_IDS, eyeBlinkField, eyeGeometry, eyeMaskMesh, offsetPolygon, type EyesMeta } from '../features/eyes.js';
import { channelDifference, parseHex, writeMatte, writeMatteToward } from '../features/eyes-matte.js';
import { AVATAR_FEATURES } from '../features/index.js';
import { MOUTH_LAYER, mouthGeometry, mouthPose, type MouthMeta } from '../features/mouth.js';
import { findFolds } from '../folds.js';
import { rgbToLab } from '../image/color.js';
import { ellipseMask, polygonMask } from '../image/raster.js';
import { buildLayers } from '../layers.js';
import { reviewPoses } from '../poses.js';
import { parseAvatarSpec } from '../spec.js';
import type { AvatarSpec, ImageSide } from '../types.js';
import { createImage } from '../../render/image.js';

const FEATURES = AVATAR_FEATURES.filter((f) => ['head', 'body', 'eyes', 'mouth', 'brows', 'cheeks'].includes(f.id));

const hana = hanaIllustration(0.5);
const spec = parseAvatarSpec(hana.doc).spec as AvatarSpec;
const layers = buildLayers(spec, hana.image, undefined, FEATURES);
const compiled = compileModel(spec, layers.meta, FEATURES);
const validation = validateModel(compiled.doc);
const model = validation.model as Model;
const rig = new Rig(model);
const textures = Object.fromEntries(layers.meta.layers.map((l) => [l.id, layers.images[l.file]]));
const W = hana.width;
const H = hana.height;
const eyesMeta = layers.meta.eyes as EyesMeta;

function render(params: Record<string, number> = {}): ImageRGBA {
  return renderImage(buildRenderList(rig, rig.pose({ params, physics: false })), textures, { supersample: 1 });
}

const rest = render();
const lab = (img: ImageRGBA, i: number) => rgbToLab(img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]);
const deltaE = (p: number[], q: number[]) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
const hexLab = (hex: string) => {
  const c = parseHex(hex)!;
  return rgbToLab(c[0], c[1], c[2]);
};

/** Pixels (index list) where a mask is fully set. */
function inside(mask: { data: Float32Array }, threshold = 0.999): number[] {
  const out: number[] = [];
  for (let i = 0; i < mask.data.length; i++) if (mask.data[i] >= threshold) out.push(i);
  return out;
}

/** Pixels of an eye's opening (fully inside the traced polygon). */
const opening = (side: ImageSide) => inside(polygonMask(W, H, spec.face.eyes[side].opening));
/** Pixels of an eye's opening whose colour is the eye white or the iris of that eye. */
function eyePixels(img: ImageRGBA, side: ImageSide, tolerance = 12): number[] {
  const eye = eyesMeta[side]!;
  const white = hexLab(eye.colors.white);
  const iris = hexLab(eye.colors.iris);
  return opening(side).filter((i) => {
    const c = lab(img, i);
    return deltaE(c, white) < tolerance || deltaE(c, iris) < tolerance;
  });
}

function maxDelta(a: ImageRGBA, b: ImageRGBA, pixels: number[]): number {
  let worst = 0;
  for (const i of pixels) worst = Math.max(worst, channelDifference(a, b, i));
  return worst;
}

describe('face features: the model', () => {
  it('builds the eye, mouth and brow layers and stores their metadata', () => {
    const ids = layers.meta.layers.map((l) => l.id);
    for (const id of ['eyeR_ball', 'eyeR_upper', 'eyeR_lower', 'eyeL_ball', 'eyeL_upper', 'eyeL_lower', MOUTH_LAYER, 'browL', 'browR']) expect(ids).toContain(id);
    expect(eyesMeta.imageLeft?.id).toBe('eyeR');
    expect(eyesMeta.imageRight?.id).toBe('eyeL');
    for (const side of ['imageLeft', 'imageRight'] as const) {
      const eye = eyesMeta[side]!;
      expect(eye.u.length).toBe(eye.upper.length);
      expect(eye.lash).toBeGreaterThan(0);
      // Eye white and iris are clearly different estimated colours.
      expect(deltaE(hexLab(eye.colors.white), hexLab(eye.colors.iris))).toBeGreaterThan(30);
    }
    expect((layers.meta.mouth as MouthMeta).line).toBeGreaterThan(0);
    expect(layers.report.issues.filter((i) => i.severity === 'warning')).toEqual([]);
  });

  it('declares the face parameters and validates without warnings', () => {
    const ids = model.parameters.map((p) => p.id);
    for (const id of ['EyeLOpen', 'EyeROpen', 'EyeBallX', 'EyeBallY', 'BrowLY', 'BrowRY', 'MouthOpen', 'MouthForm', 'Cheek']) expect(ids).toContain(id);
    expect(validation.diagnostics.filter((d) => d.severity !== 'info')).toEqual([]);
    expect(compiled.report.issues).toEqual([]);
  });

  it('has no folds, also with the eyes closed and the mouth open while the head turns', () => {
    const plan = { ...compiled.folds, poses: [...compiled.folds.poses, { EyeLOpen: 0, EyeROpen: 0, MouthOpen: 1, AngleX: 30, AngleY: -30 }, { EyeLOpen: 0.5, MouthOpen: 0.5, MouthForm: -1, AngleZ: -30 }] };
    expect(findFolds(model, plan)).toEqual([]);
  });

  it('is deterministic', () => {
    const again = buildLayers(spec, hana.image, undefined, FEATURES);
    expect(JSON.stringify(again.meta)).toBe(JSON.stringify(layers.meta));
    for (const file of Object.keys(layers.images)) expect(Buffer.compare(Buffer.from(again.images[file].data), Buffer.from(layers.images[file].data))).toBe(0);
    expect(formatModelJson(compileModel(spec, again.meta, FEATURES).doc)).toBe(formatModelJson(compiled.doc));
  });

  it('rests on the illustration: under 1% of the pixels differ by more than 2, none by more than 24', () => {
    let over2 = 0;
    let worst = 0;
    for (let i = 0; i < W * H; i++) {
      if (hana.image.data[i * 4 + 3] < 16) continue;
      const d = channelDifference(rest, hana.image, i);
      if (d > 2) over2++;
      worst = Math.max(worst, d);
    }
    expect(over2 / (W * H)).toBeLessThan(0.01);
    expect(worst).toBeLessThanOrEqual(24);
  });

  it('adds review poses for the eyes, brows, blush and the six lip-sync shapes', () => {
    const ids = reviewPoses(spec, layers.meta, FEATURES).map((p) => p.id);
    for (const id of ['eyes_quarter', 'wink', 'gaze_right', 'gaze_left', 'gaze_up', 'gaze_down', 'brows_up', 'brows_down', 'blush', 'viseme_a', 'viseme_i', 'viseme_u', 'viseme_e', 'viseme_o', 'viseme_n']) {
      expect(ids).toContain(id);
    }
  });
});

describe('eyes', () => {
  const closed = render({ EyeLOpen: 0, EyeROpen: 0 });

  it('closed: no iris or eye-white pixel is left inside either opening', () => {
    for (const side of ['imageLeft', 'imageRight'] as const) {
      // (At rest a good part of the opening has exactly these colours: the check can see them.)
      expect(eyePixels(rest, side).length).toBeGreaterThan(opening(side).length * 0.25);
      expect(eyePixels(closed, side)).toEqual([]);
    }
  });

  it('a wink closes one eye and leaves the other eye untouched', () => {
    const wink = render({ EyeLOpen: 0 });
    // EyeLOpen is the character's left eye: the one on the image right.
    expect(eyePixels(wink, 'imageRight')).toEqual([]);
    const region = inside(polygonMask(W, H, spec.face.eyes.imageLeft.region), 0.5);
    expect(maxDelta(wink, rest, region)).toBeLessThanOrEqual(1);
  });

  it('half-open shows about half of the opening', () => {
    const half = render({ EyeLOpen: 0.5, EyeROpen: 0.5 });
    // Pixels of the opening that still show the open eye: as at rest, and clearly unlike the closed eye.
    const showing = (img: ImageRGBA, side: ImageSide) => opening(side).filter((i) => channelDifference(rest, closed, i) > 40 && channelDifference(img, rest, i) <= 8).length;
    for (const side of ['imageLeft', 'imageRight'] as const) {
      const ratio = showing(half, side) / showing(rest, side);
      expect(ratio).toBeGreaterThan(0.3);
      expect(ratio).toBeLessThan(0.7);
    }
  });

  it('the brows and the cheek below the eye stay where they are while the eyes close', () => {
    const brows = spec.face.brows!;
    for (const side of ['imageLeft', 'imageRight'] as const) {
      const eye = eyesMeta[side]!;
      // A band around the brow line and a band below the eye region.
      const browBand: number[] = [];
      const below: number[] = [];
      const line = brows[side];
      // The lower lid rises a little toward the meeting line; the cheek below the region stays.
      const bottom = Math.ceil(eye.center[1] + Math.max(...eye.bottom!)) + 4;
      for (let y = 0; y < H; y++) {
        for (let x = Math.floor(eye.u[0] + eye.center[0]); x < eye.u[eye.u.length - 1] + eye.center[0]; x++) {
          if (y >= bottom && y < bottom + 6) below.push(y * W + x);
          const near = line.some((_, k) => k % 2 === 0 && Math.abs(line[k] - x) < 4 && Math.abs(line[k + 1] - y) < 2);
          if (near) browBand.push(y * W + x);
        }
      }
      expect(browBand.length).toBeGreaterThan(0);
      // (Up to a few levels where a faint stroke near the brow fades with the crease: invisible.)
      expect(maxDelta(closed, rest, browBand)).toBeLessThanOrEqual(4);
      expect(maxDelta(closed, rest, below)).toBeLessThanOrEqual(2);
    }
  });

  it('gaze moves the iris toward each sign of EyeBallX / EyeBallY', () => {
    const centroid = (img: ImageRGBA, side: ImageSide): [number, number] => {
      const iris = hexLab(eyesMeta[side]!.colors.iris);
      let sx = 0;
      let sy = 0;
      let n = 0;
      for (const i of opening(side)) {
        if (deltaE(lab(img, i), iris) >= 14) continue;
        sx += i % W;
        sy += Math.floor(i / W);
        n++;
      }
      return [sx / n, sy / n];
    };
    for (const side of ['imageLeft', 'imageRight'] as const) {
      const c0 = centroid(rest, side);
      const right = centroid(render({ EyeBallX: 1 }), side);
      const left = centroid(render({ EyeBallX: -1 }), side);
      const up = centroid(render({ EyeBallY: 1 }), side);
      const down = centroid(render({ EyeBallY: -1 }), side);
      // (The part of the iris that the lids clip off holds the centroid back a little.)
      expect(right[0] - c0[0]).toBeGreaterThan(0.25);
      expect(left[0] - c0[0]).toBeLessThan(-0.25);
      // EyeBallY > 0 looks up: smaller y.
      expect(up[1] - c0[1]).toBeLessThan(-0.15);
      expect(down[1] - c0[1]).toBeGreaterThan(0.15);
    }
  });

  it('the mask mesh collapses onto the meeting line and the lids meet there', () => {
    for (const side of ['imageLeft', 'imageRight'] as const) {
      const eye = eyesMeta[side]!;
      const mesh = eyeMaskMesh(eye);
      const n = eye.u.length;
      // Closed: both rows coincide (zero area), between the open rows.
      expect(mesh.closed.slice(0, n * 2)).toEqual(mesh.closed.slice(n * 2));
      const g = eyeGeometry(eye);
      const k = n >> 1;
      const u = eye.u[k];
      const meet = g.meet(u);
      expect(meet).toBeGreaterThan(eye.upper[k]);
      expect(meet).toBeLessThan(eye.lower[k]);
      // The lash's lower edge ends just below the meeting line, the lower lid's upper edge just above it.
      expect(eye.upper[k] + eye.grow + g.travelUp(u)).toBeCloseTo(meet + 1, 5);
      expect(eye.lower[k] - eye.grow - g.travelDown(u)).toBeCloseTo(meet - 1, 5);
      // Nothing moves above the region or far below the opening; the lash band moves rigidly.
      const up = eyeBlinkField(eye, 'upper');
      const [x0, y0] = g.frame.from(u, eye.top[k] - 3 * g.travelUp(u));
      expect(up(x0, y0)).toEqual([0, 0]);
      const [x1, y1] = g.frame.from(u, eye.upper[k] - 1);
      expect(up(x1, y1)[1]).toBeCloseTo(g.travelUp(u), 5);
      const low = eyeBlinkField(eye, 'lower');
      const [x2, y2] = g.frame.from(u, eye.lower[k] + 1);
      expect(low(x2, y2)[1]).toBeCloseTo(-g.travelDown(u), 5);
    }
  });

  it('builds without metadata or with metadata of another shape: no eye parts, no error', () => {
    const bare = compileModel(spec, { ...layers.meta, eyes: undefined, mouth: undefined, brows: undefined }, FEATURES);
    const parts = (bare.doc.parts as Array<{ id: string }>).map((p) => p.id);
    expect(parts.some((id) => id.startsWith('eyeL') || id.startsWith('eyeR') || id.startsWith('mouth') || id.startsWith('brow'))).toBe(false);
    const odd = compileModel(spec, { ...layers.meta, eyes: { version: 1, imageLeft: { id: 'eyeR', u: [1] } } }, FEATURES);
    expect(validateModel(odd.doc).diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });
});

describe('mouth', () => {
  const area = spec.face.mouth.area;
  const areaPixels = inside(ellipseMask(W, H, area.center[0], area.center[1], area.radius[0], area.radius[1], area.rotation));
  const luminance = (img: ImageRGBA, pixels: number[]) => pixels.reduce((s, i) => s + lab(img, i)[0], 0) / pixels.length;

  it('MouthOpen = 1 darkens the mouth area and leaves the chin outline in place', () => {
    const open = render({ MouthOpen: 1 });
    expect(luminance(rest, areaPixels) - luminance(open, areaPixels)).toBeGreaterThan(4);
    // The chin outline: every pixel within 4 px of the chin tip, and the rows below the mouth area.
    const [cx, cy] = spec.face.chin;
    const chin: number[] = [];
    for (let y = Math.floor(cy - 4); y <= cy + 4; y++) for (let x = Math.floor(cx - 20); x <= cx + 20; x++) chin.push(y * W + x);
    expect(maxDelta(open, rest, chin)).toBeLessThanOrEqual(3);
  });

  it('the six lip-sync shapes are distinguishable', () => {
    const shapes = (['a', 'i', 'u', 'e', 'o', 'n'] as const).map((v) => render({ MouthOpen: VISEME_SHAPES[v].open, MouthForm: VISEME_SHAPES[v].form }));
    for (let a = 0; a < shapes.length; a++) {
      for (let b = a + 1; b < shapes.length; b++) {
        let differ = 0;
        for (const i of areaPixels) if (channelDifference(shapes[a], shapes[b], i) > 24) differ++;
        expect(differ, `shapes ${a} and ${b}`).toBeGreaterThan(areaPixels.length * 0.02);
      }
    }
    // "n" is the closed mouth: the rest pose.
    expect(maxDelta(shapes[5], rest, areaPixels)).toBeLessThanOrEqual(1);
  });

  it('MouthForm widens and lifts the corners (> 0) or narrows the mouth (< 0)', () => {
    const g = mouthGeometry(spec);
    const line = (layers.meta.mouth as MouthMeta).line;
    const wide = mouthPose(g, 0, 1, line);
    const narrow = mouthPose(g, 0, -1, line);
    const [lx, ly] = spec.face.mouth.imageLeft;
    const [rx, ry] = spec.face.mouth.imageRight;
    expect(wide.field(lx, ly)[0]).toBeLessThan(-0.5);
    expect(wide.field(rx, ry)[0]).toBeGreaterThan(0.5);
    expect(wide.field(lx, ly)[1]).toBeLessThan(-0.3);
    expect(narrow.field(lx, ly)[0]).toBeGreaterThan(0.5);
    expect(narrow.field(rx, ry)[0]).toBeLessThan(-0.5);
    // Closed, the opening has no height; open, its lower edge lies below its upper edge in the middle.
    const shut = mouthPose(g, 0, 0, line);
    expect(shut.upper).toEqual(shut.lower);
    const open = mouthPose(g, 1, 0, line);
    // y of the middle sample (flat lists [x0, y0, ...]).
    const k = (open.upper.length >> 2) * 2 + 1;
    expect(open.lower[k] - open.upper[k]).toBeGreaterThan(4);
  });
});

describe('brows and blush', () => {
  const browsMeta = layers.meta.brows as BrowsMeta;

  it('brows rise and sink, the eyes stay', () => {
    const top = (params: Record<string, number>, id: string) => rig.pose({ params, physics: false }).parts[id].bounds![1];
    const up = render({ BrowLY: 1, BrowRY: 1 });
    for (const side of ['imageLeft', 'imageRight'] as const) {
      const brow = browsMeta[side]!;
      // BrowLY moves the character's left brow: the one on the image right.
      const param = side === 'imageRight' ? 'BrowLY' : 'BrowRY';
      expect(brow.id).toBe(side === 'imageRight' ? 'browL' : 'browR');
      expect(brow.lift).toBeGreaterThan(0);
      expect(top({ [param]: 1 }, brow.id)).toBeCloseTo(top({}, brow.id) - brow.lift, 1);
      expect(top({ [param]: -1 }, brow.id)).toBeCloseTo(top({}, brow.id) + brow.drop, 1);
      // The brow pixels move; the eye openings do not.
      const layer = layers.meta.layers.find((l) => l.id === brow.id)!;
      const [x, y, w, h] = layer.rect;
      const area: number[] = [];
      for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) area.push(yy * W + xx);
      expect(maxDelta(up, rest, area)).toBeGreaterThan(20);
      expect(maxDelta(up, rest, opening(side))).toBeLessThanOrEqual(1);
    }
  });

  it('the blush follows Cheek and is invisible at rest', () => {
    const blush = render({ Cheek: 1 });
    const cheeks = spec.face.cheeks!;
    for (const side of ['imageLeft', 'imageRight'] as const) {
      const [x, y] = cheeks[side];
      const i = Math.floor(y) * W + Math.floor(x);
      // Redder (a* up) at the centre of the cheek.
      expect(lab(blush, i)[1] - lab(rest, i)[1]).toBeGreaterThan(3);
    }
    // A blush colour is deeper and redder than the skin for pale and dark skin alike.
    for (const skin of [[250, 225, 210], [120, 80, 60]] as const) {
      const [L, a] = rgbToLab(skin[0], skin[1], skin[2]);
      const b = blushColor([skin[0], skin[1], skin[2]]);
      const [bL, ba] = rgbToLab(b[0], b[1], b[2]);
      expect(bL).toBeLessThan(L);
      expect(ba).toBeGreaterThan(a + 10);
    }
  });
});

describe('helpers', () => {
  it('offsetPolygon grows a polygon of either winding by the distance', () => {
    const square = [0, 0, 10, 0, 10, 10, 0, 10];
    const grown = offsetPolygon(square, 1);
    expect(grown[0]).toBeLessThan(0);
    expect(grown[1]).toBeLessThan(0);
    const reversed = offsetPolygon([0, 10, 10, 10, 10, 0, 0, 0], 1);
    expect(Math.min(...reversed.filter((_, k) => k % 2 === 0))).toBeLessThan(0);
    expect(Math.max(...reversed.filter((_, k) => k % 2 === 0))).toBeGreaterThan(10);
  });

  it('writeMatte gives the most transparent colour that turns the fill into the picture', () => {
    const source = createImage(3, 1);
    const fill = createImage(3, 1);
    source.data.set([40, 20, 30, 255, 250, 230, 220, 255, 251, 230, 220, 255]);
    fill.data.set([250, 230, 220, 255, 250, 230, 220, 255, 250, 230, 220, 255]);
    const out = createImage(3, 1);
    // A dark stroke: high alpha; plain skin: nothing; one level of noise: nothing.
    expect(writeMatte(out, source, fill, 0)).toBeGreaterThan(200);
    expect(writeMatte(out, source, fill, 1)).toBe(0);
    expect(writeMatte(out, source, fill, 2)).toBe(0);
    const a = out.data[3] / 255;
    for (let c = 0; c < 3; c++) expect(Math.abs(out.data[c] * a + fill.data[c] * (1 - a) - source.data[c])).toBeLessThanOrEqual(1);
  });

  it('writeMatteToward keeps an edge in its own colour and still gives the picture over the fill', () => {
    // Half hair, half eye white: writeMatte finds a darker, thinner colour; leaning toward the hair
    // gives the hair's colour at about half alpha, which looks right over any other backing.
    const source = createImage(1, 1);
    const white = createImage(1, 1);
    source.data.set([150, 140, 149, 255]);
    white.data.set([250, 250, 252, 255]);
    const hair = [50, 30, 45];
    const thin = createImage(1, 1);
    const toward = createImage(1, 1);
    const a1 = writeMatte(thin, source, white, 0);
    const a2 = writeMatteToward(toward, source, white, 0, hair);
    expect(a2).toBeGreaterThanOrEqual(a1);
    expect(a2 / 255).toBeCloseTo(0.5, 1);
    for (let c = 0; c < 3; c++) expect(Math.abs(toward.data[c] - hair[c])).toBeLessThanOrEqual(12);
    const a = a2 / 255;
    for (let c = 0; c < 3; c++) expect(Math.abs(toward.data[c] * a + white.data[c] * (1 - a) - source.data[c])).toBeLessThanOrEqual(1);
    // Nothing to draw where the picture is the fill.
    expect(writeMatteToward(toward, white, white, 0, hair)).toBe(0);
  });

  it('eye ids: L is the eye on the image right', () => {
    expect(EYE_IDS).toEqual({ imageLeft: 'eyeR', imageRight: 'eyeL' });
  });
});

describe('face features with the hair', () => {
  const ALL = AVATAR_FEATURES;
  const allLayers = buildLayers(spec, hana.image, undefined, ALL);
  const allCompiled = compileModel(spec, allLayers.meta, ALL);
  const allModel = validateModel(allCompiled.doc).model as Model;
  const allRig = new Rig(allModel);
  const allTextures = Object.fromEntries(allLayers.meta.layers.map((l) => [l.id, allLayers.images[l.file]]));
  const renderAll = (params: Record<string, number> = {}) => renderImage(buildRenderList(allRig, allRig.pose({ params, physics: false })), allTextures, { supersample: 1 });
  const parts = new Map(allModel.parts.map((p) => [p.id, p]));

  it('rests on the illustration, and the hair over an eye moves with the hair', () => {
    const image = renderAll();
    let worst = 0;
    for (let i = 0; i < W * H; i++) if (hana.image.data[i * 4 + 3] >= 16) worst = Math.max(worst, channelDifference(image, hana.image, i));
    expect(worst).toBeLessThanOrEqual(2);
    // The eye's matte of the hair over it lies in the hair lattice (hana's lock over the image-right eye).
    const fronts = allModel.parts.filter((p) => p.id.endsWith('_front'));
    expect(fronts.length).toBeGreaterThan(0);
    const hairParent = parts.get('hair')!.parent;
    for (const front of fronts) {
      expect(front.parent).toBe(hairParent);
      expect(front.visible ?? true).toBe(true);
    }
  });

  it('draws the cut brows above the hair, with no static copy of the brows, and the bangs go on under them', () => {
    expect(allLayers.meta.layers.some((l) => l.id === 'hair_brows')).toBe(false);
    const hairZ = parts.get('hair')!.z ?? 0;
    for (const id of ['browL', 'browR']) expect(parts.get(id)!.z ?? 0).toBeGreaterThan(hairZ);
    // The hair layer holds pixels under the brows (the continued bangs) that the brows feature claimed.
    const hairLayer = allLayers.meta.layers.find((l) => l.id === 'hair')!;
    const hairImage = allLayers.images[hairLayer.file];
    let under = 0;
    for (const id of ['browL', 'browR']) {
      const [x, y, w, h] = allLayers.meta.layers.find((l) => l.id === id)!.rect;
      for (let yy = y; yy < y + h; yy++) {
        for (let xx = x; xx < x + w; xx++) {
          const lx = xx - hairLayer.rect[0];
          const ly = yy - hairLayer.rect[1];
          if (lx >= 0 && ly >= 0 && lx < hairLayer.rect[2] && ly < hairLayer.rect[3] && hairImage.data[(ly * hairLayer.rect[2] + lx) * 4 + 3] === 255) under++;
        }
      }
    }
    expect(under).toBeGreaterThan(0);
  });

  it('closed eyes stay clean with the hair: no iris or eye-white pixel in either opening', () => {
    const closed = renderAll({ EyeLOpen: 0, EyeROpen: 0 });
    for (const side of ['imageLeft', 'imageRight'] as const) expect(eyePixels(closed, side)).toEqual([]);
  });
});
