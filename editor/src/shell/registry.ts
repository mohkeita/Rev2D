/**
 * Extension points of the editor shell: workspace modes, trailing-sidebar panels and toolbar
 * actions. Features register themselves when their module is imported (see README.md in this
 * folder); the shell (Shell.tsx, EditorToolbar.tsx) renders whatever is registered and never needs
 * to know the feature.
 *
 *   registerMode({ id: 'avatar', label: () => t('avatar.mode'), icon: 'avatar', render: { canvas: AvatarCanvas, trailing: AvatarPanel } });
 *   registerPanel({ id: AI_PANEL_ID, title: () => t('ai.title'), icon: 'sparkles', render: AiPanel });
 *   registerToolbarAction({ id: 'export-gif', label: 'Export GIF', icon: 'film', run: (session) => … });
 *
 * Every `register*` returns a function that removes the entry again; registering an id that exists
 * replaces it (so a module can be re-evaluated by hot reload).
 *
 * Which mode is on screen follows the open document (state/app.ts documentKind): with a model every
 * available mode can show; without one only the modes that declare `showsWithoutModel` (an avatar
 * project before its first build), else the start screen. A mode the person picked is kept for that
 * document; another document starts in its default mode (`isDefault`, else the first available one).
 * A mode that edits a document of its own (`document`: avatar.json) gets the toolbar's Save, Undo and
 * Redo, their keyboard shortcuts, the unsaved marker and the unsaved-changes prompt.
 */
import { useCallback, useSyncExternalStore, type ComponentType } from 'react';
import type { IconName } from '../design/index.js';
import { documentKey, documentKind, type AppState } from '../state/app.js';
import type { Session } from '../state/session.js';

/** A text, or a function that returns it in the current language (call `t()` inside). */
export type Label = string | (() => string);

export function labelText(label: Label): string {
  return typeof label === 'function' ? label() : label;
}

/**
 * A workspace mode: what the whole window is for ("Rig", "Avatar"). The toolbar shows a segmented
 * control as soon as two modes are available. Each slot is a React component rendered inside the
 * shell's panes; a slot that is left out is simply not there in that mode (no pane, no toggle).
 */
export interface WorkspaceMode {
  id: string;
  label: Label;
  icon: IconName;
  /** Position in the mode switcher (ascending; default 100; the built-in Rig mode is 0). */
  order?: number;
  /** false hides the mode. Default: available whenever a model is open. */
  isAvailable?: (state: AppState) => boolean;
  /**
   * Whether the mode also shows while NO model is open (and it is available), e.g. an avatar project
   * before its first build. Default: no; with no mode to show, the shell shows the start screen.
   */
  showsWithoutModel?: (state: AppState) => boolean;
  /**
   * Whether the mode is the default for the open document: it is shown when the document opens,
   * until the person picks another mode. Default: the first available mode (Rig).
   */
  isDefault?: (state: AppState) => boolean;
  /**
   * The document the mode edits instead of the model (Avatar mode: avatar.json). While the mode is
   * on screen the toolbar's Save, Undo and Redo, Ctrl+S / Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y, the
   * unsaved marker and the status line use it; the unsaved-changes prompt asks about it whenever it
   * is dirty and an action would replace it. Without it they act on the model.
   */
  document?: ModeDocument;
  render: {
    /** Leading sidebar: render a design-system `<Sidebar>`. */
    leading?: ComponentType;
    /** The full-bleed main area under the floating chrome (read `--r2-safe-*` to stay clear of it). */
    canvas?: ComponentType;
    /** The mode's own trailing panel (id MODE_PANEL): render a design-system `<Inspector>`. */
    trailing?: ComponentType;
    /** Bottom drawer: render a design-system `<Drawer>`. `collapsed` = only `bottomBar` px are shown. */
    bottom?: ComponentType<{ collapsed: boolean }>;
    /**
     * The mode's own items of the status line (StatusItem from shell/StatusLine.js), shown in place
     * of the model's validation badge (e.g. what avatar.json still lacks).
     */
    status?: ComponentType;
  };
  /** Names of the panes (divider and toggle labels). Default: Sidebar, Inspector, Timeline. */
  paneLabels?: { leading?: Label; trailing?: Label; bottom?: Label };
  /**
   * Height in px the bottom pane keeps while collapsed (a slim bar, e.g. transport controls).
   * 0 or omitted: the collapsed drawer is hidden entirely.
   */
  bottomBar?: number;
}

/**
 * A panel of the trailing sidebar that is available in every mode, next to the mode's own
 * inspector. It gets a toggle button in the toolbar's panel group (icon + title as tooltip).
 */
export interface TrailingPanel {
  id: string;
  title: Label;
  icon: IconName;
  /** Shortcut shown in the tooltip of its toolbar button (handle the key yourself). */
  shortcut?: string;
  /** Position among the panel buttons (ascending; default 100). */
  order?: number;
  isAvailable?: (state: AppState) => boolean;
  /** Render a design-system `<Inspector>` (or any panel shell) that fills the pane. */
  render: ComponentType;
}

