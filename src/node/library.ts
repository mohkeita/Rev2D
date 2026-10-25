/** Library file IO. src/library remains pure; originals and built avatar specs are never overwritten by import. */
import { mkdir, readFile, writeFile, rename, rm, stat, realpath, open, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { z } from 'zod';
import { formatModelJson } from '../core/format.js';
import { parseJsonc } from '../core/validate.js';
import { buildRenderList } from '../core/rig.js';
import type { Diagnostic, ImageRGBA } from '../core/types.js';
import { composeSheet, createImage, resizeNearest, blitImage, encodePNG, type SheetCell } from '../render/index.js';
import {
  LibrarySchema,
  LibraryError,
  libraryDiagnostic,
  parseLibrary,
  searchLibrary,
  keyImage,
  generationRequest,
  type Library,
  type LibraryKind,
  type SearchOptions,
  type RequestOptions,
  type KeyOptions,
} from '../library/index.js';
import { createAvatarProject, loadAvatarProject, buildAvatarProject, readPngFile } from './avatar.js';
import { loadModelFile } from './load.js';
import { renderImage } from '../render/index.js';

export async function libraryFile(dir: string, relative: string): Promise<string> {
  const root = path.resolve(dir),
    file = path.resolve(root, relative),
    rel = path.relative(root, file);
  if (
    !relative ||
    relative.includes('\\') ||
    path.isAbsolute(relative) ||
    /^[A-Za-z]:/.test(relative) ||
    rel === '..' ||
    rel.startsWith('..' + path.sep) ||
    !rel
  )
    throw new LibraryError([
      libraryDiagnostic(
        'library-path-outside',
        '/path',
        `path "${relative}" leaves the library`,
        'use a relative path inside the library',
      ),
    ]);
  // Check existing ancestors as well as leaves: an output must not follow a symlink out of the library.
  const canonicalRoot = await realpath(root);
  let parent = file;
  while (!existsSync(parent)) parent = path.dirname(parent);
  const canonical = await realpath(parent),
    inside = path.relative(canonicalRoot, canonical);
  if (inside === '..' || inside.startsWith('..' + path.sep) || path.isAbsolute(inside))
    throw new LibraryError([
      libraryDiagnostic(
        'library-path-outside',
        '/path',
        `symlink "${relative}" leaves the library`,
        'copy the asset into the library rather than linking outside it',
      ),
    ]);
  return file;
}

export async function readLibrary(dir: string): Promise<Library> {
  let doc: unknown;
  try {
    const parsed = parseJsonc(await readFile(await libraryFile(dir, 'library.json'), 'utf8'));
    if (!parsed.ok) throw new Error(parsed.error.message);
    doc = parsed.value;
  } catch (e) {
    throw new LibraryError([
      libraryDiagnostic(
        'library-file-read',
        '/library.json',
        `cannot read library.json: ${(e as Error).message}`,
        'run library init or repair the JSONC file',
      ),
    ]);
  }
  const result = parseLibrary(doc);
  if (!result.library || result.diagnostics.length) throw new LibraryError(result.diagnostics);
  return result.library;
}
export async function initLibrary(dir: string, name = 'studio'): Promise<{ dir: string; file: string }> {
  const root = path.resolve(dir);
  await mkdir(root, { recursive: true });
  const file = path.join(root, 'library.json');
  await writeFile(file, formatModelJson(LibrarySchema.parse({ version: 1, name })), { flag: 'wx' });
  return { dir: root, file };
}
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
/** Provenance for library/MCP builds: catches source and compile-only edits that the layer cache cannot detect. */
export async function recordAvatarBuild(dir: string): Promise<void> {
  const avatar = await loadAvatarProject(dir);
  if (!avatar.spec || !avatar.meta || !avatar.modelFile)
    throw new LibraryError([
      libraryDiagnostic(
        'library-pose-unbuilt',
        '/avatar',
        'cannot fingerprint an unbuilt avatar',
        'build a valid avatar first',
      ),
    ]);
  const files: Record<string, string> = {};
  const loaded = await loadModelFile(avatar.modelFile);
  if (!loaded.model || loaded.diagnostics.some((d) => d.severity === 'error'))
    throw new LibraryError([
      libraryDiagnostic(
        'library-model-invalid',
        '/avatar',
        'built model or its textures are invalid',
        'repair the referenced model and PNG textures before recording a build',
      ),
    ]);
  for (const relative of new Set([
    'avatar.json',
    avatar.spec.image.file,
    path.basename(avatar.modelFile),
    'textures/layers.json',
    ...avatar.meta.layers.map((l) => l.file),
    ...loaded.model.textures.filter((t) => !t.path.startsWith('data:')).map((t) => t.path),
  ]))
    files[relative] = hash(await readFile(await libraryFile(dir, relative)));
  const temp = await libraryFile(dir, `.build-${randomUUID()}.tmp`);
  try {
    await writeFile(temp, formatModelJson({ version: 1, files }), { flag: 'wx' });
    await rename(temp, await libraryFile(dir, 'library-build.json'));
  } finally {
    await rm(temp, { force: true });
  }
}
async function avatarBuildCurrent(dir: string, required: string[]): Promise<boolean> {
  try {
    const stamp: unknown = JSON.parse(await readFile(await libraryFile(dir, 'library-build.json'), 'utf8'));
    const parsed = z.strictObject({ version: z.literal(1), files: z.record(z.string(), z.string()) }).safeParse(stamp);
    if (!parsed.success || required.some((file) => !parsed.data.files[file])) return false;
    for (const [file, expected] of Object.entries(parsed.data.files))
      if (hash(await readFile(await libraryFile(dir, file))) !== expected) return false;
    return true;
  } catch {
    return false;
  }
}
async function writeLibrary(dir: string, library: Library) {
  const target = await libraryFile(dir, 'library.json'),
    temp = path.join(dir, `.library-${randomUUID()}.tmp`);
  try {
    await writeFile(temp, formatModelJson(library), { flag: 'wx' });
    await rename(temp, target);
  } finally {
    await rm(temp, { force: true });
  }
}
async function locked<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const lock = await libraryFile(dir, '.library.lock');
  let handle;
  try {
    handle = await open(lock, 'wx');
  } catch {
    throw new LibraryError([
      libraryDiagnostic(
        'library-busy',
        '/library.json',
        'another library write is in progress',
        'wait for it to finish; remove .library.lock only if its process has stopped',
      ),
    ]);
  }
  try {
    return await fn();
  } finally {
    await handle.close();
    await rm(lock, { force: true });
  }
}

