/**
 * The avatar build end to end on the repository's own test illustration (test/fixtures/avatar-hana.ts:
 * a render of examples/hana and a spec derived from its geometry), at a reduced size:
 *
 *   - the fixture itself is a complete, valid spec for its image;
 *   - the quality bar of src/avatar/DESIGN.md §4 for the SKELETON (the head and body features alone):
 *     the rest pose IS the illustration, the head turn / tilt, body sway and breath move what they
 *     should and nothing else, no mesh folds at the parameter extremes, byte-identical rebuilds;
 *   - the FULL pipeline (every feature that is implemented) is held to what must stay true whatever
 *     the features add: a valid model, no folds, a rest pose that still is the illustration;
 *   - the project build and the review sheets on disk (src/node/avatar.ts) and their CLI commands.
 *
 * Tests of a feature (eyes, mouth, hair, ...) live in that feature's own test file; nothing here
 * depends on which features exist.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/cli/main.js';
import { formatModelJson } from '../src/core/format.js';
import { Rig, buildRenderList } from '../src/core/rig.js';
import type { ImageRGBA, Model } from '../src/core/types.js';
import { validateModel } from '../src/core/validate.js';
import { compileModel } from '../src/avatar/compile.js';
import { AVATAR_FEATURES } from '../src/avatar/features/index.js';
import { avatarMetrics } from '../src/avatar/fields.js';
import { findFolds, FOLD_CODE } from '../src/avatar/folds.js';
import { layerInputsHash } from '../src/avatar/hash.js';
import { avatarOverlay, buildAvatarLayers, compileAvatar, parseAvatarSpec, type AvatarSpec } from '../src/avatar/index.js';
import { buildLayers } from '../src/avatar/layers.js';
import { AvatarProjectError, buildAvatarProject, loadAvatarProject, reviewAvatarProject } from '../src/node/avatar.js';
import { loadModelFile } from '../src/node/load.js';
import { decodePNG, encodePNG, renderImage } from '../src/render/index.js';
import { hanaIllustration } from './fixtures/avatar-hana.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'rev2d-avatar-build-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** The fixture at half size (256 x 320): large enough for every landmark, small enough to be fast. */
const SCALE = 0.5;
const hana = hanaIllustration(SCALE);
const parsed = parseAvatarSpec(hana.doc, { imageSize: { width: hana.width, height: hana.height } });
const spec = parsed.spec as AvatarSpec;
/** The skeleton: head turn / tilt and body sway / breath on the one base mesh. */
const SKELETON = AVATAR_FEATURES.filter((f) => f.id === 'head' || f.id === 'body');
const layers = buildLayers(spec, hana.image, undefined, SKELETON);
const compiled = compileModel(spec, layers.meta, SKELETON);
const validation = validateModel(compiled.doc);
const model = validation.model as Model;
const rig = new Rig(model);
const metrics = avatarMetrics(spec);

/** Where the rest point (x, y) of the illustration is in a pose. */
function moved(params: Record<string, number>, x: number, y: number): [number, number] {
  return rig.mapPoint(rig.pose({ params, physics: false }), 'avatarWarp', x, y);
}

function render(params: Record<string, number> = {}): ImageRGBA {
  const pose = rig.pose({ params, physics: false });
  // One sample per pixel at scale 1 reads every texel at its centre: the mesh is the only variable.
  return renderImage(buildRenderList(rig, pose), { base: layers.images['textures/base.png'] }, { supersample: 1 });
}

/** Largest channel difference per pixel; the colour of an almost transparent pixel carries no information. */
function pixelDeltas(a: ImageRGBA, b: ImageRGBA): Uint8Array {
  const out = new Uint8Array(a.width * a.height);
  for (let i = 0, k = 0; i < a.data.length; i += 4, k++) {
    let d = Math.abs(a.data[i + 3] - b.data[i + 3]);
    if (b.data[i + 3] >= 16) d = Math.max(d, Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
    out[k] = d;
  }
  return out;
}

/** A project folder with the fixture's avatar.json and source.png. */
function project(name: string, mutate: (doc: Record<string, any>) => void = () => {}): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  const doc = hanaIllustration(SCALE).doc;
  mutate(doc);
  writeFileSync(path.join(dir, 'avatar.json'), formatModelJson(doc));
  writeFileSync(path.join(dir, 'source.png'), encodePNG(hana.image));
  return dir;
}

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string; json(): any }> {
  const buf = { stdout: '', stderr: '' };
  const code = await main(args, { stdout: { write: (s: string) => ((buf.stdout += s), true) }, stderr: { write: (s: string) => ((buf.stderr += s), true) }, cwd: root });
  return { code, ...buf, json: () => JSON.parse(buf.stdout) };
}

