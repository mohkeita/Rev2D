import { describe, expect, it } from 'vitest';
import type { ImageRGBA } from '../../core/types.js';
import {
  CELL_HEIGHT,
  CELL_WIDTH,
  drawLabel,
  drawText,
  glyphRows,
  GLYPH_HEIGHT,
  GLYPH_WIDTH,
  measureLabel,
  measureText,
} from '../font.js';
import { Coverage, drawCircle, drawDashedLine, drawLine, drawPolyline, fillRect, strokeRect } from '../draw.js';
import { blitImage, cloneImage, createImage, cropImage, getPixel, resizeNearest, resolveColor } from '../image.js';

/** Bounding box [x0, y0, x1, y1] (exclusive) of pixels with alpha > 0, or null. */
function inkBox(img: ImageRGBA): [number, number, number, number] | null {
  let box: [number, number, number, number] | null = null;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3] === 0) continue;
      box = box
        ? [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x + 1), Math.max(box[3], y + 1)]
        : [x, y, x + 1, y + 1];
    }
  }
  return box;
}

function alphas(img: ImageRGBA): number[] {
  return Array.from({ length: img.width * img.height }, (_, i) => img.data[i * 4 + 3]);
}

describe('font', () => {
  const printable = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i));

  it('has a non-empty 5x7 glyph for every printable character except space', () => {
    for (const ch of printable) {
      const rows = glyphRows(ch);
      expect(rows.length).toBe(GLYPH_HEIGHT);
      expect(rows.every((r) => r < 1 << GLYPH_WIDTH)).toBe(true);
      if (ch === ' ') expect(rows.every((r) => r === 0)).toBe(true);
      else expect(rows.some((r) => r !== 0)).toBe(true);
    }
  });

  it('has a distinct shape for every character (legibility)', () => {
    const shapes = new Map<string, string>();
    for (const ch of printable) {
      const key = Array.from(glyphRows(ch)).join(',');
      expect(shapes.get(key), `"${ch}" duplicates "${shapes.get(key)}"`).toBeUndefined();
      shapes.set(key, ch);
    }
  });

  it('renders non-ASCII characters as "?"', () => {
    expect(Array.from(glyphRows('é'))).toEqual(Array.from(glyphRows('?')));
    expect(measureText('\u{1F600}').width).toBe(measureText('?').width);
  });

  it('measures text consistently', () => {
    expect(measureText('')).toEqual({ width: 0, height: 0 });
    expect(measureText('A')).toEqual({ width: GLYPH_WIDTH, height: GLYPH_HEIGHT });
    expect(measureText('abc')).toEqual({ width: 3 * CELL_WIDTH - 1, height: GLYPH_HEIGHT });
    expect(measureText('abc', { scale: 3 })).toEqual({ width: (3 * CELL_WIDTH - 1) * 3, height: GLYPH_HEIGHT * 3 });
    expect(measureText('ab\nwxyz')).toEqual({ width: 4 * CELL_WIDTH - 1, height: 2 * CELL_HEIGHT - 1 });
  });

  it('falls back to scale 1 for invalid scales', () => {
    for (const scale of [Number.NaN, 0, -2, 0.5, Number.POSITIVE_INFINITY]) {
      expect(measureText('ab', { scale }), String(scale)).toEqual(measureText('ab'));
      expect(measureLabel('ab', 0, 0, { scale }), String(scale)).toEqual(measureLabel('ab', 0, 0));
    }
    expect(measureLabel('ab', 0, 0, { padding: Number.NaN })).toEqual(measureLabel('ab', 0, 0));
    expect(measureLabel('ab', 0, 0, { padding: -3 })).toEqual({ ...measureText('ab'), x: 0, y: 0 });
  });

  it('treats CRLF and CR like LF line breaks', () => {
    expect(measureText('ab\r\nwxyz')).toEqual(measureText('ab\nwxyz'));
    const lf = createImage(30, 30);
    const crlf = createImage(30, 30);
    const cr = createImage(30, 30);
    drawText(lf, 1, 1, 'a\nb\nc', '#fff');
    drawText(crlf, 1, 1, 'a\r\nb\r\nc', '#fff');
    drawText(cr, 1, 1, 'a\rb\rc', '#fff');
    expect(Buffer.from(crlf.data).equals(Buffer.from(lf.data))).toBe(true);
    expect(Buffer.from(cr.data).equals(Buffer.from(lf.data))).toBe(true);
  });

  it('draws text exactly inside its measured box', () => {
    for (const [text, scale] of [
      ['HELLO', 1],
      ['Wm|', 2],
      ['x=12\ny=-3', 1],
    ] as Array<[string, number]>) {
      const img = createImage(80, 40);
      drawText(img, 3, 4, text, [1, 1, 1, 1], { scale });
      const m = measureText(text, { scale });
      const box = inkBox(img)!;
      expect(box[0]).toBeGreaterThanOrEqual(3);
      expect(box[1]).toBeGreaterThanOrEqual(4);
      expect(box[2]).toBeLessThanOrEqual(3 + m.width);
      expect(box[3]).toBeLessThanOrEqual(4 + m.height);
    }
    // "H" touches all four sides of its 5x7 cell.
    const h = createImage(10, 10);
    drawText(h, 2, 1, 'H', '#ff0000');
    expect(inkBox(h)).toEqual([2, 1, 7, 8]);
    expect(getPixel(h, 2, 1)).toEqual([255, 0, 0, 255]);
    expect(getPixel(h, 3, 1)[3]).toBe(0);
  });

  it('scales glyph pixels into solid blocks', () => {
    const img = createImage(20, 20);
    drawText(img, 0, 0, '.', [0, 0, 0, 1], { scale: 2 });
    // "." occupies columns 1-2, rows 5-6 of the glyph -> a 4x4 block at (2, 10).
    expect(inkBox(img)).toEqual([2, 10, 6, 14]);
    expect(alphas(img).filter((a) => a === 255).length).toBe(16);
  });

  it('draws labels on a translucent box that works over any background', () => {
    for (const bg of ['#000000', '#ffffff', '#7f7f7f']) {
      const img = createImage(60, 20, bg);
      const box = drawLabel(img, 5, 3, 'id');
      expect(box).toEqual(measureLabel('id', 5, 3));
      expect(box).toEqual({ x: 5, y: 3, width: 11 + 4, height: 7 + 4 });
      // Text pixels are white; box pixels are dark; pixels outside the box untouched.
      const text: number[] = [];
      const boxPx: number[] = [];
      for (let y = box.y; y < box.y + box.height; y++) {
        for (let x = box.x; x < box.x + box.width; x++) {
          const [r, g, b] = getPixel(img, x, y);
          if (r === 255 && g === 255 && b === 255) text.push(x);
          else boxPx.push(r);
        }
      }
      expect(text.length).toBeGreaterThan(5);
      expect(Math.max(...boxPx)).toBeLessThan(90);
      expect(getPixel(img, 4, 3)).toEqual(getPixel(createImage(1, 1, bg), 0, 0));
    }
  });
});

