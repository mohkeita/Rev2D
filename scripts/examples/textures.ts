/**
 * Procedural textures for examples/textured: paper-cutout koinobori (carp streamers) in one atlas and
 * a paper pinwheel. Drawn with a tiny supersampled shape rasterizer into RGBA buffers. Deterministic:
 * the same code always yields identical pixels (scripts/gen-textures.ts writes them as PNG).
 *
 *   koiAtlas()  256x192: red koi at y 0..96, blue koi at y 96..192
 *   pinwheel()  128x128
 */
import type { ImageRGBA } from '../../src/core/types.js';

type RGB = [number, number, number];
type Inside = (x: number, y: number) => boolean;
type Paint = RGB | ((x: number, y: number) => RGB);

const SS = 4;

/** Premultiplied float canvas with "over" compositing of supersampled shapes. */
class Canvas {
  readonly data: Float32Array;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.data = new Float32Array(width * height * 4);
  }

  /** Fill every pixel of [x0, x1) x [y0, y1) covered by `inside` (SS x SS samples per pixel). */
  fill(inside: Inside, paint: Paint, alpha = 1, box: [number, number, number, number] = [0, 0, this.width, this.height]): void {
    const [bx0, by0, bx1, by1] = box.map(Math.floor);
    for (let y = Math.max(0, by0); y < Math.min(this.height, by1 + 1); y++) {
      for (let x = Math.max(0, bx0); x < Math.min(this.width, bx1 + 1); x++) {
        // Coverage and (for function paints) the color are averaged over the covered sub-samples.
        let hits = 0;
        const c: RGB = [0, 0, 0];
        for (let sy = 0; sy < SS; sy++) {
          for (let sx = 0; sx < SS; sx++) {
            const px = x + (sx + 0.5) / SS;
            const py = y + (sy + 0.5) / SS;
            if (!inside(px, py)) continue;
            hits++;
            if (typeof paint === 'function') {
              const q = paint(px, py);
              c[0] += q[0];
              c[1] += q[1];
              c[2] += q[2];
            }
          }
        }
        if (!hits) continue;
        const a = (alpha * hits) / (SS * SS);
        for (let k = 0; k < 3; k++) c[k] = typeof paint === 'function' ? c[k] / hits : paint[k];
        const o = (y * this.width + x) * 4;
        const k = 1 - a;
        this.data[o] = c[0] * a + this.data[o] * k;
        this.data[o + 1] = c[1] * a + this.data[o + 1] * k;
        this.data[o + 2] = c[2] * a + this.data[o + 2] * k;
        this.data[o + 3] = a + this.data[o + 3] * k;
      }
    }
  }

  /** Paper grain: modulate brightness with smooth value noise (alpha untouched). */
  grain(seed: number, strength: number): void {
    const noise = valueNoise(seed);
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const o = (y * this.width + x) * 4;
        const n = 1 + strength * (noise(x / 3, y / 3) * 0.6 + noise(x / 11, y / 11) * 0.4 - 0.5);
        for (let k = 0; k < 3; k++) this.data[o + k] = Math.min(this.data[o + 3], this.data[o + k] * n);
      }
    }
  }

  toImage(): ImageRGBA {
    const out = new Uint8ClampedArray(this.width * this.height * 4);
    for (let i = 0; i < out.length; i += 4) {
      const a = this.data[i + 3];
      if (a <= 0) continue;
      out[i] = Math.round((this.data[i] / a) * 255);
      out[i + 1] = Math.round((this.data[i + 1] / a) * 255);
      out[i + 2] = Math.round((this.data[i + 2] / a) * 255);
      out[i + 3] = Math.round(a * 255);
    }
    return { width: this.width, height: this.height, data: out };
  }
}

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth 2D value noise in [0, 1] on a 64x64 lattice (wraps). */
function valueNoise(seed: number): (x: number, y: number) => number {
  const rand = rng(seed);
  const grid = Float64Array.from({ length: 64 * 64 }, rand);
  const at = (i: number, j: number) => grid[(j & 63) * 64 + (i & 63)];
  const smooth = (t: number) => t * t * (3 - 2 * t);
  return (x, y) => {
    const i = Math.floor(x);
    const j = Math.floor(y);
    const fx = smooth(x - i);
    const fy = smooth(y - j);
    const a = at(i, j) + (at(i + 1, j) - at(i, j)) * fx;
    const b = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * fx;
    return a + (b - a) * fy;
  };
}

