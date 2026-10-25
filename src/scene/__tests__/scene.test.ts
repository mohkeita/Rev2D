import { describe, expect, it } from 'vitest';
import { Rig } from '../../core/rig.js';
import { validateModel } from '../../core/validate.js';
import { apply } from '../../core/math.js';
import { createImage, getPixel } from '../../render/browser.js';
import type { ModelInput } from '../../core/types.js';
import {
  parseAlignment,
  resolveCue,
  resolveSceneCues,
  SceneSchema,
  parseScene,
  expandCamera,
  appearanceAt,
  projectPoint,
  CameraFollower,
  cameraAt,
  evaluateScene,
  ScenePlayer,
  validateScene,
  renderSceneFrame,
  analyzeScene,
  type SceneInput,
  type PreparedScene,
  type SceneSource,
  type SceneAssets,
  type Camera,
} from '../index.js';

function source(fill = '#ff0000'): SceneSource {
  return { width: 20, height: 20, image: createImage(20, 20, fill), textures: {}, anchor: [0, 0], scale: 1 };
}
function prepared(input: SceneInput, assets?: SceneAssets): PreparedScene {
  const scene = SceneSchema.parse(input);
  scene.camera = expandCamera(scene);
  return {
    scene,
    cues: [],
    assets: assets ?? {
      layers: Object.fromEntries(scene.layers.map((l) => [l.id, { sources: { '': source() } }])),
    },
  };
}
function rigSource(doc: Partial<ModelInput> = {}): SceneSource {
  const result = validateModel({
    format: 'rev2d',
    version: 1,
    meta: { name: 'scene-test', width: 100, height: 100 },
    ...doc,
  });
  if (!result.model) throw new Error(JSON.stringify(result.diagnostics));
  const rig = new Rig(result.model);
  return { width: 100, height: 100, rig, textures: {}, anchor: [0, 0], scale: 1 };
}
const words = [
  { word: 'Avant', start: 0, end: 0.4 },
  { word: 'Il', start: 10, end: 10.2 },
  { word: 'se', start: 10.3, end: 10.5 },
  { word: 'lève,', start: 10.5, end: 11 },
  { word: 'se', start: 12, end: 12.2 },
  { word: 'lève.', start: 12.2, end: 12.6 },
];

describe('narration alignment and cues', () => {
  it('prefers ElevenLabs normalized alignment and rebuilds word boundaries', () => {
    const text = 'Il se lève !';
    const alignment = {
      characters: [...text],
      character_start_times_seconds: [...text].map((_, i) => i / 10),
      character_end_times_seconds: [...text].map((_, i) => (i + 1) / 10),
    };
    const result = parseAlignment({ alignment: { characters: [] }, normalized_alignment: alignment });
    expect(result.diagnostics).toEqual([]);
    expect(result.words).toEqual([
      { word: 'Il', start: 0, end: 0.2 },
      { word: 'se', start: 0.3, end: 0.5 },
      { word: 'lève', start: 0.6, end: 1 },
    ]);
  });
  it('accepts word timings and rejects malformed, unordered or negative timings', () => {
    expect(parseAlignment(words).words).toEqual(words);
    for (const input of [
      { characters: ['a'] },
      [{ word: 'a', start: 1, end: 0 }],
      [{ word: 'a', start: -1, end: 1 }],
      [
        { word: 'b', start: 2, end: 3 },
        { word: 'a', start: 1, end: 2 },
      ],
    ])
      expect(parseAlignment(input).diagnostics[0]).toMatchObject({
        code: 'scene-alignment-format',
        hint: expect.any(String),
      });
  });
  it('resolves one-based words, phrases, offsets, word ends and scene-relative narration', () => {
    expect(resolveCue('@word:1', words, 10)).toBe(0);
    expect(resolveCue('@word:3@end+0.2', words, 10)).toBeCloseTo(1.2);
    expect(resolveCue('@text:SE LEVE-0.1', words, 10)).toBeCloseTo(0.2);
    expect(resolveCue('@text:se lève@end', words, 10)).toBe(1);
    expect(resolveCue('@text:se leve', words, 10, 0.3)).toBe(2);
    expect(resolveCue('@end-0.1', words, 10)).toBeCloseTo(2.5);
    expect(resolveCue('@word:0', words)).toBeNull();
  });
  it('keeps independent list cursors and resolves repeated phrases in order', () => {
    const scene = SceneSchema.parse({
      version: 1,
      duration: 3,
      narration: { offset: 10 },
      layers: [
        { id: 'a', type: 'color', color: 'red', enter: { t: '@text:se lève', type: 'fade' } },
        { id: 'b', type: 'color', color: 'blue', enter: { t: '@text:se lève', type: 'pop' } },
      ],
      tracks: [
        {
          target: 'layer:a.x',
          keys: [
            { t: '@text:se lève', v: 1 },
            { t: '@text:se lève', v: 2 },
          ],
        },
      ],
    });
    const resolved = resolveSceneCues(scene, words);
    expect(resolved.diagnostics).toEqual([]);
    expect(resolved.cues.map((c) => c.time)).toEqual([
      expect.closeTo(0.3),
      expect.closeTo(0.3),
      expect.closeTo(0.3),
      2,
    ]);
    expect(scene.layers[0].enter!.t).toBe('@text:se lève');
  });
  it('reports a missing cue with a pointer and useful word suggestions', () => {
    const result = resolveSceneCues(
      SceneSchema.parse({
        version: 1,
        duration: 3,
        tracks: [{ target: 'layer:x.x', keys: [{ t: '@text:Avan', v: 1 }] }],
      }),
      words,
    );
    expect(result.diagnostics[0]).toMatchObject({
      code: 'scene-cue-not-found',
      path: '/tracks/0/keys/0/t',
      hint: 'did you mean "Avant"?',
    });
  });
});

