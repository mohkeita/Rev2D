/**
 * File IO of drawn variants (src/avatar/variants.ts has the pure parts):
 *
 *   writeAvatarVariantRequests(dir, {ids})   variant-requests/<id>.mask.png + <id>.prompt.txt, README.md, preview.png
 *   importAvatarVariants(dir, {ids})         check every variants/<id>.png, cut the accepted ones into sprite
 *                                            layers (textures/sprite_*.png + layers.json) and rebuild the model
 *   avatarVariantStatus(dir)                 requested / drawn / accepted / rejected / stale, per variant
 *
 * Everything stays inside the project folder (projectFile refuses other paths) and on this machine.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Diagnostic, ImageRGBA, Model } from '../core/types.js';
import { formatModelJson } from '../core/format.js';
import { validateModel } from '../core/validate.js';
import { suggest } from '../core/address.js';
import { encodePNG } from '../render/index.js';
import { applyOps, type Op } from '../ops/index.js';
import { compileModel } from '../avatar/compile.js';
import { VARIANT_IDS, type AvatarReport, type AvatarSpec, type LayersMeta, type VariantGroup, type VariantId } from '../avatar/types.js';
import { BASE_LAYER } from '../avatar/layers.js';
import {
  buildSprites,
  hashImage,
  isVariantId,
  normalizeVariantIds,
  RECOMMENDED_VARIANT_IDS,
  rejectSprites,
  removeSprites,
  drawnAboveSprites,
  spriteBackdrop,
  spritesMeta,
  variantEditAreas,
  variantFiles,
  variantPreview,
  variantReadme,
  variantRequests,
  variantStatuses,
  VARIANT_PREVIEW,
  VARIANT_README,
  VARIANTS,
  type SpriteBackdrop,
  type VariantAreaKey,
  type VariantCheckResult,
  type VariantStatus,
} from '../avatar/variants.js';
import {
  AVATAR_LAYERS_FILE,
  AvatarProjectError,
  avatarModelFile,
  avatarProjectPaths,
  loadAvatarProject,
  projectFile,
  readPngFile,
  writeProjectFile,
  type LoadedAvatarProject,
} from './avatar.js';

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

/** A loaded project whose spec and illustration are usable, or a failure that says what to fix. */
async function usableProject(dir: string, what: string): Promise<LoadedAvatarProject & { spec: AvatarSpec; source: ImageRGBA }> {
  const project = await loadAvatarProject(dir);
  const missing = project.diagnostics.find((d) => d.code === 'file-not-found');
  if (missing) throw new AvatarProjectError('not-found', missing.message, missing.hint);
  const errors = project.diagnostics.filter((d) => d.severity === 'error');
  if (!project.spec || !project.source || errors.length) {
    const todo = errors.filter((d) => d.code === 'avatar-missing-landmark').length;
    throw new AvatarProjectError(
      'invalid',
      `cannot ${what} for ${project.dir}: the avatar spec has ${errors.length} error${errors.length === 1 ? '' : 's'}${todo ? ` (${todo} landmark${todo === 1 ? '' : 's'} still to place)` : ''}`,
      'the edit areas come from the eye regions and the mouth area of avatar.json: fix what "rev2d avatar validate" reports first',
      errors,
    );
  }
  return project as LoadedAvatarProject & { spec: AvatarSpec; source: ImageRGBA };
}

/** The variants whose request files exist (variant-requests/<id>.mask.png). */
function requestedIds(dir: string): VariantId[] {
  return VARIANT_IDS.filter((id) => existsSync(projectFile(dir, variantFiles(id).mask)));
}

// ----------------------------------------------------------------------------- request

export interface WriteVariantRequestsOptions {
  /** Variants to request (default: the recommended eyes_closed and mouth_a, plus every variant requested before). */
  ids?: VariantId[];
  /** How the project folder is written in the README's commands (default "."). */
  project?: string;
}

