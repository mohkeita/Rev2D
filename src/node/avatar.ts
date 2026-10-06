/**
 * Node-side IO of avatar projects (src/avatar is pure): creating a project folder from an
 * illustration, loading one, importing a Mesh Avatar Studio project, the files of the agent tools,
 * building a project (buildAvatarProject: layer images, layers.json and the model) and rendering
 * its review sheets (reviewAvatarProject). Layout of a project folder (src/avatar/DESIGN.md §1):
 *
 *   <project>/avatar.json         the spec (source of truth)
 *   <project>/source.png          the illustration (never modified)
 *   <project>/<name>.r2d.json     BUILT model
 *   <project>/textures/           BUILT layer images + layers.json
 *   <project>/variants/           drawn variants: <variantId>.png
 *   <project>/variant-requests/   masks and prompts for an image generator
 *   <project>/review/             pose sheets
 *   <project>/work/               scratch images of the agent (grids, overlays)
 *
 * Everything written here goes through projectFile(), which refuses paths that leave the project
 * directory. User images stay local: nothing in this module talks to a network.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Diagnostic, ImageRGBA } from '../core/types.js';
import { formatModelJson } from '../core/format.js';
import { ID_PATTERN } from '../core/schema.js';
import { parseJsonc, validateModel } from '../core/validate.js';
import { composeSheet, decodePNG, encodePNG, type SheetCell } from '../render/index.js';
import { renderFrame, type ViewBox } from '../api/frame.js';
import { buildSheet, parseSweep } from '../api/sheet.js';
import { applyOps, type Op } from '../ops/index.js';
import { VARIANT_IDS, type AvatarPose, type AvatarReport, type AvatarSpec, type LayersMeta } from '../avatar/types.js';
import { avatarSpecName, draftAvatarSpec, parseAvatarSpec } from '../avatar/spec.js';
import { layerInputsHash } from '../avatar/hash.js';
import { importMasRig, MasImportError } from '../avatar/mas.js';
import { buildLayers } from '../avatar/layers.js';
import { compileModel, ROOT_WARP } from '../avatar/compile.js';
import { reviewPoses } from '../avatar/poses.js';
import { findFolds, foldIssues, type FoldFinding } from '../avatar/folds.js';
import { mergeReports } from '../avatar/features/report.js';
import { carrySprites } from '../avatar/variants-sprites.js';
import type { VisionCheck, VisionCheckKey } from '../avatar/tools/vision-check.js';
import { loadModelFile } from './load.js';

export const AVATAR_SPEC_FILE = 'avatar.json';
export const AVATAR_SOURCE_FILE = 'source.png';
export const AVATAR_LAYERS_FILE = 'textures/layers.json';
export const VISION_CHECK_IMAGE = 'vision-check.png';
export const VISION_CHECK_KEY = 'vision-check.key.json';

/** A failed project operation: what went wrong and how to fix it. */
export class AvatarProjectError extends Error {
  readonly hint?: string;
  /** "exists": refused to overwrite; "not-found": a file or folder is missing; "invalid": unusable content; "outside": a path leaves the project. */
  readonly kind: 'exists' | 'not-found' | 'invalid' | 'outside';
  readonly diagnostics: Diagnostic[];
  constructor(kind: AvatarProjectError['kind'], message: string, hint?: string, diagnostics: Diagnostic[] = []) {
    super(message);
    this.name = 'AvatarProjectError';
    this.kind = kind;
    this.hint = hint;
    this.diagnostics = diagnostics;
  }
}

// ----------------------------------------------------------------------------- paths

export interface AvatarProjectPaths {
  /** The project directory (absolute). */
  dir: string;
  /** avatar.json */
  spec: string;
  /** textures/ and textures/layers.json (built). */
  textures: string;
  layers: string;
  variants: string;
  variantRequests: string;
  review: string;
  work: string;
}

export function avatarProjectPaths(dir: string): AvatarProjectPaths {
  const root = path.resolve(dir);
  return {
    dir: root,
    spec: path.join(root, AVATAR_SPEC_FILE),
    textures: path.join(root, 'textures'),
    layers: path.join(root, ...AVATAR_LAYERS_FILE.split('/')),
    variants: path.join(root, 'variants'),
    variantRequests: path.join(root, 'variant-requests'),
    review: path.join(root, 'review'),
    work: path.join(root, 'work'),
  };
}

/** The built model of a project: <dir>/<name>.r2d.json. */
export function avatarModelFile(dir: string, name: string): string {
  return path.join(path.resolve(dir), `${name}.r2d.json`);
}

/**
 * Absolute path of a file inside a project, given relative to it ("textures/base.png"). Throws
 * AvatarProjectError("outside") for absolute paths and paths that climb out of the project.
 */
export function projectFile(dir: string, relative: string): string {
  const root = path.resolve(dir);
  const abs = path.resolve(root, relative);
  const rel = path.relative(root, abs);
  if (path.isAbsolute(relative) || rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new AvatarProjectError('outside', `"${relative}" is not a file inside the project folder`, 'paths in an avatar project are relative to its folder and stay inside it, e.g. "source.png" or "textures/base.png"');
  }
  return abs;
}

/** Write a file inside the project (parent folders are created). Returns its absolute path. */
export async function writeProjectFile(dir: string, relative: string, data: string | Uint8Array): Promise<string> {
  const abs = projectFile(dir, relative);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, data);
  return abs;
}

/** The project directory for a path that names it or its avatar.json. */
export function avatarProjectDir(target: string): string {
  const abs = path.resolve(target);
  return path.basename(abs).toLowerCase() === AVATAR_SPEC_FILE && !statSync(abs, { throwIfNoEntry: false })?.isDirectory() ? path.dirname(abs) : abs;
}

