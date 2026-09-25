/**
 * Editor session: the single controller behind the UI.
 *
 * - Loads the model through the protocol, validates it IN THE BROWSER (parseModelText), decodes its
 *   textures and compiles a Rig. When a new version has errors, the last valid Rig stays on screen
 *   (`stale`) and the diagnostics describe the new version.
 * - Live reload: /api/events "model-changed" re-fetches the file; params, time, selection and camera
 *   survive the reload (ids that disappeared are dropped).
 * - Playback: global clock + core Player (incremental physics). Explicit parameter values (sliders,
 *   pinned physics outputs) beat animation and physics (SPEC §9); starting playback releases
 *   explicit values of params the animation drives. Layers carry their options (mode, start, hold).
 * - Edits: Inspector edits replace one object in the RAW document, are recorded in a snapshot
 *   history (undo/redo) and written with PUT {doc, baseMtimeMs}: when the file changed on disk since
 *   the version shown, the server refuses the write and the user picks reload or overwrite
 *   (`conflict`) instead of silently losing the other change.
 * - AI bridge: EditorCommands from the server are applied here; the view state is published with
 *   POST /api/state (at most every 200 ms, trailing).
 * - Files: the server works in a workspace root with at most one open model. New / Open / Save As /
 *   Import / Close go through the workspace endpoints; switching files resets the document, the undo
 *   history and the view state (Save As keeps the view). Actions that replace an unsaved document
 *   ask first (files/guard.ts). "file-changed" events (another tab or an AI switched files) are
 *   followed; with no model open the UI shows its start screen (status 'empty').
 */
import {
  Rig,
  buildRenderList,
  parseJsonc,
  parseModelText,
  validateModel,
  type Diagnostic,
  type Model,
  type Player,
  type Pose,
  type PoseOptions,
  type RenderList,
  type TextureInfo,
} from '../../../src/core/index.js';
import { formatModelJson } from '../../../src/core/format.js';
import * as api from '../api.js';
import type { EditorCommand, EditorState, FileChangedEvent, ModelChangedEvent, NewRequest, OpenResult, WorkspaceInfo } from '../api.js';
import { GUARD_IDLE, guardStep, type GuardChoice, type GuardEffect, type GuardEvent, type GuardState } from '../files/guard.js';
import { modelTextProblem, planImport, readImportFiles } from '../files/importing.js';
import { summarizeNotes } from '../files/notes.js';
import { baseName, relativeToRoot, samePath } from '../files/paths.js';
import { fitRect, roundRect, unionRects, visibleRect, zoomAt, type Camera, type Rect, type ViewportSize } from '../view/camera.js';
import {
  errorCount,
  initialState,
  OVERLAY_LAYERS,
  type AppState,
  type BackgroundMode,
  type BottomTab,
  type LayerState,
  type OverlayLayer,
  type PanelName,
  type Toast,
} from './app.js';
import {
  DocHistory,
  findEntityIndex,
  parseRefKey,
  refAfterEdit,
  refKey,
  replaceEntity,
  resolveRef,
  type EntityRef,
  type RawDoc,
} from './doc.js';
import { rigHighlight } from '../overlay/highlight.js';
import {
  activeLayers,
  advanceClock,
  animatedParams,
  explicitOptions,
  layerPhase,
  physicsOutputsByParam,
  type LayerOptions,
  type LayerSetting,
} from './playback.js';
import { shallowEqual, Store } from './store.js';

export interface Frame {
  rig: Rig;
  pose: Pose;
  list: RenderList;
}

export interface TextureEntry {
  /** Identifies the source: path + fetch version. */
  key: string;
  bitmap: ImageBitmap;
  info: TextureInfo;
}

export interface EditResult {
  ok: boolean;
  /** Diagnostics of the edited document (all of them; callers filter by pointer). */
  diagnostics: Diagnostic[];
  /** Reference of the edited object after the edit (follows id renames). */
  ref?: EntityRef;
  /** The edit was not applied because the document would have errors (retry with force). */
  blocked?: boolean;
  message?: string;
}

/** Outcome of a file operation (dialogs show `error` inline; `exists` asks to replace the target). */
export type FileOpResult = { ok: true } | { ok: false; error?: string; hint?: string; exists?: boolean; cancelled?: boolean };

type FocusTarget = Rect | 'fit' | 'canvas' | 'selection';

/** How an ingested version relates to the undo history. */
type HistoryMode = 'reset' | 'external' | 'none';

const PUBLISH_INTERVAL_MS = 200;
const FIT_PADDING_MODEL = 16;
const OWN_WRITES_KEPT = 32;
/** A model file found missing is fetched once more after this delay (delete + re-create saves). */
const MISSING_RETRY_MS = 250;
/** AI commands kept while a model loads (the oldest are dropped beyond this). */
const MAX_PENDING_COMMANDS = 64;

function isPlainObject(v: unknown): v is RawDoc {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The server's own error text (ApiRequestError.detail) when there is one. */
function detailOf(e: unknown): string {
  const d = (e as { detail?: unknown } | null)?.detail;
  return typeof d === 'string' && d ? d : messageOf(e);
}

/** 409 "no model is open" (duck-typed: works with any ApiRequestError-like error). */
function isNoModel(e: unknown): boolean {
  const status = (e as { status?: unknown } | null)?.status;
  return status === 409 && /no model is open/i.test(`${detailOf(e)} ${messageOf(e)}`);
}

/** GET /api/model answered 404: the open model's file was deleted or moved on disk. */
function isMissingFile(e: unknown): boolean {
  return (e as { status?: unknown } | null)?.status === 404;
}

/**
 * A failed file operation. new / save-as / import answer 409 when the target exists (FileExistsError);
 * checked by status so it also works with protocol fakes.
 */
function failure(e: unknown): FileOpResult {
  const hint = (e as { hint?: unknown } | null)?.hint;
  const exists = (e as { status?: unknown } | null)?.status === 409 && !isNoModel(e);
  return { ok: false, error: detailOf(e), ...(typeof hint === 'string' ? { hint } : {}), ...(exists ? { exists } : {}) };
}

/** Save a URL (same-origin or blob:) through a temporary download link. */
function triggerDownload(href: string, name: string): void {
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

const round = (v: number, digits: number): number => {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
};

/** "id", "id@0.5", "id@0.5 (add, from 1s, once)" for bridge notes. */
function layerLabel(l: LayerSetting): string {
  const o = explicitOptions(l);
  const opts = [o.mode, o.start !== undefined ? `from ${o.start}s` : '', o.hold === false ? 'once' : ''].filter(Boolean);
  return `${l.weight === 1 ? l.id : `${l.id}@${l.weight}`}${opts.length ? ` (${opts.join(', ')})` : ''}`;
}

/**
 * The physics output of each output parameter before an explicit value replaced it: the raw output
 * clamped to the parameter range (the value physics would show if the parameter were not pinned).
 */
function physicsValuesOf(model: Model, pose: Pose): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [param, outputs] of physicsOutputsByParam(pose.physics)) {
    const p = model.parameters.find((q) => q.id === param);
    const last = outputs[outputs.length - 1];
    if (!p || !Number.isFinite(last.raw)) continue;
    out[param] = Math.min(p.max, Math.max(p.min, last.raw));
  }
  return out;
}

export class Session {
  readonly store = new Store<AppState>(initialState());
  /** Compiled rig of `store.model` (the last valid version). */
  rig: Rig | null = null;
  /** Decoded textures of the current rig, by texture id. */
  textures = new Map<string, TextureEntry>();
  /** Increments whenever `textures` is replaced (renderers re-upload). */
  textureVersion = 0;
  /** Viewport counters, updated by the renderer loop (read by the status bar and the test hook). */
  readonly renderStats = { frames: 0, draws: 0, triangles: 0, lastDrawAt: 0 };