const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const disk = (cx: number, cy: number, rad: number): Inside => (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= rad * rad;
const ring = (cx: number, cy: number, r0: number, r1: number): Inside => (x, y) => {
  const d2 = (x - cx) ** 2 + (y - cy) ** 2;
  return d2 >= r0 * r0 && d2 <= r1 * r1;
};

// ---------------------------------------------------------------------------------------------- koi

interface KoiPalette {
  body: string;
  belly: string;
  scale: string;
  scaleLight: string;
  tail: string;
}

/** Half-height of the streamer body at x (0 = mouth, 256 = tail tip), before the tail fork. */
function bodyHalf(x: number): number {
  if (x < 28) return 30 + 6 * Math.sin((x / 28) * (Math.PI / 2));
  if (x < 196) return 36 - 15 * ((x - 28) / 168) ** 1.3;
  return 21;
}

/** Koi silhouette in texture-local coordinates (box 256 x 96, axis at y = 48). */
function koiInside(x: number, y: number, grow = 0): boolean {
  const dy = Math.abs(y - 48);
  if (x < 4 - grow || x > 252 + grow) return false;
  if (x <= 196) return dy <= bodyHalf(x) + grow;
  // Forked tail: lobes fan out; the center is notched back to x = 226.
  const t = (x - 196) / 56;
  const outer = 21 + 21 * t + grow;
  if (dy > outer) return false;
  const reach = 226 + 26 * Math.min(1, dy / Math.max(1, outer - grow));
  return x <= reach + grow;
}

function drawKoi(cv: Canvas, oy: number, pal: KoiPalette): void {
  const inBox = (f: Inside): Inside => (x, y) => f(x, y - oy);
  const box: [number, number, number, number] = [0, oy, 256, oy + 96];
  // Paper edge: the silhouette grown by 2 px in cream, then a soft shadow line inside it.
  cv.fill(inBox((x, y) => koiInside(x, y, 2.2)), hex('#fff4e2'), 1, box);
  const body = hex(pal.body);
  const belly = hex(pal.belly);
  cv.fill(inBox((x, y) => koiInside(x, y)), (_x, y) => mix(body, belly, Math.max(0, Math.min(1, (y - oy - 52) / 26))), 1, box);
  // Scales: rows of arcs opening toward the head, lighter inside.
  const scaleLight = hex(pal.scaleLight);
  const scale = hex(pal.scale);
  for (let j = 0; j < 5; j++) {
    for (let i = 0; i < 11; i++) {
      const sx = 70 + i * 12 + (j % 2) * 6;
      const sy = 48 + (j - 2) * 11;
      if (Math.abs(sy - 48) > bodyHalf(sx) - 7) continue;
      const inside = inBox((x, y) => koiInside(x, y) && x >= sx - 1 && (x - sx) ** 2 + (y - sy) ** 2 <= 36);
      cv.fill(inside, scaleLight, 0.55, [sx - 8, oy + sy - 8, sx + 8, oy + sy + 8]);
      const arc = inBox((x, y) => koiInside(x, y) && x >= sx && ring(sx, sy, 5.4, 7)(x, y));
      cv.fill(arc, scale, 0.9, [sx - 8, oy + sy - 8, sx + 8, oy + sy + 8]);
    }
  }
  // Gill arc.
  cv.fill(inBox((x, y) => koiInside(x, y) && x > 48 && ring(22, 48, 30, 32.5)(x, y)), scale, 0.9, box);
  // Tail stripes.
  const tail = hex(pal.tail);
  for (const k of [-0.6, -0.2, 0.2, 0.6]) {
    cv.fill(inBox((x, y) => koiInside(x, y) && x > 204 && Math.abs(y - 48 - k * (x - 196) * 0.75) < 1.2), tail, 0.8, box);
  }
  // Mouth ring and eye.
  cv.fill(inBox((x, y) => koiInside(x, y) && x < 13 && Math.abs(y - 48) <= bodyHalf(x) - 1), hex('#f4c542'), 1, box);
  cv.fill(inBox((x, y) => koiInside(x, y) && x >= 10 && x < 13), hex('#b07a18'), 1, box);
  cv.fill(inBox(disk(36, 40, 12.5)), hex('#20160f'), 1, box);
  cv.fill(inBox(disk(36, 40, 10.5)), hex('#fffaf0'), 1, box);
  cv.fill(inBox(disk(37, 40, 7)), hex('#e0a526'), 1, box);
  cv.fill(inBox(disk(37.5, 40, 4)), hex('#15100b'), 1, box);
  cv.fill(inBox(disk(35, 37.5, 1.8)), hex('#ffffff'), 1, box);
}

export function koiAtlas(): ImageRGBA {
  const cv = new Canvas(256, 192);
  drawKoi(cv, 0, { body: '#d7362f', belly: '#f47c55', scale: '#8e1a1f', scaleLight: '#f8a07a', tail: '#8e1a1f' });
  drawKoi(cv, 96, { body: '#2f68c8', belly: '#6fb3ec', scale: '#173a78', scaleLight: '#9fd0f7', tail: '#173a78' });
  cv.grain(7, 0.12);
  return cv.toImage();
}

// ---------------------------------------------------------------------------------------------- pinwheel

export function pinwheel(): ImageRGBA {
  const cv = new Canvas(128, 128);
  const c = 64;
  const colors = ['#e8413c', '#f5c542', '#3b7dd8', '#43b36a'].map(hex);
  cv.fill(disk(c, c, 61), hex('#fff4e2'));
  cv.fill(disk(c, c, 58), (x, y) => {
    // Eight curved sectors: the angle is twisted with the radius for a pinwheel swirl.
    const a = Math.atan2(y - c, x - c) + Math.hypot(x - c, y - c) / 40;
    const k = Math.floor(((a / (2 * Math.PI)) * 8 + 16) % 8);
    const shade = 0.82 + 0.18 * (((a / (2 * Math.PI)) * 8 + 16) % 1);
    const base = colors[k % 4];
    return [base[0] * shade, base[1] * shade, base[2] * shade];
  });
  cv.fill(disk(c, c, 12), hex('#fff4e2'));
  cv.fill(disk(c, c, 9), hex('#d9a22a'));
  cv.fill(disk(c - 2, c - 2, 3), hex('#ffe9a8'));
  cv.grain(11, 0.1);
  return cv.toImage();
}
