/** Builders shared by the image toolkit tests (small synthetic masks and images only). */
import type { ImageRGBA } from '../../../core/types.js';
import { createImage } from '../../../render/image.js';
import { createMask } from '../mask.js';
import type { Mask } from '../types.js';

/** A mask from rows of text: '#' = 1, '+' = 0.5, anything else = 0. */
export function maskFromRows(rows: string[]): Mask {
  const mask = createMask(rows[0].length, rows.length);
  rows.forEach((row, y) => {
    if (row.length !== mask.width) throw new Error(`row ${y} has length ${row.length}, expected ${mask.width}`);
    for (let x = 0; x < row.length; x++) mask.data[y * mask.width + x] = row[x] === '#' ? 1 : row[x] === '+' ? 0.5 : 0;
  });
  return mask;
}

/** The mask as rows of text: '#' for values >= 0.5, '.' otherwise. */
export function rowsOf(mask: Mask): string[] {
  const rows: string[] = [];
  for (let y = 0; y < mask.height; y++) {
    let row = '';
    for (let x = 0; x < mask.width; x++) row += mask.data[y * mask.width + x] >= 0.5 ? '#' : '.';
    rows.push(row);
  }
  return rows;
}

/** An image whose pixels come from a function returning [r, g, b] or [r, g, b, a] (0..255). */
export function imageFrom(width: number, height: number, pixel: (x: number, y: number) => number[]): ImageRGBA {
  const img = createImage(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = pixel(x, y);
      const i = (y * width + x) * 4;
      img.data[i] = Math.round(p[0]);
      img.data[i + 1] = Math.round(p[1]);
      img.data[i + 2] = Math.round(p[2]);
      img.data[i + 3] = p.length > 3 ? Math.round(p[3]) : 255;
    }
  }
  return img;
}

/** RGBA8 of pixel (x, y). */
export function px(img: ImageRGBA, x: number, y: number): number[] {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
}

/** Mask value at (x, y). */
export function at(mask: Mask, x: number, y: number): number {
  return mask.data[y * mask.width + x];
}

export function sum(values: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < values.length; i++) s += values[i];
  return s;
}

/** Smallest and largest value and whether any value is NaN (one assertion instead of one per pixel keeps tests fast). */
export function rangeOf(values: ArrayLike<number>): { min: number; max: number; nan: boolean } {
  let min = Infinity;
  let max = -Infinity;
  let nan = false;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isNaN(v)) nan = true;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max, nan };
}