  private player: Player | null = null;
  private frame: Frame | null = null;
  private frameKey = '';
  private readonly history = new DocHistory();
  private disposeEvents: (() => void) | null = null;
  private unsubscribePublish: (() => void) | null = null;
  /** Monotonic id of the latest load/write; async results of older ones are dropped. */
  private seq = 0;
  /** Queued and in-flight writes (PUT + local ingest) as one chain: each starts after the previous one. */
  private writing: Promise<boolean> | null = null;
  /** mtimes of versions this session wrote: their "model-changed" events are echoes, not edits by others. */
  private readonly ownWrites: number[] = [];
  /** Cache-busting counter for texture fetches (bumped on external changes). */
  private textureFetch = 0;
  private lastTick = 0;
  private pendingFocus: FocusTarget | null = 'canvas';
  private requestFrame: () => void = () => {};
  private publishTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPublished = '';
  private publishWarned = false;
  private toastSeq = 0;
  private readonly toastTimers = new Map<number, ReturnType<typeof setTimeout>>();
  /** Increments whenever the open document is replaced; results of writes to an older one are dropped. */
  private epoch = 0;
  /** Unsaved-changes prompt (state machine in files/guard.ts) and the action waiting for it. */
  private guard: GuardState = GUARD_IDLE;
  private guardResolve: ((proceed: boolean) => void) | null = null;
  /** The unsaved document the user already chose to discard (a retried action does not ask again). */
  private discardedDoc: RawDoc | null = null;
  /** Own file operations in flight: "file-changed" events meanwhile wait until they end. */
  private fileOps = 0;
  /** The last "file-changed" event received during an own operation (its echo, or a switch by someone else). */
  private deferredFileEvent: FileChangedEvent | null = null;
  /** Outcome of the last write, for the unsaved-changes prompt. */
  private lastWrite: { ok: boolean; message?: string; invalid?: boolean } = { ok: true };
  /**
   * AI commands received while a model is loading (e.g. right after an AI opened it: "open, then set
   * params, select..."): applied once it is shown, so they reach the model they were meant for.
   */
  private pendingCommands: EditorCommand[] = [];

  get(): AppState {
    return this.store.get();
  }

  // ------------------------------------------------------------------------------ lifecycle

  async start(): Promise<void> {
    this.disposeEvents = api.connectEvents({
      onOpen: () => {
        const wasOffline = this.get().connection === 'offline';
        this.store.set({ connection: 'live' });
        // A (re)started server has no view state until the UI publishes one, even if nothing changed.
        this.lastPublished = '';
        this.schedulePublish();
        // Changes may have been missed while disconnected (including another model being opened).
        if (wasOffline && this.get().status !== 'loading') {
          void this.refreshWorkspace();
          void this.reload('external', true);
        }
      },
      onError: () => this.store.set({ connection: 'offline' }),
      onModelChanged: (e) => void this.onModelChanged(e),
      onFileChanged: (e) => void this.onFileChanged(e),
      onCommand: (c) => this.handleCommand(c),
      onProtocolError: (m) => console.warn(`[rev2d] ${m}`),
    });
    this.unsubscribePublish = this.store.subscribe(() => {
      this.schedulePublish();
      if (this.pendingCommands.length && this.get().status !== 'loading') queueMicrotask(() => this.flushCommands());
    });
    // With no model open, go straight to the start screen (GET /api/model would only answer 409).
    const workspace = await this.refreshWorkspace();
    if (workspace && workspace.current === null) this.showStartScreen();
    else await this.reload('reset', true);
  }

  dispose(): void {
    this.disposeEvents?.();
    this.unsubscribePublish?.();
    if (this.publishTimer) clearTimeout(this.publishTimer);
    for (const t of this.toastTimers.values()) clearTimeout(t);
    for (const t of this.textures.values()) t.bitmap.close();
    this.textures.clear();
  }

  /** The viewport registers how to schedule a redraw. */
  setFrameRequester(fn: () => void): void {
    this.requestFrame = fn;
  }

  // ------------------------------------------------------------------------------ loading

  /** Fetch the file from the server and ingest it. Resolves whether a version from disk is shown now. */
  async reload(history: HistoryMode = 'external', bustTextures = false): Promise<boolean> {
    const seq = ++this.seq;
    // The start screen stays up while checking whether the server has a model now.
    const status = this.get().status;
    if (status === 'loading' || status === 'failed') this.store.set({ status: 'loading', loadError: null });
    try {
      let file: api.ModelFile;
      try {
        file = await api.fetchModel();
      } catch (e) {
        // Programs that save by deleting and re-creating the file: give it a moment to come back.
        if (!isMissingFile(e) || this.get().status !== 'ready') throw e;
        await new Promise((r) => setTimeout(r, MISSING_RETRY_MS));
        if (seq !== this.seq) return false;
        file = await api.fetchModel();
      }
      if (seq !== this.seq) return false;
      if (bustTextures) this.textureFetch++;
      // A different model than the one shown (opened elsewhere while disconnected): start afresh.
      if (this.get().file && !samePath(file.file, this.get().file)) {
        this.resetDocument();
        history = 'reset';
      }
      // (resetDocument above starts a new sequence: what counts is whether this ingest is still current.)
      const ingestSeq = this.seq;
      await this.ingest(file.text, { file: file.file, mtimeMs: file.mtimeMs, history, seq: ingestSeq });
      return ingestSeq === this.seq;
    } catch (e) {
      if (seq !== this.seq) return false;
      if (isNoModel(e)) this.showStartScreen();
      else if (isMissingFile(e) && this.get().status === 'ready') this.markMissing();
      else if (this.get().status !== 'ready') this.store.set({ status: 'failed', loadError: messageOf(e) });
      else this.toast('error', `Reload failed: ${messageOf(e)}`);
      return false;
    }
  }

  /**
   * The open model's file was deleted or moved away on disk. The document stays open as unsaved:
   * Save writes it back (the server re-creates the file), Save As stores it elsewhere, and leaving
   * or switching files asks first.
   */
  private markMissing(): void {
    const s = this.get();
    const name = baseName(s.file) || 'The model file';
    if (!s.doc) {
      this.toast('warning', `${name} was deleted or moved on disk.`);
      return;
    }
    this.store.set({ unsaved: true, conflict: null });
    this.toast('warning', `${name} was deleted or moved on disk. It is still open here: Save (Ctrl+S) writes it back, Save As… stores it elsewhere.`);
  }

  private async onModelChanged(e: ModelChangedEvent): Promise<void> {
    if (this.writing) await this.writing.catch(() => undefined);
    if (this.get().status === 'empty' || this.fileOps > 0) return;
    const s = this.get();
    // Echo of our own write (its PUT response carried this mtime) or of the version already shown.
    if (e.origin === 'editor') {
      const own = this.ownWrites.indexOf(e.mtimeMs);
      if (own >= 0) this.ownWrites.splice(own, 1);
      if (own >= 0 || e.mtimeMs === s.mtimeMs) return;
    }
    // An open write conflict keeps the user's edit on screen until they choose (conflict banner);
    // an overwrite is then based on this newest version.
    if (s.conflict) {
      if (e.mtimeMs > 0) this.store.set({ conflict: { ...s.conflict, mtimeMs: e.mtimeMs } });
      return;
    }
    const replacesEdit = s.unsaved && e.origin === 'external';
    // (A deleted file keeps the edit: reload reports that instead.)
    if ((await this.reload('external', e.origin === 'external')) && replacesEdit) {
      this.toast('warning', 'The file changed on disk; your unsaved edit was replaced by the new version.');
    }
  }

