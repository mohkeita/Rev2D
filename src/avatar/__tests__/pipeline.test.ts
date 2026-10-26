/**
 * The feature pipeline: buildAvatarLayers / compileAvatar / avatarReviewPoses on the hand-written
 * 400 x 500 spec and synthetic picture of ./fixtures.ts, and the contexts a feature works with.
 *
 * Exact expectations (which parameters, warps, parts and bindings exist) are checked on the SKELETON
 * (the head and body features); the full pipeline, which grows as features are implemented, is only
 * held to what stays true for any feature set: a valid model, no folds, deterministic output.
 */
import { describe, expect, it } from 'vitest';
import { formatModelJson } from '../../core/format.js';
import { Rig } from '../../core/rig.js';
import { validateModel } from '../../core/validate.js';
import { createImage } from '../../render/image.js';
import { AVATAR_Z } from '../builder.js';
import { compileModel, ROOT_WARP } from '../compile.js';
import { AVATAR_FEATURES, HEAD_TUNING, headTiltWeight, headTurnField } from '../features/index.js';
import type { AvatarFeature } from '../features/types.js';
import { avatarMetrics, shiftField, gaussianWeight } from '../fields.js';
import { findFolds } from '../folds.js';
import { layerInputsHash } from '../hash.js';
import { avatarReviewPoses, buildAvatarLayers, compileAvatar } from '../index.js';
import { BASE_LAYER, buildLayers } from '../layers.js';
import { reviewPoses, STANDARD_POSES } from '../poses.js';
import { parseAvatarSpec } from '../spec.js';
import type { AvatarSpec } from '../types.js';
import { HEIGHT, testImage, validDoc, WIDTH, type Json } from './fixtures.js';

function specOf(mutate: (doc: Json) => void = () => {}): AvatarSpec {
  const doc = validDoc();
  mutate(doc);
  const parsed = parseAvatarSpec(doc);
  if (!parsed.spec) throw new Error(JSON.stringify(parsed.diagnostics));
  return parsed.spec;
}

const source = testImage();

/** The features of the skeleton: head turn / tilt, body sway / breath. */
const SKELETON = AVATAR_FEATURES.filter((f) => f.id === 'head' || f.id === 'body');

describe('feature registry', () => {
  it('lists every feature once, head and body first, animations last', () => {
    const ids = AVATAR_FEATURES.map((f) => f.id);
    expect(ids).toEqual(['head', 'body', 'arms','eyes', 'mouth', 'brows', 'cheeks', 'hair', 'attachments', 'sprites','expressions', 'animations']);
    expect(AVATAR_FEATURES.every((f) => f.summary.length > 10)).toBe(true);
  });
});

