/**
 * PNG codec. Encoder: RGBA8, per-row adaptive filter (minimum sum of absolute differences), zlib
 * deflate. Decoder: color types 0/2/3/4/6, bit depths 1/2/4/8/16, PLTE + tRNS, Adam7 interlace;
 * always returns straight-alpha RGBA8. Uses node:zlib (the only Node dependency of the renderer).
 */
import { deflateSync, inflateSync } from 'node:zlib';
import type { ImageRGBA } from '../core/types.js';
import { assertImage } from './image.js';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Refuse to allocate images above this many pixels (1 GiB of RGBA8). */
const MAX_PIXELS = 1 << 28;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (ISO 3309, as used by PNG) of bytes[start, end). */
export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function writeU32(out: Uint8Array, pos: number, v: number): void {
  out[pos] = v >>> 24;
  out[pos + 1] = (v >>> 16) & 0xff;
  out[pos + 2] = (v >>> 8) & 0xff;
  out[pos + 3] = v & 0xff;
}

function readU32(b: Uint8Array, pos: number): number {
  return ((b[pos] << 24) | (b[pos + 1] << 16) | (b[pos + 2] << 8) | b[pos + 3]) >>> 0;
}

/** Serialize one chunk: length, type, data, CRC(type + data). */
export function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  writeU32(out, 0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  writeU32(out, 8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// ------------------------------------------------------------------------------------ encoder

export function encodePNG(img: ImageRGBA): Uint8Array {
  assertImage(img, 'encodePNG');
  const { width, height, data } = img;
  if (width === 0 || height === 0) throw new RangeError(`encodePNG: PNG cannot be empty (${width}x${height})`);
  const stride = width * 4;
  const raw = new Uint8Array(height * (stride + 1));
  const candidates = [0, 1, 2, 3, 4].map(() => new Uint8Array(stride));
  const [none, sub, up, avg, pae] = candidates;
  const zero = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const row = data.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? data.subarray((y - 1) * stride, y * stride) : zero;
    const costs = [0, 0, 0, 0, 0];
    for (let i = 0; i < stride; i++) {
      const x = row[i];
      const a = i >= 4 ? row[i - 4] : 0;
      const b = prev[i];
      const c = i >= 4 ? prev[i - 4] : 0;
      none[i] = x;
      sub[i] = x - a;
      up[i] = x - b;
      avg[i] = x - ((a + b) >> 1);
      pae[i] = x - paeth(a, b, c);
      // Heuristic cost: bytes read as signed deviations from zero.
      costs[0] += none[i] < 128 ? none[i] : 256 - none[i];
      costs[1] += sub[i] < 128 ? sub[i] : 256 - sub[i];
      costs[2] += up[i] < 128 ? up[i] : 256 - up[i];
      costs[3] += avg[i] < 128 ? avg[i] : 256 - avg[i];
      costs[4] += pae[i] < 128 ? pae[i] : 256 - pae[i];
    }
    let best = 0;
    for (let f = 1; f < 5; f++) if (costs[f] < costs[best]) best = f;
    const pos = y * (stride + 1);
    raw[pos] = best;
    raw.set(candidates[best], pos + 1);
  }
  const ihdr = new Uint8Array(13);
  writeU32(ihdr, 0, width);
  writeU32(ihdr, 4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const idat = deflateSync(raw);
  return concat([
    Uint8Array.from(SIGNATURE),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', new Uint8Array(idat.buffer, idat.byteOffset, idat.byteLength)),
    pngChunk('IEND', new Uint8Array(0)),
  ]);
}

// ------------------------------------------------------------------------------------ decoder

interface Header {
  width: number;
  height: number;
  depth: number;
  colorType: number;
  interlace: number;
  channels: number;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
/** Adam7 passes: [xStart, yStart, xStep, yStep]. */
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

function fail(msg: string): never {
  throw new Error(`PNG: ${msg}`);
}

function parseHeader(d: Uint8Array): Header {
  if (d.length !== 13) fail(`IHDR must be 13 bytes, got ${d.length}`);
  const width = readU32(d, 0);
  const height = readU32(d, 4);
  const [depth, colorType, compression, filter, interlace] = [d[8], d[9], d[10], d[11], d[12]];
  if (width === 0 || height === 0 || width > 0x7fffffff || height > 0x7fffffff) fail(`invalid size ${width}x${height}`);
  if (width * height > MAX_PIXELS) fail(`image too large (${width}x${height})`);
  const depths = DEPTHS[colorType];
  if (!depths) fail(`unsupported color type ${colorType}`);
  if (!depths.includes(depth)) {
    fail(`bit depth ${depth} is invalid for color type ${colorType} (allowed: ${depths.join(', ')})`);
  }
  if (compression !== 0) fail(`unknown compression method ${compression}`);
  if (filter !== 0) fail(`unknown filter method ${filter}`);
  if (interlace > 1) fail(`unknown interlace method ${interlace}`);
  return { width, height, depth, colorType, interlace, channels: CHANNELS[colorType] };
}

/** Undo the per-scanline filters of one (sub)image in place. Rows are (1 + rowBytes) bytes: filter type + data. */
function unfilter(buf: Uint8Array, offset: number, rows: number, rowBytes: number, bpp: number): void {
  for (let y = 0; y < rows; y++) {
    const start = offset + y * (rowBytes + 1);
    const type = buf[start];
    const cur = start + 1;
    const prev = y > 0 ? cur - (rowBytes + 1) : -1;
    switch (type) {
      case 0:
        break;
      case 1:
        for (let i = bpp; i < rowBytes; i++) buf[cur + i] = (buf[cur + i] + buf[cur + i - bpp]) & 0xff;
        break;
      case 2:
        if (prev >= 0) for (let i = 0; i < rowBytes; i++) buf[cur + i] = (buf[cur + i] + buf[prev + i]) & 0xff;
        break;
      case 3:
        for (let i = 0; i < rowBytes; i++) {
          const a = i >= bpp ? buf[cur + i - bpp] : 0;
          const b = prev >= 0 ? buf[prev + i] : 0;
          buf[cur + i] = (buf[cur + i] + ((a + b) >> 1)) & 0xff;
        }
        break;
      case 4:
        for (let i = 0; i < rowBytes; i++) {
          const a = i >= bpp ? buf[cur + i - bpp] : 0;
          const b = prev >= 0 ? buf[prev + i] : 0;
          const c = prev >= 0 && i >= bpp ? buf[prev + i - bpp] : 0;
          buf[cur + i] = (buf[cur + i] + paeth(a, b, c)) & 0xff;
        }
        break;
      default:
        fail(`invalid filter type ${type} on scanline ${y}`);
    }
  }
}

/** Transparency info from tRNS, in raw sample units. */
interface Transparency {
  /** Color key (gray: 1 value, rgb: 3 values). */
  key: number[] | null;
  /** Palette alphas. */
  alphas: Uint8Array | null;
}

function parseTransparency(h: Header, trns: Uint8Array | null, paletteSize: number): Transparency {
  if (!trns) return { key: null, alphas: null };
  if (h.colorType === 0) {
    if (trns.length < 2) fail('tRNS for grayscale must be 2 bytes');
    return { key: [(trns[0] << 8) | trns[1]], alphas: null };
  }
  if (h.colorType === 2) {
    if (trns.length < 6) fail('tRNS for truecolor must be 6 bytes');
    return { key: [(trns[0] << 8) | trns[1], (trns[2] << 8) | trns[3], (trns[4] << 8) | trns[5]], alphas: null };
  }
  if (h.colorType === 3) {
    if (trns.length > paletteSize) fail(`tRNS has ${trns.length} entries but the palette has ${paletteSize}`);
    return { key: null, alphas: trns };
  }
  return { key: null, alphas: null }; // tRNS is not allowed with an alpha channel; ignore it.
}

export function decodePNG(bytes: Uint8Array): ImageRGBA {
  if (bytes.length < 8 || SIGNATURE.some((v, i) => bytes[i] !== v)) fail('invalid signature (not a PNG file)');
  let header: Header | null = null;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let ended = false;
  let pos = 8;
  while (pos < bytes.length && !ended) {
    if (pos + 12 > bytes.length) fail(`truncated chunk header at byte ${pos}`);
    const len = readU32(bytes, pos);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    if (!/^[A-Za-z]{4}$/.test(type)) fail(`invalid chunk type at byte ${pos}`);
    if (len > 0x7fffffff || pos + 12 + len > bytes.length) {
      fail(`chunk "${type}" at byte ${pos} is truncated (length ${len})`);
    }
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    if (crc32(bytes, pos + 4, pos + 8 + len) !== readU32(bytes, pos + 8 + len)) {
      fail(`CRC mismatch in chunk "${type}" at byte ${pos}`);
    }
    pos += 12 + len;
    if (!header && type !== 'IHDR') fail(`first chunk must be IHDR, got "${type}"`);
    switch (type) {
      case 'IHDR':
        if (header) fail('duplicate IHDR chunk');
        header = parseHeader(data);
        break;
      case 'PLTE':
        if (len % 3 !== 0 || len === 0 || len > 768) fail(`invalid PLTE length ${len}`);
        palette = data;
        break;
      case 'tRNS':
        trns = data;
        break;
      case 'IDAT':
        idat.push(data);
        break;
      case 'IEND':
        ended = true;
        break;
      default:
        // Uppercase first letter (bit 5 clear) = critical chunk, which a decoder must not skip.
        if ((type.charCodeAt(0) & 0x20) === 0) fail(`unsupported critical chunk "${type}"`);
    }
  }
  if (!header) fail('missing IHDR chunk');
  if (!ended) fail('missing IEND chunk (file truncated?)');
  if (idat.length === 0) fail('missing IDAT chunk');
  if (header.colorType === 3 && !palette) fail('indexed image without PLTE chunk');

  // A valid stream inflates to exactly the size the header implies; allowing twice that (plus slack
  // for sloppy encoders) still stops a tiny file from inflating into gigabytes (zlib bomb).
  const expected = subImages(header).reduce((n, s) => n + s.rows * (s.rowBytes + 1), 0);
  const limit = expected * 2 + 1024;
  let raw: Uint8Array;
  try {
    const inflated = inflateSync(concat(idat), { maxOutputLength: limit });
    raw = new Uint8Array(inflated.buffer, inflated.byteOffset, inflated.byteLength);
  } catch (e) {
    if ((e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
      fail(`image data inflates beyond ${limit} bytes (a ${header.width}x${header.height} image needs ${expected})`);
    }
    fail(`corrupt image data (zlib: ${(e as Error).message})`);
  }
  return decodePixels(header, raw, palette, trns);
}

/** One (sub)image of the scanline stream: the whole image, or one non-empty Adam7 pass. */
interface SubImage {
  /** Placement: first pixel and step in the full image. */
  x0: number;
  y0: number;
  dx: number;
  dy: number;
  cols: number;
  rows: number;
  /** Bytes per scanline, excluding the filter-type byte. */
  rowBytes: number;
}

function subImages(h: Header): SubImage[] {
  const bitsPerPixel = h.channels * h.depth;
  const out: SubImage[] = [];
  for (const [x0, y0, dx, dy] of h.interlace ? ADAM7 : [[0, 0, 1, 1]]) {
    const cols = Math.ceil((h.width - x0) / dx);
    const rows = Math.ceil((h.height - y0) / dy);
    if (cols > 0 && rows > 0) out.push({ x0, y0, dx, dy, cols, rows, rowBytes: Math.ceil((cols * bitsPerPixel) / 8) });
  }
  return out;
}

function decodePixels(h: Header, raw: Uint8Array, palette: Uint8Array | null, trns: Uint8Array | null): ImageRGBA {
  const { width, height, depth, colorType, channels } = h;
  const paletteSize = palette ? palette.length / 3 : 0;
  const t = parseTransparency(h, trns, paletteSize);
  const out = new Uint8ClampedArray(width * height * 4);
  const bpp = Math.max(1, (channels * depth) >> 3);
  const maxSample = depth === 16 ? 65535 : (1 << depth) - 1;
  const to8 = (v: number): number => (depth === 8 ? v : Math.round((v * 255) / maxSample));
  let offset = 0;
  const px = [0, 0, 0, 0];
  for (const { x0, y0, dx, dy, cols: pw, rows: ph, rowBytes } of subImages(h)) {
    const need = ph * (rowBytes + 1);
    if (offset + need > raw.length) {
      fail(`image data truncated (have ${raw.length} bytes, need at least ${offset + need})`);
    }
    unfilter(raw, offset, ph, rowBytes, bpp);
    for (let row = 0; row < ph; row++) {
      const line = offset + row * (rowBytes + 1) + 1;
      const y = y0 + row * dy;
      for (let col = 0; col < pw; col++) {
        for (let ch = 0; ch < channels; ch++) px[ch] = readSample(raw, line, col * channels + ch, depth);
        const o = (y * width + x0 + col * dx) * 4;
        switch (colorType) {
          case 0: {
            const g = to8(px[0]);
            out[o] = out[o + 1] = out[o + 2] = g;
            out[o + 3] = t.key && px[0] === t.key[0] ? 0 : 255;
            break;
          }
          case 2:
            out[o] = to8(px[0]);
            out[o + 1] = to8(px[1]);
            out[o + 2] = to8(px[2]);
            out[o + 3] = t.key && px[0] === t.key[0] && px[1] === t.key[1] && px[2] === t.key[2] ? 0 : 255;
            break;
          case 3: {
            const idx = px[0];
            if (idx >= paletteSize) fail(`palette index ${idx} out of range (palette has ${paletteSize} entries)`);
            out[o] = palette![idx * 3];
            out[o + 1] = palette![idx * 3 + 1];
            out[o + 2] = palette![idx * 3 + 2];
            out[o + 3] = t.alphas && idx < t.alphas.length ? t.alphas[idx] : 255;
            break;
          }
          case 4: {
            const g = to8(px[0]);
            out[o] = out[o + 1] = out[o + 2] = g;
            out[o + 3] = to8(px[1]);
            break;
          }
          default:
            out[o] = to8(px[0]);
            out[o + 1] = to8(px[1]);
            out[o + 2] = to8(px[2]);
            out[o + 3] = to8(px[3]);
        }
      }
    }
    offset += need;
  }
  return { width, height, data: out };
}

/** Sample `index` of the scanline starting at `line`, at the given bit depth (MSB-first packing). */
function readSample(buf: Uint8Array, line: number, index: number, depth: number): number {
  if (depth === 8) return buf[line + index];
  if (depth === 16) return (buf[line + index * 2] << 8) | buf[line + index * 2 + 1];
  const bit = index * depth;
  return (buf[line + (bit >> 3)] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
}
