/** Lattices, weights, fields and sparse offsets of the avatar builder (src/avatar/fields.ts). */
import { describe, expect, it } from 'vitest';
import {
  applyField,
  avatarMetrics,
  bandWeight,
  denseOffsets,
  domeWeight,
  ellipseLevel,
  fanWeight,
  fieldOffsets,
  gaussianWeight,
  isEdgePoint,
  latticeCell,
  latticeFolds,
  latticeOf,
  latticePointCount,
  makeLattice,
  MAX_LATTICE_CELLS,
  multiplyWeights,
  nestedLattice,
  ramp,
  rectFadeWeight,
  rotationField,
  sampleField,
  scaleField,
  shiftField,
  smoothstep,
  softEllipseWeight,
  sparseOffsets,
  sumFields,
  weightField,
  type Ellipse,
  type Field,
} from '../fields.js';
import { parseAvatarSpec } from '../spec.js';
import { validDoc } from './fixtures.js';

const DEG = Math.PI / 180;

describe('lattices', () => {
  it('builds row-major rest points over the rect', () => {
    const l = latticeOf([10, 20, 100, 50], 4, 2);
    expect(latticePointCount(l)).toBe(15);
    expect(Array.from(l.points.slice(0, 4))).toEqual([10, 20, 35, 20]);
    expect(Array.from(l.points.slice(-2))).toEqual([110, 70]);
    // index = row * (cols + 1) + col
    expect([l.points[(1 * 5 + 2) * 2], l.points[(1 * 5 + 2) * 2 + 1]]).toEqual([60, 45]);
    expect(latticeCell(l)).toEqual([25, 25]);
    expect(() => latticeOf([0, 0, 0, 10], 2, 2)).toThrow(/positive size/);
    expect(() => latticeOf([0, 0, 10, 10], 0, 2)).toThrow(/whole numbers/);
  });

  it('chooses the cell count from a target cell size, within the limits', () => {
    const l = makeLattice([0, 0, 1000, 500], 25);
    expect([l.cols, l.rows]).toEqual([40, 20]);
    const fine = makeLattice([0, 0, 1000, 500], 2);
    expect([fine.cols, fine.rows]).toEqual([MAX_LATTICE_CELLS, MAX_LATTICE_CELLS]);
    const coarse = makeLattice([0, 0, 30, 30], 100);
    expect([coarse.cols, coarse.rows]).toEqual([2, 2]);
    expect(makeLattice([0, 0, 30, 30], 100, { min: 1 }).cols).toBe(1);
    expect(makeLattice([0, 0, 1000, 1000], 10, { max: 16 }).cols).toBe(16);
    expect(() => makeLattice([0, 0, 10, 10], 0)).toThrow(/cell size/);
  });

  it('keeps a nested lattice inside its parent and on whole pixels', () => {
    const parent: [number, number, number, number] = [0, 0, 400, 500];
    const l = nestedLattice([150.4, 180.2, 40.3, 30.1], parent, 8, 6)!;
    expect(l.rect).toEqual([144, 174, 53, 43]);
    expect([l.cols, l.rows]).toEqual([7, 5]);
    // A rect at the border is clipped, one outside gives nothing.
    expect(nestedLattice([380, 480, 60, 60], parent, 10)!.rect).toEqual([380, 480, 20, 20]);
    expect(nestedLattice([500, 10, 20, 20], parent, 10)).toBeNull();
  });

  it('knows its edge points', () => {
    const l = latticeOf([0, 0, 30, 30], 3, 3);
    const edge = Array.from({ length: 16 }, (_, i) => isEdgePoint(l, i));
    expect(edge.filter(Boolean)).toHaveLength(12);
    expect([edge[5], edge[6], edge[9], edge[10]]).toEqual([false, false, false, false]);
  });
});

