/**
 * rev2d avatar <subcommand>: an animated avatar from ONE illustration (src/avatar/DESIGN.md).
 *
 *   new, import-mas      start a project folder (avatar.json + source.png)
 *   validate, schema     check the spec; print its JSON Schema
 *   grid, overlay        the agent's eyes: read coordinates off the picture, see the landmarks on it
 *   build, poses         generate the layer images and the model; render the review sheets
 *   variants             drawn eye / mouth variants: request masks and prompts, import drawings, status
 *   vision-check         can this agent read coordinates off an image at all?
 *
 * Adding a subcommand: define a `Command` named "avatar <word>" below (group 'edit', like the
 * others), and append it to AVATAR_COMMANDS. Registration, help ("rev2d help avatar") and the
 * dispatcher follow from that list. Shared pieces for new subcommands: loadAvatar() (the Node IO
 * module, loaded on demand), guarded() (project / tool errors -> CLI errors), openProject() (a
 * loaded project or a clear failure) and writeImage().
 */
import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Diagnostic, ImageRGBA } from '../../core/types.js';
import { formatDiagnostics, parseJsonc } from '../../core/validate.js';
import { suggest } from '../../core/address.js';
import { UsageError, type FlagSpec } from '../args.js';
import type { Command } from '../command.js';
import { CliError, type Ctx } from '../context.js';
import { outFlag } from '../flags.js';
import { plural, table } from '../text.js';

type AvatarIO = typeof import('../../node/avatar.js');
type AvatarLib = typeof import('../../avatar/index.js');
type LoadedAvatarProject = import('../../node/avatar.js').LoadedAvatarProject;

interface AvatarModules {
  io: AvatarIO;
  avatar: AvatarLib;
}

/** The avatar modules, loaded on demand so the other commands start fast. */
export async function loadAvatar(): Promise<AvatarModules> {
  try {
    const [io, avatar] = await Promise.all([import('../../node/avatar.js'), import('../../avatar/index.js')]);
    return { io, avatar };
  } catch (e) {
    throw new CliError(`cannot load the avatar builder: ${e instanceof Error ? e.message : String(e)}`, { hint: 'the rev2d installation looks broken; reinstall it' });
  }
}

/** Run with project and tool errors turned into CLI errors (exit 1) that keep their hint. */
export async function guarded<T>(m: AvatarModules, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof m.io.AvatarProjectError) throw new CliError(e.message, { hint: e.hint, diagnostics: e.diagnostics.length ? e.diagnostics : undefined });
    if (e instanceof m.avatar.AvatarToolError) throw new CliError(e.message, { hint: e.hint });
    throw e;
  }
}

function countOf(diagnostics: readonly Diagnostic[], severity: Diagnostic['severity']): number {
  return diagnostics.filter((d) => d.severity === severity).length;
}

function indent(text: string): string[] {
  return text.split('\n').map((l) => `  ${l}`);
}

