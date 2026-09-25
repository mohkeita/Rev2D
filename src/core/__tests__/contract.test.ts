import { describe, expect, it } from 'vitest';
import { ModelSchema, modelJsonSchema } from '../schema.js';
import { parseAddress, resolveTarget, suggest, AddressError } from '../address.js';
import { normalizeValue, lerpValue, ValueAccumulator, valueToJSON, ValueError } from '../values.js';
import { parsePath, formatPath } from '../path.js';
import { parseColor, formatColor } from '../color.js';
import { easeFn } from '../easing.js';
import { fromTRS, multiply, invert, apply } from '../math.js';

const model = ModelSchema.parse({
  format: 'rev2d',
  version: 1,
  meta: { name: 't', width: 100, height: 100 },
  parameters: [{ id: 'A', min: -1, max: 1 }],
  bones: [{ id: 'root', x: 50, y: 50 }],
  warps: [{ id: 'w', rect: [0, 0, 100, 100], cols: 2, rows: 1 }],
  parts: [
    { id: 'p', shape: { type: 'polygon', points: [0, 0, 10, 0, 10, 10] } },
    { id: 'm', shape: { type: 'path', d: 'M0 0 L10 0 L10 10 Z' }, fill: '#f00', stroke: { color: '#000', width: 2 } },
    { id: 'e', shape: { type: 'ellipse', cx: 1, cy: 2, rx: 3, ry: 4 } },
  ],
});

