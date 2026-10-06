/**
 * Always mounted (from the file dialogs host): connects the avatar store to the session, owns the
 * canvas keys while avatar mode is on screen, and renders the "New Avatar from Illustration" sheet.
 *
 * Keys in avatar mode (they win over the editor's global shortcuts, which act on the model's view):
 *   Esc cancel placing, then deselect · F frame the selection · Shift+F frame the illustration ·
 *   1 100 % · + / - zoom · arrows nudge the selected point (Shift: 10 px) · Delete remove the
 *   selected vertex. Ctrl+S, Ctrl+Z, Ctrl+Shift+Z / Ctrl+Y are the editor's: they act on the
 *   document on screen, avatar.json in avatar mode (document.ts); so do the toolbar's Save, Undo and
 *   Redo, and leaving the page with unsaved avatar edits asks first.
 */
import { useEffect } from 'react';
import { resolveShape } from '../../../src/avatar/parts.js';
import { t } from '../i18n/index.js';
import { useSession } from '../state/context.js';
import type { Session } from '../state/session.js';
import { isTypingTarget, keepsNavigationKeys } from '../ui/keys.js';
import { fitSelection, setActionToast } from './actions.js';
import { MIN_VERTICES, dragHandle, removeVertex, translateItem, type Grab } from './geometry.js';
import { avatarActive } from './hooks.js';
import { itemLabel } from './labels.js';
import { NewAvatarSheet } from './NewAvatarSheet.js';
import { avatarStore } from './store.js';
import { stepAvatarZoom } from './view.js';

/** Keys pressed in a dialog, a menu or a popover belong to it. */
function inOverlay(target: EventTarget | null): boolean {
  const el = target as { closest?: (sel: string) => unknown } | null;
  if (typeof el?.closest === 'function' && el.closest('[aria-modal="true"], [role="menu"], [role="listbox"], .r2-layer') !== null) return true;
  // A modal sheet is open (its keys may arrive from <body> when the focus fell out of it).
  return document.querySelector('.r2-sheet[aria-modal="true"]') !== null;
}

/** Move the selected point (a vertex, a point, an ellipse's centre, a segment) by (dx, dy) image px. */
function nudge(dx: number, dy: number): boolean {
  const s = avatarStore.get();
  const item = avatarStore.item(s.selection.item);
  if (!item || !s.doc) return false;
  const r = resolveShape(s.doc, item.shape);
  if (!r) return false;
  let next = null;
  if ((r.type === 'polygon' || r.type === 'polyline') && (item.shape.type === 'polygon' || item.shape.type === 'polyline') && s.selection.vertex !== null) {
    const i = s.selection.vertex;
    if (i * 2 + 1 >= r.points.length) return false;
    const grab: Grab = { role: 'vertex', pointer: item.shape.points, index: i };
    next = dragHandle(s.doc, grab, [r.points[i * 2] + dx, r.points[i * 2 + 1] + dy]);
  } else {
    next = translateItem(s.doc, item.shape, dx, dy);
  }
  return avatarStore.edit(t('avatar.history.nudge', { item: itemLabel(t, item, s.doc) }), next);
}

function handleKey(session: Session, e: KeyboardEvent): void {
  const app = session.get();
  if (!avatarActive(app) || app.dialog || app.unsavedPrompt || inOverlay(e.target)) return;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  const take = (): void => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  if (mod || e.altKey || isTypingTarget(e.target)) return;
  const s = avatarStore.get();
  if (s.status !== 'ready') return;
  switch (e.key) {
    case 'Escape':
      take();
      if (s.placing) avatarStore.startPlacing(null);
      else avatarStore.select(null, null);
      return;
    case '1':
      take();
      avatarStore.zoomTo(1);
      return;
    case '+':
    case '=':
      take();
      avatarStore.zoomTo(stepAvatarZoom(s.camera.zoom, 1));
      return;
    case '-':
    case '_':
      take();
      avatarStore.zoomTo(stepAvatarZoom(s.camera.zoom, -1));
      return;
    case 'Delete':
    case 'Backspace': {
      const item = avatarStore.item(s.selection.item);
      if (!item || !s.doc || s.selection.vertex === null || (item.shape.type !== 'polygon' && item.shape.type !== 'polyline')) return;
      take();
      const min = item.shape.type === 'polyline' ? MIN_VERTICES.polyline : MIN_VERTICES.polygon;
      const next = removeVertex(s.doc, item.shape.points, s.selection.vertex, min);
      if (next) {
        avatarStore.edit(t('avatar.history.removePoint', { item: itemLabel(t, item, s.doc) }), next);
        avatarStore.select(item.id, undefined, null);
      } else session.toast('info', t('avatar.toast.minPoints', { n: min }));
      return;
    }
    case 'ArrowLeft':
    case 'ArrowRight':
    case 'ArrowUp':
    case 'ArrowDown': {
      if (keepsNavigationKeys(e.target) || !s.selection.item) return;
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      if (nudge(dx, dy)) take();
      return;
    }
  }
  if (key === 'f') {
    take();
    if (e.shiftKey) avatarStore.fit('image');
    else fitSelection();
  }
}

export function AvatarHost() {
  const session = useSession();

  useEffect(() => avatarStore.attach(session), [session]);

  useEffect(() => {
    setActionToast((text) => session.toast('error', text));
    return () => setActionToast(null);
  }, [session]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => handleKey(session, e);
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [session]);

  return <NewAvatarSheet />;
}
