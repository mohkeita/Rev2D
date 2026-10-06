/**
 * The live preview: the editor's WebGL renderer drawing the model compiled in the browser from the
 * current spec (preview.ts), posed by the Pose sliders, the idle animation (with physics) and the
 * lip sync. It draws on demand, and every frame while something moves by itself.
 */
import { useEffect, useRef, useState } from 'react';
import { resolveShape } from '../../../src/avatar/parts.js';
import { EmptyState, IconButton, Spinner } from '../design/index.js';
import { GlRenderer } from '../gl/renderer.js';
import { useT } from '../i18n/index.js';
import { readCanvasTheme, type CanvasTheme } from '../overlay/theme.js';
import { useSettings } from '../shell/settings.js';
import { fitRect, type Camera, type Rect } from '../view/camera.js';
import { shapeBounds } from './geometry.js';
import { shallowEqual, useAvatar } from './hooks.js';
import { avatarStore } from './store.js';
import './preview-stage.css';

/** The preview frames the whole picture, or the head. */
type Framing = 'all' | 'head';

function framingRect(framing: Framing): Rect | null {
  const s = avatarStore.get();
  if (!s.image) return null;
  const all: Rect = [0, 0, s.image.width, s.image.height];
  if (framing === 'all' || !s.doc) return all;
  const head = avatarStore.item('head.ellipse');
  const r = head ? resolveShape(s.doc, head.shape) : null;
  if (!r) return all;
  const b = shapeBounds(r, s.image.width);
  const pad = Math.max(b[2], b[3]) * 0.12;
  return [b[0] - pad, b[1] - pad, b[2] + pad * 2, b[3] + pad * 2];
}

export function PreviewStage() {
  const t = useT();
  const { resolvedAppearance } = useSettings();
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const theme = useRef<CanvasTheme | null>(null);
  const request = useRef<() => void>(() => {});
  const [framing, setFraming] = useState<Framing>('all');
  const framingRef = useRef(framing);
  framingRef.current = framing;
  const [glError, setGlError] = useState<string | null>(null);
  const s = useAvatar((st) => ({ version: st.previewVersion, error: st.previewError, hasRig: st.previewVersion > 0, meta: st.meta !== null }), shallowEqual);

  useEffect(() => {
    theme.current = null;
    request.current();
  }, [resolvedAppearance, framing]);

  useEffect(() => {
    const el = host.current!;
    const gl = canvas.current!;
    let renderer: GlRenderer | null = null;
    let raf = 0;
    let disposed = false;
    let last = 0;
    let size = { width: 0, height: 0 };
    let drawnKey = '';
    try {
      renderer = new GlRenderer(gl, () => {
        drawnKey = '';
        req();
      });
    } catch (e) {
      setGlError(e instanceof Error ? e.message : String(e));
    }
    const frame = (now: number): void => {
      raf = 0;
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
      last = now;
      if (avatarStore.animating()) avatarStore.tick(now, dt);
      const preview = avatarStore.preview;
      const inputs = avatarStore.previewInputs();
      const out = preview.evaluate(inputs);
      theme.current ??= readCanvasTheme();
      const rect = framingRect(framingRef.current);
      if (renderer && size.width > 0 && rect) {
        const dpr = window.devicePixelRatio || 1;
        const fit = fitRect(rect, size, 10);
        const camera: Camera = { cx: fit.cx, cy: fit.cy, zoom: fit.zoom };
        const key = JSON.stringify([preview.modelVersion, preview.textureVersion, inputs, size, rect, dpr, resolvedAppearance]);
        if (key !== drawnKey || out === null) {
          drawnKey = key;
          renderer.setTextures(preview.textures, preview.textureVersion);
          renderer.render({ list: out?.list ?? null, camera, viewport: size, dpr, background: 'checker', hidden: new Set(), colors: theme.current.gl });
          el.dataset.frames = String(Number(el.dataset.frames ?? 0) + 1);
        }
      }
      if (avatarStore.animating() && !disposed) req();
      else last = 0;
    };
    const req = (): void => {
      if (!raf && !disposed) raf = requestAnimationFrame(frame);
    };
    request.current = req;
    const unsubscribe = avatarStore.store.subscribe(req);
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      size = { width: Math.round(r.width), height: Math.round(r.height) };
      drawnKey = '';
      req();
    });
    ro.observe(el);
    req();
    return () => {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      unsubscribe();
      ro.disconnect();
      renderer?.dispose();
      request.current = () => {};
    };
    // resolvedAppearance is read through the key; a change re-reads the theme above.
  }, [resolvedAppearance]);

  return (
    <div className="ed-avstage" data-testid="avatar-preview">
      <div ref={host} className="ed-avstage-view" data-version={s.version}>
        <canvas ref={canvas} className="ed-avstage-gl" data-testid="avatar-preview-gl" />
        {glError ? (
          <div className="ed-avstage-note">
            <EmptyState icon="error" title={t('viewport.unavailable.title')} description={glError} size="sm" />
          </div>
        ) : !s.hasRig ? (
          <div className="ed-avstage-note">{s.error ? <EmptyState icon="warning" title={t('avatar.preview.failed')} description={s.error} size="sm" /> : s.meta ? <Spinner size={18} /> : null}</div>
        ) : null}
        <IconButton
          icon={framing === 'all' ? 'face' : 'person'}
          size="sm"
          variant="glass"
          className="ed-avstage-frame"
          label={framing === 'all' ? t('avatar.preview.frameHead') : t('avatar.preview.frameAll')}
          onClick={() => setFraming(framing === 'all' ? 'head' : 'all')}
          data-testid="avatar-preview-framing"
        />
      </div>
      {s.hasRig && s.error && (
        <p className="ed-avstage-error" role="status" title={s.error} data-testid="avatar-preview-error">
          {t('avatar.preview.kept', { message: s.error })}
        </p>
      )}
    </div>
  );
}
