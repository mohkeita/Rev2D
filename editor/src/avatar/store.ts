/**
 * The avatar store: everything avatar mode knows about the open avatar project, and every action on
 * it. One instance per page (`avatarStore`), wired to the editor session by `attach(session)`.
 *
 * Document: the RAW avatar.json document (`doc`, possibly an unfinished draft) is edited through the
 * pure functions of geometry.ts / placement.ts. Every edit is a step of the undo history (a drag is
 * one step), is validated with parseAvatarSpec (debounced) and recompiles the live preview from the
 * last built layers (preview.ts). `unsaved` compares with the version on disk; Save writes it with
 * PUT /api/avatar {doc, baseMtimeMs} (409: the conflict banner offers Reload / Overwrite).
 *
 * Layers: when an edit changed a value that cuts layer images (layerInputsHash differs from the
 * build's inputsHash), `stale` is set and `staleItems` lists what changed; "Save and rebuild" saves
 * and runs POST /api/avatar/build, following its SSE "avatar-job" events; the preview keeps the old
 * layers until the job is done.
 *
 * Live updates: SSE "avatar-changed" (an agent or another tab edited avatar.json, textures/ or the
 * illustration) reloads what changed, keeping the selection, the camera and the undo history; with
 * unsaved edits the person chooses (`external`: reload, or keep their own).
 *
 * Which project is open follows the session's workspace (`workspace.avatar`); avatar mode is the
 * default mode of an avatar project (avatarMode.tsx). The selected part is reported to the session,
 * which publishes it as EditorState.avatar.part.
 */
import type { Diagnostic } from '../../../src/core/types.js';
import {
  describeAvatarParts,
  parseAvatarSpec,
  type AvatarPartGroupId,
  type AvatarPartGroupInfo,
  type AvatarPartItemInfo,
  type AvatarSpec,
  type LayersMeta,
} from '../../../src/avatar/index.js';
import { VISEME_SHAPES, moraeBeats, mouthShapeAt, textToMorae, type Mora, type Viseme } from '../../../src/lipsync/index.js';
import * as api from '../api.js';
import type { AvatarChangedEvent, AvatarInfo, AvatarJobEvent, AvatarRef, AvatarVariantsImportRequest, AvatarVariantsInfo } from '../api.js';
import type { VariantId } from '../../../src/avatar/index.js';
import { t } from '../i18n/index.js';
import type { Session } from '../state/session.js';
import { Store } from '../state/store.js';
import type { Camera, Rect, ViewInsets, ViewportSize } from '../view/camera.js';
import { sameJson, type HandleRole, type SpecDoc } from './geometry.js';
import { SpecHistory } from './history.js';
import { AvatarPreview } from './preview.js';
import { MISSING_LANDMARK } from './problems.js';
import { changedCutItems, layersStale } from './stale.js';
import { rejectText, variantLabel } from './variantText.js';
import { frameRect, zoomToLevel } from './view.js';

export type PreviewTab = 'pose' | 'lipsync' | 'selected';

export interface AvatarSelection {
  group: AvatarPartGroupId | null;
  item: string | null;
  /** The vertex of a polygon / polyline that was grabbed last (for the numeric fields). */
  vertex: number | null;
}

export interface AvatarHover {
  item: string;
  role: HandleRole | null;
  index: number | null;
  /** Canvas CSS px of the pointer (the tooltip follows it). */
  x: number;
  y: number;
}

export interface AvatarJobView {
  id: string;
  state: AvatarJobEvent['state'];
  layers: boolean;
  /** What the job does: a build, a compile, or an import of drawn variants. */
  kind: 'build' | 'compile' | 'variants';
  /** The steps reported so far, in order. */
  steps: string[];
  last: AvatarJobEvent;
  /** The project had no built model when the job started (its first build). */
  first: boolean;
}

export interface LipSyncState {
  text: string;
  /** Beats per second. */
  rate: number;
  loop: boolean;
  /** performance.now() when the text started playing, or null. */
  startedAt: number | null;
  /** The vowel button held down, or null. */
  vowel: Viseme | null;
  /** The mouth the lip sync drives right now (null: it leaves the mouth alone). */
  mouth: { open: number; form: number } | null;
}

export interface AiJobRef {
  id: string;
  kind: string;
  /** What it works on (an item id for "fix this part"). */
  subject?: string;
}

export interface AvatarState {
  /** The open avatar project (from the session's workspace), or null. */
  ref: AvatarRef | null;
  status: 'none' | 'loading' | 'ready' | 'failed';
  error: string | null;
  info: AvatarInfo | null;
  /** The illustration's size (null: missing or unreadable). */
  image: { file: string; width: number; height: number } | null;
  /** Bumps whenever the illustration bitmap was (re)loaded. */
  sourceVersion: number;

