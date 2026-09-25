import { describe, expect, it } from 'vitest';
import { CAPTION_MAX_LINES, composeSheet, sheetSize, wrapCaption } from '../sheet.js';
import { diffImages } from '../diff.js';
import { cloneImage, createImage, getPixel } from '../image.js';
import type { ImageRGBA } from '../../core/types.js';

function hasInk(img: ImageRGBA, x0: number, y0: number, x1: number, y1: number, bg: number[]): boolean {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) if (getPixel(img, x, y).some((v, i) => v !== bg[i])) return true;
  }
  return false;
}

describe('composeSheet', () => {
  const cell = () => ({ image: createImage(10, 8, '#ff0000') });
  const BG = [41, 41, 46, 255];

  it('lays out cells on a grid with default columns ceil(sqrt(n))', () => {
    expect(composeSheet([cell(), cell(), cell(), cell()]).width).toBe(2 * 10 + 3 * 8);
    const five = composeSheet(Array.from({ length: 5 }, cell), { padding: 4 });
    expect([five.width, five.height]).toEqual([3 * 10 + 4 * 4, 2 * 8 + 3 * 4]);
    const ten = composeSheet(Array.from({ length: 10 }, cell), { padding: 0 });
    expect([ten.width, ten.height]).toEqual([40, 24]);
    expect(composeSheet([cell(), cell(), cell()], { columns: 1, padding: 0 }).height).toBe(24);
  });

  it('sheetSize predicts the composed size for every layout option', () => {
    for (const n of [1, 3, 5, 10]) {
      for (const opts of [{}, { columns: 2, padding: 4 }, { title: 'T', textScale: 2 }, { padding: 0 }]) {
        for (const caption of [undefined, 'c']) {
          for (const subcaption of [undefined, 'events']) {
            const cells = Array.from({ length: n }, (_, i) => ({ ...cell(), ...(caption ? { caption } : {}), ...(subcaption && i === 0 ? { subcaption } : {}) }));
            const img = composeSheet(cells, opts);
            const size = sheetSize(n, 10, 8, { ...opts, captions: !!caption, subcaptions: !!subcaption });
            expect([size.width, size.height], JSON.stringify({ n, opts, caption, subcaption })).toEqual([img.width, img.height]);
          }
        }
      }
    }
  });

  it('sheetSize with the caption texts predicts wrapped captions exactly', () => {
    const long = 'EyeLOpen,EyeROpen=0.333 AngleX=-30';
    for (const width of [20, 60, 72, 120, 150, 250]) {
      for (const textScale of [1, 2]) {
        const cells = [
          { image: createImage(width, 30), caption: long, subcaption: 'blink footL:contact footR:lift' },
          { image: createImage(width, 30), caption: 'AngleX=0' },
        ];
        const img = composeSheet(cells, { columns: 2, textScale, title: 'T' });
        const size = sheetSize(2, width, 30, { columns: 2, textScale, title: 'T', captions: cells.map((c) => c.caption), subcaptions: cells.map((c) => c.subcaption) });
        expect([size.width, size.height], JSON.stringify({ width, textScale })).toEqual([img.width, img.height]);
      }
    }
    // Without texts (booleans) one line each is reserved: the minimum.
    const one = sheetSize(1, 60, 30, { captions: true });
    expect(sheetSize(1, 60, 30, { captions: ['EyeLOpen,EyeROpen=0.333 AngleX=-30'] }).height).toBeGreaterThan(one.height);
    expect(sheetSize(1, 60, 30, { captions: ['short'] }).height).toBe(one.height);
    expect(sheetSize(1, 60, 30, { captions: [undefined] }).height).toBe(sheetSize(1, 60, 30, { captions: false }).height);
  });

  it('places cell images, captions and a title', () => {
    const cells = Array.from({ length: 5 }, (_, i) => ({ ...cell(), caption: `f${i}` }));
    const sheet = composeSheet(cells, { padding: 4, title: 'Sweep AngleX' });
    const captionH = 4 + 7;
    const titleH = 7 + 4;
    expect([sheet.width, sheet.height]).toEqual([46, titleH + 2 * (8 + captionH) + 3 * 4]);
    expect(getPixel(sheet, 0, 0)).toEqual(BG);
    expect(getPixel(sheet, 4, titleH + 4)).toEqual([255, 0, 0, 255]);
    expect(getPixel(sheet, 3, titleH + 4)).toEqual(BG);
    // Cell 4 = row 1, column 1.
    expect(getPixel(sheet, 4 + 14, titleH + 4 + 8 + captionH + 4)).toEqual([255, 0, 0, 255]);
    // Caption text below cell 0, title text in the top bar.
    expect(hasInk(sheet, 4, titleH + 4 + 8 + 4, 14, titleH + 4 + 8 + captionH, BG)).toBe(true);
    expect(hasInk(sheet, 4, 4, 42, 4 + 7, BG)).toBe(true);
  });

  it('centers smaller cells, scales images and honours the background', () => {
    const sheet = composeSheet([{ image: createImage(10, 10, '#00ff00') }, { image: createImage(4, 4, '#0000ff') }], {
      columns: 2,
      padding: 2,
      background: [1, 1, 1, 1],
    });
    expect(getPixel(sheet, 0, 0)).toEqual([255, 255, 255, 255]);
    // Second cell box starts at x = 14; the 4x4 image is centered: offset 3.
    expect(getPixel(sheet, 14 + 3, 2 + 3)).toEqual([0, 0, 255, 255]);
    expect(getPixel(sheet, 14 + 2, 2 + 3)).toEqual([255, 255, 255, 255]);

    const half = composeSheet([{ image: createImage(10, 8) }], { scale: 0.5, padding: 0 });
    expect([half.width, half.height]).toEqual([5, 4]);
  });

  it("wraps long captions onto up to 3 lines and grows every cell's caption area to match", () => {
    const cells = [
      { image: createImage(150, 20), caption: 'EyeLOpen,EyeROpen=0.333 AngleX=-30' },
      { image: createImage(150, 20), caption: 'EyeLOpen,EyeROpen=0 AngleX=-30' },
    ];
    const sheet = composeSheet(cells, { padding: 0, columns: 2 });
    // 150 px = 25 characters: "EyeLOpen,EyeROpen=0.333" / "AngleX=-30" (2 lines of 7 px, 2 px apart).
    expect(wrapCaption(cells[0].caption, 150)).toEqual(['EyeLOpen,EyeROpen=0.333', 'AngleX=-30']);
    expect(sheet.height).toBe(20 + 4 + 7 + 2 + 7);
    // Second line has ink under both cells (every cell reserves the same lines; the grid stays aligned).
    expect(hasInk(sheet, 0, 20 + 4 + 9, 150, 20 + 4 + 16, BG)).toBe(true);
    expect(hasInk(sheet, 150, 20 + 4 + 9, 300, 20 + 4 + 16, BG)).toBe(true);
    // Deterministic.
    expect(Buffer.from(composeSheet(cells, { padding: 0, columns: 2 }).data).equals(Buffer.from(sheet.data))).toBe(true);
  });

  it('wrapCaption: natural breaks first, then shortened ids (values kept), then cuts', () => {
    const c = 'EyeLOpen,EyeROpen=0.333 AngleX=-30';
    const at = (chars: number, text = c, maxLines?: number) => wrapCaption(text, chars * 6 - 1, maxLines ? { maxLines } : {});
    expect(at(40)).toEqual([c]);
    expect(at(25)).toEqual(['EyeLOpen,EyeROpen=0.333', 'AngleX=-30']);
    // After a comma before splitting an "id=value" pair.
    expect(at(20)).toEqual(['EyeLOpen,', 'EyeROpen=0.333', 'AngleX=-30']);
    // Too long for 3 lines: ids before "=" are shortened as little as needed, values stay whole.
    expect(at(12)).toEqual(['EyeLO.,', 'EyeRO.=0.333', 'AngleX=-30']);
    expect(at(13, 'MouthOpenForm=0.25 BodyAngleX=-10')).toEqual(['MouthOp.=0.25', 'BodyAng.=-10']);
    for (const n of [4, 5, 6, 8, 10, 12, 20]) {
      const lines = at(n);
      expect(lines.length, String(n)).toBeLessThanOrEqual(CAPTION_MAX_LINES);
      for (const l of lines) expect(Array.from(l).length, `${n}: ${l}`).toBeLessThanOrEqual(n);
    }
    // Last resort: the lines that do not fit are dropped and the cut is marked with "..".
    expect(at(10, 'averyveryverylongidentifierwithoutbreaks')).toEqual(['averyveryv', 'erylongide', 'ntifierw..']);
    expect(at(10, 'blink footL:contact footR:lift', 2)).toEqual(['blink', 'footL:..']);
    // Narrower than 4 characters: one truncated line (as before wrapping existed); line breaks are spaces.
    expect(at(3, c)).toEqual(['E..']);
    expect(at(10, 'ab\ncd\r\nef')).toEqual(['ab cd ef']);
    expect(wrapCaption('   ', 100)).toEqual([]);
    // Text scale 2 halves the characters per line: 239 px = 20 characters, as at(20) above.
    expect(wrapCaption(c, 239, { textScale: 2 })).toEqual(at(20));
  });

  it('truncates long captions to the cell width', () => {
    const sheet = composeSheet([{ image: createImage(20, 5), caption: 'a very long caption indeed' }], { padding: 0 });
    // Nothing is drawn beyond the sheet; the caption row still has ink.
    expect(sheet.width).toBe(20);
    expect(hasInk(sheet, 0, 5 + 4, 20, sheet.height, BG)).toBe(true);
  });

  it('folds multi-line captions (LF, CRLF or CR) into one line', () => {
    const sheetOf = (caption: string) => composeSheet([{ image: createImage(60, 5), caption }], { padding: 0 });
    const flat = sheetOf('ab cd ef');
    for (const caption of ['ab\ncd\nef', 'ab\r\ncd\r\nef', 'ab\rcd\ref']) {
      expect(Buffer.from(sheetOf(caption).data).equals(Buffer.from(flat.data)), JSON.stringify(caption)).toBe(true);
    }
  });

  it('adds a subcaption line in an accent color only when some cell has one', () => {
    const plain = composeSheet([{ ...cell(), caption: 'a' }, { ...cell(), caption: 'b' }], { padding: 4, columns: 2 });
    const sub = composeSheet([{ ...cell(), caption: 'a', subcaption: 'step' }, { ...cell(), caption: 'b' }], { padding: 4, columns: 2 });
    // One more text line (7 px) plus a 2 px gap.
    expect(sub.height).toBe(plain.height + 2 + 7);
    const lineY = 4 + 8 + 4 + 7 + 2;
    // Accent ink (amber on the dark default background) under cell 0 only.
    let amber = 0;
    for (let y = lineY; y < lineY + 7; y++) {
      for (let x = 4; x < 14; x++) {
        const [r, g, b] = getPixel(sub, x, y);
        if (r > 200 && g > 150 && b < 120) amber++;
      }
    }
    expect(amber).toBeGreaterThan(0);
    expect(hasInk(sub, 18, lineY, 28, lineY + 7, BG)).toBe(false);
    // A subcaption without a caption still gets the caption area.
    expect(composeSheet([{ ...cell(), subcaption: 'x' }], { padding: 0 }).height).toBe(8 + 4 + 7 + 2 + 7);
  });

  it('rejects an empty cell list, malformed cells and invalid layout numbers', () => {
    expect(() => composeSheet([])).toThrow(/no cells/);
    const bad = { image: { width: 2, height: 2, data: new Uint8ClampedArray(3) } };
    expect(() => composeSheet([cell(), bad])).toThrow(/cell 1/);
    expect(() => composeSheet([cell()], { columns: Number.NaN })).toThrow(/columns/);
    expect(() => composeSheet([cell()], { padding: Number.POSITIVE_INFINITY })).toThrow(/padding/);
  });
});

