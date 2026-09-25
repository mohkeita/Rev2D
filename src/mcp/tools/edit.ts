/**
 * Tools that write files: apply_ops (edit a model), create_model (from a template) and diff_images.
 */
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ImageRGBA } from '../../core/types.js';
import { suggest } from '../../core/address.js';
import { formatModelJson } from '../../core/format.js';
import { formatDiagnostics, parseJsonc } from '../../core/validate.js';
import { formatInfo, modelInfo } from '../../api/index.js';
import { BUILTIN_TEMPLATES, EXAMPLES_DIR, listTemplates, loadTemplate } from '../../api/templates.js';
import { hasErrors, loadModelFile, loadModelObject } from '../../node/load.js';
import { applyOps, type ApplyOpsResult, type Op } from '../../ops/index.js';
import { decodePNG, diffImages, encodePNG, resizeNearest } from '../../render/index.js';
import {
  addTool,
  displayPath,
  fileNotFound,
  fmtNum,
  image,
  json,
  MAX_IMAGE_SIDE,
  resolvePath,
  result,
  saveFile,
  text,
  ToolError,
  withFileLock,
  type Content,
  type ReadyModel,
  type ToolContext,
} from '../context.js';
import { frameShape, pathField, saveToField, toFrameInput } from '../schemas.js';
import { formatOpBrief, formatOpExamples, MAX_TOOL_DESCRIPTION } from './docs.js';
import { renderForAgent } from './model.js';

// ----------------------------------------------------------------------------- apply_ops

function opsReport(file: string, r: ApplyOpsResult, dryRun: boolean, changed: boolean): string {
  const n = r.results.length;
  const ops = `${n} op${n === 1 ? '' : 's'}`;
  const failed = r.results.find((x) => !x.ok);
  const invalid = hasErrors(r.diagnostics);
  let head: string;
  if (failed) head = `${file}: op #${failed.index} (${failed.op}) failed; nothing was written (a batch is atomic: fix that op and resend the whole batch)`;
  else if (!r.ok) head = `${file}: ${ops} applied, but the result has validation errors; nothing was written (fix the ops, or pass allow_invalid: true to write it anyway)`;
  else if (dryRun) head = `${file}: ${ops} would apply ${invalid ? '(the result has validation errors, allowed by allow_invalid)' : 'cleanly'}${changed ? '' : ' but change nothing'}; dry run, file unchanged`;
  else if (!changed) head = `${file}: ${ops} applied, but the model is unchanged; file not rewritten`;
  else head = `${file}: ${ops} applied and written${invalid ? ' WITH validation errors (allow_invalid)' : ''}`;
  const lines = [head];
  for (const x of r.results) {
    const status = x.ok ? 'ok  ' : failed && x.index > failed.index ? 'skip' : 'FAIL';
    lines.push(`  ${status} #${x.index} ${x.op}: ${x.message}${x.hint ? `  → ${x.hint}` : ''}`);
  }
  if (r.diagnostics.length) lines.push('', 'validation of the result:', formatDiagnostics(r.diagnostics));
  return lines.join('\n');
}

const renderAfterShape = z.strictObject({ ...frameShape, save_to: saveToField });

/** Keep the file's line endings: a CRLF checkout must not turn into a whole-file diff. */
function matchLineEndings(text: string, original: string): string {
  return /\r?\n/.exec(original)?.[0] === '\r\n' ? text.replace(/\n/g, '\r\n') : text;
}

const stripBom = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

const APPLY_OPS_INTRO =
  'Edit a model file with id-addressed ops, in order and atomically: every op applies and the result validates, or nothing is written. ' +
  'dry_run: report only; allow_invalid: write despite validation errors; render_after: true or render options = also return an image. ' +
  'Returns per-op lines (ok/FAIL/skip + hint), diagnostics and JSON {ok, written, changed, dryRun, results, diagnostics}. ' +
  'Setup-space px, +y down, degrees clockwise, absolute values ("bone:head.rotation", "part:mouth.shape.ry"). ' +
  'One example per op: the ops field; every field: rev2d_docs {topic: "ops"}. Ops (* = required):\n';

/**
 * render_after: an image of the edited model. Render problems (bad options, unloadable textures) are
 * reported as text so they never hide that the edit itself succeeded (and may have been written).
 */
