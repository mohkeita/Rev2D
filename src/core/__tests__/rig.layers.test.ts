import { describe, expect, it } from 'vitest';
import type { ModelInput, PoseOptions } from '../types.js';
import { expectNear, fillOf, makeRig, quad, vertex } from './rig.fixtures.js';

type Anim = NonNullable<ModelInput['animations']>[number];

const PARAMS = [
  { id: 'AngleX', min: -30, max: 30 },
  { id: 'Mouth', min: 0, max: 1 },
  { id: 'Eye', min: 0, max: 1, default: 1 },
  { id: 'P', min: -100, max: 100 },
  { id: 'Q', min: -100, max: 100 },
];

/** Idle: head sways -10..10 over 2 s (looping), blinks at 1.1 s. */
const IDLE: Anim = {
  id: 'idle',
  duration: 2,
  loop: true,
  tracks: [
    {
      target: 'param:AngleX',
      keys: [
        { t: 0, v: -10, ease: 'inOutSine' },
        { t: 1, v: 10, ease: 'inOutSine' },
        { t: 2, v: -10 },
      ],
    },
    {
      target: 'param:Eye',
      keys: [
        { t: 0, v: 1 },
        { t: 1, v: 1 },
        { t: 1.1, v: 0 },
        { t: 1.2, v: 1 },
      ],
    },
  ],
};

/** Talk: mouth flaps, head nods +4 around the default (looping, 0.5 s). */
const TALK: Anim = {
  id: 'talk',
  duration: 0.5,
  loop: true,
  tracks: [
    { target: 'param:Mouth', keys: [{ t: 0, v: 0 }, { t: 0.25, v: 1 }, { t: 0.5, v: 0 }] },
    { target: 'param:AngleX', keys: [{ t: 0, v: 0 }, { t: 0.25, v: 4 }, { t: 0.5, v: 0 }] },
  ],
};

/** Wink: a one-shot eye close (0.4 s). */
const WINK: Anim = {
  id: 'wink',
  duration: 0.4,
  loop: false,
  tracks: [{ target: 'param:Eye', keys: [{ t: 0, v: 1 }, { t: 0.2, v: 0 }, { t: 0.4, v: 0.9 }] }],
  events: [
    { t: 0, name: 'winkStart' },
    { t: 0.2, name: 'closed' },
  ],
};

function remixRig(...extra: Anim[]) {
  return makeRig({ parameters: PARAMS, animations: [IDLE, TALK, WINK, ...extra] });
}

