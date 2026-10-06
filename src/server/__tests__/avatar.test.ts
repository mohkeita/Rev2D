/**
 * Avatar mode of the editor server (src/server/avatar-routes.ts; the "avatar mode" section of
 * src/node/editor-registry.ts): opening avatar projects, GET / PUT /api/avatar (save, recompile, the
 * stale flag, the lost-update guard), build jobs over SSE, project files, a new project from an
 * uploaded picture and the "avatar-changed" watcher. Real HTTP on port 0 against temp directories; the
 * illustration is the repository's own (test/fixtures/avatar-hana.ts) at half size.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hanaIllustration } from '../../../test/fixtures/avatar-hana.js';
import { formatModelJson } from '../../core/format.js';
import { blankModel } from '../../api/templates.js';
import { compileAvatar, parseAvatarSpec, type AvatarSpec, type LayersMeta } from '../../avatar/index.js';
import { AVATAR_LAYERS_FILE, AVATAR_SOURCE_FILE, AVATAR_SPEC_FILE, buildAvatarProject } from '../../node/avatar.js';
import type { AvatarInfo, AvatarJobEvent, AvatarNewResult, AvatarRef, AvatarSaveResult, FileListing, WorkspaceInfo } from '../../node/editor-registry.js';
import { decodePNG, encodePNG } from '../../render/index.js';
import { LAYERS_FILE, SOURCE_FILE, SPEC_FILE } from '../avatar-routes.js';
import { startEditorServer, type EditorServer, type EditorServerOptions } from '../index.js';
import { openEvents, removeDir, sleep, type SseClient, type SseEvent } from './helpers.js';

const SCALE = 0.5;
const hana = hanaIllustration(SCALE);
const SOURCE_PNG = Buffer.from(encodePNG(hana.image));
const SIZE = { width: hana.width, height: hana.height };

/** A built hana project, copied for every test that needs one (a build takes longer than a copy). */
const template = mkdtempSync(path.join(os.tmpdir(), 'rev2d-avatar-template-'));
beforeAll(async () => {
  writeFileSync(path.join(template, 'avatar.json'), formatModelJson(hana.doc));
  writeFileSync(path.join(template, 'source.png'), SOURCE_PNG);
  await buildAvatarProject(template, { folds: false });
});
afterAll(() => removeDir(template));

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

interface Ws {
  dir: string;
  server: EditorServer;
  base: string;
  logs: string[];
  sse: SseClient;
}

function tempDir(prefix = 'rev2d-avatar-ws-'): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => removeDir(dir));
  return dir;
}

/** An unbuilt project <ws>/<name>: the fixture's avatar.json (after `mutate`) and source.png. */
function project(ws: string, name: string, mutate: (doc: Record<string, any>) => void = () => {}): string {
  const dir = path.join(ws, name);
  mkdirSync(dir, { recursive: true });
  const doc = hanaIllustration(SCALE).doc;
  mutate(doc);
  writeFileSync(path.join(dir, 'avatar.json'), formatModelJson(doc));
  writeFileSync(path.join(dir, 'source.png'), SOURCE_PNG);
  return dir;
}

/** A built project <ws>/<name> (hana.r2d.json, textures/). */
function builtProject(ws: string, name: string): string {
  const dir = path.join(ws, name);
  cpSync(template, dir, { recursive: true });
  return dir;
}

/** An editor server on the workspace `dir` (builds run inside the server unless a test says otherwise), with an event stream. */
async function start(dir: string, opts: Partial<EditorServerOptions> = {}): Promise<Ws> {
  const logs: string[] = [];
  const server = await startEditorServer({ root: dir, port: 0, devVite: false, register: false, staticDir: path.join(dir, '.no-ui'), log: (m) => logs.push(m), avatar: { build: 'inline' }, ...opts });
  cleanups.push(() => server.close());
  const sse = await openEvents(server.url);
  cleanups.push(() => sse.close());
  return { dir, server, base: server.url, logs, sse };
}

const send = (base: string, method: string, p: string, body?: unknown) =>
  fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const post = (base: string, p: string, body?: unknown) => send(base, 'POST', p, body);
const put = (base: string, p: string, body?: unknown) => send(base, 'PUT', p, body);

async function ok<T>(res: Response, status = 200): Promise<T> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  return JSON.parse(text) as T;
}

async function fails(res: Response, status: number): Promise<{ error: string; hint?: string; [k: string]: any }> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  const body = JSON.parse(text);
  expect(typeof body.error).toBe('string');
  return body;
}

const open = (ws: Ws, file: string) => post(ws.base, '/api/open', { file });
const info = async (ws: Ws) => ok<AvatarInfo>(await fetch(`${ws.base}/api/avatar`));
const refOf = (ws: Ws, dir: string): AvatarRef => ({ project: dir, projectPath: path.relative(ws.dir, dir).split(path.sep).join('/'), specFile: path.join(dir, 'avatar.json') });

const named = (event: string) => (e: SseEvent) => e.event === event;
const jobEvent = (state: string, step?: string) => (e: SseEvent) => e.event === 'avatar-job' && e.data.state === state && (step === undefined || e.data.step === step);

/** The last event of the next job that ends; it must have ended as `state` (else the failure shows its message). */
async function jobEnd(sse: SseClient, state: 'done' | 'failed', timeoutMs: number): Promise<AvatarJobEvent> {
  const end = (await sse.next((e) => e.event === 'avatar-job' && e.data.state !== 'running', timeoutMs)).data as AvatarJobEvent;
  expect(end.state, `${end.message}${end.log ? `\n${end.log}` : ''}`).toBe(state);
  return end;
}
const avatarChanged = (origin: string) => (e: SseEvent) => e.event === 'avatar-changed' && e.data.origin === origin;
const modelChanged = (origin: string) => (e: SseEvent) => e.event === 'model-changed' && e.data.origin === origin;

