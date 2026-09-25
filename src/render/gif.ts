/**
 * Animated GIF89a encoder (pure TypeScript, browser-safe, deterministic).
 *
 * - One global palette shared by all frames (no palette flicker): exact when the animation uses at
 *   most 255 distinct colors, otherwise a count-weighted median cut down to 255 colors.
 * - Pixels with alpha < 128 map to a dedicated transparent index (unless `background` is given, in
 *   which case frames are composited onto it first).
 * - Variable-width LZW (3..12 bits) with a clear code when the table fills up.
 */
import type { ImageRGBA, RGBA } from '../core/types.js';
import { assertImage, toRGBA8 } from './image.js';

export interface GifOptions {
  /** Frames per second (default 10). Delays are distributed so the average rate is exact; ignored when delayCs is set. */
  fps?: number;
  /** Fixed per-frame delay in centiseconds (1/100 s). */
  delayCs?: number;
  /** Loop forever (default true). false plays once. */
  loop?: boolean;
  /** Composite frames onto this color first (straight RGBA 0..1). Without it, alpha < 128 becomes transparent. */
  background?: RGBA;
}

const MAX_COLORS = 255;
const TRANSPARENT = -1;
/** Browsers treat delays below 2cs as 10cs, so fps-derived delays never go below this. */
const MIN_DELAY_CS = 2;

export function encodeGIF(frames: ImageRGBA[], opts: GifOptions = {}): Uint8Array {
  if (frames.length === 0) throw new Error('encodeGIF: no frames');
  const { width, height } = frames[0];
  frames.forEach((f, i) => {
    assertImage(f, `encodeGIF: frame ${i}`);
    if (f.width !== width || f.height !== height) {
      throw new RangeError(`encodeGIF: frame ${i} is ${f.width}x${f.height}, expected ${width}x${height} like frame 0`);
    }
  });
  if (width < 1 || height < 1 || width > 0xffff || height > 0xffff) {
    throw new RangeError(`encodeGIF: size ${width}x${height} is outside 1..65535`);
  }
  const delays = frameDelays(frames.length, opts);

  const pixels = frames.map((f) => flatten(f, opts.background));
  const hist = new Map<number, number>();
  let transparent = false;
  for (const px of pixels) {
    for (let i = 0; i < px.length; i++) {
      const c = px[i];
      if (c === TRANSPARENT) transparent = true;
      else hist.set(c, (hist.get(c) ?? 0) + 1);
    }
  }
  const palette = quantize(hist, MAX_COLORS);
  const transparentIndex = transparent ? palette.length : -1;
  const used = palette.length + (transparent ? 1 : 0);
  let tableBits = 1;
  while (1 << tableBits < used) tableBits++;
  const mapper = new PaletteMapper(palette);

  const w = new ByteWriter();
  w.ascii('GIF89a');
  w.u16(width);
  w.u16(height);
  w.byte(0x80 | (7 << 4) | (tableBits - 1)); // global color table, 8-bit color resolution
  w.byte(transparent ? transparentIndex : 0); // background color index
  w.byte(0); // pixel aspect ratio: unspecified
  for (let i = 0; i < 1 << tableBits; i++) {
    const c = i < palette.length ? palette[i] : 0;
    w.byte((c >> 16) & 0xff);
    w.byte((c >> 8) & 0xff);
    w.byte(c & 0xff);
  }
  if (opts.loop ?? true) {
    w.bytes([0x21, 0xff, 0x0b]);
    w.ascii('NETSCAPE2.0');
    w.bytes([0x03, 0x01, 0x00, 0x00, 0x00]); // sub-block: loop count 0 = forever
  }
  const lzw = new LzwEncoder(Math.max(2, tableBits));
  const indices = new Uint8Array(width * height);
  // Full-frame images: "restore to background" keeps transparent pixels from showing the previous frame.
  const disposal = transparent ? 2 : 1;
  pixels.forEach((px, f) => {
    for (let i = 0; i < px.length; i++) indices[i] = px[i] === TRANSPARENT ? transparentIndex : mapper.index(px[i]);
    w.bytes([0x21, 0xf9, 0x04, (disposal << 2) | (transparent ? 1 : 0)]); // graphic control extension
    w.u16(delays[f]);
    w.byte(transparent ? transparentIndex : 0);
    w.byte(0);
    w.byte(0x2c); // image descriptor
    w.u16(0);
    w.u16(0);
    w.u16(width);
    w.u16(height);
    w.byte(0); // no local color table, not interlaced
    lzw.encode(indices, w);
  });
  w.byte(0x3b); // trailer
  return w.result();
}