describe('weights', () => {
  it('smoothstep and ramp', () => {
    expect([smoothstep(-1), smoothstep(0), smoothstep(0.5), smoothstep(1), smoothstep(2)]).toEqual([0, 0, 0.5, 1, 1]);
    expect(ramp(10, 20, 15)).toBe(0.5);
    expect(ramp(20, 10, 12)).toBeCloseTo(smoothstep(0.8), 12);
    expect([ramp(5, 5, 4), ramp(5, 5, 5)]).toEqual([0, 1]);
  });

  it('a band is full above its start and zero below its end', () => {
    const w = bandWeight([100, 200]);
    expect([w(0, 50), w(7, 100), w(0, 150), w(0, 200), w(0, 300)]).toEqual([1, 1, 0.5, 0, 0]);
  });

  it('a dome is exactly zero on and outside the rim, with zero slope there', () => {
    const e: Ellipse = { center: [100, 80], radius: [50, 30] };
    const w = domeWeight(e, 2);
    expect(w(100, 80)).toBe(1);
    expect(w(150, 80)).toBe(0);
    expect(w(100, 111)).toBe(0);
    expect(w(160, 80)).toBe(0);
    expect(w(125, 80)).toBeCloseTo((1 - 0.25) ** 2, 12);
    // Slope at the rim: the value 1 px inside is second order small.
    expect(w(149, 80)).toBeLessThan(0.002);
    expect(domeWeight(e, 1.5)(149, 80)).toBeLessThan(0.01);
    expect(ellipseLevel(e, 150, 80)).toBe(1);
  });

  it('a soft ellipse, a gaussian and a rect fade', () => {
    const e: Ellipse = { center: [0, 0], radius: [100, 50] };
    const soft = softEllipseWeight(e, 1, 1.5);
    expect([soft(0, 0), soft(100, 0), soft(125, 0), soft(150, 0), soft(0, 80)]).toEqual([1, 1, 0.5, 0, 0]);
    const g = gaussianWeight([10, 10], 5);
    expect(g(10, 10)).toBe(1);
    expect(g(15, 10)).toBeCloseTo(Math.exp(-0.5), 12);
    expect(g(25, 10)).toBe(0);
    expect(g(10, 24.9)).toBeGreaterThan(0);
    expect(gaussianWeight([0, 0], [10, 2])(10, 0)).toBeCloseTo(gaussianWeight([0, 0], [10, 2])(0, 2), 12);
    const fade = rectFadeWeight([10, 10, 100, 60], 20);
    expect([fade(10, 40), fade(60, 10), fade(5, 40), fade(60, 40), fade(20, 40)]).toEqual([0, 0, 0, 1, 0.5]);
    expect(multiplyWeights(soft, () => 0.5)(0, 0)).toBe(0.5);
  });

  it('a fan depends on the direction from the pivot only', () => {
    const w = fanWeight([100, 100], 60, 90);
    expect(w(100, 0)).toBe(1);
    expect(w(100, 200)).toBe(0);
    // 45 degrees from up on both sides, near and far.
    expect([w(150, 50), w(50, 50), w(1100, -900)]).toEqual([1, 1, 1]);
    // Level with the pivot and below: nothing.
    expect([w(300, 100), w(0, 100), w(150, 150)]).toEqual([0, 0, 0]);
    // 75 degrees: halfway down the fade, at any distance.
    const at = (d: number) => w(100 + d * Math.sin(75 * DEG), 100 - d * Math.cos(75 * DEG));
    expect(at(10)).toBeCloseTo(0.5, 9);
    expect(at(1000)).toBeCloseTo(0.5, 9);
    expect(w(100, 100)).toBe(0);
  });
});

describe('fields', () => {
  it('rotates clockwise on screen about a pivot', () => {
    const f = rotationField([100, 100], 90);
    // Straight up goes to the right; right goes down.
    expect(applyField(f, 100, 50).map((v) => +v.toFixed(9))).toEqual([150, 100]);
    expect(applyField(f, 150, 100).map((v) => +v.toFixed(9))).toEqual([100, 150]);
    expect(rotationField([0, 0], 0)(5, 5)).toEqual([0, 0]);
  });

  it('blends the ANGLE, so a half-weighted point keeps its distance to the pivot', () => {
    const f = rotationField([0, 0], 60, () => 0.5);
    const [x, y] = applyField(f, 0, -100);
    expect(Math.hypot(x, y)).toBeCloseTo(100, 9);
    expect(Math.atan2(x, -y) / DEG).toBeCloseTo(30, 9);
    expect(rotationField([0, 0], 60, () => 0)(10, 10)).toEqual([0, 0]);
  });

  it('combines fields', () => {
    const a = shiftField(10, 0, () => 0.5);
    const b: Field = (x) => [0, x];
    expect(sumFields(a, b)(4, 0)).toEqual([5, 4]);
    expect(scaleField(b, 2)(4, 0)).toEqual([0, 8]);
    expect(weightField(b, (x) => (x > 3 ? 1 : 0))(4, 0)).toEqual([0, 4]);
    expect(weightField(b, () => 0)(4, 0)).toEqual([0, 0]);
  });
});

