import { describe, expect, it } from 'vitest';
import { buildRenderList } from '../rig.js';
import { expectNear, fillOf, gridMesh, makeRig, quad, vertex } from './rig.fixtures.js';

const A = { id: 'A', min: 0, max: 1 };

describe('rig: parts', () => {
  it('bone-parented parts follow the bone rigidly', () => {
    const rig = makeRig({
      parameters: [A],
      bones: [{ id: 'b', x: 50, y: 50 }],
      parts: [{ id: 'p', parent: 'b', shape: quad(50, 50, 20, 10) }],
      bindings: [
        { target: 'bone:b.rotation', params: ['A'], keys: [{ at: [0], value: 0 }, { at: [1], value: 90 }] },
        { target: 'bone:b.x', params: ['A'], keys: [{ at: [0], value: 50 }, { at: [1], value: 60 }] },
      ],
    });
    expectNear(fillOf(rig.pose(), 'p'), [50, 50, 70, 50, 70, 60, 50, 60]);
    const turned = rig.pose({ params: { A: 1 } });
    expectNear(fillOf(turned, 'p'), [60, 50, 60, 70, 50, 70, 50, 50]);
    expectNear(turned.parts.p.bounds!, [50, 50, 10, 20]);
  });

  it('skins with auto weights: vertices follow their nearest bone', () => {
    const rig = makeRig({
      parameters: [A],
      bones: [
        { id: 'upper', x: 0, y: 100, length: 50 },
        { id: 'lower', parent: 'upper', x: 50, length: 50 },
      ],
      parts: [{ id: 'arm', shape: gridMesh(0, 90, 100, 20, 10, 2), skin: { bones: ['upper', 'lower'] } }],
      bindings: [{ target: 'bone:lower.rotation', params: ['A'], keys: [{ at: [0], value: 0 }, { at: [1], value: 90 }] }],
    });
    // Setup pose: identity.
    expectNear(fillOf(rig.pose(), 'arm'), gridMesh(0, 90, 100, 20, 10, 2).vertices, 1e-4);
    const bent = fillOf(rig.pose({ params: { A: 1 } }), 'arm');
    const stride = 11;
    // Middle row (y = 100): the root stays, the end swings down around the elbow (50, 100).
    const root = vertex(bent, stride);
    const end = vertex(bent, stride + 10);
    expectNear(root, [0, 100], 0.05);
    expectNear(end, [50, 150], 0.05);
    // (60, 100) lies 10 px from `upper` and on `lower`: auto weights (1/11)^2 : 1 normalize to
    // 1/122 : 121/122, so LBS blends the rigid positions (60, 100) and (50, 110) exactly.
    expectNear(vertex(bent, stride + 6), [50 + 10 / 122, 110 - 10 / 122], 1e-4);
  });

  it('recomputes auto weights when bound geometry moves vertices to another bone', () => {
    const rig = makeRig({
      parameters: [A, { id: 'Move', min: 0, max: 1 }],
      bones: [
        { id: 'left', x: 0, y: 0, length: 10 },
        { id: 'right', x: 100, y: 0, length: 10 },
      ],
      parts: [{ id: 'p', shape: quad(0, 0, 5, 5), skin: { bones: ['left', 'right'] } }],
      bindings: [
        { target: 'bone:right.y', params: ['A'], keys: [{ at: [0], value: 0 }, { at: [1], value: 50 }] },
        // Moves vertex 1 from next to `left` onto `right`.
        { target: 'part:p.shape.vertices', params: ['Move'], keys: [{ at: [0], value: {} }, { at: [1], value: { '1': [105, 0] } }] },
      ],
    });
    expectNear(vertex(fillOf(rig.pose({ params: { A: 1 } }), 'p'), 1), [5, 0], 0.1);
    expectNear(vertex(fillOf(rig.pose({ params: { A: 1, Move: 1 } }), 'p'), 1), [105, 50], 0.1);
  });

  it('skins with explicit weight rows (mesh only)', () => {
    const rig = makeRig({
      parameters: [A],
      bones: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 100, y: 0 }],
      parts: [
        {
          id: 'p',
          shape: quad(0, 0, 100, 10),
          skin: { bones: ['a', 'b'], weights: [[1, 0], [0, 1], [0, 2], [0.5, 0.5]] },
        },
      ],
      bindings: [{ target: 'bone:b.y', params: ['A'], keys: [{ at: [0], value: 0 }, { at: [1], value: 40 }] }],
    });
    // Rows are normalized: [0, 2] behaves like [0, 1].
    expectNear(fillOf(rig.pose({ params: { A: 1 } }), 'p'), [0, 0, 100, 40, 100, 50, 0, 30]);
    expect(() =>
      makeRig({ bones: [{ id: 'a' }], parts: [{ id: 'p', shape: quad(0, 0, 1, 1), skin: { bones: ['a'], weights: [[1]] } }] }),
    ).toThrow(/1 weight rows, mesh has 4 vertices/);
    expect(() =>
      makeRig({ bones: [{ id: 'a' }], parts: [{ id: 'p', parent: 'a', shape: quad(0, 0, 1, 1), skin: { bones: ['a'] } }] }),
    ).toThrow(/mutually exclusive/);
  });

  it('recompiles geometry from bound shape fields', () => {
    const rig = makeRig({
      parameters: [A],
      parts: [{ id: 'p', shape: quad(0, 0, 10, 10) }],
      bindings: [{ target: 'part:p.shape.vertices', params: ['A'], keys: [{ at: [0], value: {} }, { at: [1], value: { '2': [30, 20] } }] }],
    });
    const pose = rig.pose({ params: { A: 0.5 } });
    expectNear(fillOf(pose, 'p'), [0, 0, 10, 0, 20, 15, 0, 10]);
    expectNear(pose.parts.p.bounds!, [0, 0, 20, 15]);
    expect(pose.properties['part:p.shape.vertices']).toEqual([0, 0, 10, 0, 20, 15, 0, 10]);
    // Revisiting a value hits the cache: same compiled batch, identical output.
    const again = rig.pose({ params: { A: 0.5 } });
    expect(fillOf(again, 'p')).toEqual(fillOf(pose, 'p'));
    expect(buildRenderList(rig, again).draws[0].indices).toBe(buildRenderList(rig, pose).draws[0].indices);
    expect(buildRenderList(rig, rig.pose({ params: { A: 1 } })).draws[0].indices).not.toBe(
      buildRenderList(rig, pose).draws[0].indices,
    );
    expectNear(fillOf(rig.pose(), 'p'), [0, 0, 10, 0, 10, 10, 0, 10]);
  });

  it('never recompiles geometry for tint, opacity, z or visibility changes', () => {
    const rig = makeRig({
      parameters: [A],
      parts: [{ id: 'p', shape: quad(0, 0, 10, 10) }],
      bindings: ['tint', 'opacity', 'z', 'visible'].map((prop, i) => ({
        target: `part:p.${prop}`,
        params: ['A'],
        keys: [
          { at: [0], value: ['#ffffff', 1, 0, true][i] },
          { at: [1], value: ['#000000', 0.5, 3, true][i] },
        ],
      })),
    });
    const draw = (A: number) => buildRenderList(rig, rig.pose({ params: { A } })).draws[0];
    expect(draw(0.3).indices).toBe(draw(0.9).indices);
  });

  it('applies opacity, tint and visibility; opacity 0 hides', () => {
    const rig = makeRig({
      parameters: [A],
      parts: [
        { id: 'fade', shape: quad(0, 0, 10, 10) },
        { id: 'hidden', shape: quad(0, 0, 10, 10), visible: false },
        { id: 'zero', shape: quad(0, 0, 10, 10), opacity: 0 },
      ],
      bindings: [
        { target: 'part:fade.opacity', params: ['A'], keys: [{ at: [0], value: 1 }, { at: [1], value: 0 }] },
        { target: 'part:fade.tint', params: ['A'], keys: [{ at: [0], value: '#ffffff' }, { at: [1], value: '#00ff00' }] },
        { target: 'part:hidden.visible', params: ['A'], keys: [{ at: [0], value: true }, { at: [1], value: true }] },
      ],
    });
    const half = rig.pose({ params: { A: 0.5 } });
    expect(half.parts.fade.opacity).toBeCloseTo(0.5);
    expectNear(half.parts.fade.tint, [0.5, 1, 0.5, 1]);
    // Static visible=false wins over the bound visibility; opacity 0 hides.
    expect(half.drawOrder).toEqual(['fade']);
    expect(half.parts.hidden.visible).toBe(false);
    expect(half.parts.zero.visible).toBe(false);
    // Hidden parts are still deformed (masks need them).
    expect(half.parts.zero.fill).not.toBeNull();
    const gone = rig.pose({ params: { A: 1 } });
    expect(gone.parts.fade.visible).toBe(false);
    expect(gone.drawOrder).toEqual([]);
  });

  it('sorts the draw order by z, keeping array order for ties', () => {
    const rig = makeRig({
      parameters: [A],
      parts: [
        { id: 'a', shape: quad(0, 0, 1, 1), z: 1 },
        { id: 'b', shape: quad(0, 0, 1, 1), z: 0 },
        { id: 'c', shape: quad(0, 0, 1, 1), z: 1 },
        { id: 'd', shape: quad(0, 0, 1, 1), z: -1 },
      ],
      bindings: [{ target: 'part:d.z', params: ['A'], keys: [{ at: [0], value: -1 }, { at: [1], value: 3 }] }],
    });
    expect(rig.pose().drawOrder).toEqual(['d', 'b', 'a', 'c']);
    expect(rig.pose({ params: { A: 1 } }).drawOrder).toEqual(['b', 'a', 'c', 'd']);
    // Bound z ties: array index decides.
    expect(rig.pose({ params: { A: 0.5 } }).drawOrder).toEqual(['b', 'a', 'c', 'd']);
    expect(rig.pose({ params: { A: 0.25 } }).drawOrder).toEqual(['b', 'd', 'a', 'c']);
  });

  it('rejects bad part references', () => {
    expect(() => makeRig({ parts: [{ id: 'p', parent: 'nope', shape: quad(0, 0, 1, 1) }] })).toThrow(/part "p": unknown parent "nope"/);
    expect(() => makeRig({ parts: [{ id: 'p', shape: quad(0, 0, 1, 1), mask: ['q'] }] })).toThrow(/part "p" mask: unknown part "q"/);
    expect(() => makeRig({ parts: [{ id: 'p', shape: quad(0, 0, 1, 1), mask: ['p'] }] })).toThrow(/cannot mask itself/);
    expect(() => makeRig({ parts: [{ id: 'p', shape: quad(0, 0, 1, 1), skin: { bones: ['x'] } }] })).toThrow(/unknown bone "x"/);
  });

  it('validates the setup geometry of dynamic parts at construction', () => {
    expect(() =>
      makeRig({
        parameters: [A],
        parts: [{ id: 'p', shape: { type: 'mesh', vertices: [0, 0, 1, 0, 1, 1], triangles: [0, 1, 7] } }],
        bindings: [{ target: 'part:p.shape.vertices', params: ['A'], keys: [{ at: [0], value: {} }, { at: [1], value: { '1': [5, 0] } }] }],
      }),
    ).toThrow(/part "p".*triangle index 7 is out of range/);
  });

  it('rejects deformer bones whose setup transform cannot be inverted', () => {
    const flat = { id: 'b', x: 10, y: 10, scaleX: 0 };
    expect(() => makeRig({ bones: [flat], parts: [{ id: 'p', parent: 'b', shape: quad(0, 0, 1, 1) }] })).toThrow(
      /part "p": bone "b" has a degenerate setup transform/,
    );
    expect(() => makeRig({ bones: [flat], parts: [{ id: 'p', shape: quad(0, 0, 1, 1), skin: { bones: ['b'] } }] })).toThrow(
      /part "p" skin: bone "b" has a degenerate setup transform/,
    );
    expect(() => makeRig({ bones: [flat], warps: [{ id: 'w', parent: 'b', rect: [0, 0, 1, 1] }] })).toThrow(
      /warp "w": bone "b" has a degenerate setup transform/,
    );
    // Degenerate bones are fine as long as nothing is attached through their setup transform.
    expect(makeRig({ bones: [flat, { id: 'c', parent: 'b', x: 5, length: 5 }] }).pose().bones.c.x).toBe(10);
  });
});
