import { describe, expect, it } from 'vitest';
import { Rig } from '../../../core/rig.js';
import { exportLive2dPhysics, importLive2dPhysics } from '../index.js';
import { restTilt } from '../physics3.js';
import { codes, fixture, hanaModel, hanaRaw, miniRaw, normalize, refCubismPhysics, type RefRange } from './helpers.js';

type Group = {
  id: string;
  inputs: Array<{ param: string; type: string; weight: number }>;
  outputs: Array<{ param: string; type: string; scale: number; segment?: number }>;
  segments: Array<{ length: number; mass: number }>;
  gravity: number;
  damping: number;
  stiffness: number;
  description: string;
};

describe('live2d physics3 import', () => {
  it('maps Cubism settings to pendulum groups with the documented formulas', () => {
    const { physics, report } = importLive2dPhysics(fixture('mini.physics3.json'), { model: miniRaw() });
    const [bangs, back] = physics as Group[];
    expect(bangs.id).toBe('PhysicsSetting1');
    expect(bangs.description).toContain('"Bangs"');
    // Weight% x normalization half range / parameter half range; + for X and Angle, Reflect flips.
    expect(bangs.inputs).toEqual([
      { param: 'AngleX', type: 'x', weight: 0.2 },
      { param: 'AngleZ', type: 'angle', weight: 0.2 },
      { param: 'BodyAngleX', type: 'x', weight: -0.4 },
    ]);
    // Radians x Scale -> degrees x scale, sign flipped (Cubism's physics x axis points left).
    expect(bangs.outputs).toEqual([{ param: 'HairFront', type: 'angle', scale: expect.closeTo((-1.5 * Math.PI) / 180, 8) }]);
    expect(bangs.segments).toEqual([{ length: 10, mass: 1 }]);
    expect(bangs.gravity).toBeCloseTo(900 * 1.5 * 0.8 * 0.8, 3); // 900 x Acceleration x Delay^2
    expect(bangs.damping).toBeCloseTo(1 - Math.pow(0.9, 30 / 60), 6); // Mobility per 30 fps step -> per 60 Hz step
    expect(bangs.stiffness).toBe(0);
    // Y input: negative weight; output on vertex 2 with Weight 50 % folded into the scale.
    expect(back.inputs).toEqual([{ param: 'AngleX', type: 'y', weight: expect.closeTo(-1 / 3, 6) }]);
    expect(back.outputs).toEqual([{ param: 'HairBack', type: 'angle', scale: expect.closeTo((-2 * Math.PI) / 180 / 2, 8) }]);
    expect(back.segments).toHaveLength(2);
    const c = codes(report);
    expect(c).toEqual(expect.arrayContaining(['live2d-physics-vertices-averaged', 'live2d-physics-output-weight', 'live2d-physics-angle-relative', 'live2d-physics-invalid', 'live2d-physics-approximation']));
    expect(report.issues.find((i) => i.code === 'live2d-physics-invalid')?.where).toBe('PhysicsSettings[1] (PhysicsSetting2 Back hair).Output[1]');
    expect(report.stats).toMatchObject({ physicsSettings: 2, inputs: 4, outputs: 2 });
    // The groups are valid Rev2D physics.
    const raw = miniRaw();
    raw.physics = physics;
    expect(() => normalize(raw)).not.toThrow();
  });

  it('swings the way Cubism does: a sudden AngleX increase first gives a negative output', () => {
    const { physics } = importLive2dPhysics(fixture('mini.physics3.json'), { model: miniRaw() });
    const raw = miniRaw();
    raw.physics = [physics[0]];
    raw.animations = [{ id: 'step', duration: 2, loop: false, tracks: [{ target: 'param:AngleX', keys: [{ t: 0, v: 0, ease: 'step' }, { t: 0.5, v: 30 }] }] }];
    const player = new Rig(normalize(raw)).player();
    const out: number[] = [];
    for (let k = 1; k <= 60; k++) out.push(player.update({ time: k / 60, animations: ['step'] }).params.HairFront);
    expect(out[25]).toBeCloseTo(0, 6);
    expect(Math.min(...out.slice(30, 45))).toBeLessThan(-0.05);
  });

  it('reports missing parameters once, and unknown ranges without a model', () => {
    const raw = miniRaw();
    raw.parameters = (raw.parameters as Array<{ id: string }>).filter((p) => p.id !== 'AngleZ' && p.id !== 'HairBack');
    const { physics, report } = importLive2dPhysics(fixture('mini.physics3.json'), { model: raw });
    expect(physics).toHaveLength(1);
    const unknown = report.issues.filter((i) => i.code === 'live2d-unknown-parameter');
    expect(unknown).toHaveLength(1);
    expect(unknown[0].where).toBe('PhysicsSettings[0].Input[1], PhysicsSettings[1].Output[0]');
    expect(codes(report)).toContain('live2d-physics-setting-dropped');
    const noModel = importLive2dPhysics({ Version: 3, Meta: {}, PhysicsSettings: [{ Id: 'S', Input: [{ Source: { Id: 'ParamTail' }, Weight: 50, Type: 'X', Reflect: false }], Output: [{ Destination: { Id: 'ParamTailSway' }, VertexIndex: 1, Scale: 1, Weight: 100, Type: 'X', Reflect: false }], Vertices: [{ Radius: 0 }, { Radius: 8, Mobility: 0.9, Delay: 1, Acceleration: 1 }], Normalization: {} }] });
    expect(codes(noModel.report)).toEqual(expect.arrayContaining(['live2d-physics-param-range-unknown', 'live2d-physics-fps-assumed', 'live2d-physics-invalid']));
    expect((noModel.physics[0] as Group).outputs[0]).toMatchObject({ type: 'x', scale: -1 });
  });

  it('checks Meta counts and ignores custom forces like the SDK', () => {
    const doc = JSON.parse(fixture('mini.physics3.json'));
    doc.Meta.TotalInputCount = 9;
    doc.Meta.EffectiveForces.Wind = { X: 1, Y: 0 };
    const { report } = importLive2dPhysics(doc, { model: miniRaw() });
    expect(report.issues.find((i) => i.code === 'live2d-meta-count-mismatch')?.where).toBe('Meta.TotalInputCount');
    expect(report.issues.find((i) => i.code === 'live2d-physics-forces-ignored')).toMatchObject({ severity: 'info' });
    expect(() => importLive2dPhysics({ Version: 3 })).toThrow(/PhysicsSettings/);
  });
});

