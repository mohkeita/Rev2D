import { describe, expect, it } from 'vitest';
import type { Shape } from '../../../core/types.js';
import { fitSegments, reduceFrames, segmentKeys } from '../bake-reduce.js';
import { frameTimes } from '../bake.js';
import { skeletonHash, writeSpineJson } from '../export-json.js';
import { alphaContour, polygonArea, simplifyClosed } from '../export-mask.js';
import { planMorph, shapeArea } from '../export-morph.js';
import { bleedAlpha, composePages, packRects, premultiply } from '../pack.js';
import { makeImage } from './helpers.js';

// ----------------------------------------------------------------------------- packing

describe('spine export: atlas packing', () => {
  const items = Array.from({ length: 40 }, (_, i) => ({ id: `r${i}`, width: 10 + ((i * 37) % 90), height: 8 + ((i * 53) % 70) }));

  it('packs without overlap, inside power-of-two pages, with padding', () => {
    const res = packRects(items, { maxSize: 2048, padding: 2 });
    expect(res.pages).toHaveLength(1);
    const page = res.pages[0];
    expect(Math.log2(page.width) % 1).toBe(0);
    expect(Math.log2(page.height) % 1).toBe(0);
    for (const p of res.placements) {
      expect(p.x).toBeGreaterThanOrEqual(2);
      expect(p.y).toBeGreaterThanOrEqual(2);
      expect(p.x + p.width + 2).toBeLessThanOrEqual(page.width);
      expect(p.y + p.height + 2).toBeLessThanOrEqual(page.height);
    }
    for (let i = 0; i < res.placements.length; i++) {
      for (let j = i + 1; j < res.placements.length; j++) {
        const a = res.placements[i];
        const b = res.placements[j];
        const apart = a.x + a.width + 2 <= b.x || b.x + b.width + 2 <= a.x || a.y + a.height + 2 <= b.y || b.y + b.height + 2 <= a.y;
        expect(apart, `${a.id} vs ${b.id}`).toBe(true);
      }
    }
    // Placements are in input order; the result is deterministic.
    expect(res.placements.map((p) => p.id)).toEqual(items.map((i) => i.id));
    expect(packRects(items, { maxSize: 2048, padding: 2 })).toEqual(res);
    // The page is reasonably tight: at most 4x the item area.
    const area = items.reduce((s, it) => s + it.width * it.height, 0);
    expect(page.width * page.height).toBeLessThan(4 * area);
  });

  it('spreads over several pages when one is not enough and rejects items that fit no page', () => {
    const big = Array.from({ length: 6 }, (_, i) => ({ id: `b${i}`, width: 100, height: 100 }));
    const res = packRects(big, { maxSize: 256, padding: 2 });
    expect(res.pages.length).toBeGreaterThan(1);
    expect(new Set(res.placements.map((p) => p.page)).size).toBe(res.pages.length);
    expect(() => packRects([{ id: 'x', width: 300, height: 10 }], { maxSize: 256 })).toThrow(/does not fit/);
  });

  it('composes pages, premultiplies and bleeds alpha', () => {
    const red = makeImage(3, 2, () => [255, 0, 0, 255]);
    const res = packRects([{ id: 'a', width: 3, height: 2 }], { maxSize: 64, padding: 2 });
    const [page] = composePages(res, new Map([['a', red]]));
    const { x, y } = res.placements[0];
    expect(Array.from(page.data.subarray(((y + 1) * page.width + x + 2) * 4, ((y + 1) * page.width + x + 2) * 4 + 4))).toEqual([255, 0, 0, 255]);
    expect(page.data[3]).toBe(0);

    const half = makeImage(1, 1, () => [200, 100, 50, 128]);
    expect(Array.from(premultiply(half).data)).toEqual([100, 50, 25, 128]);

    const dot = makeImage(5, 1, (px) => (px === 2 ? [10, 200, 30, 255] : [0, 0, 0, 0]));
    const bled = bleedAlpha(dot, 2);
    for (let px = 0; px < 5; px++) {
      expect(bled.data[px * 4 + 3]).toBe(px === 2 ? 255 : 0);
      expect(bled.data[px * 4 + 1]).toBe(200);
    }
  });
});

// ----------------------------------------------------------------------------- key reduction

/** Independent cubic Bézier value y(t) with control times at 1/3 and 2/3 (x(u) = u). */
function cubicAt(a: number, c1: number, c2: number, b: number, u: number): number {
  return (1 - u) ** 3 * a + 3 * (1 - u) ** 2 * u * c1 + 3 * (1 - u) * u * u * c2 + u ** 3 * b;
}

