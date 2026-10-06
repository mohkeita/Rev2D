/**
 * Avatar mode of the editor server (the "avatar mode" section of src/node/editor-registry.ts has the
 * types): the editor works on an AVATAR PROJECT, a folder with avatar.json (the spec), source.png (the
 * illustration) and what is built from them (src/avatar/DESIGN.md §1).
 *
 *   GET  /api/avatar                   -> AvatarInfo: the spec text, the illustration's size, the build state, diagnostics
 *   PUT  /api/avatar {text | doc, baseMtimeMs?, compile?} -> AvatarSaveResult: writes avatar.json (the previous
 *                                         content stays as avatar.json.bak) and recompiles the model from the
 *                                         existing layers; 409 {error, hint, mtimeMs} on a lost update
 *   POST /api/avatar/build {layers?}   -> 202 AvatarJobEvent; progress and result as SSE "avatar-job"; 409 while one runs
 *   GET  /api/avatar/build             -> {job: AvatarJobEvent | null}
 *   GET  /api/avatar/file?path=<rel>   -> a file of the project folder (images, JSON, text), 403 outside it
 *   POST /api/avatar/new {image: {name, base64}, name?, dir?, unique?} -> AvatarNewResult; the new project is open
 *   GET  /api/avatar/variants          -> AvatarVariantsInfo: every drawn variant with its state (requested, drawn,
 *                                         accepted, rejected with the reason, stale), the edit areas
 *   POST /api/avatar/variants/request {ids?} -> AvatarVariantRequestsResult: masks, prompts, README and preview
 *   POST /api/avatar/variants/import {ids?, remove?} -> 202 AvatarJobEvent (kind "variants"): a job like a build
 *                                         that checks the drawings in variants/, cuts the accepted ones into
 *                                         sprites and recompiles the model; `remove` deletes drawings first
 *   SSE  "avatar-changed" {origin, project, files, mtimeMs} when avatar.json, the illustration, textures/,
 *        variants/, variant-requests/ or review/ change on disk (debounced)
 *
 * Which project is open follows the open model (ApiContext.switchTo): a model whose folder holds an
 * avatar.json attaches that project; POST /api/open with an avatar.json (or the folder) opens the built
 * model, or the project WITHOUT a model while it has none. The AvatarBridge below keeps what belongs to
 * the open project: the watcher, the versions of avatar.json it has seen (lost-update guard), the build
 * job and who is writing right now, so that the server's own writes are reported as origin "editor".
 *
 * A build runs `rev2d avatar build` as a child process (the same code path an agent uses), so cutting
 * layers never blocks this server; recompiling the model from existing layers is fast and runs here.
 * The avatar modules are loaded on first use: the rest of the editor does not depend on them.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, watch, type FSWatcher, type Stats } from 'node:fs';
import { mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Diagnostic } from '../core/types.js';
import { formatModelJson } from '../core/format.js';
import { ID_PATTERN } from '../core/schema.js';
import { parseJsonc, validateModel } from '../core/validate.js';
import type { AvatarReport, AvatarSpec, LayersMeta, VariantId } from '../avatar/types.js';
import type {
  AvatarBuildReport,
  AvatarBuildRequest,
  AvatarChangedEvent,
  AvatarFileInfo,
  AvatarInfo,
  AvatarJobEvent,
  AvatarJobStep,
  AvatarNewResult,
  AvatarOpenResult,
  AvatarRef,
  AvatarSaveRequest,
  AvatarSaveResult,
  AvatarVariantRequestsRequest,
  AvatarVariantRequestsResult,
  AvatarVariantsImport,
  AvatarVariantsImportRequest,
  AvatarVariantsInfo,
  AvatarJobKind,
  FileListing,
} from '../node/editor-registry.js';
import { killTree } from '../node/agent/exec.js';
import { PACKAGE_ROOT } from '../api/templates.js';
import { HttpError, readBody, readJson, sendJson } from './http.js';
import { ModelStore } from './model-store.js';
import { parseAvatarBuildRequest, parseAvatarNewRequest, parseAvatarSaveRequest, parseAvatarVariantRequestsRequest, parseAvatarVariantsImportRequest } from './protocol.js';
import type { ApiContext } from './routes.js';
import type { SseHub } from './sse.js';
import { checkNameSegment, samePath, within, type WorkspaceRoot } from './workspace.js';

/** File names of a project (AVATAR_SPEC_FILE, AVATAR_SOURCE_FILE and AVATAR_LAYERS_FILE of src/node/avatar.ts). */
export const SPEC_FILE = 'avatar.json';
export const SOURCE_FILE = 'source.png';
export const LAYERS_FILE = 'textures/layers.json';
/** Folders of a project whose files (directly inside) are watched and listed, besides avatar.json and the illustration. */
export const WATCHED_FOLDERS = ['textures', 'variants', 'variant-requests', 'review'] as const;

/** Largest picture POST /api/avatar/new accepts: what an agent job may attach (MAX_IMAGE_BYTES of src/node/agent). */
export const DEFAULT_MAX_AVATAR_IMAGE_BYTES = 20 * 1024 * 1024;
/** Largest side of that picture, px (the canvas limit of new models). */
export const MAX_AVATAR_IMAGE_SIDE = 8192;
export const DEFAULT_BUILD_TIMEOUT_MS = 10 * 60 * 1000;
/** Largest avatar.json that is read to tell what a file or folder is. */
const MAX_SPEC_BYTES = 16 * 1024 * 1024;
/** Most files of one watched folder that are tracked. */
const MAX_FOLDER_FILES = 1000;
const MAX_CHANGED_FILES = 200;
const LOG_TAIL_CHARS = 4000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const NOT_AVATAR_HINT =
  'open an avatar project first: POST /api/open {"file": "<project>/avatar.json"} (GET /api/files marks the projects of the workspace), or create one from a picture with POST /api/avatar/new';

/** Settings of avatar mode (EditorServerOptions.avatar). */
export interface AvatarBridgeOptions {
  /**
   * How POST /api/avatar/build cuts the layers: "process" (default) runs `rev2d avatar build` as a
   * child process, so the server keeps answering; "inline" builds inside the server process (it does
   * not answer while the layers are cut; for embedding and tests).
   */
  build?: 'process' | 'inline';
  /** bin/rev2d.js of the Rev2D installation the build process runs (default: this package's). */
  rev2dBin?: string;
  /** A build is stopped and fails after this many ms (default 10 minutes). */
  buildTimeoutMs?: number;
  /** Largest picture of POST /api/avatar/new in bytes (default 20 MiB). */
  maxImageBytes?: number;
  /** Quiet period before a burst of file changes is reported as "avatar-changed" (default 100 ms). */
  debounceMs?: number;
}

type AvatarLib = typeof import('../avatar/index.js');
type AvatarIO = typeof import('../node/avatar.js');
type OpsLib = typeof import('../ops/index.js');
type VariantsIO = typeof import('../node/avatar-variants.js');
interface AvatarModules {
  lib: AvatarLib;
  io: AvatarIO;
  ops: OpsLib;
  variants: VariantsIO;
}

let modules: Promise<AvatarModules> | null = null;

/** The avatar builder, loaded on first use (the rest of the server works without it). */
function avatarModules(): Promise<AvatarModules> {
  modules ??= Promise.all([import('../avatar/index.js'), import('../node/avatar.js'), import('../ops/index.js'), import('../node/avatar-variants.js')]).then(
    ([lib, io, ops, variants]) => ({ lib, io, ops, variants }),
    (e: unknown) => {
      modules = null;
      throw new HttpError(500, `cannot load the avatar builder: ${e instanceof Error ? e.message : String(e)}`, 'the rev2d installation looks broken; reinstall it');
    },
  );
  return modules;
}

// ----------------------------------------------------------------------------- small helpers

const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';
const keyOf = (p: string) => (CASE_INSENSITIVE ? path.resolve(p).toLowerCase() : path.resolve(p));
const sha1 = (bytes: Uint8Array) => createHash('sha1').update(bytes).digest('hex');
const stripBom = (text: string) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
const slashed = (p: string) => p.split(path.sep).join('/');
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const statSig = (st: Stats) => `${st.mtimeMs}:${st.size}`;

async function fileSig(file: string): Promise<string> {
  const st = await stat(file).catch(() => null);
  return st?.isFile() ? statSig(st) : 'missing';
}

function usesCrlf(text: string): boolean {
  const nl = text.indexOf('\n');
  return nl > 0 && text[nl - 1] === '\r';
}

/** "1.2 s" / "340 ms". */
function duration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

/** A failed build or compile: what went wrong, how to fix it and the diagnostics behind it. */
class BuildFailure extends Error {
  constructor(
    message: string,
    readonly hint?: string,
    readonly diagnostics: Diagnostic[] = [],
    readonly log?: string,
  ) {
    super(message);
  }
}

// ----------------------------------------------------------------------------- what is an avatar project

interface SpecHead {
  /** The file holds (or is meant to hold) an avatar spec: anything but a Rev2D model. */
  isSpec: boolean;
  /** Its `name` when that is a usable id. */
  name: string | null;
  /** Its `image.file` (default "source.png"), '/'-separated. */
  image: string;
}

/** What a spec text says about itself, read leniently (a draft or a half-written file still counts). */
function specHead(text: string): SpecHead {
  const parsed = parseJsonc(stripBom(text));
  const doc = parsed.ok && isPlainObject(parsed.value) ? parsed.value : null;
  const name = doc && typeof doc.name === 'string' && ID_PATTERN.test(doc.name) ? doc.name : null;
  const declared = doc && isPlainObject(doc.image) ? doc.image.file : undefined;
  return { isSpec: doc?.format !== 'rev2d', name, image: typeof declared === 'string' && declared !== '' ? declared : SOURCE_FILE };
}

