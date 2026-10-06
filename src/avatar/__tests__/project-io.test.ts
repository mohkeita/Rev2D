/**
 * Node IO of avatar projects (src/node/avatar.ts): creating a project from a PNG, loading one with
 * its diagnostics and build state, the Mesh Avatar Studio project import, the vision-check files,
 * and the rule that nothing is written outside the project folder.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatModelJson } from '../../core/format.js';
import { createImage, encodePNG } from '../../render/index.js';
import { layerInputsHash } from '../hash.js';
import { parseAvatarSpec } from '../spec.js';
import { makeVisionCheck } from '../tools/vision-check.js';
import {
  AvatarProjectError,
  avatarModelFile,
  avatarProjectDir,
  avatarProjectPaths,
  createAvatarProject,
  importMasProject,
  isAvatarProject,
  loadAvatarProject,
  projectFile,
  readPngFile,
  readVisionCheckKey,
  writeAvatarSpec,
  writeProjectFile,
  writeVisionCheck,
} from '../../node/avatar.js';
import { HEIGHT, masRig, testImage, validDoc, WIDTH, type Json } from './fixtures.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'rev2d-avatar-io-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = (name = 'p') => path.join(root, `${name}${n++}`);

const PNG = encodePNG(testImage());
const art = path.join(root, 'art.png');
writeFileSync(art, PNG);

async function failure(run: () => Promise<unknown>): Promise<AvatarProjectError> {
  try {
    await run();
  } catch (e) {
    expect(e).toBeInstanceOf(AvatarProjectError);
    return e as AvatarProjectError;
  }
  throw new Error('expected an AvatarProjectError');
}

/** A complete project folder: the fixture spec and picture. */
function project(mutate: (doc: Json) => void = () => {}): string {
  const dir = fresh('proj');
  mkdirSync(dir, { recursive: true });
  const doc = validDoc();
  mutate(doc);
  writeFileSync(path.join(dir, 'avatar.json'), formatModelJson(doc));
  writeFileSync(path.join(dir, 'source.png'), PNG);
  return dir;
}

describe('project paths', () => {
  it('names the files of a project', () => {
    const p = avatarProjectPaths(path.join(root, 'x'));
    expect(p.spec).toBe(path.join(root, 'x', 'avatar.json'));
    expect(p.layers).toBe(path.join(root, 'x', 'textures', 'layers.json'));
    expect([p.variants, p.variantRequests, p.review, p.work].map((d) => path.basename(d))).toEqual(['variants', 'variant-requests', 'review', 'work']);
    expect(avatarModelFile(path.join(root, 'x'), 'hero')).toBe(path.join(root, 'x', 'hero.r2d.json'));
    expect(avatarProjectDir(path.join(root, 'x', 'avatar.json'))).toBe(path.join(root, 'x'));
    expect(avatarProjectDir(path.join(root, 'x'))).toBe(path.join(root, 'x'));
  });

  it('keeps every path inside the project folder', async () => {
    const dir = fresh();
    expect(projectFile(dir, 'textures/base.png')).toBe(path.join(dir, 'textures', 'base.png'));
    for (const bad of ['../outside.png', 'a/../../outside.png', path.join(root, 'abs.png'), '.', '']) {
      expect(() => projectFile(dir, bad), bad).toThrow(AvatarProjectError);
    }
    expect((await failure(() => writeProjectFile(dir, '../escape.txt', 'x'))).kind).toBe('outside');
    expect(existsSync(path.join(root, 'escape.txt'))).toBe(false);
    const written = await writeProjectFile(dir, 'work/notes/a.txt', 'hello');
    expect(readFileSync(written, 'utf8')).toBe('hello');
  });
});

