/**
 * The viewport: WebGL2 canvas (model) + Canvas 2D overlay, camera navigation and picking. It is the
 * full-bleed main area of the Rig mode: it runs edge to edge under the floating chrome, and its
 * controls (zoom / framing: ViewControls) and messages sit in the part the chrome leaves free
 * (`--r2-safe-*`, published by the shell's SplitView; the session gets the same insets and frames
 * the model in the free area).
 *
 * Rendering is demand-driven: a frame is scheduled on any store change and while playing; a frame
 * redraws only when one of its inputs changed. The workspace, checkerboard, frame, selection and
 * handle colours come from the design tokens (overlay/theme.ts) and follow the appearance.
 */
import { useEffect, useRef, useState } from 'react';
import { Button, EmptyState, IconButton, Spinner, Toolbar, ToolbarGroup, ToolbarSeparator } from '../design/index.js';
import { useT } from '../i18n/index.js';
import { errorCount } from '../state/app.js';
import { useApp, useSession } from '../state/context.js';
import { parseRefKey, type EntityRef } from '../state/doc.js';
import type { Session } from '../state/session.js';
import { GlRenderer } from '../gl/renderer.js';
import { drawOverlay } from '../overlay/draw.js';
import { rigHighlight } from '../overlay/highlight.js';
import { readCanvasTheme, type CanvasTheme } from '../overlay/theme.js';
import { useSettings } from '../shell/settings.js';
import { formatZoom, panBy, screenToWorld, stepZoom, wheelZoomFactor, zoomAt } from '../view/camera.js';
import { cyclePick, pickBone, pickParts } from '../view/picking.js';
import { keyState } from '../ui/keys.js';
import './viewport.css';

/** Screen radius (CSS px) within which a click selects a bone joint. */
const BONE_PICK_PX = 9;
/** Pointer travel (CSS px) below which a press counts as a click. */
const CLICK_SLOP = 4;