describe('buildAvatarLayers', () => {
  it('starts with the base layer: the illustration, untouched, and its metadata', () => {
    const spec = specOf();
    const built = buildLayers(spec, source, undefined, SKELETON);
    expect(Object.keys(built.images)).toEqual(['textures/base.png']);
    const base = built.images['textures/base.png'];
    expect(base).not.toBe(source);
    expect(Buffer.compare(Buffer.from(base.data), Buffer.from(source.data))).toBe(0);
    expect(built.meta).toEqual({
      version: 1,
      inputsHash: layerInputsHash(spec),
      image: { width: WIDTH, height: HEIGHT },
      layers: [{ id: 'base', file: 'textures/base.png', rect: [0, 0, WIDTH, HEIGHT] }],
      variants: [],
    });
    expect(built.report).toEqual({ issues: [], stats: { layers: 1 } });
    expect(() => buildAvatarLayers(spec, createImage(10, 10))).toThrow(/400x500 image, but the source is 10x10/);
  });

  it('with every feature: the base comes first, the hash is recorded, the result is deterministic', () => {
    const spec = specOf();
    const built = buildAvatarLayers(spec, source);
    expect(built.meta.layers[0]).toEqual({ id: 'base', file: 'textures/base.png', rect: [0, 0, WIDTH, HEIGHT] });
    expect(built.meta.inputsHash).toBe(layerInputsHash(spec));
    expect(Object.keys(built.images).sort()).toEqual(built.meta.layers.map((l) => l.file).sort());
    for (const layer of built.meta.layers) expect([built.images[layer.file].width, built.images[layer.file].height]).toEqual([layer.rect[2], layer.rect[3]]);
    const again = buildAvatarLayers(spec, source, built.meta);
    expect(JSON.stringify(again.meta)).toBe(JSON.stringify(built.meta));
    for (const file of Object.keys(built.images)) expect(Buffer.compare(Buffer.from(again.images[file].data), Buffer.from(built.images[file].data))).toBe(0);
  });

  it('lets a feature cut a layer, replace the base, store metadata and report', () => {
    const spec = specOf();
    const previous = buildAvatarLayers(spec, source).meta;
    const cutter: AvatarFeature = {
      id: 'eyes',
      summary: 'test feature: cuts a patch',
      layers(ctx) {
        expect(ctx.source).toBe(source);
        expect(ctx.previous).toBe(previous);
        expect(ctx.metrics.width).toBe(WIDTH);
        expect(ctx.sourceLab()).toBe(ctx.sourceLab());
        const patch = createImage(20, 10, '#ff0000');
        const info = ctx.addLayer('eyeR_ball', patch, [150, 190, 20, 10]);
        expect(info).toEqual({ id: 'eyeR_ball', file: 'textures/eyeR_ball.png', rect: [150, 190, 20, 10] });
        expect(() => ctx.addLayer('eyeR_ball', patch, [0, 0, 20, 10])).toThrow(/used twice/);
        expect(() => ctx.addLayer('base', patch, [0, 0, 20, 10])).toThrow(/used twice/);
        expect(() => ctx.addLayer('x', patch, [0, 0, 21, 10])).toThrow(/its rect is/);
        expect(() => ctx.addLayer('bad id', patch, [0, 0, 20, 10])).toThrow(/not a valid layer id/);
        const next = createImage(WIDTH, HEIGHT, '#00ff00');
        ctx.base = next;
        ctx.setMeta('eyes', { upper: [1, 2, 3] });
        expect(() => ctx.setMeta('layers', [])).toThrow(/reserved key/);
        // Claimed pixels: the union of what the features cut, for later features to stay out of.
        expect(ctx.claimed.data.every((v) => v === 0)).toBe(true);
        ctx.claim({ width: 20, height: 10, data: new Float32Array(200).fill(0.5) }, 150, 190);
        ctx.claim({ width: 2, height: 1, data: new Float32Array([1, 0.25]) }, 150, 190);
        expect([ctx.claimed.width, ctx.claimed.height]).toEqual([WIDTH, HEIGHT]);
        expect(Array.from(ctx.claimed.data.slice(190 * WIDTH + 149, 190 * WIDTH + 153))).toEqual([0, 1, 0.5, 0.5]);
        expect(() => ctx.claim(ctx.claimed, 0.5, 0)).toThrow(/whole pixels/);
        ctx.addVariant('eyes_closed');
        ctx.addVariant('eyes_closed');
        ctx.report.warning('avatar-test', 'look at this', { path: '/face/eyes', hint: 'a hint' });
        ctx.report.stat('eyeLayers', 1);
      },
    };
    const built = buildLayers(spec, source, previous, [cutter]);
    expect(Object.keys(built.images)).toEqual(['textures/base.png', 'textures/eyeR_ball.png']);
    expect(Array.from(built.images['textures/base.png'].data.slice(0, 4))).toEqual([0, 255, 0, 255]);
    expect(built.meta.layers.map((l) => l.id)).toEqual(['base', 'eyeR_ball']);
    expect(built.meta.variants).toEqual(['eyes_closed']);
    expect(built.meta.eyes).toEqual({ upper: [1, 2, 3] });
    expect(built.report.issues).toEqual([{ severity: 'warning', code: 'avatar-test', message: 'look at this', path: '/face/eyes', hint: 'a hint' }]);
    expect(built.report.stats).toEqual({ eyeLayers: 1, layers: 2 });
    // The source is never modified.
    expect(Buffer.compare(Buffer.from(source.data), Buffer.from(testImage().data))).toBe(0);
    const shrink: AvatarFeature = { id: 'hair', summary: 'breaks the base size on purpose', layers: (ctx) => void (ctx.base = createImage(5, 5)) };
    expect(() => buildLayers(spec, source, undefined, [shrink])).toThrow(/size of the base layer/);
  });
});