describe('draw primitives', () => {
  it('fillRect blends straight alpha source-over', () => {
    const img = createImage(4, 4, [0, 0, 1, 1]);
    fillRect(img, 1, 1, 2, 2, [1, 0, 0, 0.5]);
    expect(getPixel(img, 1, 1)).toEqual([128, 0, 127, 255]);
    expect(getPixel(img, 0, 0)).toEqual([0, 0, 255, 255]);
    expect(getPixel(img, 3, 3)).toEqual([0, 0, 255, 255]);
    const clear = createImage(2, 2);
    fillRect(clear, 0, 0, 2, 2, [0, 1, 0, 0.5]);
    expect(getPixel(clear, 0, 0)).toEqual([0, 255, 0, 128]);
    fillRect(clear, 0, 0, 2, 2, [0, 1, 0, 0.5]);
    // 128/255 + 128/255 * (1 - 128/255) = 0.75196 -> 191.75 -> 192.
    expect(getPixel(clear, 0, 0)).toEqual([0, 255, 0, 192]);
  });

  it('fillRect clips to the image', () => {
    const img = createImage(3, 3);
    fillRect(img, -5, -5, 6, 100, '#fff');
    expect(alphas(img)).toEqual([255, 0, 0, 255, 0, 0, 255, 0, 0]);
  });

  it('strokeRect never double-blends its corners', () => {
    const img = createImage(10, 10);
    strokeRect(img, 1, 1, 8, 6, [1, 1, 0, 0.5], 2);
    expect(new Set(alphas(img))).toEqual(new Set([0, 128]));
    expect(getPixel(img, 1, 1)[3]).toBe(128);
    expect(getPixel(img, 2, 2)[3]).toBe(128);
    expect(getPixel(img, 3, 3)[3]).toBe(0);
    expect(getPixel(img, 8, 6)[3]).toBe(128);
    expect(getPixel(img, 9, 7)[3]).toBe(0);
  });

  it('drawLine without antialiasing is exactly one pixel wide', () => {
    const img = createImage(12, 12);
    drawLine(img, 1.2, 5.7, 10.9, 5.1, '#ff0000', { antialias: false });
    const covered = alphas(img)
      .map((a, i) => (a ? i : -1))
      .filter((i) => i >= 0);
    expect(covered).toEqual(Array.from({ length: 10 }, (_, k) => 5 * 12 + 1 + k));
    const diag = createImage(8, 8);
    drawLine(diag, 0, 0, 7.9, 7.9, '#fff', { antialias: false });
    expect(alphas(diag).filter((a) => a === 255).length).toBe(8);
    for (let i = 0; i < 8; i++) expect(getPixel(diag, i, i)[3]).toBe(255);
  });

  it('drawLine anti-aliases and honours width', () => {
    const img = createImage(20, 20);
    drawLine(img, 2, 3, 17, 15, '#ffffff', { width: 3 });
    const a = alphas(img);
    expect(a.some((v) => v > 0 && v < 255)).toBe(true);
    // Pixel on the line is fully covered; far away untouched.
    expect(getPixel(img, 10, 9)[3]).toBe(255);
    expect(getPixel(img, 17, 3)[3]).toBe(0);
    // A thick horizontal line through pixel centers covers width rows.
    const h = createImage(10, 10);
    drawLine(h, 1, 4.5, 8, 4.5, '#fff', { width: 3 });
    expect([3, 4, 5].map((y) => getPixel(h, 4, y)[3])).toEqual([255, 255, 255]);
    expect(getPixel(h, 4, 1)[3]).toBe(0);
  });

  it('drawPolyline with a translucent color does not darken joints', () => {
    const img = createImage(30, 30);
    drawPolyline(img, [3, 3, 25, 5, 20, 25, 4, 20], [1, 0, 0, 0.5], { width: 3, closed: true });
    const a = alphas(img);
    expect(Math.max(...a)).toBe(128);
    expect(getPixel(img, 25, 5)[3]).toBe(128);
    expect(getPixel(img, 3, 3)[3]).toBe(128);
  });

  it('drawDashedLine alternates dashes and gaps', () => {
    const img = createImage(40, 3);
    drawDashedLine(img, 0, 1.5, 40, 1.5, '#fff', { dash: 6, gap: 4, antialias: false });
    const row = Array.from({ length: 40 }, (_, x) => (getPixel(img, x, 1)[3] ? 1 : 0)).join('');
    // Crisp dashes run from pixel center to pixel center: a 6px dash spans 7 pixels.
    expect(row).toBe('1111111000111111100011111110001111111000');
  });

  it('drawCircle fills discs and strokes rings', () => {
    const disc = createImage(21, 21);
    drawCircle(disc, 10.5, 10.5, 6, '#00ff00');
    expect(getPixel(disc, 10, 10)).toEqual([0, 255, 0, 255]);
    expect(getPixel(disc, 10, 15)[3]).toBe(255);
    expect(getPixel(disc, 10, 18)[3]).toBe(0);
    expect(getPixel(disc, 0, 0)[3]).toBe(0);

    const ring = createImage(21, 21);
    drawCircle(ring, 10.5, 10.5, 6, '#00ff00', { fill: false, width: 2 });
    expect(getPixel(ring, 10, 10)[3]).toBe(0);
    expect(getPixel(ring, 16, 10)[3]).toBe(255);
    expect(getPixel(ring, 10, 4)[3]).toBe(255);
    expect(getPixel(ring, 20, 10)[3]).toBe(0);
  });

  it('Coverage combines shapes with max before a single composite', () => {
    const img = createImage(10, 10);
    new Coverage(img).rect(0, 0, 6, 6).rect(3, 3, 6, 6).rect(0, 8, 10, 1, 0.5).composite(img, [0, 0, 1, 0.8]);
    expect(getPixel(img, 4, 4)[3]).toBe(204);
    expect(getPixel(img, 1, 1)[3]).toBe(204);
    expect(getPixel(img, 1, 8)[3]).toBe(102);
    expect(getPixel(img, 5, 8)[3]).toBe(204);
    expect(getPixel(img, 9, 0)[3]).toBe(0);
  });

  it('ignores non-finite geometry', () => {
    const img = createImage(5, 5);
    drawLine(img, Number.NaN, 0, 4, 4, '#fff');
    drawCircle(img, Number.POSITIVE_INFINITY, 2, 3, '#fff');
    expect(alphas(img).every((a) => a === 0)).toBe(true);
  });

  it('drawPolyline skips only the segments that touch a non-finite vertex', () => {
    const img = createImage(20, 20);
    drawPolyline(img, [1.5, 1.5, 18.5, 1.5, Number.NaN, 9, 18.5, 18.5, 1.5, 18.5], '#fff', { antialias: false });
    // The first and last segments are finite; the two segments through the NaN vertex are dropped.
    expect([1, 10, 18].map((x) => getPixel(img, x, 1)[3])).toEqual([255, 255, 255]);
    expect([1, 10, 18].map((x) => getPixel(img, x, 18)[3])).toEqual([255, 255, 255]);
    expect(getPixel(img, 18, 9)[3]).toBe(0);
  });

  it('only does work for the visible part of lines with far-away endpoints', () => {
    const near = createImage(20, 8);
    const far = createImage(20, 8);
    const back = createImage(20, 8);
    drawDashedLine(near, 2, 3.5, 60, 3.5, '#fff', { dash: 5, gap: 3 });
    const t0 = performance.now();
    drawDashedLine(far, 2, 3.5, 1e9, 3.5, '#fff', { dash: 5, gap: 3 });
    drawDashedLine(back, 1e9, 3.5, 2, 3.5, '#fff', { dash: 5, gap: 3 });
    drawLine(back, -1e9, -1e9, 1e9, 1e9, '#fff');
    expect(performance.now() - t0).toBeLessThan(250);
    // Dashes are phased from the start point, so the visible pattern does not depend on the far end.
    expect(Buffer.from(far.data).equals(Buffer.from(near.data))).toBe(true);
    expect(alphas(back).some((a) => a > 0)).toBe(true);
  });

  it('draws a dash pattern finer than a pixel as a solid line', () => {
    const dense = createImage(20, 4);
    const t0 = performance.now();
    drawDashedLine(dense, 0, 1.5, 20, 1.5, '#fff', { dash: 1e-6, gap: 1e-6 });
    expect(performance.now() - t0).toBeLessThan(250);
    const solid = createImage(20, 4);
    drawLine(solid, 0, 1.5, 20, 1.5, '#fff');
    expect(Buffer.from(dense.data).equals(Buffer.from(solid.data))).toBe(true);
  });

  it('rasterizes segments exactly like a brute-force distance evaluation', () => {
    // Oracle: the documented coverage model evaluated at every pixel center of the region.
    const oracle = (w: number, h: number, seg: number[], width: number, aa: boolean): Float32Array => {
      let [ax, ay, bx, by] = seg;
      if (!aa) [ax, ay, bx, by] = [ax, ay, bx, by].map((v) => Math.floor(v) + 0.5);
      const hw = Math.max(width, 1) / 2;
      const alpha = Math.min(width, 1);
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const out = new Float32Array(w * h);
      for (let py = 0; py < h; py++) {
        for (let px = 0; px < w; px++) {
          const [cx, cy] = [px + 0.5, py + 0.5];
          const t = len2 > 0 ? Math.min(1, Math.max(0, ((cx - ax) * dx + (cy - ay) * dy) / len2)) : 0;
          const [ex, ey] = [ax + t * dx - cx, ay + t * dy - cy];
          const d = Math.sqrt(ex * ex + ey * ey);
          const c = aa ? (hw + 0.5 - d) * alpha : d <= hw ? 1 : 0;
          if (c > 0) out[py * w + px] = Math.min(1, c);
        }
      }
      return out;
    };
    let seed = 99;
    const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32) * 60 - 10;
    const segments = [
      [5, 5, 5, 5], // zero length
      [3.2, 10.5, 35.7, 10.5], // horizontal
      [12.5, -3, 12.5, 40], // vertical
      [-500, -320, 800, 470], // far endpoints, shallow
      [20, 15, 21, 900], // steep, one far endpoint
      ...Array.from({ length: 40 }, () => [rnd(), rnd(), rnd(), rnd()]),
    ];
    for (const seg of segments) {
      for (const width of [0.5, 1, 2.5, 6]) {
        for (const aa of [true, false]) {
          const cov = new Coverage({ width: 40, height: 30 }).segment(seg[0], seg[1], seg[2], seg[3], width, aa);
          expect(Array.from(cov.data), `${seg} w=${width} aa=${aa}`).toEqual(Array.from(oracle(40, 30, seg, width, aa)));
        }
      }
    }
  });

  it('Coverage.clear resets only what was drawn so a buffer can be reused', () => {
    const img = createImage(12, 12);
    const cov = new Coverage(img).segment(1, 1, 10, 10, 2);
    expect(cov.data.some((c) => c > 0)).toBe(true);
    cov.clear();
    expect(cov.data.every((c) => c === 0)).toBe(true);
    cov.rect(2, 2, 3, 3).composite(img, '#ff0000');
    expect(alphas(img).filter((a) => a > 0).length).toBe(9);
  });
});

