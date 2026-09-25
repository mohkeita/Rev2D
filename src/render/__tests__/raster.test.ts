import { describe, expect, it } from 'vitest';
import { renderImage } from '../raster.js';
import { buildRenderList, Rig } from '../../core/rig.js';
import { ModelSchema } from '../../core/schema.js';
import type { BlendMode, DrawItem, ImageRGBA, RenderList, RGBA } from '../../core/types.js';

const CLEAR: RGBA = [0, 0, 0, 0];

function item(positions: number[], indices: number[], color: RGBA | RGBA[], extra: Partial<DrawItem> = {}): DrawItem {
  const n = positions.length / 2;
  const colors = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) colors.set(Array.isArray(color[0]) ? (color as RGBA[])[i] : (color as RGBA), i * 4);
  return {
    partId: extra.partId ?? 'p',
    kind: 'fill',
    positions: Float32Array.from(positions),
    colors,
    indices: Uint32Array.from(indices),
    blend: 'normal',
    ...extra,
  };
}

/** Axis-aligned quad as two triangles sharing the (x0,y0)-(x1,y1) diagonal. */
function quad(x0: number, y0: number, x1: number, y1: number, color: RGBA, extra: Partial<DrawItem> = {}): DrawItem {
  return item([x0, y0, x1, y0, x1, y1, x0, y1], [0, 1, 2, 0, 2, 3], color, extra);
}

function list(width: number, height: number, draws: DrawItem[], background: RGBA = CLEAR): RenderList {
  return { width, height, background, draws };
}

function px(img: ImageRGBA, x: number, y: number): number[] {
  const i = (y * img.width + x) * 4;
  return Array.from(img.data.subarray(i, i + 4));
}

/** Alpha channel, row-major. */
function alphas(img: ImageRGBA): number[] {
  return Array.from({ length: img.width * img.height }, (_, i) => img.data[i * 4 + 3]);
}

function alphaSet(img: ImageRGBA, x0 = 0, y0 = 0, x1 = img.width, y1 = img.height): Set<number> {
  const s = new Set<number>();
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) s.add(img.data[(y * img.width + x) * 4 + 3]);
  return s;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** cols x rows grid mesh over [0,w]x[0,h]; interior vertices jittered so shared edges run at arbitrary angles. */
function jitteredGrid(
  w: number,
  h: number,
  cols: number,
  rows: number,
  jitter: number,
  seed: number,
): { positions: number[]; indices: number[] } {
  const r = rng(seed);
  const positions: number[] = [];
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= cols; i++) {
      const interior = i > 0 && j > 0 && i < cols && j < rows;
      positions.push(
        (w * i) / cols + (interior ? (r() - 0.5) * jitter : 0),
        (h * j) / rows + (interior ? (r() - 0.5) * jitter : 0),
      );
    }
  }
  const indices: number[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const a = j * (cols + 1) + i;
      const b = a + 1;
      const c = a + cols + 1;
      const d = c + 1;
      // Alternate diagonals and windings.
      if ((i + j) % 2) indices.push(a, b, d, a, d, c);
      else indices.push(a, c, b, b, c, d);
    }
  }
  return { positions, indices };
}

