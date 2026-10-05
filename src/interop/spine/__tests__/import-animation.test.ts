import { describe, expect, it } from 'vitest';
import { importSpine } from '../index.js';
import { invert, multiply } from '../../../core/math.js';
import { animation, bezierRef, canvasOf, codes, expectClose, fixtureText, load, makeImage, part, render, track } from './helpers.js';

const heroPage = makeImage(64, 32, () => [255, 255, 255, 255]);
const hero = () => importSpine({ skeleton: fixtureText('hero-4x.json'), atlas: fixtureText('hero.atlas'), pages: { 'hero.png': heroPage } });
const legacyPage = makeImage(32, 32, () => [255, 255, 255, 255]);
const legacy = () => importSpine({ skeleton: fixtureText('legacy-3x.json'), atlas: fixtureText('legacy.atlas'), pages: { 'legacy.png': legacyPage } });
// Looping animations wrap at t = duration (back to t = 0), so sample just before the end.
const TIMES = [...Array.from({ length: 20 }, (_, i) => i / 20), 0.999];

describe('spine import: bone timelines', () => {
  const res = hero();
  const { rig } = load(res);
  const at = (t: number) => rig.pose({ animations: ['move'], time: t });

  it('converts relative rotate keys with 4.x bezier curves into absolute rotations (y flip: negated)', () => {
    for (const t of TIMES) {
      const expected = -bezierRef(0, 0, 0.25, 0, 0.5, 45, 1, 90, t);
      expect(at(t).bones.hip.local.rotation).toBeCloseTo(expected, 3);
    }
  });

  it('keeps separate curves for x and y and flips translate y', () => {
    for (const t of TIMES) {
      const p = at(t).bones.hip.local;
      expect(p.x).toBeCloseTo(bezierRef(0, 0, 0.3, 0, 0.6, 10, 1, 10, t), 3);
      expect(p.y).toBeCloseTo(-40 - bezierRef(0, 0, 0.2, 0, 0.8, 20, 1, 20, t), 3);
    }
  });

  it('multiplies scale keys with the setup scale and shows the setup pose before the first key', () => {
    expect(track(res.doc, 'move', 'bone:hip.scaleX')).toEqual([
      { t: 0, v: 1, ease: 'step' },
      { t: 0.5, v: 2 },
      { t: 1, v: 1 },
    ]);
    expect(at(0.25).bones.hip.local.scaleX).toBe(1);
    expect(at(0.75).bones.hip.local.scaleX).toBeCloseTo(1.5, 12);
    expect(at(0.75).bones.hip.local.scaleY).toBeCloseTo(0.75, 12);
    // Single-axis timelines (torso is sheared: its translation lives on "torso-shear").
    expect(at(0.5).bones['torso-shear'].local.x).toBeCloseTo(0, 12);
    expect(at(0).bones['torso-shear'].local.x).toBeCloseTo(3, 12);
    expect(at(0.3).bones.torso.scaleY).toBeCloseTo(1.5, 3);
  });

  it('splits curves that bulge between equal values so the motion is kept', () => {
    const keys = track(res.doc, 'move', 'bone:head.rotation')!;
    expect(keys.length).toBeGreaterThan(2);
    for (const t of TIMES) expect(at(t).bones.head.local.rotation).toBeCloseTo(15 - bezierRef(0, 10, 0.2, 30, 0.8, 30, 1, 10, t), 3);
    expect(at(0.5).bones.head.local.rotation).toBeCloseTo(15 - 25, 3);
  });

  it('reproduces shear timelines with a scale bone and a rotation bone', () => {
    expect(res.report.issues.find((i) => i.code === 'spine-bone-shear-pair' && i.where === 'bones[2] (torso)')?.message).toMatch(/animated in 1 animation/);
    expect(codes(res)).not.toContain('spine-timeline-shear');
    // Torso relative to hip = the Spine local transform (translatex 3 -> -3, rotation 90, shearX 5,
    // scaleY 1.5), mapped to Rev2D (y flipped).
    for (const t of [0.1, 0.3, 0.6, 0.9]) {
      const p = at(t);
      const rel = multiply(invert(p.bones.hip.world), p.bones.torso.world);
      const x = 3 - 6 * t;
      const c = Math.cos(((90 + 5) * Math.PI) / 180);
      const s = Math.sin(((90 + 5) * Math.PI) / 180);
      // Spine local: x axis (cos 95°, sin 95°), y axis 1.5 · (cos 180°, sin 180°); Rev2D = F · L · F.
      expectClose(rel, [c, -s, 1.5, 0, x, 0], 2e-3);
    }
  });

  it('bakes a translate-only transform constraint whose target moves', () => {
    // back-shoulder follows front-shoulder with mix -1: it moves the opposite way.
    for (const t of [0, 0.25, 0.5, 0.999]) {
      const p = at(t);
      expect(p.bones['front-shoulder'].local.y).toBeCloseTo(-(10 + 10 * t), 6);
      expect(p.bones['back-shoulder'].local.y).toBeCloseTo(10 + 10 * t, 6);
      expect(p.bones['back-shoulder'].local.x).toBeCloseTo(30, 6);
    }
  });

  it('uses the last key time as the duration and loops animations that end where they start', () => {
    expect(animation(res.doc, 'move')).toMatchObject({ duration: 1, loop: false });
    expect(animation(res.doc, 'soft').duration).toBe(2);
    expect(res.report.issues.find((i) => i.code === 'spine-animation-once' && i.where === 'animations.move')).toBeDefined();
    const cycle = importSpine({
      skeleton: {
        bones: [{ name: 'root' }, { name: 'b', parent: 'root' }],
        animations: { walk: { bones: { b: { rotate: [{ value: 5 }, { time: 0.5, value: -5 }, { time: 1, value: 5 }] } } } },
      },
    });
    expect(animation(cycle.doc, 'walk').loop).toBe(true);
  });
});

