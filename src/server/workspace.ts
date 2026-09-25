/**
 * The editor server's workspace: the root directory that every file-management request is confined
 * to, directory listings, the recently-opened list (~/.rev2d/recent.json), template descriptions and
 * the texture-path rewrite of "save as".
 *
 * Confinement is checked on real paths: a request path (absolute, or relative to the root) is
 * resolved, symbolic links / junctions are followed (for a path that does not exist yet: those of its
 * nearest existing ancestor), and the result must be the root or lie inside it. So neither ".." nor
 * a link pointing elsewhere can reach a file outside the root.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FileEntry, FileListing, TemplateInfo } from '../node/editor-registry.js';
import { compareNames, listTemplates, loadTemplate } from '../api/templates.js';
import { HttpError } from './http.js';

const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';
const fold = (p: string) => (CASE_INSENSITIVE ? p.toLowerCase() : p);

/** Whether absolute path `p` is `dir` itself or lies inside it (case-folded where the file system is). */
export function within(dir: string, p: string): boolean {
  const rel = path.relative(fold(dir), fold(p));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** Whether two paths name the same file (resolved, case-folded where the file system is). */
export function samePath(a: string, b: string): boolean {
  return fold(path.resolve(a)) === fold(path.resolve(b));
}

/** Model files are conventionally named *.r2d.json (JSONC: *.r2d.jsonc). */
export const MODEL_NAME = /\.r2d\.jsonc?$/i;
const JSON_NAME = /\.jsonc?$/i;
const PNG_NAME = /\.png$/i;

/** `file` with ".r2d.json" appended when it has no .json/.jsonc extension (a bare name typed in a dialog). */
export function withModelExtension(file: string): { file: string; appended: boolean } {
  return JSON_NAME.test(file) ? { file, appended: false } : { file: `${file}.r2d.json`, appended: true };
}

/** Characters no portable file name may contain (Windows rules; "/" separates segments). */
const BAD_NAME_CHARS = /[<>:"|?*\\\u0000-\u001f]/;
/** Windows device names, which name the device in every directory ("nul.r2d.json" too). */
const DEVICE_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

export const NAME_HINT =
  'use letters, digits, spaces, "-", "_" and "."; no \\ / : * ? " < > | or control characters, no trailing dot or space, and no device names such as CON or NUL';

/** Throws 400 unless `name` is a portable single file or directory name. */
export function checkNameSegment(name: string, what: string): void {
  if (!name || name === '.' || name === '..' || BAD_NAME_CHARS.test(name) || /[. ]$/.test(name) || DEVICE_NAME.test(name)) {
    throw new HttpError(400, `invalid file name ${JSON.stringify(name)} in ${what}`, NAME_HINT);
  }
}

const ROOT_HINT = (root: string) =>
  `paths are relative to the workspace root ${root} (absolute paths must lie inside it); to work on files elsewhere, restart the editor with --root <dir>`;

export class WorkspaceRoot {
  private constructor(
    /** Absolute root directory as given (used for display and relative paths). */
    readonly dir: string,
    /** The root with every link resolved (used for containment checks). */
    private readonly real: string,
  ) {}

  /** Open an existing directory as the workspace root (throws a descriptive Error otherwise). */
  static async open(dir: string): Promise<WorkspaceRoot> {
    const abs = path.resolve(dir);
    const st = await stat(abs).catch(() => null);
    if (!st) throw new Error(`workspace root not found: ${abs}`);
    if (!st.isDirectory()) throw new Error(`workspace root ${abs} is not a directory`);
    return new WorkspaceRoot(abs, await realpath(abs));
  }

  /** Root-relative, '/'-separated form of an absolute path inside the root ('' = the root). */
  rel(abs: string): string {
    return path.relative(this.dir, abs).split(path.sep).join('/');
  }

  /** Whether an existing absolute path lies inside the root once links are resolved (never throws). */
  containsSync(abs: string): boolean {
    try {
      return within(this.real, realpathSync.native(abs));
    } catch {
      return false;
    }
  }

  /**
   * Absolute path of a request path (absolute, or relative to the root). 400 for a path that is not
   * a string or contains NUL; 403 when it resolves outside the root, directly or through a link.
   * Paths inside the root are returned as spelled under `dir` (an absolute path given in another
   * spelling of the root, e.g. its real path, is mapped back onto it).
   */
  async resolve(p: unknown, field = 'file'): Promise<string> {
    if (typeof p !== 'string') throw new HttpError(400, `"${field}" must be a string path`, ROOT_HINT(this.dir));
    if (p.includes('\0')) throw new HttpError(400, `"${field}" contains a NUL character`, ROOT_HINT(this.dir));
    const abs = path.resolve(this.dir, p);
    const real = await this.realOf(abs, p, field);
    if (!within(this.real, real)) {
      const via = within(this.dir, abs) ? ` (through a symbolic link, to ${real})` : '';
      throw new HttpError(403, `${field} ${JSON.stringify(p)} is outside the workspace root ${this.dir}${via}`, ROOT_HINT(this.dir));
    }
    return within(this.dir, abs) ? abs : path.join(this.dir, path.relative(this.real, real));
  }

  /**
   * As resolve, for a path about to be created: the segments that do not exist yet must be portable
   * file names (400 otherwise), so a write never lands on a device name or an alternate data stream.
   */
  async resolveNew(p: unknown, field = 'file'): Promise<string> {
    const abs = await this.resolve(p, field);
    let existing = abs;
    while (!(await exists(existing))) {
      const parent = path.dirname(existing);
      if (parent === existing) break;
      checkNameSegment(path.basename(existing), `"${field}"`);
      existing = parent;
    }
    return abs;
  }

  /** Real path of `abs`, or of its nearest existing ancestor joined with the missing rest. */
  private async realOf(abs: string, p: string, field: string): Promise<string> {
    const rest: string[] = [];
    let cur = abs;
    for (;;) {
      try {
        return path.join(await realpath(cur), ...rest);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') throw new HttpError(400, `cannot resolve ${field} ${JSON.stringify(p)}: ${(e as Error).message}`);
        // A link whose target is missing: writing through it would create a file wherever it points.
        if (await lstat(cur).then((s) => s.isSymbolicLink(), () => false)) {
          throw new HttpError(403, `${field} ${JSON.stringify(p)} goes through a broken symbolic link (${cur})`, ROOT_HINT(this.dir));
        }
        const parent = path.dirname(cur);
        if (parent === cur) return abs;
        rest.unshift(path.basename(cur));
        cur = parent;
      }
    }
  }
}

async function exists(p: string): Promise<boolean> {
  return lstat(p).then(
    () => true,
    () => false,
  );
}

// ----------------------------------------------------------------------------- listings

function entryType(name: string, isDir: boolean): FileEntry['type'] | null {
  if (isDir) return 'dir';
  if (MODEL_NAME.test(name)) return 'model';
  if (PNG_NAME.test(name)) return 'image';
  if (JSON_NAME.test(name)) return 'other';
  return null;
}

/**
 * One directory of the workspace: subdirectories, model files (*.r2d.json), PNG images and other
 * JSON files (models not named by the convention), directories first, then by name. Hidden entries
 * (".name") and links leading outside the root are left out.
 */
export async function listDirectory(root: WorkspaceRoot, dirParam: string): Promise<FileListing> {
  const abs = await root.resolve(dirParam, 'dir');
  const rel = root.rel(abs);
  const st = await stat(abs).catch(() => null);
  if (!st) throw new HttpError(404, `directory not found: ${rel || '.'}`, 'GET /api/files (without dir) lists the workspace root');
  if (!st.isDirectory()) throw new HttpError(400, `${rel} is a file, not a directory`, `list its directory: GET /api/files?dir=${encodeURIComponent(path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel))}`);
  const dirents = await readdir(abs, { withFileTypes: true }).catch((e: Error) => {
    throw new HttpError(500, `cannot list ${rel || '.'}: ${e.message}`);
  });
  const entries: FileEntry[] = [];
  for (const d of dirents) {
    if (d.name.startsWith('.')) continue;
    const full = path.join(abs, d.name);
    if (d.isSymbolicLink() && !root.containsSync(full)) continue;
    const s = await stat(full).catch(() => null);
    if (!s) continue; // broken link, or removed meanwhile
    const type = entryType(d.name, s.isDirectory());
    if (!type) continue;
    entries.push({ name: d.name, path: root.rel(full), type, size: type === 'dir' ? 0 : s.size, mtimeMs: s.mtimeMs });
  }
  entries.sort((a, b) => (a.type === 'dir') !== (b.type === 'dir') ? (a.type === 'dir' ? -1 : 1) : compareNames(a.name, b.name));
  const parent = rel === '' ? null : path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel);
  return { dir: rel, parent, entries };
}

// ----------------------------------------------------------------------------- recent files

export const MAX_RECENT = 10;

/** Default location of the recently-opened list. */
export function defaultRecentFile(): string {
  return path.join(os.homedir(), '.rev2d', 'recent.json');
}

function isFile(p: string): boolean {
  return statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;
}

/**
 * Recently opened model files, newest first: at most MAX_RECENT that still exist. Kept in a JSON
 * file shared by every editor server (`{"files": [absolute paths]}`), or in memory only when no
 * file is given. Failures to write it are logged, never fatal.
 */
export class RecentFiles {
  private memory: string[] = [];

  constructor(
    readonly file: string | null,
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  list(): string[] {
    return this.stored().filter(isFile).slice(0, MAX_RECENT);
  }

  add(model: string): void {
    const abs = path.resolve(model);
    const next = [abs, ...this.stored().filter((f) => !samePath(f, abs))].filter(isFile).slice(0, MAX_RECENT);
    if (!this.file) {
      this.memory = next;
      return;
    }
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ files: next }, null, 2) + '\n');
      renameSync(tmp, this.file);
    } catch (e) {
      this.log(`cannot update the recent-files list ${this.file}: ${(e as Error).message}`);
    }
  }

  private stored(): string[] {
    if (!this.file) return this.memory;
    if (!existsSync(this.file)) return [];
    try {
      const files = (JSON.parse(readFileSync(this.file, 'utf8')) as { files?: unknown }).files;
      return Array.isArray(files) ? files.filter((f): f is string => typeof f === 'string' && path.isAbsolute(f)) : [];
    } catch {
      return []; // unreadable or corrupt: start over
    }
  }
}