describe('renderImage: output mapping', () => {
  it('uses the list size by default and a transparent background', () => {
    const img = renderImage(list(7, 5, []), {});
    expect([img.width, img.height]).toEqual([7, 5]);
    expect(img.data.every((v) => v === 0)).toBe(true);
  });

  it('maps setup space through viewBox and scale', () => {
    const l = list(100, 50, [quad(20, 30, 30, 37, [1, 0, 0, 1])]);
    const img = renderImage(l, {}, { viewBox: [10, 20, 40, 20], scale: 2 });
    expect([img.width, img.height]).toEqual([80, 40]);
    // Setup x 20..30 -> pixels 20..40, y 30..37 -> pixels 20..34 (exclusive right/bottom).
    expect(px(img, 20, 20)).toEqual([255, 0, 0, 255]);
    expect(px(img, 39, 33)).toEqual([255, 0, 0, 255]);
    expect(px(img, 19, 25)[3]).toBe(0);
    expect(px(img, 40, 25)[3]).toBe(0);
    expect(px(img, 25, 19)[3]).toBe(0);
    expect(px(img, 25, 34)[3]).toBe(0);
  });

  it('rounds non-integer output sizes', () => {
    const img = renderImage(list(10, 10, []), {}, { viewBox: [0, 0, 10.3, 5.6], scale: 1.5 });
    expect([img.width, img.height]).toEqual([Math.round(10.3 * 1.5), Math.round(5.6 * 1.5)]);
  });

  it('fills list.background, overridable by opts.background (null keeps the list color)', () => {
    const l = list(2, 2, [], [0, 0, 1, 1]);
    expect(px(renderImage(l, {}), 1, 1)).toEqual([0, 0, 255, 255]);
    expect(px(renderImage(l, {}, { background: null }), 1, 1)).toEqual([0, 0, 255, 255]);
    expect(px(renderImage(l, {}, { background: [1, 1, 1, 0.5] }), 0, 0)).toEqual([255, 255, 255, 128]);
  });

  it('rejects invalid options', () => {
    const l = list(10, 10, []);
    expect(() => renderImage(l, {}, { viewBox: [0, 0, 0, 10] })).toThrow(/viewBox/);
    expect(() => renderImage(l, {}, { scale: -1 })).toThrow(/scale/);
    expect(() => renderImage(l, {}, { scale: 0.01 })).toThrow(/output would be/);
    expect(() => renderImage(l, {}, { supersample: Number.NaN })).toThrow(/supersample/);
    expect(() => renderImage(list(100000, 100000, []), {})).toThrow(/exceeds/);
  });
});