describe('hana fixture', () => {
  it('is a transparent-background picture with a complete spec that validates cleanly at every size', () => {
    expect([hana.width, hana.height, hana.image.width, hana.image.height]).toEqual([256, 320, 256, 320]);
    expect(hana.image.data[3]).toBe(0);
    const opaque = hana.image.data.filter((_, i) => i % 4 === 3 && hana.image.data[i] === 255).length;
    expect(opaque / (256 * 320)).toBeGreaterThan(0.4);
    expect(parsed.diagnostics).toEqual([]);
    const full = hanaIllustration(1);
    expect(parseAvatarSpec(full.doc, { imageSize: { width: 512, height: 640 } }).diagnostics).toEqual([]);
    // A fresh document every call; the picture is cached.
    expect(hanaIllustration(1).doc).not.toBe(full.doc);
    expect(hanaIllustration(1).image).toBe(full.image);
    expect(() => hanaIllustration(0.3)).toThrow(/whole image size/);
  });

  it('has its landmarks where hana has the features', () => {
    const doc = hanaIllustration(1).doc;
    const near = (p: number[], x: number, y: number, tolerance: number) => Math.hypot(p[0] - x, p[1] - y) <= tolerance;
    // Numbers from scripts/examples/hana.ts (512 x 640).
    expect(near(doc.face.chin, 256, 352, 2)).toBe(true);
    expect(near(doc.face.nose, 257, 300, 3)).toBe(true);
    expect(near(doc.face.mouth.imageLeft, 244, 322, 1)).toBe(true);
    expect(near(doc.face.mouth.imageRight, 268, 322, 1)).toBe(true);
    expect(near(doc.face.eyes.imageLeft.iris.center, 210, 263, 0.01)).toBe(true);
    expect(near(doc.face.eyes.imageRight.iris.center, 302, 263, 0.01)).toBe(true);
    // The opening starts at the outer corner and runs over the top (smaller y) first.
    const opening = doc.face.eyes.imageLeft.opening;
    expect(near(opening, 181, 267, 0.5)).toBe(true);
    expect(opening.length).toBe(36);
    expect(opening[2 * 4 + 1]).toBeLessThan(250);
    expect(near(doc.face.cheeks.imageLeft, 198, 300, 1)).toBe(true);
    expect(doc.face.ears.imageLeft[0]).toBeLessThan(170);
    expect(doc.face.brows.imageLeft).toHaveLength(8);
    // Seven bangs, two side locks, two back strands; one attachment of each kind.
    expect(doc.hair.strands.map((s: any) => s.id)).toEqual(['bang1', 'bang2', 'bang3', 'bang4', 'bang5', 'bang6', 'bang7', 'sideL', 'sideR', 'backL', 'backR']);
    expect(doc.attachments.map((a: any) => [a.id, a.kind, a.follow])).toEqual([['flower', 'cutout', 'head'], ['bow', 'jiggle', 'body'], ['ribbon', 'pendulum', 'body']]);
    // The flower's outline surrounds the hairpin (334, 168); the bow sits on the knot of the ribbon.
    const flowerBox = [0, 1].map((k) => doc.attachments[0].outline.filter((_: number, i: number) => i % 2 === k)).map((v: number[]) => [Math.min(...v), Math.max(...v)]);
    expect(flowerBox[0][0] < 318 && flowerBox[0][1] > 350 && flowerBox[1][0] < 152 && flowerBox[1][1] > 184).toBe(true);
    expect(near(doc.attachments[1].center, 256, 462, 4)).toBe(true);
    expect(doc.head.neck[0]).toBeGreaterThan(doc.face.chin[1]);
    expect(doc.head.pivot[1]).toBeGreaterThan(doc.head.neck[0]);
    expect(doc.body.pivot[1]).toBeGreaterThan(640);
    // Lengths scale with the picture, angles and factors do not.
    expect(hana.doc.face.chin[1]).toBeCloseTo(doc.face.chin[1] / 2, 1);
    expect(hana.doc.hair.strands[0].width).toBe(doc.hair.strands[0].width / 2);
    // A pendulum swings by an angle, a jiggle by pixels.
    expect(hana.doc.attachments[2].swing).toBe(doc.attachments[2].swing);
    expect(hana.doc.attachments[1].swing).toBe(doc.attachments[1].swing / 2);
    expect(hana.doc.body.sway).toBe(2);
    // The overlay tool draws every landmark of it.
    expect(avatarOverlay(hana.image, hana.doc).missing).toEqual([]);
  });
});