describe('live2d physics3 import: outputs past vertex 1 and legacy ids', () => {
  it('imports the X output of vertex 2 as the angle of its segment, matching a Cubism-style simulation', () => {
    const setting = {
      Id: 'Chain',
      Input: [
        { Source: { Target: 'Parameter', Id: 'ParamAngleX' }, Weight: 80, Type: 'X', Reflect: false },
        { Source: { Target: 'Parameter', Id: 'ParamAngleZ' }, Weight: 60, Type: 'Angle', Reflect: false },
      ],
      Output: [
        { Destination: { Target: 'Parameter', Id: 'ParamHairFront' }, VertexIndex: 1, Scale: 0.1, Weight: 100, Type: 'X', Reflect: false },
        { Destination: { Target: 'Parameter', Id: 'ParamHairBack' }, VertexIndex: 2, Scale: 0.1, Weight: 100, Type: 'X', Reflect: true },
      ],
      Vertices: [
        { Position: { X: 0, Y: 0 }, Mobility: 1, Delay: 1, Acceleration: 1, Radius: 0 },
        { Position: { X: 0, Y: 12 }, Mobility: 0.92, Delay: 0.9, Acceleration: 1.5, Radius: 12 },
        { Position: { X: 0, Y: 24 }, Mobility: 0.92, Delay: 0.9, Acceleration: 1.5, Radius: 12 },
      ],
      Normalization: { Position: { Minimum: -10, Default: 0, Maximum: 10 }, Angle: { Minimum: -10, Default: 0, Maximum: 10 } },
    };
    const doc = { Version: 3, Meta: { Fps: 60, PhysicsSettingCount: 1, TotalInputCount: 2, TotalOutputCount: 2, VertexCount: 3 }, PhysicsSettings: [setting] };
    const raw = miniRaw();
    for (const p of raw.parameters as Array<{ id: string; min: number; max: number }>) if (p.id.startsWith('Hair')) Object.assign(p, { min: -100, max: 100 });
    const { physics, report } = importLive2dPhysics(doc, { model: raw });
    const g = physics[0] as Group;
    expect(g.outputs).toEqual([
      { param: 'HairFront', type: 'x', segment: 0, scale: -0.1 },
      { param: 'HairBack', type: 'angle', scale: expect.closeTo((-0.1 * 12 * Math.PI) / 180, 8) },
    ]);
    expect(report.issues.find((i) => i.code === 'live2d-physics-x-as-angle')).toMatchObject({ severity: 'info', where: 'PhysicsSettings[0] (Chain).Output[1]' });
    // The Cubism SDKs never read the Scale of X / Y outputs: reported for both.
    expect(report.issues.filter((i) => i.code === 'live2d-physics-translation-output').map((i) => i.where)).toEqual(['PhysicsSettings[0] (Chain).Output[0]', 'PhysicsSettings[0] (Chain).Output[1]']);
    expect(report.issues.find((i) => i.code === 'live2d-physics-angle-input')).toMatchObject({ severity: 'info', where: 'PhysicsSettings[0]' });
    // Step AngleX: the Rev2D chain (the same integrator for one Delay / Mobility) swings like the reference.
    raw.physics = physics;
    raw.animations = [{ id: 'step', duration: 3, loop: false, tracks: [{ target: 'param:AngleX', keys: [{ t: 0.5, v: 0 }, { t: 0.7, v: 30 }] }] }];
    const player = new Rig(normalize(raw)).player();
    const ranges = { ParamAngleX: { min: -30, max: 30 }, ParamAngleZ: { min: -30, max: 30 } };
    const cub = refCubismPhysics(setting, ranges, (t) => ({ ParamAngleX: t < 0.5 ? 0 : t < 0.7 ? (30 * (t - 0.5)) / 0.2 : 30 }), 60, 3);
    const worst = [0, 0];
    cub.forEach((row, k) => {
      const p = player.update({ time: (k + 1) / 60, animations: ['step'] }).params;
      worst[0] = Math.max(worst[0], Math.abs(row[0] - p.HairFront));
      worst[1] = Math.max(worst[1], Math.abs(row[1] - p.HairBack));
    });
    expect(worst[0]).toBeLessThan(1e-6);
    expect(worst[1]).toBeLessThan(0.02); // x extent (sine) vs angle
  });

  it('reads Cubism 2 parameter ids by their Cubism 3 names', () => {
    const doc = JSON.parse(fixture('mini.physics3.json'));
    doc.PhysicsSettings[0].Input[0].Source.Id = 'PARAM_ANGLE_X';
    doc.PhysicsSettings[0].Output[0].Destination.Id = 'PARAM_HAIR_FRONT';
    const { physics, report } = importLive2dPhysics(doc, { model: miniRaw() });
    expect((physics[0] as Group).inputs[0]).toEqual({ param: 'AngleX', type: 'x', weight: 0.2 });
    expect((physics[0] as Group).outputs[0].param).toBe('HairFront');
    expect(report.issues.find((i) => i.code === 'live2d-legacy-id')?.message).toContain('PARAM_ANGLE_X -> ParamAngleX (AngleX)');
  });
});

