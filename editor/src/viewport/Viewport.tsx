/**
 * The viewport: WebGL2 canvas (model) + Canvas 2D overlay, camera navigation and picking, and the
 * view bar docked under it (zoom / framing controls and the side panel toggles, so no control sits
 * on top of the model). Rendering is demand-driven: a frame is scheduled on any store change and
 * while playing; a frame redraws only when one of its inputs changed.
 */
import { useEffect, useRef, useState } from 'react';
import { errorCount } from '../state/app.js';
import { useApp, useSession } from '../state/context.js';
import { parseRefKey, type EntityRef } from '../state/doc.js';
import type { Session } from '../state/session.js';
import { GlRenderer } from '../gl/renderer.js';
import { drawOverlay } from '../overlay/draw.js';
import { rigHighlight } from '../overlay/highlight.js';
import { formatZoom, panBy, screenToWorld, stepZoom, wheelZoomFactor, zoomAt } from '../view/camera.js';
import { cyclePick, pickBone, pickParts } from '../view/picking.js';
import { Icon } from '../ui/icons.js';
import { keyState } from '../ui/keys.js';

/** Screen radius (CSS px) within which a click selects a bone joint. */
const BONE_PICK_PX = 9;
/** Pointer travel (CSS px) below which a press counts as a click. */
const CLICK_SLOP = 4;

export function Viewport() {
  const session = useSession();
  const host = useRef<HTMLDivElement>(null);
  const glCanvas = useRef<HTMLCanvasElement>(null);
  const overlayCanvas = useRef<HTMLCanvasElement>(null);
  const [panning, setPanning] = useState(false);

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
      const inputs = [frame, s.model, s.camera, s.viewport, dpr, s.overlays, s.background, s.hidden, s.selection, s.hover, session.textureVersion];
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

  const localPoint = (e: React.PointerEvent): [number, number] => {
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
      className={`viewport${panning ? ' is-panning' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={onPointerLeave}
      onContextMenu={(e) => e.preventDefault()}
      data-testid="viewport"
    >
      <canvas ref={glCanvas} className="viewport-gl" data-testid="viewport-gl" />
      <canvas ref={overlayCanvas} className="viewport-overlay" />
      <ViewportBanners />
      <ViewportEmptyState />
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

function ViewportBanners() {
  const session = useSession();
  const stale = useApp((s) => s.stale);
  const errors = useApp((s) => errorCount(s.diagnostics));
  const validAt = useApp((s) => s.validAt);
  const evalError = useApp((s) => s.evalError);
  const conflict = useApp((s) => s.conflict);
  return (
    <div className="viewport-banners" onPointerDown={(e) => e.stopPropagation()}>
      {conflict && (
        <div className="banner banner-warning" role="alert" data-testid="conflict-banner">
          <Icon name="warning" />
          <span title="Someone else (a text editor, an AI tool) saved the file after this version was loaded, so your edit was not written. Reload shows their version (your edit stays in the undo history); Overwrite replaces their change with your version.">
            The file changed on disk — your last edit is <b>not saved</b>.
          </span>
          <span className="banner-actions">
            <button className="button button-small" onClick={() => void session.resolveConflict('reload')} data-testid="conflict-reload">
              Reload from disk
            </button>
            <button className="button button-small button-danger" onClick={() => void session.resolveConflict('overwrite')} data-testid="conflict-overwrite">
              Overwrite
            </button>
          </span>
        </div>
      )}
      {stale && (
        <div className="banner banner-error" role="alert" data-testid="stale-banner">
          <Icon name="error" />
          <span>
            The file has {errors} error{errors === 1 ? '' : 's'} — showing the last valid version
            {validAt ? ` (${new Date(validAt).toLocaleTimeString()})` : ''}.
          </span>
          <button className="link-button" onClick={() => session.showDock('problems')}>
            Show problems
          </button>
        </div>
      )}
      {evalError && (
        <div className="banner banner-error" role="alert">
          <Icon name="error" />
          <span>{evalError}</span>
        </div>
      )}
    </div>
  );
}

function ViewportEmptyState() {
  const session = useSession();
  const status = useApp((s) => s.status);
  const hasModel = useApp((s) => s.model !== null);
  const errors = useApp((s) => errorCount(s.diagnostics));
  const glError = useApp((s) => s.glError);
  if (glError) {
    return (
      <div className="viewport-empty">
        <div className="empty-card">
          <Icon name="error" size={22} />
          <h3>Viewport unavailable</h3>
          <p>{glError}</p>
          <p className="muted">Everything else (parameters, inspector, diagnostics) still works.</p>
        </div>
      </div>
    );
  }
  if (status === 'loading' && !hasModel) {
    return (
      <div className="viewport-empty">
        <div className="spinner" aria-label="Loading" />
      </div>
    );
  }
  if (status === 'ready' && !hasModel) {
    return (
      <div className="viewport-empty">
        <div className="empty-card">
          <Icon name="warning" size={22} />
          <h3>Nothing to show yet</h3>
          <p>
            The model has {errors} error{errors === 1 ? '' : 's'} and no earlier valid version was loaded. Fix the
            problems below; the viewport updates as soon as the file validates.
          </p>
          <button className="button" onClick={() => session.showDock('problems')}>
            Show problems
          </button>
        </div>
      </div>
    );
  }
  return null;
}

/** Bar under the viewport: side panel toggles at its edges, zoom and framing controls. */
export function ViewBar() {
  const session = useSession();
  const zoom = useApp((s) => s.camera.zoom);
  const hasModel = useApp((s) => s.model !== null);
  const panels = useApp((s) => s.panels);
  return (
    <div className="view-bar" data-testid="view-bar">
      <button
        className="icon-button"
        title={panels.outliner ? 'Hide the outliner' : 'Show the outliner'}
        aria-pressed={panels.outliner}
        onClick={() => session.togglePanel('outliner')}
        data-testid="toggle-outliner"
      >
        <Icon name="sidebarLeft" />
      </button>
      <span className="view-bar-spacer" />
      {hasModel && (
        <div className="view-controls" role="group" aria-label="View">
          <button className="icon-button" title="Zoom out (-)" onClick={() => session.zoomTo(stepZoom(zoom, -1))}>
            <span className="glyph">−</span>
          </button>
          <button className="zoom-readout" title="Reset zoom to 100% (1)" onClick={() => session.zoomTo(1)} data-testid="zoom">
            {formatZoom(zoom)}
          </button>
          <button className="icon-button" title="Zoom in (+)" onClick={() => session.zoomTo(stepZoom(zoom, 1))}>
            <span className="glyph">+</span>
          </button>
          <span className="sep" />
          <button className="icon-button" title="Frame selection or model (F)" onClick={() => session.focus(session.get().selection.length ? 'selection' : 'fit')}>
            <Icon name="fit" />
          </button>
          <button className="icon-button" title="Frame canvas (Shift+F)" onClick={() => session.focus('canvas')}>
            <Icon name="model" />
          </button>
        </div>
      )}
      <span className="sep" />
      <button
        className="icon-button"
        title={panels.inspector ? 'Hide parameters and inspector' : 'Show parameters and inspector'}
        aria-pressed={panels.inspector}
        onClick={() => session.togglePanel('inspector')}
        data-testid="toggle-inspector"
      >
        <Icon name="sidebarRight" />
      </button>
    </div>
  );
}
