/**
 * Editor shell: toolbar, outliner | viewport + view bar | parameters + inspector, bottom dock
 * (timeline / problems), status bar. Panel sizes are draggable, panels collapsible (view bar and dock
 * buttons), and both are remembered per browser; on small windows the panels shrink (CSS clamps) so
 * the viewport keeps most of the space.
 */
import { useEffect, useState, type CSSProperties, type DragEvent } from 'react';
import { DEFAULT_PANELS, errorCount, warningCount, type OverlayLayer, type PanelName, type PanelState } from './state/app.js';
import { useApp, useSession } from './state/context.js';
import type { Session } from './state/session.js';
import { stepZoom } from './view/camera.js';
import { FileDialogs } from './files/FileDialogs.js';
import { fileShortcut } from './files/shortcuts.js';
import { StartScreen } from './files/StartScreen.js';
import { Diagnostics } from './panels/Diagnostics.js';
import { Inspector } from './panels/Inspector.js';
import { Outliner } from './panels/Outliner.js';
import { LoadFailure, ShortcutsHelp, Toasts } from './panels/Overlays.js';
import { Parameters } from './panels/Parameters.js';
import { StatusBar } from './panels/StatusBar.js';
import { Timeline } from './panels/Timeline.js';
import { Toolbar } from './panels/Toolbar.js';
import { Icon } from './ui/icons.js';
import { isTypingTarget, keepsNavigationKeys, keyState, NAVIGATION_KEYS } from './ui/keys.js';
import { basename } from './ui/text.js';
import { ViewBar, Viewport } from './viewport/Viewport.js';

interface Layout {
  /** Preferred panel sizes in CSS px (the stylesheet caps them relative to the window). */
  left: number;
  right: number;
  bottom: number;
  /** Fraction of the right panel used by the parameter list. */
  params: number;
}

const DEFAULT_LAYOUT: Layout = { left: 250, right: 320, bottom: 230, params: 0.46 };
const LAYOUT_KEY = 'rev2d.editor.layout';

/** Stored layout; unusable values (older versions, hand edits) fall back to the defaults. */
function loadLayout(): { layout: Layout; panels: PanelState } {
  const layout = { ...DEFAULT_LAYOUT };
  const panels = { ...DEFAULT_PANELS };
  try {
    const raw = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}') as Record<string, unknown> & { panels?: Record<string, unknown> };
    for (const k of Object.keys(layout) as Array<keyof Layout>) {
      const v = raw[k];
      if (typeof v === 'number' && Number.isFinite(v)) layout[k] = v;
    }
    for (const k of Object.keys(panels) as PanelName[]) {
      const v = raw.panels?.[k];
      if (typeof v === 'boolean') panels[k] = v;
    }
  } catch {
    // storage unavailable (private mode, blocked) or unreadable: defaults
  }
  return { layout, panels };
}

