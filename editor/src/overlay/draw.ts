/**
 * Viewport overlay drawn with Canvas 2D in CSS-pixel screen space on top of the WebGL canvas:
 * coordinate grid, the model canvas frame, mesh wireframes, warp lattices, part bounds, bones, id
 * labels and the selection / hover highlights (a selected IK constraint shows its bone chain and
 * target, a physics group the bones and warps it moves). Line widths are constant on screen at any zoom.
 */
import type { DrawItem, Model, Pose, RGBA } from '../../../src/core/index.js';
import { parseColor } from '../../../src/core/index.js';
import type { OverlayLayer } from '../state/app.js';
import type { EntityRef } from '../state/doc.js';
import { visibleRect, worldToScreen, type Camera, type ViewportSize } from '../view/camera.js';
import { boneGlyph, boundaryEdges, formatCoord, gridLines, gridSpacing, latticePolylines, uniqueEdges } from './geometry.js';
import { rigHighlight, type RigHighlight } from './highlight.js';

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
}

const FONT = '11px "Segoe UI", system-ui, -apple-system, sans-serif';
const MONO = '10px "Cascadia Mono", "JetBrains Mono", Consolas, ui-monospace, monospace';
const ACCENT = '#4c9dff';
const MESH = 'rgba(90, 190, 255, 0.42)';
const WARP = 'rgba(255, 96, 214, 0.95)';
const BOUNDS = 'rgba(255, 210, 70, 0.9)';
const SHADOW = 'rgba(0, 0, 0, 0.55)';
const BONE_PALETTE = ['#ff5a5a', '#58f070', '#5a9aff', '#ffcc33', '#ff5aff', '#33dddd', '#ff9933', '#aa77ff'];

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

  const S = (x: number, y: number): [number, number] => worldToScreen(o.camera, vp, x, y);
  const L = o.layers;
  if (L.has('grid')) drawGrid(ctx, o);
  drawCanvasFrame(ctx, o, S);
  if (!o.pose) return;
  const hl = rigHighlight(o.model, o.selection);
  if (L.has('mesh')) drawMesh(ctx, o, S);
  if (L.has('warps')) drawWarps(ctx, o.model, o.pose, S, null);
  if (L.has('bounds')) drawBounds(ctx, o, S);
  drawHover(ctx, o, S);
  drawSelection(ctx, o, hl, S);
  if (L.has('bones')) drawBones(ctx, o, hl, S);
  // Selected bones (also those of a selected IK constraint or physics group) are drawn even when
  // the bones layer is off, on top of everything else.
  drawSelectedBones(ctx, o, hl, S);
  if (L.has('labels')) drawLabels(ctx, o, S);
}

// ------------------------------------------------------------------------------------ grid

function drawGrid(ctx: CanvasRenderingContext2D, o: OverlayInput): void {
  const { camera: cam, viewport: vp } = o;
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
  lines((v) => !isMajor(v), 'rgba(150, 168, 200, 0.07)');
  lines((v) => isMajor(v) && v !== 0, 'rgba(150, 168, 200, 0.17)');
  // Axes through the model origin.
  ctx.beginPath();
  ctx.moveTo(sx(0), 0);
  ctx.lineTo(sx(0), vp.height);
  ctx.strokeStyle = 'rgba(110, 230, 140, 0.45)';
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0, sy(0));
  ctx.lineTo(vp.width, sy(0));
  ctx.strokeStyle = 'rgba(255, 110, 110, 0.45)';
  ctx.stroke();

  // Coordinate rulers along the top and left edges.
  ctx.font = MONO;
  ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(12, 14, 18, 0.72)';
  ctx.fillRect(0, 0, vp.width, 15);
  ctx.fillRect(0, 15, 34, vp.height - 15);
  ctx.fillStyle = 'rgba(200, 212, 235, 0.85)';
  for (const x of xs) {
    if (!isMajor(x)) continue;
    const px = sx(x);
    if (px < 36) continue;
    ctx.fillText(formatCoord(x, minor), px + 3, 2);
    ctx.fillRect(px - 0.5, 10, 1, 5);
  }
  ctx.textBaseline = 'middle';
  for (const y of ys) {
    if (!isMajor(y)) continue;
    const py = sy(y);
    if (py < 22) continue;
    ctx.save();
    ctx.translate(12, py);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'left';
    ctx.fillText(formatCoord(y, minor), 3, 0);
    ctx.restore();
    ctx.fillRect(29, py - 0.5, 5, 1);
  }
  ctx.textAlign = 'left';
}