describe('rig: animation layer modes', () => {
  it("'add' layers add their offset from the parameter default instead of overriding", () => {
    const rig = makeRig({
      parameters: [{ id: 'Q', min: 0, max: 20, default: 3 }],
      animations: [
        { id: 'base', duration: 1, tracks: [{ target: 'param:Q', keys: [{ t: 0, v: 8 }] }] },
        { id: 'gesture', duration: 1, tracks: [{ target: 'param:Q', keys: [{ t: 0, v: 5 }] }] },
      ],
    });
    const q = (animations: PoseOptions['animations']) => rig.pose({ animations }).params.Q;
    expect(q(['base', { id: 'gesture', mode: 'add' }])).toBeCloseTo(8 + (5 - 3));
    expect(q(['base', { id: 'gesture', mode: 'add', weight: 0.5 }])).toBeCloseTo(8 + 0.5 * (5 - 3));
    expect(q(['base', { id: 'gesture', mode: 'override', weight: 0.5 }])).toBeCloseTo(6.5);
    // An 'add' layer alone starts from the default; the sum is clamped to the range afterwards.
    expect(q([{ id: 'gesture', mode: 'add' }])).toBeCloseTo(5);
    expect(q(['base', { id: 'gesture', mode: 'add' }, { id: 'gesture', mode: 'add' }, { id: 'base', mode: 'add' }])).toBeCloseTo(8 + 2 + 2 + 5);
    expect(q(['base', ...Array(10).fill({ id: 'base', mode: 'add' })])).toBe(20);
  });

  it('remix: idle + talk(add) keeps the idle head sway and adds the nod', () => {
    const rig = remixRig();
    for (const time of [0.1, 0.35, 0.8, 1.3, 1.9]) {
      const idle = rig.pose({ time, animations: ['idle'] }).params;
      const talk = rig.pose({ time, animations: ['talk'] }).params;
      const added = rig.pose({ time, animations: ['idle', { id: 'talk', mode: 'add' }] }).params;
      expect(added.AngleX).toBeCloseTo(idle.AngleX + talk.AngleX, 10);
      expect(added.Mouth).toBeCloseTo(talk.Mouth, 10);
      // Override (the default) replaces the sway instead.
      expect(rig.pose({ time, animations: ['idle', 'talk'] }).params.AngleX).toBeCloseTo(talk.AngleX, 10);
    }
  });

  it('non-param tracks stay additive deltas from setup in both modes', () => {
    const rig = makeRig({
      bones: [{ id: 'b', rotation: 10 }],
      animations: [{ id: 'spin', duration: 1, tracks: [{ target: 'bone:b.rotation', keys: [{ t: 0, v: 30 }] }] }],
    });
    for (const mode of ['override', 'add'] as const) {
      expect(rig.pose({ animations: ['spin', { id: 'spin', mode }] }).bones.b.local.rotation).toBeCloseTo(50);
    }
  });

  it('rejects malformed layer options', () => {
    const rig = remixRig();
    expect(() => rig.pose({ animations: [{ id: 'talk', mode: 'blend' as never }] })).toThrow(/mode of animation layer "talk" must be "override" or "add", got "blend"/);
    expect(() => rig.pose({ animations: [{ id: 'talk', start: Number.NaN }] })).toThrow(/start of animation layer "talk" must be a finite number/);
    expect(() => rig.pose({ animations: [{ id: 'talk', hold: 'no' as never }] })).toThrow(/hold of animation layer "talk" must be true or false/);
  });
});