/** An icon button in the toolbar's panel group. */
export interface ToolbarAction {
  id: string;
  label: Label;
  icon: IconName;
  shortcut?: string;
  /** Position among the actions (ascending; default 100). */
  order?: number;
  /** false hides the button. */
  isAvailable?: (state: AppState) => boolean;
  /** false dims it (it stays focusable and keeps its tooltip). */
  isEnabled?: (state: AppState) => boolean;
  /** A toggle: the button is shown pressed while this returns true. */
  isActive?: (state: AppState) => boolean;
  run: (session: Session) => void;
}

/** What the chrome shows of a mode document; `getState()` returns the same object while nothing changed. */
export interface ModeDocumentState {
  /** Shown in the toolbar's File button and the window title (e.g. the avatar's name). */
  name: string;
  /** The file, relative to the workspace root: status line, tooltips, the unsaved-changes prompt. */
  path: string;
  /** Edits that are not on disk. */
  dirty: boolean;
  saving: boolean;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
}

/**
 * A document a mode edits besides the model (WorkspaceMode.document): an external store the shell
 * subscribes to from React and the session reads for the unsaved-changes prompt.
 */
export interface ModeDocument {
  subscribe(listener: () => void): () => void;
  /** null while there is nothing to save or undo (loading, failed): Save, Undo and Redo are dimmed. */
  getState(): ModeDocumentState | null;
  /** Write it; resolves whether it is on disk now (the document reports its own failures). */
  save(): Promise<boolean>;
  undo(): void;
  redo(): void;
  /**
   * Whether opening `next` (absolute path of a model, a project folder or an avatar.json; null =
   * closing everything) keeps this document open, so its unsaved edits are not lost. Default: false.
   */
  keptBy?(next: string | null): boolean;
}

/**
 * Reserved panel id: the toolbar always shows the AI button (sparkles); it is dimmed with the
 * tooltip "AI Assistant" until a panel with this id is registered, and toggles that panel after.
 */
export const AI_PANEL_ID = 'ai';

class Registry<T extends { id: string; order?: number }> {
  private items: readonly T[] = [];
  private readonly listeners = new Set<() => void>();

  register = (item: T): (() => void) => {
    this.items = [...this.items.filter((i) => i.id !== item.id), item].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
    this.emit();
    return () => {
      if (!this.items.includes(item)) return;
      this.items = this.items.filter((i) => i !== item);
      this.emit();
    };
  };

  get = (): readonly T[] => this.items;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emit(): void {
    for (const l of [...this.listeners]) l();
  }
}

const modes = new Registry<WorkspaceMode>();
const panels = new Registry<TrailingPanel>();
const actions = new Registry<ToolbarAction>();

export const registerMode = modes.register;
export const registerPanel = panels.register;
export const registerToolbarAction = actions.register;

export const getModes = modes.get;
export const getPanels = panels.get;
export const getToolbarActions = actions.get;

/** Registered modes in display order; the component re-renders when the list changes. */
export function useModes(): readonly WorkspaceMode[] {
  return useSyncExternalStore(modes.subscribe, modes.get, modes.get);
}

export function usePanels(): readonly TrailingPanel[] {
  return useSyncExternalStore(panels.subscribe, panels.get, panels.get);
}

export function useToolbarActions(): readonly ToolbarAction[] {
  return useSyncExternalStore(actions.subscribe, actions.get, actions.get);
}

/**
 * The modes that can show for a state, in display order: the available ones, and while no model is
 * open only those that show without one.
 */
export function availableModes(list: readonly WorkspaceMode[], state: AppState): WorkspaceMode[] {
  const model = documentKind(state) === 'model';
  return list.filter((m) => (m.isAvailable ? m.isAvailable(state) : true) && (model || (m.showsWithoutModel?.(state) ?? false)));
}

/**
 * The mode on screen: the one the person picked for this document when it is available, else the
 * document's default (`isDefault`), else the first available one; null: none (the start screen).
 */
export function resolveMode(list: readonly WorkspaceMode[], state: AppState): WorkspaceMode | null {
  const available = availableModes(list, state);
  const picked = state.mode && state.modeFor === documentKey(state) ? available.find((m) => m.id === state.mode) : undefined;
  return picked ?? available.find((m) => m.isDefault?.(state) ?? false) ?? available[0] ?? null;
}

/** The document of the mode on screen (Save, Undo and Redo act on it), or null: the model is the document. */
export function activeDocument(state: AppState, list: readonly WorkspaceMode[] = getModes()): ModeDocument | null {
  return resolveMode(list, state)?.document ?? null;
}

/** The documents of every mode available for `state`, on screen or not (the unsaved-changes prompt asks about them). */
export function modeDocuments(state: AppState, list: readonly WorkspaceMode[] = getModes()): ModeDocument[] {
  return [...new Set(availableModes(list, state).flatMap((m) => (m.document ? [m.document] : [])))];
}

const unsubscribed = (): void => undefined;

/** The state of a mode document (the component re-renders when it changes); null without a document. */
export function useDocumentState(document: ModeDocument | null | undefined): ModeDocumentState | null {
  const subscribe = useCallback((listener: () => void) => (document ? document.subscribe(listener) : unsubscribed), [document]);
  const get = useCallback(() => document?.getState() ?? null, [document]);
  return useSyncExternalStore(subscribe, get, get);
}
