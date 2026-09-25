import { describe, expect, it } from 'vitest';
import { encodeGIF } from '../gif.js';
import type { ImageRGBA, RGBA } from '../../core/types.js';

interface GifFrame {
  delay: number;
  disposal: number;
  transparentIndex: number | null;
  indices: number[];
}

interface ParsedGif {
  width: number;
  height: number;
  palette: number[][];
  backgroundIndex: number;
  loop: number | null;
  frames: GifFrame[];
}

/** Minimal GIF LZW decoder (independent of the encoder). Throws on invalid codes or a missing EOI. */
function lzwDecode(data: Uint8Array, minCodeSize: number, pixelCount: number): number[] {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let size = minCodeSize + 1;
  let dict: number[][] = [];
  const reset = () => {
    dict = Array.from({ length: clear }, (_, i) => [i]);
    dict.push([], []); // clear, eoi placeholders
    size = minCodeSize + 1;
  };
  reset();
  let bitPos = 0;
  const read = (): number => {
    let code = 0;
    for (let i = 0; i < size; i++, bitPos++) {
      if (bitPos >> 3 >= data.length) throw new Error('LZW: ran out of data before EOI');
      code |= ((data[bitPos >> 3] >> (bitPos & 7)) & 1) << i;
    }
    return code;
  };
  const out: number[] = [];
  let prev: number[] | null = null;
  for (;;) {
    const code = read();
    if (code === clear) {
      reset();
      prev = null;
      continue;
    }
    if (code === eoi) break;
    let entry: number[];
    if (code < dict.length && code !== clear && code !== eoi) entry = dict[code];
    else if (code === dict.length && prev) entry = [...prev, prev[0]];
    else throw new Error(`LZW: invalid code ${code} (table size ${dict.length})`);
    out.push(...entry);
    if (prev && dict.length < 4096) dict.push([...prev, entry[0]]);
    prev = entry;
    if (dict.length >= 1 << size && size < 12) size++;
  }
  // Only zero padding bits may follow the EOI code.
  expect(Math.ceil(bitPos / 8)).toBe(data.length);
  expect(out.length).toBe(pixelCount);
  return out;
}

function parseGif(b: Uint8Array): ParsedGif {
  let p = 0;
  const u8 = () => b[p++];
  const u16 = () => {
    const v = b[p] | (b[p + 1] << 8);
    p += 2;
    return v;
  };
  const ascii = (n: number) => {
    const s = String.fromCharCode(...b.subarray(p, p + n));
    p += n;
    return s;
  };
  const subBlocks = (): Uint8Array => {
    const parts: number[] = [];
    for (let n = u8(); n !== 0; n = u8()) {
      parts.push(...b.subarray(p, p + n));
      p += n;
    }
    return Uint8Array.from(parts);
  };
  expect(ascii(6)).toBe('GIF89a');
  const width = u16();
  const height = u16();
  const packed = u8();
  expect(packed & 0x80).toBe(0x80);
  const tableSize = 1 << ((packed & 7) + 1);
  const backgroundIndex = u8();
  u8();
  const palette: number[][] = [];
  for (let i = 0; i < tableSize; i++) palette.push([u8(), u8(), u8()]);
  let loop: number | null = null;
  const frames: GifFrame[] = [];
  let gce = { delay: 0, disposal: 0, transparentIndex: null as number | null };
  for (;;) {
    const intro = u8();
    if (intro === 0x3b) break;
    if (intro === 0x21) {
      const label = u8();
      if (label === 0xf9) {
        expect(u8()).toBe(4);
        const flags = u8();
        const delay = u16();
        const ti = u8();
        expect(u8()).toBe(0);
        gce = { delay, disposal: (flags >> 2) & 7, transparentIndex: flags & 1 ? ti : null };
      } else if (label === 0xff) {
        expect(u8()).toBe(11);
        expect(ascii(11)).toBe('NETSCAPE2.0');
        const data = subBlocks();
        expect(data[0]).toBe(1);
        loop = data[1] | (data[2] << 8);
      } else {
        subBlocks();
      }
      continue;
    }
    expect(intro).toBe(0x2c);
    expect([u16(), u16(), u16(), u16()]).toEqual([0, 0, width, height]);
    expect(u8()).toBe(0);
    const minCodeSize = u8();
    const indices = lzwDecode(subBlocks(), minCodeSize, width * height);
    frames.push({ ...gce, indices });
  }
  expect(p).toBe(b.length);
  return { width, height, palette, backgroundIndex, loop, frames };
}

function image(width: number, height: number, fn: (x: number, y: number) => number[]): ImageRGBA {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(fn(x, y), (y * width + x) * 4);
  return { width, height, data };
}

/** Frame pixels as [r,g,b] (or null for transparent) via the decoded palette. */
function colorsOf(gif: ParsedGif, f: number): Array<number[] | null> {
  const fr = gif.frames[f];
  return fr.indices.map((i) => (i === fr.transparentIndex ? null : gif.palette[i]));
}

