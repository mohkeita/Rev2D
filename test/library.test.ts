import { it, expect, afterAll } from 'vitest';
import { mkdtemp, writeFile, readFile, rm, mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  initLibrary,
  importLibraryImage,
  readLibrary,
  validateLibrary,
  requestLibraryImage,
  rigLibraryPose,
  librarySheet,
  libraryFile,
} from '../src/node/library.js';
import { LibrarySchema, parseLibrary, searchLibrary, LibraryError } from '../src/library/index.js';
import { createImage, encodePNG } from '../src/render/index.js';
import { hanaIllustration } from './fixtures/avatar-hana.js';
import { propFixtures } from './fixtures/studio.js';
import { buildPhoneUI } from '../scripts/examples/phone-ui.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'rev2d-library-'));
afterAll(() => rm(root, { recursive: true, force: true }));

it('searches poses with all tags, character identity and accented text', () => {
  const library = LibrarySchema.parse({
    version: 1,
    name: 'test',
    characters: [
      {
        id: 'hero',
        name: 'Héros',
        description: 'Blue jacket',
        height: 500,
        poses: [
          { id: 'sitting_phone', avatar: 'characters/hero/phone', tags: ['sitting', 'phone'] },
          { id: 'standing', avatar: 'characters/hero/standing', tags: ['standing'] },
        ],
      },
    ],
  });
  expect(
    searchLibrary(library, { tags: ['sitting', 'phone'], text: 'heros', character: 'hero' }).map((e) => e.id),
  ).toEqual(['sitting_phone']);
  expect(searchLibrary(library, { tags: ['phone', 'standing'] })).toEqual([]);
  expect(
    parseLibrary({
      ...library,
      props: [
        { id: 'box', src: 'a.png' },
        { id: 'box', src: 'b.png' },
      ],
    }).diagnostics.map((d) => d.code),
  ).toContain('library-duplicate-id');
});

