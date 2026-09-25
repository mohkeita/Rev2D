import { describe, expect, it } from 'vitest';
import { expectNear, makeRig, quad } from './rig.fixtures.js';

const oneBone = { bones: [{ id: 'b', x: 5 }] };

describe('rig: bindings', () => {
  it('interpolates 1D keyforms and clamps outside the grid', () => {
    const rig = makeRig({
      ...oneBone,
      parameters: [{ id: 'A', min: -2, max: 3 }],
      bindings: [
        {
          target: 'bone:b.x',
          params: ['A'],
          keys: [
            { at: [2], value: 40 },
            { at: [-1], value: -10 },
            { at: [0], value: 0 },
          ],
        },
      ],
    });
    const x = (A: number) => rig.pose({ params: { A } }).bones.b.local.x;
    expect(x(0)).toBe(0);
    expect(x(1)).toBeCloseTo(20);
    expect(x(-0.5)).toBeCloseTo(-5);
    expect(x(3)).toBe(40);
    expect(x(-2)).toBe(-10);
  });

  it('interpolates 2D grids bilinearly', () => {
    const rig = makeRig({
      ...oneBone,
      parameters: [
        { id: 'A', min: 0, max: 1 },
        { id: 'B', min: 0, max: 1 },
      ],
      bindings: [
        {
          target: 'bone:b.x',
          params: ['A', 'B'],
          keys: [
            { at: [0, 0], value: 0 },
            { at: [1, 0], value: 10 },
            { at: [0, 1], value: 20 },
            { at: [1, 1], value: 40 },
          ],
        },
      ],
    });
    const x = (A: number, B: number) => rig.pose({ params: { A, B } }).bones.b.local.x;
    expect(x(0.5, 0.5)).toBeCloseTo(17.5);
    expect(x(1, 0.5)).toBeCloseTo(25);
    expect(x(0.25, 1)).toBeCloseTo(25);
    expect(x(1, 1)).toBe(40);
  });

  it('interpolates 3D grids trilinearly', () => {
    const keys = [];
    for (const a of [0, 1]) for (const b of [0, 1]) for (const c of [0, 1]) keys.push({ at: [a, b, c], value: 8 * a * b * c + a });
    const rig = makeRig({
      ...oneBone,
      parameters: ['A', 'B', 'C'].map((id) => ({ id, min: 0, max: 1 })),
      bindings: [{ target: 'bone:b.x', params: ['A', 'B', 'C'], keys }],
    });
    expect(rig.pose({ params: { A: 0.5, B: 0.5, C: 0.5 } }).bones.b.local.x).toBeCloseTo(1.5);
    expect(rig.pose({ params: { A: 1, B: 1, C: 0.25 } }).bones.b.local.x).toBeCloseTo(3);
  });

  it('step interpolation holds the lower grid value', () => {
    const rig = makeRig({
      ...oneBone,
      parameters: [{ id: 'A', min: -1, max: 3 }],
      bindings: [
        {
          target: 'bone:b.x',
          params: ['A'],
          interpolation: 'step',
          keys: [
            { at: [0], value: 0 },
            { at: [1], value: 10 },
            { at: [2], value: 20 },
          ],
        },
      ],
    });
    const x = (A: number) => rig.pose({ params: { A } }).bones.b.local.x;
    expect([x(-1), x(0.99), x(1), x(1.7), x(2), x(3)]).toEqual([0, 0, 10, 10, 20, 20]);
  });

  it('sums deltas from setup when several bindings drive one property', () => {
    const rig = makeRig({
      ...oneBone,
      parameters: [
        { id: 'A', min: 0, max: 1 },
        { id: 'B', min: 0, max: 1 },
      ],
      bindings: [
        { target: 'bone:b.x', params: ['A'], keys: [{ at: [0], value: 5 }, { at: [1], value: 15 }] },
        { target: 'bone:b.x', params: ['B'], keys: [{ at: [0], value: 5 }, { at: [1], value: 25 }] },
      ],
    });
    expect(rig.pose({ params: { A: 1, B: 1 } }).bones.b.local.x).toBeCloseTo(35);
    expect(rig.pose({ params: { A: 0.5, B: 0 } }).bones.b.local.x).toBeCloseTo(10);
    expect(rig.pose({ params: { A: 1, B: 1 } }).properties['bone:b.x']).toBe(35);
  });

  it('binds points (sparse), colors (clamped) and booleans (threshold 0.5)', () => {
    const rig = makeRig({
      parameters: [{ id: 'A', min: 0, max: 1 }],
      warps: [{ id: 'w', rect: [0, 0, 100, 100], cols: 1, rows: 1 }],
      parts: [{ id: 'p', shape: quad(0, 0, 10, 10) }],
      bindings: [
        { target: 'warp:w.offsets', params: ['A'], keys: [{ at: [0], value: {} }, { at: [1], value: { '3': [10, -20] } }] },
        { target: 'part:p.tint', params: ['A'], keys: [{ at: [0], value: '#ffffff' }, { at: [1], value: '#ff0000' }] },
        { target: 'part:p.tint', params: ['A'], keys: [{ at: [0], value: '#ffffff' }, { at: [1], value: '#ffffff00' }] },
        { target: 'part:p.visible', params: ['A'], keys: [{ at: [0], value: false }, { at: [1], value: true }] },
      ],
    });
    const half = rig.pose({ params: { A: 0.5 } });
    expect(half.properties['warp:w.offsets']).toEqual([0, 0, 0, 0, 0, 0, 5, -10]);
    expectNear(half.warps.w.points, [0, 0, 100, 0, 0, 100, 105, 90]);
    expectNear(half.parts.p.tint, [1, 0.5, 0.5, 0.5]);
    expect(half.parts.p.visible).toBe(true);
    expect(half.properties['part:p.visible']).toBe(1);
    const low = rig.pose({ params: { A: 0.4 } });
    expect(low.parts.p.visible).toBe(false);
    expect(low.drawOrder).toEqual([]);
  });

  it('clamps opacity and ik mix to 0..1 and records final values', () => {
    const rig = makeRig({
      parameters: [{ id: 'A', min: 0, max: 1 }],
      parts: [{ id: 'p', shape: quad(0, 0, 10, 10), opacity: 0.8 }],
      bindings: [{ target: 'part:p.opacity', params: ['A'], keys: [{ at: [0], value: 0.8 }, { at: [1], value: 1.6 }] }],
    });
    expect(rig.pose({ params: { A: 1 } }).parts.p.opacity).toBe(1);
    expect(rig.pose({ params: { A: 0.25 } }).parts.p.opacity).toBeCloseTo(1);
    expect(rig.pose({ params: { A: 0 } }).properties['part:p.opacity']).toBe(0.8);

    const ik = makeRig({
      parameters: [{ id: 'A', min: 0, max: 1 }],
      bones: [{ id: 'aim', length: 10 }, { id: 'target', y: 50 }],
      ik: [{ id: 'look', bones: ['aim'], target: 'target', mix: 0.5 }],
      bindings: [{ target: 'ik:look.mix', params: ['A'], keys: [{ at: [0], value: 0.5 }, { at: [1], value: 3 }] }],
    });
    // An unclamped mix of 3 would overshoot the 90° aim to 270°.
    const full = ik.pose({ params: { A: 1 } });
    expect(full.bones.aim.local.rotation).toBeCloseTo(90);
    expect(full.properties['ik:look.mix']).toBe(1);
  });

  it('rejects malformed bindings with actionable errors', () => {
    const base = { ...oneBone, parameters: [{ id: 'A', min: 0, max: 1 }, { id: 'B', min: 0, max: 1 }] };
    expect(() =>
      makeRig({
        ...base,
        bindings: [
          {
            target: 'bone:b.x',
            params: ['A', 'B'],
            keys: [
              { at: [0, 0], value: 0 },
              { at: [1, 0], value: 1 },
              { at: [0, 1], value: 2 },
            ],
          },
        ],
      }),
    ).toThrow(/full grid \(missing key at \[1, 1\]/);
    expect(() =>
      makeRig({ ...base, bindings: [{ target: 'bone:b.x', params: ['A'], keys: [{ at: [0], value: 0 }, { at: [0], value: 1 }] }] }),
    ).toThrow(/duplicate key/);
    expect(() => makeRig({ ...base, bindings: [{ target: 'bone:b.x', params: ['Q'], keys: [{ at: [0], value: 0 }] }] })).toThrow(
      /unknown parameter "Q"/,
    );
    expect(() => makeRig({ ...base, bindings: [{ target: 'param:A', params: ['B'], keys: [{ at: [0], value: 0 }] }] })).toThrow(
      /cannot be binding targets/,
    );
    expect(() => makeRig({ ...base, bindings: [{ target: 'bone:b.rotaton', params: ['A'], keys: [{ at: [0], value: 0 }] }] })).toThrow(
      /bone has no property "rotaton" \(did you mean "rotation"\?\)/,
    );
    expect(() => makeRig({ ...base, bindings: [{ target: 'bone:b.x', params: ['A'], keys: [{ at: [0], value: 'x' }] }] })).toThrow(
      /keys\[0\]: expected a number/,
    );
  });
});
