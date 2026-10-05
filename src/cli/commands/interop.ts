/**
 * Interop commands: import spine / import live2d / export spine / export live2d. The converters and
 * their file IO (src/node/interop.ts, which pulls in the ops engine) are loaded on demand, so the
 * other commands start fast and keep working without them.
 */
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import type { InteropReport, SpineExportOptions } from '../../interop/types.js';
import { hasErrors, loadModelFile } from '../../node/load.js';
import { formatDiagnostics } from '../../core/validate.js';
import { UsageError, type FlagSpec } from '../args.js';
import type { Command } from '../command.js';
import { CliError, type Ctx } from '../context.js';
import { idHint, requireOut } from '../flags.js';
import { plural, table } from '../text.js';

type InteropModule = typeof import('../../node/interop.js');
type WrittenFile = import('../../node/interop.js').WrittenFile;

async function loadInterop(): Promise<InteropModule> {
  return import('../../node/interop.js').catch((e: unknown) => {
    throw new CliError(`cannot load the interop converters: ${e instanceof Error ? e.message : String(e)}`, { hint: 'the rev2d installation looks broken; reinstall it' });
  });
}

/** Run with InteropErrors turned into CLI errors (usage -> exit 2, the rest -> exit 1). */
async function guarded(io: InteropModule, fn: () => Promise<number>, existsHint: string): Promise<number> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof io.InteropError) {
      if (e.kind === 'usage') throw new UsageError(e.message, e.hint);
      throw new CliError(e.message, { hint: e.kind === 'exists' ? existsHint : e.hint, diagnostics: e.diagnostics.length ? e.diagnostics : undefined });
    }
    throw e;
  }
}

