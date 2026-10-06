/**
 * Editor root: the display settings, the shell (shell/Shell.tsx: floating toolbar, sidebars and
 * drawer over a full-bleed canvas) and what belongs to the whole window: global keyboard shortcuts,
 * dropping files onto it, the document title and the warning before leaving with unsaved edits.
 * Save, Undo and Redo (and the title's unsaved marker) follow the document on screen: the active
 * mode's own document (avatar.json in Avatar mode), else the model.
 *
 * Features do not go here: a workspace mode, a trailing panel or a toolbar action registers itself
 * with the shell (shell/registry.ts) and is listed in shell/extensions.ts; see shell/README.md.
 */
import { useEffect, useState, type DragEvent } from 'react';
import { fileShortcut } from './files/shortcuts.js';
import { t, useLanguage } from './i18n/index.js';
import { DropOverlay } from './shell/Overlays.js';
import './shell/extensions.js';
import { resolveMode, useDocumentState, useModes } from './shell/registry.js';
import { SettingsProvider } from './shell/settings.js';
import { Shell } from './shell/Shell.js';
import type { OverlayLayer } from './state/app.js';
import { useApp, useSession } from './state/context.js';
import type { Session } from './state/session.js';
import { isTypingTarget, keepsNavigationKeys, keyState, NAVIGATION_KEYS } from './ui/keys.js';
import { basename } from './ui/text.js';
import { stepZoom } from './view/camera.js';

export function App() {
  const session = useSession();
  useLanguage();
  useShortcuts(session);
  useUnloadWarning(session);
  const drop = useFileDrop(session);
  const file = useApp((s) => s.file);
  const unsaved = useApp((s) => s.unsaved);
  const modes = useModes();
  const doc = useDocumentState(useApp((s) => resolveMode(modes, s)?.document));
  const name = doc ? doc.name : file ? basename(file) : '';
  const dirty = doc ? doc.dirty : unsaved;
  useEffect(() => {
    document.title = name ? `${dirty ? '● ' : ''}${name} • Rev2D` : 'Rev2D';
  }, [name, dirty]);

  return (
    <SettingsProvider>
      <div className="ed-app" {...drop.handlers}>
        <Shell />
        {drop.active && <DropOverlay />}
      </div>
    </SettingsProvider>
  );
}

/**
 * Files dragged from the computer onto the window open the import dialog (Live2D files: the Live2D
 * import into the open model). File drags are always taken (preventDefault), also while a dialog is
 * open: otherwise the browser would navigate to the dropped file and the page (with any unsaved
 * edit) would be gone.
 */
function useFileDrop(session: Session): { active: boolean; handlers: Record<string, (e: DragEvent<HTMLDivElement>) => void> } {
  const [depth, setDepth] = useState(0);
  const hasFiles = (e: DragEvent): boolean => [...(e.dataTransfer?.types ?? [])].includes('Files');
  const enabled = (): boolean => session.get().workspace !== null && !session.get().dialog && !session.get().unsavedPrompt;
  return {
    active: depth > 0 && enabled(),
    handlers: {
      onDragEnter: (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setDepth((d) => d + 1);
      },
      onDragOver: (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = enabled() ? 'copy' : 'none';
      },
      onDragLeave: (e) => {
        if (!hasFiles(e)) return;
        setDepth((d) => Math.max(0, d - 1));
      },
      onDrop: (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setDepth(0);
        const files = [...e.dataTransfer.files];
        if (files.length && enabled()) session.openPickedFiles(files);
      },
    },
  };
}

/**
 * The browser asks before leaving the page while an edit is not on disk (or still being written):
 * the model's, or one of a mode's document (avatar.json).
 */
function useUnloadWarning(session: Session): void {
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent): void => {
      if (!session.hasUnsavedWork()) return;
      e.preventDefault();
      // Older browsers need returnValue set to show the prompt.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [session]);
}

const OVERLAY_KEYS: Record<string, OverlayLayer> = { b: 'bones', m: 'mesh', w: 'warps', x: 'bounds', l: 'labels', g: 'grid' };