async function renderResult(ctx: ToolContext, abs: string, doc: unknown, opts: true | z.output<typeof renderAfterShape>, written: boolean): Promise<Content[]> {
  const after = await loadModelObject(doc, path.dirname(abs), abs);
  if (!after.rig || !after.model || hasErrors(after.diagnostics)) {
    const errors = after.diagnostics.filter((d) => d.severity === 'error');
    // Schema/semantic errors were listed with the ops; anything else (e.g. a texture that fails to load) is new here.
    const listed = errors.every((d) => d.code !== 'texture-load' && d.code !== 'rig-compile');
    return [text(listed ? 'render skipped: the result has validation errors (listed above)' : `render skipped: the result cannot be rendered\n${formatDiagnostics(errors)}`)];
  }
  const o = opts === true ? {} : opts;
  try {
    const { png, summary } = renderForAgent(after as ReadyModel, toFrameInput(o));
    const lines = [`render of the result: ${summary[0]}`, ...summary.slice(1)];
    if (o.save_to) lines.push(`saved: ${await saveFile(ctx, o.save_to, png)}`);
    return [text(lines.join('\n')), image(png)];
  } catch (e) {
    const hint = e instanceof ToolError && e.hint ? `\nhint: ${e.hint}` : '';
    const edit = written ? 'the ops were applied and written' : 'the ops result is as reported above';
    return [text(`render_after failed: ${(e as Error).message}${hint}\n(${edit}; render it with rev2d_render once the options are fixed)`)];
  }
}

// ----------------------------------------------------------------------------- create_model

/** "hero" for ".../hero.r2d.json". */
function nameFromFile(abs: string): string {
  return path.basename(abs).replace(/\.r2d\.json$/i, '').replace(/\.jsonc?$/i, '') || 'untitled';
}

interface CreateArgs {
  template?: string;
  name?: string;
  width?: number;
  height?: number;
  overwrite?: boolean;
}

/** Write a template to `abs` (and copy its textures next to it); refuses to overwrite unless asked. */
async function createModel(ctx: ToolContext, abs: string, a: CreateArgs): Promise<CallToolResult> {
  const shown = displayPath(ctx, abs);
  const template = a.template ?? 'blank';
  const available = listTemplates();
  if (!available.includes(template)) {
    throw new ToolError(`unknown template "${template}"`, [], suggest(template, available) ?? `available: ${available.join(', ')}`);
  }
  if (statSync(abs, { throwIfNoEntry: false })?.isDirectory()) {
    throw new ToolError(`${shown} is a directory`, [], `give the new model's file path, e.g. "${shown}/${a.name ?? 'model'}.r2d.json"`);
  }
  const overwrite = a.overwrite ?? false;
  if (!overwrite && existsSync(abs)) {
    throw new ToolError(`${shown} already exists`, [], 'pass overwrite: true to replace it, or edit it with rev2d_apply_ops');
  }
  const { doc, textureFiles } = loadTemplate(template, { name: a.name ?? nameFromFile(abs), width: a.width, height: a.height });
  const srcDir = path.join(EXAMPLES_DIR, template);
  const textures = await Promise.all(
    textureFiles.map(async (src) => {
      const dest = path.join(path.dirname(abs), path.relative(srcDir, src));
      // An identical copy (e.g. from another model made from this template) is simply shared.
      const existing = await readFile(dest).catch(() => null);
      return { src, dest, existing, same: existing !== null && existing.equals(await readFile(src)) };
    }),
  );
  const clashes = textures.filter((t) => t.existing && !t.same && !overwrite).map((t) => displayPath(ctx, t.dest));
  if (clashes.length) {
    throw new ToolError(`different texture files already exist: ${clashes.join(', ')}`, [], 'pass overwrite: true to replace them, or create the model in another directory');
  }
  const copies = textures.filter((t) => !t.same);
  const shared = textures.filter((t) => t.same);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, formatModelJson(doc));
  for (const c of copies) {
    await mkdir(path.dirname(c.dest), { recursive: true });
    await copyFile(c.src, c.dest);
  }
  const m = await loadModelFile(abs);
  const lines = [`created ${shown} from template "${template}"`];
  const generated = (BUILTIN_TEMPLATES as readonly string[]).includes(template);
  if (!generated && (a.width !== undefined || a.height !== undefined)) {
    lines.push(`note: width/height apply only to the ${BUILTIN_TEMPLATES.map((t) => `"${t}"`).join(' and ')} templates; the example keeps its canvas size`);
  }
  if (!/\.r2d\.json$/i.test(abs)) lines.push('note: model files are conventionally named *.r2d.json (tools list and suggest files by that extension)');
  if (copies.length) lines.push(`copied textures: ${copies.map((c) => displayPath(ctx, c.dest)).join(', ')}`);
  if (shared.length) lines.push(`reused identical textures: ${shared.map((c) => displayPath(ctx, c.dest)).join(', ')}`);
  if (m.model) lines.push('', formatInfo(modelInfo(m.model)));
  if (m.diagnostics.length) lines.push('', formatDiagnostics(m.diagnostics));
  lines.push(
    '',
    template === 'empty'
      ? `next: add parameters, bones and parts with rev2d_apply_ops {path: "${shown}", ops: [...]} (op catalogue: rev2d_docs {topic: "ops"}; recipes: rev2d_docs {topic: "recipes"}), then rev2d_render with overlay ["bones","labels"]`
      : `next: rev2d_render {path: "${shown}", overlay: ["bones","warps","labels"]}; edit with rev2d_apply_ops; recipes in rev2d_guide`,
  );
  return result(
    [text(lines.join('\n')), json({ ok: !hasErrors(m.diagnostics), file: abs, template, textures: textures.map((c) => c.dest), diagnostics: m.diagnostics })],
    hasErrors(m.diagnostics),
  );
}

