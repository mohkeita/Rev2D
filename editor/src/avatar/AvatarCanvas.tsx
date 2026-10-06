/**
 * The canvas of avatar mode: the SOURCE illustration on a checkerboard with every part of the spec
 * drawn as handles in its group colour (draw.ts), full-bleed under the floating chrome.
 *
 * Pointer: drag a handle to move it (Shift snaps a rotation to 15°); Alt-click a vertex removes it;
 * double-click an edge of a polygon / polyline inserts a vertex; drag the body of the SELECTED part
 * to move it whole; click a part to select it; drag empty space (or Space-drag, middle-drag) to pan;
 * wheel / pinch zooms at the cursor (10 % to 1600 %). While a part waits to be placed, a click places
 * it. Hovering a handle shows "<group> · <part> · <handle>"; the pointer position in image pixels
 * goes to the status line.
 */
import { useEffect, useRef, useState } from 'react';
import { resolveShape } from '../../../src/avatar/parts.js';
import { ContextMenu, type MenuEntry } from '../design/index.js';
import { useT } from '../i18n/index.js';
import { readCanvasTheme, type CanvasTheme } from '../overlay/theme.js';
import { useSettings } from '../shell/settings.js';
import { useSession } from '../state/context.js';
import { keyState } from '../ui/keys.js';
import { useAi } from './ai.js';
import { fitItem, itemMenu, placeAt } from './actions.js';
import { paintCanvas, visibleHandles } from './draw.js';
import {
  dragHandle,
  hitBody,
  hitEdge,
  hitBandLine,
  hitHandle,
  insertVertex,
  isCircle,
  MIN_VERTICES,
  removeVertex,
  translateItem,
  type Grab,
  type Handle,
  type HitShape,
  type SpecDoc,
} from './geometry.js';
import { shallowEqual, useAvatar } from './hooks.js';
import { groupLabel, handleLabel, itemLabel } from './labels.js';
import { problemsByItem } from './problems.js';
import { avatarStore } from './store.js';
import { panBy, wheelZoomFactor } from '../view/camera.js';
import { projector, zoomAround } from './view.js';
import './avatar-canvas.css';

/** Pointer travel (CSS px) below which a press is a click. */
const CLICK_SLOP = 4;

type Drag =
  | { kind: 'handle'; id: number; grab: Grab; moved: boolean }
  | { kind: 'move'; id: number; item: string; start: [number, number]; base: SpecDoc; moved: boolean }
  | { kind: 'pan'; id: number; x: number; y: number }
  | { kind: 'press'; id: number; x: number; y: number; sx: number; sy: number; moved: boolean };

/** Placed items of the visible groups, for hit tests. */
function hitShapes(only?: string | null): HitShape[] {
  const s = avatarStore.get();
  if (!s.doc) return [];
  const out: HitShape[] = [];
  for (const g of s.parts) {
    if (s.hidden.includes(g.id)) continue;
    for (const item of g.items) {
      if (only !== undefined && item.id !== only) continue;
      const resolved = resolveShape(s.doc, item.shape);
      if (resolved) out.push({ item: item.id, group: g.id, shape: item.shape, resolved });
    }
  }
  return out;
}