/** specHead of a file; null when it does not exist, is not a file or is too large to be a spec. */
async function readSpecHead(file: string): Promise<SpecHead | null> {
  const st = await stat(file).catch(() => null);
  if (!st?.isFile() || st.size > MAX_SPEC_BYTES) return null;
  const text = await readFile(file, 'utf8').catch(() => null);
  return text === null ? null : specHead(text);
}

/** Whether `dir` is an avatar project: it holds an avatar.json that is not a Rev2D model. */
async function isAvatarProjectDir(dir: string): Promise<boolean> {
  return (await readSpecHead(path.join(dir, SPEC_FILE)))?.isSpec === true;
}

function refOf(root: WorkspaceRoot, dir: string): AvatarRef {
  return { project: dir, projectPath: root.rel(dir), specFile: path.join(dir, SPEC_FILE) };
}

/** The avatar project a model in `dir` belongs to (its folder holds an avatar.json), or null. */
export async function detectAvatarProject(root: WorkspaceRoot, dir: string): Promise<AvatarRef | null> {
  return (await isAvatarProjectDir(dir)) ? refOf(root, dir) : null;
}

/**
 * The folder of the avatar project that an existing path of the workspace names: its avatar.json, or
 * the folder that holds one. Null for everything else (a Rev2D model that happens to be called
 * avatar.json is a model).
 */
export async function avatarProjectAt(abs: string, st: Stats): Promise<string | null> {
  if (st.isDirectory()) return (await isAvatarProjectDir(abs)) ? abs : null;
  const dir = path.dirname(abs);
  return samePath(abs, path.join(dir, SPEC_FILE)) && (await isAvatarProjectDir(dir)) ? dir : null;
}

/** What opening an avatar project opens: its built model when that exists, else the project alone. */
export async function avatarOpenTarget(root: WorkspaceRoot, dir: string): Promise<{ ref: AvatarRef; model: string | null; note: string | null }> {
  const ref = refOf(root, dir);
  const head = await readSpecHead(ref.specFile);
  const model = head?.name ? path.join(dir, `${head.name}.r2d.json`) : null;
  if (model && (await stat(model).catch(() => null))?.isFile()) return { ref, model, note: null };
  const shown = root.rel(ref.specFile);
  return { ref, model: null, note: `${shown} has no built model yet: POST /api/avatar/build builds it (CLI: rev2d avatar build ${ref.projectPath || '.'})` };
}

/** Open an avatar project that has no built model. The caller holds ctx.exclusive. */
export async function openAvatarAlone(ctx: ApiContext, ref: AvatarRef, origin: 'editor' | 'ai', notes: string[]): Promise<{ result: AvatarOpenResult; delivered: number }> {
  const delivered = await ctx.switchTo(null, origin, ref);
  return { result: { file: null, text: null, mtimeMs: 0, notes, avatar: ref }, delivered };
}

/** Mark the avatar projects of a directory listing (FileEntry.avatar): folders with an avatar.json, and the avatar.json itself. */
export async function markAvatarProjects(root: WorkspaceRoot, listing: FileListing): Promise<FileListing> {
  await Promise.all(
    listing.entries.map(async (entry) => {
      const isSpecFile = entry.type === 'other' && entry.name.toLowerCase() === SPEC_FILE;
      if (entry.type !== 'dir' && !isSpecFile) return;
      const dir = path.join(root.dir, ...(isSpecFile ? listing.dir : entry.path).split('/').filter(Boolean));
      const specFile = isSpecFile ? path.join(dir, entry.name) : path.join(dir, SPEC_FILE);
      const head = await readSpecHead(specFile);
      if (!head?.isSpec) return;
      const model = head.name ? path.join(dir, `${head.name}.r2d.json`) : null;
      const built = model !== null && ((await stat(model).catch(() => null))?.isFile() ?? false);
      entry.avatar = { spec: root.rel(specFile), name: head.name, model: built ? root.rel(model!) : null };
    }),
  );
  return listing;
}

// ----------------------------------------------------------------------------- the open project

interface Tracked {
  /** mtime:size. */
  sig: string;
  size: number;
  mtimeMs: number;
  /** Content hash (avatar.json only): a touch is not a change. */
  hash?: string;
}

/** The watched files of a project by their path inside it. */
type Snapshot = Map<string, Tracked>;

function differs(a: Tracked | undefined, b: Tracked | undefined): boolean {
  if (!a || !b) return a !== b;
  return a.hash !== undefined || b.hash !== undefined ? a.hash !== b.hash : a.sig !== b.sig;
}

/** What depends on the illustration and on layers.json but not on the spec text (cached by their file signatures). */
interface Statics {
  project: string;
  key: string;
  image: { file: string; width: number; height: number } | null;
  sourceDiagnostics: Diagnostic[];
  meta: LayersMeta | null;
  layersDiagnostics: Diagnostic[];
}

/** The project as it is on disk right now. */
interface ProjectView {
  specText: string | null;
  mtimeMs: number;
  spec: AvatarSpec | null;
  diagnostics: Diagnostic[];
  image: Statics['image'];
  meta: LayersMeta | null;
  stale: boolean;
  name: string | null;
  /** Where the built model goes: <project>/<name>.r2d.json. */
  modelFile: string | null;
}

interface CompiledModel {
  text: string;
  report: AvatarReport;
  diagnostics: Diagnostic[];
  postOps: number;
  timings: { compileMs: number; validateMs: number };
}

interface Job {
  id: string;
  ref: AvatarRef;
  layers: boolean;
  kind: AvatarJobKind;
  /** kind "variants": the drawings to import (all when absent) and those to delete first. */
  ids?: VariantId[];
  remove?: VariantId[];
  startedAt: number;
  child: ChildProcess | null;
  /** Why the job was stopped from outside (a timeout, the server closing). */
  stopped: string | null;
  done: Promise<void>;
}

const ms = (from: number) => Math.round((performance.now() - from) * 10) / 10;
const countWarnings = (items: ReadonlyArray<{ severity: string }>) => items.filter((i) => i.severity === 'warning').length;

export class AvatarBridge {
  private current: AvatarRef | null = null;
  private snapshot: Snapshot = new Map();
  /** The project `snapshot` was taken of: until its first scan is done, changes cannot be told apart. */
  private snapshotOf: AvatarRef | null = null;
  /** `image.file` of the spec as last read ('/'-separated, relative to the project). */
  private imageFile = SOURCE_FILE;
  /** Content hashes of the versions of avatar.json served, written or detected, by mtime. */
  private readonly versions = new Map<number, string>();
  private statics: Statics | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  /** fs watchers by watched folder ('' = the project folder itself). */
  private readonly watchers = new Map<string, FSWatcher>();
  private pollTimer: NodeJS.Timeout | null = null;
  private timer: NodeJS.Timeout | null = null;
  private burstStart = 0;
  /** Paths (inside the project) the server itself is writing right now: it reports them when it is done. */
  private readonly owners = new Set<(file: string) => boolean>();
  /** Project folders whose model the server itself is rewriting, with how many writers. */
  private readonly held = new Map<string, number>();
  private job: Job | null = null;
  /** The latest job event per project folder (the newest few). */
  private readonly lastEvents = new Map<string, AvatarJobEvent>();
  private polling: boolean;
  private closed = false;
  /** Fingerprints of drawn variants already read (GET /api/avatar/variants), by file. */
  private readonly drawingHashes = new Map<string, { sig: string; hash: string }>();

  private readonly root: WorkspaceRoot;
  private readonly sse: SseHub;
  private readonly log: (message: string) => void;
  private readonly pollIntervalMs: number;
  private readonly debounceMs: number;
  private readonly buildMode: 'process' | 'inline';
  private readonly rev2dBin: string;
  private readonly buildTimeoutMs: number;
  readonly maxImageBytes: number;

  constructor(opts: { root: WorkspaceRoot; sse: SseHub; log: (message: string) => void; poll?: boolean; pollIntervalMs?: number; options?: AvatarBridgeOptions }) {
    this.root = opts.root;
    this.sse = opts.sse;
    this.log = opts.log;
    this.polling = opts.poll === true;
    this.pollIntervalMs = opts.pollIntervalMs ?? 300;
    this.debounceMs = opts.options?.debounceMs ?? 100;
    this.buildMode = opts.options?.build ?? 'process';
    this.rev2dBin = opts.options?.rev2dBin ?? path.join(PACKAGE_ROOT, 'bin', 'rev2d.js');
    this.buildTimeoutMs = opts.options?.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS;
    this.maxImageBytes = opts.options?.maxImageBytes ?? DEFAULT_MAX_AVATAR_IMAGE_BYTES;
  }

  /** The open avatar project, or null. */
  ref(): AvatarRef | null {
    return this.current;
  }

  /** The open avatar project, or 404 {error, hint}. */
  requireProject(): AvatarRef {
    if (!this.current) throw new HttpError(404, 'the open document is not an avatar project', NOT_AVATAR_HINT);
    return this.current;
  }

  /** Whether the server itself is rewriting the model and textures in `dir`: file events there are its own. */
  holdsModel(dir: string): boolean {
    return (this.held.get(keyOf(dir)) ?? 0) > 0;
  }

  /** The latest event of the last build job of the open project. */
  lastJob(): AvatarJobEvent | null {
    return this.current ? (this.lastEvents.get(keyOf(this.current.project)) ?? null) : null;
  }

  private isCurrent(ref: AvatarRef): boolean {
    return this.current !== null && samePath(this.current.project, ref.project);
  }

  /** Make `ref` the open project (null: none): retarget the watcher and forget what belonged to the previous one. */
  async attach(ref: AvatarRef | null): Promise<void> {
    if (this.closed) return;
    if (ref && this.isCurrent(ref)) {
      this.current = ref;
      return;
    }
    this.stopWatching();
    this.current = ref;
    this.snapshot = new Map();
    this.snapshotOf = null;
    this.versions.clear();
    this.statics = null;
    this.imageFile = SOURCE_FILE;
    if (!ref) return;
    await this.serial(async () => {
      const snapshot = await this.scan(ref, new Map());
      if (this.isCurrent(ref)) {
        this.snapshot = snapshot;
        this.snapshotOf = ref;
      }
    });
    this.arm();
  }