export interface WrittenVariantRequest {
  id: VariantId;
  group: 'eyes' | 'mouth';
  label: string;
  recommended: boolean;
  /** Project-relative paths: where the drawing goes, the mask and the prompt. */
  file: string;
  maskFile: string;
  promptFile: string;
  prompt: string;
  areas: Array<{ key: VariantAreaKey; bounds: [number, number, number, number]; grow: number; feather: number }>;
}

export interface WrittenVariantRequests {
  dir: string;
  /** The image size the drawings must have. */
  size: [number, number];
  /** Whether the illustration has a transparent background (the prompts ask to keep it). */
  transparent: boolean;
  requests: WrittenVariantRequest[];
  /** Absolute paths of README.md and preview.png. */
  readme: string;
  preview: string;
  /** Every file written, project-relative. */
  files: string[];
  notes: string[];
}

/**
 * Write the requests: per variant the edit mask and the prompt, plus README.md (the flow, the
 * files, the check) and preview.png (the editable areas tinted). Requests written earlier are
 * written again (the landmarks may have moved), so the README lists every request of the project.
 */
export async function writeAvatarVariantRequests(dir: string, options: WriteVariantRequestsOptions = {}): Promise<WrittenVariantRequests> {
  const project = await usableProject(dir, 'write variant requests');
  const { spec, source } = project;
  const earlier = requestedIds(project.dir);
  const wanted = options.ids && options.ids.length ? options.ids : RECOMMENDED_VARIANT_IDS;
  const ids = normalizeVariantIds([...wanted, ...earlier]);
  const sourceName = spec.image.file;
  const set = variantRequests(spec, source, ids, { sourceName });
  const files: string[] = [];
  const masks = new Map<string, Uint8Array>();
  for (const r of set.requests) {
    let png = masks.get(r.group);
    if (!png) masks.set(r.group, (png = encodePNG(r.mask)));
    await writeIfChanged(project.dir, r.maskFile, png);
    await writeIfChanged(project.dir, r.promptFile, r.prompt);
    files.push(r.maskFile, r.promptFile);
  }
  const readme = await writeIfChanged(project.dir, VARIANT_README, variantReadme(spec, set.requests, { sourceName, transparent: set.transparent, project: options.project }));
  const preview = await writeIfChanged(project.dir, VARIANT_PREVIEW, encodePNG(variantPreview(source, set.edits)));
  files.push(VARIANT_README, VARIANT_PREVIEW);
  const notes: string[] = [];
  const again = earlier.filter((id) => !(options.ids ?? []).includes(id) && !RECOMMENDED_VARIANT_IDS.includes(id));
  if (again.length) notes.push(`also wrote again the earlier request${again.length === 1 ? '' : 's'} ${again.join(', ')}`);
  if (project.meta === null) notes.push('the avatar is not built yet: build it ("rev2d avatar build") before importing drawings');
  return {
    dir: project.dir,
    size: [spec.image.width, spec.image.height],
    transparent: set.transparent,
    requests: set.requests.map((r) => ({ id: r.id, group: r.group, label: r.label, recommended: r.recommended, file: r.file, maskFile: r.maskFile, promptFile: r.promptFile, prompt: r.prompt, areas: r.areas })),
    readme,
    preview,
    files,
    notes,
  };
}

// ----------------------------------------------------------------------------- the model

interface ModelText {
  file: string;
  text: string;
  model: Model;
  report: AvatarReport;
  /** Warnings and info of the model validation. */
  diagnostics: Diagnostic[];
  postOps: number;
}

