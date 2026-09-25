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
import type { EditorCommand, EditorState, ModelChangedEvent } from '../api.js';
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

type FocusTarget = Rect | 'fit' | 'canvas' | 'selection';

/** How an ingested version relates to the undo history. */
type HistoryMode = 'reset' | 'external' | 'none';

const PUBLISH_INTERVAL_MS = 200;
const FIT_PADDING_MODEL = 16;
const OWN_WRITES_KEPT = 32;

function isPlainObject(v: unknown): v is RawDoc {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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
        // Changes may have been missed while disconnected.
        if (wasOffline && this.get().status !== 'loading') void this.reload('external', true);
      },
      onError: () => this.store.set({ connection: 'offline' }),
      onModelChanged: (e) => void this.onModelChanged(e),
      onCommand: (c) => this.handleCommand(c),
      onProtocolError: (m) => console.warn(`[rev2d] ${m}`),
    });
    this.unsubscribePublish = this.store.subscribe(() => this.schedulePublish());
    await this.reload('reset', true);
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

  /** Fetch the file from the server and ingest it. */
  async reload(history: HistoryMode = 'external', bustTextures = false): Promise<void> {
    const seq = ++this.seq;
    const first = this.get().status !== 'ready';
    if (first) this.store.set({ status: 'loading', loadError: null });
    try {
      const file = await api.fetchModel();
      if (seq !== this.seq) return;
      if (bustTextures) this.textureFetch++;
      await this.ingest(file.text, { file: file.file, mtimeMs: file.mtimeMs, history, seq });
    } catch (e) {
      if (seq !== this.seq) return;
      if (this.get().status !== 'ready') this.store.set({ status: 'failed', loadError: messageOf(e) });
      else this.toast('error', `Reload failed: ${messageOf(e)}`);
    }
  }

  private async onModelChanged(e: ModelChangedEvent): Promise<void> {
    if (this.writing) await this.writing.catch(() => undefined);
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
    if (s.unsaved && e.origin === 'external') this.toast('warning', 'The file changed on disk; your unsaved edit was replaced by the new version.');
    await this.reload('external', e.origin === 'external');
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

  toast(kind: Toast['kind'], text: string, extra: Pick<Toast, 'source' | 'action'> = {}): void {
    const id = ++this.toastSeq;
    this.store.set((s) => ({ toasts: [...s.toasts.slice(-4), { id, kind, text, ...extra }] }));
    const ms = extra.action ? 10000 : kind === 'error' ? 9000 : kind === 'warning' ? 6000 : 4000;
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
  async save(force = false): Promise<void> {
    if (this.writing) await this.writing.catch(() => false);
    const s = this.get();
    if (!s.doc) {
      this.toast('error', 'Nothing to save: the file is not valid JSON.');
      return;
    }
    if (!s.unsaved && !force) {
      this.toast('info', 'No unsaved changes: the file on disk is up to date.');
      return;
    }
    if (await this.writeDoc(s.doc, force, s.mtimeMs)) this.toast('success', 'Saved');
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
  private writeDoc(doc: RawDoc, force: boolean, baseMtimeMs?: number): Promise<boolean> {
    const run = (): Promise<boolean> => this.performWrite(doc, force, baseMtimeMs ?? this.get().mtimeMs);
    const write = this.writing ? this.writing.then(run, run) : run();
    this.writing = write;
    void write.finally(() => {
      if (this.writing === write) this.writing = null;
    });
    return write;
  }

  private async performWrite(doc: RawDoc, force: boolean, baseMtimeMs: number): Promise<boolean> {
    const seq = ++this.seq;
    const text = formatModelJson(doc);
    this.store.set({ saving: true });
    let written = false;
    let conflict = this.get().conflict;
    let mtimeMs = this.get().mtimeMs;
    try {
      // mtime 0: the version is unknown (nothing to compare), write unconditionally.
      const res = await api.putModel({ doc }, { force, baseMtimeMs: baseMtimeMs > 0 ? baseMtimeMs : undefined });
      written = res.written;
      if (written) {
        mtimeMs = res.mtimeMs;
        this.ownWrites.push(mtimeMs);
        // Echoes normally arrive within milliseconds; keep only recent ones (events can be lost offline).
        if (this.ownWrites.length > OWN_WRITES_KEPT) this.ownWrites.splice(0, this.ownWrites.length - OWN_WRITES_KEPT);
      } else {
        const n = errorCount(res.diagnostics);
        this.toast('error', `Not saved: the server rejected the model (${n} error${n === 1 ? '' : 's'}).`, {
          action: { label: 'Save anyway', run: () => void this.save(true) },
        });
      }
    } catch (e) {
      if (e instanceof api.ConflictError) conflict = { mtimeMs: e.mtimeMs, force };
      else this.toast('error', `Save failed: ${messageOf(e)}`, { action: { label: 'Retry', run: () => void this.save(force) } });
    }
    if (seq === this.seq) await this.ingest(text, { mtimeMs, history: 'none', seq });
    this.store.set({ saving: false, unsaved: !written, conflict: written ? null : conflict, ...this.historyFlags() });
    return written;
  }

  // ------------------------------------------------------------------------------ AI bridge

  handleCommand(c: EditorCommand): void {
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
