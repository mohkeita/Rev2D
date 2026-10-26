/**
 * Discovery of running editor servers, so the CLI / MCP server can talk to the editor a human is
 * looking at ("what does the user see?", "show the user this pose").
 *
 * Each server writes ~/.rev2d/editors/<pid>-<port>.json while running (one process may run several
 * servers). Stale entries (dead pid) are ignored and cleaned up opportunistically.
 */
import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Diagnostic } from '../core/types.js';
import type { AvatarIssue, LayersMeta, VariantId } from '../avatar/types.js';
import type { VariantStatusEntry } from './avatar-variants.js';
import type { AgentEffort, AgentEvent, AgentJobEvents, AgentJobInfo, AgentJobState, AgentProviderId, AgentSandbox, CodexWindowsSandbox } from './agent/types.js';

export interface EditorEntry {
  pid: number;
  url: string;
  /**
   * Absolute path of the model file the editor has open, '' while it has none (start screen). The
   * server rewrites its entry whenever the open model changes (open, new, save as, import, close).
   */
  file: string;
  /**
   * Absolute workspace root of the editor: every file it opens, creates, saves or imports lies inside
   * it, so an editor on its start screen (file '') is still found by a path of its workspace. Absent
   * in entries of editors that predate file management.
   */
  root?: string;
  startedAt: string;
}

/**
 * One animation layer of the editor (EditorState.animations, setAnimations commands). Mirrors
 * core AnimationLayer (SPEC §6): weight 0..1 (default 1); mode 'override' (default: later layers
 * win) or 'add' (param tracks add weight * (v - default) on top); start = global time at which
 * the layer starts (local time = time - start, default 0); hold (default true) = a non-looping
 * layer keeps its first/last key values outside [0, duration] (false: it contributes nothing there).
 */
export interface EditorLayer {
  id: string;
  weight?: number;
  mode?: 'override' | 'add';
  start?: number;
  hold?: boolean;
}

/**
 * Editor view state, published by the editor UI (POST /api/state) and readable by AI tools
 * (GET /api/state). Mirrors PoseInput so it can be rendered server-side.
 */
export interface EditorState {
  file: string;
  /**
   * Evaluated value of every parameter as shown, physics outputs and pinned values included: together with `time` and
   * `animations` (for non-parameter tracks) they define the pose, so screenshots render them with
   * physics off.
   */
  params: Record<string, number>;
  /** Global playback time in seconds (layers with `start` run at time - start). */
  time: number;
  /** Animation layers in blend order: the timeline's main animation first, then the extra layers. */
  animations: EditorLayer[];
  playing: boolean;
  selection: string[];
  overlay: string[];
  /** Visible region of the viewport in model space [x, y, w, h]. */
  viewBox: [number, number, number, number] | null;
  /** The editor's physics toggle (its results are already in `params`). */
  physics?: boolean;
  /** Parts hidden in the editor's preview (not in the model); screenshots leave them out. */
  hidden?: string[];
  /**
   * Parameters with an explicit value in the editor (slider moved, value typed or physics output
   * pinned): their `params` value beats animation and physics until the human releases it.
   */
  pinned?: string[];
  /**
   * Avatar mode only (the open model belongs to an avatar project): what the person works on in the
   * avatar panel. `part` is the selected item of describeAvatarParts (src/avatar/parts.ts), e.g.
   * "eyes.imageLeft.opening" or "strand.bang1"; null or absent when nothing is selected.
   */
  avatar?: { part?: string | null };
  updatedAt: string;
}

/** Commands an AI can send to the editor (POST /api/command); forwarded to the UI over SSE. */
export type EditorCommand =
  | { type: 'setParams'; params: Record<string, number>; reset?: boolean }
  | { type: 'play'; animation?: string }
  | { type: 'pause' }
  | { type: 'seek'; time: number }
  | { type: 'setAnimations'; animations: EditorLayer[] }
  | { type: 'select'; ids: string[] }
  | { type: 'setOverlay'; overlay: string[] }
  | { type: 'focus'; viewBox: [number, number, number, number] | 'fit' }
  | { type: 'reload' }
  /**
   * Open another model of the workspace (absolute, or relative to the workspace root). Handled by the
   * server, not forwarded: POST /api/command answers {delivered, file, mtimeMs, notes} (delivered = tabs
   * that received "file-changed", origin "ai"), or the errors of POST /api/open. `file` may also name
   * an avatar project (its avatar.json or its folder): the answer then carries `avatar` (AvatarRef), and
   * `file` is null while the project has no built model yet.
   */
  | { type: 'open'; file: string }
  | { type: 'message'; text: string };

export function registryDir(): string {
  return path.join(os.homedir(), '.rev2d', 'editors');
}