describe('spine import: slot timelines', () => {
  const res = hero();
  const { rig } = load(res);
  const at = (t: number) => rig.pose({ animations: ['move'], time: t });

  it('switches attachments with stepped opacity keys', () => {
    expect(track(res.doc, 'move', 'part:head__head.opacity')).toEqual([
      { t: 0, v: 1, ease: 'step' },
      { t: 0.5, v: 0, ease: 'step' },
    ]);
    expect(track(res.doc, 'move', 'part:head__head-alt.opacity')).toEqual([
      { t: 0, v: 0, ease: 'step' },
      { t: 0.5, v: 128 / 255, ease: 'step' },
      { t: 0.75, v: 0, ease: 'step' },
    ]);
    expect(at(0.4).drawOrder).toContain('head__head');
    expect(at(0.6).drawOrder).toContain('head__head-alt');
    expect(at(0.6).drawOrder).not.toContain('head__head');
    expect(at(0.8).drawOrder.filter((id) => id.startsWith('head'))).toEqual([]);
  });

  it('turns color timelines into tint (times the attachment color) and opacity', () => {
    expect(track(res.doc, 'move', 'part:head__head.tint')).toEqual([{ t: 0, v: '#ff0000' }, { t: 1, v: '#0000ff' }]);
    expect(track(res.doc, 'move', 'part:head__head-alt.tint')).toEqual([{ t: 0, v: '#ff0000' }, { t: 1, v: '#000000' }]);
    expectClose(at(0.5).parts.head__head.tint, [128 / 255, 0, 128 / 255, 1], 0.003);
    expect(at(0.25).parts.body__body.opacity).toBeCloseTo(0.75, 9);
    expect(track(res.doc, 'move', 'part:body__body-linked.opacity')).toBeUndefined();
    // Two-color tint: the light color is imported, the dark one reported.
    expect(track(res.doc, 'move', 'part:skin.tint')).toEqual([{ t: 0, v: '#ffffff' }, { t: 1, v: '#808080' }]);
    expect(res.report.issues.some((i) => i.code === 'spine-dark-color' && i.where === 'animations.move.slots.skin.rgba2')).toBe(true);
  });

  it('keeps the alpha in the tint when a slot animates both alpha and attachment', () => {
    const skeleton = {
      skeleton: { spine: '4.2.0' },
      bones: [{ name: 'root' }],
      slots: [{ name: 's', bone: 'root', attachment: 'a', color: 'ffffff80' }],
      skins: [{ name: 'default', attachments: { s: { a: { width: 10, height: 10 }, b: { width: 10, height: 10 } } } }],
      animations: {
        fade: {
          slots: {
            s: {
              attachment: [{ time: 0.5, name: 'b' }],
              rgba: [{ color: 'ffffffff', curve: [0.25, 1, 0.75, 1, 0.25, 1, 0.75, 1, 0.25, 1, 0.75, 1, 0.25, 1, 0.75, 0] }, { time: 1, color: 'ffffff00' }],
            },
          },
        },
      },
    };
    const res2 = importSpine({ skeleton });
    expect(codes(res2)).toContain('spine-slot-alpha-in-tint');
    expect(part(res2.doc, 's__a')).toMatchObject({ tint: '#ffffff80' });
    expect(part(res2.doc, 's__a').opacity).toBeUndefined();
    expect(part(res2.doc, 's__b')).toMatchObject({ tint: '#ffffff80', opacity: 0 });
    expect(track(res2.doc, 'fade', 'part:s__b.opacity')).toEqual([
      { t: 0, v: 0, ease: 'step' },
      { t: 0.5, v: 1, ease: 'step' },
    ]);
    expect(track(res2.doc, 'fade', 'part:s__b.tint')).toEqual([
      { t: 0, v: '#ffffffff', ease: [0.25, 0, 0.75, 1] },
      { t: 1, v: '#ffffff00' },
    ]);
    const { rig } = load(res2);
    const p = rig.pose({ animations: ['fade'], time: 0.75 });
    expect(p.parts.s__b.opacity).toBe(1);
    expect(p.parts.s__b.tint[3]).toBeCloseTo(bezierRef(0, 1, 0.25, 1, 0.75, 0, 1, 0, 0.75), 2);
  });

  it('samples color keys whose channels use different curves', () => {
    const skeleton = {
      skeleton: { spine: '4.2.0' },
      bones: [{ name: 'root' }],
      slots: [{ name: 's', bone: 'root', attachment: 'a' }],
      skins: [{ name: 'default', attachments: { s: { a: { width: 10, height: 10 } } } }],
      animations: { c: { slots: { s: { rgb: [{ color: 'ff0000', curve: [0.1, 0.1, 0.2, 0, 0.8, 0, 0.9, 1, 0, 0, 1, 0] }, { time: 1, color: '00ff00' }] } } } },
    };
    const res2 = importSpine({ skeleton });
    expect(codes(res2)).toContain('spine-color-curve-sampled');
    const { rig } = load(res2);
    for (const t of [0.2, 0.5, 0.8]) {
      const tint = rig.pose({ animations: ['c'], time: t }).parts.s.tint;
      expect(tint[0]).toBeCloseTo(bezierRef(0, 1, 0.1, 0.1, 0.2, 0, 1, 0, t), 1);
      expect(tint[1]).toBeCloseTo(bezierRef(0, 0, 0.8, 0, 0.9, 1, 1, 1, t), 1);
    }
  });

  it('switches toggled clipping masks between the clip outline and an open polygon', () => {
    const keys = track(res.doc, 'move', 'part:clip.shape.points')!;
    const real = part(res.doc, 'clip').shape.points;
    expect(keys.map((k) => [k.t, k.ease])).toEqual([
      [0, 'step'],
      [0.5, 'step'],
      [0.9, 'step'],
    ]);
    expect(keys[0].v).toEqual(real);
    expect(keys[2].v).toEqual(real);
    // The open polygon lies far outside the canvas all around.
    const open = keys[1].v as number[];
    expect(open).toHaveLength(real.length);
    for (let i = 0; i < open.length; i += 2) expect(Math.hypot(open[i] - 82, open[i + 1] - 112)).toBeGreaterThan(500);
  });
});