  /**
   * Validate + compile a version of the file. On success the new rig replaces the old one while
   * view state is carried over; on failure the old rig stays and `stale` is set.
   */
  private async ingest(
    text: string,
    opts: { file?: string; mtimeMs: number; history: HistoryMode; seq: number },
  ): Promise<void> {
    const parsed = parseJsonc(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    const doc = parsed.ok && isPlainObject(parsed.value) ? parsed.value : null;
    const result = parseModelText(text);
    const diagnostics = [...result.diagnostics];
    let rig: Rig | null = null;
    let textures: Map<string, TextureEntry> | null = null;
    if (result.model) {
      const loaded = await this.loadTextures(result.model);
      if (opts.seq !== this.seq) {
        this.releaseUnused(loaded.entries);
        return;
      }
      diagnostics.push(...loaded.diagnostics);
      textures = loaded.entries;
      if (errorCount(loaded.diagnostics) === 0) {
        try {
          rig = new Rig(result.model, { textures: loaded.info });
        } catch (e) {
          diagnostics.push({
            severity: 'error',
            code: 'rig-compile',
            message: messageOf(e),
            path: '',
            hint: 'the model validated but could not be compiled; run `rev2d validate` for details',
          });
        }
      }
    }

    if (doc) this.recordHistory(doc, opts.history);
    const s = this.get();
    const common: Partial<AppState> = {
      status: 'ready',
      loadError: null,
      file: opts.file ?? s.file,
      mtimeMs: opts.mtimeMs,
      text,
      doc,
      diagnostics,
      ...this.historyFlags(),
      // A version read from disk is, by definition, saved (and resolves a write conflict).
      ...(opts.history !== 'none' ? { unsaved: false, conflict: null } : {}),
    };

    if (!rig || !textures) {
      if (textures) this.releaseUnused(textures);
      this.store.set({ ...common, stale: this.rig !== null });
      if (this.get().bottomTab !== 'problems' && errorCount(diagnostics) > 0 && !this.rig) this.showDock('problems');
      this.requestFrame();
      return;
    }

    const prev = this.textures;
    this.textures = textures;
    for (const [id, entry] of prev) if (textures.get(id) !== entry) entry.bitmap.close();
    this.textureVersion++;
    this.rig = rig;
    this.player = rig.player();
    this.frame = null;
    this.frameKey = '';
    const model = rig.model;
    this.store.set({ ...common, ...this.carryOver(model, doc), model, modelVersion: s.modelVersion + 1, stale: false, validAt: Date.now() });
    if (this.pendingFocus) this.focus(this.pendingFocus);
    this.requestFrame();
  }

  /** View state that survives a reload, minus ids that no longer exist. */
  private carryOver(model: Model, doc: RawDoc | null): Partial<AppState> {
    const s = this.get();
    const params = new Map(model.parameters.map((p) => [p.id, p]));
    const overrides: Record<string, number> = {};
    for (const [id, v] of Object.entries(s.overrides)) {
      const p = params.get(id);
      if (p) overrides[id] = Math.min(p.max, Math.max(p.min, v));
    }
    const anims = new Set(model.animations.map((a) => a.id));
    const parts = new Set(model.parts.map((p) => p.id));
    return {
      overrides,
      animation: s.animation && anims.has(s.animation) ? s.animation : null,
      layers: s.layers.filter((l) => anims.has(l.id)),
      hidden: s.hidden.filter((id) => parts.has(id)),
      selection: s.selection.filter((k) => resolveRef(doc, k) !== null),
      hover: null,
    };
  }

  private recordHistory(doc: RawDoc, mode: HistoryMode): void {
    if (mode === 'reset' || !this.history.current) this.history.reset(doc);
    else if (mode === 'external' && JSON.stringify(this.history.current.doc) !== JSON.stringify(doc)) {
      this.history.push(doc, 'External change');
    }
  }

  private historyFlags(): Pick<AppState, 'canUndo' | 'canRedo' | 'undoLabel' | 'redoLabel'> {
    return {
      canUndo: this.history.canUndo,
      canRedo: this.history.canRedo,
      undoLabel: this.history.undoLabel,
      redoLabel: this.history.redoLabel,
    };
  }

  /** Decode every texture of `model`, reusing bitmaps whose source did not change. */
  private async loadTextures(
    model: Model,
  ): Promise<{ entries: Map<string, TextureEntry>; info: Record<string, TextureInfo>; diagnostics: Diagnostic[] }> {
    const entries = new Map<string, TextureEntry>();
    const info: Record<string, TextureInfo> = {};
    const diagnostics: Diagnostic[] = [];
    const version = this.textureFetch;
    await Promise.all(
      model.textures.map(async (tex, i) => {
        const key = `${version}|${tex.path}`;
        let entry = this.textures.get(tex.id);
        if (!entry || entry.key !== key) {
          try {
            const bitmap = await api.fetchTexture(tex.id, version);
            entry = { key, bitmap, info: { width: bitmap.width, height: bitmap.height } };
          } catch (e) {
            diagnostics.push({
              severity: 'error',
              code: 'texture-load',
              message: `cannot load texture "${tex.id}": ${messageOf(e)}`,
              path: `/textures/${i}/path`,
              hint: 'paths are relative to the model file; only PNG is supported',
            });
            return;
          }
        }
        entries.set(tex.id, entry);
        info[tex.id] = entry.info;
        if ((tex.width && tex.width !== entry.info.width) || (tex.height && tex.height !== entry.info.height)) {
          diagnostics.push({
            severity: 'warning',
            code: 'texture-size-mismatch',
            message: `texture "${tex.id}" is ${entry.info.width}x${entry.info.height} but declares ${tex.width ?? '?'}x${tex.height ?? '?'}`,
            path: `/textures/${i}`,
            hint: 'remove width/height or fix them; the decoded size is used',
          });
        }
      }),
    );
    return { entries, info, diagnostics };
  }

  /** Close bitmaps of a discarded texture set that the live set does not share. */
  private releaseUnused(entries: Map<string, TextureEntry>): void {
    for (const [id, entry] of entries) if (this.textures.get(id) !== entry) entry.bitmap.close();
  }

  /**
   * Forget the open document before another one is shown: pending loads, the undo history (its steps
   * would write the old document into the new file), textures and the compiled rig. `keepView`
   * (Save As: the same model under a new name) keeps parameters, animation, selection and camera.
   */
  private resetDocument(opts: { keepView?: boolean } = {}): void {
    this.seq++;
    this.epoch++;
    this.history.clear();
    this.ownWrites.length = 0;
    this.discardedDoc = null;
    this.rig = null;
    this.player = null;
    this.frame = null;
    this.frameKey = '';
    for (const t of this.textures.values()) t.bitmap.close();
    this.textures = new Map();
    this.textureVersion++;
    this.textureFetch++;
    this.lastPublished = '';
    // Toast actions (Retry, Save anyway) act on the open document: they would now hit the next one.
    for (const t of this.get().toasts) if (t.action) this.dismissToast(t.id);
    const view: Partial<AppState> = opts.keepView
      ? {}
      : {
          hidden: [],
          selection: [],
          animation: null,
          animationWeight: 1,
          animationOptions: {},
          layers: [],
          playing: false,
          time: 0,
          overrides: {},
          values: {},
          physicsValues: {},
          drawOrder: [],
          search: '',
        };
    if (!opts.keepView) this.pendingFocus = 'canvas';
    this.store.set({
      file: '',
      mtimeMs: 0,
      text: '',
      doc: null,
      diagnostics: [],
      model: null,
      stale: false,
      validAt: null,
      saving: false,
      unsaved: false,
      conflict: null,
      hover: null,
      pointer: null,
      evalError: null,
      ...this.historyFlags(),
      ...view,
    });
    this.requestFrame();
  }

  /** No model is open on the server: the start screen. */
  private showStartScreen(): void {
    this.resetDocument();
    this.store.set({ status: 'empty', loadError: null });
  }

  // ------------------------------------------------------------------------------ evaluation

  /** Layers passed to the rig for the given state. */
  layersOf(s: AppState): LayerSetting[] {
    if (!s.model) return [];
    return activeLayers(s.model, {
      animation: s.animation,
      animationWeight: s.animationWeight,
      animationOptions: s.animationOptions,
      layers: s.layers.filter((l) => l.enabled),
    });
  }

  /** Params driven by the active animation layers. */
  animatedNow(s: AppState = this.get()): Set<string> {
    return s.model ? animatedParams(s.model, this.layersOf(s)) : new Set();
  }

  /** Current frame (pose + render list), re-evaluated only when the pose inputs changed. */
  evaluate(): Frame | null {
    const rig = this.rig;
    if (!rig || !this.player) return null;
    const s = this.get();
    const inputs: PoseOptions = {
      time: s.time,
      animations: this.layersOf(s),
      params: s.overrides,
      physics: s.physics,
    };
    const key = JSON.stringify(inputs);
    if (this.frame && this.frame.rig === rig && key === this.frameKey) return this.frame;
    try {
      const pose = this.player.update(inputs);
      const list = buildRenderList(rig, pose);
      this.frame = { rig, pose, list };
      this.frameKey = key;
      const physicsValues = physicsValuesOf(rig.model, pose);
      this.store.set((st) => ({
        values: shallowEqual(st.values, pose.params) ? st.values : { ...pose.params },
        physicsValues: shallowEqual(st.physicsValues, physicsValues) ? st.physicsValues : physicsValues,
        drawOrder: shallowEqual(st.drawOrder, pose.drawOrder) ? st.drawOrder : pose.drawOrder,
        poseTick: st.poseTick + 1,
        evalError: null,
      }));
    } catch (e) {
      this.frameKey = key;
      this.store.set({ evalError: `Evaluation failed: ${messageOf(e)}` });
    }
    return this.frame;
  }

  /** Last evaluated frame without re-evaluating. */
  currentFrame(): Frame | null {
    return this.frame;
  }

  /** Advance the playback clock (called once per animation frame with the rAF timestamp). */
  tick(now: number): void {
    const s = this.get();
    if (!s.playing) {
      this.lastTick = 0;
      return;
    }
    const dt = this.lastTick ? Math.min(0.1, (now - this.lastTick) / 1000) : 0;
    this.lastTick = now;
    if (dt <= 0) return;
    const step = advanceClock(s.time, dt * s.speed, this.primary(s), s.repeat, explicitOptions(s.animationOptions).start ?? 0);
    this.store.set({ time: step.time, playing: !step.ended });
  }

  private primary(s: AppState): Model['animations'][number] | null {
    return s.model?.animations.find((a) => a.id === s.animation) ?? null;
  }

  // ------------------------------------------------------------------------------ parameters

  setParam(id: string, value: number): void {
    const s = this.get();
    const p = s.model?.parameters.find((q) => q.id === id);
    if (!p || !Number.isFinite(value)) return;
    const patch: Partial<AppState> = { overrides: { ...s.overrides, [id]: Math.min(p.max, Math.max(p.min, value)) } };
    // Posing a parameter the running animation drives pauses playback, otherwise it would fight.
    if (s.playing && this.animatedNow(s).has(id)) patch.playing = false;
    this.store.set(patch);
  }

  resetParam(id: string): void {
    const { [id]: _removed, ...rest } = this.get().overrides;
    this.store.set({ overrides: rest });
  }

  resetAllParams(): void {
    this.store.set({ overrides: {} });
  }

  /**
   * Pin a parameter at its current (e.g. physics-driven) value: an explicit value, which beats
   * animation and physics. Unpin releases it (physics / animation drive it again).
   */
  setPinned(id: string, pinned: boolean): void {
    const s = this.get();
    if (!pinned) return this.resetParam(id);
    const p = s.model?.parameters.find((q) => q.id === id);
    if (!p || id in s.overrides) return;
    this.setParam(id, s.values[id] ?? p.default ?? Math.min(p.max, Math.max(p.min, 0)));
  }

  // ------------------------------------------------------------------------------ playback

  play(): void {
    const s = this.get();
    if (!s.model) return;
    let animation = s.animation;
    if (!animation && !s.layers.some((l) => l.enabled) && s.model.animations.length) animation = s.model.animations[0].id;
    const primary = s.model.animations.find((a) => a.id === animation) ?? null;
    // An animation picked here (none was chosen) plays at full weight, without options.
    const picked = animation !== s.animation;
    const animationWeight = picked ? 1 : s.animationWeight;
    const animationOptions = picked ? {} : s.animationOptions;
    let time = s.time;
    if (primary && !s.repeat) {
      const start = explicitOptions(animationOptions).start ?? 0;
      const local = time - start;
      const atEnd = primary.loop ? local > 0 && layerPhase(time, primary, { start }).local < 1e-6 : local >= primary.duration - 1e-6;
      if (atEnd) time = Math.max(0, start);
    }
    const next = { ...s, animation, animationWeight, animationOptions };
    this.store.set({ animation, animationWeight, animationOptions, time, playing: true, overrides: this.releaseAnimated(next) });
  }

  pause(): void {
    this.store.set({ playing: false });
  }

  togglePlay(): void {
    if (this.get().playing) this.pause();
    else this.play();
  }

  seek(time: number): void {
    if (!Number.isFinite(time)) return;
    this.store.set({ time: Math.max(0, time) });
  }

  /** Step one frame (at meta.fps) forward or back, pausing playback. */
  stepFrame(dir: 1 | -1): void {
    const s = this.get();
    const fps = s.model?.meta.fps ?? 30;
    const frame = Math.round(s.time * fps) + dir;
    this.store.set({ playing: false, time: Math.max(0, frame / fps) });
  }

  /** Pick the main animation (timeline): it plays at full weight, without layer options. */
  setAnimation(id: string | null): void {
    const s = this.get();
    const next = { ...s, animation: id, animationWeight: 1, animationOptions: {} };
    this.store.set({ animation: id, animationWeight: 1, animationOptions: {}, time: 0, overrides: s.playing ? this.releaseAnimated(next) : s.overrides });
  }

  /** Change (or with {} clear) the main animation's layer options. */
  setAnimationOptions(options: LayerOptions): void {
    const s = this.get();
    const animationOptions = explicitOptions(options);
    this.store.set({ animationOptions, overrides: s.playing ? this.releaseAnimated({ ...s, animationOptions }) : s.overrides });
  }

  /** Weight (0..1) of the primary animation. */
  setAnimationWeight(weight: number): void {
    if (!Number.isFinite(weight)) return;
    const s = this.get();
    const animationWeight = Math.min(1, Math.max(0, weight));
    const next = { ...s, animationWeight };
    this.store.set({ animationWeight, overrides: s.playing ? this.releaseAnimated(next) : s.overrides });
  }

  /** Upsert an extra layer's settings (checkbox, weight slider, mode / start / hold options). */
  setLayer(id: string, patch: Partial<Omit<LayerState, 'id'>>): void {
    const s = this.get();
    const cur: LayerState = s.layers.find((l) => l.id === id) ?? { id, weight: 1, enabled: false };
    const merged = { ...cur, ...patch };
    const weight = Math.min(1, Math.max(0, Number.isFinite(merged.weight) ? merged.weight : cur.weight));
    const updated: LayerState = { id, weight, enabled: merged.enabled, ...explicitOptions(merged) };
    const layers = s.layers.some((l) => l.id === id) ? s.layers.map((l) => (l.id === id ? updated : l)) : [...s.layers, updated];
    const next = { ...s, layers };
    this.store.set({ layers, overrides: s.playing ? this.releaseAnimated(next) : s.overrides });
  }

  setSpeed(speed: number): void {
    this.store.set({ speed: Math.min(2, Math.max(0.25, speed)) });
  }

  setRepeat(repeat: boolean): void {
    this.store.set({ repeat });
  }

  setPhysics(physics: boolean): void {
    this.store.set({ physics });
  }

  /** Overrides without the params that the layers of `s` animate. */
  private releaseAnimated(s: AppState): Record<string, number> {
    const animated = this.animatedNow(s);
    if (![...animated].some((id) => id in s.overrides)) return s.overrides;
    return Object.fromEntries(Object.entries(s.overrides).filter(([id]) => !animated.has(id)));
  }

  // ------------------------------------------------------------------------------ selection & view

  select(keys: string[], mode: 'replace' | 'toggle' = 'replace'): void {
    const s = this.get();
    if (mode === 'replace') {
      this.store.set({ selection: shallowEqual(s.selection, keys) ? s.selection : keys });
      return;
    }
    const set = new Set(s.selection);
    for (const k of keys) {
      if (set.has(k)) set.delete(k);
      else set.add(k);
    }
    this.store.set({ selection: [...set] });
  }

  setHover(key: string | null): void {
    this.store.set({ hover: key });
  }

  setPointer(p: [number, number] | null): void {
    this.store.set({ pointer: p });
  }

  toggleOverlay(layer: OverlayLayer): void {
    const s = this.get();
    const overlays = s.overlays.includes(layer) ? s.overlays.filter((l) => l !== layer) : OVERLAY_LAYERS.filter((l) => l === layer || s.overlays.includes(l));
    this.store.set({ overlays });
  }

  setOverlays(layers: OverlayLayer[]): void {
    this.store.set({ overlays: OVERLAY_LAYERS.filter((l) => layers.includes(l)) });
  }

  setBackground(background: BackgroundMode): void {
    this.store.set({ background });
  }

  toggleHidden(partId: string): void {
    const s = this.get();
    this.store.set({ hidden: s.hidden.includes(partId) ? s.hidden.filter((h) => h !== partId) : [...s.hidden, partId] });
  }

  showAllParts(): void {
    this.store.set({ hidden: [] });
  }

  setCamera(camera: Camera): void {
    this.pendingFocus = null;
    this.store.set({ camera });
  }

  setViewport(viewport: ViewportSize): void {
    const s = this.get();
    if (s.viewport.width === viewport.width && s.viewport.height === viewport.height) return;
    this.store.set({ viewport });
    if (this.pendingFocus && viewport.width > 0 && viewport.height > 0) this.focus(this.pendingFocus);
  }

  /** Zoom to an absolute level around the viewport center. */
  zoomTo(zoom: number): void {
    const s = this.get();
    this.setCamera(zoomAt(s.camera, s.viewport, s.viewport.width / 2, s.viewport.height / 2, zoom / s.camera.zoom));
  }

  /** Frame a model-space rect, the visible parts ('fit'), the canvas or the selection. */
  focus(target: FocusTarget): void {
    const s = this.get();
    if (!s.model || s.viewport.width <= 0 || s.viewport.height <= 0) {
      this.pendingFocus = target;
      return;
    }
    const canvas: Rect = [0, 0, s.model.meta.width, s.model.meta.height];
    let rect: Rect | null;
    let padding = 32;
    if (Array.isArray(target)) {
      rect = target;
      padding = 0;
    } else if (target === 'canvas') {
      rect = canvas;
    } else {
      const frame = this.frame ?? this.evaluate();
      // A selection without geometry (parameter, animation, ...) frames the visible parts.
      rect = frame ? ((target === 'selection' ? this.selectionBounds(frame) : null) ?? this.partsBounds(frame)) : null;
      if (rect) rect = [rect[0] - FIT_PADDING_MODEL, rect[1] - FIT_PADDING_MODEL, rect[2] + FIT_PADDING_MODEL * 2, rect[3] + FIT_PADDING_MODEL * 2];
      rect ??= canvas;
    }
    this.pendingFocus = null;
    this.store.set({ camera: fitRect(rect, s.viewport, padding) });
  }

  private partsBounds(frame: Frame): Rect | null {
    const hidden = new Set(this.get().hidden);
    return unionRects(frame.pose.drawOrder.filter((id) => !hidden.has(id)).map((id) => frame.pose.parts[id]?.bounds));
  }

  /** Bounds of what the selection highlights: parts, bones and warps (also via IK / physics). */
  private selectionBounds(frame: Frame): Rect | null {
    const refs = this.get().selection.map(parseRefKey).filter((r): r is EntityRef => r !== null);
    const hl = rigHighlight(frame.rig.model, refs);
    const rects: Array<Rect | null> = refs.filter((r) => r.kind === 'part').map((r) => frame.pose.parts[r.id]?.bounds ?? null);
    for (const id of [...hl.bones, ...hl.targets]) {
      const b = frame.pose.bones[id];
      if (b) rects.push(unionRects([[b.x, b.y, 0, 0], [b.tip[0], b.tip[1], 0, 0]]));
    }
    for (const id of hl.warps) {
      const w = frame.pose.warps[id];
      if (!w) continue;
      const xs: number[] = [];
      const ys: number[] = [];
      for (let i = 0; i < w.points.length; i += 2) {
        xs.push(w.points[i]);
        ys.push(w.points[i + 1]);
      }
      rects.push([Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)]);
    }
    return unionRects(rects);
  }

