import { describe, expect, it } from 'vitest';
import { softDistance } from '../rig/ik.js';
import type { ModelInput } from '../types.js';
import { expectNear, makeRig } from './rig.fixtures.js';

type BoneInput = NonNullable<ModelInput['bones']>[number];
type IkInput = NonNullable<ModelInput['ik']>[number];

const target = (x: number, y: number): BoneInput => ({ id: 'target', x, y });

/** Upper arm at (100,100) length 50, forearm at its tip, length 50 (max reach 100). */
function armRig(tx: number, ty: number, ik: Partial<IkInput> = {}) {
  return makeRig({
    parameters: [{ id: 'M', min: 0, max: 1, default: 1 }],
    bones: [
      { id: 'upper', x: 100, y: 100, length: 50 },
      { id: 'fore', parent: 'upper', x: 50, length: 50 },
      { id: 'hand', parent: 'fore', x: 50, length: 10 },
      target(tx, ty),
    ],
    ik: [{ id: 'arm', bones: ['upper', 'fore'], target: 'target', ...ik }],
    bindings: [{ target: 'ik:arm.mix', params: ['M'], keys: [{ at: [0], value: 0 }, { at: [1], value: 1 }] }],
  });
}

/** One aim bone at (0, 0), length 20. */
function aimRig(tx: number, ty: number, ik: Partial<IkInput> = {}, bone: Partial<BoneInput> = {}) {
  return makeRig({
    bones: [{ id: 'aim', length: 20, ...bone }, target(tx, ty)],
    ik: [{ id: 'look', bones: ['aim'], target: 'target', ...ik }],
  });
}

describe('rig: IK diagnostics', () => {
  it('reports reach, error, extension and bend for a two-bone chain', () => {
    const near = armRig(150, 150).pose().ik.arm;
    expect(near.reached).toBe(true);
    expect(near.error).toBeLessThan(1e-9);
    expect(near.distance).toBeCloseTo(Math.hypot(50, 50));
    expect(near.maxReach).toBeCloseTo(100);
    expect(near.extension).toBeCloseTo(Math.hypot(50, 50) / 100);
    expect(near.bend).toBeCloseTo(90, 6); // right triangle 50-50-70.7
    expect(near.stretch).toBeUndefined();

    const far = armRig(300, 100).pose().ik.arm;
    expect(far.reached).toBe(false);
    expect(far.error).toBeCloseTo(100);
    expect(far.extension).toBeCloseTo(2);
    expect(far.bend).toBeCloseTo(180, 6);
  });

  it('reached describes the full solve (before mix); error the final pose', () => {
    const half = armRig(150, 150).pose({ params: { M: 0.5 } }).ik.arm;
    expect(half.reached).toBe(true);
    expect(half.error).toBeGreaterThan(1);
    const off = armRig(150, 150).pose({ params: { M: 0 } });
    expect(off.ik.arm.reached).toBe(true);
    expectNear(off.bones.fore.tip, [200, 100]);
    expect(off.ik.arm.error).toBeCloseTo(Math.hypot(50, 50));
  });

  it('one-bone aim: maxReach is the world length; reached only when the tip lands on the target', () => {
    const d = aimRig(30, 40).pose().ik.look;
    expect(d).toMatchObject({ reached: false, distance: 50, maxReach: 20, extension: 2.5 });
    expect(d.error).toBeCloseTo(30);
    expect(d.bend).toBeUndefined();
    expect(aimRig(12, 16).pose().ik.look.reached).toBe(true);
    // A zero-length aim bone has no reach: extension 0 by definition.
    expect(aimRig(12, 16, {}, { length: 0 }).pose().ik.look).toMatchObject({ maxReach: 0, extension: 0 });
    // World scale counts: a bone scaled x2 reaches 40.
    expect(aimRig(24, 32, {}, { scaleX: 2 }).pose().ik.look).toMatchObject({ maxReach: 40, reached: true });
  });

  it('lists every constraint, including ones with mix 0', () => {
    const rig = makeRig({
      bones: [{ id: 'a', length: 10 }, { id: 'b', x: 50, length: 10 }, target(0, 30)],
      ik: [
        { id: 'one', bones: ['a'], target: 'target' },
        { id: 'two', bones: ['b'], target: 'target', mix: 0 },
      ],
    });
    expect(Object.keys(rig.pose().ik)).toEqual(['one', 'two']);
  });
});

