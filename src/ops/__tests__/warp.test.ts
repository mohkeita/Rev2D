import { describe, expect, it } from 'vitest';
import { Rig } from '../../core/rig.js';
import { validateModel } from '../../core/validate.js';
import { warpPoseOffsets } from '../index.js';
import { applyFail, applyOk, emptyDoc, rigDoc } from './fixtures.js';

const SQUARE = [0, 0, 100, 100] as const;

/** Offset of control point (col, row). */
function at(offsets: number[], cols: number, col: number, row: number): [number, number] {
  const i = (row * (cols + 1) + col) * 2;
  return [offsets[i], offsets[i + 1]];
}

describe('warpPoseOffsets', () => {
  it('rest pose and zero turns give exact zeros', () => {
    for (const pose of [{}, { yaw: 0 }, { pitch: 0 }, { yaw: 0, pitch: 0, rotate: 0, scale: 1, translate: [0, 0] as [number, number] }]) {
      const out = warpPoseOffsets([13, 7, 91, 55], 5, 3, pose);
      expect(out).toHaveLength(2 * 6 * 4);
      expect(out.every((v) => Object.is(v, 0))).toBe(true);
    }
  });

  it('translate moves every point uniformly', () => {
    const out = warpPoseOffsets(SQUARE, 3, 2, { translate: [5, -3] });
    for (let i = 0; i < out.length; i += 2) expect([out[i], out[i + 1]]).toEqual([5, -3]);
  });

  it('rotate 90 about the centre maps each corner onto the next one clockwise', () => {
    const out = warpPoseOffsets(SQUARE, 1, 1, { rotate: 90 });
    expect(at(out, 1, 0, 0)).toEqual([100, 0]); // top-left -> top-right
    expect(at(out, 1, 1, 0)).toEqual([0, 100]); // top-right -> bottom-right
    expect(at(out, 1, 1, 1)).toEqual([-100, 0]); // bottom-right -> bottom-left
    expect(at(out, 1, 0, 1)).toEqual([0, -100]); // bottom-left -> top-left
  });

  it('yaw > 0 shifts the centre column right more than the edges and compresses the far side', () => {
    const cols = 4;
    const out = warpPoseOffsets(SQUARE, cols, 2, { yaw: 20 });
    const dx = (col: number) => at(out, cols, col, 1)[0];
    expect(dx(2)).toBeGreaterThan(0);
    expect(dx(2)).toBeGreaterThan(dx(0));
    expect(dx(2)).toBeGreaterThan(dx(4));
    // Every row moves the same way, and nothing moves vertically.
    for (let col = 0; col <= cols; col++) {
      expect(at(out, cols, col, 0)[0]).toBe(dx(col));
      expect(at(out, cols, col, 2)[1]).toBe(0);
    }
    // Far (+x) half gets narrower, near half wider.
    const x = (col: number) => col * 25 + dx(col);
    expect(x(4) - x(2)).toBeLessThan(50);
    expect(x(2) - x(0)).toBeGreaterThan(50);
    // Negative yaw mirrors it.
    const back = warpPoseOffsets(SQUARE, cols, 2, { yaw: -20 });
    for (let col = 0; col <= cols; col++) expect(at(back, cols, cols - col, 1)[0]).toBeCloseTo(-dx(col), 4);
  });

  it('pitch > 0 moves the centre row down more than the edges', () => {
    const out = warpPoseOffsets(SQUARE, 2, 4, { pitch: 15 });
    const dy = (row: number) => at(out, 2, 1, row)[1];
    expect(dy(2)).toBeGreaterThan(0);
    expect(dy(2)).toBeGreaterThan(dy(0));
    expect(dy(2)).toBeGreaterThan(dy(4));
    expect(at(out, 2, 0, 2)[0]).toBe(0);
  });

  it('never folds the lattice over, even for large turns on dense lattices', () => {
    const cols = 16;
    const out = warpPoseOffsets(SQUARE, cols, 1, { yaw: 60 });
    for (let col = 1; col <= cols; col++) {
      expect(col * (100 / cols) + at(out, cols, col, 0)[0]).toBeGreaterThanOrEqual((col - 1) * (100 / cols) + at(out, cols, col - 1, 0)[0] - 1e-9);
    }
  });

  it('applies scale about the pivot, then rotate, then translate', () => {
    expect(at(warpPoseOffsets(SQUARE, 1, 1, { scale: 2 }), 1, 0, 0)).toEqual([-50, -50]);
    expect(at(warpPoseOffsets(SQUARE, 1, 1, { scale: 2, pivot: [0, 0] }), 1, 1, 1)).toEqual([100, 100]);
    expect(at(warpPoseOffsets(SQUARE, 1, 1, { scale: 2, translate: [10, 0] }), 1, 0, 0)).toEqual([-40, -50]);
    // Scale [2, 1] first, then rotate 90: top-right (50, -50) -> (100, -50) -> (50, 100) about the centre.
    expect(at(warpPoseOffsets(SQUARE, 1, 1, { scale: [2, 1], rotate: 90 }), 1, 1, 0)).toEqual([0, 150]);
  });
});