// ------------------------------------------------------------------------------------ canvas frame

function drawCanvasFrame(ctx: CanvasRenderingContext2D, o: OverlayInput, S: (x: number, y: number) => [number, number]): void {
  const m = o.model!;
  const [ax, ay] = S(0, 0);
  const [bx, by] = S(m.meta.width, m.meta.height);
  const x = Math.round(ax) + 0.5;
  const y = Math.round(ay) + 0.5;
  const w = Math.round(bx) - Math.round(ax);
  const h = Math.round(by) - Math.round(ay);
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
  ctx.strokeRect(x - 1, y - 1, w + 2, h + 2);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
  ctx.strokeRect(x, y, w, h);
  ctx.font = MONO;
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = 'rgba(190, 200, 220, 0.7)';
  const label = `${m.meta.name} · ${m.meta.width} × ${m.meta.height}`;
  if (y - 4 > 18) ctx.fillText(label, x, y - 4);
}

// ------------------------------------------------------------------------------------ mesh

function strokeEdges(
  ctx: CanvasRenderingContext2D,
  positions: ArrayLike<number>,
  edges: Uint32Array,
  S: (x: number, y: number) => [number, number],
): void {
  for (let i = 0; i < edges.length; i += 2) {
    const a = edges[i] * 2;
    const b = edges[i + 1] * 2;
    const [x0, y0] = S(positions[a], positions[a + 1]);
    const [x1, y1] = S(positions[b], positions[b + 1]);
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
  }
}

function drawMesh(ctx: CanvasRenderingContext2D, o: OverlayInput, S: (x: number, y: number) => [number, number]): void {
  ctx.beginPath();
  for (const item of o.draws) {
    if (o.hidden.has(item.partId)) continue;
    strokeEdges(ctx, item.positions, cached(edgeCache, item.indices, uniqueEdges), S);
  }
  ctx.lineWidth = 1;
  ctx.strokeStyle = MESH;
  ctx.stroke();
}

// ------------------------------------------------------------------------------------ warps

function drawWarps(
  ctx: CanvasRenderingContext2D,
  model: Model,
  pose: Pose,
  S: (x: number, y: number) => [number, number],
  only: ReadonlySet<string> | null,
  color = WARP,
): void {
  for (const warp of model.warps) {
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
    ctx.lineWidth = 3;
    ctx.strokeStyle = SHADOW;
    ctx.stroke();
    ctx.lineWidth = only !== null ? 1.5 : 1;
    ctx.strokeStyle = color;
    ctx.stroke();
    for (let i = 0; i < wp.points.length; i += 2) {
      const [x, y] = S(wp.points[i], wp.points[i + 1]);
      ctx.fillStyle = SHADOW;
      ctx.fillRect(x - 3, y - 3, 6, 6);
      ctx.fillStyle = color;
      ctx.fillRect(x - 2, y - 2, 4, 4);
    }
  }
}

// ------------------------------------------------------------------------------------ bounds

function drawBounds(ctx: CanvasRenderingContext2D, o: OverlayInput, S: (x: number, y: number) => [number, number]): void {
  ctx.beginPath();
  for (const id of o.pose!.drawOrder) {
    if (o.hidden.has(id)) continue;
    const b = o.pose!.parts[id]?.bounds;
    if (!b) continue;
    const [x0, y0] = S(b[0], b[1]);
    const [x1, y1] = S(b[0] + b[2], b[1] + b[3]);
    ctx.rect(Math.round(x0) + 0.5, Math.round(y0) + 0.5, Math.round(x1 - x0), Math.round(y1 - y0));
  }
  ctx.lineWidth = 3;
  ctx.strokeStyle = SHADOW;
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.strokeStyle = BOUNDS;
  ctx.stroke();
}

// ------------------------------------------------------------------------------------ bones

/** Bone overlay color as "#rrggbb" (so an alpha suffix can be appended). */
function boneColor(model: Model, index: number): string {
  const c = model.bones[index].color;
  const rgba = c !== undefined ? parseColor(c) : null;
  return rgba ? hex(rgba) : BONE_PALETTE[index % BONE_PALETTE.length];
}

