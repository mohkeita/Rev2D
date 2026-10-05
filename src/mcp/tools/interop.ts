/**
 * Interop tools: rev2d_import (a Spine skeleton export -> a new model; Live2D motion3 / exp3 /
 * physics3 / cdi3 / model3 files -> ops applied to a model) and rev2d_export (a model -> Spine JSON +
 * atlas + PNG pages, or Live2D motion3 / physics3 / cdi3 / model3 JSON). File IO and the conversion
 * reports come from src/node/interop.ts; see docs/INTEROP.md.
 */
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { formatDiagnostics } from '../../core/validate.js';
import { hasErrors, loadModelFile } from '../../node/load.js';
import {
  InteropError,
  applyOpsToModelFile,
  convertLive2dSources,
  diskReferenceReader,
  exportLive2dToDir,
  exportSpineToDir,
  importSpineFile,
  paramMapFromSpec,
  readLive2dSource,
  readModelDoc,
  reportLines,
  skeletonStem,
  spineModelText,
  summaryText,
  writeOutputFiles,
  type WrittenFile,
} from '../../node/interop.js';
import type { InteropReport, SpineExportOptions } from '../../interop/types.js';
import { addTool, displayPath, json, loadModel, requireKnownIds, resolvePath, result, text, ToolError, withFileLock, type ToolContext } from '../context.js';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Issue lines in the result text (the JSON block always has every issue). */
const MAX_REPORT_LINES = 80;

/** InteropError -> ToolError (with the MCP spelling of the fix for existing files). */
async function guarded(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof InteropError) {
      throw new ToolError(e.message, e.diagnostics, e.kind === 'exists' ? 'pass overwrite: true to replace them, or write into another directory' : e.hint);
    }
    throw e;
  }
}

function reportText(report: InteropReport): string[] {
  return reportLines(report, { max: MAX_REPORT_LINES });
}

function filesText(ctx: ToolContext, files: WrittenFile[]): string {
  return files.map((f) => `${displayPath(ctx, f.path)} (${f.status}, ${f.bytes} bytes)`).join(', ');
}

function filesJson(files: WrittenFile[]) {
  return files.map((f) => ({ path: f.path, status: f.status, bytes: f.bytes }));
}

const paramMapField = z
  .union([z.string().min(1), z.record(z.string(), z.string())])
  .optional()
  .describe(
    'Live2D parameter id mapping: "standard" (default: AngleX <-> ParamAngleX, MouthOpen <-> ParamMouthOpenY, ...), "none" (ids unchanged), "prefix" ("Param" + id), an object {"<Rev2D id>": "<Live2D id>"} merged over the standard preset, or the path of a JSON file holding one.',
  );

const IMPORT_DESCRIPTION =
  'Convert files from other 2D animation tools. Every approximated or dropped feature is listed in the report (stable code, where, hint); the text shows it, the JSON block has every issue. ' +
  'format "spine": path = a Spine 3.8-4.2 skeleton JSON export; its atlas (atlas option, default <name>.atlas / .atlas.txt next to it) and PNG pages are read and a NEW model is written to `out` (default <skeleton name>.r2d.json next to it) with the pages in textures/ next to it; overwrite: true replaces existing files. ' +
  'Bones map with y flipped and angles clockwise, slots become textured mesh parts in draw order, weighted meshes skinned parts, clipping masks, animations absolute tracks; shear, inheritance modes, transform constraints and image sequences are emulated; path/physics constraints, two-color tint and other skins are reported. ' +
  'format "live2d": path = one or more .motion3.json (-> animation), .exp3.json (-> one-key animation for "add" layering), .physics3.json (-> physics groups, an approximation), .cdi3.json (-> parameter names/groups) or one .model3.json (everything it lists; the proprietary .moc3 model binary is never read); ' +
  '`into` = the Rev2D model they are imported into, as ops applied atomically (all apply and the result validates, or nothing is written; dry_run: report only). Parameter ids are mapped with param_map; curves for unknown parameters are dropped and reported with a did-you-mean. ' +
  'An existing animation with the same id is replaced (a warning in the report when it was made in Rev2D, not by an earlier import: rename it first or pass id); physics "replace" (default) removes model groups driving the same parameters, "merge" keeps them. ' +
  'After an import, check the result: rev2d_validate, rev2d_render, rev2d_sheet {animation}. Details: rev2d_docs {topic: "interop"}.';