function frameDelays(count: number, opts: GifOptions): number[] {
  if (opts.delayCs !== undefined) {
    if (!Number.isFinite(opts.delayCs) || opts.delayCs < 0) {
      throw new RangeError(`encodeGIF: invalid delayCs ${opts.delayCs}`);
    }
    return new Array<number>(count).fill(Math.min(0xffff, Math.round(opts.delayCs)));
  }
  const fps = opts.fps ?? 10;
  if (!(fps > 0) || !Number.isFinite(fps)) throw new RangeError(`encodeGIF: fps must be a positive number, got ${fps}`);
  // Accumulate in exact time so e.g. 30 fps alternates 3/3/4 cs instead of drifting.
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const d = Math.round(((i + 1) * 100) / fps) - Math.round((i * 100) / fps);
    out.push(Math.min(0xffff, Math.max(MIN_DELAY_CS, d)));
  }
  return out;
}

/** Per-pixel 0xRRGGBB, or TRANSPARENT for alpha < 128 (after optional compositing onto `bg`). */
function flatten(img: ImageRGBA, bg: RGBA | undefined): Int32Array {
  const n = img.width * img.height;
  const out = new Int32Array(n);
  const d = img.data;
  const [br, bgG, bb, ba8] = bg ? toRGBA8(bg) : [0, 0, 0, 0];
  const ba = ba8 / 255;
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    let r = d[i];
    let g = d[i + 1];
    let b = d[i + 2];
    let a8 = d[i + 3];
    if (bg && a8 < 255) {
      const a = a8 / 255;
      const keep = ba * (1 - a);
      const oa = a + keep;
      if (oa > 0) {
        r = Math.round((r * a + br * keep) / oa);
        g = Math.round((g * a + bgG * keep) / oa);
        b = Math.round((b * a + bb * keep) / oa);
      }
      a8 = Math.round(oa * 255);
    }
    out[p] = a8 < 128 ? TRANSPARENT : (r << 16) | (g << 8) | b;
  }
  return out;
}

// ------------------------------------------------------------------------------------ palette

interface Box {
  start: number;
  end: number;
  count: number;
  /** Channel shift (16 = red, 8 = green, 0 = blue) of the widest axis, and its extent. */
  axis: number;
  range: number;
}

/**
 * Palette (0xRRGGBB values) of at most `maxColors` entries. Exact (sorted) when the histogram fits;
 * otherwise median cut: repeatedly split the box with the largest (range x pixel count) at the
 * count-weighted median of its widest channel, and use each box's weighted mean color.
 */
function quantize(hist: Map<number, number>, maxColors: number): number[] {
  const colors = Int32Array.from(hist.keys()).sort();
  if (colors.length <= maxColors) return Array.from(colors);
  const counts = new Float64Array(colors.length);
  colors.forEach((c, i) => (counts[i] = hist.get(c)!));
  const order = Int32Array.from(colors.keys());

  const makeBox = (start: number, end: number): Box => {
    const lo = [255, 255, 255];
    const hi = [0, 0, 0];
    let count = 0;
    for (let k = start; k < end; k++) {
      const c = colors[order[k]];
      count += counts[order[k]];
      for (let ch = 0; ch < 3; ch++) {
        const v = (c >> (16 - ch * 8)) & 0xff;
        if (v < lo[ch]) lo[ch] = v;
        if (v > hi[ch]) hi[ch] = v;
      }
    }
    let best = 0;
    for (let ch = 1; ch < 3; ch++) if (hi[ch] - lo[ch] > hi[best] - lo[best]) best = ch;
    return { start, end, count, axis: 16 - best * 8, range: hi[best] - lo[best] };
  };

  const boxes = [makeBox(0, colors.length)];
  while (boxes.length < maxColors) {
    let pick = -1;
    let score = 0;
    boxes.forEach((b, i) => {
      const s = b.range * b.count;
      if (b.end - b.start > 1 && s > score) {
        pick = i;
        score = s;
      }
    });
    if (pick < 0) break;
    const box = boxes[pick];
    const shift = box.axis;
    order
      .subarray(box.start, box.end)
      .sort((a, b) => ((colors[a] >> shift) & 0xff) - ((colors[b] >> shift) & 0xff) || colors[a] - colors[b]);
    let acc = 0;
    let cut = box.end - 1;
    for (let k = box.start; k < box.end - 1; k++) {
      acc += counts[order[k]];
      if (acc >= box.count / 2) {
        cut = k + 1;
        break;
      }
    }
    boxes.splice(pick, 1, makeBox(box.start, cut), makeBox(cut, box.end));
  }
  return boxes.map((b) => {
    let r = 0;
    let g = 0;
    let bl = 0;
    for (let k = b.start; k < b.end; k++) {
      const c = colors[order[k]];
      const n = counts[order[k]];
      r += ((c >> 16) & 0xff) * n;
      g += ((c >> 8) & 0xff) * n;
      bl += (c & 0xff) * n;
    }
    return (Math.round(r / b.count) << 16) | (Math.round(g / b.count) << 8) | Math.round(bl / b.count);
  });
}