/** Port of an editor URL ("80" / "443" when the URL names none, "0" when it does not parse). */
function portOf(url: string): string {
  if (!URL.canParse(url)) return '0';
  const u = new URL(url);
  return u.port || (u.protocol === 'https:' ? '443' : '80');
}

/** Advertise a running server; returns a function that withdraws exactly this entry. */
export function registerEditor(entry: EditorEntry): () => void {
  const dir = registryDir();
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${entry.pid}-${portOf(entry.url)}.json`);
  writeFileSync(file, JSON.stringify(entry, null, 2));
  return () => rmSync(file, { force: true });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';
/** Comparable form of a path: resolved, case-folded where the file system is case-insensitive. */
const key = (p: string) => (CASE_INSENSITIVE ? path.resolve(p).toLowerCase() : path.resolve(p));

/** Whether `p` is directory `dir` itself or lies inside it (lexically). */
function within(dir: string, p: string): boolean {
  const rel = path.relative(key(dir), key(p));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** Real path of `p`, or of its nearest existing ancestor joined with the missing rest; null if none resolves. */
function realPath(p: string): string | null {
  const rest: string[] = [];
  for (let cur = path.resolve(p); ; ) {
    try {
      return path.join(realpathSync.native(cur), ...rest);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return null;
      rest.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

/** Whether the editor has model file `file` open. */
export function editorHasFile(entry: EditorEntry, file: string): boolean {
  return entry.file !== '' && key(entry.file) === key(file);
}

/**
 * Whether `p` (a file or directory; it need not exist) lies inside the editor's workspace root, or is
 * the root itself. Other spellings of the same place (symbolic links, junctions, 8.3 short names) are
 * compared by their real paths. False for entries without a root.
 */
export function editorRootContains(entry: EditorEntry, p: string): boolean {
  if (!entry.root) return false;
  if (within(entry.root, p)) return true;
  const root = realPath(entry.root);
  const real = realPath(p);
  return root !== null && real !== null && within(root, real);
}

/** Innermost workspace root first (the roots containing one path are nested); stable, so ties stay newest first. */
function innermostFirst(entries: EditorEntry[]): EditorEntry[] {
  return entries.slice().sort((a, b) => key(b.root ?? '').length - key(a.root ?? '').length);
}

/**
 * Which running editors listEditors returns (every condition given must hold):
 * - file: editors that have this model file open;
 * - root: editors whose workspace root is this directory;
 * - inside: editors whose workspace root contains this path (a file or directory, the root itself
 *   included), innermost root first. Entries without a root never match root / inside.
 */
export interface EditorQuery {
  file?: string;
  root?: string;
  inside?: string;
}

/**
 * Running editors, newest first (with `inside`: innermost workspace root first, then newest). A
 * string argument is short for {file}: only the editors that have that model file open.
 */
export function listEditors(query: string | EditorQuery = {}): EditorEntry[] {
  const q: EditorQuery = typeof query === 'string' ? { file: query } : query;
  const dir = registryDir();
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: EditorEntry[] = [];
  for (const n of names) {
    const full = path.join(dir, n);
    try {
      const e = JSON.parse(readFileSync(full, 'utf8')) as EditorEntry;
      if (!alive(e.pid)) {
        rmSync(full, { force: true });
        continue;
      }
      if (q.file && !editorHasFile(e, q.file)) continue;
      if (q.root && !(e.root && key(e.root) === key(q.root))) continue;
      if (q.inside && !editorRootContains(e, q.inside)) continue;
      out.push(e);
    } catch {
      // ignore unreadable entries
    }
  }
  out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return q.inside ? innermostFirst(out) : out;
}

/**
 * Find the editor to talk to: an explicit `url` (not looked up); else, among the running editors
 * (restricted to the workspace `root` when given: the editor of exactly that root, else the
 * innermost one containing it),
 * - for `file`: the newest editor that has it open, else the one whose workspace root contains it
 *   (innermost root first, then newest), e.g. an editor on its start screen in that workspace;
 * - otherwise the newest editor.
 * Null when none matches. editorHasFile tells whether the result has `file` open.
 */
export function findEditor(opts: { url?: string; file?: string; root?: string } = {}): EditorEntry | null {
  if (opts.url) return { pid: -1, url: opts.url.replace(/\/$/, ''), file: opts.file ?? '', startedAt: '' };
  let pool = listEditors();
  if (opts.root) {
    const root = opts.root;
    const exact = pool.filter((e) => e.root !== undefined && key(e.root) === key(root));
    pool = exact.length ? exact : innermostFirst(pool.filter((e) => editorRootContains(e, root)));
  }
  if (opts.file) {
    const file = opts.file;
    return pool.find((e) => editorHasFile(e, file)) ?? innermostFirst(pool.filter((e) => editorRootContains(e, file)))[0] ?? null;
  }
  return pool[0] ?? null;
}

// ----------------------------------------------------------------------------- workspace (file management)
//
// The editor server works inside a WORKSPACE ROOT directory (`rev2d edit [model] --root <dir>`;
// default: the model's directory, else the current directory). At most one model is open at a time;
// the human (File menu) or an AI (POST /api/open, EditorCommand 'open') can switch, create, save-as
// and close models. Every path in these payloads is either absolute or relative to the root, and
// the server rejects anything that resolves outside the root (after resolving symlinks).
//
//   GET  /api/workspace            -> WorkspaceInfo
//   GET  /api/files?dir=<rel>      -> FileListing          (directories + model files + PNGs)
//   POST /api/open    OpenRequest  -> OpenResult           (switch the current model)
//   POST /api/new     NewRequest   -> OpenResult           (create from a template, then open it)
//   POST /api/save-as SaveAsRequest-> OpenResult           (write the doc to a new path, then open it)
//   POST /api/close                -> WorkspaceInfo        (no model open: the UI shows its start screen)
//   POST /api/import  ImportRequest-> OpenResult           (files picked from the user's computer, written into the root)
//   GET  /api/download             -> the current model file as an attachment
//   GET  /api/templates            -> TemplateInfo[]
// Endpoints that need a model (/api/model, /api/texture, /api/screenshot, /api/info, /api/state,
// /api/download, /api/save-as, commands other than open/message) answer 409 {error: "no model is
// open", hint} while none is open. SSE event "file-changed" {file | null, origin: "editor" | "ai"}
// tells every UI tab to (re)load or show the start screen; the stream's first event is hello
// {file | null, mtimeMs, root}.
//
// Errors are JSON {error, hint?, diagnostics?}: 400 malformed request or invalid file name (new files
// must have portable names: no \ : * ? " < > |, control characters, trailing dot/space or device
// names such as CON), 403 path outside the root (also through a symbolic link, or through a broken
// link), 404 missing file, 409 target exists without overwrite / no model open, 413 too large, 422
// not a Rev2D model / unparseable JSON (with diagnostics).
//
// A switch (open, new, save as, import, close) resets the view state (GET /api/state 404 until the UI
// publishes again), retargets the file watcher, rewrites the registry entry's `file` and records the
// file in the recent list. So that a tab which has not followed a switch yet cannot write its old
// model over the new one, PUT /api/model accepts `file` (the model the write is for) and POST
// /api/state checks its absolute `file`: a mismatch is refused with 409 {error, hint, file}.

export interface WorkspaceInfo {
  /** Absolute workspace root. */
  root: string;
  /** Absolute path of the open model, or null. */
  current: string | null;
  /**
   * Recently opened model files (absolute, newest first, at most 10; only those that still exist and
   * lie inside this root). Stored in ~/.rev2d/recent.json ({"files": [...]}, shared by editors).
   * The avatar.json of an avatar project that was opened before it had a built model is listed too.
   */
  recent: string[];
  /** The open avatar project (avatar mode); absent when the open document is not one. */
  avatar?: AvatarRef;
}

export interface FileEntry {
  name: string;
  /** Path relative to the root, '/'-separated. */
  path: string;
  /** model = *.r2d.json / *.r2d.jsonc, image = *.png, other = any other *.json (may be a model). Other files and ".hidden" entries are not listed. */
  type: 'dir' | 'model' | 'image' | 'other';
  /** Bytes (0 for directories). */
  size: number;
  mtimeMs: number;
  /**
   * Present on a directory that is an avatar project (it holds an avatar.json) and on the avatar.json
   * itself: `spec` is the avatar.json to open (POST /api/open {file: spec}), `name` the avatar's name
   * (null while the spec has no usable one) and `model` its built model when that exists (paths
   * relative to the root, '/'-separated).
   */
  avatar?: { spec: string; name: string | null; model: string | null };
}

export interface FileListing {
  /** Listed directory relative to the root ('' = root). */
  dir: string;
  /** Parent directory relative to the root, or null at the root. */
  parent: string | null;
  /** Directories first, then files, each by name; links leading outside the root are left out. */
  entries: FileEntry[];
}

export interface OpenRequest {
  file: string;
}

export interface NewRequest {
  /** Target model path (should end in .r2d.json; a name without .json/.jsonc gets ".r2d.json" appended). Parent directories are created. */
  file: string;
  /** Template name from GET /api/templates (default "blank"). Example textures are copied next to the model (identical existing copies are shared). */
  template?: string;
  /** meta.name (default: the file name without extension). */
  name?: string;
  /** Canvas size of the blank and empty templates (integers 1..8192; default 512). */
  width?: number;
  height?: number;
  /** Replace an existing file (default false: 409 when it exists). */
  overwrite?: boolean;
}

export interface SaveAsRequest {
  /** Target path (a name without .json/.jsonc gets ".r2d.json" appended). Needs an open model. */
  file: string;
  /**
   * The document to write (the UI's current raw doc); written with formatModelJson (CRLF kept when
   * the open file uses it). Or raw `text`, written verbatim unless texture paths must be rewritten
   * (then reformatted; a JSON syntax error is refused with 422). Neither: the open file as on disk.
   * Relative texture paths are rewritten to point at the same PNGs from the new location (notes).
   */
  doc?: unknown;
  text?: string;
  /** Replace an existing file (default false: 409). Saving over the open model itself needs no overwrite. */
  overwrite?: boolean;
}

export interface ImportRequest {
  /** Target directory relative to the root (default ''); created when missing. */
  dir?: string;
  /**
   * Exactly one model (.json / .jsonc: must be a JSON object with "format": "rev2d", else 422 with
   * diagnostics) plus optional PNG textures (checked by signature), at most 64 files. A Spine
   * skeleton JSON export is accepted too, with its .atlas / .atlas.txt (as text) and PNG pages: it is
   * converted into <skeleton name>.r2d.json + textures/ (src/node/interop.ts), and the answer adds its
   * conversion `report`. Content is
   * utf8 `text` or `base64` (a data: URL is accepted). `name` may contain "/" for subdirectories
   * (portable names only). Other files are skipped with a note. Nothing is written when any check
   * fails; the request body is capped (default 64 MiB) and the model by the editor's write limit.
   */
  files: Array<{ name: string; text?: string; base64?: string }>;
  /** Replace existing files with different content (default false: 409 naming them; identical files are fine). */
  overwrite?: boolean;
}

export interface OpenResult {
  file: string;
  text: string;
  mtimeMs: number;
  /** Notes such as rewritten texture paths after save-as or skipped files after import. */
  notes: string[];
  /** The avatar project the opened model belongs to (its folder holds an avatar.json): the editor is in avatar mode. */
  avatar?: AvatarRef;
}

/**
 * POST /api/open (and the "open" command) for an avatar project that has no built model yet: the
 * project is open, no model is (the UI shows the illustration and the landmarks, with a Build button).
 */
export interface AvatarOpenResult {
  file: null;
  text: null;
  mtimeMs: 0;
  notes: string[];
  avatar: AvatarRef;
}

export interface TemplateInfo {
  name: string;
  description: string;
}

// ----------------------------------------------------------------------------- avatar mode
//
// An avatar project is a folder with avatar.json (the spec), source.png (the illustration) and what
// is built from them: <name>.r2d.json, textures/ (src/avatar/DESIGN.md §1). The editor is in AVATAR
// MODE while the open model has a sibling avatar.json, or after an avatar project itself was opened:
// POST /api/open (and the "open" command) accept an avatar.json or a project folder and open its
// built model; while it has none, the project is open WITHOUT a model (AvatarOpenResult; /api/model
// answers 409 "no model is open" until the first build). src/server/avatar-routes.ts implements:
//
//   GET  /api/avatar                          -> AvatarInfo
//   PUT  /api/avatar  AvatarSaveRequest       -> AvatarSaveResult  (write avatar.json, recompile the model)
//   POST /api/avatar/build AvatarBuildRequest -> 202 AvatarJobEvent (state "running"; one job at a time)
//   GET  /api/avatar/build                    -> {job: AvatarJobEvent | null}  (the latest event of the last job)
//   GET  /api/avatar/file?path=<relative>     -> the bytes of a file of the project folder
//   POST /api/avatar/new   AvatarNewRequest   -> AvatarNewResult   (a new project from one uploaded PNG; it is opened)
//   SSE "avatar-changed" AvatarChangedEvent, SSE "avatar-job" AvatarJobEvent on GET /api/events
//
// The SSE events "hello" and "file-changed", GET /api/workspace and the answers of the endpoints that
// open a model gain `avatar` (AvatarRef) while an avatar project is open; it is absent otherwise.
// GET /api/files marks avatar projects (FileEntry.avatar).
//
// Errors are JSON {error, hint?}: 400 malformed request, 403 a path outside the project folder or the
// workspace root, 404 the open document is not an avatar project / no such file, 409 the folder of a
// new project exists / avatar.json changed on disk (with mtimeMs) / a build is running (with job),
// 413 the picture is too large, 415 a file type GET /api/avatar/file does not serve, 422 the picture
// is not a PNG.

/** The avatar project that is open in the editor. */
export interface AvatarRef {
  /** Absolute project folder. */
  project: string;
  /**
   * The folder relative to the workspace root, '/'-separated ('' = the root itself): what an agent
   * job takes as `context.project` (POST /api/agent/jobs).
   */
  projectPath: string;
  /** Absolute path of its avatar.json. */
  specFile: string;
}

/** A file of an avatar project that the server watches. */
export interface AvatarFileInfo {
  /** Path relative to the project folder, '/'-separated: the `path` of GET /api/avatar/file. */
  path: string;
  size: number;
  mtimeMs: number;
}

/** GET /api/avatar: the open avatar project. */
export interface AvatarInfo extends AvatarRef {
  /** Name of the avatar (its built model is <name>.r2d.json); null while avatar.json has no usable name. */
  name: string | null;
  /** Text of avatar.json; null when the file is missing or unreadable (`diagnostics` says so; PUT writes it again). */
  specText: string | null;
  /** mtime of avatar.json (0 when it is missing): the `baseMtimeMs` of the next PUT /api/avatar. */
  mtimeMs: number;
  /**
   * The illustration: its path inside the project (GET /api/avatar/file?path=<file>) and its real
   * pixel size. null when it is missing or not a usable PNG (`diagnostics` says why).
   */
  image: { file: string; width: number; height: number } | null;
  built: {
    /** Absolute path of the built model <name>.r2d.json when it exists, else null. */
    model: string | null;
    /** Its mtime (null without a model). */
    modelMtimeMs: number | null;
    /** textures/layers.json: what compileAvatar needs besides the spec; null until the layers are built. */
    meta: LayersMeta | null;
    /**
     * True when the layer images are older than the spec: a landmark that cuts pixels changed since
     * they were built (meta.inputsHash differs from layerInputsHash(spec)); POST /api/avatar/build
     * rebuilds them. False without layers and while the spec has errors (it cannot be told then).
     */
    stale: boolean;
    /** Ids of the drawn variants that were accepted and cut into sprites (meta.variants). */
    variants: string[];
  };
  /**
   * The watched files of the project: avatar.json, the illustration and everything directly inside
   * textures/, variants/, variant-requests/ and review/, by path.
   */
  files: AvatarFileInfo[];
  /** File problems first ("file-not-found", "avatar-source-*"), then the spec's diagnostics (parseAvatarSpec), then "avatar-layers-*". */
  diagnostics: Diagnostic[];
  /** The latest event of the last build job of this project, or null. */
  job: AvatarJobEvent | null;
}

/** PUT /api/avatar. */
export interface AvatarSaveRequest {
  /** The new avatar.json: raw text (written verbatim), or ... */
  text?: string;
  /** ... the document (written with the stable formatter; CRLF is kept when the file uses it). Exactly one of the two. */
  doc?: unknown;
  /**
   * mtimeMs of the version the edit is based on (GET /api/avatar, or the last PUT): the write is
   * refused with 409 {error, hint, mtimeMs} when avatar.json changed on disk since (same rule as PUT
   * /api/model). Omit it to write unconditionally.
   */
  baseMtimeMs?: number;
  /** Recompile the model after the write (default true). */
  compile?: boolean;
}

/** PUT /api/avatar: 200 also when the spec has errors (a draft is saved all the same). */
export interface AvatarSaveResult {
  /** The spec has no errors. */
  ok: boolean;
  /** avatar.json holds the new text (its previous content is kept as avatar.json.bak). False only when the text is not a JSON object: nothing was written then (`hint`). */
  written: boolean;
  /** Diagnostics of the new spec, as in AvatarInfo. */
  diagnostics: Diagnostic[];
  /** As AvatarInfo.built.stale, for the new spec. */
  stale: boolean;
  /** mtime of avatar.json now. */
  mtimeMs: number;
  /**
   * The model was recompiled from the new spec and the existing layer metadata. False when the spec
   * has errors, the layers are not built yet, a build job is running, `compile` was false or the
   * compile failed (`notes` says which; `error` has the failure).
   */
  compiled: boolean;
  /** The built model after the recompile (`changed`: its text differs from before, so it was rewritten); null when not compiled. */
  model: { file: string; mtimeMs: number; changed: boolean } | null;
  notes: string[];
  /** Why the compile failed. */
  error?: { message: string; hint?: string; diagnostics?: Diagnostic[] };
  hint?: string;
}

/** POST /api/avatar/build (the body may be empty). */
export interface AvatarBuildRequest {
  /**
   * true (default): the whole build: cut the layer images, write textures/ and layers.json, compile
   * the model. false: only recompile the model from the existing layers (fast).
   */
  layers?: boolean;
}

/** running: the job works (`step` says on what); done / failed: it ended. */
export type AvatarJobState = 'running' | 'done' | 'failed';

/**
 * What a running job does: "start" (accepted), "build" (cutting the layer images and compiling the
 * model), "compile" (compiling the model from the existing layers), "reload" (the editor opens or
 * reloads the built model).
 */
export type AvatarJobStep = 'start' | 'build' | 'compile' | 'variants' | 'reload';

/** What a job does: cut the layers and compile (build), only compile, or import the drawn variants. */
export type AvatarJobKind = 'build' | 'compile' | 'variants';

/** What a finished build did. */
export interface AvatarBuildReport {
  /** Whether the layer images were rebuilt (false: the model was recompiled from the existing layers). */
  layers: boolean;
  name: string;
  /** Absolute path of the built model and its size. */
  modelFile: string;
  modelBytes: number;
  /** The layer images of the build, relative to the project ("textures/base.png", ...); empty for a compile-only job. */
  layerFiles: string[];
  /** Layer images of an earlier build that were deleted. */
  removed: string[];
  /** Number of spec.post ops applied. */
  postOps: number;
  /** Warnings among `issues` and `diagnostics`. */
  warnings: number;
  /** Issues of the build (e.g. "avatar-mesh-fold"), with JSON pointers into avatar.json where they have one. */
  issues: AvatarIssue[];
  /** Counts and measurements of the build (layers, parameters, warps, latticePoints, ...). */
  stats: Record<string, number>;
  /** Validation diagnostics of the built model (warnings and info; errors fail the build). */
  diagnostics: Diagnostic[];
  /** Milliseconds per stage (layersMs, compileMs, validateMs, foldsMs, writeMs, totalMs, ...). */
  timings: Record<string, number>;
}

/**
 * One event of a build job: the answer of POST /api/avatar/build (202, state "running", step "start"),
 * every SSE "avatar-job" event, and `job` of GET /api/avatar and GET /api/avatar/build. A job sends
 * "running" events (one per step) and ends with exactly one "done" or "failed" event.
 */
export interface AvatarJobEvent {
  /** Id of the job. */
  job: string;
  state: AvatarJobState;
  /** Absolute folder of the project the job builds. */
  project: string;
  /** AvatarBuildRequest.layers (false for a variants import: no layer image is cut). */
  layers: boolean;
  /** "variants" for POST /api/avatar/variants/import; absent for builds ("build" or "compile" by `layers`). */
  kind?: AvatarJobKind;
  /** running: what the job is doing. */
  step?: AvatarJobStep;
  /** A sentence for the person: what happens (running), what was built (done), what went wrong (failed). */
  message?: string;
  /** failed: how to fix it. */
  hint?: string;
  /** failed: the diagnostics behind the failure (spec errors with JSON pointers into avatar.json, model errors). */
  diagnostics?: Diagnostic[];
  /** failed: the end of the builder's error output, when it wrote any. */
  log?: string;
  /** done: what was built. */
  report?: AvatarBuildReport;
  /** done: whether the layers are older than the spec again (avatar.json changed while the job ran). */
  stale?: boolean;
  /** done, kind "variants": what the import did. */
  variants?: AvatarVariantsImport;
  /** ISO 8601 times; `elapsedMs` since the start. */
  startedAt: string;
  endedAt?: string;
  elapsedMs: number;
}

// ----------------------------------------------------------------------------- drawn variants

/** POST /api/avatar/variants/import (the body may be empty): a job like a build ("avatar-job" events, kind "variants"). */
export interface AvatarVariantsImportRequest {
  /** Only these variants (default: every drawing in variants/). */
  ids?: VariantId[];
  /** Delete these drawings (variants/<id>.png) first: their sprites go with the import. */
  remove?: VariantId[];
}

/** What a variants import did (AvatarJobEvent.variants). */
export interface AvatarVariantsImport {
  /** Drawings accepted and cut into sprites now. */
  accepted: VariantId[];
  /** Drawings rejected now, with the reason and what to ask the image generator next (`code` / `values`: VariantCheckResult). */
  rejected: Array<{ id: VariantId; reason: string; hint?: string; code?: string; values?: Record<string, number | string> }>;
  /** Rejected drawings whose earlier sprite stays. */
  kept: VariantId[];
  /** Variants whose drawing is gone (or was removed): their sprites were removed. */
  removed: VariantId[];
  /** The variants with a sprite in the model now. */
  variants: VariantId[];
  /** Files in variants/ that are not drawings of a known variant. */
  ignored: Array<{ file: string; reason: string; hint?: string }>;
  notes: string[];
}

/** One variant in GET /api/avatar/variants (src/node/avatar-variants.ts VariantStatusEntry). */
export type AvatarVariantStatus = VariantStatusEntry;

/** GET /api/avatar/variants: the state of every drawn variant of the open project. */
export interface AvatarVariantsInfo {
  /** Absolute project folder. */
  project: string;
  /** The project has layers (drawings can be imported). */
  built: boolean;
  /** Every variant id (VARIANT_IDS order) with its state: missing, requested, drawn, accepted, rejected or stale. */
  variants: AvatarVariantStatus[];
  counts: Record<AvatarVariantStatus['state'], number>;
  /** Files in variants/ that are not drawings of a known variant. */
  ignored: Array<{ file: string; reason: string; hint?: string }>;
  /** The edit areas in source pixels, [x, y, width, height] (eyes: both eyes; mouth: the mouth area); null without a valid spec. */
  areas: Partial<Record<import('../avatar/types.js').VariantGroup, [number, number, number, number] | null>>;
  /** variant-requests/README.md and preview.png when written (project-relative), else null. */
  requests: { readme: string | null; preview: string | null };
  notes: string[];
}

/** POST /api/avatar/variants/request: write the masks and prompts for an image generator. */
export interface AvatarVariantRequestsRequest {
  /** Default: the recommended eyes_closed and mouth_a, plus every variant requested before. */
  ids?: VariantId[];
}

/** POST /api/avatar/variants/request answers this. */
export interface AvatarVariantRequestsResult {
  /** The variants requested (masks and prompts written), project-relative paths. */
  requests: Array<{ id: VariantId; maskFile: string; promptFile: string; file: string; prompt: string }>;
  readme: string;
  preview: string;
  /** Every file written, project-relative. */
  files: string[];
  notes: string[];
}

/** POST /api/avatar/new: a new avatar project from one picture. */
export interface AvatarNewRequest {
  /**
   * Name of the avatar (letters, digits, "_" and "-", not starting with a digit): its model will be
   * <name>.r2d.json. Default: made from the picture's file name.
   */
  name?: string;
  /** Folder to create, relative to the workspace root (default: the name). */
  dir?: string;
  /**
   * The picture: its file name (for messages and the default name) and its bytes, base64-encoded (a
   * data: URL is accepted). PNG only, at most 20 MB and 8192 px per side.
   */
  image: { name: string; base64: string };
  /**
   * What to do when the folder exists and is not empty: false (default) answers 409; true creates
   * "<dir>-2", "<dir>-3", ... instead (the answer says which).
   */
  unique?: boolean;
}

/**
 * POST /api/avatar/new: the project was created (source.png and a draft avatar.json with every
 * landmark still to place) and is open, without a model (SSE "file-changed" {file: null, avatar}).
 * Everything an "avatar-create" agent job needs: POST /api/agent/jobs {provider, kind: "avatar-create",
 * context: {project: projectPath}, images: [image.path]}.
 */
export interface AvatarNewResult extends AvatarRef {
  /** avatar.json relative to the workspace root. */
  specPath: string;
  name: string;
  image: {
    /** The illustration inside the project ("source.png"; GET /api/avatar/file?path=) and relative to the workspace root (for `images` of an agent job). */
    file: string;
    path: string;
    width: number;
    height: number;
    bytes: number;
  };
  /** mtime of the new avatar.json. */
  mtimeMs: number;
  /** Landmarks the draft still lacks ("avatar-missing-landmark" diagnostics). */
  landmarksToPlace: number;
  /** Things worth telling the person (the picture has no transparent background, the folder got another name, ...). */
  notes: string[];
}

/**
 * SSE "avatar-changed": files of the open avatar project changed on disk. origin "editor": this
 * server wrote them (PUT /api/avatar, a build job); "external": another program did (an agent, a
 * text editor). Debounced; GET /api/avatar has the new state.
 */
export interface AvatarChangedEvent {
  origin: 'editor' | 'external';
  /** Absolute project folder. */
  project: string;
  /** What changed (created, modified or deleted), relative to the project: "avatar.json", "textures/base.png", "variants/eyes_closed.png", ... */
  files: string[];
  /** mtime of avatar.json now (0 when it is missing). */
  mtimeMs: number;
}

// ----------------------------------------------------------------------------- agent bridge (in-app coding agents)
//
// The editor can start a coding agent (the Codex CLI or Claude Code) for a request, show its progress
// live and continue it with follow-up messages (docs/AGENT-BRIDGE.md; src/server/agent-routes.ts,
// src/node/agent). One job runs at a time.
//
//   GET  /api/session                       -> SessionInfo           (the token for the calls below)
//   GET  /api/agent/providers               -> AgentProviderInfo[]
//   GET  /api/agent/tasks                   -> AgentTaskInfo[]
//   GET  /api/agent/jobs                    -> AgentJobList
//   POST /api/agent/jobs  AgentStartRequest -> 202 {job: AgentJobInfo}
//   GET  /api/agent/jobs/:id?since=<seq>    -> AgentJobDetail
//   POST /api/agent/jobs/:id/cancel         -> {job: AgentJobInfo}
//   POST /api/agent/jobs/:id/message AgentMessageRequest -> 202 {job: AgentJobInfo}
//   GET  /api/agent/settings                -> AgentSettingsInfo  (effective settings + where each comes from)
//   PUT  /api/agent/settings AgentSettingsRequest -> AgentSettingsInfo (saved to ~/.rev2d/settings.json)
//   SSE event "agent-job" AgentJobEventPayload on GET /api/events
//
// Every /api/agent request needs the header "X-Rev2D-Token: <SessionInfo.token>". The endpoints exist
// only while the editor server is bound to a loopback address (or was started with --allow-agent);
// otherwise they answer 404 {error, hint, code: "agent-disabled"} and SessionInfo.agent.enabled is false.
// Errors are JSON {error, hint?, code?}: 400 invalid, 401 token-required, 403 outside the workspace root,
// 404 unknown-job, 409 busy | not-resumable | unavailable | settings-file, 413 too-large, 429 rate-limited.
//
// Settings (today: codexWindowsSandbox, which of Codex's Windows sandbox implementations a job uses)
// are never part of a job request. "error" events may carry a stable `code`; "codex-windows-sandbox"
// (also on the "stalled" status event) means Codex cannot start commands on Windows, and its hint
// names the fixes, one of which is PUT /api/agent/settings {"codexWindowsSandbox": "unelevated"}.

export type {
  AgentDoneReason,
  AgentEffort,
  AgentEvent,
  AgentEventBody,
  AgentEventType,
  AgentFileChange,
  AgentItemPhase,
  AgentItemStatus,
  AgentJobEvents,
  AgentJobInfo,
  AgentJobState,
  AgentProviderId,
  AgentProviderInfo,
  AgentSandbox,
  AgentSettingSource,
  AgentSettings,
  AgentSettingsInfo,
  AgentUsage,
  CodexWindowsSandbox,
} from './agent/types.js';

/** PUT /api/agent/settings: the user settings to save (kept in ~/.rev2d/settings.json). */
export interface AgentSettingsRequest {
  codexWindowsSandbox: CodexWindowsSandbox;
}

/** GET /api/session. */
export interface SessionInfo {
  /** Value of the X-Rev2D-Token header of /api/agent requests; null while the agent bridge is disabled. */
  token: string | null;
  agent: {
    enabled: boolean;
    /** Why the bridge is disabled (the server is not bound to a loopback address). */
    reason?: string;
  };
}

/** POST /api/agent/jobs. */
export interface AgentStartRequest {
  provider: AgentProviderId;
  /** Task template (GET /api/agent/tasks); default "freeform": `prompt` is the task. */
  kind?: string;
  /** The request in the person's words (at most 32 KiB; required by "freeform"). */
  prompt?: string;
  /**
   * Input of the task template, plus two entries the server reads itself: `project` (a folder of the
   * workspace, relative to its root: the agent's working directory; default the workspace root) and
   * `file` (the model the request is about; default the open model).
   */
  context?: Record<string, unknown>;
  /** Image files of the workspace to attach (paths relative to the root, at most 8; PNG, JPEG, WebP, GIF). */
  images?: string[];
  model?: string;
  effort?: AgentEffort;
  /** Default "workspace-write": the agent may change files inside its working directory. */
  sandbox?: AgentSandbox;
  /** Default false. True lets the agent use its built-in image generator (and only that one). */
  allowImageGeneration?: boolean;
}

/** POST /api/agent/jobs/:id/message: a follow-up in the provider session of the finished job :id. */
export interface AgentMessageRequest {
  prompt: string;
  images?: string[];
  /** Default: as in the job that is continued. */
  allowImageGeneration?: boolean;
}

/** GET /api/agent/jobs. */
export interface AgentJobList {
  /** The jobs the server remembers (the newest 20), newest first. */
  jobs: AgentJobInfo[];
  /** Id of the queued or running job, or null. */
  active: string | null;
}

/** GET /api/agent/jobs/:id?since=<seq>: the job, its request text and its events after `since`. */
export interface AgentJobDetail extends AgentJobEvents {
  job: AgentJobInfo;
  /** The request in the person's words. */
  prompt: string;
}

/** SSE event "agent-job": one event of a job, with the job as it is right after it. */
export interface AgentJobEventPayload {
  job: AgentJobInfo;
  state: AgentJobState;
  event?: AgentEvent;
}

/** GET /api/agent/tasks: a task template. */
export interface AgentTaskInfo {
  kind: string;
  title: string;
  description: string;
  /** Whether the template needs the person's own text (`prompt`). */
  needsPrompt: boolean;
}