/** True when the directory holds an avatar.json. */
export function isAvatarProject(dir: string): boolean {
  return statSync(path.join(path.resolve(dir), AVATAR_SPEC_FILE), { throwIfNoEntry: false })?.isFile() ?? false;
}

// ----------------------------------------------------------------------------- images

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The image format named by a file's first bytes, for the "not a PNG" message; null when unknown. */
function sniffFormat(bytes: Uint8Array): string | null {
  const ascii = (from: number, text: string) => [...text].every((ch, i) => bytes[from + i] === ch.charCodeAt(0));
  if (PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return 'PNG';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'JPEG';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'WebP';
  if (ascii(0, 'GIF8')) return 'GIF';
  if (ascii(0, 'BM')) return 'BMP';
  if (ascii(4, 'ftyp')) return 'AVIF / HEIC';
  if (ascii(0, '8BPS')) return 'Photoshop (PSD)';
  if (ascii(0, '<svg') || ascii(0, '<?xml')) return 'SVG';
  return null;
}

/** Read and decode a PNG. Throws AvatarProjectError naming the real format when it is something else. */
export async function readPngFile(file: string): Promise<{ bytes: Uint8Array; image: ImageRGBA }> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(file);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new AvatarProjectError('not-found', code === 'EISDIR' ? `${file} is a directory, not an image` : `cannot read the image ${file}`, 'give the path of a PNG file');
  }
  const format = sniffFormat(bytes);
  if (format !== 'PNG') {
    throw new AvatarProjectError(
      'invalid',
      `${file} is ${format ? `a ${format} image` : 'not a PNG image'}; avatar projects need a PNG`,
      'convert the illustration to PNG first, ideally with a transparent background (an image editor, or e.g. "magick input.jpg output.png")',
    );
  }
  try {
    return { bytes, image: decodePNG(bytes) };
  } catch (e) {
    throw new AvatarProjectError('invalid', `cannot decode ${file}: ${(e as Error).message}`, 'save the illustration again as a standard 8-bit PNG');
  }
}

/** Encode an image as PNG and write it, creating parent folders. Returns the absolute path. */
export async function writePngFile(file: string, image: ImageRGBA): Promise<string> {
  const abs = path.resolve(file);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, encodePNG(image));
  return abs;
}

/** Share of pixels that are not fully opaque (0 = no transparency at all). */
function transparentShare(image: ImageRGBA): number {
  let n = 0;
  for (let i = 3; i < image.data.length; i += 4) if (image.data[i] < 255) n++;
  return image.width * image.height ? n / (image.width * image.height) : 0;
}

// ----------------------------------------------------------------------------- create

export interface CreateAvatarProjectOptions {
  /** Name of the avatar (an id; default: the project folder's name made a valid id). */
  name?: string;
  /** Replace an existing avatar.json / source.png. */
  force?: boolean;
}

export interface CreatedAvatarProject {
  dir: string;
  specFile: string;
  sourceFile: string;
  name: string;
  width: number;
  height: number;
  /** The draft document that was written. */
  doc: Record<string, unknown>;
  notes: string[];
}

function projectName(dir: string, name: string | undefined): string {
  if (name === undefined) return avatarSpecName(path.basename(path.resolve(dir)));
  if (!ID_PATTERN.test(name)) {
    throw new AvatarProjectError('invalid', `"${name}" is not a valid avatar name`, `names use letters, digits, _ and - and do not start with a digit, e.g. "${avatarSpecName(name)}"`);
  }
  return name;
}

/** Refuse to replace project files unless `force`; returns whether source.png already holds exactly `bytes`. */
async function checkOverwrite(paths: AvatarProjectPaths, bytes: Uint8Array, force: boolean): Promise<boolean> {
  const source = path.join(paths.dir, AVATAR_SOURCE_FILE);
  let same = false;
  if (existsSync(source)) {
    const current = await readFile(source);
    same = current.length === bytes.length && Buffer.compare(current, bytes) === 0;
  }
  if (!force) {
    const taken = [existsSync(paths.spec) ? AVATAR_SPEC_FILE : null, existsSync(source) && !same ? AVATAR_SOURCE_FILE : null].filter((f) => f !== null);
    if (taken.length) {
      throw new AvatarProjectError('exists', `${paths.dir} already holds ${taken.join(' and ')}`, 'choose another folder, or overwrite the project (its landmarks are lost) with --force');
    }
  }
  return same;
}

function imageNotes(image: ImageRGBA): string[] {
  const notes: string[] = [];
  if (transparentShare(image) < 0.001) {
    notes.push('the image has no transparent background: hair and accessories that swing past the silhouette need one; cut the character out first if you can');
  }
  return notes;
}

/**
 * Start a project: copy the PNG to <dir>/source.png (bytes unchanged) and write the draft
 * avatar.json with the image size filled in and every landmark still to be placed.
 */
export async function createAvatarProject(imagePath: string, projectDir: string, options: CreateAvatarProjectOptions = {}): Promise<CreatedAvatarProject> {
  const paths = avatarProjectPaths(projectDir);
  const name = projectName(paths.dir, options.name);
  if (statSync(paths.dir, { throwIfNoEntry: false })?.isFile()) throw new AvatarProjectError('invalid', `${paths.dir} is a file, not a folder`, 'give the folder the project should live in');
  const { bytes, image } = await readPngFile(path.resolve(imagePath));
  const same = await checkOverwrite(paths, bytes, options.force === true);
  const doc = draftAvatarSpec(name, image.width, image.height);
  const sourceFile = same ? path.join(paths.dir, AVATAR_SOURCE_FILE) : await writeProjectFile(paths.dir, AVATAR_SOURCE_FILE, bytes);
  const specFile = await writeProjectFile(paths.dir, AVATAR_SPEC_FILE, formatModelJson(doc));
  return { dir: paths.dir, specFile, sourceFile, name, width: image.width, height: image.height, doc, notes: imageNotes(image) };
}