describe('bind_warp op', () => {
  function faceDoc() {
    return {
      ...emptyDoc(),
      parameters: [{ id: 'AngleX', min: -30, max: 30 }, { id: 'AngleY', min: -30, max: 30 }],
      warps: [{ id: 'face', rect: [100, 100, 200, 200], cols: 2, rows: 2 }],
      parts: [{ id: 'head', parent: 'face', shape: { type: 'ellipse', cx: 200, cy: 200, rx: 80, ry: 90 } }],
    };
  }

  it('generates full offset keyforms and a binding the rig evaluates', () => {
    const { doc, messages } = applyOk(faceDoc(), [
      { op: 'bind_warp', warp: 'face', params: ['AngleX'], keys: [{ at: [-30], yaw: -25 }, { at: [0] }, { at: [30], yaw: 25, translate: [4, 0] }] },
    ]);
    const binding = doc.bindings[0];
    expect(binding.target).toBe('warp:face.offsets');
    expect(binding.keys.map((k: any) => k.value.length)).toEqual([18, 18, 18]);
    expect(binding.keys[1].value.every((v: number) => v === 0)).toBe(true);
    expect(messages[0]).toMatch(/^added binding warp:face\.offsets ← \[AngleX\] as \/bindings\/0 \(3 keyforms\); 9 control points per keyform, largest displacement [\d.]+ px \(at \[30\]\)$/);

    const { model } = validateModel(doc);
    const pose = new Rig(model!).pose({ params: { AngleX: 30 } });
    const expected = binding.keys[2].value as number[];
    const points = pose.warps.face.points;
    // Centre control point (index 4) at rest (200, 200) plus its offset.
    expect(points[8]).toBeCloseTo(200 + expected[8], 3);
    expect(points[9]).toBeCloseTo(200 + expected[9], 3);
  });

  it('adds raw offsets on top and replaces the existing binding', () => {
    const first = applyOk(faceDoc(), [{ op: 'bind_warp', warp: 'face', params: ['AngleY'], keys: [{ at: [0] }, { at: [30], pitch: 10 }] }]);
    const second = applyOk(first.doc, [
      { op: 'bind_warp', warp: 'face', params: ['AngleY'], keys: [{ at: [0] }, { at: [30], translate: [0, 5], offsets: { '4': [1, 1] } }], id: 'look' },
    ]);
    expect(second.messages[0]).toMatch(/^replaced binding warp:face\.offsets ← \[AngleY\] at \/bindings\/0 \(2 keyforms, was 2\)/);
    const value = second.doc.bindings[0].keys[1].value as number[];
    expect(second.doc.bindings[0].id).toBe('look');
    expect([value[8], value[9]]).toEqual([1, 6]);
    expect([value[0], value[1]]).toEqual([0, 5]);
  });

  it('builds 2D grids for head turns', () => {
    const keys = [];
    for (const y of [-30, 0, 30]) for (const x of [-30, 0, 30]) keys.push({ at: [x, y], yaw: x * 0.8, pitch: y * 0.5 });
    const { doc } = applyOk(faceDoc(), [{ op: 'bind_warp', warp: 'face', params: ['AngleX', 'AngleY'], keys }]);
    expect(doc.bindings[0].keys).toHaveLength(9);
  });

  it('reports bad fields, warps and grids precisely', () => {
    let r = applyFail(faceDoc(), [{ op: 'bind_warp', warp: 'face', params: ['AngleX'], keys: [{ at: [0], rotation: 5 }] }]);
    expect(r.message).toBe('bind_warp: keys[0]: unknown field "rotation"');
    expect(r.hint).toContain('did you mean "rotate"?');
    r = applyFail(faceDoc(), [{ op: 'bind_warp', warp: 'fcae', params: ['AngleX'], keys: [{ at: [0] }] }]);
    expect(r.hint).toBe('did you mean "face"?');
    r = applyFail(faceDoc(), [{ op: 'bind_warp', warp: 'face', params: ['AngleX'], keys: [{ at: [0], scale: 'big' }] }]);
    expect(r.message).toBe('bind_warp: keys[0].scale must be a number or [sx, sy], got string "big"');
    r = applyFail(faceDoc(), [{ op: 'bind_warp', warp: 'face', params: ['AngleX'], keys: [{ at: [0], offsets: { '9': [1, 1] } }] }]);
    expect(r.message).toContain('point index 9 out of range (0..8)');
    r = applyFail(rigDoc(), [{ op: 'bind_warp', warp: 'face', params: ['AngleX', 'AngleY'], keys: [{ at: [0, 0] }, { at: [30, 30] }] }]);
    expect(r.message).toContain('keys do not form a full grid');
  });

  it('rejects turns of 90° or more and zero scales (they collapse the lattice)', () => {
    let r = applyFail(faceDoc(), [{ op: 'bind_warp', warp: 'face', params: ['AngleX'], keys: [{ at: [0] }, { at: [30], yaw: 90 }] }]);
    expect(r.message).toBe('bind_warp: keys[1].yaw must be between -90 and 90 degrees (exclusive), got 90');
    expect(r.hint).toBe('a turn of ±90° shows the lattice edge-on (every column on the limb); head turns typically use 10 to 30');
    r = applyFail(faceDoc(), [{ op: 'bind_warp', warp: 'face', params: ['AngleY'], keys: [{ at: [0] }, { at: [30], pitch: -120 }] }]);
    expect(r.message).toBe('bind_warp: keys[1].pitch must be between -90 and 90 degrees (exclusive), got -120');
    r = applyFail(faceDoc(), [{ op: 'bind_warp', warp: 'face', params: ['AngleX'], keys: [{ at: [0] }, { at: [30], scale: [1, 0] }] }]);
    expect(r.message).toBe('bind_warp: keys[1].scale must not be 0 (it collapses the lattice), got [1, 0]');
  });
});
