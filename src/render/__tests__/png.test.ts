import { describe, expect, it } from 'vitest';
import { deflateSync, inflateSync } from 'node:zlib';
import { crc32, decodePNG, encodePNG, pngChunk } from '../png.js';
import type { ImageRGBA } from '../../core/types.js';

/** Deterministic PRNG (mulberry32). */
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

function randomImage(width: number, height: number, seed: number): ImageRGBA {
  const r = rng(seed);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i++) data[i] = Math.floor(r() * 256);
  return { width, height, data };
}

const SIG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function u32(v: number): number[] {
  return [v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
}

/** Pack rows of samples at `depth` bits (MSB first) into unfiltered scanline bytes. */
function packRows(rows: number[][], depth: number): number[][] {
  return rows.map((row) => {
    const out: number[] = [];
    if (depth === 16) {
      for (const s of row) out.push(s >> 8, s & 255);
      return out;
    }
    let acc = 0;
    let bits = 0;
    for (const s of row) {
      acc = (acc << depth) | s;
      bits += depth;
      if (bits === 8) {
        out.push(acc);
        acc = 0;
        bits = 0;
      }
    }
    if (bits > 0) out.push(acc << (8 - bits));
    return out;
  });
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Filter scanlines as an encoder would (row y uses types[y % types.length]); each row gets its filter byte. */
function filterScanlines(rows: number[][], bpp: number, types: number[]): Uint8Array {
  const out: number[] = [];
  rows.forEach((row, y) => {
    const prev = y > 0 ? rows[y - 1] : row.map(() => 0);
    const type = types[y % types.length];
    out.push(type);
    row.forEach((x, i) => {
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      const predictor = [0, a, b, (a + b) >> 1, paeth(a, b, c)][type];
      out.push((x - predictor) & 255);
    });
  });
  return Uint8Array.from(out);
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

interface BuildOptions {
  width: number;
  height: number;
  depth: number;
  colorType: number;
  /** pixels[y][x] = samples of that pixel. */
  pixels: number[][][];
  interlace?: boolean;
  plte?: number[];
  trns?: number[];
  extraChunks?: Uint8Array[];
  /** Scanline filter types, cycled per row of each (sub)image. Default [0]. */
  filters?: number[];
}

/** Hand-build a PNG file from per-pixel samples. */
function buildPNG(o: BuildOptions): Uint8Array {
  const flatRow = (px: number[][]) => px.flat();
  const bpp = Math.max(1, (CHANNELS[o.colorType] * o.depth) >> 3);
  const encode = (rows: number[][]) => filterScanlines(packRows(rows, o.depth), bpp, o.filters ?? [0]);
  let raw: Uint8Array;
  if (o.interlace) {
    const parts: Uint8Array[] = [];
    for (const [x0, y0, dx, dy] of ADAM7) {
      const rows: number[][] = [];
      for (let y = y0; y < o.height; y += dy) {
        const row: number[][] = [];
        for (let x = x0; x < o.width; x += dx) row.push(o.pixels[y][x]);
        if (row.length > 0) rows.push(flatRow(row));
      }
      if (rows.length > 0) parts.push(encode(rows));
    }
    raw = concat(parts);
  } else {
    raw = encode(o.pixels.map(flatRow));
  }
  const ihdr = Uint8Array.from([...u32(o.width), ...u32(o.height), o.depth, o.colorType, 0, 0, o.interlace ? 1 : 0]);
  const chunks = [SIG, pngChunk('IHDR', ihdr)];
  if (o.plte) chunks.push(pngChunk('PLTE', Uint8Array.from(o.plte)));
  if (o.trns) chunks.push(pngChunk('tRNS', Uint8Array.from(o.trns)));
  chunks.push(...(o.extraChunks ?? []));
  chunks.push(pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', new Uint8Array(0)));
  return concat(chunks);
}

function pixelsOf(img: ImageRGBA): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < img.data.length; i += 4) out.push(Array.from(img.data.subarray(i, i + 4)));
  return out;
}

/** Inflated scanline filter bytes of a (non-interlaced RGBA8) PNG produced by encodePNG. */
function filterTypes(png: Uint8Array, width: number, height: number): number[] {
  let pos = 8;
  const idat: Uint8Array[] = [];
  while (pos < png.length) {
    const len = (png[pos] << 24) | (png[pos + 1] << 16) | (png[pos + 2] << 8) | png[pos + 3];
    const type = String.fromCharCode(...png.subarray(pos + 4, pos + 8));
    if (type === 'IDAT') idat.push(png.subarray(pos + 8, pos + 8 + len));
    pos += 12 + len;
  }
  const raw = inflateSync(concat(idat));
  return Array.from({ length: height }, (_, y) => raw[y * (width * 4 + 1)]);
}

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe('encodePNG / decodePNG roundtrip', () => {
  const cases: Array<[string, ImageRGBA]> = [
    ['1x1', randomImage(1, 1, 1)],
    ['1x37 column', randomImage(1, 37, 2)],
    ['41x1 row', randomImage(41, 1, 3)],
    ['random 64x48', randomImage(64, 48, 4)],
    ['random 257x3', randomImage(257, 3, 5)],
    ['transparent 16x16', { width: 16, height: 16, data: new Uint8ClampedArray(16 * 16 * 4) }],
    ['opaque white 9x7', { width: 9, height: 7, data: new Uint8ClampedArray(9 * 7 * 4).fill(255) }],
  ];
  for (const [name, img] of cases) {
    it(`roundtrips ${name}`, () => {
      const png = encodePNG(img);
      expect(Array.from(png.subarray(0, 8))).toEqual(Array.from(SIG));
      const back = decodePNG(png);
      expect(back.width).toBe(img.width);
      expect(back.height).toBe(img.height);
      expect(Buffer.from(back.data).equals(Buffer.from(img.data))).toBe(true);
    });
  }

  it('roundtrips a smooth gradient and picks predictive filters for it', () => {
    const w = 64;
    const h = 32;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        data.set([x * 4, y * 8, (x + y) * 2, 255], i);
      }
    }
    const img = { width: w, height: h, data };
    const png = encodePNG(img);
    expect(Buffer.from(decodePNG(png).data).equals(Buffer.from(data))).toBe(true);
    const types = filterTypes(png, w, h);
    expect(types.every((t) => t >= 0 && t <= 4)).toBe(true);
    expect(types.some((t) => t !== 0)).toBe(true);
    // Smooth data compresses far below its raw size.
    expect(png.length).toBeLessThan((w * h * 4) / 4);
  });

  it('is deterministic', () => {
    const img = randomImage(33, 17, 9);
    expect(Buffer.from(encodePNG(img)).equals(Buffer.from(encodePNG(img)))).toBe(true);
  });

  it('rejects empty or malformed images', () => {
    expect(() => encodePNG({ width: 0, height: 4, data: new Uint8ClampedArray(0) })).toThrow(/empty/);
    expect(() => encodePNG({ width: 2, height: 2, data: new Uint8ClampedArray(3) })).toThrow(/data length/);
  });
});

