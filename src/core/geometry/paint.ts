/**
 * Paint evaluation: fills (solid / linear / radial gradients) sampled per vertex in setup space.
 */
import { clamp } from '../math.js';
import { mixColor, parseColor } from '../color.js';
import type { Fill, RGBA } from '../types.js';
import { GeometryError } from './errors.js';

/** Fill used when a part has none, so image shapes show their texture unchanged. */
export const DEFAULT_FILL = '#ffffff';

type Paint = (x: number, y: number) => RGBA;

/** Parse a paint color, reporting `what` in the GeometryError. */
export function paintColor(input: string, what: string): RGBA {
  const c = parseColor(input);
  if (!c) throw new GeometryError(`invalid ${what} "${input}" (use "#rrggbb", "#rrggbbaa", "rgba(r,g,b,a)" or a basic color name)`);
  return c;
}

/** Straight RGBA of `fill` (default white) at every vertex of `positions`, 4 floats per vertex. */
export function fillColors(fill: Fill | undefined, positions: readonly number[]): Float32Array {
  const paint = compilePaint(fill ?? DEFAULT_FILL);
  const n = positions.length >> 1;
  const out = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) out.set(paint(positions[2 * i], positions[2 * i + 1]), 4 * i);
  return out;
}

/** The same color on `count` vertices. */
export function solidColors(color: RGBA, count: number): Float32Array {
  const out = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) out.set(color, 4 * i);
  return out;
}

function compilePaint(fill: Fill): Paint {
  if (typeof fill === 'string') return constant(paintColor(fill, 'fill color'));
  switch (fill.type) {
    case 'solid':
      return constant(paintColor(fill.color, 'fill color'));
    case 'linear': {
      const ramp = colorRamp(fill.stops);
      const [fx, fy] = fill.from;
      const dx = fill.to[0] - fx;
      const dy = fill.to[1] - fy;
      const len2 = dx * dx + dy * dy;
      // SVG: a zero-length gradient vector paints the last stop's color.
      if (!(len2 > 0)) return constant(ramp(1));
      return (x, y) => ramp(((x - fx) * dx + (y - fy) * dy) / len2);
    }
    case 'radial': {
      const ramp = colorRamp(fill.stops);
      const [cx, cy] = fill.center;
      const r = fill.radius;
      if (!(r > 0)) return constant(ramp(1));
      return (x, y) => ramp(Math.hypot(x - cx, y - cy) / r);
    }
  }
}

function constant(c: RGBA): Paint {
  return () => c;
}

/**
 * Gradient color at t (clamped to 0..1): stops sorted by offset (ties keep their order, giving hard
 * transitions), the first/last color outside the stops, linear interpolation in between.
 */
function colorRamp(stops: ReadonlyArray<readonly [number, string]>): (t: number) => RGBA {
  if (stops.length === 0) throw new GeometryError('gradient needs at least one stop');
  const sorted = stops
    .map(([offset, c], index) => ({ offset, color: paintColor(c, 'gradient stop color'), index }))
    .sort((a, b) => a.offset - b.offset || a.index - b.index);
  const last = sorted[sorted.length - 1];
  return (tRaw) => {
    const t = clamp(tRaw, 0, 1);
    if (!(t > sorted[0].offset)) return sorted[0].color;
    for (let i = 1; i < sorted.length; i++) {
      const b = sorted[i];
      if (t <= b.offset) {
        // t > a.offset here (earlier stops were passed), so the span is non-zero.
        const a = sorted[i - 1];
        return mixColor(a.color, b.color, (t - a.offset) / (b.offset - a.offset));
      }
    }
    return last.color;
  };
}