  // ------------------------------------------------------------------------------ ui helpers

  setPanel(panel: PanelName, open: boolean): void {
    this.store.set((s) => (s.panels[panel] === open ? {} : { panels: { ...s.panels, [panel]: open } }));
  }

  togglePanel(panel: PanelName): void {
    this.setPanel(panel, !this.get().panels[panel]);
  }

  /** Show a tab of the bottom dock, expanding the dock when it is collapsed. */
  showDock(tab: BottomTab): void {
    this.store.set((s) => ({ bottomTab: tab, ...(s.panels.dock ? {} : { panels: { ...s.panels, dock: true } }) }));
  }

  toast(kind: Toast['kind'], text: string, extra: Pick<Toast, 'source' | 'action' | 'details'> = {}): void {
    const id = ++this.toastSeq;
    this.store.set((s) => ({ toasts: [...s.toasts.slice(-4), { id, kind, text, ...extra }] }));
    const ms = extra.action ? 10000 : kind === 'error' ? 9000 : kind === 'warning' || extra.details?.length ? 7000 : 4000;
    this.toastTimers.set(
      id,
      setTimeout(() => this.dismissToast(id), ms),
    );
  }

  dismissToast(id: number): void {
    const timer = this.toastTimers.get(id);
    if (timer) clearTimeout(timer);
    this.toastTimers.delete(id);
    this.store.set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  }