const EXPORT_DESCRIPTION =
  'Export a model for other tools into out_dir (created; files of an earlier export are replaced; the result lists each file as new, replaced or unchanged). Every approximation is listed in the report. ' +
  'format "spine": <name>.json (Spine 4.x skeleton), <name>.atlas and PNG pages (premultiplied alpha unless premultiplied_alpha: false). Each visible part becomes a slot with a textured mesh (its paint rasterized at texture_scale), warps become grids of bones with exactly weighted meshes, shape morphs deform timelines; parameters, bindings, physics and IK are baked into the sampled animations (fps, key reduction within tolerance px/degrees); param_poses adds one-frame "param/<id>/min|max" animations. ' +
  'format "live2d": motions/<id>.motion3.json per animation (parameter tracks and part opacity; eases exact where Live2D can express them, else fitted within tolerance), <name>.physics3.json (approximation), <name>.cdi3.json (display names) and a partial <name>.model3.json. There is no .moc3: the files drive a Live2D model built in Cubism Editor whose parameter ids match param_map; merge the model3.json FileReferences into that model\'s model3.json. ' +
  'Details: rev2d_docs {topic: "interop"}.';

export function registerInteropTools(server: McpServer, ctx: ToolContext): void {
  addTool(
    server,
    'rev2d_import',
    {
      title: 'Import Spine / Live2D files',
      description: IMPORT_DESCRIPTION,
      input: z.strictObject({
        format: z.enum(['spine', 'live2d']).describe('"spine" (skeleton JSON + atlas -> a new model) or "live2d" (JSON files -> ops on the model `into`).'),
        path: z
          .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
          .describe('spine: the skeleton .json; live2d: one file or a list (.model3/.motion3/.exp3/.physics3/.cdi3.json). Relative to the MCP server working directory.'),
        out: z.string().min(1).optional().describe('spine: model file to write (default: <skeleton name>.r2d.json next to the skeleton).'),
        into: z.string().min(1).optional().describe('live2d (required): the Rev2D model to import into; edited in place.'),
        atlas: z.string().min(1).optional().describe('spine: the .atlas file (default: found next to the skeleton).'),
        skin: z.string().min(1).optional().describe('spine: skin to import (default "default"; the others are reported).'),
        scale: z.number().positive().max(100).optional().describe('spine: extra uniform scale (default 1).'),
        padding: z.number().min(0).max(4096).optional().describe('spine: canvas padding around the setup bounds in px (default 32).'),
        name: z.string().min(1).optional().describe('spine: meta.name (default: the output file name).'),
        overwrite: z.boolean().optional().describe('spine: replace an existing model / different texture files (default false).'),
        param_map: paramMapField,
        id: z.string().min(1).optional().describe('live2d: animation id for a single motion3 / exp3 file (default: its file name; expressions get "exp_").'),
        physics: z.enum(['replace', 'merge', 'skip']).optional().describe('live2d: imported physics replaces (default) or merges with model groups driving the same parameters, or is skipped.'),
        display_info: z.enum(['fill', 'overwrite', 'skip']).optional().describe('live2d: cdi3 names fill missing descriptions/groups (default), overwrite them, or are skipped.'),
        motions: z.boolean().optional().describe('live2d model3: import its motions (default true).'),
        expressions: z.boolean().optional().describe('live2d model3: import its expressions (default true).'),
        dry_run: z.boolean().optional().describe('live2d: convert, apply and validate without writing (default false).'),
      }),
      effect: 'destructive',
    },
    (a) =>
      guarded(async () => {
        const only = (keys: string[], format: string) => {
          const bad = keys.filter((k) => (a as Record<string, unknown>)[k] !== undefined);
          if (bad.length) throw new ToolError(`${bad.join(', ')} ${bad.length === 1 ? 'does' : 'do'} not apply to format "${a.format}"`, [], `${bad.length === 1 ? 'it applies' : 'they apply'} to format "${format}" only; remove ${bad.length === 1 ? 'it' : 'them'}`);
        };
        if (a.format === 'spine') {
          only(['into', 'param_map', 'id', 'physics', 'display_info', 'motions', 'expressions', 'dry_run'], 'live2d');
          if (Array.isArray(a.path)) {
            if (a.path.length !== 1) throw new ToolError('format "spine" imports one skeleton at a time', [], 'pass the skeleton .json as path (its atlas and pages are found next to it)');
          }
          return importSpineTool(ctx, Array.isArray(a.path) ? a.path[0] : a.path, a);
        }
        only(['out', 'atlas', 'skin', 'scale', 'padding', 'name', 'overwrite'], 'spine');
        if (!a.into) throw new ToolError('format "live2d" needs `into`: the Rev2D model to import into', [], 'e.g. {format: "live2d", path: "idle.motion3.json", into: "hana.r2d.json"}');
        return importLive2dTool(ctx, Array.isArray(a.path) ? a.path : [a.path], a.into, a);
      }),
  );

  addTool(
    server,
    'rev2d_export',
    {
      title: 'Export to Spine / Live2D',
      description: EXPORT_DESCRIPTION,
      input: z.strictObject({
        format: z.enum(['spine', 'live2d']).describe('"spine" (JSON + atlas + PNG pages) or "live2d" (motion3 / physics3 / cdi3 / model3 JSON).'),
        path: z.string().min(1).describe('Model file (*.r2d.json) to export; it must have no validation errors.'),
        out_dir: z.string().min(1).describe('Output directory (relative to the working directory; created).'),
        animations: z.array(z.string().min(1)).optional().describe('Animation ids to export (default: all).'),
        fps: z.number().positive().max(240).optional().describe('spine: sampling rate of the baked motion (default 30); live2d: Meta.Fps (default 30).'),
        name: z.string().min(1).optional().describe('Base file name (default: meta.name).'),
        tolerance: z.number().min(0).max(10).optional().describe('spine: key reduction tolerance in px / degrees (default 0.05; 0 = every sample). live2d: ease fitting error as a fraction of each segment\'s change (default 0.001).'),
        texture_scale: z.number().positive().max(8).optional().describe('spine: raster scale of part textures (default 1; 2 = crisper).'),
        param_poses: z.boolean().optional().describe('spine: also export every bound parameter\'s min/max pose as one-frame animations (default false).'),
        max_page_size: z.number().int().min(64).max(8192).optional().describe('spine: largest atlas page side (default 2048).'),
        spine_version: z.string().min(1).optional().describe('spine: version written to skeleton.spine (default "4.2.00").'),
        premultiplied_alpha: z.boolean().optional().describe('spine: premultiplied-alpha pages (default true, what Spine runtimes expect).'),
        param_map: paramMapField,
      }),
      effect: 'additive',
    },
    (a) =>
      guarded(async () => {
        const spineOnly = ['texture_scale', 'param_poses', 'max_page_size', 'spine_version', 'premultiplied_alpha'].filter((k) => (a as Record<string, unknown>)[k] !== undefined);
        if (a.format === 'live2d' && spineOnly.length) throw new ToolError(`${spineOnly.join(', ')} only apply to format "spine"`, [], 'remove them');
        if (a.format === 'spine' && a.param_map !== undefined) throw new ToolError('param_map only applies to format "live2d"', [], 'remove it');
        if (a.format === 'live2d' && a.tolerance === 0) throw new ToolError('tolerance must be > 0 for format "live2d"', [], 'e.g. 0.001 (the default)');
        const m = await loadModel(ctx, a.path);
        const ids = m.model.animations.map((x) => x.id);
        if (a.animations) requireKnownIds('animation', a.animations, ids);
        const dir = resolvePath(ctx, a.out_dir);
        const shown = displayPath(ctx, m.file);
        if (a.format === 'spine') {
          const opts: SpineExportOptions = {
            animations: a.animations,
            fps: a.fps,
            textureScale: a.texture_scale,
            paramPoses: a.param_poses,
            name: a.name,
            tolerance: a.tolerance,
            maxPageSize: a.max_page_size,
            spineVersion: a.spine_version,
            premultipliedAlpha: a.premultiplied_alpha,
          };
          const res = await exportSpineToDir(m, dir, opts, { overwrite: true });
          const s = res.report.stats;
          const lines = [
            `exported ${shown} to Spine in ${displayPath(ctx, dir)}: ${plural(s.bones ?? 0, 'bone')}, ${plural(s.slots ?? 0, 'slot')}, ${plural(s.animations ?? 0, 'animation')}, ${plural(s.pages ?? 0, 'atlas page')}`,
            `files: ${filesText(ctx, res.files)}`,
            ...reportText(res.report),
            `next: load the .json with its .atlas in a Spine runtime or the Spine editor (Import Data); pages are ${a.premultiplied_alpha === false ? 'straight alpha (configure the runtime with premultipliedAlpha false)' : 'premultiplied (pma: true)'}`,
          ];
          return result([text(lines.join('\n')), json({ ok: true, file: m.file, dir, files: filesJson(res.files), report: res.report })]);
        }
        const paramMap = paramMapFromSpec(a.param_map, m.model.parameters.map((p) => p.id), ctx.cwd);
        const res = await exportLive2dToDir(m.model, dir, { animations: a.animations, paramMap, fps: a.fps, name: a.name, tolerance: a.tolerance }, { overwrite: true });
        const motions = res.files.filter((f) => f.rel.endsWith('.motion3.json')).length;
        const lines = [
          `exported ${shown} as Live2D JSON in ${displayPath(ctx, dir)}: ${plural(motions, 'motion')}, ${plural(res.files.length, 'file')}`,
          `files: ${filesText(ctx, res.files)}`,
          ...reportText(res.report),
          'next: copy the files into a Live2D model folder (built in Cubism Editor with matching parameter ids) and merge the model3.json FileReferences into its model3.json',
        ];
        return result([text(lines.join('\n')), json({ ok: true, file: m.file, dir, files: filesJson(res.files), report: res.report })]);
      }),
  );
}

