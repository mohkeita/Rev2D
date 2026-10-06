/**
 * The hair and attachments features (../features/hair.ts, attachments.ts) on the repository's own
 * test illustration (test/fixtures/avatar-hana.ts, half size: 256 x 320), built with the skeleton
 * and these features only, so the tests do not depend on the face features:
 *
 *   - the hair mask covers the hair and stays off the face;
 *   - one strand parameter moves the pixels of its lock, and nothing of the face or the clothes;
 *   - the base behind the swinging edges is erased (background) or filled (skin, cloth);
 *   - one physics group per strand, quicker for short bangs than for long locks;
 *   - the pendulum (hana's ribbon) turns about its pivot and the base behind it is filled; the
 *     jiggle (the bow) wobbles the root lattice locally; the cut-out (the hairpin flower) moves
 *     rigidly with the head; a cut-out on the body with a contact point bends toward the head;
 *   - the rest pose is still the illustration, no folds, deterministic.
 */
import { describe, expect, it } from 'vitest';
import { formatModelJson } from '../../core/format.js';
import { Rig, buildRenderList } from '../../core/rig.js';
import type { ImageRGBA, Model } from '../../core/types.js';
import { validateModel } from '../../core/validate.js';
import { renderImage } from '../../render/index.js';
import { hanaIllustration } from '../../../test/fixtures/avatar-hana.js';
import { AVATAR_Z } from '../builder.js';
import { compileModel } from '../compile.js';
import { ATTACHMENT_TUNING } from '../features/attachments.js';
import { HAIR_BROWS_LAYER, HAIR_LAYER, HAIR_MASK_LAYER, HAIR_WARP, strandDynamics, strandShape } from '../features/hair.js';
import { AVATAR_FEATURES } from '../features/index.js';
import { avatarMetrics } from '../fields.js';
import { findFolds } from '../folds.js';
import { rgbToLab } from '../image/color.js';
import { ellipseMask, strokeMask } from '../image/raster.js';
import { buildLayers } from '../layers.js';
import { parseAvatarSpec } from '../spec.js';
import type { AvatarAttachment, AvatarSpec, BuildLayersResult, LayersMeta } from '../types.js';
import { testImage, validDoc } from './fixtures.js';

const FEATURES = AVATAR_FEATURES.filter((f) => ['head', 'body', 'hair', 'attachments', 'animations'].includes(f.id));

const hana = hanaIllustration(0.5);
const spec = parseAvatarSpec(hana.doc).spec as AvatarSpec;
const metrics = avatarMetrics(spec);
const layers = buildLayers(spec, hana.image, undefined, FEATURES);
const compiled = compileModel(spec, layers.meta, FEATURES);
const validation = validateModel(compiled.doc);
const model = validation.model as Model;
const rig = new Rig(model);
const textures = Object.fromEntries(layers.meta.layers.map((l) => [l.id, layers.images[l.file]]));
const W = hana.width;
const H = hana.height;

function render(params: Record<string, number> = {}): ImageRGBA {
  return renderImage(buildRenderList(rig, rig.pose({ params, physics: false })), textures, { supersample: 1 });
}

/** Largest channel difference per pixel (colour only where b is visible). */
function deltas(a: ImageRGBA, b: ImageRGBA): Uint8Array {
  const out = new Uint8Array(a.width * a.height);
  for (let i = 0, k = 0; i < a.data.length; i += 4, k++) {
    let d = Math.abs(a.data[i + 3] - b.data[i + 3]);
    if (b.data[i + 3] >= 16) d = Math.max(d, Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
    out[k] = d;
  }
  return out;
}

/** A layer image's value at a source pixel (0 outside its rect). */
function layerAt(meta: LayersMeta, images: BuildLayersResult['images'], id: string, x: number, y: number, channel = 3): number {
  const info = meta.layers.find((l) => l.id === id)!;
  const lx = Math.floor(x) - info.rect[0];
  const ly = Math.floor(y) - info.rect[1];
  if (lx < 0 || ly < 0 || lx >= info.rect[2] || ly >= info.rect[3]) return 0;
  return images[info.file].data[(ly * info.rect[2] + lx) * 4 + channel];
}

const base = layers.images['textures/base.png'];
const lab = (img: ImageRGBA, i: number) => rgbToLab(img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]);
const deltaE = (p: number[], q: number[]) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);