  // ------------------------------------------------------------------------------ edits

  /**
   * Replace one object of the raw document and write it. Edits that would make the document
   * invalid are refused (blocked) unless `force` is set; the diagnostics explain why.
   */
  async applyEdit(ref: EntityRef, value: unknown, force = false): Promise<EditResult> {
    // Build on the document of the previous write, not on the version it is replacing.
    if (this.writing) await this.writing.catch(() => false);
    const s = this.get();
    if (!s.doc) return { ok: false, diagnostics: [], message: 'The file on disk is not valid JSON; fix it in your text editor first.' };
    const index = findEntityIndex(s.doc, ref);
    if (index < 0) return { ok: false, diagnostics: [], message: `${refKey(ref)} no longer exists in the file.` };
    const doc = replaceEntity(s.doc, ref, value);
    const check = validateModel(doc);
    if (errorCount(check.diagnostics) > 0 && !force) return { ok: false, blocked: true, diagnostics: check.diagnostics };
    const next = refAfterEdit(ref, value, index);
    this.history.push(doc, `Edit ${refKey(ref)}`);
    if (refKey(next) !== refKey(ref)) {
      this.store.set({ selection: s.selection.map((k) => (k === refKey(ref) ? refKey(next) : k)) });
    }
    // The edit derives from the version shown: `mtimeMs` changes together with `doc`.
    await this.writeDoc(doc, force, s.mtimeMs);
    return { ok: true, ref: next, diagnostics: check.diagnostics };
  }

  /**
   * Ctrl+S: write the current raw document (formatted) when it is not on disk yet (a rejected or
   * failed write). Otherwise the file already holds it and rewriting would only reformat it.
   */
  async save(force = false): Promise<boolean> {
    if (this.writing) await this.writing.catch(() => false);
    const s = this.get();
    if (s.status !== 'ready') return false;
    if (!s.doc) {
      this.toast('error', 'Nothing to save: the file is not valid JSON.');
      return false;
    }
    if (!s.unsaved && !force) {
      this.toast('info', 'No unsaved changes: the file on disk is up to date.');
      return true;
    }
    const ok = await this.writeDoc(s.doc, force, s.mtimeMs);
    if (ok) this.toast('success', 'Saved');
    return ok;
  }

  /**
   * Settle a write conflict: 'reload' drops the local edit for the version on disk (the edit stays
   * in the undo history); 'overwrite' writes the local document over it on purpose.
   */
  async resolveConflict(choice: 'reload' | 'overwrite'): Promise<void> {
    const s = this.get();
    const conflict = s.conflict;
    if (!conflict) return;
    if (choice === 'reload') {
      // Ingesting the version from disk clears the conflict; a failed reload keeps it open.
      await this.reload('external', true);
      return;
    }
    if (!s.doc) return;
    if (await this.writeDoc(s.doc, conflict.force, conflict.mtimeMs)) this.toast('success', 'Saved: your version replaced the change on disk.');
  }

  async undo(): Promise<void> {
    const step = this.history.undo();
    if (!step) return;
    this.store.set(this.historyFlags());
    await this.writeDoc(step.entry.doc, true);
    this.toast('info', `Undo: ${step.undone}`);
  }

  async redo(): Promise<void> {
    const entry = this.history.redo();
    if (!entry) return;
    this.store.set(this.historyFlags());
    await this.writeDoc(entry.doc, true);
    this.toast('info', `Redo: ${entry.label}`);
  }

  /**
   * PUT {doc}, then ingest the same document locally (the view shows it even when the write was
   * rejected; `unsaved` tells the user it is not on disk). Writes run one after another, in call
   * order (the server applies PUTs in arrival order). Change events arriving meanwhile wait for all
   * queued writes, so echoes of our own writes are recognized by their mtimes.
   *
   * `baseMtimeMs` is the file version `doc` derives from (default: the version shown when the write
   * runs, for documents that replace it wholesale like undo steps).
   */
  private writeDoc(doc: RawDoc, force: boolean, baseMtimeMs?: number, quiet = false): Promise<boolean> {
    // The model this document belongs to: the server refuses the write once another one is open.
    const file = this.get().file;
    const run = (): Promise<boolean> => this.performWrite(doc, force, baseMtimeMs ?? this.get().mtimeMs, quiet, file);
    const write = this.writing ? this.writing.then(run, run) : run();
    this.writing = write;
    void write.finally(() => {
      if (this.writing === write) this.writing = null;
    });
    return write;
  }

