import { describe, expect, it } from 'vitest';
import { Rig } from '../rig.js';
import { expectNear, makeModel, makeRig } from './rig.fixtures.js';

describe('rig: bones', () => {
  it('places roots in setup space and rotates clockwise (y down)', () => {
    const pose = makeRig({ bones: [{ id: 'root', x: 100, y: 100, rotation: 90, length: 50 }] }).pose();
    const b = pose.bones.root;
    expect([b.x, b.y]).toEqual([100, 100]);
    expectNear(b.tip, [100, 150]);
    expect(b.rotation).toBeCloseTo(90);
    expect(b.local).toEqual({ x: 100, y: 100, rotation: 90, scaleX: 1, scaleY: 1, length: 50 });

    const diag = makeRig({ bones: [{ id: 'b', x: 0, y: 0, rotation: 45, length: Math.SQRT2 * 10 }] }).pose();
    expectNear(diag.bones.b.tip, [10, 10]);
  });

  it('composes parent transforms (children in the parent frame, any array order)', () => {
    const pose = makeRig({
      bones: [
        { id: 'hand', parent: 'arm', x: 20, rotation: 90, length: 10 },
        { id: 'arm', parent: 'root', x: 50, length: 20 },
        { id: 'root', x: 100, y: 100, rotation: 90, length: 50 },
      ],
    }).pose();
    expectNear([pose.bones.arm.x, pose.bones.arm.y], [100, 150]);
    expectNear(pose.bones.arm.tip, [100, 170]);
    expect(pose.bones.arm.rotation).toBeCloseTo(90);
    expectNear([pose.bones.hand.x, pose.bones.hand.y], [100, 170]);
    expectNear(pose.bones.hand.tip, [90, 170]);
    expect(pose.bones.hand.rotation).toBeCloseTo(180);
  });

  it('inherits scale', () => {
    const pose = makeRig({
      bones: [
        { id: 'root', x: 10, y: 10, scaleX: 2, scaleY: 3, length: 10 },
        { id: 'child', parent: 'root', x: 10, y: 10, length: 10 },
        { id: 'turned', parent: 'root', rotation: 90, length: 10 },
      ],
    }).pose();
    expectNear(pose.bones.root.tip, [30, 10]);
    expectNear([pose.bones.child.x, pose.bones.child.y], [30, 40]);
    expectNear(pose.bones.child.tip, [50, 40]);
    expect(pose.bones.child.scaleX).toBeCloseTo(2);
    expect(pose.bones.child.scaleY).toBeCloseTo(3);
    // Local +x of the rotated child maps onto the parent's +y axis, scaled by 3.
    expectNear(pose.bones.turned.tip, [10, 40]);
    expect(pose.bones.turned.scaleX).toBeCloseTo(3);
  });

  it('drives bone properties from bindings and reports final locals', () => {
    const rig = makeRig({
      parameters: [{ id: 'Turn', min: 0, max: 1 }],
      bones: [
        { id: 'root', x: 100, y: 100, length: 50 },
        { id: 'tip', parent: 'root', x: 50, length: 10 },
      ],
      bindings: [
        { target: 'bone:root.rotation', params: ['Turn'], keys: [{ at: [0], value: 0 }, { at: [1], value: 90 }] },
        { target: 'bone:root.length', params: ['Turn'], keys: [{ at: [0], value: 50 }, { at: [1], value: -20 }] },
      ],
    });
    const pose = rig.pose({ params: { Turn: 1 } });
    expect(pose.bones.root.local.rotation).toBe(90);
    // Negative lengths are clamped to 0.
    expect(pose.bones.root.local.length).toBe(0);
    expectNear(pose.bones.root.tip, [100, 100]);
    expectNear([pose.bones.tip.x, pose.bones.tip.y], [100, 150]);
    expect(pose.properties['bone:root.rotation']).toBe(90);
  });

  it('reports bad references and cycles clearly', () => {
    expect(() => makeRig({ bones: [{ id: 'a', parent: 'nope' }] })).toThrow(/bone "a" parent: unknown bone "nope"/);
    expect(() =>
      makeRig({
        bones: [
          { id: 'a', parent: 'b' },
          { id: 'b', parent: 'a' },
        ],
      }),
    ).toThrow(/bone parent cycle: a -> b -> a/);
    expect(() => makeRig({ bones: [{ id: 'a', parent: 'a' }] })).toThrow(/cycle/);
    const model = makeModel({ bones: [{ id: 'a' }] });
    model.bones.push({ ...model.bones[0] });
    expect(() => new Rig(model)).toThrow(/duplicate bone id "a"/);
  });
});