describe('live2d physics3 export', () => {
  it('restTilt: the share of a tilt a springy chain follows at rest', () => {
    expect(restTilt({ gravity: 980, stiffness: 0, segments: [{ length: 30, mass: 1 }] })).toEqual([0]);
    expect(restTilt({ gravity: 0, stiffness: 5, segments: [{ length: 30, mass: 1 }, { length: 10, mass: 2 }] })).toEqual([1, 1]);
    // One segment: stiffness × length against gravity.
    expect(restTilt({ gravity: 980, stiffness: 40, segments: [{ length: 22, mass: 1 }] })[0]).toBeCloseTo((40 * 22) / (980 + 40 * 22), 12);
    // Two segments (hana's side hair): the outer segment follows more of the tilt.
    const [a, b] = restTilt({ gravity: 980, stiffness: 12, segments: [{ length: 40, mass: 1 }, { length: 40, mass: 1 }] });
    expect(a).toBeCloseTo(480 / 1460, 9);
    expect(b).toBeGreaterThan(a);
    // It is where the Rev2D chain comes to rest (rest direction turned by 2 degrees).
    const raw = miniRaw();
    raw.physics = [{ id: 's', inputs: [{ param: 'AngleZ', type: 'angle', weight: 1 }], outputs: [{ param: 'HairFront', type: 'angle', scale: 1, segment: 0 }, { param: 'HairBack', type: 'angle', scale: 1 }], segments: [{ length: 40, mass: 1 }, { length: 40, mass: 1 }], gravity: 980, stiffness: 12, damping: 0.2 }];
    for (const p of raw.parameters as Array<{ id: string; min: number; max: number }>) if (p.id.startsWith('Hair')) Object.assign(p, { min: -10, max: 10 });
    const pose = new Rig(normalize(raw)).pose({ time: 20, params: { AngleZ: 2 } });
    expect(pose.params.HairFront).toBeCloseTo(2 * (a - 1), 1);
    expect(pose.params.HairBack).toBeCloseTo(2 * (b - 1), 1);
  });

  it('writes exact Meta counts and settings for hana', () => {
    const hana = hanaModel();
    const { physics3, report } = exportLive2dPhysics(hana);
    const settings = physics3.PhysicsSettings as Array<{ Id: string; Input: unknown[]; Output: unknown[]; Vertices: unknown[] }>;
    expect(physics3.Meta).toMatchObject({
      PhysicsSettingCount: 3,
      TotalInputCount: settings.reduce((n, s) => n + s.Input.length, 0),
      TotalOutputCount: settings.reduce((n, s) => n + s.Output.length, 0),
      VertexCount: settings.reduce((n, s) => n + s.Vertices.length, 0),
      Fps: 60,
      EffectiveForces: { Gravity: { X: 0, Y: -1 }, Wind: { X: 0, Y: 0 } },
    });
    expect((physics3.Meta as { PhysicsDictionary: unknown[] }).PhysicsDictionary).toHaveLength(3);
    expect(settings.map((s) => s.Id)).toEqual(['hairFront', 'hairSide', 'hairBack']);
    expect(settings[0].Input[0]).toEqual({ Source: { Target: 'Parameter', Id: 'ParamAngleX' }, Weight: 100, Type: 'X', Reflect: false });
    // hana's springs have no Cubism equivalent: reported, folded into the acceleration.
    expect(report.issues.filter((i) => i.code === 'live2d-physics-stiffness-approximated')).toHaveLength(3);
    // The last segment of hairSide / hairBack: Cubism's Angle output of vertex 2 is relative to segment 1
    // (0 at rest, often the opposite sign) and the SDKs evaluate X outputs as 0, so the output is written
    // as the Angle of vertex 1: same direction, same rest angle.
    expect(codes(report)).not.toContain('live2d-physics-angle-relative');
    expect(report.issues.filter((i) => i.code === 'live2d-physics-output-first-segment').map((i) => i.where)).toEqual(['physics[1] (hairSide).outputs[0]', 'physics[2] (hairBack).outputs[0]']);
    const outs = settings.map((s) => s.Output[0]);
    expect(outs[0]).toMatchObject({ Type: 'Angle', VertexIndex: 1, Reflect: true });
    expect(outs[1]).toEqual({ Destination: { Target: 'Parameter', Id: 'ParamHairSide' }, VertexIndex: 1, Scale: expect.closeTo((0.06 * 180) / Math.PI, 6), Weight: 100, Type: 'Angle', Reflect: true });
    expect(outs[2]).toMatchObject({ Type: 'Angle', VertexIndex: 1, Scale: expect.closeTo((0.05 * 180) / Math.PI, 6), Reflect: true });
    expect(settings.flatMap((s) => s.Output as Array<{ Type: string }>).every((o) => o.Type === 'Angle')).toBe(true);
    // Angle input weights are scaled to the share of the tilt hana's springy chains keep at rest.
    expect(report.issues.filter((i) => i.code === 'live2d-physics-angle-weight-scaled')).toHaveLength(3);
    const angleWeight = (k: number) => (settings[k].Input as Array<{ Type: string; Weight: number }>).find((i) => i.Type === 'Angle')!.Weight;
    expect(angleWeight(0)).toBeCloseTo(100 * (980 / (980 + 40 * 22)), 4);
  });

  it("rests where Rev2D rests and swings the same way in a Cubism-style simulation of hana's exported physics", () => {
    const raw = hanaRaw();
    const physicsOnly = { format: 'rev2d', version: 1, meta: { name: 'h', width: 10, height: 10 }, parameters: raw.parameters, parts: [], physics: raw.physics };
    const model = normalize(physicsOnly);
    const { physics3 } = exportLive2dPhysics(model);
    const ranges: Record<string, RefRange> = {};
    for (const p of model.parameters) ranges[p.id === 'MouthOpen' ? 'ParamMouthOpenY' : `Param${p.id}`] = { min: p.min, max: p.max };
    const seconds = 6;
    for (const [param, target] of [['AngleZ', 30], ['AngleX', 30]] as const) {
      const drive = (t: number) => ({ [`Param${param}`]: t < 0.5 ? 0 : t < 0.7 ? (target * (t - 0.5)) / 0.2 : target });
      const doc = structuredClone(physicsOnly) as Record<string, unknown>;
      doc.animations = [{ id: 'drive', duration: seconds, loop: false, tracks: [{ target: `param:${param}`, keys: [{ t: 0.5, v: 0 }, { t: 0.7, v: target }] }] }];
      const player = new Rig(normalize(doc)).player();
      const rev = Array.from({ length: seconds * 60 }, (_, k) => player.update({ time: (k + 1) / 60, animations: ['drive'] }).params);
      (physics3.PhysicsSettings as Array<Record<string, unknown>>).forEach((setting, gi) => {
        const out = model.physics[gi].outputs[0].param;
        const clamp = (v: number) => Math.max(-1, Math.min(1, v));
        const cub = refCubismPhysics(setting, ranges, drive, 60, seconds).map((row) => clamp(row[0]));
        const r = rev.map((p) => p[out]);
        if (param === 'AngleZ') {
          // Same resting tilt (Angle weights scaled for the stiffness), same sign on the way there.
          expect(cub[cub.length - 1]).toBeCloseTo(r[r.length - 1], 2);
          expect(Math.sign(cub[60])).toBe(Math.sign(r[60]));
        } else {
          // A head turn: both chains first swing the same way and settle (the Cubism outputs follow the
          // first segment of hana's two-segment chains, which swings further than the last).
          const peak = (xs: number[]) => xs.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0);
          expect(Math.sign(peak(cub))).toBe(Math.sign(peak(r)));
          expect(Math.abs(peak(cub) - peak(r))).toBeLessThan(0.45);
          expect(Math.abs(cub[cub.length - 1])).toBeLessThan(0.02);
        }
      });
    }
  });

  it('round-trips groups without stiffness', () => {
    const raw = miniRaw();
    raw.physics = [
      {
        id: 'sway',
        inputs: [
          { param: 'AngleX', type: 'x', weight: 0.5 },
          { param: 'BodyAngleX', type: 'y', weight: -0.8 },
          { param: 'AngleZ', type: 'angle', weight: -0.3 },
        ],
        outputs: [
          { param: 'HairFront', type: 'angle', scale: 0.04, segment: 0 },
          { param: 'HairBack', type: 'x', scale: -0.02 },
        ],
        segments: [{ length: 12, mass: 1 }, { length: 20, mass: 1 }],
        gravity: 700,
        damping: 0.07,
        description: 'Sway',
      },
    ];
    const model = normalize(raw);
    const { physics3, report } = exportLive2dPhysics(model);
    expect(codes(report)).toEqual(expect.arrayContaining(['live2d-physics-x-as-angle', 'live2d-physics-y-input']));
    // Only Angle outputs: the SDKs evaluate X / Y outputs as 0.
    expect(((physics3.PhysicsSettings as Array<{ Output: Array<{ Type: string; VertexIndex: number }> }>)[0].Output).map((o) => [o.Type, o.VertexIndex])).toEqual([
      ['Angle', 1],
      ['Angle', 1],
    ]);
    const back = importLive2dPhysics(JSON.parse(JSON.stringify(physics3)), { model: raw }).physics[0] as Group;
    expect(back.id).toBe('sway');
    expect(back.inputs).toEqual(model.physics[0].inputs.map((i) => ({ ...i, weight: expect.closeTo(i.weight, 6) })));
    expect(back.outputs).toEqual([
      { param: 'HairFront', type: 'angle', segment: 0, scale: expect.closeTo(0.04, 6) },
      // The x offset of the chain's end (32 px from the pivot) is written as the Angle of vertex 1 (the
      // SDKs evaluate X outputs as 0), which reads back as the first segment's angle: -0.02 per px =
      // 0.02 × 32 px × π / 180 per degree (small swings of a straight chain).
      { param: 'HairBack', type: 'angle', segment: 0, scale: expect.closeTo((0.02 * 32 * Math.PI) / 180, 6) },
    ]);
    expect(back.segments).toEqual([{ length: 12, mass: 1 }, { length: 20, mass: 1 }]);
    expect(back.gravity).toBeCloseTo(700, 3);
    expect(back.damping).toBeCloseTo(0.07, 6);
  });
});
