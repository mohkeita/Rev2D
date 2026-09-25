import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseModelText, type Model } from '../src/core/index.js';
import { rigHighlight } from '../editor/src/overlay/highlight.js';
import {
  boneGlyph,
  boundaryEdges,
  formatCoord,
  gridLines,
  gridSpacing,
  latticePolylines,
  niceCeil,
  uniqueEdges,
} from '../editor/src/overlay/geometry.js';

describe('editor overlay geometry', () => {
  it('rounds up to 1-2-5 nice numbers', () => {
    expect(niceCeil(0.7)).toBe(1);
    expect(niceCeil(1)).toBe(1);
    expect(niceCeil(1.2)).toBe(2);
    expect(niceCeil(3)).toBe(5);
    expect(niceCeil(6)).toBe(10);
    expect(niceCeil(0.03)).toBeCloseTo(0.05, 12);
  });

  it('adapts grid spacing to the zoom so lines stay readable', () => {
    for (const zoom of [0.05, 0.3, 1, 2.5, 8, 40]) {
      const { minor, major } = gridSpacing(zoom, 12);
      expect(minor * zoom).toBeGreaterThanOrEqual(12 - 1e-9);
      expect(major * zoom).toBeGreaterThanOrEqual(48 - 1e-9);
      expect(Math.abs(major / minor - Math.round(major / minor))).toBeLessThan(1e-9);
    }
    expect(gridSpacing(1, 10)).toEqual({ minor: 10, major: 50 });
    expect(gridSpacing(1, 20)).toEqual({ minor: 20, major: 100 });
  });

  it('lists grid lines inside a range without float drift', () => {
    expect(gridLines(-12, 31, 10)).toEqual([-10, 0, 10, 20, 30]);
    expect(gridLines(0, 0.35, 0.1)).toEqual([0, 0.1, 0.2, 0.3]);
    expect(gridLines(5, 4, 1)).toEqual([]);
    expect(gridLines(0, 1e9, 1, 50)).toHaveLength(50);
    expect(formatCoord(0.30000000000000004, 0.1)).toBe('0.3');
    expect(formatCoord(-0.0001, 1)).toBe('0');
    expect(formatCoord(250, 50)).toBe('250');
  });

  it('extracts unique and boundary edges of a triangle list', () => {
    // Quad split into two triangles sharing the diagonal 0-2.
    const quad = [0, 1, 2, 0, 2, 3];
    const edges = uniqueEdges(quad);
    expect(edges.length / 2).toBe(5);
    const boundary = boundaryEdges(quad);
    expect(boundary.length / 2).toBe(4);
    const pairs = new Set<string>();
    for (let i = 0; i < boundary.length; i += 2) pairs.add([boundary[i], boundary[i + 1]].sort().join('-'));
    expect(pairs.has('0-2')).toBe(false);
    expect(pairs).toEqual(new Set(['0-1', '1-2', '2-3', '0-3']));
  });

  it('builds a kite-shaped bone glyph from joint to tip', () => {
    const g = boneGlyph(0, 0, 100, 0, 7);
    expect(g).not.toBeNull();
    const [jx, jy, ax, ay, tx, ty, bx, by] = g!;
    expect([jx, jy, tx, ty]).toEqual([0, 0, 100, 0]);
    expect(ax).toBeCloseTo(15, 9);
    expect(bx).toBeCloseTo(15, 9);
    expect(Math.abs(ay)).toBeCloseTo(7, 9);
    expect(ay).toBeCloseTo(-by, 9);
    expect(boneGlyph(0, 0, 2, 0)).toBeNull();
  });

  it('builds lattice polylines (rows then columns)', () => {
    // 2x1 lattice: 3 x 2 points.
    const pts = [0, 0, 10, 0, 20, 0, 0, 10, 10, 10, 20, 10];
    const lines = latticePolylines(pts, 2, 1);
    expect(lines).toHaveLength(2 + 3);
    expect(lines[0]).toEqual([0, 0, 10, 0, 20, 0]);
    expect(lines[2]).toEqual([0, 0, 0, 10]);
    expect(lines[4]).toEqual([20, 0, 20, 10]);
  });
});

function example(name: string): Model {
  const { model } = parseModelText(readFileSync(new URL(`../examples/${name}/${name}.r2d.json`, import.meta.url), 'utf8'));
  if (!model) throw new Error(`examples/${name} does not validate`);
  return model;
}

describe('editor selection highlight', () => {
  it('shows an IK constraint as its bone chain, its target and the goal line', () => {
    const h = rigHighlight(example('robot-arm'), [{ kind: 'ik', id: 'armIk' }]);
    expect([...h.bones]).toEqual(['upperArm', 'foreArm']);
    expect([...h.targets]).toEqual(['ikTarget']);
    expect(h.links).toEqual([{ from: 'foreArm', to: 'ikTarget' }]);
    expect(h.warps.size).toBe(0);
  });

  it('shows a physics group as the bones and warps its output parameters move', () => {
    const arm = rigHighlight(example('robot-arm'), [{ kind: 'physics', id: 'cableSwing' }]);
    expect([...arm.bones].sort()).toEqual(['cable1', 'cable2', 'cable3']);
    expect(arm.targets.size + arm.links.length).toBe(0);
    const hana = example('hana');
    expect([...rigHighlight(hana, [{ kind: 'physics', id: 'hairSide' }]).warps].sort()).toEqual(['sideHairWarpL', 'sideHairWarpR']);
    expect([...rigHighlight(hana, [{ kind: 'physics', id: 'hairFront' }]).warps]).toEqual(['frontHairWarp']);
  });

  it('includes selected bones and warps and ignores other kinds and unknown ids', () => {
    const h = rigHighlight(example('robot-arm'), [
      { kind: 'bone', id: 'hand' },
      { kind: 'part', id: 'base' },
      { kind: 'ik', id: 'nope' },
      { kind: 'physics', id: 'nope' },
      { kind: 'param', id: 'ReachX' },
    ]);
    expect([...h.bones]).toEqual(['hand']);
    expect(h.targets.size + h.warps.size + h.links.length).toBe(0);
  });
});