describe('hair mask and layer', () => {
  it('builds the layers it promises, without warnings', () => {
    expect(layers.meta.layers.map((l) => l.id)).toEqual(['base', HAIR_LAYER, HAIR_MASK_LAYER, HAIR_BROWS_LAYER, 'att_flower', 'att_ribbon']);
    expect(layers.report.issues.filter((i) => i.severity === 'warning')).toEqual([]);
    expect(layers.report.stats.hairCoverage).toBeGreaterThan(0.35);
    expect(layers.report.stats.hairCoverage).toBeLessThan(0.8);
    expect(layers.report.stats.hairErased).toBeGreaterThan(0);
    expect(layers.report.stats.hairFilled).toBeGreaterThan(0);
  });

  it('covers the hair-coloured pixels and not the face', () => {
    // hana's hair is a gradient between these colours (examples/hana: hairFront, hairSide, hairBack).
    const hairTones = ['#86607f', '#5d3c58', '#3f2640'].map((hex) => rgbToLab(parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)));
    const head = ellipseMask(W, H, spec.head.center[0], spec.head.center[1], spec.head.radius[0], spec.head.radius[1]);
    const brows = strokeMask(W, H, [...spec.face.brows!.imageLeft], 4);
    const brows2 = strokeMask(W, H, [...spec.face.brows!.imageRight], 4);
    let hairLike = 0;
    let masked = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (head.data[i] < 0.5 || brows.data[i] > 0 || brows2.data[i] > 0 || hana.image.data[i * 4 + 3] < 255) continue;
        const c = lab(hana.image, i);
        if (Math.min(...hairTones.map((t) => deltaE(c, t))) > 6) continue;
        hairLike++;
        if (layerAt(layers.meta, layers.images, HAIR_MASK_LAYER, x, y, 0) >= 128) masked++;
      }
    }
    expect(hairLike).toBeGreaterThan(3000);
    expect(masked / hairLike).toBeGreaterThan(0.95);
    // The lower face (around the nose and the mouth) has no hair at all.
    const face = spec.face;
    let facePixels = 0;
    let faceMasked = 0;
    const lower = ellipseMask(W, H, face.nose[0], face.nose[1] + face.radius[1] * 0.15, face.radius[0] * 0.55, face.radius[1] * 0.45);
    for (let i = 0; i < W * H; i++) {
      if (lower.data[i] < 0.5) continue;
      facePixels++;
      if (layerAt(layers.meta, layers.images, HAIR_MASK_LAYER, i % W, Math.floor(i / W), 0) > 0) faceMasked++;
    }
    expect(facePixels).toBeGreaterThan(500);
    expect(faceMasked).toBe(0);
  });

  it('warns when a strand is not on hair, and when no hair is found at all', () => {
    const hairOnly = AVATAR_FEATURES.filter((f) => ['head', 'body', 'hair'].includes(f.id));
    const build = (mutate: (doc: any) => void) => {
      const doc = hanaIllustration(0.5).doc;
      mutate(doc);
      return buildLayers(parseAvatarSpec(doc).spec!, hana.image, undefined, hairOnly).report.issues.map((i) => [i.code, i.path]);
    };
    // A strand drawn across the cheek: it is reported, the others still build the mask.
    const [nx, ny] = spec.face.nose;
    const offCheek = build((doc) => void (doc.hair.strands[0].nodes = [nx - 30, ny - 4, nx - 20, ny, nx - 10, ny + 4]));
    expect(offCheek).toEqual([['avatar-hair-strand-off', '/hair/strands/0/nodes']]);
    // Every strand on the transparent background: no hair, no layer.
    const nowhere = build((doc) => void (doc.hair.strands = [{ id: 'lost', nodes: [4, 4, 6, 40], width: 6 }]));
    expect(nowhere).toEqual([['avatar-hair-mask-empty', '/hair/strands']]);
  });

  it('is drawn over the base in a warp nested in the root lattice, with the brows above it', () => {
    expect(validation.diagnostics.filter((d) => d.severity !== 'info')).toEqual([]);
    expect(model.warps.find((w) => w.id === HAIR_WARP)).toMatchObject({ parent: 'avatarWarp' });
    const hair = model.parts.find((p) => p.id === HAIR_LAYER)!;
    expect(hair).toMatchObject({ parent: HAIR_WARP, z: AVATAR_Z.hair });
    expect(model.parts.find((p) => p.id === HAIR_BROWS_LAYER)).toMatchObject({ parent: 'avatarWarp', z: AVATAR_Z.hair + 2 });
  });
});