// ----------------------------------------------------------------------------- diff

async function readPng(ctx: ToolContext, p: string): Promise<{ img: ImageRGBA; shown: string }> {
  const abs = resolvePath(ctx, p);
  let bytes: Uint8Array;
  try {
    bytes = await readFile(abs);
  } catch {
    throw fileNotFound(ctx, abs, 'image');
  }
  try {
    return { img: decodePNG(bytes), shown: displayPath(ctx, abs) };
  } catch (e) {
    throw new ToolError(`${displayPath(ctx, abs)} is not a readable PNG: ${(e as Error).message}`);
  }
}

/** Downscale (nearest) so the longest side fits MAX_IMAGE_SIDE; returns the input when it already fits. */
function fitPreview(img: ImageRGBA): ImageRGBA {
  const side = Math.max(img.width, img.height);
  if (side <= MAX_IMAGE_SIDE) return img;
  const s = MAX_IMAGE_SIDE / side;
  return resizeNearest(img, Math.max(1, Math.round(img.width * s)), Math.max(1, Math.round(img.height * s)));
}

// ----------------------------------------------------------------------------- registration

export function registerEditTools(server: McpServer, ctx: ToolContext): void {
  addTool(
    server,
    'rev2d_apply_ops',
    {
      title: 'Edit a model with ops',
      description: APPLY_OPS_INTRO + formatOpBrief(MAX_TOOL_DESCRIPTION - APPLY_OPS_INTRO.length),
      input: z.strictObject({
        path: pathField,
        ops: z
          .array(z.looseObject({ op: z.string().min(1).describe('Op name.') }))
          .min(1)
          .describe(`Ops applied in order, one JSON object each. One example per op:\n${formatOpExamples()}`),
        dry_run: z.boolean().optional().describe('Validate and report without writing (default false).'),
        allow_invalid: z.boolean().optional().describe('Write even when the result has validation errors (default false).'),
        render_after: z
          .union([z.boolean(), renderAfterShape])
          .optional()
          .describe('Also render the result (true = default view; or render options like rev2d_render). With dry_run: a preview.'),
      }),
      effect: 'destructive',
    },
    (a) => {
      const abs = resolvePath(ctx, a.path);
      return withFileLock(abs, async () => {
        const shown = displayPath(ctx, abs);
        let src: string;
        try {
          src = await readFile(abs, 'utf8');
        } catch {
          throw fileNotFound(ctx, abs);
        }
        const parsed = parseJsonc(stripBom(src));
        if (!parsed.ok) throw new ToolError(`${shown} is not parseable JSON; fix the syntax before applying ops`, [parsed.error]);
        // Texture sizes for ops that need image dimensions (available when the current file is valid).
        const current = await loadModelObject(parsed.value, path.dirname(abs), abs);
        const dryRun = a.dry_run ?? false;
        const r = applyOps(parsed.value, a.ops as Op[], { allowInvalid: a.allow_invalid ?? false, textures: current.textureInfo });
        const formatted = r.ok ? formatModelJson(r.doc) : '';
        const changed = r.ok && formatted !== formatModelJson(parsed.value);
        const written = changed && !dryRun;
        if (written) {
          // The editor (or the human) may have saved the file since it was read: never overwrite that.
          const now = await readFile(abs, 'utf8').catch(() => null);
          if (now !== src) {
            throw new ToolError(`${shown} changed on disk while the ops were being applied; nothing was written`, [], 'send the same ops again: they apply to the current file');
          }
          await writeFile(abs, matchLineEndings(formatted, src));
        }
        const content: Content[] = [
          text(opsReport(shown, r, dryRun, changed)),
          json({ ok: r.ok, written, changed, dryRun, file: abs, results: r.results, diagnostics: r.diagnostics }),
        ];
        if (r.ok && a.render_after) content.push(...(await renderResult(ctx, abs, r.doc, a.render_after, written)));
        return result(content, !r.ok);
      });
    },
  );

  const templates = listTemplates();
  addTool(
    server,
    'rev2d_create_model',
    {
      title: 'Create a model from a template',
      description:
        `Create a new model file from a template: ${templates.map((t) => `"${t}"`).join(', ')}. ` +
        '"blank" is a small complete rig (Lean/Squash parameters driving a warp and a bone, idle animation) sized by width/height; "empty" has only format, version and meta (sized by width/height: build everything with rev2d_apply_ops); other templates are the shipped examples (their texture files are copied next to the new model). ' +
        'Refuses to overwrite existing files unless overwrite: true. Returns the model outline and validation status.',
      input: z.strictObject({
        path: pathField.describe('New model file, e.g. "models/hero.r2d.json" (directories are created).'),
        template: z.string().min(1).optional().describe(`Template name (default "blank"): ${templates.join(', ')}.`),
        name: z.string().min(1).optional().describe('meta.name (default: the file name without .r2d.json).'),
        width: z.number().int().positive().max(8192).optional().describe('Canvas width in px (blank and empty templates only; default 512).'),
        height: z.number().int().positive().max(8192).optional().describe('Canvas height in px (blank and empty templates only; default 512).'),
        overwrite: z.boolean().optional().describe('Replace an existing model/texture files (default false).'),
      }),
      effect: 'destructive',
    },
    (a) => {
      const abs = resolvePath(ctx, a.path);
      return withFileLock(abs, () => createModel(ctx, abs, a));
    },
  );

  addTool(
    server,
    'rev2d_diff_images',
    {
      title: 'Compare two PNGs',
      description:
        'Pixel-compare two same-size PNG files (e.g. renders saved with save_to before and after an edit). Reports how many pixels differ (per-pixel delta = max |difference| over R, G, B, A, 0..255), ' +
        'the max and mean delta, and returns a visualization: image a dimmed to gray with differing pixels in red (downscaled inline when larger than 1024 px; save_to writes full size).',
      input: z.strictObject({
        a: z.string().min(1).describe('First PNG path.'),
        b: z.string().min(1).describe('Second PNG path.'),
        threshold: z.number().min(0).max(255).optional().describe('Count a pixel as different only when its delta exceeds this (default 0).'),
        save_to: saveToField.describe('Write the full-size diff visualization PNG here.'),
      }),
      effect: 'additive',
    },
    async (a) => {
      const [ia, ib] = await Promise.all([readPng(ctx, a.a), readPng(ctx, a.b)]);
      if (ia.img.width !== ib.img.width || ia.img.height !== ib.img.height) {
        throw new ToolError(
          `size mismatch: ${ia.shown} is ${ia.img.width}x${ia.img.height}, ${ib.shown} is ${ib.img.width}x${ib.img.height}`,
          [],
          'render both with the same viewBox and scale',
        );
      }
      const d = diffImages(ia.img, ib.img, { threshold: a.threshold });
      const total = d.width * d.height;
      const pct = total ? (100 * d.differentPixels) / total : 0;
      const lines = [
        d.differentPixels === 0
          ? `${ia.shown} and ${ib.shown} are identical${a.threshold ? ` within threshold ${a.threshold}` : ''} (${d.width}x${d.height})`
          : `${ia.shown} vs ${ib.shown} (${d.width}x${d.height}): ${d.differentPixels} of ${total} pixels differ (${fmtNum(pct)}%), max delta ${d.maxDelta}, mean delta ${fmtNum(d.meanDelta)}`,
      ];
      const stats = { a: ia.shown, b: ib.shown, width: d.width, height: d.height, differentPixels: d.differentPixels, maxDelta: d.maxDelta, meanDelta: d.meanDelta };
      if (a.save_to) lines.push(`saved: ${await saveFile(ctx, a.save_to, encodePNG(d.image))}`);
      const content: Content[] = [text(lines.join('\n')), json(stats)];
      if (d.differentPixels > 0) content.push(image(encodePNG(fitPreview(d.image))));
      return result(content);
    },
  );
}