describe('decodePNG formats', () => {
  it('decodes 2-bit palette with tRNS (row not byte aligned)', () => {
    const plte = [255, 0, 0, 0, 255, 0, 0, 0, 255, 10, 20, 30];
    const idx = [
      [0, 1, 2, 3, 0],
      [3, 2, 1, 0, 3],
    ];
    const png = buildPNG({
      width: 5,
      height: 2,
      depth: 2,
      colorType: 3,
      pixels: idx.map((r) => r.map((i) => [i])),
      plte,
      trns: [0, 128], // entry 0 fully transparent, entry 1 half, others opaque
    });
    const img = decodePNG(png);
    const expected = (i: number) => [plte[i * 3], plte[i * 3 + 1], plte[i * 3 + 2], i === 0 ? 0 : i === 1 ? 128 : 255];
    expect(pixelsOf(img)).toEqual(idx.flat().map(expected));
  });

  it('decodes 8-bit palette without tRNS', () => {
    const plte = Array.from({ length: 256 * 3 }, (_, i) => (i * 7) & 255);
    const png = buildPNG({ width: 3, height: 1, depth: 8, colorType: 3, pixels: [[[0], [100], [255]]], plte });
    expect(pixelsOf(decodePNG(png))).toEqual([
      [0, 7, 14, 255],
      [(300 * 7) & 255, (301 * 7) & 255, (302 * 7) & 255, 255],
      [(765 * 7) & 255, (766 * 7) & 255, (767 * 7) & 255, 255],
    ]);
  });

  it('decodes 16-bit RGBA by rounding to 8 bits', () => {
    const px = [
      [0x0000, 0xffff, 0x8080, 0x1234],
      [0xfeff, 0x0101, 0x7f7f, 0xffff],
    ];
    const img = decodePNG(buildPNG({ width: 2, height: 1, depth: 16, colorType: 6, pixels: [px] }));
    expect(pixelsOf(img)).toEqual(px.map((p) => p.map((v) => Math.round(v / 257))));
  });

  it('decodes 16-bit RGB with a tRNS color key', () => {
    const px = [
      [0x1000, 0x2000, 0x3000],
      [0x1000, 0x2000, 0x3001],
    ];
    const img = decodePNG(
      buildPNG({
        width: 2,
        height: 1,
        depth: 16,
        colorType: 2,
        pixels: [px],
        trns: [0x10, 0x00, 0x20, 0x00, 0x30, 0x00],
      }),
    );
    expect(img.data[3]).toBe(0);
    expect(img.data[7]).toBe(255);
    expect(Array.from(img.data.subarray(4, 7))).toEqual([16, 32, 48]);
  });

  it('decodes grayscale at 1, 4, 8 and 16 bits', () => {
    const one = decodePNG(
      buildPNG({
        width: 10,
        height: 1,
        depth: 1,
        colorType: 0,
        pixels: [[1, 0, 1, 1, 0, 0, 1, 0, 1, 1].map((v) => [v])],
      }),
    );
    expect(pixelsOf(one).map((p) => p[0])).toEqual([255, 0, 255, 255, 0, 0, 255, 0, 255, 255]);
    expect(pixelsOf(one).every((p) => p[0] === p[1] && p[1] === p[2] && p[3] === 255)).toBe(true);

    const four = decodePNG(buildPNG({ width: 3, height: 1, depth: 4, colorType: 0, pixels: [[[0], [7], [15]]] }));
    expect(pixelsOf(four).map((p) => p[0])).toEqual([0, 119, 255]);

    const eight = decodePNG(
      buildPNG({
        width: 2,
        height: 2,
        depth: 8,
        colorType: 0,
        pixels: [
          [[0], [50]],
          [[200], [255]],
        ],
        trns: [0, 50],
      }),
    );
    expect(pixelsOf(eight)).toEqual([
      [0, 0, 0, 255],
      [50, 50, 50, 0],
      [200, 200, 200, 255],
      [255, 255, 255, 255],
    ]);

    const sixteen = decodePNG(
      buildPNG({ width: 2, height: 1, depth: 16, colorType: 0, pixels: [[[0x8000], [0xffff]]] }),
    );
    expect(pixelsOf(sixteen).map((p) => p[0])).toEqual([Math.round(0x8000 / 257), 255]);
  });

  it('decodes gray + alpha at 8 and 16 bits', () => {
    const g8 = decodePNG(
      buildPNG({
        width: 2,
        height: 1,
        depth: 8,
        colorType: 4,
        pixels: [
          [
            [10, 20],
            [250, 255],
          ],
        ],
      }),
    );
    expect(pixelsOf(g8)).toEqual([
      [10, 10, 10, 20],
      [250, 250, 250, 255],
    ]);
    const g16 = decodePNG(buildPNG({ width: 1, height: 1, depth: 16, colorType: 4, pixels: [[[0xffff, 0x0000]]] }));
    expect(pixelsOf(g16)).toEqual([[255, 255, 255, 0]]);
  });

  it('decodes Adam7-interlaced RGBA8 images of awkward sizes', () => {
    for (const [w, h] of [
      [1, 1],
      [3, 2],
      [11, 9],
      [17, 23],
    ]) {
      const src = randomImage(w, h, w * 100 + h);
      const pixels: number[][][] = [];
      for (let y = 0; y < h; y++) {
        pixels.push([]);
        for (let x = 0; x < w; x++) pixels[y].push(Array.from(src.data.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)));
      }
      const img = decodePNG(buildPNG({ width: w, height: h, depth: 8, colorType: 6, pixels, interlace: true }));
      expect(Buffer.from(img.data).equals(Buffer.from(src.data))).toBe(true);
    }
  });

  it('decodes Adam7-interlaced 1-bit palette images', () => {
    const w = 13;
    const h = 10;
    const idx = Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => (x * 3 + y * 5) % 2));
    const img = decodePNG(
      buildPNG({
        width: w,
        height: h,
        depth: 1,
        colorType: 3,
        interlace: true,
        plte: [0, 0, 0, 255, 255, 0],
        pixels: idx.map((r) => r.map((i) => [i])),
      }),
    );
    expect(pixelsOf(img)).toEqual(idx.flat().map((i) => (i ? [255, 255, 0, 255] : [0, 0, 0, 255])));
  });

  it('skips unknown ancillary chunks', () => {
    const png = buildPNG({
      width: 1,
      height: 1,
      depth: 8,
      colorType: 2,
      pixels: [[[1, 2, 3]]],
      extraChunks: [pngChunk('tEXt', new TextEncoder().encode('Comment\0hi'))],
    });
    expect(pixelsOf(decodePNG(png))).toEqual([[1, 2, 3, 255]]);
  });

  it('undoes every filter type at every bit depth, interlaced or not', () => {
    const r = rng(2024);
    const w = 11;
    const h = 9;
    const plte = Array.from({ length: 16 * 3 }, () => Math.floor(r() * 256));
    for (const [colorType, depth] of [
      [0, 1],
      [0, 2],
      [0, 4],
      [0, 8],
      [0, 16],
      [2, 8],
      [2, 16],
      [3, 4],
      [3, 8],
      [4, 8],
      [4, 16],
      [6, 8],
      [6, 16],
    ]) {
      const channels = CHANNELS[colorType];
      const max = colorType === 3 ? 15 : depth === 16 ? 65535 : (1 << depth) - 1;
      const pixels = Array.from({ length: h }, () =>
        Array.from({ length: w }, () => Array.from({ length: channels }, () => Math.floor(r() * (max + 1)))),
      );
      const to8 = (v: number) => (depth === 16 ? Math.round(v / 257) : Math.round((v * 255) / ((1 << depth) - 1)));
      const expected = pixels.flat().map((p) => {
        if (colorType === 3) return [...plte.slice(p[0] * 3, p[0] * 3 + 3), 255];
        const s = p.map(to8);
        return channels === 1 ? [s[0], s[0], s[0], 255] : channels === 2 ? [s[0], s[0], s[0], s[1]] : channels === 3 ? [...s, 255] : s;
      });
      for (const filters of [[0], [1], [2], [3], [4], [4, 3, 2, 1, 0]]) {
        for (const interlace of [false, true]) {
          const png = buildPNG({ width: w, height: h, depth, colorType, pixels, interlace, filters, plte: colorType === 3 ? plte : undefined });
          expect(pixelsOf(decodePNG(png)), `type ${colorType} depth ${depth} filters ${filters} interlace ${interlace}`).toEqual(expected);
        }
      }
    }
  });

  it('roundtrips rows for which the encoder picks different filters', () => {
    // Our encoder chooses filters adaptively; random + structured rows exercise several of them.
    const w = 40;
    const h = 40;
    const r = rng(77);
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const mode = y % 4;
        data[i] = mode === 0 ? Math.floor(r() * 256) : mode === 1 ? x * 6 : mode === 2 ? y * 6 : (x * y) & 255;
        data[i + 1] = (x + y * 3) & 255;
        data[i + 2] = mode === 3 ? Math.floor(r() * 16) : 128;
        data[i + 3] = 255 - x;
      }
    }
    const png = encodePNG({ width: w, height: h, data });
    expect(new Set(filterTypes(png, w, h)).size).toBeGreaterThan(1);
    expect(Buffer.from(decodePNG(png).data).equals(Buffer.from(data))).toBe(true);
  });
});

