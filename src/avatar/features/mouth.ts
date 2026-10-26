/**
 * Feature "mouth": MouthOpen and MouthForm without drawn variants (the mesh fallback).
 *
 * LAYERS. One opaque crop of the illustration over the mouth area (`mouth`, an INTERIOR PATCH,
 * DESIGN.md §3: its warp offsets vanish inside the area ellipse, so it always covers the base's own
 * copy), plus metadata: the thickness and colour of the closed mouth line and the colours of the
 * inside of the mouth (a dark shade of the line colour, a tongue tone) estimated from the picture.
 *
 * COMPILE. Everything is measured in the mouth frame: u along the line through both corners, v across
 * it (downward), the closed line a parabola through both corners that bulges by `bow` in the middle.
 *   mouthWarp    a fine lattice over the patch, nested in the root warp. One binding on
 *                MouthOpen x MouthForm: the skin below the line moves down by the depth of the
 *                opening (most in the middle, nothing at the corners) and is compressed toward the
 *                rim of the area, the skin above rises a little; MouthForm moves the corners (wide and
 *                up for > 0, narrow for < 0) with a Gaussian falloff. All of it fades out inside the
 *                area ellipse, so the chin outline never moves.
 *   mouthInner   a mesh strip between the upper and the lower edge of the opening (zero height when
 *   mouthTongue  the mouth is closed: invisible), in a dark mouth colour; a tongue strip in its lower
 *                part. Their vertices are keyforms on the same grid, built from the same curves as
 *                the warp field, so the opening and the moving skin stay together. The lower half of
 *                the drawn mouth line travels down with the skin and becomes the lower lip line.
 * The six lip-sync shapes (src/lipsync VISEME_SHAPES: a, i, u, e, o, n) are review poses.
 *
 * DRAWN MOUTHS. When the layers hold drawn mouth sprites (../variants-sprites.ts shownSprites), they
 * show the opening (../features/sprites.ts): the mesh then keeps only MouthForm on the closed mouth
 * (mouthShape on MouthForm alone), and mouthInner / mouthTongue are left out, so a drawn mouth never
 * shows together with a mesh opening.
 */
import { VISEME_SHAPES } from '../../lipsync/types.js';
import { AVATAR_Z, smoothstep, type Field, type RectTuple } from '../fields.js';
import { labToRgb } from '../image/color.js';
import { cropRect } from '../image/compose.js';
import { pixelRect, type RGB } from '../image/types.js';
import type { AvatarPose, AvatarSpec } from '../types.js';
import { hexColor, makeFrame, parseHex, rgbToLab, round2, type Frame } from './eyes-matte.js';
import { VARIANTS } from '../variants-areas.js';
import { shownSprites } from '../variants-sprites.js';
import type { AvatarFeature, CompileContext } from './types.js';

export const MOUTH_TUNING = {
  /** Depth of the opening at MouthOpen = 1, MouthForm = 0, as a share of the corner distance... */
  depth: 0.42,
  /** ...at most this share of the room between the line and the rim of the area below it. */
  room: 0.62,
  /** The upper lip rises by this share of the depth. */
  rise: 0.14,
  /** Profile of the opening along the line: sin(pi t) ^ exponent (smaller = rounder, fuller to the corners). */
  exponent: 0.8,
  /** MouthForm = +1: corners out and up (share of the corner distance), a flatter, shallower opening. */
  wide: { out: 0.07, up: 0.06, depth: 0.62, exponent: 0.55 },
  /** MouthForm = -1: corners in (share of the corner distance), a round opening. */
  round: { in: 0.17, down: 0.01, depth: 1, exponent: 0.45 },
  /** Gaussian falloff of the corner motion, in corner distances. */
  cornerSigma: 0.32,
  /** The motion fades out between these levels of the area ellipse (1 = its outline). */
  fadeFrom: 0.62,
  fadeTo: 0.97,
  /** Lattice cells across the mouth line (the cell is never smaller than 2 px). */
  cells: 16,
  /** Samples along the line for the opening mesh. */
  samples: 17,
  /** The tongue rises from the floor of the opening up to this share of its depth in the middle. */
  tongue: 0.3,
} as const;

/** What the layer stage stores (textures/layers.json, key "mouth"). */
export interface MouthMeta {
  version: 1;
  /** Thickness of the closed mouth line (px). */
  line: number;
  /** "#rrggbb": the line, the inside of the mouth, the tongue. */
  colors: { line: string; inside: string; tongue: string };
}