export function AvatarCanvas() {
  const session = useSession();
  const t = useT();
  const ai = useAi();
  const { resolvedAppearance } = useSettings();
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const theme = useRef<CanvasTheme | null>(null);
  const request = useRef<() => void>(() => {});
  const drag = useRef<Drag | null>(null);
  const contextItem = useRef<string | null>(null);
  const [cursor, setCursor] = useState<string>('default');
  const placing = useAvatar((s) => s.placing);
  const hover = useAvatar((s) => s.hover, shallowEqual);

  useEffect(() => {
    theme.current = null;
    request.current();
  }, [resolvedAppearance]);

  // Drawing: on demand, whenever the avatar state, the viewport or the chrome's insets change.
  useEffect(() => {
    const el = host.current!;
    const ctx = canvas.current!.getContext('2d');
    let raf = 0;
    let lastInsets = '';
    const frame = (): void => {
      raf = 0;
      const s = avatarStore.get();
      // The part of the canvas the chrome covers, as the shell reports it.
      const inset = session.getInsets();
      const key = `${inset.top}|${inset.right}|${inset.bottom}|${inset.left}`;
      if (key !== lastInsets) {
        lastInsets = key;
        avatarStore.setViewport(s.viewport, inset);
      }
      if (!ctx || s.viewport.width <= 0) return;
      theme.current ??= readCanvasTheme();
      const st = avatarStore.get();
      const errors = new Set<string>();
      if (st.doc) for (const [item, list] of problemsByItem(st.doc, st.diagnostics)) if (item && list.some((d) => d.severity === 'error' && d.code !== 'avatar-missing-landmark')) errors.add(item);
      paintCanvas(ctx, {
        theme: theme.current,
        camera: st.camera,
        viewport: st.viewport,
        dpr: window.devicePixelRatio || 1,
        source: avatarStore.source,
        image: st.image,
        doc: st.doc,
        parts: st.parts,
        hidden: new Set(st.hidden),
        selection: st.selection,
        hover: st.hover,
        bandX: bandX(),
        errors,
      });
    };
    const req = (): void => {
      if (!raf) raf = requestAnimationFrame(frame);
    };
    request.current = req;
    // Only what the canvas shows asks for a frame (not the preview's clock or the lip sync).
    const drawn = (st: ReturnType<typeof avatarStore.get>): unknown[] => [st.doc, st.parts, st.camera, st.viewport, st.selection, st.hover, st.hidden, st.image, st.sourceVersion, st.diagnostics];
    let seen = drawn(avatarStore.get());
    const unsubscribe = avatarStore.store.subscribe(() => {
      const now = drawn(avatarStore.get());
      if (now.some((v, i) => !Object.is(v, seen[i]))) {
        seen = now;
        req();
      }
    });
    // The shell reports chrome changes (panes resized) through the session's frame requester.
    session.setFrameRequester(req);
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      avatarStore.setViewport({ width: Math.round(r.width), height: Math.round(r.height) }, session.getInsets());
      req();
    });
    ro.observe(el);
    req();
    return () => {
      if (raf) cancelAnimationFrame(raf);
      unsubscribe();
      ro.disconnect();
      session.setFrameRequester(() => {});
      request.current = () => {};
    };
  }, [session]);

  // Wheel zoom (non-passive: the page must not scroll).
  useEffect(() => {
    const el = host.current!;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const s = avatarStore.get();
      const r = el.getBoundingClientRect();
      avatarStore.setCamera(zoomAround(s.camera, s.viewport, e.clientX - r.left, e.clientY - r.top, wheelZoomFactor(e.deltaY, e.deltaMode)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  /** Screen x of the band grips: near the right edge of the illustration, inside the free area. */
  function bandX(): number {
    const s = avatarStore.get();
    const inset = session.getInsets();
    const { toScreen } = projector(s.camera, s.viewport);
    const right = toScreen(s.image?.width ?? 0, 0)[0];
    return Math.max(inset.left + 24, Math.min(right - 18, s.viewport.width - inset.right - 24));
  }

  const local = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = host.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  const handlesNow = () => {
    const s = avatarStore.get();
    const { toScreen } = projector(s.camera, s.viewport);
    return visibleHandles({ doc: s.doc, parts: s.parts, hidden: new Set(s.hidden), selection: s.selection, bandX: bandX() }, toScreen);
  };

  /** The handle under a screen point: a handle, else a line of a band (bands drag anywhere along them). */
  const grabAt = (x: number, y: number): Handle | null => {
    const h = hitHandle(handlesNow(), x, y);
    if (h) return h;
    const s = avatarStore.get();
    if (!s.image) return null;
    const { toScreen } = projector(s.camera, s.viewport);
    return hitBandLine(hitShapes(), x, y, toScreen, toScreen(0, 0)[0], toScreen(s.image.width, 0)[0]);
  };

  // Two fingers on a touch screen pinch-zoom and pan.
  const touches = useRef(new Map<number, [number, number]>());
  const pinch = useRef<{ mid: [number, number]; dist: number } | null>(null);
  const pinchState = (): { mid: [number, number]; dist: number } => {
    const [a, b] = [...touches.current.values()];
    return { mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], dist: Math.max(1, Math.hypot(a[0] - b[0], a[1] - b[1])) };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    const [x, y] = local(e);
    if (e.pointerType === 'touch') {
      touches.current.set(e.pointerId, [x, y]);
      if (touches.current.size === 2) {
        // A second finger: whatever the first one started becomes a pinch.
        const d = drag.current;
        if (d && (d.kind === 'handle' || d.kind === 'move')) avatarStore.endGesture();
        drag.current = null;
        e.currentTarget.setPointerCapture(e.pointerId);
        pinch.current = pinchState();
        return;
      }
    }
    if (drag.current || pinch.current) return;
    const s = avatarStore.get();
    const { toImage } = projector(s.camera, s.viewport);
    if (e.button === 1 || (e.button === 0 && keyState.space)) {
      if (keyState.space) keyState.spaceUsed = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { kind: 'pan', id: e.pointerId, x, y };
      setCursor('grabbing');
      e.preventDefault();
      return;
    }
    if (e.button !== 0 || !s.doc) return;
    if (s.placing) {
      placeAt(s.placing, toImage(x, y));
      return;
    }
    const h = grabAt(x, y);
    if (h) {
      const item = avatarStore.item(h.item);
      if (!item) return;
      if (e.altKey && h.role === 'vertex') {
        const min = item.shape.type === 'polyline' ? MIN_VERTICES.polyline : MIN_VERTICES.polygon;
        const next = removeVertex(s.doc, h.pointer, h.index ?? -1, min);
        if (next) avatarStore.edit(t('avatar.history.removePoint', { item: itemLabel(t, item, s.doc) }), next);
        else session.toast('info', t('avatar.toast.minPoints', { n: min }));
        avatarStore.select(h.item, h.group, null);
        return;
      }
      const r = resolveShape(s.doc, item.shape);
      const grab: Grab = {
        role: h.role,
        pointer: h.pointer,
        ...(h.index !== undefined ? { index: h.index } : {}),
        ...(r?.type === 'ellipse' ? { ellipse: { center: r.center, radius: r.radius, rotation: r.rotation, circle: isCircle(s.doc, item.shape) } } : {}),
      };
      avatarStore.select(h.item, h.group, h.role === 'vertex' ? (h.index ?? null) : null);
      avatarStore.beginGesture(t('avatar.history.move', { item: itemLabel(t, item, s.doc) }));
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { kind: 'handle', id: e.pointerId, grab, moved: false };
      setCursor('grabbing');
      return;
    }
    // The body of the selected part moves it whole.
    const sel = s.selection.item;
    if (sel) {
      const at = toImage(x, y);
      if (hitBody(hitShapes(sel), at[0], at[1], 1 / s.camera.zoom).includes(sel)) {
        const item = avatarStore.item(sel)!;
        avatarStore.beginGesture(t('avatar.history.move', { item: itemLabel(t, item, s.doc) }));
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { kind: 'move', id: e.pointerId, item: sel, start: at, base: s.doc, moved: false };
        setCursor('move');
        return;
      }
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { kind: 'press', id: e.pointerId, x, y, sx: x, sy: y, moved: false };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const [x, y] = local(e);
    if (touches.current.has(e.pointerId)) touches.current.set(e.pointerId, [x, y]);
    if (pinch.current && touches.current.size === 2) {
      const s = avatarStore.get();
      const before = pinch.current;
      const now = pinchState();
      const panned = panBy(s.camera, now.mid[0] - before.mid[0], now.mid[1] - before.mid[1]);
      avatarStore.setCamera(zoomAround(panned, s.viewport, now.mid[0], now.mid[1], now.dist / before.dist));
      pinch.current = now;
      return;
    }
    const s = avatarStore.get();
    const { toImage } = projector(s.camera, s.viewport);
    const p = toImage(x, y);
    avatarStore.setPointer([Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]);
    const d = drag.current;
    if (d && d.id === e.pointerId) {
      if (d.kind === 'pan' || (d.kind === 'press' && (d.moved || Math.hypot(x - d.sx, y - d.sy) > CLICK_SLOP))) {
        avatarStore.setCamera(panBy(s.camera, x - d.x, y - d.y));
        d.x = x;
        d.y = y;
        if (d.kind === 'press') {
          d.moved = true;
          setCursor('grabbing');
        }
        return;
      }
      if (d.kind === 'handle' && s.doc) {
        d.moved = true;
        avatarStore.gestureUpdate(dragHandle(s.doc, d.grab, p, { snap: e.shiftKey }));
        return;
      }
      if (d.kind === 'move') {
        const item = avatarStore.item(d.item);
        if (!item) return;
        d.moved = true;
        avatarStore.gestureUpdate(translateItem(d.base, item.shape, p[0] - d.start[0], p[1] - d.start[1]));
        return;
      }
      return;
    }
    if (s.placing) {
      setCursor('crosshair');
      return;
    }
    const h = grabAt(x, y);
    avatarStore.setHover(h ? { item: h.item, role: h.role, index: h.index ?? null, x, y } : null);
    if (h) setCursor(h.role === 'bandStart' || h.role === 'bandEnd' ? 'ns-resize' : 'grab');
    else {
      const sel = s.selection.item;
      setCursor(sel && hitBody(hitShapes(sel), p[0], p[1], 1 / s.camera.zoom).includes(sel) ? 'move' : 'default');
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    touches.current.delete(e.pointerId);
    if (pinch.current) {
      if (touches.current.size < 2) pinch.current = null;
      return;
    }
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    setCursor('default');
    if (d.kind === 'handle' || d.kind === 'move') {
      avatarStore.endGesture();
      return;
    }
    if (d.kind === 'press' && !d.moved) {
      // A click: select the smallest part under the pointer (or nothing).
      const s = avatarStore.get();
      const { toImage } = projector(s.camera, s.viewport);
      const [px, py] = toImage(d.sx, d.sy);
      const hits = hitBody(hitShapes(), px, py, 1 / s.camera.zoom);
      avatarStore.select(hits[0] ?? null, hits[0] ? undefined : null);
    }
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    const [x, y] = local(e);
    const s = avatarStore.get();
    if (!s.doc || s.placing) return;
    if (grabAt(x, y)) return;
    const { toScreen, toImage } = projector(s.camera, s.viewport);
    const edge = hitEdge(hitShapes(), x, y, toScreen, toImage);
    if (edge) {
      const item = avatarStore.item(edge.item);
      if (item && avatarStore.edit(t('avatar.history.addPoint', { item: itemLabel(t, item, s.doc) }), insertVertex(s.doc, edge.pointer, edge.edge, edge.at))) avatarStore.select(edge.item, undefined, edge.edge + 1);
      return;
    }
    const [px, py] = toImage(x, y);
    const hit = hitBody(hitShapes(), px, py, 1 / s.camera.zoom)[0];
    if (hit) fitItem(hit);
  };

  const onPointerLeave = (): void => {
    if (drag.current) return;
    avatarStore.setPointer(null);
    avatarStore.setHover(null);
  };

  // What the right-clicked spot is: a handle's part, else the smallest part under it.
  const onContextMenuCapture = (e: React.MouseEvent<HTMLDivElement>): void => {
    const [x, y] = local(e);
    const s = avatarStore.get();
    const h = hitHandle(handlesNow(), x, y);
    let id = h?.item ?? null;
    if (!id) {
      const { toImage } = projector(s.camera, s.viewport);
      const [px, py] = toImage(x, y);
      id = hitBody(hitShapes(), px, py, 1 / s.camera.zoom)[0] ?? null;
    }
    contextItem.current = id;
    if (id) avatarStore.select(id);
  };

  const menuItems = (): MenuEntry[] => {
    const item = avatarStore.item(contextItem.current);
    return item ? itemMenu(t, item, ai !== null) : [];
  };

  const doc = useAvatar((s) => s.doc);
  const hoverItem = hover ? avatarStore.item(hover.item) : null;
  const hoverGroup = hoverItem ? avatarStore.get().parts.find((g) => g.items.includes(hoverItem)) : null;
  const tip = hover && hoverItem && hoverGroup ? [groupLabel(t, hoverGroup.id), itemLabel(t, hoverItem, doc), hover.role ? handleLabel(t, hoverItem, hover.role, hover.index ?? undefined) : null].filter(Boolean).join(' · ') : null;

  return (
    <ContextMenu items={menuItems}>
      <div
        ref={host}
        className="ed-avcanvas"
        style={{ cursor: placing ? 'crosshair' : cursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerLeave}
        onDoubleClick={onDoubleClick}
        onContextMenuCapture={onContextMenuCapture}
        data-placing={placing ? '' : undefined}
        data-testid="avatar-canvas"
      >
        <canvas ref={canvas} className="ed-avcanvas-2d" />
        {tip && !drag.current && (
          <div className="ed-avcanvas-tip" style={{ left: hover!.x + 14, top: hover!.y + 16 }} role="tooltip" data-testid="avatar-tooltip">
            {tip}
          </div>
        )}
      </div>
    </ContextMenu>
  );
}
