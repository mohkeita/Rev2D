/**
 * Layout and resize logic of SplitView: panes docked to the edges of a container around one main
 * area (a canvas), resizable and collapsible. Pure.
 *
 * Panes claim space in array order, like a dock layout: each takes its whole edge of what is left.
 *   [bottom timeline, leading sidebar, trailing inspector]  the timeline spans the full width
 *   [leading sidebar, trailing inspector, bottom timeline]  the timeline sits between the sidebars
 *
 * Two modes:
 * - docked (`floating: false`): panes and the main area tile the container, dividers between them;
 * - floating: the main area is full-bleed, panes float above it inset by `gap` (glass panels over a
 *   canvas); the space they cover is reported as `safe` insets so that the content can keep its
 *   subject in the uncovered part.
 */
import { clamp } from './number.js';

export type DockEdge = 'leading' | 'trailing' | 'top' | 'bottom';

export interface DockPaneSpec {
  id: string;
  edge: DockEdge;
  /** Default size along the resizable axis (width for leading / trailing, height for top / bottom). */
  size: number;
  min: number;
  max: number;
  /** May be collapsed (hidden) by dragging past its minimum, from the keyboard, or by the app. */
  collapsible?: boolean;
  /** Largest share of the container the pane may take (0..1). Default 0.45. */
  maxFraction?: number;
}

export interface DockState {
  sizes: Record<string, number>;
  collapsed: Record<string, boolean>;
}

export interface DockOptions {
  floating?: boolean;
  /** Floating: distance between panes and from the container edges. Docked: thickness of dividers. */
  gap?: number;
}

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface DockPaneLayout {
  id: string;
  edge: DockEdge;
  collapsed: boolean;
  /** Effective size after clamping (the stored size is kept, so a larger window restores it). */
  size: number;
  /** Offsets from the container edges; the resizable axis has a `size` instead of two offsets. */
  inset: Insets;
  /** Clamp range in effect (for aria-valuemin / aria-valuemax of the divider). */
  min: number;
  max: number;
}

export interface DockLayout {
  panes: DockPaneLayout[];
  /** Insets of the main area. Zero in floating mode (the main area is full-bleed). */
  main: Insets;
  /** Space covered by chrome on each side: equals `main` when docked. */
  safe: Insets;
}

export function initialDockState(specs: readonly DockPaneSpec[], collapsed: readonly string[] = []): DockState {
  const state: DockState = { sizes: {}, collapsed: {} };
  for (const s of specs) {
    state.sizes[s.id] = clamp(s.size, s.min, s.max);
    state.collapsed[s.id] = collapsed.includes(s.id);
  }
  return state;
}

function isHorizontal(edge: DockEdge): boolean {
  return edge === 'leading' || edge === 'trailing';
}

/** Min / max of a pane given the container (unknown before the first measurement: spec limits). */
export function paneLimits(spec: DockPaneSpec, container: { width: number; height: number } | null): { min: number; max: number } {
  if (!container) return { min: spec.min, max: Math.max(spec.min, spec.max) };
  const extent = isHorizontal(spec.edge) ? container.width : container.height;
  const byFraction = extent * (spec.maxFraction ?? 0.45);
  const max = Math.max(Math.min(spec.max, byFraction), Math.min(spec.min, byFraction));
  return { min: Math.min(spec.min, max), max };
}