/** Write a spec document as avatar.json with the stable formatter. Returns the file path. */
export async function writeAvatarSpec(dir: string, doc: unknown): Promise<string> {
  return writeProjectFile(dir, AVATAR_SPEC_FILE, formatModelJson(doc));
}

// ----------------------------------------------------------------------------- load

export interface LoadedAvatarProject {
  dir: string;
  /** <dir>/avatar.json */
  specFile: string;
  /** Its text; null when the file cannot be read. */
  specText: string | null;
  /** The raw parsed document (drafts included); undefined when the text is not JSON. */
  doc: unknown;
  /** The normalized spec when it has no errors. */
  spec: AvatarSpec | null;
  /** Everything found: file problems ("file-not-found", "avatar-source-*"), then the spec diagnostics. */
  diagnostics: Diagnostic[];
  /** The illustration: its path inside the project and its pixels (null when missing or unreadable). */
  sourceFile: string | null;
  source: ImageRGBA | null;
  /** textures/layers.json when the layers were built and the file is usable. */
  layersFile: string;
  meta: LayersMeta | null;
  /** True when the built layers do not match the spec any more; null without a valid spec or without layers. */
  layersStale: boolean | null;
  /** <dir>/<name>.r2d.json (null while the spec has no usable name) and whether it exists. */
  modelFile: string | null;
  modelExists: boolean;
}

function diag(severity: Diagnostic['severity'], code: string, message: string, pointer = '', hint?: string): Diagnostic {
  return hint ? { severity, code, message, path: pointer, hint } : { severity, code, message, path: pointer };
}

function isLayersMeta(v: unknown): v is LayersMeta {
  if (v === null || typeof v !== 'object') return false;
  const m = v as Partial<LayersMeta>;
  return m.version === 1 && typeof m.inputsHash === 'string' && Array.isArray(m.layers);
}

/**
 * Load a project folder: the spec (parsed and validated against the real image size), the
 * illustration and the build state. Never throws for problems inside the project; they are
 * diagnostics, so callers can show a half-finished project.
 */
export async function loadAvatarProject(dir: string): Promise<LoadedAvatarProject> {
  const paths = avatarProjectPaths(dir);
  const out: LoadedAvatarProject = {
    dir: paths.dir,
    specFile: paths.spec,
    specText: null,
    doc: undefined,
    spec: null,
    diagnostics: [],
    sourceFile: null,
    source: null,
    layersFile: paths.layers,
    meta: null,
    layersStale: null,
    modelFile: null,
    modelExists: false,
  };
  try {
    out.specText = await readFile(paths.spec, 'utf8');
  } catch {
    const exists = statSync(paths.dir, { throwIfNoEntry: false });
    const message = !exists ? `the project folder ${paths.dir} does not exist` : !exists.isDirectory() ? `${paths.dir} is not a project folder` : `${paths.dir} has no ${AVATAR_SPEC_FILE}`;
    out.diagnostics.push(diag('error', 'file-not-found', message, '', 'an avatar project is a folder with avatar.json and source.png; create one with "rev2d avatar new <image.png> <dir>"'));
    return out;
  }

  // The illustration first: its real size is what the spec's coordinates must refer to.
  const raw = parseJsonc(out.specText.charCodeAt(0) === 0xfeff ? out.specText.slice(1) : out.specText);
  const rawDoc = raw.ok ? raw.value : undefined;
  const declared = rawDoc !== null && typeof rawDoc === 'object' ? (rawDoc as { image?: { file?: unknown } }).image?.file : undefined;
  const fileName = typeof declared === 'string' && declared !== '' ? declared : AVATAR_SOURCE_FILE;
  const sourceDiagnostics: Diagnostic[] = [];
  try {
    out.sourceFile = projectFile(paths.dir, fileName);
    out.source = (await readPngFile(out.sourceFile)).image;
  } catch (e) {
    const err = e as AvatarProjectError;
    const code = err.kind === 'outside' ? 'avatar-source-outside-project' : err.kind === 'not-found' ? 'avatar-source-missing' : 'avatar-source-load';
    const hint = err.kind === 'not-found' ? `put the illustration at ${path.join(paths.dir, fileName)} (a PNG), or fix "image.file"` : err.hint;
    sourceDiagnostics.push(diag('error', code, err.kind === 'not-found' ? `the illustration "${fileName}" is missing from the project` : err.message, '/image/file', hint));
  }

  const parsed = parseAvatarSpec(out.specText, out.source ? { imageSize: { width: out.source.width, height: out.source.height }, imageName: fileName } : {});
  out.doc = parsed.doc;
  out.spec = sourceDiagnostics.length ? null : parsed.spec;
  out.diagnostics.push(...sourceDiagnostics, ...parsed.diagnostics);

  const name = parsed.doc !== null && typeof parsed.doc === 'object' ? (parsed.doc as { name?: unknown }).name : undefined;
  if (typeof name === 'string' && ID_PATTERN.test(name)) {
    out.modelFile = avatarModelFile(paths.dir, name);
    out.modelExists = existsSync(out.modelFile);
  }

  if (existsSync(paths.layers)) {
    try {
      const meta: unknown = JSON.parse(await readFile(paths.layers, 'utf8'));
      if (!isLayersMeta(meta)) throw new Error('it is not a layers.json of version 1');
      out.meta = meta;
      if (parsed.spec) out.layersStale = meta.inputsHash !== layerInputsHash(parsed.spec);
    } catch (e) {
      out.diagnostics.push(diag('warning', 'avatar-layers-load', `cannot use ${AVATAR_LAYERS_FILE}: ${(e as Error).message}`, '', 'build the layers again'));
    }
  }
  return out;
}

