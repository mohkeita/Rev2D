/**
 * Interop endpoints of the editor server: POST /api/import converting a Spine export (skeleton JSON +
 * atlas + PNG pages), POST /api/live2d-import (Live2D files -> the resulting doc, nothing written) and
 * POST /api/export (Spine / Live2D files into a workspace folder). Real HTTP on port 0.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PACKAGE_ROOT, loadTemplate } from '../../api/templates.js';
import { formatModelJson } from '../../core/format.js';
import { validateModel } from '../../core/validate.js';
import type { OpenResult } from '../../node/editor-registry.js';
import type { ExportResponse, Live2dImportResponse } from '../../node/interop.js';
import type { InteropReport } from '../../interop/types.js';
import { createImage, encodePNG } from '../../render/index.js';
import { startEditorServer } from '../index.js';
import { makeModelDir, openEvents, removeDir } from './helpers.js';

const SPINE_FIXTURES = path.join(PACKAGE_ROOT, 'src', 'interop', 'spine', '__tests__', 'fixtures');
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** Spine exports rasterize every part: generous limits for loaded machines (the suite runs files in parallel). */
const EXPORT_TIMEOUT = 180_000;

/**
 * A server on a temp workspace whose open model is a copy of an example: hana by default (Live2D-style
 * parameter ids), minimal for quick Spine exports.
 */
async function start(template = 'hana'): Promise<{ dir: string; file: string; base: string }> {
  const { dir } = makeModelDir();
  cleanups.push(() => removeDir(dir));
  const file = path.join(dir, `${template}.r2d.json`);
  writeFileSync(file, formatModelJson(loadTemplate(template, { name: template }).doc));
  const server = await startEditorServer({ file, root: dir, port: 0, devVite: false, register: false, staticDir: path.join(dir, '.no-ui'), recentFile: null, log: () => {} });
  cleanups.push(() => server.close());
  return { dir, file, base: server.url };
}

const post = (base: string, p: string, body: unknown) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function ok<T>(res: Response): Promise<T> {
  const text = await res.text();
  expect(res.status, text).toBe(200);
  return JSON.parse(text) as T;
}

async function fails(res: Response, status: number): Promise<{ error: string; hint?: string; [k: string]: unknown }> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  return JSON.parse(text);
}

const spineFiles = () => [
  { name: 'hero.json', text: readFileSync(path.join(SPINE_FIXTURES, 'hero-4x.json'), 'utf8') },
  { name: 'hero.atlas', text: readFileSync(path.join(SPINE_FIXTURES, 'hero.atlas'), 'utf8') },
  { name: 'hero.png', base64: Buffer.from(encodePNG(createImage(64, 32, '#ffffff'))).toString('base64') },
];

const motion3 = JSON.stringify({
  Version: 3,
  Meta: { Duration: 1, Fps: 30, Loop: true, AreBeziersRestricted: true, CurveCount: 1, TotalSegmentCount: 1, TotalPointCount: 2, UserDataCount: 0, TotalUserDataSize: 0 },
  Curves: [{ Target: 'Parameter', Id: 'ParamAngleX', Segments: [0, 0, 0, 1, 20] }],
});