  /** Stop watching and end the running build (its process is killed). */
  async close(): Promise<void> {
    this.closed = true;
    this.stopWatching();
    const job = this.job;
    if (job) {
      job.stopped ??= 'the editor server was closed';
      if (job.child?.pid !== undefined) await killTree(job.child.pid).catch(() => undefined);
      await job.done.catch(() => undefined);
    }
    await this.queue.catch(() => undefined);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  // --------------------------------------------------------------------------- watching

  private stopWatching(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
  }

  /** Watch the project folder and the watched folders that exist (again after each scan: folders appear later). */
  private arm(): void {
    const ref = this.current;
    if (!ref || this.closed) return;
    if (this.polling) {
      if (!this.pollTimer) {
        this.pollTimer = setInterval(() => this.report(), this.pollIntervalMs);
        this.pollTimer.unref();
      }
      return;
    }
    for (const folder of ['', ...WATCHED_FOLDERS]) {
      if (this.watchers.has(folder)) continue;
      const dir = path.join(ref.project, folder);
      try {
        const w = watch(dir, { persistent: false }, (_event, filename) => {
          if (folder !== '' || this.concerns(filename)) this.schedule();
        });
        w.on('error', (e) => {
          w.close();
          if (this.watchers.get(folder) === w) this.watchers.delete(folder);
          if (folder === '') this.fallBack(dir, e as NodeJS.ErrnoException);
          this.schedule();
        });
        this.watchers.set(folder, w);
      } catch (e) {
        // A watched folder that does not exist (yet, or any more) is no failure: the project folder's
        // watcher sees it appear, and the scan after that event arms it.
        if (folder !== '') continue;
        this.fallBack(dir, e as NodeJS.ErrnoException);
        return;
      }
    }
  }

  /** fs.watch does not work for the project folder (a network drive, a deleted folder): poll instead. */
  private fallBack(dir: string, e: NodeJS.ErrnoException): void {
    if (this.polling || this.closed) return;
    this.polling = true;
    this.log(`fs.watch unavailable for ${dir} (${e.code ?? e.message}); polling every ${this.pollIntervalMs} ms`);
    this.stopWatching();
    this.arm();
  }

  /** Whether an entry of the project folder is one whose change matters: avatar.json, the illustration, a watched folder. */
  private concerns(filename: string | Buffer | null): boolean {
    if (filename === null) return true;
    const name = filename.toString().toLowerCase();
    return name === SPEC_FILE || name === this.imageFile.split('/')[0].toLowerCase() || (WATCHED_FOLDERS as readonly string[]).includes(name);
  }

  private schedule(): void {
    if (this.closed) return;
    const now = Date.now();
    if (!this.timer) this.burstStart = now;
    else clearTimeout(this.timer);
    // A continuously changing folder is still reported once a second.
    const wait = Math.max(0, Math.min(this.debounceMs, this.burstStart + 1000 - now));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.report();
    }, wait);
  }

  private report(): void {
    this.sync('external')
      .then(() => this.arm())
      .catch((e: Error) => this.log(`avatar change detection failed: ${e.message}`));
  }

  /** The watched files of the project as they are now; hashes of an unchanged avatar.json are taken from `previous`. */
  private async scan(ref: AvatarRef, previous: Snapshot): Promise<Snapshot> {
    const next: Snapshot = new Map();
    const specStat = await stat(ref.specFile).catch(() => null);
    if (specStat?.isFile()) {
      const sig = statSig(specStat);
      const known = previous.get(SPEC_FILE);
      let hash = known?.sig === sig ? known.hash : undefined;
      if (hash === undefined) {
        const bytes = await readFile(ref.specFile).catch(() => null);
        if (bytes) {
          hash = sha1(bytes);
          if (this.isCurrent(ref)) {
            this.remember(specStat.mtimeMs, hash);
            this.imageFile = slashed(specHead(bytes.toString('utf8')).image);
          }
        }
      }
      if (hash !== undefined) next.set(SPEC_FILE, { sig, hash, size: specStat.size, mtimeMs: specStat.mtimeMs });
    }
    const image = this.isCurrent(ref) ? this.imageFile : SOURCE_FILE;
    const imageAbs = path.resolve(ref.project, image);
    if (!path.isAbsolute(image) && within(ref.project, imageAbs) && !samePath(imageAbs, ref.project)) {
      const st = await stat(imageAbs).catch(() => null);
      if (st?.isFile()) next.set(image, { sig: statSig(st), size: st.size, mtimeMs: st.mtimeMs });
    }
    for (const folder of WATCHED_FOLDERS) {
      const dir = path.join(ref.project, folder);
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
      if (!entries) {
        // Gone (or not there yet): its watcher, if any, watches nothing now.
        const stale = this.isCurrent(ref) ? this.watchers.get(folder) : undefined;
        if (stale) {
          stale.close();
          this.watchers.delete(folder);
        }
        continue;
      }
      const names = entries.filter((e) => !e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
      for (const name of names.sort().slice(0, MAX_FOLDER_FILES)) {
        const st = await stat(path.join(dir, name)).catch(() => null);
        if (st?.isFile()) next.set(`${folder}/${name}`, { sig: statSig(st), size: st.size, mtimeMs: st.mtimeMs });
      }
    }
    return next;
  }

  /**
   * Compare the project with what is known and broadcast "avatar-changed" for the difference. An
   * "external" pass (the watcher) leaves out the paths the server is writing itself; an "editor" pass
   * (after such a write) reports exactly those (`mine`).
   */
  private sync(origin: 'editor' | 'external', mine?: (file: string) => boolean): Promise<string[]> {
    return this.serial(async () => {
      const ref = this.current;
      // A pass queued before a switch would compare the new project with an empty snapshot.
      if (!ref || !this.snapshotOf || !this.isCurrent(this.snapshotOf)) return [];
      const next = await this.scan(ref, this.snapshot);
      if (!this.isCurrent(ref)) return [];
      const merged: Snapshot = new Map(this.snapshot);
      const changed: string[] = [];
      for (const file of new Set([...this.snapshot.keys(), ...next.keys()])) {
        const now = next.get(file);
        if (differs(this.snapshot.get(file), now)) {
          const own = [...this.owners].some((owns) => owns(file));
          if (origin === 'external' ? own : mine !== undefined && !mine(file)) continue;
          changed.push(file);
        }
        if (now) merged.set(file, now);
        else merged.delete(file);
      }
      this.snapshot = merged;
      if (changed.length) {
        const event: AvatarChangedEvent = { origin, project: ref.project, files: changed.sort().slice(0, MAX_CHANGED_FILES), mtimeMs: merged.get(SPEC_FILE)?.mtimeMs ?? 0 };
        this.sse.broadcast('avatar-changed', event);
      }
      return changed;
    });
  }

  /** Run a write of the server itself: the paths `mine` are reported as origin "editor" once it is done. */
  private async owning<T>(mine: (file: string) => boolean, fn: () => Promise<T>): Promise<T> {
    this.owners.add(mine);
    try {
      return await fn();
    } finally {
      await this.sync('editor', mine).catch((e: Error) => this.log(`avatar change detection failed: ${e.message}`));
      this.owners.delete(mine);
    }
  }

  // --------------------------------------------------------------------------- avatar.json

  private remember(mtimeMs: number, hash: string): void {
    this.versions.delete(mtimeMs);
    this.versions.set(mtimeMs, hash);
    if (this.versions.size > 64) this.versions.delete(this.versions.keys().next().value!);
  }

  /** Text and mtime of avatar.json; null when it is missing. */
  private async readSpec(ref: AvatarRef): Promise<{ text: string; mtimeMs: number } | null> {
    try {
      const [bytes, st] = await Promise.all([readFile(ref.specFile), stat(ref.specFile)]);
      if (this.isCurrent(ref)) this.remember(st.mtimeMs, sha1(bytes));
      return { text: bytes.toString('utf8'), mtimeMs: st.mtimeMs };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      throw new HttpError(500, `cannot read ${ref.specFile}: ${(e as Error).message}`);
    }
  }

  /**
   * Write avatar.json; its previous content is kept as avatar.json.bak. With `base` (the mtime of the
   * version the text was derived from) the write is refused with 409 {mtimeMs} when the file changed
   * on disk since: its mtime differs AND its content is neither that version's nor the text being
   * written (the rule of PUT /api/model). Returns the file's mtime.
   */
  private async writeSpec(ref: AvatarRef, text: string, base: number | undefined): Promise<number> {
    const bytes = Buffer.from(text, 'utf8');
    let current: Buffer | null = null;
    let mtimeMs = 0;
    try {
      const [onDisk, st] = await Promise.all([readFile(ref.specFile), stat(ref.specFile)]);
      current = onDisk;
      mtimeMs = st.mtimeMs;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new HttpError(500, `cannot read ${ref.specFile}: ${(e as Error).message}`);
    }
    if (current && base !== undefined && mtimeMs !== base) {
      const hash = sha1(current);
      this.remember(mtimeMs, hash);
      if (hash !== this.versions.get(base) && !current.equals(bytes)) {
        throw new HttpError(
          409,
          `avatar.json changed on disk since the version this write is based on (mtime ${base}, now ${mtimeMs}); nothing was written`,
          'GET /api/avatar and apply the change to the new version; to overwrite the other change on purpose, PUT again with baseMtimeMs set to this mtimeMs',
          { mtimeMs },
        );
      }
    }
    if (current?.equals(bytes)) return mtimeMs;
    try {
      if (current) await writeFile(`${ref.specFile}.bak`, current);
      await writeFile(ref.specFile, bytes);
    } catch (e) {
      throw new HttpError(500, `cannot write ${ref.specFile}: ${(e as Error).message}`, 'check that the project folder is writable and the file is not locked by another program');
    }
    mtimeMs = (await stat(ref.specFile)).mtimeMs;
    this.remember(mtimeMs, sha1(bytes));
    return mtimeMs;
  }

  /** The illustration's size, its problems and the layer metadata: reloaded only when those files change. */
  private async loadStatics(ref: AvatarRef, image: string): Promise<Statics> {
    const { io } = await avatarModules();
    let source: string | null;
    try {
      source = io.projectFile(ref.project, image);
    } catch {
      source = null;
    }
    const key = [image, source ? await fileSig(source) : 'outside', await fileSig(path.join(ref.project, ...LAYERS_FILE.split('/')))].join('\n');
    if (this.statics?.key === key && samePath(this.statics.project, ref.project)) return this.statics;
    // loadAvatarProject is the one place that knows what is wrong with a project's files.
    const loaded = await io.loadAvatarProject(ref.project);
    const statics: Statics = {
      project: ref.project,
      key,
      image: loaded.source ? { file: slashed(image), width: loaded.source.width, height: loaded.source.height } : null,
      sourceDiagnostics: loaded.diagnostics.filter((d) => d.code.startsWith('avatar-source')),
      meta: loaded.meta,
      layersDiagnostics: loaded.diagnostics.filter((d) => d.code.startsWith('avatar-layers')),
    };
    if (this.isCurrent(ref)) this.statics = statics;
    return statics;
  }

  /** The project on disk: the spec validated against the real image size, the layer metadata, whether the layers are stale. */
  private async view(ref: AvatarRef): Promise<ProjectView> {
    const { lib, io } = await avatarModules();
    const file = await this.serial(() => this.readSpec(ref));
    if (!file) {
      const loaded = await io.loadAvatarProject(ref.project);
      return { specText: null, mtimeMs: 0, spec: null, diagnostics: loaded.diagnostics, image: null, meta: null, stale: false, name: null, modelFile: null };
    }
    const head = specHead(file.text);
    if (this.isCurrent(ref)) this.imageFile = slashed(head.image);
    const statics = await this.loadStatics(ref, head.image);
    const parsed = lib.parseAvatarSpec(file.text, statics.image ? { imageSize: { width: statics.image.width, height: statics.image.height }, imageName: head.image } : {});
    return {
      specText: file.text,
      mtimeMs: file.mtimeMs,
      // Without a usable illustration the spec cannot be built, whatever it says.
      spec: statics.sourceDiagnostics.length ? null : parsed.spec,
      diagnostics: [...statics.sourceDiagnostics, ...parsed.diagnostics, ...statics.layersDiagnostics],
      image: statics.image,
      meta: statics.meta,
      stale: statics.meta !== null && parsed.spec !== null && statics.meta.inputsHash !== lib.layerInputsHash(parsed.spec),
      name: head.name,
      modelFile: head.name ? io.avatarModelFile(ref.project, head.name) : null,
    };
  }

  /** GET /api/avatar. */
  async info(): Promise<AvatarInfo> {
    const ref = this.requireProject();
    const view = await this.view(ref);
    const modelStat = view.modelFile ? await stat(view.modelFile).catch(() => null) : null;
    const built = modelStat?.isFile() === true;
    const snapshot = await this.serial(() => this.scan(ref, this.snapshot));
    // layers.json is read from disk: only its version, hash and layer list are checked.
    const accepted: unknown[] = view.meta && Array.isArray(view.meta.variants) ? view.meta.variants : [];
    const files: AvatarFileInfo[] = [...snapshot].map(([file, t]) => ({ path: file, size: t.size, mtimeMs: t.mtimeMs })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return {
      ...ref,
      name: view.name,
      specText: view.specText,
      mtimeMs: view.mtimeMs,
      image: view.image,
      built: {
        model: built ? view.modelFile : null,
        modelMtimeMs: built ? modelStat!.mtimeMs : null,
        meta: view.meta,
        stale: view.stale,
        variants: accepted.filter((v): v is string => typeof v === 'string'),
      },
      files,
      diagnostics: view.diagnostics,
      job: this.lastJob(),
    };
  }

  // --------------------------------------------------------------------------- compiling

  /**
   * Stage 2 alone: spec + existing layer metadata -> the model text, with the spec's post ops applied
   * and the result validated, as the build does after cutting layers (buildAvatarProject).
   */
  private async compile(spec: AvatarSpec, meta: LayersMeta): Promise<CompiledModel> {
    const { lib, ops } = await avatarModules();
    let t = performance.now();
    let doc: unknown;
    let report: AvatarReport;
    try {
      const compiled = lib.compileAvatar(spec, meta);
      doc = compiled.doc;
      report = compiled.report;
    } catch (e) {
      throw new BuildFailure(`cannot compile the model: ${(e as Error).message}`, 'build the layers again (POST /api/avatar/build): their metadata may not fit this spec any more');
    }
    const post = (spec.post ?? []) as Array<{ op: string; [key: string]: unknown }>;
    if (post.length) {
      const applied = ops.applyOps(doc, post, { validate: false, textures: Object.fromEntries(meta.layers.map((l) => [l.id, { width: l.rect[2], height: l.rect[3] }])) });
      if (!applied.ok) {
        const failed = applied.results.find((r) => !r.ok);
        throw new BuildFailure(
          `the "post" op #${failed?.index ?? 0} (${failed?.op ?? '?'}) of avatar.json failed: ${failed?.message ?? 'unknown error'}`,
          failed?.hint ?? 'post ops are edit ops (docs/OPS.md) applied to the generated model; fix or remove the op',
        );
      }
      doc = applied.doc;
    }
    const compileMs = ms(t);
    t = performance.now();
    const validation = validateModel(doc);
    const errors = validation.diagnostics.filter((d) => d.severity === 'error');
    if (!validation.model || errors.length) {
      throw new BuildFailure(
        `the generated model has ${plural(errors.length, 'error')}${post.length ? ' (after the "post" ops of avatar.json)' : ''}`,
        post.length ? 'check the "post" ops: they must leave a valid model' : 'build the layers again (POST /api/avatar/build); if the error stays, it is a bug in the avatar builder',
        errors,
      );
    }
    return { text: formatModelJson(doc), report, diagnostics: validation.diagnostics.filter((d) => d.severity !== 'error'), postOps: post.length, timings: { compileMs, validateMs: ms(t) } };
  }

  /** Write the built model unless the file already holds exactly this text. */
  private async writeModel(file: string, text: string): Promise<{ file: string; mtimeMs: number; changed: boolean }> {
    const bytes = Buffer.from(text, 'utf8');
    const current = await readFile(file).catch(() => null);
    const changed = !current?.equals(bytes);
    if (changed) {
      try {
        await writeFile(file, bytes);
      } catch (e) {
        throw new BuildFailure(`cannot write ${file}: ${(e as Error).message}`, 'check that the project folder is writable and the file is not locked by another program');
      }
    }
    return { file, mtimeMs: (await stat(file)).mtimeMs, changed };
  }

  private hold(dir: string): void {
    this.held.set(keyOf(dir), (this.held.get(keyOf(dir)) ?? 0) + 1);
  }

  private release(dir: string): void {
    const n = (this.held.get(keyOf(dir)) ?? 1) - 1;
    if (n > 0) this.held.set(keyOf(dir), n);
    else this.held.delete(keyOf(dir));
  }

  /**
   * After the server (re)wrote the built model of `ref`: make the editor show it. A project without
   * an open model (or with its model under an earlier name, `previous`) gets the built model opened;
   * an open model in the project folder is reported as changed by the editor. The caller holds
   * ctx.exclusive and the model hold of the folder.
   */
  private async adopt(ctx: ApiContext, ref: AvatarRef, modelFile: string, previous: string | null): Promise<void> {
    if (!this.isCurrent(ref)) return; // the project was closed meanwhile
    const store = ctx.store;
    const open = store !== null && samePath(store.file, modelFile);
    if (!open && (store === null || (previous !== null && samePath(store.file, previous)))) {
      let next: ModelStore;
      try {
        next = await ModelStore.open(modelFile);
      } catch (e) {
        throw new BuildFailure((e as Error).message);
      }
      await ctx.switchTo(next, 'editor', this.current ?? ref);
      return;
    }
    if (store && samePath(store.dir, ref.project)) await ctx.syncModel('editor');
  }

  /** PUT /api/avatar. The caller holds ctx.exclusive. */
  async save(ctx: ApiContext, req: AvatarSaveRequest): Promise<AvatarSaveResult> {
    const ref = this.requireProject();
    const before = await this.serial(() => this.readSpec(ref));
    let text = req.text ?? formatModelJson(req.doc);
    // Formatted writes keep the file's line endings (a CRLF checkout must not turn into a whole-file diff).
    if (req.text === undefined && before && usesCrlf(before.text)) text = text.replace(/\n/g, '\r\n');
    const parsed = parseJsonc(stripBom(text));
    if (!parsed.ok || !isPlainObject(parsed.value)) {
      const view = await this.view(ref);
      return {
        ok: false,
        written: false,
        diagnostics: parsed.ok ? [{ severity: 'error', code: 'schema-invalid-type', path: '', message: 'an avatar spec must be a JSON object' }] : [parsed.error],
        stale: view.stale,
        mtimeMs: view.mtimeMs,
        compiled: false,
        model: null,
        notes: [],
        hint: 'avatar.json must hold a JSON object and was NOT written; fix the text (see diagnostics) or send the spec as "doc"',
      };
    }
    const previousModel = before ? this.modelOf(ref, specHead(before.text).name) : null;
    const isSpec = (file: string) => file === SPEC_FILE;
    this.hold(ref.project);
    try {
      return await this.owning(isSpec, async () => {
        await this.serial(() => this.writeSpec(ref, text, req.baseMtimeMs));
        const view = await this.view(ref);
        const result: AvatarSaveResult = { ok: view.spec !== null, written: true, diagnostics: view.diagnostics, stale: view.stale, mtimeMs: view.mtimeMs, compiled: false, model: null, notes: [] };
        if (req.compile === false) result.notes.push('not compiled: "compile" was false');
        else if (!view.spec) result.notes.push('not compiled: the spec has errors (see diagnostics)');
        else if (this.job && samePath(this.job.ref.project, ref.project)) result.notes.push('not compiled: a build is running; it compiles the model from this spec when it ends');
        else if (!view.meta || !view.modelFile) result.notes.push('not compiled: the layers are not built yet (POST /api/avatar/build)');
        else {
          try {
            const compiled = await this.compile(view.spec, view.meta);
            result.model = await this.writeModel(view.modelFile, compiled.text);
            result.compiled = true;
            await this.adopt(ctx, ref, view.modelFile, previousModel);
            if (previousModel && !samePath(previousModel, view.modelFile) && existsSync(previousModel)) {
              result.notes.push(`the avatar was renamed: its model is ${path.basename(view.modelFile)} now; ${path.basename(previousModel)} is not rebuilt any more and can be deleted`);
            }
            const warnings = countWarnings(compiled.report.issues) + countWarnings(compiled.diagnostics);
            if (warnings) result.notes.push(`the compiled model has ${plural(warnings, 'warning')}; POST /api/avatar/build reports them`);
            if (view.stale) result.notes.push('the layer images are older than this spec (a landmark that cuts pixels changed): POST /api/avatar/build rebuilds them');
          } catch (e) {
            if (!(e instanceof BuildFailure)) throw e;
            result.error = { message: e.message, ...(e.hint ? { hint: e.hint } : {}), ...(e.diagnostics.length ? { diagnostics: e.diagnostics } : {}) };
            result.notes.push(`not compiled: ${e.message}`);
          }
        }
        return result;
      });
    } finally {
      this.release(ref.project);
      // The model watcher ignored the folder meanwhile: another program's change of the model there is reported now.
      if (ctx.store && samePath(ctx.store.dir, ref.project)) await ctx.syncModel('external').catch((e: Error) => this.log(`change detection failed: ${e.message}`));
    }
  }

  private modelOf(ref: AvatarRef, name: string | null): string | null {
    return name ? path.join(ref.project, `${name}.r2d.json`) : null;
  }

  // --------------------------------------------------------------------------- build jobs

  private emit(job: Job, patch: Pick<AvatarJobEvent, 'state'> & Partial<AvatarJobEvent>): AvatarJobEvent {
    const now = Date.now();
    const event: AvatarJobEvent = {
      job: job.id,
      project: job.ref.project,
      layers: job.layers,
      // (Builds and compiles leave `kind` out: `layers` says which; their events stay as they were.)
      ...(job.kind === 'variants' ? { kind: job.kind } : {}),
      startedAt: new Date(job.startedAt).toISOString(),
      elapsedMs: now - job.startedAt,
      ...patch,
      ...(patch.state !== 'running' ? { endedAt: new Date(now).toISOString() } : {}),
    };
    const key = keyOf(job.ref.project);
    this.lastEvents.delete(key);
    this.lastEvents.set(key, event);
    if (this.lastEvents.size > 8) this.lastEvents.delete(this.lastEvents.keys().next().value!);
    this.sse.broadcast('avatar-job', event);
    return event;
  }

  private step(job: Job, step: AvatarJobStep, message: string): AvatarJobEvent {
    return this.emit(job, { state: 'running', step, message });
  }

  /** POST /api/avatar/build: start the job and answer with its first event; the rest arrives as SSE "avatar-job". */
  startBuild(ctx: ApiContext, req: AvatarBuildRequest): AvatarJobEvent {
    const ref = this.requireProject();
    if (this.closed) throw new HttpError(503, 'the editor server is closing');
    if (this.job) {
      throw new HttpError(
        409,
        `an avatar build is already running (job ${this.job.id})`,
        'wait for its SSE "avatar-job" event with state "done" or "failed" (GET /api/avatar/build has the latest event), then build again',
        { job: this.job.id },
      );
    }
    const layers = req.layers !== false;
    const job: Job = { id: randomBytes(6).toString('hex'), ref, layers, kind: layers ? 'build' : 'compile', startedAt: Date.now(), child: null, stopped: null, done: Promise.resolve() };
    this.job = job;
    const first = this.step(job, 'start', job.layers ? 'build accepted' : 'recompile accepted');
    job.done = this.runJob(ctx, job).catch((e: Error) => this.log(`avatar build job ${job.id} failed unexpectedly: ${e.stack ?? e.message}`));
    return first;
  }

  /**
   * POST /api/avatar/variants/import: a job like a build (the same SSE "avatar-job" events, kind
   * "variants") that deletes the `remove` drawings, imports the drawings in variants/ (checks, sprite
   * layers, layers.json) and recompiles the model; its result is AvatarJobEvent.variants.
   */
  startVariantsImport(ctx: ApiContext, req: AvatarVariantsImportRequest): AvatarJobEvent {
    const ref = this.requireProject();
    if (this.closed) throw new HttpError(503, 'the editor server is closing');
    if (this.job) {
      throw new HttpError(409, `an avatar job is already running (job ${this.job.id})`, 'wait for its SSE "avatar-job" event with state "done" or "failed", then import again', { job: this.job.id });
    }
    const job: Job = {
      id: randomBytes(6).toString('hex'),
      ref,
      layers: false,
      kind: 'variants',
      ...(req.ids?.length ? { ids: [...new Set(req.ids)] } : {}),
      ...(req.remove?.length ? { remove: [...new Set(req.remove)] } : {}),
      startedAt: Date.now(),
      child: null,
      stopped: null,
      done: Promise.resolve(),
    };
    this.job = job;
    const first = this.step(job, 'start', 'import accepted');
    job.done = this.runJob(ctx, job).catch((e: Error) => this.log(`avatar variants job ${job.id} failed unexpectedly: ${e.stack ?? e.message}`));
    return first;
  }

  private async runJob(ctx: ApiContext, job: Job): Promise<void> {
    const { ref } = job;
    const isLayer = job.kind === 'variants' ? (file: string) => file.startsWith('textures/') || file.startsWith('variants/') : (file: string) => file.startsWith('textures/');
    let done: { report: AvatarBuildReport; stale: boolean } | null = null;
    let imported: AvatarVariantsImport | null = null;
    let failure: BuildFailure | null = null;
    this.hold(ref.project);
    this.owners.add(isLayer);
    try {
      // Let the 202 answer leave before the first step is reported.
      await yieldToLoop();
      const before = await this.view(ref);
      let report: AvatarBuildReport;
      if (job.kind === 'variants') {
        this.step(job, 'variants', 'checking the drawings and cutting the accepted ones into sprites');
        const r = await this.importVariants(job, before);
        report = r.report;
        imported = r.variants;
      } else if (job.layers) {
        this.step(job, 'build', 'cutting the layer images and compiling the model');
        report = await this.build(job);
      } else {
        this.step(job, 'compile', 'compiling the model from the existing layers');
        await yieldToLoop();
        report = await this.recompile(ref, before);
      }
      this.step(job, 'reload', 'loading the built model');
      done = await ctx.exclusive(async () => {
        this.statics = null;
        const after = await this.view(ref);
        // avatar.json changed while the job ran: the model on disk must be the one of the spec on disk.
        if (after.specText !== before.specText && after.spec && after.meta && after.modelFile) {
          try {
            const compiled = await this.compile(after.spec, after.meta);
            const written = await this.writeModel(after.modelFile, compiled.text);
            report = { ...report, modelFile: written.file, modelBytes: Buffer.byteLength(compiled.text, 'utf8') };
          } catch (e) {
            if (!(e instanceof BuildFailure)) throw e;
            report.issues.push({ severity: 'warning', code: 'avatar-recompile-failed', message: `avatar.json changed while the build ran, and the model could not be compiled from the new spec: ${e.message}`, ...(e.hint ? { hint: e.hint } : {}) });
            report.warnings++;
          }
        }
        await this.sync('editor', isLayer);
        await this.adopt(ctx, ref, report.modelFile, before.modelFile);
        return { report, stale: after.stale };
      });
    } catch (e) {
      failure = e instanceof BuildFailure ? e : new BuildFailure(e instanceof HttpError ? e.message : `the build failed unexpectedly: ${(e as Error).message}`, e instanceof HttpError ? e.hint : undefined);
    } finally {
      await this.sync('editor', isLayer).catch(() => undefined);
      this.owners.delete(isLayer);
      // File events of the model were held back while the job wrote: report what changed, as the editor's own.
      if (!done && ctx.store && samePath(ctx.store.dir, ref.project)) await ctx.syncModel('editor').catch(() => undefined);
      this.release(ref.project);
    }
    if (this.job === job) this.job = null;
    if (done && imported) {
      const v = imported;
      const parts = [`${v.accepted.length} accepted`, `${v.rejected.length} rejected`, ...(v.removed.length ? [`${v.removed.length} removed`] : [])];
      this.emit(job, { state: 'done', message: `imported the drawn variants of "${done.report.name}": ${parts.join(', ')} in ${duration(Date.now() - job.startedAt)}`, report: done.report, stale: done.stale, variants: v });
    } else if (done) {
      const { report } = done;
      const what = report.layers ? `${plural(report.layerFiles.length, 'layer image')}, ` : 'model recompiled, ';
      this.emit(job, { state: 'done', message: `built "${report.name}": ${what}${plural(report.warnings, 'warning')} in ${duration(Date.now() - job.startedAt)}`, report, stale: done.stale });
    } else {
      const f = failure!;
      this.emit(job, { state: 'failed', message: job.stopped ?? f.message, ...(f.hint && !job.stopped ? { hint: f.hint } : {}), ...(f.diagnostics.length ? { diagnostics: f.diagnostics } : {}), ...(f.log ? { log: f.log } : {}) });
    }
  }

  /** Compile-only job: the model from the existing layers. */
  private async recompile(ref: AvatarRef, view: ProjectView): Promise<AvatarBuildReport> {
    const t0 = performance.now();
    if (!view.spec || !view.modelFile) {
      const errors = view.diagnostics.filter((d) => d.severity === 'error');
      throw new BuildFailure(`cannot compile ${ref.project}: the avatar spec has ${plural(errors.length, 'error')}`, 'fix what the diagnostics say (GET /api/avatar lists them), then build again', errors);
    }
    if (!view.meta) throw new BuildFailure(`${ref.project} has no layers yet`, 'build with "layers": true (the default) first: it cuts the layer images the model is made of');
    const compiled = await this.compile(view.spec, view.meta);
    const t = performance.now();
    await this.writeModel(view.modelFile, compiled.text);
    return {
      layers: false,
      name: view.spec.name,
      modelFile: view.modelFile,
      modelBytes: Buffer.byteLength(compiled.text, 'utf8'),
      layerFiles: [],
      removed: [],
      postOps: compiled.postOps,
      warnings: countWarnings(compiled.report.issues) + countWarnings(compiled.diagnostics),
      issues: compiled.report.issues,
      stats: compiled.report.stats,
      diagnostics: compiled.diagnostics,
      timings: { ...compiled.timings, writeMs: ms(t), totalMs: ms(t0) },
    };
  }

  /** The whole build (layers, layers.json, model), in a child process unless the server was told to build inline. */
  private async build(job: Job): Promise<AvatarBuildReport> {
    if (this.buildMode === 'process' && existsSync(this.rev2dBin)) return this.buildInChild(job);
    const { io } = await avatarModules();
    await yieldToLoop();
    try {
      const r = await io.buildAvatarProject(job.ref.project);
      return {
        layers: true,
        name: r.name,
        modelFile: r.modelFile,
        modelBytes: r.modelBytes,
        layerFiles: r.layers,
        removed: r.removed,
        postOps: r.postOps,
        warnings: countWarnings(r.report.issues) + countWarnings(r.diagnostics),
        issues: r.report.issues,
        stats: r.report.stats,
        diagnostics: r.diagnostics,
        timings: { ...r.timings },
      };
    } catch (e) {
      if (e instanceof io.AvatarProjectError) throw new BuildFailure(e.message, e.hint, e.diagnostics);
      throw e;
    }
  }

  // --------------------------------------------------------------------------- drawn variants

  /**
   * The import of a variants job: delete the `remove` drawings, then `rev2d avatar variants import`
   * (as a child process unless the server builds inline). Nothing to import after a removal is fine.
   */
  private async importVariants(job: Job, before: ProjectView): Promise<{ report: AvatarBuildReport; variants: AvatarVariantsImport }> {
    const { ref } = job;
    const t0 = performance.now();
    if (!before.meta) throw new BuildFailure(`${ref.project} is not built yet`, 'build the avatar first (POST /api/avatar/build): the drawn variants are added to its layers');
    for (const id of job.remove ?? []) {
      const file = path.join(ref.project, 'variants', `${id}.png`);
      try {
        await rm(file, { force: true });
      } catch (e) {
        throw new BuildFailure(`cannot delete variants/${id}.png: ${(e as Error).message}`, 'close the program that has the file open, then try again');
      }
    }
    const ids = job.ids ? [...new Set([...job.ids, ...(job.remove ?? [])])] : undefined;
    let answer: Record<string, unknown>;
    try {
      if (this.buildMode === 'process' && existsSync(this.rev2dBin)) {
        answer = await this.childJson(job, ['avatar', 'variants', 'import', ref.project, ...(ids ?? []), '--json'], 'the import');
      } else {
        const { variants, io } = await avatarModules();
        await yieldToLoop();
        try {
          answer = { ...(await variants.importAvatarVariants(ref.project, ids ? { ids } : {})) } as unknown as Record<string, unknown>;
        } catch (e) {
          if (e instanceof io.AvatarProjectError) throw new BuildFailure(e.message, e.hint, e.diagnostics);
          throw e;
        }
      }
    } catch (e) {
      // Removing the last drawing of a variant that had no sprite leaves nothing to import: done.
      if (job.remove?.length && e instanceof BuildFailure && e.message.startsWith('no drawings to import')) {
        const empty: AvatarVariantsImport = { accepted: [], rejected: [], kept: [], removed: [...job.remove], variants: (before.meta.variants ?? []) as VariantId[], ignored: [], notes: [] };
        return {
          report: { layers: false, name: before.name ?? '', modelFile: before.modelFile ?? '', modelBytes: 0, layerFiles: [], removed: [], postOps: 0, warnings: 0, issues: [], stats: {}, diagnostics: [], timings: { totalMs: ms(t0) } },
          variants: empty,
        };
      }
      throw e;
    }
    return variantsReportOf(answer, ref.project, before.name ?? '', job.remove ?? [], ms(t0));
  }

  /** GET /api/avatar/variants. */
  async variantsInfo(): Promise<AvatarVariantsInfo> {
    const ref = this.requireProject();
    const { variants, lib } = await avatarModules();
    const status = await variants.avatarVariantStatus(ref.project, { cache: this.drawingHashes });
    const view = await this.view(ref);
    const box = (group: 'eyes' | 'mouth'): [number, number, number, number] | null => {
      if (!view.spec) return null;
      const rects = lib.variantEditAreas(view.spec, group).areas.map((a) => a.rect);
      if (!rects.length) return null;
      const x0 = Math.min(...rects.map((r) => r.x));
      const y0 = Math.min(...rects.map((r) => r.y));
      const x1 = Math.max(...rects.map((r) => r.x + r.width));
      const y1 = Math.max(...rects.map((r) => r.y + r.height));
      return [x0, y0, x1 - x0, y1 - y0];
    };
    const has = (rel: string) => existsSync(path.join(ref.project, ...rel.split('/')));
    return {
      project: ref.project,
      built: status.built,
      variants: status.variants,
      counts: status.counts,
      ignored: status.ignored,
      areas: { eyes: box('eyes'), mouth: box('mouth') },
      requests: { readme: has(lib.VARIANT_README) ? lib.VARIANT_README : null, preview: has(lib.VARIANT_PREVIEW) ? lib.VARIANT_PREVIEW : null },
      notes: status.notes,
    };
  }

  /** POST /api/avatar/variants/request: masks, prompts, README and preview (fast: no pixels but the masks). */
  async writeVariantRequests(req: AvatarVariantRequestsRequest): Promise<AvatarVariantRequestsResult> {
    const ref = this.requireProject();
    const { variants, io } = await avatarModules();
    const isRequest = (file: string) => file.startsWith('variant-requests/');
    this.owners.add(isRequest);
    try {
      const r = await variants.writeAvatarVariantRequests(ref.project, { ...(req.ids?.length ? { ids: req.ids } : {}), project: ref.projectPath || '.' });
      return { requests: r.requests.map((q) => ({ id: q.id, maskFile: q.maskFile, promptFile: q.promptFile, file: q.file, prompt: q.prompt })), readme: slashed(path.relative(ref.project, r.readme)), preview: slashed(path.relative(ref.project, r.preview)), files: r.files, notes: r.notes };
    } catch (e) {
      if (e instanceof io.AvatarProjectError) throw new HttpError(e.kind === 'not-found' ? 404 : 400, e.message, e.hint);
      throw e;
    } finally {
      await this.sync('editor', isRequest).catch(() => undefined);
      this.owners.delete(isRequest);
    }
  }

  /**
   * Run `node bin/rev2d.js <args>` for a job and return its JSON answer (exit 0, or exit 1 with a
   * JSON answer that is not an error). Failures, timeouts and stops become BuildFailures.
   */
  private childJson(job: Job, args: string[], what: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(process.execPath, [this.rev2dBin, ...args], { cwd: job.ref.project, env: process.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        reject(new BuildFailure(`cannot start ${what}: ${(e as Error).message}`));
        return;
      }
      job.child = child;
      const out: Buffer[] = [];
      let outBytes = 0;
      let err = '';
      child.stdout!.on('data', (chunk: Buffer) => {
        outBytes += chunk.length;
        if (outBytes <= 32 * 1024 * 1024) out.push(chunk);
      });
      child.stderr!.on('data', (chunk: Buffer) => {
        err = (err + chunk.toString('utf8')).slice(-LOG_TAIL_CHARS);
      });
      const timer = setTimeout(() => {
        job.stopped ??= `${what} did not finish within ${duration(this.buildTimeoutMs)} and was stopped`;
        if (child.pid !== undefined) void killTree(child.pid);
      }, this.buildTimeoutMs);
      timer.unref();
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        job.child = null;
        fn();
      };
      child.once('error', (e) => finish(() => reject(new BuildFailure(`cannot start ${what}: ${e.message}`))));
      child.once('close', (code, signal) =>
        finish(() => {
          const log = err.trim() || undefined;
          if (job.stopped) return reject(new BuildFailure(job.stopped, undefined, [], log));
          let answer: Record<string, unknown> | null = null;
          try {
            const parsed: unknown = JSON.parse(Buffer.concat(out).toString('utf8'));
            answer = isPlainObject(parsed) ? parsed : null;
          } catch {
            answer = null;
          }
          const error = answer && isPlainObject(answer.error) ? answer.error : null;
          if (error && typeof error.message === 'string') {
            return reject(new BuildFailure(error.message, typeof error.hint === 'string' ? error.hint : undefined, Array.isArray(error.diagnostics) ? (error.diagnostics as Diagnostic[]) : [], log));
          }
          if (answer && (code === 0 || code === 1)) return resolve(answer);
          reject(new BuildFailure(`${what} ended with ${signal ? `signal ${signal}` : `exit code ${code}`}`, `run "rev2d ${args.filter((a) => a !== '--json').join(' ')}" in a terminal to see what it prints`, [], log));
        }),
      );
    });
  }

  /** `node bin/rev2d.js avatar build <project> --json`: its JSON answer is the report, or the failure. */
  private buildInChild(job: Job): Promise<AvatarBuildReport> {
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(process.execPath, [this.rev2dBin, 'avatar', 'build', job.ref.project, '--json'], { cwd: job.ref.project, env: process.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        reject(new BuildFailure(`cannot start the build: ${(e as Error).message}`));
        return;
      }
      job.child = child;
      const out: Buffer[] = [];
      let outBytes = 0;
      let err = '';
      child.stdout!.on('data', (chunk: Buffer) => {
        outBytes += chunk.length;
        if (outBytes <= 32 * 1024 * 1024) out.push(chunk);
      });
      child.stderr!.on('data', (chunk: Buffer) => {
        err = (err + chunk.toString('utf8')).slice(-LOG_TAIL_CHARS);
      });
      const timer = setTimeout(() => {
        job.stopped ??= `the build did not finish within ${duration(this.buildTimeoutMs)} and was stopped`;
        if (child.pid !== undefined) void killTree(child.pid);
      }, this.buildTimeoutMs);
      timer.unref();
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        job.child = null;
        fn();
      };
      child.once('error', (e) => finish(() => reject(new BuildFailure(`cannot start the build: ${e.message}`))));
      child.once('close', (code, signal) =>
        finish(() => {
          const log = err.trim() || undefined;
          if (job.stopped) return reject(new BuildFailure(job.stopped, undefined, [], log));
          let answer: Record<string, unknown> | null = null;
          try {
            const parsed: unknown = JSON.parse(Buffer.concat(out).toString('utf8'));
            answer = isPlainObject(parsed) ? parsed : null;
          } catch {
            answer = null;
          }
          if (code === 0 && answer?.ok === true) return resolve(reportOf(answer, job.ref.project));
          const error = answer && isPlainObject(answer.error) ? answer.error : null;
          if (error && typeof error.message === 'string') {
            return reject(new BuildFailure(error.message, typeof error.hint === 'string' ? error.hint : undefined, Array.isArray(error.diagnostics) ? (error.diagnostics as Diagnostic[]) : [], log));
          }
          reject(new BuildFailure(`the build process ended with ${signal ? `signal ${signal}` : `exit code ${code}`}`, `run "rev2d avatar build ${job.ref.projectPath || '.'}" in a terminal to see what it prints`, [], log));
        }),
      );
    });
  }
}

