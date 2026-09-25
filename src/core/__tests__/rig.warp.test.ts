import { describe, expect, it } from 'vitest';
import { mapThroughWarp } from '../rig.js';
import { expectNear, fillOf, makeRig, pointsMesh, vertex } from './rig.fixtures.js';

/** Probe points (as a mesh) inside and around the rect [0,0,100,100]. */
const PROBES = [0, 0, 50, 50, 25, 25, 75, 75, 100, 0, 25, 75, 150, 50, -50, 120];

function warpRig(body: NonNullable<Parameters<typeof makeRig>[0]>) {
  return makeRig({
    parameters: [{ id: 'A', min: 0, max: 1 }],
    ...body,
    parts: [{ id: 'probe', parent: 'w', shape: pointsMesh(PROBES) }, ...(body.parts ?? [])],
  });
}

const pull = (offsets: Record<string, [number, number]> | number[]) => ({
  target: 'warp:w.offsets',
  params: ['A'],
  keys: [
    { at: [0], value: {} },
    { at: [1], value: offsets },
  ],
});

describe('rig: warps', () => {
  it('is the identity at rest (inside and outside the rect)', () => {
    const pose = warpRig({ warps: [{ id: 'w', rect: [0, 0, 100, 100], cols: 3, rows: 2 }] }).pose();
    expectNear(fillOf(pose, 'probe'), PROBES, 1e-4);
    expect(pose.warps.w.points.length).toBe(4 * 3 * 2);
    expect([pose.warps.w.cols, pose.warps.w.rows]).toEqual([3, 2]);
  });

  it('translates everything by a uniform offset', () => {
    const rig = warpRig({
      warps: [{ id: 'w', rect: [0, 0, 100, 100], cols: 2, rows: 2 }],
      bindings: [pull(new Array(18).fill(0).map((_, i) => (i % 2 ? 5 : 10)))],
    });
    const out = fillOf(rig.pose({ params: { A: 1 } }), 'probe');
    expectNear(out, PROBES.map((v, i) => v + (i % 2 ? 5 : 10)), 1e-4);
  });

  it('pulling one control point moves only its neighbouring cells, bilinearly', () => {
    const rig = warpRig({
      warps: [{ id: 'w', rect: [0, 0, 100, 100], cols: 2, rows: 2 }],
      bindings: [pull({ '4': [10, 0] })],
    });
    const out = fillOf(rig.pose({ params: { A: 1 } }), 'probe');
    expectNear(vertex(out, 0), [0, 0]); // corner
    expectNear(vertex(out, 1), [60, 50]); // the pulled point itself
    expectNear(vertex(out, 2), [27.5, 25]); // cell centre: weight 1/4
    expectNear(vertex(out, 3), [77.5, 75]);
    expectNear(vertex(out, 4), [100, 0]); // other corner
    expectNear(vertex(out, 5), [27.5, 75]);
    // Outside: the edge cell's bilinear formula extrapolates its gradient (the pull fades out at the
    // right edge, so it continues past it with the opposite sign).
    expectNear(vertex(out, 6), [140, 50]);
  });

  it('a pulled control point leaves cells that do not touch it unchanged', () => {
    const rig = makeRig({
      parameters: [{ id: 'A', min: 0, max: 1 }],
      warps: [{ id: 'w', rect: [0, 0, 100, 100], cols: 4, rows: 4 }],
      parts: [{ id: 'probe', parent: 'w', shape: pointsMesh([12.5, 12.5, 37.5, 37.5, 62.5, 62.5, 87.5, 12.5, 50, 50]) }],
      // Point 6 = (col 1, row 1) at (25, 25).
      bindings: [pull({ '6': [8, -4] })],
    });
    const out = fillOf(rig.pose({ params: { A: 1 } }), 'probe');
    // Centres of the cells on either side of the point get 1/4 of its offset.
    expectNear(vertex(out, 0), [14.5, 11.5]);
    expectNear(vertex(out, 1), [39.5, 36.5]);
    // Cells that do not have the point as a corner (and the rest point (50, 50)) stay put.
    expectNear(vertex(out, 2), [62.5, 62.5]);
    expectNear(vertex(out, 3), [87.5, 12.5]);
    expectNear(vertex(out, 4), [50, 50]);
  });

  it('extrapolates outside the rect from the nearest edge cell', () => {
    // Offsets = rest positions: the lattice scales by 2 about the origin.
    const rig = warpRig({
      warps: [{ id: 'w', rect: [0, 0, 100, 100], cols: 1, rows: 1 }],
      bindings: [pull([0, 0, 100, 0, 0, 100, 100, 100])],
    });
    const out = fillOf(rig.pose({ params: { A: 1 } }), 'probe');
    expectNear(out, PROBES.map((v) => v * 2), 1e-3);
  });

  it('follows a rotating parent bone', () => {
    const rig = warpRig({
      bones: [{ id: 'b', x: 50, y: 50 }],
      warps: [{ id: 'w', parent: 'b', rect: [0, 0, 100, 100], cols: 2, rows: 2 }],
      bindings: [{ target: 'bone:b.rotation', params: ['A'], keys: [{ at: [0], value: 0 }, { at: [1], value: 90 }] }],
    });
    const out = fillOf(rig.pose({ params: { A: 1 } }), 'probe');
    expectNear(vertex(out, 0), [100, 0]);
    expectNear(vertex(out, 1), [50, 50]);
    expectNear(vertex(out, 4), [100, 100]);
    expectNear(vertex(out, 6), [50, 150]);
    // The lattice itself is reported in world space.
    expectNear(Array.from(rig.pose({ params: { A: 1 } }).warps.w.points.slice(0, 2)), [100, 0]);
  });

  it('maps nested warps through the parent lattice', () => {
    const rig = warpRig({
      warps: [
        { id: 'w', parent: 'outer', rect: [0, 0, 100, 100], cols: 2, rows: 2 },
        { id: 'outer', rect: [-100, -100, 400, 400], cols: 1, rows: 1 },
      ],
      bindings: [
        // Outer lattice: shift by (+10, 0) → everything inside shifts.
        { target: 'warp:outer.offsets', params: ['A'], keys: [{ at: [0], value: {} }, { at: [1], value: [10, 0, 10, 0, 10, 0, 10, 0] }] },
        pull({ '4': [0, 20] }),
      ],
    });
    const out = fillOf(rig.pose({ params: { A: 1 } }), 'probe');
    expectNear(vertex(out, 0), [10, 0]);
    expectNear(vertex(out, 1), [60, 70]);
    expectNear(vertex(out, 2), [35, 30]);
    expectNear(vertex(out, 6), [160, 30]); // extrapolated from the inner edge cell, then shifted
  });

  it('mapThroughWarp maps single points (for editors)', () => {
    const lattice = [0, 0, 100, 0, 0, 100, 120, 100];
    expectNear(mapThroughWarp(lattice, 1, 1, [0, 0, 100, 100], 100, 100), [120, 100]);
    expectNear(mapThroughWarp(lattice, 1, 1, [0, 0, 100, 100], 50, 50), [55, 50]);
    // Beyond the bottom edge the column continues linearly: x = 50 at v=0, 60 at v=1 → 70 at v=2.
    expectNear(mapThroughWarp(lattice, 1, 1, [0, 0, 100, 100], 50, 200), [70, 200]);
  });

  it('rejects unknown, ambiguous and cyclic parents', () => {
    expect(() => makeRig({ warps: [{ id: 'w', parent: 'nope', rect: [0, 0, 1, 1] }] })).toThrow(/warp "w": unknown parent "nope"/);
    expect(() =>
      makeRig({
        warps: [
          { id: 'a', parent: 'b', rect: [0, 0, 1, 1] },
          { id: 'b', parent: 'a', rect: [0, 0, 1, 1] },
        ],
      }),
    ).toThrow(/warp parent cycle/);
    expect(() => makeRig({ bones: [{ id: 'x' }], warps: [{ id: 'x', rect: [0, 0, 1, 1] }, { id: 'w', parent: 'x', rect: [0, 0, 1, 1] }] })).toThrow(
      /warp "w": parent "x" is ambiguous/,
    );
    // An unreferenced shared id is only a validator warning, so the rig must still compile it.
    expect(() => makeRig({ bones: [{ id: 'x' }], warps: [{ id: 'x', rect: [0, 0, 1, 1] }] })).not.toThrow();
  });
});
