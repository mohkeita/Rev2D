import { describe, expect, it } from 'vitest';
import { apply, fromTRS, multiply } from '../../../core/math.js';
import type { Mat2D } from '../../../core/types.js';
import {
  computeSpineWorlds,
  decomposeMatrix,
  rev2dLocalFromSpine,
  rev2dWorldFromSpine,
  spineLocalMatrix,
  spineToCanvas,
  spineWorldMatrix,
  type SpineBoneLocal,
} from '../transform.js';
import { expectClose, spineLocal } from './helpers.js';

const bone = (o: Partial<SpineBoneLocal>): SpineBoneLocal => ({ x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, shearX: 0, shearY: 0, inherit: 'normal', ...o });
const angle = (m: Mat2D) => (Math.atan2(m[1], m[0]) * 180) / Math.PI;
const xLen = (m: Mat2D) => Math.hypot(m[0], m[1]);
const yLen = (m: Mat2D) => Math.hypot(m[2], m[3]);
const det = (m: Mat2D) => m[0] * m[3] - m[1] * m[2];

describe('spine transform: local and world matrices', () => {
  it('builds local matrices with rotation, scale and shear per axis', () => {
    const b = { x: 3, y: -4, rotation: 30, scaleX: 2, scaleY: 0.5, shearX: 10, shearY: -20 };
    const ref = spineLocal(b);
    expectClose(spineLocalMatrix(b), [ref.a, ref.c, ref.b, ref.d, 3, -4], 1e-12);
  });

  it('composes normal inheritance as parent · local', () => {
    const parent = spineLocalMatrix(bone({ x: 5, rotation: 40, scaleX: 2 }));
    const child = bone({ x: 10, y: 2, rotation: -15, scaleY: 3 });
    expectClose(spineWorldMatrix(parent, child), multiply(parent, spineLocalMatrix(child)), 1e-12);
    expect(() => computeSpineWorlds([{ ...child, parent: 1 }, { ...child, parent: -1 }])).toThrow(/before its parent/);
  });

  it('onlyTranslation keeps the local rotation / scale and follows the parent position only', () => {
    const parent = spineLocalMatrix(bone({ x: 5, y: 1, rotation: 90, scaleX: 3, scaleY: 3 }));
    const w = spineWorldMatrix(parent, bone({ x: 10, rotation: 20, scaleX: 2, inherit: 'onlyTranslation' }));
    expect(angle(w)).toBeCloseTo(20, 10);
    expect(xLen(w)).toBeCloseTo(2, 10);
    expectClose([w[4], w[5]], apply(parent, 10, 0), 1e-10);
  });

  it('noRotationOrReflection drops the parent rotation and reflection but keeps its scale', () => {
    const parent = spineLocalMatrix(bone({ rotation: 30, scaleX: 2, scaleY: -2 }));
    const w = spineWorldMatrix(parent, bone({ x: 4, rotation: 10, inherit: 'noRotationOrReflection' }));
    expect(angle(w)).toBeCloseTo(10, 8);
    expect(xLen(w)).toBeCloseTo(2, 8);
    expect(yLen(w)).toBeCloseTo(2, 8);
    expect(det(w)).toBeGreaterThan(0);
    expectClose([w[4], w[5]], apply(parent, 4, 0), 1e-10);
  });

  it('noScale keeps the parent rotation but not its scale; noScaleOrReflection also drops mirroring', () => {
    const parent = spineLocalMatrix(bone({ rotation: 30, scaleX: 3, scaleY: 3 }));
    const w = spineWorldMatrix(parent, bone({ rotation: 15, scaleX: 1.5, inherit: 'noScale' }));
    expect(angle(w)).toBeCloseTo(45, 8);
    expect(xLen(w)).toBeCloseTo(1.5, 8);
    expect(yLen(w)).toBeCloseTo(1, 8);
    const mirrored = spineLocalMatrix(bone({ scaleX: 2, scaleY: -2 }));
    expect(det(spineWorldMatrix(mirrored, bone({ inherit: 'noScale' })))).toBeLessThan(0);
    expect(det(spineWorldMatrix(mirrored, bone({ inherit: 'noScaleOrReflection' })))).toBeGreaterThan(0);
  });
});

describe('spine transform: Rev2D mapping', () => {
  it('flips y and negates rotations: Rev2D locals compose to the mapped Spine worlds', () => {
    const S = 1.5;
    const canvas = spineToCanvas(S, 100, 200);
    const nodes = [
      { ...bone({ x: 10, y: 20, rotation: 30 }), parent: -1 },
      { ...bone({ x: 15, y: -5, rotation: -70, scaleX: 2, scaleY: 0.5 }), parent: 0 },
      { ...bone({ x: 7, y: 3, rotation: 200, scaleX: -1 }), parent: 1 },
    ];
    const worlds = computeSpineWorlds(nodes);
    let parentRev: Mat2D | null = null;
    nodes.forEach((n, i) => {
      const l = rev2dLocalFromSpine(n, S);
      expect(l.rotation).toBe(-n.rotation);
      expect(l.y).toBe(-n.y * S);
      const local = fromTRS(l.x + (i === 0 ? 100 : 0), l.y + (i === 0 ? 200 : 0), l.rotation, l.scaleX, l.scaleY);
      const rev: Mat2D = parentRev ? multiply(parentRev, local) : local;
      expectClose(rev, rev2dWorldFromSpine(worlds[i], canvas, S), 1e-9);
      // A point local to the bone lands where the mapped Spine world point is.
      const [sx, sy] = apply(worlds[i], 3, 4);
      expectClose(apply(rev, 3 * S, -4 * S), apply(canvas, sx, sy), 1e-9);
      parentRev = rev;
    });
  });

  it('decomposes matrices into rotation, scale and residual shear', () => {
    const d = decomposeMatrix(fromTRS(3, 4, 25, 2, -0.5));
    expect(d.x).toBe(3);
    expect(d.y).toBe(4);
    expect(d.rotation).toBeCloseTo(25, 10);
    expect(d.scaleX).toBeCloseTo(2, 10);
    expect(d.scaleY).toBeCloseTo(-0.5, 10);
    expect(d.shear).toBeCloseTo(0, 10);
    const sheared = spineLocalMatrix(bone({ rotation: 0, shearY: 20 }));
    expect(Math.abs(decomposeMatrix(sheared).shear)).toBeCloseTo(20, 8);
  });
});
