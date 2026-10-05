/**
 * Interop endpoints of the editor protocol (Spine exports are imported through POST /api/import, see
 * workspace-routes.ts):
 *
 *   POST /api/live2d-import  Live2dImportRequest -> Live2dImportResponse: Live2D JSON files converted
 *                            into ops and applied to the editor's document (or the open file). Nothing
 *                            is written: the editor writes the resulting doc as one undoable edit.
 *   POST /api/export         ExportRequest -> ExportResponse: the open model (or the editor's
 *                            document) as Spine or Live2D files in a folder of the workspace; 409
 *                            naming the files when different ones exist and `overwrite` is not set.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { suggest } from '../core/address.js';
import { formatModelJson } from '../core/format.js';
import { parseJsonc } from '../core/validate.js';
import { hasErrors, loadModelObject } from '../node/load.js';
import {
  InteropError,
  convertLive2dSources,
  exportLive2dToDir,
  exportSpineToDir,
  paramMapFromSpec,
  type ExportResponse,
  type Live2dImportResponse,
  type Live2dSource,
} from '../node/interop.js';
import { applyOps } from '../ops/index.js';
import { HttpError, readJson, sendJson } from './http.js';
import { parseExportRequest, parseLive2dImportRequest } from './protocol.js';
import type { ApiContext } from './routes.js';
import { requireStore } from './workspace-routes.js';

const stripBom = (text: string) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/** InteropError -> HttpError (usage 400, not-found 404, exists 409, invalid 422). */
function httpError(e: unknown): unknown {
  if (!(e instanceof InteropError)) return e;
  const status = e.kind === 'usage' ? 400 : e.kind === 'not-found' ? 404 : e.kind === 'exists' ? 409 : 422;
  return new HttpError(status, e.message, e.hint, e.diagnostics.length ? { diagnostics: e.diagnostics } : {});
}

/** Comparable '/'-separated, lower-case form of an uploaded file name. */
const key = (name: string) => path.posix.normalize(name.replace(/\\/g, '/')).toLowerCase();

/**
 * The uploaded file a model3.json refers to: by its path relative to the model3 file, else by file
 * name when exactly one uploaded file has it (a browser file picker only yields bare names).
 */
function findReferenced(sources: Live2dSource[], ref: string, model3: Live2dSource): Live2dSource | undefined {
  const wanted = key(path.posix.join(path.posix.dirname(model3.name.replace(/\\/g, '/')), ref));
  const exact = sources.find((s) => key(s.name) === wanted);
  if (exact) return exact;
  const base = wanted.split('/').pop();
  const byName = sources.filter((s) => key(s.name).split('/').pop() === base);
  return byName.length === 1 ? byName[0] : undefined;
}

export async function postLive2dImport(ctx: ApiContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const r = parseLive2dImportRequest(await readJson(req, ctx.maxImportBytes));
  const store = requireStore(ctx);
  let doc: Record<string, unknown>;
  if (r.doc !== undefined) {
    // An object: checked by parseLive2dImportRequest.
    doc = r.doc as Record<string, unknown>;
  } else {
    const { text } = await store.read();
    const parsed = parseJsonc(stripBom(text));
    if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
      throw new HttpError(422, 'the open model is not valid JSON; fix its syntax first', 'GET /api/info shows the error location');
    }
    doc = parsed.value as Record<string, unknown>;
  }
  const paramIds = (Array.isArray(doc.parameters) ? doc.parameters : []).map((p) => String((p as { id?: unknown }).id));
  const sources: Live2dSource[] = r.files.map((f) => ({ name: f.name, text: stripBom(f.text) }));
  let conv: ReturnType<typeof convertLive2dSources>;
  try {
    conv = convertLive2dSources(sources, doc, (ref, m3) => findReferenced(sources, ref, m3), {
      paramMap: paramMapFromSpec(r.paramMap, paramIds, store.dir),
      id: r.id,
      physics: r.physics,
      displayInfo: r.displayInfo,
      motions: r.motions,
      expressions: r.expressions,
    });
  } catch (e) {
    throw httpError(e);
  }
  const applied = applyOps(doc, conv.ops);
  const changed = applied.ok && formatModelJson(applied.doc) !== formatModelJson(doc);
  const body: Live2dImportResponse = {
    ok: applied.ok,
    changed,
    doc: applied.doc,
    results: applied.results,
    diagnostics: applied.diagnostics,
    report: conv.report,
    summary: conv.summary,
    sources: conv.sources.map((s) => ('via' in s ? { file: s.name, kind: s.kind, via: s.via } : { file: s.name, kind: s.kind })),
  };
  sendJson(res, 200, body);
}