function quoteArg(s: string): string {
  return /[\s"'$&|<>()]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

/**
 * Load the project a path names (its folder or its avatar.json). Fails (exit 1) when there is no
 * avatar.json; spec problems stay in `diagnostics` for the caller to judge.
 */
export async function openProject(ctx: Ctx, m: AvatarModules, target: string): Promise<LoadedAvatarProject> {
  const project = await m.io.loadAvatarProject(m.io.avatarProjectDir(ctx.resolve(target)));
  const missing = project.diagnostics.find((d) => d.code === 'file-not-found');
  if (missing) throw new CliError(missing.message.replace(project.dir, ctx.display(project.dir)), { hint: missing.hint });
  return project;
}

/** The illustration of a loaded project, or a failure that says why it cannot be used. */
export function projectSource(ctx: Ctx, project: LoadedAvatarProject): ImageRGBA {
  if (project.source) return project.source;
  const problems = project.diagnostics.filter((d) => d.code.startsWith('avatar-source'));
  throw new CliError(`the illustration of ${ctx.display(project.dir)} cannot be used`, { diagnostics: problems.length ? problems : undefined, hint: 'a project needs its illustration as a PNG (image.file, default source.png)' });
}

/** Encode and write a PNG; returns the absolute path. */
export async function writeImage(ctx: Ctx, m: AvatarModules, file: string, image: ImageRGBA): Promise<string> {
  const abs = ctx.resolve(file);
  if (statSync(abs, { throwIfNoEntry: false })?.isDirectory()) throw new UsageError(`-o ${ctx.display(file)} is a directory`, `give the PNG file to write, e.g. -o ${ctx.display(path.join(file, 'out.png'))}`);
  try {
    return await m.io.writePngFile(abs, image);
  } catch (e) {
    throw new CliError(`cannot write ${ctx.display(file)} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`, { hint: 'check that the directory is writable' });
  }
}

const FORCE_FLAG: FlagSpec = { name: 'force', type: 'boolean', description: 'replace an existing avatar.json / source.png in the folder (its landmarks are lost)' };
const NAME_FLAG: FlagSpec = { name: 'name', type: 'string', arg: 'id', description: 'name of the avatar and of its built model <name>.r2d.json (default: the folder name)' };
const SCALE_FLAG: FlagSpec = { name: 'scale', type: 'int', min: 1, max: 40, arg: 'n', description: 'output pixels per source pixel, a whole number (default: chosen so the long side is about 1000-1600 px)' };

function landmarksToPlace(diagnostics: readonly Diagnostic[]): number {
  return diagnostics.filter((d) => d.code === 'avatar-missing-landmark').length;
}

/** The commands that come next for a project, with paths as the user typed them. */
function nextSteps(ctx: Ctx, dir: string, placed: boolean): string[] {
  const p = quoteArg(ctx.display(dir));
  const work = (name: string) => quoteArg(ctx.display(path.join(dir, 'work', name)));
  return [
    `rev2d avatar grid ${p} -o ${work('grid.png')}`,
    `rev2d avatar grid ${p} --region x0,y0,x1,y1 -o ${work('zoom.png')}`,
    ...(placed ? [] : [`rev2d avatar validate ${p}`]),
    `rev2d avatar overlay ${p} -o ${work('overlay.png')}`,
    `rev2d avatar overlay ${p} --part eyes.imageLeft --zoom -o ${work('eye.png')}`,
  ];
}

// ----------------------------------------------------------------------------- new

export const avatarNew: Command = {
  name: 'avatar new',
  group: 'edit',
  summary: 'start an avatar project from one illustration: <dir>/source.png and a draft avatar.json',
  usage: 'avatar new <image.png> <dir> [--name id] [--force] [--json]',
  args: ['<image.png>', '<dir>'],
  flags: [NAME_FLAG, FORCE_FLAG],
  json: true,
  description: [
    'Copies the PNG (ideally a front-facing bust with a transparent background) to <dir>/source.png, byte for byte, and writes <dir>/avatar.json: the avatar spec with the image size filled in and every landmark still null. "rev2d avatar validate <dir>" lists the landmarks to place, each with a hint; "rev2d avatar grid" shows the coordinates to read them from.',
    'Other image formats are refused with the way to convert them. An existing project is not overwritten without --force. The image stays on this machine: nothing is uploaded.',
  ],
  examples: ['rev2d avatar new art/miko.png projects/miko', 'rev2d avatar new bust.png projects/hero --name hero --json'],
  async run(ctx) {
    const m = await loadAvatar();
    const [image, dir] = ctx.args.positionals;
    return guarded(m, async () => {
      const created = await m.io.createAvatarProject(ctx.resolve(image), ctx.resolve(dir), { name: ctx.args.str('name'), force: ctx.args.bool('force') === true });
      const todo = landmarksToPlace(m.avatar.parseAvatarSpec(created.doc).diagnostics);
      const next = nextSteps(ctx, created.dir, false);
      if (ctx.json) {
        ctx.printJson({ ok: true, dir: created.dir, specFile: created.specFile, sourceFile: created.sourceFile, name: created.name, width: created.width, height: created.height, landmarksToPlace: todo, notes: created.notes, next });
        return 0;
      }
      ctx.out(`created avatar project ${ctx.display(created.dir)}: "${created.name}", ${created.width}x${created.height}`);
      ctx.out(
        ...table([
          [ctx.display(created.sourceFile), 'the illustration (a copy; never modified)'],
          [ctx.display(created.specFile), `draft spec: ${plural(todo, 'landmark')} to place`],
        ]),
      );
      ctx.out('next steps:', ...next.map((n) => `  ${n}`));
      ctx.notes(created.notes);
      return 0;
    });
  },
};

// ----------------------------------------------------------------------------- schema

export const avatarSchema: Command = {
  name: 'avatar schema',
  group: 'edit',
  summary: 'print the JSON Schema of avatar.json (the avatar spec)',
  usage: 'avatar schema [-o schema.json] [--json]',
  args: [],
  flags: [outFlag('schema.json', 'write to a file instead of stdout')],
  json: true,
  description: [
    'Every field of the avatar spec with its description: what each landmark is, where it goes and which polygons cut layers. "rev2d avatar validate" performs the full (semantic) validation.',
    'The schema itself is JSON either way; with -o, --json prints {"file": <absolute path>} instead of a message.',
  ],
  examples: ['rev2d avatar schema', 'rev2d avatar schema -o avatar.schema.json'],
  async run(ctx) {
    const m = await loadAvatar();
    const text = JSON.stringify(m.avatar.avatarJsonSchema(), null, 2) + '\n';
    const out = ctx.args.str('out');
    if (!out) {
      ctx.io.stdout.write(text);
      return 0;
    }
    const file = ctx.writeFile(out, text);
    if (ctx.json) ctx.printJson({ file });
    else ctx.out(`wrote ${ctx.display(file)}`);
    return 0;
  },
};

// ----------------------------------------------------------------------------- validate

export const avatarValidate: Command = {
  name: 'avatar validate',
  group: 'edit',
  summary: 'check an avatar project: the spec (structure, missing landmarks, geometry) against its illustration',
  usage: 'avatar validate <project> [--strict] [--json]',
  args: ['<project>'],
  flags: [{ name: 'strict', type: 'boolean', description: 'also fail (exit 1) on warnings' }],
  json: true,
  description: [
    '<project> is the project folder or its avatar.json. Diagnostics look like those of "rev2d validate": severity, stable code, JSON pointer into avatar.json, message and a hint with the fix. Structural problems are "schema-*" (unknown keys get a did-you-mean); a landmark that is still null is "avatar-missing-landmark" with the way to place it; geometry is checked for everything already placed ("avatar-*": coordinates outside the image, an eye opening outside its region, swapped eyes or mouth corners, landmarks outside the head ellipse, unordered bands, duplicate ids, ...), so a half-finished draft gets feedback too.',
    'The declared image size is compared with the real size of the illustration. Exit 1 when there are errors (or warnings with --strict).',
  ],
  examples: ['rev2d avatar validate projects/miko', 'rev2d avatar validate projects/miko/avatar.json --strict --json'],
  async run(ctx) {
    const m = await loadAvatar();
    const strict = ctx.args.bool('strict') === true;
    return guarded(m, async () => {
      const project = await openProject(ctx, m, ctx.args.positionals[0]);
      const diagnostics = project.diagnostics;
      const errors = countOf(diagnostics, 'error');
      const warnings = countOf(diagnostics, 'warning');
      const ok = errors === 0 && (!strict || warnings === 0);
      const todo = landmarksToPlace(diagnostics);
      const layers = project.meta === null ? 'not built' : project.layersStale === null ? 'unknown' : project.layersStale ? 'stale' : 'current';
      if (ctx.json) {
        ctx.printJson({
          file: project.specFile,
          ok,
          errors,
          warnings,
          landmarksToPlace: todo,
          diagnostics,
          image: project.source ? { file: project.sourceFile, width: project.source.width, height: project.source.height } : null,
          layers,
        });
        return ok ? 0 : 1;
      }
      const shown = ctx.display(project.specFile);
      if (diagnostics.length === 0) ctx.out(`ok    ${shown}  (0 errors, 0 warnings)`);
      else ctx.out(`${ok ? 'ok  ' : 'FAIL'}  ${shown}`, ...indent(formatDiagnostics(diagnostics)));
      if (todo) {
        ctx.out(`${plural(todo, 'landmark')} to place: read coordinates with "rev2d avatar grid ${quoteArg(ctx.display(project.dir))}" (add --region x0,y0,x1,y1 to zoom in), then look at them with "rev2d avatar overlay"`);
      }
      if (layers === 'stale') ctx.out('layers: stale (the spec changed what the layer images are cut from since they were built)');
      return ok ? 0 : 1;
    });
  },
};

// ----------------------------------------------------------------------------- grid

function parseRegion(raw: string): number[] {
  const parts = raw.split(',').map((s) => (s.trim() === '' ? NaN : Number(s)));
  if (parts.length !== 4 || !parts.every(Number.isFinite)) {
    throw new UsageError(`--region expects "x0,y0,x1,y1", got "${raw}"`, 'the top-left and bottom-right corner in source-image pixels, e.g. --region 420,380,580,520');
  }
  if (!(parts[2] > parts[0] && parts[3] > parts[1])) throw new UsageError(`--region needs x0 < x1 and y0 < y1, got "${raw}"`, 'it is two corners (x0,y0,x1,y1), not x,y,width,height');
  return parts;
}

/** The picture a grid is drawn over: a project's illustration, or a PNG file. */
async function gridInput(ctx: Ctx, m: AvatarModules, target: string): Promise<{ image: ImageRGBA; projectDir: string | null; file: string }> {
  const abs = ctx.resolve(target);
  const stat = statSync(abs, { throwIfNoEntry: false });
  if (!stat) throw new CliError(`${ctx.display(target)} does not exist`, { hint: 'give an avatar project folder or a PNG file' });
  if (stat.isFile() && path.basename(abs).toLowerCase() !== m.io.AVATAR_SPEC_FILE) {
    return { image: (await m.io.readPngFile(abs)).image, projectDir: null, file: abs };
  }
  const project = await openProject(ctx, m, target);
  return { image: projectSource(ctx, project), projectDir: project.dir, file: project.sourceFile! };
}

export const avatarGrid: Command = {
  name: 'avatar grid',
  group: 'edit',
  summary: 'draw a labelled coordinate grid over the illustration (whole image, or a magnified region) to read landmark coordinates from',
  usage: 'avatar grid <project | image.png> [--region x0,y0,x1,y1] [--step n] [--scale n] [-o out.png] [--json]',
  args: ['<project|image.png>'],
  flags: [
    { name: 'region', type: 'string', arg: 'x0,y0,x1,y1', description: 'magnify this rectangle of the source image (two corners, source pixels) instead of showing the whole image' },
    { name: 'step', type: 'number', greaterThan: 0, arg: 'px', description: 'source pixels between grid lines (default: 50 for a 1000 px view at x1; 5 or 10 in a magnified eye-sized region)' },
    SCALE_FLAG,
    outFlag('out.png', 'the PNG to write (default for a project: <project>/work/grid.png, or grid-x0-y0-x1-y1.png for a region; required for an image file)'),
  ],
  json: true,
  description: [
    'This is how coordinates are read off a picture. Labels are SOURCE pixel coordinates on all four sides at any magnification (origin top-left, +x right, +y down): the numbers you read are the numbers avatar.json wants. Lines on round coordinates are stronger; every line is a dark and a light pixel side by side, so it shows on any artwork; transparent pixels show a checkerboard; the footer states region, magnification and spacing.',
    'Start with the whole image (a line every 50 px on a 1000 px image) to find rough positions, then magnify with --region: the rectangle is enlarged by a whole number so its long side is about 1000-1600 px, pixels stay crisp squares, and an eye-sized region gets a line every 5 or 10 px (readable to about 2 px). Look at the PNG with your image viewer / the Read tool.',
  ],
  examples: [
    'rev2d avatar grid projects/miko -o projects/miko/work/grid.png',
    'rev2d avatar grid projects/miko --region 420,410,580,530 -o projects/miko/work/eye.png',
    'rev2d avatar grid art/bust.png --region 0,0,400,300 --step 10 -o out/corner.png --json',
  ],
  async run(ctx) {
    const m = await loadAvatar();
    const regionRaw = ctx.args.str('region');
    const region = regionRaw !== undefined ? parseRegion(regionRaw) : undefined;
    return guarded(m, async () => {
      const input = await gridInput(ctx, m, ctx.args.positionals[0]);
      let out = ctx.args.str('out');
      if (out === undefined) {
        if (!input.projectDir) throw new UsageError('missing output file: pass -o <out.png>', 'e.g. rev2d avatar grid art/bust.png -o out/grid.png (for a project folder the default is <project>/work/grid.png)');
        out = path.join(input.projectDir, 'work', region ? `grid-${region.map((v) => Math.round(v)).join('-')}.png` : 'grid.png');
      }
      const grid = m.avatar.avatarGrid(input.image, { region, step: ctx.args.num('step'), scale: ctx.args.num('scale') });
      const file = await writeImage(ctx, m, out, grid.image);
      const [x0, y0, x1, y1] = grid.region;
      if (ctx.json) {
        ctx.printJson({ file, width: grid.image.width, height: grid.image.height, source: input.file, region: grid.region, scale: grid.scale, step: grid.step, labelStep: grid.labelStep, origin: grid.origin });
        return 0;
      }
      ctx.out(
        `wrote ${ctx.display(file)} (${grid.image.width}x${grid.image.height}): x ${x0}..${x1}, y ${y0}..${y1} of the ${input.image.width}x${input.image.height} image at x${grid.scale}, a line every ${grid.step} px, labels every ${grid.labelStep} px`,
      );
      return 0;
    });
  },
};

// ----------------------------------------------------------------------------- overlay

export const avatarOverlay: Command = {
  name: 'avatar overlay',
  group: 'edit',
  summary: 'draw the landmarks of avatar.json over the illustration in their group colours (optionally one part, zoomed, with numbered vertices)',
  usage: 'avatar overlay <project> [--part group|item] [--zoom] [--grid] [--scale n] [-o out.png] [--json]',
  args: ['<project>'],
  flags: [
    { name: 'part', type: 'string', arg: 'group|item', description: 'draw only one group (head, eyes, mouth, face, cheeks, strands, attachments, body) or the items whose id starts with this ("eyes.imageLeft", "strand.bang1", "attachment.tassel")' },
    { name: 'zoom', type: 'boolean', description: 'crop to what is drawn plus a margin, magnified; polygon and polyline vertices are numbered from 0 (their index in the point list)' },
    { name: 'grid', type: 'boolean', description: 'also draw the coordinate grid lines of "rev2d avatar grid" over the picture (default: ruler ticks and labels in the margins only)' },
    SCALE_FLAG,
    outFlag('out.png', 'the PNG to write (default: <project>/work/overlay.png, with the part and "zoom" in the name when given)'),
  ],
  json: true,
  description: [
    'The check after placing landmarks: do the polygons sit on the eyes, does the head ellipse cover all hair, do the strands follow the locks? Works on an unfinished draft (what is not placed is skipped and counted). Colours are fixed per group and colour-blind friendly (legend in the footer); the rulers are in source pixels, so a point that is off can be corrected from the picture.',
    'Shapes: ellipses with a cross at the centre; polygons closed; polylines (strands, brows) with a ring at their first point (the root); points as a ring around a dot; a band as a solid line at yStart and a dashed line at yEnd; a segment (mouth corners, pendulum pivot to tip) from a ring to a dot. With --part every item carries its id; with --zoom the vertices are numbered.',
  ],
  examples: [
    'rev2d avatar overlay projects/miko -o projects/miko/work/overlay.png',
    'rev2d avatar overlay projects/miko --part eyes.imageLeft --zoom -o projects/miko/work/eye.png',
    'rev2d avatar overlay projects/miko --part strands --json',
  ],
  async run(ctx) {
    const m = await loadAvatar();
    const part = ctx.args.str('part');
    const zoom = ctx.args.bool('zoom') === true;
    return guarded(m, async () => {
      const project = await openProject(ctx, m, ctx.args.positionals[0]);
      if (project.doc === undefined) {
        throw new CliError(`${ctx.display(project.specFile)} is not valid JSON`, { diagnostics: project.diagnostics.filter((d) => d.code === 'json-syntax'), hint: 'fix the syntax first ("rev2d avatar validate" shows the place)' });
      }
      const source = projectSource(ctx, project);
      const out = ctx.args.str('out') ?? path.join(project.dir, 'work', `overlay${part ? `-${part.replace(/[^A-Za-z0-9_-]+/g, '-')}` : ''}${zoom ? '-zoom' : ''}.png`);
      const overlay = m.avatar.avatarOverlay(source, project.doc, { part, zoom, grid: ctx.args.bool('grid') === true, scale: ctx.args.num('scale') });
      const file = await writeImage(ctx, m, out, overlay.image);
      const notes = overlay.missing.length ? [`${plural(overlay.missing.length, 'landmark')} of this selection ${overlay.missing.length === 1 ? 'is' : 'are'} not placed yet: ${overlay.missing.slice(0, 8).join(', ')}${overlay.missing.length > 8 ? ', ...' : ''}`] : [];
      if (ctx.json) {
        ctx.printJson({ file, width: overlay.image.width, height: overlay.image.height, region: overlay.region, scale: overlay.scale, origin: overlay.origin, drawn: overlay.drawn, missing: overlay.missing, notes });
        return 0;
      }
      const [x0, y0, x1, y1] = overlay.region;
      ctx.out(`wrote ${ctx.display(file)} (${overlay.image.width}x${overlay.image.height}): ${plural(overlay.drawn.length, 'landmark shape')}${part ? ` of "${part}"` : ''}, x ${x0}..${x1}, y ${y0}..${y1} at x${overlay.scale}`);
      ctx.notes(notes);
      return 0;
    });
  },
};

// ----------------------------------------------------------------------------- vision-check

const VISION_ACTIONS = ['make', 'score'];

export const avatarVisionCheck: Command = {
  name: 'avatar vision-check',
  group: 'edit',
  summary: 'test whether you (the agent) can read pixel coordinates off an image: "make" a marker image, "score" your answer',
  usage: 'avatar vision-check <make|score> <dir> [answer.json] [--seed n] [--size px] [--json]',
  args: ['<make|score>', '<dir>', '[answer.json]'],
  flags: [
    { name: 'seed', type: 'int', arg: 'n', description: 'make: which image to generate (default 1); the same seed always gives the same image' },
    { name: 'size', type: 'int', min: 256, max: 4096, arg: 'px', description: 'make: width and height of the image (default 1024)' },
  ],
  json: true,
  description: [
    '"make <dir>" writes <dir>/vision-check.png, a busy illustration-like picture with 12 numbered crosshair markers, and <dir>/vision-check.key.json, the answer key (encoded: do not decode it). Find the centre of every crosshair (where its four arms point; a whole number of pixels), the way you would read landmarks: "rev2d avatar grid <dir>/vision-check.png -o ..." and magnified regions. Write {"1": [x, y], ..., "12": [x, y]} to a JSON file.',
    '"score <dir> <answer.json>" prints the error of every marker, the mean and the largest error, and advice (a constant shift, a scale factor from reading a resized copy, swapped axes). It passes (exit 0) when the mean error is at most 4 px and the largest at most 10 px on a 1024 px image (the limits scale with --size); otherwise exit 1.',
  ],
  examples: ['rev2d avatar vision-check make out/vision', 'rev2d avatar grid out/vision/vision-check.png -o out/vision/grid.png', 'rev2d avatar vision-check score out/vision out/vision/answer.json', 'rev2d avatar vision-check make out/vision2 --seed 7 --size 2048 --json'],
  async run(ctx) {
    const m = await loadAvatar();
    const [action, dir, answerFile] = ctx.args.positionals;
    if (!VISION_ACTIONS.includes(action)) throw new UsageError(`unknown vision-check action "${action}"`, suggest(action, VISION_ACTIONS) ?? 'actions: make, score');
    return guarded(m, async () => {
      if (action === 'make') {
        if (answerFile !== undefined) throw new UsageError(`unexpected argument "${answerFile}"`, '"make" takes only the folder to write into; the answer file belongs to "score"');
        const check = m.avatar.makeVisionCheck({ seed: ctx.args.num('seed'), size: ctx.args.num('size') });
        const files = await m.io.writeVisionCheck(ctx.resolve(dir), check);
        const shownDir = quoteArg(ctx.display(dir));
        const next = [
          `rev2d avatar grid ${quoteArg(ctx.display(files.image))} -o ${quoteArg(ctx.display(path.join(dir, 'grid.png')))}`,
          `rev2d avatar grid ${quoteArg(ctx.display(files.image))} --region x0,y0,x1,y1 -o ${quoteArg(ctx.display(path.join(dir, 'zoom.png')))}`,
          `rev2d avatar vision-check score ${shownDir} ${quoteArg(ctx.display(path.join(dir, 'answer.json')))}`,
        ];
        const markers = Object.keys(check.key.markers).length;
        if (ctx.json) {
          ctx.printJson({ ok: true, image: files.image, key: files.key, seed: check.key.seed, size: check.key.size, markers, answerFormat: '{"1": [x, y], ..., "12": [x, y]}', next });
          return 0;
        }
        ctx.out(
          `wrote ${ctx.display(files.image)} (${check.key.size}x${check.key.size}, seed ${check.key.seed}) with ${markers} numbered crosshair markers, and its answer key ${ctx.display(files.key)} (encoded; do not decode it)`,
          `task: find the centre of every crosshair and write {"1": [x, y], ..., "${markers}": [x, y]} to a JSON file`,
          'next steps:',
          ...next.map((n) => `  ${n}`),
        );
        return 0;
      }
      if (answerFile === undefined) throw new UsageError('missing argument [answer.json]', 'e.g. rev2d avatar vision-check score out/vision out/vision/answer.json (a JSON file {"1": [x, y], ...})');
      for (const flag of ['seed', 'size']) if (ctx.args.has(flag)) throw new UsageError(`--${flag} applies to "make" only`, 'the key written by "make" remembers the seed and the size');
      const key = await m.io.readVisionCheckKey(ctx.resolve(dir));
      let text: string;
      try {
        text = await readFile(ctx.resolve(answerFile), 'utf8');
      } catch {
        throw new CliError(`cannot read the answer file ${ctx.display(answerFile)}`, { hint: 'write {"1": [x, y], ..., "12": [x, y]} to a JSON file and pass its path' });
      }
      const parsed = parseJsonc(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
      if (!parsed.ok) throw new CliError(`${ctx.display(answerFile)} is not valid JSON`, { diagnostics: [parsed.error] });
      const score = m.avatar.scoreVisionCheck(key, parsed.value);
      if (ctx.json) {
        ctx.printJson({ ok: score.pass, ...score });
        return score.pass ? 0 : 1;
      }
      const cell = (p: [number, number] | null) => (p ? `(${p[0]}, ${p[1]})` : '-');
      ctx.out(`${score.pass ? 'PASS' : 'FAIL'}  mean error ${score.mean ?? '-'} px (limit ${score.limits.mean}), largest ${score.max ?? '-'} px (limit ${score.limits.max}), ${score.answered} of ${score.total} markers answered`);
      ctx.out(...table([['marker', 'answer', 'expected', 'error px'], ...score.markers.map((s) => [s.id, cell(s.answer), cell(s.expected), s.error === null ? 'no answer' : String(s.error)])]));
      ctx.out(score.advice);
      return score.pass ? 0 : 1;
    });
  },
};

// ----------------------------------------------------------------------------- import-mas

export const avatarImportMas: Command = {
  name: 'avatar import-mas',
  group: 'edit',
  summary: 'import a Mesh Avatar Studio project (rig.json + source.png) as an avatar project',
  usage: 'avatar import-mas <mas-project-dir> <dir> [--name id] [--image file.png] [--force] [--json]',
  args: ['<mas-project-dir>', '<dir>'],
  flags: [NAME_FLAG, { name: 'image', type: 'string', arg: 'file.png', description: 'the illustration the rig was made for (default: source.png in the Mesh Avatar Studio folder, else the only PNG there)' }, FORCE_FLAG],
  json: true,
  description: [
    'Reads rig.json (version 1; <mas-project-dir> may also be the rig.json itself) and writes <dir>/avatar.json, a copy of the illustration as <dir>/source.png, and the drawn variants whose names Rev2D knows (variants/eyes_closed.png, mouth_a.png, ...). Radians become degrees; eyes[0] / eyes[1] become imageLeft / imageRight (roi -> region); the mouth line (centre, angle, half length, bow) becomes two corners; strands, buns (jiggle), accessories (pendulum with its box as outline) and the hand (cut-out with its contact point) become hair strands and attachments.',
    'Mesh Avatar Studio has no face oval and no chin point: both are estimated from its face ellipses. Everything estimated, approximated or not imported is listed as a note; the imported spec is validated against the image (exit 1 when it has errors). Look at the result with "rev2d avatar overlay" before building.',
  ],
  examples: ['rev2d avatar import-mas downloads/miko-mas projects/miko', 'rev2d avatar import-mas downloads/rig.json projects/hero --image art/hero.png --name hero --json'],
  async run(ctx) {
    const m = await loadAvatar();
    const [mas, dir] = ctx.args.positionals;
    const image = ctx.args.str('image');
    return guarded(m, async () => {
      const r = await m.io.importMasProject(ctx.resolve(mas), ctx.resolve(dir), { name: ctx.args.str('name'), force: ctx.args.bool('force') === true, image: image !== undefined ? ctx.resolve(image) : undefined });
      const errors = countOf(r.diagnostics, 'error');
      const warnings = countOf(r.diagnostics, 'warning');
      const next = nextSteps(ctx, r.dir, errors === 0).slice(-2);
      if (ctx.json) {
        ctx.printJson({
          ok: errors === 0,
          dir: r.dir,
          specFile: r.specFile,
          sourceFile: r.sourceFile,
          name: r.name,
          width: r.width,
          height: r.height,
          sources: { rig: r.rigFile, image: r.imageFile },
          variants: r.variants,
          errors,
          warnings,
          diagnostics: r.diagnostics,
          notes: r.notes,
          next,
        });
        return errors ? 1 : 0;
      }
      const doc = r.doc as { hair?: { strands?: unknown[] }; attachments?: unknown[] };
      ctx.out(
        `imported ${ctx.display(r.rigFile)} into avatar project ${ctx.display(r.dir)}: "${r.name}", ${r.width}x${r.height}, ${plural(doc.hair?.strands?.length ?? 0, 'strand')}, ${plural(doc.attachments?.length ?? 0, 'attachment')}`,
      );
      ctx.out(
        ...table([
          [ctx.display(r.sourceFile), `copy of ${ctx.display(r.imageFile)}`],
          [ctx.display(r.specFile), 'the imported spec'],
          ...r.variants.map((v) => [ctx.display(path.join(r.dir, v)), 'drawn variant']),
        ]),
      );
      ctx.out(`validation: ${plural(errors, 'error')}, ${plural(warnings, 'warning')}`);
      if (r.diagnostics.length) ctx.out(...indent(formatDiagnostics(r.diagnostics)));
      ctx.out('next steps:', ...next.map((n) => `  ${n}`));
      ctx.notes(r.notes);
      return errors ? 1 : 0;
    });
  },
};

// ----------------------------------------------------------------------------- build

/** "1.2 s" / "340 ms". */
function duration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

function kilobytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** One line per report issue: severity, code, message, hint (like diagnostics). */
function issueLines(issues: ReadonlyArray<{ severity: string; code: string; message: string; path?: string; hint?: string }>): string[] {
  return table(issues.map((i) => [i.severity, i.code, `${i.path ? `${i.path}  ` : ''}${i.message}${i.hint ? `  → ${i.hint}` : ''}`]));
}

export const avatarBuild: Command = {
  name: 'avatar build',
  group: 'edit',
  summary: 'build an avatar project: cut the layer images and generate the Rev2D model <name>.r2d.json from avatar.json + source.png',
  usage: 'avatar build <project> [--json]',
  args: ['<project>'],
  flags: [],
  json: true,
  description: [
    '<project> is the project folder or its avatar.json. Writes textures/*.png (the base layer and the cut layers), textures/layers.json (what the model compiler needs besides the spec) and <name>.r2d.json: an ordinary Rev2D model (render, sheet, inspect, analyze, edit and the exporters work on it). The model is regenerated by every build: change avatar.json, or add edit ops to its "post" list (they are applied after every build), never the model file. Unchanged files are not rewritten.',
    'The spec must have no errors ("rev2d avatar validate"); the built model is validated (0 errors) and checked for folds: every parameter at both ends, and every corner of AngleX x AngleY x AngleZ x BodyAngleX, must leave no lattice cell or triangle flipped or collapsed ("avatar-mesh-fold" warnings name the parameters and the place). Prints the model size, counts, timings, the issues of the build and the validation warnings. Exit 1 when the build fails; warnings do not fail it. Next: "rev2d avatar poses <project>" renders the review sheets.',
  ],
  examples: ['rev2d avatar build projects/miko', 'rev2d avatar build projects/miko/avatar.json --json'],
  async run(ctx) {
    const m = await loadAvatar();
    return guarded(m, async () => {
      const r = await m.io.buildAvatarProject(m.io.avatarProjectDir(ctx.resolve(ctx.args.positionals[0])));
      const warnings = r.report.issues.filter((i) => i.severity === 'warning').length + countOf(r.diagnostics, 'warning');
      const next = [`rev2d avatar poses ${quoteArg(ctx.display(r.dir))}`];
      if (ctx.json) {
        ctx.printJson({
          ok: true,
          dir: r.dir,
          name: r.name,
          modelFile: r.modelFile,
          modelBytes: r.modelBytes,
          layersFile: r.layersFile,
          layers: r.layers,
          removed: r.removed,
          postOps: r.postOps,
          warnings,
          issues: r.report.issues,
          stats: r.report.stats,
          diagnostics: r.diagnostics,
          timings: r.timings,
          next,
        });
        return 0;
      }
      const s = r.report.stats;
      const t = r.timings;
      ctx.out(`built ${ctx.display(r.dir)}: "${r.name}", ${kilobytes(r.modelBytes)} model, ${plural(r.layers.length, 'layer image')}, ${plural(warnings, 'warning')}`);
      ctx.out(
        ...table([
          [ctx.display(r.modelFile), `${plural(s.parameters ?? 0, 'parameter')}, ${plural(s.warps ?? 0, 'warp')} (${s.latticePoints ?? 0} lattice points; root ${s.latticeCols ?? '?'} x ${s.latticeRows ?? '?'} cells), ${plural(s.parts ?? 0, 'part')}, ${plural(s.bindings ?? 0, 'binding')}${r.postOps ? `, ${plural(r.postOps, 'post op')}` : ''}`],
          [ctx.display(path.join(r.dir, 'textures')), `${r.layers.map((f) => path.basename(f)).join(', ')} + layers.json${r.removed.length ? ` (removed: ${r.removed.map((f) => path.basename(f)).join(', ')})` : ''}`],
          ['time', `${duration(t.totalMs)} (layers ${duration(t.layersMs)}, compile ${duration(t.compileMs)}, validate ${duration(t.validateMs)}, fold check ${duration(t.foldsMs)}, write ${duration(t.writeMs)})`],
        ]),
      );
      if (r.report.issues.length) ctx.out('build issues:', ...issueLines(r.report.issues));
      if (r.diagnostics.length) ctx.out('model validation:', ...indent(formatDiagnostics(r.diagnostics)));
      ctx.out('next steps:', ...next.map((n) => `  ${n}`));
      return 0;
    });
  },
};

// ----------------------------------------------------------------------------- poses

export const avatarPoses: Command = {
  name: 'avatar poses',
  group: 'edit',
  summary: 'render the review sheets of a built avatar: review/poses.png, turn.png, eyes.png, mouth.png and summary.json',
  usage: 'avatar poses <project> [--scale n] [--json]',
  args: ['<project>'],
  flags: [{ name: 'scale', type: 'number', greaterThan: 0, arg: 'n', description: 'multiply the size of every cell (default 1: cells of about 400 px, a review in a few seconds; 2 shows more detail)' }],
  json: true,
  description: [
    'The check after "rev2d avatar build": look at every sheet. review/poses.png is one captioned contact sheet of the review poses (rest, eyes half / closed, mouth open, turn left / right, look up / down, tilt both ways, body sway both ways, plus poses of the built features); review/turn.png is the 3 x 3 grid AngleX x AngleY (top row looks up); review/eyes.png and review/mouth.png show the eye and mouth poses cropped and magnified; review/summary.json lists the sheets, the poses with their parameter values, notes and timings.',
    'Cells are rendered small, on a mid-grey background with room around the canvas (a tilted head leaves it), so halos, torn or folded mesh, a cut chin or a double edge show. Poses whose parameters the model does not have are skipped and named in a note. For one pose at full size use "rev2d render <project>/<name>.r2d.json --param AngleX=30 -o out.png"; add "--overlay warps" to see the lattice.',
  ],
  examples: ['rev2d avatar poses projects/miko', 'rev2d avatar poses projects/miko --scale 2 --json'],
  async run(ctx) {
    const m = await loadAvatar();
    return guarded(m, async () => {
      const r = await m.io.reviewAvatarProject(m.io.avatarProjectDir(ctx.resolve(ctx.args.positionals[0])), { scale: ctx.args.num('scale') });
      if (ctx.json) {
        ctx.printJson({ ok: true, dir: r.dir, modelFile: r.modelFile, sheets: r.sheets, poses: r.poses, summaryFile: r.summaryFile, notes: r.notes, timings: r.timings });
        return 0;
      }
      const rendered = r.poses.filter((p) => !p.skipped).length;
      ctx.out(`reviewed ${ctx.display(r.modelFile)}: ${plural(rendered, 'pose')} on ${plural(r.sheets.length, 'sheet')} in ${duration(r.timings.totalMs)}`);
      ctx.out(
        ...table([
          ...r.sheets.map((s) => [ctx.display(s.file), `${s.width}x${s.height}`, `${plural(s.cells, 'cell')} at x${s.scale}: ${s.captions.join(' | ')}`]),
          [ctx.display(r.summaryFile), '', 'sheets, poses and their parameters, notes, timings'],
        ]),
      );
      ctx.notes(r.notes);
      return 0;
    });
  },
};

// ----------------------------------------------------------------------------- variants

type VariantsIO = typeof import('../../node/avatar-variants.js');
type VariantId = import('../../avatar/types.js').VariantId;
type VariantCheckResult = import('../../avatar/variants.js').VariantCheckResult;

/** The drawn-variant IO module, loaded on demand. */
async function loadVariants(): Promise<VariantsIO> {
  return import('../../node/avatar-variants.js');
}

const VARIANT_ACTIONS = ['request', 'import', 'status'];

/** Variant ids from the command line (also comma-separated), checked: an unknown one is a usage error with did-you-mean. */
function variantIds(m: AvatarModules, raw: string[]): VariantId[] {
  const known = [...m.avatar.VARIANT_IDS] as string[];
  const ids: VariantId[] = [];
  for (const r of raw.flatMap((x) => x.split(',')).map((x) => x.trim()).filter((x) => x !== '')) {
    if (!m.avatar.isVariantId(r)) throw new UsageError(`unknown variant "${r}"`, suggest(r, known) ?? `variants: ${known.join(', ')}`);
    if (!ids.includes(r)) ids.push(r);
  }
  return ids;
}

const pct = (share: number) => `${Math.round(share * 1000) / 10}%`;

/** "outside 0.41 (limit 2), changed inside 34% (image left 35%, image right 33%)". */
function checkNumbers(c: VariantCheckResult): string {
  const name = (k: string) => (k === 'imageLeft' ? 'image left' : k === 'imageRight' ? 'image right' : k);
  const areas = c.areas.length > 1 ? ` (${c.areas.map((a) => `${name(a.key)} ${pct(a.changed)}`).join(', ')})` : '';
  return `outside ${c.outsideDiff} (limit ${c.tolerance}), changed inside ${pct(c.insideChanged)}${areas}`;
}

export const avatarVariants: Command = {
  name: 'avatar variants',
  group: 'edit',
  summary: 'drawn eye / mouth variants: "request" masks and prompts for an image generator, "import" the drawings as sprites, "status" of every variant',
  usage: 'avatar variants <request|import|status> <project> [ids...] [--all] [--json]',
  args: ['<request|import|status>', '<project>', '[ids...]'],
  flags: [{ name: 'all', type: 'boolean', description: 'request: every variant instead of the recommended ones' }],
  json: true,
  description: [
    'Closed eyes and an open mouth look far better DRAWN than deformed: an image generator redraws the eyes or the mouth of a full-size copy of the illustration, and Rev2D cuts the redrawn area out as a sprite that replaces the mesh deformation (the mesh stays the fallback of every variant without a drawing). Variants: eyes_closed, eyes_half, eyes_smile (EyeLSmile / EyeRSmile), mouth_a, mouth_a_half, mouth_i, mouth_u, mouth_e, mouth_o (each shown at its place on the MouthOpen x MouthForm viseme table; the nearest drawn one stands in for a missing one). [ids...] may also be comma-separated.',
    '"request <project> [ids...]" writes, per variant, variant-requests/<id>.mask.png (the edit mask at the source size: OPAQUE black = must stay identical, TRANSPARENT = may change; eye variants share both eye regions slightly grown, mouth variants the mouth area ellipse) and variant-requests/<id>.prompt.txt (what to draw, where, and the hard constraints: same size and framing, every pixel outside the mask unchanged, nothing added), plus README.md (the flow and the rules of the check) and preview.png (the editable areas tinted). Without ids: eyes_closed and mouth_a, the recommended ones (--all: every variant); requests written before are written again.',
    '"import <project> [ids...]" checks every variants/<id>.png: exactly the size of the source; outside the mask a mean difference of at most build.variantTolerance (default 2 of 255, so recompression noise passes), at most 0.5% of the pixels changed by more than 40 levels and no colour step in the ring around the editable area (the transparent background does not count); a global shift or zoom is found and named; inside, at least 2% of the editable area (of EACH eye) must change. Accepted drawings are cut into feathered sprite layers (textures/sprite_<id>_<area>.png: one per eye, or the mouth area), recorded in textures/layers.json with fingerprints of the drawing and of the landmarks, and the model is rebuilt from the existing layers. A rejected drawing is reported with the reason and what to ask the image generator next; an earlier accepted sprite of that variant stays. Deleting variants/<id>.png and importing again removes its sprite. Exit 1 when a drawing is rejected (the accepted ones are imported all the same).',
    '"status <project>" lists every variant as missing, requested, drawn (not imported yet), accepted, rejected (with the reason) or stale (the drawing, the eye regions or the mouth area changed since the sprite was cut: import again). "rev2d avatar build" keeps the sprites; review them with "rev2d avatar poses" (review/eyes.png, review/mouth.png).',
  ],
  examples: [
    'rev2d avatar variants request projects/miko',
    'rev2d avatar variants request projects/miko eyes_closed eyes_half mouth_a',
    'rev2d avatar variants import projects/miko',
    'rev2d avatar variants status projects/miko --json',
  ],
  async run(ctx) {
    const m = await loadAvatar();
    const [action, target, ...rawIds] = ctx.args.positionals;
    if (!VARIANT_ACTIONS.includes(action)) throw new UsageError(`unknown variants action "${action}"`, suggest(action, VARIANT_ACTIONS) ?? `actions: ${VARIANT_ACTIONS.join(', ')}`);
    const all = ctx.args.bool('all') === true;
    if (all && action !== 'request') throw new UsageError('--all applies to "request" only', '"import" takes every drawing in variants/ (or the ids you name); "status" lists every variant anyway');
    if (action === 'status' && rawIds.length) throw new UsageError(`unexpected argument "${rawIds[0]}"`, '"status" lists every variant; it takes only the project');
    const ids = all ? [...m.avatar.VARIANT_IDS] : variantIds(m, rawIds);
    const v = await loadVariants();
    const dir = m.io.avatarProjectDir(ctx.resolve(target));
    const shown = quoteArg(ctx.display(dir));
    return guarded(m, async () => {
      if (action === 'request') {
        const r = await v.writeAvatarVariantRequests(dir, { ids, project: shown });
        const next = [`draw each variant as variant-requests/<id>.prompt.txt says and save it as variants/<id>.png (${r.size[0]}x${r.size[1]} px)`, `rev2d avatar variants import ${shown}`];
        if (ctx.json) {
          ctx.printJson({ ok: true, dir: r.dir, size: r.size, transparent: r.transparent, requests: r.requests, readme: r.readme, preview: r.preview, files: r.files, notes: r.notes, next });
          return 0;
        }
        ctx.out(`wrote ${plural(r.requests.length, 'variant request')} for ${shown} (${r.requests.map((q) => q.id).join(', ')}); the drawings must be ${r.size[0]}x${r.size[1]} px`);
        ctx.out(
          ...table([
            ...r.requests.map((q) => [ctx.display(path.join(r.dir, q.promptFile)), `${q.label}${q.recommended ? ' (recommended)' : ''}: save the drawing as ${q.file}`]),
            ...[...new Set(r.requests.map((q) => q.group))].map((g) => {
              const q = r.requests.find((x) => x.group === g)!;
              return [ctx.display(path.join(r.dir, 'variant-requests', `${g === 'eyes' ? '{eyes_*}' : '{mouth_*}'}.mask.png`)), `edit masks: ${g === 'eyes' ? 'both eye areas' : 'the mouth area'} may change (${q.areas.map((a) => `${a.key} x ${Math.round(a.bounds[0])}..${Math.round(a.bounds[2])}, y ${Math.round(a.bounds[1])}..${Math.round(a.bounds[3])}`).join('; ')})`];
            }),
            [ctx.display(r.readme), 'how to draw and import them, and what the import checks'],
            [ctx.display(r.preview), 'the editable areas tinted on the illustration'],
          ]),
        );
        ctx.out('next steps:', ...next.map((n) => `  ${n}`));
        ctx.notes(r.notes);
        return 0;
      }

      if (action === 'import') {
        const r = await v.importAvatarVariants(dir, { ids });
        const ok = r.rejected.length === 0;
        const next = ok ? [`rev2d avatar poses ${shown}`] : ['draw the rejected variants again as their hints say, then import again', `rev2d avatar poses ${shown}`];
        const warnings = r.report.issues.filter((i) => i.severity === 'warning').length + countOf(r.diagnostics, 'warning');
        if (ctx.json) {
          ctx.printJson({
            ok,
            dir: r.dir,
            accepted: r.accepted,
            rejected: r.rejected,
            kept: r.kept,
            removed: r.removed,
            variants: r.variants,
            checks: r.checks,
            unreadable: r.unreadable,
            ignored: r.ignored,
            sprites: r.sprites,
            deleted: r.deleted,
            layersFile: r.layersFile,
            modelFile: r.modelFile,
            modelBytes: r.modelBytes,
            warnings,
            issues: r.report.issues,
            diagnostics: r.diagnostics,
            notes: r.notes,
            timings: r.timings,
            next,
          });
          return ok ? 0 : 1;
        }
        const total = r.checks.length + r.unreadable.length;
        ctx.out(`imported ${plural(total, 'drawing')} of ${shown}: ${r.accepted.length} accepted, ${r.rejected.length} rejected${r.removed.length ? `, ${plural(r.removed.length, 'sprite')} removed` : ''}`);
        const rows: string[][] = [];
        for (const c of r.checks) {
          if (c.ok) rows.push([c.id, 'accepted', checkNumbers(c)]);
          else rows.push([c.id, 'REJECTED', c.reason ?? ''], ['', '', `hint: ${c.hint ?? ''}`]);
        }
        for (const u of r.unreadable) rows.push([u.id, 'REJECTED', u.reason], ...(u.hint ? [['', '', `hint: ${u.hint}`]] : []));
        for (const id of r.removed) rows.push([id, 'removed', `variants/${id}.png is gone: its sprite was removed`]);
        for (const i of r.ignored) rows.push([i.file, 'ignored', `${i.reason}${i.hint ? ` (${i.hint})` : ''}`]);
        ctx.out(...table(rows));
        ctx.out(`model: ${ctx.display(r.modelFile)} (${kilobytes(r.modelBytes)}), sprites: ${r.variants.length ? r.variants.join(', ') : 'none'}${warnings ? `, ${plural(warnings, 'warning')}` : ''}`);
        if (r.report.issues.length) ctx.out('build issues:', ...issueLines(r.report.issues));
        if (r.diagnostics.length) ctx.out('model validation:', ...indent(formatDiagnostics(r.diagnostics)));
        ctx.out('next steps:', ...next.map((n) => `  ${n}`));
        ctx.notes(r.notes);
        return ok ? 0 : 1;
      }

      const r = await v.avatarVariantStatus(dir);
      if (ctx.json) {
        ctx.printJson({ ok: true, dir: r.dir, name: r.name, built: r.built, variants: r.variants, counts: r.counts, ignored: r.ignored, notes: r.notes });
        return 0;
      }
      const summary = (['accepted', 'stale', 'rejected', 'drawn', 'requested'] as const).filter((k) => r.counts[k]).map((k) => `${r.counts[k]} ${k}`);
      ctx.out(`variants of ${shown}: ${summary.length ? summary.join(', ') : 'none requested or drawn yet'}`);
      ctx.out(
        ...table([
          ['variant', 'state', 'request', 'drawing', 'sprite', 'details'],
          ...r.variants.map((s) => [
            s.id,
            s.state,
            s.requested ? 'yes' : '-',
            s.drawn ? 'yes' : '-',
            s.sprite ? 'yes' : '-',
            s.unreadable ?? s.rejection?.reason ?? (s.stale.length ? s.stale.join('; ') : s.check ? `outside ${s.check.outsideDiff}, changed inside ${pct(s.check.insideChanged)}` : s.recommended && s.state === 'missing' ? 'recommended' : ''),
          ]),
        ]),
      );
      for (const i of r.ignored) ctx.out(`  ignored ${i.file}: ${i.reason}${i.hint ? ` (${i.hint})` : ''}`);
      ctx.notes(r.notes);
      return 0;
    });
  },
};

// ----------------------------------------------------------------------------- registry

/** Every "rev2d avatar ..." subcommand, in help order. Append new ones (variants, ...) here. */
export const AVATAR_COMMANDS: Command[] = [avatarNew, avatarImportMas, avatarValidate, avatarGrid, avatarOverlay, avatarBuild, avatarPoses, avatarVariants, avatarVisionCheck, avatarSchema];

/** The "avatar" parent entry of the dispatcher; its summary lists the subcommands. */
export const AVATAR_PARENT: { summary: string; subcommands: Command[] } = {
  get summary() {
    return `an animated avatar from one illustration (${AVATAR_COMMANDS.map((c) => c.name.split(' ')[1]).join(', ')})`;
  },
  subcommands: AVATAR_COMMANDS,
};