/** Spine runtime evaluation: the polyline through the curve at u = 0, 0.1, ..., 1. */
function runtimeAt(a: number, c1: number, c2: number, b: number, u: number): number {
  const k = Math.min(9, Math.floor(u * 10));
  const f = u * 10 - k;
  const p = cubicAt(a, c1, c2, b, k / 10);
  const q = cubicAt(a, c1, c2, b, (k + 1) / 10);
  return p + (q - p) * f;
}

function evaluate(times: number[], values: number[], dims: number, d: number, segs: ReturnType<typeof fitSegments>, t: number, runtime: boolean): number {
  const s = segs.find((x) => t >= times[x.from] - 1e-12 && t <= times[x.to] + 1e-12)!;
  const a = values[s.from * dims + d];
  const b = values[s.to * dims + d];
  const u = (t - times[s.from]) / (times[s.to] - times[s.from]);
  if (!s.curve) return a + (b - a) * u;
  if (s.curve === 'stepped') return u < 1 ? a : b;
  return (runtime ? runtimeAt : cubicAt)(a, s.curve[2 * d], s.curve[2 * d + 1], b, u);
}

describe('spine export: key reduction and curve fitting', () => {
  const times = Array.from({ length: 61 }, (_, i) => i / 30);

  it('keeps only the ends of linear motion and every frame at tolerance 0', () => {
    const values = times.map((t) => 3 + 10 * t);
    expect(segmentKeys(fitSegments(times, values, 1, 0.01, 'channels'))).toEqual([0, 60]);
    expect(reduceFrames(times, values, 1, 0.01)).toEqual([0, 60]);
    expect(reduceFrames(times, values, 1, 0)).toHaveLength(61);
  });

  it('fits eased motion with curves that stay within tolerance, exactly and as Spine runtimes evaluate them', () => {
    const tol = 0.05;
    const values = times.map((t) => 100 * Math.sin(Math.PI * t) + 20 * t * t);
    const segs = fitSegments(times, values, 1, tol, 'channels');
    expect(segs.length).toBeLessThan(12);
    expect(segs.some((s) => s.curve)).toBe(true);
    times.forEach((t, i) => {
      expect(Math.abs(evaluate(times, values, 1, 0, segs, t, false) - values[i])).toBeLessThanOrEqual(tol + 1e-9);
      expect(Math.abs(evaluate(times, values, 1, 0, segs, t, true) - values[i])).toBeLessThanOrEqual(tol + 1e-9);
    });
    // Linear-only reduction of the same data needs many more keys.
    expect(reduceFrames(times, values, 1, tol).length).toBeGreaterThan(segs.length * 2);
  });

  it('fits each channel separately, or one shared percent curve for proportional vectors', () => {
    const dims = 3;
    const ease = (t: number) => t * t * (3 - 2 * t);
    const tt = times.slice(0, 31);
    const values: number[] = [];
    // Small amplitudes: Spine's 10-segment polyline of one curve stays within 0.02 of the cubic.
    for (const t of tt) values.push(1 * ease(t), -2 * ease(t), 0.5 * ease(t));
    expect(tt[tt.length - 1]).toBe(1);
    const shared = fitSegments(tt, values, dims, 0.02, 'shared');
    expect(shared).toHaveLength(1);
    expect(shared[0].curve).toHaveLength(2);
    // Channels moving with different timing cannot share one curve.
    const mixed: number[] = [];
    for (const t of tt) mixed.push(10 * ease(t), -40 * t, 5 * ease(t) * ease(t));
    expect(fitSegments(tt, mixed, dims, 0.01, 'shared').length).toBeGreaterThan(1);
    const channels = fitSegments(tt, mixed, dims, 0.01, 'channels');
    expect(channels[0].curve?.length ?? 6).toBe(6);
  });

  it('writes a stepped segment across a step change instead of a ramp', () => {
    // Frames 1 ms apart around a step at t = 1 (the frame at 1 already shows the new value).
    const ts = [0, 0.5, 0.999, 1, 1.5, 2];
    const vs = [0, 0, 0, 1, 1, 1];
    const jumps = [false, false, true, false, false];
    const segs = fitSegments(ts, vs, 1, 0.01, 'channels', true, jumps);
    expect(segs).toEqual([
      { from: 0, to: 2, curve: null },
      { from: 2, to: 3, curve: 'stepped' },
      { from: 3, to: 5, curve: null },
    ]);
    // Without the step marks the change is a linear ramp over the 1 ms interval.
    expect(fitSegments(ts, vs, 1, 0.01, 'channels', true).some((s) => s.curve === 'stepped')).toBe(false);
    // A marked interval whose values do not change stays an ordinary segment.
    expect(fitSegments(ts, [0, 0, 0, 0, 0, 0], 1, 0.01, 'channels', true, jumps)).toEqual([{ from: 0, to: 5, curve: null }]);
    // Continuous motion through a marked interval (another track steps there) is not a step.
    expect(fitSegments(ts, ts.map((t) => 30 * t), 1, 0.01, 'channels', true, jumps)).toEqual([{ from: 0, to: 5, curve: null }]);
  });

  it('samples key times and the instant before a step change', () => {
    const anim = {
      id: 'a',
      duration: 1,
      loop: true,
      tracks: [
        { target: 'param:x', offset: 0.1, keys: [{ t: 0, v: 0, ease: 'step' as const }, { t: 0.37, v: 1, ease: 'linear' as const }] },
      ],
    };
    const ts = frameTimes(1, 10, anim as never);
    expect(ts[0]).toBe(0);
    expect(ts[ts.length - 1]).toBe(1);
    expect(ts).toContain(0.47);
    expect(ts.some((t) => Math.abs(t - 0.469) < 1e-9)).toBe(true);
    for (let i = 1; i < ts.length; i++) expect(ts[i] - ts[i - 1]).toBeGreaterThan(4e-4);
  });
});