/** Nearest palette entry (squared RGB distance, lowest index on ties), memoized per color. */
class PaletteMapper {
  private readonly cache = new Map<number, number>();
  constructor(private readonly palette: number[]) {}

  index(c: number): number {
    const hit = this.cache.get(c);
    if (hit !== undefined) return hit;
    const r = (c >> 16) & 0xff;
    const g = (c >> 8) & 0xff;
    const b = c & 0xff;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < this.palette.length; i++) {
      const p = this.palette[i];
      const dr = ((p >> 16) & 0xff) - r;
      const dg = ((p >> 8) & 0xff) - g;
      const db = (p & 0xff) - b;
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) {
        bestD = d;
        best = i;
        if (d === 0) break;
      }
    }
    this.cache.set(c, best);
    return best;
  }
}

// ------------------------------------------------------------------------------------ LZW

const MAX_CODE = 4096;
/** Generation counter limit so that (generation * 4096 + code) fits in a Uint32 entry. */
const MAX_GENERATION = 0xfffff;

/**
 * GIF LZW encoder. The string table is a flat (prefix code x pixel index) array whose entries are
 * tagged with a generation number, so a clear code resets the table in O(1).
 */
class LzwEncoder {
  private readonly table = new Uint32Array(MAX_CODE * 256);
  private generation = 0;

  constructor(private readonly minCodeSize: number) {}

  private reset(): number {
    if (++this.generation > MAX_GENERATION) {
      this.table.fill(0);
      this.generation = 1;
    }
    return this.generation;
  }

  /** Write the LZW minimum code size byte, the data sub-blocks and the block terminator. */
  encode(indices: Uint8Array, w: ByteWriter): void {
    const min = this.minCodeSize;
    const clear = 1 << min;
    const eoi = clear + 1;
    const table = this.table;
    const out = new BitPacker(w);
    w.byte(min);
    let size = min + 1;
    let next = eoi + 1;
    let gen = this.reset();
    out.write(clear, size);
    let prefix = indices[0];
    for (let i = 1; i < indices.length; i++) {
      const k = indices[i];
      const key = prefix * 256 + k;
      const entry = table[key];
      if (Math.floor(entry / MAX_CODE) === gen) {
        prefix = entry % MAX_CODE;
        continue;
      }
      out.write(prefix, size);
      if (next === MAX_CODE) {
        out.write(clear, size);
        gen = this.reset();
        size = min + 1;
        next = eoi + 1;
      } else {
        // The decoder widens its codes once its table (one entry behind ours) reaches 2^size.
        if (next >= 1 << size) size++;
        table[key] = gen * MAX_CODE + next++;
      }
      prefix = k;
    }
    out.write(prefix, size);
    // The decoder adds one more entry after reading the final code, which can widen the EOI code.
    if (next >= 1 << size && size < 12) size++;
    out.write(eoi, size);
    out.flush();
    w.byte(0); // block terminator
  }
}

/** Packs variable-width codes LSB-first into 255-byte data sub-blocks. */
class BitPacker {
  private acc = 0;
  private bits = 0;
  private readonly block = new Uint8Array(255);
  private fill = 0;

  constructor(private readonly w: ByteWriter) {}

  write(code: number, size: number): void {
    this.acc |= code << this.bits;
    this.bits += size;
    while (this.bits >= 8) {
      this.push(this.acc & 0xff);
      this.acc >>>= 8;
      this.bits -= 8;
    }
  }

  flush(): void {
    if (this.bits > 0) this.push(this.acc & 0xff);
    this.acc = 0;
    this.bits = 0;
    if (this.fill > 0) this.emitBlock();
  }

  private push(byte: number): void {
    this.block[this.fill++] = byte;
    if (this.fill === 255) this.emitBlock();
  }

  private emitBlock(): void {
    this.w.byte(this.fill);
    this.w.bytes(this.block.subarray(0, this.fill));
    this.fill = 0;
  }
}

/** Growable byte buffer. */
class ByteWriter {
  private buf = new Uint8Array(1 << 16);
  private len = 0;

  private ensure(extra: number): void {
    if (this.len + extra <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + extra) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  byte(v: number): void {
    this.ensure(1);
    this.buf[this.len++] = v;
  }

  u16(v: number): void {
    this.ensure(2);
    this.buf[this.len++] = v & 0xff;
    this.buf[this.len++] = (v >> 8) & 0xff;
  }

  bytes(src: ArrayLike<number>): void {
    this.ensure(src.length);
    for (let i = 0; i < src.length; i++) this.buf[this.len++] = src[i];
  }

  ascii(s: string): void {
    this.ensure(s.length);
    for (let i = 0; i < s.length; i++) this.buf[this.len++] = s.charCodeAt(i);
  }

  result(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}