  doc: SpecDoc | null;
  /** The document as on disk (last loaded or written). */
  savedDoc: SpecDoc | null;
  /** mtime of avatar.json the document is based on (the next PUT's baseMtimeMs). */
  mtimeMs: number;
  unsaved: boolean;
  saving: boolean;
  /** The last save was refused: avatar.json changed on disk (Reload / Overwrite). */
  conflict: { mtimeMs: number } | null;
  /** avatar.json changed on disk while there were unsaved edits (Reload / Keep mine). */
  external: { mtimeMs: number } | null;
  /** Diagnostics of `doc` (parseAvatarSpec) plus the server's file problems. */
  diagnostics: Diagnostic[];
  /** The normalized spec of `doc` (null while it has errors). */
  spec: AvatarSpec | null;
  /** Groups and items of `doc` (describeAvatarParts). */
  parts: AvatarPartGroupInfo[];
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;

  meta: LayersMeta | null;
  /** Fetch version of the layer images (bumps after a build). */
  layersVersion: number;
  /** The document the layers were cut from, when known (for the list of changed parts). */
  baseline: SpecDoc | null;
  stale: boolean;
  staleItems: string[];
  /** The project has a built model. */
  hasModel: boolean;
  job: AvatarJobView | null;

  selection: AvatarSelection;
  /** Groups whose handles are hidden. */
  hidden: AvatarPartGroupId[];
  hover: AvatarHover | null;
  camera: Camera;
  viewport: ViewportSize;
  /** Pointer in image px. */
  pointer: [number, number] | null;
  /** Waiting for a click on the canvas that places this item ("strand" / "attachment:<kind>" add one). */
  placing: string | null;

  /** Bumps when the preview rig or its textures changed. */
  previewVersion: number;
  previewError: string | null;
  /** The preview's explicit parameter values (pose sliders). */
  previewParams: Record<string, number>;
  /** The idle animation plays (with physics). */
  idle: boolean;
  /** Seconds of preview playback. */
  clock: number;
  tab: PreviewTab;
  lipsync: LipSyncState;

  ai: AiJobRef | null;

  /** The drawn variants of the project (GET /api/avatar/variants), null until loaded. */
  variants: AvatarVariantsInfo | null;
  variantsError: string | null;
  /** Writing the requests (masks and prompts) right now. */
  requestingVariants: boolean;
}

const NO_SELECTION: AvatarSelection = { group: null, item: null, vertex: null };

export function initialAvatarState(): AvatarState {
  return {
    ref: null,
    status: 'none',
    error: null,
    info: null,
    image: null,
    sourceVersion: 0,
    doc: null,
    savedDoc: null,
    mtimeMs: 0,
    unsaved: false,
    saving: false,
    conflict: null,
    external: null,
    diagnostics: [],
    spec: null,
    parts: [],
    canUndo: false,
    canRedo: false,
    undoLabel: null,
    redoLabel: null,
    meta: null,
    layersVersion: 0,
    baseline: null,
    stale: false,
    staleItems: [],
    hasModel: false,
    job: null,
    selection: NO_SELECTION,
    hidden: [],
    hover: null,
    camera: { cx: 0, cy: 0, zoom: 1 },
    viewport: { width: 0, height: 0 },
    pointer: null,
    placing: null,
    previewVersion: 0,
    previewError: null,
    previewParams: {},
    idle: false,
    clock: 0,
    tab: 'pose',
    lipsync: { text: '', rate: 7, loop: false, startedAt: null, vowel: null, mouth: null },
    ai: null,
    variants: null,
    variantsError: null,
    requestingVariants: false,
  };
}

/** How long validation and the preview recompile wait after the last edit. */
export const RECOMPILE_DEBOUNCE_MS = 80;

function messageOf(e: unknown): string {
  return e instanceof Error ? ((e as { detail?: string }).detail ?? e.message) : String(e);
}