// ----------------------------------------------------------------------------- Mesh Avatar Studio import

export interface ImportMasProjectOptions extends CreateAvatarProjectOptions {
  /** The illustration, when it is not <mas-dir>/source.png. */
  image?: string;
}

export interface ImportedMasProject extends CreatedAvatarProject {
  /** The rig.json and the image that were read. */
  rigFile: string;
  imageFile: string;
  /** Drawn variants copied to variants/ (project-relative paths). */
  variants: string[];
  /** Validation of the imported spec against the image. */
  spec: AvatarSpec | null;
  diagnostics: Diagnostic[];
}

/** The illustration of a Mesh Avatar Studio project: source.png, else the only PNG in the folder. */
function findMasImage(masDir: string, image: string | undefined): string {
  if (image !== undefined) return path.resolve(image);
  const standard = path.join(masDir, AVATAR_SOURCE_FILE);
  if (existsSync(standard)) return standard;
  let pngs: string[] = [];
  try {
    pngs = readdirSync(masDir).filter((n) => n.toLowerCase().endsWith('.png'));
  } catch {
    pngs = [];
  }
  if (pngs.length === 1) return path.join(masDir, pngs[0]);
  throw new AvatarProjectError(
    'not-found',
    `${masDir} has no source.png`,
    pngs.length ? `name the illustration with --image (PNG files there: ${pngs.slice(0, 8).join(', ')})` : 'name the illustration the rig was made for with --image <file.png>',
  );
}

/**
 * Import a Mesh Avatar Studio project folder (rig.json + source.png, optionally variants/*.png)
 * into a new avatar project: avatar.json from the rig (importMasRig), a copy of the illustration
 * and of the drawn variants whose names Rev2D knows (eyes_closed, mouth_a, ...).
 */
export async function importMasProject(masPath: string, projectDir: string, options: ImportMasProjectOptions = {}): Promise<ImportedMasProject> {
  const given = path.resolve(masPath);
  const isFile = statSync(given, { throwIfNoEntry: false })?.isFile() ?? false;
  const masDir = isFile ? path.dirname(given) : given;
  const rigFile = isFile ? given : path.join(masDir, 'rig.json');
  let text: string;
  try {
    text = await readFile(rigFile, 'utf8');
  } catch {
    throw new AvatarProjectError('not-found', `cannot read ${rigFile}`, 'give the folder of a Mesh Avatar Studio project (it holds rig.json and source.png), or the rig.json itself');
  }
  const json = parseJsonc(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  if (!json.ok) throw new AvatarProjectError('invalid', `${rigFile} is not valid JSON`, undefined, [json.error]);

  const paths = avatarProjectPaths(projectDir);
  const name = projectName(paths.dir, options.name);
  let imported;
  try {
    imported = importMasRig(json.value, { name });
  } catch (e) {
    if (e instanceof MasImportError) throw new AvatarProjectError('invalid', `${rigFile}: ${e.message}`, e.hint);
    throw e;
  }
  const imageFile = findMasImage(masDir, options.image);
  const { bytes, image } = await readPngFile(imageFile);
  const same = await checkOverwrite(paths, bytes, options.force === true);
  const sourceFile = same ? path.join(paths.dir, AVATAR_SOURCE_FILE) : await writeProjectFile(paths.dir, AVATAR_SOURCE_FILE, bytes);
  const specFile = await writeAvatarSpec(paths.dir, imported.doc);

  const variants: string[] = [];
  for (const id of VARIANT_IDS) {
    const from = path.join(masDir, 'variants', `${id}.png`);
    if (!existsSync(from)) continue;
    const rel = `variants/${id}.png`;
    await writeProjectFile(paths.dir, rel, await readFile(from));
    variants.push(rel);
  }

  const check = parseAvatarSpec(imported.doc, { imageSize: { width: image.width, height: image.height }, imageName: path.basename(imageFile) });
  return {
    dir: paths.dir,
    specFile,
    sourceFile,
    name,
    width: image.width,
    height: image.height,
    doc: imported.doc,
    notes: [...imported.notes, ...imageNotes(image)],
    rigFile,
    imageFile,
    variants,
    spec: check.spec,
    diagnostics: check.diagnostics,
  };
}

// ----------------------------------------------------------------------------- vision check files

interface VisionCheckKeyFile {
  about: string;
  seed: number;
  size: number;
  markers: number;
  /** The key (marker -> [x, y]) as base64 of its JSON, so that listing or printing the file does not reveal it. */
  key: string;
}

/** Write <dir>/vision-check.png and the answer key beside it (encoded, see VisionCheckKeyFile). */
export async function writeVisionCheck(dir: string, check: VisionCheck): Promise<{ image: string; key: string }> {
  const root = path.resolve(dir);
  const image = await writePngFile(path.join(root, VISION_CHECK_IMAGE), check.image);
  const file: VisionCheckKeyFile = {
    about: 'Answer key of "rev2d avatar vision-check": do not decode it before answering; score your answer with "rev2d avatar vision-check score <dir> <answer.json>".',
    seed: check.key.seed,
    size: check.key.size,
    markers: Object.keys(check.key.markers).length,
    key: Buffer.from(JSON.stringify(check.key.markers), 'utf8').toString('base64'),
  };
  const key = path.join(root, VISION_CHECK_KEY);
  await writeFile(key, formatModelJson(file));
  return { image, key };
}

/** Read the answer key written by writeVisionCheck. */
export async function readVisionCheckKey(dir: string): Promise<VisionCheckKey> {
  const file = path.join(path.resolve(dir), VISION_CHECK_KEY);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    throw new AvatarProjectError('not-found', `${file} does not exist`, 'run "rev2d avatar vision-check make <dir>" first; it writes the image and its answer key');
  }
  try {
    const data = JSON.parse(text) as Partial<VisionCheckKeyFile>;
    const markers = JSON.parse(Buffer.from(String(data.key), 'base64').toString('utf8')) as VisionCheckKey['markers'];
    if (typeof data.seed !== 'number' || typeof data.size !== 'number' || markers === null || typeof markers !== 'object') throw new Error('missing fields');
    return { version: 1, seed: data.seed, size: data.size, markers };
  } catch {
    throw new AvatarProjectError('invalid', `${file} is damaged`, 'run "rev2d avatar vision-check make <dir>" again');
  }
}