// ----------------------------------------------------------------------------- templates

const BUILTIN_DESCRIPTIONS: Record<string, string> = {
  blank: 'A small complete rig to start from: two parameters (Lean, Squash) driving a warp and a bone, a body and an eye, an idle animation. Canvas size selectable (default 512x512).',
  empty: 'Nothing but format, version and meta: build every parameter, bone and part yourself. Canvas size selectable (default 512x512).',
};

/** Every template of GET /api/templates, in `rev2d new` order ("blank" and "empty" first). */
export function templateInfos(): TemplateInfo[] {
  return listTemplates().map((name) => {
    if (BUILTIN_DESCRIPTIONS[name]) return { name, description: BUILTIN_DESCRIPTIONS[name] };
    try {
      const { doc, textureFiles } = loadTemplate(name);
      const meta = doc.meta as { width?: number; height?: number; description?: string };
      const textures = textureFiles.length ? `, ${textureFiles.length} PNG texture${textureFiles.length === 1 ? '' : 's'} copied next to the model` : '';
      return { name, description: `${meta.description ?? 'Example model.'} (example, ${meta.width}x${meta.height}${textures})` };
    } catch (e) {
      return { name, description: `(cannot be loaded: ${(e as Error).message})` };
    }
  });
}

// ----------------------------------------------------------------------------- save as

