/**
 * Debug overlays drawn on top of a rendered image so an AI (or a human) can verify a rig from a
 * single screenshot: coordinate grid, mesh wireframes, warp lattices, part bounds, bones and id labels.
 * Pure TypeScript (browser-safe). Overlay sizes are in output pixels (independent of `scale`). Bones,
 * links, warps and bounds have a dark underlay and labels sit on dark boxes, so they stay legible over
 * any background; the grid and mesh wireframe are deliberately faint, translucent single-pixel lines.
 * A label that had to move away from its anchor (crowding) gets a leader line: dashed, in a lighter
 * tint of the label's color, ending in a dot on the anchor (joint or bounds corner), so it never
 * reads as a solid bounds edge or a white dashed bone link. It ends mid-side on the label box, and moved
 * part labels are indented from the bounds corner, so it leaves the bounds edge at an angle instead of
 * running along it.
 */
import type { ImageRGBA, Model, Pose, RenderList, RGBA } from '../core/types.js';
import { parseColor } from '../core/color.js';
import { Coverage, distance, fillRect } from './draw.js';
import { drawLabel, measureLabel } from './font.js';
import type { PixelRect } from './image.js';

export type OverlayLayer = 'bones' | 'mesh' | 'warps' | 'bounds' | 'labels' | 'grid';

export interface OverlayOptions {
  layers: OverlayLayer[];
  /** Same viewBox/scale used for renderImage so overlays line up. */
  viewBox?: [number, number, number, number];
  scale?: number;
  /** Grid spacing in setup px for the 'grid' layer (default 50, labels every 100). */
  gridStep?: number;
  /** Integer magnification of label text. Default: 1, or 2 for images of 1536 px and larger. */
  textScale?: number;
  /**
   * Focus: only these ids are drawn by the bones, warps, mesh, bounds and labels layers (bone ids by
   * bones/labels, warp ids by warps, part ids by mesh/bounds/labels); the grid is unaffected. Unknown
   * ids are ignored (the API checks them).
   */
  only?: string[];
  /** With `only`: also draw the ancestor bones of the listed bones (their chain up to the root). */
  onlyChain?: boolean;
}

/** Everything an overlay may need: the model (bone colors, warp dims, ids), the pose (world transforms, bounds) and the render list (triangles for wireframes). */
export interface OverlayScene {
  model: Model;
  pose: Pose;
  list: RenderList;
}

const SHADOW: RGBA = [0, 0, 0, 0.55];
const GRID: RGBA = [0.55, 0.62, 0.75, 0.6];
/** Coverage of minor grid lines relative to major ones. */
const GRID_MINOR = 0.45;
const GRID_TEXT: RGBA = [0.8, 0.88, 1, 1];
const MESH: RGBA = [0.15, 0.75, 1, 0.55];
const WARP: RGBA = [1, 0.35, 0.85, 0.95];
const BOUNDS: RGBA = [1, 0.85, 0.2, 0.95];
const LINK: RGBA = [1, 1, 1, 0.8];
const LABEL_TEXT: RGBA = [1, 1, 1, 1];
/** Part labels use the bounds hue, opaque so the text stays crisp on its box. */
const PART_LABEL_TEXT: RGBA = [BOUNDS[0], BOUNDS[1], BOUNDS[2], 1];
/** Leader lines: dash and gap lengths (px) and how far their color is lightened toward white. */
const LEADER_DASH = 3;
const LEADER_GAP = 2;
const LEADER_TINT = 0.45;
/** A moved part label sits this many px further right than its unmoved spot (see the module comment). */
const MOVED_PART_INDENT = 10;
const BONE_PALETTE: RGBA[] = [
  [1, 0.33, 0.33, 1],
  [0.33, 1, 0.4, 1],
  [0.35, 0.6, 1, 1],
  [1, 0.8, 0.2, 1],
  [1, 0.35, 1, 1],
  [0.2, 0.87, 0.87, 1],
  [1, 0.6, 0.2, 1],
  [0.67, 0.47, 1, 1],
];
/** Fixed back-to-front layer order, whatever order `opts.layers` lists them in. */
const LAYER_ORDER: OverlayLayer[] = ['grid', 'mesh', 'warps', 'bounds', 'bones', 'labels'];