export function Viewport() {
  const session = useSession();
  const { resolvedAppearance } = useSettings();
  const host = useRef<HTMLDivElement>(null);
  const glCanvas = useRef<HTMLCanvasElement>(null);
  const overlayCanvas = useRef<HTMLCanvasElement>(null);
  const [panning, setPanning] = useState(false);
  /** Colours read from the design tokens; null = read them again in the next frame. */
  const theme = useRef<CanvasTheme | null>(null);
  const requestRef = useRef<() => void>(() => {});

  // The appearance attribute is applied by an effect above this component: read the tokens in the
  // next frame, when it is in place.
  useEffect(() => {
    theme.current = null;
    requestRef.current();
  }, [resolvedAppearance]);

  useEffect(() => {
    const el = host.current!;
    const gl = glCanvas.current!;
    const ov = overlayCanvas.current!;
    const ctx = ov.getContext('2d');
    let renderer: GlRenderer | null = null;
    let raf = 0;
    let disposed = false;
    const request = (): void => {
      if (!raf && !disposed) raf = requestAnimationFrame(loop);
    };
    requestRef.current = request;
    /** Inputs of the last drawn frame; a frame is drawn only when one of them changed. */
    const last: unknown[] = [];
    try {
      // A restored context starts empty: redraw although no input changed.
      renderer = new GlRenderer(gl, () => {
        last.length = 0;
        request();
      });
    } catch (e) {
      session.store.set({ glError: e instanceof Error ? e.message : String(e) });
    }

    let fpsFrames = 0;
    let fpsSince = performance.now();
    const loop = (now: number): void => {
      raf = 0;
      session.tick(now);
      const frame = session.evaluate();
      const s = session.get();
      const dpr = window.devicePixelRatio || 1;
      theme.current ??= readCanvasTheme();
      const colors = theme.current;
      const insets = session.getInsets();
      const inputs = [frame, s.model, s.camera, s.viewport, dpr, s.overlays, s.background, s.hidden, s.selection, s.hover, session.textureVersion, colors, insets];
      const dirty = inputs.length !== last.length || inputs.some((v, i) => !Object.is(v, last[i]));
      if (dirty && s.viewport.width > 0 && s.viewport.height > 0) {
        last.splice(0, last.length, ...inputs);
        const hidden = new Set(s.hidden);
        if (renderer) {
          renderer.setTextures(session.textures, session.textureVersion);
          const stats = renderer.render({
            list: frame?.list ?? null,
            camera: s.camera,
            viewport: s.viewport,
            dpr,
            background: s.background,
            hidden,
            colors: colors.gl,
          });
          session.renderStats.draws = stats.draws;
          session.renderStats.triangles = stats.triangles;
          // Counters show at once (the fps tick below only runs while frames keep coming).
          const shown = session.get().stats;
          if (shown.draws !== stats.draws || shown.triangles !== stats.triangles) {
            session.store.set({ stats: { ...shown, draws: stats.draws, triangles: stats.triangles } });
          }
        }
        if (ctx) {
          drawOverlay(ctx, {
            model: s.model,
            pose: frame?.pose ?? null,
            draws: frame?.list.draws ?? [],
            camera: s.camera,
            viewport: s.viewport,
            dpr,
            layers: new Set(s.overlays),
            selection: s.selection.map(parseRefKey).filter((r): r is EntityRef => r !== null),
            hover: s.hover ? parseRefKey(s.hover) : null,
            hidden,
            theme: colors.overlay,
            insets,
          });
        }
        session.renderStats.frames++;
        session.renderStats.lastDrawAt = now;
        fpsFrames++;
      }
      if (now - fpsSince >= 500) {
        const fps = Math.round((fpsFrames * 1000) / (now - fpsSince));
        fpsFrames = 0;
        fpsSince = now;
        session.store.set({ stats: { fps, draws: session.renderStats.draws, triangles: session.renderStats.triangles } });
      }
      if (session.get().playing) request();
    };

    session.setFrameRequester(request);
    const unsubscribe = session.store.subscribe(request);
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      session.setViewport({ width: Math.round(r.width), height: Math.round(r.height) });
      request();
    });
    ro.observe(el);
    const media = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    media.addEventListener('change', request);
    request();
    return () => {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      unsubscribe();
      ro.disconnect();
      media.removeEventListener('change', request);
      session.setFrameRequester(() => {});
      requestRef.current = () => {};
      renderer?.dispose();
    };
  }, [session]);

  // Wheel zoom needs a non-passive listener to prevent page scrolling.
  useEffect(() => {
    const el = host.current!;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const s = session.get();
      const r = el.getBoundingClientRect();
      session.setCamera(zoomAt(s.camera, s.viewport, e.clientX - r.left, e.clientY - r.top, wheelZoomFactor(e.deltaY, e.deltaMode)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [session]);

  const drag = useRef<{ id: number; mode: 'pan' | 'click'; x: number; y: number; moved: boolean } | null>(null);
  const lastClick = useRef<{ x: number; y: number } | null>(null);

  const localPoint = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = host.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (drag.current) return;
    const [x, y] = localPoint(e);
    const pan = e.button === 1 || e.button === 2 || (e.button === 0 && keyState.space);
    if (!pan && e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, mode: pan ? 'pan' : 'click', x, y, moved: false };
    if (pan) {
      if (keyState.space) keyState.spaceUsed = true;
      setPanning(true);
      e.preventDefault();
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const [x, y] = localPoint(e);
    const s = session.get();
    const d = drag.current;
    if (d && d.id === e.pointerId) {
      if (Math.hypot(x - d.x, y - d.y) > CLICK_SLOP) d.moved = true;
      if (d.mode === 'pan') {
        session.setCamera(panBy(s.camera, x - d.x, y - d.y));
        d.x = x;
        d.y = y;
      }
    }
    const [wx, wy] = screenToWorld(s.camera, s.viewport, x, y);
    session.setPointer([wx, wy]);
    if (!d || d.mode !== 'pan') session.setHover(hitAt(session, wx, wy));
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    setPanning(false);
    if (d.mode !== 'click' || d.moved) return;
    const [x, y] = localPoint(e);
    const s = session.get();
    const [wx, wy] = screenToWorld(s.camera, s.viewport, x, y);
    const sameSpot = lastClick.current !== null && Math.hypot(x - lastClick.current.x, y - lastClick.current.y) <= CLICK_SLOP;
    lastClick.current = { x, y };
    const toggle = e.shiftKey || e.ctrlKey || e.metaKey;
    const bone = boneAt(session, wx, wy);
    if (bone) {
      session.select([`bone:${bone}`], toggle ? 'toggle' : 'replace');
      return;
    }
    const frame = session.currentFrame();
    const hits = frame ? pickParts(frame.list.draws, wx, wy, new Set(s.hidden)) : [];
    const current = s.selection.length === 1 && s.selection[0].startsWith('part:') ? s.selection[0].slice(5) : null;
    const id = cyclePick(hits, current, sameSpot);
    if (id) session.select([`part:${id}`], toggle ? 'toggle' : 'replace');
    else if (!toggle) session.select([]);
  };

  const onPointerLeave = (): void => {
    if (drag.current) return;
    session.setPointer(null);
    session.setHover(null);
  };

  return (
    <div
      ref={host}
      className="ed-viewport"
      data-panning={panning ? '' : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={onPointerLeave}
      // A second click on what the first one selected: show it in the inspector.
      onDoubleClick={() => {
        const selection = session.get().selection;
        if (selection.length) session.inspect(selection);
      }}
      onContextMenu={(e) => e.preventDefault()}
      data-testid="viewport"
    >
      <canvas ref={glCanvas} className="ed-viewport-gl" data-testid="viewport-gl" />
      <canvas ref={overlayCanvas} className="ed-viewport-overlay" />
    </div>
  );
}

function boneAt(session: Session, wx: number, wy: number): string | null {
  const s = session.get();
  const frame = session.currentFrame();
  if (!frame || !s.model) return null;
  // Highlighted bones (selected, or of a selected IK constraint / physics group) are drawn, hence
  // pickable, even when the bones layer is off.
  const highlighted = rigHighlight(s.model, s.selection.map(parseRefKey).filter((r): r is EntityRef => r !== null)).bones;
  const showBones = s.overlays.includes('bones');
  const bones = s.model.bones
    .filter((b) => showBones || highlighted.has(b.id))
    .map((b) => ({ id: b.id, x: frame.pose.bones[b.id].x, y: frame.pose.bones[b.id].y, tip: frame.pose.bones[b.id].tip }));
  return pickBone(bones, wx, wy, BONE_PICK_PX / s.camera.zoom);
}

/** Hover key under a model point: a bone joint first, then the top-most part. */
function hitAt(session: Session, wx: number, wy: number): string | null {
  const bone = boneAt(session, wx, wy);
  if (bone) return `bone:${bone}`;
  const frame = session.currentFrame();
  if (!frame) return null;
  const top = pickParts(frame.list.draws, wx, wy, new Set(session.get().hidden))[0];
  return top ? `part:${top}` : null;
}

/** What the viewport says when it has nothing to draw: centred in the free area. */
export function ViewportMessages() {
  const session = useSession();
  const t = useT();
  const status = useApp((s) => s.status);
  const hasModel = useApp((s) => s.model !== null);
  const errors = useApp((s) => errorCount(s.diagnostics));
  const glError = useApp((s) => s.glError);
  let content: React.ReactNode = null;
  if (glError) {
    content = <EmptyState icon="error" title={t('viewport.unavailable.title')} description={`${glError} ${t('viewport.unavailable.text')}`} />;
  } else if (status === 'loading' && !hasModel) {
    content = <Spinner size={24} aria-label={t('common.loading')} />;
  } else if (status === 'ready' && !hasModel) {
    content = (
      <EmptyState
        icon="warning"
        title={t('viewport.nothing.title')}
        description={t('viewport.nothing.text', { n: errors })}
        actions={
          <Button variant="tinted" onClick={() => session.showProblems()}>
            {t('viewport.showProblems')}
          </Button>
        }
      />
    );
  }
  if (!content) return null;
  return (
    <div className="ed-viewport-message" onPointerDown={(e) => e.stopPropagation()}>
      {content}
    </div>
  );
}

/** Zoom and framing controls: a small glass group at the trailing bottom corner of the free area. */
export function ViewControls() {
  const session = useSession();
  const t = useT();
  const zoom = useApp((s) => s.camera.zoom);
  const hasModel = useApp((s) => s.model !== null);
  if (!hasModel) return null;
  return (
    <Toolbar size="md" aria-label={t('view.label')} className="ed-view-controls" data-testid="view-bar">
      <ToolbarGroup>
        <IconButton icon="zoomOut" label={t('view.zoomOut')} shortcut="-" tooltip="top" onClick={() => session.zoomTo(stepZoom(zoom, -1))} />
        <button type="button" className="ed-zoom-value r2-num" title={t('view.zoomReset')} aria-label={t('view.zoomReset')} onClick={() => session.zoomTo(1)} data-testid="zoom">
          {formatZoom(zoom)}
        </button>
        <IconButton icon="zoomIn" label={t('view.zoomIn')} shortcut="+" tooltip="top" onClick={() => session.zoomTo(stepZoom(zoom, 1))} />
        <ToolbarSeparator />
        <IconButton icon="fit" label={t('view.fit')} shortcut="F" tooltip="top" onClick={() => session.focus(session.get().selection.length ? 'selection' : 'fit')} />
        <IconButton icon="model" label={t('view.frameCanvas')} shortcut="Shift+F" tooltip="top" onClick={() => session.focus('canvas')} />
      </ToolbarGroup>
    </Toolbar>
  );
}
