/**
 * Painting the avatar canvas (Canvas 2D, CSS px): the workspace, the illustration on a
 * checkerboard, and every placed part in its group colour with its handles on top. Lines and handles
 * keep their screen size at every zoom; the selected group is drawn strong, the others dimmed; the
 * selected item gets a light fill and larger handles. Colours of the chrome come from the design
 * tokens (overlay/theme.ts), the group colours from the avatar builder (AVATAR_PART_GROUPS).
 */
import type { AvatarPartGroupInfo, ResolvedShape } from '../../../src/avatar/index.js';
import { resolveShape } from '../../../src/avatar/parts.js';
import type { CanvasTheme } from '../overlay/theme.js';
import type { Camera, ViewportSize } from '../view/camera.js';
import { worldToScreen } from '../view/camera.js';
import { HANDLE_RADIUS, HANDLE_RADIUS_SELECTED, ROTATION_KNOB, ellipseAxes, isCircle, partHandles, type Handle, type SpecDoc, type ToScreen } from './geometry.js';
import type { AvatarHover, AvatarSelection } from './store.js';

export interface CanvasInput {
  theme: CanvasTheme;
  camera: Camera;
  viewport: ViewportSize;
  dpr: number;
  source: ImageBitmap | null;
  image: { width: number; height: number } | null;
  doc: SpecDoc | null;
  parts: readonly AvatarPartGroupInfo[];
  hidden: ReadonlySet<string>;
  selection: AvatarSelection;
  hover: AvatarHover | null;
  /** Screen x of band grips. */
  bandX: number;
  /** Item ids with errors (drawn with a dashed outline). */
  errors: ReadonlySet<string>;
}

const rgba = (c: readonly number[], a = 1): string => `rgba(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}, ${Math.round(c[3] * a * 1000) / 1000})`;

/** The handles of every visible placed item, in hit-test order (the selected group last: on top). */
export function visibleHandles(o: Pick<CanvasInput, 'doc' | 'parts' | 'hidden' | 'selection' | 'bandX'>, S: ToScreen): Handle[] {
  if (!o.doc) return [];
  const groups = [...o.parts].sort((a, b) => Number(a.id === o.selection.group) - Number(b.id === o.selection.group));
  const out: Handle[] = [];
  for (const g of groups) {
    if (o.hidden.has(g.id)) continue;
    // The selected item's handles go last within its group.
    const items = [...g.items].sort((a, b) => Number(a.id === o.selection.item) - Number(b.id === o.selection.item));
    for (const item of items) {
      const r = resolveShape(o.doc, item.shape);
      if (!r) continue;
      const handles = partHandles(item.id, g.id, item.shape, r, S, { circle: isCircle(o.doc, item.shape), bandX: o.bandX });
      // Zoomed out, the vertices of a part that is not selected crowd into a blob: its outline says
      // enough (a click selects it, and then its vertices are there to drag).
      if (item.id !== o.selection.item && (r.type === 'polygon' || r.type === 'polyline') && meanSpacing(handles) < MIN_VERTEX_SPACING) continue;
      out.push(...handles);
    }
  }
  return out;
}

/** Screen px between neighbouring vertices below which a part that is not selected hides them. */
export const MIN_VERTEX_SPACING = 18;

function meanSpacing(handles: readonly Handle[]): number {
  if (handles.length < 2) return Infinity;
  let sum = 0;
  for (let i = 1; i < handles.length; i++) sum += Math.hypot(handles[i].x - handles[i - 1].x, handles[i].y - handles[i - 1].y);
  return sum / (handles.length - 1);
}

