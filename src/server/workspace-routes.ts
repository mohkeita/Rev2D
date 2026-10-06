/**
 * Workspace endpoints of the editor protocol (file management; see the "workspace" section of
 * src/node/editor-registry.ts): list, open, new, save as, close, import (Rev2D models, and Spine exports
 * converted on the way), download and templates. Open also takes an avatar project (its avatar.json or
 * its folder; avatar-routes.ts), and the listing marks the avatar projects.
 * Every request path goes through WorkspaceRoot, so nothing outside the workspace root is read or
 * written. Operations that switch the open model run one at a time (ApiContext.exclusive).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Diagnostic } from '../core/types.js';
import { suggest } from '../core/address.js';
import { formatModelJson } from '../core/format.js';
import { parseJsonc, parseModelText } from '../core/validate.js';
import type { AvatarOpenResult, OpenResult, WorkspaceInfo } from '../node/editor-registry.js';
import { BUILTIN_TEMPLATES, EXAMPLES_DIR, listTemplates, loadTemplate } from '../api/templates.js';
import { isAtlasName, looksLikeSpineSkeleton } from '../interop/detect.js';
import type { InteropReport } from '../interop/types.js';
import { InteropError, countsText, importSpineUpload, issueLine, spineModelText } from '../node/interop.js';
import { avatarOpenTarget, avatarProjectAt, markAvatarProjects, openAvatarAlone } from './avatar-routes.js';
import { HttpError, readJson, sendJson } from './http.js';
import { ModelStore } from './model-store.js';
import { parseImportRequest, parseNewRequest, parseOpenRequest, parseSaveAsRequest } from './protocol.js';
import type { ApiContext, FileOrigin } from './routes.js';
import { MODEL_NAME, checkNameSegment, listDirectory, rewriteTexturePaths, samePath, templateInfos, withModelExtension } from './workspace.js';

/** Largest file POST /api/open inspects when its name does not say it is a model. */
const MAX_SNIFF_BYTES = 64 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const NO_MODEL_HINT =
  'open one first: POST /api/open {"file"} (GET /api/files lists the workspace), POST /api/new {"file", "template"} or POST /api/import; ' +
  'CLI: rev2d editor command --open <file>; MCP: rev2d_editor_command {"type": "open", "file"}';

/** The open model, or 409 {error: "no model is open", hint}. */
export function requireStore(ctx: ApiContext): ModelStore {
  if (!ctx.store) throw new HttpError(409, 'no model is open', NO_MODEL_HINT);
  return ctx.store;
}

export function workspaceInfo(ctx: ApiContext): WorkspaceInfo {
  const avatar = ctx.avatar.ref();
  return {
    root: ctx.root.dir,
    current: ctx.store?.file ?? null,
    recent: ctx.recent.list().filter((f) => ctx.root.containsSync(f)),
    ...(avatar ? { avatar } : {}),
  };
}

const stripBom = (text: string) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
const usesCrlf = (text: string) => {
  const nl = text.indexOf('\n');
  return nl > 0 && text[nl - 1] === '\r';
};
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** "2048 bytes", "25.0 MB". */
const sizeText = (n: number) => (n < 1024 * 1024 ? `${n} bytes` : `${(n / (1024 * 1024)).toFixed(1)} MB`);

function isRev2dObject(v: unknown): boolean {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && (v as { format?: unknown }).format === 'rev2d';
}

const errorsOf = (diags: Diagnostic[]) => diags.filter((d) => d.severity === 'error');

/** Note for a model written or opened with validation errors (it still opens: the editor lists them). */
function errorNote(shown: string, text: string): string[] {
  const n = errorsOf(parseModelText(text).diagnostics).length;
  return n ? [`${shown} has ${plural(n, 'validation error')}; the editor lists them under Problems`] : [];
}

async function writeOut(ctx: ApiContext, abs: string, data: string | Uint8Array): Promise<void> {
  try {
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, data);
  } catch (e) {
    throw new HttpError(500, `cannot write ${ctx.root.rel(abs)}: ${(e as Error).message}`, 'check that the directory is writable and the file is not locked by another program');
  }
}

// ----------------------------------------------------------------------------- read-only

export function getWorkspace(ctx: ApiContext, _req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 200, workspaceInfo(ctx));
}