/** Stage 2 + the spec's post ops + validation, as the build does: the model text, or a failure. */
function compileProjectModel(dir: string, spec: AvatarSpec, meta: LayersMeta): ModelText {
  const compiled = compileModel(spec, meta);
  let doc: unknown = compiled.doc;
  const post = (spec.post ?? []) as Op[];
  if (post.length) {
    const applied = applyOps(doc, post, { validate: false, textures: Object.fromEntries(meta.layers.map((l) => [l.id, { width: l.rect[2], height: l.rect[3] }])) });
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
  const validation = validateModel(doc);
  const errors = validation.diagnostics.filter((d) => d.severity === 'error');
  if (!validation.model || errors.length) {
    throw new AvatarProjectError(
      'invalid',
      `the generated model has ${errors.length} error${errors.length === 1 ? '' : 's'}${post.length ? ' (after the "post" ops of avatar.json)' : ''}`,
      post.length ? 'check the "post" ops: they must leave a valid model; without them this is a bug in the avatar builder' : 'this is a bug in the avatar builder: please report it with the avatar.json',
      errors,
    );
  }
  return { file: avatarModelFile(dir, spec.name), text: formatModelJson(doc), model: validation.model, report: compiled.report, diagnostics: validation.diagnostics.filter((d) => d.severity !== 'error'), postOps: post.length };
}

// ----------------------------------------------------------------------------- backdrops

/**
 * What lies over the sprites of each group in the current model at rest (spriteBackdrop): the
 * model compiled from the existing layers, rendered with only its parts above the sprites, and the
 * base layer. Null for a group when the layer images cannot be read (the drawing is then cut as it is).
 */
async function spriteBackdrops(dir: string, spec: AvatarSpec, meta: LayersMeta, groups: ReadonlySet<VariantGroup>, notes: string[]): Promise<Partial<Record<VariantGroup, SpriteBackdrop>>> {
  if (groups.size === 0) return {};
  try {
    const { model } = compileProjectModel(dir, spec, meta);
    const wanted = new Set<string>();
    for (const part of model.parts) {
      const texture = (part.shape as { texture?: string }).texture;
      if (typeof texture === 'string' && [...groups].some((g) => drawnAboveSprites(part, g))) wanted.add(texture);
    }
    const textures: Record<string, ImageRGBA> = {};
    for (const t of model.textures) if (wanted.has(t.id)) textures[t.id] = (await readPngFile(projectFile(dir, t.path))).image;
    const baseInfo = meta.layers.find((l) => l.id === BASE_LAYER);
    if (!baseInfo) throw new Error('layers.json lists no base layer');
    const base = (await readPngFile(projectFile(dir, baseInfo.file))).image;
    const out: Partial<Record<VariantGroup, SpriteBackdrop>> = {};
    for (const group of groups) out[group] = spriteBackdrop(model, textures, base, variantEditAreas(spec, group));
    return out;
  } catch (e) {
    notes.push(`the layers over the sprites could not be read (${(e as Error).message}): the drawings were cut as they are; build the avatar again and import again`);
    return {};
  }
}

// ----------------------------------------------------------------------------- import

export interface ImportVariantsOptions {
  /** Only these variants (default: every variants/<id>.png). */
  ids?: VariantId[];
}

export interface IgnoredVariantFile {
  /** Project-relative path. */
  file: string;
  reason: string;
  hint?: string;
}

export interface ImportedVariants {
  dir: string;
  name: string;
  /** One check per drawing that could be read, in variant order. */
  checks: VariantCheckResult[];
  /** Drawings accepted and cut now. */
  accepted: VariantId[];
  /** Drawings rejected now (checks with ok false, and drawings that cannot be read). */
  rejected: VariantId[];
  /** Rejected drawings whose earlier sprite stays in the model. */
  kept: VariantId[];
  /** Variants whose drawing is gone: their sprites were removed. */
  removed: VariantId[];
  /** Drawings that are not usable PNG files: why, and what to do. */
  unreadable: Array<{ id: VariantId; file: string; reason: string; hint?: string }>;
  /** Files in variants/ that are not drawings of a known variant. */
  ignored: IgnoredVariantFile[];
  /** The variants with a sprite in the model now. */
  variants: VariantId[];
  /** Sprite images written and deleted, project-relative. */
  sprites: string[];
  deleted: string[];
  layersFile: string;
  modelFile: string;
  modelBytes: number;
  /** Issues and statistics of compiling the model; validation warnings of the model. */
  report: AvatarReport;
  diagnostics: Diagnostic[];
  notes: string[];
  timings: { loadMs: number; checkMs: number; compileMs: number; writeMs: number; totalMs: number };
}

/** The PNG files in variants/ with their variant id (null for a name that is not one). */
function variantFolder(dir: string): Array<{ name: string; id: VariantId | null }> {
  const folder = avatarProjectPaths(dir).variants;
  let names: string[] = [];
  try {
    names = readdirSync(folder, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
  return names.map((name) => {
    const m = /^(.*)\.png$/i.exec(name);
    return { name, id: m && isVariantId(m[1]) && name.endsWith('.png') ? (m[1] as VariantId) : null };
  });
}

function ignoredFiles(dir: string, ids: readonly VariantId[] | null): IgnoredVariantFile[] {
  const out: IgnoredVariantFile[] = [];
  for (const f of variantFolder(dir)) {
    if (f.id) continue;
    const dot = f.name.lastIndexOf('.');
    const stem = dot > 0 ? f.name.slice(0, dot) : f.name;
    const ext = dot > 0 ? f.name.slice(dot) : '';
    if (isVariantId(stem)) {
      if (ids && !ids.includes(stem)) continue;
      out.push(
        ext.toLowerCase() === '.png'
          ? { file: `variants/${f.name}`, reason: `"${f.name}" has an upper-case extension`, hint: `rename it to variants/${stem}.png` }
          : { file: `variants/${f.name}`, reason: `"${f.name}" is not a .png file`, hint: `save the drawing as a PNG named variants/${stem}.png` },
      );
      continue;
    }
    const near = suggest(stem.toLowerCase(), [...VARIANT_IDS]);
    const names = `variants are named ${VARIANT_IDS.map((id) => `${id}.png`).join(', ')}`;
    out.push({ file: `variants/${f.name}`, reason: `"${f.name}" is not the name of a variant`, hint: near ? `${near.replace(/"([^"]+)"/, '"$1.png"')} ${names}` : names });
  }
  return out;
}

/**
 * Import the drawings in variants/: check each (checkVariantDrawing), cut the accepted ones into
 * sprite layers, remove the sprites of variants whose drawing is gone, write the sprite images and
 * layers.json, and rebuild the model from the existing layers (no layer images are cut again).
 * A rejected drawing keeps the variant's earlier sprite. Fails when the avatar is not built yet, or
 * when there is nothing to import or remove.
 */
export async function importAvatarVariants(dir: string, options: ImportVariantsOptions = {}): Promise<ImportedVariants> {
  const t0 = now();
  const project = await usableProject(dir, 'import drawn variants');
  const { spec, source } = project;
  if (!project.meta) {
    throw new AvatarProjectError('not-found', `${project.dir} is not built yet`, `build it first ("rev2d avatar build ${project.dir}"): the sprites are added to its layers and its model`);
  }
  const only = options.ids && options.ids.length ? normalizeVariantIds(options.ids) : null;
  const inScope = (id: VariantId) => !only || only.includes(id);
  const present = variantFolder(project.dir).filter((f): f is { name: string; id: VariantId } => f.id !== null && inScope(f.id));
  const ignored = ignoredFiles(project.dir, only);
  const before = spritesMeta(project.meta);
  const orphaned = (before?.sprites ?? []).map((s) => s.id).filter((id) => inScope(id) && !present.some((f) => f.id === id));
  if (present.length === 0 && orphaned.length === 0) {
    const scope = only ? ` for ${only.join(', ')}` : '';
    throw new AvatarProjectError(
      'not-found',
      `no drawings to import${scope} in ${path.join(project.dir, 'variants')}`,
      `write the requests ("rev2d avatar variants request ${project.dir}"), draw each variant as its prompt says and save it as variants/<id>.png (${VARIANT_IDS.join(', ')})${ignored.length ? `; ignored: ${ignored.map((i) => i.file).join(', ')}` : ''}`,
    );
  }
  const loadMs = ms(t0);

  let t = now();
  const drawings: Partial<Record<VariantId, ImageRGBA>> = {};
  const unreadable: ImportedVariants['unreadable'] = [];
  for (const f of present) {
    const file = variantFiles(f.id).drawing;
    try {
      drawings[f.id] = (await readPngFile(projectFile(project.dir, file))).image;
    } catch (e) {
      const err = e as AvatarProjectError;
      unreadable.push({ id: f.id, file, reason: err.message.replace(projectFile(project.dir, file), file), ...(err.hint ? { hint: err.hint } : {}) });
    }
  }
  const notes: string[] = [];
  const groups = new Set(Object.keys(drawings).map((id) => VARIANTS[id as VariantId].group));
  const backdrops = await spriteBackdrops(project.dir, spec, project.meta, groups, notes);
  const built = buildSprites(spec, project.meta, source, drawings, { backdrops });
  let meta = built.meta;
  if (unreadable.length) meta = rejectSprites(meta, unreadable.map((u) => ({ id: u.id, drawingHash: null, reason: u.reason, ...(u.hint ? { hint: u.hint } : {}), code: 'unreadable' as const, values: {}, outsideDiff: null, insideChanged: null })));
  const removal = removeSprites(meta, orphaned);
  meta = removal.meta;
  const checkMs = ms(t);

  t = now();
  const model = compileProjectModel(project.dir, spec, meta);
  const compileMs = ms(t);

  t = now();
  const sprites: string[] = [];
  for (const [file, image] of Object.entries(built.images)) {
    await writeIfChanged(project.dir, file, encodePNG(image));
    sprites.push(file);
  }
  const deleted: string[] = [];
  for (const layer of [...built.dropped, ...removal.removed]) {
    if (sprites.includes(layer.file) || meta.layers.some((l) => l.file === layer.file)) continue;
    const abs = projectFile(project.dir, layer.file);
    if (existsSync(abs)) {
      await rm(abs);
      deleted.push(layer.file);
    }
  }
  await writeIfChanged(project.dir, AVATAR_LAYERS_FILE, formatModelJson(meta));
  await writeIfChanged(project.dir, path.basename(model.file), model.text);
  const writeMs = ms(t);

  const rejectedIds = [...built.rejected, ...unreadable.map((u) => u.id)].sort((a, b) => VARIANT_IDS.indexOf(a) - VARIANT_IDS.indexOf(b));
  const kept = [...built.kept, ...unreadable.map((u) => u.id).filter((id) => (before?.sprites ?? []).some((s) => s.id === id))];
  if (project.layersStale) notes.push('the layer images are older than avatar.json (a polygon that cuts layers changed): run "rev2d avatar build" too');
  for (const id of kept) notes.push(`${id}: the drawing was rejected, so the sprite of the earlier accepted drawing stays`);
  for (const c of built.checks) for (const n of c.notes) notes.push(`${c.id}: ${n}`);
  return {
    dir: project.dir,
    name: spec.name,
    checks: built.checks,
    accepted: built.accepted,
    rejected: rejectedIds,
    kept,
    removed: orphaned,
    unreadable,
    ignored,
    variants: (meta.variants as VariantId[]).filter(isVariantId),
    sprites,
    deleted,
    layersFile: project.layersFile,
    modelFile: model.file,
    modelBytes: Buffer.byteLength(model.text, 'utf8'),
    report: model.report,
    diagnostics: model.diagnostics,
    notes,
    timings: { loadMs, checkMs, compileMs, writeMs, totalMs: ms(t0) },
  };
}

// ----------------------------------------------------------------------------- status

export interface VariantStatusEntry extends VariantStatus {
  /** Project-relative paths of the drawing, the mask and the prompt. */
  file: string;
  maskFile: string;
  promptFile: string;
  /** Why the drawing cannot be read (not a PNG, broken), when it exists but is unusable. */
  unreadable?: string;
}

export interface AvatarVariantStatus {
  dir: string;
  name: string | null;
  /** The avatar has layers (sprites can be imported). */
  built: boolean;
  variants: VariantStatusEntry[];
  /** Ids by state. */
  counts: Record<VariantStatus['state'], number>;
  ignored: IgnoredVariantFile[];
  notes: string[];
}

/**
 * The state of every variant of a project: requested (mask + prompt written), drawn (variants/<id>.png
 * exists), accepted (a current sprite), rejected (the last import refused the current drawing, with
 * its reason), stale (the drawing or the landmarks changed since the sprite was cut). Works on a
 * project whose spec has errors (staleness against the landmarks is then not judged).
 */
export interface VariantStatusOptions {
  /**
   * Fingerprints of drawings already read, by absolute path with their file signature (mtime:size):
   * a long-lived caller (the editor server) passes the same map every time, so unchanged drawings are
   * not decoded again.
   */
  cache?: Map<string, { sig: string; hash: string }>;
}

export async function avatarVariantStatus(dir: string, options: VariantStatusOptions = {}): Promise<AvatarVariantStatus> {
  const project = await loadAvatarProject(dir);
  const missing = project.diagnostics.find((d) => d.code === 'file-not-found');
  if (missing) throw new AvatarProjectError('not-found', missing.message, missing.hint);
  const files: Parameters<typeof variantStatuses>[2] = {};
  const unreadable = new Map<VariantId, string>();
  const folder = variantFolder(project.dir);
  for (const id of VARIANT_IDS) {
    const f = variantFiles(id);
    const requested = existsSync(projectFile(project.dir, f.mask));
    let drawing: { hash: string | null } | null = null;
    if (folder.some((x) => x.id === id)) {
      const abs = projectFile(project.dir, f.drawing);
      try {
        const st = statSync(abs);
        const sig = `${st.mtimeMs}:${st.size}`;
        const known = options.cache?.get(abs);
        const hash = known && known.sig === sig ? known.hash : hashImage((await readPngFile(abs)).image);
        options.cache?.set(abs, { sig, hash });
        drawing = { hash };
      } catch (e) {
        drawing = { hash: null };
        unreadable.set(id, (e as Error).message.replace(projectFile(project.dir, f.drawing), f.drawing));
      }
    }
    files[id] = { requested, drawing };
  }
  const statuses = variantStatuses(project.spec, project.meta, files);
  const variants: VariantStatusEntry[] = statuses.map((s) => {
    const f = variantFiles(s.id);
    const u = unreadable.get(s.id);
    const entry: VariantStatusEntry = { ...s, file: f.drawing, maskFile: f.mask, promptFile: f.prompt };
    if (u) {
      entry.unreadable = u;
      if (s.state === 'drawn') entry.state = 'rejected';
    }
    return entry;
  });
  const counts = { missing: 0, requested: 0, drawn: 0, accepted: 0, rejected: 0, stale: 0 } as Record<VariantStatus['state'], number>;
  for (const v of variants) counts[v.state]++;
  const notes: string[] = [];
  if (!project.meta) notes.push('the avatar is not built yet: build it before importing drawings ("rev2d avatar build")');
  if (!project.spec) notes.push('avatar.json has errors: whether sprites match the current landmarks cannot be told ("rev2d avatar validate")');
  if (counts.drawn) notes.push(`${counts.drawn} drawing${counts.drawn === 1 ? ' is' : 's are'} not imported yet: "rev2d avatar variants import"`);
  if (counts.stale) notes.push(`${counts.stale} sprite${counts.stale === 1 ? ' is' : 's are'} stale: import again`);
  const name = project.doc !== null && typeof project.doc === 'object' ? (project.doc as { name?: unknown }).name : undefined;
  return { dir: project.dir, name: typeof name === 'string' ? name : null, built: project.meta !== null, variants, counts, ignored: ignoredFiles(project.dir, null), notes };
}

/** Labels for messages: "eyes_closed (Eyes closed)". */
export function variantLabel(id: VariantId): string {
  return `${id} (${VARIANTS[id].label})`;
}