/** The report and the summary of a variants import from its JSON answer (CLI --json or importAvatarVariants). */
function variantsReportOf(answer: Record<string, unknown>, project: string, name: string, removedFirst: readonly VariantId[], totalMs: number): { report: AvatarBuildReport; variants: AvatarVariantsImport } {
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);
  const issuesOf = (v: unknown) => (isPlainObject(v) && Array.isArray(v.issues) ? v.issues : Array.isArray(v) ? v : []) as AvatarBuildReport['issues'];
  const issues = issuesOf(answer.issues ?? answer.report);
  const diagnostics = (Array.isArray(answer.diagnostics) ? answer.diagnostics : []) as Diagnostic[];
  type Rejected = { id?: unknown; ok?: unknown; reason?: unknown; hint?: unknown; code?: unknown; values?: unknown };
  const checks = (Array.isArray(answer.checks) ? answer.checks : []) as Rejected[];
  const unreadable = ((Array.isArray(answer.unreadable) ? answer.unreadable : []) as Rejected[]).map((u) => ({ ...u, code: 'unreadable' }));
  const rejected = [...checks.filter((c) => c.ok === false), ...unreadable]
    .filter((c): c is Rejected & { id: string; reason: string } => typeof c.id === 'string' && typeof c.reason === 'string')
    .map((c) => ({
      id: c.id as VariantId,
      reason: c.reason,
      ...(typeof c.hint === 'string' ? { hint: c.hint } : {}),
      ...(typeof c.code === 'string' ? { code: c.code } : {}),
      ...(isPlainObject(c.values) ? { values: c.values as Record<string, number | string> } : {}),
    }));
  const ignored = (Array.isArray(answer.ignored) ? answer.ignored : []).filter(isPlainObject).map((i) => ({ file: String(i.file), reason: String(i.reason), ...(typeof i.hint === 'string' ? { hint: i.hint } : {}) }));
  const removed = [...new Set([...strings(answer.removed), ...removedFirst])] as VariantId[];
  const modelFile = typeof answer.modelFile === 'string' ? answer.modelFile : path.join(project, `${name}.r2d.json`);
  return {
    report: {
      layers: false,
      name: name || path.basename(modelFile).replace(/\.r2d\.json$/, ''),
      modelFile,
      modelBytes: typeof answer.modelBytes === 'number' ? answer.modelBytes : 0,
      layerFiles: strings(answer.sprites),
      removed: strings(answer.deleted),
      postOps: 0,
      warnings: countWarnings(issues) + countWarnings(diagnostics),
      issues,
      stats: {},
      diagnostics,
      timings: { totalMs },
    },
    variants: {
      accepted: strings(answer.accepted) as VariantId[],
      rejected,
      kept: strings(answer.kept) as VariantId[],
      removed,
      variants: strings(answer.variants) as VariantId[],
      ignored,
      notes: strings(answer.notes),
    },
  };
}

