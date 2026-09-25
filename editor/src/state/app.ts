/**
 * Editor application state (everything React renders). Heavy runtime objects (Rig, Player, Pose,
 * RenderList, textures) live in the Session, not here.
 */
import type { Diagnostic, Model } from '../../../src/core/index.js';
import type { Camera, ViewportSize } from '../view/camera.js';
import type { RawDoc } from './doc.js';
import type { LayerOptions } from './playback.js';

/** Same names as the server-side overlay layers (src/api OVERLAY_LAYERS), so AI tools can reuse them. */
export type OverlayLayer = 'bones' | 'mesh' | 'warps' | 'bounds' | 'labels' | 'grid';
export const OVERLAY_LAYERS: readonly OverlayLayer[] = ['bones', 'mesh', 'warps', 'bounds', 'labels', 'grid'];

export type BackgroundMode = 'checker' | 'dark' | 'light' | 'model';
export const BACKGROUND_MODES: readonly BackgroundMode[] = ['model', 'checker', 'dark', 'light'];

export type OutlinerTab = 'tree' | 'parts' | 'warps' | 'params' | 'animations' | 'rig';
export type BottomTab = 'timeline' | 'problems';
/** Collapsible layout panels: outliner (left), parameters + inspector (right), bottom dock. */
export type PanelName = 'outliner' | 'inspector' | 'dock';
export type PanelState = Record<PanelName, boolean>;
export const DEFAULT_PANELS: PanelState = { outliner: true, inspector: true, dock: true };

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'warning' | 'error';
  text: string;
  /** Small caption, e.g. "AI" for messages sent through the bridge. */
  source?: string;
  action?: ToastAction;
}

/**
 * Extra animation layer settings, kept per animation id even while disabled. The options mirror core
 * AnimationLayer: mode 'override' (default) | 'add', start = global time the layer starts at
 * (default 0), hold = a one-shot keeps its end values outside [0, duration] (default true).
 */
export interface LayerState extends LayerOptions {
  id: string;
  weight: number;
  enabled: boolean;
}

/** A write the server refused because the file changed on disk since the version it edits. */
export interface WriteConflict {
  /** mtime of the version on disk now: an overwrite is based on it. */
  mtimeMs: number;
  /** The refused write was forced (written despite validation errors). */
  force: boolean;
}

export interface BridgeActivity {
  /** Short description of the last command received from an AI tool. */
  text: string;
  at: number;
}

export interface AppState {
  // ---- file & model
  status: 'loading' | 'ready' | 'failed';
  loadError: string | null;
  connection: 'connecting' | 'live' | 'offline';
  file: string;
  mtimeMs: number;
  /** Raw text of the current file version. */
  text: string;
  /** Raw JSON of the current version (null when the text is not parseable JSON). */
  doc: RawDoc | null;
  /** Diagnostics of the current version (validation, textures, rig compile). */
  diagnostics: Diagnostic[];
  /** Last VALID model: kept while the current version has errors. */
  model: Model | null;
  /** Increments on every successful compile. */
  modelVersion: number;
  /** The shown model is older than the current file version (which has errors). */
  stale: boolean;
  /** When `model` was compiled (ms since epoch). */
  validAt: number | null;
  saving: boolean;
  /** The local document was not written to disk (write rejected or failed). */
  unsaved: boolean;
  /** The last write was refused: the file changed on disk meanwhile (reload or overwrite). */
  conflict: WriteConflict | null;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;

  // ---- view
  camera: Camera;
  viewport: ViewportSize;
  overlays: OverlayLayer[];
  background: BackgroundMode;
  /** Preview-only hidden parts (not written to the model). */
  hidden: string[];
  /** Selected entities as "kind:id" keys. */
  selection: string[];
  /** Part or bone key under the pointer. */
  hover: string | null;
  /** Pointer position in MODEL coordinates. */
  pointer: [number, number] | null;
  /** Visible parts in draw order (back to front) of the current pose. */
  drawOrder: string[];
  /** Increments whenever a new pose was evaluated. */
  poseTick: number;
  evalError: string | null;
  glError: string | null;

  // ---- playback & parameters
  /** Primary animation (shown in the timeline). */
  animation: string | null;
  /** Weight of the primary animation: 1 unless an AI setAnimations command asked for less. */
  animationWeight: number;
  /** Layer options of the primary animation (set by AI setAnimations; the timeline picker clears them). */
  animationOptions: LayerOptions;
  layers: LayerState[];
  playing: boolean;
  /** Global playback time in seconds. */
  time: number;
  speed: number;
  /** Keep playing past the end of the primary animation. */
  repeat: boolean;
  physics: boolean;
  /** Explicit parameter values (slider / setParams). */
  overrides: Record<string, number>;
  /** Evaluated parameter values of the current pose. */
  values: Record<string, number>;
  /**
   * Physics output of the current pose per parameter, before any explicit (pinned) value replaced it:
   * the raw output clamped to the parameter range. Empty when physics is off.
   */
  physicsValues: Record<string, number>;

  // ---- ui
  outlinerTab: OutlinerTab;
  bottomTab: BottomTab;
  /** Which layout panels are shown (collapsed ones keep their size). */
  panels: PanelState;
  search: string;
  helpOpen: boolean;
  toasts: Toast[];
  bridge: BridgeActivity | null;
  stats: { fps: number; draws: number; triangles: number };
}

export const DEFAULT_OVERLAYS: OverlayLayer[] = ['bones'];

export function initialState(): AppState {
  return {
    status: 'loading',
    loadError: null,
    connection: 'connecting',
    file: '',
    mtimeMs: 0,
    text: '',
    doc: null,
    diagnostics: [],
    model: null,
    modelVersion: 0,
    stale: false,
    validAt: null,
    saving: false,
    unsaved: false,
    conflict: null,
    canUndo: false,
    canRedo: false,
    undoLabel: null,
    redoLabel: null,
    camera: { cx: 0, cy: 0, zoom: 1 },
    viewport: { width: 0, height: 0 },
    overlays: [...DEFAULT_OVERLAYS],
    background: 'model',
    hidden: [],
    selection: [],
    hover: null,
    pointer: null,
    drawOrder: [],
    poseTick: 0,
    evalError: null,
    glError: null,
    animation: null,
    animationWeight: 1,
    animationOptions: {},
    layers: [],
    playing: false,
    time: 0,
    speed: 1,
    repeat: true,
    physics: true,
    overrides: {},
    values: {},
    physicsValues: {},
    outlinerTab: 'tree',
    bottomTab: 'timeline',
    panels: { ...DEFAULT_PANELS },
    search: '',
    helpOpen: false,
    toasts: [],
    bridge: null,
    stats: { fps: 0, draws: 0, triangles: 0 },
  };
}

export function errorCount(diags: readonly Diagnostic[]): number {
  return diags.filter((d) => d.severity === 'error').length;
}

export function warningCount(diags: readonly Diagnostic[]): number {
  return diags.filter((d) => d.severity === 'warning').length;
}