describe('spine import: deform, draw order, events, IK', () => {
  const res = hero();
  const { rig } = load(res);
  const toCanvas = canvasOf(res.doc);

  it('converts deform keys of unweighted meshes (and their linked meshes) to absolute vertices', () => {
    const keys = track(res.doc, 'move', 'part:body__body.shape.vertices')!;
    const setup = part(res.doc, 'body__body').shape.vertices as number[];
    // Vertex 1 is offset by (5, 0) in the torso's frame = (0, 5) in Spine space = (0, -5) on the canvas.
    const moved = setup.slice();
    moved[3] -= 5;
    expect(keys).toEqual([
      { t: 0, v: moved, ease: [0.25, 0, 0.75, 1] },
      { t: 1, v: setup },
    ]);
    expect(track(res.doc, 'move', 'part:body__body-linked.shape.vertices')).toEqual(keys);
    const pose = rig.pose({ animations: ['move'], time: 0 });
    expect(pose.properties['part:body__body.shape.vertices']).toEqual(moved);
  });

  it('converts deform keys of weighted meshes through each influence bone', () => {
    const keys = track(res.doc, 'move', 'part:skin.shape.vertices')!;
    const setup = part(res.doc, 'skin').shape.vertices as number[];
    expect(keys[0]).toEqual({ t: 0, v: setup });
    // Vertex 1: hip-local (0, 5) -> (0, 5); torso-local (0, 5) -> (-5, 0); weighted 50/50 -> (-2.5, 2.5).
    const expected = setup.slice();
    const [x, y] = toCanvas(10 - 2.5, 40 + 2.5);
    expected[2] = x;
    expected[3] = y;
    expectClose(keys[1].v, expected, 1e-9);
  });

  it('turns draw order keys into stepped z keys', () => {
    expect(track(res.doc, 'move', 'part:head__head.z')).toEqual([
      { t: 0, v: 4, ease: 'step' },
      { t: 0.5, v: 1, ease: 'step' },
      { t: 1, v: 4, ease: 'step' },
    ]);
    expect(track(res.doc, 'move', 'part:body__body.z')?.map((k) => k.v)).toEqual([1, 2, 1]);
    expect(track(res.doc, 'move', 'part:clip.z')?.map((k) => k.v)).toEqual([3, 4, 3]);
    expect(track(res.doc, 'move', 'part:back.z')).toBeUndefined();
    const order = rig.pose({ animations: ['move'], time: 0.6 }).drawOrder;
    expect(order.indexOf('head__head-alt')).toBeLessThan(order.indexOf('body__body'));
  });

  it('converts events with their data (key values over event defaults)', () => {
    expect(animation(res.doc, 'move').events).toEqual([
      { t: 0.25, name: 'step', data: { int: 3, string: 'hi' } },
      { t: 0.75, name: 'sound', data: { audio: 'a.ogg', volume: 0.5 } },
    ]);
    expect(rig.pose({ animations: ['move'], time: 0.25 }).events).toEqual([{ animation: 'move', name: 'step', t: 0.25, data: { int: 3, string: 'hi' } }]);
  });

  it('converts IK mix keys exactly', () => {
    expect(track(res.doc, 'move', 'ik:arm-ik.mix')).toEqual([
      { t: 0, v: 1, ease: [0.25, 0, 0.75, 1] },
      { t: 1, v: 0 },
    ]);
  });

  it('blends IK variants for animated softness and switches them for bend changes', () => {
    // Play "soft" once (not looping) so t = 2 shows its last key.
    const once = { ...res.doc, animations: (res.doc.animations as Array<Record<string, unknown>>).map((a) => ({ ...a, loop: false })) };
    const onceRig = load({ ...res, doc: once }).rig;
    const ids = (res.doc.ik as Array<{ id: string }>).map((k) => k.id).filter((id) => id.startsWith('arm-ik'));
    const mixes = (t: number) => {
      const p = onceRig.pose({ animations: ['soft'], time: t }).properties;
      return Object.fromEntries(ids.map((id) => [id, (p[`ik:${id}.mix`] as number | undefined) ?? (id === 'arm-ik' ? 1 : 0)]));
    };
    const on = (t: number) => Object.entries(mixes(t)).filter(([, m]) => m > 1e-9).map(([id]) => id);
    expect(on(0)).toEqual(['arm-ik']);
    // The last fully mixed variant wins (Rev2D solves constraints in order); at t = 1 it is softness 20.
    expect(on(1).at(-1)).toBe('arm-ik__s20');
    expect(mixes(1)['arm-ik__s20']).toBeCloseTo(1, 9);
    expect(on(2)).toEqual(['arm-ik__flip']);
    // Regression (spineboy-pro "run"): while softness is interpolated, the blended variants must
    // match one constraint solved at that softness, not a blend of the key values' solutions
    // (4 and 20 px blended at 12 px would be about 1 degree off).
    const doc = res.doc as { ik: Array<Record<string, unknown>> };
    const solvedAt = (softness: number) => {
      const ik = doc.ik.filter((k) => !String(k.id).includes('__')).map((k) => (k.id === 'arm-ik' ? { ...k, softness, mix: 1 } : k));
      return load({ ...res, doc: { ...res.doc, ik, animations: [] } }).rig.pose();
    };
    for (const t of [0.1, 0.3, 0.5, 0.62, 0.9, 1.4]) {
      const softness = t <= 1 ? 4 + 16 * t : 20 - 16 * (t - 1);
      const got = onceRig.pose({ animations: ['soft'], time: t }).bones;
      const want = solvedAt(softness).bones;
      for (const b of ['upper_arm', 'fore-arm']) {
        expect(Math.abs(got[b].rotation - want[b].rotation), `${b} at ${t}`).toBeLessThan(0.05);
        expect(Math.hypot(got[b].x - want[b].x, got[b].y - want[b].y), `${b} at ${t}`).toBeLessThan(0.05);
      }
    }
    // The flipped variant bends the elbow to the other side.
    const elbow = (t: number) => onceRig.pose({ animations: ['soft'], time: t }).bones['fore-arm'];
    const target = rig.pose().bones['hand-target'];
    const root = rig.pose().bones.upper_arm;
    const side = (b: { x: number; y: number }) => Math.sign((target.x - root.x) * (b.y - root.y) - (target.y - root.y) * (b.x - root.x));
    expect(side(elbow(0))).toBe(-side(elbow(2)));
  });

  it('reports constraint timelines it cannot convert', () => {
    for (const where of ['animations.move.path.p', 'animations.move.physics.phys']) {
      expect(res.report.issues.some((i) => i.where === where && i.severity === 'warning')).toBe(true);
    }
    // The transform constraint (and its timeline) is emulated.
    expect(res.report.issues.some((i) => i.where === 'animations.move.transform.other')).toBe(false);
    expect(res.report.issues.find((i) => i.code === 'spine-transform-emulated')?.where).toBe('transform[1] (other)');
  });
});