it('imports without modifying originals, creates explicit drafts, requests references and refuses replacement', async () => {
  const dir = path.join(root, 'draft'),
    input = path.join(root, 'source.png');
  await initLibrary(dir, 'test');
  const image = createImage(60, 80, '#00ff00');
  for (let y = 15; y < 65; y++) for (let x = 15; x < 45; x++) image.data.set([30, 30, 40, 255], (y * 60 + x) * 4);
  const bytes = encodePNG(image);
  await writeFile(input, bytes);
  const result = await importLibraryImage(input, dir, {
    kind: 'character',
    character: 'hero',
    pose: 'standing',
    tags: ['standing'],
  });
  expect(result.needsLandmarks).toBe(true);
  expect(await readFile(input)).toEqual(Buffer.from(bytes));
  const status = await validateLibrary(dir);
  expect(status.ok).toBe(false);
  expect(status.diagnostics.map((d) => d.code)).toContain('library-pose-unbuilt');
  await expect(
    importLibraryImage(input, dir, { kind: 'character', character: 'hero', pose: 'standing' }),
  ).rejects.toBeInstanceOf(LibraryError);
  const req = await requestLibraryImage(dir, path.join(root, 'request'), {
    kind: 'character',
    character: 'hero',
    pose: 'sitting with phone',
  });
  expect(req.prompt).toMatch(/Full body/);
  expect(req.prompt).toMatch(/#00FF00/);
  expect(await readFile(path.join(req.directory, req.references[0]))).toEqual(
    await readFile(path.join(result.directory, 'source.png')),
  );
  await expect(
    requestLibraryImage(dir, path.join(root, 'bad-request'), { kind: 'character', character: 'her' }),
  ).rejects.toThrow('unknown character');
  const sheet = await librarySheet(dir);
  expect(sheet.entries).toHaveLength(1);
  expect(sheet.image.width).toBeGreaterThan(200);
});

it('validates files, built poses, anchors and the parameter contract between actual avatars', async () => {
  const dir = path.join(root, 'built');
  await initLibrary(dir);
  const { image, doc } = hanaIllustration(0.25),
    input = path.join(root, 'hana.png');
  await writeFile(input, encodePNG(image));
  for (const pose of ['standing', 'sitting']) {
    const result = await importLibraryImage(input, dir, { kind: 'character', character: 'hana', pose, trim: false });
    await writeFile(path.join(result.directory, 'avatar.json'), JSON.stringify({ ...doc, name: 'hana_' + pose }));
    await rigLibraryPose(dir, 'hana', pose);
  }
  expect(await validateLibrary(dir)).toMatchObject({ ok: true });
  const manifest = await readLibrary(dir);
  manifest.characters[0].poses[0].anchor = 'center';
  manifest.props.push({ id: 'missing', src: 'missing.png', anchor: 'bottom-center', tags: [] });
  await writeFile(path.join(dir, 'library.json'), JSON.stringify(manifest));
  const modelFile = path.join(dir, 'characters/hana/sitting/hana_sitting.r2d.json'),
    model = JSON.parse(await readFile(modelFile, 'utf8'));
  model.parameters.push({ id: 'Extra', min: 0, max: 1, default: 0 });
  await writeFile(modelFile, JSON.stringify(model));
  const codes = (await validateLibrary(dir)).diagnostics.map((d) => d.code);
  expect(codes).toEqual(
    expect.arrayContaining(['library-file-missing', 'library-unknown-anchor', 'library-parameters-inconsistent']),
  );
  // Source edits make the avatar explicitly stale rather than silently claiming it was built.
  await writeFile(
    path.join(dir, 'characters/hana/standing/avatar.json'),
    JSON.stringify({ ...doc, name: 'hana_standing', head: { ...(doc.head as object), tilt: 5 } }),
  );
  expect((await validateLibrary(dir)).diagnostics.map((d) => d.code)).toContain('library-pose-unbuilt');
  await rm(path.join(dir, 'characters/hana/sitting/source.png'));
  expect((await validateLibrary(dir)).diagnostics.map((d) => d.code)).toContain('library-avatar-invalid');
});

it('refuses traversal and symlinks outside a library', async () => {
  const dir = path.join(root, 'confined');
  await initLibrary(dir);
  await mkdir(path.join(root, 'outside'));
  await symlink(path.join(root, 'outside'), path.join(dir, 'linked'));
  await expect(libraryFile(dir, '../source.png')).rejects.toBeInstanceOf(LibraryError);
  await expect(libraryFile(dir, 'linked/new.png')).rejects.toBeInstanceOf(LibraryError);
  expect(parseLibrary({ version: 1, name: 'bad', props: [{ id: 'p', src: '../secret.png' }] }).library).toBeNull();
});

it('imports props/bubbles and renders a parameterized UI catalogue entry', async () => {
  const dir = path.join(root, 'all-kinds');
  await initLibrary(dir);
  for (const [id, image] of Object.entries(propFixtures())) {
    const file = path.join(root, id + '.png');
    await writeFile(file, encodePNG(image));
    await importLibraryImage(file, dir, { kind: id === 'box' ? 'prop' : 'bubble', id });
  }
  await mkdir(path.join(dir, 'ui'));
  await writeFile(path.join(dir, 'ui/phone.r2d.json'), JSON.stringify(buildPhoneUI()));
  const manifest = await readLibrary(dir);
  manifest.ui.push({ id: 'phone', model: 'ui/phone.r2d.json', params: { Progress: '0..1' }, tags: ['phone'] });
  await writeFile(path.join(dir, 'library.json'), JSON.stringify(manifest));
  expect((await validateLibrary(dir)).ok).toBe(true);
  expect((await librarySheet(dir)).entries).toHaveLength(3);
  expect((await librarySheet(dir, { kind: 'ui' })).entries[0].id).toBe('phone');
  manifest.ui[0].params = { Missing: '0..1' };
  await writeFile(path.join(dir, 'library.json'), JSON.stringify(manifest));
  expect((await validateLibrary(dir)).diagnostics.map((d) => d.code)).toContain('library-unknown-param');
});