/** The report of a build from the JSON answer of `rev2d avatar build --json`. */
function reportOf(answer: Record<string, unknown>, project: string): AvatarBuildReport {
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);
  const numbers = (v: unknown) => (isPlainObject(v) ? Object.fromEntries(Object.entries(v).filter((e): e is [string, number] => typeof e[1] === 'number')) : {});
  const issues = (Array.isArray(answer.issues) ? answer.issues : []) as AvatarBuildReport['issues'];
  const diagnostics = (Array.isArray(answer.diagnostics) ? answer.diagnostics : []) as Diagnostic[];
  const name = typeof answer.name === 'string' ? answer.name : '';
  return {
    layers: true,
    name,
    modelFile: typeof answer.modelFile === 'string' ? answer.modelFile : path.join(project, `${name}.r2d.json`),
    modelBytes: typeof answer.modelBytes === 'number' ? answer.modelBytes : 0,
    layerFiles: strings(answer.layers),
    removed: strings(answer.removed),
    postOps: typeof answer.postOps === 'number' ? answer.postOps : 0,
    warnings: countWarnings(issues) + countWarnings(diagnostics),
    issues,
    stats: numbers(answer.stats),
    diagnostics,
    timings: numbers(answer.timings),
  };
}

// ----------------------------------------------------------------------------- endpoints