// ----------------------------------------------------------------------------- build

export interface AvatarBuildOptions {
  /** Run the fold checker on the built model (default true). */
  folds?: boolean;
}

export interface AvatarBuildTimings {
  /** Loading the project (spec, illustration). */
  loadMs: number;
  /** Stage 1: the layer images. */
  layersMs: number;
  /** Stage 2: the model document, post ops included. */
  compileMs: number;
  validateMs: number;
  foldsMs: number;
  /** Encoding and writing the PNGs, layers.json and the model. */
  writeMs: number;
  totalMs: number;
}

export interface AvatarBuildResult {
  dir: string;
  name: string;
  /** <dir>/<name>.r2d.json and its size. */
  modelFile: string;
  modelBytes: number;
  /** textures/layers.json */
  layersFile: string;
  /** The layer images written, relative to the project ("textures/base.png", ...). */
  layers: string[];
  /** Layer images of an earlier build that this build no longer produces (deleted). */
  removed: string[];
  /** Number of spec.post ops applied. */
  postOps: number;
  /** Issues and statistics of both stages plus the fold check ("avatar-mesh-fold" warnings). */
  report: AvatarReport;
  /** Validation diagnostics of the built model: warnings and info only (errors fail the build). */
  diagnostics: Diagnostic[];
  folds: FoldFinding[];
  timings: AvatarBuildTimings;
}

const now = (): number => performance.now();
const ms = (from: number): number => Math.round((now() - from) * 10) / 10;

/** Write a project file unless it already holds exactly these bytes (keeps mtimes and live reloads quiet). */
async function writeIfChanged(dir: string, relative: string, data: string | Uint8Array): Promise<string> {
  const abs = projectFile(dir, relative);
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  try {
    const current = await readFile(abs);
    if (current.length === bytes.length && Buffer.compare(current, bytes) === 0) return abs;
  } catch {
    // Not there yet.
  }
  return writeProjectFile(dir, relative, bytes);
}