/** The spec of a raw document, validated against the fixture image. */
function specOf(doc: unknown): AvatarSpec {
  const parsed = parseAvatarSpec(doc, { imageSize: SIZE });
  expect(parsed.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  return parsed.spec!;
}

const metaOf = (dir: string) => JSON.parse(readFileSync(path.join(dir, 'textures', 'layers.json'), 'utf8')) as LayersMeta;
const modelText = (dir: string, name = 'hana') => readFileSync(path.join(dir, `${name}.r2d.json`), 'utf8');
/** What the server must write for a spec: stage 2 of the build on the project's layer metadata. */
const compiledText = (doc: unknown, dir: string) => formatModelJson(compileAvatar(specOf(doc), metaOf(dir)).doc);

// ----------------------------------------------------------------------------- opening

describe('opening avatar projects', () => {
  it('uses the file names of the avatar builder', () => {
    expect([SPEC_FILE, SOURCE_FILE, LAYERS_FILE]).toEqual([AVATAR_SPEC_FILE, AVATAR_SOURCE_FILE, AVATAR_LAYERS_FILE]);
  });

  it('opens an avatar.json without a built model as a project with NO model', async () => {
    const dir = tempDir();
    const miko = project(dir, 'avatars/miko');
    const ws = await start(dir);
    expect((await fails(await fetch(`${ws.base}/api/avatar`), 404)).hint).toContain('POST /api/avatar/new');

    const ref = refOf(ws, miko);
    expect(ref.projectPath).toBe('avatars/miko');
    const opened = await ok<any>(await open(ws, 'avatars/miko/avatar.json'));
    expect(opened).toEqual({ file: null, text: null, mtimeMs: 0, notes: [expect.stringContaining('avatars/miko/avatar.json has no built model yet')], avatar: ref });
    expect(opened.notes[0]).toContain('POST /api/avatar/build');
    expect((await ws.sse.next(named('file-changed'))).data).toEqual({ file: null, origin: 'editor', avatar: ref });

    // No model is open: the model endpoints say so, the workspace names the project.
    expect(ws.server.file).toBeNull();
    expect((await fails(await fetch(`${ws.base}/api/model`), 409)).error).toBe('no model is open');
    const workspace = await ok<WorkspaceInfo>(await fetch(`${ws.base}/api/workspace`));
    expect(workspace).toEqual({ root: dir, current: null, recent: [ref.specFile], avatar: ref });

    const a = await info(ws);
    expect(a).toMatchObject({ ...ref, name: 'hana', image: { file: 'source.png', ...SIZE }, built: { model: null, modelMtimeMs: null, meta: null, stale: false, variants: [] }, diagnostics: [], job: null });
    expect(a.specText).toBe(readFileSync(ref.specFile, 'utf8'));
    expect(a.mtimeMs).toBe(statSync(ref.specFile).mtimeMs);
    expect(a.files.map((f) => f.path)).toEqual(['avatar.json', 'source.png']);
    expect(a.files[1]).toEqual({ path: 'source.png', size: SOURCE_PNG.length, mtimeMs: statSync(path.join(miko, 'source.png')).mtimeMs });

    // A stream that connects now learns about the project from its first event.
    const late = await openEvents(ws.base);
    cleanups.push(() => late.close());
    expect(late.events[0].data).toEqual({ file: null, mtimeMs: 0, root: dir, avatar: ref });

    // Closing the document closes the project.
    await ok(await post(ws.base, '/api/close'));
    expect((await ws.sse.next(named('file-changed'))).data).toEqual({ file: null, origin: 'editor' });
    await fails(await fetch(`${ws.base}/api/avatar`), 404);
    expect((await ok<WorkspaceInfo>(await fetch(`${ws.base}/api/workspace`))).avatar).toBeUndefined();
  });

  it('opens the built model for an avatar.json, a project folder or the model itself: avatar mode', async () => {
    const dir = tempDir();
    const hanaDir = builtProject(dir, 'hana');
    const ws = await start(dir);
    const ref = refOf(ws, hanaDir);
    const model = path.join(hanaDir, 'hana.r2d.json');

    for (const file of ['hana/avatar.json', 'hana', path.join(hanaDir, 'avatar.json'), 'hana/hana.r2d.json']) {
      const opened = await ok<any>(await open(ws, file));
      expect(opened, file).toMatchObject({ file: model, text: modelText(hanaDir), avatar: ref });
      expect((await ws.sse.next(named('file-changed'))).data, file).toEqual({ file: model, origin: 'editor', avatar: ref });
    }
    expect(ws.server.file).toBe(model);
    const a = await info(ws);
    expect(a.built).toMatchObject({ model, modelMtimeMs: statSync(model).mtimeMs, stale: false, variants: [] });
    expect(a.built.meta).toEqual(metaOf(hanaDir));
    expect(a.files.map((f) => f.path)).toEqual(expect.arrayContaining(['avatar.json', 'source.png', 'textures/base.png', 'textures/layers.json']));
    // The model's own endpoints work as for any model.
    expect((await ok<any>(await fetch(`${ws.base}/api/model`))).file).toBe(model);
    expect((await fetch(`${ws.base}/api/texture/base`)).status).toBe(200);
  });

  it('opens on behalf of an AI through the "open" command', async () => {
    const dir = tempDir();
    const draft = project(dir, 'draft');
    const built = builtProject(dir, 'built');
    const ws = await start(dir);
    const first = await ok<any>(await post(ws.base, '/api/command', { type: 'open', file: path.join(draft, 'avatar.json') }));
    expect(first).toEqual({ delivered: 1, file: null, mtimeMs: 0, notes: [expect.stringContaining('no built model yet')], avatar: refOf(ws, draft) });
    expect((await ws.sse.next(named('file-changed'))).data).toEqual({ file: null, origin: 'ai', avatar: refOf(ws, draft) });
    const second = await ok<any>(await post(ws.base, '/api/command', { type: 'open', file: 'built/avatar.json' }));
    expect(second).toMatchObject({ delivered: 1, file: path.join(built, 'hana.r2d.json'), avatar: refOf(ws, built) });
    expect(second.notes).toEqual(['opened the built model of the avatar project built']);
    expect((await ws.sse.next(named('file-changed'))).data.origin).toBe('ai');
  });

  it('keeps ordinary models ordinary: no avatar mode without an avatar.json, and a model may be called avatar.json', async () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, 'plain'));
    const text = formatModelJson(blankModel({ name: 'plain', width: 32, height: 32 }));
    writeFileSync(path.join(dir, 'plain', 'model.r2d.json'), text);
    writeFileSync(path.join(dir, 'plain', 'avatar.json'), text);
    const ws = await start(dir);
    for (const file of ['plain/model.r2d.json', 'plain/avatar.json']) {
      const opened = await ok<any>(await open(ws, file));
      expect(opened.file).toBe(path.join(dir, 'plain', path.basename(file)));
      expect(opened.avatar).toBeUndefined();
      expect((await ws.sse.next(named('file-changed'))).data).toEqual({ file: opened.file, origin: 'editor' });
      await fails(await fetch(`${ws.base}/api/avatar`), 404);
    }
    // A folder is only opened when it is an avatar project.
    expect((await fails(await open(ws, 'plain'), 400)).error).toBe('plain is a directory, not a model file');
    expect((await fails(await open(ws, 'nowhere/avatar.json'), 404)).error).toContain('file not found');
    await fails(await put(ws.base, '/api/avatar', { doc: {} }), 404);
    await fails(await post(ws.base, '/api/avatar/build'), 404);
    await fails(await fetch(`${ws.base}/api/avatar/build`), 404);
    await fails(await fetch(`${ws.base}/api/avatar/file?path=source.png`), 404);
  });

  it('starts on an avatar project when the server is given its avatar.json', async () => {
    const dir = tempDir();
    const draft = project(dir, 'draft');
    const built = builtProject(dir, 'built');
    const a = await startEditorServer({ file: path.join(draft, 'avatar.json'), port: 0, devVite: false, register: false, staticDir: path.join(dir, '.no-ui'), log: () => undefined });
    cleanups.push(() => a.close());
    expect([a.file, a.root]).toEqual([null, draft]);
    expect(await ok<AvatarInfo>(await fetch(`${a.url}/api/avatar`))).toMatchObject({ project: draft, projectPath: '', name: 'hana' });
    const b = await startEditorServer({ file: path.join(built, 'avatar.json'), root: dir, port: 0, devVite: false, register: false, staticDir: path.join(dir, '.no-ui'), log: () => undefined });
    cleanups.push(() => b.close());
    expect([b.file, b.root]).toEqual([path.join(built, 'hana.r2d.json'), dir]);
    expect((await ok<WorkspaceInfo>(await fetch(`${b.url}/api/workspace`))).avatar).toEqual({ project: built, projectPath: 'built', specFile: path.join(built, 'avatar.json') });
    await expect(startEditorServer({ file: path.join(draft, 'avatar.json'), root: built, port: 0, devVite: false, register: false, log: () => undefined })).rejects.toThrow(/outside the workspace root/);
  });

  it('marks avatar projects in the file listing', async () => {
    const dir = tempDir();
    project(dir, 'draft', (doc) => void (doc.name = 'my avatar'));
    builtProject(dir, 'built');
    mkdirSync(path.join(dir, 'other'));
    const ws = await start(dir);
    const root = await ok<FileListing>(await fetch(`${ws.base}/api/files`));
    expect(root.entries.map((e) => [e.name, e.type, e.avatar])).toEqual([
      ['built', 'dir', { spec: 'built/avatar.json', name: 'hana', model: 'built/hana.r2d.json' }],
      ['draft', 'dir', { spec: 'draft/avatar.json', name: null, model: null }],
      ['other', 'dir', undefined],
    ]);
    const inside = await ok<FileListing>(await fetch(`${ws.base}/api/files?dir=built`));
    expect(inside.entries.map((e) => [e.name, e.type, e.avatar])).toEqual([
      ['textures', 'dir', undefined],
      ['avatar.json', 'other', { spec: 'built/avatar.json', name: 'hana', model: 'built/hana.r2d.json' }],
      ['hana.r2d.json', 'model', undefined],
      ['source.png', 'image', undefined],
    ]);
  });
});