export function layoutDock(
  specs: readonly DockPaneSpec[],
  state: DockState,
  container: { width: number; height: number } | null,
  opts: DockOptions = {},
): DockLayout {
  const floating = opts.floating ?? false;
  const gap = opts.gap ?? (floating ? 12 : 1);
  // Space already claimed on each side (docked: includes dividers; floating: includes gaps).
  const used: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
  const panes: DockPaneLayout[] = [];
  for (const spec of specs) {
    const collapsed = state.collapsed[spec.id] === true;
    const limits = paneLimits(spec, container);
    const size = clamp(state.sizes[spec.id] ?? spec.size, limits.min, limits.max);
    const lead = floating ? gap : 0;
    const inset: Insets = { top: used.top + lead, right: used.right + lead, bottom: used.bottom + lead, left: used.left + lead };
    panes.push({ id: spec.id, edge: spec.edge, collapsed, size, inset, min: limits.min, max: limits.max });
    if (collapsed) continue;
    const side = spec.edge === 'leading' ? 'left' : spec.edge === 'trailing' ? 'right' : spec.edge;
    used[side] += size + gap;
  }
  const safe: Insets = { ...used };
  if (floating) {
    // A side with panes also keeps the outer gap free.
    for (const side of ['top', 'right', 'bottom', 'left'] as const) if (safe[side] > 0) safe[side] += gap;
  }
  return { panes, main: floating ? { top: 0, right: 0, bottom: 0, left: 0 } : { ...used }, safe };
}

/** Collapse when a drag ends below this share of the minimum size; expand again above it. */
export const COLLAPSE_THRESHOLD = 0.5;

/**
 * Set the size of a pane (from a drag or the keyboard). A collapsible pane dragged below half its
 * minimum collapses and keeps the size it had; dragging a collapsed pane back out expands it.
 */
export function resizeDock(
  specs: readonly DockPaneSpec[],
  state: DockState,
  id: string,
  requested: number,
  container: { width: number; height: number } | null,
): DockState {
  const spec = specs.find((s) => s.id === id);
  if (!spec) return state;
  const { min, max } = paneLimits(spec, container);
  const wasCollapsed = state.collapsed[id] === true;
  if (spec.collapsible && requested < min * COLLAPSE_THRESHOLD) {
    return wasCollapsed ? state : { sizes: state.sizes, collapsed: { ...state.collapsed, [id]: true } };
  }
  const size = clamp(Math.round(requested), min, max);
  if (!wasCollapsed && state.sizes[id] === size) return state;
  return { sizes: { ...state.sizes, [id]: size }, collapsed: { ...state.collapsed, [id]: false } };
}

export function toggleDock(state: DockState, id: string, collapsed?: boolean): DockState {
  const next = collapsed ?? !state.collapsed[id];
  if ((state.collapsed[id] === true) === next) return state;
  return { sizes: state.sizes, collapsed: { ...state.collapsed, [id]: next } };
}

/**
 * Pointer movement -> change of size: a leading pane grows when its divider moves right, a trailing
 * pane when it moves left, a top pane down, a bottom pane up.
 */
export function dragDelta(edge: DockEdge, dx: number, dy: number, rtl = false): number {
  switch (edge) {
    case 'leading':
      return rtl ? -dx : dx;
    case 'trailing':
      return rtl ? dx : -dx;
    case 'top':
      return dy;
    case 'bottom':
      return -dy;
  }
}

export type DockKeyAction = { type: 'resize'; delta: number } | { type: 'min' } | { type: 'max' } | { type: 'toggle' };

/** Keyboard on a focused divider: arrows resize (Shift = larger steps), Home / End, Enter toggles. */
export function dockKeyAction(edge: DockEdge, key: string, opts: { shiftKey?: boolean; step?: number; rtl?: boolean } = {}): DockKeyAction | null {
  const step = (opts.step ?? 16) * (opts.shiftKey ? 4 : 1);
  if (key === 'Enter') return { type: 'toggle' };
  if (key === 'Home') return { type: 'min' };
  if (key === 'End') return { type: 'max' };
  const dx = key === 'ArrowRight' ? step : key === 'ArrowLeft' ? -step : 0;
  const dy = key === 'ArrowDown' ? step : key === 'ArrowUp' ? -step : 0;
  if (isHorizontal(edge) ? dx === 0 : dy === 0) return null;
  return { type: 'resize', delta: dragDelta(edge, dx, dy, opts.rtl) };
}