describe('compileAvatar', () => {
  const spec = specOf();
  const meta = buildLayers(spec, source, undefined, SKELETON).meta;
  /** The skeleton only: what these tests pin down exactly. */
  const compileSkeleton = (s: AvatarSpec = spec, m = meta) => compileModel(s, m, SKELETON);

  it('with every feature: a valid model without warnings or folds, the same every time', () => {
    const fullMeta = buildAvatarLayers(spec, source).meta;
    const compiled = compileAvatar(spec, fullMeta);
    const doc = compiled.doc as Json;
    expect(doc.warps[0].id).toBe(ROOT_WARP);
    expect(doc.parts[0].id).toBe(BASE_LAYER);
    expect(doc.parameters.map((p: Json) => p.id)).toEqual(expect.arrayContaining(['AngleX', 'AngleY', 'AngleZ', 'BodyAngleX', 'Breath']));
    const { model, diagnostics } = validateModel(doc);
    expect(diagnostics.filter((d) => d.severity !== 'info')).toEqual([]);
    expect(findFolds(model!, compiled.folds)).toEqual([]);
    expect(formatModelJson(compileAvatar(specOf(), fullMeta).doc)).toBe(formatModelJson(doc));
  });

  it('builds the skeleton: one root lattice, the base image on it, and the head / body bindings', () => {
    const compiled = compileSkeleton();
    const doc = compiled.doc as Json;
    expect(doc.meta).toMatchObject({ name: 'tester', width: WIDTH, height: HEIGHT, background: 'transparent' });
    // Only parameters that something drives, in the standard order.
    expect(doc.parameters.map((p: Json) => p.id)).toEqual(['AngleX', 'AngleY', 'AngleZ', 'BodyAngleX', 'Breath']);
    expect(doc.textures).toEqual([{ id: 'base', path: 'textures/base.png', width: WIDTH, height: HEIGHT }]);
    // Cells of 2% of the long side: 500 px -> 10 px.
    expect(doc.warps).toHaveLength(1);
    expect(doc.warps[0]).toMatchObject({ id: ROOT_WARP, rect: [0, 0, WIDTH, HEIGHT], cols: 40, rows: 50 });
    expect(doc.parts).toHaveLength(1);
    expect(doc.parts[0]).toMatchObject({ id: BASE_LAYER, parent: ROOT_WARP, z: AVATAR_Z.base, shape: { type: 'image', texture: 'base', x: 0, y: 0, w: WIDTH, h: HEIGHT, cols: 40, rows: 50 } });
    expect(doc.bindings.map((b: Json) => [b.id, b.target, b.params, b.keys.length])).toEqual([
      ['headTurn', 'warp:avatarWarp.offsets', ['AngleX', 'AngleY'], 9],
      ['headTilt', 'warp:avatarWarp.offsets', ['AngleZ'], 3],
      ['bodySway', 'warp:avatarWarp.offsets', ['BodyAngleX'], 3],
      ['breath', 'warp:avatarWarp.offsets', ['Breath'], 2],
    ]);
    // Keyforms at the parameter defaults are the rest pose.
    const turn = doc.bindings[0];
    expect(turn.keys.find((k: Json) => k.at[0] === 0 && k.at[1] === 0).value).toEqual({});
    expect(doc.bindings[1].keys[1]).toEqual({ at: [0], value: {} });
    expect(doc.physics).toBeUndefined();
    expect(doc.animations).toBeUndefined();
    expect(compiled.report.issues).toEqual([]);
    expect(compiled.report.stats).toMatchObject({ parameters: 5, warps: 1, parts: 1, bindings: 4, latticePoints: 41 * 51, latticeCols: 40, latticeRows: 50 });
    expect(compiled.report.stats.turnPoints).toBeGreaterThan(300);
    expect(compiled.folds).toEqual({ poses: [], collapsible: [], skip: [] });
  });

  it('the skeleton validates without any diagnostic, has no folds, and is deterministic', () => {
    const compiled = compileSkeleton();
    const { model, diagnostics } = validateModel(compiled.doc);
    expect(diagnostics).toEqual([]);
    expect(findFolds(model!, compiled.folds)).toEqual([]);
    expect(formatModelJson(compileSkeleton(specOf()).doc)).toBe(formatModelJson(compiled.doc));
  });

  it('keeps keyforms sparse and rounded', () => {
    const doc = compileSkeleton().doc as Json;
    const head = avatarMetrics(spec).head;
    const lattice = { cols: 40, rows: 50, cw: WIDTH / 40, ch: HEIGHT / 50 };
    for (const key of doc.bindings[0].keys) {
      for (const [index, offset] of Object.entries(key.value) as Array<[string, [number, number]]>) {
        const i = Number(index);
        const x = (i % (lattice.cols + 1)) * lattice.cw;
        const y = Math.floor(i / (lattice.cols + 1)) * lattice.ch;
        // Listed points lie inside the head ellipse, and no value has more than 2 decimals.
        expect(((x - head.center[0]) / head.radius[0]) ** 2 + ((y - head.center[1]) / head.radius[1]) ** 2).toBeLessThan(1);
        expect(offset.every((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-9)).toBe(true);
        expect(offset[0] !== 0 || offset[1] !== 0).toBe(true);
      }
    }
  });

  it('honours build.cell.body and reports a cell that had to be raised', () => {
    const coarse = compileSkeleton(specOf((doc) => void (doc.build = { cell: { body: 25 } })));
    expect((coarse.doc as Json).warps[0]).toMatchObject({ cols: 16, rows: 20 });
    expect((coarse.doc as Json).parts[0].shape).toMatchObject({ cols: 16, rows: 20 });
    expect(coarse.report.issues).toEqual([]);
    const fine = compileSkeleton(specOf((doc) => void (doc.build = { cell: { body: 4 } })));
    expect((fine.doc as Json).warps[0]).toMatchObject({ cols: 51, rows: 64 });
    expect(fine.report.issues.map((i) => [i.severity, i.code, i.path])).toEqual([['info', 'avatar-cell-clamped', '/build/cell/body']]);
    expect(validateModel(fine.doc).diagnostics).toEqual([]);
  });

  it('adds keyforms at half the tilt when the head arc is long', () => {
    const steep = compileSkeleton(specOf((doc) => void (doc.head.tilt = 25)));
    const tilt = (steep.doc as Json).bindings.find((b: Json) => b.id === 'headTilt');
    expect(tilt.keys.map((k: Json) => k.at[0])).toEqual([-30, -15, 0, 15, 30]);
  });

  it('warns when the pivot sits so high that the chin does not follow the head', () => {
    const high = compileSkeleton(specOf((doc) => void (doc.head.pivot = [200, 262])));
    expect(high.report.issues.map((i) => [i.code, i.path])).toEqual([['avatar-chin-weight', '/head/pivot']]);
    expect(headTiltWeight(spec)(200, 278)).toBe(1);
    const low = compileSkeleton(specOf((doc) => void (doc.head.pivot = [200, 360])));
    expect(low.report.issues.map((i) => [i.severity, i.code, i.path])).toEqual([['warning', 'avatar-pivot-below-neck', '/head/pivot']]);
  });

  it('survives stale or incomplete layer metadata', () => {
    const stale = compileSkeleton(spec, { ...meta, image: { width: 200, height: 250 }, layers: [] });
    expect(stale.report.issues.map((i) => i.code)).toEqual(['avatar-layers-size', 'avatar-layers-incomplete']);
    expect(validateModel(stale.doc).diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('gives a feature the root warp, layers, metadata, the fold plan and the report', () => {
    const layered = buildLayers(spec, source, undefined, [
      {
        id: 'brows',
        summary: 'test feature: a layer and metadata',
        layers(ctx) {
          ctx.addLayer('brow_patch', createImage(40, 20, '#402010'), [150, 160, 40, 20]);
          ctx.setMeta('brows', { lift: 4 });
        },
      },
    ]).meta;
    const brows: AvatarFeature = {
      id: 'brows',
      summary: 'test feature: a binding on the root lattice, a nested warp and a part',
      compile(ctx) {
        expect(ctx.root.id).toBe(ROOT_WARP);
        expect(ctx.model.hasParameter('AngleX')).toBe(true);
        const lift = ctx.featureMeta<{ lift: number }>('brows')!.lift;
        expect(ctx.featureMeta('nothing')).toBeUndefined();
        expect(ctx.layer('nothing')).toBeUndefined();
        const param = ctx.model.parameter('BrowLY');
        ctx.model.bindField(ctx.root, { id: 'browL', params: [param], keys: [{ at: [-1] }, { at: [0] }, { at: [1], field: shiftField(0, -lift, gaussianWeight([165, 168], 12)) }] });
        const layer = ctx.layer('brow_patch')!;
        const warp = ctx.model.warp({ id: 'browWarp', parent: ctx.root.id, rect: layer.rect, cell: ctx.metrics.cell.detail });
        // A layer that covers its warp gets the warp's cells as its image grid.
        expect(ctx.model.imagePart(layer, { id: 'browPatch', parent: warp.id, z: AVATAR_Z.brows })).toBe('browPatch');
        expect(ctx.model.findPart('browPatch')!.shape).toEqual({ type: 'image', texture: 'brow_patch', x: 150, y: 160, w: 40, h: 20, cols: warp.lattice.cols, rows: warp.lattice.rows });
        ctx.folds.pose({ BrowLY: 1, AngleX: 30 });
        ctx.folds.collapsible('warp', 'browWarp');
        ctx.folds.skip('part', 'browPatch');
        ctx.report.info('avatar-test-info', 'a note');
      },
      poses: () => [{ id: 'brow_up', label: 'brow up', params: { BrowLY: 1 } }],
    };
    const features = [...SKELETON, brows];
    const compiled = compileModel(spec, layered, features);
    const doc = compiled.doc as Json;
    expect(doc.parameters.map((p: Json) => p.id)).toEqual(['AngleX', 'AngleY', 'AngleZ', 'BrowLY', 'BodyAngleX', 'Breath']);
    expect(doc.warps.map((w: Json) => [w.id, w.parent])).toEqual([['avatarWarp', undefined], ['browWarp', 'avatarWarp']]);
    expect(doc.parts.map((p: Json) => p.id)).toEqual(['base', 'browPatch']);
    expect(doc.textures.map((t: Json) => t.id)).toEqual(['base', 'brow_patch']);
    expect(compiled.folds).toEqual({ poses: [{ BrowLY: 1, AngleX: 30 }], collapsible: ['warp:browWarp'], skip: ['part:browPatch'] });
    expect(compiled.report.issues).toEqual([{ severity: 'info', code: 'avatar-test-info', message: 'a note' }]);
    const { model, diagnostics } = validateModel(doc);
    expect(diagnostics.filter((d) => d.severity !== 'info')).toEqual([]);
    // The nested patch follows the head: its warp is a child of the root lattice.
    const rig = new Rig(model!);
    const pose = rig.pose({ params: { AngleZ: 30 }, physics: false });
    const onBase = rig.mapPoint(pose, 'avatarWarp', 170, 170);
    const onPatch = rig.mapPoint(pose, 'browWarp', 170, 170);
    expect(Math.hypot(onBase[0] - 170, onBase[1] - 170)).toBeGreaterThan(10);
    expect(Math.hypot(onBase[0] - onPatch[0], onBase[1] - onPatch[1])).toBeLessThan(0.05);
    expect(findFolds(model!, compiled.folds)).toEqual([]);
    // Its pose is appended to the standard review poses.
    expect(reviewPoses(spec, layered, features).map((p) => p.id)).toEqual([...STANDARD_POSES.map((p) => p.id), 'brow_up']);
    expect(() => reviewPoses(spec, layered, [brows, brows])).toThrow(/pose id "brow_up" is used twice/);
  });
});

describe('head turn field', () => {
  const spec = specOf();
  const metrics = avatarMetrics(spec);

  it('moves the face centre by exactly head.turn and nothing outside the head ellipse', () => {
    const right = headTurnField(spec, metrics, 1, 0);
    const up = headTurnField(spec, metrics, 0, 1);
    const [fx, fy] = spec.face.center;
    expect(right(fx, fy)[0]).toBeCloseTo(14, 9);
    expect(right(fx, fy)[1]).toBe(0);
    expect(up(fx, fy)[1]).toBeCloseTo(-12, 9);
    expect(headTurnField(spec, metrics, -1, 0)(fx, fy)[0]).toBeCloseTo(-14, 9);
    // On and outside the rim of the head ellipse (centre 200,170, radius 130,150): exactly nothing.
    for (const [x, y] of [[330, 170], [200, 20], [60, 170], [340, 60], [200, 330], [10, 10]]) expect(right(x, y)).toEqual([0, 0]);
    // Below the neck band nothing moves, although the head ellipse reaches further down.
    expect(right(200, 310)[0]).toBeGreaterThan(0);
    const short = specOf((doc) => void (doc.head.neck = [285, 300]));
    expect(headTurnField(short, avatarMetrics(short), 1, 0)(200, 310)).toEqual([0, 0]);
    // Yaw and pitch together move a little less than each alone.
    const both = headTurnField(spec, metrics, 1, 1)(fx, fy);
    expect(both[0]).toBeCloseTo(14 * (1 - HEAD_TUNING.diagonal), 9);
    expect(both[1]).toBeCloseTo(-12 * (1 - HEAD_TUNING.diagonal), 9);
  });

  it('moves the nose most, the ears least, and the far half of the face less than the near half', () => {
    const right = headTurnField(spec, metrics, 1, 0);
    const dx = (p: readonly number[]) => right(p[0], p[1])[0];
    const ears = spec.face.ears!;
    // The nose tip sticks out of the face: it leads the point that mirrors it across the face centre.
    const nose = spec.face.nose;
    expect(dx(nose)).toBeGreaterThan(dx([nose[0], 2 * spec.face.center[1] - nose[1]]) + 0.5);
    expect(dx(ears.imageLeft!)).toBeGreaterThan(0);
    expect(dx(ears.imageLeft!)).toBeLessThan(dx(spec.face.nose) * 0.5);
    expect(dx(ears.imageRight!)).toBeLessThan(dx(spec.face.nose) * 0.5);
    // Turning right, the right half leads (it turns away): mirrored points move less there.
    expect(dx([240, 200])).toBeLessThan(dx([160, 200]));
    expect(headTurnField(spec, metrics, -1, 0)(160, 200)[0]).toBeCloseTo(-dx([240, 200]), 9);
  });
});

describe('avatarReviewPoses', () => {
  it('lists the standard poses with the ids of the Live2D parameters', () => {
    const spec = specOf();
    const poses = avatarReviewPoses(spec, buildAvatarLayers(spec, source).meta);
    // The standard poses come first, in sheet order; features append theirs.
    expect(poses.slice(0, 12).map((p) => p.id)).toEqual(['rest', 'eyes_half', 'eyes_closed', 'mouth_open', 'turn_left', 'turn_right', 'look_up', 'look_down', 'tilt_left', 'tilt_right', 'sway_left', 'sway_right']);
    expect(new Set(poses.map((p) => p.id)).size).toBe(poses.length);
    expect(poses[0].params).toEqual({});
    expect(poses.find((p) => p.id === 'eyes_closed')).toMatchObject({ params: { EyeLOpen: 0, EyeROpen: 0 }, zoom: 'eyes' });
    expect(poses.find((p) => p.id === 'mouth_open')).toMatchObject({ params: { MouthOpen: 1 }, zoom: 'mouth' });
    expect(poses.find((p) => p.id === 'look_up')!.params).toEqual({ AngleY: 30 });
    // A copy every time: callers may change it.
    poses[0].params.AngleX = 1;
    expect(STANDARD_POSES[0].params).toEqual({});
  });
});