// ----------------------------------------------------------------------------- GET /api/avatar

describe('GET /api/avatar', () => {
  it('reports what is wrong with a project instead of failing', async () => {
    const dir = tempDir();
    const draft = project(dir, 'draft', (doc) => {
      doc.face.nose = null;
      doc.head.pivot = null;
    });
    const ws = await start(dir);
    await ok(await open(ws, 'draft/avatar.json'));
    const a = await info(ws);
    expect(a.diagnostics.map((d) => [d.severity, d.code, d.path])).toEqual([
      ['error', 'avatar-missing-landmark', '/head/pivot'],
      ['error', 'avatar-missing-landmark', '/face/nose'],
    ]);
    expect(a.built.stale).toBe(false);

    // A picture of another size, then none at all, then no avatar.json: every state has an answer.
    writeFileSync(path.join(draft, 'source.png'), encodePNG({ width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4) }));
    expect((await info(ws)).image).toEqual({ file: 'source.png', width: 8, height: 8 });
    expect((await info(ws)).diagnostics.map((d) => d.code)).toContain('avatar-image-size-mismatch');
    writeFileSync(path.join(draft, 'source.png'), SOURCE_PNG.subarray(0, 200));
    const corrupt = await info(ws);
    expect(corrupt.image).toBeNull();
    expect(corrupt.diagnostics[0]).toMatchObject({ severity: 'error', code: 'avatar-source-load', path: '/image/file' });
    removeDir(path.join(draft, 'source.png'));
    expect((await info(ws)).diagnostics[0]).toMatchObject({ code: 'avatar-source-missing' });
    removeDir(path.join(draft, 'avatar.json'));
    const gone = await info(ws);
    expect(gone).toMatchObject({ specText: null, mtimeMs: 0, name: null, image: null, files: [] });
    expect(gone.diagnostics).toEqual([expect.objectContaining({ severity: 'error', code: 'file-not-found' })]);
    // PUT writes it again.
    const saved = await ok<AvatarSaveResult>(await put(ws.base, '/api/avatar', { doc: hana.doc }));
    expect(saved).toMatchObject({ written: true, ok: false });
    expect(existsSync(path.join(draft, 'avatar.json'))).toBe(true);
    expect(existsSync(path.join(draft, 'avatar.json.bak'))).toBe(false);
  });
});

// ----------------------------------------------------------------------------- PUT /api/avatar

