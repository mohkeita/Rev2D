/**
 * Spine bone shear, reproduced by the importer with two Rev2D bones per sheared bone (a rotated child of
 * a non-uniformly scaled bone: R(phi)·diag(sx, sy)·R(theta)). Checked against Spine world transforms
 * computed with the independent helpers (spineLocal / compose). Regression tests for the official
 * windmill (sheared pivot: blades turn on an ellipse), powerup and owl examples.
 */
import { describe, expect, it } from 'vitest';
import { apply } from '../../../core/math.js';
import { importSpine } from '../index.js';
import { animation, applyAffine, bone, canvasOf, codes, compose, expectClose, load, spineLocal, type Affine } from './helpers.js';

/** Canvas position of the local point (px, py) (Spine units, y up) of a Rev2D bone in a pose (scale 1). */
function revPoint(world: readonly number[], px: number, py: number): [number, number] {
  return apply(world as [number, number, number, number, number, number], px, -py);
}

const LOCAL_POINTS: Array<[number, number]> = [
  [0, 0],
  [30, 0],
  [0, 20],
  [25, -15],
];

describe('spine import: shear', () => {
  it('turns children of a statically sheared bone on the sheared plane (exact, keys kept)', () => {
    const res = importSpine({
      skeleton: {
        skeleton: { spine: '4.2.0' },
        bones: [
          { name: 'root' },
          { name: 'pivot', parent: 'root', x: -80, y: 360, scaleX: 0.86, shearX: -20 },
          { name: 'blade', parent: 'pivot', x: -5, y: -6, length: 40 },
        ],
        animations: {
          spin: {
            bones: {
              pivot: { rotate: [{ value: 0, curve: [0.3, 0, 0.6, 45] }, { time: 1, value: 90 }] },
              blade: { rotate: [{ value: 0 }, { time: 2, value: 360 }] },
            },
          },
        },
      },
    });
    const { rig } = load(res);
    const toCanvas = canvasOf(res.doc);
    // Two Rev2D bones for the pivot: "pivot-shear" (translation, rotation, scale) carries "pivot".
    expect(bone(res.doc, 'pivot').parent).toBe('pivot-shear');
    expect(bone(res.doc, 'pivot-shear').parent).toBe('root');
    expect(bone(res.doc, 'blade').parent).toBe('pivot');
    expect(res.report.issues.find((i) => i.code === 'spine-bone-shear-pair')?.where).toBe('bones[1] (pivot)');
    expect(codes(res)).not.toContain('spine-bone-shear');
    // Only the rotation is animated: the outer bone's track keeps the Spine keys and their curve.
    const track = animation(res.doc, 'spin').tracks.find((t: { target: string }) => t.target === 'bone:pivot-shear.rotation');
    expect(track.keys).toHaveLength(2);
    expect(track.keys[0].ease).toEqual([0.3, 0, 0.6, 0.5]);
    for (const t of [0, 0.25, 0.5, 1, 1.5]) {
      const pose = rig.pose({ animations: ['spin'], time: t });
      // Spine (independent): pivot and blade rotations from the timelines.
      const u = Math.min(1, t);
      const pivotRot = t >= 1 ? 90 : bezierAt(u, [0.3, 0, 0.6, 45], 90);
      const pivot: Affine = spineLocal({ x: -80, y: 360, rotation: pivotRot, scaleX: 0.86, shearX: -20 });
      const blade = compose(pivot, spineLocal({ x: -5, y: -6, rotation: 180 * t }));
      for (const [px, py] of LOCAL_POINTS) expectClose(revPoint(pose.bones.blade.world, px, py), toCanvas(...applyAffine(blade, px, py)), 1e-6);
    }
  });

  it('samples bones whose shear and scale are animated', () => {
    const res = importSpine({
      skeleton: {
        skeleton: { spine: '4.2.0' },
        bones: [
          { name: 'root' },
          { name: 'wing', parent: 'root', rotation: 30, length: 50 },
          { name: 'tip', parent: 'wing', x: 50, length: 20 },
        ],
        animations: {
          flap: {
            bones: {
              wing: {
                rotate: [{ value: 0 }, { time: 1, value: -40 }],
                shear: [{ x: 0, y: 0 }, { time: 0.5, x: 25, y: -10 }, { time: 1, x: 0, y: 0 }],
                scale: [{ x: 1, y: 1 }, { time: 1, x: 1.5, y: 0.8 }],
              },
            },
          },
        },
      },
    });
    const { rig } = load(res);
    const toCanvas = canvasOf(res.doc);
    expect(bone(res.doc, 'wing').parent).toBe('wing-shear');
    for (const t of [0.1, 0.33, 0.5, 0.71, 0.95]) {
      const pose = rig.pose({ animations: ['flap'], time: t });
      const k = t <= 0.5 ? t / 0.5 : (1 - t) / 0.5;
      const wing = spineLocal({ rotation: 30 - 40 * t, shearX: 25 * k, shearY: -10 * k, scaleX: 1 + 0.5 * t, scaleY: 1 - 0.2 * t });
      const tip = compose(wing, spineLocal({ x: 50 }));
      // Sampled within 0.05° / 0.0005 per sample interval: well under 0.1 px here.
      for (const [px, py] of LOCAL_POINTS) {
        expectClose(revPoint(pose.bones.wing.world, px, py), toCanvas(...applyAffine(wing, px, py)), 0.1);
        expectClose(revPoint(pose.bones.tip.world, px, py), toCanvas(...applyAffine(tip, px, py)), 0.1);
      }
    }
    expect(res.report.stats.sampledShearTracks).toBe(1);
    expect(codes(res)).not.toContain('spine-timeline-shear');
  });

  it('keeps one bone (dropping the shear, reported) for bones inside IK chains', () => {
    const res = importSpine({
      skeleton: {
        skeleton: { spine: '4.2.0' },
        bones: [
          { name: 'root' },
          { name: 'a', parent: 'root', length: 20, shearY: 10 },
          { name: 't', parent: 'root', x: 10, y: 10 },
        ],
        ik: [{ name: 'aim', bones: ['a'], target: 't' }],
      },
    });
    expect(res.report.issues.find((i) => i.code === 'spine-bone-shear')).toMatchObject({ severity: 'warning', where: 'bones[1] (a)' });
    expect((res.doc.bones as Array<{ id: string }>).map((b) => b.id)).toEqual(['root', 'a', 't']);
  });
});

/** Value of a Spine bezier timeline segment 0 -> v1 over [0, 1] at time u (dense sampling, independent). */
function bezierAt(u: number, c: [number, number, number, number], v1: number): number {
  const N = 20000;
  let px = 0;
  let py = 0;
  for (let i = 1; i <= N; i++) {
    const s = i / N;
    const m = 1 - s;
    const x = 3 * m * m * s * c[0] + 3 * m * s * s * c[2] + s * s * s;
    const y = 3 * m * m * s * c[1] + 3 * m * s * s * c[3] + s * s * s * v1;
    if (x >= u) return x === px ? y : py + ((u - px) / (x - px)) * (y - py);
    px = x;
    py = y;
  }
  return v1;
}
