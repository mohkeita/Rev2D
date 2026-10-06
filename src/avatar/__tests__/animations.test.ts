/**
 * The generated animations (../features/animations.ts) on the repository's own test illustration
 * (test/fixtures/avatar-hana.ts, half size), with the skeleton, hair and attachments:
 *
 *   - only parameters the model has are driven: without eye / mouth parameters there is no "blink"
 *     and no "talk", and the idle does not blink; with them (a stand-in feature declares them) both
 *     appear and the idle blinks;
 *   - every animation validates, looping ones close their loop (analyze: the seam), and the idle
 *     keeps the physics lively but never clamped;
 *   - spec.post ops are applied after the generated animations and survive a rebuild.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeAnimation } from '../../api/analyze.js';
import { formatModelJson } from '../../core/format.js';
import { Rig } from '../../core/rig.js';
import type { Model } from '../../core/types.js';
import { validateModel } from '../../core/validate.js';
import { buildAvatarProject } from '../../node/avatar.js';
import type { LoadedModel } from '../../node/load.js';
import { encodePNG } from '../../render/index.js';
import { hanaIllustration } from '../../../test/fixtures/avatar-hana.js';
import { compileModel } from '../compile.js';
import { animationPlans } from '../features/animations.js';
import { AVATAR_FEATURES } from '../features/index.js';
import type { AvatarFeature } from '../features/types.js';
import { buildLayers } from '../layers.js';
import { parseAvatarSpec } from '../spec.js';
import type { AvatarSpec } from '../types.js';

const MINE = AVATAR_FEATURES.filter((f) => ['head', 'body', 'hair', 'attachments', 'animations'].includes(f.id));
/** Stands in for the face features: declares their parameters and drives a root binding with each. */
const FACE_PARAMS = ['EyeLOpen', 'EyeROpen', 'EyeBallX', 'EyeBallY', 'MouthOpen', 'MouthForm'] as const;
const face: AvatarFeature = {
  id: 'eyes',
  summary: 'test stand-in: declares the eye and mouth parameters',
  compile(ctx) {
    for (const id of FACE_PARAMS) {
      const p = ctx.model.parameter(id);
      const nudge = (x: number, y: number): [number, number] => (Math.hypot(x - 128, y - 150) < 20 ? [0.5, 0] : [0, 0]);
      // The rest keyform sits at the parameter's default (1 for the eyes, 0 for the others).
      const keys = id.endsWith('Open') ? [{ at: [0], field: nudge }, { at: [1] }] : [{ at: [-1], field: nudge }, { at: [0] }, { at: [1], field: nudge }];
      ctx.model.bindField(ctx.root, { id: `stand_${id}`, params: [p], keys });
    }
  },
};
const WITH_FACE = [...MINE.slice(0, 2), face, ...MINE.slice(2)];

const hana = hanaIllustration(0.5);
const spec = parseAvatarSpec(hana.doc).spec as AvatarSpec;
const layers = buildLayers(spec, hana.image, undefined, MINE);
const textures = Object.fromEntries(layers.meta.layers.map((l) => [l.id, layers.images[l.file]]));

function built(features: readonly AvatarFeature[]): { doc: any; model: Model; loaded: LoadedModel } {
  const doc = compileModel(spec, layers.meta, features).doc as any;
  const v = validateModel(doc);
  expect(v.diagnostics.filter((d) => d.severity !== 'info')).toEqual([]);
  const model = v.model as Model;
  const textureInfo = Object.fromEntries(Object.entries(textures).map(([id, img]) => [id, { width: img.width, height: img.height }]));
  return { doc, model, loaded: { file: null, baseDir: '.', model, diagnostics: [], textures, textureInfo, rig: new Rig(model, { textures: textureInfo }) } };
}

const plain = built(MINE);
const full = built(WITH_FACE);

