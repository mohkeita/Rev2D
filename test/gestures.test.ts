import { describe, it, expect } from 'vitest';
import { validateModel } from '../src/core/validate.js';
import { Rig } from '../src/core/rig.js';
import { parseAvatarSpec, buildAvatarLayers, compileAvatar } from '../src/avatar/index.js';
import { fullFigureAvatarDoc, figureFixture } from './fixtures/studio.js';
import {
  GESTURES,
  EXPRESSIONS,
  generateGesture,
  generateExpression,
  generateIdle,
  actKeys,
} from '../src/gestures/index.js';
import { analyzeAnimation } from '../src/api/analyze.js';
import type { LoadedModel } from '../src/node/load.js';
import { compileSceneActing, parseScene, evaluateScene } from '../src/scene/index.js';

const spec = parseAvatarSpec(fullFigureAvatarDoc()).spec!;
const layers = buildAvatarLayers(spec, figureFixture('standing').image),
  doc = compileAvatar(spec, layers.meta).doc,
  model = validateModel(doc).model!;
const textureImages = Object.fromEntries(layers.meta.layers.map((l) => [l.id, layers.images[l.file]]));

describe('acting motion', () => {
  it('anticipates in the opposite direction, overshoots, settles and optionally releases', () => {
    for (const to of [10, -10]) {
      const curve = actKeys({ from: 0, to, duration: 0.5, settle: 0.3, hold: 1 });
      expect(curve.keys[1].v * to).toBeLessThan(0);
      expect(curve.keys[2].v / to).toBeGreaterThan(1);
      expect(curve.keys.at(-1)!.v).toBeCloseTo(to, 5);
      const release = actKeys({ from: 3, to, release: 0.4 });
      expect(release.keys.at(-1)!.v).toBe(3);
    }
    expect(() => actKeys({ from: 0, to: 1, settle: 0 })).toThrow();
  });
  for (const [kind, catalog, generate] of [
    ['gesture', GESTURES, generateGesture],
    ['expression', EXPRESSIONS, generateExpression],
  ] as const) {
    for (const name of Object.keys(catalog))
      it(`${kind} ${name} validates and analyzes without motion notes`, async () => {
        const { animation, diagnostics } = generate(model, name);
        const result = validateModel({ ...doc, animations: [animation] });
        expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
        expect(diagnostics.every((d) => d.code === 'gesture-missing-param' && d.severity === 'warning')).toBe(
          true,
        );
        const normalized = result.model!,
          textureInfo = Object.fromEntries(
            Object.entries(textureImages).map(([id, p]) => [id, { width: p.width, height: p.height }]),
          );
        const loaded: LoadedModel = {
          file: null,
          baseDir: '.',
          model: normalized,
          rig: new Rig(normalized, { textures: textureInfo }),
          diagnostics: result.diagnostics,
          textures: textureImages,
          textureInfo,
        };
        const analysis = analyzeAnimation(loaded, { animation: animation.id, pixels: false, physics: false });
        expect(analysis.notes).toEqual([]);
      });
  }
  it('skips absent controls, suggests unknown names and rejects non-finite options', () => {
    const missing = generateGesture(model, 'count');
    expect(missing.diagnostics.some((d) => d.code === 'gesture-missing-param')).toBe(true);
    expect(
      missing.animation.tracks.every((t) => model.parameters.some((p) => 'param:' + p.id === t.target)),
    ).toBe(true);
    expect(() => generateGesture(model, 'point_rigth')).toThrow('unknown gesture');
    for (const options of [{ t: NaN }, { hold: Infinity }, { duration: 0 }, { intensity: 2 }])
      expect(() => generateGesture(model, 'voila', options)).toThrow();
  });
  it('idle is seeded, non-periodic, includes double blinks and stays inside ranges for 60 seconds', () => {
    const idle = generateIdle(model, 'C1:P010'),
      other = generateIdle(model, 'C2:P010');
    expect(generateIdle(model, 'C1:P010')).toEqual(idle);
    expect(other).not.toEqual(idle);
    const times = (idle.animation.events ?? []).map((e) => e.t),
      intervals = times.map((t, i) => t - (times[i - 1] ?? 0));
    expect(intervals.length).toBeGreaterThan(8);
    expect(intervals.every((v) => v >= 2 && v <= 6)).toBe(true);
    expect(new Set(intervals.map((v) => v.toFixed(2))).size).toBeGreaterThan(5);
    expect((idle.animation.events ?? []).some((e) => (e.data as { double: boolean }).double)).toBe(true);
    expect(
      validateModel({ ...doc, animations: [idle.animation] }).diagnostics.filter(
        (d) => d.severity === 'error',
      ),
    ).toEqual([]);
    for (const track of idle.animation.tracks) {
      const p = model.parameters.find((p) => 'param:' + p.id === track.target)!;
      for (const k of track.keys) {
        expect(k.v).toBeGreaterThanOrEqual(p.min);
        expect(k.v).toBeLessThanOrEqual(p.max);
      }
    }
  });
  it('scene acting uses independent in-memory rigs and leaves the source model unchanged', () => {
    const rig = new Rig(model),
      source = {
        width: 360,
        height: 480,
        rig,
        textures: textureImages,
        anchor: [180, 480] as [number, number],
        scale: 1,
      };
    const parsed = parseScene({
      version: 1,
      id: 'P010',
      width: 720,
      height: 480,
      duration: 4,
      fps: 12,
      layers: [
        {
          id: 'C1',
          type: 'model',
          src: 'figure.json',
          x: 180,
          y: 480,
          animations: [
            'idle_alive',
            { gesture: 'point_right', t: 1 },
            { expression: 'shocked', t: 2, hold: 1 },
          ],
        },
      ],
    });
    expect(parsed.diagnostics).toEqual([]);
    const original = JSON.stringify(model);
    const result = compileSceneActing(parsed.scene!, { layers: { C1: { sources: { '': source } } } });
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(result.assets.layers.C1.sources[''].rig).not.toBe(rig);
    expect(JSON.stringify(model)).toBe(original);
    expect(source.rig.model).toBe(model);
    const evaluated = evaluateScene({ scene: result.scene, assets: result.assets, cues: [] }, 2.6);
    expect(evaluated.layers[0].pose!.params.EyeWide).toBeGreaterThan(0.5);
    expect(JSON.stringify(model)).toBe(original);
  });
});
