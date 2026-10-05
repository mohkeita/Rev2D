/**
 * Node-side file IO for format interop (the converters in src/interop are pure): reading a Spine
 * export folder (skeleton JSON + atlas + page PNGs), turning Live2D JSON files into edit ops for a
 * Rev2D model and applying them to the model file, writing converter output files, and formatting
 * conversion reports as text. Shared by the CLI (`rev2d import|export`), the MCP server
 * (rev2d_import / rev2d_export) and the editor server (POST /api/import, /api/live2d-import,
 * /api/export). See docs/INTEROP.md.
 *
 * Every failure is an InteropError with a `kind` the callers map to their own error type (CLI exit
 * codes, MCP isError results, HTTP statuses) and a surface-neutral hint.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Diagnostic, ImageRGBA, Model } from '../core/types.js';
import type { Rig } from '../core/rig.js';
import { ID_PATTERN } from '../core/schema.js';
import { formatModelJson } from '../core/format.js';
import { parseJsonc } from '../core/validate.js';
import { decodePNG } from '../render/index.js';
import { applyOps, type Op, type OpResult } from '../ops/index.js';
import {
  IDENTITY_PARAM_MAP,
  STANDARD_PARAM_MAP,
  exportLive2d,
  exportSpine,
  importLive2dExpression,
  importLive2dModel3,
  importLive2dMotion,
  importSpine,
  paramMapFromJson,
  prefixParamMap,
  spineAtlas,
  type InteropFormat,
  type InteropIssue,
  type InteropReport,
  type Live2dExportOptions,
  type OutputFile,
  type ParamMap,
  type SpineExportOptions,
} from '../interop/index.js';
import { detectInteropFile, isAtlasName, type DetectedFormat } from '../interop/detect.js';
import { isLive2dImport, replacedAnimationIssue } from '../interop/live2d/util.js';

// ----------------------------------------------------------------------------- errors

/**
 * A failed interop operation. kind: not-found (a file is missing), exists (output files exist and
 * overwriting was not allowed; `files` lists them), invalid (unreadable or unconvertible input),
 * usage (contradictory or unknown options).
 */
