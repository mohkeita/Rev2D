/**
 * Authoring helpers shared by the example model builders (scripts/examples/*.ts).
 *
 * The example models in examples/ are plain Rev2D JSON files. Their builders compute the parts that
 * are tedious to write by hand (keyform lattices, mirrored features, bone-space geometry) and round
 * every number so the generated JSON stays short and diff-friendly.
 */
import { parsePath } from '../../src/core/path.js';
import { apply, fromTRS, multiply, type Mat2D } from '../../src/core/index.js';

export type Doc = Record<string, unknown>;
export type Pt = [number, number];
export type Rect = [number, number, number, number];

/** Round to `digits` decimals (default 1) and normalize -0. */
export function r(v: number, digits = 1): number {
  const k = 10 ** digits;
  const out = Math.round(v * k) / k;
  return Object.is(out, -0) ? 0 : out;
}

/**
 * Tagged template for SVG path data: interpolated numbers are rounded to 1 decimal, whitespace is
 * collapsed. `d\`M ${x} ${y} L ${x + 10} ${y}\``.
 */
export function d(strings: TemplateStringsArray, ...values: Array<number | string>): string {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < values.length) out += typeof values[i] === 'number' ? String(r(values[i] as number)) : values[i];
  });
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Apply `f` to every coordinate pair of an absolute SVG path made of M/L/C/S/Q/T/Z commands and
 * return the transformed path with the same command structure (so keyforms stay compatible).
 */
export function mapPath(path: string, f: (x: number, y: number) => Pt): string {
  const p = parsePath(path);
  const out: string[] = [];
  let k = 0;
  for (const cmd of p.commands) {
    if (cmd === 'Z' || cmd === 'z') {
      out.push('Z');
      continue;
    }
    if (!'MLCSQT'.includes(cmd)) throw new Error(`mapPath: only absolute M L C S Q T Z are supported, got "${cmd}"`);
    const argc = { M: 2, L: 2, C: 6, S: 4, Q: 4, T: 2 }[cmd as 'M' | 'L' | 'C' | 'S' | 'Q' | 'T'];
    const args: number[] = [];
    for (let i = 0; i < argc; i += 2) {
      const [x, y] = f(p.nums[k + i], p.nums[k + i + 1]);
      args.push(r(x), r(y));
    }
    k += argc;
    out.push(`${cmd} ${args.join(' ')}`);
  }
  return out.join(' ');
}

/** Mirror an absolute path horizontally about x = cx. */
export function mirrorPath(path: string, cx: number): string {
  return mapPath(path, (x, y) => [2 * cx - x, y]);
}

/** Translate an absolute path. */
export function movePath(path: string, dx: number, dy: number): string {
  return mapPath(path, (x, y) => [x + dx, y + dy]);
}

// ------------------------------------------------------------------------------------ warps

/** Rest lattice points of a warp, row-major (index = row * (cols + 1) + col). */
export function lattice(rect: Rect, cols: number, rows: number): Pt[] {
  const pts: Pt[] = [];
  for (let row = 0; row <= rows; row++) {
    for (let col = 0; col <= cols; col++) pts.push([rect[0] + (rect[2] * col) / cols, rect[1] + (rect[3] * row) / rows]);
  }
  return pts;
}

/**
 * Warp offsets from a displacement field evaluated at every rest lattice point. Returns a sparse map
 * {"index": [dx, dy]} listing only moved points (readable), or a full flat list when most points move
 * (form "auto"; force either with form "sparse" / "full").
 */
export function warpOffsets(
  rect: Rect,
  cols: number,
  rows: number,
  field: (x: number, y: number, col: number, row: number) => Pt,
  opts: { digits?: number; form?: 'auto' | 'sparse' | 'full' } = {},
): number[] | Record<string, Pt> {
  const digits = opts.digits ?? 1;
  const flat: number[] = [];
  const sparse: Record<string, Pt> = {};
  let moved = 0;
  lattice(rect, cols, rows).forEach(([x, y], i) => {
    const col = i % (cols + 1);
    const row = Math.floor(i / (cols + 1));
    const [dx, dy] = field(x, y, col, row);
    const o: Pt = [r(dx, digits), r(dy, digits)];
    flat.push(o[0], o[1]);
    if (o[0] !== 0 || o[1] !== 0) {
      sparse[String(i)] = o;
      moved++;
    }
  });
  const form = opts.form ?? 'auto';
  if (form === 'auto') return moved * 2 > (cols + 1) * (rows + 1) ? flat : sparse;
  return form === 'full' ? flat : sparse;
}

