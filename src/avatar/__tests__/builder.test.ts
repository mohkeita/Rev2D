/** ModelBuilder (ids, standard parameters, draw order, field bindings) and the fold checker. */
import { describe, expect, it } from 'vitest';
import { validateModel } from '../../core/validate.js';
import { AVATAR_Z, AvatarBuildError, ModelBuilder, STANDARD_PARAMETERS } from '../builder.js';
import { defaultFoldPoses, findFolds, foldIssues, FOLD_CODE } from '../folds.js';
import { domeWeight, shiftField } from '../fields.js';

function builder(): ModelBuilder {
  return new ModelBuilder({ name: 'test', width: 200, height: 100 });
}

/** A model with one 10 x 5 lattice, a mesh part in it and a binding that shifts a dome by `push` px. */
function pushModel(push: number, extra: (b: ModelBuilder) => void = () => {}) {
  const b = builder();
  const warp = b.warp({ id: 'w', rect: [0, 0, 200, 100], cols: 10, rows: 5 });
  b.part({ id: 'sheet', parent: 'w', shape: { type: 'rect', x: 0, y: 0, w: 200, h: 100, detail: 20 }, fill: '#808080', z: 0 });
  b.parameter('AngleX');
  b.bindField(warp, {
    id: 'push',
    params: ['AngleX'],
    keys: [{ at: [0] }, { at: [30], field: shiftField(push, 0, domeWeight({ center: [100, 50], radius: [60, 40] }, 2)) }],
  });
  extra(b);
  const { model, diagnostics } = validateModel(b.build());
  if (!model) throw new Error(JSON.stringify(diagnostics));
  return model;
}