/** The layer and part ids. */
export const MOUTH_LAYER = 'mouth';
const INNER = 'mouthInner';
const TONGUE = 'mouthTongue';
const WARP = 'mouthWarp';

// ----------------------------------------------------------------------------- geometry

/** The mouth line and area of a spec, in the mouth frame. */
export interface MouthGeometry {
  frame: Frame;
  /** u of the two corners (image-left corner first) and the corner distance. */
  u0: number;
  u1: number;
  width: number;
  /** v of the closed line at u (0 at the corners, `bow` in the middle; 0 beyond the corners). */
  lineAt(u: number): number;
  /** Position 0..1 along the line at u (clamped). */
  tAt(u: number): number;
  /** Level of a source point in the area ellipse (0 centre, 1 outline). */
  areaLevel(x: number, y: number): number;
  /** Px from the line to the area outline below / above it, at u. */
  roomBelow(u: number): number;
  roomAbove(u: number): number;
}

export function mouthGeometry(spec: AvatarSpec): MouthGeometry {
  const m = spec.face.mouth;
  const a = m.imageLeft;
  const b = m.imageRight;
  const center: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const raw = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
  const frame = makeFrame(center, Math.abs(raw) < 0.5 ? 0 : raw);
  const width = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const u0 = -width / 2;
  const u1 = width / 2;
  const tAt = (u: number) => Math.min(1, Math.max(0, (u - u0) / Math.max(1e-6, width)));
  const lineAt = (u: number) => {
    const t = (u - u0) / Math.max(1e-6, width);
    return t <= 0 || t >= 1 ? 0 : m.bow * 4 * t * (1 - t);
  };
  const { center: ac, radius, rotation } = m.area;
  const rot = (rotation * Math.PI) / 180;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const areaLevel = (x: number, y: number) => {
    const dx = x - ac[0];
    const dy = y - ac[1];
    const p = (dx * cos + dy * sin) / radius[0];
    const q = (-dx * sin + dy * cos) / radius[1];
    return Math.sqrt(p * p + q * q);
  };
  const room = (u: number, dir: 1 | -1) => {
    const v = lineAt(u);
    let d = 0;
    // Half-pixel steps until the outline (at most the size of the area).
    const limit = 2 * Math.max(radius[0], radius[1]);
    while (d < limit) {
      const [x, y] = frame.from(u, v + dir * (d + 0.5));
      if (areaLevel(x, y) >= 1) break;
      d += 0.5;
    }
    return d;
  };
  return { frame, u0, u1, width, lineAt, tAt, areaLevel, roomBelow: (u) => room(u, 1), roomAbove: (u) => room(u, -1) };
}

/** Parameters of the opening at MouthForm = f (-1..1): depth, profile exponent, corner motion. */
interface FormShape {
  depth: number;
  exponent: number;
  /** Corner motion in the frame: du outward (+ = away from the middle), dv (+ = down). */
  out: number;
  down: number;
}

function formShape(f: number, width: number, depth: number): FormShape {
  const T = MOUTH_TUNING;
  const k = Math.abs(f);
  if (f >= 0) {
    return { depth: depth * (1 + (T.wide.depth - 1) * k), exponent: T.exponent + (T.wide.exponent - T.exponent) * k, out: T.wide.out * width * k, down: -T.wide.up * width * k };
  }
  return { depth: depth * (1 + (T.round.depth - 1) * k), exponent: T.exponent + (T.round.exponent - T.exponent) * k, out: -T.round.in * width * k, down: T.round.down * width * k };
}

/** The whole motion of the mouth at (open, form): the warp field and the edges of the opening. */
export interface MouthPose {
  field: Field;
  /** Upper and lower edge of the opening and the top of the tongue at `samples` points along the line (source px, flat lists). */
  upper: number[];
  lower: number[];
  tongue: number[];
}