export async function getAvatar(ctx: ApiContext, _req: IncomingMessage, res: ServerResponse): Promise<void> {
  sendJson(res, 200, await ctx.avatar.info());
}

export async function putAvatar(ctx: ApiContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = parseAvatarSaveRequest(await readJson(req, ctx.maxBodyBytes));
  sendJson(res, 200, await ctx.exclusive(() => ctx.avatar.save(ctx, body)));
}

export async function postAvatarBuild(ctx: ApiContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = (await readBody(req, 64 * 1024)).toString('utf8').trim();
  let body: unknown;
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch (e) {
      throw new HttpError(400, `request body is not valid JSON: ${(e as Error).message}`, 'send {"layers": <boolean>}, or no body for a whole build');
    }
  }
  sendJson(res, 202, ctx.avatar.startBuild(ctx, parseAvatarBuildRequest(body)));
}

export async function getAvatarVariants(ctx: ApiContext, _req: IncomingMessage, res: ServerResponse): Promise<void> {
  sendJson(res, 200, await ctx.avatar.variantsInfo());
}

/** A small optional JSON body ("" = undefined). */
async function optionalJson(req: IncomingMessage, shape: string): Promise<unknown> {
  const raw = (await readBody(req, 64 * 1024)).toString('utf8').trim();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new HttpError(400, `request body is not valid JSON: ${(e as Error).message}`, `send ${shape}, or no body`);
  }
}