describe('createAvatarProject', () => {
  it('copies the PNG byte for byte and writes the draft spec', async () => {
    const dir = fresh('My Hero ');
    const created = await createAvatarProject(art, dir);
    expect(created).toMatchObject({ dir, width: WIDTH, height: HEIGHT, name: path.basename(dir).trim().replace(/ /g, '_') });
    expect(readdirSync(dir).sort()).toEqual(['avatar.json', 'source.png']);
    expect(Buffer.compare(readFileSync(created.sourceFile), Buffer.from(PNG))).toBe(0);
    const doc = JSON.parse(readFileSync(created.specFile, 'utf8'));
    expect(doc).toEqual(created.doc);
    expect(doc.image).toEqual({ file: 'source.png', width: WIDTH, height: HEIGHT });
    expect(isAvatarProject(dir)).toBe(true);
    // The fixture has a transparent background: nothing to remark.
    expect(created.notes).toEqual([]);
  });

  it('takes a name and remarks on an opaque image', async () => {
    const opaque = path.join(root, 'opaque.png');
    writeFileSync(opaque, encodePNG(createImage(64, 48, '#336699')));
    const created = await createAvatarProject(opaque, fresh(), { name: 'hero-2' });
    expect(created.name).toBe('hero-2');
    expect(created.width).toBe(64);
    expect(created.notes.join(' ')).toMatch(/no transparent background/);
    const bad = await failure(() => createAvatarProject(opaque, fresh(), { name: '2 heroes' }));
    expect(bad.kind).toBe('invalid');
    expect(bad.hint).toContain('"_2_heroes"');
  });

  it('refuses to overwrite a project unless forced', async () => {
    const dir = fresh();
    await createAvatarProject(art, dir);
    writeFileSync(path.join(dir, 'avatar.json'), formatModelJson({ ...validDoc(), name: 'kept' }));
    const refused = await failure(() => createAvatarProject(art, dir));
    expect(refused.kind).toBe('exists');
    expect(refused.message).toContain('already holds avatar.json');
    expect(refused.hint).toContain('--force');
    expect(JSON.parse(readFileSync(path.join(dir, 'avatar.json'), 'utf8')).name).toBe('kept');
    const forced = await createAvatarProject(art, dir, { force: true, name: 'again' });
    expect(JSON.parse(readFileSync(forced.specFile, 'utf8')).head.center).toBeNull();
    // A folder that only holds another picture is refused too.
    const other = fresh();
    mkdirSync(other);
    writeFileSync(path.join(other, 'source.png'), encodePNG(createImage(8, 8, '#ff0000')));
    expect((await failure(() => createAvatarProject(art, other))).message).toContain('already holds source.png');
  });

  it('rejects other image formats with the way to convert them', async () => {
    const jpeg = path.join(root, 'photo.png');
    writeFileSync(jpeg, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]));
    const target = fresh('refused');
    const e = await failure(() => createAvatarProject(jpeg, target));
    expect(e.kind).toBe('invalid');
    expect(e.message).toMatch(/is a JPEG image; avatar projects need a PNG/);
    expect(e.hint).toMatch(/convert the illustration to PNG/);
    const webp = path.join(root, 'art.webp');
    writeFileSync(webp, Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1'));
    expect((await failure(() => readPngFile(webp))).message).toMatch(/a WebP image/);
    const text = path.join(root, 'notes.txt');
    writeFileSync(text, 'hello');
    expect((await failure(() => readPngFile(text))).message).toMatch(/is not a PNG image/);
    const broken = path.join(root, 'broken.png');
    writeFileSync(broken, Buffer.from(PNG.subarray(0, 40)));
    expect((await failure(() => readPngFile(broken))).message).toMatch(/cannot decode/);
    expect((await failure(() => createAvatarProject(path.join(root, 'nope.png'), target))).kind).toBe('not-found');
    // Nothing was created for the failures.
    expect(existsSync(target)).toBe(false);
  });
});