describe('decodePNG errors', () => {
  const good = encodePNG(randomImage(8, 8, 42));

  it('rejects a bad signature', () => {
    expect(() => decodePNG(new Uint8Array([1, 2, 3]))).toThrow(/signature/);
    const bad = good.slice();
    bad[1] = 0;
    expect(() => decodePNG(bad)).toThrow(/signature/);
  });

  it('rejects CRC mismatches', () => {
    const bad = good.slice();
    bad[8 + 8 + 2] ^= 0xff; // inside IHDR data
    expect(() => decodePNG(bad)).toThrow(/CRC mismatch in chunk "IHDR"/);
  });

  it('rejects truncated files', () => {
    expect(() => decodePNG(good.subarray(0, good.length - 20))).toThrow(/truncated|IEND/);
    expect(() => decodePNG(good.subarray(0, good.length - 12))).toThrow(/missing IEND/);
    expect(() => decodePNG(good.subarray(0, 8))).toThrow(/IHDR/);
  });

  it('rejects invalid headers', () => {
    const png = (depth: number, colorType: number) =>
      concat([
        SIG,
        pngChunk('IHDR', Uint8Array.from([...u32(1), ...u32(1), depth, colorType, 0, 0, 0])),
        pngChunk('IEND', new Uint8Array(0)),
      ]);
    expect(() => decodePNG(png(3, 0))).toThrow(/bit depth 3/);
    expect(() => decodePNG(png(8, 5))).toThrow(/color type 5/);
    expect(() => decodePNG(png(16, 3))).toThrow(/bit depth 16/);
  });

  it('rejects corrupt zlib data and short image data', () => {
    const ihdr = pngChunk('IHDR', Uint8Array.from([...u32(4), ...u32(4), 8, 6, 0, 0, 0]));
    const garbage = concat([
      SIG,
      ihdr,
      pngChunk('IDAT', Uint8Array.from([1, 2, 3, 4, 5])),
      pngChunk('IEND', new Uint8Array(0)),
    ]);
    expect(() => decodePNG(garbage)).toThrow(/corrupt image data/);
    const short = concat([
      SIG,
      ihdr,
      pngChunk('IDAT', deflateSync(new Uint8Array(10))),
      pngChunk('IEND', new Uint8Array(0)),
    ]);
    expect(() => decodePNG(short)).toThrow(/truncated/);
  });

  it('bounds decompression by the declared image size (zlib bombs) but tolerates a small overrun', () => {
    const ihdr = pngChunk('IHDR', Uint8Array.from([...u32(1), ...u32(1), 8, 6, 0, 0, 0]));
    const bomb = concat([
      SIG,
      ihdr,
      pngChunk('IDAT', deflateSync(new Uint8Array(4 << 20))),
      pngChunk('IEND', new Uint8Array(0)),
    ]);
    expect(() => decodePNG(bomb)).toThrow(/inflates beyond/);
    // One stray extra scanline after the 1x1 image still decodes.
    const overrun = concat([
      SIG,
      ihdr,
      pngChunk('IDAT', deflateSync(Uint8Array.from([0, 1, 2, 3, 4, 0, 9, 9, 9, 9]))),
      pngChunk('IEND', new Uint8Array(0)),
    ]);
    expect(pixelsOf(decodePNG(overrun))).toEqual([[1, 2, 3, 4]]);
  });

  it('rejects bad filter types, missing palettes and out-of-range indices', () => {
    const ihdr = pngChunk('IHDR', Uint8Array.from([...u32(1), ...u32(1), 8, 0, 0, 0, 0]));
    const badFilter = concat([
      SIG,
      ihdr,
      pngChunk('IDAT', deflateSync(Uint8Array.from([9, 0]))),
      pngChunk('IEND', new Uint8Array(0)),
    ]);
    expect(() => decodePNG(badFilter)).toThrow(/filter type 9/);

    const indexed = pngChunk('IHDR', Uint8Array.from([...u32(1), ...u32(1), 8, 3, 0, 0, 0]));
    const noPalette = concat([
      SIG,
      indexed,
      pngChunk('IDAT', deflateSync(Uint8Array.from([0, 0]))),
      pngChunk('IEND', new Uint8Array(0)),
    ]);
    expect(() => decodePNG(noPalette)).toThrow(/PLTE/);

    const outOfRange = buildPNG({ width: 1, height: 1, depth: 8, colorType: 3, pixels: [[[5]]], plte: [1, 2, 3] });
    expect(() => decodePNG(outOfRange)).toThrow(/palette index 5/);
  });

  it('rejects unknown critical chunks', () => {
    const png = buildPNG({
      width: 1,
      height: 1,
      depth: 8,
      colorType: 0,
      pixels: [[[0]]],
      extraChunks: [pngChunk('ZZZZ', new Uint8Array(1))],
    });
    expect(() => decodePNG(png)).toThrow(/critical chunk "ZZZZ"/);
  });
});