describe('ModelBuilder', () => {
  it('declares standard parameters once, in the standard order, and custom ones after them', () => {
    const b = builder();
    b.parameter({ id: 'Hair_bang1', min: -1, max: 1, default: 0, group: 'Hair' });
    expect(b.parameter('Breath')).toBe('Breath');
    b.parameter('EyeLOpen');
    b.parameter('AngleX');
    b.parameter('AngleX');
    b.parameter({ id: 'Sway_tassel', min: -1, max: 1 });
    expect(b.parameterIds()).toEqual(['AngleX', 'EyeLOpen', 'Breath', 'Hair_bang1', 'Sway_tassel']);
    expect(b.hasParameter('EyeLOpen')).toBe(true);
    expect(b.hasParameter('EyeROpen')).toBe(false);
    const doc = b.build() as { parameters: Array<Record<string, unknown>> };
    expect(doc.parameters[1]).toEqual({ id: 'EyeLOpen', ...STANDARD_PARAMETERS.EyeLOpen });
    expect(doc.parameters[1].default).toBe(1);
    // The same id with another range is a bug of the feature that declares it.
    expect(() => b.parameter({ id: 'Breath', min: 0, max: 2 })).toThrow(AvatarBuildError);
    expect(() => b.parameter('Nope' as 'AngleX')).toThrow(/not a standard parameter/);
    expect(() => b.parameter({ id: '1bad', min: 0, max: 1 })).toThrow(/not a valid id/);
  });

  it('keeps ids unique and references sound', () => {
    const b = builder();
    b.warp({ id: 'root', rect: [0, 0, 200, 100], cell: 20 });
    expect(() => b.warp({ id: 'root', rect: [0, 0, 10, 10], cell: 5 })).toThrow(/used twice/);
    expect(() => b.warp({ id: 'child', parent: 'nope', rect: [0, 0, 10, 10], cell: 5 })).toThrow(/parent warp "nope"/);
    expect(() => b.warp({ id: 'child', rect: [0, 0, 10, 10] })).toThrow(/cell size or cols and rows/);
    b.part({ id: 'a', parent: 'root', shape: { type: 'rect', x: 0, y: 0, w: 10, h: 10 }, z: 1 });
    expect(() => b.part({ id: 'a', shape: { type: 'rect', x: 0, y: 0, w: 10, h: 10 }, z: 1 })).toThrow(/used twice/);
    expect(() => b.part({ id: 'b', parent: 'ghost', shape: { type: 'rect', x: 0, y: 0, w: 10, h: 10 }, z: 1 })).toThrow(/parent warp "ghost"/);
    expect(() => b.part({ id: 'b', mask: ['ghost'], shape: { type: 'rect', x: 0, y: 0, w: 10, h: 10 }, z: 1 })).toThrow(/mask part "ghost"/);
    expect(() => b.bind({ target: 'part:a.opacity', params: ['Cheek'], keys: [{ at: [0], value: 0 }] })).toThrow(/"Cheek" is not declared/);
    b.parameter('Cheek');
    b.bind({ id: 'blush', target: 'part:a.opacity', params: ['Cheek'], keys: [{ at: [0], value: 0 }, { at: [1], value: 1 }] });
    expect(() => b.bind({ id: 'blush', target: 'part:a.opacity', params: ['Cheek'], keys: [{ at: [0], value: 0 }] })).toThrow(/used twice/);
    expect(() => b.physics({ id: 'p', inputs: [{ param: 'AngleX', type: 'x' }], outputs: [{ param: 'Cheek' }] })).toThrow(/"AngleX" is not declared/);
    b.texture({ id: 'base', file: 'textures/base.png', rect: [0, 0, 200, 100] });
    expect(b.texture({ id: 'base', file: 'textures/base.png', rect: [0, 0, 200, 100] })).toBe('base');
    expect(() => b.texture({ id: 'base', file: 'textures/other.png', rect: [0, 0, 1, 1] })).toThrow(/two files/);
    expect(b.warpHandle('root').lattice.cols).toBe(10);
    expect(() => b.warpHandle('ghost')).toThrow(/unknown warp/);
    expect(b.findPart('a')?.z).toBe(1);
    expect(b.hasWarp('root') && b.hasPart('a') && !b.hasPart('zzz')).toBe(true);
  });

  it('writes parts back to front by z, ties in the order they were added', () => {
    const b = builder();
    const rect = { type: 'rect' as const, x: 0, y: 0, w: 10, h: 10 };
    b.part({ id: 'hair', shape: rect, z: AVATAR_Z.hair });
    b.part({ id: 'eyeBall', shape: rect, z: AVATAR_Z.eyes });
    b.part({ id: 'base', shape: rect, z: AVATAR_Z.base });
    b.part({ id: 'eyeLid', shape: rect, z: AVATAR_Z.eyes });
    const doc = b.build() as { parts: Array<{ id: string; z: number }> };
    expect(doc.parts.map((p) => p.id)).toEqual(['base', 'eyeBall', 'eyeLid', 'hair']);
    expect(doc.parts.every((p) => typeof p.z === 'number')).toBe(true);
    const z = Object.values(AVATAR_Z);
    expect([...z].sort((a, b2) => a - b2)).toEqual(z);
    expect(new Set(z).size).toBe(z.length);
  });

  it('binds fields as sparse offsets and builds a valid model', () => {
    const b = builder();
    const warp = b.warp({ id: 'w', rect: [0, 0, 200, 100], cell: 20, description: 'root' });
    b.parameter('AngleX');
    const values = b.bindField(warp, {
      id: 'push',
      params: ['AngleX'],
      keys: [{ at: [-30], field: shiftField(-8, 0, domeWeight({ center: [100, 50], radius: [50, 30] })) }, { at: [0] }, { at: [30], field: shiftField(8, 0, domeWeight({ center: [100, 50], radius: [50, 30] })) }],
    });
    expect(values[1]).toEqual({});
    // Only the points inside the ellipse are listed; the centre point (col 5, row 2..3) moves most.
    expect(Object.keys(values[2]).length).toBeGreaterThan(4);
    expect(Object.keys(values[2]).length).toBeLessThan(20);
    expect(values[2][String(2 * 11 + 5)][0]).toBeGreaterThan(5);
    // A field that moves nothing adds no binding.
    b.bindField(warp, { params: ['AngleX'], keys: [{ at: [0] }, { at: [30], field: () => [0.001, 0] }] });
    const doc = b.build() as { bindings: unknown[]; warps: unknown[] };
    expect(doc.bindings).toHaveLength(1);
    expect(doc.warps).toEqual([{ id: 'w', rect: [0, 0, 200, 100], cols: 10, rows: 5, description: 'root' }]);
    const { model, diagnostics } = validateModel(doc);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(model?.meta).toMatchObject({ name: 'test', width: 200, height: 100, background: 'transparent' });
    expect(b.stats()).toMatchObject({ parameters: 1, warps: 1, latticePoints: 66, parts: 0, bindings: 1 });
  });
});