describe('loadAvatarProject', () => {
  it('loads spec, raw document, illustration and build state', async () => {
    const dir = project();
    const p = await loadAvatarProject(dir);
    expect(p.diagnostics).toEqual([]);
    expect(p.spec?.name).toBe('tester');
    expect(p.doc).toEqual(validDoc());
    expect(p.specFile).toBe(path.join(dir, 'avatar.json'));
    expect(p.specText).toBe(formatModelJson(validDoc()));
    expect(p.sourceFile).toBe(path.join(dir, 'source.png'));
    expect([p.source!.width, p.source!.height]).toEqual([WIDTH, HEIGHT]);
    expect(p.modelFile).toBe(path.join(dir, 'tester.r2d.json'));
    expect(p.modelExists).toBe(false);
    expect(p.meta).toBeNull();
    expect(p.layersStale).toBeNull();
  });

  it('tells whether the built layers still match the spec', async () => {
    const dir = project();
    const spec = parseAvatarSpec(validDoc()).spec!;
    const meta = { version: 1, inputsHash: layerInputsHash(spec), image: { width: WIDTH, height: HEIGHT }, layers: [], variants: [] };
    mkdirSync(path.join(dir, 'textures'));
    writeFileSync(path.join(dir, 'textures', 'layers.json'), JSON.stringify(meta));
    writeFileSync(path.join(dir, 'tester.r2d.json'), '{}');
    let p = await loadAvatarProject(dir);
    expect(p.meta).toEqual(meta);
    expect(p.layersStale).toBe(false);
    expect(p.modelExists).toBe(true);
    // A change that only needs a recompile keeps them current; a cut polygon makes them stale.
    const doc = validDoc();
    doc.head.tilt = 5;
    await writeAvatarSpec(dir, doc);
    expect((await loadAvatarProject(dir)).layersStale).toBe(false);
    doc.face.eyes.imageLeft.opening[0] -= 2;
    await writeAvatarSpec(dir, doc);
    expect((await loadAvatarProject(dir)).layersStale).toBe(true);
    writeFileSync(path.join(dir, 'textures', 'layers.json'), '{"version": 3}');
    p = await loadAvatarProject(dir);
    expect(p.meta).toBeNull();
    expect(p.diagnostics).toEqual([expect.objectContaining({ severity: 'warning', code: 'avatar-layers-load' })]);
    expect(p.spec).not.toBeNull();
  });

  it('checks the declared size against the real illustration', async () => {
    const p = await loadAvatarProject(project((d) => Object.assign(d.image, { width: 800, height: 1000 })));
    expect(p.spec).toBeNull();
    expect(p.diagnostics[0]).toMatchObject({ code: 'avatar-image-size-mismatch', message: 'the spec says the image is 800x1000, but source.png is 400x500' });
  });

  it('reports a missing, misplaced or unusable illustration as diagnostics', async () => {
    const missing = project();
    rmSync(path.join(missing, 'source.png'));
    let p = await loadAvatarProject(missing);
    expect(p.source).toBeNull();
    expect(p.spec).toBeNull();
    expect(p.doc).toEqual(validDoc());
    expect(p.diagnostics).toEqual([expect.objectContaining({ severity: 'error', code: 'avatar-source-missing', path: '/image/file' })]);
    p = await loadAvatarProject(project((d) => (d.image.file = '../art.png')));
    expect(p.diagnostics[0]).toMatchObject({ code: 'avatar-source-outside-project' });
    expect(p.source).toBeNull();
    const text = project((d) => (d.image.file = 'avatar.json'));
    expect((await loadAvatarProject(text)).diagnostics[0]).toMatchObject({ code: 'avatar-source-load' });
    // Another file name inside the project is fine.
    const renamed = project((d) => (d.image.file = 'art/picture.png'));
    mkdirSync(path.join(renamed, 'art'));
    writeFileSync(path.join(renamed, 'art', 'picture.png'), PNG);
    expect((await loadAvatarProject(renamed)).diagnostics).toEqual([]);
  });

  it('loads drafts and broken specs without throwing', async () => {
    const created = await createAvatarProject(art, fresh());
    const draft = await loadAvatarProject(created.dir);
    expect(draft.spec).toBeNull();
    expect(draft.source).not.toBeNull();
    expect(draft.diagnostics.every((d) => d.code === 'avatar-missing-landmark')).toBe(true);
    expect(draft.modelFile).toBe(path.join(created.dir, `${created.name}.r2d.json`));
    const broken = project();
    writeFileSync(path.join(broken, 'avatar.json'), '{ "format": ');
    const p = await loadAvatarProject(broken);
    expect(p.doc).toBeUndefined();
    expect(p.diagnostics.map((d) => d.code)).toEqual(['json-syntax']);
    expect(p.source).not.toBeNull();
    const nothing = await loadAvatarProject(path.join(root, 'no-such-project'));
    expect(nothing.diagnostics).toEqual([expect.objectContaining({ code: 'file-not-found', hint: expect.stringContaining('rev2d avatar new') })]);
    expect(nothing.specText).toBeNull();
  });
});