export function paintCanvas(ctx: CanvasRenderingContext2D, o: CanvasInput): Handle[] {
  const { viewport: vp, dpr, theme } = o;
  const w = Math.max(1, Math.round(vp.width * dpr));
  const h = Math.max(1, Math.round(vp.height * dpr));
  if (ctx.canvas.width !== w || ctx.canvas.height !== h) {
    ctx.canvas.width = w;
    ctx.canvas.height = h;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = rgba(theme.gl.workspace);
  ctx.fillRect(0, 0, w, h);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const S: ToScreen = (x, y) => worldToScreen(o.camera, vp, x, y);
  if (o.image) paintImage(ctx, o, S);
  if (!o.doc) return [];

  const T = theme.overlay;
  const anySelected = o.selection.group !== null;
  // Outlines first (dimmed groups under the selected one), then handles on top.
  const order = [...o.parts].filter((g) => !o.hidden.has(g.id)).sort((a, b) => Number(a.id === o.selection.group) - Number(b.id === o.selection.group));
  for (const g of order) {
    const dim = anySelected && g.id !== o.selection.group;
    for (const item of g.items) {
      const r = resolveShape(o.doc, item.shape);
      if (!r) continue;
      const selected = item.id === o.selection.item;
      const hovered = o.hover?.item === item.id;
      paintShape(ctx, o, S, r, g.color, { dim, selected, hovered, error: o.errors.has(item.id), strand: item.id.startsWith('strand.'), knob: item.shape.type === 'ellipse' && item.shape.rotation !== undefined });
    }
  }
  const handles = visibleHandles(o, S);
  for (const hd of handles) {
    const g = o.parts.find((p) => p.id === hd.group);
    const dim = anySelected && hd.group !== o.selection.group;
    const selectedItem = hd.item === o.selection.item;
    const hot = o.hover?.item === hd.item && o.hover.role === hd.role && (o.hover.index ?? null) === (hd.index ?? null);
    const active = selectedItem && hd.role === 'vertex' && o.selection.vertex === hd.index;
    paintHandle(ctx, T, hd, g?.color ?? T.accent, { dim, selected: selectedItem, hot, active });
  }
  return handles;
}

function paintImage(ctx: CanvasRenderingContext2D, o: CanvasInput, S: ToScreen): void {
  const img = o.image!;
  const [x0, y0] = S(0, 0);
  const [x1, y1] = S(img.width, img.height);
  const T = o.theme;
  // The image area: a checkerboard for transparency, with a soft frame.
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, y0, x1 - x0, y1 - y0);
  ctx.clip();
  ctx.fillStyle = rgba(T.gl.checkA);
  ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  ctx.fillStyle = rgba(T.gl.checkB);
  const cell = 8;
  const sx = Math.max(0, Math.floor(-x0 / cell));
  const sy = Math.max(0, Math.floor(-y0 / cell));
  const ex = Math.min(Math.ceil((x1 - x0) / cell), sx + Math.ceil(o.viewport.width / cell) + 2);
  const ey = Math.min(Math.ceil((y1 - y0) / cell), sy + Math.ceil(o.viewport.height / cell) + 2);
  for (let j = sy; j < ey; j++) for (let i = sx + ((j + sx) % 2 === 0 ? 1 : 0); i < ex; i += 2) ctx.fillRect(x0 + i * cell, y0 + j * cell, cell, cell);
  if (o.source) {
    // Pixels stay crisp when zoomed in (placing landmarks needs them), smooth when zoomed out.
    ctx.imageSmoothingEnabled = o.camera.zoom < 2;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(o.source, x0, y0, x1 - x0, y1 - y0);
  }
  ctx.restore();
  ctx.lineWidth = 1;
  T.overlay.frameShadow.forEach((color, i) => {
    ctx.strokeStyle = color;
    ctx.strokeRect(Math.round(x0) - 0.5 - (i + 1), Math.round(y0) - 0.5 - (i + 1), Math.round(x1 - x0) + 1 + 2 * (i + 1), Math.round(y1 - y0) + 1 + 2 * (i + 1));
  });
  ctx.strokeStyle = T.overlay.frame;
  ctx.strokeRect(Math.round(x0) - 0.5, Math.round(y0) - 0.5, Math.round(x1 - x0) + 1, Math.round(y1 - y0) + 1);
}