describe('fold checker', () => {
  it('passes a gentle push and reports a push that folds the lattice and the mesh', () => {
    expect(findFolds(pushModel(10))).toEqual([]);
    const findings = findFolds(pushModel(60));
    const warp = findings.find((f) => f.kind === 'warp');
    const part = findings.find((f) => f.kind === 'part');
    expect(warp).toMatchObject({ id: 'w', params: { AngleX: 30 }, flipped: true });
    expect(part).toMatchObject({ id: 'sheet', params: { AngleX: 30 } });
    expect(warp!.count).toBeGreaterThan(0);
    // The fold is on the side the dome is pushed toward.
    expect(warp!.at[0]).toBeGreaterThan(100);
    expect(warp!.ratio).toBeLessThan(0);
    const issues = foldIssues(findings);
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatchObject({ severity: 'warning', code: FOLD_CODE });
    expect(issues[0].message).toMatch(/the lattice of warp "w" flips at AngleX=30: \d+ cells?, the worst near \(\d+, \d+\) with -\d+% of its rest area/);
    expect(issues[0].hint).toContain('--overlay warps');
    expect(foldIssues([])).toEqual([]);
  });

  it('honours the plan: skipped objects, collapsible lattices, extra poses', () => {
    const model = pushModel(60);
    expect(findFolds(model, { skip: ['warp:w', 'part:sheet'] })).toEqual([]);
    expect(findFolds(model, { skip: ['part:sheet'] }).map((f) => f.kind)).toEqual(['warp']);
    // A collapse (area near 0) is fine for a collapsible lattice, a real flip is still reported.
    const squeezed = pushModel(43);
    const strict = findFolds(squeezed, { skip: ['part:sheet'] });
    expect(strict).toHaveLength(1);
    expect(strict[0].flipped).toBe(false);
    expect(foldIssues(strict)[0].message).toContain('collapses');
    expect(findFolds(squeezed, { skip: ['part:sheet'], collapsible: ['warp:w'] })).toEqual([]);
    expect(findFolds(model, { skip: ['part:sheet'], collapsible: ['warp:w'] })).toHaveLength(1);
    // Explicit poses replace the defaults; unknown parameters are dropped from a pose.
    expect(findFolds(model, {}, { poses: [{ AngleX: 0 }] })).toEqual([]);
    expect(findFolds(model, { poses: [{ AngleX: 29, Missing: 1 }] }, { poses: [] })[0].params).toEqual({ AngleX: 29 });
    expect(findFolds(model, {}, { minRatio: -10 })).toEqual([]);
  });

  it('checks every parameter at both ends and the corners of the head and body parameters', () => {
    const model = pushModel(10, (b) => {
      for (const id of ['AngleY', 'AngleZ', 'BodyAngleX', 'Breath', 'EyeLOpen'] as const) b.parameter(id);
    });
    const poses = defaultFoldPoses(model);
    // Singles: 4 x 2 ends, Breath at 1 and EyeLOpen at 0 (their other end is the rest value).
    const singles = poses.filter((p) => Object.keys(p).length === 1);
    expect(singles).toHaveLength(10);
    expect(singles).toContainEqual({ EyeLOpen: 0 });
    expect(singles).not.toContainEqual({ EyeLOpen: 1 });
    const corners = poses.filter((p) => Object.keys(p).length === 5);
    expect(corners).toHaveLength(16);
    expect(corners.every((p) => p.Breath === 1 && Math.abs(p.AngleX) === 30 && Math.abs(p.BodyAngleX) === 10)).toBe(true);
    expect(new Set(corners.map((p) => JSON.stringify(p))).size).toBe(16);
  });
});