export function mouthPose(g: MouthGeometry, open: number, form: number, thickness: number): MouthPose {
  const T = MOUTH_TUNING;
  const { frame, u0, u1, width } = g;
  const h = Math.max(1, thickness / 2 + 0.5);
  // The opening may use at most a share of the room below the line (at the middle).
  const mid = (u0 + u1) / 2;
  const depth = Math.max(0, Math.min(T.depth * width, T.room * (g.roomBelow(mid) - h)));
  const s = formShape(form, width, depth);
  const sigma = T.cornerSigma * width;
  const fade = (x: number, y: number) => 1 - smoothstep((g.areaLevel(x, y) - T.fadeFrom) / (T.fadeTo - T.fadeFrom));
  const profile = (t: number) => (t <= 0 || t >= 1 ? 0 : Math.pow(Math.sin(Math.PI * t), s.exponent));
  // Corner motion in the frame: outward along u, plus down along v, with a Gaussian falloff around each corner.
  const corners = (u: number, v: number): [number, number] => {
    let du = 0;
    let dv = 0;
    for (const [cu, sign] of [[u0, -1], [u1, 1]] as const) {
      const d2 = ((u - cu) ** 2 + v * v) / (sigma * sigma);
      if (d2 > 9) continue;
      const w = Math.exp(-0.5 * d2);
      du += sign * s.out * w;
      dv += s.down * w;
    }
    return [du, dv];
  };
  // Depth below / rise above the line at u, limited by the room the area leaves there.
  const below = (u: number) => Math.min(open * s.depth * profile(g.tAt(u)), T.room * Math.max(0, g.roomBelow(u) - h));
  const above = (u: number) => Math.min(open * T.rise * s.depth * profile(g.tAt(u)), T.room * Math.max(0, g.roomAbove(u) - h));
  const field: Field = (x, y) => {
    const w = fade(x, y);
    if (w === 0) return [0, 0];
    const [u, v] = frame.to(x, y);
    const dv0 = v - g.lineAt(u);
    let dv = 0;
    if (open > 0) {
      const down = below(u);
      const up = above(u);
      if (dv0 >= h) {
        const reach = Math.max(h + 1, g.roomBelow(u));
        dv = down * Math.max(0, 1 - (dv0 - h) / (reach - h));
      } else if (dv0 <= -h) {
        const reach = Math.max(h + 1, g.roomAbove(u));
        dv = -up * Math.max(0, 1 - (-dv0 - h) / (reach - h));
      } else {
        dv = -up + ((dv0 + h) / (2 * h)) * (down + up);
      }
    }
    const [cu, cv] = corners(u, v);
    const du = cu * w;
    const total = dv * w + cv * w;
    return [du * frame.along[0] + total * frame.down[0] + 0, du * frame.along[1] + total * frame.down[1] + 0];
  };
  const upper: number[] = [];
  const lower: number[] = [];
  const tongue: number[] = [];
  for (let k = 0; k < T.samples; k++) {
    const t = k / (T.samples - 1);
    const u = u0 + t * width;
    const v = g.lineAt(u);
    const [cu, cv] = corners(u, v);
    const base: [number, number] = [u + cu, v + cv];
    const down = below(u);
    const up = above(u);
    const put = (list: number[], dv: number) => {
      const p = frame.from(base[0], base[1] + dv);
      list.push(round2(p[0]), round2(p[1]));
    };
    // The opening's upper edge also covers the upper half of the drawn line (the warp stretches it
    // there); toward the corners it narrows to nothing.
    const cover = open * h * Math.min(1, 3 * profile(t));
    put(upper, -up - cover);
    put(lower, down);
    // The tongue: a low mound in the middle of the opening's floor.
    const mound = T.tongue * (down + up) * Math.max(0, (profile(t) - 0.35) / 0.65);
    put(tongue, down - mound);
  }
  return { field, upper, lower, tongue };
}

/** Triangles of a strip between two rows of `n` points (row a: 0..n-1, row b: n..2n-1). */
function strip(n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < n; i++) out.push(i, i + 1, n + i + 1, i, n + i + 1, n + i);
  return out;
}

/** The rectangle of the mouth patch: the area ellipse's bounds (whole pixels, inside the image). */
export function mouthRect(spec: AvatarSpec): RectTuple {
  const { center, radius, rotation } = spec.face.mouth.area;
  const rot = (rotation * Math.PI) / 180;
  const ex = Math.sqrt((radius[0] * Math.cos(rot)) ** 2 + (radius[1] * Math.sin(rot)) ** 2);
  const ey = Math.sqrt((radius[0] * Math.sin(rot)) ** 2 + (radius[1] * Math.cos(rot)) ** 2);
  const r = pixelRect({ x: center[0] - ex, y: center[1] - ey, width: 2 * ex, height: 2 * ey }, 1, spec.image.width, spec.image.height);
  return [r.x, r.y, r.width, r.height];
}

// ----------------------------------------------------------------------------- the feature