describe('offsets', () => {
  const lattice = latticeOf([0, 0, 40, 40], 4, 4);

  it('samples a field at the lattice points and lists only the points that move', () => {
    const field: Field = (x, y) => (x === 20 && y === 20 ? [1.23456, -0.004] : x === 30 ? [0.004, 0.0049] : [0, 0]);
    const dense = sampleField(lattice, field);
    expect(dense).toHaveLength(50);
    const sparse = sparseOffsets(dense);
    // Rounded to 2 decimals; a move below half a hundredth of a pixel is no move.
    expect(sparse).toEqual({ '12': [1.23, 0] });
    expect(Object.is(sparse['12'][1], -0)).toBe(false);
    expect(fieldOffsets(lattice, field)).toEqual(sparse);
    expect(Array.from(denseOffsets(lattice, sparse).slice(24, 26))).toEqual([1.23, 0]);
  });

  it('pins the edge points of a nested warp', () => {
    const everywhere: Field = () => [3, 4];
    const pinned = fieldOffsets(lattice, everywhere, { pinEdges: true });
    expect(Object.keys(pinned)).toEqual(['6', '7', '8', '11', '12', '13', '16', '17', '18']);
    expect(Object.keys(fieldOffsets(lattice, everywhere))).toHaveLength(25);
  });

  it('ignores non-finite field values', () => {
    expect(sparseOffsets(sampleField(lattice, () => [NaN, Infinity]))).toEqual({});
  });

  it('finds folded and collapsed cells of a lattice', () => {
    expect(latticeFolds(lattice, new Float64Array(50))).toEqual([]);
    // A rigid shift folds nothing.
    expect(latticeFolds(lattice, sampleField(lattice, () => [25, -7]))).toEqual([]);
    // Push the middle point past its right neighbour: the cells around it flip.
    const dense = new Float64Array(50);
    dense[12 * 2] = 15;
    const folds = latticeFolds(lattice, dense);
    expect(folds.length).toBeGreaterThanOrEqual(2);
    expect(folds[0].ratio).toBeLessThan(0);
    expect(folds.every((f) => f.col >= 1 && f.col <= 2 && f.row >= 1 && f.row <= 2)).toBe(true);
    // A squeeze to 5% is a collapse, not a flip.
    const squeeze = sampleField(lattice, (x) => [x > 15 && x < 25 ? -9.5 : x >= 25 ? -9.5 : 0, 0]);
    const collapsed = latticeFolds(lattice, squeeze);
    expect(collapsed[0].ratio).toBeCloseTo(0.05, 9);
    expect(latticeFolds(lattice, squeeze, 0.01)).toEqual([]);
  });
});

describe('avatarMetrics', () => {
  const spec = (mutate: (doc: any) => void = () => {}) => {
    const doc = validDoc();
    mutate(doc);
    const parsed = parseAvatarSpec(doc);
    if (!parsed.spec) throw new Error(JSON.stringify(parsed.diagnostics));
    return parsed.spec;
  };

  it('takes the amounts of the spec', () => {
    const m = avatarMetrics(spec());
    expect([m.width, m.height, m.long]).toEqual([400, 500, 500]);
    expect(m.turn).toEqual({ x: 14, y: 12 });
    expect([m.tilt, m.sway]).toEqual([8.5, 2]);
    expect(m.breath).toBeCloseTo(1.75, 12);
    expect(m.cell.body).toBe(10);
    expect(m.cellClamped).toBe(false);
    expect(m.feather).toBe(1.5);
    expect(m.head).toEqual({ center: [200, 170], radius: [130, 150] });
  });

  it('fills in the defaults and clamps a cell that would need too many lattice cells', () => {
    const m = avatarMetrics(
      spec((doc) => {
        delete doc.head.turn;
        delete doc.head.tilt;
        doc.body.breath = 3;
        doc.build = { cell: { body: 4, detail: 3 }, feather: 2 };
      }),
    );
    expect(m.turn.x).toBeCloseTo(14, 12);
    expect(m.turn.y).toBeCloseTo(12.5, 12);
    expect([m.tilt, m.breath, m.feather]).toEqual([8.5, 3, 2]);
    expect(m.cell.body).toBeCloseTo(500 / 64, 12);
    expect(m.cellClamped).toBe(true);
    expect(m.cell.detail).toBe(3);
  });
});