describe('diffImages', () => {
  const base = createImage(4, 3, '#406080');

  it('reports identical images', () => {
    const d = diffImages(base, cloneImage(base));
    expect(d).toMatchObject({ width: 4, height: 3, differentPixels: 0, maxDelta: 0, meanDelta: 0 });
    expect(new Set(Array.from({ length: 12 }, (_, i) => d.image.data[i * 4 + 3]))).toEqual(new Set([255]));
    // Dimmed: darker than the source everywhere.
    expect(getPixel(d.image, 0, 0)[0]).toBeLessThan(0x40);
  });

  it('counts, measures and highlights differences', () => {
    const other = cloneImage(base);
    other.data[(1 * 4 + 2) * 4 + 1] += 10; // pixel (2, 1) green +10
    other.data[(2 * 4 + 3) * 4 + 3] = 0; // pixel (3, 2) alpha 255 -> 0
    const d = diffImages(base, other);
    expect(d.differentPixels).toBe(2);
    expect(d.maxDelta).toBe(255);
    expect(d.meanDelta).toBeCloseTo((10 + 255) / 12, 10);
    expect(getPixel(d.image, 2, 1)).toEqual([255, 0, 0, 255]);
    expect(getPixel(d.image, 3, 2)).toEqual([255, 0, 0, 255]);
    expect(getPixel(d.image, 0, 0)).not.toEqual([255, 0, 0, 255]);
    expect(diffImages(base, other, { threshold: 10 }).differentPixels).toBe(1);
  });

  it('throws on size mismatch and on an invalid threshold', () => {
    expect(() => diffImages(base, createImage(3, 4))).toThrow(/size mismatch/);
    expect(() => diffImages(base, base, { threshold: Number.NaN })).toThrow(/threshold/);
  });
});
