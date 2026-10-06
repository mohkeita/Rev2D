/**
 * Seeded pseudo-random numbers (mulberry32): small, fast and identical on every JS engine
 * (32-bit integer arithmetic only), so everything built on it is reproducible.
 */

/** A generator of uniform numbers in [0, 1) with 32 bits of resolution. The seed is used as a uint32. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An integer in [0, n) from a generator returned by mulberry32. */
export function randomInt(random: () => number, n: number): number {
  return Math.min(Math.max(0, Math.ceil(n) - 1), Math.floor(random() * n));
}