describe('renderImage: coverage and fill rule', () => {
  it('half-covered pixels get half alpha at SS 2 and 4, none at SS 1 (pixel center on the right edge)', () => {
    const l = list(4, 1, [quad(0, 0, 2.5, 1, [1, 0, 0, 1])]);
    for (const ss of [2, 4]) {
      const img = renderImage(l, {}, { supersample: ss });
      expect(px(img, 0, 0)).toEqual([255, 0, 0, 255]);
      expect(px(img, 1, 0)).toEqual([255, 0, 0, 255]);
      expect(px(img, 2, 0)).toEqual([255, 0, 0, 128]);
      expect(px(img, 3, 0)).toEqual([0, 0, 0, 0]);
    }
    const hard = renderImage(l, {}, { supersample: 1 });
    expect(px(hard, 1, 0)).toEqual([255, 0, 0, 255]);
    expect(px(hard, 2, 0)[3]).toBe(0);
  });

  it('shared edges with 50% alpha show no seam and no gaps (diagonal through sample centers)', () => {
    for (const ss of [1, 2, 3, 4]) {
      const img = renderImage(list(8, 8, [quad(0, 0, 8, 8, [0, 1, 0, 0.5])]), {}, { supersample: ss });
      expect(alphaSet(img)).toEqual(new Set([128]));
    }
  });

  it('a jittered mesh with mixed windings covers every sample exactly once', () => {
    const { positions, indices } = jitteredGrid(64, 48, 9, 7, 5, 1234);
    const l = list(64, 48, [item(positions, indices, [0.2, 0.4, 1, 0.5])]);
    for (const ss of [1, 2]) {
      const img = renderImage(l, {}, { supersample: ss });
      expect(alphaSet(img)).toEqual(new Set([128]));
      expect(new Set(Array.from({ length: 64 * 48 }, (_, i) => img.data[i * 4 + 2]))).toEqual(new Set([255]));
    }
  });

  it('a triangle fan around a center vertex has no seams', () => {
    const positions = [16, 16];
    const indices: number[] = [];
    const k = 7;
    for (let i = 0; i < k; i++) {
      const a = (i / k) * Math.PI * 2;
      positions.push(16 + Math.cos(a) * 14, 16 + Math.sin(a) * 14);
      indices.push(0, 1 + i, 1 + ((i + 1) % k));
    }
    const img = renderImage(list(32, 32, [item(positions, indices, [1, 1, 1, 0.5])]), {}, { supersample: 1 });
    // Every covered pixel was blended exactly once.
    expect(alphaSet(img)).toEqual(new Set([0, 128]));
    expect(px(img, 16, 16)[3]).toBe(128);
  });

  it('covers exactly the samples a brute-force top-left-rule test selects', () => {
    // Oracle: evaluate the three edge functions at every sample center (no span solving) with the
    // same 1/256 snapping; a sample on an edge belongs to the triangle only for top or left edges.
    const oracle = (v: number[], w: number, h: number): number[] => {
      const p = v.map((c) => Math.round(c * 256));
      let [x0, y0, x1, y1, x2, y2] = p;
      if ((x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0) < 0) [x1, y1, x2, y2] = [x2, y2, x1, y1];
      const edges = [
        [x1, y1, x2, y2],
        [x2, y2, x0, y0],
        [x0, y0, x1, y1],
      ];
      const out: number[] = [];
      for (let py = 0; py < h; py++) {
        for (let px = 0; px < w; px++) {
          const [sx, sy] = [px * 256 + 128, py * 256 + 128];
          const inside = edges.every(([ax, ay, bx, by]) => {
            const e = (bx - ax) * (sy - ay) - (by - ay) * (sx - ax);
            const topLeft = by - ay < 0 || (by === ay && bx > ax);
            return e > 0 || (e === 0 && topLeft);
          });
          out.push(inside ? 255 : 0);
        }
      }
      return out;
    };
    const r = rng(31);
    // Mix arbitrary 1/256 positions with sample centers (k + 0.5) to create exact ties.
    const coord = () => (r() < 0.5 ? Math.floor(r() * 44) - 6 + 0.5 : Math.round((r() * 44 - 6) * 256) / 256);
    for (let n = 0; n < 300; n++) {
      const v = [coord(), coord(), coord(), coord(), coord(), coord()];
      const img = renderImage(list(32, 32, [item(v, [0, 1, 2], [1, 1, 1, 1])]), {}, { supersample: 1 });
      expect(alphas(img), JSON.stringify(v)).toEqual(oracle(v, 32, 32));
    }
  });

  it('renders both windings identically', () => {
    const cw = item([2, 1, 14, 5, 5, 13], [0, 1, 2], [1, 0.5, 0, 1]);
    const ccw = item([2, 1, 14, 5, 5, 13], [0, 2, 1], [1, 0.5, 0, 1]);
    const a = renderImage(list(16, 16, [cw]), {});
    const b = renderImage(list(16, 16, [ccw]), {});
    expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(true);
    expect(px(a, 7, 6)).toEqual([255, 128, 0, 255]);
  });

  it('supersampling anti-aliases edges with intermediate alpha', () => {
    const tri = list(16, 16, [item([0, 0, 16, 3, 3, 16], [0, 1, 2], [1, 1, 1, 1])]);
    const hard = alphaSet(renderImage(tri, {}, { supersample: 1 }));
    expect(hard).toEqual(new Set([0, 255]));
    const soft = [...alphaSet(renderImage(tri, {}, { supersample: 4 }))];
    expect(soft.some((a) => a > 0 && a < 255)).toBe(true);
    expect(soft.filter((a) => a > 0 && a < 255).length).toBeGreaterThan(3);
  });

  it('supersampled alpha is exactly the fraction of covered sample centers', () => {
    // Edges at x = 2.25 and y = 1.75 with SS 4 (samples at k/4 + 1/8).
    const rect = renderImage(list(4, 3, [quad(0, 0, 2.25, 1.75, [1, 1, 1, 1])]), {}, { supersample: 4 });
    expect([px(rect, 0, 0)[3], px(rect, 1, 1)[3], px(rect, 2, 0)[3], px(rect, 2, 1)[3], px(rect, 3, 0)[3]]).toEqual([
      255,
      Math.round((12 / 16) * 255),
      Math.round((4 / 16) * 255),
      Math.round((3 / 16) * 255),
      0,
    ]);
    // Hypotenuse x + y = 4 is a right edge: samples exactly on it (i + j = 3 inside a pixel) are excluded.
    const tri = renderImage(list(4, 4, [item([0, 0, 4, 0, 0, 4], [0, 1, 2], [1, 1, 1, 1])]), {}, { supersample: 4 });
    expect([px(tri, 1, 1)[3], px(tri, 1, 2)[3], px(tri, 2, 1)[3], px(tri, 0, 3)[3], px(tri, 2, 2)[3]]).toEqual([
      255,
      Math.round((6 / 16) * 255),
      Math.round((6 / 16) * 255),
      Math.round((6 / 16) * 255),
      0,
    ]);
  });

  it('ignores degenerate triangles and non-finite vertices', () => {
    const l = list(8, 8, [item([1, 1, 5, 5, 7, 7, Number.NaN, 2], [0, 1, 2, 0, 1, 3], [1, 0, 0, 1])]);
    expect(renderImage(l, {}).data.every((v) => v === 0)).toBe(true);
  });

  it('clips geometry outside the viewport', () => {
    const img = renderImage(list(10, 10, [quad(-100, -100, 5, 200, [0, 0, 1, 1])]), {}, { supersample: 1 });
    expect(px(img, 4, 9)).toEqual([0, 0, 255, 255]);
    expect(px(img, 5, 0)[3]).toBe(0);
  });

  it('interpolates vertex colors (premultiplied) across the triangle', () => {
    const black: RGBA = [0, 0, 0, 1];
    const white: RGBA = [1, 1, 1, 1];
    const img = renderImage(
      list(16, 1, [item([0, 0, 16, 0, 16, 1, 0, 1], [0, 1, 2, 0, 2, 3], [black, white, white, black])]),
      {},
      { supersample: 1 },
    );
    const reds = Array.from({ length: 16 }, (_, x) => px(img, x, 0)[0]);
    for (let x = 1; x < 16; x++) expect(reds[x]).toBeGreaterThan(reds[x - 1]);
    expect(reds[0]).toBe(Math.round((0.5 / 16) * 255));
    expect(reds[15]).toBe(Math.round((15.5 / 16) * 255));
    // Fading to transparent keeps the color: no dark fringe.
    const fade = renderImage(
      list(8, 1, [
        item(
          [0, 0, 8, 0, 8, 1, 0, 1],
          [0, 1, 2, 0, 2, 3],
          [
            [1, 1, 1, 1],
            [0, 0, 0, 0],
            [0, 0, 0, 0],
            [1, 1, 1, 1],
          ],
        ),
      ]),
      {},
      { supersample: 1 },
    );
    expect(px(fade, 4, 0).slice(0, 3)).toEqual([255, 255, 255]);
  });

  it('validates draw items', () => {
    expect(() => renderImage(list(4, 4, [item([0, 0, 1, 0, 0, 1], [0, 1, 5], [1, 1, 1, 1])]), {})).toThrow(
      /index 5 is out of range/,
    );
    const bad = item([0, 0, 1, 0, 0, 1], [0, 1, 2], [1, 1, 1, 1]);
    bad.colors = new Float32Array(4);
    expect(() => renderImage(list(4, 4, [bad]), {})).toThrow(/color floats/);
  });

  it('is deterministic', () => {
    const { positions, indices } = jitteredGrid(50, 50, 6, 6, 6, 99);
    const n = positions.length / 2;
    const r = rng(5);
    const colors = Array.from({ length: n }, () => [r(), r(), r(), r()] as RGBA);
    const l = list(50, 50, [
      item(positions, indices, colors),
      quad(10, 10, 40, 30, [1, 0, 0, 0.3], { blend: 'screen' }),
    ]);
    const a = renderImage(l, {}, { supersample: 3 });
    const b = renderImage(l, {}, { supersample: 3 });
    expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(true);
  });
});