describe('PUT /api/avatar', () => {
  it('validates the request', async () => {
    const dir = tempDir();
    project(dir, 'p');
    const ws = await start(dir);
    await ok(await open(ws, 'p'));
    for (const body of [{}, { text: '{}', doc: {} }, { doc: [] }, { doc: 'x' }, { doc: {}, baseMtimeMs: 'yesterday' }, { doc: {}, compile: 'yes' }, { doc: {}, force: true }, []]) {
      const err = await fails(await put(ws.base, '/api/avatar', body), 400);
      expect(err.error, JSON.stringify(body)).toMatch(/^invalid avatar save request/);
      expect(err.hint).toBeTruthy();
    }
    await fails(await fetch(`${ws.base}/api/avatar`, { method: 'PUT', body: '{nope' }), 400);
    expect((await fails(await post(ws.base, '/api/avatar', {}), 405)).hint).toBe('use GET, PUT');
  });

  it('saves a draft: avatar.json is written, the previous content kept, nothing compiled before the first build', async () => {
    const dir = tempDir();
    const p = project(dir, 'p');
    const ws = await start(dir);
    await ok(await open(ws, 'p'));
    const before = readFileSync(path.join(p, 'avatar.json'), 'utf8');
    const doc = hanaIllustration(SCALE).doc;
    doc.face.nose = [doc.face.nose[0] + 1, doc.face.nose[1]];
    const saved = await ok<AvatarSaveResult>(await put(ws.base, '/api/avatar', { doc, baseMtimeMs: (await info(ws)).mtimeMs }));
    expect(saved).toEqual({ ok: true, written: true, diagnostics: [], stale: false, mtimeMs: statSync(path.join(p, 'avatar.json')).mtimeMs, compiled: false, model: null, notes: ['not compiled: the layers are not built yet (POST /api/avatar/build)'] });
    expect(readFileSync(path.join(p, 'avatar.json'), 'utf8')).toBe(formatModelJson(doc));
    expect(readFileSync(path.join(p, 'avatar.json.bak'), 'utf8')).toBe(before);
    expect((await ws.sse.next(named('avatar-changed'))).data).toEqual({ origin: 'editor', project: p, files: ['avatar.json'], mtimeMs: saved.mtimeMs });

    // A spec with errors is a draft: saved all the same, and said so.
    doc.face.chin = null;
    const draft = await ok<AvatarSaveResult>(await put(ws.base, '/api/avatar', { doc }));
    expect(draft).toMatchObject({ ok: false, written: true, compiled: false, notes: ['not compiled: the spec has errors (see diagnostics)'] });
    expect(draft.diagnostics.map((d) => d.code)).toEqual(['avatar-missing-landmark']);
    expect(readFileSync(path.join(p, 'avatar.json.bak'), 'utf8')).toBe(formatModelJson({ ...doc, face: { ...doc.face, chin: hana.doc.face.chin } }));

    // Text that is not a JSON object is refused, and nothing is touched.
    const current = readFileSync(path.join(p, 'avatar.json'), 'utf8');
    for (const text of ['{ "format": ', '[1, 2]']) {
      const refused = await ok<AvatarSaveResult>(await put(ws.base, '/api/avatar', { text }));
      expect(refused).toMatchObject({ ok: false, written: false, compiled: false, mtimeMs: draft.mtimeMs });
      expect(refused.hint).toContain('NOT written');
      expect(refused.diagnostics).toHaveLength(1);
    }
    expect(readFileSync(path.join(p, 'avatar.json'), 'utf8')).toBe(current);

    // Raw text is written verbatim (comments stay); saving the same text again writes nothing.
    const text = `// landmarks by hand\r\n${formatModelJson(hana.doc).replace(/\n/g, '\r\n')}`;
    const verbatim = await ok<AvatarSaveResult>(await put(ws.base, '/api/avatar', { text }));
    expect(verbatim).toMatchObject({ ok: true, written: true });
    expect(readFileSync(path.join(p, 'avatar.json'), 'utf8')).toBe(text);
    await sleep(15);
    const again = await ok<AvatarSaveResult>(await put(ws.base, '/api/avatar', { text }));
    expect(again.mtimeMs).toBe(verbatim.mtimeMs);
    // A document keeps the file's CRLF line endings.
    await ok(await put(ws.base, '/api/avatar', { doc: hana.doc }));
    expect(readFileSync(path.join(p, 'avatar.json'), 'utf8')).toBe(formatModelJson(hana.doc).replace(/\n/g, '\r\n'));
  });

  it('recompiles and rewrites the open model, reported once as origin "editor"', async () => {
    const dir = tempDir();
    const p = builtProject(dir, 'hana');
    const ws = await start(dir);
    await ok(await open(ws, 'hana/avatar.json'));
    await ws.sse.next(named('file-changed'));
    const model = path.join(p, 'hana.r2d.json');
    const built = modelText(p);

    // Not a layer input: only the compiled model changes.
    const doc = hanaIllustration(SCALE).doc;
    doc.body.sway = 5;
    const saved = await ok<AvatarSaveResult>(await put(ws.base, '/api/avatar', { doc }));
    expect(saved).toMatchObject({ ok: true, written: true, stale: false, compiled: true, notes: [], model: { file: model, changed: true, mtimeMs: statSync(model).mtimeMs } });
    expect(modelText(p)).toBe(compiledText(doc, p));
    expect(modelText(p)).not.toBe(built);
    expect((await ws.sse.next(modelChanged('editor'))).data).toEqual({ origin: 'editor', mtimeMs: saved.model!.mtimeMs, files: ['hana.r2d.json'] });
    expect((await ok<any>(await fetch(`${ws.base}/api/model`))).text).toBe(modelText(p));

    // The same spec again: nothing to rewrite, nothing to report.
    const same = await ok<AvatarSaveResult>(await put(ws.base, '/api/avatar', { doc }));
    expect(same).toMatchObject({ compiled: true, model: { changed: false, mtimeMs: saved.model!.mtimeMs }, mtimeMs: saved.mtimeMs });
    // compile: false saves without touching the model.
    doc.body.sway = 1;
    const quiet = await ok<AvatarSaveResult>(await put(ws.base, '/api/avatar', { doc, compile: false }));
    expect(quiet).toMatchObject({ compiled: false, model: null, notes: ['not compiled: "compile" was false'] });
    expect(statSync(model).mtimeMs).toBe(saved.model!.mtimeMs);

    await sleep(450); // well past both watchers' debounce: the server's own writes are never echoed as external
    expect(ws.sse.pending((e) => e.event === 'model-changed')).toEqual([]);
    expect(ws.sse.pending(avatarChanged('external'))).toEqual([]);
    expect(ws.sse.pending(avatarChanged('editor')).map((e) => e.data.files)).toEqual([['avatar.json'], ['avatar.json']]);
  });

  it('flags stale layers when a landmark that cuts pixels moves, until they are rebuilt', async () => {
    const dir = tempDir();
    const p = builtProject(dir, 'hana');
    const ws = await start(dir);
    await ok(await open(ws, 'hana'));
    expect((await info(ws)).built.stale).toBe(false);

    const doc = hanaIllustration(SCALE).doc;
    // The eye opening is cut out of the picture: moving a point of it outdates the layer images.
    const opening = doc.face.eyes.imageLeft.opening as number[];
    const top = opening.reduce((best, _, i) => (i % 2 === 1 && opening[i] < opening[best] ? i : best), 1);
    opening[top] += 0.5;
    const saved = await ok<AvatarSaveResult>(await put(ws.base, '/api/avatar', { doc }));
    expect(saved).toMatchObject({ ok: true, written: true, stale: true, compiled: true });
    expect(saved.notes).toEqual([expect.stringContaining('POST /api/avatar/build rebuilds them')]);
    // The model was still compiled from the new spec (with the layers there are).
    expect(modelText(p)).toBe(compiledText(doc, p));
    expect((await info(ws)).built.stale).toBe(true);

    const job = await ok<AvatarJobEvent>(await post(ws.base, '/api/avatar/build'), 202);
    const done = await jobEnd(ws.sse, 'done', 20000);
    expect(done).toMatchObject({ job: job.job, stale: false });
    const after = await info(ws);
    expect(after.built.stale).toBe(false);
    expect(after.built.meta!.inputsHash).not.toBe(metaOf(template).inputsHash);
    expect(modelText(p)).toBe(compiledText(doc, p));
  });

  it('refuses a save based on an older version when avatar.json changed on disk since (409)', async () => {
    const dir = tempDir();
    const p = project(dir, 'p');
    const file = path.join(p, 'avatar.json');
    const ws = await start(dir);
    await ok(await open(ws, 'p'));
    const base = (await info(ws)).mtimeMs;

    // Another program (an agent) writes the file.
    await sleep(15);
    const theirs = hanaIllustration(SCALE).doc;
    theirs.body.sway = 4;
    writeFileSync(file, formatModelJson(theirs));
    const mine = hanaIllustration(SCALE).doc;
    mine.body.sway = 3;
    const err = await fails(await put(ws.base, '/api/avatar', { doc: mine, baseMtimeMs: base }), 409);
    expect(err.error).toContain('avatar.json changed on disk');
    expect(err.hint).toContain('baseMtimeMs');
    expect(err.mtimeMs).toBe(statSync(file).mtimeMs);
    expect(readFileSync(file, 'utf8')).toBe(formatModelJson(theirs));
    expect(existsSync(`${file}.bak`)).toBe(false);

    // Overwriting on purpose: base the write on the version the 409 named.
    const forced = await ok<AvatarSaveResult>(await put(ws.base, '/api/avatar', { doc: mine, baseMtimeMs: err.mtimeMs }));
    expect(forced.written).toBe(true);
    expect(readFileSync(`${file}.bak`, 'utf8')).toBe(formatModelJson(theirs));

    // A touch (new mtime, same content) is not a conflict, nor is a write of the very text on disk.
    const later = new Date(Date.now() + 5000);
    utimesSync(file, later, later);
    mine.body.sway = 2;
    expect((await ok<AvatarSaveResult>(await put(ws.base, '/api/avatar', { doc: mine, baseMtimeMs: forced.mtimeMs }))).written).toBe(true);
    await sleep(15);
    writeFileSync(file, formatModelJson(theirs));
    expect((await ok<AvatarSaveResult>(await put(ws.base, '/api/avatar', { doc: theirs, baseMtimeMs: forced.mtimeMs }))).written).toBe(true);
    // Without baseMtimeMs the write is unconditional.
    await sleep(15);
    writeFileSync(file, formatModelJson(hana.doc));
    expect((await ok<AvatarSaveResult>(await put(ws.base, '/api/avatar', { doc: mine }))).written).toBe(true);
  });

  it('reports a compile that fails without losing the save, and follows a renamed avatar', async () => {
    const dir = tempDir();
    const p = builtProject(dir, 'hana');
    const ws = await start(dir);
    await ok(await open(ws, 'hana'));
    await ws.sse.next(named('file-changed'));
    const built = modelText(p);

    const bad = hanaIllustration(SCALE).doc;
    bad.post = [{ op: 'set', target: 'part:nope.opacity', value: 0.5 }];
    const failed = await ok<AvatarSaveResult>(await put(ws.base, '/api/avatar', { doc: bad }));
    expect(failed).toMatchObject({ ok: true, written: true, compiled: false, model: null });
    expect(failed.error!.message).toMatch(/the "post" op #0 \(set\) of avatar\.json failed: unknown part "nope"/);
    expect(failed.notes[0]).toContain('not compiled: the "post" op #0');
    expect(modelText(p)).toBe(built);

    const renamed = hanaIllustration(SCALE).doc;
    renamed.name = 'hana2';
    const saved = await ok<AvatarSaveResult>(await put(ws.base, '/api/avatar', { doc: renamed }));
    const model = path.join(p, 'hana2.r2d.json');
    expect(saved).toMatchObject({ compiled: true, model: { file: model, changed: true } });
    expect(saved.notes).toEqual(['the avatar was renamed: its model is hana2.r2d.json now; hana.r2d.json is not rebuilt any more and can be deleted']);
    expect((await ws.sse.next(named('file-changed'))).data).toEqual({ file: model, origin: 'editor', avatar: refOf(ws, p) });
    expect(ws.server.file).toBe(model);
    expect((await info(ws)).built.model).toBe(model);
  });
});

// ----------------------------------------------------------------------------- build jobs

describe('POST /api/avatar/build', () => {
  it('builds an unbuilt project: steps over SSE, then the built model is open', async () => {
    const dir = tempDir();
    const p = project(dir, 'p');
    const ws = await start(dir);
    await ok(await open(ws, 'p/avatar.json'));
    await ws.sse.next(named('file-changed'));
    expect(await ok<any>(await fetch(`${ws.base}/api/avatar/build`))).toEqual({ job: null });

    const started = await ok<AvatarJobEvent>(await post(ws.base, '/api/avatar/build'), 202);
    expect(started).toEqual({ job: expect.stringMatching(/^[0-9a-f]{12}$/), state: 'running', step: 'start', message: 'build accepted', project: p, layers: true, startedAt: expect.any(String), elapsedMs: expect.any(Number) });
    const done = await jobEnd(ws.sse, 'done', 20000);
    const mine = ws.sse.events.filter((e) => e.event === 'avatar-job').map((e) => e.data as AvatarJobEvent);
    expect(mine.map((e) => [e.job, e.state, e.step])).toEqual([
      [started.job, 'running', 'start'],
      [started.job, 'running', 'build'],
      [started.job, 'running', 'reload'],
      [started.job, 'done', undefined],
    ]);
    const model = path.join(p, 'hana.r2d.json');
    expect(done).toMatchObject({ state: 'done', project: p, layers: true, stale: false, report: { layers: true, name: 'hana', modelFile: model, removed: [], postOps: 0 } });
    // Warnings depend on the features of the builder; the count is that of the issues and diagnostics listed.
    const warnings = [...done.report!.issues, ...done.report!.diagnostics].filter((i) => i.severity === 'warning').length;
    expect(done.report!.warnings).toBe(warnings);
    expect(done.message).toMatch(new RegExp(`^built "hana": \\d+ layer images?, ${warnings} warnings? in `));
    expect(done.endedAt).toBeTruthy();
    expect(done.report!.layerFiles[0]).toBe('textures/base.png');
    expect(done.report!.modelBytes).toBe(statSync(model).size);
    expect(done.report!.stats).toMatchObject({ latticeCols: 40, latticeRows: 50 });
    expect(done.report!.timings.totalMs).toBeGreaterThan(0);

    // What the build wrote is the editor's own change, and the built model is open now.
    const order = ws.sse.events.map((e) => e.event).filter((e) => e !== 'hello');
    expect(order.indexOf('file-changed', 1)).toBeLessThan(order.lastIndexOf('avatar-job'));
    const changed = ws.sse.events.filter(avatarChanged('editor')).flatMap((e) => e.data.files as string[]);
    expect(changed).toEqual(expect.arrayContaining(['textures/base.png', 'textures/layers.json']));
    expect(ws.sse.events.filter(named('file-changed')).at(-1)!.data).toEqual({ file: model, origin: 'editor', avatar: refOf(ws, p) });
    expect(ws.server.file).toBe(model);
    const a = await info(ws);
    expect(a.built).toMatchObject({ model, stale: false });
    expect(a.job).toEqual(done);
    expect(await ok<any>(await fetch(`${ws.base}/api/avatar/build`))).toEqual({ job: done });
    // The same result as the builder's own two stages.
    expect(modelText(p)).toBe(compiledText(hana.doc, p));
    await sleep(450);
    expect(ws.sse.pending((e) => e.event === 'model-changed' && e.data.origin === 'external')).toEqual([]);
    expect(ws.sse.events.filter(avatarChanged('external'))).toEqual([]);
  });

  it('fails with the reasons: a corrupt illustration, an unfinished spec', async () => {
    const dir = tempDir();
    const p = project(dir, 'p');
    writeFileSync(path.join(p, 'source.png'), SOURCE_PNG.subarray(0, 300));
    const ws = await start(dir);
    await ok(await open(ws, 'p'));
    const started = await ok<AvatarJobEvent>(await post(ws.base, '/api/avatar/build', { layers: true }), 202);
    const failed = await jobEnd(ws.sse, 'failed', 20000);
    expect(failed).toMatchObject({ job: started.job, state: 'failed', project: p });
    expect(failed.message).toMatch(/the avatar spec has 1 error/);
    expect(failed.diagnostics).toEqual([expect.objectContaining({ severity: 'error', code: 'avatar-source-load' })]);
    expect(failed.hint).toBeTruthy();
    expect(failed.report).toBeUndefined();
    expect(existsSync(path.join(p, 'hana.r2d.json'))).toBe(false);
    expect((await info(ws)).job).toEqual(failed);

    // The job is over: the next one starts (and fails for its own reason).
    writeFileSync(path.join(p, 'source.png'), SOURCE_PNG);
    const draft = hanaIllustration(SCALE).doc;
    draft.face.nose = null;
    await ok(await put(ws.base, '/api/avatar', { doc: draft }));
    const second = await ok<AvatarJobEvent>(await post(ws.base, '/api/avatar/build'), 202);
    expect(second.job).not.toBe(started.job);
    const unfinished = await jobEnd(ws.sse, 'failed', 20000);
    expect(unfinished.message).toContain('1 landmark still to place');
    expect(unfinished.diagnostics!.map((d) => [d.code, d.path])).toEqual([['avatar-missing-landmark', '/face/nose']]);

    // Malformed requests never start a job.
    expect((await fails(await post(ws.base, '/api/avatar/build', { layers: 'all' }), 400)).error).toMatch(/^invalid avatar build request/);
    await fails(await post(ws.base, '/api/avatar/build', { fast: true }), 400);
    await fails(await fetch(`${ws.base}/api/avatar/build`, { method: 'POST', body: '{' }), 400);
  });

  it('recompiles only with layers: false, and says when there are no layers', async () => {
    const dir = tempDir();
    const p = builtProject(dir, 'built');
    project(dir, 'draft');
    const ws = await start(dir);
    await ok(await open(ws, 'built'));
    // Edited behind the server's back: the model is older than the spec.
    const doc = hanaIllustration(SCALE).doc;
    doc.body.sway = 6;
    writeFileSync(path.join(p, 'avatar.json'), formatModelJson(doc));
    const layersBefore = statSync(path.join(p, 'textures', 'base.png')).mtimeMs;
    const started = await ok<AvatarJobEvent>(await post(ws.base, '/api/avatar/build', { layers: false }), 202);
    expect(started).toMatchObject({ layers: false, step: 'start', message: 'recompile accepted' });
    const done = await jobEnd(ws.sse, 'done', 20000);
    expect(done.report).toMatchObject({ layers: false, name: 'hana', layerFiles: [], removed: [], modelFile: path.join(p, 'hana.r2d.json') });
    expect(done.message).toMatch(/^built "hana": model recompiled, \d+ warnings? in /);
    expect(ws.sse.events.filter(named('avatar-job')).map((e) => e.data.step)).toEqual(['start', 'compile', 'reload', undefined]);
    expect(modelText(p)).toBe(compiledText(doc, p));
    expect(statSync(path.join(p, 'textures', 'base.png')).mtimeMs).toBe(layersBefore);
    // The rewritten model is the editor's own change (reported before the job's last event).
    expect(ws.sse.events.filter(modelChanged('editor')).map((e) => e.data.files)).toEqual([['hana.r2d.json']]);

    await ok(await open(ws, 'draft'));
    await ok(await post(ws.base, '/api/avatar/build', { layers: false }), 202);
    const failed = await jobEnd(ws.sse, 'failed', 20000);
    expect(failed.message).toContain('has no layers yet');
    expect(failed.hint).toContain('"layers": true');
  });

  it('runs the build as a child process by default: one at a time, and the model follows a save made meanwhile', async () => {
    const dir = tempDir();
    const p = project(dir, 'p');
    const ws = await start(dir, { avatar: {} });
    await ok(await open(ws, 'p'));
    const started = await ok<AvatarJobEvent>(await post(ws.base, '/api/avatar/build'), 202);
    // One job at a time.
    const busy = await fails(await post(ws.base, '/api/avatar/build'), 409);
    expect(busy).toMatchObject({ error: `an avatar build is already running (job ${started.job})`, job: started.job });
    expect(busy.hint).toContain('avatar-job');
    // The server keeps answering while the layers are cut; a save made now is not compiled by itself...
    const doc = hanaIllustration(SCALE).doc;
    doc.body.sway = 7;
    const saved = await ok<AvatarSaveResult>(await put(ws.base, '/api/avatar', { doc }));
    expect(saved).toMatchObject({ written: true, compiled: false, notes: ['not compiled: a build is running; it compiles the model from this spec when it ends'] });

    const done = await jobEnd(ws.sse, 'done', 60000);
    expect(done).toMatchObject({ job: started.job, state: 'done', stale: false, report: { layers: true, name: 'hana' } });
    expect(done.report!.layerFiles[0]).toBe('textures/base.png');
    expect(done.report!.timings.layersMs).toBeGreaterThanOrEqual(0);
    // ... the job did it when it ended: the model on disk is the one of the spec on disk.
    expect(modelText(p)).toBe(compiledText(doc, p));
    expect(ws.server.file).toBe(path.join(p, 'hana.r2d.json'));
    expect(ws.sse.events.filter(avatarChanged('external'))).toEqual([]);

    // A failure of the child process arrives with its message and hint.
    const bad = hanaIllustration(SCALE).doc;
    bad.post = [{ op: 'set', target: 'part:nope.opacity', value: 0.5 }];
    await ok(await put(ws.base, '/api/avatar', { doc: bad, compile: false }));
    await ok(await post(ws.base, '/api/avatar/build'), 202);
    const failed = await jobEnd(ws.sse, 'failed', 60000);
    expect(failed.message).toMatch(/the "post" op #0 \(set\) of avatar\.json failed: unknown part "nope"/);
    expect(failed.hint).toBeTruthy();
  }, 120000);

  it('stops a build that takes too long, and one that runs when the server closes', async () => {
    const dir = tempDir();
    project(dir, 'p');
    // A "build" that never ends: any script that keeps running stands in for bin/rev2d.js.
    const hang = path.join(dir, 'hang.mjs');
    writeFileSync(hang, 'setInterval(() => {}, 1000);\n');
    const ws = await start(dir, { avatar: { rev2dBin: hang, buildTimeoutMs: 300 } });
    await ok(await open(ws, 'p'));
    await ok(await post(ws.base, '/api/avatar/build'), 202);
    const failed = await jobEnd(ws.sse, 'failed', 20000);
    expect(failed.message).toMatch(/did not finish within 300 ms and was stopped/);

    const closing = await start(dir, { avatar: { rev2dBin: hang } });
    await ok(await open(closing, 'p'));
    await ok(await post(closing.base, '/api/avatar/build'), 202);
    await closing.sse.next(jobEvent('running', 'build'));
    const t = Date.now();
    await closing.server.close();
    expect(Date.now() - t).toBeLessThan(15000);
  }, 60000);
});

// ----------------------------------------------------------------------------- project files

describe('GET /api/avatar/file', () => {
  it('serves the files of the project with their types, revalidated by ETag', async () => {
    const dir = tempDir();
    const p = builtProject(dir, 'hana');
    mkdirSync(path.join(p, 'variant-requests'));
    writeFileSync(path.join(p, 'variant-requests', 'README.md'), '# requests\n');
    writeFileSync(path.join(p, 'variant-requests', 'eyes_closed.prompt.txt'), 'closed eyes\n');
    const ws = await start(dir);
    await ok(await open(ws, 'hana'));
    const get = (p: string, headers: Record<string, string> = {}) => fetch(`${ws.base}/api/avatar/file?path=${encodeURIComponent(p)}`, { headers });

    const source = await get('source.png');
    expect(source.status).toBe(200);
    expect(Object.fromEntries(['content-type', 'cache-control', 'x-content-type-options', 'cross-origin-resource-policy', 'content-length'].map((h) => [h, source.headers.get(h)]))).toEqual({
      'content-type': 'image/png',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'same-origin',
      'content-length': String(SOURCE_PNG.length),
    });
    expect(Buffer.from(await source.arrayBuffer()).equals(SOURCE_PNG)).toBe(true);
    const etag = source.headers.get('etag')!;
    const cached = await get('source.png', { 'if-none-match': etag });
    expect([cached.status, await cached.text()]).toEqual([304, '']);

    const layer = await get('textures\\base.png');
    expect(layer.headers.get('content-type')).toBe('image/png');
    expect(decodePNG(new Uint8Array(await layer.arrayBuffer()))).toMatchObject(SIZE);
    expect((await get('textures/layers.json')).headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await (await get('avatar.json')).json()).toEqual(JSON.parse(JSON.stringify(hana.doc)));
    const readme = await get('variant-requests/README.md');
    expect([readme.headers.get('content-type'), await readme.text()]).toEqual(['text/plain; charset=utf-8', '# requests\n']);
    expect(await (await get('variant-requests/eyes_closed.prompt.txt')).text()).toBe('closed eyes\n');
    // A changed file has another ETag.
    await sleep(15);
    writeFileSync(path.join(p, 'source.png'), encodePNG({ width: 4, height: 4, data: new Uint8ClampedArray(64) }));
    const changed = await get('source.png', { 'if-none-match': etag });
    expect(changed.status).toBe(200);
    expect(changed.headers.get('etag')).not.toBe(etag);
  });

  it('refuses everything outside the project, hidden files and types a browser would run', async () => {
    const dir = tempDir();
    const p = builtProject(dir, 'hana');
    const outside = tempDir('rev2d-avatar-outside-');
    writeFileSync(path.join(outside, 'secret.png'), SOURCE_PNG);
    writeFileSync(path.join(dir, 'neighbour.png'), SOURCE_PNG);
    symlinkSync(outside, path.join(p, 'linked'), 'junction');
    mkdirSync(path.join(p, '.git'));
    writeFileSync(path.join(p, '.git', 'config.json'), '{}');
    writeFileSync(path.join(p, 'page.html'), '<script>alert(1)</script>');
    writeFileSync(path.join(p, 'drawing.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const ws = await start(dir);
    await ok(await open(ws, 'hana'));
    const get = (p: string) => fetch(`${ws.base}/api/avatar/file?path=${encodeURIComponent(p)}`);

    for (const escape of ['../neighbour.png', '..\\neighbour.png', 'textures/../../neighbour.png', path.join(dir, 'neighbour.png'), path.join(p, 'source.png'), '/etc/passwd', 'C:\\Windows\\win.ini', '\\\\server\\share\\x.png', '.', '']) {
      const res = await get(escape);
      const err = await fails(res, escape === '' ? 400 : 403);
      if (escape !== '') expect(err.error, escape).toContain('is not a file inside the project folder');
      expect(err.hint, escape).toContain('relative to the project folder');
    }
    expect((await fails(await get('linked/secret.png'), 403)).error).toContain('through a symbolic link');
    expect((await fails(await get('.git/config.json'), 403)).error).toContain('hidden file');
    for (const file of ['page.html', 'drawing.svg', 'hana.r2d.jsonx', 'textures']) {
      expect((await fails(await get(file), 415)).hint, file).toContain('.png');
    }
    expect((await fails(await get('textures/missing.png'), 404)).error).toBe('file not found in the project: textures/missing.png');
    expect((await fails(await get('textures.png/x.png'), 404)).error).toContain('file not found');
    expect((await fails(await get('a:b.png'), 403)).error).toContain('is not a file inside the project folder'); // a drive-relative path on Windows
    expect((await fails(await get('bad|name.png'), 400)).error).toContain('invalid file name');
    mkdirSync(path.join(p, 'folder.png'));
    expect((await fails(await get('folder.png'), 400)).error).toBe('folder.png is a directory, not a file');
    await fails(await post(ws.base, '/api/avatar/file?path=source.png'), 405);
  });
});

// ----------------------------------------------------------------------------- new project

describe('POST /api/avatar/new', () => {
  const picture = (name = 'My Girl (1).png') => ({ name, base64: SOURCE_PNG.toString('base64') });

  it('creates a project from one PNG, opens it and returns what an agent job needs', async () => {
    const dir = tempDir();
    const ws = await start(dir);
    const created = await ok<AvatarNewResult>(await post(ws.base, '/api/avatar/new', { image: picture() }));
    const p = path.join(dir, 'My_Girl_1');
    expect(created).toEqual({
      project: p,
      projectPath: 'My_Girl_1',
      specFile: path.join(p, 'avatar.json'),
      specPath: 'My_Girl_1/avatar.json',
      name: 'My_Girl_1',
      image: { file: 'source.png', path: 'My_Girl_1/source.png', ...SIZE, bytes: SOURCE_PNG.length },
      mtimeMs: statSync(path.join(p, 'avatar.json')).mtimeMs,
      landmarksToPlace: expect.any(Number),
      notes: [`created My_Girl_1: source.png (${SIZE.width}x${SIZE.height}) and a draft avatar.json`],
    });
    expect(created.landmarksToPlace).toBeGreaterThan(10);
    // The picture byte for byte, and a draft that names it.
    expect(readFileSync(path.join(p, 'source.png')).equals(SOURCE_PNG)).toBe(true);
    const draft = JSON.parse(readFileSync(path.join(p, 'avatar.json'), 'utf8'));
    expect(draft).toMatchObject({ format: 'rev2d-avatar', name: 'My_Girl_1', image: { file: 'source.png', ...SIZE }, face: { nose: null } });

    // It is open, without a model.
    const ref: AvatarRef = { project: p, projectPath: 'My_Girl_1', specFile: created.specFile };
    expect((await ws.sse.next(named('file-changed'))).data).toEqual({ file: null, origin: 'editor', avatar: ref });
    const a = await info(ws);
    expect(a).toMatchObject({ ...ref, name: 'My_Girl_1', mtimeMs: created.mtimeMs, image: { file: 'source.png', ...SIZE }, built: { model: null, meta: null } });
    expect(a.diagnostics.filter((d) => d.code === 'avatar-missing-landmark')).toHaveLength(created.landmarksToPlace);
    expect((await ok<FileListing>(await fetch(`${ws.base}/api/files`))).entries[0].avatar).toEqual({ spec: 'My_Girl_1/avatar.json', name: 'My_Girl_1', model: null });

    // A name and a folder of one's own; a data: URL; an opaque picture gets a note.
    const opaque = encodePNG({ width: 16, height: 16, data: new Uint8ClampedArray(16 * 16 * 4).fill(255) });
    const second = await ok<AvatarNewResult>(await post(ws.base, '/api/avatar/new', { name: 'hero', dir: 'avatars/the hero', image: { name: 'x.png', base64: `data:image/png;base64,${Buffer.from(opaque).toString('base64')}` } }));
    expect(second).toMatchObject({ project: path.join(dir, 'avatars', 'the hero'), projectPath: 'avatars/the hero', specPath: 'avatars/the hero/avatar.json', name: 'hero', image: { path: 'avatars/the hero/source.png', width: 16, height: 16 } });
    expect(second.notes[1]).toContain('no transparent background');
    expect((await info(ws)).project).toBe(second.project);
  });

  it('never overwrites: 409 for an existing folder, or the next free name with unique', async () => {
    const dir = tempDir();
    const ws = await start(dir);
    await ok(await post(ws.base, '/api/avatar/new', { name: 'hero', image: picture() }));
    const before = readFileSync(path.join(dir, 'hero', 'avatar.json'), 'utf8');
    const err = await fails(await post(ws.base, '/api/avatar/new', { name: 'hero', image: picture() }), 409);
    expect(err.error).toBe('the folder hero already exists and is not empty');
    expect(err.hint).toContain('"unique": true');
    expect(readFileSync(path.join(dir, 'hero', 'avatar.json'), 'utf8')).toBe(before);
    writeFileSync(path.join(dir, 'taken'), 'a file');
    expect((await fails(await post(ws.base, '/api/avatar/new', { name: 'hero', dir: 'taken', image: picture() }), 409)).error).toBe('taken is a file');

    const second = await ok<AvatarNewResult>(await post(ws.base, '/api/avatar/new', { name: 'hero', image: picture(), unique: true }));
    expect(second).toMatchObject({ project: path.join(dir, 'hero-2'), projectPath: 'hero-2', name: 'hero' });
    expect(second.notes[1]).toBe('hero exists: the project was created as hero-2');
    const third = await ok<AvatarNewResult>(await post(ws.base, '/api/avatar/new', { name: 'hero', image: picture(), unique: true }));
    expect(third.projectPath).toBe('hero-3');
    // An empty folder is as good as none.
    mkdirSync(path.join(dir, 'empty'));
    expect((await ok<AvatarNewResult>(await post(ws.base, '/api/avatar/new', { name: 'hero', dir: 'empty', image: picture() }))).projectPath).toBe('empty');
  });

  it('accepts PNG only, within the size limits, and creates nothing otherwise', async () => {
    const dir = tempDir();
    const ws = await start(dir, { avatar: { build: 'inline', maxImageBytes: 100 * 1024 } });
    const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
    const tall = Buffer.from(SOURCE_PNG.subarray(0, 33));
    tall.writeUInt32BE(9000, 20);

    const notPng = await fails(await post(ws.base, '/api/avatar/new', { image: { name: 'C:\\Users\\me\\photo.jpg', base64: b64(jpeg) } }), 422);
    expect(notPng.error).toBe('photo.jpg is a JPEG image; an avatar project needs a PNG');
    expect(notPng.hint).toContain('convert the picture to PNG');
    expect((await fails(await post(ws.base, '/api/avatar/new', { image: { name: 'notes.png', base64: b64(Buffer.from('just some text, long enough to look at')) } }), 422)).error).toBe('notes.png is not a PNG image; an avatar project needs a PNG');
    expect((await fails(await post(ws.base, '/api/avatar/new', { image: { name: 'tall.png', base64: b64(tall) } }), 422)).error).toContain('256x9000 px');
    // A PNG that does not decode: the folder that was started is removed again.
    const broken = await fails(await post(ws.base, '/api/avatar/new', { name: 'broken', dir: 'deep/er/broken', image: { name: 'broken.png', base64: b64(SOURCE_PNG.subarray(0, 300)) } }), 422);
    expect(broken.error).toMatch(/^cannot decode broken\.png: .*; nothing was created$/);
    expect(existsSync(path.join(dir, 'deep'))).toBe(false);

    // Too large: the decoded picture, or already the request body.
    const big = Buffer.concat([SOURCE_PNG, Buffer.alloc(100 * 1024)]);
    const large = await fails(await post(ws.base, '/api/avatar/new', { image: { name: 'big.png', base64: b64(big) } }), 413);
    expect(large.error).toMatch(/^the picture is 0\.\d MB; at most 0\.1 MB are accepted$/);
    expect(large.hint).toContain('scale it down');
    const huge = await fails(await post(ws.base, '/api/avatar/new', { image: { name: 'huge.png', base64: b64(Buffer.alloc(400 * 1024)) } }), 413);
    expect(huge.error).toBe('the picture is larger than 0.1 MB');

    for (const [body, status, message] of [
      [{ image: picture(), name: '1st try' }, 400, /"1st try" is not a valid avatar name/],
      [{ image: { name: 'x.png', base64: '!!!' } }, 400, /not valid base64/],
      [{ image: picture(), dir: '../escape' }, 403, /outside the workspace root/],
      [{ image: picture(), dir: 'bad:name' }, 400, /invalid file name/],
      [{ name: 'x' }, 400, /^invalid avatar new request: image/],
      [{ image: picture(), overwrite: true }, 400, /^invalid avatar new request/],
    ] as const) {
      expect((await fails(await post(ws.base, '/api/avatar/new', body), status)).error, JSON.stringify(body).slice(0, 80)).toMatch(message);
    }
    expect((await ok<FileListing>(await fetch(`${ws.base}/api/files`))).entries).toEqual([]);
    expect((await ok<WorkspaceInfo>(await fetch(`${ws.base}/api/workspace`))).avatar).toBeUndefined();
  });
});

// ----------------------------------------------------------------------------- avatar-changed

describe('SSE avatar-changed', () => {
  it('reports edits by other programs: avatar.json, layer images, drawn variants, review sheets', async () => {
    const dir = tempDir();
    const p = builtProject(dir, 'hana');
    const ws = await start(dir);
    await ok(await open(ws, 'hana'));

    // An agent moves a landmark.
    const doc = hanaIllustration(SCALE).doc;
    doc.body.sway = 3;
    writeFileSync(path.join(p, 'avatar.json'), formatModelJson(doc));
    const spec = (await ws.sse.next(avatarChanged('external'))).data;
    expect(spec).toEqual({ origin: 'external', project: p, files: ['avatar.json'], mtimeMs: statSync(path.join(p, 'avatar.json')).mtimeMs });
    expect((await info(ws)).specText).toBe(formatModelJson(doc));

    // A folder that did not exist when the project was opened.
    mkdirSync(path.join(p, 'variants'));
    writeFileSync(path.join(p, 'variants', 'eyes_closed.png'), SOURCE_PNG);
    expect((await ws.sse.next(avatarChanged('external'))).data.files).toEqual(['variants/eyes_closed.png']);
    await sleep(15);
    writeFileSync(path.join(p, 'variants', 'eyes_closed.png'), SOURCE_PNG.subarray(0, 500));
    writeFileSync(path.join(p, 'variants', 'mouth_a.png'), SOURCE_PNG);
    const seen = new Set<string>();
    while (seen.size < 2) for (const f of (await ws.sse.next(avatarChanged('external'))).data.files as string[]) seen.add(f);
    expect([...seen].sort()).toEqual(['variants/eyes_closed.png', 'variants/mouth_a.png']);

    // A layer image, and a review sheet.
    writeFileSync(path.join(p, 'textures', 'base.png'), encodePNG({ width: 2, height: 2, data: new Uint8ClampedArray(16) }));
    expect((await ws.sse.next(avatarChanged('external'))).data.files).toEqual(['textures/base.png']);
    mkdirSync(path.join(p, 'review'));
    writeFileSync(path.join(p, 'review', 'poses.png'), SOURCE_PNG);
    expect((await ws.sse.next(avatarChanged('external'))).data.files).toEqual(['review/poses.png']);
    removeDir(path.join(p, 'review', 'poses.png'));
    expect((await ws.sse.next(avatarChanged('external'))).data.files).toEqual(['review/poses.png']);
    // Whatever the build wrote into textures/ (its layers and layers.json), plus the drawings; the deleted sheet is gone.
    const textures = readdirSync(path.join(p, 'textures')).map((n) => `textures/${n}`);
    expect(textures).toEqual(expect.arrayContaining(['textures/base.png', 'textures/layers.json', ...metaOf(p).layers.map((l) => l.file)]));
    expect((await info(ws)).files.map((f) => f.path)).toEqual(['avatar.json', 'source.png', ...textures.sort(), 'variants/eyes_closed.png', 'variants/mouth_a.png']);

    // Not a change: a touch of avatar.json, scratch files of an agent, other files of the folder.
    const later = new Date(Date.now() + 5000);
    utimesSync(path.join(p, 'avatar.json'), later, later);
    mkdirSync(path.join(p, 'work'));
    writeFileSync(path.join(p, 'work', 'grid.png'), SOURCE_PNG);
    writeFileSync(path.join(p, 'notes.txt'), 'x');
    await sleep(450);
    expect(ws.sse.pending(named('avatar-changed'))).toEqual([]);
  });

  it('reports nothing when switching between unchanged projects while polling', async () => {
    // A poll that was queued for the previous project must not scan the new one against an empty
    // snapshot (every file of it would be reported as changed).
    const dir = tempDir();
    project(dir, 'a');
    project(dir, 'b');
    const ws = await start(dir, { poll: true, pollIntervalMs: 1 });
    for (let i = 0; i < 12; i++) {
      await ok(await open(ws, i % 2 ? 'b' : 'a'));
      await sleep(5);
    }
    await sleep(100);
    expect(ws.sse.pending(named('avatar-changed'))).toEqual([]);
  });

  it('follows the open project, and polls where file events are unavailable', async () => {
    const dir = tempDir();
    const a = project(dir, 'a');
    const b = project(dir, 'b');
    const ws = await start(dir, { poll: true, pollIntervalMs: 40 });
    await ok(await open(ws, 'a'));
    const doc = hanaIllustration(SCALE).doc;
    doc.body.sway = 3;
    writeFileSync(path.join(a, 'avatar.json'), formatModelJson(doc));
    expect((await ws.sse.next(avatarChanged('external'))).data).toMatchObject({ project: a, files: ['avatar.json'] });

    await ok(await open(ws, 'b'));
    doc.body.sway = 4;
    writeFileSync(path.join(a, 'avatar.json'), formatModelJson(doc));
    writeFileSync(path.join(b, 'avatar.json'), formatModelJson(doc));
    expect((await ws.sse.next(avatarChanged('external'))).data).toMatchObject({ project: b, files: ['avatar.json'] });
    await ok(await post(ws.base, '/api/close'));
    doc.body.sway = 5;
    writeFileSync(path.join(b, 'avatar.json'), formatModelJson(doc));
    await sleep(300);
    expect(ws.sse.pending(named('avatar-changed'))).toEqual([]);
  });
});

// ----------------------------------------------------------------------------- view state

describe('editor state in avatar mode', () => {
  it('carries the selected avatar part', async () => {
    const dir = tempDir();
    builtProject(dir, 'hana');
    const ws = await start(dir);
    await ok(await open(ws, 'hana'));
    expect((await post(ws.base, '/api/state', { params: {}, avatar: { part: 'eyes.imageLeft.opening' } })).status).toBe(204);
    expect((await ok<any>(await fetch(`${ws.base}/api/state`))).avatar).toEqual({ part: 'eyes.imageLeft.opening' });
    expect((await post(ws.base, '/api/state', { params: {}, avatar: { part: null, tool: 'move' } })).status).toBe(204);
    expect((await ok<any>(await fetch(`${ws.base}/api/state`))).avatar).toEqual({ part: null, tool: 'move' });
    expect((await fails(await post(ws.base, '/api/state', { params: {}, avatar: { part: 7 } }), 400)).error).toContain('avatar.part');
    expect((await fails(await post(ws.base, '/api/state', { params: {}, avatar: 'eyes' }), 400)).hint).toContain('avatar?:');
  });
});
