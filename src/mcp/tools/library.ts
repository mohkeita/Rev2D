/** Asset-library and avatar IO wrappers; no network calls or inferred landmarks. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ImageRGBA } from '../../core/types.js';
import { LibraryError, libraryDiagnostic, searchLibrary, LIBRARY_KINDS } from '../../library/index.js';
import { encodePNG, decodePNG, resizeNearest } from '../../render/index.js';
import { addTool, json, image, result, resolvePath, ToolError, type ToolContext } from '../context.js';

async function guarded(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof LibraryError) throw new ToolError(e.message, e.diagnostics, e.diagnostics[0]?.hint);
    const err = e as Error & { diagnostics?: import('../../core/types.js').Diagnostic[]; hint?: string };
    if (err.diagnostics) throw new ToolError(err.message, err.diagnostics, err.hint);
    throw new ToolError(
      err.message,
      [
        libraryDiagnostic(
          'library-io',
          '',
          err.message,
          err.hint ?? 'check the paths, output collisions and filesystem permissions',
        ),
      ],
      err.hint,
    );
  }
}
function preview(img: ImageRGBA) {
  const s = Math.min(1, 1024 / Math.max(img.width, img.height));
  return image(
    encodePNG(
      s === 1
        ? img
        : resizeNearest(img, Math.max(1, Math.round(img.width * s)), Math.max(1, Math.round(img.height * s))),
    ),
  );
}
async function save(file: string, bytes: Uint8Array) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes, { flag: 'wx' });
}
const Path = z.string().min(1),
  Kind = z.enum(LIBRARY_KINDS);
export function registerLibraryTools(server: McpServer, ctx: ToolContext): void {
  addTool(
    server,
    'rev2d_library_search',
    {
      title: 'Search reusable assets',
      description:
        'Find reusable background, prop, bubble, UI and character-pose assets by kind, character, tags (all must match) and case/accent-insensitive text. Returns relative paths and tags. Read rev2d_docs topic library first; search does not prove that a pose is rigged.',
      input: z.strictObject({
        path: Path,
        kind: Kind.optional(),
        character: Path.optional(),
        tags: z.array(z.string()).optional(),
        text: z.string().optional(),
      }),
      effect: 'read-only',
    },
    (a) =>
      guarded(async () => {
        const io = await import('../../node/library.js');
        return result([json(searchLibrary(await io.readLibrary(resolvePath(ctx, a.path)), a))]);
      }),
  );
  addTool(
    server,
    'rev2d_library_validate',
    {
      title: 'Validate a library',
      description:
        'Check library.json, files, duplicate ids, pose anchors, avatar build freshness, models and parameter consistency between poses. Returns stable library-* diagnostics with JSON pointers and correction hints. A valid manifest alone does not approve the artwork.',
      input: z.strictObject({ path: Path }),
      effect: 'read-only',
    },
    (a) =>
      guarded(async () => {
        const io = await import('../../node/library.js'),
          r = await io.validateLibrary(resolvePath(ctx, a.path));
        return result([json(r)], !r.ok);
      }),
  );
  addTool(
    server,
    'rev2d_library_import',
    {
      title: 'Import a PNG asset',
      description:
        'Import one PNG into an existing library. Characters, props and bubbles are keyed from a uniform background and trimmed; backgrounds stay intact. Import never replaces an existing asset or its landmarks. Character import creates a draft avatar requiring placed landmarks, build and visual review.',
      input: z.strictObject({
        path: Path,
        image: Path,
        kind: z.enum(['character', 'background', 'prop', 'bubble']),
        id: Path.optional(),
        character: Path.optional(),
        pose: Path.optional(),
        name: Path.optional(),
        description: z.string().optional(),
        tags: z.array(z.string()).optional(),
        key: z.string().optional(),
        tolerance: z.number().positive().max(100).optional(),
        trim: z.boolean().optional(),
        padding: z.number().int().min(0).max(4096).optional(),
      }),
      effect: 'additive',
    },
    (a) =>
      guarded(async () => {
        const io = await import('../../node/library.js');
        return result([json(await io.importLibraryImage(resolvePath(ctx, a.image), resolvePath(ctx, a.path), a))]);
      }),
  );
  addTool(
    server,
    'rev2d_library_request',
    {
      title: 'Request missing artwork',
      description:
        'Write a local generation request: prompt.txt, request.json and copies of the character references. No network or image generator is called. Attach these files to your generator, review identity and pose, then import the resulting PNG. The output directory must be new.',
      input: z.strictObject({
        path: Path,
        out: Path,
        kind: z.enum(['character', 'background', 'prop', 'bubble']),
        character: Path.optional(),
        pose: Path.optional(),
        id: Path.optional(),
        size: z.tuple([z.number().int().positive().max(8192), z.number().int().positive().max(8192)]).optional(),
      }),
      effect: 'additive',
    },
    (a) =>
      guarded(async () => {
        const io = await import('../../node/library.js');
        return result([json(await io.requestLibraryImage(resolvePath(ctx, a.path), resolvePath(ctx, a.out), a))]);
      }),
  );
  addTool(
    server,
    'rev2d_library_sheet',
    {
      title: 'Preview library artwork',
      description:
        'Render a captioned contact sheet of library artwork, optionally filtered by kind and character. Returns a PNG inline and an entry list; save_to writes a new full-resolution PNG. This previews imported art, not the rig animation: use avatar poses and library validate to review those.',
      input: z.strictObject({
        path: Path,
        kind: Kind.optional(),
        character: Path.optional(),
        save_to: Path.optional(),
      }),
      effect: 'additive',
    },
    (a) =>
      guarded(async () => {
        const io = await import('../../node/library.js'),
          r = await io.librarySheet(resolvePath(ctx, a.path), a);
        if (a.save_to) await save(resolvePath(ctx, a.save_to), encodePNG(r.image));
        return result([preview(r.image), json({ entries: r.entries, save_to: a.save_to })]);
      }),
  );

  addTool(
    server,
    'rev2d_avatar_new',
    {
      title: 'Create an avatar project',
      description:
        'Copy one PNG into a new avatar project and create avatar.json with unplaced landmarks. The source illustration is never modified. Read the avatar documentation, use grid and overlay to place landmarks, then validate, build and review poses. No full-body articulation is inferred.',
      input: z.strictObject({ path: Path, out: Path, name: Path.optional() }),
      effect: 'additive',
    },
    (a) =>
      guarded(async () => {
        const io = await import('../../node/avatar.js');
        return result([
          json(await io.createAvatarProject(resolvePath(ctx, a.path), resolvePath(ctx, a.out), { name: a.name })),
        ]);
      }),
  );
  addTool(
    server,
    'rev2d_avatar_validate',
    {
      title: 'Validate avatar landmarks',
      description:
        'Load an avatar project and report spec and source diagnostics, missing landmarks, model existence and layer freshness. Does not build or change files. Repair every error before building; visual quality still requires looking at the overlay and all pose sheets.',
      input: z.strictObject({ path: Path }),
      effect: 'read-only',
    },
    (a) =>
      guarded(async () => {
        const io = await import('../../node/avatar.js'),
          p = await io.loadAvatarProject(resolvePath(ctx, a.path));
        const ok = !p.diagnostics.some((d) => d.severity === 'error');
        return result(
          [json({ ok, diagnostics: p.diagnostics, modelExists: p.modelExists, layersStale: p.layersStale })],
          !ok,
        );
      }),
  );
  addTool(
    server,
    'rev2d_avatar_grid',
    {
      title: 'Read source pixel coordinates',
      description:
        'Return the avatar illustration with a coordinate grid as an inline PNG. Use region [x0,y0,x1,y1] to inspect eyes, mouth and joints at source pixel precision before placing landmarks. Optional save_to writes a new PNG; source.png and avatar.json remain unchanged.',
      input: z.strictObject({
        path: Path,
        region: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
        step: z.number().positive().optional(),
        scale: z.number().int().min(1).max(4).optional(),
        save_to: Path.optional(),
      }),
      effect: 'additive',
    },
    (a) =>
      guarded(async () => {
        const io = await import('../../node/avatar.js'),
          { avatarGrid } = await import('../../avatar/tools/grid.js'),
          p = await io.loadAvatarProject(resolvePath(ctx, a.path));
        if (!p.source) throw new ToolError('avatar source PNG is missing');
        const r = avatarGrid(p.source, a);
        if (a.save_to) await save(resolvePath(ctx, a.save_to), encodePNG(r.image));
        return result([preview(r.image), json({ region: r.region, scale: r.scale, step: r.step, origin: r.origin })]);
      }),
  );
  addTool(
    server,
    'rev2d_avatar_overlay',
    {
      title: 'Review placed landmarks',
      description:
        'Draw avatar landmarks on the source illustration and return a PNG inline. Select part (for example eyes.imageLeft), zoom and grid to inspect placement. The metadata lists drawn and missing items. Optional save_to creates a new PNG. Correct the spec before building a bad landmark.',
      input: z.strictObject({
        path: Path,
        part: Path.optional(),
        zoom: z.boolean().optional(),
        grid: z.boolean().optional(),
        scale: z.number().int().min(1).max(4).optional(),
        save_to: Path.optional(),
      }),
      effect: 'additive',
    },
    (a) =>
      guarded(async () => {
        const io = await import('../../node/avatar.js'),
          { avatarOverlay } = await import('../../avatar/tools/overlay.js'),
          p = await io.loadAvatarProject(resolvePath(ctx, a.path));
        if (!p.source) throw new ToolError('avatar source PNG is missing');
        const r = avatarOverlay(p.source, p.doc, a);
        if (a.save_to) await save(resolvePath(ctx, a.save_to), encodePNG(r.image));
        return result([preview(r.image), json({ region: r.region, drawn: r.drawn, missing: r.missing })]);
      }),
  );
  addTool(
    server,
    'rev2d_avatar_build',
    {
      title: 'Build an avatar rig',
      description:
        'Build an avatar project from its authored avatar.json and source.png, writing layer PNGs and the generated Rev2D model. Does not guess landmarks or call a generator. Returns validation diagnostics and fold findings. Inspect every review sheet before treating the pose as production-ready.',
      input: z.strictObject({ path: Path }),
      effect: 'destructive',
    },
    (a) =>
      guarded(async () => {
        const io = await import('../../node/avatar.js');
        const dir = resolvePath(ctx, a.path),
          built = await io.buildAvatarProject(dir);
        const { recordAvatarBuild } = await import('../../node/library.js');
        await recordAvatarBuild(dir);
        return result([json(built)]);
      }),
  );
  addTool(
    server,
    'rev2d_avatar_poses',
    {
      title: 'Review avatar motion',
      description:
        'Render the standard rest, turn, eye and mouth review sheets of a built avatar, writing review/ images and summary.json. Returns each sheet as an inline PNG plus review metrics. Look for torn silhouettes, folds, mouth distortion and bad blinks; numeric validity alone is not artistic approval.',
      input: z.strictObject({ path: Path, scale: z.number().positive().max(2).optional() }),
      effect: 'additive',
    },
    (a) =>
      guarded(async () => {
        const io = await import('../../node/avatar.js'),
          r = await io.reviewAvatarProject(resolvePath(ctx, a.path), { scale: a.scale ?? 0.5 });
        const content = [];
        for (const sheet of r.sheets) content.push(preview(decodePNG(await readFile(sheet.file))));
        return result([...content, json(r)]);
      }),
  );
}