  /** `quiet`: failures are reported by the caller (the unsaved-changes prompt), not as toasts. */
  private async performWrite(doc: RawDoc, force: boolean, baseMtimeMs: number, quiet = false, file = this.get().file): Promise<boolean> {
    const seq = ++this.seq;
    const epoch = this.epoch;
    const text = formatModelJson(doc);
    this.store.set({ saving: true });
    let written = false;
    let conflict = this.get().conflict;
    let mtimeMs = this.get().mtimeMs;
    try {
      // mtime 0: the version is unknown (nothing to compare), write unconditionally.
      const res = await api.putModel({ doc }, { force, baseMtimeMs: baseMtimeMs > 0 ? baseMtimeMs : undefined, ...(file ? { file } : {}) });
      written = res.written;
      if (written) {
        this.lastWrite = { ok: true };
        mtimeMs = res.mtimeMs;
        this.ownWrites.push(mtimeMs);
        // Echoes normally arrive within milliseconds; keep only recent ones (events can be lost offline).
        if (this.ownWrites.length > OWN_WRITES_KEPT) this.ownWrites.splice(0, this.ownWrites.length - OWN_WRITES_KEPT);
      } else {
        const n = errorCount(res.diagnostics);
        const message = `Not saved: the server rejected the model (${n} error${n === 1 ? '' : 's'}).`;
        this.lastWrite = { ok: false, message, invalid: true };
        if (!quiet) this.toast('error', message, { action: { label: 'Save anyway', run: () => void this.save(true) } });
      }
    } catch (e) {
      if (e instanceof api.ConflictError) {
        conflict = { mtimeMs: e.mtimeMs, force };
        this.lastWrite = { ok: false, message: 'Not saved: the file changed on disk since it was loaded.' };
      } else if ((e as { file?: unknown }).file !== undefined && (e as { status?: unknown }).status === 409) {
        // FileSwitchedError: another tab or an AI opened another model; follow it (file-changed may be late).
        this.lastWrite = { ok: false, message: `Not saved: ${baseName(String((e as { file: unknown }).file))} was opened meanwhile.` };
        if (!quiet) this.toast('error', `Not saved: another model (${baseName(String((e as { file: unknown }).file))}) was opened meanwhile.`);
        void this.syncWithServer();
      } else {
        this.lastWrite = { ok: false, message: `Save failed: ${messageOf(e)}` };
        if (!quiet) this.toast('error', `Save failed: ${messageOf(e)}`, { action: { label: 'Retry', run: () => void this.save(force) } });
      }
    }
    // Another file was opened meanwhile: this write's outcome no longer describes what is shown.
    if (epoch !== this.epoch) return written;
    if (seq === this.seq) await this.ingest(text, { mtimeMs, history: 'none', seq });
    this.store.set({ saving: false, unsaved: !written, conflict: written ? null : conflict, ...this.historyFlags() });
    return written;
  }

  // ------------------------------------------------------------------------------ files & workspace

  /** Re-read the workspace (root, open model, recent files). Null when the server has no workspace API. */
  async refreshWorkspace(): Promise<WorkspaceInfo | null> {
    try {
      const workspace = await api.fetchWorkspace();
      this.store.set({ workspace });
      return workspace;
    } catch {
      // An older editor server (no /api/workspace): file management stays unavailable.
      return null;
    }
  }

  /** `abs` relative to the workspace root ('/'-separated), or the path itself outside of it. */
  displayPath(abs: string): string {
    const root = this.get().workspace?.root;
    const rel = root ? relativeToRoot(abs, root) : null;
    return rel ?? abs;
  }

  private importPicker: (() => void) | null = null;

  /** The hidden file input registers how to open the browser's file picker. */
  setImportPicker(fn: (() => void) | null): void {
    this.importPicker = fn;
  }

  /** "Import from computer…": the browser's file picker; the picked files open the import dialog. */
  pickImportFiles(): void {
    this.importPicker?.();
  }

  openDialog(dialog: AppState['dialog']): void {
    if (dialog && dialog.kind === 'saveAs' && this.get().status !== 'ready') return;
    this.store.set({ dialog, helpOpen: false });
  }

  closeDialog(): void {
    this.store.set({ dialog: null });
  }

  /**
   * Ask before an action replaces an unsaved document: resolves true to go on (saved, or the user
   * chose "Don't save"), false when the user cancelled or the prompt is already up for another action.
   */
  async confirmUnsaved(action: string): Promise<boolean> {
    if (this.writing) await this.writing.catch(() => false);
    const s = this.get();
    const dirty = s.status === 'ready' && s.unsaved && !(s.doc !== null && s.doc === this.discardedDoc);
    const effect = this.stepGuard({ type: 'request', dirty, file: baseName(s.file) || 'the model', action });
    if (effect === 'proceed') return true;
    if (effect === 'abort') return false;
    return new Promise<boolean>((resolve) => {
      this.guardResolve = resolve;
    });
  }

  /** The user's answer to the unsaved-changes prompt. */
  resolveUnsaved(choice: GuardChoice): void {
    if (choice === 'discard' && this.guard.phase === 'asking') this.discardedDoc = this.get().doc;
    void this.runGuard(this.stepGuard({ type: 'choose', choice }));
  }

  private stepGuard(event: GuardEvent): GuardEffect {
    const { state, effect } = guardStep(this.guard, event);
    this.guard = state;
    this.store.set({ unsavedPrompt: state.phase === 'idle' ? null : state });
    return effect;
  }

  private async runGuard(effect: GuardEffect): Promise<void> {
    if (effect === 'proceed' || effect === 'abort') {
      const resolve = this.guardResolve;
      this.guardResolve = null;
      resolve?.(effect === 'proceed');
      return;
    }
    if (effect !== 'save' && effect !== 'saveAnyway') return;
    const s = this.get();
    let ok = false;
    if (!s.doc) this.lastWrite = { ok: false, message: 'The file is not valid JSON, so it cannot be saved from here.' };
    else ok = await this.writeDoc(s.doc, effect === 'saveAnyway', s.mtimeMs, true);
    if (ok) this.toast('success', 'Saved');
    await this.runGuard(this.stepGuard({ type: 'saved', ok, error: this.lastWrite.message, invalid: this.lastWrite.invalid }));
  }

  /** Drop a pending prompt (the document it is about was replaced from elsewhere). */
  private cancelGuard(): void {
    if (this.guard.phase === 'idle') return;
    this.guard = GUARD_IDLE;
    this.store.set({ unsavedPrompt: null });
    const resolve = this.guardResolve;
    this.guardResolve = null;
    resolve?.(false);
  }

  /**
   * Run a file operation. "file-changed" events that arrive meanwhile are held back: once it ends,
   * the last one is handled (its own echo is recognized by the file now shown; a switch by another
   * tab or an AI right after it is followed, with its toast), else the server is re-read.
   */
  private async fileOp(label: string, run: () => Promise<FileOpResult>): Promise<FileOpResult> {
    this.fileOps++;
    this.store.set({ fileBusy: label });
    try {
      return await run();
    } finally {
      this.fileOps--;
      if (this.fileOps === 0) {
        this.store.set({ fileBusy: null });
        const deferred = this.deferredFileEvent;
        this.deferredFileEvent = null;
        if (deferred) void this.onFileChanged(deferred);
        else void this.syncWithServer();
      }
    }
  }

  /** Follow the server when its open model differs from the one shown (events missed during an operation). */
  private async syncWithServer(): Promise<void> {
    const ws = await this.refreshWorkspace();
    if (!ws || this.fileOps > 0) return;
    const s = this.get();
    if (ws.current === null && s.status === 'ready') this.showStartScreen();
    else if (ws.current !== null && (s.status === 'empty' || (s.status === 'ready' && !samePath(ws.current, s.file)))) {
      this.resetDocument();
      this.store.set({ status: 'loading' });
      await this.reload('reset', true);
    }
  }

  /** Show a model the server just opened (open / new / save-as / import). */
  private async adopt(result: OpenResult, message: string, opts: { keepView?: boolean } = {}): Promise<void> {
    this.resetDocument(opts);
    this.store.set({ status: 'loading', dialog: null });
    await this.ingest(result.text, { file: result.file, mtimeMs: result.mtimeMs, history: 'reset', seq: this.seq });
    const { text, details } = summarizeNotes(message, result.notes);
    this.toast('success', text, details.length ? { details } : {});
    await this.refreshWorkspace();
  }