describe('hair sway', () => {
  const rest = render();

  it('sways the lock of one strand and nothing of the face or the clothes', () => {
    for (const id of ['bang3', 'sideL']) {
      const strand = spec.hair!.strands.find((s) => s.id === id)!;
      const shape = strandShape(strand);
      const moved = deltas(render({ [`Hair_${id}`]: 1 }), rest);
      const reach = strand.swing + metrics.cell.head * 2;
      let inside = 0;
      let outside = 0;
      for (let i = 0; i < moved.length; i++) {
        if (moved[i] <= 8) continue;
        const x = i % W;
        const y = Math.floor(i / W);
        const near = x >= shape.bounds[0] - reach && x <= shape.bounds[2] + reach && y >= shape.bounds[1] - reach && y <= shape.bounds[3] + reach;
        if (near) inside++;
        else outside++;
      }
      expect(inside, id).toBeGreaterThan(40);
      expect(outside, id).toBe(0);
    }
    // The face and the chest never change, whatever the hair does.
    const all = Object.fromEntries(spec.hair!.strands.map((s) => [`Hair_${s.id}`, 1]));
    const allMoved = deltas(render(all), rest);
    const face = ellipseMask(W, H, spec.face.nose[0], spec.face.nose[1], spec.face.radius[0] * 0.5, spec.face.radius[1] * 0.4);
    const chest = ellipseMask(W, H, spec.body.chest.center[0], spec.body.chest.center[1], spec.body.chest.radius[0] * 0.5, spec.body.chest.radius[1] * 0.5);
    for (let i = 0; i < allMoved.length; i++) if (face.data[i] >= 0.5 || chest.data[i] >= 0.5) expect(allMoved[i]).toBeLessThanOrEqual(2);
  });

  it('moves the tip of a lock by its swing, perpendicular to the strand, and the root not at all', () => {
    const strand = spec.hair!.strands.find((s) => s.id === 'sideL')!;
    const shape = strandShape(strand);
    const at = (s: number, p: readonly number[]) => rig.mapPoint(rig.pose({ params: { Hair_sideL: s }, physics: false }), HAIR_WARP, p[0], p[1]);
    const tip = at(1, shape.tip);
    // +1 moves a hanging lock to the screen right; -1 mirrors it.
    expect(tip[0] - shape.tip[0]).toBeGreaterThan(strand.swing * 0.8);
    expect(tip[0] - shape.tip[0]).toBeLessThan(strand.swing * 1.1);
    expect(at(-1, shape.tip)[0] - shape.tip[0]).toBeCloseTo(-(tip[0] - shape.tip[0]), 1);
    const root = at(1, shape.root);
    expect(Math.hypot(root[0] - shape.root[0], root[1] - shape.root[1])).toBeLessThan(0.1 * strand.swing);
  });

  it('leaves no copy of a swinging edge in the base: erased over the background', () => {
    // backL hangs at the outer left edge of the hair, against the transparent background.
    const strand = spec.hair!.strands.find((s) => s.id === 'backL')!;
    const y = Math.round(strand.nodes[3]);
    let edge = -1;
    for (let x = 0; x < W; x++) if (hana.image.data[(y * W + x) * 4 + 3] > 0) { edge = x; break; }
    expect(edge).toBeGreaterThan(0);
    for (let x = edge; x < edge + 3; x++) expect(base.data[(y * W + x) * 4 + 3], `x=${x}`).toBe(0);
    // ... while the hair layer keeps the silhouette.
    expect(layerAt(layers.meta, layers.images, HAIR_LAYER, edge + 2, y)).toBeGreaterThan(200);
  });

  it('drives every strand by its own physics group, quick for short bangs and slow for long locks', () => {
    const groups = model.physics.filter((g) => g.id.startsWith('hairPhysics_'));
    expect(groups.map((g) => g.outputs[0].param)).toEqual(spec.hair!.strands.map((s) => `Hair_${s.id}`));
    for (const g of groups) {
      expect(g.inputs.map((i) => i.param)).toEqual(expect.arrayContaining(['AngleX', 'AngleZ', 'BodyAngleX']));
      expect(g.segments).toHaveLength(1);
    }
    const omega = (id: string) => {
      const g = groups.find((p) => p.id === `hairPhysics_${id}`)!;
      return Math.sqrt(g.gravity / g.segments[0].length + g.stiffness);
    };
    // A bang is short and stiff, a side lock long and loose.
    expect(omega('bang4')).toBeGreaterThan(omega('sideL') * 1.2);
    // For the same stiffness a longer lock is slower.
    const sideL = spec.hair!.strands.find((s) => s.id === 'sideL')!;
    const longer = { ...sideL, nodes: sideL.nodes.map((v, k) => (k % 2 ? sideL.nodes[1] + (v - sideL.nodes[1]) * 2 : v)) };
    expect(strandDynamics(spec, longer, strandShape(longer)).frequency).toBeLessThan(strandDynamics(spec, sideL, strandShape(sideL)).frequency);
  });
});