// ------------------------------------------------------------------------------------ bones

export interface BoneSpec {
  id: string;
  parent?: string;
  x?: number;
  y?: number;
  rotation?: number;
  scaleX?: number;
  scaleY?: number;
  length?: number;
}

/** Setup world matrices of a bone list (parents must come first). */
export function boneWorlds(bones: BoneSpec[]): Record<string, Mat2D> {
  const out: Record<string, Mat2D> = {};
  for (const b of bones) {
    const local = fromTRS(b.x ?? 0, b.y ?? 0, b.rotation ?? 0, b.scaleX ?? 1, b.scaleY ?? 1);
    if (b.parent && !out[b.parent]) throw new Error(`boneWorlds: parent "${b.parent}" of "${b.id}" must come first`);
    out[b.id] = b.parent ? multiply(out[b.parent], local) : local;
  }
  return out;
}

/** Map bone-local points (x along the bone, y to its right) to setup space. */
export function toSetup(m: Mat2D, pts: Pt[]): Pt[] {
  return pts.map(([x, y]) => {
    const [sx, sy] = apply(m, x, y);
    return [r(sx), r(sy)];
  });
}

/** Flatten points to [x0, y0, x1, y1, ...]. */
export function flat(pts: Pt[]): number[] {
  return pts.flatMap(([x, y]) => [r(x), r(y)]);
}

/** Closed polygon path "M ... L ... Z" through points. */
export function polyPath(pts: Pt[]): string {
  return pts.map(([x, y], i) => `${i ? 'L' : 'M'} ${r(x)} ${r(y)}`).join(' ') + ' Z';
}

/** Rounded rectangle in bone-local space (x from x0 to x1 along the bone, half-height h) as a setup-space path. */
export function boneRectPath(m: Mat2D, x0: number, x1: number, h0: number, h1 = h0, corner = 0): string {
  // Corners are approximated with quadratic curves so the outline stays a single simple path.
  const c = Math.min(corner, (x1 - x0) / 2, h0, h1);
  const P = (x: number, y: number): string => {
    const [sx, sy] = apply(m, x, y);
    return `${r(sx)} ${r(sy)}`;
  };
  if (c <= 0) return `M ${P(x0, -h0)} L ${P(x1, -h1)} L ${P(x1, h1)} L ${P(x0, h0)} Z`;
  return [
    `M ${P(x0 + c, -h0)}`,
    `L ${P(x1 - c, -h1)}`,
    `Q ${P(x1, -h1)} ${P(x1, -h1 + c)}`,
    `L ${P(x1, h1 - c)}`,
    `Q ${P(x1, h1)} ${P(x1 - c, h1)}`,
    `L ${P(x0 + c, h0)}`,
    `Q ${P(x0, h0)} ${P(x0, h0 - c)}`,
    `L ${P(x0, -h0 + c)}`,
    `Q ${P(x0, -h0)} ${P(x0 + c, -h0)}`,
    'Z',
  ].join(' ');
}

// ------------------------------------------------------------------------------------ keys

/** Animation key shorthand. */
export function key(t: number, v: number | string, ease?: string): Doc {
  return ease ? { t: r(t, 3), v: typeof v === 'number' ? r(v, 3) : v, ease } : { t: r(t, 3), v: typeof v === 'number' ? r(v, 3) : v };
}

/**
 * Looping track: values at evenly spaced times over `duration` and the first value repeated at
 * t = duration so the loop is seamless. `ease` "smooth" (automatic Catmull-Rom tangents, closed over
 * the loop) keeps the motion flowing through every key, the right choice for sways and bobs;
 * "inOutSine" (the default) stops at every key, for pose-to-pose motion that holds each value.
 */
export function loopTrack(target: string, duration: number, values: number[], ease = 'inOutSine'): Doc {
  const step = duration / values.length;
  const keys = values.map((v, i) => key(i * step, v, ease));
  keys.push(key(duration, values[0]));
  return { target, keys };
}