describe('image utilities', () => {
  it('createImage fills and validates', () => {
    expect(getPixel(createImage(2, 1, 'rgba(255,0,0,0.5)'), 1, 0)).toEqual([255, 0, 0, 128]);
    expect(createImage(3, 3).data.every((v) => v === 0)).toBe(true);
    expect(() => createImage(-1, 2)).toThrow(RangeError);
    expect(() => createImage(1.5, 2)).toThrow(RangeError);
    expect(() => createImage(1, 1, 'nocolor')).toThrow(/invalid color/);
    expect(resolveColor('#00ff00')).toEqual([0, 1, 0, 1]);
  });

  it('cloneImage copies data', () => {
    const a = createImage(2, 2, '#123456');
    const b = cloneImage(a);
    b.data[0] = 0;
    expect(a.data[0]).toBe(0x12);
  });

  it('getPixel rejects out-of-bounds reads', () => {
    expect(() => getPixel(createImage(2, 2), 2, 0)).toThrow(RangeError);
  });

  it('blitImage composites with alpha and clips', () => {
    const dst = createImage(4, 4, [0, 0, 1, 1]);
    const src = createImage(2, 2, [1, 0, 0, 0.5]);
    src.data.set([0, 255, 0, 255], 12); // bottom-right source pixel opaque green
    blitImage(dst, src, 3, 3);
    expect(getPixel(dst, 3, 3)).toEqual([128, 0, 127, 255]);
    expect(getPixel(dst, 2, 2)).toEqual([0, 0, 255, 255]);
    blitImage(dst, src, -1, -1);
    expect(getPixel(dst, 0, 0)).toEqual([0, 255, 0, 255]);
    blitImage(dst, src, 1, 1, 0);
    expect(getPixel(dst, 1, 1)).toEqual([0, 0, 255, 255]);
  });

  it('cropImage copies a region and pads with transparency', () => {
    const img = createImage(3, 3);
    for (let i = 0; i < 9; i++) img.data.set([i, i, i, 255], i * 4);
    const c = cropImage(img, 1, 1, 3, 3);
    expect([c.width, c.height]).toEqual([3, 3]);
    expect(getPixel(c, 0, 0)).toEqual([4, 4, 4, 255]);
    expect(getPixel(c, 1, 1)).toEqual([8, 8, 8, 255]);
    expect(getPixel(c, 2, 2)).toEqual([0, 0, 0, 0]);
    expect(getPixel(cropImage(img, -1, 0, 2, 1), 1, 0)).toEqual([0, 0, 0, 255]);
  });

  it('resizeNearest duplicates and decimates pixels', () => {
    const img = createImage(2, 1);
    img.data.set([255, 0, 0, 255, 0, 0, 255, 255]);
    const up = resizeNearest(img, 4, 2);
    expect([0, 1, 2, 3].map((x) => getPixel(up, x, 1)[0])).toEqual([255, 255, 0, 0]);
    const down = resizeNearest(up, 2, 1);
    expect(Buffer.from(down.data).equals(Buffer.from(img.data))).toBe(true);
  });
});