function hex(c: RGBA): string {
  return `#${[c[0], c[1], c[2]].map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')}`;
}

function drawBone(
  ctx: CanvasRenderingContext2D,
  joint: [number, number],
  tip: [number, number],
  color: string,
  emphasis: 'normal' | 'hover' | 'selected',
): void {
  const glyph = boneGlyph(joint[0], joint[1], tip[0], tip[1], emphasis === 'selected' ? 8 : 7);
  if (glyph) {
    ctx.beginPath();
    ctx.moveTo(glyph[0], glyph[1]);
    for (let i = 2; i < glyph.length; i += 2) ctx.lineTo(glyph[i], glyph[i + 1]);
    ctx.closePath();
    ctx.fillStyle = emphasis === 'selected' ? 'rgba(76, 157, 255, 0.55)' : `${color}66`;
    ctx.fill();
    ctx.lineWidth = emphasis === 'normal' ? 1.25 : 2;
    ctx.strokeStyle = SHADOW;
    ctx.stroke();
    ctx.strokeStyle = emphasis === 'selected' ? '#ffffff' : emphasis === 'hover' ? '#ffffffcc' : color;
    ctx.lineWidth = emphasis === 'normal' ? 1 : 1.5;
    ctx.stroke();
  } else {
    // Zero-length bone: a cross through the joint.
    ctx.beginPath();
    ctx.moveTo(joint[0] - 6, joint[1] - 6);
    ctx.lineTo(joint[0] + 6, joint[1] + 6);
    ctx.moveTo(joint[0] + 6, joint[1] - 6);
    ctx.lineTo(joint[0] - 6, joint[1] + 6);
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = SHADOW;
    ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = emphasis === 'selected' ? '#ffffff' : color;
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(joint[0], joint[1], emphasis === 'normal' ? 4 : 5, 0, Math.PI * 2);
  ctx.fillStyle = emphasis === 'selected' ? ACCENT : 'rgba(10, 12, 16, 0.85)';
  ctx.fill();
  ctx.lineWidth = 1.75;
  ctx.strokeStyle = emphasis === 'normal' ? color : '#ffffff';
  ctx.stroke();
}

function drawBones(ctx: CanvasRenderingContext2D, o: OverlayInput, hl: RigHighlight, S: (x: number, y: number) => [number, number]): void {
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
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
  ctx.stroke();
  ctx.setLineDash([]);

  const hover = o.hover?.kind === 'bone' ? o.hover.id : null;
  model.bones.forEach((bone, i) => {
    const bp = pose.bones[bone.id];
    if (!bp || hl.bones.has(bone.id)) return;
    drawBone(ctx, S(bp.x, bp.y), S(bp.tip[0], bp.tip[1]), boneColor(model, i), bone.id === hover ? 'hover' : 'normal');
  });
}

// ------------------------------------------------------------------------------------ labels

function pill(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, border?: string): [number, number, number, number] {
  ctx.font = FONT;
  const w = Math.ceil(ctx.measureText(text).width) + 8;
  const h = 16;
  ctx.fillStyle = 'rgba(12, 14, 18, 0.82)';
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 3);
  ctx.fill();
  if (border) {
    ctx.fillStyle = border;
    ctx.fillRect(x, y + 2, 2, h - 4);
  }
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + 5, y + h / 2 + 0.5);
  return [x, y, w, h];
}

function drawLabels(ctx: CanvasRenderingContext2D, o: OverlayInput, S: (x: number, y: number) => [number, number]): void {
  const model = o.model!;
  const pose = o.pose!;
  const placed: Array<[number, number, number, number]> = [];
  const free = (r: [number, number, number, number]): boolean =>
    !placed.some((p) => r[0] < p[0] + p[2] && p[0] < r[0] + r[2] && r[1] < p[1] + p[3] && p[1] < r[1] + r[3]);
  const place = (text: string, x: number, y: number, color: string, border?: string): void => {
    ctx.font = FONT;
    const w = Math.ceil(ctx.measureText(text).width) + 8;
    for (let k = 0; k < 8; k++) {
      const dy = (k % 2 === 1 ? 1 : -1) * Math.ceil(k / 2) * 18;
      const r: [number, number, number, number] = [x, y + dy, w, 16];
      if (free(r)) {
        placed.push(pill(ctx, text, r[0], r[1], color, border));
        return;
      }
    }
  };
  model.bones.forEach((bone, i) => {
    const bp = pose.bones[bone.id];
    if (!bp) return;
    const [x, y] = S(bp.x, bp.y);
    place(bone.id, Math.round(x + 9), Math.round(y - 8), '#ffffff', boneColor(model, i));
  });
  for (const id of pose.drawOrder) {
    if (o.hidden.has(id)) continue;
    const b = pose.parts[id]?.bounds;
    if (!b) continue;
    const [x, y] = S(b[0], b[1]);
    place(id, Math.round(x + 2), Math.round(y + 2), 'rgb(255, 214, 90)');
  }
}

