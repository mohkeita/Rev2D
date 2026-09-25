/**
 * Rig.mapPoint through parts: skinned parts (linear blend skinning with the weights a vertex at the
 * point would get), parts with a parent, parts in model space, and explicit "kind:" prefixes.
 */
import { describe, expect, it } from 'vitest';
import type { Pose } from '../types.js';
import { expectNear, fillOf, gridMesh, makeRig, quad, vertex } from './rig.fixtures.js';

const EXPLICIT_ROWS = [
  [1, 0],
  [0.5, 0.5],
  [0, 1],
  [1, 0],
  [0.5, 0.5],
  [0, 1],
];

const rig = makeRig({
  parameters: [{ id: 'A', min: -1, max: 1 }],
  bones: [
    { id: 'root', x: 50, y: 100 },
    { id: 'upper', parent: 'root', length: 50 },
    { id: 'lower', parent: 'upper', x: 50, length: 50 },
  ],
  warps: [{ id: 'bend', parent: 'root', rect: [40, 60, 120, 80], cols: 2, rows: 2 }],
  parts: [
    { id: 'autoSkin', shape: gridMesh(50, 90, 100, 20, 8, 2), skin: { bones: ['upper', 'lower'], falloff: 3 } },
    { id: 'rowSkin', shape: gridMesh(50, 90, 100, 20, 2, 1), skin: { bones: ['upper', 'lower'], weights: EXPLICIT_ROWS } },
    { id: 'onBone', parent: 'lower', shape: quad(110, 95, 20, 10) },
    { id: 'onWarp', parent: 'bend', shape: quad(60, 70, 30, 20) },
    { id: 'free', shape: quad(0, 0, 5, 5) },
    // A part may share its id with a bone: a bare "lower" means the bone, "part:lower" this part.
    { id: 'lower', parent: 'bend', shape: quad(120, 70, 20, 20) },
  ],
  bindings: [
    { target: 'bone:upper.rotation', params: ['A'], keys: [{ at: [-1], value: -30 }, { at: [0], value: 0 }, { at: [1], value: 40 }] },
    { target: 'bone:lower.rotation', params: ['A'], keys: [{ at: [-1], value: 25 }, { at: [0], value: 0 }, { at: [1], value: -60 }] },
    { target: 'bone:root.x', params: ['A'], keys: [{ at: [-1], value: 40 }, { at: [0], value: 50 }, { at: [1], value: 65 }] },
    { target: 'warp:bend.offsets', params: ['A'], keys: [{ at: [-1], value: { '4': [-6, 3] } }, { at: [0], value: {} }, { at: [1], value: { '4': [9, -5] } }] },
  ],
});

const setupVertices = (part: string) => (rig.model.parts.find((p) => p.id === part)!.shape as { vertices: number[] }).vertices;

/** Linear blend of the bone mappings of (x, y) with normalized weights. */
function blend(pose: Pose, weights: Record<string, number>, x: number, y: number): [number, number] {
  let sx = 0;
  let sy = 0;
  let sw = 0;
  for (const [bone, w] of Object.entries(weights)) {
    const [bx, by] = rig.mapPoint(pose, `bone:${bone}`, x, y);
    sx += w * bx;
    sy += w * by;
    sw += w;
  }
  return [sx / sw, sy / sw];
}