/** Build issues about carried sprites: stale ones (landmarks changed since the cut) and ones whose image file is gone. */
function spriteIssues(sprites: ReturnType<typeof carrySprites>, dir: string): AvatarReport['issues'] {
  const target = /[\s"'$&|<>()]/.test(dir) ? `"${dir}"` : dir;
  const issues: AvatarReport['issues'] = [];
  if (sprites.stale.length) {
    issues.push({
      severity: 'warning',
      code: 'avatar-variant-stale',
      message: `the sprites of ${sprites.stale.join(', ')} were cut for other eye regions, another mouth area or other layers than the avatar has now`,
      hint: `cut them again from their drawings: rev2d avatar variants import ${target}`,
    });
  }
  if (sprites.missing.length) {
    issues.push({
      severity: 'warning',
      code: 'avatar-variant-sprite-missing',
      message: `the sprite images of ${sprites.missing.join(', ')} are missing from textures/: those variants are left out`,
      hint: `cut them again from their drawings: rev2d avatar variants import ${target}`,
    });
  }
  return issues;
}

/**
 * Build a project: avatar.json + source.png -> textures/*.png, textures/layers.json and
 * <name>.r2d.json (stable formatting; unchanged files are not rewritten).
 *
 * Fails with AvatarProjectError when the spec has errors, a spec.post op fails or the generated
 * model does not validate; nothing of the model is written then. Warnings do not fail the build:
 * they are in the result (report.issues, diagnostics).
 */
export async function buildAvatarProject(dir: string, options: AvatarBuildOptions = {}): Promise<AvatarBuildResult> {
  const t0 = now();
  const project = await loadAvatarProject(dir);
  const missing = project.diagnostics.find((d) => d.code === 'file-not-found');
  if (missing) throw new AvatarProjectError('not-found', missing.message, missing.hint);
  const errors = project.diagnostics.filter((d) => d.severity === 'error');
  if (!project.spec || !project.source || errors.length) {
    const todo = errors.filter((d) => d.code === 'avatar-missing-landmark').length;
    throw new AvatarProjectError(
      'invalid',
      `cannot build ${project.dir}: the avatar spec has ${errors.length} error${errors.length === 1 ? '' : 's'}${todo ? ` (${todo} landmark${todo === 1 ? '' : 's'} still to place)` : ''}`,
      'fix what "rev2d avatar validate" reports, then build again',
      errors,
    );
  }
  const { spec, source } = project;
  const loadMs = ms(t0);

  let t = now();
  const layers = buildLayers(spec, source, project.meta ?? undefined);
  // Drawn variants: the sprites cut from accepted drawings survive a rebuild of the layers.
  const sprites = carrySprites(project.meta, layers.meta, spec, (file) => existsSync(projectFile(project.dir, file)));
  layers.meta = sprites.meta;
  layers.report.issues.push(...spriteIssues(sprites, project.dir));
  const layersMs = ms(t);

  t = now();
  const compiled = compileModel(spec, layers.meta);
  let doc: unknown = compiled.doc;
  const post = (spec.post ?? []) as Op[];
  if (post.length) {
    const applied = applyOps(doc, post, { validate: false, textures: Object.fromEntries(layers.meta.layers.map((l) => [l.id, { width: l.rect[2], height: l.rect[3] }])) });
    if (!applied.ok) {
      const failed = applied.results.find((r) => !r.ok);
      throw new AvatarProjectError(
        'invalid',
        `the "post" op #${failed?.index ?? 0} (${failed?.op ?? '?'}) of avatar.json failed: ${failed?.message ?? 'unknown error'}`,
        failed?.hint ?? 'post ops are edit ops (docs/OPS.md) applied to the generated model; fix or remove the op',
      );
    }
    doc = applied.doc;
  }
  const compileMs = ms(t);

  t = now();
  const validation = validateModel(doc);
  const modelErrors = validation.diagnostics.filter((d) => d.severity === 'error');
  if (!validation.model || modelErrors.length) {
    throw new AvatarProjectError(
      'invalid',
      `the generated model has ${modelErrors.length} error${modelErrors.length === 1 ? '' : 's'}${post.length ? ' (after the "post" ops of avatar.json)' : ''}`,
      post.length ? 'check the "post" ops: they must leave a valid model; without them this is a bug in the avatar builder' : 'this is a bug in the avatar builder: please report it with the avatar.json',
      modelErrors,
    );
  }
  const validateMs = ms(t);

  t = now();
  const folds = options.folds === false ? [] : findFolds(validation.model, compiled.folds);
  const foldsMs = ms(t);

  t = now();
  const written: string[] = [];
  for (const [file, image] of Object.entries(layers.images)) {
    await writeIfChanged(project.dir, file, encodePNG(image));
    written.push(file);
  }
  // Layer images of the previous build that are gone now (a removed attachment) would only confuse.
  const removed: string[] = [];
  for (const old of project.meta?.layers ?? []) {
    if (typeof old?.file !== 'string' || written.includes(old.file) || sprites.carried.some((c) => c.file === old.file)) continue;
    try {
      const abs = projectFile(project.dir, old.file);
      if (existsSync(abs)) {
        await rm(abs);
        removed.push(old.file);
      }
    } catch {
      // A path outside the project in an edited layers.json: leave it alone.
    }
  }
  await writeIfChanged(project.dir, AVATAR_LAYERS_FILE, formatModelJson(layers.meta));
  const text = formatModelJson(doc);
  const modelFile = avatarModelFile(project.dir, spec.name);
  await writeIfChanged(project.dir, path.basename(modelFile), text);
  const writeMs = ms(t);

  const foldPoses = new Set(folds.map((f) => JSON.stringify(f.params))).size;
  const report = mergeReports(layers.report, compiled.report, { issues: foldIssues(folds), stats: options.folds === false ? {} : { foldPoses } });
  return {
    dir: project.dir,
    name: spec.name,
    modelFile,
    modelBytes: Buffer.byteLength(text, 'utf8'),
    layersFile: project.layersFile,
    layers: written,
    removed,
    postOps: post.length,
    report,
    diagnostics: validation.diagnostics.filter((d) => d.severity !== 'error'),
    folds,
    timings: { loadMs, layersMs, compileMs, validateMs, foldsMs, writeMs, totalMs: ms(t0) },
  };
}

// ----------------------------------------------------------------------------- review sheets

export interface AvatarReviewOptions {
  /** Multiplies the size of every cell (default 1: cells of about 400 px, a review in a few seconds). */
  scale?: number;
}

export interface AvatarReviewSheet {
  kind: 'poses' | 'turn' | 'eyes' | 'mouth';
  /** Absolute path of the PNG and its path inside the project ("review/poses.png"). */
  file: string;
  name: string;
  width: number;
  height: number;
  cells: number;
  columns: number;
  /** Output px per source px, and the source region [x, y, w, h] every cell shows. */
  scale: number;
  viewBox: ViewBox;
  /** Captions of the cells, in order. */
  captions: string[];
  ms: number;
}

export interface AvatarReviewPose {
  id: string;
  label: string;
  /** The parameter values used: those of the pose that the built model has. */
  params: Record<string, number>;
  /** Why the pose was left out (the model lacks its parameters); absent when it was rendered. */
  skipped?: string;
  /**
   * Where the landmarks of the spec are in this pose, as offsets [dx, dy] from the illustration in
   * source pixels (how the root lattice carries them): numbers to check a sheet against. Only the
   * landmarks that move by at least 0.05 px are listed; absent for skipped poses.
   */
  moves?: Record<string, [number, number]>;
}

export interface AvatarReviewResult {
  dir: string;
  modelFile: string;
  sheets: AvatarReviewSheet[];
  poses: AvatarReviewPose[];
  /** review/summary.json */
  summaryFile: string;
  notes: string[];
  timings: { loadMs: number; renderMs: number; writeMs: number; totalMs: number };
}

/** The landmarks whose motion the review summary reports, by name. */
function reviewLandmarks(spec: AvatarSpec): Array<[string, number, number]> {
  const centroid = (points: number[]): [number, number] => {
    let x = 0;
    let y = 0;
    for (let i = 0; i + 1 < points.length; i += 2) {
      x += points[i];
      y += points[i + 1];
    }
    return [x / (points.length / 2), y / (points.length / 2)];
  };
  const { head, face, body } = spec;
  const list: Array<[string, readonly [number, number] | undefined]> = [
    ['headTop', [head.center[0], Math.max(0, head.center[1] - head.radius[1] * 0.9)]],
    ['faceCenter', face.center],
    ['eyeImageLeft', centroid(face.eyes.imageLeft.opening)],
    ['eyeImageRight', centroid(face.eyes.imageRight.opening)],
    ['earImageLeft', face.ears?.imageLeft],
    ['earImageRight', face.ears?.imageRight],
    ['nose', face.nose],
    ['mouthImageLeft', face.mouth.imageLeft],
    ['mouthImageRight', face.mouth.imageRight],
    ['chin', face.chin],
    ['neckPivot', head.pivot],
    ['shoulderImageLeft', body.shoulders?.[0]],
    ['shoulderImageRight', body.shoulders?.[1]],
    ['chest', body.chest.center],
  ];
  return list.flatMap(([name, p]) => (p ? [[name, p[0], p[1]] as [string, number, number]] : []));
}

/** Background of review cells: a mid tone shows light and dark halos alike. */
const REVIEW_BACKGROUND = '#7d8797';
const REVIEW_DIR = 'review';

type Box = [number, number, number, number];

function boundsOf(points: ArrayLike<number>, into: Box | null): Box | null {
  let b = into;
  for (let i = 0; i + 1 < points.length; i += 2) {
    const x = points[i];
    const y = points[i + 1];
    b = b ? [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)] : [x, y, x, y];
  }
  return b;
}