describe('importMasProject', () => {
  function masFolder(): string {
    const dir = fresh('mas');
    mkdirSync(path.join(dir, 'variants'), { recursive: true });
    writeFileSync(path.join(dir, 'rig.json'), JSON.stringify(masRig()));
    writeFileSync(path.join(dir, 'source.png'), PNG);
    writeFileSync(path.join(dir, 'variants', 'eyes_closed.png'), PNG);
    writeFileSync(path.join(dir, 'variants', 'mouth_a.png'), PNG);
    writeFileSync(path.join(dir, 'variants', 'sketch.png'), PNG);
    return dir;
  }

  it('writes a valid project with the illustration and the known variants', async () => {
    const out = fresh('imported');
    const r = await importMasProject(masFolder(), out, { name: 'mas' });
    expect(r.diagnostics).toEqual([]);
    expect(r.spec?.name).toBe('mas');
    expect(r.variants).toEqual(['variants/eyes_closed.png', 'variants/mouth_a.png']);
    expect(readdirSync(path.join(out, 'variants')).sort()).toEqual(['eyes_closed.png', 'mouth_a.png']);
    expect(Buffer.compare(readFileSync(path.join(out, 'source.png')), Buffer.from(PNG))).toBe(0);
    expect(r.notes.length).toBeGreaterThan(6);
    const loaded = await loadAvatarProject(out);
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.spec?.attachments?.map((a) => a.kind)).toEqual(['jiggle', 'pendulum', 'cutout']);
    // Importing again needs force.
    expect((await failure(() => importMasProject(masFolder(), out))).kind).toBe('exists');
    await importMasProject(masFolder(), out, { force: true });
  });

  it('accepts the rig.json itself and an image elsewhere', async () => {
    const mas = masFolder();
    rmSync(path.join(mas, 'source.png'));
    // Three PNG-less choices: no source.png and no other PNG at the top level.
    const noImage = await failure(() => importMasProject(path.join(mas, 'rig.json'), fresh()));
    expect(noImage.kind).toBe('not-found');
    expect(noImage.hint).toContain('--image');
    const r = await importMasProject(path.join(mas, 'rig.json'), fresh(), { image: art });
    expect(r.imageFile).toBe(art);
    expect(r.diagnostics).toEqual([]);
  });

  it('fails clearly for a missing or unusable rig', async () => {
    expect((await failure(() => importMasProject(fresh(), fresh()))).message).toMatch(/cannot read .*rig\.json/);
    const bad = masFolder();
    writeFileSync(path.join(bad, 'rig.json'), '{ "version": 2 }');
    expect((await failure(() => importMasProject(bad, fresh()))).message).toMatch(/unsupported rig\.json version 2/);
    writeFileSync(path.join(bad, 'rig.json'), '{ nope');
    const syntax = await failure(() => importMasProject(bad, fresh()));
    expect(syntax.diagnostics[0].code).toBe('json-syntax');
    // A rig for another picture size: imported, and the mismatch is reported.
    const other = masFolder();
    writeFileSync(path.join(other, 'source.png'), encodePNG(createImage(200, 250, '#00000000')));
    const r = await importMasProject(other, fresh());
    expect(r.spec).toBeNull();
    expect(r.diagnostics[0].code).toBe('avatar-image-size-mismatch');
  });
});

describe('vision-check files', () => {
  it('writes the image and an encoded key, and reads the key back', async () => {
    const dir = fresh('vision');
    const check = makeVisionCheck({ seed: 9, size: 256 });
    const files = await writeVisionCheck(dir, check);
    expect(path.basename(files.image)).toBe('vision-check.png');
    expect((await readPngFile(files.image)).image.width).toBe(256);
    const text = readFileSync(files.key, 'utf8');
    const [x, y] = check.key.markers['1'];
    expect(text).not.toContain(`[${x}, ${y}]`);
    expect(text).not.toContain(`${x},${y}`);
    expect(JSON.parse(text)).toMatchObject({ seed: 9, size: 256, markers: 12 });
    expect(await readVisionCheckKey(dir)).toEqual(check.key);
    expect((await failure(() => readVisionCheckKey(fresh()))).hint).toContain('vision-check make');
    writeFileSync(files.key, '{"seed": 1}');
    expect((await failure(() => readVisionCheckKey(dir))).kind).toBe('invalid');
  });
});