/** Maps setup space to output pixels exactly like renderImage. */
interface View {
  x: number;
  y: number;
  scale: number;
}

function px(v: View, x: number, y: number): [number, number] {
  return [(x - v.x) * v.scale, (y - v.y) * v.scale];
}

/** Own-property lookup, so ids such as "constructor" never resolve to Object.prototype members. */
function lookup<T>(record: Record<string, T>, id: string): T | undefined {
  return Object.hasOwn(record, id) ? record[id] : undefined;
}

/** Ids each layer may draw (null = all). */
interface Focus {
  bones: Set<string> | null;
  warps: Set<string> | null;
  parts: Set<string> | null;
}

function focusOf(model: Model, opts: OverlayOptions): Focus {
  if (!opts.only) return { bones: null, warps: null, parts: null };
  const ids = new Set(opts.only);
  const bones = new Set(ids);
  if (opts.onlyChain) {
    const parentOf = new Map(model.bones.map((b) => [b.id, b.parent ?? null]));
    for (const id of [...ids]) {
      // Walk up to the root; the guard stops at cycles (the model validator reports them).
      let p = parentOf.get(id) ?? null;
      for (let guard = 0; p !== null && guard < model.bones.length; guard++) {
        bones.add(p);
        p = parentOf.get(p) ?? null;
      }
    }
  }
  // An id names a bone, a warp and/or a part; each layer only looks up the kinds it draws.
  return { bones, warps: ids, parts: ids };
}

function shown(set: Set<string> | null, id: string): boolean {
  return set === null || set.has(id);
}

/** Draw debug overlays onto `img` in place (bones with joints/tips, mesh wireframe, warp lattices, part bounds, id labels, coordinate grid). */
export function drawOverlay(img: ImageRGBA, scene: OverlayScene, opts: OverlayOptions): void {
  const vb = opts.viewBox ?? [0, 0, scene.list.width, scene.list.height];
  const focus = focusOf(scene.model, opts);
  const view: View = { x: vb[0], y: vb[1], scale: opts.scale ?? 1 };
  if (!(view.scale > 0) || !Number.isFinite(view.scale)) {
    throw new RangeError(`drawOverlay: invalid scale ${opts.scale}`);
  }
  const layers = new Set(opts.layers);
  const textScale = Math.max(1, Math.floor(opts.textScale ?? (Math.min(img.width, img.height) >= 1536 ? 2 : 1)));
  for (const layer of LAYER_ORDER) {
    if (!layers.has(layer)) continue;
    switch (layer) {
      case 'grid':
        drawGrid(img, vb, view, opts.gridStep ?? 50, textScale);
        break;
      case 'mesh':
        drawMesh(img, scene.list, view, focus);
        break;
      case 'warps':
        drawWarps(img, scene, view, focus);
        break;
      case 'bounds':
        drawBounds(img, scene.pose, view, focus);
        break;
      case 'bones':
        drawBones(img, scene, view, focus);
        break;
      case 'labels':
        drawLabels(img, scene, view, textScale, focus);
        break;
    }
  }
}

// ------------------------------------------------------------------------------------ grid

function drawGrid(
  img: ImageRGBA,
  vb: [number, number, number, number],
  v: View,
  step: number,
  textScale: number,
): void {
  if (!(step > 0) || !Number.isFinite(step)) {
    throw new RangeError(`drawOverlay: gridStep must be positive, got ${step}`);
  }
  // Keep lines at least 4px apart so a small step at a low scale cannot flood the image.
  while (step * v.scale < 4) step *= 2;
  const major = step * Math.max(1, Math.round(100 / step));
  const isMajor = (g: number): boolean => Math.abs(g / major - Math.round(g / major)) < 1e-9;
  const cov = new Coverage(img);
  const xs: Array<[number, number]> = [];
  const ys: Array<[number, number]> = [];
  for (let i = Math.ceil(vb[0] / step); i * step <= vb[0] + vb[2]; i++) {
    const g = i * step;
    const p = Math.floor((g - v.x) * v.scale);
    if (p < 0 || p >= img.width) continue;
    cov.rect(p, 0, 1, img.height, isMajor(g) ? 1 : GRID_MINOR);
    if (isMajor(g)) xs.push([g, p]);
  }
  for (let i = Math.ceil(vb[1] / step); i * step <= vb[1] + vb[3]; i++) {
    const g = i * step;
    const p = Math.floor((g - v.y) * v.scale);
    if (p < 0 || p >= img.height) continue;
    cov.rect(0, p, img.width, 1, isMajor(g) ? 1 : GRID_MINOR);
    if (isMajor(g)) ys.push([g, p]);
  }
  // A single composite: crossings are covered once, not blended twice.
  cov.composite(img, GRID);
  const placed: PixelRect[] = [];
  const label = (text: string, x: number, y: number): void => {
    const box = measureLabel(text, x, y, { scale: textScale });
    if (box.x + box.width > img.width || box.y + box.height > img.height) return;
    if (placed.some((r) => overlaps(r, box))) return;
    placed.push(drawLabel(img, x, y, text, { scale: textScale, color: GRID_TEXT }));
  };
  for (const [g, p] of xs) label(formatCoord(g), p + 2, 1);
  for (const [g, p] of ys) label(formatCoord(g), 1, p + 2);
}