describe('the full pipeline on hana (every implemented feature)', () => {
  const fullLayers = buildAvatarLayers(spec, hana.image);
  const full = compileAvatar(spec, fullLayers.meta);
  const fullValidation = validateModel(full.doc);

  it('builds a valid model: no errors, no warnings, no folds', () => {
    expect(fullValidation.diagnostics.filter((d) => d.severity !== 'info')).toEqual([]);
    expect(fullLayers.report.issues.filter((i) => i.severity === 'warning')).toEqual([]);
    expect(full.report.issues.filter((i) => i.severity === 'warning')).toEqual([]);
    expect(findFolds(fullValidation.model!, full.folds)).toEqual([]);
    // Every texture of the model is a layer image of the build.
    for (const texture of fullValidation.model!.textures) expect(Object.keys(fullLayers.images)).toContain(texture.path);
  });

  it('rest pose = the illustration (outside the feathered seams of cut layers)', () => {
    const fullRig = new Rig(fullValidation.model!);
    const textures = Object.fromEntries(fullLayers.meta.layers.map((l) => [l.id, fullLayers.images[l.file]]));
    const image = renderImage(buildRenderList(fullRig, fullRig.pose({ physics: false })), textures, { supersample: 1 });
    const deltas = pixelDeltas(image, hana.image);
    const off = deltas.filter((d) => d > 2).length;
    // Seams of cut layers may differ by a few steps on a thin line; anything more is a visible change.
    expect(off / deltas.length).toBeLessThan(0.01);
    expect(deltas.reduce((m, d) => Math.max(m, d), 0)).toBeLessThanOrEqual(24);
  });

  it('rest pose at full size (1024 x 1280) = the illustration as the renderer draws it, layer seams included', () => {
    // The default render (2 x 2 samples per pixel, bilinear texels) blends every pixel with its
    // neighbours, so two layers that end on the same pixel edge (a cut stroke split between layers, a
    // hard edge drawn by a layer and by the base under it) show a light or dark seam that one sample
    // per pixel cannot see. The reference is the illustration drawn by the same renderer as one image.
    const big = hanaIllustration(2);
    const bigSpec = parseAvatarSpec(big.doc, { imageSize: { width: big.width, height: big.height } }).spec as AvatarSpec;
    const built = buildAvatarLayers(bigSpec, big.image);
    const bigModel = validateModel(compileAvatar(bigSpec, built.meta).doc).model!;
    const bigRig = new Rig(bigModel);
    const textures = Object.fromEntries(built.meta.layers.map((l) => [l.id, built.images[l.file]]));
    const image = renderImage(buildRenderList(bigRig, bigRig.pose({ physics: false })), textures);
    const single = validateModel({
      format: 'rev2d',
      version: 1,
      meta: { name: 'reference', width: big.width, height: big.height },
      textures: [{ id: 'illustration', path: 'illustration.png' }],
      parts: [{ id: 'illustration', shape: { type: 'image', texture: 'illustration', x: 0, y: 0, w: big.width, h: big.height, cols: 1, rows: 1 } }],
    }).model!;
    const singleRig = new Rig(single);
    const reference = renderImage(buildRenderList(singleRig, singleRig.pose({})), { illustration: big.image });
    // Premultiplied colour and alpha, so the colour of a transparent pixel carries no weight.
    let over8 = 0;
    let over24 = 0;
    for (let i = 0; i < image.data.length; i += 4) {
      const a = image.data[i + 3] / 255;
      const b = reference.data[i + 3] / 255;
      let d = Math.abs(image.data[i + 3] - reference.data[i + 3]);
      for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(image.data[i + c] * a - reference.data[i + c] * b));
      if (d > 8) over8++;
      if (d > 24) over24++;
    }
    // What remains: single pixels where a stroke of the picture has a hard (unantialiased) edge on a
    // layer boundary (a bang tip ending on the eye's lid, the hair's silhouette), at most ~23 levels.
    expect(over24).toBeLessThanOrEqual(4);
    expect(over8 / (big.width * big.height)).toBeLessThan(0.0003);
  }, 120_000);

  it('is deterministic', () => {
    const again = buildAvatarLayers(spec, hana.image, fullLayers.meta);
    expect(JSON.stringify(again.meta)).toBe(JSON.stringify(fullLayers.meta));
    for (const [file, image] of Object.entries(fullLayers.images)) expect(Buffer.compare(Buffer.from(again.images[file].data), Buffer.from(image.data))).toBe(0);
    expect(formatModelJson(compileAvatar(spec, again.meta).doc)).toBe(formatModelJson(full.doc));
  });
});

describe('layers and model of the hana skeleton', () => {
  it('keeps the illustration as the base layer and records the inputs hash', () => {
    expect(Object.keys(layers.images)).toEqual(['textures/base.png']);
    expect(layers.meta.layers[0]).toEqual({ id: 'base', file: 'textures/base.png', rect: [0, 0, 256, 320] });
    expect(layers.meta.inputsHash).toBe(layerInputsHash(spec));
    expect(layers.meta.image).toEqual({ width: 256, height: 320 });
  });

  it('validates with no errors and no warnings', () => {
    expect(validation.diagnostics.filter((d) => d.severity !== 'info')).toEqual([]);
    expect(compiled.report.issues.filter((i) => i.severity === 'warning')).toEqual([]);
    expect(model.parameters.map((p) => p.id)).toEqual(['AngleX', 'AngleY', 'AngleZ', 'BodyAngleX', 'Breath']);
    expect(model.warps[0]).toMatchObject({ id: 'avatarWarp', rect: [0, 0, 256, 320], cols: 40, rows: 50 });
  });

  it('rest pose = the illustration, pixel for pixel', () => {
    const image = render();
    expect([image.width, image.height]).toEqual([256, 320]);
    expect(pixelDeltas(image, hana.image).reduce((m, d) => Math.max(m, d), 0)).toBeLessThanOrEqual(2);
  });

  it('builds byte-identical layers and models from the same inputs', () => {
    const again = buildLayers(spec, hana.image, undefined, SKELETON);
    expect(JSON.stringify(again.meta)).toBe(JSON.stringify(layers.meta));
    for (const [file, image] of Object.entries(layers.images)) expect(Buffer.compare(Buffer.from(encodePNG(again.images[file])), Buffer.from(encodePNG(image)))).toBe(0);
    expect(formatModelJson(compileModel(spec, again.meta, SKELETON).doc)).toBe(formatModelJson(compiled.doc));
    // The fixture spec round-trips through its file form.
    const reread = parseAvatarSpec(formatModelJson(hana.doc)).spec!;
    expect(formatModelJson(compileModel(reread, layers.meta, SKELETON).doc)).toBe(formatModelJson(compiled.doc));
  });
});