export class InteropError extends Error {
  constructor(
    message: string,
    readonly kind: 'not-found' | 'exists' | 'invalid' | 'usage',
    readonly hint?: string,
    readonly files: string[] = [],
    readonly diagnostics: Diagnostic[] = [],
  ) {
    super(message);
  }
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ----------------------------------------------------------------------------- reports

export function issueCounts(report: InteropReport): { warnings: number; info: number } {
  const warnings = report.issues.filter((i) => i.severity === 'warning').length;
  return { warnings, info: report.issues.length - warnings };
}

/** "2 warnings, 5 info" */
export function countsText(report: InteropReport): string {
  const { warnings, info } = issueCounts(report);
  return `${warnings} warning${warnings === 1 ? '' : 's'}, ${info} info`;
}

/** "bones 12, slots 8, animations 2" in the report's own (deterministic) order. */
export function statsText(stats: Record<string, number>): string {
  return Object.entries(stats)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
}

/** One issue on one line: "code  where: message  → hint". */
export function issueLine(issue: InteropIssue, codeWidth = 0): string {
  const where = issue.where ? `${issue.where}: ` : '';
  return `${issue.code.padEnd(codeWidth)}  ${where}${issue.message}${issue.hint ? `  → ${issue.hint}` : ''}`;
}

/**
 * The report as text lines: a counts line, the warnings, then the info issues (each group headed and
 * indented), then the stats. `max` limits the issue lines (the rest is counted in a last line).
 */
export function reportLines(report: InteropReport, opts: { indent?: string; max?: number; stats?: boolean } = {}): string[] {
  const indent = opts.indent ?? '  ';
  const lines = [`report: ${countsText(report)}`];
  const width = Math.min(32, Math.max(0, ...report.issues.map((i) => i.code.length)));
  let budget = opts.max ?? Infinity;
  let hidden = 0;
  for (const severity of ['warning', 'info'] as const) {
    const list = report.issues.filter((i) => i.severity === severity);
    if (!list.length) continue;
    if (budget <= 0) {
      hidden += list.length;
      continue;
    }
    lines.push(`${severity === 'warning' ? 'warnings' : 'info'}:`);
    for (const issue of list) {
      if (budget <= 0) {
        hidden++;
        continue;
      }
      lines.push(indent + issueLine(issue, width));
      budget--;
    }
  }
  if (hidden) lines.push(`${indent}... ${hidden} more (the JSON output lists every issue)`);
  if (opts.stats !== false && Object.keys(report.stats).length) lines.push(`stats: ${statsText(report.stats)}`);
  return lines;
}

/**
 * Several reports as one: issues in order (their `where` prefixed with the label when given), stats
 * summed per key.
 */
export function mergeReports(parts: Array<{ label?: string; report: InteropReport }>, format: InteropFormat, direction: 'import' | 'export'): InteropReport {
  const issues: InteropIssue[] = [];
  const stats: Record<string, number> = {};
  for (const { label, report } of parts) {
    for (const issue of report.issues) {
      const where = label ? (issue.where ? `${label}: ${issue.where}` : label) : issue.where;
      issues.push({ ...issue, ...(where !== undefined ? { where } : {}) });
    }
    for (const [k, v] of Object.entries(report.stats)) stats[k] = (stats[k] ?? 0) + v;
  }
  return { format, direction, issues, stats };
}

// ----------------------------------------------------------------------------- output files

export type WriteStatus = 'new' | 'replaced' | 'unchanged';

export interface WrittenFile {
  /** Absolute path. */
  path: string;
  /** Path relative to the output directory, '/'-separated. */
  rel: string;
  status: WriteStatus;
  bytes: number;
}

export function outputBytes(f: OutputFile): Uint8Array {
  return f.bytes ?? Buffer.from(f.text ?? '', 'utf8');
}

/** An output path that stays inside its directory: relative, '/'-separated, no "." / ".." segments. */
function safeRel(rel: string): string[] {
  const segments = rel.split('/');
  if (!rel || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || segments.some((s) => s === '' || s === '.' || s === '..' || s.includes('\\'))) {
    throw new InteropError(`refusing to write the output file "${rel}": output paths must be relative and stay inside the output directory`, 'invalid');
  }
  return segments;
}

/**
 * Where each output file goes and whether it is new, would be replaced (different content) or is
 * unchanged. Throws when the directory or a target path is a file / directory of the wrong kind.
 */
export async function planOutputFiles(dir: string, files: OutputFile[]): Promise<WrittenFile[]> {
  const st = await stat(dir).catch(() => null);
  if (st && !st.isDirectory()) throw new InteropError(`${dir} is a file, not a directory`, 'invalid', 'choose an output directory');
  const out: WrittenFile[] = [];
  for (const f of files) {
    const abs = path.join(dir, ...safeRel(f.path));
    const bytes = outputBytes(f);
    const cur = await stat(abs).catch(() => null);
    if (cur?.isDirectory()) throw new InteropError(`${abs} is a directory`, 'invalid', 'remove or rename it, or write into another directory');
    const existing = cur ? await readFile(abs).catch(() => null) : null;
    const status: WriteStatus = existing === null ? 'new' : Buffer.from(bytes).equals(existing) ? 'unchanged' : 'replaced';
    out.push({ path: abs, rel: f.path, status, bytes: bytes.length });
  }
  return out;
}

/**
 * Write converter output into `dir` (created when missing). Files with identical content are left
 * alone. Without `overwrite`, different existing files are an InteropError of kind "exists" naming
 * them, and nothing is written. `dryRun` plans without writing.
 */
export async function writeOutputFiles(dir: string, files: OutputFile[], opts: { overwrite: boolean; dryRun?: boolean }): Promise<WrittenFile[]> {
  const plan = await planOutputFiles(dir, files);
  const clashes = plan.filter((p) => p.status === 'replaced');
  if (clashes.length && !opts.overwrite) {
    throw new InteropError(
      `files already exist: ${clashes.map((c) => c.path).join(', ')}; nothing was written`,
      'exists',
      'allow overwriting (CLI --force, MCP overwrite: true), or write into another directory',
      clashes.map((c) => c.path),
    );
  }
  if (!opts.dryRun) {
    for (let i = 0; i < files.length; i++) {
      if (plan[i].status === 'unchanged') continue;
      try {
        await mkdir(path.dirname(plan[i].path), { recursive: true });
        await writeFile(plan[i].path, outputBytes(files[i]));
      } catch (e) {
        throw new InteropError(`cannot write ${plan[i].path}: ${errorText(e)}`, 'invalid', 'check that the directory is writable and the file is not open in another program');
      }
    }
  }
  return plan;
}

// ----------------------------------------------------------------------------- Spine import

/** Decimals of an imported model file: 1e-5 keeps atlas UVs sub-pixel exact on 4096 px pages. */
export const SPINE_MODEL_PRECISION = 5;

/** The imported model as file text. */
export function spineModelText(doc: Record<string, unknown>): string {
  return formatModelJson(doc, { precision: SPINE_MODEL_PRECISION });
}

/** "spineboy-pro" for ".../spineboy-pro.json". */
export function skeletonStem(file: string): string {
  return path.basename(file).replace(/\.(json|skel)$/i, '') || 'spine';
}

/** Atlas names tried next to a skeleton, in order ("x-pro.json" also tries "x.atlas", like the Spine samples). */
export function atlasCandidates(skeleton: string): string[] {
  const stem = skeletonStem(skeleton);
  const bases = [stem, stem.replace(/[-_.](pro|ess|ent)$/i, '')].filter((b, i, a) => b && a.indexOf(b) === i);
  return bases.flatMap((b) => [`${b}.atlas`, `${b}.atlas.txt`, `${b}-pma.atlas`, `${b}-pma.atlas.txt`]);
}

/**
 * The atlas of a skeleton export: one named after the skeleton, else the only atlas in its folder.
 * Null (with a note) when there is none; an InteropError when several could be meant.
 */
export function findSpineAtlas(skeletonAbs: string): { atlas: string | null; notes: string[] } {
  const dir = path.dirname(skeletonAbs);
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    // unreadable directory: nothing to find
  }
  const lower = new Map(names.map((n) => [n.toLowerCase(), n]));
  for (const c of atlasCandidates(skeletonAbs)) {
    const hit = lower.get(c.toLowerCase());
    if (hit && statSync(path.join(dir, hit), { throwIfNoEntry: false })?.isFile()) return { atlas: path.join(dir, hit), notes: [] };
  }
  const atlases = names.filter((n) => isAtlasName(n)).sort();
  if (atlases.length === 1) return { atlas: path.join(dir, atlases[0]), notes: [`using ${atlases[0]}, the only atlas next to the skeleton`] };
  if (atlases.length > 1) {
    throw new InteropError(
      `several atlases next to ${path.basename(skeletonAbs)} (${atlases.join(', ')}) and none is named after it`,
      'usage',
      'name the atlas explicitly (CLI --atlas <file>, MCP atlas)',
    );
  }
  return {
    atlas: null,
    notes: [
      `no atlas found next to ${path.basename(skeletonAbs)} (looked for ${atlasCandidates(skeletonAbs).slice(0, 2).join(', ')}): region and mesh attachments are imported untextured; name the atlas explicitly if it lives elsewhere`,
    ],
  };
}

