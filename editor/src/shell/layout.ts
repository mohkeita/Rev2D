/**
 * Layout of the shell's panes (pure): sizes and limits, the dock specs for the design system's
 * SplitView, and what is remembered per browser (pane sizes, which panes are open).
 */
import type { DockPaneSpec, DockState } from '../design/logic/dock.js';
import { DEFAULT_PANELS, type PanelState } from '../state/app.js';

export interface PaneSizes {
  /** Width of the leading sidebar. */
  leading: number;
  /** Width of the trailing sidebar. */
  trailing: number;
  /** Height of the open bottom drawer. */
  bottom: number;
}

export const DEFAULT_SIZES: PaneSizes = { leading: 256, trailing: 312, bottom: 212 };

/** Gap between floating panes and from the window edge (--r2-panel-inset). */
export const PANE_GAP = 12;
/** Height of the toolbar row (--r2-toolbar-height with a pointer). */
export const TOOLBAR_HEIGHT = 44;
/** Below this window width the sidebars start closed and the toolbar folds into menus. */
export const COMPACT_WIDTH = 1100;

const LIMITS = {
  leading: { min: 212, max: 440, maxFraction: 0.3 },
  trailing: { min: 272, max: 560, maxFraction: 0.36 },
  bottom: { min: 148, max: 600, maxFraction: 0.42 },
} as const;

export const PANE_IDS = { toolbar: 'toolbar', bottom: 'bottom', leading: 'leading', trailing: 'trailing' } as const;

export interface PaneSetup {
  /** The mode has this pane at all. */
  leading: boolean;
  trailing: boolean;
  bottom: boolean;
  /** Panes that are open (see panelOpen in state/app.ts). */
  leadingOpen: boolean;
  trailingOpen: boolean;
  bottomOpen: boolean;
  /** Height the bottom pane keeps while closed (0: hidden). */
  bottomBar: number;
}

/**
 * Dock specs in claim order: the toolbar, the bottom drawer across the full width, then the
 * sidebars between them. A closed bottom drawer with a bar is a fixed pane of the bar's height.
 */
export function paneSpecs(setup: PaneSetup): DockPaneSpec[] {
  const specs: DockPaneSpec[] = [{ id: PANE_IDS.toolbar, edge: 'top', size: TOOLBAR_HEIGHT, min: TOOLBAR_HEIGHT, max: TOOLBAR_HEIGHT }];
  if (setup.bottom) {
    if (!setup.bottomOpen && setup.bottomBar > 0) specs.push({ id: PANE_IDS.bottom, edge: 'bottom', size: setup.bottomBar, min: setup.bottomBar, max: setup.bottomBar });
    else specs.push({ id: PANE_IDS.bottom, edge: 'bottom', size: DEFAULT_SIZES.bottom, ...LIMITS.bottom, collapsible: true });
  }
  if (setup.leading) specs.push({ id: PANE_IDS.leading, edge: 'leading', size: DEFAULT_SIZES.leading, ...LIMITS.leading, collapsible: true });
  if (setup.trailing) specs.push({ id: PANE_IDS.trailing, edge: 'trailing', size: DEFAULT_SIZES.trailing, ...LIMITS.trailing, collapsible: true });
  return specs;
}

/** The SplitView state for the remembered sizes and the open panes. */
export function dockStateOf(sizes: PaneSizes, setup: PaneSetup): DockState {
  const bar = !setup.bottomOpen && setup.bottomBar > 0;
  return {
    sizes: {
      [PANE_IDS.toolbar]: TOOLBAR_HEIGHT,
      [PANE_IDS.bottom]: bar ? setup.bottomBar : sizes.bottom,
      [PANE_IDS.leading]: sizes.leading,
      [PANE_IDS.trailing]: sizes.trailing,
    },
    collapsed: {
      [PANE_IDS.toolbar]: false,
      [PANE_IDS.bottom]: !setup.bottomOpen && !bar,
      [PANE_IDS.leading]: !setup.leadingOpen,
      [PANE_IDS.trailing]: !setup.trailingOpen,
    },
  };
}

// ----------------------------------------------------------------------------------- persistence

export const LAYOUT_STORAGE_KEY = 'rev2d.editor.layout';

export interface StoredLayout {
  sizes: PaneSizes;
  panels: PanelState;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * Read a stored layout. Unusable values (hand edits, other versions) fall back to the defaults; the
 * layout of the editor before the floating shell ({left, right, bottom, panels}) is understood too.
 */
export function parseLayout(raw: string | null | undefined): StoredLayout {
  const layout: StoredLayout = { sizes: { ...DEFAULT_SIZES }, panels: { ...DEFAULT_PANELS } };
  if (!raw) return layout;
  let data: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return layout;
    data = parsed as Record<string, unknown>;
  } catch {
    return layout;
  }
  const sizes = (typeof data.sizes === 'object' && data.sizes !== null ? data.sizes : {}) as Record<string, unknown>;
  const pick = (key: keyof PaneSizes, legacy: string): void => {
    const v = finite(sizes[key]) ? sizes[key] : finite(data[legacy]) ? data[legacy] : null;
    if (v !== null) layout.sizes[key] = Math.min(LIMITS[key].max, Math.max(LIMITS[key].min, Math.round(v as number)));
  };
  pick('leading', 'left');
  pick('trailing', 'right');
  pick('bottom', 'bottom');
  const panels = (typeof data.panels === 'object' && data.panels !== null ? data.panels : {}) as Record<string, unknown>;
  for (const k of Object.keys(layout.panels) as Array<keyof PanelState>) {
    if (typeof panels[k] === 'boolean') layout.panels[k] = panels[k] as boolean;
  }
  return layout;
}

export function serializeLayout(layout: StoredLayout): string {
  return JSON.stringify({ v: 2, sizes: layout.sizes, panels: layout.panels });
}

export function loadLayout(): StoredLayout {
  try {
    return parseLayout(localStorage.getItem(LAYOUT_STORAGE_KEY));
  } catch {
    // Storage unavailable (private mode, blocked): defaults.
    return parseLayout(null);
  }
}

export function saveLayout(layout: StoredLayout): void {
  try {
    localStorage.setItem(LAYOUT_STORAGE_KEY, serializeLayout(layout));
  } catch {
    // Storage unavailable: the layout lasts for this page only.
  }
}

/** Sizes after the SplitView reported a new state (only the panes that exist and are resizable). */
export function sizesFromDock(prev: PaneSizes, dock: DockState, setup: PaneSetup): PaneSizes {
  const next = { ...prev };
  if (setup.leading && finite(dock.sizes[PANE_IDS.leading])) next.leading = dock.sizes[PANE_IDS.leading];
  if (setup.trailing && finite(dock.sizes[PANE_IDS.trailing])) next.trailing = dock.sizes[PANE_IDS.trailing];
  if (setup.bottom && setup.bottomOpen && finite(dock.sizes[PANE_IDS.bottom])) next.bottom = dock.sizes[PANE_IDS.bottom];
  return next.leading === prev.leading && next.trailing === prev.trailing && next.bottom === prev.bottom ? prev : next;
}
