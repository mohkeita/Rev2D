/**
 * Viewport overlay drawn with Canvas 2D in CSS-pixel screen space on top of the WebGL canvas:
 * coordinate grid, the model canvas frame, mesh wireframes, warp lattices, part bounds, bones, id
 * labels and the selection / hover highlights (a selected IK constraint shows its bone chain and
 * target, a physics group the bones and warps it moves). Line widths are constant on screen at any zoom.
 *
 * Colours come from the design tokens through an OverlayTheme (overlay/theme.ts), so the overlay
 * follows the light / dark appearance. Selection uses the one tint: a tint line over a light
 * underlay, and handles drawn as discs with a coloured ring (`drawHandle`, also for other modes).
 * The canvas is full-bleed under the floating chrome: rulers sit at the edges of the free area
 * (`insets`).
 */
import type { DrawItem, Model, Pose, RGBA } from '../../../src/core/index.js';
import { parseColor } from '../../../src/core/index.js';
import type { OverlayLayer } from '../state/app.js';
import type { EntityRef } from '../state/doc.js';
import { NO_INSETS, visibleRect, worldToScreen, type Camera, type ViewInsets, type ViewportSize } from '../view/camera.js';
import { boneGlyph, boundaryEdges, formatCoord, gridLines, gridSpacing, latticePolylines, uniqueEdges } from './geometry.js';
import { rigHighlight, type RigHighlight } from './highlight.js';
import type { OverlayTheme } from './theme.js';

export interface OverlayInput {
  model: Model | null;
  pose: Pose | null;
  draws: readonly DrawItem[];
  camera: Camera;
  viewport: ViewportSize;
  dpr: number;
  layers: ReadonlySet<OverlayLayer>;
  selection: readonly EntityRef[];
  /** "part:<id>" or "bone:<id>" under the pointer. */
  hover: EntityRef | null;
  hidden: ReadonlySet<string>;
  theme: OverlayTheme;
  /** Part of the viewport covered by floating chrome (rulers and captions keep clear of it). */
  insets?: ViewInsets;
}

type ToScreen = (x: number, y: number) => [number, number];

const edgeCache = new WeakMap<ArrayLike<number>, Uint32Array>();
const outlineCache = new WeakMap<ArrayLike<number>, Uint32Array>();

function cached(cache: WeakMap<ArrayLike<number>, Uint32Array>, indices: Uint32Array, fn: (i: ArrayLike<number>) => Uint32Array): Uint32Array {
  let e = cache.get(indices);
  if (!e) {
    e = fn(indices);
    cache.set(indices, e);
  }
  return e;
}

export function drawOverlay(ctx: CanvasRenderingContext2D, o: OverlayInput): void {
  const { viewport: vp, dpr } = o;
  const w = Math.max(1, Math.round(vp.width * dpr));
  const h = Math.max(1, Math.round(vp.height * dpr));
  if (ctx.canvas.width !== w || ctx.canvas.height !== h) {
    ctx.canvas.width = w;
    ctx.canvas.height = h;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (!o.model) return;

  const S: ToScreen = (x, y) => worldToScreen(o.camera, vp, x, y);
  const L = o.layers;
  if (L.has('grid')) drawGrid(ctx, o);
  drawCanvasFrame(ctx, o, S);
  if (!o.pose) return;
  const hl = rigHighlight(o.model, o.selection);
  if (L.has('mesh')) drawMesh(ctx, o, S);
  if (L.has('warps')) drawWarps(ctx, o, S, null);
  if (L.has('bounds')) drawBounds(ctx, o, S);
  drawHover(ctx, o, S);
  drawSelection(ctx, o, hl, S);
  if (L.has('bones')) drawBones(ctx, o, hl, S);
  // Selected bones (also those of a selected IK constraint or physics group) are drawn even when
  // the bones layer is off, on top of everything else.
  drawSelectedBones(ctx, o, hl, S);
  if (L.has('labels')) drawLabels(ctx, o, S);
}

// ------------------------------------------------------------------------------------ handles

/**
 * A handle: a disc ringed in `color`. `selected` handles are larger (14 px across), filled white
 * and ringed in the tint. Shared by every mode that puts draggable points on the canvas.
 */
export function drawHandle(ctx: CanvasRenderingContext2D, theme: OverlayTheme, x: number, y: number, opts: { color?: string; selected?: boolean; radius?: number } = {}): void {
  const selected = opts.selected === true;
  const r = opts.radius ?? (selected ? 7 : 4.5);
  ctx.beginPath();
  ctx.arc(x, y, r + 1, 0, Math.PI * 2);
  ctx.fillStyle = theme.haloSoft;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, r - 1, 0, Math.PI * 2);
  ctx.fillStyle = selected ? theme.onAccent : theme.handleFill;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = selected ? theme.accent : (opts.color ?? theme.accent);
  ctx.stroke();
}