export interface SpineSources {
  /** Absolute paths of the files read. */
  skeleton: string;
  atlas: string | null;
  pages: string[];
}

export interface SpineImportFileOptions {
  /** Atlas file (default: found next to the skeleton, see findSpineAtlas). */
  atlas?: string;
  skin?: string;
  scale?: number;
  padding?: number;
  /** Model name (default: the skeleton file name). */
  name?: string;
}

export interface SpineFileImport {
  doc: Record<string, unknown>;
  /** Texture files relative to the model file. */
  files: OutputFile[];
  report: InteropReport;
  sources: SpineSources;
  /** Where the atlas and pages came from, pages that could not be read. */
  notes: string[];
}

async function readText(abs: string, what: string): Promise<string> {
  try {
    const text = await readFile(abs, 'utf8');
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new InteropError(`${what} not found: ${abs}`, 'not-found', 'check the path (relative paths resolve against the working directory)');
    if (code === 'EISDIR') throw new InteropError(`${what} ${abs} is a directory`, 'invalid', 'give the path of the file');
    throw new InteropError(`cannot read ${what} ${abs}: ${errorText(e)}`, 'invalid');
  }
}

/** Decode the atlas pages next to the atlas (or the skeleton). Missing or non-PNG pages become notes. */
async function readAtlasPages(atlasText: string, atlasAbs: string, skeletonAbs: string): Promise<{ pages: Record<string, ImageRGBA>; files: string[]; notes: string[] }> {
  let pageNames: string[];
  try {
    pageNames = spineAtlas.parseAtlas(atlasText).pages.map((p) => p.name);
  } catch (e) {
    throw new InteropError(`${atlasAbs} is not a readable Spine atlas: ${errorText(e)}`, 'invalid', 'pass the .atlas file Spine wrote next to the skeleton JSON');
  }
  const pages: Record<string, ImageRGBA> = {};
  const files: string[] = [];
  const notes: string[] = [];
  for (const name of pageNames) {
    const tries = [path.resolve(path.dirname(atlasAbs), name), path.resolve(path.dirname(skeletonAbs), path.basename(name))];
    const found = tries.find((p) => statSync(p, { throwIfNoEntry: false })?.isFile());
    if (!found) {
      notes.push(`atlas page ${name} not found next to the atlas: its regions are imported untextured`);
      continue;
    }
    try {
      pages[name] = decodePNG(await readFile(found));
      files.push(found);
    } catch (e) {
      notes.push(`atlas page ${found} cannot be decoded (${errorText(e)}; only PNG pages are supported): its regions are imported untextured`);
    }
  }
  return { pages, files, notes };
}

/** Read a Spine export (skeleton JSON + atlas + pages) and convert it into a raw Rev2D model. */
export async function importSpineFile(skeletonPath: string, opts: SpineImportFileOptions = {}): Promise<SpineFileImport> {
  const skeletonAbs = path.resolve(skeletonPath);
  if (/\.skel(\.bytes)?$/i.test(skeletonAbs)) {
    throw new InteropError(`${path.basename(skeletonAbs)} is a binary skeleton; only Spine JSON exports are supported`, 'invalid', 'export the skeleton as JSON from Spine (Export > JSON), with the texture atlas');
  }
  const skeleton = await readText(skeletonAbs, 'skeleton');
  const notes: string[] = [];
  let atlasAbs: string | null = null;
  if (opts.atlas !== undefined) {
    atlasAbs = path.resolve(opts.atlas);
  } else {
    const found = findSpineAtlas(skeletonAbs);
    atlasAbs = found.atlas;
    notes.push(...found.notes);
  }
  let atlas: string | undefined;
  let pages: Record<string, ImageRGBA> = {};
  let pageFiles: string[] = [];
  if (atlasAbs) {
    atlas = await readText(atlasAbs, 'atlas');
    const read = await readAtlasPages(atlas, atlasAbs, skeletonAbs);
    pages = read.pages;
    pageFiles = read.files;
    notes.push(...read.notes);
  }
  let result;
  try {
    result = importSpine({ skeleton, atlas, pages, name: opts.name ?? skeletonStem(skeletonAbs), skin: opts.skin, scale: opts.scale, padding: opts.padding });
  } catch (e) {
    throw new InteropError(errorText(e).replace(/^importSpine: /, ''), 'invalid', 'the skeleton must be a Spine 3.8 - 4.2 JSON export');
  }
  return { doc: result.doc, files: result.files, report: result.report, sources: { skeleton: skeletonAbs, atlas: atlasAbs, pages: pageFiles }, notes };
}