function formatCoord(v: number): string {
  return String(Math.round(v * 1000) / 1000);
}

// ------------------------------------------------------------------------------------ mesh

function drawMesh(img: ImageRGBA, list: RenderList, v: View, focus: Focus): void {
  const cov = new Coverage(img);
  for (const item of list.draws) {
    if (!shown(focus.parts, item.partId)) continue;
    const pos = item.positions;
    const n = pos.length / 2;
    const idx = item.indices;
    const seen = new Set<number>();
    const edge = (a: number, b: number): void => {
      if (a >= n || b >= n) return;
      const key = a < b ? a * n + b : b * n + a;
      if (seen.has(key)) return;
      seen.add(key);
      const [ax, ay] = px(v, pos[a * 2], pos[a * 2 + 1]);
      const [bx, by] = px(v, pos[b * 2], pos[b * 2 + 1]);
      cov.segment(ax, ay, bx, by, 1);
    };
    for (let t = 0; t + 2 < idx.length; t += 3) {
      edge(idx[t], idx[t + 1]);
      edge(idx[t + 1], idx[t + 2]);
      edge(idx[t + 2], idx[t]);
    }
  }
  cov.composite(img, MESH);
}

// ------------------------------------------------------------------------------------ warps

function drawWarps(img: ImageRGBA, scene: OverlayScene, v: View, focus: Focus): void {
  const polylines: number[][] = [];
  const points: number[] = [];
  for (const id of orderedIds(scene.model.warps, scene.pose.warps)) {
    if (!shown(focus.warps, id)) continue;
    const w = scene.pose.warps[id];
    const stride = w.cols + 1;
    const at = (col: number, row: number): [number, number] =>
      px(v, w.points[(row * stride + col) * 2], w.points[(row * stride + col) * 2 + 1]);
    for (let row = 0; row <= w.rows; row++) {
      polylines.push(Array.from({ length: stride }, (_, col) => at(col, row)).flat());
      for (let col = 0; col <= w.cols; col++) points.push(...at(col, row));
    }
    for (let col = 0; col <= w.cols; col++)
      polylines.push(Array.from({ length: w.rows + 1 }, (_, row) => at(col, row)).flat());
  }
  // Lattice lines run through the control points, so the points' extent bounds everything drawn.
  const box = region(points, 6);
  const shadow = new Coverage(img, box);
  const lines = new Coverage(img, box);
  const dotShadow = new Coverage(img, box);
  const dots = new Coverage(img, box);
  for (const line of polylines) {
    shadow.polyline(line, 3);
    lines.polyline(line, 1);
  }
  for (let i = 0; i < points.length; i += 2) {
    dotShadow.disc(points[i], points[i + 1], 3.5);
    dots.disc(points[i], points[i + 1], 2);
  }
  shadow.composite(img, SHADOW);
  lines.composite(img, WARP);
  dotShadow.composite(img, SHADOW);
  dots.composite(img, WARP);
}

