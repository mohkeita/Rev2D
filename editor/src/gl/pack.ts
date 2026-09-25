/**
 * Packs a frame's draw items (and the mask items they reference) into ONE interleaved vertex array
 * and ONE index array, so the renderer uploads two buffers per frame and issues one drawElements per
 * item. Pure (no GL), reuses its buffers between frames.
 */
import type { DrawItem } from '../../../src/core/index.js';
import { FLOATS_PER_VERTEX } from './shaders.js';

export interface PackedRange {
  /** First index (in indices, not bytes). */
  first: number;
  count: number;
}

export interface PackedFrame {
  /** Interleaved x, y, r, g, b, a, u, v (a view into the packer's buffer). */
  vertices: Float32Array;
  indices: Uint32Array;
  /** Visible draw items in draw order with their index ranges. */
  draws: Array<{ item: DrawItem; range: PackedRange }>;
  /** Each distinct mask item once. */
  masks: Map<DrawItem, PackedRange>;
  triangles: number;
}

/**
 * How the renderer applies an item's mask list (see DrawItem.masks):
 * - 'none': no `masks` field, draw normally
 * - 'mask': multiply by the union coverage of the mask items
 * - 'invert': multiply by 1 - coverage
 * - 'skip': a present but EMPTY list is zero coverage, so the item draws nothing
 * An empty list with maskInvert is full coverage inverted: drawn unmasked ('none').
 */
export type MaskMode = 'none' | 'mask' | 'invert' | 'skip';

export function maskModeOf(item: Pick<DrawItem, 'masks' | 'maskInvert'>): MaskMode {
  if (!item.masks) return 'none';
  if (item.masks.length === 0) return item.maskInvert ? 'none' : 'skip';
  return item.maskInvert ? 'invert' : 'mask';
}

export class FramePacker {
  private vertices = new Float32Array(4096 * FLOATS_PER_VERTEX);
  private indices = new Uint32Array(8192);

  /**
   * Items whose indices point past their vertices are skipped (the core never produces them), and so
   * are items clipped away entirely (an empty, non-inverted mask list: zero coverage).
   */
  pack(draws: readonly DrawItem[], hidden: ReadonlySet<string>): PackedFrame {
    const visible = draws.filter((d) => !hidden.has(d.partId) && valid(d) && maskModeOf(d) !== 'skip');
    const masks = new Set<DrawItem>();
    for (const d of visible) {
      const mode = maskModeOf(d);
      if (mode === 'mask' || mode === 'invert') for (const m of d.masks ?? []) if (valid(m)) masks.add(m);
    }
    let vertexCount = 0;
    let indexCount = 0;
    for (const d of [...visible, ...masks]) {
      vertexCount += d.positions.length >> 1;
      indexCount += d.indices.length - (d.indices.length % 3);
    }
    this.reserve(vertexCount, indexCount);

    let v = 0;
    let i = 0;
    const write = (d: DrawItem): PackedRange => {
      const n = d.positions.length >> 1;
      const base = v;
      const out = this.vertices;
      const uvs = d.uvs && d.uvs.length >= n * 2 ? d.uvs : null;
      for (let k = 0; k < n; k++) {
        const o = (base + k) * FLOATS_PER_VERTEX;
        out[o] = d.positions[k * 2];
        out[o + 1] = d.positions[k * 2 + 1];
        out[o + 2] = d.colors[k * 4];
        out[o + 3] = d.colors[k * 4 + 1];
        out[o + 4] = d.colors[k * 4 + 2];
        out[o + 5] = d.colors[k * 4 + 3];
        out[o + 6] = uvs ? uvs[k * 2] : 0;
        out[o + 7] = uvs ? uvs[k * 2 + 1] : 0;
      }
      v += n;
      const first = i;
      const count = d.indices.length - (d.indices.length % 3);
      for (let k = 0; k < count; k++) this.indices[i++] = d.indices[k] + base;
      return { first, count };
    };

    const packed = visible.map((item) => ({ item, range: write(item) }));
    const maskRanges = new Map<DrawItem, PackedRange>();
    for (const m of masks) maskRanges.set(m, write(m));
    const triangles = packed.reduce((sum, p) => sum + p.range.count / 3, 0);
    return {
      vertices: this.vertices.subarray(0, v * FLOATS_PER_VERTEX),
      indices: this.indices.subarray(0, i),
      draws: packed,
      masks: maskRanges,
      triangles,
    };
  }

  private reserve(vertices: number, indices: number): void {
    if (this.vertices.length < vertices * FLOATS_PER_VERTEX) {
      this.vertices = new Float32Array(Math.max(vertices, this.vertices.length / FLOATS_PER_VERTEX * 2) * FLOATS_PER_VERTEX);
    }
    if (this.indices.length < indices) this.indices = new Uint32Array(Math.max(indices, this.indices.length * 2));
  }
}

function valid(d: DrawItem): boolean {
  const n = d.positions.length >> 1;
  if (d.colors.length < n * 4) return false;
  for (let k = 0; k < d.indices.length; k++) if (d.indices[k] >= n) return false;
  return true;
}