describe('attachments', () => {
  const ribbon = spec.attachments!.find((a) => a.id === 'ribbon') as Extract<AvatarAttachment, { kind: 'pendulum' }>;
  const flower = spec.attachments!.find((a) => a.id === 'flower') as { kind: 'cutout'; outline: number[] };
  const bow = spec.attachments!.find((a) => a.id === 'bow') as { kind: 'jiggle'; center: [number, number]; radius: [number, number]; swing: number };

  it('swings the pendulum along an arc about its pivot', () => {
    const p = ribbon.pivot;
    const tip = ribbon.tip;
    const length = Math.hypot(tip[0] - p[0], tip[1] - p[1]);
    const rest0 = rig.mapPoint(rig.pose({ physics: false }), 'att_ribbonWarp', tip[0], tip[1]);
    expect(Math.hypot(rest0[0] - tip[0], rest0[1] - tip[1])).toBeLessThan(1e-3);
    for (const s of [-1, -0.5, 0.5, 1]) {
      const q = rig.mapPoint(rig.pose({ params: { Sway_ribbon: s }, physics: false }), 'att_ribbonWarp', tip[0], tip[1]);
      expect(Math.hypot(q[0] - p[0], q[1] - p[1])).toBeCloseTo(length, 0);
      // Clockwise for s > 0: the tip of a hanging pendulum goes to the screen left.
      const angle = (Math.atan2(q[1] - p[1], q[0] - p[0]) - Math.atan2(tip[1] - p[1], tip[0] - p[0])) * (180 / Math.PI);
      expect(angle).toBeCloseTo(s * ribbon.swing, 0);
    }
    expect(model.physics.find((g) => g.id === 'att_ribbon')!.outputs[0]).toMatchObject({ param: 'Sway_ribbon', type: 'angle' });
  });

  it('fills the base behind the pendulum and the cut-out', () => {
    const red = rgbToLab(0xb0, 0x30, 0x4a);
    for (const id of ['att_ribbon', 'att_flower']) {
      const info = layers.meta.layers.find((l) => l.id === id)!;
      let solid = 0;
      let object = 0;
      let stillThere = 0;
      for (let y = info.rect[1]; y < info.rect[1] + info.rect[3]; y++) {
        for (let x = info.rect[0]; x < info.rect[0] + info.rect[2]; x++) {
          if (layerAt(layers.meta, layers.images, id, x, y) < 255) continue;
          solid++;
          const i = y * W + x;
          const c = lab(base, i);
          const s = lab(hana.image, i);
          // Only the object's own pixels (the outline also takes a rim of what is around it):
          // the red tails of the ribbon, the light petals of the flower over dark hair.
          if (id === 'att_ribbon' ? deltaE(s, red) > 30 : s[0] < 60) continue;
          object++;
          // Behind the object the base shows what was around it, not the object.
          if (deltaE(c, s) < 8) stillThere++;
        }
      }
      expect(solid, id).toBeGreaterThan(30);
      expect(object, id).toBeGreaterThan(20);
      expect(stillThere / object, id).toBeLessThan(0.05);
    }
  });

  it('keeps the cut-out on the head rigid while the head turns and tilts', () => {
    const pts: Array<[number, number]> = [];
    for (let i = 0; i + 1 < flower.outline.length; i += 4) pts.push([flower.outline[i], flower.outline[i + 1]]);
    const pose = rig.pose({ params: { AngleX: 30, AngleZ: 30, AngleY: -30 }, physics: false });
    const moved = pts.map(([x, y]) => rig.mapPoint(pose, 'att_flowerWarp', x, y));
    for (let a = 0; a < pts.length; a++) {
      for (let b = a + 1; b < pts.length; b++) {
        const before = Math.hypot(pts[a][0] - pts[b][0], pts[a][1] - pts[b][1]);
        const after = Math.hypot(moved[a][0] - moved[b][0], moved[a][1] - moved[b][1]);
        expect(Math.abs(after - before)).toBeLessThan(0.3);
      }
    }
    // ... and it moves with the head: its centre goes where the root lattice takes it.
    const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    const onRoot = rig.mapPoint(pose, 'avatarWarp', cx, cy);
    const onFlower = rig.mapPoint(pose, 'att_flowerWarp', cx, cy);
    expect(Math.hypot(onRoot[0] - cx, onRoot[1] - cy)).toBeGreaterThan(5);
    expect(Math.hypot(onRoot[0] - onFlower[0], onRoot[1] - onFlower[1])).toBeLessThan(1);
    expect(model.parts.find((p) => p.id === 'att_flower')!.z).toBeGreaterThanOrEqual(AVATAR_Z.cutouts);
  });

  it('wobbles the jiggle softly on the root lattice', () => {
    const pose = rig.pose({ params: { Sway_bow: 1 }, physics: false });
    const centre = rig.mapPoint(pose, 'avatarWarp', bow.center[0], bow.center[1]);
    expect(centre[0] - bow.center[0]).toBeCloseTo(bow.swing, 1);
    const far = [bow.center[0], bow.center[1] - bow.radius[1] * 3];
    const still = rig.mapPoint(pose, 'avatarWarp', far[0], far[1]);
    expect(Math.hypot(still[0] - far[0], still[1] - far[1])).toBeLessThan(1e-3);
    expect(model.physics.find((g) => g.id === 'att_bow')!.inputs.map((i) => i.param)).toEqual(['BodyAngleX']);
  });

  it('bends a cut-out on the body toward the head at its contact point only', () => {
    const doc = validDoc();
    const s = parseAvatarSpec(doc).spec!;
    const features = AVATAR_FEATURES.filter((f) => ['head', 'body', 'attachments'].includes(f.id));
    const built = buildLayers(s, testImage(), undefined, features);
    const c = compileModel(s, built.meta, features);
    const v = validateModel(c.doc);
    expect(v.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const r = new Rig(v.model!);
    const pose = r.pose({ params: { AngleX: 30, AngleZ: 30 }, physics: false });
    // The contact (180, 285) touches the top of the hand (y = 300): measure just inside it.
    const contact = s.attachments!.find((a) => a.kind === 'cutout')!.contact!;
    const head = r.mapPoint(pose, 'avatarWarp', contact[0], contact[1]);
    const headMove = Math.hypot(head[0] - contact[0], head[1] - contact[1]);
    expect(headMove).toBeGreaterThan(3);
    const tipAt: [number, number] = [contact[0], 303];
    const tip = r.mapPoint(pose, 'att_handWarp', tipAt[0], tipAt[1]);
    const tipMove = Math.hypot(tip[0] - tipAt[0], tip[1] - tipAt[1]);
    expect(tipMove).toBeGreaterThan(0.6 * ATTACHMENT_TUNING.contactShare * headMove);
    expect(tipMove).toBeLessThan(1.15 * ATTACHMENT_TUNING.contactShare * headMove);
    // ... in the direction the head moves there.
    expect((tip[0] - tipAt[0]) * (head[0] - contact[0]) + (tip[1] - tipAt[1]) * (head[1] - contact[1])).toBeGreaterThan(0);
    // The far end of the hand stays with the body, which does not move here.
    const far = r.mapPoint(pose, 'att_handWarp', 165, 415);
    expect(Math.hypot(far[0] - 165, far[1] - 415)).toBeLessThan(0.3);
    // The body sway carries the whole hand rigidly.
    const swayed = r.pose({ params: { BodyAngleX: 10 }, physics: false });
    const a = r.mapPoint(swayed, 'att_handWarp', 150, 310);
    const b = r.mapPoint(swayed, 'att_handWarp', 185, 410);
    expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeCloseTo(Math.hypot(150 - 185, 310 - 410), 1);
    expect(findFolds(v.model!, c.folds)).toEqual([]);
  });

  it('copes with layers built without these features', () => {
    const skeleton = AVATAR_FEATURES.filter((f) => f.id === 'head' || f.id === 'body');
    const bare = buildLayers(spec, hana.image, undefined, skeleton).meta;
    const c = compileModel(spec, bare, FEATURES);
    expect(c.report.issues.map((i) => i.code).sort()).toEqual(['avatar-attachment-layer-missing', 'avatar-attachment-layer-missing', 'avatar-hair-layer-missing']);
    expect(validateModel(c.doc).diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });
});

describe('the whole of it', () => {
  it('keeps the rest pose = the illustration, has no folds, and is deterministic', () => {
    const d = deltas(render(), hana.image);
    expect(d.filter((v) => v > 2).length / d.length).toBeLessThan(0.002);
    expect(d.reduce((m, v) => Math.max(m, v), 0)).toBeLessThanOrEqual(8);
    expect(findFolds(model, compiled.folds)).toEqual([]);
    const again = buildLayers(spec, hana.image, layers.meta, FEATURES);
    expect(JSON.stringify(again.meta)).toBe(JSON.stringify(layers.meta));
    for (const [file, image] of Object.entries(layers.images)) expect(Buffer.compare(Buffer.from(again.images[file].data), Buffer.from(image.data)), file).toBe(0);
    expect(formatModelJson(compileModel(spec, again.meta, FEATURES).doc)).toBe(formatModelJson(compiled.doc));
  });
});