function saveLayout(l: Layout, panels: PanelState): void {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ ...l, panels }));
  } catch {
    // storage unavailable: layout is per session only
  }
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function App() {
  const session = useSession();
  const [layout, setLayout] = useState<Layout>(() => {
    const stored = loadLayout();
    // First render of the root: no panel has subscribed to the store yet.
    session.store.set({ panels: stored.panels });
    return stored.layout;
  });
  const panels = useApp((s) => s.panels);
  useEffect(() => saveLayout(layout, panels), [layout, panels]);
  useShortcuts(session);
  useUnloadWarning(session);
  const drop = useFileDrop(session);
  const file = useApp((s) => s.file);
  const unsaved = useApp((s) => s.unsaved);
  const status = useApp((s) => s.status);
  useEffect(() => {
    document.title = file ? `${unsaved ? '● ' : ''}${basename(file)} • Rev2D` : 'Rev2D';
  }, [file, unsaved]);

  const style = {
    '--left-w': `${layout.left}px`,
    '--right-w': `${layout.right}px`,
    '--bottom-h': `${layout.bottom}px`,
  } as CSSProperties;

  if (status === 'empty') {
    return (
      <div className="app is-empty" {...drop.handlers}>
        <Toolbar />
        <StartScreen />
        <StatusBar />
        <Toasts />
        <ShortcutsHelp />
        <FileDialogs />
        {drop.active && <DropOverlay />}
      </div>
    );
  }

  const closed = (Object.keys(panels) as PanelName[]).filter((p) => !panels[p]).map((p) => ` ${p}-closed`).join('');
  return (
    <div className={`app${closed}`} style={style} {...drop.handlers}>
      <Toolbar />
      <div className="workspace">
        <Outliner />
        <Splitter axis="x" panel="previous" className="splitter-left" onResize={(w) => setLayout((l) => ({ ...l, left: clamp(w, 170, 520) }))} />
        <main className="center">
          <Viewport />
          <ViewBar />
        </main>
        <Splitter axis="x" panel="next" className="splitter-right" onResize={(w) => setLayout((l) => ({ ...l, right: clamp(w, 230, 640) }))} />
        <RightPanel fraction={layout.params} onResize={(f) => setLayout((l) => ({ ...l, params: clamp(f, 0.15, 0.85) }))} />
      </div>
      <Splitter axis="y" panel="next" className="splitter-bottom" onResize={(h) => setLayout((l) => ({ ...l, bottom: clamp(h, 120, 560) }))} />
      <BottomDock />
      <StatusBar />
      <Toasts />
      <ShortcutsHelp />
      <LoadFailure />
      <FileDialogs />
      {drop.active && <DropOverlay />}
    </div>
  );
}

function DropOverlay() {
  return (
    <div className="drop-overlay" aria-hidden="true">
      <div className="drop-card">
        <Icon name="upload" size={28} />
        <strong>Drop to import</strong>
        <span>A model .json with its PNG textures, or a Spine export (.json + .atlas + PNG pages), is copied into the workspace and opened; Live2D motion, expression and physics files are imported into the open model.</span>
      </div>
    </div>
  );
}

/**
 * Files dragged from the computer onto the window open the import dialog (Live2D files: the Live2D
 * import into the open model). File drags are always
 * taken (preventDefault), also while a dialog is open: otherwise the browser would navigate to the
 * dropped file and the page (with any unsaved edit) would be gone.
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

/** The browser asks before leaving the page while an edit is not on disk (or still being written). */
function useUnloadWarning(session: Session): void {
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent): void => {
      const s = session.get();
      if (!s.unsaved && !s.saving) return;
      e.preventDefault();
      // Older browsers need returnValue set to show the prompt.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [session]);
}

function RightPanel({ fraction, onResize }: { fraction: number; onResize: (f: number) => void }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  return (
    <aside className="panel right-panel" ref={setEl} style={{ ['--params-frac' as string]: String(fraction) }}>
      <Parameters />
      <Splitter
        axis="y"
        panel="previous"
        onResize={(h) => {
          // The parameter section is `fraction * 100% - 2px` tall (half the splitter).
          onResize((h + 2) / Math.max(1, el?.getBoundingClientRect().height ?? 1));
        }}
      />
      <Inspector />
    </aside>
  );
}

function BottomDock() {
  const session = useSession();
  const tab = useApp((s) => s.bottomTab);
  const open = useApp((s) => s.panels.dock);
  const errors = useApp((s) => errorCount(s.diagnostics));
  const warnings = useApp((s) => warningCount(s.diagnostics));
  return (
    <section className="bottom-dock">
      <div className="dock-tabs" role="tablist">
        <button role="tab" aria-selected={open && tab === 'timeline'} className={`dock-tab${open && tab === 'timeline' ? ' is-active' : ''}`} onClick={() => session.showDock('timeline')}>
          <Icon name="film" size={14} /> Timeline
        </button>
        <button
          role="tab"
          aria-selected={open && tab === 'problems'}
          className={`dock-tab${open && tab === 'problems' ? ' is-active' : ''}`}
          onClick={() => session.showDock('problems')}
          data-testid="problems-tab"
        >
          <Icon name={errors ? 'error' : warnings ? 'warning' : 'check'} size={14} /> Problems
          {(errors > 0 || warnings > 0) && <span className={`count ${errors ? 'count-error' : 'count-warning'}`}>{errors + warnings}</span>}
        </button>
        <span className="dock-tabs-spacer" />
        <button
          className="icon-button icon-button-small"
          title={open ? 'Collapse the timeline / problems panel' : 'Expand the timeline / problems panel'}
          aria-pressed={open}
          onClick={() => session.togglePanel('dock')}
          data-testid="toggle-dock"
        >
          <Icon name={open ? 'chevronDown' : 'chevronUp'} size={14} />
        </button>
      </div>
      <div className="dock-body">{tab === 'timeline' ? <Timeline /> : <Diagnostics />}</div>
    </section>
  );
}

