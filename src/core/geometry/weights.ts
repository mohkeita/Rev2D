/**
 * Automatic skinning weights from distances to bone segments.
 */

/** Segments of bones in setup world space for auto skin weights. For length-0 bones x0==x1, y0==y1. */
export interface BoneSegment {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Auto skinning weights: w_i = 1 / (dist(v, segment_i) + 1)^falloff, normalized per vertex.
 * Returns Float32Array of length vertexCount * bones.length (row per vertex).
 */
export function computeAutoWeights(positions: ArrayLike<number>, bones: BoneSegment[], falloff: number): Float32Array {
  const n = Math.floor(positions.length / 2);
  const nb = bones.length;
  const out = new Float32Array(n * nb);
  const dist = new Float64Array(nb);
  const w = new Float64Array(nb);
  for (let v = 0; v < n; v++) {
    const px = positions[v * 2];
    const py = positions[v * 2 + 1];
    let nearest = Infinity;
    for (let b = 0; b < nb; b++) {
      const s = bones[b];
      const dx = s.x1 - s.x0;
      const dy = s.y1 - s.y0;
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - s.x0) * dx + (py - s.y0) * dy) / len2)) : 0;
      dist[b] = Math.hypot(px - (s.x0 + dx * t), py - (s.y0 + dy * t));
      nearest = Math.min(nearest, dist[b]);
    }
    // Scaling every weight by (nearest + 1)^falloff leaves the normalized result unchanged but keeps
    // the largest weight at 1, so large distances or falloffs cannot underflow into 0 / 0.
    let sum = 0;
    for (let b = 0; b < nb; b++) {
      w[b] = Math.pow((nearest + 1) / (dist[b] + 1), falloff);
      sum += w[b];
    }
    for (let b = 0; b < nb; b++) out[v * nb + b] = w[b] / sum;
  }
  return out;
}