/**
 * Point the relative texture paths of a parsed model at the same files from `toDir` (the model
 * moves from `fromDir`). Mutates `doc`; returns whether anything changed and a note per rewrite.
 * data: URIs and absolute paths stay as they are.
 */
export function rewriteTexturePaths(doc: unknown, fromDir: string, toDir: string): { changed: boolean; notes: string[] } {
  const notes: string[] = [];
  const textures = (doc as { textures?: unknown } | null)?.textures;
  if (samePath(fromDir, toDir) || !Array.isArray(textures)) return { changed: false, notes };
  let changed = false;
  for (const t of textures) {
    if (!t || typeof t !== 'object') continue;
    const tex = t as { id?: unknown; path?: unknown };
    if (typeof tex.path !== 'string' || tex.path.startsWith('data:') || path.isAbsolute(tex.path) || !tex.path) continue;
    const target = path.resolve(fromDir, tex.path);
    const rel = path.relative(toDir, target);
    const next = path.isAbsolute(rel) ? target.split(path.sep).join('/') : rel.split(path.sep).join('/');
    const id = typeof tex.id === 'string' ? tex.id : '?';
    if (next !== tex.path) {
      notes.push(`texture "${id}": path "${tex.path}" rewritten to "${next}" so it still points at the same file`);
      tex.path = next;
      changed = true;
    }
    if (!existsSync(target)) notes.push(`texture "${id}": ${target} does not exist`);
  }
  return { changed, notes };
}
