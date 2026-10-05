import { describe, expect, it } from 'vitest';
import { EASINGS, easeFn } from '../../../core/easing.js';
import type { Ease } from '../../../core/types.js';
import {
  bezierToEase,
  channelToKeys,
  easeToSpineCurve,
  evalBezier,
  hermiteToBezier,
  namedEaseBezier,
  percentCurveToEase,
  readSegmentCurve,
  splitBezier,
  type Bezier,
  type EasedKey,
} from '../curves.js';
import { bezierRef } from './helpers.js';

/** Evaluate Rev2D keys the way a Rev2D track does (ease shapes the segment to the next key). */
function sampleKeys(keys: EasedKey[], t: number): number {
  if (t <= keys[0].t) return keys[0].v;
  for (let i = 0; i + 1 < keys.length; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (t < b.t) {
      if (a.ease === 'step') return a.v;
      return a.v + (b.v - a.v) * easeFn(a.ease)((t - a.t) / (b.t - a.t));
    }
  }
  return keys[keys.length - 1].v;
}

/** Deterministic pseudo-random numbers. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('spine curves: reading', () => {
  const span: [number, number, number, number] = [1, 10, 3, 30];

  it('reads 4.x absolute per-channel curves, stepped and linear', () => {
    const key = { curve: [1.5, 12, 2.5, 28, 1.2, 0, 2.8, 5] };
    expect(readSegmentCurve(key, 0, span, false)).toEqual([1.5, 12, 2.5, 28]);
    expect(readSegmentCurve(key, 1, span, false)).toEqual([1.2, 0, 2.8, 5]);
    expect(readSegmentCurve(key, 2, span, false)).toBe('linear');
    expect(readSegmentCurve({ curve: 'stepped' }, 0, span, false)).toBe('stepped');
    expect(readSegmentCurve({}, 0, span, false)).toBe('linear');
  });

  it('denormalizes 3.8 number curves (c2..c4 default 0, 1, 1) and 3.7 array curves', () => {
    expect(readSegmentCurve({ curve: 0.25, c2: 0.1, c3: 0.75, c4: 0.9 }, 0, span, true)).toEqual([1.5, 12, 2.5, 28]);
    expect(readSegmentCurve({ curve: 0.25 }, 3, span, true)).toEqual([1.5, 10, 3, 30]);
    expect(readSegmentCurve({ curve: [0.25, 0.1, 0.75, 0.9] }, 1, span, true)).toEqual([1.5, 12, 2.5, 28]);
    expect(readSegmentCurve({ curve: 'linear' }, 0, span, true)).toBe('linear');
  });
});

describe('spine curves: bezier -> ease', () => {
  it('matches an independent evaluation of random Spine curves (also for negated values)', () => {
    const r = rng(7);
    for (let n = 0; n < 60; n++) {
      const t0 = r() * 2;
      const t1 = t0 + 0.05 + r() * 2;
      const v0 = (r() - 0.5) * 200;
      const v1 = v0 + (r() - 0.5) * 200;
      const c: Bezier = [t0 + r() * (t1 - t0), v0 + (r() - 0.3) * 150, t0 + r() * (t1 - t0), v1 + (r() - 0.7) * 150];
      const ease = bezierToEase(t0, v0, c, t1, v1);
      expect(ease).not.toBeNull();
      for (const sign of [1, -1]) {
        const e = bezierToEase(t0, sign * v0, [c[0], sign * c[1], c[2], sign * c[3]], t1, sign * v1);
        expect(e).toEqual(ease);
      }
      const fn = easeFn(ease!);
      for (let k = 0; k <= 20; k++) {
        const t = t0 + ((t1 - t0) * k) / 20;
        const expected = bezierRef(t0, v0, c[0], c[1], c[2], c[3], t1, v1, t);
        const got = v0 + (v1 - v0) * fn((t - t0) / (t1 - t0));
        expect(Math.abs(got - expected)).toBeLessThan(2e-3 * Math.max(1, Math.abs(v1 - v0)));
        expect(Math.abs(evalBezier(t0, v0, c, t1, v1, t) - expected)).toBeLessThan(2e-3 * Math.max(1, Math.abs(v1 - v0)));
      }
    }
  });

  it('recognizes straight lines and constant segments; bulges back to the same value need a split', () => {
    expect(bezierToEase(0, 0, [1 / 3, 10 / 3, 2 / 3, 20 / 3], 1, 10)).toBe('linear');
    expect(bezierToEase(0, 5, [0.2, 5, 0.8, 5], 1, 5)).toBe('linear');
    expect(bezierToEase(0, 5, [0.2, 9, 0.8, 9], 1, 5)).toBeNull();
    // Control times outside the segment are clamped like the Spine editor does.
    expect(bezierToEase(0, 0, [-0.5, 2, 1.5, 8], 1, 10)).toEqual([0, 0.2, 1, 0.8]);
  });

  it('splits bezier segments exactly (de Casteljau)', () => {
    const [l, rr] = splitBezier(0, 0, [0.1, 20, 0.9, -5], 2, 10, 0.5);
    for (const t of [0.1, 0.4, 0.8, 1.3, 1.9]) {
      const seg = t <= l[3] ? l : rr;
      expect(evalBezier(...seg, t)).toBeCloseTo(evalBezier(0, 0, [0.1, 20, 0.9, -5], 2, 10, t), 6);
    }
  });

  it('converts channels exactly, splitting zero-span bulges into extra keys', () => {
    const cases: Array<Array<{ t: number; v: number; curve: 'linear' | 'stepped' | Bezier }>> = [
      [
        { t: 0, v: 10, curve: [0.2, 30, 0.8, 30] },
        { t: 1, v: 10, curve: 'linear' },
      ],
      [
        { t: 0, v: 0, curve: [0.3, 15, 0.6, -15] },
        { t: 1.5, v: 0, curve: 'stepped' },
        { t: 2, v: 4, curve: [2.1, 0, 2.9, 4] },
        { t: 3, v: 8, curve: 'linear' },
      ],
    ];
    for (const keys of cases) {
      const { keys: out, split } = channelToKeys(keys);
      expect(split).toBeGreaterThan(0);
      for (let i = 0; i + 1 < out.length; i++) expect(out[i + 1].t - out[i].t).toBeGreaterThan(1e-3);
      for (let k = 0; k <= 60; k++) {
        const t = (keys[keys.length - 1].t * k) / 60;
        let i = 0;
        while (i + 2 < keys.length && keys[i + 1].t <= t) i++;
        const a = keys[i];
        const b = keys[i + 1];
        const expected = t >= b.t ? b.v : a.curve === 'stepped' ? a.v : a.curve === 'linear' ? a.v + ((t - a.t) / (b.t - a.t)) * (b.v - a.v) : bezierRef(a.t, a.v, ...a.curve, b.t, b.v, t);
        expect(Math.abs(sampleKeys(out, t) - expected)).toBeLessThan(2e-3);
      }
    }
    expect(channelToKeys([{ t: 0, v: 1, curve: 'stepped' }, { t: 1, v: 2, curve: 'linear' }]).keys).toEqual([
      { t: 0, v: 1, ease: 'step' },
      { t: 1, v: 2 },
    ]);
  });

  it('reads percent curves (deform and other vector keys)', () => {
    expect(percentCurveToEase(1, [1.5, 0.2, 2.5, 0.9], 3)).toEqual([0.25, 0.2, 0.75, 0.9]);
    expect(percentCurveToEase(1, 'stepped', 3)).toBe('step');
    expect(percentCurveToEase(1, 'linear', 3)).toBeUndefined();
  });
});

describe('spine curves: ease -> Spine curve (for exporters)', () => {
  it('round-trips cubic-bezier eases through absolute Spine control points', () => {
    const e: Ease = [0.2, -0.3, 0.7, 1.4];
    const c = easeToSpineCurve(e, 2, -10, 4, 30) as Bezier;
    expect(c).toEqual([2.4, -22, 3.4, 46].map((x) => expect.closeTo(x, 12)));
    expect(bezierToEase(2, -10, c, 4, 30)).toEqual(e.map((x) => expect.closeTo(x, 12)));
    expect(easeToSpineCurve('linear', 0, 0, 1, 1)).toBeUndefined();
    expect(easeToSpineCurve(undefined, 0, 0, 1, 1)).toBeUndefined();
    expect(easeToSpineCurve('step', 0, 0, 1, 1)).toBe('stepped');
    expect(easeToSpineCurve('outBounce', 0, 0, 1, 1)).toBeNull();
    expect(easeToSpineCurve('smooth', 0, 0, 1, 1)).toBeNull();
  });

  it('gives exact beziers for polynomial named eases and close fits for the others', () => {
    for (const name of ['linear', 'inQuad', 'outQuad', 'inCubic', 'outCubic', 'inBack', 'outBack']) {
      const b = namedEaseBezier(name)!;
      expect(b.exact).toBe(true);
      expect(b.maxError).toBeLessThan(1e-6);
    }
    for (const name of ['inSine', 'outSine', 'inOutSine', 'inOutQuad', 'inOutCubic', 'inOutBack']) {
      const b = namedEaseBezier(name)!;
      expect(b.exact).toBe(false);
      expect(b.maxError).toBeLessThan(0.05);
    }
    expect(namedEaseBezier('outElastic')).toBeNull();
    // Approximate forms only within the tolerance (value units).
    expect(easeToSpineCurve('inSine', 0, 0, 1, 100, 0)).toBeNull();
    expect(easeToSpineCurve('inSine', 0, 0, 1, 100, 5)).not.toBeNull();
    expect(easeToSpineCurve('inQuad', 0, 0, 1, 100, 0)).not.toBeNull();
    expect(Object.keys(EASINGS)).toContain('inQuad');
  });

  it('converts Hermite (smooth) segments exactly', () => {
    const [t0, v0, m0, t1, v1, m1] = [0.5, 2, 30, 1.7, -4, -12];
    const c = hermiteToBezier(t0, v0, m0, t1, v1, m1);
    for (let k = 1; k < 10; k++) {
      const s = k / 10;
      const dt = t1 - t0;
      const h = (2 * s ** 3 - 3 * s ** 2 + 1) * v0 + (s ** 3 - 2 * s ** 2 + s) * dt * m0 + (-2 * s ** 3 + 3 * s ** 2) * v1 + (s ** 3 - s ** 2) * dt * m1;
      expect(evalBezier(t0, v0, c, t1, v1, t0 + s * dt)).toBeCloseTo(h, 6);
    }
  });
});