  /** Open a model of the workspace (absolute or root-relative path). */
  async openFile(file: string): Promise<FileOpResult> {
    // Already open: nothing to do (Reload from disk re-reads it).
    const s = this.get();
    const root = s.workspace?.root;
    const target = /^([a-zA-Z]:[\\/]|[\\/])/.test(file) || !root ? file : `${root}/${file}`;
    if (s.status === 'ready' && samePath(target, s.file)) {
      this.closeDialog();
      return { ok: true };
    }
    if (!(await this.confirmUnsaved(`open ${baseName(file)}`))) return { ok: false, cancelled: true };
    return this.fileOp(`Opening ${baseName(file)}…`, async () => {
      try {
        const result = await api.openModel(file);
        await this.adopt(result, `Opened ${this.displayPath(result.file)}`);
        return { ok: true };
      } catch (e) {
        return failure(e);
      }
    });
  }

  /** Open Recent / start screen: like openFile, errors as toasts. */
  async openRecent(file: string): Promise<void> {
    const r = await this.openFile(file);
    if (!r.ok && !r.cancelled) this.toast('error', `Could not open ${baseName(file)}: ${r.error}${r.hint ? ` (${r.hint})` : ''}`);
  }

  /** Create a model from a template and open it. */
  async createModel(req: NewRequest): Promise<FileOpResult> {
    if (!(await this.confirmUnsaved('create a new model'))) return { ok: false, cancelled: true };
    return this.fileOp(`Creating ${baseName(req.file)}…`, async () => {
      try {
        const result = await api.newModel(req);
        await this.adopt(result, `Created ${this.displayPath(result.file)}`);
        return { ok: true };
      } catch (e) {
        return failure(e);
      }
    });
  }

  /** Write the current document to another file of the workspace and continue editing that one. */
  async saveAs(file: string, overwrite = false): Promise<FileOpResult> {
    if (this.writing) await this.writing.catch(() => false);
    const s = this.get();
    if (s.status !== 'ready') return { ok: false, error: 'No model is open.' };
    return this.fileOp(`Saving ${baseName(file)}…`, async () => {
      try {
        const result = await api.saveAs(s.doc ? { file, doc: s.doc, overwrite } : { file, text: s.text, overwrite });
        await this.adopt(result, `Saved as ${this.displayPath(result.file)}`, { keepView: true });
        return { ok: true };
      } catch (e) {
        return failure(e);
      }
    });
  }

  /** Import a model (+ PNG textures) picked on the user's computer into `dir`, then open it. */
  async importFiles(files: readonly File[], dir: string, overwrite = false): Promise<FileOpResult> {
    const plan = planImport(files);
    if (plan.error) return { ok: false, error: plan.error };
    let payload: Awaited<ReturnType<typeof readImportFiles>>;
    try {
      payload = await readImportFiles(files, plan);
    } catch (e) {
      return { ok: false, error: `Could not read the picked files: ${messageOf(e)}` };
    }
    const model = payload.find((f) => f.name === plan.model);
    const problem = model?.text !== undefined ? modelTextProblem(model.text) : 'The model file could not be read.';
    if (problem) return { ok: false, error: problem };
    if (!(await this.confirmUnsaved(`import ${plan.model}`))) return { ok: false, cancelled: true };
    return this.fileOp(`Importing ${plan.model}…`, async () => {
      try {
        const result = await api.importFiles({ dir, files: payload, overwrite });
        await this.adopt(result, `Imported ${this.displayPath(result.file)}`);
        return { ok: true };
      } catch (e) {
        return failure(e);
      }
    });
  }

  /** Close the model: the server keeps running, the UI shows its start screen. */
  async closeModel(): Promise<FileOpResult> {
    if (this.get().status !== 'ready' && this.get().status !== 'failed') return { ok: true };
    if (!(await this.confirmUnsaved('close it'))) return { ok: false, cancelled: true };
    const r = await this.fileOp('Closing…', async () => {
      try {
        await api.closeModel();
        this.showStartScreen();
        await this.refreshWorkspace();
        return { ok: true };
      } catch (e) {
        return failure(e);
      }
    });
    if (!r.ok && !r.cancelled) this.toast('error', `Could not close the model: ${r.error}`);
    return r;
  }

  /** Re-read the file from disk, dropping an unsaved edit (after asking). */
  async reloadFromDisk(): Promise<void> {
    if (this.get().status !== 'ready') return;
    if (!(await this.confirmUnsaved('reload it from disk'))) return;
    if (await this.reload('external', true)) this.toast('info', `Reloaded ${baseName(this.get().file)} from disk`);
  }

  /**
   * Download the model: the file as on disk, or, while the document shown is not on disk (a failed
   * write, a deleted file), that document itself.
   */
  downloadCopy(): void {
    const s = this.get();
    if (s.status !== 'ready') return;
    if (s.unsaved && s.doc) {
      const url = URL.createObjectURL(new Blob([formatModelJson(s.doc)], { type: 'application/json' }));
      triggerDownload(url, baseName(s.file));
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      this.toast('info', 'Downloaded the version shown in the editor (it is not saved to disk yet).');
      return;
    }
    triggerDownload(api.DOWNLOAD_URL, baseName(s.file));
  }

  /** Download a PNG of the current view (rendered by the server from the published view state). */
  async exportPng(): Promise<void> {
    const s = this.get();
    if (!s.model) return;
    const name = `${baseName(s.file).replace(/(\.r2d)?\.json$/i, '') || 'rev2d'}.png`;
    try {
      await this.publishNow();
      const blob = await api.fetchScreenshot();
      const url = URL.createObjectURL(blob);
      triggerDownload(url, name);
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      this.toast('success', `Exported ${name}`);
    } catch (e) {
      this.toast('error', `Export failed: ${detailOf(e)}`);
    }
  }

  /** Another tab or an AI switched files (or closed the model): follow it. */
  private async onFileChanged(e: FileChangedEvent): Promise<void> {
    // During an own operation: handled when it ends (fileOp).
    if (this.fileOps > 0) {
      this.deferredFileEvent = e;
      return;
    }
    const s = this.get();
    if (e.file !== null && s.status === 'ready' && samePath(e.file, s.file)) return void this.refreshWorkspace();
    if (e.file === null && s.status === 'empty') return void this.refreshWorkspace();
    const lost = s.status === 'ready' && s.unsaved ? baseName(s.file) : null;
    const previous = baseName(s.file);
    // Prompts and dialogs about the old document no longer apply, nor do commands held back for a
    // model that is replaced before it was even shown.
    this.cancelGuard();
    this.pendingCommands = [];
    if (s.dialog?.kind === 'saveAs') this.store.set({ dialog: null });
    const from = e.origin === 'ai' ? { source: 'AI' } : {};
    if (e.file === null) {
      this.showStartScreen();
      this.toast('info', e.origin === 'ai' ? `closed ${previous || 'the model'}` : `${previous || 'The model'} was closed in another tab`, from);
    } else {
      this.resetDocument();
      this.store.set({ status: 'loading' });
      await this.reload('reset', true);
      const name = this.displayPath(e.file);
      this.toast('info', e.origin === 'ai' ? `opened ${name}` : `${name} was opened in another tab`, from);
    }
    if (lost) this.toast('warning', `Your unsaved edit to ${lost} was discarded.`);
    void this.refreshWorkspace();
  }

  // ------------------------------------------------------------------------------ AI bridge

  /** Apply the commands held back while a model was loading. */
  private flushCommands(): void {
    if (this.get().status === 'loading') return;
    const queued = this.pendingCommands;
    this.pendingCommands = [];
    for (const c of queued) this.handleCommand(c);
  }