/**
 * Drag handle between panels. `panel` names the neighbour it resizes; its size is measured when the
 * drag starts (it may be smaller than the stored preference on a small window) and follows the pointer.
 */
function Splitter({
  axis,
  panel,
  className = '',
  onResize,
}: {
  axis: 'x' | 'y';
  panel: 'previous' | 'next';
  className?: string;
  onResize: (size: number) => void;
}) {
  return (
    <div
      className={`splitter splitter-${axis} ${className}`.trim()}
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      onPointerDown={(e) => {
        e.preventDefault();
        const el = e.currentTarget;
        const target = panel === 'previous' ? el.previousElementSibling : el.nextElementSibling;
        if (!target) return;
        el.setPointerCapture(e.pointerId);
        const rect = target.getBoundingClientRect();
        const start = axis === 'x' ? rect.width : rect.height;
        const x0 = e.clientX;
        const y0 = e.clientY;
        // Dragging toward the neighbour shrinks it.
        const sign = panel === 'previous' ? 1 : -1;
        const move = (ev: PointerEvent): void => {
          onResize(start + sign * (axis === 'x' ? ev.clientX - x0 : ev.clientY - y0));
        };
        const up = (): void => {
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
          el.removeEventListener('pointercancel', up);
          document.body.classList.remove('is-resizing');
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
        document.body.classList.add('is-resizing');
      }}
    />
  );
}

const OVERLAY_KEYS: Record<string, OverlayLayer> = { b: 'bones', m: 'mesh', w: 'warps', x: 'bounds', l: 'labels', g: 'grid' };

/** Keys pressed in a dialog or a menu belong to it. */
function inOverlay(target: EventTarget | null): boolean {
  const el = target as { closest?: (sel: string) => unknown } | null;
  return typeof el?.closest === 'function' && el.closest('[aria-modal="true"], [role="menu"]') !== null;
}

/** File shortcuts (Ctrl+S, Ctrl+Shift+S, Ctrl+O, Alt+N); they also work while typing in a field. */
function runFileShortcut(session: Session, which: NonNullable<ReturnType<typeof fileShortcut>>): void {
  const s = session.get();
  if (which === 'save') {
    if (s.status === 'ready') void session.save();
    return;
  }
  if (!s.workspace) {
    session.toast('info', 'This editor server cannot switch files (it has no workspace API); update rev2d.');
    return;
  }
  if (which === 'saveAs') session.openDialog({ kind: 'saveAs' });
  else session.openDialog({ kind: which });
}

/** Global keyboard shortcuts (see ShortcutsHelp for the list). */
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
      if (isTypingTarget(e.target)) return;
      // A focused slider / select / radio uses these keys itself (e.g. arrows step a slider).
      if (NAVIGATION_KEYS.has(e.key) && keepsNavigationKeys(e.target)) return;
      if (mod && (key === 'z' || key === 'y')) {
        e.preventDefault();
        if (key === 'y' || e.shiftKey) void session.redo();
        else void session.undo();
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
      // Handled shortcuts cancel the key's default action, e.g. a focused <select> jumping to the
      // option whose label starts with the typed letter (which would switch the animation).
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