// ----------------------------------------------------------------------------- exports

export interface ExportResult {
  files: WrittenFile[];
  report: InteropReport;
}

/** Rev2D model -> <dir>/<name>.json + .atlas + PNG pages. */
export async function exportSpineToDir(
  loaded: { model: Model; rig: Rig; textures: Record<string, ImageRGBA> },
  dir: string,
  opts: SpineExportOptions,
  write: { overwrite: boolean },
): Promise<ExportResult> {
  let res;
  try {
    res = exportSpine(loaded.model, loaded.rig, loaded.textures, opts);
  } catch (e) {
    throw new InteropError(errorText(e).replace(/^exportSpine: /, ''), 'usage');
  }
  return { files: await writeOutputFiles(dir, res.files, write), report: res.report };
}

/** Rev2D model -> <dir>/motions/*.motion3.json, <name>.physics3.json, <name>.cdi3.json, <name>.model3.json. */
export async function exportLive2dToDir(
  model: Model,
  dir: string,
  opts: Live2dExportOptions & { animations?: string[]; name?: string; tolerance?: number },
  write: { overwrite: boolean },
): Promise<ExportResult> {
  let res;
  try {
    res = exportLive2d(model, opts);
  } catch (e) {
    throw new InteropError(errorText(e).replace(/^exportLive2d: /, ''), 'usage');
  }
  return { files: await writeOutputFiles(dir, res.files, write), report: res.report };
}

// ----------------------------------------------------------------------------- parameter maps

export const PARAM_MAP_PRESETS = ['standard', 'none', 'prefix'] as const;

/**
 * A parameter map from a spec: "standard" (default: AngleX <-> ParamAngleX, MouthOpen <->
 * ParamMouthOpenY, ...), "none" (ids unchanged), "prefix" ("Param" + id for the model's parameters),
 * an object {"<Rev2D id>": "<Live2D id>"} merged over the standard preset, or the path of a JSON file
 * holding such an object (resolved against `baseDir`).
 */
export function paramMapFromSpec(spec: string | Record<string, string> | undefined, paramIds: string[], baseDir: string): ParamMap {
  if (spec === undefined || spec === 'standard') return STANDARD_PARAM_MAP;
  if (spec === 'none' || spec === 'identity') return IDENTITY_PARAM_MAP;
  if (spec === 'prefix') return prefixParamMap(paramIds);
  const hint = 'use "standard", "none", "prefix" or a JSON object / file {"<Rev2D id>": "<Live2D id>", ...}';
  if (typeof spec !== 'string') {
    try {
      return paramMapFromJson(spec);
    } catch (e) {
      throw new InteropError(errorText(e), 'usage', hint);
    }
  }
  const abs = path.resolve(baseDir, spec);
  let text: string;
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    throw new InteropError(`parameter map "${spec}" is neither a preset nor a readable file (${abs})`, 'usage', hint);
  }
  try {
    return paramMapFromJson(text);
  } catch (e) {
    throw new InteropError(`${abs}: ${errorText(e)}`, 'usage', hint);
  }
}

// ----------------------------------------------------------------------------- Live2D import

export type Live2dKind = 'model3' | 'motion3' | 'exp3' | 'physics3' | 'cdi3';

const LIVE2D_KINDS: Partial<Record<DetectedFormat, Live2dKind>> = {
  'live2d-model3': 'model3',
  'live2d-motion3': 'motion3',
  'live2d-exp3': 'exp3',
  'live2d-physics3': 'physics3',
  'live2d-cdi3': 'cdi3',
};

/** The Live2D kind of a file from its name, else from its (JSON) content. */
export function live2dKind(name: string, text?: string): Live2dKind | null {
  let value: unknown;
  if (text !== undefined) {
    try {
      value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    } catch {
      value = undefined;
    }
  }
  const format = detectInteropFile(name, value);
  return format ? (LIVE2D_KINDS[format] ?? null) : null;
}

/** A Live2D file to import; `name` labels it in reports and is how a model3.json refers to it. */
export interface Live2dSource {
  name: string;
  text: string;
}