/** Stroke the current path as a tint line over a light underlay (reads on any artwork). */
function strokeAccent(ctx: CanvasRenderingContext2D, theme: OverlayTheme, width: number, alpha = 1): void {
  ctx.globalAlpha = alpha * 0.9;
  ctx.lineWidth = width + 2;
  ctx.strokeStyle = theme.onAccent;
  ctx.stroke();
  ctx.globalAlpha = alpha;
  ctx.lineWidth = width;
  ctx.strokeStyle = theme.accent;
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/** Stroke the current path in `color` over a dark halo. */
function strokeOverHalo(ctx: CanvasRenderingContext2D, theme: OverlayTheme, color: string, width: number): void {
  ctx.lineWidth = width + 2;
  ctx.strokeStyle = theme.halo;
  ctx.stroke();
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  ctx.stroke();
}

// ------------------------------------------------------------------------------------ grid

function drawGrid(ctx: CanvasRenderingContext2D, o: OverlayInput): void {
  const { camera: cam, viewport: vp, theme: T } = o;
  const inset = o.insets ?? NO_INSETS;
  const [x0, y0, vw, vh] = visibleRect(cam, vp);
  const { minor, major } = gridSpacing(cam.zoom, 10);
  const isMajor = (v: number): boolean => Math.abs(v / major - Math.round(v / major)) < 1e-6;
  const xs = gridLines(x0, x0 + vw, minor);
  const ys = gridLines(y0, y0 + vh, minor);
  const sx = (x: number): number => Math.round((x - cam.cx) * cam.zoom + vp.width / 2) + 0.5;
  const sy = (y: number): number => Math.round((y - cam.cy) * cam.zoom + vp.height / 2) + 0.5;
  const lines = (pred: (v: number) => boolean, color: string): void => {
    ctx.beginPath();
    for (const x of xs) {
      if (!pred(x)) continue;
      ctx.moveTo(sx(x), 0);
      ctx.lineTo(sx(x), vp.height);
    }
    for (const y of ys) {
      if (!pred(y)) continue;
      ctx.moveTo(0, sy(y));
      ctx.lineTo(vp.width, sy(y));
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.stroke();
  };
  lines((v) => !isMajor(v), T.gridMinor);
  lines((v) => isMajor(v) && v !== 0, T.gridMajor);
  // Axes through the model origin.
  ctx.beginPath();
  ctx.moveTo(sx(0), 0);
  ctx.lineTo(sx(0), vp.height);
  ctx.strokeStyle = T.axisX;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0, sy(0));
  ctx.lineTo(vp.width, sy(0));
  ctx.strokeStyle = T.axisY;
  ctx.stroke();

  // Coordinate rulers along the top and leading edges of the free area.
  const left = inset.left;
  const top = inset.top;
  const right = vp.width - inset.right;
  const bottom = vp.height - inset.bottom;
  if (right - left < 120 || bottom - top < 80) return;
  ctx.font = T.mono;
  ctx.textBaseline = 'top';
  ctx.fillStyle = T.rulerPlate;
  ctx.fillRect(left, top, right - left, 15);
  ctx.fillRect(left, top + 15, 34, bottom - top - 15);
  ctx.fillStyle = T.rulerText;
  for (const x of xs) {
    if (!isMajor(x)) continue;
    const px = sx(x);
    if (px < left + 36 || px > right - 4) continue;
    ctx.fillText(formatCoord(x, minor), px + 3, top + 2);
    ctx.fillRect(px - 0.5, top + 10, 1, 5);
  }
  ctx.textBaseline = 'middle';
  for (const y of ys) {
    if (!isMajor(y)) continue;
    const py = sy(y);
    if (py < top + 22 || py > bottom - 4) continue;
    ctx.save();
    ctx.translate(left + 12, py);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'left';
    ctx.fillText(formatCoord(y, minor), 3, 0);
    ctx.restore();
    ctx.fillRect(left + 29, py - 0.5, 5, 1);
  }
  ctx.textAlign = 'left';
}

// ------------------------------------------------------------------------------------ canvas frame

/** The model canvas as an artboard: a hairline, a soft shadow around it and a small caption. */
function drawCanvasFrame(ctx: CanvasRenderingContext2D, o: OverlayInput, S: ToScreen): void {
  const m = o.model!;
  const T = o.theme;
  const [ax, ay] = S(0, 0);
  const [bx, by] = S(m.meta.width, m.meta.height);
  const x = Math.round(ax) + 0.5;
  const y = Math.round(ay) + 0.5;
  const w = Math.round(bx) - Math.round(ax);
  const h = Math.round(by) - Math.round(ay);
  ctx.lineWidth = 1;
  // Shadow: rings of fading strength just outside the frame, a little heavier below.
  T.frameShadow.forEach((color, i) => {
    const d = i + 1;
    ctx.strokeStyle = color;
    ctx.strokeRect(x - d, y - d + (i > 0 ? 1 : 0), w + 2 * d, h + 2 * d);
  });
  ctx.strokeStyle = T.frame;
  ctx.strokeRect(x - 1, y - 1, w + 2, h + 2);
  ctx.font = T.mono;
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = T.frameLabel;
  const label = `${m.meta.name} · ${m.meta.width} × ${m.meta.height}`;
  const top = (o.insets ?? NO_INSETS).top;
  if (y - 6 > top + 14) ctx.fillText(label, x, y - 6);
}

// ------------------------------------------------------------------------------------ mesh

function strokeEdges(ctx: CanvasRenderingContext2D, positions: ArrayLike<number>, edges: Uint32Array, S: ToScreen): void {
  for (let i = 0; i < edges.length; i += 2) {
    const a = edges[i] * 2;
    const b = edges[i + 1] * 2;
    const [x0, y0] = S(positions[a], positions[a + 1]);
    const [x1, y1] = S(positions[b], positions[b + 1]);
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
  }
}

function drawMesh(ctx: CanvasRenderingContext2D, o: OverlayInput, S: ToScreen): void {
  ctx.beginPath();
  for (const item of o.draws) {
    if (o.hidden.has(item.partId)) continue;
    strokeEdges(ctx, item.positions, cached(edgeCache, item.indices, uniqueEdges), S);
  }
  ctx.lineWidth = 1;
  ctx.strokeStyle = o.theme.mesh;
  ctx.stroke();
}

// ------------------------------------------------------------------------------------ warps

/** Warp lattices. `only`: just these warps, as a selection (tint line, handles on the points). */
function drawWarps(ctx: CanvasRenderingContext2D, o: OverlayInput, S: ToScreen, only: ReadonlySet<string> | null): void {
  const T = o.theme;
  const pose = o.pose!;
  for (const warp of o.model!.warps) {
    if (only !== null && !only.has(warp.id)) continue;
    const wp = pose.warps[warp.id];
    if (!wp) continue;
    const lines = latticePolylines(wp.points, wp.cols, wp.rows);
    ctx.beginPath();
    for (const line of lines) {
      for (let i = 0; i < line.length; i += 2) {
        const [x, y] = S(line[i], line[i + 1]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
    }
    if (only !== null) {
      strokeAccent(ctx, T, 1.5);
      // Handles only while they do not crowd each other.
      const [x0, y0] = S(wp.points[0], wp.points[1]);
      const [x1, y1] = S(wp.points[2] ?? wp.points[0], wp.points[3] ?? wp.points[1]);
      const spacing = Math.hypot(x1 - x0, y1 - y0);
      for (let i = 0; i < wp.points.length; i += 2) {
        const [x, y] = S(wp.points[i], wp.points[i + 1]);
        drawHandle(ctx, T, x, y, { radius: spacing >= 22 ? 4 : 2.5 });
      }
      continue;
    }
    strokeOverHalo(ctx, T, T.warp, 1);
    for (let i = 0; i < wp.points.length; i += 2) {
      const [x, y] = S(wp.points[i], wp.points[i + 1]);
      ctx.fillStyle = T.halo;
      ctx.fillRect(x - 3, y - 3, 6, 6);
      ctx.fillStyle = T.warp;
      ctx.fillRect(x - 2, y - 2, 4, 4);
    }
  }
}

// ------------------------------------------------------------------------------------ bounds

function drawBounds(ctx: CanvasRenderingContext2D, o: OverlayInput, S: ToScreen): void {
  ctx.beginPath();
  for (const id of o.pose!.drawOrder) {
    if (o.hidden.has(id)) continue;
    const b = o.pose!.parts[id]?.bounds;
    if (!b) continue;
    const [x0, y0] = S(b[0], b[1]);
    const [x1, y1] = S(b[0] + b[2], b[1] + b[3]);
    ctx.rect(Math.round(x0) + 0.5, Math.round(y0) + 0.5, Math.round(x1 - x0), Math.round(y1 - y0));
  }
  strokeOverHalo(ctx, o.theme, o.theme.bounds, 1);
}

// ------------------------------------------------------------------------------------ bones

/** Bone overlay colour: the bone's own `color`, else one of the palette by index. */
function boneColor(o: OverlayInput, index: number): string {
  const c = o.model!.bones[index].color;
  const rgba = c !== undefined ? parseColor(c) : null;
  return rgba ? cssOf(rgba) : o.theme.bonePalette[index % o.theme.bonePalette.length];
}

function cssOf(c: RGBA): string {
  const ch = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `rgb(${ch(c[0])}, ${ch(c[1])}, ${ch(c[2])})`;
}

function drawBone(ctx: CanvasRenderingContext2D, T: OverlayTheme, joint: [number, number], tip: [number, number], color: string, emphasis: 'normal' | 'hover' | 'selected'): void {
  const selected = emphasis === 'selected';
  const glyph = boneGlyph(joint[0], joint[1], tip[0], tip[1], selected ? 8 : 7);
  if (glyph) {
    ctx.beginPath();
    ctx.moveTo(glyph[0], glyph[1]);
    for (let i = 2; i < glyph.length; i += 2) ctx.lineTo(glyph[i], glyph[i + 1]);
    ctx.closePath();
    if (selected) {
      ctx.fillStyle = T.accentFill;
      ctx.fill();
      strokeAccent(ctx, T, 1.5);
    } else {
      ctx.globalAlpha = emphasis === 'hover' ? 0.6 : 0.4;
      ctx.fillStyle = color;
      ctx.fill();
      ctx.globalAlpha = 1;
      strokeOverHalo(ctx, T, color, emphasis === 'hover' ? 1.5 : 1);
    }
  } else {
    // Zero-length bone: a cross through the joint.
    ctx.beginPath();
    ctx.moveTo(joint[0] - 6, joint[1] - 6);
    ctx.lineTo(joint[0] + 6, joint[1] + 6);
    ctx.moveTo(joint[0] + 6, joint[1] - 6);
    ctx.lineTo(joint[0] - 6, joint[1] + 6);
    if (selected) strokeAccent(ctx, T, 1.5);
    else strokeOverHalo(ctx, T, color, 1.5);
  }
  drawHandle(ctx, T, joint[0], joint[1], { color, selected, radius: selected ? 7 : emphasis === 'hover' ? 5.5 : 4.5 });
}

function drawBones(ctx: CanvasRenderingContext2D, o: OverlayInput, hl: RigHighlight, S: ToScreen): void {
  const model = o.model!;
  const pose = o.pose!;
  // Parent links: dashed joint-to-joint lines underneath.
  ctx.beginPath();
  for (const bone of model.bones) {
    const bp = pose.bones[bone.id];
    const parent = bone.parent ? pose.bones[bone.parent] : undefined;
    if (!bp || !parent) continue;
    const [ax, ay] = S(parent.x, parent.y);
    const [bx, by] = S(bp.x, bp.y);
    if (Math.hypot(bx - ax, by - ay) < 2) continue;
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
  }
  ctx.setLineDash([3, 3]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = o.theme.boneLink;
  ctx.stroke();
  ctx.setLineDash([]);

  const hover = o.hover?.kind === 'bone' ? o.hover.id : null;
  model.bones.forEach((bone, i) => {
    const bp = pose.bones[bone.id];
    if (!bp || hl.bones.has(bone.id)) return;
    drawBone(ctx, o.theme, S(bp.x, bp.y), S(bp.tip[0], bp.tip[1]), boneColor(o, i), bone.id === hover ? 'hover' : 'normal');
  });
}

// ------------------------------------------------------------------------------------ labels

function pill(ctx: CanvasRenderingContext2D, T: OverlayTheme, text: string, x: number, y: number, color: string, mark?: string): [number, number, number, number] {
  ctx.font = T.font;
  const w = Math.ceil(ctx.measureText(text).width) + (mark ? 14 : 10);
  const h = 17;
  ctx.fillStyle = T.haloSoft;
  ctx.beginPath();
  ctx.roundRect(x - 0.5, y - 0.5, w + 1, h + 1, 5.5);
  ctx.fill();
  ctx.fillStyle = T.pillPlate;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 5);
  ctx.fill();
  if (mark) {
    ctx.fillStyle = mark;
    ctx.beginPath();
    ctx.arc(x + 7, y + h / 2, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + (mark ? 12 : 5), y + h / 2 + 0.5);
  return [x, y, w, h];
}

function drawLabels(ctx: CanvasRenderingContext2D, o: OverlayInput, S: ToScreen): void {
  const model = o.model!;
  const pose = o.pose!;
  const T = o.theme;
  const placed: Array<[number, number, number, number]> = [];
  const free = (r: [number, number, number, number]): boolean =>
    !placed.some((p) => r[0] < p[0] + p[2] && p[0] < r[0] + r[2] && r[1] < p[1] + p[3] && p[1] < r[1] + r[3]);
  const place = (text: string, x: number, y: number, color: string, mark?: string): void => {
    ctx.font = T.font;
    const w = Math.ceil(ctx.measureText(text).width) + (mark ? 14 : 10);
    for (let k = 0; k < 8; k++) {
      const dy = (k % 2 === 1 ? 1 : -1) * Math.ceil(k / 2) * 19;
      const r: [number, number, number, number] = [x, y + dy, w, 17];
      if (free(r)) {
        placed.push(pill(ctx, T, text, r[0], r[1], color, mark));
        return;
      }
    }
  };
  model.bones.forEach((bone, i) => {
    const bp = pose.bones[bone.id];
    if (!bp) return;
    const [x, y] = S(bp.x, bp.y);
    place(bone.id, Math.round(x + 10), Math.round(y - 8), T.pillText, boneColor(o, i));
  });
  for (const id of pose.drawOrder) {
    if (o.hidden.has(id)) continue;
    const b = pose.parts[id]?.bounds;
    if (!b) continue;
    const [x, y] = S(b[0], b[1]);
    place(id, Math.round(x + 2), Math.round(y + 2), T.pillPartText);
  }
}

// ------------------------------------------------------------------------------------ highlights

function partItems(o: OverlayInput, id: string): DrawItem[] {
  return o.draws.filter((d) => d.partId === id);
}

function outlinePart(ctx: CanvasRenderingContext2D, o: OverlayInput, id: string, S: ToScreen): boolean {
  const items = partItems(o, id);
  if (items.length === 0) return false;
  ctx.beginPath();
  for (const item of items) strokeEdges(ctx, item.positions, cached(outlineCache, item.indices, boundaryEdges), S);
  return true;
}

function drawHover(ctx: CanvasRenderingContext2D, o: OverlayInput, S: ToScreen): void {
  const h = o.hover;
  if (h?.kind !== 'part' || o.selection.some((r) => r.kind === 'part' && r.id === h.id)) return;
  if (!outlinePart(ctx, o, h.id, S)) return;
  strokeAccent(ctx, o.theme, 1, 0.7);
}

function drawSelection(ctx: CanvasRenderingContext2D, o: OverlayInput, hl: RigHighlight, S: ToScreen): void {
  const pose = o.pose!;
  const T = o.theme;
  // Selected warps and the warps a selected physics group moves.
  if (hl.warps.size) drawWarps(ctx, o, S, hl.warps);
  for (const ref of o.selection) {
    if (ref.kind === 'part') {
      const items = partItems(o, ref.id);
      if (items.length) {
        // Faint triangle wireframe + strong silhouette.
        ctx.beginPath();
        for (const item of items) strokeEdges(ctx, item.positions, cached(edgeCache, item.indices, uniqueEdges), S);
        ctx.lineWidth = 1;
        ctx.strokeStyle = T.accentSoft;
        ctx.stroke();
        outlinePart(ctx, o, ref.id, S);
        strokeAccent(ctx, T, 2);
      } else {
        // Not drawn (hidden, invisible or empty): dashed bounds.
        const b = pose.parts[ref.id]?.bounds;
        if (!b) continue;
        const [x0, y0] = S(b[0], b[1]);
        const [x1, y1] = S(b[0] + b[2], b[1] + b[3]);
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.rect(x0, y0, x1 - x0, y1 - y0);
        strokeAccent(ctx, T, 1.5);
        ctx.setLineDash([]);
      }
    }
  }
}

function drawSelectedBones(ctx: CanvasRenderingContext2D, o: OverlayInput, hl: RigHighlight, S: ToScreen): void {
  const pose = o.pose!;
  const T = o.theme;
  // IK goal lines: chain tip -> target joint.
  for (const link of hl.links) {
    const from = pose.bones[link.from];
    const to = pose.bones[link.to];
    if (!from || !to) continue;
    const [ax, ay] = S(from.tip[0], from.tip[1]);
    const [bx, by] = S(to.x, to.y);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.setLineDash([5, 4]);
    strokeAccent(ctx, T, 1.5);
    ctx.setLineDash([]);
  }
  for (const id of hl.bones) {
    const bp = pose.bones[id];
    if (bp) drawBone(ctx, T, S(bp.x, bp.y), S(bp.tip[0], bp.tip[1]), T.accent, 'selected');
  }
  for (const id of hl.targets) {
    const bp = pose.bones[id];
    if (bp) drawTarget(ctx, T, S(bp.x, bp.y));
  }
}

/** IK goal marker: a ring with a cross hair. */
function drawTarget(ctx: CanvasRenderingContext2D, T: OverlayTheme, [x, y]: [number, number]): void {
  ctx.beginPath();
  ctx.arc(x, y, 9, 0, Math.PI * 2);
  ctx.moveTo(x - 14, y);
  ctx.lineTo(x - 4, y);
  ctx.moveTo(x + 4, y);
  ctx.lineTo(x + 14, y);
  ctx.moveTo(x, y - 14);
  ctx.lineTo(x, y - 4);
  ctx.moveTo(x, y + 4);
  ctx.lineTo(x, y + 14);
  strokeAccent(ctx, T, 2);
}