describe('head turn (AngleX x AngleY)', () => {
  const { face, head } = spec;
  const nose = face.nose;
  const ears = [face.ears!.imageLeft!, face.ears!.imageRight!];

  it('moves the face centre by head.turn: + AngleX toward the screen right, + AngleY up', () => {
    const [cx, cy] = face.center;
    const right = moved({ AngleX: 30 }, cx, cy);
    expect(right[0] - cx).toBeCloseTo(metrics.turn.x, 0);
    expect(Math.abs(right[1] - cy)).toBeLessThan(0.05);
    const up = moved({ AngleY: 30 }, cx, cy);
    expect(up[1] - cy).toBeCloseTo(-metrics.turn.y, 0);
    expect(moved({ AngleX: -30 }, cx, cy)[0] - cx).toBeCloseTo(-metrics.turn.x, 0);
    // Halfway there at half the parameter.
    expect(moved({ AngleX: 15 }, cx, cy)[0] - cx).toBeCloseTo(metrics.turn.x / 2, 0);
  });

  it('moves the nose farther than the ears, and the ears with it', () => {
    for (const sign of [-1, 1]) {
      const dNose = moved({ AngleX: 30 * sign }, nose[0], nose[1])[0] - nose[0];
      expect(dNose * sign).toBeGreaterThan(metrics.turn.x * 0.85);
      for (const ear of ears) {
        const dEar = moved({ AngleX: 30 * sign }, ear[0], ear[1])[0] - ear[0];
        expect(dEar * sign).toBeGreaterThan(0.2);
        expect(dEar * sign).toBeLessThan(dNose * sign * 0.6);
      }
    }
    const dNoseUp = moved({ AngleY: 30 }, nose[0], nose[1])[1] - nose[1];
    expect(dNoseUp).toBeLessThan(-metrics.turn.y * 0.8);
  });

  it('moves nothing outside the head ellipse and nothing below the neck', () => {
    const corners: Array<Record<string, number>> = [
      { AngleX: 30 },
      { AngleX: -30, AngleY: 30 },
      { AngleX: 30, AngleY: -30 },
    ];
    // The image corners, the body, and a ring around the head ellipse. The field is exactly zero
    // outside the ellipse; a mesh point moves with its lattice cell, so the ring keeps one and a half
    // cells of distance (inside the last cell the motion is below a hundredth of a pixel, see below).
    const outside: Array<[number, number]> = [[2, 2], [254, 2], [3, 318], [128, 300], [128, 250], [40, 260], [216, 260]];
    const rim: Array<[number, number]> = [];
    const clear = 1 + (1.5 * metrics.cell.body * Math.SQRT2) / Math.min(head.radius[0], head.radius[1]);
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const at = (level: number): [number, number] => [head.center[0] + Math.cos(a) * head.radius[0] * level, head.center[1] + Math.sin(a) * head.radius[1] * level];
      for (const [list, p] of [[outside, at(clear)], [rim, at(1.01)]] as const) if (p[0] > 0 && p[0] < 256 && p[1] > 0 && p[1] < 320) list.push(p);
    }
    expect(outside.length).toBeGreaterThan(10);
    expect(rim.length).toBeGreaterThan(4);
    for (const params of corners) {
      for (const [x, y] of outside) {
        const p = moved(params, x, y);
        // Exactly zero in the keyforms; the pose stores positions as 32-bit floats.
        expect(Math.hypot(p[0] - x, p[1] - y)).toBeLessThan(1e-4);
      }
      for (const [x, y] of rim) {
        const p = moved(params, x, y);
        expect(Math.hypot(p[0] - x, p[1] - y)).toBeLessThan(0.02);
      }
    }
    // The picture changes inside the head and nowhere below the neck band.
    const rest = render();
    const turned = render({ AngleX: 30, AngleY: -30 });
    let above = 0;
    let below = 0;
    const firstStill = Math.ceil(spec.head.neck[1] + metrics.cell.body);
    for (let y = 0; y < 320; y++) {
      for (let x = 0; x < 256; x++) {
        const i = (y * 256 + x) * 4;
        const delta = Math.max(Math.abs(rest.data[i] - turned.data[i]), Math.abs(rest.data[i + 1] - turned.data[i + 1]), Math.abs(rest.data[i + 2] - turned.data[i + 2]), Math.abs(rest.data[i + 3] - turned.data[i + 3]));
        if (delta > 0) y >= firstStill ? below++ : above++;
      }
    }
    expect(above).toBeGreaterThan(2000);
    expect(below).toBe(0);
  });

  it('compresses the half of the face the head turns to and stretches the other', () => {
    const [cx, cy] = face.center;
    const span = face.radius[0] * 0.6;
    const width = (params: Record<string, number>, x0: number, x1: number) => moved(params, x1, cy)[0] - moved(params, x0, cy)[0];
    expect(width({ AngleX: 30 }, cx, cx + span)).toBeLessThan(span * 0.95);
    expect(width({ AngleX: 30 }, cx - span, cx)).toBeGreaterThan(span * 1.05);
    expect(width({ AngleX: -30 }, cx - span, cx)).toBeLessThan(span * 0.95);
  });
});