describe('POST /api/import with a Spine export', () => {
  it('converts the skeleton into <name>.r2d.json + textures/, opens it and returns the report', { timeout: EXPORT_TIMEOUT }, async () => {
    const ws = await start();
    const tab = await openEvents(ws.base);
    cleanups.push(() => tab.close());
    const res = await ok<OpenResult & { report: InteropReport }>(await post(ws.base, '/api/import', { dir: 'chars', files: [...spineFiles(), { name: 'notes.md', text: 'x' }] }));
    const model = path.join(ws.dir, 'chars', 'hero.r2d.json');
    expect(res.file).toBe(model);
    expect(res.report).toMatchObject({ format: 'spine', direction: 'import' });
    expect(res.notes[0]).toBe('imported Spine skeleton hero.json as chars/hero.r2d.json: 12 bones, 9 parts, 2 animations');
    expect(res.notes[1]).toMatch(/^conversion report: \d+ warnings, \d+ info$/);
    expect(res.notes.some((n) => /^spine-dark-color {2}slots\[4\]/.test(n))).toBe(true);
    expect(res.notes).toContain('wrote chars/hero.r2d.json, chars/textures/hero.png');
    expect(res.notes.some((n) => n.startsWith('skipped notes.md'))).toBe(true);
    expect((await tab.next((e) => e.event === 'file-changed')).data).toEqual({ file: model, origin: 'editor' });
    expect(validateModel(JSON.parse(readFileSync(model, 'utf8'))).diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(existsSync(path.join(ws.dir, 'chars', 'textures', 'hero.png'))).toBe(true);
    // The texture is served for the opened model.
    expect((await fetch(`${ws.base}/api/texture/hero`)).status).toBe(200);

    // Again: identical files are fine; a changed page needs overwrite.
    expect((await ok<OpenResult>(await post(ws.base, '/api/import', { dir: 'chars', files: spineFiles() }))).notes).toContain('nothing new was written');
    const files = spineFiles();
    files[2] = { name: 'hero.png', base64: Buffer.from(encodePNG(createImage(64, 32, '#ff0000'))).toString('base64') };
    const clash = await fails(await post(ws.base, '/api/import', { dir: 'chars', files }), 409);
    expect(clash.error).toBe('files already exist: chars/textures/hero.png; nothing was imported');
    await ok(await post(ws.base, '/api/import', { dir: 'chars', files, overwrite: true }));
  });

  it('imports without an atlas (untextured, with a note) and explains broken inputs', async () => {
    const ws = await start();
    const bare = await ok<OpenResult>(await post(ws.base, '/api/import', { files: [spineFiles()[0]] }));
    expect(bare.notes.some((n) => n.startsWith('no atlas (.atlas or .atlas.txt) was imported with hero.json'))).toBe(true);
    const atlas = spineFiles()[1];
    const two = await fails(await post(ws.base, '/api/import', { files: [spineFiles()[0], { ...atlas, name: 'a.atlas' }, { ...atlas, name: 'b.atlas' }] }), 400);
    expect(two.error).toMatch(/several atlases \(a\.atlas, b\.atlas\) and none is named after hero\.json; nothing was imported/);
    const badAtlas = await fails(await post(ws.base, '/api/import', { files: [spineFiles()[0], { name: 'hero.atlas', text: 'p.png\nsize: x\n' }] }), 422);
    expect(badAtlas.error).toMatch(/hero\.atlas is not a readable Spine atlas/);
    // A Rev2D model with an atlas: the atlas is skipped.
    const rev2d = await ok<OpenResult>(await post(ws.base, '/api/import', { files: [{ name: 'm.r2d.json', text: formatModelJson(loadTemplate('blank', { name: 'm' }).doc) }, atlas] }));
    expect(rev2d.notes).toContain('skipped hero.atlas: an atlas belongs to a Spine skeleton, and m.r2d.json is a Rev2D model');
    const other = await fails(await post(ws.base, '/api/import', { files: [{ name: 'x.json', text: '{"bones": 3}' }] }), 422);
    expect(other.hint).toMatch(/a Spine skeleton export .* is converted/);
  });
});

describe('POST /api/live2d-import', () => {
  it('returns the model with the imported animation without writing it', async () => {
    const ws = await start();
    const before = readFileSync(ws.file, 'utf8');
    const res = await ok<Live2dImportResponse>(await post(ws.base, '/api/live2d-import', { files: [{ name: 'turn.motion3.json', text: motion3 }] }));
    expect(res).toMatchObject({ ok: true, changed: true, summary: { animations: ['turn'] }, sources: [{ file: 'turn.motion3.json', kind: 'motion3' }] });
    expect((res.doc as { animations: Array<{ id: string }> }).animations.some((a) => a.id === 'turn')).toBe(true);
    expect(readFileSync(ws.file, 'utf8')).toBe(before);

    // Into the editor's document (unsaved edits included), with options.
    const doc = JSON.parse(before);
    doc.animations = [];
    const res2 = await ok<Live2dImportResponse>(await post(ws.base, '/api/live2d-import', { files: [{ name: 'turn.motion3.json', text: motion3 }], doc, id: 'look', paramMap: 'standard' }));
    expect((res2.doc as { animations: Array<{ id: string }> }).animations.map((a) => a.id)).toEqual(['look']);
  });

  it('finds the files a model3.json lists among the uploaded ones by path or file name', async () => {
    const ws = await start();
    const model3 = JSON.stringify({ Version: 3, FileReferences: { Moc: 'x.moc3', Motions: { Idle: [{ File: 'motions/turn.motion3.json' }] } } });
    const res = await ok<Live2dImportResponse>(await post(ws.base, '/api/live2d-import', { files: [{ name: 'x.model3.json', text: model3 }, { name: 'turn.motion3.json', text: motion3 }] }));
    expect(res.sources).toEqual([
      { file: 'x.model3.json', kind: 'model3' },
      { file: 'turn.motion3.json', kind: 'motion3', via: 'x.model3.json' },
    ]);
    expect(res.summary.animations).toEqual(['turn']);
    expect(res.report.issues.some((i) => i.code === 'live2d-moc-ignored')).toBe(true);
  });

  it('answers ok: false when the result does not validate, 400 / 422 for bad requests', async () => {
    const ws = await start();
    const broken = JSON.parse(readFileSync(ws.file, 'utf8'));
    broken.parts[0].parent = 'nope';
    const invalid = await ok<Live2dImportResponse>(await post(ws.base, '/api/live2d-import', { files: [{ name: 'turn.motion3.json', text: motion3 }], doc: broken }));
    expect(invalid.ok).toBe(false);
    expect(invalid.diagnostics.some((d) => d.severity === 'error')).toBe(true);
    expect((await fails(await post(ws.base, '/api/live2d-import', { files: [] }), 400)).error).toMatch(/invalid live2d-import request/);
    expect((await fails(await post(ws.base, '/api/live2d-import', { files: [{ name: 'a.motion3.json', text: motion3 }], paramMap: 'map.json' }), 400)).hint).toMatch(/"standard" \| "none" \| "prefix"/);
    const notL2d = await fails(await post(ws.base, '/api/live2d-import', { files: [{ name: 'hero.json', text: spineFiles()[0].text! }] }), 422);
    expect(notL2d.hint).toMatch(/Spine skeleton/);
    const two = await fails(await post(ws.base, '/api/live2d-import', { files: [{ name: 'a.motion3.json', text: motion3 }, { name: 'b.motion3.json', text: motion3 }], id: 'x' }), 400);
    expect(two.error).toMatch(/exactly one motion3 or exp3 file/);
  });
});

describe('POST /api/export', () => {
  it('writes Spine files into exports/<model>-spine by default, and asks before replacing different files', async () => {
    const ws = await start('minimal');
    const res = await ok<ExportResponse>(await post(ws.base, '/api/export', { format: 'spine', animations: ['sway'], fps: 15 }));
    const dir = path.join(ws.dir, 'exports', 'minimal-spine');
    expect(res.dir).toBe(dir);
    expect(res.files.map((f) => [path.relative(dir, f.path).split(path.sep).join('/'), f.status])).toEqual([
      ['minimal.json', 'new'],
      ['minimal.atlas', 'new'],
      ['minimal.png', 'new'],
    ]);
    expect(res.report).toMatchObject({ format: 'spine', direction: 'export' });
    expect(res.notes[0]).toBe('exported minimal.r2d.json to Spine in exports/minimal-spine: 3 files');
    expect(Object.keys(JSON.parse(readFileSync(path.join(dir, 'minimal.json'), 'utf8')).animations)).toEqual(['sway']);
    // Unsaved edits (doc) are exported; a different result needs overwrite.
    const doc = JSON.parse(readFileSync(ws.file, 'utf8'));
    doc.animations[0].duration = 3;
    const clash = await fails(await post(ws.base, '/api/export', { format: 'spine', doc, fps: 15 }), 409);
    expect(clash.error).toBe('files already exist: exports/minimal-spine/minimal.json; nothing was exported');
    expect(clash.files).toEqual(['exports/minimal-spine/minimal.json']);
    const replaced = await ok<ExportResponse>(await post(ws.base, '/api/export', { format: 'spine', doc, fps: 15, overwrite: true }));
    expect(replaced.files.map((f) => f.status)).toEqual(['replaced', 'unchanged', 'unchanged']);
  }, EXPORT_TIMEOUT);

  it('writes Live2D files into a chosen folder', async () => {
    const ws = await start();
    const res = await ok<ExportResponse>(await post(ws.base, '/api/export', { format: 'live2d', dir: 'out/l2d', animations: ['idle'], paramMap: 'standard' }));
    expect(res.files.map((f) => path.basename(f.path))).toEqual(['idle.motion3.json', 'hana.physics3.json', 'hana.cdi3.json', 'hana.model3.json']);
    expect(existsSync(path.join(ws.dir, 'out', 'l2d', 'motions', 'idle.motion3.json'))).toBe(true);
    expect(res.notes[1]).toMatch(/merge the FileReferences of the \.model3\.json into its model3\.json/);
  });

  it('refuses unknown animations, invalid models, paths outside the root and mixed options', async () => {
    const ws = await start();
    const typo = await fails(await post(ws.base, '/api/export', { format: 'spine', animations: ['idel'] }), 400);
    expect(typo).toMatchObject({ error: 'unknown animation "idel"', hint: 'did you mean "idle"?' });
    const broken = JSON.parse(readFileSync(ws.file, 'utf8'));
    broken.parts[0].parent = 'nope';
    const invalid = await fails(await post(ws.base, '/api/export', { format: 'live2d', doc: broken }), 422);
    expect(invalid.error).toBe('the model has errors and cannot be exported');
    expect((invalid.diagnostics as unknown[]).length).toBeGreaterThan(0);
    expect((await fails(await post(ws.base, '/api/export', { format: 'spine', dir: '../outside' }), 403)).error).toMatch(/outside the workspace root/);
    expect((await fails(await post(ws.base, '/api/export', { format: 'live2d', textureScale: 2 }), 400)).error).toMatch(/textureScale only apply to "spine"/);
    expect((await fails(await post(ws.base, '/api/export', { format: 'spine', paramMap: 'none' }), 400)).error).toMatch(/paramMap only applies to "live2d"/);
    expect((await fails(await post(ws.base, '/api/export', { format: 'gif' }), 400)).error).toMatch(/invalid export request/);
    expect(existsSync(path.join(ws.dir, 'exports'))).toBe(false);
  });
});