describe('renderImage: blend modes', () => {
  const src: RGBA = [0.5, 0.5, 1, 0.5];
  function expected(mode: BlendMode, dst: RGBA): number[] {
    const s = [src[0] * src[3], src[1] * src[3], src[2] * src[3], src[3]];
    const d = [dst[0] * dst[3], dst[1] * dst[3], dst[2] * dst[3], dst[3]];
    const out = s.map((sv, i) => {
      const dv = d[i];
      switch (mode) {
        case 'normal':
          return sv + dv * (1 - s[3]);
        case 'add':
          return Math.min(1, sv + dv);
        case 'multiply':
          return sv * dv + sv * (1 - d[3]) + dv * (1 - s[3]);
        case 'screen':
          return sv + dv - sv * dv;
      }
    });
    const a = out[3];
    return [...out.slice(0, 3).map((v) => Math.round((v / a) * 255)), Math.round(a * 255)];
  }

  for (const mode of ['normal', 'add', 'multiply', 'screen'] as BlendMode[]) {
    for (const dst of [
      [0.2, 0.4, 0.6, 1],
      [0.8, 0.2, 0.4, 0.5],
    ] as RGBA[]) {
      it(`${mode} over ${JSON.stringify(dst)}`, () => {
        const img = renderImage(list(2, 2, [quad(0, 0, 2, 2, src, { blend: mode })], dst), {}, { supersample: 1 });
        const got = px(img, 1, 1);
        const want = expected(mode, dst);
        for (let i = 0; i < 4; i++) expect(Math.abs(got[i] - want[i])).toBeLessThanOrEqual(1);
      });
    }
  }

  it('add clamps to 1 and multiply over opaque darkens', () => {
    const add = renderImage(list(1, 1, [quad(0, 0, 1, 1, [1, 1, 1, 1], { blend: 'add' })], [0.5, 0.5, 0.5, 1]), {});
    expect(px(add, 0, 0)).toEqual([255, 255, 255, 255]);
    const mul = renderImage(list(1, 1, [quad(0, 0, 1, 1, [0.5, 1, 0, 1], { blend: 'multiply' })], [1, 0.5, 1, 1]), {});
    expect(px(mul, 0, 0)).toEqual([128, 128, 0, 255]);
  });
});