export interface Live2dConvertOptions {
  paramMap?: ParamMap;
  /** Animation id of a single motion3 / exp3 file (default: its file name; expressions get "exp_"). */
  id?: string;
  physics?: 'replace' | 'merge' | 'skip';
  displayInfo?: 'fill' | 'overwrite' | 'skip';
  /** model3.json: import its motions / expressions (default true). */
  motions?: boolean;
  expressions?: boolean;
}

export interface Live2dSummary {
  /** Animations added (ids), including replaced ones. */
  animations: string[];
  /** Existing animations replaced by an imported one (the report has a live2d-animation-replaced issue for each). */
  replaced: string[];
  /** Physics groups added / removed (replaced). */
  physics: string[];
  removedPhysics: string[];
  /** Parameter / part description and group updates (display info). */
  updates: number;
}

export interface Live2dConversion {
  ops: Op[];
  /** Every source's issues (`where` starts with the file name) and summed stats. */
  report: InteropReport;
  sources: Array<{ name: string; kind: Live2dKind; report: InteropReport } | { name: string; kind: Live2dKind; via: string }>;
  summary: Live2dSummary;
}

const KIND_FORMAT: Record<Live2dKind, InteropFormat> = {
  model3: 'live2d-model3',
  motion3: 'live2d-motion3',
  exp3: 'live2d-exp3',
  physics3: 'live2d-physics3',
  cdi3: 'live2d-cdi3',
};

/** "idle" for "motions/idle.motion3.json". */
export function live2dStem(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  return base.replace(/\.(motion3|exp3|physics3|cdi3|model3)\.json$/i, '').replace(/\.json$/i, '');
}

function toId(s: string, fallback: string): string {
  let id = s.trim().replace(/[^A-Za-z0-9_-]+/g, '_');
  if (!id) id = fallback;
  if (!/^[A-Za-z_]/.test(id)) id = `_${id}`;
  return id;
}

/** Comparable form of a source name ('/' separators; case-insensitive on Windows and macOS). */
function nameKey(name: string): string {
  const n = path.normalize(name).split(path.sep).join('/');
  return process.platform === 'win32' || process.platform === 'darwin' ? n.toLowerCase() : n;
}

function summarize(ops: Op[]): Live2dSummary {
  const s: Live2dSummary = { animations: [], replaced: [], physics: [], removedPhysics: [], updates: 0 };
  const removedAnimations = new Set<string>();
  for (const op of ops as Array<Record<string, any>>) {
    if (op.op === 'remove' && op.kind === 'animation') removedAnimations.add(op.id);
    if (op.op === 'add' && op.kind === 'animation') {
      s.animations.push(op.value.id);
      if (removedAnimations.has(op.value.id)) s.replaced.push(op.value.id);
    }
    if (op.op === 'add' && op.kind === 'physics') s.physics.push(op.value.id);
    if (op.op === 'remove' && op.kind === 'physics') s.removedPhysics.push(op.id);
    if (op.op === 'update') s.updates++;
  }
  return s;
}

/** "3 animations (idle, tap, exp_f01; replaced: idle), 2 physics groups, 17 display-info updates". */
export function summaryText(s: Live2dSummary): string {
  const parts: string[] = [];
  if (s.animations.length) {
    parts.push(`${s.animations.length} animation${s.animations.length === 1 ? '' : 's'} (${s.animations.join(', ')}${s.replaced.length ? `; replaced: ${s.replaced.join(', ')}` : ''})`);
  }
  if (s.physics.length) parts.push(`${s.physics.length} physics group${s.physics.length === 1 ? '' : 's'} (${s.physics.join(', ')})`);
  if (s.removedPhysics.length) parts.push(`removed physics ${s.removedPhysics.join(', ')}`);
  if (s.updates) parts.push(`${s.updates} display-info update${s.updates === 1 ? '' : 's'}`);
  return parts.length ? parts.join(', ') : 'nothing';
}

/**
 * Convert Live2D files into edit ops for `model` (its raw JSON): a model3.json brings the motions,
 * expressions, physics and display info it lists (read through `readReferenced`, relative to the
 * model3 file); motion3 / exp3 files become animations (an existing animation with the same id is
 * replaced: reported as a warning when it was made in Rev2D, as info when an earlier Live2D import wrote
 * it), physics3 files physics groups, cdi3 files parameter / part descriptions. Files that a
 * model3.json of the batch references are imported through it only. At most one model3.json per call.
 */