describe('rig: animation layer start and hold', () => {
  const wink = (extra: Partial<{ start: number; hold: boolean; time: number }> = {}) => ({ id: 'wink', ...extra });

  it('start delays the layer clock (local time = time - start)', () => {
    const rig = remixRig();
    const eye = (time: number, layer: object) => rig.pose({ time, animations: [layer as never] }).params.Eye;
    expect(eye(0.7, wink({ start: 0.5 }))).toBeCloseTo(eye(0.2, wink()), 12);
    expect(eye(0.7, wink({ start: 0.5 }))).toBeCloseTo(0);
    // An explicit layer time ignores start.
    expect(eye(5, wink({ start: 0.5, time: 0.2 }))).toBeCloseTo(0);
  });

  it('remix: idle + wink(once, hold: false) hands the eye back to the idle blink after the wink', () => {
    const rig = remixRig();
    const eye = (time: number, hold?: boolean) =>
      rig.pose({ time, animations: ['idle', { id: 'wink', start: 0.6, ...(hold === undefined ? {} : { hold }) }] }).params.Eye;
    const idleEye = (time: number) => rig.pose({ time, animations: ['idle'] }).params.Eye;
    // During the wink (0.6 .. 1.0) the wink overrides the eye.
    expect(eye(0.8, false)).toBeCloseTo(0);
    expect(eye(1.0, false)).toBeCloseTo(0.9); // the end instant still belongs to the wink
    // After it: idle's blink at 1.1 shows again with hold: false ...
    expect(idleEye(1.1)).toBe(0);
    expect(eye(1.1, false)).toBe(0);
    expect(eye(1.15, false)).toBeCloseTo(idleEye(1.15), 12);
    // ... while the default (hold: true) keeps the wink's last value and hides the blink.
    expect(eye(1.1)).toBeCloseTo(0.9);
    // Before the start: hold: false contributes nothing, hold: true holds the first key.
    expect(eye(0.3, false)).toBe(idleEye(0.3));
  });

  it('hold: false on a looping layer: nothing before its start, loops forever after', () => {
    const rig = remixRig();
    const layer = { id: 'talk', start: 1, hold: false };
    expect(rig.pose({ time: 0.9, animations: [layer] }).params.Mouth).toBe(0);
    expect(rig.pose({ time: 1.25, animations: [layer] }).params.Mouth).toBeCloseTo(1);
    expect(rig.pose({ time: 101.25, animations: [layer] }).params.Mouth).toBeCloseTo(1);
    // Holding looping layers wrap negative local time (they play before their start).
    expect(rig.pose({ time: 0.75, animations: [{ id: 'talk', start: 1 }] }).params.Mouth).toBeCloseTo(1);
  });

  it('events follow start and stop outside the active window', () => {
    const rig = remixRig({
      id: 'steps',
      duration: 1,
      loop: true,
      events: [
        { t: 0, name: 'a' },
        { t: 0.5, name: 'b' },
      ],
    });
    const names = (opts: PoseOptions) => rig.pose(opts).events.map((e) => `${e.animation}.${e.name}`);
    expect(names({ time: 0.8, animations: [wink({ start: 0.6 })] })).toEqual(['wink.closed']);
    expect(names({ time: 0.6, animations: [wink({ start: 0.6, hold: false })] })).toEqual(['wink.winkStart']);
    // A non-holding looping layer fires nothing before its start (0.5 before start would be "b").
    expect(names({ time: 1.5, animations: [{ id: 'steps', start: 2, hold: false }] })).toEqual([]);
    expect(names({ time: 1.5, animations: [{ id: 'steps', start: 2 }] })).toEqual(['steps.b']);
    expect(names({ time: 2, animations: [{ id: 'steps', start: 2, hold: false }] })).toEqual(['steps.a']);

    const player = rig.player();
    const seen: string[] = [];
    for (let f = 0; f <= 60 * 4; f++) {
      const time = f / 60;
      const pose = player.update({ time, animations: [{ id: 'steps', start: 2, hold: false }, wink({ start: 0.6, hold: false })] });
      for (const e of pose.events) seen.push(`${f}:${e.animation}.${e.name}`);
    }
    expect(seen).toEqual(['36:wink.winkStart', '48:wink.closed', '120:steps.a', '150:steps.b', '180:steps.a', '210:steps.b', '240:steps.a']);
  });

  it('physics sees delayed layers exactly like the stateless pose', () => {
    const rig = makeRig({
      parameters: [
        { id: 'X', min: -100, max: 100 },
        { id: 'Sway', min: -90, max: 90 },
      ],
      physics: [{ id: 'hair', inputs: [{ param: 'X', type: 'x' }], outputs: [{ param: 'Sway', type: 'angle' }], segments: [{ length: 40 }] }],
      animations: [{ id: 'push', duration: 0.2, loop: false, tracks: [{ target: 'param:X', keys: [{ t: 0, v: 0 }, { t: 0.2, v: 60 }] }] }],
    });
    const opts = (time: number): PoseOptions => ({ time, animations: [{ id: 'push', start: 0.5, hold: false }] });
    const player = rig.player();
    let last = 0;
    for (let f = 0; f <= 90; f++) last = player.update(opts(f / 60)).params.Sway;
    expect(last).toBeCloseTo(rig.pose(opts(1.5)).params.Sway, 9);
    // The push (0.5 .. 0.7) swung the pendulum; hold: false then removed it, so X is back at 0.
    expect(rig.pose(opts(0.6)).params.X).toBeCloseTo(30);
    expect(rig.pose(opts(1.5)).params.X).toBe(0);
    expect(Math.abs(rig.pose(opts(0.75)).params.Sway)).toBeGreaterThan(1);
    expect(rig.pose({ ...opts(0.75), animations: [{ id: 'push', start: 5, hold: false }] }).params.Sway).toBe(0);
  });
});

