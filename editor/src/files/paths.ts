/**
 * Pure path and file-list helpers for the File menu, the file dialogs and the start screen.
 *
 * Paths come in two shapes (see the workspace contract in src/node/editor-registry.ts): ABSOLUTE
 * paths as the server's OS writes them (Windows "C:\a\b" or POSIX "/a/b"), and ROOT-RELATIVE paths,
 * always '/'-separated, '' being the workspace root itself. Nothing here touches the DOM or the network;
 * the few words these helpers produce (name problems, relative times) come from the i18n dictionary.
 */
import type { FileEntry } from '../../../src/node/editor-registry.js';
import { t } from '../i18n/index.js';

/** The extension new model files get. */
export const MODEL_EXT = '.r2d.json';

/** Forward slashes, no trailing separator (except for a bare root like "/" or "C:/"). */
export function normalizeSlashes(p: string): string {
  const s = p.replace(/\\/g, '/');
  if (s === '/' || /^[a-zA-Z]:\/$/.test(s)) return s;
  return s.replace(/\/+$/, '');
}

/** Windows paths (drive letter or UNC) compare case-insensitively. */
function isWindowsPath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('//');
}

/**
 * Path of `abs` relative to `root` ('/'-separated, '' for the root itself), or null when `abs` lies
 * outside the root. Handles either separator and Windows' case-insensitive drive paths.
 */
export function relativeToRoot(abs: string, root: string): string | null {
  const a = normalizeSlashes(abs);
  const r = normalizeSlashes(root);
  const fold = isWindowsPath(abs) || isWindowsPath(root);
  const ca = fold ? a.toLowerCase() : a;
  const cr = fold ? r.toLowerCase() : r;
  if (ca === cr) return '';
  const prefix = cr.endsWith('/') ? cr : `${cr}/`;
  if (!ca.startsWith(prefix)) return null;
  return a.slice(prefix.length);
}

/** Same file, whatever the separators (and case, for Windows paths). */
export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const na = normalizeSlashes(a);
  const nb = normalizeSlashes(b);
  return isWindowsPath(a) || isWindowsPath(b) ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/** Last segment of a path (either separator). */
export function baseName(p: string): string {
  const s = normalizeSlashes(p);
  return s.slice(s.lastIndexOf('/') + 1) || s;
}

/** Directory part of a root-relative path ('' at the root). */
export function dirOf(rel: string): string {
  const s = normalizeSlashes(rel);
  const i = s.lastIndexOf('/');
  return i < 0 ? '' : s.slice(0, i);
}

/** Parent of a root-relative directory, or null at the root. */
export function parentDir(dir: string): string | null {
  if (!dir) return null;
  return dirOf(dir);
}

/** Join a root-relative directory and a (possibly nested, '/'-separated) name. */
export function joinPath(dir: string, name: string): string {
  const n = normalizeSlashes(name).replace(/^\/+/, '');
  return dir ? `${normalizeSlashes(dir)}/${n}` : n;
}

export interface Crumb {
  label: string;
  /** Root-relative directory the crumb navigates to. */
  path: string;
}

/** Breadcrumbs from the root to `dir`: [{root}, {a}, {a/b}, ...]. */
export function breadcrumbs(dir: string, rootLabel: string): Crumb[] {
  const out: Crumb[] = [{ label: rootLabel, path: '' }];
  let acc = '';
  for (const seg of normalizeSlashes(dir).split('/').filter(Boolean)) {
    acc = acc ? `${acc}/${seg}` : seg;
    out.push({ label: seg, path: acc });
  }
  return out;
}

/** Display name of the workspace root: its last folder name. */
export function rootLabel(root: string | null | undefined): string {
  if (!root) return t('files.paths.workspace');
  const s = normalizeSlashes(root);
  return s.slice(s.lastIndexOf('/') + 1) || s;
}

// ----------------------------------------------------------------------------- file names

/** Characters Windows refuses in file names (checked everywhere so models stay portable). */
const BAD_CHARS = /[<>:"|?*\u0000-\u001f]/;
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** Lower-case, dash-separated file stem from a display name ("My Hero!" -> "my-hero"). */
export function slugify(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    // Back to the composed form: NFKD splits Hangul syllables into jamo, which is another file name.
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^a-z0-9\u00c0-\uffff]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s.slice(0, 64) || 'untitled';
}

/** A model file name for what the user typed: "hero" -> "hero.r2d.json", "hero.r2d" -> "hero.r2d.json". */
export function modelFileName(input: string): string {
  const s = input.trim();
  if (!s) return '';
  if (/\.json$/i.test(s)) return s;
  if (/\.r2d$/i.test(s)) return `${s}.json`;
  return `${s}${MODEL_EXT}`;
}