export async function validateLibrary(dir: string): Promise<{ ok: boolean; diagnostics: Diagnostic[] }> {
  let library: Library;
  try {
    library = await readLibrary(dir);
  } catch (e) {
    if (e instanceof LibraryError) return { ok: false, diagnostics: e.diagnostics };
    throw e;
  }
  const diagnostics: Diagnostic[] = [];
  const file = async (relative: string, pointer: string) => {
    try {
      const f = await libraryFile(dir, relative);
      if (!(await stat(f)).isFile()) throw new Error('not a file');
      return f;
    } catch (e) {
      diagnostics.push(
        libraryDiagnostic(
          e instanceof LibraryError ? 'library-path-outside' : 'library-file-missing',
          pointer,
          `cannot read "${relative}"`,
          'copy the referenced file inside the library or correct the path',
        ),
      );
      return null;
    }
  };
  for (const [group, items] of [
    ['backgrounds', library.backgrounds],
    ['props', library.props],
    ['bubbles', library.bubbles],
  ] as const)
    for (const [i, item] of items.entries()) {
      const f = await file(item.src, `/${group}/${i}/src`);
      if (f)
        try {
          const { image } = await readPngFile(f);
          if (
            group === 'backgrounds' &&
            'size' in item &&
            (image.width !== item.size[0] || image.height !== item.size[1])
          )
            diagnostics.push(
              libraryDiagnostic(
                'library-image-size',
                `/${group}/${i}/size`,
                'declared background size differs from its PNG',
                'set size to the actual PNG dimensions',
              ),
            );
        } catch {
          diagnostics.push(
            libraryDiagnostic(
              'library-image-format',
              `/${group}/${i}/src`,
              'asset is not a readable PNG',
              'import a standard 8-bit PNG',
            ),
          );
        }
    }
  for (const [i, b] of library.backgrounds.entries())
    for (const [id, src] of Object.entries(b.variants)) await file(src, `/backgrounds/${i}/variants/${id}`);
  for (const [i, c] of library.characters.entries()) {
    for (const [j, ref] of c.references.entries()) await file(ref, `/characters/${i}/references/${j}`);
    let signature: string | undefined;
    for (const [j, p] of c.poses.entries()) {
      const pointer = `/characters/${i}/poses/${j}`;
      let avatarDir: string;
      try {
        avatarDir = await libraryFile(dir, p.avatar);
      } catch (e) {
        diagnostics.push(...(e as LibraryError).diagnostics.map((d) => ({ ...d, path: pointer + '/avatar' })));
        continue;
      }
      const avatar = await loadAvatarProject(avatarDir);
      diagnostics.push(
        ...avatar.diagnostics
          .filter((d) => d.severity === 'error')
          .map((d) => ({ ...d, code: 'library-avatar-invalid', path: pointer + d.path })),
      );
      if (!avatar.spec || !avatar.meta || !avatar.source || !avatar.modelExists || avatar.layersStale !== false) {
        diagnostics.push(
          libraryDiagnostic(
            'library-pose-unbuilt',
            pointer + '/avatar',
            `pose "${c.id}/${p.id}" has no current built avatar`,
            'place its landmarks, then run library rig and avatar poses',
          ),
        );
        continue;
      }
      if (
        Array.isArray(p.anchor) &&
        avatar.source &&
        (p.anchor[0] < 0 ||
          p.anchor[1] < 0 ||
          p.anchor[0] >= avatar.source.width ||
          p.anchor[1] >= avatar.source.height)
      )
        diagnostics.push(
          libraryDiagnostic(
            'library-unknown-anchor',
            pointer + '/anchor',
            'pose anchor lies outside its image',
            'use feet, seat or coordinates inside source.png',
          ),
        );
      if (typeof p.anchor === 'string' && !['feet', 'seat'].includes(p.anchor))
        diagnostics.push(
          libraryDiagnostic(
            'library-unknown-anchor',
            pointer + '/anchor',
            `unknown pose anchor "${p.anchor}"`,
            'use feet, seat or [x,y]',
          ),
        );
      const loaded = await loadModelFile(avatar.modelFile!);
      if (!loaded.model || loaded.diagnostics.some((d) => d.severity === 'error')) {
        diagnostics.push(
          libraryDiagnostic(
            'library-model-invalid',
            pointer + '/avatar',
            'built avatar model does not validate',
            'rebuild and repair its avatar spec',
          ),
        );
        continue;
      }
      const next = JSON.stringify(
        [...loaded.model.parameters]
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          .map(({ id, min, max, default: v }) => [id, min, max, v]),
      );
      if (
        !(await avatarBuildCurrent(avatarDir, [
          'avatar.json',
          avatar.spec!.image.file,
          path.basename(avatar.modelFile!),
          'textures/layers.json',
          ...avatar.meta!.layers.map((l) => l.file),
          ...loaded.model.textures.filter((t) => !t.path.startsWith('data:')).map((t) => t.path),
        ]))
      )
        diagnostics.push(
          libraryDiagnostic(
            'library-pose-unbuilt',
            pointer + '/avatar',
            `pose "${c.id}/${p.id}" has missing or stale build fingerprints`,
            'run library rig (or rev2d_avatar_build) to record and verify current inputs',
          ),
        );
      if (signature !== undefined && signature !== next)
        diagnostics.push(
          libraryDiagnostic(
            'library-parameters-inconsistent',
            pointer + '/avatar',
            `pose "${p.id}" has a different parameter interface`,
            'give every pose of this character the same parameter ids, ranges and defaults',
          ),
        );
      signature ??= next;
    }
  }
  for (const [i, ui] of library.ui.entries()) {
    const f = await file(ui.model, `/ui/${i}/model`);
    if (!f) continue;
    const loaded = await loadModelFile(f);
    if (!loaded.model || loaded.diagnostics.some((d) => d.severity === 'error'))
      diagnostics.push(
        libraryDiagnostic(
          'library-model-invalid',
          `/ui/${i}/model`,
          'UI model does not validate',
          'repair the model with rev2d validate',
        ),
      );
    else
      for (const id of Object.keys(ui.params))
        if (!loaded.model.parameters.some((p) => p.id === id))
          diagnostics.push(
            libraryDiagnostic(
              'library-unknown-param',
              `/ui/${i}/params/${id}`,
              `unknown UI parameter "${id}"`,
              'use a parameter present in the referenced model',
            ),
          );
  }
  return { ok: !diagnostics.some((d) => d.severity === 'error'), diagnostics };
}