describe('renderImage: masks', () => {
  const red: RGBA = [1, 0, 0, 1];
  it('clips to the mask coverage and inverts with maskInvert', () => {
    const mask = quad(0, 0, 4, 8, [1, 1, 1, 1], { partId: 'mask' });
    const clipped = renderImage(list(8, 8, [quad(0, 0, 8, 8, red, { masks: [mask] })]), {});
    expect(px(clipped, 1, 4)).toEqual([255, 0, 0, 255]);
    expect(px(clipped, 3, 4)).toEqual([255, 0, 0, 255]);
    expect(px(clipped, 4, 4)).toEqual([0, 0, 0, 0]);
    expect(px(clipped, 7, 4)).toEqual([0, 0, 0, 0]);

    const inverted = renderImage(list(8, 8, [quad(0, 0, 8, 8, red, { masks: [mask], maskInvert: true })]), {});
    expect(px(inverted, 1, 4)).toEqual([0, 0, 0, 0]);
    expect(px(inverted, 4, 4)).toEqual([255, 0, 0, 255]);
    expect(px(inverted, 7, 4)).toEqual([255, 0, 0, 255]);
  });

  it('never draws the mask geometry itself', () => {
    const mask = quad(0, 0, 8, 8, [0, 1, 0, 1]);
    const img = renderImage(list(8, 8, [quad(2, 2, 6, 6, red, { masks: [mask] })]), {});
    expect(px(img, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(px(img, 3, 3)).toEqual([255, 0, 0, 255]);
  });

  it('uses the union of several masks and scales by mask alpha', () => {
    const m1 = quad(0, 0, 2, 8, [1, 1, 1, 1]);
    const m2 = quad(6, 0, 8, 8, [1, 1, 1, 1]);
    const img = renderImage(list(8, 8, [quad(0, 0, 8, 8, red, { masks: [m1, m2] })]), {});
    expect(px(img, 1, 1)[3]).toBe(255);
    expect(px(img, 4, 1)[3]).toBe(0);
    expect(px(img, 7, 1)[3]).toBe(255);

    const half = renderImage(list(8, 8, [quad(0, 0, 8, 8, red, { masks: [quad(0, 0, 8, 8, [1, 1, 1, 0.5])] })]), {});
    expect(alphaSet(half)).toEqual(new Set([128]));
    // Overlapping 50% masks union to 75%.
    const both = renderImage(
      list(8, 8, [
        quad(0, 0, 8, 8, red, { masks: [quad(0, 0, 8, 8, [1, 1, 1, 0.5]), quad(0, 0, 8, 8, [1, 1, 1, 0.5])] }),
      ]),
      {},
    );
    expect(alphaSet(both)).toEqual(new Set([191]));
  });

  it('masks with texture alpha', () => {
    // Left texel opaque, right texel transparent: only the left half of the item survives.
    const tex: ImageRGBA = { width: 2, height: 1, data: Uint8ClampedArray.from([9, 9, 9, 255, 9, 9, 9, 0]) };
    const mask = quad(0, 0, 8, 8, [1, 1, 1, 1], { texture: 't', uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]) });
    const img = renderImage(list(8, 8, [quad(0, 0, 8, 8, red, { masks: [mask] })]), { t: tex }, { supersample: 1 });
    // Bilinear texel alpha at u = (x + 0.5) / 8: 1 up to the first texel center, then a linear ramp to 0.
    const row = Array.from({ length: 8 }, (_, x) => px(img, x, 4)[3]);
    expect(row).toEqual([255, 255, 223, 159, 96, 32, 0, 0]);
    expect(px(img, 3, 4).slice(0, 3)).toEqual([255, 0, 0]);
  });

  it('keeps antialiased mask edges', () => {
    const mask = quad(0, 0, 3.5, 8, [1, 1, 1, 1]);
    const img = renderImage(list(8, 8, [quad(0, 0, 8, 8, red, { masks: [mask] })]), {}, { supersample: 2 });
    expect(px(img, 3, 4)).toEqual([255, 0, 0, 128]);
  });

  it('treats a present but empty mask list as zero coverage (maskInvert: full coverage)', () => {
    const clipped = renderImage(list(8, 8, [quad(0, 0, 8, 8, red, { masks: [] })]), {});
    expect(alphaSet(clipped)).toEqual(new Set([0]));
    const inverted = renderImage(list(8, 8, [quad(0, 0, 8, 8, red, { masks: [], maskInvert: true })]), {});
    expect(alphaSet(inverted)).toEqual(new Set([255]));
    expect(px(inverted, 4, 4)).toEqual([255, 0, 0, 255]);
    // No `masks` at all = unmasked (maskInvert alone means nothing).
    expect(alphaSet(renderImage(list(8, 8, [quad(0, 0, 8, 8, red, { maskInvert: true })]), {}))).toEqual(new Set([255]));
  });

  it('treats masks without any triangles as zero coverage', () => {
    const empty = item([], [], red);
    const degenerate = quad(2, 2, 6, 2, [1, 1, 1, 1]); // zero height: triangles with no area
    for (const masks of [[empty], [degenerate], [empty, degenerate]]) {
      expect(alphaSet(renderImage(list(8, 8, [quad(0, 0, 8, 8, red, { masks })]), {}))).toEqual(new Set([0]));
      const inverted = renderImage(list(8, 8, [quad(0, 0, 8, 8, red, { masks, maskInvert: true })]), {});
      expect(alphaSet(inverted)).toEqual(new Set([255]));
    }
  });

  describe('rig masks end to end (SPEC §3.4)', () => {
    /** 40x40 window rect whose height follows Open (0 -> 0 px, 1 -> 20 px), masking a red dot. */
    function windowRig(maskInvert: boolean): Rig {
      return new Rig(
        ModelSchema.parse({
          format: 'rev2d',
          version: 1,
          meta: { name: 'window', width: 40, height: 40 },
          parameters: [{ id: 'Open', min: 0, max: 1 }],
          parts: [
            { id: 'win', shape: { type: 'rect', x: 10, y: 10, w: 20, h: 20 }, visible: false },
            {
              id: 'dot',
              shape: { type: 'ellipse', cx: 20, cy: 20, rx: 8, ry: 8 },
              fill: '#ff0000',
              z: 1,
              mask: ['win'],
              maskInvert,
            },
          ],
          bindings: [
            { target: 'part:win.shape.h', params: ['Open'], keys: [{ at: [0], value: 0 }, { at: [1], value: 20 }] },
          ],
        }),
      );
    }
    const redPixels = (rig: Rig, open: number): number => {
      const img = renderImage(buildRenderList(rig, rig.pose({ params: { Open: open } })), {});
      let n = 0;
      for (let i = 0; i < img.data.length; i += 4) if (img.data[i + 3] > 0) n++;
      return n;
    };

    it('draws nothing while the mask parts have no geometry', () => {
      const rig = windowRig(false);
      expect(redPixels(rig, 0)).toBe(0);
      const full = redPixels(rig, 1);
      expect(full).toBeGreaterThan(150); // the whole dot (r = 8) lies inside the open window
      expect(redPixels(rig, 0.5)).toBeGreaterThan(0);
      expect(redPixels(rig, 0.5)).toBeLessThan(full);
    });

    it('draws fully with maskInvert while the mask parts have no geometry', () => {
      const inverted = windowRig(true);
      expect(redPixels(inverted, 0)).toBe(redPixels(windowRig(false), 1));
      expect(redPixels(inverted, 1)).toBe(0);
    });
  });
});