describe('spine import: Spine 3.x files', () => {
  const res = legacy();
  const l = load(res);
  const at = (t: number) => l.rig.pose({ animations: ['wave'], time: t });

  it('reads 3.8 skeletons with the legacy atlas and computes bounds from the attachments', () => {
    expect(res.doc.meta).toMatchObject({ name: 'spine', description: 'Imported from Spine 3.8.99 (skin "default")' });
    const toCanvas = canvasOf(res.doc);
    // Body mesh spans x -12..12, y 0..24 -> canvas with 32 px padding.
    expect(part(res.doc, 'body').shape.vertices).toEqual([...toCanvas(-12, 0), ...toCanvas(12, 0), ...toCanvas(12, 24), ...toCanvas(-12, 24)]);
    // Rotated, whitespace-stripped legacy region: content x 1..9, y 0..12 of the 10 x 14 image.
    expectClose(part(res.doc, 'arm').shape.uvs, [14 / 32, 10 / 32, 2 / 32, 10 / 32, 2 / 32, 2 / 32, 14 / 32, 2 / 32], 1e-12);
    expect(res.report.issues.find((i) => i.code === 'spine-bone-inherit-baked')?.where).toBe('bones[2] (hand)');
    expect(codes(res)).not.toContain('spine-version-old');
    expect(render(l).image.width).toBe(res.doc.meta && (res.doc.meta as { width: number }).width);
  });

  it('interpolates 3.x rotations the short way with normalized curves', () => {
    // 170 -> -170 turns +20 degrees (not -340): Rev2D -45-170 = -215 -> -235 with ease [0.25, 0, 0.75, 1].
    expect(track(res.doc, 'wave', 'bone:arm.rotation')).toEqual([
      { t: 0, v: -215, ease: [0.25, 0, 0.75, 1] },
      { t: 1, v: -235 },
    ]);
    expect(at(0.5).bones.arm.local.rotation).toBeCloseTo(-225, 6);
    expect(at(0.4).bones.arm.local.x).toBe(5);
    expect(at(0.5).bones.arm.local.x).toBe(9);
    expect(at(0.5).bones.arm.local.y).toBe(-7);
  });

  it('reads 3.x color, deform, draw order and event timelines', () => {
    expect(part(res.doc, 'arm').opacity).toBeCloseTo(128 / 255, 12);
    expect(track(res.doc, 'wave', 'part:arm.tint')).toEqual([
      { t: 0, v: '#ffffff', ease: 'step' },
      { t: 0.5, v: '#ff0000' },
    ]);
    expect(track(res.doc, 'wave', 'part:arm.opacity')).toEqual([
      { t: 0, v: 1, ease: 'step' },
      { t: 0.5, v: 128 / 255 },
    ]);
    const deform = track(res.doc, 'wave', 'part:body.shape.vertices')!;
    expect(deform[0].ease).toEqual([0.5, 0, 0.5, 1]);
    const setup = part(res.doc, 'body').shape.vertices as number[];
    expect(deform[1].v).toEqual(setup.map((v, i) => (i >= 4 && i % 2 === 1 ? v - 6 : v)));
    expect(track(res.doc, 'wave', 'part:body.z')).toEqual([
      { t: 0, v: 0, ease: 'step' },
      { t: 0.5, v: 1, ease: 'step' },
    ]);
    expect(animation(res.doc, 'wave').events).toEqual([{ t: 0.5, name: 'hit', data: { float: 0.5 } }]);
  });

  it('reads 3.7 array curves and guesses the version of files that do not name it', () => {
    const skeleton = (spine?: string) => ({
      skeleton: spine ? { spine } : {},
      bones: [{ name: 'root' }, { name: 'b', parent: 'root' }],
      animations: { a: { bones: { b: { rotate: [{ time: 0, angle: 0, curve: [0.25, 0, 0.75, 1] }, { time: 1, angle: 90 }] } } } },
    });
    const old = importSpine({ skeleton: skeleton('3.7.94') });
    expect(track(old.doc, 'a', 'bone:b.rotation')).toEqual([
      { t: 0, v: 0, ease: [0.25, 0, 0.75, 1] },
      { t: 1, v: -90 },
    ]);
    const guessed = importSpine({ skeleton: skeleton() });
    expect(codes(guessed)).toContain('spine-version-unknown');
    expect(track(guessed.doc, 'a', 'bone:b.rotation')).toEqual(track(old.doc, 'a', 'bone:b.rotation'));
  });
});
