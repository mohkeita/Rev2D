/** Library commands share all IO with MCP through src/node/library.ts. */
import type { Command } from '../command.js';
import { UsageError, type FlagSpec } from '../args.js';
import { CliError, type Ctx } from '../context.js';
import { LibraryError, libraryDiagnostic, LIBRARY_KINDS, type LibraryKind } from '../../library/schema.js';

const string = (name: string, description: string, short?: string): FlagSpec => ({
  name,
  description,
  type: 'string',
  short,
});
const kind = string('kind', 'asset kind: character, background, prop, bubble or ui');
const character = string('character', 'character id'),
  pose = string('pose', 'pose id (or description for requests)'),
  out = string('out', 'new output file or request directory', 'o');
function required(ctx: Ctx, name: string): string {
  const v = ctx.args.str(name);
  if (!v) throw new UsageError(`--${name} is required`);
  return v;
}
function assetKind(ctx: Ctx, optional = false): LibraryKind | undefined {
  const v = ctx.args.str('kind')?.replace(/s$/, '');
  if (!v && optional) return;
  if (!LIBRARY_KINDS.includes(v as LibraryKind))
    throw new UsageError('unknown or missing asset kind', 'use character, background, prop, bubble or ui');
  return v as LibraryKind;
}
function options(ctx: Ctx) {
  return {
    kind: assetKind(ctx, true),
    character: ctx.args.str('character'),
    tags: ctx.args.str('tags')?.split(',').filter(Boolean),
    text: ctx.args.str('text'),
  };
}
async function guarded(ctx: Ctx, fn: () => Promise<{ data: unknown; ok?: boolean }>) {
  try {
    const r = await fn();
    ctx.json ? ctx.printJson(r.data) : ctx.out(JSON.stringify(r.data, null, 2));
    return r.ok === false ? 1 : 0;
  } catch (e) {
    if (e instanceof UsageError) throw e;
    const err = e as Error & { diagnostics?: import('../../core/types.js').Diagnostic[]; hint?: string };
    throw new CliError(err.message, {
      diagnostics: err.diagnostics ?? [
        libraryDiagnostic(
          'library-io',
          '',
          err.message,
          err.hint ?? 'check the paths, output collisions and filesystem permissions',
        ),
      ],
      hint: err.hint ?? (e instanceof LibraryError ? e.diagnostics[0]?.hint : undefined),
    });
  }
}
const cmd = (
  verb: string,
  args: string[],
  flags: FlagSpec[],
  summary: string,
  run: (ctx: Ctx) => Promise<{ data: unknown; ok?: boolean }>,
): Command => ({
  name: 'library ' + verb,
  group: 'edit',
  summary,
  usage: `library ${verb} ${args.join(' ')} [--json]`,
  args,
  flags,
  json: true,
  description: [
    summary + '. Read docs/LIBRARY.md for the file format and the import, landmark, build and review workflow.',
  ],
  examples: [],
  run: (ctx) => guarded(ctx, () => run(ctx)),
});
export const LIBRARY_COMMANDS: Command[] = [
  cmd('init', ['<dir>'], [string('name', 'library name')], 'create a reusable asset library', async (ctx) => {
    const io = await import('../../node/library.js');
    return { data: await io.initLibrary(ctx.resolve(ctx.args.positionals[0]), ctx.args.str('name')) };
  }),
  cmd('validate', ['<dir>'], [], 'validate assets, poses, anchors and parameter consistency', async (ctx) => {
    const io = await import('../../node/library.js');
    const r = await io.validateLibrary(ctx.resolve(ctx.args.positionals[0]));
    return { data: r, ok: r.ok };
  }),
  ...['list', 'search'].map((verb) =>
    cmd(
      verb,
      ['<dir>'],
      [
        kind,
        character,
        string('tags', 'comma-separated tags (all must match)'),
        string('text', 'case/accent-insensitive search text'),
      ],
      'find reusable assets and character poses',
      async (ctx) => {
        const io = await import('../../node/library.js'),
          { searchLibrary } = await import('../../library/search.js');
        return { data: searchLibrary(await io.readLibrary(ctx.resolve(ctx.args.positionals[0])), options(ctx)) };
      },
    ),
  ),
  cmd(
    'import',
    ['<image>'],
    [
      string('into', 'destination library'),
      kind,
      character,
      pose,
      string('id', 'asset id'),
      string('name', 'display name for a new character'),
      string('description', 'identity description for a new character'),
      string('tags', 'comma-separated tags'),
      string('key', 'auto, white or #RRGGBB'),
      { name: 'tolerance', type: 'number', description: 'Lab key tolerance', greaterThan: 0, max: 100 },
      { name: 'trim', type: 'boolean', description: 'trim the transparent margin (default true)' },
      { name: 'padding', type: 'int', description: 'padding in source pixels', min: 0, max: 4096 },
      string('remover', 'external executable accepting input-path output-path (no shell)'),
    ],
    'key and import one PNG without replacing an existing asset',
    async (ctx) => {
      const k = assetKind(ctx);
      if (k === 'ui') throw new UsageError('UI entries reference authored model files; add them to library.json');
      const io = await import('../../node/library.js');
      return {
        data: await io.importLibraryImage(ctx.resolve(ctx.args.positionals[0]), ctx.resolve(required(ctx, 'into')), {
          kind: k!,
          id: ctx.args.str('id'),
          character: ctx.args.str('character'),
          pose: ctx.args.str('pose'),
          name: ctx.args.str('name'),
          description: ctx.args.str('description'),
          tags: ctx.args.str('tags')?.split(',').filter(Boolean),
          key: ctx.args.str('key'),
          tolerance: ctx.args.num('tolerance'),
          trim: ctx.args.bool('trim'),
          padding: ctx.args.num('padding'),
          remover: ctx.args.str('remover'),
        }),
      };
    },
  ),
  cmd(
    'request',
    ['<dir>'],
    [
      kind,
      character,
      pose,
      string('id', 'background/prop/bubble description'),
      out,
      string('size', 'expected image size WxH'),
    ],
    'write a generation prompt and copied reference attachments',
    async (ctx) => {
      const k = assetKind(ctx);
      if (k === 'ui') throw new UsageError('UI assets are authored Rev2D models');
      let size: [number, number] | undefined;
      const s = ctx.args.str('size');
      if (s) {
        const m = /^(\d+)x(\d+)$/.exec(s);
        if (!m || +m[1] < 1 || +m[2] < 1 || +m[1] > 8192 || +m[2] > 8192)
          throw new UsageError('size must be WxH within 1..8192');
        size = [+m[1], +m[2]];
      }
      const io = await import('../../node/library.js');
      return {
        data: await io.requestLibraryImage(ctx.resolve(ctx.args.positionals[0]), ctx.resolve(required(ctx, 'out')), {
          kind: k!,
          character: ctx.args.str('character'),
          pose: ctx.args.str('pose'),
          id: ctx.args.str('id'),
          size,
        }),
      };
    },
  ),
  cmd('rig', ['<dir>'], [character, pose], 'build a pose from its authored avatar landmarks', async (ctx) => {
    const io = await import('../../node/library.js');
    return {
      data: await io.rigLibraryPose(
        ctx.resolve(ctx.args.positionals[0]),
        required(ctx, 'character'),
        required(ctx, 'pose'),
      ),
    };
  }),
  cmd('sheet', ['<dir>'], [out, kind, character], 'render a contact sheet of imported artwork', async (ctx) => {
    const io = await import('../../node/library.js'),
      { encodePNG } = await import('../../render/png.js');
    const file = required(ctx, 'out');
    const r = await io.librarySheet(ctx.resolve(ctx.args.positionals[0]), options(ctx));
    const { writeFile, mkdir } = await import('node:fs/promises'),
      path = await import('node:path');
    await mkdir(path.dirname(ctx.resolve(file)), { recursive: true });
    await writeFile(ctx.resolve(file), encodePNG(r.image), { flag: 'wx' });
    return {
      data: { file: ctx.resolve(file), assets: r.entries.length, width: r.image.width, height: r.image.height },
    };
  }),
];
export const LIBRARY_PARENT = {
  summary: 'manage reusable backgrounds, character poses, props, bubbles and UI',
  subcommands: LIBRARY_COMMANDS,
};