describe('renderImage: textures', () => {
  const tex2x2: ImageRGBA = {
    width: 2,
    height: 2,
    data: Uint8ClampedArray.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]),
  };
  const uvs = Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]);
  const white: RGBA = [1, 1, 1, 1];

  it('reproduces texels exactly at texel centers', () => {
    const img = renderImage(
      list(2, 2, [quad(0, 0, 2, 2, white, { texture: 't', uvs })]),
      { t: tex2x2 },
      { supersample: 1 },
    );
    expect(px(img, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(px(img, 1, 0)).toEqual([0, 255, 0, 255]);
    expect(px(img, 0, 1)).toEqual([0, 0, 255, 255]);
    expect(px(img, 1, 1)).toEqual([255, 255, 255, 255]);
  });

  it('filters bilinearly between texels and clamps at the edges', () => {
    const img = renderImage(
      list(2, 2, [quad(0, 0, 2, 2, white, { texture: 't', uvs })]),
      { t: tex2x2 },
      { scale: 2, supersample: 1 },
    );
    // Pixel (1, 0): center u = 1.5/4 -> 25% of the way from red to green.
    expect(px(img, 1, 0)).toEqual([191, 64, 0, 255]);
    // Pixel (0, 0): center u = v = 0.125 is outside the texel-center grid -> clamped to pure red.
    expect(px(img, 0, 0)).toEqual([255, 0, 0, 255]);
    // Pixel (1, 1): 9/16 red + 3/16 green + 3/16 blue + 1/16 white.
    expect(px(img, 1, 1)).toEqual([
      Math.round((10 / 16) * 255),
      Math.round((4 / 16) * 255),
      Math.round((4 / 16) * 255),
      255,
    ]);
  });

  it('premultiplies texels before filtering (no dark fringes)', () => {
    const tex: ImageRGBA = { width: 2, height: 1, data: Uint8ClampedArray.from([255, 255, 255, 255, 0, 0, 0, 0]) };
    const img = renderImage(
      list(1, 1, [quad(0, 0, 1, 1, white, { texture: 't', uvs })]),
      { t: tex },
      { scale: 4, supersample: 1 },
    );
    const mid = px(img, 1, 0);
    expect(mid.slice(0, 3)).toEqual([255, 255, 255]);
    expect(mid[3]).toBe(191);
  });

  it('multiplies vertex color with the texel', () => {
    const img = renderImage(
      list(2, 2, [quad(0, 0, 2, 2, [1, 0.5, 1, 0.5], { texture: 't', uvs })]),
      { t: tex2x2 },
      { supersample: 1 },
    );
    expect(px(img, 1, 1)).toEqual([255, 128, 255, 128]);
    expect(px(img, 0, 0)).toEqual([255, 0, 0, 128]);
  });

  it('reports missing textures and uvs', () => {
    expect(() => renderImage(list(2, 2, [quad(0, 0, 2, 2, white, { texture: 'nope', uvs })]), {})).toThrow(
      /texture "nope"/,
    );
    expect(() => renderImage(list(2, 2, [quad(0, 0, 2, 2, white, { texture: 't' })]), { t: tex2x2 })).toThrow(/uv/);
    // Valid ids that are also Object.prototype keys must not resolve to inherited members.
    expect(() => renderImage(list(2, 2, [quad(0, 0, 2, 2, white, { texture: 'constructor', uvs })]), {})).toThrow(
      /texture "constructor", which was not provided/,
    );
    const own = renderImage(
      list(2, 2, [quad(0, 0, 2, 2, white, { texture: 'toString', uvs })]),
      { toString: tex2x2 },
      { supersample: 1 },
    );
    expect(px(own, 0, 0)).toEqual([255, 0, 0, 255]);
  });
});

describe('renderImage: performance', () => {
  it('renders 512x512 with ~5k textured triangles at SS 2 in under a second', () => {
    const cols = 50;
    const rows = 50;
    const { positions, indices } = jitteredGrid(512, 512, cols, rows, 6, 7);
    const n = positions.length / 2;
    const uvs = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      uvs[i * 2] = positions[i * 2] / 512;
      uvs[i * 2 + 1] = positions[i * 2 + 1] / 512;
    }
    const tex: ImageRGBA = {
      width: 64,
      height: 64,
      data: new Uint8ClampedArray(64 * 64 * 4).map((_, i) => (i * 37) & 255),
    };
    const l = list(512, 512, [item(positions, indices, [1, 1, 1, 0.9], { texture: 't', uvs })], [1, 1, 1, 1]);
    expect(indices.length / 3).toBe(5000);
    renderImage(list(8, 8, []), {}); // warm up
    const t0 = performance.now();
    const img = renderImage(l, { t: tex }, { supersample: 2 });
    const ms = performance.now() - t0;
    expect(img.width).toBe(512);
    expect(ms).toBeLessThan(1000);
  });
});