export function convertLive2dSources(
  sources: Live2dSource[],
  model: Record<string, unknown>,
  readReferenced: (ref: string, model3: Live2dSource) => Live2dSource | undefined,
  opts: Live2dConvertOptions = {},
): Live2dConversion {
  if (!sources.length) throw new InteropError('no Live2D files given', 'usage', 'pass a .model3.json, .motion3.json, .exp3.json, .physics3.json or .cdi3.json file');
  const kinds = sources.map((s) => {
    const kind = live2dKind(s.name, s.text);
    if (kind) return kind;
    const format = (() => {
      try {
        return detectInteropFile(s.name, JSON.parse(s.text.charCodeAt(0) === 0xfeff ? s.text.slice(1) : s.text));
      } catch {
        return null;
      }
    })();
    const hint =
      format === 'spine'
        ? 'this is a Spine skeleton: convert it with rev2d import spine (MCP rev2d_import {format: "spine"})'
        : format === 'rev2d'
          ? 'this is a Rev2D model; Live2D imports read .model3.json, .motion3.json, .exp3.json, .physics3.json and .cdi3.json files'
          : 'Live2D JSON files end in .model3.json, .motion3.json, .exp3.json, .physics3.json or .cdi3.json (the .moc3 model binary is not supported)';
    throw new InteropError(`${s.name} is not a Live2D motion, expression, physics, display info or model3 file`, 'invalid', hint);
  });
  const model3s = sources.filter((_, i) => kinds[i] === 'model3');
  if (model3s.length > 1) throw new InteropError(`import one model3.json at a time (got ${model3s.map((s) => s.name).join(', ')})`, 'usage');
  const direct = sources.filter((_, i) => kinds[i] === 'motion3' || kinds[i] === 'exp3');
  if (opts.id !== undefined) {
    if (!ID_PATTERN.test(opts.id)) throw new InteropError(`invalid animation id "${opts.id}"`, 'usage', 'ids start with a letter or _ and contain letters, digits, _ and -');
    if (model3s.length || direct.length !== 1) {
      throw new InteropError('an explicit animation id applies to exactly one motion3 or exp3 file', 'usage', 'import the files one at a time to name each animation, or omit the id (the file name is used)');
    }
  }
  const map = opts.paramMap ?? STANDARD_PARAM_MAP;
  /** The model's animations by id -> whether an earlier Live2D import wrote them (replacing those is expected). */
  const existingAnimations = new Map<string, boolean>();
  for (const a of Array.isArray(model.animations) ? model.animations : []) {
    const id = (a as { id?: unknown } | null)?.id;
    if (typeof id === 'string') existingAnimations.set(id, isLive2dImport(a));
  }
  const ops: Op[] = [];
  const parts: Array<{ label?: string; report: InteropReport }> = [];
  const out: Live2dConversion['sources'] = [];
  const consumed = new Map<string, string>();
  const taken = new Set<string>();
  const labelAll = sources.length > 1;

  // model3 first: the files it references are imported through it.
  for (const m3 of model3s) {
    const read = (ref: string) => {
      const r = readReferenced(ref, m3);
      if (r) consumed.set(nameKey(r.name), m3.name);
      return r?.text;
    };
    let res;
    try {
      res = importLive2dModel3(m3.text, read, {
        model,
        paramMap: map,
        physics: opts.physics,
        displayInfo: opts.displayInfo,
        motions: opts.motions,
        expressions: opts.expressions,
      });
    } catch (e) {
      throw new InteropError(`${m3.name}: ${errorText(e)}`, 'invalid');
    }
    for (const op of res.ops as Array<Record<string, any>>) if (op.op === 'add' && op.kind === 'animation') taken.add(op.value.id);
    ops.push(...res.ops);
    parts.push({ label: labelAll ? m3.name : undefined, report: res.report });
    out.push({ name: m3.name, kind: 'model3', report: res.report });
  }

  sources.forEach((src, i) => {
    const kind = kinds[i];
    if (kind === 'model3') return;
    const via = consumed.get(nameKey(src.name));
    if (via) {
      out.push({ name: src.name, kind, via });
      return;
    }
    let res: { ops: Op[]; report: InteropReport };
    try {
      if (kind === 'motion3' || kind === 'exp3') {
        const base = opts.id ?? (kind === 'exp3' ? `exp_${toId(live2dStem(src.name), `expression${i + 1}`)}` : toId(live2dStem(src.name), `motion${i + 1}`));
        let id = base;
        for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
        const conv = kind === 'motion3' ? importLive2dMotion(src.text, id, { paramMap: map, model }) : importLive2dExpression(src.text, id, { paramMap: map, model });
        const extra: InteropIssue[] = [];
        if (id !== base) extra.push({ severity: 'info', code: 'live2d-id-renamed', message: `animation id "${base}" is already imported from another file: this one is "${id}"` });
        const local: Op[] = [];
        const imported = existingAnimations.get(id);
        if (imported !== undefined) {
          local.push({ op: 'remove', kind: 'animation', id });
          // A warning when the replaced animation was made in Rev2D, a note when an earlier import wrote it.
          extra.push(replacedAnimationIssue(id, imported));
        }
        local.push({ op: 'add', kind: 'animation', value: conv.animation });
        taken.add(id);
        res = { ops: local, report: { ...conv.report, issues: [...conv.report.issues, ...extra] } };
      } else {
        // physics3 / cdi3: through a one-file model3, which knows how to replace or merge physics and
        // fill or overwrite display info.
        const virtual = { Version: 3, FileReferences: kind === 'physics3' ? { Physics: src.name } : { DisplayInfo: src.name } };
        const r = importLive2dModel3(virtual, (ref) => (ref === src.name ? src.text : undefined), { model, paramMap: map, physics: opts.physics, displayInfo: opts.displayInfo });
        res = { ops: r.ops, report: { ...r.report, format: KIND_FORMAT[kind] } };
      }
    } catch (e) {
      throw new InteropError(`${src.name}: ${errorText(e)}`, 'invalid');
    }
    ops.push(...res.ops);
    // One-file model3 reports already name the file in every `where`.
    parts.push({ label: kind === 'motion3' || kind === 'exp3' ? src.name : undefined, report: res.report });
    out.push({ name: src.name, kind, report: res.report });
  });

  const format = model3s.length ? 'live2d-model3' : KIND_FORMAT[kinds[0]];
  return { ops, report: mergeReports(parts, format, 'import'), sources: out, summary: summarize(ops) };
}

