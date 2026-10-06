/**
 * Viewport camera math (pure). The camera stores the MODEL point shown at the viewport center and a
 * zoom in CSS pixels per model pixel, so resizing the viewport keeps the view centered:
 *   screen = (world - center) * zoom + viewport / 2      (both axes, +y down like the model)
 */

export interface Camera {
  /** Model-space point at the viewport center. */
  cx: number;
  cy: number;
  /** CSS pixels per model pixel. */
  zoom: number;
}

export interface ViewportSize {
  /** CSS pixels. */
  width: number;
  height: number;
}

/** [x, y, w, h] in model space. */
export type Rect = [number, number, number, number];

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 64;

/** Discrete zoom levels used by keyboard zoom (+/-) and shown as "nice" percentages. */
export const ZOOM_STEPS = [0.05, 0.1, 0.125, 0.25, 0.333, 0.5, 0.667, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64];

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export function worldToScreen(cam: Camera, vp: ViewportSize, x: number, y: number): [number, number] {
  return [(x - cam.cx) * cam.zoom + vp.width / 2, (y - cam.cy) * cam.zoom + vp.height / 2];
}

export function screenToWorld(cam: Camera, vp: ViewportSize, sx: number, sy: number): [number, number] {
  return [(sx - vp.width / 2) / cam.zoom + cam.cx, (sy - vp.height / 2) / cam.zoom + cam.cy];
}

/** Zoom by `factor` keeping the model point under screen point (sx, sy) fixed. */
export function zoomAt(cam: Camera, vp: ViewportSize, sx: number, sy: number, factor: number): Camera {
  const zoom = clampZoom(cam.zoom * factor);
  const [wx, wy] = screenToWorld(cam, vp, sx, sy);
  // Solve (wx - cx') * zoom + w/2 = sx for cx'.
  return { zoom, cx: wx - (sx - vp.width / 2) / zoom, cy: wy - (sy - vp.height / 2) / zoom };
}

/** Pan by a screen-space delta (content follows the pointer). */
export function panBy(cam: Camera, dx: number, dy: number): Camera {
  return { ...cam, cx: cam.cx - dx / cam.zoom, cy: cam.cy - dy / cam.zoom };
}

/** Camera showing `rect` entirely, centered, with `padding` CSS px of margin on every side. */
export function fitRect(rect: Rect, vp: ViewportSize, padding = 32): Camera {
  const [x, y, w, h] = rect;
  const availW = Math.max(1, vp.width - padding * 2);
  const availH = Math.max(1, vp.height - padding * 2);
  const zoom = clampZoom(Math.min(availW / Math.max(w, 1e-6), availH / Math.max(h, 1e-6)));
  return { cx: x + w / 2, cy: y + h / 2, zoom };
}

/** Visible model-space rectangle of the viewport. */
export function visibleRect(cam: Camera, vp: ViewportSize): Rect {
  const w = vp.width / cam.zoom;
  const h = vp.height / cam.zoom;
  return [cam.cx - w / 2, cam.cy - h / 2, w, h];
}

/**
 * CSS px of the viewport covered by floating chrome on each side (toolbar, sidebars, drawer). The
 * canvas is full-bleed; what is not covered is the "free area" the model is framed in.
 */
export interface ViewInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const NO_INSETS: ViewInsets = { top: 0, right: 0, bottom: 0, left: 0 };

/** Size of the free area (at least 1 px, so that a tiny window never divides by zero). */
export function freeSize(vp: ViewportSize, insets: ViewInsets): ViewportSize {
  return { width: Math.max(1, vp.width - insets.left - insets.right), height: Math.max(1, vp.height - insets.top - insets.bottom) };
}

/** Centre of the free area in viewport (CSS px) coordinates. */
export function freeCenter(vp: ViewportSize, insets: ViewInsets): [number, number] {
  const size = freeSize(vp, insets);
  return [insets.left + size.width / 2, insets.top + size.height / 2];
}

/** Model-space rectangle visible in the free area (the whole viewport when nothing covers it). */
export function visibleFreeRect(cam: Camera, vp: ViewportSize, insets: ViewInsets): Rect {
  const size = freeSize(vp, insets);
  const [x, y] = screenToWorld(cam, vp, insets.left, insets.top);
  return [x, y, size.width / cam.zoom, size.height / cam.zoom];
}

/**
 * Wheel delta -> multiplicative zoom factor. Pixel-mode trackpads send small deltas, line/page-mode
 * mice send units of lines; both map to a smooth exponential curve (one mouse notch ~ 1.2x).
 */
export function wheelZoomFactor(deltaY: number, deltaMode = 0): number {
  const px = deltaMode === 1 ? deltaY * 33 : deltaMode === 2 ? deltaY * 400 : deltaY;
  const clamped = Math.max(-300, Math.min(300, px));
  return Math.exp(-clamped * 0.0018);
}

/** Next discrete zoom level above (dir > 0) or below (dir < 0) the current zoom. */
export function stepZoom(zoom: number, dir: 1 | -1): number {
  const eps = 1e-3;
  if (dir > 0) return ZOOM_STEPS.find((z) => z > zoom * (1 + eps)) ?? MAX_ZOOM;
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) if (ZOOM_STEPS[i] < zoom * (1 - eps)) return ZOOM_STEPS[i];
  return MIN_ZOOM;
}

/** Union of rectangles, null when empty. */
export function unionRects(rects: Iterable<Rect | null | undefined>): Rect | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    if (!r || !r.every(Number.isFinite)) continue;
    x0 = Math.min(x0, r[0]);
    y0 = Math.min(y0, r[1]);
    x1 = Math.max(x1, r[0] + r[2]);
    y1 = Math.max(y1, r[1] + r[3]);
  }
  return x0 === Infinity ? null : [x0, y0, x1 - x0, y1 - y0];
}

/**
 * World -> clip-space affine for the GL renderer: clip = world * scale + offset (y flipped because
 * clip space is +y up while the model is +y down). `dpr` does not matter here: clip space is
 * resolution independent.
 */
export function clipTransform(cam: Camera, vp: ViewportSize): [number, number, number, number] {
  const sx = (2 * cam.zoom) / vp.width;
  const sy = (-2 * cam.zoom) / vp.height;
  return [sx, sy, -cam.cx * sx, -cam.cy * sy];
}

/** Round a model-space rect for publishing (0.01 px is far below anything visible). */
export function roundRect(r: Rect): Rect {
  return r.map((v) => Math.round(v * 100) / 100) as Rect;
}

/** Human-readable zoom, e.g. "100%", "12.5%", "3200%". */
export function formatZoom(zoom: number): string {
  const pct = zoom * 100;
  return `${pct >= 100 ? Math.round(pct) : Math.round(pct * 10) / 10}%`;
}