function withAlpha(hex: string, a: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function paintShape(
  ctx: CanvasRenderingContext2D,
  o: CanvasInput,
  S: ToScreen,
  r: ResolvedShape,
  color: string,
  f: { dim: boolean; selected: boolean; hovered: boolean; error: boolean; strand: boolean; knob: boolean },
): void {
  const T = o.theme.overlay;
  const alpha = f.dim ? 0.38 : 1;
  const width = f.selected ? 2.25 : f.hovered ? 1.75 : 1.4;
  ctx.beginPath();
  let closed = false;
  switch (r.type) {
    case 'ellipse': {
      const [cx, cy] = S(r.center[0], r.center[1]);
      ctx.ellipse(cx, cy, r.radius[0] * o.camera.zoom, r.radius[1] * o.camera.zoom, (r.rotation * Math.PI) / 180, 0, Math.PI * 2);
      closed = true;
      if (f.selected) {
        // The local axes, faintly: where the radius handles measure.
        const { ux, uy } = ellipseAxes(r.rotation);
        ctx.moveTo(cx, cy);
        ctx.lineTo(...S(r.center[0] + ux[0] * r.radius[0], r.center[1] + ux[1] * r.radius[0]));
        ctx.moveTo(cx, cy);
        ctx.lineTo(...S(r.center[0] + uy[0] * r.radius[1], r.center[1] + uy[1] * r.radius[1]));
        ctx.moveTo(cx, cy);
        const top = S(r.center[0] - uy[0] * r.radius[1], r.center[1] - uy[1] * r.radius[1]);
        ctx.lineTo(...top);
        if (f.knob) {
          // The stem of the rotation knob.
          const len = Math.hypot(top[0] - cx, top[1] - cy) || 1;
          ctx.lineTo(top[0] + ((top[0] - cx) / len) * ROTATION_KNOB, top[1] + ((top[1] - cy) / len) * ROTATION_KNOB);
        }
      }
      break;
    }
    case 'polygon':
    case 'polyline': {
      for (let i = 0; i + 1 < r.points.length; i += 2) {
        const [x, y] = S(r.points[i], r.points[i + 1]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      if (r.type === 'polygon') {
        ctx.closePath();
        closed = true;
      }
      break;
    }
    case 'segment': {
      ctx.moveTo(...S(r.a[0], r.a[1]));
      ctx.lineTo(...S(r.b[0], r.b[1]));
      break;
    }
    case 'band': {
      const img = o.image;
      const x0 = S(0, 0)[0];
      const x1 = S(img?.width ?? 0, 0)[0];
      const ya = S(0, r.range[0])[1];
      const yb = S(0, r.range[1])[1];
      if (f.selected || f.hovered) {
        ctx.fillStyle = withAlpha(color, f.selected ? 0.1 : 0.06);
        ctx.fillRect(x0, Math.min(ya, yb), x1 - x0, Math.abs(yb - ya));
      }
      ctx.setLineDash([6, 5]);
      ctx.moveTo(x0, ya);
      ctx.lineTo(x1, ya);
      ctx.moveTo(x0, yb);
      ctx.lineTo(x1, yb);
      break;
    }
    case 'point':
      return;
  }
  ctx.globalAlpha = alpha;
  if (closed && (f.selected || f.hovered)) {
    ctx.fillStyle = withAlpha(color, f.selected ? 0.16 : 0.08);
    ctx.fill('evenodd');
  }
  if (f.error) ctx.setLineDash([5, 4]);
  ctx.lineWidth = width + 2;
  ctx.strokeStyle = T.halo;
  ctx.stroke();
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.setLineDash([]);
  // A strand points from its root to its tip.
  if (f.strand && r.type === 'polyline' && r.points.length >= 4) {
    const n = r.points.length;
    const [tx, ty] = S(r.points[n - 2], r.points[n - 1]);
    const [px, py] = S(r.points[n - 4], r.points[n - 3]);
    const a = Math.atan2(ty - py, tx - px);
    ctx.beginPath();
    ctx.moveTo(tx + Math.cos(a) * 2, ty + Math.sin(a) * 2);
    ctx.lineTo(tx - Math.cos(a - 0.5) * 9, ty - Math.sin(a - 0.5) * 9);
    ctx.lineTo(tx - Math.cos(a + 0.5) * 9, ty - Math.sin(a + 0.5) * 9);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/**
 * A handle. Parts that are not selected show small solid dots in their group colour (many of them
 * stay readable on any artwork); the selected part shows large white knobs ringed in its colour; the
 * handle under the pointer and the grabbed vertex are filled with the colour. Size handles are
 * rounded squares, band grips capsules.
 */
function paintHandle(ctx: CanvasRenderingContext2D, T: CanvasTheme['overlay'], hd: Handle, color: string, f: { dim: boolean; selected: boolean; hot: boolean; active: boolean }): void {
  const knob = f.selected || f.hot;
  const base = f.selected ? HANDLE_RADIUS_SELECTED - 0.5 : f.dim ? 2.75 : HANDLE_RADIUS - 1.25;
  const r = base + (f.hot ? 1.5 : 0) + (f.active ? 1 : 0);
  ctx.globalAlpha = f.dim && !f.hot ? 0.6 : 1;
  ctx.beginPath();
  switch (hd.role) {
    case 'radiusX':
    case 'radiusY':
      ctx.roundRect(hd.x - r, hd.y - r, r * 2, r * 2, Math.min(2.5, r / 2));
      break;
    case 'bandStart':
    case 'bandEnd':
      ctx.roundRect(hd.x - r - 6, hd.y - r + 1, (r + 6) * 2, (r - 1) * 2, r);
      break;
    default:
      ctx.arc(hd.x, hd.y, r, 0, Math.PI * 2);
  }
  // A dark halo keeps every handle visible on light and dark artwork.
  ctx.lineWidth = knob ? 4 : 3;
  ctx.strokeStyle = T.haloSoft;
  ctx.stroke();
  if (!knob) {
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = T.handleFill;
    ctx.stroke();
  } else {
    const filled = f.active || f.hot;
    ctx.fillStyle = filled ? color : T.handleFill;
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = filled ? T.handleFill : color;
    ctx.stroke();
  }
  if (hd.role === 'center' && knob) {
    ctx.beginPath();
    ctx.arc(hd.x, hd.y, 1.75, 0, Math.PI * 2);
    ctx.fillStyle = f.hot ? T.handleFill : color;
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}