function isPlainObject(v: unknown): v is SpecDoc {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The server's file diagnostics (the illustration, the layers): kept next to the local validation. */
function fileDiagnostics(list: readonly Diagnostic[]): Diagnostic[] {
  return list.filter((d) => d.code === 'file-not-found' || d.code.startsWith('avatar-source') || d.code.startsWith('avatar-layers'));
}

/** Signature of a project file in an AvatarInfo listing ("" when it is not there). */
function fileSig(info: AvatarInfo | null, file: string): string {
  const f = info?.files?.find((x) => x.path === file);
  return f ? `${f.size}:${f.mtimeMs}` : '';
}

export class AvatarStore {
  readonly store = new Store<AvatarState>(initialAvatarState());
  readonly preview = new AvatarPreview();
  /** The illustration, decoded for the 2D canvas. */
  source: ImageBitmap | null = null;
  private readonly history = new SpecHistory();
  private session: Session | null = null;
  private seq = 0;
  private validateTimer: ReturnType<typeof setTimeout> | null = null;
  private gesture: { base: SpecDoc; label: string } | null = null;
  private sourceKey = '';
  /** Insets of the canvas (the part the chrome covers), reported by the canvas component. */
  insets: ViewInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  /** Frame the image once the viewport is known (a new project). */
  private fitPending = true;
  /** mtimes of avatar.json versions this page wrote: their "avatar-changed" echoes are not news. */
  private readonly ownWrites: number[] = [];
  private refreshing: Promise<void> | null = null;
  private refreshAgain = false;
  /** Signature of textures/layers.json when the layers were last loaded. */
  private layersSig = '';

  get(): AvatarState {
    return this.store.get();
  }

  // ------------------------------------------------------------------------------ wiring

  /** Follow the session's open avatar project and the server's avatar events; returns the detacher. */
  attach(session: Session): () => void {
    this.session = session;
    let last = session.get().workspace?.avatar ?? null;
    void this.follow(last);
    // The selected part goes to the session, which publishes it (`rev2d editor state` shows it).
    let part = this.get().selection.item;
    session.setAvatarPart(part);
    const unsubscribeSelf = this.store.subscribe(() => {
      const item = this.get().selection.item;
      if (item === part) return;
      part = item;
      session.setAvatarPart(item);
    });
    const unsubscribe = session.store.subscribe(() => {
      const ref = session.get().workspace?.avatar ?? null;
      if (ref?.project !== last?.project) {
        last = ref;
        void this.follow(ref);
      } else if (ref && !this.get().ref) {
        void this.follow(ref);
      }
    });
    const unlisten = api.listenToEvents({
      onAvatarChanged: (e) => void this.onChanged(e),
      onAvatarJob: (e) => void this.onJob(e),
      onHello: () => {
        if (this.get().ref) void this.refresh({ layers: true, source: true });
      },
    });
    return () => {
      unsubscribe();
      unsubscribeSelf();
      unlisten();
      if (this.session === session) this.session = null;
    };
  }

  private toast(kind: 'info' | 'success' | 'warning' | 'error', text: string, extra: { details?: string[]; action?: { label: string; run: () => void } } = {}): void {
    this.session?.toast(kind, text, extra);
  }

  /** Switch to another project (or none). */
  private async follow(ref: AvatarRef | null): Promise<void> {
    const seq = ++this.seq;
    if (this.validateTimer) clearTimeout(this.validateTimer);
    this.preview.clear();
    this.source?.close();
    this.source = null;
    this.sourceKey = '';
    this.layersSig = '';
    this.history.reset({});
    this.ownWrites.length = 0;
    this.fitPending = true;
    const keep = this.get();
    this.store.set({ ...initialAvatarState(), ref, status: ref ? 'loading' : 'none', hidden: keep.hidden, tab: keep.tab, viewport: keep.viewport, ai: ref && keep.ai && keep.ref?.project === ref.project ? keep.ai : null });
    if (!ref) return;
    try {
      const info = await api.fetchAvatar();
      if (seq !== this.seq) return;
      this.adopt(info, 'reset');
      await Promise.all([this.loadSource(info), this.loadLayers(), this.loadVariants()]);
    } catch (e) {
      if (seq !== this.seq) return;
      this.store.set({ status: 'failed', error: messageOf(e) });
    }
  }

  /** Re-read the project (after an "avatar-changed" event, a build, a reconnect). One at a time. */
  async refresh(opts: { layers?: boolean; source?: boolean } = {}): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return this.refreshing;
    }
    const run = async (): Promise<void> => {
      const seq = this.seq;
      if (!this.get().ref) return;
      let info: AvatarInfo;
      try {
        info = await api.fetchAvatar();
      } catch (e) {
        if (seq === this.seq && (e as { status?: number }).status !== 404) this.toast('error', t('avatar.toast.reloadFailed', { message: messageOf(e) }));
        return;
      }
      if (seq !== this.seq || info.project !== this.get().ref?.project) return;
      this.adopt(info, 'external');
      if (opts.source !== false) await this.loadSource(info);
      await this.loadLayers();
      this.maybeOpenBuiltModel(info);
      await this.loadVariants();
    };
    this.refreshing = run().finally(() => {
      this.refreshing = null;
      if (this.refreshAgain) {
        this.refreshAgain = false;
        void this.refresh(opts);
      }
    });
    return this.refreshing;
  }

  /**
   * Take a GET /api/avatar answer. `reset`: a fresh project (the history starts over); `external`:
   * a change from disk (a step of the history; with unsaved edits it waits for the person).
   */
  adopt(info: AvatarInfo, mode: 'reset' | 'external'): void {
    const s = this.get();
    const parsed = info.specText !== null ? parseAvatarSpec(info.specText) : null;
    const diskDoc = parsed && isPlainObject(parsed.doc) ? parsed.doc : null;
    const meta = info.built.meta;
    // New layer images: other metadata, or layers.json rewritten (a build writes it last).
    const sig = fileSig(info, 'textures/layers.json');
    const metaChanged = !sameJson(meta, s.meta) || sig !== this.layersSig;
    this.layersSig = sig;
    // A job shows while it runs; one that ended before this page saw it is no news.
    const job = info.job && (info.job.state === 'running' || s.job?.id === info.job.job) ? this.jobView(info.job, s.job) : s.job;
    const patch: Partial<AvatarState> = {
      info,
      image: info.image,
      hasModel: info.built.model !== null,
      meta,
      ...(metaChanged ? { layersVersion: s.layersVersion + 1 } : {}),
      job,
    };
    if (mode === 'reset') {
      if (!diskDoc) {
        this.store.set({ ...patch, status: 'failed', error: info.specText === null ? t('avatar.error.noSpec') : t('avatar.error.notJson'), diagnostics: parsed?.diagnostics ?? info.diagnostics });
        return;
      }
      this.history.reset(diskDoc);
      this.store.set({ ...patch, status: 'ready', error: null, doc: diskDoc, savedDoc: diskDoc, parts: describeAvatarParts(diskDoc), mtimeMs: info.mtimeMs, unsaved: false, conflict: null, external: null, ...this.historyFlags() });
      this.validateNow();
      // The layers were cut from exactly this document: changes are measured against it.
      if (meta && !this.get().stale) this.store.set({ baseline: diskDoc });
      return;
    }
    // A change from disk.
    const own = this.ownWrites.includes(info.mtimeMs);
    if (!diskDoc || own || sameJson(diskDoc, s.savedDoc)) {
      // Nothing new in avatar.json (or our own write): only the build state and files changed.
      this.store.set({ ...patch, ...(diskDoc && !s.unsaved && !s.conflict ? { mtimeMs: info.mtimeMs } : {}) });
      if (metaChanged) this.validateNow();
      return;
    }
    if (s.unsaved || s.conflict) {
      this.store.set({ ...patch, external: { mtimeMs: info.mtimeMs } });
      return;
    }
    this.history.push(diskDoc, t('avatar.history.disk'));
    this.store.set({ ...patch, status: 'ready', error: null, doc: diskDoc, savedDoc: diskDoc, parts: describeAvatarParts(diskDoc), mtimeMs: info.mtimeMs, unsaved: false, external: null, ...this.historyFlags() });
    this.validateNow();
  }

  private async loadSource(info: AvatarInfo): Promise<void> {
    const image = info.image;
    if (!image) return;
    const key = `${image.file}|${fileSig(info, image.file)}`;
    if (key === this.sourceKey) return;
    const seq = this.seq;
    try {
      const bitmap = await api.fetchAvatarBitmap(image.file, fileSig(info, image.file) || undefined);
      if (seq !== this.seq) {
        bitmap.close();
        return;
      }
      this.source?.close();
      this.source = bitmap;
      this.sourceKey = key;
      this.store.set((s) => ({ sourceVersion: s.sourceVersion + 1 }));
      this.refit();
    } catch (e) {
      if (seq === this.seq) this.toast('error', t('avatar.toast.imageFailed', { message: messageOf(e) }));
    }
  }

  /** Load the layer images of the current metadata (if not loaded yet), then recompile the preview. */
  private loadLayers(): Promise<void> {
    return this.preview.queue(async () => {
      const s = this.get();
      if (!s.meta) return;
      const version = s.layersVersion;
      const seq = this.seq;
      try {
        await this.preview.setLayers(s.meta, version);
      } catch (e) {
        if (seq === this.seq) this.store.set({ previewError: t('avatar.preview.layersFailed', { message: messageOf(e) }) });
        return;
      }
      if (seq !== this.seq) return;
      this.compilePreview();
    });
  }

  /** The agent (or a terminal) built the project while the editor shows it without a model: open the model. */
  private maybeOpenBuiltModel(info: AvatarInfo): void {
    const session = this.session;
    const model = info.built.model;
    if (!session || !model) return;
    const st = session.get();
    if (st.status === 'empty' && st.workspace?.avatar?.project === info.project && !st.fileBusy) void session.openFile(model);
  }

  // ------------------------------------------------------------------------------ events

  private async onChanged(e: AvatarChangedEvent): Promise<void> {
    const s = this.get();
    if (!s.ref || e.project !== s.ref.project) return;
    const spec = e.files.includes('avatar.json');
    const layers = e.files.some((f) => f.startsWith('textures/'));
    // Echo of our own write.
    if (e.origin === 'editor' && spec && !layers && this.ownWrites.includes(e.mtimeMs) && e.files.length === 1) return;
    await this.refresh({ layers, source: true });
  }

  private jobView(e: AvatarJobEvent, prev: AvatarJobView | null): AvatarJobView {
    const same = prev && prev.id === e.job;
    const steps = same ? [...prev.steps] : [];
    if (e.step && !steps.includes(e.step)) steps.push(e.step);
    const kind = e.kind ?? (e.layers ? 'build' : 'compile');
    return { id: e.job, state: e.state, layers: e.layers, kind, steps, last: e, first: same ? prev.first : !this.get().hasModel && kind === 'build' };
  }

  private async onJob(e: AvatarJobEvent): Promise<void> {
    const s = this.get();
    if (!s.ref || e.project !== s.ref.project) return;
    const prev = s.job;
    if (prev && prev.id === e.job && prev.state !== 'running') return;
    const view = this.jobView(e, prev);
    this.store.set({ job: view });
    // (The server opens the model a first build writes: the session follows it as the same document.)
    if (e.state === 'done') {
      const built = this.get().savedDoc;
      await this.refresh({ layers: true });
      // The layers are now those of the version that was saved for the build.
      if (built && !e.stale) this.store.set({ baseline: built });
      this.validateNow();
      // The banner says it is done (and goes away); an import says what it accepted and refused.
      if (e.kind === 'variants' && e.variants) this.announceImport(e);
      else if (e.report?.warnings) this.toast('warning', t('avatar.toast.builtWarnings', { n: e.report.warnings }), { details: e.report.issues.filter((i) => i.severity === 'warning').slice(0, 4).map((i) => i.message) });
      setTimeout(() => {
        if (this.get().job?.id === e.job && this.get().job?.state === 'done') this.store.set({ job: null });
      }, 3500);
    } else if (e.state === 'failed') {
      this.toast('error', t('avatar.toast.buildFailed', { message: e.message ?? '' }));
    }
  }

  // ------------------------------------------------------------------------------ drawn variants

  /** Re-read the drawn variants (GET /api/avatar/variants). Quietly keeps the last answer on failure. */
  async loadVariants(): Promise<void> {
    const seq = this.seq;
    if (!this.get().ref) return;
    try {
      const variants = await api.fetchAvatarVariants();
      if (seq === this.seq && variants.project === this.get().ref?.project) this.store.set({ variants, variantsError: null });
    } catch (e) {
      if (seq === this.seq) this.store.set({ variantsError: messageOf(e) });
    }
  }

  /**
   * Import the drawings in variants/ (all, or `ids`), after deleting the `remove` drawings: a job like
   * a build (its banner shows; SSE "avatar-job" with kind "variants" brings the result).
   */
  async importVariants(req: AvatarVariantsImportRequest = {}): Promise<boolean> {
    const s = this.get();
    if (!s.ref || s.job?.state === 'running') return false;
    try {
      const first = await api.startVariantsImport(req);
      await this.onJob(first);
      return true;
    } catch (e) {
      this.toast('error', t('avatar.variants.importFailed', { message: messageOf(e) }));
      return false;
    }
  }

  /** Write the masks and prompts of `ids` (default: the recommended ones and every earlier request). */
  async requestVariants(ids?: VariantId[]): Promise<boolean> {
    if (!this.get().ref || this.get().requestingVariants) return false;
    this.store.set({ requestingVariants: true });
    try {
      const r = await api.requestAvatarVariants(ids?.length ? { ids } : {});
      this.toast('success', t('avatar.variants.requested', { n: r.requests.length }), { details: [r.readme] });
      await this.loadVariants();
      return true;
    } catch (e) {
      this.toast('error', t('avatar.variants.requestFailed', { message: messageOf(e) }));
      return false;
    } finally {
      this.store.set({ requestingVariants: false });
    }
  }

  /** The toast after an import: accepted ones, and the reasons of refused ones. */
  private announceImport(e: AvatarJobEvent): void {
    const v = e.variants!;
    void this.loadVariants();
    if (v.rejected.length) {
      this.toast('warning', t('avatar.variants.importRejected', { n: v.rejected.length, accepted: v.accepted.length }), {
        details: v.rejected.slice(0, 3).map((r) => `${variantLabel(t, r.id)}: ${rejectText(t, r.code, r.values, r.reason)}`),
      });
    } else if (v.accepted.length || v.removed.length) {
      this.toast('success', v.accepted.length ? t('avatar.variants.importDone', { n: v.accepted.length }) : t('avatar.variants.removedDone', { n: v.removed.length }));
    } else {
      this.toast('info', t('avatar.variants.importNothing'));
    }
  }

  // ------------------------------------------------------------------------------ validation & preview

  private scheduleValidate(): void {
    if (this.validateTimer) clearTimeout(this.validateTimer);
    this.validateTimer = setTimeout(() => {
      this.validateTimer = null;
      this.validateNow();
    }, RECOMPILE_DEBOUNCE_MS);
  }

  /** Validate the document, update the stale state and recompile the preview. */
  validateNow(): void {
    if (this.validateTimer) {
      clearTimeout(this.validateTimer);
      this.validateTimer = null;
    }
    const s = this.get();
    if (!s.doc) return;
    const image = s.image;
    const parsed = parseAvatarSpec(s.doc, image ? { imageSize: { width: image.width, height: image.height }, imageName: image.file } : {});
    const spec = parsed.spec;
    const stale = layersStale(spec, s.meta);
    const staleItems = stale && s.baseline ? changedCutItems(s.baseline, s.doc) : [];
    this.store.set({ spec, diagnostics: [...fileDiagnostics(s.info?.diagnostics ?? []), ...parsed.diagnostics], stale, staleItems });
    this.compilePreview();
  }

  private compilePreview(): void {
    const s = this.get();
    if (!s.spec || !s.meta || !this.preview.hasLayers(s.meta, s.layersVersion)) {
      if (this.preview.error !== s.previewError) this.store.set({ previewError: this.preview.error });
      return;
    }
    this.preview.compile(s.spec, s.meta);
    this.store.set((st) => ({ previewVersion: st.previewVersion + 1, previewError: this.preview.error }));
  }

  // ------------------------------------------------------------------------------ edits & history

  private historyFlags(): Pick<AvatarState, 'canUndo' | 'canRedo' | 'undoLabel' | 'redoLabel'> {
    return { canUndo: this.history.canUndo, canRedo: this.history.canRedo, undoLabel: this.history.undoLabel, redoLabel: this.history.redoLabel };
  }

  private show(doc: SpecDoc): void {
    const s = this.get();
    this.store.set({ doc, parts: describeAvatarParts(doc), unsaved: !sameJson(doc, s.savedDoc), ...this.historyFlags() });
    this.scheduleValidate();
  }

  /** Apply an edit as one undo step. A null or unchanged document is no edit. */
  edit(label: string, next: SpecDoc | null): boolean {
    const doc = this.get().doc;
    if (!next || !doc || sameJson(next, doc)) return false;
    this.history.push(next, label);
    this.show(next);
    return true;
  }

  /** Start a drag: the moves until endGesture are one step. */
  beginGesture(label: string): void {
    const doc = this.get().doc;
    if (doc) this.gesture = { base: doc, label };
  }

  /** The document base of the running gesture. */
  gestureBase(): SpecDoc | null {
    return this.gesture?.base ?? null;
  }

  /** A move of the running gesture (shown at once, recorded when it ends). */
  gestureUpdate(next: SpecDoc): void {
    if (!this.gesture) return;
    const doc = this.get().doc;
    if (doc && sameJson(next, doc)) return;
    this.store.set({ doc: next, parts: describeAvatarParts(next), unsaved: !sameJson(next, this.get().savedDoc) });
    this.scheduleValidate();
  }

  endGesture(): void {
    const g = this.gesture;
    this.gesture = null;
    const doc = this.get().doc;
    if (!g || !doc || sameJson(doc, g.base)) return;
    this.history.push(doc, g.label);
    this.store.set(this.historyFlags());
    this.validateNow();
  }

  undo(): void {
    if (this.gesture) return;
    const step = this.history.undo();
    if (!step) return;
    this.show(step.doc);
    this.toast('info', t('avatar.toast.undo', { label: step.undone }));
  }

  redo(): void {
    if (this.gesture) return;
    const entry = this.history.redo();
    if (!entry) return;
    this.show(entry.doc);
    this.toast('info', t('avatar.toast.redo', { label: entry.label }));
  }

  // ------------------------------------------------------------------------------ save & build

  /** Write avatar.json. `compile: false` leaves the model alone (a build follows). */
  async save(opts: { compile?: boolean; base?: number; quiet?: boolean } = {}): Promise<boolean> {
    if (this.gesture) this.endGesture();
    const s = this.get();
    if (!s.doc || !s.ref) return false;
    if (!s.unsaved && opts.base === undefined) {
      if (!opts.quiet) this.toast('info', t('avatar.toast.upToDate'));
      return true;
    }
    const doc = s.doc;
    this.store.set({ saving: true });
    try {
      const base = opts.base ?? s.mtimeMs;
      const res = await api.putAvatar({ doc, ...(base > 0 ? { baseMtimeMs: base } : {}), ...(opts.compile === false ? { compile: false } : {}) });
      if (!res.written) {
        this.toast('error', t('avatar.toast.notWritten'), res.hint ? { details: [res.hint] } : {});
        this.store.set({ saving: false });
        return false;
      }
      this.ownWrites.push(res.mtimeMs);
      if (this.ownWrites.length > 32) this.ownWrites.shift();
      const now = this.get();
      this.store.set({ saving: false, savedDoc: doc, mtimeMs: res.mtimeMs, unsaved: !sameJson(now.doc, doc), conflict: null, external: null });
      if (!opts.quiet) {
        const details = res.error ? [res.error.message, ...(res.error.hint ? [res.error.hint] : [])] : [];
        this.toast(res.error ? 'warning' : 'success', res.error ? t('avatar.toast.savedNotCompiled') : t('avatar.toast.saved'), details.length ? { details } : {});
      }
      return true;
    } catch (e) {
      if (e instanceof api.AvatarConflictError) {
        this.store.set({ saving: false, conflict: { mtimeMs: e.mtimeMs } });
        return false;
      }
      this.store.set({ saving: false });
      this.toast('error', t('avatar.toast.saveFailed', { message: messageOf(e) }), { action: { label: t('common.retry'), run: () => void this.save(opts) } });
      return false;
    }
  }

  /** Settle a refused save: 'reload' takes the version on disk, 'overwrite' writes ours over it. */
  async resolveConflict(choice: 'reload' | 'overwrite'): Promise<void> {
    const c = this.get().conflict;
    if (!c) return;
    if (choice === 'overwrite') {
      if (await this.save({ base: c.mtimeMs, quiet: true })) this.toast('success', t('avatar.toast.overwritten'));
      return;
    }
    await this.reloadFromDisk();
  }

  /** avatar.json changed on disk while edits were unsaved: 'reload' takes it, 'keep' keeps ours (the next save overwrites). */
  async resolveExternal(choice: 'reload' | 'keep'): Promise<void> {
    const ext = this.get().external;
    if (!ext) return;
    if (choice === 'keep') {
      this.store.set({ external: null, mtimeMs: ext.mtimeMs });
      return;
    }
    await this.reloadFromDisk();
  }

  /** Take avatar.json as it is on disk (a step of the history: undo brings the edits back). */
  async reloadFromDisk(): Promise<void> {
    let info: AvatarInfo;
    try {
      info = await api.fetchAvatar();
    } catch (e) {
      this.toast('error', t('avatar.toast.reloadFailed', { message: messageOf(e) }));
      return;
    }
    const parsed = info.specText !== null ? parseAvatarSpec(info.specText) : null;
    const diskDoc = parsed && isPlainObject(parsed.doc) ? parsed.doc : null;
    if (!diskDoc) {
      this.toast('error', t('avatar.error.notJson'));
      return;
    }
    this.history.push(diskDoc, t('avatar.history.disk'));
    this.store.set({ info, doc: diskDoc, savedDoc: diskDoc, parts: describeAvatarParts(diskDoc), mtimeMs: info.mtimeMs, unsaved: false, conflict: null, external: null, ...this.historyFlags() });
    this.validateNow();
  }

  /**
   * Save (when needed) and build: `layers` true cuts the layer images again (after outlines changed),
   * false only recompiles the model. The job's progress arrives as SSE "avatar-job".
   */
  async build(layers = true): Promise<boolean> {
    const s = this.get();
    if (!s.ref || s.job?.state === 'running') return false;
    if (s.unsaved || s.external) {
      if (!(await this.save({ compile: false, quiet: true }))) return false;
    }
    try {
      const first = await api.startAvatarBuild({ layers });
      await this.onJob(first);
      return true;
    } catch (e) {
      this.toast('error', t('avatar.toast.buildFailed', { message: messageOf(e) }));
      return false;
    }
  }

  // ------------------------------------------------------------------------------ selection & view

  select(item: string | null, group?: AvatarPartGroupId | null, vertex: number | null = null): void {
    const s = this.get();
    const g = group !== undefined ? group : item ? (s.parts.find((p) => p.items.some((i) => i.id === item))?.id ?? null) : s.selection.group;
    this.store.set({ selection: { group: g ?? null, item, vertex } });
  }

  selectGroup(group: AvatarPartGroupId | null): void {
    this.store.set({ selection: { group, item: null, vertex: null } });
  }

  toggleGroup(group: AvatarPartGroupId): void {
    const hidden = this.get().hidden;
    this.store.set({ hidden: hidden.includes(group) ? hidden.filter((g) => g !== group) : [...hidden, group] });
  }

  setHover(hover: AvatarHover | null): void {
    const h = this.get().hover;
    if (h === hover || (h && hover && h.item === hover.item && h.role === hover.role && h.index === hover.index && h.x === hover.x && h.y === hover.y)) return;
    this.store.set({ hover });
  }

  setPointer(p: [number, number] | null): void {
    this.store.set({ pointer: p });
    this.session?.setPointer(p);
  }

  /** Navigation by the person (pan, zoom): the view no longer follows the last framing. */
  setCamera(camera: Camera): void {
    this.fitPending = false;
    this.following = null;
    this.store.set({ camera });
  }

  /**
   * The canvas size and the part the chrome covers. The framing in effect (the last Fit, until the
   * person pans or zooms) is applied again, so the picture stays centred when panes open or close.
   */
  setViewport(viewport: ViewportSize, insets: ViewInsets): void {
    const i = this.insets;
    const insetsChanged = i.top !== insets.top || i.right !== insets.right || i.bottom !== insets.bottom || i.left !== insets.left;
    this.insets = insets;
    const s = this.get();
    const sizeChanged = s.viewport.width !== viewport.width || s.viewport.height !== viewport.height;
    if (sizeChanged) this.store.set({ viewport });
    if (this.fitPending) this.refit();
    else if ((sizeChanged || insetsChanged) && this.following) this.fit(this.following);
  }

  /** Frame the illustration once it and the viewport are known (a newly opened project). */
  private refit(): void {
    if (this.fitPending && this.get().image && this.get().viewport.width > 0) this.fit('image');
  }

  /** The framing the view keeps while the free area changes (null once the person navigated). */
  private following: 'image' | Rect | null = null;

  /** Frame the whole illustration, a rect, or an item's shape. */
  fit(target: 'image' | Rect): void {
    const s = this.get();
    if (s.viewport.width <= 0 || s.viewport.height <= 0) return;
    this.following = target;
    this.fitPending = false;
    if (target === 'image') {
      if (!s.image) return;
      this.store.set({ camera: frameRect([0, 0, s.image.width, s.image.height], s.viewport, this.insets, 32, 16) });
      return;
    }
    this.store.set({ camera: frameRect(target, s.viewport, this.insets, 48) });
  }

  zoomTo(zoom: number): void {
    const s = this.get();
    this.setCamera(zoomToLevel(s.camera, s.viewport, this.insets, zoom));
  }

  startPlacing(what: string | null): void {
    this.store.set({ placing: what });
  }

  // ------------------------------------------------------------------------------ preview

  setTab(tab: PreviewTab): void {
    this.store.set({ tab });
  }

  setPreviewParams(previewParams: Record<string, number>): void {
    this.store.set({ previewParams });
  }

  setIdle(idle: boolean): void {
    this.store.set({ idle, ...(idle ? {} : { clock: 0 }) });
  }

  setLipSync(patch: Partial<LipSyncState>): void {
    this.store.set((s) => ({ lipsync: { ...s.lipsync, ...patch } }));
  }

  /** Beats of the text being played (textToMorae of lipsync.text). */
  private lip: { morae: Mora[]; beats: number } = { morae: [], beats: 0 };

  /** Play the lip-sync text; returns the characters it could not map (they become short rests). */
  playLipSync(): string[] {
    const { morae, unknown } = textToMorae(this.get().lipsync.text);
    this.lip = { morae, beats: moraeBeats(morae) };
    this.setLipSync({ startedAt: this.lip.beats > 0 ? performance.now() : null });
    return unknown;
  }

  stopLipSync(): void {
    this.setLipSync({ startedAt: null, vowel: null });
  }

  /** Hold a vowel shape (a / i / u / e / o / n) while a button is pressed; null releases it. */
  holdVowel(vowel: Viseme | null): void {
    this.setLipSync({ vowel });
  }

  /** Whether the preview moves by itself (idle animation, lip sync): the stage keeps drawing. */
  animating(): boolean {
    const s = this.get();
    return s.idle || s.lipsync.startedAt !== null || s.lipsync.vowel !== null || s.lipsync.mouth !== null;
  }

  /**
   * Advance the preview by `dt` seconds at time `now` (performance.now()): the idle clock, and the
   * mouth the lip sync drives (eased toward the held vowel or the text's shape at this moment).
   */
  tick(now: number, dt: number): void {
    const s = this.get();
    const patch: Partial<AvatarState> = {};
    if (s.idle) patch.clock = (s.clock + dt) % 600;
    const lip = s.lipsync;
    let target: { open: number; form: number } | null = null;
    let startedAt = lip.startedAt;
    if (lip.vowel) target = VISEME_SHAPES[lip.vowel];
    else if (startedAt !== null) {
      const rate = Math.max(1, lip.rate);
      const length = this.lip.beats / rate;
      let t = (now - startedAt) / 1000;
      if (t >= length) {
        // A loop restarts after a short breath; a one-shot ends closed.
        if (lip.loop) {
          t %= length + 0.4;
        } else {
          startedAt = null;
          t = length;
        }
      }
      target = mouthShapeAt(this.lip.morae, rate, t);
    }
    let mouth = lip.mouth;
    const goal = target ?? { open: 0, form: 0 };
    if (target || mouth) {
      const k = 1 - Math.exp(-dt * (lip.vowel ? 22 : 40));
      const m = mouth ?? { open: 0, form: 0 };
      const next = { open: m.open + (goal.open - m.open) * k, form: m.form + (goal.form - m.form) * k };
      // Back at rest with nothing driving it: the lip sync lets go of the mouth.
      mouth = !target && Math.abs(next.open) < 0.005 && Math.abs(next.form) < 0.005 ? null : next;
    }
    if (mouth !== lip.mouth || startedAt !== lip.startedAt) patch.lipsync = { ...lip, mouth, startedAt };
    if (Object.keys(patch).length) this.store.set(patch);
  }

  /** The explicit parameters of the preview right now: the pose sliders, then the lip-sync mouth. */
  previewInputs(): { params: Record<string, number>; animations: string[]; time: number; physics: boolean } {
    const s = this.get();
    const params = { ...s.previewParams };
    if (s.lipsync.mouth) {
      params.MouthOpen = s.lipsync.mouth.open;
      params.MouthForm = s.lipsync.mouth.form;
    }
    return { params, animations: s.idle ? ['idle'] : [], time: s.idle ? s.clock : 0, physics: s.idle };
  }

  // ------------------------------------------------------------------------------ AI

  setAiJob(ai: AiJobRef | null): void {
    this.store.set({ ai });
  }

  // ------------------------------------------------------------------------------ queries

  /** An item of the current document by id. */
  item(id: string | null): AvatarPartItemInfo | null {
    if (!id) return null;
    for (const g of this.get().parts) for (const i of g.items) if (i.id === id) return i;
    return null;
  }

  /** The landmarks still missing ("avatar-missing-landmark" diagnostics). */
  missing(): Diagnostic[] {
    return this.get().diagnostics.filter((d) => d.code === MISSING_LANDMARK);
  }
}

/** The page's avatar store. */
export const avatarStore = new AvatarStore();

/** Automation hook for tests and AI-driven browsers (read-only use: actions go through the UI or the server). */
export interface Rev2dAvatarHook {
  store: AvatarStore;
  state(): AvatarState;
}

declare global {
  interface Window {
    __rev2dAvatar?: Rev2dAvatarHook;
  }
}

if (typeof window !== 'undefined') window.__rev2dAvatar = { store: avatarStore, state: () => avatarStore.get() };