describe('head tilt (AngleZ)', () => {
  const pivot = spec.head.pivot;
  const rotated = (x: number, y: number, degrees: number): [number, number] => {
    const a = (degrees * Math.PI) / 180;
    const qx = x - pivot[0];
    const qy = y - pivot[1];
    return [pivot[0] + qx * Math.cos(a) - qy * Math.sin(a), pivot[1] + qx * Math.sin(a) + qy * Math.cos(a)];
  };

  it('rotates the head about the neck pivot by head.tilt, clockwise for + AngleZ', () => {
    expect(metrics.tilt).toBe(8.5);
    // The top of the head, the face centre, an eye, the chin: everything above the neck is rigid.
    const points: Array<readonly [number, number]> = [[128, 50], spec.face.center, spec.face.nose, spec.face.chin, [90, 110], [170, 90]];
    for (const [x, y] of points) {
      for (const sign of [-1, 1]) {
        const p = moved({ AngleZ: 30 * sign }, x, y);
        const want = rotated(x, y, metrics.tilt * sign);
        expect(Math.hypot(p[0] - want[0], p[1] - want[1])).toBeLessThan(0.15);
      }
    }
    // Clockwise: the top of the head goes to the screen right.
    expect(moved({ AngleZ: 30 }, 128, 50)[0]).toBeGreaterThan(128 + 15);
    // Between the keyforms the path is a chord: half the parameter is about half the angle.
    const half = moved({ AngleZ: 15 }, 128, 50);
    const arc = rotated(128, 50, metrics.tilt / 2);
    expect(Math.hypot(half[0] - arc[0], half[1] - arc[1])).toBeLessThan(0.6);
  });

  it('leaves the lower body still and bends the neck in between', () => {
    for (const [x, y] of [[128, 215], [60, 240], [200, 300], [20, 200], [236, 200], [128, 318]]) {
      const p = moved({ AngleZ: 30 }, x, y);
      expect(Math.hypot(p[0] - x, p[1] - y)).toBeLessThan(1e-4);
    }
    // Up the neck from the pivot the motion grows steadily into the head's.
    const dx = (above: number) => moved({ AngleZ: 30 }, pivot[0], pivot[1] - above)[0] - pivot[0];
    const chin = pivot[1] - spec.face.chin[1];
    // The pivot itself stays (within what one lattice cell around it interpolates).
    expect(dx(0)).toBeLessThan(0.3);
    expect(dx(chin * 0.4)).toBeGreaterThan(dx(0) + 0.05);
    expect(dx(chin)).toBeGreaterThan(dx(chin * 0.4) + 0.05);
    expect(dx(chin)).toBeCloseTo(rotated(pivot[0], spec.face.chin[1], metrics.tilt)[0] - pivot[0], 1);
  });
});

describe('body sway (BodyAngleX) and breath', () => {
  it('leans everything above the fade band about the body pivot and anchors the bottom', () => {
    const pivot = spec.body.pivot;
    const a = (spec.body.sway * Math.PI) / 180;
    for (const [x, y] of [[128, 40], spec.face.nose, [60, 200], [200, 150]] as Array<readonly [number, number]>) {
      expect(y).toBeLessThan(spec.body.fade[0]);
      const p = moved({ BodyAngleX: 10 }, x, y);
      const qx = x - pivot[0];
      const qy = y - pivot[1];
      const want = [pivot[0] + qx * Math.cos(a) - qy * Math.sin(a), pivot[1] + qx * Math.sin(a) + qy * Math.cos(a)];
      expect(Math.hypot(p[0] - want[0], p[1] - want[1])).toBeLessThan(0.05);
      // + leans toward the screen right; - mirrors it.
      expect(p[0]).toBeGreaterThan(x + 3);
      expect(moved({ BodyAngleX: -10 }, x, y)[0]).toBeLessThan(x - 3);
    }
    for (const x of [0, 64, 128, 256]) {
      const p = moved({ BodyAngleX: 10 }, x, 320);
      expect(Math.hypot(p[0] - x, p[1] - 320)).toBeLessThan(1e-4);
    }
    // In the band the lean fades out monotonically.
    const lean = (y: number) => moved({ BodyAngleX: 10 }, 128, y)[0] - 128;
    const [y0, y1] = spec.body.fade;
    expect(lean(y0 + (y1 - y0) * 0.25)).toBeGreaterThan(lean(y0 + (y1 - y0) * 0.75));
    expect(lean(y0 + (y1 - y0) * 0.75)).toBeGreaterThan(0);
  });

  it('lifts the chest by body.breath, the head by a third, and nothing at the bottom', () => {
    const chest = spec.body.chest.center;
    const rise = (x: number, y: number) => y - moved({ Breath: 1 }, x, y)[1];
    expect(metrics.breath).toBeCloseTo(320 * 0.0035, 9);
    expect(rise(chest[0], chest[1])).toBeCloseTo(metrics.breath, 1);
    expect(rise(spec.face.nose[0], spec.face.nose[1])).toBeCloseTo(metrics.breath / 3, 1);
    expect(rise(128, 20)).toBeCloseTo(metrics.breath / 3, 1);
    // The shoulders rise more than the head, less than the chest.
    const shoulder = spec.body.shoulders![0];
    expect(rise(shoulder[0], shoulder[1])).toBeGreaterThan(metrics.breath / 3 + 0.05);
    expect(rise(shoulder[0], shoulder[1])).toBeLessThan(metrics.breath);
    expect(Math.abs(rise(128, 320))).toBeLessThan(1e-4);
    expect(rise(10, 318)).toBeLessThan(0.02);
    // Breath = 0 is the rest pose.
    expect(rise(chest[0], chest[1]) - (chest[1] - moved({ Breath: 0.5 }, chest[0], chest[1])[1])).toBeCloseTo(metrics.breath / 2, 1);
    expect(Math.abs(moved({ Breath: 0 }, chest[0], chest[1])[1] - chest[1])).toBeLessThan(1e-4);
  });
});

describe('fold check of the hana avatar', () => {
  it('finds no flipped or collapsed cell at any parameter extreme or corner', () => {
    expect(findFolds(model, compiled.folds)).toEqual([]);
    // Even far below the default threshold nothing comes close to collapsing.
    expect(findFolds(model, compiled.folds, { minRatio: 0.4 })).toEqual([]);
  });

  it('reports a spec whose amounts tear the mesh', () => {
    const doc = hanaIllustration(SCALE).doc;
    doc.head.turn = { x: 70, y: 8 };
    const wild = parseAvatarSpec(doc, { imageSize: { width: 256, height: 320 } }).spec!;
    const built = compileModel(wild, layers.meta, SKELETON);
    const findings = findFolds(validateModel(built.doc).model!, built.folds);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.kind === 'warp' && f.id === 'avatarWarp' && 'AngleX' in f.params)).toBe(true);
  });
});