export async function postAvatarVariantsImport(ctx: ApiContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await optionalJson(req, '{"ids"?: [...], "remove"?: [...]}');
  sendJson(res, 202, ctx.avatar.startVariantsImport(ctx, parseAvatarVariantsImportRequest(body)));
}

export async function postAvatarVariantRequests(ctx: ApiContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await optionalJson(req, '{"ids"?: [...]}');
  sendJson(res, 200, await ctx.avatar.writeVariantRequests(parseAvatarVariantRequestsRequest(body)));
}

export function getAvatarBuild(ctx: ApiContext, _req: IncomingMessage, res: ServerResponse): void {
  ctx.avatar.requireProject();
  sendJson(res, 200, { job: ctx.avatar.lastJob() });
}

// ----------------------------------------------------------------------------- project files

/** What GET /api/avatar/file serves, by extension: pictures, JSON and plain text. Never a type a browser would run. */
const FILE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

const FILE_HINT = 'give a path relative to the project folder, e.g. "source.png", "textures/base.png", "variants/eyes_closed.png" or "review/poses.png" (GET /api/avatar lists the files)';

/**
 * Absolute path of a file inside the project folder, checked on its spelling: 403 when it leaves the
 * folder or names a hidden file, 400 for a name no portable file has. Nothing is read yet.
 */