/** "812 B", "99.2 kB", "1.5 MB". */
function sizeText(n: number): string {
  if (n < 1000) return `${n} B`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)} kB`;
  return `${(n / 1_000_000).toFixed(1)} MB`;
}

function fileRows(ctx: Ctx, files: WrittenFile[]): string[] {
  return table(files.map((f) => [ctx.display(f.path), sizeText(f.bytes), f.status]));
}

function fileJson(files: WrittenFile[]): Array<{ path: string; status: string; bytes: number }> {
  return files.map((f) => ({ path: f.path, status: f.status, bytes: f.bytes }));
}

function printReport(ctx: Ctx, io: InteropModule, report: InteropReport): void {
  ctx.out(...io.reportLines(report));
}

/** "a.png, b.png (unchanged: c.png)". */
function writtenText(ctx: Ctx, files: WrittenFile[]): string {
  const changed = files.filter((f) => f.status !== 'unchanged').map((f) => ctx.display(f.path));
  const same = files.filter((f) => f.status === 'unchanged').map((f) => ctx.display(f.path));
  return `${changed.length ? `wrote ${changed.join(', ')}` : 'wrote nothing new'}${same.length ? ` (unchanged: ${same.join(', ')})` : ''}`;
}

function quoteArg(s: string): string {
  return /[\s"'$&|<>()]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

const PARAM_MAP_FLAG: FlagSpec = {
  name: 'param-map',
  type: 'string',
  arg: 'standard|none|prefix|map.json',
  description:
    'parameter id mapping: standard (default: AngleX <-> ParamAngleX, MouthOpen <-> ParamMouthOpenY, ...), none (ids unchanged), prefix ("Param" + id) or a JSON file {"<Rev2D id>": "<Live2D id>"} merged over the standard preset',
};

const ANIM_FLAG: FlagSpec = { name: 'anim', type: 'string', repeat: true, arg: 'ids', description: 'animations to export (comma list or repeated; default: all)' };

/** --anim ids checked against the model (did-you-mean), or undefined for all. */
function animationIds(ctx: Ctx, ids: string[]): string[] | undefined {
  const list = ctx.args.csv('anim');
  for (const id of list) if (!ids.includes(id)) throw new UsageError(`unknown animation "${id}" in --anim`, idHint(id, ids, 'animations'));
  return list.length ? [...new Set(list)] : undefined;
}

function oneOf<T extends string>(ctx: Ctx, flag: string, allowed: readonly T[]): T | undefined {
  const v = ctx.args.str(flag);
  if (v === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(v)) throw new UsageError(`--${flag} must be one of ${allowed.join(', ')}, got "${v}"`);
  return v as T;
}

// ----------------------------------------------------------------------------- import spine

export const importSpine: Command = {
  name: 'import spine',
  group: 'interop',
  summary: 'convert a Spine skeleton export (JSON + atlas + PNG pages) into a Rev2D model',
  usage: 'import spine <skeleton.json> -o <out.r2d.json> [--atlas file] [--skin name] [--scale n] [--padding px] [--name text] [--force] [--json]',
  args: ['<skeleton.json>'],
  flags: [
    { name: 'out', short: 'o', type: 'string', arg: 'out.r2d.json', description: 'the model file to write; the atlas pages go to textures/ next to it (required)' },
    { name: 'atlas', type: 'string', arg: 'file', description: 'texture atlas (default: <skeleton>.atlas or .atlas.txt next to the skeleton, else the only atlas there)' },
    { name: 'skin', type: 'string', arg: 'name', description: 'skin to import (default "default"; the others are listed in the report)' },
    { name: 'scale', type: 'number', greaterThan: 0, arg: 'n', description: 'extra uniform scale of the skeleton (default 1)' },
    { name: 'padding', type: 'number', min: 0, arg: 'px', description: 'canvas padding around the setup-pose bounds (default 32)' },
    { name: 'name', type: 'string', arg: 'text', description: 'meta.name (default: the output file name)' },
    { name: 'force', type: 'boolean', description: 'overwrite an existing model file or different texture files' },
  ],
  json: true,
  description: [
    'Reads a Spine 3.8 - 4.2 JSON export with its atlas and page images and writes a Rev2D model: bones (y flipped, angles clockwise), slots as textured mesh parts in draw order, weighted meshes as skinned parts, clipping as masks, IK, events and every animation as absolute tracks. Binary .skel files are not supported (export JSON from Spine).',
    'Shear, non-normal transform inheritance, transform constraints and image sequences are emulated (sampled where needed). Nothing is lost silently: every emulated, approximated or dropped feature (path/physics constraints, two-color tint, other skins, ...) is listed in the report with a stable code, where it was found and a hint. The written model is validated (with its textures); exit 1 when it has errors. Existing files are not overwritten without --force. See "rev2d docs interop".',
  ],
  examples: [
    'rev2d import spine spineboy/spineboy-pro.json -o models/spineboy.r2d.json',
    'rev2d import spine hero.json --atlas hero-pma.atlas --skin armored -o hero.r2d.json --json',
  ],
  async run(ctx) {
    const io = await loadInterop();
    const out = requireOut(ctx.args, 'rev2d import spine hero.json -o hero.r2d.json');
    const outAbs = ctx.resolve(out);
    const force = ctx.args.bool('force') === true;
    return guarded(
      io,
      async () => {
        if (statSync(outAbs, { throwIfNoEntry: false })?.isDirectory()) {
          throw new UsageError(`-o ${ctx.display(out)} is a directory`, `give the model file to write, e.g. -o ${ctx.display(path.join(out, 'model.r2d.json'))}`);
        }
        if (existsSync(outAbs) && !force) throw new CliError(`${ctx.display(out)} already exists`, { hint: 'pass --force to overwrite it, or choose another file name' });
        const atlas = ctx.args.str('atlas');
        const imp = await io.importSpineFile(ctx.resolve(ctx.args.positionals[0]), {
          atlas: atlas !== undefined ? ctx.resolve(atlas) : undefined,
          skin: ctx.args.str('skin'),
          scale: ctx.args.num('scale'),
          padding: ctx.args.num('padding'),
          name: ctx.args.str('name') ?? path.basename(outAbs).replace(/(\.r2d)?\.jsonc?$/i, ''),
        });
        const files = await io.writeOutputFiles(path.dirname(outAbs), [{ path: path.basename(outAbs), text: io.spineModelText(imp.doc) }, ...imp.files], { overwrite: force });
        const check = await loadModelFile(outAbs);
        const notes = [...imp.notes];
        if (!/\.r2d\.json$/i.test(outAbs)) notes.push('model files conventionally end in .r2d.json');
        const anims = ((imp.doc.animations as Array<{ id: string }> | undefined) ?? []).map((a) => a.id);
        const shown = quoteArg(ctx.display(out));
        const stem = ctx.display(out).replace(/(\.r2d)?\.jsonc?$/i, '');
        const next = [
          `rev2d render ${shown} -o ${quoteArg(`${stem}.png`)} --overlay bones,labels`,
          ...(anims.length ? [`rev2d sheet ${shown} -o ${quoteArg(`${stem}-${anims[0]}.png`)} --anim ${quoteArg(anims[0])} --frames 8`] : []),
          `rev2d edit ${shown}`,
        ];
        if (ctx.json) {
          ctx.printJson({
            ok: !hasErrors(check.diagnostics),
            file: outAbs,
            sources: imp.sources,
            files: fileJson(files),
            report: imp.report,
            diagnostics: check.diagnostics,
            notes,
            next,
          });
        } else {
          const count = (k: string) => imp.report.stats[k] ?? 0;
          ctx.out(
            `imported Spine skeleton ${ctx.display(imp.sources.skeleton)} into ${ctx.display(out)}: ${plural(count('bones'), 'bone')}, ${plural(count('parts'), 'part')}, ${plural(count('animations'), 'animation')}`,
          );
          ctx.out(
            ...table([
              ['atlas', imp.sources.atlas ? ctx.display(imp.sources.atlas) : '(none)'],
              ['pages', imp.sources.pages.length ? imp.sources.pages.map((p) => ctx.display(p)).join(', ') : '(none)'],
            ]),
          );
          ctx.out(writtenText(ctx, files));
          printReport(ctx, io, imp.report);
          const errors = check.diagnostics.filter((d) => d.severity === 'error').length;
          const warnings = check.diagnostics.filter((d) => d.severity === 'warning').length;
          ctx.out(`validation: ${plural(errors, 'error')}, ${plural(warnings, 'warning')}${check.diagnostics.length ? ` (see "rev2d validate ${shown}")` : ''}`);
          if (errors) ctx.out(formatDiagnostics(check.diagnostics.filter((d) => d.severity === 'error')));
          ctx.out('next steps:', ...next.map((n) => `  ${n}`));
          ctx.notes(notes);
        }
        return hasErrors(check.diagnostics) ? 1 : 0;
      },
      'pass --force to overwrite them, or write the model into another directory',
    );
  },
};

// ----------------------------------------------------------------------------- export spine

export const exportSpine: Command = {
  name: 'export spine',
  group: 'interop',
  summary: 'export a model as Spine JSON + atlas + PNG pages (parts rasterized, deformation baked)',
  usage:
    'export spine <model> -o <dir> [--anim ids] [--fps n] [--texture-scale n] [--param-poses] [--name base] [--tolerance n] [--max-page-size px] [--spine-version v] [--straight-alpha] [--json]',
  args: ['<model>'],
  flags: [
    { name: 'out', short: 'o', type: 'string', arg: 'dir', description: 'output directory (created; files of an earlier export are replaced) (required)' },
    ANIM_FLAG,
    { name: 'fps', type: 'number', greaterThan: 0, arg: 'n', description: 'sampling rate of the baked motion (default 30; key times are sampled too, fast motion is refined)' },
    { name: 'texture-scale', type: 'number', greaterThan: 0, arg: 'n', description: 'raster scale of the part textures (default 1; 2 = crisper vector parts)' },
    { name: 'param-poses', type: 'boolean', description: 'also export every bound parameter\'s min and max pose as one-frame animations "param/<id>/min|max"' },
    { name: 'name', type: 'string', arg: 'base', description: 'base file name of <base>.json, <base>.atlas and the pages (default: meta.name)' },
    { name: 'tolerance', type: 'number', min: 0, arg: 'n', description: 'key reduction tolerance in px / degrees (default 0.05; 0 keeps every sampled key)' },
    { name: 'max-page-size', type: 'int', min: 64, arg: 'px', description: 'largest atlas page side (default 2048)' },
    { name: 'spine-version', type: 'string', arg: 'v', description: 'version written to skeleton.spine (default 4.2.00; 4.0 uses the 4.0 deform layout)' },
    { name: 'straight-alpha', type: 'boolean', description: 'write straight-alpha pages (default: premultiplied, "pma: true", what Spine runtimes expect)' },
  ],
  json: true,
  description: [
    'Writes <base>.json (Spine 4.x skeleton), <base>.atlas and the page PNGs. The setup pose is the rig\'s default pose (y flipped, a synthetic root at the canvas origin). Each visible part becomes a slot with a textured mesh (its paint rasterized); warps become grids of bones with exactly weighted meshes; what bones cannot express (shape morphs, skinning differences) becomes deform timelines. Parameters, bindings and physics are not Spine runtime features: animations are sampled with physics and baked into timelines (IK too: constraints are written with mix 0).',
    'Every approximation is listed in the report. Existing files in the directory are replaced (the file list says which). See "rev2d docs interop".',
  ],
  examples: [
    'rev2d export spine hero.r2d.json -o out/hero-spine',
    'rev2d export spine hero.r2d.json -o out/hero-spine --anim idle,walk --texture-scale 2 --param-poses',
  ],
  async run(ctx) {
    const io = await loadInterop();
    const out = requireOut(ctx.args, 'rev2d export spine hero.r2d.json -o out/hero-spine');
    const m = await ctx.loadRig(ctx.args.positionals[0]);
    const animations = animationIds(ctx, m.model.animations.map((a) => a.id));
    const opts: SpineExportOptions = {
      animations,
      fps: ctx.args.num('fps'),
      textureScale: ctx.args.num('texture-scale'),
      paramPoses: ctx.args.bool('param-poses'),
      name: ctx.args.str('name'),
      tolerance: ctx.args.num('tolerance'),
      maxPageSize: ctx.args.num('max-page-size'),
      spineVersion: ctx.args.str('spine-version'),
      ...(ctx.args.bool('straight-alpha') === true ? { premultipliedAlpha: false } : {}),
    };
    return guarded(
      io,
      async () => {
        const dir = ctx.resolve(out);
        const res = await io.exportSpineToDir(m, dir, opts, { overwrite: true });
        const skeleton = res.files.find((f) => f.rel.endsWith('.json'));
        if (ctx.json) {
          ctx.printJson({ ok: true, file: m.file, dir, files: fileJson(res.files), report: res.report });
          return 0;
        }
        const s = res.report.stats;
        ctx.out(
          `exported ${ctx.display(ctx.args.positionals[0])} to Spine in ${ctx.display(out)}: ${plural(s.bones ?? 0, 'bone')}, ${plural(s.slots ?? 0, 'slot')}, ${plural(s.animations ?? 0, 'animation')}, ${plural(s.pages ?? 0, 'atlas page')}`,
        );
        ctx.out(...fileRows(ctx, res.files));
        printReport(ctx, io, res.report);
        if (skeleton) {
          ctx.out(
            `next: load ${ctx.display(skeleton.path)} with its atlas in a Spine runtime or the Spine editor (Import Data)${opts.premultipliedAlpha === false ? '; the pages are straight alpha: configure the runtime with premultipliedAlpha false' : '; the pages have premultiplied alpha (pma: true)'}`,
          );
        }
        return 0;
      },
      'choose another output directory',
    );
  },
};

// ----------------------------------------------------------------------------- import live2d

const PHYSICS_MODES = ['replace', 'merge', 'skip'] as const;
const DISPLAY_MODES = ['fill', 'overwrite', 'skip'] as const;

export const importLive2d: Command = {
  name: 'import live2d',
  group: 'interop',
  summary: 'import Live2D motions, expressions, physics and display info into a model (as ops)',
  usage:
    'import live2d <file.json>... --into <model.r2d.json> [--param-map standard|none|prefix|map.json] [--id name] [--physics replace|merge|skip] [--display-info fill|overwrite|skip] [--no-motions] [--no-expressions] [--dry-run] [--json]',
  args: ['<file.json...>'],
  flags: [
    { name: 'into', type: 'string', arg: 'model.r2d.json', description: 'the Rev2D model to import into (edited in place; required)' },
    PARAM_MAP_FLAG,
    { name: 'id', type: 'string', arg: 'name', description: 'animation id for a single motion3 / exp3 file (default: the file name; expressions get "exp_")' },
    { name: 'physics', type: 'string', arg: 'replace|merge|skip', description: 'imported physics: replace (default) removes model physics groups that drive the same parameters, merge keeps them, skip ignores physics' },
    { name: 'display-info', type: 'string', arg: 'fill|overwrite|skip', description: 'cdi3 names: fill (default) sets missing parameter / part descriptions and groups, overwrite replaces them, skip ignores them' },
    { name: 'motions', type: 'boolean', description: 'import the motions a model3.json lists (default on; --no-motions skips them)' },
    { name: 'expressions', type: 'boolean', description: 'import the expressions a model3.json lists (default on; --no-expressions skips them)' },
    { name: 'dry-run', type: 'boolean', description: 'convert, apply and validate, but do not write the model' },
  ],
  json: true,
  description: [
    'Accepts .motion3.json (-> an animation of parameter tracks, part opacity, events), .exp3.json (-> a one-key animation meant for "add" layering), .physics3.json (-> physics groups, an approximation), .cdi3.json (-> parameter / part descriptions and groups) and .model3.json (all the files it lists, read relative to it; the .moc3 model binary is proprietary and never read). Live2D parameter ids are mapped with --param-map; curves for parameters the model lacks are dropped and reported with a did-you-mean.',
    'The conversion becomes edit ops applied atomically: every op applies and the result validates, or nothing is written (like "rev2d ops"). An animation with an existing id is replaced: the report warns when that animation was made in Rev2D (rename it first, or pass --id), and only notes it when an earlier Live2D import wrote it; --dry-run shows what would happen. Every approximation is listed in the report. See "rev2d docs interop".',
  ],
  examples: [
    'rev2d import live2d idle.motion3.json --into hana.r2d.json',
    'rev2d import live2d Hiyori/hiyori.model3.json --into hana.r2d.json --physics merge --dry-run',
    'rev2d import live2d F01.exp3.json --into hana.r2d.json --id smile --param-map map.json',
  ],
  async run(ctx) {
    const io = await loadInterop();
    const into = ctx.args.str('into');
    if (!into) throw new UsageError('missing --into <model.r2d.json>: the model to import into', 'e.g. rev2d import live2d idle.motion3.json --into hana.r2d.json');
    const physics = oneOf(ctx, 'physics', PHYSICS_MODES);
    const displayInfo = oneOf(ctx, 'display-info', DISPLAY_MODES);
    const dryRun = ctx.args.bool('dry-run') === true;
    return guarded(
      io,
      async () => {
        const target = await io.readModelDoc(ctx.resolve(into));
        const paramIds = (Array.isArray(target.doc.parameters) ? target.doc.parameters : []).map((p) => String((p as { id?: unknown }).id));
        const paramMap = io.paramMapFromSpec(ctx.args.str('param-map'), paramIds, ctx.cwd);
        const absOf = new Map<string, string>();
        const sources = await Promise.all(
          ctx.args.positionals.map(async (f) => {
            absOf.set(ctx.display(f), ctx.resolve(f));
            return io.readLive2dSource(ctx.resolve(f), ctx.display(f));
          }),
        );
        const conv = io.convertLive2dSources(sources, target.doc, (ref, m3) => io.diskReferenceReader(absOf.get(m3.name)!, (abs) => ctx.display(abs))(ref), {
          paramMap,
          id: ctx.args.str('id'),
          physics,
          displayInfo,
          motions: ctx.args.bool('motions'),
          expressions: ctx.args.bool('expressions'),
        });
        const edit = await io.applyOpsToModelFile(target, conv.ops, { dryRun });
        const sourceJson = conv.sources.map((s) => ('via' in s ? { file: s.name, kind: s.kind, via: s.via } : { file: s.name, kind: s.kind }));
        if (ctx.json) {
          ctx.printJson({
            ok: edit.ok,
            file: target.file,
            written: edit.written,
            dryRun,
            changed: edit.changed,
            sources: sourceJson,
            summary: conv.summary,
            files: edit.written ? [{ path: target.file, status: 'replaced' }] : [],
            results: edit.results,
            diagnostics: edit.diagnostics,
            report: conv.report,
          });
          return edit.ok ? 0 : 1;
        }
        const shown = ctx.display(into);
        ctx.out(`import into ${shown}${dryRun ? ' (dry run)' : ''}: ${io.summaryText(conv.summary)}`);
        ctx.out(...table(conv.sources.map((s) => [s.name, s.kind, 'via' in s ? `via ${s.via}` : ''])));
        const failed = edit.results.filter((r) => !r.ok);
        if (failed.length) ctx.out(...table(failed.map((r) => ['FAIL', `#${r.index}`, r.op, r.hint ? `${r.message}  → ${r.hint}` : r.message])));
        if (edit.diagnostics.length) ctx.out('validation of the result:', ...formatDiagnostics(edit.diagnostics).split('\n').map((l) => `  ${l}`));
        if (!conv.ops.length) ctx.out(`nothing to import: ${shown} is unchanged`);
        else if (edit.written) ctx.out(`wrote ${shown}`);
        else if (!edit.ok) ctx.out(`not written: ${failed.length ? `${plural(failed.length, 'op')} failed` : 'the result has validation errors'}`);
        else if (!edit.changed) ctx.out(`unchanged: the import does not change ${shown}`);
        else ctx.out(`dry run: nothing written; without --dry-run this would write ${shown}`);
        printReport(ctx, io, conv.report);
        return edit.ok ? 0 : 1;
      },
      'run the import again',
    );
  },
};