/** Pixel region [minX, minY, maxX, maxY] of flat points grown by `margin`, to size Coverage buffers. */
function region(points: number[], margin: number): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 1 < points.length; i += 2) {
    if (points[i] < minX) minX = points[i];
    if (points[i] > maxX) maxX = points[i];
    if (points[i + 1] < minY) minY = points[i + 1];
    if (points[i + 1] > maxY) maxY = points[i + 1];
  }
  return [minX - margin, minY - margin, maxX + margin, maxY + margin];
}

/** Ids in model order first (deterministic), then any extra pose entries in key order. */
function orderedIds(defs: Array<{ id: string }>, present: Record<string, unknown>): string[] {
  const ids = defs.map((d) => d.id).filter((id) => Object.hasOwn(present, id));
  const known = new Set(ids);
  return [...ids, ...Object.keys(present).filter((id) => !known.has(id))];
}

// ------------------------------------------------------------------------------------ bounds

function boundsRect(v: View, b: [number, number, number, number]): PixelRect {
  const [x0, y0] = px(v, b[0], b[1]);
  const [x1, y1] = px(v, b[0] + b[2], b[1] + b[3]);
  const x = Math.floor(x0);
  const y = Math.floor(y0);
  return { x, y, width: Math.max(1, Math.ceil(x1) - x), height: Math.max(1, Math.ceil(y1) - y) };
}

function outline(cov: Coverage, r: PixelRect, t: number): void {
  cov
    .rect(r.x, r.y, r.width, t)
    .rect(r.x, r.y + r.height - t, r.width, t)
    .rect(r.x, r.y, t, r.height)
    .rect(r.x + r.width - t, r.y, t, r.height);
}

function drawBounds(img: ImageRGBA, pose: Pose, v: View, focus: Focus): void {
  const rects: PixelRect[] = [];
  for (const id of pose.drawOrder) {
    if (!shown(focus.parts, id)) continue;
    const b = lookup(pose.parts, id)?.bounds;
    if (b) rects.push(boundsRect(v, b));
  }
  const box = region(
    rects.flatMap((r) => [r.x, r.y, r.x + r.width, r.y + r.height]),
    2,
  );
  const shadow = new Coverage(img, box);
  const lines = new Coverage(img, box);
  for (const r of rects) {
    outline(shadow, { x: r.x - 1, y: r.y - 1, width: r.width + 2, height: r.height + 2 }, 3);
    outline(lines, r, 1);
  }
  shadow.composite(img, SHADOW);
  lines.composite(img, BOUNDS);
}

// ------------------------------------------------------------------------------------ bones

function boneColors(model: Model): Map<string, RGBA> {
  const out = new Map<string, RGBA>();
  model.bones.forEach((bone, i) => {
    const c = bone.color !== undefined ? parseColor(bone.color) : null;
    out.set(bone.id, c ? [c[0], c[1], c[2], 1] : BONE_PALETTE[i % BONE_PALETTE.length]);
  });
  return out;
}

function drawBones(img: ImageRGBA, scene: OverlayScene, v: View, focus: Focus): void {
  const { model, pose } = scene;
  const colors = boneColors(model);
  const bones = model.bones.flatMap((bone) => {
    if (!shown(focus.bones, bone.id)) return [];
    const bp = lookup(pose.bones, bone.id);
    return bp ? [{ bone, joint: px(v, bp.x, bp.y), tip: px(v, bp.tip[0], bp.tip[1]) }] : [];
  });

  // Parent links first (underneath): thin dashed line from the parent joint to the child joint.
  const segments: number[] = [];
  for (const { bone, joint } of bones) {
    const parent = bone.parent && shown(focus.bones, bone.parent) ? lookup(pose.bones, bone.parent) : undefined;
    if (!parent) continue;
    const [ax, ay] = px(v, parent.x, parent.y);
    if (distance(joint[0] - ax, joint[1] - ay) >= 1) segments.push(ax, ay, joint[0], joint[1]);
  }
  const linkBox = region(segments, 3);
  const linkShadow = new Coverage(img, linkBox);
  const links = new Coverage(img, linkBox);
  for (let i = 0; i < segments.length; i += 4) {
    const [ax, ay, bx, by] = segments.slice(i, i + 4);
    linkShadow.segment(ax, ay, bx, by, 3);
    links.dashed(ax, ay, bx, by, 1, 4, 3);
  }
  linkShadow.composite(img, SHADOW);
  links.composite(img, LINK);

  // Each bone is composited on its own (later bones on top); one pair of buffers is reused and
  // cleared after every bone, so the cost follows the drawn pixels rather than the bones' extents.
  const box = region(
    bones.flatMap(({ joint, tip }) => [...joint, ...tip]),
    8,
  );
  const shadow = new Coverage(img, box);
  const body = new Coverage(img, box);
  for (const { bone, joint, tip } of bones) {
    const [jx, jy] = joint;
    const [tx, ty] = tip;
    if (distance(tx - jx, ty - jy) < 1) {
      // Length-0 bone: a small cross through the joint.
      for (const [dx, dy] of [
        [5, 5],
        [5, -5],
      ]) {
        shadow.segment(jx - dx, jy - dy, jx + dx, jy + dy, 4);
        body.segment(jx - dx, jy - dy, jx + dx, jy + dy, 2);
      }
    } else {
      shadow.segment(jx, jy, tx, ty, 5).disc(tx, ty, 3.5);
      body.segment(jx, jy, tx, ty, 3).disc(tx, ty, 2);
    }
    shadow.disc(jx, jy, 6);
    body.ring(jx, jy, 4, 2);
    shadow.composite(img, SHADOW);
    body.composite(img, colors.get(bone.id) ?? BONE_PALETTE[0]);
    shadow.clear();
    body.clear();
  }
}