interface SpineArgs {
  out?: string;
  atlas?: string;
  skin?: string;
  scale?: number;
  padding?: number;
  name?: string;
  overwrite?: boolean;
}

async function importSpineTool(ctx: ToolContext, skeletonPath: string, a: SpineArgs): Promise<CallToolResult> {
  const skeleton = resolvePath(ctx, skeletonPath);
  const outAbs = a.out ? resolvePath(ctx, a.out) : path.join(path.dirname(skeleton), `${skeletonStem(skeleton)}.r2d.json`);
  return withFileLock(outAbs, async () => {
    const shownOut = displayPath(ctx, outAbs);
    if (statSync(outAbs, { throwIfNoEntry: false })?.isDirectory()) {
      throw new ToolError(`out ${shownOut} is a directory`, [], `give the model file to write, e.g. "${shownOut}/${skeletonStem(skeleton)}.r2d.json"`);
    }
    if (existsSync(outAbs) && !a.overwrite) throw new ToolError(`${shownOut} already exists`, [], 'pass overwrite: true to replace it, or choose another out path');
    const imp = await importSpineFile(skeleton, {
      atlas: a.atlas !== undefined ? resolvePath(ctx, a.atlas) : undefined,
      skin: a.skin,
      scale: a.scale,
      padding: a.padding,
      name: a.name ?? path.basename(outAbs).replace(/(\.r2d)?\.jsonc?$/i, ''),
    });
    const files = await writeOutputFiles(path.dirname(outAbs), [{ path: path.basename(outAbs), text: spineModelText(imp.doc) }, ...imp.files], { overwrite: a.overwrite ?? false });
    const check = await loadModelFile(outAbs);
    const errors = check.diagnostics.filter((d) => d.severity === 'error');
    const warnings = check.diagnostics.filter((d) => d.severity === 'warning').length;
    const s = imp.report.stats;
    const anims = ((imp.doc.animations as Array<{ id: string }> | undefined) ?? []).map((x) => x.id);
    const lines = [
      `imported Spine skeleton ${displayPath(ctx, skeleton)} into ${shownOut}: ${plural(s.bones ?? 0, 'bone')}, ${plural(s.parts ?? 0, 'part')}, ${plural(s.animations ?? 0, 'animation')}${anims.length ? ` (${anims.join(', ')})` : ''}`,
      `atlas: ${imp.sources.atlas ? displayPath(ctx, imp.sources.atlas) : 'none'}; pages: ${imp.sources.pages.map((p) => displayPath(ctx, p)).join(', ') || 'none'}`,
      `files: ${filesText(ctx, files)}`,
      ...imp.notes.map((n) => `note: ${n}`),
      `validation: ${plural(errors.length, 'error')}, ${plural(warnings, 'warning')}${check.diagnostics.length ? ' (rev2d_validate lists them)' : ''}`,
      ...(errors.length ? [formatDiagnostics(errors)] : []),
      ...reportText(imp.report),
      `next: rev2d_render {path: "${shownOut}", overlay: ["bones","labels"]}${anims.length ? `; rev2d_sheet {path: "${shownOut}", animation: "${anims[0]}"}` : ''}`,
    ];
    return result(
      [text(lines.join('\n')), json({ ok: !hasErrors(check.diagnostics), file: outAbs, sources: imp.sources, files: filesJson(files), report: imp.report, diagnostics: check.diagnostics, notes: imp.notes })],
      hasErrors(check.diagnostics),
    );
  });
}