describe('rig: smooth ease', () => {
  const track = (keys: Array<{ t: number; v: number; ease?: 'smooth' | 'linear' | 'step' }>, extra: Partial<Anim> = {}): Anim => ({
    id: 'a',
    duration: 4,
    loop: false,
    tracks: [{ target: 'param:P', keys }],
    ...extra,
  });
  const sampler = (anim: Anim) => {
    const rig = makeRig({ parameters: PARAMS, animations: [anim] });
    return (time: number) => rig.pose({ time, animations: ['a'] }).params.P;
  };
  /** One-sided derivative of f at t (second-order finite difference from the left or the right). */
  const slope = (f: (t: number) => number, t: number, side: -1 | 1) => {
    const h = 1e-4 * side;
    return (-3 * f(t) + 4 * f(t + h) - f(t + 2 * h)) / (2 * h);
  };

  it('two keys: one-sided tangents make it exactly linear', () => {
    const p = sampler(track([{ t: 0, v: 0, ease: 'smooth' }, { t: 2, v: 10 }]));
    for (const t of [0.3, 1, 1.7]) expect(p(t)).toBeCloseTo(5 * t, 10);
  });

  it('passes through every key with Catmull-Rom tangents (non-uniform times)', () => {
    const keys = [
      { t: 0, v: 0, ease: 'smooth' as const },
      { t: 1, v: 10, ease: 'smooth' as const },
      { t: 3, v: 30, ease: 'smooth' as const },
      { t: 4, v: 0 },
    ];
    const p = sampler(track(keys));
    for (const k of keys) expect(p(k.t)).toBeCloseTo(k.v, 10);
    // Tangents: m0 = 10 (one-sided), m1 = (30 - 0) / 3 = 10, m2 = (0 - 10) / 3.
    // Segment 0: h10·1·10 + h01·10 + h11·1·10 at s = 0.5.
    expect(p(0.5)).toBeCloseTo(0.125 * 10 + 0.5 * 10 - 0.125 * 10, 10);
    // Continuous velocity through the inner keys despite the uneven spacing.
    expect(slope(p, 1, -1)).toBeCloseTo(10, 3);
    expect(slope(p, 1, 1)).toBeCloseTo(10, 3);
    expect(slope(p, 3, -1)).toBeCloseTo(-10 / 3, 3);
    expect(slope(p, 3, 1)).toBeCloseTo(-10 / 3, 3);
  });

  it('only segments whose start key is smooth use the curve', () => {
    const p = sampler(
      track([
        { t: 0, v: 0, ease: 'linear' },
        { t: 1, v: 10, ease: 'smooth' },
        { t: 2, v: 0, ease: 'step' },
        { t: 3, v: 5 },
      ]),
    );
    expect(p(0.5)).toBeCloseTo(5, 10); // linear
    expect(p(1.5)).not.toBeCloseTo(5, 3); // smooth: m1 = 0, m2 = (5 - 10) / 2
    expect(p(1.5)).toBeCloseTo(0.5 * 10 + 0.5 * 0 - 0.125 * 1 * -2.5, 10);
    expect(p(2.5)).toBe(0); // step holds
  });

  it('a closed looping track has continuous velocity across the seam', () => {
    // Keys at 0 .. duration with last == first: the seam tangent comes from keys 1 and n-1.
    const loopKeys = [0, 10, 5, -4, 0].map((v, i) => ({ t: i * 0.25, v, ease: 'smooth' as const }));
    const p = sampler(track(loopKeys, { duration: 1, loop: true }));
    const seamSlope = (10 - -4) / 0.5;
    expect(slope(p, 1, -1)).toBeCloseTo(seamSlope, 2);
    expect(slope(p, 1, 1)).toBeCloseTo(seamSlope, 2);
    expect(p(1)).toBeCloseTo(0, 10);
    expect(p(0.999999)).toBeCloseTo(0, 4);
    // Not closed (last key before the duration): one-sided ends, the gap to the loop holds.
    const open = sampler(track(loopKeys.slice(0, 4), { duration: 1, loop: true }));
    expect(slope(open, 0, 1)).toBeCloseTo(40, 2);
    expect(open(0.9)).toBe(-4);
  });

  it('interpolates points, colors and paths element-wise', () => {
    const rig = makeRig({
      parameters: PARAMS,
      parts: [
        { id: 'poly', shape: { type: 'polygon', points: [0, 0, 10, 0, 10, 10] } },
        { id: 'curve', shape: { type: 'path', d: 'M0 0 L10 0 L10 10 Z' }, fill: '#000000' },
      ],
      animations: [
        {
          id: 'a',
          duration: 3,
          loop: false,
          tracks: [
            { target: 'param:P', keys: [0, 10, 30, 0].map((v, t) => ({ t, v, ease: 'smooth' as const })) },
            {
              target: 'part:poly.shape.points',
              keys: [0, 10, 30, 0].map((v, t) => ({ t, v: { '1': [10 + v, 0] }, ease: 'smooth' as const })),
            },
            { target: 'part:curve.fill', keys: ['#000000', '#404040', '#ffffff', '#000000'].map((v, t) => ({ t, v, ease: 'smooth' as const })) },
            {
              target: 'part:curve.shape.d',
              keys: [0, 10, 30, 0].map((v, t) => ({ t, v: `M0 0 L${10 + v} 0 L10 10 Z`, ease: 'smooth' as const })),
            },
          ],
        },
      ],
    });
    for (const time of [0.4, 1.3, 2.6]) {
      const pose = rig.pose({ time, animations: ['a'] });
      const p = pose.params.P;
      expect((pose.properties['part:poly.shape.points'] as number[])[2]).toBeCloseTo(10 + p, 3);
      const d = /^M0 0 L(\S+) 0 L10 10 Z$/.exec(pose.properties['part:curve.shape.d'] as string);
      expect(Number(d?.[1])).toBeCloseTo(10 + p, 2);
    }
    // Colors: channels follow the same curve, then clamp to [0, 1] (overshoot above white is cut).
    const fill = (time: number) => rig.pose({ time, animations: ['a'] }).properties['part:curve.fill'];
    expect(fill(2)).toBe('#ffffff');
    expect(fill(0)).toBe('#000000');
  });
});