// ----------------------------------------------------------------------------- morphs

describe('spine export: shape morphs', () => {
  const pts = new Float64Array([10, 10, 30, 5, 20, 25, -5, 12, 22, 14]);

  it('maps ellipse and image points with the exact affine map', () => {
    const ref: Shape = { type: 'ellipse', cx: 10, cy: 12, rx: 20, ry: 10, rotation: 0 };
    const to: Shape = { type: 'ellipse', cx: 15, cy: 10, rx: 10, ry: 30, rotation: 90 };
    const plan = planMorph(ref, [to], pts, {})!;
    const out = new Float64Array(pts.length);
    plan.map(to, out);
    // Point on the reference outline at angle a lands on the target outline at the same angle.
    const onRef = [ref.cx + 20 * Math.cos(1), ref.cy + 10 * Math.sin(1)];
    const single = planMorph(ref, [to], onRef, {})!;
    const o1 = new Float64Array(2);
    single.map(to, o1);
    // rotation 90°: local (x, y) -> (-y, x)
    expect(o1[0]).toBeCloseTo(15 - 30 * Math.sin(1), 9);
    expect(o1[1]).toBeCloseTo(10 + 10 * Math.cos(1), 9);
    const img: Shape = { type: 'image', texture: 't', x: 0, y: 0, w: 10, h: 20, cols: 1, rows: 1 };
    const img2: Shape = { type: 'image', texture: 't', x: 5, y: 5, w: 20, h: 10, cols: 1, rows: 1 };
    const pi = planMorph(img, [img2], [5, 10, 10, 20], {})!;
    const o2 = new Float64Array(4);
    pi.map(img2, o2);
    expect(Array.from(o2)).toEqual([15, 10, 25, 15]);
  });

  it('maps rounded rects with a nine-slice map that keeps the corner arcs', () => {
    const ref: Shape = { type: 'rect', x: 0, y: 0, w: 100, h: 50, radius: 10 };
    const to: Shape = { type: 'rect', x: 10, y: 0, w: 60, h: 80, radius: 20 };
    const a = (Math.PI / 180) * 30;
    // A point on the top-left corner arc of ref -> the same angle on the target's arc.
    const p = [10 - 10 * Math.cos(a), 10 - 10 * Math.sin(a)];
    const plan = planMorph(ref, [to], p, {})!;
    const out = new Float64Array(2);
    plan.map(to, out);
    expect(out[0]).toBeCloseTo(10 + 20 - 20 * Math.cos(a), 9);
    expect(out[1]).toBeCloseTo(20 - 20 * Math.sin(a), 9);
  });

  it('control-point morphs (polygon, mesh, path) reproduce rigid motions exactly, inside and outside', () => {
    const rot = (x: number, y: number): [number, number] => {
      const c = Math.cos(0.4);
      const s = Math.sin(0.4);
      return [7 + c * x - s * y, -3 + s * x + c * y];
    };
    const moveList = (l: number[]) => {
      const o: number[] = [];
      for (let i = 0; i < l.length; i += 2) o.push(...rot(l[i], l[i + 1]));
      return o;
    };
    const expectRigid = (ref: Shape, to: Shape) => {
      const plan = planMorph(ref, [to], pts, {})!;
      const out = new Float64Array(pts.length);
      plan.map(to, out);
      const want = moveList(Array.from(pts));
      for (let i = 0; i < pts.length; i++) expect(out[i]).toBeCloseTo(want[i], 6);
    };
    const poly = [0, 0, 30, 0, 35, 20, 10, 30, -2, 15];
    expectRigid({ type: 'polygon', points: poly }, { type: 'polygon', points: moveList(poly) });
    const verts = [0, 0, 30, 0, 30, 30, 0, 30];
    expectRigid({ type: 'mesh', vertices: verts, triangles: [0, 1, 2, 0, 2, 3] }, { type: 'mesh', vertices: moveList(verts), triangles: [0, 1, 2, 0, 2, 3] });
    // Path: the same commands with transformed control points (a rigid motion maps Béziers exactly).
    const d = (pp: number[]) => `M ${pp[0]} ${pp[1]} C ${pp[2]} ${pp[3]} ${pp[4]} ${pp[5]} ${pp[6]} ${pp[7]} L ${pp[8]} ${pp[9]} Z`;
    const ctrl = [0, 0, 20, -10, 40, 10, 35, 30, -5, 25];
    expectRigid({ type: 'path', d: d(ctrl), tolerance: 0.5 }, { type: 'path', d: d(moveList(ctrl)), tolerance: 0.5 });
  });

  it('measures shape areas', () => {
    expect(shapeArea({ type: 'rect', x: 0, y: 0, w: 10, h: 5, radius: 0 }, {})).toBe(50);
    expect(shapeArea({ type: 'ellipse', cx: 0, cy: 0, rx: 2, ry: 3, rotation: 0 }, {})).toBeCloseTo(6 * Math.PI, 9);
    expect(shapeArea({ type: 'path', d: 'M0 0 L10 0 L10 10 L0 10 Z', tolerance: 0.5 }, {})).toBeCloseTo(100, 9);
  });
});

