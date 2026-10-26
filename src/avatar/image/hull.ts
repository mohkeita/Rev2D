import type { ImageRGBA } from '../../core/types.js';

/** Convex hull of occupied pixel corners. Transparent edit padding must not travel with a glove. */
export function pixelHull(image: ImageRGBA, ox: number, oy: number): number[] {
  const points: [number, number][] = [];
  for (let y = 0; y < image.height; y++) {
    let first = -1,
      last = -1;
    for (let x = 0; x < image.width; x++)
      if (image.data[(y * image.width + x) * 4 + 3]) {
        if (first < 0) first = x;
        last = x;
      }
    if (first >= 0)
      points.push(
        [first + ox, y + oy],
        [last + 1 + ox, y + oy],
        [first + ox, y + 1 + oy],
        [last + 1 + ox, y + 1 + oy],
      );
  }
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (a: readonly number[], b: readonly number[], c: readonly number[]) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const half = (list: [number, number][]) => {
    const hull: [number, number][] = [];
    for (const p of list) {
      while (hull.length > 1 && cross(hull[hull.length - 2], hull[hull.length - 1], p) <= 0) hull.pop();
      hull.push(p);
    }
    hull.pop();
    return hull;
  };
  return [...half(points), ...half([...points].reverse())].flat();
}