export async function postExport(ctx: ApiContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const r = parseExportRequest(await readJson(req, ctx.maxBodyBytes));
  const store = requireStore(ctx);
  const loaded = r.doc !== undefined ? await loadModelObject(r.doc, store.dir, store.file) : await store.loaded();
  if (!loaded.model || !loaded.rig || hasErrors(loaded.diagnostics)) {
    throw new HttpError(422, 'the model has errors and cannot be exported', 'fix them first (the Problems panel lists them)', {
      diagnostics: loaded.diagnostics.filter((d) => d.severity === 'error').slice(0, 20),
    });
  }
  const model = loaded.model;
  const ids = model.animations.map((a) => a.id);
  const unknown = (r.animations ?? []).filter((a) => !ids.includes(a));
  if (unknown.length) {
    throw new HttpError(400, `unknown animation${unknown.length === 1 ? '' : 's'} ${unknown.map((u) => JSON.stringify(u)).join(', ')}`, suggest(unknown[0], ids) ?? `animations: ${ids.join(', ') || 'none'}`);
  }
  const stem = path.basename(store.file).replace(/(\.r2d)?\.jsonc?$/i, '') || 'model';
  const requested = r.dir ?? `exports/${stem}-${r.format}`;
  const result = await ctx.exclusive(async (): Promise<ExportResponse> => {
    const dir = await ctx.root.resolveNew(requested, 'dir');
    const shown = ctx.root.rel(dir) || '.';
    try {
      const out =
        r.format === 'spine'
          ? await exportSpineToDir(
              { model, rig: loaded.rig!, textures: loaded.textures },
              dir,
              {
                animations: r.animations,
                fps: r.fps,
                name: r.name,
                tolerance: r.tolerance,
                textureScale: r.textureScale,
                paramPoses: r.paramPoses,
                premultipliedAlpha: r.premultipliedAlpha,
              },
              { overwrite: r.overwrite ?? false },
            )
          : await exportLive2dToDir(
              model,
              dir,
              {
                animations: r.animations,
                fps: r.fps,
                name: r.name,
                tolerance: r.tolerance,
                paramMap: paramMapFromSpec(r.paramMap, model.parameters.map((p) => p.id), store.dir),
              },
              { overwrite: r.overwrite ?? false },
            );
      const changed = out.files.filter((f) => f.status !== 'unchanged').length;
      const notes = [
        `exported ${path.basename(store.file)} to ${r.format === 'spine' ? 'Spine' : 'Live2D'} in ${shown}: ${out.files.length} file${out.files.length === 1 ? '' : 's'}${changed < out.files.length ? ` (${out.files.length - changed} unchanged)` : ''}`,
        r.format === 'spine'
          ? `load ${out.files.find((f) => f.rel.endsWith('.json'))?.rel ?? 'the .json'} with its .atlas in a Spine runtime or the Spine editor (Import Data); pages are ${r.premultipliedAlpha === false ? 'straight alpha' : 'premultiplied (pma: true)'}`
          : 'copy the files into a Live2D model folder (a model built in Cubism Editor whose parameter ids match) and merge the FileReferences of the .model3.json into its model3.json',
      ];
      return { dir, files: out.files.map((f) => ({ path: f.path, status: f.status, bytes: f.bytes })), report: out.report, notes };
    } catch (e) {
      if (e instanceof InteropError && e.kind === 'exists') {
        const rel = e.files.map((f) => ctx.root.rel(f));
        throw new HttpError(409, `files already exist: ${rel.join(', ')}; nothing was exported`, 'pass "overwrite": true to replace them, or export into another folder ("dir")', { files: rel });
      }
      throw httpError(e);
    }
  });
  sendJson(res, 200, result);
}