describe('rig: track offset', () => {
  const triangle = [
    { t: 0, v: -10 },
    { t: 0.5, v: 10 },
    { t: 1, v: -10 },
  ];

  it('offset = duration / 2 mirrors a phase in a looping animation', () => {
    const rig = makeRig({
      parameters: PARAMS,
      animations: [
        {
          id: 'walk',
          duration: 1,
          tracks: [
            { target: 'param:P', keys: triangle },
            { target: 'param:Q', keys: triangle, offset: 0.5 },
          ],
        },
      ],
    });
    for (let f = 0; f <= 40; f++) {
      const { P, Q } = rig.pose({ time: f / 20 + 0.013, animations: ['walk'] }).params;
      expect(Q).toBeCloseTo(-P, 9);
    }
  });

  it('samples at (t - offset): wraps when looping, holds the end keys otherwise', () => {
    const anim = (loop: boolean, offset: number): Anim => ({
      id: `a${loop}${offset}`.replace('.', '_'),
      duration: 1,
      loop,
      tracks: [{ target: 'param:P', keys: triangle, offset }],
    });
    const rig = makeRig({ parameters: PARAMS, animations: [anim(true, 0.25), anim(true, -0.25), anim(true, 2.25), anim(false, 0.25)] });
    const p = (id: string, time: number) => rig.pose({ time, animations: [id] }).params.P;
    expect(p('atrue0_25', 0.5)).toBeCloseTo(0); // samples 0.25
    expect(p('atrue0_25', 0.1)).toBeCloseTo(-4); // samples -0.15 -> 0.85
    expect(p('atrue-0_25', 0.5)).toBeCloseTo(0); // samples 0.75
    expect(p('atrue2_25', 0.5)).toBeCloseTo(p('atrue0_25', 0.5), 12);
    expect(p('afalse0_25', 0.1)).toBe(-10); // samples -0.15: first key holds
    expect(p('afalse0_25', 0.75)).toBeCloseTo(10);
    expect(p('afalse0_25', 1)).toBeCloseTo(0);
    expect(p('afalse0_25', 3)).toBeCloseTo(0); // the layer clamps to the end, then the offset applies
  });
});