/** Read a Live2D file from disk as a source named by `label` (default: the path as given). */
export async function readLive2dSource(file: string, label = file): Promise<Live2dSource> {
  return { name: label, text: await readText(path.resolve(file), 'Live2D file') };
}

/** A readReferenced for files on disk: `ref` relative to the model3 file at `model3Abs`, labelled by `label(abs)`. */
export function diskReferenceReader(model3Abs: string, label: (abs: string) => string): (ref: string) => Live2dSource | undefined {
  return (ref) => {
    const abs = path.resolve(path.dirname(model3Abs), ref);
    try {
      const text = readFileSync(abs, 'utf8');
      return { name: label(abs), text: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text };
    } catch {
      return undefined;
    }
  };
}

// ----------------------------------------------------------------------------- model files

export interface ModelFileText {
  /** Absolute path. */
  file: string;
  text: string;
  /** Parsed raw JSON (JSONC allowed). */
  doc: Record<string, unknown>;
}

/** Read and parse a model file (raw: defaults are not filled in, so edits stay minimal). */
export async function readModelDoc(file: string): Promise<ModelFileText> {
  const abs = path.resolve(file);
  const text = await readText(abs, 'model file');
  const parsed = parseJsonc(text);
  if (!parsed.ok) throw new InteropError(`${abs} is not valid JSON; fix the syntax first`, 'invalid', parsed.error.hint, [], [parsed.error]);
  if (typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
    throw new InteropError(`${abs} does not hold a model object`, 'invalid', 'a model file is a JSON object with "format": "rev2d"');
  }
  return { file: abs, text, doc: parsed.value as Record<string, unknown> };
}

export interface ModelEdit {
  /** Every op applied and the result validates. */
  ok: boolean;
  /** The result differs from the file. */
  changed: boolean;
  written: boolean;
  dryRun: boolean;
  results: OpResult[];
  diagnostics: Diagnostic[];
  /** The resulting raw model (the input when !ok). */
  doc: unknown;
}

/**
 * Apply ops to a model file read with readModelDoc: atomically (every op applies and the result
 * validates, or nothing is written), formatted, keeping the file's line endings; unchanged files are
 * not rewritten. Refuses to write when the file changed on disk since it was read.
 */
export async function applyOpsToModelFile(src: ModelFileText, ops: Op[], opts: { dryRun?: boolean } = {}): Promise<ModelEdit> {
  const dryRun = opts.dryRun ?? false;
  const res = applyOps(src.doc, ops);
  const formatted = res.ok ? formatModelJson(res.doc) : '';
  const changed = res.ok && formatted !== formatModelJson(src.doc);
  let written = false;
  if (changed && !dryRun) {
    const now = await readFile(src.file, 'utf8').catch(() => null);
    const before = now !== null && now.charCodeAt(0) === 0xfeff ? now.slice(1) : now;
    if (before !== src.text) {
      throw new InteropError(`${src.file} changed on disk while the import was converted; nothing was written`, 'invalid', 'run the import again: it applies to the current file');
    }
    const crlf = /\r?\n/.exec(src.text)?.[0] === '\r\n';
    try {
      await writeFile(src.file, crlf ? formatted.replace(/\n/g, '\r\n') : formatted);
    } catch (e) {
      throw new InteropError(`cannot write ${src.file}: ${errorText(e)}`, 'invalid', 'check that the file is writable and not locked by another program');
    }
    written = true;
  }
  return { ok: res.ok, changed, written, dryRun, results: res.results, diagnostics: res.diagnostics, doc: res.doc };
}

// ----------------------------------------------------------------------------- uploads (editor server)

export interface UploadedFile {
  name: string;
  bytes: Uint8Array;
}

/**
 * A Spine export sent as files (skeleton JSON text, atlas files, PNG pages; e.g. picked in the
 * editor) converted into a raw Rev2D model. The atlas is the only one sent, else the one named after
 * the skeleton; pages are matched to the atlas pages by file name.
 */