function isMouthMeta(value: unknown): value is MouthMeta {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Partial<MouthMeta>;
  return typeof m.line === 'number' && Number.isFinite(m.line) && typeof m.colors === 'object' && m.colors !== null;
}

/** The colours inside an open mouth for a mouth-line colour: a deep shade and a tongue tone. */
export function mouthColors(line: RGB): { inside: RGB; tongue: RGB } {
  const [L, a, b] = rgbToLab(line[0], line[1], line[2]);
  return {
    inside: labToRgb(Math.min(24, L * 0.55), Math.max(18, a * 0.8 + 10), Math.max(4, b * 0.5)),
    tongue: labToRgb(Math.min(46, Math.max(34, L * 0.8 + 6)), Math.max(26, a + 8), Math.max(12, b * 0.6 + 6)),
  };
}

function compileMouth(ctx: CompileContext): void {
  const T = MOUTH_TUNING;
  const { spec, model, root } = ctx;
  const patch = ctx.layer(MOUTH_LAYER);
  const meta = ctx.featureMeta<MouthMeta>('mouth');
  if (!patch || !isMouthMeta(meta)) return;
  const g = mouthGeometry(spec);
  if (!(g.width >= 4)) return;
  // Drawn mouths (the "sprites" feature) take over the opening: the mesh then keeps MouthForm only.
  const drawn = shownSprites(ctx.meta, 'mouth').some(s=>VARIANTS[s.id].mouth !== undefined);
  const open = drawn ? null : model.parameter('MouthOpen');
  const form = model.parameter('MouthForm');
  const cell = Math.max(2, Math.min(ctx.metrics.cell.detail, g.width / T.cells));
  const warp = model.warp({ id: WARP, parent: root.id, rect: patch.rect, cell, description: 'The mouth area: MouthOpen moves the skin below the mouth line down, MouthForm moves the corners; nothing moves at the rim of the area.' });
  model.imagePart(patch, { parent: warp.id, z: AVATAR_Z.mouth, description: 'The mouth area of the illustration (an opaque interior patch: it covers the base copy).' });

  const forms = [-1, 0, 1];
  const opens = open === null ? [0] : [0, 1];
  const poses = new Map<string, MouthPose>();
  for (const o of opens) for (const f of forms) poses.set(`${o}:${f}`, mouthPose(g, o, f, meta.line));
  const rest = poses.get('0:0') as MouthPose;
  if (open === null) {
    model.bindField(warp, {
      id: 'mouthShape',
      params: [form],
      keys: forms.map((f) => ({ at: [f], field: f === 0 ? undefined : poses.get(`0:${f}`)!.field })),
      pinEdges: true,
      description: 'Mouth shape (MouthForm) on the mouth patch; drawn mouths show the opening.',
    });
    ctx.report.info('avatar-mouth-drawn', 'drawn mouths replace the mesh opening: MouthOpen shows them, the mesh keeps MouthForm only');
    ctx.folds.collapsible('warp', warp.id);
    ctx.folds.collapsible('part', patch.id);
    return;
  }
  model.bindField(warp, {
    id: 'mouthShape',
    params: [open, form],
    keys: opens.flatMap((o) => forms.map((f) => ({ at: [o, f], field: o === 0 && f === 0 ? undefined : poses.get(`${o}:${f}`)!.field }))),
    pinEdges: true,
    description: 'Mouth opening (MouthOpen) and shape (MouthForm) on the mouth patch.',
  });

  const inside = parseHex(meta.colors.inside) ?? [60, 20, 28];
  const tongue = parseHex(meta.colors.tongue) ?? [150, 60, 70];
  const n = T.samples;
  const vertices = (top: number[], bottom: number[]) => [...top, ...bottom];
  const add = (id: string, color: RGB, rows: (p: MouthPose) => [number[], number[]], z: number, what: string) => {
    const [top, bottom] = rows(rest);
    model.part({ id, parent: root.id, z, shape: { type: 'mesh', vertices: vertices(top, bottom), triangles: strip(n) }, fill: hexColor(color), description: what });
    model.bind({
      id: `${id}Shape`,
      target: `part:${id}.shape.vertices`,
      params: [open, form],
      keys: opens.flatMap((o) => forms.map((f) => {
        const p = poses.get(`${o}:${f}`)!;
        const [a, b] = rows(p);
        return { at: [o, f], value: vertices(a, b) };
      })),
    });
    ctx.folds.skip('part', id);
  };
  add(INNER, inside, (p) => [p.upper, p.lower], AVATAR_Z.mouth + 1, 'The inside of the open mouth: zero height while the mouth is closed.');
  add(TONGUE, tongue, (p) => [p.tongue, p.lower], AVATAR_Z.mouth + 2, 'The tongue in the lower part of the open mouth.');
  ctx.folds.collapsible('warp', warp.id);
  ctx.folds.collapsible('part', patch.id);
}