describe('contract', () => {
  it('applies defaults', () => {
    expect(model.bones[0].rotation).toBe(0);
    expect(model.parts[0].opacity).toBe(1);
    expect(model.parts[0].tint).toBe('#ffffff');
    expect(model.meta.fps).toBe(30);
  });
  it('rejects unknown keys', () => {
    const r = ModelSchema.safeParse({ format: 'rev2d', version: 1, meta: { name: 't', width: 1, height: 1 }, bonez: [] });
    expect(r.success).toBe(false);
  });
  it('json schema exports', () => {
    const s = modelJsonSchema() as any;
    expect(s.type).toBe('object');
  });
  it('parses addresses', () => {
    expect(parseAddress('part:m.shape.d')).toEqual({ kind: 'part', id: 'm', prop: ['shape', 'd'] });
    expect(() => parseAddress('bone:root')).toThrow(AddressError);
    expect(() => parseAddress('bon:root.x')).toThrow(/unknown address kind/);
  });
  it('resolves targets', () => {
    expect(resolveTarget(model, 'bone:root.rotation').setup).toBe(0);
    const w = resolveTarget(model, 'warp:w.offsets');
    expect(w.pointCount).toBe(6);
    expect(resolveTarget(model, 'part:p.shape.points').valueType).toBe('points');
    expect(resolveTarget(model, 'part:m.stroke.width').setup).toBe(2);
    try {
      resolveTarget(model, 'bone:root.rotaton');
      expect.unreachable();
    } catch (e) {
      expect((e as AddressError).hint).toContain('rotation');
    }
    expect(() => resolveTarget(model, 'part:e.shape.r')).toThrow(AddressError);
  });
  it('resolves omitted image w/h to the crop size, else the texture size', () => {
    const images = ModelSchema.parse({
      format: 'rev2d',
      version: 1,
      meta: { name: 'images', width: 100, height: 100 },
      textures: [
        { id: 'sized', path: 'a.png', width: 64, height: 32 },
        { id: 'bare', path: 'b.png' },
        { id: 'constructor', path: 'c.png' },
      ],
      parts: [
        { id: 'full', shape: { type: 'image', texture: 'sized', x: 5, y: 6 } },
        { id: 'crop', shape: { type: 'image', texture: 'sized', x: 0, y: 0, crop: [4, 4, 10, 12] } },
        { id: 'bare', shape: { type: 'image', texture: 'bare', x: 0, y: 0 } },
        { id: 'fixed', shape: { type: 'image', texture: 'bare', x: 0, y: 0, w: 7, h: 9, crop: [0, 0, 1, 1] } },
        { id: 'proto', shape: { type: 'image', texture: 'constructor', x: 0, y: 0 } },
      ],
    });
    const setup = (addr: string, opts?: Parameters<typeof resolveTarget>[2]) => resolveTarget(images, addr, opts).setup;
    const provided = { textures: { sized: { width: 100, height: 50 }, bare: { width: 20, height: 30 } } };
    // Model texture sizes, overridden by provided (decoded) sizes.
    expect([setup('part:full.shape.w'), setup('part:full.shape.h')]).toEqual([64, 32]);
    expect([setup('part:full.shape.w', provided), setup('part:full.shape.h', provided)]).toEqual([100, 50]);
    expect([setup('part:bare.shape.w', provided), setup('part:bare.shape.h', provided)]).toEqual([20, 30]);
    // A crop wins over any texture size; explicit values win over everything.
    expect([setup('part:crop.shape.w', provided), setup('part:crop.shape.h')]).toEqual([10, 12]);
    expect([setup('part:fixed.shape.w', provided), setup('part:fixed.shape.h')]).toEqual([7, 9]);
    expect([setup('part:full.shape.x'), setup('part:full.shape.y')]).toEqual([5, 6]);
    // Unknown sizes resolve to 0 (object prototype keys are not texture sizes).
    expect([setup('part:bare.shape.w'), setup('part:bare.shape.h')]).toEqual([0, 0]);
    expect(setup('part:proto.shape.w')).toBe(0);
    expect(setup('part:proto.shape.w', { textures: {} })).toBe(0);
    // Partial models without a textures section (as ops resolve single items) are fine.
    const partial = { parameters: [], bones: [], warps: [], ik: [], parts: [images.parts[0]] } as unknown as typeof images;
    expect(resolveTarget(partial, 'part:full.shape.w').setup).toBe(0);
    expect(resolveTarget(partial, 'part:full.shape.w', provided).setup).toBe(100);
  });

  it('normalizes values incl. sparse points and paths', () => {
    const t = resolveTarget(model, 'warp:w.offsets');
    expect(normalizeValue({ '1': [5, 6] }, t)).toEqual([0, 0, 5, 6, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(() => normalizeValue([1, 2], t)).toThrow(ValueError);
    const pt = resolveTarget(model, 'part:m.shape.d');
    expect(() => normalizeValue('M0 0 L5 5 Z', pt)).toThrow(/structure/);
    const v = normalizeValue('M0 0 L20 0 L20 20 Z', pt);
    const mid = lerpValue(pt.setup, v, 0.5);
    expect(valueToJSON(mid, 'path')).toBe('M0 0 L15 0 L15 15 Z');
  });
  it('accumulates deltas', () => {
    const acc = new ValueAccumulator(10);
    acc.add(15);
    acc.add(5, 0.5);
    expect(acc.result()).toBe(12.5);
  });
  it('parses paths with implicit commands and arcs', () => {
    const p = parsePath('M0,0 10 10 a5 5 0 01 10 0z');
    expect(p.commands).toEqual(['M', 'L', 'a', 'z']);
    expect(p.nums).toEqual([0, 0, 10, 10, 5, 5, 0, 0, 1, 10, 0]);
    expect(formatPath(p)).toBe('M0 0 L10 10 a5 5 0 0 1 10 0 z');
  });
  it('colors', () => {
    expect(parseColor('#f00')).toEqual([1, 0, 0, 1]);
    expect(formatColor(parseColor('rgba(255,0,0,0.5)')!)).toBe('#ff000080');
    expect(parseColor('transparent')![3]).toBe(0);
    expect(parseColor('nope')).toBeNull();
  });
  it('easing', () => {
    expect(easeFn('linear')(0.3)).toBeCloseTo(0.3);
    expect(easeFn([0.25, 0.1, 0.25, 1])(0.5)).toBeCloseTo(0.8024, 3);
    expect(easeFn('inOutSine')(0.5)).toBeCloseTo(0.5);
  });
  it('math', () => {
    const m = fromTRS(10, 0, 90, 1, 1);
    const [x, y] = apply(m, 1, 0);
    expect(x).toBeCloseTo(10);
    expect(y).toBeCloseTo(1);
    const r = multiply(m, invert(m));
    expect(r[0]).toBeCloseTo(1);
    expect(r[4]).toBeCloseTo(0);
  });
  it('suggest', () => {
    expect(suggest('hed', ['head', 'neck'])).toContain('head');
    expect(suggest('zzzzzz', ['head'])).toBeNull();
  });
});