describe('rig: mapPoint through skinned parts', () => {
  it('maps every setup vertex of a skinned part onto its posed vertex (auto and explicit weights)', () => {
    for (const A of [-1, 0, 0.35, 1]) {
      const pose = rig.pose({ params: { A } });
      for (const part of ['autoSkin', 'rowSkin']) {
        const vertices = setupVertices(part);
        for (let i = 0; i < vertices.length / 2; i++) {
          expectNear(rig.mapPoint(pose, part, vertices[i * 2], vertices[i * 2 + 1]), vertex(fillOf(pose, part), i), 1e-3);
        }
      }
    }
  });

  it('weights points between vertices like auto weights: 1 / (distance + 1)^falloff, normalized', () => {
    const pose = rig.pose({ params: { A: 0.8 } });
    // The joint lies on both segments: equal weights.
    expectNear(rig.mapPoint(pose, 'autoSkin', 100, 100), blend(pose, { upper: 1, lower: 1 }, 100, 100), 1e-4);
    // (75, 100) is on "upper" and 25 px from "lower" (falloff 3); (130, 80) is 20 px from "lower", ~36 px from "upper".
    expectNear(rig.mapPoint(pose, 'autoSkin', 75, 100), blend(pose, { upper: 1, lower: 1 / 26 ** 3 }, 75, 100), 1e-4);
    const du = Math.hypot(130 - 100, 80 - 100);
    expectNear(rig.mapPoint(pose, 'autoSkin', 130, 80), blend(pose, { upper: 1 / (du + 1) ** 3, lower: 1 / 21 ** 3 }, 130, 80), 1e-4);
  });

  it('takes the explicit weight row of the nearest setup mesh vertex', () => {
    const pose = rig.pose({ params: { A: -0.6 } });
    // Nearest vertex 0 (50, 90): row [1, 0] -> rigidly with "upper".
    expectNear(rig.mapPoint(pose, 'rowSkin', 58, 93), rig.mapPoint(pose, 'upper', 58, 93), 1e-9);
    // Nearest vertex 1 (100, 90): row [0.5, 0.5].
    expectNear(rig.mapPoint(pose, 'rowSkin', 104, 94), blend(pose, { upper: 0.5, lower: 0.5 }, 104, 94), 1e-6);
    // Nearest vertex 5 (150, 110): row [0, 1] -> rigidly with "lower", even far outside the mesh.
    expectNear(rig.mapPoint(pose, 'rowSkin', 190, 130), rig.mapPoint(pose, 'lower', 190, 130), 1e-9);
  });

  it('is the identity in the setup pose', () => {
    const pose = rig.pose();
    expectNear(rig.mapPoint(pose, 'autoSkin', 123, 87), [123, 87], 1e-9);
    expectNear(rig.mapPoint(pose, 'rowSkin', 71, 104), [71, 104], 1e-9);
  });
});

describe('rig: mapPoint through other parts and explicit kinds', () => {
  it('maps a part with a parent like that parent, and a part in model space not at all', () => {
    const pose = rig.pose({ params: { A: 0.5 } });
    expect(rig.mapPoint(pose, 'onBone', 115, 97)).toEqual(rig.mapPoint(pose, 'lower', 115, 97));
    expect(rig.mapPoint(pose, 'onWarp', 70, 75)).toEqual(rig.mapPoint(pose, 'bend', 70, 75));
    expectNear(rig.mapPoint(pose, 'onWarp', 60, 70), vertex(fillOf(pose, 'onWarp'), 0), 1e-3);
    expect(rig.mapPoint(pose, 'free', 3, 4)).toEqual([3, 4]);
  });

  it('prefers bones and warps for a bare id and accepts "bone:", "warp:" and "part:" prefixes', () => {
    const pose = rig.pose({ params: { A: 1 } });
    const asBone = rig.mapPoint(pose, 'lower', 125, 75);
    const asPart = rig.mapPoint(pose, 'part:lower', 125, 75);
    expect(rig.mapPoint(pose, 'bone:lower', 125, 75)).toEqual(asBone);
    expect(asPart).toEqual(rig.mapPoint(pose, 'warp:bend', 125, 75));
    expect(asPart).not.toEqual(asBone);
    expectNear(rig.mapPoint(pose, 'part:autoSkin', 50, 90), vertex(fillOf(pose, 'autoSkin'), 0), 1e-3);
  });

  it('rejects unknown ids per kind, unknown kinds and poses without the skin bones', () => {
    const pose = rig.pose();
    expect(() => rig.mapPoint(pose, 'autoSkn', 0, 0)).toThrow('Rig.mapPoint: unknown parent "autoSkn" (not a bone, warp or part id) (did you mean "autoSkin"?)');
    expect(() => rig.mapPoint(pose, 'warp:lower', 0, 0)).toThrow('unknown parent "warp:lower" (not a warp id)');
    expect(() => rig.mapPoint(pose, 'part:uper', 0, 0)).toThrow('unknown parent "part:uper" (not a part id)');
    expect(() => rig.mapPoint(pose, 'bone:uper', 0, 0)).toThrow('unknown parent "bone:uper" (not a bone id) (did you mean "upper"?)');
    expect(() => rig.mapPoint(pose, 'ik:upper', 0, 0)).toThrow('unknown parent kind "ik" in "ik:upper" (use a bare id, or prefix it with "bone:", "warp:" or "part:")');
    expect(() => rig.mapPoint({ ...pose, bones: {} }, 'autoSkin', 0, 0)).toThrow(
      'the pose has no bone "upper" (skin bone of part "autoSkin"; pass a pose evaluated by this rig)',
    );
  });
});