// ------------------------------------------------------------------------------------ highlights

function partItems(o: OverlayInput, id: string): DrawItem[] {
  return o.draws.filter((d) => d.partId === id);
}

function outlinePart(ctx: CanvasRenderingContext2D, o: OverlayInput, id: string, S: (x: number, y: number) => [number, number]): boolean {
  const items = partItems(o, id);
  if (items.length === 0) return false;
  ctx.beginPath();
  for (const item of items) strokeEdges(ctx, item.positions, cached(outlineCache, item.indices, boundaryEdges), S);
  return true;
}

function drawHover(ctx: CanvasRenderingContext2D, o: OverlayInput, S: (x: number, y: number) => [number, number]): void {
  const h = o.hover;
  if (h?.kind !== 'part' || o.selection.some((r) => r.kind === 'part' && r.id === h.id)) return;
  if (!outlinePart(ctx, o, h.id, S)) return;
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)';
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
  ctx.stroke();
}

function drawSelection(ctx: CanvasRenderingContext2D, o: OverlayInput, hl: RigHighlight, S: (x: number, y: number) => [number, number]): void {
  const model = o.model!;
  const pose = o.pose!;
  // Selected warps and the warps a selected physics group moves.
  if (hl.warps.size) drawWarps(ctx, model, pose, S, hl.warps, ACCENT);
  for (const ref of o.selection) {
    if (ref.kind === 'part') {
      const items = partItems(o, ref.id);
      if (items.length) {
        // Faint triangle wireframe + tinted fill + strong silhouette.
        ctx.beginPath();
        for (const item of items) strokeEdges(ctx, item.positions, cached(edgeCache, item.indices, uniqueEdges), S);
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(76, 157, 255, 0.35)';
        ctx.stroke();
        outlinePart(ctx, o, ref.id, S);
        ctx.lineWidth = 4;
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
        ctx.stroke();
        ctx.lineWidth = 2;
        ctx.strokeStyle = ACCENT;
        ctx.stroke();
      } else {
        // Not drawn (hidden, invisible or empty): dashed bounds.
        const b = pose.parts[ref.id]?.bounds;
        if (!b) continue;
        const [x0, y0] = S(b[0], b[1]);
        const [x1, y1] = S(b[0] + b[2], b[1] + b[3]);
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = ACCENT;
        ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
        ctx.setLineDash([]);
      }
    }
  }
}

function drawSelectedBones(ctx: CanvasRenderingContext2D, o: OverlayInput, hl: RigHighlight, S: (x: number, y: number) => [number, number]): void {
  const pose = o.pose!;
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
    ctx.lineWidth = 3;
    ctx.strokeStyle = SHADOW;
    ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = ACCENT;
    ctx.stroke();
    ctx.setLineDash([]);
  }
  for (const id of hl.bones) {
    const bp = pose.bones[id];
    if (bp) drawBone(ctx, S(bp.x, bp.y), S(bp.tip[0], bp.tip[1]), ACCENT, 'selected');
  }
  for (const id of hl.targets) {
    const bp = pose.bones[id];
    if (bp) drawTarget(ctx, S(bp.x, bp.y));
  }
}

/** IK goal marker: a ring with a cross hair. */
function drawTarget(ctx: CanvasRenderingContext2D, [x, y]: [number, number]): void {
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
  ctx.lineWidth = 4;
  ctx.strokeStyle = SHADOW;
  ctx.stroke();
  ctx.lineWidth = 2;
  ctx.strokeStyle = ACCENT;
  ctx.stroke();
}