interface Live2dArgs {
  param_map?: string | Record<string, string>;
  id?: string;
  physics?: 'replace' | 'merge' | 'skip';
  display_info?: 'fill' | 'overwrite' | 'skip';
  motions?: boolean;
  expressions?: boolean;
  dry_run?: boolean;
}

async function importLive2dTool(ctx: ToolContext, files: string[], into: string, a: Live2dArgs): Promise<CallToolResult> {
  const intoAbs = resolvePath(ctx, into);
  return withFileLock(intoAbs, async () => {
    const target = await readModelDoc(intoAbs);
    const paramIds = (Array.isArray(target.doc.parameters) ? target.doc.parameters : []).map((p) => String((p as { id?: unknown }).id));
    const paramMap = paramMapFromSpec(a.param_map, paramIds, ctx.cwd);
    const absOf = new Map<string, string>();
    const sources = await Promise.all(
      files.map((f) => {
        const abs = resolvePath(ctx, f);
        absOf.set(displayPath(ctx, abs), abs);
        return readLive2dSource(abs, displayPath(ctx, abs));
      }),
    );
    const conv = convertLive2dSources(sources, target.doc, (ref, m3) => diskReferenceReader(absOf.get(m3.name)!, (abs) => displayPath(ctx, abs))(ref), {
      paramMap,
      id: a.id,
      physics: a.physics,
      displayInfo: a.display_info,
      motions: a.motions,
      expressions: a.expressions,
    });
    const dryRun = a.dry_run ?? false;
    const edit = await applyOpsToModelFile(target, conv.ops, { dryRun });
    const shown = displayPath(ctx, intoAbs);
    const failed = edit.results.filter((r) => !r.ok);
    const status = !conv.ops.length
      ? `nothing to import: ${shown} is unchanged`
      : edit.written
        ? `written: ${shown}`
        : !edit.ok
          ? `nothing was written: ${failed.length ? `op #${failed[0].index} (${failed[0].op}) failed: ${failed[0].message}${failed[0].hint ? `  → ${failed[0].hint}` : ''}` : 'the result has validation errors'}`
          : !edit.changed
            ? `unchanged: the import does not change ${shown}`
            : `dry run: ${shown} unchanged (without dry_run it would be written)`;
    const lines = [
      `import into ${shown}: ${summaryText(conv.summary)}`,
      `files: ${conv.sources.map((s) => `${s.name} (${s.kind}${'via' in s ? `, via ${s.via}` : ''})`).join(', ')}`,
      status,
      ...(edit.diagnostics.length ? ['validation of the result:', formatDiagnostics(edit.diagnostics)] : []),
      ...reportText(conv.report),
      ...(edit.written && conv.summary.animations.length ? [`next: rev2d_sheet {path: "${shown}", animation: "${conv.summary.animations[0]}"}; rev2d_analyze to check loops and physics`] : []),
    ];
    const sourceJson = conv.sources.map((s) => ('via' in s ? { file: s.name, kind: s.kind, via: s.via } : { file: s.name, kind: s.kind }));
    return result(
      [
        text(lines.join('\n')),
        json({
          ok: edit.ok,
          file: intoAbs,
          written: edit.written,
          dryRun,
          changed: edit.changed,
          sources: sourceJson,
          summary: conv.summary,
          files: edit.written ? [{ path: intoAbs, status: 'replaced' }] : [],
          results: edit.results,
          diagnostics: edit.diagnostics,
          report: conv.report,
        }),
      ],
      !edit.ok,
    );
  });
}