describe('camera and appearances', () => {
  it('applies the documented 1 / 0.5 / 0 parallax pan and zoom formula', () => {
    const scene = { width: 1000, height: 500 },
      camera = { x: 700, y: 250, zoom: 1, rotation: 0 };
    for (const [depth, displacement] of [
      [1, 200],
      [0.5, 100],
      [0, 0],
    ])
      expect(projectPoint(scene, camera, depth, [500, 250])).toEqual([500 - displacement, 250]);
    expect(projectPoint(scene, { ...camera, x: 500, zoom: 2 }, 0.5, [600, 250])).toEqual([650, 250]);
    expect(projectPoint(scene, { ...camera, x: 500, rotation: 90 }, 1, [600, 250])[1]).toBeCloseTo(150);
  });
  it('generates all numeric presets and continuous seeded shake boundaries', () => {
    for (const preset of ['static', 'slow-push', 'slow-pull', 'pan-left', 'pan-right', 'punch-in@1']) {
      const p = prepared({ version: 1, duration: 3, width: 100, height: 100, camera: preset });
      expect(cameraAt(p.scene, 0).zoom).toBeGreaterThan(0);
      expect(cameraAt(p.scene, 3).zoom).toBeGreaterThan(0);
    }
    const p = prepared({
      version: 1,
      duration: 3,
      width: 100,
      height: 100,
      camera: { shake: [{ start: 1, end: 2, amplitude: 20, frequency: 14, seed: 7 }] },
    });
    expect(cameraAt(p.scene, 1)).toEqual(cameraAt(p.scene, 2));
    expect(cameraAt(p.scene, 1.000001).x).toBeCloseTo(50, 7);
    expect(cameraAt(p.scene, 1.5)).toEqual(cameraAt(p.scene, 1.5));
    expect(cameraAt(p.scene, 1.5).x).not.toBe(50);
  });
  it('matches critical spring follow for random access, 24fps and 60fps playback', () => {
    const target = (t: number): [number, number] => [t < 0.5 ? 0 : 100, 20 * t];
    const a = new CameraFollower(target, 2),
      b = new CameraFollower(target, 2),
      c = new CameraFollower(target, 2);
    for (let i = 0; i <= 48; i++) b.at(i / 24);
    for (let i = 0; i <= 120; i++) c.at(i / 60);
    expect(a.at(2)).toEqual(b.at(2));
    expect(a.at(2)).toEqual(c.at(2));
    expect(a.at(2)[0]).toBeCloseTo(100, 3);
    expect(a.at(0.25)).toEqual(new CameraFollower(target, 2).at(0.25));
  });
  it('overshoots and settles pop while fade stays monotone and entries stay hidden', () => {
    const enter = { t: 1, type: 'pop' as const, duration: 1, overshoot: 0.15 };
    expect(appearanceAt(enter, 0.99).opacity).toBe(0);
    expect(
      Math.max(...Array.from({ length: 101 }, (_, i) => appearanceAt(enter, 1 + i / 100).scale)),
    ).toBeGreaterThan(1.05);
    expect(appearanceAt(enter, 2).scale).toBe(1);
    let previous = 0;
    for (let i = 0; i <= 100; i++) {
      const value = appearanceAt({ ...enter, type: 'fade' }, 1 + i / 100).opacity;
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
    for (const type of [
      'fade',
      'pop',
      'slide-left',
      'slide-right',
      'slide-up',
      'slide-down',
      'wipe',
      'draw-on',
    ] as const) {
      expect(appearanceAt({ ...enter, type }, 0).opacity).toBe(0);
      expect(appearanceAt({ ...enter, type }, 3, true).opacity).toBe(0);
    }
  });
});

describe('scene evaluation and pixels', () => {
  const animated = () =>
    rigSource({
      parameters: [{ id: 'Blink', min: 0, max: 1 }],
      animations: [
        {
          id: 'blink',
          duration: 2,
          tracks: [
            {
              target: 'param:Blink',
              keys: [
                { t: 0, v: 0 },
                { t: 2, v: 1 },
              ],
            },
          ],
        },
      ],
    });
  it('switches poses on the exact frame and keeps parameter animation on the scene clock', () => {
    const p = prepared(
      {
        version: 1,
        duration: 2,
        layers: [
          {
            id: 'hero',
            type: 'character',
            character: 'hero',
            poses: [
              { t: 0, pose: 'sit' },
              { t: 1, pose: 'stand' },
            ],
            animations: ['blink'],
          },
        ],
      },
      { layers: { hero: { sources: { sit: animated(), stand: animated() } } } },
    );
    const player = new ScenePlayer(p);
    expect(player.update(23 / 24).layers[0].poseId).toBe('sit');
    const frame = player.update(1).layers[0];
    expect(frame.poseId).toBe('stand');
    expect(frame.pose!.params.Blink).toBe(0.5);
    expect(player.update(25 / 24).layers[0].pose!.params.Blink).toBeCloseTo(25 / 48);
  });
  it('crossfades poses with shared time and unchanged source rigs', () => {
    const a = animated(),
      b = animated(),
      before = JSON.stringify(a.rig!.model);
    const p = prepared(
      {
        version: 1,
        duration: 2,
        layers: [
          {
            id: 'hero',
            type: 'character',
            character: 'hero',
            poses: [
              { t: 0, pose: 'a' },
              { t: 1, pose: 'b', transition: { type: 'dissolve', duration: 0.5 } },
            ],
            animations: ['blink'],
          },
        ],
      },
      { layers: { hero: { sources: { a, b } } } },
    );
    expect(evaluateScene(p, 1.25).layers.map((l) => l.opacity)).toEqual([0.5, 0.5]);
    expect(evaluateScene(p, 1.5).layers.map((l) => l.poseId)).toEqual(['b']);
    expect(JSON.stringify(a.rig!.model)).toBe(before);
  });
  it('keeps each pose physics player continuous through pose changes', () => {
    const physics = () =>
      rigSource({
        parameters: [
          { id: 'X', min: -100, max: 100 },
          { id: 'Sway', min: -90, max: 90 },
        ],
        animations: [
          {
            id: 'jerk',
            duration: 3,
            tracks: [
              {
                target: 'param:X',
                keys: [
                  { t: 0, v: 0, ease: 'step' },
                  { t: 0.5, v: 50 },
                ],
              },
            ],
          },
        ],
        physics: [
          {
            id: 'hair',
            inputs: [{ param: 'X', type: 'x' }],
            outputs: [{ param: 'Sway', type: 'angle' }],
            segments: [{ length: 40 }],
            damping: 0.1,
          },
        ],
      });
    const a = physics(),
      b = physics(),
      baseline = b.rig!.player();
    const p = prepared(
      {
        version: 1,
        duration: 3,
        layers: [
          {
            id: 'hero',
            type: 'character',
            character: 'hero',
            poses: [
              { t: 0, pose: 'a' },
              { t: 1, pose: 'b' },
            ],
            animations: ['jerk'],
          },
        ],
      },
      { layers: { hero: { sources: { a, b } } } },
    );
    const player = new ScenePlayer(p);
    let moved = false;
    for (let i = 0; i <= 120; i++) {
      const time = i / 60,
        expected = baseline.update({ time, animations: ['jerk'] }).params.Sway;
      expect(player.update(time).layers[0].pose!.params.Sway).toBe(expected);
      moved ||= Math.abs(expected) > 0.1;
    }
    expect(moved).toBe(true);
  });
  it('applies background anchors, their scale, and attached model points', () => {
    const hero = rigSource({
      bones: [{ id: 'head' }],
      animations: [
        {
          id: 'move',
          duration: 1,
          loop: false,
          tracks: [
            {
              target: 'bone:head.x',
              keys: [
                { t: 0, v: 0 },
                { t: 1, v: 20 },
              ],
            },
          ],
        },
      ],
    });
    hero.points = { head: { at: [10, 10], parent: 'bone:head' } };
    const p = prepared(
      {
        version: 1,
        duration: 1,
        layers: [
          { id: 'room', type: 'image', src: 'room.png', scale: 2 },
          { id: 'hero', type: 'model', src: 'hero.json', at: 'room.seat', animations: ['move'] },
          { id: 'idea', type: 'image', src: 'idea.png', attach: 'hero.head', offset: [3, -2] },
        ],
      },
      {
        layers: {
          room: { sources: { '': source() }, anchors: { seat: { at: [30, 40], scale: 0.5 } } },
          hero: { sources: { '': hero } },
          idea: { sources: { '': source() } },
        },
      },
    );
    const frame = evaluateScene(p, 1);
    expect(apply(frame.layers[1].matrix, 0, 0)).toEqual([60, 80]);
    expect(apply(frame.layers[2].matrix, 0, 0)).toEqual([93, 88]);
  });
  it('composes sorted layers, opacity and deterministic wipe pixels', () => {
    const p = prepared(
      {
        version: 1,
        width: 40,
        height: 40,
        duration: 2,
        background: 'white',
        layers: [
          { id: 'red', type: 'image', src: 'a', x: 10, y: 10, z: 2, opacity: 0.5 },
          { id: 'blue', type: 'image', src: 'b', x: 10, y: 10, z: 1 },
        ],
      },
      { layers: { red: { sources: { '': source('red') } }, blue: { sources: { '': source('blue') } } } },
    );
    expect(getPixel(renderSceneFrame(p, 0), 15, 15)).toEqual([128, 0, 128, 255]);
    p.scene.layers[0].opacity = 1;
    p.scene.layers[0].enter = { type: 'wipe', t: 0, duration: 1, overshoot: 0 };
    const a = renderSceneFrame(p, 0.5),
      b = renderSceneFrame(p, 0.5);
    expect(a.data).toEqual(b.data);
    expect(getPixel(a, 15, 15)).toEqual([255, 0, 0, 255]);
    expect(getPixel(a, 25, 15)).toEqual([0, 0, 255, 255]);
  });
  it('detects reveal intervals and their maximum overflow at the requested fps', () => {
    const p = prepared({
      version: 1,
      width: 100,
      height: 100,
      fps: 10,
      duration: 2,
      layers: [{ id: 'room', type: 'background', ref: 'room' }],
      camera: {
        keys: [
          { t: 0, x: 50, y: 50 },
          { t: 2, x: 250, y: 50 },
        ],
      },
    });
    p.assets.layers.room.sources[''] = { ...source(), width: 100, height: 100 };
    const note = analyzeScene(p).diagnostics.find((d) => d.code === 'scene-camera-reveal')!;
    expect(note.intervals).toEqual([[0.1, 2]]);
    expect(note.max).toBeCloseTo(190);
    p.scene.layers[0].depth = 0;
    expect(analyzeScene(p).diagnostics.some((d) => d.code === 'scene-camera-reveal')).toBe(false);
  });
  it('keeps model masks effective while revealing geometry and flipping layers', () => {
    const source = rigSource({
      parts: [
        { id: 'mask', visible: false, shape: { type: 'rect', x: 0, y: 0, w: 50, h: 100 }, fill: 'white' },
        { id: 'body', mask: ['mask'], shape: { type: 'rect', x: 0, y: 0, w: 100, h: 100 }, fill: 'red' },
      ],
    });
    const p = prepared(
      {
        version: 1,
        width: 100,
        height: 100,
        duration: 1,
        background: 'white',
        layers: [
          {
            id: 'masked',
            type: 'model',
            src: 'model',
            flip: true,
            x: 100,
            enter: { type: 'wipe', t: 0, duration: 1 },
          },
        ],
      },
      { layers: { masked: { sources: { '': source } } } },
    );
    const image = renderSceneFrame(p, 0.5);
    expect(getPixel(image, 75, 50)).toEqual([255, 0, 0, 255]);
    expect(getPixel(image, 25, 50)).toEqual([255, 255, 255, 255]);
  });
  it('reports cropped bubbles, offscreen layers, overlaps and fast camera motion with intervals', () => {
    const p = prepared(
      {
        version: 1,
        width: 100,
        height: 100,
        fps: 10,
        duration: 1,
        layers: [
          { id: 'a', type: 'character', character: 'a', poses: [{ t: 0, pose: 'standing' }] },
          { id: 'b', type: 'character', character: 'b', poses: [{ t: 0, pose: 'standing' }] },
          { id: 'bubble', type: 'bubble', ref: 'thought', x: -10 },
          { id: 'hidden', type: 'image', src: 'offscreen', x: 500 },
        ],
        camera: {
          keys: [
            { t: 0, x: 50, y: 50 },
            { t: 1, x: 250, y: 50 },
          ],
        },
      },
      {
        layers: {
          a: { sources: { standing: source() } },
          b: { sources: { standing: source() } },
          bubble: { sources: { '': source() } },
          hidden: { sources: { '': source() } },
        },
      },
    );
    const notes = analyzeScene(p).diagnostics;
    expect(notes.map((n) => n.code)).toEqual(
      expect.arrayContaining([
        'scene-overlap',
        'scene-bubble-offscreen',
        'scene-layer-offscreen',
        'scene-camera-fast',
      ]),
    );
    expect(notes.every((n) => n.intervals.length > 0 && n.hint)).toBe(true);
  });
  it('validates formats, dangling references, duplicate ids, cycles and track targets', () => {
    expect(parseScene({ version: 1, duration: 1, fps: 121 }).diagnostics[0].code).toBe('scene-fps-range');
    expect(parseScene({ version: 1, duration: 1, width: 4000 }).diagnostics[0].code).toBe('scene-size-range');
    expect(parseScene({ version: 1, duration: 1, width: 1080, height: 1920 }).diagnostics).toEqual([]);
    const p = prepared({
      version: 1,
      duration: 1,
      layers: [
        { id: 'a', type: 'image', src: 'a', attach: 'b.point:0,0' },
        { id: 'b', type: 'image', src: 'b', attach: 'a.point:0,0' },
        { id: 'a', type: 'image', src: 'a', at: 'missing.anchor' },
      ],
      tracks: [{ target: 'layer:a.color', keys: [{ t: 0, v: 1 }] }],
      camera: { follow: { layer: 'missing' } },
    });
    const diags = validateScene(p.scene, p.assets);
    expect(diags.map((d) => d.code)).toEqual(
      expect.arrayContaining([
        'scene-duplicate-id',
        'scene-unknown-layer',
        'scene-attachment-cycle',
        'scene-track-target',
      ]),
    );
    expect(diags.every((d) => d.path.startsWith('/') && d.hint)).toBe(true);
  });
});