/**
 * Why a (possibly nested, '/'-separated) file name cannot be used, or null when it is fine. Nested
 * names ("poses/idle.r2d.json") are allowed; they stay inside the chosen folder.
 */
export function fileNameProblem(name: string): string | null {
  const s = name.trim();
  if (!s) return t('files.name.empty');
  if (s.includes('\\')) return t('files.name.backslash');
  if (s.startsWith('/')) return t('files.name.absolute');
  const segments = s.split('/');
  for (const seg of segments) {
    if (!seg) return t('files.name.emptySegment');
    if (seg === '.' || seg === '..') return t('files.name.dots');
    if (BAD_CHARS.test(seg)) return t('files.name.badChars');
    if (RESERVED.test(seg)) return t('files.name.reserved', { name: seg });
    if (/[. ]$/.test(seg)) return t('files.name.trailing');
  }
  if (!/\.json$/i.test(s)) return t('files.name.extension');
  return null;
}

/** `name` or, if taken, "stem-2.r2d.json", "stem-3.r2d.json", ... (case-insensitive check). */
export function uniqueFileName(name: string, taken: Iterable<string>): string {
  const lower = new Set([...taken].map((t) => t.toLowerCase()));
  if (!lower.has(name.toLowerCase())) return name;
  const m = /^(.*?)((?:\.r2d)?\.json)$/i.exec(name);
  const stem = m ? m[1] : name;
  const ext = m ? m[2] : '';
  for (let i = 2; i < 1000; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
  return name;
}

/** Suggested "Save As" name for the current file: "hero.r2d.json" -> "hero-copy.r2d.json". */
export function copyName(file: string): string {
  const base = baseName(file);
  const m = /^(.*?)((?:\.r2d)?\.json)$/i.exec(base);
  return m ? `${m[1]}-copy${m[2]}` : `${base}-copy${MODEL_EXT}`;
}

// ----------------------------------------------------------------------------- listings

/** Locale-independent name order (the server's compareNames). */
export function compareNames(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la !== lb) return la < lb ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Listing order: folders, model files (*.r2d.json), other JSON files (may be models). */
const TYPE_ORDER: Record<FileEntry['type'], number> = { dir: 0, model: 1, other: 2, image: 3 };

/** Entries a dialog can open: models, and other .json files (they may be models too). */
export function isOpenable(e: FileEntry): boolean {
  return e.type === 'model' || (e.type === 'other' && /\.jsonc?$/i.test(e.name));
}

/**
 * The entries a dialog shows: folders, then model files, then other JSON files (each by name). PNGs
 * are hidden; `query` filters by name (case-insensitive substring).
 */
export function visibleEntries(entries: readonly FileEntry[], query = ''): FileEntry[] {
  const q = query.trim().toLowerCase();
  return entries
    .filter((e) => e.type === 'dir' || isOpenable(e))
    .filter((e) => !q || e.name.toLowerCase().includes(q))
    .sort((a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || compareNames(a.name, b.name));
}

/** Next highlighted row for a navigation key, or null when the key does not move it. */
export function moveHighlight(index: number, key: string, count: number, page = 8): number | null {
  if (count <= 0) return null;
  const clamp = (i: number) => Math.max(0, Math.min(count - 1, i));
  switch (key) {
    case 'ArrowDown':
      return index < 0 ? 0 : clamp(index + 1);
    case 'ArrowUp':
      return index < 0 ? count - 1 : clamp(index - 1);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    case 'PageDown':
      return clamp((index < 0 ? 0 : index) + page);
    case 'PageUp':
      return clamp((index < 0 ? 0 : index) - page);
    default:
      return null;
  }
}

// ----------------------------------------------------------------------------- formatting

/** "812 B", "12.3 KB", "4.1 MB". */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** "just now", "5 min ago", "3 h ago", "yesterday 14:03", "2026-09-20 14:03" (local time). */
export function formatWhen(mtimeMs: number, now: number = Date.now()): string {
  if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) return '';
  const diff = now - mtimeMs;
  if (diff < 45_000 && diff > -60_000) return t('files.when.now');
  if (diff > 0 && diff < 3_600_000) return t('files.when.minutes', { n: Math.max(1, Math.round(diff / 60_000)) });
  const d = new Date(mtimeMs);
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (mtimeMs >= startOfToday && diff > 0) return diff < 6 * 3_600_000 ? t('files.when.hours', { n: Math.round(diff / 3_600_000) }) : t('files.when.today', { time });
  if (mtimeMs >= startOfToday - 86_400_000 && mtimeMs < startOfToday) return t('files.when.yesterday', { time });
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${time}`;
}