export const mouth: AvatarFeature = {
  id: 'mouth',
  summary: 'mouth opening and shape (MouthOpen / MouthForm): a mouth patch in its own nested warp, a dark opening and a tongue that grow along the mouth line',

  layers(ctx) {
    const { spec, source } = ctx;
    const [x, y, w, h] = mouthRect(spec);
    if (w < 2 || h < 2) return;
    const patch = cropRect(source, { x, y, width: w, height: h });
    ctx.addLayer(MOUTH_LAYER, patch, [x, y, w, h]);

    // The mouth line: its darkest pixels along the parabola, and its thickness across the middle.
    const g = mouthGeometry(spec);
    const pixel = (px: number, py: number): RGB | null => {
      const ix = Math.floor(px);
      const iy = Math.floor(py);
      if (ix < 0 || iy < 0 || ix >= source.width || iy >= source.height) return null;
      const o = (iy * source.width + ix) * 4;
      return source.data[o + 3] < 128 ? null : [source.data[o], source.data[o + 1], source.data[o + 2]];
    };
    const lightness = (c: RGB) => rgbToLab(c[0], c[1], c[2])[0];
    const samples: RGB[] = [];
    const runs: number[] = [];
    const reach = Math.max(3, g.width * 0.15);
    for (let k = 1; k < 12; k++) {
      const u = g.u0 + (g.width * k) / 12;
      // The darkest pixel across the line near u, then the run of pixels nearly that dark.
      let best: { c: RGB; d: number; L: number } | null = null;
      const across: Array<{ c: RGB; d: number; L: number }> = [];
      for (let d = -reach; d <= reach; d += 0.5) {
        const [px, py] = g.frame.from(u, g.lineAt(u) + d);
        const c = pixel(px, py);
        if (!c) continue;
        const item = { c, d, L: lightness(c) };
        across.push(item);
        if (!best || item.L < best.L) best = item;
      }
      if (!best) continue;
      samples.push(best.c);
      const skin = across.reduce((m, a) => Math.max(m, a.L), best.L);
      const cut = best.L + (skin - best.L) * 0.5;
      runs.push(across.filter((a) => a.L <= cut && Math.abs(a.d - best!.d) <= reach / 2).length * 0.5);
    }
    if (samples.length === 0) {
      ctx.report.warning('avatar-mouth-line', 'no mouth line found between the mouth corners: the mouth opens without colours from the picture', { path: '/face/mouth', hint: 'place face.mouth.imageLeft / imageRight on the mouth corners of the closed mouth' });
    }
    const median = (list: number[]) => [...list].sort((p, q) => p - q)[list.length >> 1] ?? 0;
    const line: RGB = samples.length ? [median(samples.map((c) => c[0])), median(samples.map((c) => c[1])), median(samples.map((c) => c[2]))] : [120, 50, 60];
    const colours = mouthColors(line);
    const meta: MouthMeta = { version: 1, line: round2(Math.max(1, Math.min(reach, median(runs)))), colors: { line: hexColor(line), inside: hexColor(colours.inside), tongue: hexColor(colours.tongue) } };
    ctx.setMeta('mouth', meta);
    ctx.report.stat('mouthLine', meta.line);
  },

  compile(ctx) {
    compileMouth(ctx);
  },

  poses(): AvatarPose[] {
    const out: AvatarPose[] = [];
    for (const id of ['a', 'i', 'u', 'e', 'o', 'n'] as const) {
      const s = VISEME_SHAPES[id];
      out.push({ id: `viseme_${id}`, label: `"${id}" (open ${s.open}, form ${s.form})`, params: { MouthOpen: s.open, MouthForm: s.form }, zoom: 'mouth' });
    }
    out.push({ id: 'mouth_smile', label: 'smile (MouthForm 1)', params: { MouthForm: 1 }, zoom: 'mouth' });
    out.push({ id: 'mouth_narrow', label: 'narrow (MouthForm -1)', params: { MouthForm: -1 }, zoom: 'mouth' });
    return out;
  },
};