describe('rig: IK stretch', () => {
  it('two-bone: scales both bones uniformly so the tip reaches an out-of-reach target', () => {
    const pose = armRig(300, 100, { stretch: true }).pose();
    expectNear(pose.bones.fore.tip, [300, 100], 1e-6);
    expect(pose.bones.upper.local.scaleX).toBeCloseTo(2);
    expect(pose.bones.fore.scaleX).toBeCloseTo(2); // world scale: inherited, corrected to exactly 2
    expect(Math.hypot(pose.bones.fore.x - 100, pose.bones.fore.y - 100)).toBeCloseTo(100);
    expectNear([pose.bones.hand.x, pose.bones.hand.y], [300, 100], 1e-6);
    expect(pose.ik.arm).toMatchObject({ reached: true, stretch: 2, maxReach: 100 });
    expect(pose.ik.arm.error).toBeLessThan(1e-6);
    // In reach: no stretch.
    const near = armRig(150, 150, { stretch: true }).pose();
    expect(near.ik.arm.stretch).toBe(1);
    expect(near.bones.upper.local.scaleX).toBe(1);
  });

  it('two-bone: exact with an off-axis child joint under rotated, scaled and mirrored frames', () => {
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const sign = () => (rand() < 0.5 ? -1 : 1);
    for (let i = 0; i < 40; i++) {
      const k = 0.5 + rand() * 1.5;
      const bones: BoneInput[] = [
        { id: 'root', x: 100, y: 100, rotation: rand() * 360, scaleX: k * sign(), scaleY: k * sign() },
        { id: 'upper', parent: 'root', rotation: rand() * 360, length: 30 },
        { id: 'fore', parent: 'upper', x: 20 + rand() * 30, y: (rand() - 0.5) * 30, rotation: rand() * 90, length: 15 + rand() * 30 },
      ];
      const setup = makeRig({ bones }).pose().bones;
      const [jx, jy] = [setup.upper.x, setup.upper.y];
      const reach = Math.hypot(setup.fore.x - jx, setup.fore.y - jy) + Math.hypot(setup.fore.tip[0] - setup.fore.x, setup.fore.tip[1] - setup.fore.y);
      const angle = rand() * 2 * Math.PI;
      const dist = reach * (1.05 + rand());
      const [tx, ty] = [jx + dist * Math.cos(angle), jy + dist * Math.sin(angle)];
      const pose = makeRig({ bones: [...bones, target(tx, ty)], ik: [{ id: 'arm', bones: ['upper', 'fore'], target: 'target', stretch: true }] }).pose();
      expectNear(pose.bones.fore.tip, [tx, ty], 1e-6);
      expect(pose.ik.arm.stretch).toBeCloseTo(dist / reach, 9);
      expect(pose.ik.arm.reached).toBe(true);
    }
  });

  it('two-bone: works in any direction and with mix (the stretch blends too)', () => {
    const down = armRig(100, 260, { stretch: true }).pose();
    expectNear(down.bones.fore.tip, [100, 260], 1e-6);
    const half = armRig(300, 100, { stretch: true }).pose({ params: { M: 0.5 } });
    expect(half.ik.arm.stretch).toBeCloseTo(1.5);
    expect(half.bones.upper.local.scaleX).toBeCloseTo(1.5);
  });

  it('one-bone: stretches the bone length toward the target', () => {
    const pose = aimRig(30, 40, { stretch: true }).pose();
    expectNear(pose.bones.aim.tip, [30, 40], 1e-6);
    expect(pose.bones.aim.local.scaleX).toBeCloseTo(2.5);
    expect(pose.ik.look).toMatchObject({ reached: true, stretch: 2.5 });
    // A mirrored bone keeps its sign.
    const mirrored = aimRig(30, 40, { stretch: true }, { scaleX: -1 }).pose();
    expectNear(mirrored.bones.aim.tip, [30, 40], 1e-6);
    expect(mirrored.bones.aim.local.scaleX).toBeCloseTo(-2.5);
    // Zero length cannot stretch.
    expect(aimRig(30, 40, { stretch: true }, { length: 0 }).pose().ik.look.stretch).toBe(1);
  });
});