// ------------------------------------------------------------------------------------ labels

function overlaps(a: PixelRect, b: PixelRect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Labels that share one anchor (joint or bounds corner) and are placed as one stacked block. */
interface LabelGroup {
  /** Anchor in output pixels (a leader line points here when the block had to move away). */
  anchor: [number, number];
  /** Preferred top-left corner of the block. */
  x: number;
  y: number;
  /** Bone labels may also move to the left of their joint when the right side is crowded. */
  flip: boolean;
  /** x of the block once it has to move up or down (default `x`). */
  movedX?: number;
  /** Label color; the leader line is a lighter tint of it. */
  color: RGBA;
  labels: Array<{ text: string; width: number; height: number; color: RGBA; strip?: RGBA }>;
}

/**
 * Greedy placement of a block (a stack of labels): at the preferred corner, then alternately one
 * label height further down / up (at `movedX` when given), first at `x` and then at `altX`; the first
 * position inside the image that overlaps no earlier label wins (fallback: the preferred corner
 * clamped into the image).
 */
function placeBlock(img: ImageRGBA, placed: PixelRect[], block: PixelRect, step: number, altX: number | null, movedX = block.x): PixelRect {
  const clampX = (x: number): number => Math.max(0, Math.min(img.width - block.width, x));
  const clampY = (y: number): number => Math.max(0, Math.min(img.height - block.height, y));
  for (const x of altX === null ? [block.x] : [block.x, altX]) {
    for (let k = 0; k <= 16; k++) {
      const offset = (k % 2 === 1 ? 1 : -1) * Math.ceil(k / 2) * step;
      const y = block.y + offset;
      if (y < 0 || y + block.height > img.height) continue;
      const cand = { ...block, x: clampX(k > 0 && x === block.x ? movedX : x), y };
      if (!placed.some((r) => overlaps(r, cand))) return cand;
    }
  }
  return { ...block, x: clampX(block.x), y: clampY(block.y) };
}

/** Leader line color: the label color lightened toward white (opaque). */
function leaderColor(c: RGBA): RGBA {
  return [c[0] + (1 - c[0]) * LEADER_TINT, c[1] + (1 - c[1]) * LEADER_TINT, c[2] + (1 - c[2]) * LEADER_TINT, 1];
}

/**
 * Where a leader line from (x, y) meets a label box: the middle of the side facing the point (left or
 * right side when the point is beside the box, else top or bottom). Ending mid-side keeps the leader
 * off the axis-aligned bounds edge through the anchor.
 */
function leaderEnd(r: PixelRect, x: number, y: number): [number, number] {
  if (x < r.x) return [r.x, r.y + r.height / 2];
  if (x > r.x + r.width) return [r.x + r.width, r.y + r.height / 2];
  return [r.x + r.width / 2, y < r.y + r.height / 2 ? r.y : r.y + r.height];
}

function drawLabels(img: ImageRGBA, scene: OverlayScene, v: View, textScale: number, focus: Focus): void {
  const { model, pose } = scene;
  const colors = boneColors(model);
  const opts = { scale: textScale };
  const groups = new Map<string, LabelGroup>();
  const group = (key: string, make: () => LabelGroup): LabelGroup => {
    let g = groups.get(key);
    if (!g) groups.set(key, (g = make()));
    return g;
  };
  for (const bone of model.bones) {
    if (!shown(focus.bones, bone.id)) continue;
    const bp = lookup(pose.bones, bone.id);
    if (!bp) continue;
    const [jx, jy] = px(v, bp.x, bp.y);
    if (!(jx >= 0 && jy >= 0 && jx < img.width && jy < img.height)) continue;
    const size = measureLabel(bone.id, 0, 0, opts);
    const color = colors.get(bone.id) ?? BONE_PALETTE[0];
    const g = group(`bone:${Math.round(jx)},${Math.round(jy)}`, () => ({
      anchor: [jx, jy],
      x: Math.round(jx + 8),
      y: Math.round(jy - size.height / 2),
      flip: true,
      color,
      labels: [],
    }));
    g.labels.push({ text: bone.id, width: size.width, height: size.height, color: LABEL_TEXT, strip: color });
  }
  for (const id of pose.drawOrder) {
    if (!shown(focus.parts, id)) continue;
    const b = lookup(pose.parts, id)?.bounds;
    if (!b) continue;
    const r = boundsRect(v, b);
    if (!overlaps(r, { x: 0, y: 0, width: img.width, height: img.height })) continue;
    const size = measureLabel(id, 0, 0, opts);
    const g = group(`part:${r.x},${r.y}`, () => ({
      anchor: [r.x, r.y],
      x: r.x + 2,
      y: r.y + 2,
      movedX: r.x + 2 + MOVED_PART_INDENT,
      flip: false,
      color: PART_LABEL_TEXT,
      labels: [],
    }));
    g.labels.push({ text: id, width: size.width, height: size.height, color: PART_LABEL_TEXT });
  }

  // Place every block first, so leader lines can go underneath all labels.
  const placed: PixelRect[] = [];
  const blocks: Array<{ group: LabelGroup; box: PixelRect }> = [];
  for (const g of groups.values()) {
    const width = Math.max(...g.labels.map((l) => l.width));
    const height = g.labels.reduce((h, l) => h + l.height, 0) + g.labels.length - 1;
    const rowStep = g.labels[0].height + 1;
    const altX = g.flip && g.anchor[0] - 8 - width >= 0 ? Math.round(g.anchor[0] - 8 - width) : null;
    const box = placeBlock(img, placed, { x: g.x, y: g.y, width, height }, rowStep, altX, g.movedX);
    placed.push(box);
    blocks.push({ group: g, box });
  }

  // Leader lines from blocks that had to move to their anchors: dashed, lighter than the label color,
  // with a dot on the anchor (a solid line in the bounds color would read as a bounds edge).
  const shadow = new Coverage(img);
  const line = new Coverage(img);
  for (const { group: g, box } of blocks) {
    const moved = Math.abs(box.y - g.y) > g.labels[0].height / 2 || box.x !== Math.max(0, Math.min(img.width - box.width, g.x));
    if (!moved) continue;
    const [ax, ay] = g.anchor;
    const [ex, ey] = leaderEnd(box, ax, ay);
    if (distance(ex - ax, ey - ay) < 3) continue;
    shadow.dashed(ax, ay, ex, ey, 3, LEADER_DASH, LEADER_GAP).disc(ax, ay, 3.5);
    line.dashed(ax, ay, ex, ey, 1, LEADER_DASH, LEADER_GAP).disc(ax, ay, 2);
    shadow.composite(img, SHADOW);
    line.composite(img, leaderColor(g.color));
    shadow.clear();
    line.clear();
  }

  for (const { group: g, box } of blocks) {
    let y = box.y;
    for (const l of g.labels) {
      drawLabel(img, box.x, y, l.text, { ...opts, color: l.color });
      // Color key: a strip in the bone's color along the label's left edge.
      if (l.strip) fillRect(img, box.x, y, 2, l.height, l.strip);
      y += l.height + 1;
    }
  }
}