// ----------------------------------------------------------------------------- export live2d

export const exportLive2d: Command = {
  name: 'export live2d',
  group: 'interop',
  summary: 'export animations, physics and display info as Live2D motion3 / physics3 / cdi3 / model3 JSON',
  usage: 'export live2d <model> -o <dir> [--anim ids] [--param-map standard|none|prefix|map.json] [--fps n] [--name base] [--tolerance n] [--json]',
  args: ['<model>'],
  flags: [
    { name: 'out', short: 'o', type: 'string', arg: 'dir', description: 'output directory (created; files of an earlier export are replaced) (required)' },
    ANIM_FLAG,
    PARAM_MAP_FLAG,
    { name: 'fps', type: 'number', greaterThan: 0, arg: 'n', description: 'Meta.Fps of the motions and the rate where curves must be sampled (default 30)' },
    { name: 'name', type: 'string', arg: 'base', description: 'base file name of <base>.physics3.json, .cdi3.json and .model3.json (default: meta.name)' },
    { name: 'tolerance', type: 'number', greaterThan: 0, arg: 'n', description: 'allowed error of eases fitted with Bézier segments, as a fraction of each segment\'s change (default 0.001)' },
  ],
  json: true,
  description: [
    'Writes motions/<id>.motion3.json for every animation (parameter tracks and part opacity; eases become exact Bézier segments where Live2D can express them, else fitted within the tolerance), <base>.physics3.json (an approximation), <base>.cdi3.json (parameter names and groups) and a partial <base>.model3.json listing them. The .moc3 model binary is proprietary and not written: the files drive a Live2D model built in Cubism Editor whose parameter ids match (see --param-map). Merge the model3.json FileReferences into that model\'s own model3.json.',
    'Other tracks (bones, part shapes) and features Live2D motions cannot hold are listed in the report. See "rev2d docs interop".',
  ],
  examples: ['rev2d export live2d hana.r2d.json -o out/hana-live2d', 'rev2d export live2d hana.r2d.json -o out/motions --anim idle,talk --param-map map.json --json'],
  async run(ctx) {
    const io = await loadInterop();
    const out = requireOut(ctx.args, 'rev2d export live2d hana.r2d.json -o out/hana-live2d');
    const m = await ctx.loadRig(ctx.args.positionals[0]);
    const animations = animationIds(ctx, m.model.animations.map((a) => a.id));
    return guarded(
      io,
      async () => {
        const paramMap = io.paramMapFromSpec(ctx.args.str('param-map'), m.model.parameters.map((p) => p.id), ctx.cwd);
        const dir = ctx.resolve(out);
        const res = await io.exportLive2dToDir(
          m.model,
          dir,
          { animations, paramMap, fps: ctx.args.num('fps'), name: ctx.args.str('name'), tolerance: ctx.args.num('tolerance') },
          { overwrite: true },
        );
        if (ctx.json) {
          ctx.printJson({ ok: true, file: m.file, dir, files: fileJson(res.files), report: res.report });
          return 0;
        }
        const motions = res.files.filter((f) => f.rel.endsWith('.motion3.json')).length;
        ctx.out(`exported ${ctx.display(ctx.args.positionals[0])} as Live2D JSON in ${ctx.display(out)}: ${plural(motions, 'motion')}, ${plural(res.files.length, 'file')}`);
        ctx.out(...fileRows(ctx, res.files));
        printReport(ctx, io, res.report);
        const model3 = res.files.find((f) => f.rel.endsWith('.model3.json'));
        if (model3) {
          ctx.out(
            `next: copy the files into your Live2D model's folder and merge the FileReferences (Motions, Physics, DisplayInfo) of ${ctx.display(model3.path)} into its model3.json; play the motions in Cubism Viewer or an SDK app`,
          );
        }
        return 0;
      },
      'choose another output directory',
    );
  },
};
