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
   * that received "file-changed", origin "ai"), or the errors of POST /api/open.
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
   */
  recent: string[];
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
}

export interface TemplateInfo {
  name: string;
  description: string;
}