describe('rig: IK softness', () => {
  it('softDistance: identity below maxReach - s, quadratic ease-out to maxReach at maxReach + s', () => {
    expect(softDistance(80, 100, 10)).toBe(80);
    expect(softDistance(90, 100, 10)).toBe(90);
    expect(softDistance(100, 100, 10)).toBeCloseTo(100 - 10 / 4);
    expect(softDistance(110, 100, 10)).toBe(100);
    expect(softDistance(500, 100, 10)).toBe(100);
    expect(softDistance(95, 100, 10)).toBeCloseTo(95 - 25 / 40);
    // C1: slope 1 at the soft start, 0 at the end.
    const h = 1e-6;
    expect((softDistance(90 + h, 100, 10) - softDistance(90, 100, 10)) / h).toBeCloseTo(1, 4);
    expect((softDistance(110, 100, 10) - softDistance(110 - h, 100, 10)) / h).toBeCloseTo(0, 4);
    // Softness larger than the reach is limited to the reach.
    expect(softDistance(0, 100, 500)).toBeCloseTo(0);
    expect(softDistance(200, 100, 500)).toBe(100);
  });

  it('two-bone: the chain keeps a bend near full extension instead of snapping straight', () => {
    const bendAt = (tx: number, softness: number) => armRig(tx, 100, { softness }).pose().ik.arm;
    const hard = bendAt(199, 0);
    const soft = bendAt(199, 20);
    expect(hard.bend).toBeGreaterThan(160);
    expect(soft.bend!).toBeLessThan(hard.bend!);
    expect(soft.reached).toBe(false);
    expect(soft.error).toBeCloseTo(199 - 100 - softDistance(99, 100, 20), 6);
    // Fully straight only at maxReach + softness.
    expect(bendAt(220, 20).bend).toBeCloseTo(180, 4);
    expect(bendAt(219, 20).bend!).toBeLessThan(179.9);
    // Below the soft zone: identical to no softness.
    const inside = armRig(170, 100, { softness: 20 }).pose();
    expectNear(inside.bones.fore.tip, [170, 100], 1e-9);
    // The bend angle changes continuously as the target moves out.
    let prev = bendAt(170, 20).bend!;
    for (let tx = 171; tx <= 230; tx++) {
      const b = bendAt(tx, 20).bend!;
      expect(b).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(b - prev).toBeLessThan(6);
      prev = b;
    }
  });

  it('softness + stretch: the tip always reaches, the stretch grows smoothly from 1', () => {
    let prev = 1;
    for (let tx = 170; tx <= 260; tx += 5) {
      const pose = armRig(tx, 100, { softness: 20, stretch: true }).pose();
      expectNear(pose.bones.fore.tip, [tx, 100], 1e-6);
      const s = pose.ik.arm.stretch!;
      expect(s).toBeGreaterThanOrEqual(prev);
      expect(s - prev).toBeLessThan(0.1);
      prev = s;
    }
    expect(armRig(179, 100, { softness: 20, stretch: true }).pose().ik.arm.stretch).toBe(1);
    expect(armRig(240, 100, { softness: 20, stretch: true }).pose().ik.arm.stretch).toBeCloseTo(1.4);
  });

  it('one-bone IK ignores softness', () => {
    expect(aimRig(30, 40, { softness: 10 }).pose().bones.aim.rotation).toBeCloseTo(aimRig(30, 40).pose().bones.aim.rotation, 12);
  });
});

describe('rig: physics diagnostics', () => {
  const rig = () =>
    makeRig({
      parameters: [
        { id: 'X', min: -100, max: 100 },
        { id: 'Sway', min: -5, max: 5 },
        { id: 'Wide', min: -90, max: 90 },
      ],
      physics: [
        {
          id: 'hair',
          inputs: [{ param: 'X', type: 'x' }],
          outputs: [
            { param: 'Sway', type: 'angle' },
            { param: 'Wide', type: 'angle', scale: 0.5 },
          ],
          segments: [{ length: 40 }],
        },
      ],
      animations: [{ id: 'jerk', duration: 10, loop: false, tracks: [{ target: 'param:X', keys: [{ t: 0, v: 0, ease: 'step' }, { t: 0.5, v: 50 }] }] }],
    });

  it('reports raw (value·scale, before clamping), value, clamped and overridden per output', () => {
    const pose = rig().pose({ time: 0.6, animations: ['jerk'] });
    const [sway, wide] = pose.physics.hair.outputs;
    expect(sway.param).toBe('Sway');
    expect(sway.raw).toBeGreaterThan(5);
    expect(sway).toMatchObject({ value: 5, clamped: true, overridden: false });
    expect(pose.params.Sway).toBe(5);
    expect(wide.raw).toBeCloseTo(sway.raw * 0.5, 9);
    expect(wide).toMatchObject({ value: wide.raw, clamped: false, overridden: false });
    expect(pose.params.Wide).toBe(wide.raw);
  });

  it('marks explicit parameters as overridden with their value; empty when physics is off', () => {
    const r = rig();
    const pose = r.pose({ time: 0.6, animations: ['jerk'], params: { Sway: -2 } });
    expect(pose.physics.hair.outputs[0]).toMatchObject({ param: 'Sway', value: -2, overridden: true, clamped: true });
    expect(pose.params.Sway).toBe(-2);
    expect(r.pose({ time: 0.6, animations: ['jerk'], physics: false }).physics).toEqual({});
    expect(makeRig().pose().physics).toEqual({});
    expect(makeRig().pose().ik).toEqual({});
  });

  it('the player reports the same diagnostics as the stateless pose', () => {
    const r = rig();
    const player = r.player();
    let last;
    for (let f = 0; f <= 40; f++) last = player.update({ time: f / 60, animations: ['jerk'] });
    expect(last!.physics).toEqual(r.pose({ time: 40 / 60, animations: ['jerk'] }).physics);
  });
});