/** A source region [x0, y0, x1, y1] grown by `grow` (a share of its size on every side), as a whole-pixel view box. */
function cropBox(b: Box, grow: number): ViewBox {
  const mx = (b[2] - b[0]) * grow;
  const my = (b[3] - b[1]) * grow;
  const x = Math.floor(b[0] - mx);
  const y = Math.floor(b[1] - my);
  return [x, y, Math.max(8, Math.ceil(b[2] + mx) - x), Math.max(8, Math.ceil(b[3] + my) - y)];
}

/**
 * Render the review sheets of a BUILT project into <dir>/review/:
 *
 *   poses.png     every review pose (avatarReviewPoses) as one captioned contact sheet
 *   turn.png      the 3 x 3 grid AngleX x AngleY (top row looks up)
 *   eyes.png      the eye poses, cropped to both eyes and magnified
 *   mouth.png     the mouth poses, cropped to the mouth and magnified
 *   summary.json  what was rendered: sheets, poses with their parameters and how far each landmark of
 *                 the spec moves in them (numbers to check the pictures against), notes, timings
 *
 * Cells are rendered at a reduced scale with some room around the canvas (a tilting head leaves it),
 * so a review takes seconds. Poses whose parameters the model does not have are skipped and listed.
 */
export async function reviewAvatarProject(dir: string, options: AvatarReviewOptions = {}): Promise<AvatarReviewResult> {
  const t0 = now();
  const factor = options.scale ?? 1;
  if (!(factor > 0) || !Number.isFinite(factor)) throw new AvatarProjectError('invalid', `the review scale must be a positive number, got ${factor}`);
  const project = await loadAvatarProject(dir);
  const missing = project.diagnostics.find((d) => d.code === 'file-not-found');
  if (missing) throw new AvatarProjectError('not-found', missing.message, missing.hint);
  if (!project.spec) {
    const errors = project.diagnostics.filter((d) => d.severity === 'error');
    throw new AvatarProjectError('invalid', `cannot review ${project.dir}: the avatar spec has errors`, 'fix what "rev2d avatar validate" reports, build, then review', errors);
  }
  if (!project.modelFile || !project.modelExists || !project.meta) {
    throw new AvatarProjectError('not-found', `${project.dir} is not built yet`, 'run "rev2d avatar build <project>" first; it writes the model and its layer images');
  }
  const loaded = await loadModelFile(project.modelFile);
  const model = loaded.model;
  if (!model || !loaded.rig) {
    const errors = loaded.diagnostics.filter((d) => d.severity === 'error');
    throw new AvatarProjectError('invalid', `the built model ${project.modelFile} cannot be loaded`, 'build the project again ("rev2d avatar build")', errors);
  }
  const { spec, meta } = project;
  const notes: string[] = [];
  if (project.layersStale) notes.push('the layer images are older than the spec (a polygon that cuts layers changed): run "rev2d avatar build" again');
  else if (statSync(project.specFile).mtimeMs > statSync(project.modelFile).mtimeMs + 1) notes.push('avatar.json changed after the model was built: run "rev2d avatar build" to review the current spec');
  const loadMs = ms(t0);

  const ids = new Set(model.parameters.map((p) => p.id));
  type ReviewPose = AvatarPose & { use: Record<string, number>; skipped?: string };
  const poses: ReviewPose[] = reviewPoses(spec, meta).map((pose) => {
    const use = Object.fromEntries(Object.entries(pose.params).filter(([id]) => ids.has(id)));
    const lacking = Object.keys(pose.params).filter((id) => !ids.has(id));
    return lacking.length && Object.keys(use).length === 0 ? { ...pose, use, skipped: `the model has no ${lacking.join(' / ')} parameter` } : { ...pose, use };
  });
  const shown = poses.filter((p) => !p.skipped);
  const skipped = poses.filter((p) => p.skipped);
  // How the root lattice carries the landmarks in each pose: the numbers behind the pictures.
  const rig = loaded.rig;
  const rootWarp = model.warps.some((w) => w.id === ROOT_WARP) ? ROOT_WARP : null;
  const landmarks = reviewLandmarks(spec);
  const movesOf = (params: Record<string, number>): Record<string, [number, number]> => {
    const moves: Record<string, [number, number]> = {};
    if (!rootWarp) return moves;
    const pose = rig.pose({ params, physics: false });
    for (const [name, x, y] of landmarks) {
      const p = rig.mapPoint(pose, `warp:${rootWarp}`, x, y);
      const d: [number, number] = [Math.round((p[0] - x) * 10) / 10, Math.round((p[1] - y) * 10) / 10];
      if (Math.abs(d[0]) >= 0.05 || Math.abs(d[1]) >= 0.05) moves[name] = d;
    }
    return moves;
  };
  if (skipped.length) notes.push(`${skipped.length} review pose${skipped.length === 1 ? ' is' : 's are'} skipped, the model lacks the parameters: ${skipped.map((p) => p.id).join(', ')}`);

  const { width, height } = model.meta;
  // Room around the canvas: tilt and sway move the head past the image edges.
  const pad = Math.round(Math.max(width, height) * 0.06);
  const full: ViewBox = [-pad, -pad, width + 2 * pad, height + pad];
  const round3 = (v: number) => Math.round(v * 1000) / 1000;
  const cellScale = (box: ViewBox, target: number, max: number) => round3(Math.min(max, (target * factor) / Math.max(box[2], box[3])));
  const supersample = (scale: number) => (scale < 0.5 ? 3 : 2);

  const sheets: AvatarReviewSheet[] = [];
  const outputs: Array<{ name: string; image: ImageRGBA }> = [];
  const tRender = now();
  const poseSheet = (kind: AvatarReviewSheet['kind'], list: ReviewPose[], box: ViewBox, target: number, maxScale: number, columns: number, title: string) => {
    const t = now();
    const scale = cellScale(box, target, maxScale);
    const cells: SheetCell[] = list.map((pose) => ({
      image: renderFrame(loaded, { params: pose.use, physics: false, viewBox: box, scale, background: REVIEW_BACKGROUND, supersample: supersample(scale) }).image,
      caption: pose.label,
    }));
    const cols = Math.min(columns, cells.length);
    const image = composeSheet(cells, { columns: cols, title });
    const name = `${REVIEW_DIR}/${kind}.png`;
    outputs.push({ name, image });
    sheets.push({ kind, file: projectFile(project.dir, name), name, width: image.width, height: image.height, cells: cells.length, columns: cols, scale, viewBox: box, captions: list.map((p) => p.label), ms: ms(t) });
  };

  poseSheet('poses', shown, full, 400, 1, Math.ceil(Math.sqrt(shown.length)), `${spec.name} - review poses`);

  if (ids.has('AngleX') && ids.has('AngleY')) {
    const t = now();
    const scale = cellScale(full, 440, 1);
    const sheet = buildSheet(loaded, {
      sweeps: [parseSweep(model, 'AngleX=-30,0,30'), parseSweep(model, 'AngleY=30,0,-30')],
      physics: false,
      viewBox: full,
      scale,
      background: REVIEW_BACKGROUND,
      supersample: supersample(scale),
      title: `${spec.name} - head turn: AngleX (columns) x AngleY (rows, top looks up)`,
    });
    const name = `${REVIEW_DIR}/turn.png`;
    outputs.push({ name, image: sheet.image });
    sheets.push({ kind: 'turn', file: projectFile(project.dir, name), name, width: sheet.image.width, height: sheet.image.height, cells: sheet.cells, columns: sheet.columns, scale, viewBox: full, captions: sheet.captions, ms: ms(t) });
  } else {
    notes.push('review/turn.png is not written: the model has no AngleX / AngleY parameters');
  }

  // Magnified crops: the rest pose plus the poses that concern the eyes / the mouth.
  const rest = shown.filter((p) => p.id === 'rest');
  const eyes = spec.face.eyes;
  const eyeBox = boundsOf(eyes.imageRight.region, boundsOf(eyes.imageLeft.region, null));
  const eyePoses = [...rest, ...shown.filter((p) => p.zoom === 'eyes')];
  if (eyeBox && eyePoses.length) {
    poseSheet('eyes', eyePoses, cropBox(eyeBox, 0.2), 620, 4, 2, `${spec.name} - eyes`);
    if (eyePoses.length === rest.length) notes.push('review/eyes.png shows the rest pose only: the model has no eye parameters (EyeLOpen / EyeROpen) yet');
  }
  const area = spec.face.mouth.area;
  const reach = Math.max(area.radius[0], area.radius[1]);
  const mouthPoses = [...rest, ...shown.filter((p) => p.zoom === 'mouth')];
  if (mouthPoses.length) {
    poseSheet('mouth', mouthPoses, cropBox([area.center[0] - reach, area.center[1] - reach, area.center[0] + reach, area.center[1] + reach], 0.6), 420, 4, 3, `${spec.name} - mouth`);
    if (mouthPoses.length === rest.length) notes.push('review/mouth.png shows the rest pose only: the model has no mouth parameter (MouthOpen) yet');
  }
  const renderMs = ms(tRender);

  const tWrite = now();
  for (const out of outputs) await writeProjectFile(project.dir, out.name, encodePNG(out.image));
  const timings = { loadMs, renderMs, writeMs: ms(tWrite), totalMs: ms(t0) };
  const reviewed: AvatarReviewPose[] = poses.map((p) => (p.skipped ? { id: p.id, label: p.label, params: p.use, skipped: p.skipped } : { id: p.id, label: p.label, params: p.use, moves: movesOf(p.use) }));
  const summaryFile = await writeProjectFile(
    project.dir,
    `${REVIEW_DIR}/summary.json`,
    formatModelJson({
      name: spec.name,
      model: path.basename(project.modelFile),
      canvas: [width, height],
      parameters: model.parameters.map((p) => p.id),
      sheets: sheets.map((s) => ({ kind: s.kind, file: s.name, width: s.width, height: s.height, cells: s.cells, columns: s.columns, scale: s.scale, viewBox: s.viewBox, captions: s.captions, ms: s.ms })),
      poses: reviewed,
      notes,
      timings,
    }),
  );
  return { dir: project.dir, modelFile: project.modelFile, sheets, poses: reviewed, summaryFile, notes, timings };
}
