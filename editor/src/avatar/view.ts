/**
 * The avatar canvas camera (pure): the editor's camera math (view/camera.ts) with the zoom range of
 * this mode (10 % to 1600 %) and framing inside the free area (the part the floating chrome leaves
 * uncovered).
 */
import { fitRect, freeCenter, freeSize, screenToWorld, worldToScreen, type Camera, type Rect, type ViewInsets, type ViewportSize } from '../view/camera.js';

export const AVATAR_MIN_ZOOM = 0.1;
export const AVATAR_MAX_ZOOM = 16;
/** Zoom levels of the +/- buttons and keys. */
export const AVATAR_ZOOM_STEPS = [0.1, 0.125, 0.167, 0.25, 0.333, 0.5, 0.667, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16];

export function clampAvatarZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(AVATAR_MAX_ZOOM, Math.max(AVATAR_MIN_ZOOM, zoom));
}

/** Zoom by `factor` around screen point (sx, sy), kept inside the mode's zoom range. */
export function zoomAround(cam: Camera, vp: ViewportSize, sx: number, sy: number, factor: number): Camera {
  const zoom = clampAvatarZoom(cam.zoom * factor);
  // As zoomAt (view/camera.ts), with the exact target zoom (no 3.9999 % from a round trip).
  const [wx, wy] = screenToWorld(cam, vp, sx, sy);
  return { zoom, cx: wx - (sx - vp.width / 2) / zoom, cy: wy - (sy - vp.height / 2) / zoom };
}

/** The next zoom level up (dir 1) or down (dir -1). */
export function stepAvatarZoom(zoom: number, dir: 1 | -1): number {
  const eps = 1e-3;
  if (dir > 0) return AVATAR_ZOOM_STEPS.find((z) => z > zoom * (1 + eps)) ?? AVATAR_MAX_ZOOM;
  for (let i = AVATAR_ZOOM_STEPS.length - 1; i >= 0; i--) if (AVATAR_ZOOM_STEPS[i] < zoom * (1 - eps)) return AVATAR_ZOOM_STEPS[i];
  return AVATAR_MIN_ZOOM;
}

/** Zoom to an absolute level around the centre of the free area. */
export function zoomToLevel(cam: Camera, vp: ViewportSize, insets: ViewInsets, zoom: number): Camera {
  const [cx, cy] = freeCenter(vp, insets);
  const target = clampAvatarZoom(zoom);
  const [wx, wy] = screenToWorld(cam, vp, cx, cy);
  return { zoom: target, cx: wx - (cx - vp.width / 2) / target, cy: wy - (cy - vp.height / 2) / target };
}

/**
 * The camera that shows `rect` (image px) centred in the free area with `padding` CSS px around it;
 * `maxZoom` keeps tiny rects (a point) from filling the screen.
 */
export function frameRect(rect: Rect, vp: ViewportSize, insets: ViewInsets, padding = 32, maxZoom = 8): Camera {
  const [x, y, w, h] = rect;
  // A point or a line has no area: frame a little neighbourhood instead.
  const minSide = 24;
  const r: Rect = [x - Math.max(0, minSide - w) / 2, y - Math.max(0, minSide - h) / 2, Math.max(w, minSide), Math.max(h, minSide)];
  const fit = fitRect(r, freeSize(vp, insets), padding);
  const zoom = clampAvatarZoom(Math.min(fit.zoom, maxZoom));
  const [fx, fy] = freeCenter(vp, insets);
  return { zoom, cx: fit.cx - (fx - vp.width / 2) / zoom, cy: fit.cy - (fy - vp.height / 2) / zoom };
}

/** Image px -> canvas CSS px and back, for a camera and viewport. */
export function projector(cam: Camera, vp: ViewportSize): { toScreen: (x: number, y: number) => [number, number]; toImage: (x: number, y: number) => [number, number] } {
  return { toScreen: (x, y) => worldToScreen(cam, vp, x, y), toImage: (x, y) => screenToWorld(cam, vp, x, y) };
}

/** "100%", "12.5%". */
export function zoomLabel(zoom: number): string {
  const pct = zoom * 100;
  return `${pct >= 100 ? Math.round(pct) : Math.round(pct * 10) / 10}%`;
}