describe('encodeGIF', () => {
  const colors = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [250, 200, 10],
  ];
  const frames = [0, 1, 2].map((f) =>
    image(16, 8, (x, y) => [...colors[(x + y + f) % 4], x === f && y === 0 ? 0 : 255]),
  );

  it('writes a valid GIF89a with header, loop extension, frames and trailer', () => {
    const bytes = encodeGIF(frames, { fps: 10 });
    expect(String.fromCharCode(...bytes.subarray(0, 6))).toBe('GIF89a');
    expect(bytes[bytes.length - 1]).toBe(0x3b);
    const gif = parseGif(bytes);
    expect([gif.width, gif.height]).toEqual([16, 8]);
    expect(gif.loop).toBe(0);
    expect(gif.frames.length).toBe(3);
    expect(gif.frames.map((f) => f.delay)).toEqual([10, 10, 10]);
  });

  it('reproduces pixels exactly when there are few colors, with transparency', () => {
    const gif = parseGif(encodeGIF(frames));
    frames.forEach((frame, f) => {
      const ti = gif.frames[f].transparentIndex;
      expect(ti).not.toBeNull();
      expect(gif.frames[f].disposal).toBe(2);
      expect(gif.backgroundIndex).toBe(ti);
      const got = colorsOf(gif, f);
      for (let i = 0; i < 16 * 8; i++) {
        const src = Array.from(frame.data.subarray(i * 4, i * 4 + 4));
        expect(got[i]).toEqual(src[3] < 128 ? null : src.slice(0, 3));
      }
    });
  });

  it('composites onto a background instead of using transparency', () => {
    const img = image(2, 1, (x) => (x === 0 ? [255, 255, 255, 0] : [255, 0, 0, 128]));
    const bg: RGBA = [0, 0, 1, 1];
    const gif = parseGif(encodeGIF([img], { background: bg }));
    expect(gif.frames[0].transparentIndex).toBeNull();
    expect(gif.frames[0].disposal).toBe(1);
    expect(colorsOf(gif, 0)).toEqual([
      [0, 0, 255],
      [128, 0, 127],
    ]);
  });

  it('distributes fps delays exactly and honours delayCs and loop', () => {
    const one = image(1, 1, () => [1, 2, 3, 255]);
    const six = Array.from({ length: 6 }, () => one);
    expect(parseGif(encodeGIF(six, { fps: 30 })).frames.map((f) => f.delay)).toEqual([3, 4, 3, 3, 4, 3]);
    expect(parseGif(encodeGIF(six, { fps: 60 })).frames.every((f) => f.delay >= 2)).toBe(true);
    expect(parseGif(encodeGIF(six, { fps: 30, delayCs: 7 })).frames.map((f) => f.delay)).toEqual([7, 7, 7, 7, 7, 7]);
    const once = parseGif(encodeGIF([one], { loop: false }));
    expect(once.loop).toBeNull();
    expect(colorsOf(once, 0)).toEqual([[1, 2, 3]]);
  });

  it('keeps 255 distinct colors exact and exercises code growth and clear codes', () => {
    // Pseudo-random indices over 255 colors: long LZW streams that fill the 4096-entry table repeatedly.
    let s = 12345;
    const next = () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0);
    const pal = Array.from({ length: 255 }, (_, i) => [(i * 53) & 255, (i * 97) & 255, i]);
    const frame = image(160, 120, () => [...pal[(next() >>> 8) % 255], 255]);
    const gif = parseGif(encodeGIF([frame]));
    expect(gif.frames[0].transparentIndex).toBeNull();
    const got = colorsOf(gif, 0);
    for (let i = 0; i < 160 * 120; i++) expect(got[i]).toEqual(Array.from(frame.data.subarray(i * 4, i * 4 + 3)));
  });

  it('encodes every stream length, including code-width changes right before the EOI code', () => {
    // Lengths 1..600 over 2, 4 and 200 colors end the stream at every code-width boundary.
    let s = 7;
    const next = () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0) >>> 8;
    for (const n of [2, 4, 200]) {
      const pal = Array.from({ length: n }, (_, i) => [(i * 3) & 255, (i * 7) & 255, i]);
      for (let len = 1; len <= 600; len++) {
        const ids = Array.from({ length: len }, () => next() % n);
        const gif = parseGif(encodeGIF([image(len, 1, (x) => [...pal[ids[x]], 255])]));
        expect(colorsOf(gif, 0), `${n} colors, length ${len}`).toEqual(ids.map((i) => pal[i]));
      }
    }
  });

  it('quantizes many colors to at most 255 close palette entries', () => {
    const frame = image(128, 128, (x, y) => [x * 2, y * 2, (x + y) & 255, 255]);
    const gif = parseGif(encodeGIF([frame, image(128, 128, (x, y) => [255 - x, y, 128, 255])]));
    const used = new Set(gif.frames.flatMap((f) => f.indices));
    expect(used.size).toBeLessThanOrEqual(255);
    expect(used.size).toBeGreaterThan(200);
    const got = colorsOf(gif, 0);
    let err = 0;
    for (let i = 0; i < 128 * 128; i++) {
      for (let c = 0; c < 3; c++) err += Math.abs(got[i]![c] - frame.data[i * 4 + c]);
    }
    expect(err / (128 * 128 * 3)).toBeLessThan(8);
  });

  it('handles a single pixel and a single color', () => {
    const gif = parseGif(encodeGIF([image(1, 1, () => [9, 8, 7, 255])]));
    expect(gif.palette.length).toBe(2);
    expect(colorsOf(gif, 0)).toEqual([[9, 8, 7]]);
    const flat = parseGif(encodeGIF([image(300, 200, () => [0, 0, 0, 0])]));
    expect(colorsOf(flat, 0).every((c) => c === null)).toBe(true);
  });

  it('is deterministic', () => {
    const a = encodeGIF(frames, { fps: 12 });
    const b = encodeGIF(frames, { fps: 12 });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('rejects bad input', () => {
    expect(() => encodeGIF([])).toThrow(/no frames/);
    expect(() => encodeGIF([image(2, 2, () => [0, 0, 0, 255]), image(3, 2, () => [0, 0, 0, 255])])).toThrow(
      /frame 1 is 3x2/,
    );
    expect(() => encodeGIF(frames, { fps: 0 })).toThrow(/fps/);
  });
});