  handleCommand(c: EditorCommand): void {
    // A model is being loaded (just opened): the command is meant for it, not for the empty view.
    if (this.get().status === 'loading' && c.type !== 'message') {
      this.pendingCommands.push(c);
      if (this.pendingCommands.length > MAX_PENDING_COMMANDS) this.pendingCommands.shift();
      return;
    }
    const s = this.get();
    const model = s.model;
    const note = (text: string): void => this.store.set({ bridge: { text, at: Date.now() } });
    switch (c.type) {
      case 'setParams': {
        const unknown = Object.keys(c.params ?? {}).filter((id) => !model?.parameters.some((p) => p.id === id));
        if (unknown.length) {
          this.toast('warning', `AI setParams: unknown parameter${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')}`, { source: 'AI' });
        }
        const overrides: Record<string, number> = c.reset ? {} : { ...s.overrides };
        let pause = false;
        const animated = this.animatedNow(s);
        for (const [id, v] of Object.entries(c.params ?? {})) {
          const p = model?.parameters.find((q) => q.id === id);
          if (!p || typeof v !== 'number' || !Number.isFinite(v)) continue;
          overrides[id] = Math.min(p.max, Math.max(p.min, v));
          if (animated.has(id)) pause = true;
        }
        this.store.set({ overrides, ...(pause && s.playing ? { playing: false } : {}) });
        note(`setParams ${Object.keys(c.params ?? {}).join(', ')}${c.reset ? ' (reset)' : ''}`);
        return;
      }
      case 'play': {
        if (c.animation !== undefined) {
          if (!model?.animations.some((a) => a.id === c.animation)) {
            this.toast('error', `AI play: unknown animation "${c.animation}"`, { source: 'AI' });
            return;
          }
          this.setAnimation(c.animation);
        }
        this.play();
        note(`play ${c.animation ?? ''}`.trim());
        return;
      }
      case 'pause':
        this.pause();
        note('pause');
        return;
      case 'seek':
        this.seek(c.time);
        note(`seek ${c.time}`);
        return;
      case 'setAnimations': {
        const warn = (text: string): void => this.toast('warning', `AI setAnimations: ${text}`, { source: 'AI' });
        const requested = c.animations ?? [];
        const missing = requested.filter((a) => !model?.animations.some((m) => m.id === a.id)).map((a) => a.id);
        if (missing.length) warn(`unknown animation ${missing.join(', ')}`);
        // Exactly the requested layers, in the requested order (later layers win for param tracks),
        // with their options (mode, start, hold).
        const list: LayerState[] = [];
        const clamped: string[] = [];
        const repeated: string[] = [];
        const badOptions: string[] = [];
        for (const a of requested) {
          if (missing.includes(a.id)) continue;
          if (list.some((l) => l.id === a.id)) {
            repeated.push(a.id);
            continue;
          }
          const w = a.weight ?? 1;
          const weight = Math.min(1, Math.max(0, w));
          if (weight !== w) clamped.push(`${a.id}@${w} -> ${weight}`);
          const options: LayerOptions = {};
          if (a.mode === 'add' || a.mode === 'override') options.mode = a.mode;
          else if (a.mode !== undefined) badOptions.push(`${a.id}: mode ${JSON.stringify(a.mode)}`);
          if (typeof a.start === 'number' && Number.isFinite(a.start)) options.start = a.start;
          else if (a.start !== undefined) badOptions.push(`${a.id}: start ${JSON.stringify(a.start)}`);
          if (typeof a.hold === 'boolean') options.hold = a.hold;
          else if (a.hold !== undefined) badOptions.push(`${a.id}: hold ${JSON.stringify(a.hold)}`);
          list.push({ id: a.id, weight, enabled: true, ...explicitOptions(options) });
        }
        if (clamped.length) warn(`weights are limited to 0..1 in the editor (${clamped.join(', ')})`);
        if (repeated.length) warn(`each animation plays once in the editor; ignored repeated ${repeated.join(', ')}`);
        if (badOptions.length) warn(`ignored bad layer options (${badOptions.join(', ')}); mode is "override" or "add", start a number of seconds, hold true or false`);
        const [first, ...rest] = list;
        // Other extra layers keep their remembered settings, disabled, after the requested ones.
        const layers = [...rest, ...s.layers.filter((l) => !list.some((x) => x.id === l.id)).map((l) => ({ ...l, enabled: false }))];
        const animationOptions = first ? explicitOptions(first) : {};
        const next = { ...s, animation: first?.id ?? null, animationWeight: first?.weight ?? 1, animationOptions, layers };
        this.store.set({
          animation: next.animation,
          animationWeight: next.animationWeight,
          animationOptions,
          layers,
          overrides: s.playing ? this.releaseAnimated(next) : s.overrides,
        });
        note(`setAnimations ${list.map(layerLabel).join(', ') || '(none)'}`);
        return;
      }
      case 'select': {
        const keys: string[] = [];
        const missing: string[] = [];
        // While the file does not parse, ids of the model on screen (the last valid one) still resolve.
        const lookup = s.doc ?? (s.model as unknown as RawDoc | null);
        for (const id of c.ids ?? []) {
          const ref = resolveRef(lookup, id);
          if (ref) keys.push(refKey(ref));
          else missing.push(id);
        }
        if (missing.length) this.toast('warning', `AI select: not found: ${missing.join(', ')}`, { source: 'AI' });
        this.select(keys);
        note(`select ${keys.join(', ') || '(none)'}`);
        return;
      }
      case 'setOverlay': {
        // "all" / "none" as in GET /api/screenshot?overlay= and the CLI.
        const names = c.overlay ?? [];
        const requested = names.includes('all') ? [...OVERLAY_LAYERS] : names.filter((l) => l !== 'none');
        const valid = requested.filter((l): l is OverlayLayer => (OVERLAY_LAYERS as readonly string[]).includes(l));
        const bad = requested.filter((l) => !valid.includes(l as OverlayLayer));
        if (bad.length) this.toast('warning', `AI setOverlay: unknown layer ${bad.join(', ')} (valid: ${OVERLAY_LAYERS.join(', ')})`, { source: 'AI' });
        this.setOverlays(valid);
        note(`overlay ${valid.join(', ') || '(none)'}`);
        return;
      }
      case 'focus': {
        const vb = c.viewBox;
        if (vb === 'fit') this.focus('fit');
        else if (Array.isArray(vb) && vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0) this.focus([vb[0], vb[1], vb[2], vb[3]]);
        else {
          this.toast('warning', `AI focus: bad viewBox ${JSON.stringify(vb)} (need "fit" or [x, y, w, h] with w, h > 0)`, { source: 'AI' });
          return;
        }
        note(`focus ${JSON.stringify(vb)}`);
        return;
      }
      case 'reload':
        void this.reload('external', true);
        note('reload');
        return;
      case 'open':
        // The server switches files itself; this UI follows its "file-changed" event.
        note(`open ${String(c.file ?? '')}`);
        return;
      case 'message':
        this.toast('info', String(c.text ?? ''), { source: 'AI' });
        note('message');
        return;
    }
  }

  /** The view state as published to /api/state (without updatedAt), or null before the first load. */
  editorState(): Omit<EditorState, 'updatedAt'> | null {
    const s = this.get();
    if (s.status !== 'ready') return null;
    const vp = s.viewport;
    return {
      file: s.file,
      params: Object.fromEntries(Object.entries(s.values).map(([k, v]) => [k, round(v, 4)])),
      time: round(s.time, 4),
      animations: this.layersOf(s).map((l) => ({ id: l.id, ...(l.weight === 1 ? {} : { weight: round(l.weight, 3) }), ...explicitOptions(l) })),
      playing: s.playing,
      selection: s.selection,
      overlay: s.overlays,
      viewBox: vp.width > 0 && vp.height > 0 ? roundRect(visibleRect(s.camera, vp)) : null,
      physics: s.physics,
      hidden: s.hidden,
      pinned: Object.keys(s.overrides),
    };
  }

  private schedulePublish(): void {
    if (this.publishTimer) return;
    const body = this.editorState();
    if (!body || JSON.stringify(body) === this.lastPublished) return;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      this.flushPublish();
    }, PUBLISH_INTERVAL_MS);
  }

  /** Publish the view state now (before a screenshot that must show exactly this view). */
  private async publishNow(): Promise<void> {
    if (this.publishTimer) {
      clearTimeout(this.publishTimer);
      this.publishTimer = null;
    }
    const body = this.editorState();
    if (!body) return;
    this.lastPublished = JSON.stringify(body);
    await api.postState({ ...body, updatedAt: new Date().toISOString() });
  }

  private flushPublish(): void {
    const body = this.editorState();
    if (!body) return;
    const json = JSON.stringify(body);
    if (json === this.lastPublished) return;
    this.lastPublished = json;
    api.postState({ ...body, updatedAt: new Date().toISOString() }).catch((e: unknown) => {
      // Allow a retry with the next change.
      this.lastPublished = '';
      if (!this.publishWarned) console.warn(`[rev2d] cannot publish editor state: ${messageOf(e)}`);
      this.publishWarned = true;
    });
  }
}