export async function getFiles(ctx: ApiContext, _req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  sendJson(res, 200, await markAvatarProjects(ctx.root, await listDirectory(ctx.root, url.searchParams.get('dir') ?? '')));
}

export function getTemplates(_ctx: ApiContext, _req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 200, templateInfos());
}

/** RFC 6266 attachment header with an ASCII fallback and the exact UTF-8 name. */
function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\%]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

export async function getDownload(ctx: ApiContext, _req: IncomingMessage, res: ServerResponse): Promise<void> {
  const store = requireStore(ctx);
  const { text } = await store.read();
  const body = Buffer.from(text, 'utf8');
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Content-Disposition': contentDisposition(path.basename(store.file)),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

// ----------------------------------------------------------------------------- open

/** 422 unless the file holds a Rev2D model (for files not named *.r2d.json). */
async function requireModelContent(abs: string, shown: string, size: number): Promise<void> {
  const hint = 'a model file is a JSON object with "format": "rev2d" (conventionally named *.r2d.json)';
  if (size > MAX_SNIFF_BYTES) throw new HttpError(422, `${shown} is not a Rev2D model (${size} bytes, too large to be one)`, hint);
  const text = stripBom((await readFile(abs)).toString('utf8'));
  const parsed = parseJsonc(text);
  if (!parsed.ok) throw new HttpError(422, `${shown} is not a Rev2D model: it is not valid JSON`, hint, { diagnostics: [parsed.error] });
  if (!isRev2dObject(parsed.value)) {
    throw new HttpError(422, `${shown} is not a Rev2D model`, hint, { diagnostics: errorsOf(parseModelText(text).diagnostics).slice(0, 20) });
  }
}

/**
 * Open an existing model file of the workspace and make it the current model. The caller holds
 * ctx.exclusive. Files named *.r2d.json open even with errors (the editor lists them); other files
 * must hold a Rev2D model.
 */
async function openModel(ctx: ApiContext, requested: string, origin: FileOrigin, notes: string[] = []): Promise<{ result: OpenResult; delivered: number }> {
  const abs = await ctx.root.resolve(requested, 'file');
  const shown = ctx.root.rel(abs) || '.';
  const st = await stat(abs).catch(() => null);
  if (!st) throw new HttpError(404, `file not found: ${shown}`, 'GET /api/files lists the workspace (paths are relative to its root); POST /api/new creates a model');
  if (st.isDirectory()) {
    throw new HttpError(400, `${shown} is a directory, not a model file`, `GET /api/files?dir=${encodeURIComponent(ctx.root.rel(abs))} lists the files in it`);
  }
  if (!MODEL_NAME.test(abs)) await requireModelContent(abs, shown, st.size);
  let store: ModelStore;
  try {
    store = await ModelStore.open(abs);
  } catch (e) {
    throw new HttpError(500, (e as Error).message);
  }
  const { text, mtimeMs } = await store.read();
  const delivered = await ctx.switchTo(store, origin);
  // A model in an avatar project's folder opens that project with it (avatar mode).
  const avatar = ctx.avatar.ref();
  return { result: { file: store.file, text, mtimeMs, notes: [...notes, ...errorNote(shown, text)], ...(avatar ? { avatar } : {}) }, delivered };
}

/**
 * What POST /api/open and the "open" command open: a model file, or an avatar project named by its
 * avatar.json or its folder. A project opens with its built model; while it has none, the project
 * is open without a model (AvatarOpenResult). The caller holds ctx.exclusive.
 */
async function openTarget(ctx: ApiContext, requested: string, origin: FileOrigin): Promise<{ result: OpenResult | AvatarOpenResult; delivered: number }> {
  const abs = await ctx.root.resolve(requested, 'file');
  const st = await stat(abs).catch(() => null);
  const project = st ? await avatarProjectAt(abs, st) : null;
  if (!project) return openModel(ctx, requested, origin);
  const target = await avatarOpenTarget(ctx.root, project);
  if (target.model === null) return openAvatarAlone(ctx, target.ref, origin, target.note ? [target.note] : []);
  return openModel(ctx, target.model, origin, [`opened the built model of the avatar project ${ctx.root.rel(project) || '.'}`]);
}

export async function postOpen(ctx: ApiContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { file } = parseOpenRequest(await readJson(req, ctx.maxBodyBytes));
  const { result } = await ctx.exclusive(() => openTarget(ctx, file, 'editor'));
  sendJson(res, 200, result);
}

/** EditorCommand {type: "open"}: open on behalf of an AI; the tabs follow through "file-changed". */
export function openCommand(ctx: ApiContext, file: string): Promise<{ result: OpenResult | AvatarOpenResult; delivered: number }> {
  return ctx.exclusive(() => openTarget(ctx, file, 'ai'));
}

export async function postClose(ctx: ApiContext, _req: IncomingMessage, res: ServerResponse): Promise<void> {
  await ctx.exclusive(() => ctx.switchTo(null, 'editor'));
  sendJson(res, 200, workspaceInfo(ctx));
}

// ----------------------------------------------------------------------------- new

export async function postNew(ctx: ApiContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const r = parseNewRequest(await readJson(req, ctx.maxBodyBytes));
  const template = r.template ?? 'blank';
  const templates = listTemplates();
  if (!templates.includes(template)) {
    throw new HttpError(400, `unknown template "${template}"`, `${suggest(template, templates) ?? ''} templates: ${templates.join(', ')} (GET /api/templates describes them)`.trim());
  }
  const { file: requested, appended } = withModelExtension(r.file);
  const result = await ctx.exclusive(async () => {
    const abs = await ctx.root.resolveNew(requested, 'file');
    const shown = ctx.root.rel(abs);
    const existing = await stat(abs).catch(() => null);
    if (existing?.isDirectory()) throw new HttpError(400, `${shown || '.'} is a directory`, `give the new model's file path, e.g. "${shown ? `${shown}/` : ''}hero.r2d.json"`);
    if (existing && !r.overwrite) throw new HttpError(409, `${shown} already exists`, 'pass "overwrite": true to replace it, choose another name, or open it with POST /api/open');
    const notes: string[] = [];
    if (appended) notes.push(`added the model file extension: ${shown}`);
    if (!(BUILTIN_TEMPLATES as readonly string[]).includes(template) && (r.width !== undefined || r.height !== undefined)) {
      notes.push(`width/height apply only to the ${BUILTIN_TEMPLATES.map((t) => `"${t}"`).join(' and ')} templates; the example keeps its canvas size`);
    }
    const name = r.name?.trim() || path.basename(abs).replace(/(\.r2d)?\.jsonc?$/i, '') || 'untitled';
    const { doc, textureFiles } = loadTemplate(template, { name, width: r.width, height: r.height });
    // Example textures are copied next to the model, keeping their paths relative to it.
    const srcDir = path.join(EXAMPLES_DIR, template);
    const copies: Array<{ dest: string; bytes: Buffer }> = [];
    const shared: string[] = [];
    const clashes: string[] = [];
    for (const src of textureFiles) {
      const dest = await ctx.root.resolveNew(path.join(path.dirname(abs), path.relative(srcDir, src)), 'texture');
      const bytes = await readFile(src).catch(() => {
        throw new HttpError(500, `template texture is missing: ${src}`, 'the installation looks incomplete; reinstall rev2d');
      });
      const current = await readFile(dest).catch(() => null);
      if (current?.equals(bytes)) shared.push(ctx.root.rel(dest));
      else if (current && !r.overwrite) clashes.push(ctx.root.rel(dest));
      else copies.push({ dest, bytes });
    }
    if (clashes.length) {
      throw new HttpError(409, `different texture files already exist: ${clashes.join(', ')}`, 'pass "overwrite": true to replace them, or create the model in another directory');
    }
    await writeOut(ctx, abs, formatModelJson(doc));
    for (const c of copies) await writeOut(ctx, c.dest, c.bytes);
    notes.unshift(`created ${shown} from template "${template}"`);
    if (copies.length) notes.push(`copied textures: ${copies.map((c) => ctx.root.rel(c.dest)).join(', ')}`);
    if (shared.length) notes.push(`reused identical textures: ${shared.join(', ')}`);
    if (!MODEL_NAME.test(abs)) notes.push('model files are conventionally named *.r2d.json');
    return (await openModel(ctx, abs, 'editor', notes)).result;
  });
  sendJson(res, 200, result);
}

// ----------------------------------------------------------------------------- save as

export async function postSaveAs(ctx: ApiContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const r = parseSaveAsRequest(await readJson(req, ctx.maxBodyBytes));
  const { file: requested, appended } = withModelExtension(r.file);
  const result = await ctx.exclusive(async () => {
    const store = requireStore(ctx);
    const abs = await ctx.root.resolveNew(requested, 'file');
    const shown = ctx.root.rel(abs);
    const existing = await stat(abs).catch(() => null);
    if (existing?.isDirectory()) throw new HttpError(400, `${shown || '.'} is a directory`, `give the file path to save to, e.g. "${shown ? `${shown}/` : ''}copy.r2d.json"`);
    if (existing && !r.overwrite && !samePath(abs, store.file)) {
      throw new HttpError(409, `${shown} already exists`, 'pass "overwrite": true to replace it, or choose another name');
    }
    const notes: string[] = [];
    if (appended) notes.push(`added the model file extension: ${shown}`);
    // The open file: the source when neither doc nor text is sent, and the line-ending style otherwise.
    const current = r.doc === undefined && r.text === undefined ? await store.read() : await store.read().catch(() => null);
    const toDir = path.dirname(abs);
    let out: string;
    if (r.doc !== undefined) {
      const doc = structuredClone(r.doc);
      notes.push(...rewriteTexturePaths(doc, store.dir, toDir).notes);
      out = formatModelJson(doc);
      if (current && usesCrlf(current.text)) out = out.replace(/\n/g, '\r\n');
    } else {
      const text = r.text ?? current!.text;
      const parsed = parseJsonc(stripBom(text));
      if (!parsed.ok) {
        throw new HttpError(422, 'the model text has a JSON syntax error; nothing was written', 'fix the syntax error first (see diagnostics), or send the model object as "doc"', {
          diagnostics: [parsed.error],
        });
      }
      // Text already in the standard format loses nothing when it is rewritten with new paths.
      const formatted = formatModelJson(parsed.value) === stripBom(text).replace(/\r\n/g, '\n');
      const rewrite = rewriteTexturePaths(parsed.value, store.dir, toDir);
      notes.push(...rewrite.notes);
      if (rewrite.changed) {
        out = formatModelJson(parsed.value);
        if (usesCrlf(text)) out = out.replace(/\n/g, '\r\n');
        if (!formatted) notes.push('the text was reformatted to rewrite its texture paths (comments and custom formatting are not kept)');
      } else {
        out = text;
      }
    }
    await writeOut(ctx, abs, out);
    notes.unshift(`saved as ${shown}`);
    if (!MODEL_NAME.test(abs)) notes.push('model files are conventionally named *.r2d.json');
    return (await openModel(ctx, abs, 'editor', notes)).result;
  });
  sendJson(res, 200, result);
}

// ----------------------------------------------------------------------------- import

const DATA_URL = /^data:[^,]*;base64,/i;
const BASE64 = /^[A-Za-z0-9+/_-]*={0,2}$/;

function decodeBase64(raw: string, name: string): Buffer {
  const b64 = raw.replace(DATA_URL, '').replace(/\s+/g, '');
  if (!BASE64.test(b64)) throw new HttpError(400, `invalid import request: ${JSON.stringify(name)} is not valid base64`, 'send PNG bytes base64-encoded (a data: URL is accepted too)');
  return Buffer.from(b64, 'base64');
}

interface ImportFile {
  name: string;
  segments: string[];
  bytes: Buffer;
  abs?: string;
}

/** Warning lines of a conversion report shown in the import notes (the answer's `report` has all). */
const REPORT_NOTE_LINES = 6;

/**
 * Write `files` into the import folder `dir`: files identical to what is there are fine, different
 * ones are refused (409 naming them) unless `overwrite`; nothing is written when any check fails.
 * The caller holds ctx.exclusive.
 */
async function writeImport(ctx: ApiContext, dir: string, files: ImportFile[], overwrite: boolean | undefined, notes: string[]): Promise<ImportFile[]> {
  const written: ImportFile[] = [];
  const clashes: string[] = [];
  for (const f of files) {
    f.abs = await ctx.root.resolveNew(path.join(dir, ...f.segments), 'files');
    const st = await stat(f.abs).catch(() => null);
    if (st?.isDirectory()) throw new HttpError(400, `${ctx.root.rel(f.abs)} is a directory`, 'rename the file, or import into another directory');
    const current = st ? await readFile(f.abs).catch(() => null) : null;
    if (current?.equals(f.bytes)) notes.push(`${ctx.root.rel(f.abs)} is already there (identical)`);
    else if (current && !overwrite) clashes.push(ctx.root.rel(f.abs));
    else written.push(f);
  }
  if (clashes.length) {
    throw new HttpError(409, `files already exist: ${clashes.join(', ')}; nothing was imported`, 'pass "overwrite": true to replace them, or import into another directory ("dir")');
  }
  for (const f of written) await writeOut(ctx, f.abs!, f.bytes);
  return written;
}

/**
 * A Spine export (skeleton JSON + atlas + PNG pages) among the imported files: converted into
 * <skeleton name>.r2d.json with its pages in textures/, written into the import folder and opened.
 * The answer carries the conversion report; the notes summarize it.
 */
async function importSpineExport(
  ctx: ApiContext,
  r: { dir?: string; overwrite?: boolean },
  skeleton: ImportFile,
  atlases: ImportFile[],
  images: ImportFile[],
  notes: string[],
): Promise<OpenResult & { report: InteropReport }> {
  let conv: ReturnType<typeof importSpineUpload>;
  try {
    conv = importSpineUpload(
      { name: skeleton.name, text: stripBom(skeleton.bytes.toString('utf8')) },
      atlases.map((a) => ({ name: a.name, text: stripBom(a.bytes.toString('utf8')) })),
      images.map((i) => ({ name: i.name, bytes: i.bytes })),
    );
  } catch (e) {
    if (e instanceof InteropError) throw new HttpError(e.kind === 'usage' ? 400 : 422, `${e.message}; nothing was imported`, e.hint);
    throw e;
  }
  const stem = skeleton.segments[skeleton.segments.length - 1].replace(/\.jsonc?$/i, '') || 'spine';
  const modelSegments = [...skeleton.segments.slice(0, -1), `${stem}.r2d.json`];
  const modelFile: ImportFile = { name: modelSegments.join('/'), segments: modelSegments, bytes: Buffer.from(spineModelText(conv.doc), 'utf8') };
  const textures: ImportFile[] = conv.files.map((f) => {
    const segments = [...skeleton.segments.slice(0, -1), ...f.path.split('/')];
    for (const seg of segments) checkNameSegment(seg, 'a converted texture name');
    return { name: segments.join('/'), segments, bytes: Buffer.from(f.bytes ?? Buffer.from(f.text ?? '', 'utf8')) };
  });
  return ctx.exclusive(async () => {
    const dir = await ctx.root.resolveNew(r.dir ?? '', 'dir');
    const dirShown = ctx.root.rel(dir);
    const dirStat = await stat(dir).catch(() => null);
    if (dirStat && !dirStat.isDirectory()) throw new HttpError(400, `${dirShown} is a file, not a directory`, 'import into a directory ("dir" relative to the workspace root)');
    const own: string[] = [];
    const written = await writeImport(ctx, dir, [modelFile, ...textures], r.overwrite, own);
    const stats = conv.report.stats;
    const warnings = conv.report.issues.filter((i) => i.severity === 'warning');
    const head = [
      `imported Spine skeleton ${skeleton.name} as ${ctx.root.rel(modelFile.abs!)}: ${plural(stats.bones ?? 0, 'bone')}, ${plural(stats.parts ?? 0, 'part')}, ${plural(stats.animations ?? 0, 'animation')}`,
      `conversion report: ${countsText(conv.report)}`,
      ...warnings.slice(0, REPORT_NOTE_LINES).map((w) => issueLine(w)),
      ...(warnings.length > REPORT_NOTE_LINES ? [`... ${warnings.length - REPORT_NOTE_LINES} more warnings in the conversion report`] : []),
    ];
    const tail = [...conv.notes, ...notes, ...own, written.length ? `wrote ${written.map((f) => ctx.root.rel(f.abs!)).join(', ')}` : 'nothing new was written'];
    const { result } = await openModel(ctx, modelFile.abs!, 'editor', [...head, ...tail]);
    return { ...result, report: conv.report };
  });
}

export async function postImport(ctx: ApiContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const r = parseImportRequest(await readJson(req, ctx.maxImportBytes));
  const notes: string[] = [];
  const models: ImportFile[] = [];
  const images: ImportFile[] = [];
  const atlases: ImportFile[] = [];
  const seen = new Set<string>();
  r.files.forEach((f, i) => {
    const segments = f.name.split('/');
    for (const s of segments) checkNameSegment(s, `files.${i}.name`);
    const key = segments.join('/').toLowerCase();
    if (seen.has(key)) throw new HttpError(400, `invalid import request: ${JSON.stringify(f.name)} is listed twice`, 'send each file once');
    seen.add(key);
    const bytes = f.base64 !== undefined ? decodeBase64(f.base64, f.name) : Buffer.from(f.text!, 'utf8');
    if (/\.jsonc?$/i.test(f.name)) {
      models.push({ name: f.name, segments, bytes });
    } else if (/\.png$/i.test(f.name)) {
      if (bytes.length < 8 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
        throw new HttpError(422, `${f.name} is not a PNG file; nothing was imported`, 'only PNG textures are supported');
      }
      images.push({ name: f.name, segments, bytes });
    } else if (isAtlasName(f.name)) {
      atlases.push({ name: f.name, segments, bytes });
    } else {
      notes.push(`skipped ${f.name}: only a model (.json) with its PNG textures, or a Spine export (.json + .atlas + PNG pages), is imported`);
    }
  });
  if (models.length !== 1) {
    throw new HttpError(
      400,
      models.length ? `import one model at a time (got ${models.map((m) => m.name).join(', ')})` : 'no model file among the imported files',
      'send exactly one model file (*.r2d.json or *.json) plus the PNG textures it uses, or one Spine skeleton .json with its .atlas and PNG pages',
    );
  }
  const model = models[0];
  if (model.bytes.length > ctx.maxBodyBytes) {
    throw new HttpError(413, `${model.name} is ${sizeText(model.bytes.length)}; the editor saves models of at most ${sizeText(ctx.maxBodyBytes)}`, 'move large embedded (data:) textures into PNG files next to the model');
  }
  const text = model.bytes.toString('utf8');
  const parsed = parseJsonc(stripBom(text));
  if (!parsed.ok) throw new HttpError(422, `${model.name} is not valid JSON; nothing was imported`, 'fix the syntax error (see diagnostics) and import it again', { diagnostics: [parsed.error] });
  if (!isRev2dObject(parsed.value)) {
    if (looksLikeSpineSkeleton(parsed.value)) {
      sendJson(res, 200, await importSpineExport(ctx, r, model, atlases, images, notes));
      return;
    }
    throw new HttpError(
      422,
      `${model.name} is not a Rev2D model; nothing was imported`,
      'a model file is a JSON object with "format": "rev2d" (see diagnostics); a Spine skeleton export (JSON with "skeleton" and "bones") is converted',
      { diagnostics: errorsOf(parseModelText(text).diagnostics).slice(0, 20) },
    );
  }
  for (const a of atlases) notes.push(`skipped ${a.name}: an atlas belongs to a Spine skeleton, and ${model.name} is a Rev2D model`);

  const result = await ctx.exclusive(async () => {
    const dir = await ctx.root.resolveNew(r.dir ?? '', 'dir');
    const dirShown = ctx.root.rel(dir);
    const dirStat = await stat(dir).catch(() => null);
    if (dirStat && !dirStat.isDirectory()) throw new HttpError(400, `${dirShown} is a file, not a directory`, 'import into a directory ("dir" relative to the workspace root)');
    const written = await writeImport(ctx, dir, [model, ...images], r.overwrite, notes);
    const modelAbs = model.abs!;
    // Textures the model references that are neither imported nor already there.
    const textures = (parsed.value as { textures?: unknown }).textures;
    for (const t of Array.isArray(textures) ? textures : []) {
      const tex = t as { id?: unknown; path?: unknown };
      if (typeof tex?.path !== 'string' || !tex.path || tex.path.startsWith('data:')) continue;
      const target = path.resolve(path.dirname(modelAbs), tex.path);
      if (!(await stat(target).catch(() => null))) {
        notes.push(`texture "${String(tex.id)}" (${tex.path}) was not imported and does not exist next to the model; import the PNG too, or fix the path`);
      }
    }
    notes.unshift(`imported ${written.length ? written.map((f) => ctx.root.rel(f.abs!)).join(', ') : 'nothing new'} into ${dirShown || 'the workspace root'}`);
    return (await openModel(ctx, modelAbs, 'editor', notes)).result;
  });
  sendJson(res, 200, result);
}