export function importSpineUpload(
  skeleton: { name: string; text: string },
  atlases: Array<{ name: string; text: string }>,
  images: UploadedFile[],
  opts: { name?: string } = {},
): { doc: Record<string, unknown>; files: OutputFile[]; report: InteropReport; atlas: string | null; pages: string[]; notes: string[] } {
  const notes: string[] = [];
  const base = (n: string) => n.split('/').pop()!.toLowerCase();
  let atlas = atlases.length === 1 ? atlases[0] : undefined;
  if (atlases.length > 1) {
    const wanted = atlasCandidates(skeleton.name).map((c) => c.toLowerCase());
    atlas = atlases.find((a) => wanted.includes(base(a.name)));
    if (!atlas) {
      throw new InteropError(
        `several atlases (${atlases.map((a) => a.name).join(', ')}) and none is named after ${skeleton.name}`,
        'usage',
        'import the skeleton with its own atlas only',
      );
    }
    notes.push(`used ${atlas.name}; skipped ${atlases.filter((a) => a !== atlas).map((a) => a.name).join(', ')}`);
  }
  const pages: Record<string, ImageRGBA> = {};
  const used: string[] = [];
  if (atlas) {
    let pageNames: string[];
    try {
      pageNames = spineAtlas.parseAtlas(atlas.text).pages.map((p) => p.name);
    } catch (e) {
      throw new InteropError(`${atlas.name} is not a readable Spine atlas: ${errorText(e)}`, 'invalid', 'import the .atlas file Spine wrote next to the skeleton JSON');
    }
    for (const page of pageNames) {
      const img = images.find((i) => base(i.name) === base(page));
      if (!img) {
        notes.push(`atlas page ${page} was not imported: its regions are untextured (import the page PNG together with the skeleton)`);
        continue;
      }
      try {
        pages[page] = decodePNG(img.bytes);
        used.push(img.name);
      } catch (e) {
        notes.push(`atlas page ${img.name} cannot be decoded (${errorText(e)}): its regions are untextured`);
      }
    }
  } else {
    notes.push(`no atlas (.atlas or .atlas.txt) was imported with ${skeleton.name}: attachments are imported untextured; import the atlas and its PNG pages together with the skeleton`);
  }
  const unused = images.filter((i) => !used.includes(i.name)).map((i) => i.name);
  if (unused.length) notes.push(`not atlas pages, skipped: ${unused.join(', ')}`);
  let result;
  try {
    result = importSpine({ skeleton: skeleton.text, atlas: atlas?.text, pages, name: opts.name ?? skeletonStem(skeleton.name) });
  } catch (e) {
    throw new InteropError(`${skeleton.name}: ${errorText(e).replace(/^importSpine: /, '')}`, 'invalid', 'the skeleton must be a Spine 3.8 - 4.2 JSON export');
  }
  return { doc: result.doc, files: result.files, report: result.report, atlas: atlas?.name ?? null, pages: used, notes };
}

// ----------------------------------------------------------------------------- editor protocol

/**
 * POST /api/live2d-import: convert Live2D JSON files into the open model. Nothing is written: the
 * answer holds the resulting raw model, which the editor writes with PUT /api/model {doc, baseMtimeMs}
 * (so the import is one undoable edit and conflicts are detected as for any edit).
 */
export interface Live2dImportRequest {
  /** .model3 / .motion3 / .exp3 / .physics3 / .cdi3 .json files (UTF-8 text). A model3.json finds the files it lists among them by path or file name. */
  files: Array<{ name: string; text: string }>;
  /** The model to import into (the editor's raw document); default: the open model file as on disk. */
  doc?: unknown;
  /** "standard" (default), "none", "prefix" or {"<Rev2D id>": "<Live2D id>"}. */
  paramMap?: string | Record<string, string>;
  id?: string;
  physics?: 'replace' | 'merge' | 'skip';
  displayInfo?: 'fill' | 'overwrite' | 'skip';
  motions?: boolean;
  expressions?: boolean;
}

export interface Live2dImportResponse {
  /** Every op applied and the result validates. */
  ok: boolean;
  /** Whether the result differs from the input. */
  changed: boolean;
  /** The resulting raw model (the input when !ok). */
  doc: unknown;
  results: OpResult[];
  diagnostics: Diagnostic[];
  report: InteropReport;
  summary: Live2dSummary;
  sources: Array<{ file: string; kind: Live2dKind; via?: string }>;
}

/** POST /api/export: export the open model into a folder of the workspace. */
export interface ExportRequest {
  format: 'spine' | 'live2d';
  /** Output folder, relative to the workspace root (default "exports/<model file name>-spine" or "-live2d"). */
  dir?: string;
  /** The model to export (the editor's raw document, unsaved edits included); default: the open model file. */
  doc?: unknown;
  /** Replace different existing files (default false: 409 naming them). */
  overwrite?: boolean;
  animations?: string[];
  fps?: number;
  name?: string;
  tolerance?: number;
  /** Spine only. */
  textureScale?: number;
  paramPoses?: boolean;
  premultipliedAlpha?: boolean;
  /** Live2D only: "standard" (default), "none", "prefix" or {"<Rev2D id>": "<Live2D id>"}. */
  paramMap?: string | Record<string, string>;
}

export interface ExportResponse {
  /** Absolute output folder. */
  dir: string;
  files: Array<{ path: string; status: WriteStatus; bytes: number }>;
  report: InteropReport;
  notes: string[];
}