describe('buildAvatarProject and reviewAvatarProject', () => {
  it('writes layers, layers.json and the model; a rebuild changes no file', async () => {
    const dir = project('build');
    const r = await buildAvatarProject(dir);
    // The same result as the two stages in memory, with every feature.
    const expected = buildAvatarLayers(spec, hana.image);
    const expectedModel = formatModelJson(compileAvatar(spec, expected.meta).doc);
    expect(r.name).toBe('hana');
    expect(r.modelFile).toBe(path.join(dir, 'hana.r2d.json'));
    expect(r.layers).toEqual(Object.keys(expected.images));
    expect(r.layers[0]).toBe('textures/base.png');
    expect(r.removed).toEqual([]);
    expect(r.postOps).toBe(0);
    expect(r.folds).toEqual([]);
    expect(r.diagnostics.filter((d) => d.severity === 'warning')).toEqual([]);
    expect(r.report.issues.filter((i) => i.severity === 'warning')).toEqual([]);
    expect(r.report.stats).toMatchObject({ layers: r.layers.length, latticeCols: 40, latticeRows: 50, foldPoses: 0 });
    expect(r.report.stats.parameters).toBeGreaterThanOrEqual(5);
    expect(Object.keys(r.timings).sort()).toEqual(['compileMs', 'foldsMs', 'layersMs', 'loadMs', 'totalMs', 'validateMs', 'writeMs']);
    const text = readFileSync(r.modelFile, 'utf8');
    expect(r.modelBytes).toBe(Buffer.byteLength(text));
    expect(text).toBe(expectedModel);
    for (const [file, image] of Object.entries(expected.images)) expect(Buffer.compare(Buffer.from(decodePNG(readFileSync(path.join(dir, file))).data), Buffer.from(image.data))).toBe(0);
    expect(JSON.parse(readFileSync(path.join(dir, 'textures/layers.json'), 'utf8'))).toEqual(JSON.parse(JSON.stringify(expected.meta)));
    // The built model is an ordinary model file: it loads with its textures.
    const loaded = await loadModelFile(r.modelFile);
    expect(loaded.diagnostics.filter((d) => d.severity !== 'info')).toEqual([]);
    expect(loaded.textureInfo.base).toEqual({ width: 256, height: 320 });
    const state = await loadAvatarProject(dir);
    expect([state.modelExists, state.layersStale]).toEqual([true, false]);

    const files = ['hana.r2d.json', 'textures/layers.json', ...r.layers];
    const before = files.map((f) => statSync(path.join(dir, f)).mtimeMs);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await buildAvatarProject(dir, { folds: false });
    expect(files.map((f) => statSync(path.join(dir, f)).mtimeMs)).toEqual(before);
  });

  it('applies the post ops of the spec after every build and removes layer images that are gone', async () => {
    const dir = project('post', (doc) => {
      doc.post = [
        { op: 'add', kind: 'parameter', value: { id: 'Mood', min: 0, max: 1 } },
        { op: 'key', animation: 'wave', target: 'param:AngleY', t: 0, v: 0, duration: 1, loop: false },
        { op: 'key', animation: 'wave', target: 'param:AngleY', t: 0.5, v: -20 },
      ];
    });
    // A layer image of an earlier build that this build does not produce.
    mkdirSync(path.join(dir, 'textures'), { recursive: true });
    writeFileSync(path.join(dir, 'textures/old.png'), encodePNG(hana.image));
    writeFileSync(path.join(dir, 'textures/keep.png'), encodePNG(hana.image));
    writeFileSync(path.join(dir, 'textures/layers.json'), JSON.stringify({ version: 1, inputsHash: 'x', image: { width: 256, height: 320 }, layers: [{ id: 'old', file: 'textures/old.png', rect: [0, 0, 256, 320] }], variants: [] }));
    const r = await buildAvatarProject(dir);
    expect(r.postOps).toBe(3);
    expect(r.removed).toEqual(['textures/old.png']);
    expect(existsSync(path.join(dir, 'textures/old.png'))).toBe(false);
    expect(existsSync(path.join(dir, 'textures/keep.png'))).toBe(true);
    const built = JSON.parse(readFileSync(r.modelFile, 'utf8'));
    expect(built.parameters.map((p: any) => p.id)).toContain('Mood');
    // Next to the generated animations (src/avatar/features/animations.ts).
    expect(built.animations.map((a: any) => a.id)).toContain('wave');
    // The op-added parameter drives nothing: the model validator says so, as information.
    expect(r.diagnostics.map((d) => d.code)).toContain('unused-parameter');
  });

  it('fails with the reasons: an unfinished spec, a failing post op, a missing project', async () => {
    const draft = project('draft', (doc) => {
      doc.face.nose = null;
      doc.head.pivot = null;
    });
    const unfinished = await buildAvatarProject(draft).catch((e) => e);
    expect(unfinished).toBeInstanceOf(AvatarProjectError);
    expect(unfinished.message).toMatch(/the avatar spec has 2 errors \(2 landmarks still to place\)/);
    expect(unfinished.hint).toContain('rev2d avatar validate');
    expect(unfinished.diagnostics).toHaveLength(2);
    expect(existsSync(path.join(draft, 'hana.r2d.json'))).toBe(false);

    const bad = project('badpost', (doc) => void (doc.post = [{ op: 'set', target: 'part:nope.opacity', value: 0.5 }]));
    const failed = await buildAvatarProject(bad).catch((e) => e);
    expect(failed).toBeInstanceOf(AvatarProjectError);
    expect(failed.message).toMatch(/the "post" op #0 \(set\) of avatar\.json failed: unknown part "nope"/);
    expect(existsSync(path.join(bad, 'hana.r2d.json'))).toBe(false);

    const invalid = project('invalidpost', (doc) => void (doc.post = [{ op: 'patch', patch: [{ op: 'add', path: '/parts/0/parent', value: 'ghost' }] }]));
    const rejected = await buildAvatarProject(invalid).catch((e) => e);
    expect(rejected.message).toMatch(/the generated model has 1 error \(after the "post" ops/);
    expect(rejected.diagnostics[0].code).toBe('unknown-parent');

    const missing = await buildAvatarProject(path.join(root, 'nowhere')).catch((e) => e);
    expect(missing).toBeInstanceOf(AvatarProjectError);
    expect(missing.kind).toBe('not-found');
  });

  it('reports folds as warnings without failing the build', async () => {
    const dir = project('folds', (doc) => void (doc.head.turn = { x: 70, y: 8 }));
    const r = await buildAvatarProject(dir);
    expect(r.folds.length).toBeGreaterThan(0);
    const issue = r.report.issues.find((i) => i.code === FOLD_CODE)!;
    expect(issue.severity).toBe('warning');
    expect(issue.message).toMatch(/warp "avatarWarp" (flips|collapses) at .*AngleX=-?30/);
    expect(r.report.stats.foldPoses).toBeGreaterThan(0);
    expect(existsSync(r.modelFile)).toBe(true);
  });

  it('renders the review sheets of a built project', async () => {
    const dir = project('review');
    const unbuilt = await reviewAvatarProject(dir).catch((e) => e);
    expect(unbuilt).toBeInstanceOf(AvatarProjectError);
    expect(unbuilt.hint).toContain('rev2d avatar build');
    await buildAvatarProject(dir, { folds: false });
    // Half-size cells keep the test fast; the default is twice as large.
    const r = await reviewAvatarProject(dir, { scale: 0.5 });
    expect(r.sheets.map((s) => [s.kind, s.name])).toEqual([
      ['poses', 'review/poses.png'],
      ['turn', 'review/turn.png'],
      ['eyes', 'review/eyes.png'],
      ['mouth', 'review/mouth.png'],
    ]);
    const ids = JSON.parse(readFileSync(path.join(dir, 'hana.r2d.json'), 'utf8')).parameters.map((p: any) => p.id) as string[];
    const rendered = r.poses.filter((p) => !p.skipped);
    expect(r.sheets[0].cells).toBe(rendered.length);
    expect(r.sheets[1].cells).toBe(9);
    for (const sheet of r.sheets) {
      const image = decodePNG(readFileSync(sheet.file));
      expect([image.width, image.height]).toEqual([sheet.width, sheet.height]);
    }
    // Room around the canvas; the eye and mouth crops are magnified.
    const [poses, turn, eyes, mouth] = r.sheets;
    expect(poses.viewBox[0]).toBeLessThan(0);
    expect(poses.viewBox[2]).toBeGreaterThan(256);
    expect(poses.captions).toEqual(rendered.map((p) => p.label));
    expect(poses.captions).toEqual(expect.arrayContaining(['rest', 'turn left (AngleX -30)', 'turn right (AngleX 30)', 'look up (AngleY 30)', 'look down (AngleY -30)', 'tilt left (AngleZ -30)', 'tilt right (AngleZ 30)', 'sway left (BodyAngleX -10)', 'sway right (BodyAngleX 10)']));
    expect(eyes.captions[0]).toBe('rest');
    expect(mouth.captions[0]).toBe('rest');
    expect(turn.captions[0]).toBe('AngleX=-30 AngleY=30');
    expect(eyes.scale).toBeGreaterThan(2);
    expect(mouth.scale).toBeGreaterThan(2);
    const eyeBox = eyes.viewBox;
    const iris = spec.face.eyes.imageLeft.iris!.center;
    expect(iris[0] > eyeBox[0] && iris[0] < eyeBox[0] + eyeBox[2] && iris[1] > eyeBox[1] && iris[1] < eyeBox[1] + eyeBox[3]).toBe(true);
    // A pose is skipped (and named in a note) exactly when the model has none of its parameters.
    for (const pose of r.poses) {
      expect(Object.keys(pose.params).every((id) => ids.includes(id))).toBe(true);
      if (pose.skipped) expect(Object.keys(pose.params)).toEqual([]);
    }
    const skipped = r.poses.filter((p) => p.skipped).map((p) => p.id);
    expect(skipped).toEqual(['eyes_half', 'eyes_closed', 'mouth_open'].filter((id) => !rendered.some((p) => p.id === id)));
    if (skipped.length) expect(r.notes.join('\n')).toContain(`skipped, the model lacks the parameters: ${skipped.join(', ')}`);
    // Every rendered pose says how far the landmarks of the spec travel in it (source pixels).
    const moves = (id: string) => r.poses.find((p) => p.id === id)!.moves!;
    expect(r.poses.find((p) => p.id === 'tilt_left')).toMatchObject({ id: 'tilt_left', label: 'tilt left (AngleZ -30)', params: { AngleZ: -30 } });
    expect(r.poses.every((p) => (p.skipped === undefined) === (p.moves !== undefined))).toBe(true);
    expect(moves('rest')).toEqual({});
    expect(moves('turn_right').faceCenter[0]).toBeCloseTo(metrics.turn.x, 0);
    expect(moves('turn_right').nose[0]).toBeGreaterThan(moves('turn_right').earImageLeft[0] * 2);
    expect(moves('turn_right').chest).toBeUndefined();
    expect(moves('look_up').nose[1]).toBeLessThan(-metrics.turn.y * 0.8);
    expect(moves('tilt_right').headTop[0]).toBeGreaterThan(10);
    expect(moves('tilt_right').shoulderImageLeft).toBeUndefined();
    expect(moves('sway_left').chest[0]).toBeLessThan(-1);
    const summary = JSON.parse(readFileSync(r.summaryFile, 'utf8'));
    expect(summary).toMatchObject({ name: 'hana', model: 'hana.r2d.json', canvas: [256, 320], parameters: ids });
    expect(summary.sheets.map((s: any) => s.file)).toEqual(['review/poses.png', 'review/turn.png', 'review/eyes.png', 'review/mouth.png']);
    expect(summary.poses).toEqual(JSON.parse(JSON.stringify(r.poses)));
    expect(summary.timings.totalMs).toBeGreaterThan(0);
    // The scale option sizes the cells.
    const small = await reviewAvatarProject(dir, { scale: 0.25 });
    expect(small.sheets[0].width).toBeLessThan(poses.width);
    expect(small.sheets[0].scale).toBeCloseTo(poses.scale / 2, 2);
    await expect(reviewAvatarProject(dir, { scale: 0 })).rejects.toThrow(/positive number/);
    // Slow on purpose: a build and two reviews that render every review pose of every feature.
  }, 60_000);
});

describe('rev2d avatar build / poses', () => {
  it('builds and reviews from the command line', async () => {
    project('cli');
    const build = await run(['avatar', 'build', 'cli']);
    expect(build.code).toBe(0);
    expect(build.stdout).toMatch(/^built cli: "hana", \d+ KB model, \d+ layer images?, 0 warnings\n/);
    expect(build.stdout).toContain('cli/hana.r2d.json');
    expect(build.stdout).toMatch(/\d+ parameters, \d+ warps? \(\d+ lattice points; root 40 x 50 cells\), \d+ parts?, \d+ bindings/);
    expect(build.stdout).toMatch(/base\.png.* \+ layers\.json/);
    expect(build.stdout).toMatch(/time\s+\d+(\.\d+)? (ms|s) \(layers /);
    expect(build.stdout).toContain('rev2d avatar poses cli');
    expect(build.stderr).toBe('');

    const json = (await run(['avatar', 'build', 'cli/avatar.json', '--json'])).json();
    expect(json).toMatchObject({ ok: true, name: 'hana', postOps: 0, warnings: 0 });
    expect(json.layers[0]).toBe('textures/base.png');
    expect(json.issues.filter((i: any) => i.severity === 'warning')).toEqual([]);
    expect(json.modelFile).toBe(path.join(root, 'cli', 'hana.r2d.json'));
    expect(json.stats).toMatchObject({ latticeCols: 40, latticeRows: 50 });
    expect(json.timings.totalMs).toBeGreaterThan(0);

    const poses = await run(['avatar', 'poses', 'cli', '--scale', '0.5']);
    expect(poses.code).toBe(0);
    expect(poses.stdout).toMatch(/^reviewed cli\/hana\.r2d\.json: \d+ poses on 4 sheets in /);
    for (const name of ['poses.png', 'turn.png', 'eyes.png', 'mouth.png', 'summary.json']) {
      expect(poses.stdout).toContain(`cli/review/${name}`);
      expect(existsSync(path.join(root, 'cli', 'review', name))).toBe(true);
    }
    const posesJson = (await run(['avatar', 'poses', 'cli', '--scale', '0.25', '--json'])).json();
    expect(posesJson.ok).toBe(true);
    expect(posesJson.sheets.map((s: any) => s.kind)).toEqual(['poses', 'turn', 'eyes', 'mouth']);
    expect(posesJson.poses.length).toBeGreaterThanOrEqual(12);
    expect(posesJson.notes.every((n: string) => poses.stderr.includes(`note: ${n}`))).toBe(true);
    expect(posesJson.sheets[0].scale).toBeLessThan(0.3);

    // The built model works with the ordinary commands.
    const sheet = await run(['sheet', 'cli/hana.r2d.json', '--sweep', 'AngleZ=-30,30', '--scale', '0.5', '-o', 'cli/work/tilt.png']);
    expect(sheet.code).toBe(0);
    // Two builds with the fold check and two reviews of every feature's poses.
  }, 60_000);

  it('explains failures: an unfinished spec, a project that is not built, usage', async () => {
    project('cli-draft', (doc) => void (doc.face.chin = null));
    const draft = await run(['avatar', 'build', 'cli-draft']);
    expect(draft.code).toBe(1);
    expect(draft.stderr).toContain('the avatar spec has 1 error (1 landmark still to place)');
    expect(draft.stderr).toContain('avatar-missing-landmark');
    expect(draft.stderr).toContain('rev2d avatar validate');
    const failed = (await run(['avatar', 'build', 'cli-draft', '--json'])).json();
    expect(failed).toMatchObject({ ok: false, exitCode: 1 });

    project('cli-unbuilt');
    const unbuilt = await run(['avatar', 'poses', 'cli-unbuilt']);
    expect(unbuilt.code).toBe(1);
    expect(unbuilt.stderr).toContain('is not built yet');
    expect(unbuilt.stderr).toContain('rev2d avatar build');

    expect((await run(['avatar', 'build', 'no-such-dir'])).code).toBe(1);
    expect((await run(['avatar', 'build'])).code).toBe(2);
    const scale = await run(['avatar', 'poses', 'cli-unbuilt', '--scale', '0']);
    expect(scale.code).toBe(2);
    const help = await run(['help', 'avatar', 'poses']);
    expect(help.stdout).toContain('review/turn.png');
  });
});
