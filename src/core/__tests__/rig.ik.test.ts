import { describe, expect, it } from 'vitest';
import type { ModelInput } from '../types.js';
import { expectNear, makeRig } from './rig.fixtures.js';

type BoneInput = NonNullable<ModelInput['bones']>[number];
type IkInput = NonNullable<ModelInput['ik']>[number];

const target = (x: number, y: number): BoneInput => ({ id: 'target', x, y });

/** Upper arm at (100,100) length 50, forearm at its tip, length 50. */
function armRig(tx: number, ty: number, ik: Partial<IkInput> = {}, rootBone: Partial<BoneInput> = {}) {
  return makeRig({
    bones: [
      { id: 'root', ...rootBone },
      { id: 'upper', parent: 'root', x: 100, y: 100, length: 50 },
      { id: 'fore', parent: 'upper', x: 50, length: 50 },
      { id: 'hand', parent: 'fore', x: 50, length: 10 },
      target(tx, ty),
    ],
    ik: [{ id: 'arm', bones: ['upper', 'fore'], target: 'target', ...ik }],
  });
}

describe('rig: IK', () => {
  it('one-bone IK aims the bone +x axis at the target', () => {
    const pose = makeRig({
      bones: [
        { id: 'parent', x: 10, y: 10, rotation: 45 },
        { id: 'aim', parent: 'parent', length: 20 },
        target(10, 60),
      ],
      ik: [{ id: 'look', bones: ['aim'], target: 'target' }],
    }).pose();
    expect(pose.bones.aim.rotation).toBeCloseTo(90);
    expect(pose.bones.aim.local.rotation).toBeCloseTo(45);
    expectNear(pose.bones.aim.tip, [10, 30]);
  });

  it('one-bone IK respects mirrored parents', () => {
    const pose = makeRig({
      bones: [
        { id: 'parent', x: 50, y: 50, scaleX: -1 },
        { id: 'aim', parent: 'parent', length: 10 },
        target(80, 90),
      ],
      ik: [{ id: 'look', bones: ['aim'], target: 'target' }],
    }).pose();
    const b = pose.bones.aim;
    expectNear([(b.tip[0] - b.x) / 10, (b.tip[1] - b.y) / 10], [0.6, 0.8]);
  });

  it('mix blends the rotation change (0 = no change)', () => {
    const rig = (mix: number) =>
      makeRig({
        bones: [{ id: 'aim', length: 10, rotation: 10 }, target(0, 50)],
        ik: [{ id: 'look', bones: ['aim'], target: 'target', mix }],
      });
    expect(rig(0).pose().bones.aim.local.rotation).toBe(10);
    expect(rig(0.5).pose().bones.aim.local.rotation).toBeCloseTo(50);
    // The mix is bindable.
    const bound = makeRig({
      parameters: [{ id: 'M', min: 0, max: 1 }],
      bones: [{ id: 'aim', length: 10 }, target(0, 50)],
      ik: [{ id: 'look', bones: ['aim'], target: 'target' }],
      bindings: [{ target: 'ik:look.mix', params: ['M'], keys: [{ at: [0], value: 0 }, { at: [1], value: 1 }] }],
    });
    expect(bound.pose({ params: { M: 0.25 } }).bones.aim.local.rotation).toBeCloseTo(22.5);
  });

  it('mix blends through the shortest angle', () => {
    const pose = makeRig({
      bones: [{ id: 'aim', length: 10, rotation: 170 }, target(-10, 5)],
      ik: [{ id: 'look', bones: ['aim'], target: 'target', mix: 0.5 }],
    }).pose();
    // Target direction is ≈153.4° (-206.6°); halfway from 170° goes down, not around.
    expect(pose.bones.aim.local.rotation).toBeCloseTo((170 + 153.43494882) / 2, 4);
  });

  it('two-bone IK reaches a reachable target and updates descendants', () => {
    for (const [tx, ty] of [
      [150, 150],
      [60, 130],
      [100, 170],
      [180, 90],
    ]) {
      const pose = armRig(tx, ty).pose();
      expectNear(pose.bones.fore.tip, [tx, ty]);
      expectNear([pose.bones.hand.x, pose.bones.hand.y], [tx, ty]);
      expectNear([pose.bones.upper.x, pose.bones.upper.y], [100, 100]);
      // Segment lengths are preserved.
      expect(Math.hypot(pose.bones.fore.x - 100, pose.bones.fore.y - 100)).toBeCloseTo(50);
    }
  });

  it('two-bone IK handles a child joint that is offset inside the parent frame', () => {
    const pose = makeRig({
      bones: [
        { id: 'upper', x: 100, y: 100, length: 40 },
        { id: 'fore', parent: 'upper', x: 40, y: 30, length: 30 },
        target(140, 150),
      ],
      ik: [{ id: 'arm', bones: ['upper', 'fore'], target: 'target' }],
    }).pose();
    expectNear(pose.bones.fore.tip, [140, 150]);
    expect(Math.hypot(pose.bones.fore.x - 100, pose.bones.fore.y - 100)).toBeCloseTo(50);
  });

  it('two-bone IK reaches random targets under rotated, scaled and mirrored frames', () => {
    let seed = 20240925;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const sign = () => (rand() < 0.5 ? -1 : 1);
    for (let i = 0; i < 60; i++) {
      // Similarity frames only (uniform |scale|, optional mirroring), with the elbow offset off-axis.
      const k = 0.5 + rand() * 1.5;
      const bones: BoneInput[] = [
        { id: 'root', x: 100, y: 100, rotation: rand() * 360, scaleX: k * sign(), scaleY: k * sign() },
        { id: 'upper', parent: 'root', x: rand() * 20, y: rand() * 20, rotation: rand() * 360, scaleX: sign(), scaleY: sign(), length: 30 },
        { id: 'fore', parent: 'upper', x: 20 + rand() * 30, y: (rand() - 0.5) * 30, rotation: rand() * 360, length: 15 + rand() * 30 },
      ];
      const setup = makeRig({ bones }).pose().bones;
      const [jx, jy] = [setup.upper.x, setup.upper.y];
      const l1 = Math.hypot(setup.fore.x - jx, setup.fore.y - jy);
      const l2 = Math.hypot(setup.fore.tip[0] - setup.fore.x, setup.fore.tip[1] - setup.fore.y);
      const lo = Math.abs(l1 - l2);
      const dist = lo + (l1 + l2 - lo) * (0.05 + 0.9 * rand());
      const angle = rand() * 2 * Math.PI;
      const [tx, ty] = [jx + dist * Math.cos(angle), jy + dist * Math.sin(angle)];
      for (const bendPositive of [true, false]) {
        const pose = makeRig({ bones: [...bones, target(tx, ty)], ik: [{ id: 'arm', bones: ['upper', 'fore'], target: 'target', bendPositive }] }).pose();
        const { upper, fore } = pose.bones;
        expectNear(fore.tip, [tx, ty]);
        expect(Math.hypot(fore.x - jx, fore.y - jy)).toBeCloseTo(l1, 6);
        // Elbow side: the turn joint -> elbow -> tip is clockwise (y down) in the upper bone's own frame.
        const turn = (fore.x - jx) * (fore.tip[1] - fore.y) - (fore.y - jy) * (fore.tip[0] - fore.x);
        const det = upper.world[0] * upper.world[3] - upper.world[1] * upper.world[2];
        expect(Math.sign(turn * det)).toBe(bendPositive ? 1 : -1);
      }
    }
  });

  it('two-bone IK stays exact with any scale on the child bone itself (SPEC §7)', () => {
    // Only the chain parent's world transform and the first bone's scale must be similarities; the child's
    // own scale (non-uniform, mirrored) just changes l2 = length × world x scale.
    for (const [scaleX, scaleY] of [
      [2, 0.5],
      [-1.5, 0.25],
      [0.6, -3],
    ]) {
      const pose = makeRig({
        bones: [
          { id: 'root', x: 100, y: 100, rotation: 30, scaleX: 1.5, scaleY: -1.5 },
          { id: 'upper', parent: 'root', x: 5, y: 3, rotation: 20, length: 30 },
          { id: 'fore', parent: 'upper', x: 30, y: 4, rotation: 30, length: 25, scaleX, scaleY },
          target(120, 140),
        ],
        ik: [{ id: 'arm', bones: ['upper', 'fore'], target: 'target' }],
      }).pose();
      expectNear(pose.bones.fore.tip, [120, 140], 1e-6);
    }
  });

  it('two-bone IK straightens toward an out-of-reach target', () => {
    const far = armRig(300, 100).pose();
    expectNear(far.bones.fore.tip, [200, 100]);
    expect(far.bones.upper.local.rotation).toBeCloseTo(0);
    expect(far.bones.fore.local.rotation).toBeCloseTo(0);
    const down = armRig(100, 400).pose();
    expectNear(down.bones.fore.tip, [100, 200]);
    expect(down.bones.upper.rotation).toBeCloseTo(90);
  });

  it('bendPositive picks a clockwise elbow; false mirrors it across the target line', () => {
    const pos = armRig(170, 100).pose();
    const neg = armRig(170, 100, { bendPositive: false }).pose();
    expectNear(pos.bones.fore.tip, [170, 100]);
    expectNear(neg.bones.fore.tip, [170, 100]);
    // Target line is the x axis through y=100: elbows mirror across it.
    expect(pos.bones.fore.y).toBeLessThan(100);
    expectNear([neg.bones.fore.x, neg.bones.fore.y], [pos.bones.fore.x, 200 - pos.bones.fore.y]);
    expect(pos.bones.fore.local.rotation).toBeGreaterThan(0);
    expect(neg.bones.fore.local.rotation).toBeLessThan(0);
  });

  it('bend direction is defined in the chain frame, so a mirrored rig mirrors the elbow', () => {
    // Root mirrors x about 0: the arm now sits at x = -100 and points to -x.
    const pose = armRig(-170, 100, {}, { scaleX: -1 }).pose();
    expectNear(pose.bones.fore.tip, [-170, 100]);
    expect(pose.bones.fore.y).toBeLessThan(100);
    expect(pose.bones.fore.local.rotation).toBeGreaterThan(0);
  });

  it('two-bone IK with mix 0 leaves the pose unchanged', () => {
    const pose = armRig(150, 150, { mix: 0 }).pose();
    expectNear(pose.bones.fore.tip, [200, 100]);
    expect(pose.bones.upper.local.rotation).toBe(0);
  });

  it('requires the second bone to be a direct child', () => {
    expect(() =>
      makeRig({
        bones: [{ id: 'a' }, { id: 'b' }, target(0, 0)],
        ik: [{ id: 'k', bones: ['a', 'b'], target: 'target' }],
      }),
    ).toThrow(/ik "k": bone "b" must be a direct child of "a"/);
    expect(() => makeRig({ bones: [{ id: 'a' }], ik: [{ id: 'k', bones: ['a'], target: 'nope' }] })).toThrow(/unknown bone "nope"/);
  });
});