// ----------------------------------------------------------------------------- contours & JSON

describe('spine export: mask contours and JSON output', () => {
  it('traces the largest alpha region and simplifies it within tolerance', () => {
    const img = makeImage(60, 40, (x, y) => {
      const inCircle = (x + 0.5 - 20) ** 2 + (y + 0.5 - 20) ** 2 <= 15 * 15;
      const inDot = (x + 0.5 - 52) ** 2 + (y + 0.5 - 8) ** 2 <= 3 * 3;
      return inCircle || inDot ? [255, 255, 255, 255] : [0, 0, 0, 0];
    });
    const c = alphaContour(img);
    expect(c.polygon).not.toBeNull();
    expect(Math.abs(polygonArea(c.polygon!)) / (Math.PI * 225)).toBeCloseTo(1, 1);
    expect(c.otherArea).toBeGreaterThan(15);
    // Every contour point lies on the circle's edge (within a pixel).
    for (let i = 0; i < c.polygon!.length; i += 2) expect(Math.abs(Math.hypot(c.polygon![i] - 20, c.polygon![i + 1] - 20) - 15)).toBeLessThan(1);
    const s = simplifyClosed(c.polygon!, 0.3);
    expect(s.length).toBeLessThan(c.polygon!.length);
    expect(Math.abs(polygonArea(s))).toBeCloseTo(Math.abs(polygonArea(c.polygon!)), -1);
  });

  it('writes readable, valid JSON and a stable hash', () => {
    const doc = { skeleton: { hash: 'x' }, bones: [{ name: 'root' }, { name: 'a', parent: 'root', x: 1.5 }], animations: { a: { bones: { a: { rotate: [{ value: 1 }, { time: 1, value: 2 }] } } } } };
    const text = writeSpineJson(doc);
    expect(JSON.parse(text)).toEqual(doc);
    expect(text).toContain('\n\t\t{ "name": "a", "parent": "root", "x": 1.5 }');
    expect(skeletonHash(text)).toMatch(/^[A-Za-z0-9+/]{11}$/);
    expect(skeletonHash(text)).toBe(skeletonHash(writeSpineJson(doc)));
    expect(skeletonHash(text)).not.toBe(skeletonHash(text + ' '));
  });
});