function projectPath(ref: AvatarRef, relative: string): string {
  const outside = () => new HttpError(403, `${JSON.stringify(relative)} is not a file inside the project folder`, FILE_HINT);
  if (relative.includes('\0')) throw new HttpError(400, '"path" contains a NUL character', FILE_HINT);
  if (path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative) || /^[\\/]/.test(relative)) throw outside();
  const abs = path.resolve(ref.project, relative);
  if (!within(ref.project, abs) || samePath(abs, ref.project)) throw outside();
  const segments = path.relative(ref.project, abs).split(path.sep);
  if (segments.some((s) => s.startsWith('.'))) throw new HttpError(403, `${JSON.stringify(relative)} is a hidden file`, FILE_HINT);
  for (const s of segments) checkNameSegment(s, '"path"');
  return abs;
}

/** 404 when `abs` does not exist; 403 when it leads outside the project folder through a link or junction. */
async function checkReal(ref: AvatarRef, abs: string, relative: string, shown: string): Promise<void> {
  const [real, realProject] = await Promise.all([realpath(abs).catch(() => null), realpath(ref.project).catch(() => null)]);
  if (real === null || realProject === null) throw new HttpError(404, `file not found in the project: ${shown}`, FILE_HINT);
  if (!within(realProject, real)) throw new HttpError(403, `${JSON.stringify(relative)} leads outside the project folder (through a symbolic link)`, FILE_HINT);
}

export async function getAvatarFile(ctx: ApiContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const ref = ctx.avatar.requireProject();
  const relative = url.searchParams.get('path');
  if (!relative) throw new HttpError(400, 'missing query parameter "path"', FILE_HINT);
  const abs = projectPath(ref, relative);
  const shown = slashed(path.relative(ref.project, abs));
  const type = FILE_TYPES[path.extname(abs).toLowerCase()];
  if (!type) {
    throw new HttpError(415, `${shown} is not a file type the editor serves`, `served types: ${Object.keys(FILE_TYPES).join(', ')}`);
  }
  await checkReal(ref, abs, relative, shown);
  const st = await stat(abs).catch(() => null);
  if (!st) throw new HttpError(404, `file not found in the project: ${shown}`, FILE_HINT);
  if (!st.isFile()) throw new HttpError(400, `${shown} is a directory, not a file`, FILE_HINT);
  const etag = `W/"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}"`;
  const headers: Record<string, string | number> = {
    'Content-Type': type,
    // Revalidated on every use: a rebuilt layer shows at once, an unchanged one is not sent again.
    'Cache-Control': 'no-cache',
    ETag: etag,
    'Last-Modified': st.mtime.toUTCString(),
    'X-Content-Type-Options': 'nosniff',
    // The person's pictures are not for other sites to embed.
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  try {
    await pipeline(createReadStream(abs), res);
  } catch {
    // The client went away, or the file was replaced while it was sent: the connection is of no use.
    res.destroy();
  }
}

// ----------------------------------------------------------------------------- new project

const DATA_URL = /^data:[^,]*;base64,/i;
const BASE64 = /^[A-Za-z0-9+/_-]*={0,2}$/;

/** The image format named by a file's first bytes, for the "not a PNG" message; null when unknown. */
function imageFormat(bytes: Buffer): string | null {
  const ascii = (from: number, text: string) => bytes.length >= from + text.length && bytes.toString('latin1', from, from + text.length) === text;
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'JPEG';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'WebP';
  if (ascii(0, 'GIF8')) return 'GIF';
  if (ascii(0, 'BM')) return 'BMP';
  if (ascii(4, 'ftyp')) return 'AVIF / HEIC';
  if (ascii(0, '8BPS')) return 'Photoshop (PSD)';
  if (ascii(0, '<svg') || ascii(0, '<?xml')) return 'SVG';
  return null;
}

const megabytes = (n: number) => `${(n / (1024 * 1024)).toFixed(n % (1024 * 1024) === 0 ? 0 : 1)} MB`;

/** Folders of `abs` (itself first) that do not exist yet: what creating it will create. */
async function missingFolders(abs: string): Promise<string[]> {
  const missing: string[] = [];
  for (let cur = abs; !(await stat(cur).catch(() => null)); cur = path.dirname(cur)) {
    missing.push(cur);
    if (path.dirname(cur) === cur) break;
  }
  return missing;
}

export async function postAvatarNew(ctx: ApiContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const limit = ctx.avatar.maxImageBytes;
  const tooLarge = (size?: number) =>
    new HttpError(
      413,
      `the picture is ${size === undefined ? 'larger than' : `${megabytes(size)}; at most`} ${megabytes(limit)}${size === undefined ? '' : ' are accepted'}`,
      'scale it down or save it with stronger PNG compression (2000 to 3000 px on the long side is plenty for an avatar)',
      {},
      { Connection: 'close' },
    );
  let raw: unknown;
  try {
    // base64 takes 4 characters per 3 bytes; the rest of the body is a few names.
    raw = await readJson(req, Math.ceil(limit / 3) * 4 + 64 * 1024);
  } catch (e) {
    if (e instanceof HttpError && e.status === 413) throw tooLarge();
    throw e;
  }
  const body = parseAvatarNewRequest(raw);
  const pictureName = body.image.name.split(/[\\/]/).pop() || 'picture';
  const b64 = body.image.base64.replace(DATA_URL, '').replace(/\s+/g, '');
  if (!BASE64.test(b64)) throw new HttpError(400, 'invalid avatar new request: image.base64 is not valid base64', 'send the PNG bytes base64-encoded (a data: URL is accepted too)');
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.length > limit) throw tooLarge(bytes.length);
  const convert = 'convert the picture to PNG first, ideally with a transparent background (an image editor, or e.g. "magick input.jpg output.png")';
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString('latin1', 12, 16) !== 'IHDR') {
    const format = imageFormat(bytes);
    throw new HttpError(422, `${pictureName} is ${format ? `a ${format} image` : 'not a PNG image'}; an avatar project needs a PNG`, convert);
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1 || width > MAX_AVATAR_IMAGE_SIDE || height > MAX_AVATAR_IMAGE_SIDE) {
    throw new HttpError(422, `${pictureName} is ${width}x${height} px; pictures of 1 to ${MAX_AVATAR_IMAGE_SIDE} px per side are accepted`, 'scale the picture down (2000 to 3000 px on the long side is plenty for an avatar)');
  }

  const { lib, io } = await avatarModules();
  const name = body.name ?? lib.avatarSpecName(pictureName.replace(/\.[A-Za-z0-9]+$/, ''));
  if (!ID_PATTERN.test(name)) {
    throw new HttpError(400, `invalid avatar new request: "${name}" is not a valid avatar name`, `names use letters, digits, _ and - and do not start with a digit, e.g. "${lib.avatarSpecName(name)}"`);
  }

  const result = await ctx.exclusive(async (): Promise<AvatarNewResult> => {
    const requested = body.dir ?? name;
    const notes: string[] = [];
    // The folder must be new or empty; with "unique", the first of <dir>, <dir>-2, <dir>-3, ... that is.
    let dir = '';
    for (let n = 1; ; n++) {
      const candidate = await ctx.root.resolveNew(n === 1 ? requested : `${requested.replace(/[\\/]+$/, '')}-${n}`, 'dir');
      const st = await stat(candidate).catch(() => null);
      const free = !st || (st.isDirectory() && (await readdir(candidate).catch(() => ['?'])).length === 0);
      if (free) {
        dir = candidate;
        if (n > 1) notes.push(`${ctx.root.rel(await ctx.root.resolve(requested, 'dir')) || '.'} exists: the project was created as ${ctx.root.rel(dir)}`);
        break;
      }
      if (body.unique !== true || n >= 99) {
        const shown = ctx.root.rel(candidate) || '.';
        throw new HttpError(
          409,
          st!.isDirectory() ? `the folder ${shown} already exists and is not empty` : `${shown} is a file`,
          `choose another "dir" or "name", pass "unique": true to create "${ctx.root.rel(await ctx.root.resolve(requested, 'dir')) || name}-2" instead, or open the project that is there (POST /api/open {"file": "${shown === '.' ? '' : `${shown}/`}${SPEC_FILE}"})`,
        );
      }
    }
    const created = await missingFolders(dir);
    const source = path.join(dir, SOURCE_FILE);
    const undo = async () => {
      if (created.length) await rm(created[created.length - 1], { recursive: true, force: true }).catch(() => undefined);
      else await Promise.all([rm(source, { force: true }), rm(path.join(dir, SPEC_FILE), { force: true })]).catch(() => undefined);
    };
    let project: Awaited<ReturnType<AvatarIO['createAvatarProject']>>;
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(source, bytes);
      // The bytes are in place already: createAvatarProject checks that they decode and writes the draft spec.
      project = await io.createAvatarProject(source, dir, { name });
    } catch (e) {
      await undo();
      if (e instanceof io.AvatarProjectError) {
        const message = e.message.split(source).join(pictureName);
        throw new HttpError(e.kind === 'exists' ? 409 : 422, `${message}; nothing was created`, e.kind === 'invalid' ? (e.hint ?? convert) : e.hint);
      }
      throw new HttpError(500, `cannot create ${ctx.root.rel(dir) || '.'}: ${(e as Error).message}`, 'check that the workspace is writable');
    }
    const ref = refOf(ctx.root, dir);
    await ctx.switchTo(null, 'editor', ref);
    const draft = lib.parseAvatarSpec(project.doc, { imageSize: { width: project.width, height: project.height } });
    notes.unshift(`created ${ctx.root.rel(dir) || '.'}: ${SOURCE_FILE} (${project.width}x${project.height}) and a draft ${SPEC_FILE}`);
    return {
      ...ref,
      specPath: ctx.root.rel(ref.specFile),
      name: project.name,
      image: { file: SOURCE_FILE, path: ctx.root.rel(source), width: project.width, height: project.height, bytes: bytes.length },
      mtimeMs: (await stat(ref.specFile)).mtimeMs,
      landmarksToPlace: draft.diagnostics.filter((d) => d.code === 'avatar-missing-landmark').length,
      notes: [...notes, ...project.notes],
    };
  });
  sendJson(res, 200, result);
}