const root = mkdtempSync(path.join(os.tmpdir(), 'rev2d-avatar-animations-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('generated animations', () => {
  it('drive only the parameters the model has', () => {
    const ids = (doc: any) => doc.animations.map((a: any) => a.id);
    expect(ids(plain.doc)).toEqual(['idle', 'nod', 'look_around', 'sweep']);
    expect(ids(full.doc)).toEqual(['idle', 'blink', 'talk', 'nod', 'look_around', 'sweep']);
    for (const { doc, model } of [plain, full]) {
      const params = new Set(model.parameters.map((p) => p.id));
      for (const a of doc.animations) for (const t of a.tracks) expect(params.has(t.target.slice('param:'.length)), `${a.id} ${t.target}`).toBe(true);
      // Physics writes the hair and the attachments: no animation touches them.
      for (const a of doc.animations) for (const t of a.tracks) expect(t.target).not.toMatch(/^param:(Hair|Sway)_/);
    }
    const idleTargets = (doc: any) => doc.animations.find((a: any) => a.id === 'idle').tracks.map((t: any) => t.target);
    expect(idleTargets(plain.doc)).toEqual(['param:Breath', 'param:BodyAngleX', 'param:AngleX', 'param:AngleY', 'param:AngleZ']);
    expect(idleTargets(full.doc)).toEqual(expect.arrayContaining(['param:EyeLOpen', 'param:EyeROpen', 'param:EyeBallX']));
    // The plan lists exactly the animations of DESIGN.md.
    expect(animationPlans().map((p) => p.id)).toEqual(['idle', 'blink', 'talk', 'nod', 'look_around', 'sweep']);
  });

  it('close their loops: every looping track ends where it starts, at t = duration', () => {
    for (const a of full.doc.animations) {
      for (const t of a.tracks) {
        const keys = t.keys;
        expect(keys[0].t).toBe(0);
        expect(keys[keys.length - 1].t, `${a.id} ${t.target}`).toBeLessThanOrEqual(a.duration);
        if (a.loop) {
          expect(keys[keys.length - 1].t, `${a.id} ${t.target}`).toBe(a.duration);
          expect(keys[keys.length - 1].v, `${a.id} ${t.target}`).toBe(keys[0].v);
        }
      }
    }
    expect(full.doc.animations.filter((a: any) => !a.loop).map((a: any) => a.id)).toEqual(['blink', 'nod']);
  });

  it('give a seamless idle with lively, never clamped physics', () => {
    // 32 frames are plenty: the idle's physics peaks lie far below the limit.
    const r = analyzeAnimation(full.loaded, { animation: 'idle', warmup: 8, frames: 32, pixels: false });
    expect(r.duration).toBe(8);
    expect(r.seam?.ok).toBe(true);
    expect(r.physics.length).toBe(spec.hair!.strands.length + 2);
    for (const p of r.physics) expect(p.clampedFrames, p.param).toBe(0);
    // Lively: every lock swings by a good part of its range during the idle.
    for (const p of r.physics.filter((q) => q.param.startsWith('Hair_'))) expect(Math.abs(p.peak), p.param).toBeGreaterThan(0.15);
    // The idle blinks: the eyes close fully.
    const eye = r.params.find((p) => p.id === 'EyeLOpen')!;
    expect([eye.min, eye.max]).toEqual([0, 1]);
  });

  it('are deterministic', () => {
    expect(formatModelJson(compileModel(spec, layers.meta, WITH_FACE).doc)).toBe(formatModelJson(full.doc));
  });
});

describe('spec.post', () => {
  it('adds to the generated animations, and survives a rebuild', async () => {
    const dir = path.join(root, 'post');
    mkdirSync(dir, { recursive: true });
    const doc = hanaIllustration(0.5).doc;
    doc.post = [
      { op: 'key', animation: 'wave', target: 'param:AngleZ', t: 0, v: 0, duration: 2 },
      { op: 'key', animation: 'wave', target: 'param:AngleZ', t: 1, v: 12 },
      { op: 'key', animation: 'wave', target: 'param:AngleZ', t: 2, v: 0 },
      // A post op may also change a generated animation.
      { op: 'update', kind: 'animation', id: 'idle', set: { description: 'my idle' } },
    ];
    writeFileSync(path.join(dir, 'avatar.json'), formatModelJson(doc));
    writeFileSync(path.join(dir, 'source.png'), encodePNG(hana.image));
    for (let build = 0; build < 2; build++) {
      const r = await buildAvatarProject(dir, { folds: false });
      expect(r.postOps).toBe(4);
      const model = JSON.parse(readFileSync(r.modelFile, 'utf8'));
      const ids = model.animations.map((a: any) => a.id);
      expect(ids).toEqual(expect.arrayContaining(['idle', 'nod', 'look_around', 'sweep', 'wave']));
      expect(model.animations.find((a: any) => a.id === 'wave').tracks[0].keys.map((k: any) => k.v)).toEqual([0, 12, 0]);
      expect(model.animations.find((a: any) => a.id === 'idle').description).toBe('my idle');
    }
  }, 90_000);
});