export interface ImportLibraryOptions extends KeyOptions {
  kind: Exclude<LibraryKind, 'ui'>;
  id?: string;
  character?: string;
  pose?: string;
  name?: string;
  description?: string;
  tags?: string[];
  remover?: string;
}
export async function importLibraryImage(imageFile: string, dir: string, options: ImportLibraryOptions) {
  return locked(dir, async () => {
    const library = await readLibrary(dir),
      id = options.kind === 'character' ? options.character : options.id;
    const valid = (s: string | undefined) => s && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(s);
    if (!valid(id) || (options.kind === 'character' && !valid(options.pose)))
      throw new LibraryError([
        libraryDiagnostic(
          'library-import-id',
          '/id',
          'import needs valid asset and pose ids',
          'use --id for backgrounds/props/bubbles, or --character and --pose for characters',
        ),
      ]);
    const relative =
      options.kind === 'character'
        ? `characters/${id}/${options.pose}`
        : `${options.kind === 'background' ? 'backgrounds' : options.kind === 'prop' ? 'props' : 'bubbles'}/${id}`;
    const dest = await libraryFile(dir, relative);
    if (existsSync(dest))
      throw new LibraryError([
        libraryDiagnostic(
          'library-import-exists',
          '/id',
          `asset output already exists: ${relative}`,
          'use a new id; edit avatar.json to update an existing pose',
        ),
      ]);
    const items =
      options.kind === 'background'
        ? library.backgrounds
        : options.kind === 'prop'
          ? library.props
          : options.kind === 'bubble'
            ? library.bubbles
            : (library.characters.find((c) => c.id === id)?.poses ?? []);
    if (items.some((i) => i.id === (options.kind === 'character' ? options.pose : id)))
      throw new LibraryError([
        libraryDiagnostic('library-duplicate-id', '/id', 'asset id already exists', 'use another id'),
      ]);
    const stage = await libraryFile(dir, `.import-${randomUUID()}`);
    await mkdir(stage);
    try {
      let input = imageFile;
      if (options.remover) {
        input = path.join(stage, 'removed.png');
        try {
          await promisify(execFile)(options.remover, [path.resolve(imageFile), input], {
            shell: false,
            timeout: 120000,
            maxBuffer: 1024 * 1024,
          });
        } catch (e) {
          throw new LibraryError([
            libraryDiagnostic(
              'library-remover-failed',
              '/remover',
              `external remover failed: ${(e as Error).message}`,
              'provide an executable accepting input-path and output-path, without shell syntax',
            ),
          ]);
        }
      }
      const { image: source } = await readPngFile(input),
        cut =
          options.kind === 'background'
            ? {
                image: source,
                offset: [0, 0] as [number, number],
                background: null,
                diagnostics: [] as Diagnostic[],
                removedPixels: 0,
              }
            : keyImage(source, options);
      await writeFile(path.join(stage, 'source.png'), encodePNG(cut.image));
      await writeFile(
        path.join(stage, 'import.json'),
        formatModelJson({
          version: 1,
          sourceSize: [source.width, source.height],
          offset: cut.offset,
          key: cut.background,
          diagnostics: cut.diagnostics,
        }),
      );
      const tags = options.tags ?? [];
      if (options.kind === 'character') {
        await createAvatarProject(path.join(stage, 'source.png'), stage, { name: id + '_' + options.pose });
        let character = library.characters.find((c) => c.id === id);
        if (!character) {
          character = {
            id: id!,
            name: options.name ?? id!,
            description: options.description ?? '',
            height: cut.image.height,
            references: [relative + '/source.png'],
            poses: [],
          };
          library.characters.push(character);
        }
        character.poses.push({
          id: options.pose!,
          avatar: relative,
          anchor: options.pose!.startsWith('sitting') ? 'seat' : 'feet',
          facing: 'front',
          tags,
        });
      } else if (options.kind === 'background')
        library.backgrounds.push({
          id: id!,
          src: relative + '/source.png',
          size: [source.width, source.height],
          tags,
          anchors: {},
          variants: {},
        });
      else if (options.kind === 'prop')
        library.props.push({ id: id!, src: relative + '/source.png', anchor: 'bottom-center', tags });
      else
        library.bubbles.push({
          id: id!,
          src: relative + '/source.png',
          content_rect: [0, 0, cut.image.width, cut.image.height],
          tail: [0, cut.image.height],
          tags,
        });
      await mkdir(path.dirname(dest), { recursive: true });
      await rename(stage, dest);
      try {
        await writeLibrary(dir, library);
      } catch (e) {
        await rm(dest, { recursive: true, force: true });
        throw e;
      }
      return {
        id,
        pose: options.pose,
        directory: dest,
        width: cut.image.width,
        height: cut.image.height,
        offset: cut.offset,
        diagnostics: cut.diagnostics,
        needsLandmarks: options.kind === 'character',
      };
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  });
}
export async function requestLibraryImage(dir: string, output: string, options: RequestOptions) {
  const library = await readLibrary(dir),
    request = generationRequest(library, options),
    refs: string[] = [];
  for (const ref of request.references) {
    const f = await libraryFile(dir, ref);
    await stat(f);
    refs.push(f);
  }
  const target = path.resolve(output);
  if (existsSync(target))
    throw new LibraryError([
      libraryDiagnostic(
        'library-request-exists',
        '/out',
        'request directory already exists',
        'choose a new output directory',
      ),
    ]);
  const stage = target + '.' + randomUUID() + '.tmp';
  await mkdir(stage, { recursive: true });
  try {
    await mkdir(path.join(stage, 'references'));
    const attachments = [];
    for (const [i, f] of refs.entries()) {
      const name = `references/ref-${i + 1}${path.extname(f)}`;
      await copyFile(f, path.join(stage, name));
      attachments.push(name);
    }
    await writeFile(path.join(stage, 'prompt.txt'), request.prompt + '\n');
    await writeFile(path.join(stage, 'request.json'), formatModelJson({ ...request, references: attachments }));
    await writeFile(
      path.join(stage, 'README.md'),
      '# Asset request\n\nAttach the files in references/ with prompt.txt to your image generator. No network call was made. Save one PNG, then import it with library import. Review identity and pose before rigging.\n',
    );
    await rename(stage, target);
    return { directory: target, ...request, references: attachments };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
export async function rigLibraryPose(dir: string, character: string, pose: string) {
  return locked(dir, async () => {
    const library = await readLibrary(dir),
      p = library.characters.find((c) => c.id === character)?.poses.find((p) => p.id === pose);
    if (!p)
      throw new LibraryError([
        libraryDiagnostic(
          'library-unknown-pose',
          '/pose',
          `unknown pose ${character}/${pose}`,
          'run library search to choose an existing pose',
        ),
      ]);
    const avatarDir = await libraryFile(dir, p.avatar),
      built = await buildAvatarProject(avatarDir);
    await recordAvatarBuild(avatarDir);
    return built;
  });
}
export async function librarySheet(dir: string, options: SearchOptions = {}) {
  const entries = searchLibrary(await readLibrary(dir), options),
    cells: SheetCell[] = [];
  if (!entries.length)
    throw new LibraryError([
      libraryDiagnostic(
        'library-search-empty',
        '/kind',
        'no assets match this sheet',
        'import assets or remove the kind/character filter',
      ),
    ]);
  for (const e of entries) {
    let image: ImageRGBA;
    if (e.kind === 'ui') {
      const loaded = await loadModelFile(await libraryFile(dir, e.source));
      if (!loaded.rig)
        throw new LibraryError([
          libraryDiagnostic('library-model-invalid', '/ui', 'UI model is invalid', 'run validate on its model'),
        ]);
      image = renderImage(buildRenderList(loaded.rig, loaded.rig.pose()), loaded.textures, {
        scale: Math.min(1, 240 / loaded.rig.model.meta.width),
      });
    } else
      image = (await readPngFile(await libraryFile(dir, e.kind === 'character' ? e.source + '/source.png' : e.source)))
        .image;
    const cell = createImage(240, 320, '#e8e8e8'),
      scale = Math.min(224 / image.width, 300 / image.height);
    const thumb = resizeNearest(
      image,
      Math.max(1, Math.round(image.width * scale)),
      Math.max(1, Math.round(image.height * scale)),
    );
    blitImage(cell, thumb, Math.floor((240 - thumb.width) / 2), Math.floor((320 - thumb.height) / 2));
    cells.push({ image: cell, caption: [e.character, e.id].filter(Boolean).join('/'), subcaption: e.kind });
  }
  return {
    image: composeSheet(cells, {
      columns: Math.min(4, cells.length),
      title: entries.length + ' library assets (artwork previews; validate rigs separately)',
    }),
    entries,
  };
}