/** Keys pressed in a dialog, a menu or a popover belong to it (also a modal sheet the focus fell out of). */
function inOverlay(target: EventTarget | null): boolean {
  const el = target as { closest?: (sel: string) => unknown } | null;
  if (typeof el?.closest === 'function' && el.closest('[aria-modal="true"], [role="menu"], [role="listbox"], .r2-layer') !== null) return true;
  return document.querySelector('.r2-sheet[aria-modal="true"]') !== null;
}

/** File shortcuts (Ctrl+S, Ctrl+Shift+S, Ctrl+O, Alt+N); they also work while typing in a field. */
function runFileShortcut(session: Session, which: NonNullable<ReturnType<typeof fileShortcut>>): void {
  const s = session.get();
  if (which === 'save') {
    // The document on screen: the mode's own (avatar.json), else the model.
    void session.saveDocument();
    return;
  }
  if (!s.workspace) {
    session.toast('info', t('app.noWorkspace'));
    return;
  }
  if (which === 'saveAs') session.openDialog({ kind: 'saveAs' });
  else session.openDialog({ kind: which });
}

/** Global keyboard shortcuts (see the shortcut sheet in shell/Overlays.tsx for the list). */
function useShortcuts(session: Session): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const st = session.get();
      if (inOverlay(e.target) || st.dialog || st.unsavedPrompt) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      const file = fileShortcut(e);
      if (file) {
        e.preventDefault();
        runFileShortcut(session, file);
        return;
      }
      // A control already used the key (a slider stepping, a toolbar or list moving its focus).
      if (e.defaultPrevented) return;
      if (isTypingTarget(e.target)) return;
      // A focused slider / select / radio uses these keys itself (e.g. arrows step a slider).
      if (NAVIGATION_KEYS.has(e.key) && keepsNavigationKeys(e.target)) return;
      if (mod && (key === 'z' || key === 'y')) {
        e.preventDefault();
        if (key === 'y' || e.shiftKey) void session.redoDocument();
        else void session.undoDocument();
        return;
      }
      if (mod || (e.altKey && key !== 'h')) return;
      if (e.key === ' ') {
        e.preventDefault();
        // Keep Space from also activating a focused button / checkbox / select.
        if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) document.activeElement.blur();
        if (!e.repeat) {
          keyState.space = true;
          keyState.spaceUsed = false;
          document.body.classList.add('is-space-held');
        }
        return;
      }
      const s = session.get();
      if (s.helpOpen && e.key !== '?') return;
      // Handled shortcuts cancel the key's default action (e.g. type-ahead in a focused control).
      const handled = (): void => e.preventDefault();
      switch (e.key) {
        case '?':
          handled();
          session.store.set({ helpOpen: !s.helpOpen });
          return;
        case 'Escape':
          session.select([]);
          return;
        case 'ArrowLeft':
        case 'ArrowRight':
          handled();
          session.stepFrame(e.key === 'ArrowLeft' ? -1 : 1);
          return;
        case 'Home':
          handled();
          session.seek(0);
          return;
        case '+':
        case '=':
          handled();
          session.zoomTo(stepZoom(s.camera.zoom, 1));
          return;
        case '-':
        case '_':
          handled();
          session.zoomTo(stepZoom(s.camera.zoom, -1));
          return;
        case '1':
          handled();
          session.zoomTo(1);
          return;
      }
      if (key === 'f') {
        handled();
        session.focus(e.shiftKey ? 'canvas' : s.selection.length ? 'selection' : 'fit');
      } else if (key === 'h') {
        handled();
        if (e.altKey) session.showAllParts();
        else for (const k of s.selection) if (k.startsWith('part:')) session.toggleHidden(k.slice(5));
      } else if (OVERLAY_KEYS[key] && !e.shiftKey) {
        handled();
        session.toggleOverlay(OVERLAY_KEYS[key]);
      }
    };
    const releaseSpace = (): void => {
      keyState.space = false;
      document.body.classList.remove('is-space-held');
    };
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.key !== ' ' || !keyState.space || inOverlay(e.target)) return;
      releaseSpace();
      // A tap toggles playback; a press used for space+drag panning does not.
      if (!keyState.spaceUsed && !isTypingTarget(e.target)) session.togglePlay();
    };
    const onBlur = releaseSpace;
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [session]);
}