describe('rig: mapPoint', () => {
  const rig = makeRig({
    parameters: [{ id: 'A', min: -1, max: 1 }],
    bones: [
      { id: 'root', x: 100, y: 100 },
      { id: 'arm', parent: 'root', x: 10, rotation: 30, length: 40 },
    ],
    warps: [
      { id: 'outer', parent: 'arm', rect: [100, 80, 80, 60], cols: 2, rows: 2 },
      { id: 'inner', parent: 'outer', rect: [120, 90, 40, 30], cols: 1, rows: 1 },
    ],
    parts: [
      { id: 'onBone', parent: 'arm', shape: quad(110, 95, 20, 10) },
      { id: 'onWarp', parent: 'inner', shape: quad(125, 95, 20, 15) },
      { id: 'free', shape: quad(0, 0, 5, 5) },
    ],
    bindings: [
      { target: 'bone:arm.rotation', params: ['A'], keys: [{ at: [-1], value: -20 }, { at: [1], value: 70 }] },
      { target: 'warp:outer.offsets', params: ['A'], keys: [{ at: [-1], value: {} }, { at: [1], value: { '4': [12, -7] } }] },
      { target: 'warp:inner.offsets', params: ['A'], keys: [{ at: [-1], value: {} }, { at: [1], value: { '3': [5, 9] } }] },
    ],
  });

  it('maps setup points exactly like attached part vertices (bone, nested warps, none)', () => {
    for (const A of [-1, 0.3, 1]) {
      const pose = rig.pose({ params: { A } });
      for (const [part, parent] of [
        ['onBone', 'arm'],
        ['onWarp', 'inner'],
        ['free', null],
      ] as const) {
        const setup = rig.model.parts.find((p) => p.id === part)!.shape as { vertices: number[] };
        for (let i = 0; i < 4; i++) {
          const mapped = rig.mapPoint(pose, parent, setup.vertices[i * 2], setup.vertices[i * 2 + 1]);
          expectNear(mapped, vertex(fillOf(pose, part), i), 1e-3);
        }
      }
    }
  });

  it('maps a bone joint onto the posed joint', () => {
    const pose = rig.pose({ params: { A: 1 } });
    const setupJoint = [100 + 10, 100];
    expectNear(rig.mapPoint(pose, 'arm', setupJoint[0], setupJoint[1]), [pose.bones.arm.x, pose.bones.arm.y], 1e-9);
  });

  it('rejects unknown parents with a did-you-mean hint', () => {
    const pose = rig.pose();
    expect(() => rig.mapPoint(pose, 'inenr', 0, 0)).toThrow(/unknown parent "inenr" \(not a bone, warp or part id\) \(did you mean "inner"\?\)/);
    expect(() => rig.mapPoint(pose, 'fre', 0, 0)).toThrow(/unknown parent "fre" .*\(did you mean "free"\?\)/);
    expect(() => rig.mapPoint(pose, 'arm', Number.NaN, 0)).toThrow(/finite/);
    // Parts map like their vertices (rig.mappoint.test.ts): "free" is in model space.
    expect(rig.mapPoint(pose, 'free', 3, 4)).toEqual([3, 4]);
  });
});
