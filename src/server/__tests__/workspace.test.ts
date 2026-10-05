/**
 * File management of the editor server (the "workspace" section of src/node/editor-registry.ts):
 * listing, open / new / save as / close / import / download / templates, the recent-files list,
 * confinement to the workspace root (traversal and link escapes) and what a switch updates (events,
 * watcher, registry entry, view state). Real HTTP on port 0 against temp directories.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatModelJson } from '../../core/format.js';
import { EXAMPLES_DIR, blankModel, listTemplates } from '../../api/templates.js';
import { loadModelFile } from '../../node/load.js';
import { listEditors, type FileListing, type OpenResult, type TemplateInfo, type WorkspaceInfo } from '../../node/editor-registry.js';
import { decodePNG } from '../../render/index.js';
import { startEditorServer, type EditorServer, type EditorServerOptions } from '../index.js';
import { makeModelDir, openEvents, removeDir, sleep, testModel, texturePng, type SseClient, type SseEvent } from './helpers.js';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  vi.restoreAllMocks();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => removeDir(dir));
  return dir;
}

interface Ws {
  dir: string;
  file: string;
  server: EditorServer;
  base: string;
  logs: string[];
}

/** An editor server on a temp workspace (model.r2d.json + tex.png) that does not touch ~/.rev2d. */
async function startWs(opts: Partial<EditorServerOptions> = {}): Promise<Ws> {
  const { dir, file } = makeModelDir();
  cleanups.push(() => removeDir(dir));
  const logs: string[] = [];
  const server = await startEditorServer({ file, root: dir, port: 0, devVite: false, register: false, staticDir: path.join(dir, '.no-ui'), log: (m) => logs.push(m), ...opts });
  cleanups.push(() => server.close());
  return { dir, file, server, base: server.url, logs };
}

async function events(base: string): Promise<SseClient> {
  const c = await openEvents(base);
  cleanups.push(() => c.close());
  return c;
}

const post = (base: string, p: string, body?: unknown) =>
  fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

async function ok<T>(res: Response): Promise<T> {
  const text = await res.text();
  expect(res.status, text).toBe(200);
  return JSON.parse(text) as T;
}

async function fails(res: Response, status: number): Promise<{ error: string; hint?: string; diagnostics?: any[]; [k: string]: unknown }> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  const body = JSON.parse(text);
  expect(typeof body.error).toBe('string');
  return body;
}

const fileChanged = (e: SseEvent) => e.event === 'file-changed';
const modelText = (name: string, extra: Record<string, unknown> = {}) => formatModelJson({ ...blankModel({ name, width: 32, height: 32 }), ...extra });

// ----------------------------------------------------------------------------- listing

describe('GET /api/workspace and /api/files', () => {
  it('describes the workspace: root, open model and recent files', async () => {
    const ws = await startWs();
    const info = await ok<WorkspaceInfo>(await fetch(`${ws.base}/api/workspace`));
    expect(info).toEqual({ root: ws.dir, current: ws.file, recent: [ws.file] });
    expect(ws.server.root).toBe(ws.dir);
    expect(ws.server.file).toBe(ws.file);
  });

  it('lists directories, models, PNGs and other JSON files; hides dot entries and other files', async () => {
    const ws = await startWs();
    mkdirSync(path.join(ws.dir, 'b-dir'));
    mkdirSync(path.join(ws.dir, 'A-dir', 'deep'), { recursive: true });
    mkdirSync(path.join(ws.dir, '.git'));
    writeFileSync(path.join(ws.dir, 'notes.txt'), 'x');
    writeFileSync(path.join(ws.dir, 'plain.json'), '{}');
    writeFileSync(path.join(ws.dir, '.hidden.r2d.json'), '{}');
    writeFileSync(path.join(ws.dir, 'A-dir', 'deep', 'm.r2d.jsonc'), modelText('m'));
    const root = await ok<FileListing>(await fetch(`${ws.base}/api/files`));
    expect(root.dir).toBe('');
    expect(root.parent).toBeNull();
    expect(root.entries.map((e) => [e.name, e.type, e.path])).toEqual([
      ['A-dir', 'dir', 'A-dir'],
      ['b-dir', 'dir', 'b-dir'],
      ['model.r2d.json', 'model', 'model.r2d.json'],
      ['plain.json', 'other', 'plain.json'],
      ['tex.png', 'image', 'tex.png'],
    ]);
    const model = root.entries.find((e) => e.type === 'model')!;
    expect(model.size).toBe(readFileSync(ws.file).length);
    expect(model.mtimeMs).toBeGreaterThan(0);

    const deep = await ok<FileListing>(await fetch(`${ws.base}/api/files?dir=${encodeURIComponent('A-dir/deep')}`));
    expect(deep).toMatchObject({ dir: 'A-dir/deep', parent: 'A-dir', entries: [{ name: 'm.r2d.jsonc', type: 'model', path: 'A-dir/deep/m.r2d.jsonc' }] });
    expect((await ok<FileListing>(await fetch(`${ws.base}/api/files?dir=A-dir`))).parent).toBe('');
    // Absolute paths inside the root are accepted and reported relative to it.
    expect((await ok<FileListing>(await fetch(`${ws.base}/api/files?dir=${encodeURIComponent(path.join(ws.dir, 'A-dir'))}`))).dir).toBe('A-dir');
  });

  it('answers 404 / 400 / 403 for missing directories, files and paths outside the root', async () => {
    const ws = await startWs();
    const missing = await fails(await fetch(`${ws.base}/api/files?dir=nope`), 404);
    expect(missing.error).toBe('directory not found: nope');
    expect(missing.hint).toBeTruthy();
    expect((await fails(await fetch(`${ws.base}/api/files?dir=tex.png`), 400)).error).toBe('tex.png is a file, not a directory');
    for (const dir of ['..', '../..', 'A/../../x', path.dirname(ws.dir), path.parse(ws.dir).root]) {
      const err = await fails(await fetch(`${ws.base}/api/files?dir=${encodeURIComponent(dir)}`), 403);
      expect(err.error, dir).toContain('outside the workspace root');
      expect(err.hint, dir).toContain('--root');
    }
  });
});

// ----------------------------------------------------------------------------- confinement

describe('confinement to the workspace root', () => {
  /** A directory link (a junction on Windows: no privileges needed) from the workspace to `target`. */
  function linkDir(target: string, link: string): void {
    symlinkSync(target, link, 'junction');
  }

  it('rejects traversal in every endpoint that takes a path, before touching the file system', async () => {
    const ws = await startWs();
    const outside = tempDir('rev2d-outside-');
    const victim = path.join(outside, 'victim.r2d.json');
    writeFileSync(victim, modelText('victim'));
    const traversal = path.relative(ws.dir, victim);
    const attempts: Array<[string, unknown]> = [
      ['/api/open', { file: traversal }],
      ['/api/open', { file: victim }],
      ['/api/new', { file: path.join(outside, 'new.r2d.json') }],
      ['/api/new', { file: '../escaped.r2d.json' }],
      ['/api/save-as', { file: '../escaped.r2d.json' }],
      ['/api/save-as', { file: victim, overwrite: true }],
      ['/api/import', { dir: '..', files: [{ name: 'x.r2d.json', text: modelText('x') }] }],
      ['/api/command', { type: 'open', file: victim }],
    ];
    for (const [p, body] of attempts) {
      const err = await fails(await post(ws.base, p, body), 403);
      expect(err.error, `${p} ${JSON.stringify(body)}`).toMatch(/is outside the workspace root/);
    }
    expect(readFileSync(victim, 'utf8')).toBe(modelText('victim'));
    expect(existsSync(path.join(outside, 'new.r2d.json'))).toBe(false);
    expect(existsSync(path.join(path.dirname(ws.dir), 'escaped.r2d.json'))).toBe(false);
    expect(ws.server.file).toBe(ws.file);
  });

  it('rejects links that lead outside the root (listing hides them), and broken links', async () => {
    const ws = await startWs();
    const outside = tempDir('rev2d-outside-');
    writeFileSync(path.join(outside, 'secret.r2d.json'), modelText('secret'));
    linkDir(outside, path.join(ws.dir, 'escape'));
    mkdirSync(path.join(ws.dir, 'real'));
    writeFileSync(path.join(ws.dir, 'real', 'in.r2d.json'), modelText('in'));
    linkDir(path.join(ws.dir, 'real'), path.join(ws.dir, 'alias'));

    const names = (await ok<FileListing>(await fetch(`${ws.base}/api/files`))).entries.map((e) => e.name);
    expect(names).toContain('alias');
    expect(names).not.toContain('escape');
    const via = await fails(await post(ws.base, '/api/open', { file: 'escape/secret.r2d.json' }), 403);
    expect(via.error).toMatch(/escape\/secret\.r2d\.json" is outside the workspace root .*through a symbolic link/);
    await fails(await fetch(`${ws.base}/api/files?dir=escape`), 403);
    await fails(await post(ws.base, '/api/new', { file: 'escape/planted.r2d.json' }), 403);
    await fails(await post(ws.base, '/api/import', { dir: 'escape', files: [{ name: 'x.r2d.json', text: modelText('x') }] }), 403);
    expect(existsSync(path.join(outside, 'planted.r2d.json'))).toBe(false);
    expect(existsSync(path.join(outside, 'x.r2d.json'))).toBe(false);

    // A link that stays inside the root is fine.
    const opened = await ok<OpenResult>(await post(ws.base, '/api/open', { file: 'alias/in.r2d.json' }));
    expect(opened.file).toBe(path.join(ws.dir, 'alias', 'in.r2d.json'));

    // A dangling link would let a write create its target wherever it points.
    const gone = tempDir('rev2d-gone-');
    linkDir(gone, path.join(ws.dir, 'dangling'));
    removeDir(gone);
    const broken = await fails(await post(ws.base, '/api/new', { file: 'dangling/x.r2d.json' }), 403);
    expect(broken.error).toContain('broken symbolic link');
    expect(existsSync(gone)).toBe(false);
  });

  it('rejects file links to outside files (where the OS lets the test create one)', async (t) => {
    const ws = await startWs();
    const outside = tempDir('rev2d-outside-');
    writeFileSync(path.join(outside, 'secret.r2d.json'), modelText('secret'));
    try {
      symlinkSync(path.join(outside, 'secret.r2d.json'), path.join(ws.dir, 'link.r2d.json'), 'file');
    } catch {
      return t.skip(); // Windows without the symlink privilege
    }
    await fails(await post(ws.base, '/api/open', { file: 'link.r2d.json' }), 403);
    await fails(await post(ws.base, '/api/save-as', { file: 'link.r2d.json', overwrite: true }), 403);
    expect(readFileSync(path.join(outside, 'secret.r2d.json'), 'utf8')).toBe(modelText('secret'));
  });

  it('refuses a model outside the root at startup, and a missing root', async () => {
    const { dir, file } = makeModelDir();
    cleanups.push(() => removeDir(dir));
    const other = tempDir('rev2d-root-');
    const base = { port: 0, devVite: false, register: false, staticDir: path.join(dir, '.no-ui') } as const;
    await expect(startEditorServer({ ...base, file, root: other })).rejects.toThrow(/the model .*model\.r2d\.json is outside the workspace root/);
    await expect(startEditorServer({ ...base, root: path.join(other, 'missing') })).rejects.toThrow(/workspace root not found: .*missing/);
    await expect(startEditorServer({ ...base, root: file })).rejects.toThrow(/is not a directory/);
  });
});

// ----------------------------------------------------------------------------- open / close

describe('POST /api/open, POST /api/close', () => {
  it('switches the model: result, events, served model, textures, view state and watcher', async () => {
    const ws = await startWs();
    const tab = await events(ws.base);
    expect((await post(ws.base, '/api/state', { params: { Lean: 1 } })).status).toBe(204);
    mkdirSync(path.join(ws.dir, 'sub'));
    const other = path.join(ws.dir, 'sub', 'other.r2d.json');
    const doc = testModel();
    doc.meta.name = 'other';
    doc.textures[0].path = 'blue.png';
    writeFileSync(other, formatModelJson(doc));
    writeFileSync(path.join(ws.dir, 'sub', 'blue.png'), texturePng('#0000ff'));

    const res = await ok<OpenResult>(await post(ws.base, '/api/open', { file: 'sub/other.r2d.json' }));
    expect(res).toEqual({ file: other, text: readFileSync(other, 'utf8'), mtimeMs: expect.any(Number), notes: [] });
    expect((await tab.next(fileChanged)).data).toEqual({ file: other, origin: 'editor' });
    expect(ws.server.file).toBe(other);
    expect((await ok<{ file: string }>(await fetch(`${ws.base}/api/model`))).file).toBe(other);
    expect((await ok<{ info: { name: string } }>(await fetch(`${ws.base}/api/info`))).info.name).toBe('other');
    const tex = decodePNG(new Uint8Array(await (await fetch(`${ws.base}/api/texture/tex`)).arrayBuffer()));
    expect(Array.from(tex.data.subarray(0, 4))).toEqual([0, 0, 255, 255]);
    // The previous model's view state does not apply to this one.
    expect((await fetch(`${ws.base}/api/state`)).status).toBe(404);
    expect((await ok<WorkspaceInfo>(await fetch(`${ws.base}/api/workspace`))).current).toBe(other);

    // The watcher follows: the new file reports changes, the old one no longer does.
    writeFileSync(ws.file, modelText('old-file-edit'));
    await sleep(400);
    expect(tab.pending((e) => e.event === 'model-changed')).toEqual([]);
    writeFileSync(other, formatModelJson({ ...doc, meta: { ...doc.meta, name: 'edited' } }));
    const changed = await tab.next((e) => e.event === 'model-changed');
    expect(changed.data).toMatchObject({ origin: 'external', files: ['other.r2d.json'] });

    // A new event stream starts with the open model.
    const late = await events(ws.base);
    expect(late.events[0].data).toMatchObject({ file: other, root: ws.dir });
  });

  it('opens by absolute path, JSON models not named *.r2d.json, and models with errors (with a note)', async () => {
    const ws = await startWs();
    writeFileSync(path.join(ws.dir, 'plain.json'), modelText('plain'));
    expect((await ok<OpenResult>(await post(ws.base, '/api/open', { file: path.join(ws.dir, 'plain.json') }))).file).toBe(path.join(ws.dir, 'plain.json'));
    const broken = testModel();
    broken.parts[0].parent = 'nowhere';
    writeFileSync(path.join(ws.dir, 'broken.r2d.json'), formatModelJson(broken));
    const res = await ok<OpenResult>(await post(ws.base, '/api/open', { file: 'broken.r2d.json' }));
    expect(res.notes).toEqual(['broken.r2d.json has 1 validation error; the editor lists them under Problems']);
    // Even a syntax error opens when the name says it is a model: the editor shows the problem.
    writeFileSync(path.join(ws.dir, 'half.r2d.json'), '{ "format": "rev2d", ');
    expect((await ok<OpenResult>(await post(ws.base, '/api/open', { file: 'half.r2d.json' }))).notes[0]).toMatch(/half\.r2d\.json has 1 validation error/);
  });

  it('refuses missing files, directories and files that are not models, keeping the open model', async () => {
    const ws = await startWs();
    const missing = await fails(await post(ws.base, '/api/open', { file: 'nope.r2d.json' }), 404);
    expect(missing).toMatchObject({ error: 'file not found: nope.r2d.json', hint: expect.stringContaining('GET /api/files') });
    mkdirSync(path.join(ws.dir, 'folder'));
    expect((await fails(await post(ws.base, '/api/open', { file: 'folder' }), 400)).error).toBe('folder is a directory, not a model file');
    writeFileSync(path.join(ws.dir, 'package.json'), '{"name": "pkg", "version": "1.0.0"}');
    const notModel = await fails(await post(ws.base, '/api/open', { file: 'package.json' }), 422);
    expect(notModel.error).toBe('package.json is not a Rev2D model');
    expect(notModel.diagnostics!.map((d) => d.path)).toContain('/format');
    const png = await fails(await post(ws.base, '/api/open', { file: 'tex.png' }), 422);
    expect(png.error).toBe('tex.png is not a Rev2D model: it is not valid JSON');
    expect(png.diagnostics![0].code).toBe('json-syntax');
    for (const body of [{}, { file: '' }, { file: 3 }, { file: 'model.r2d.json', extra: 1 }]) {
      const err = await fails(await post(ws.base, '/api/open', body), 400);
      expect(err.hint, JSON.stringify(body)).toContain('"file"');
    }
    expect((await fails(await post(ws.base, '/api/open', { file: 'a\0b' }), 400)).error).toContain('NUL');
    expect(ws.server.file).toBe(ws.file);
  });

  it('close leaves no model open: model endpoints answer 409 with a hint until one is opened', async () => {
    const ws = await startWs();
    const tab = await events(ws.base);
    const info = await ok<WorkspaceInfo>(await post(ws.base, '/api/close'));
    expect(info).toEqual({ root: ws.dir, current: null, recent: [ws.file] });
    expect((await tab.next(fileChanged)).data).toEqual({ file: null, origin: 'editor' });
    expect(ws.server.file).toBeNull();

    const checks: Array<[string, RequestInit?]> = [
      ['/api/model'],
      ['/api/model', { method: 'PUT', body: JSON.stringify({ doc: testModel() }) }],
      ['/api/texture/tex'],
      ['/api/screenshot'],
      ['/api/info'],
      ['/api/download'],
      ['/api/state'],
      ['/api/state', { method: 'POST', body: JSON.stringify({ time: 0 }) }],
      ['/api/save-as', { method: 'POST', body: JSON.stringify({ file: 'copy.r2d.json' }) }],
      ['/api/command', { method: 'POST', body: JSON.stringify({ type: 'setParams', params: { Lean: 1 } }) }],
      ['/api/command', { method: 'POST', body: JSON.stringify({ type: 'reload' }) }],
    ];
    for (const [p, init] of checks) {
      const err = await fails(await fetch(ws.base + p, init), 409);
      expect(err.error, p).toBe('no model is open');
      expect(err.hint, p).toContain('POST /api/open');
    }
    expect(existsSync(path.join(ws.dir, 'copy.r2d.json'))).toBe(false);
    // Messages still reach the start screen; the workspace endpoints keep working.
    expect(await ok(await post(ws.base, '/api/command', { type: 'message', text: 'hi' }))).toEqual({ delivered: 1 });
    await ok(await fetch(`${ws.base}/api/files`));
    await ok(await fetch(`${ws.base}/api/templates`));
    const late = await events(ws.base);
    expect(late.events[0].data).toEqual({ file: null, mtimeMs: 0, root: ws.dir });
    // Closing again is harmless; opening brings the endpoints back.
    await ok(await post(ws.base, '/api/close'));
    await ok(await post(ws.base, '/api/open', { file: 'model.r2d.json' }));
    await ok(await fetch(`${ws.base}/api/model`));
  });

  it('starts without a model (start screen) in the given root', async () => {
    const dir = tempDir('rev2d-empty-ws-');
    const server = await startEditorServer({ root: dir, port: 0, devVite: false, register: false, staticDir: path.join(dir, '.no-ui') });
    cleanups.push(() => server.close());
    expect(server.file).toBeNull();
    expect(server.root).toBe(dir);
    expect(await ok(await fetch(`${server.url}/api/workspace`))).toEqual({ root: dir, current: null, recent: [] });
    expect((await fails(await fetch(`${server.url}/api/model`), 409)).error).toBe('no model is open');
    const created = await ok<OpenResult>(await post(server.url, '/api/new', { file: 'first' }));
    expect(created.file).toBe(path.join(dir, 'first.r2d.json'));
    expect(server.file).toBe(created.file);
  });

  it('defaults the root to the current directory without a model', async () => {
    const server = await startEditorServer({ port: 0, devVite: false, register: false, staticDir: path.join(os.tmpdir(), 'rev2d-no-ui') });
    cleanups.push(() => server.close());
    expect(server.root).toBe(process.cwd());
    expect(server.file).toBeNull();
  });

  it('serializes concurrent switches', async () => {
    const ws = await startWs();
    for (const n of ['a', 'b', 'c']) writeFileSync(path.join(ws.dir, `${n}.r2d.json`), modelText(n));
    const results = await Promise.all(['a', 'b', 'c'].map((n) => post(ws.base, '/api/open', { file: `${n}.r2d.json` }).then((r) => ok<OpenResult>(r))));
    expect(results.map((r) => path.basename(r.file))).toEqual(['a.r2d.json', 'b.r2d.json', 'c.r2d.json']);
    expect(ws.server.file).toBe(path.join(ws.dir, 'c.r2d.json'));
  });
});

// ----------------------------------------------------------------------------- open from the AI side

describe('EditorCommand {type: "open"}', () => {
  it('is handled by the server: the tabs follow "file-changed" (origin ai), no command is forwarded', async () => {
    const ws = await startWs();
    const tab = await events(ws.base);
    writeFileSync(path.join(ws.dir, 'b.r2d.json'), modelText('b'));
    const res = await ok<{ delivered: number; file: string; mtimeMs: number; notes: string[] }>(await post(ws.base, '/api/command', { type: 'open', file: 'b.r2d.json' }));
    expect(res).toEqual({ delivered: 1, file: path.join(ws.dir, 'b.r2d.json'), mtimeMs: expect.any(Number), notes: [] });
    expect((await tab.next(fileChanged)).data).toEqual({ file: path.join(ws.dir, 'b.r2d.json'), origin: 'ai' });
    expect(tab.pending((e) => e.event === 'command')).toEqual([]);
    const bad = await fails(await post(ws.base, '/api/command', { type: 'open' }), 400);
    expect(bad.hint).toContain('"type":"open","file"');
    await fails(await post(ws.base, '/api/command', { type: 'open', file: 'missing.r2d.json' }), 404);
  });

  it('updates the registry entry, so the CLI / MCP find the editor by its current file', async () => {
    const home = tempDir('rev2d-home-');
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    const ws = await startWs({ register: true });
    expect(listEditors(ws.file).map((e) => e.url)).toEqual([ws.base]);
    writeFileSync(path.join(ws.dir, 'b.r2d.json'), modelText('b'));
    await ok(await post(ws.base, '/api/command', { type: 'open', file: 'b.r2d.json' }));
    expect(listEditors(path.join(ws.dir, 'b.r2d.json')).map((e) => e.url)).toEqual([ws.base]);
    expect(listEditors(ws.file)).toEqual([]);
    await ok(await post(ws.base, '/api/close'));
    expect(listEditors()).toEqual([expect.objectContaining({ url: ws.base, file: '' })]);
    // register: true also keeps the recent list under the (mocked) home.
    expect(JSON.parse(readFileSync(path.join(home, '.rev2d', 'recent.json'), 'utf8')).files).toEqual([path.join(ws.dir, 'b.r2d.json'), ws.file]);
    await ws.server.close();
    expect(listEditors()).toEqual([]);
  });

  it('refuses writes and view states meant for the model that was switched away from (409)', async () => {
    const ws = await startWs();
    writeFileSync(path.join(ws.dir, 'b.r2d.json'), modelText('b'));
    await ok(await post(ws.base, '/api/open', { file: 'b.r2d.json' }));
    const stale = await fails(await fetch(`${ws.base}/api/model`, { method: 'PUT', body: JSON.stringify({ doc: testModel(), file: ws.file }) }), 409);
    expect(stale.error).toContain(`the write is for ${ws.file}, but the editor now has`);
    expect(stale.file).toBe(path.join(ws.dir, 'b.r2d.json'));
    expect(readFileSync(path.join(ws.dir, 'b.r2d.json'), 'utf8')).toBe(modelText('b'));
    await fails(await post(ws.base, '/api/state', { file: ws.file, time: 0 }), 409);
    // Naming the open model (absolute or root-relative) is fine.
    await ok(await fetch(`${ws.base}/api/model`, { method: 'PUT', body: JSON.stringify({ text: modelText('b2'), file: 'b.r2d.json' }) }));
    expect((await post(ws.base, '/api/state', { file: path.join(ws.dir, 'b.r2d.json'), time: 0 })).status).toBe(204);
  });
});

// ----------------------------------------------------------------------------- new

describe('POST /api/new and GET /api/templates', () => {
  it('lists every template with a description, blank and empty first', async () => {
    const ws = await startWs();
    const list = await ok<TemplateInfo[]>(await fetch(`${ws.base}/api/templates`));
    expect(list.map((t) => t.name)).toEqual(listTemplates());
    expect(list.slice(0, 2).map((t) => t.name)).toEqual(['blank', 'empty']);
    for (const t of list) expect(t.description.length, t.name).toBeGreaterThan(20);
    expect(list.find((t) => t.name === 'textured')!.description).toMatch(/2 PNG textures copied next to the model/);
  });

  it('creates a model from every template and opens it', async () => {
    const ws = await startWs();
    const tab = await events(ws.base);
    for (const template of listTemplates()) {
      const res = await ok<OpenResult>(await post(ws.base, '/api/new', { file: `made/${template}.r2d.json`, template }));
      const abs = path.join(ws.dir, 'made', `${template}.r2d.json`);
      expect(res.file).toBe(abs);
      expect(res.text).toBe(readFileSync(abs, 'utf8'));
      expect(res.notes[0]).toBe(`created made/${template}.r2d.json from template "${template}"`);
      expect((await tab.next(fileChanged)).data).toEqual({ file: abs, origin: 'editor' });
      const m = await loadModelFile(abs);
      expect(m.diagnostics.filter((d) => d.severity === 'error'), template).toEqual([]);
    }
    expect(ws.server.file).toBe(path.join(ws.dir, 'made', `${listTemplates().at(-1)}.r2d.json`));
  });

  it('copies the PNGs of a textured example next to the model (identical copies are shared)', async () => {
    const ws = await startWs();
    const res = await ok<OpenResult>(await post(ws.base, '/api/new', { file: 'art/koi.r2d.json', template: 'textured' }));
    expect(res.notes).toContain('copied textures: art/koi-atlas.png, art/pinwheel.png');
    for (const png of ['koi-atlas.png', 'pinwheel.png']) {
      expect(readFileSync(path.join(ws.dir, 'art', png)).equals(readFileSync(path.join(EXAMPLES_DIR, 'textured', png)))).toBe(true);
    }
    const tex = await fetch(`${ws.base}/api/texture/koiAtlas`);
    expect(tex.status).toBe(200);
    const again = await ok<OpenResult>(await post(ws.base, '/api/new', { file: 'art/koi2.r2d.json', template: 'textured' }));
    expect(again.notes).toContain('reused identical textures: art/koi-atlas.png, art/pinwheel.png');

    // A different file under a texture's name is not replaced without overwrite.
    writeFileSync(path.join(ws.dir, 'pinwheel.png'), texturePng());
    const clash = await fails(await post(ws.base, '/api/new', { file: 'koi3.r2d.json', template: 'textured' }), 409);
    expect(clash.error).toBe('different texture files already exist: pinwheel.png');
    expect(existsSync(path.join(ws.dir, 'koi3.r2d.json'))).toBe(false);
    await ok(await post(ws.base, '/api/new', { file: 'koi3.r2d.json', template: 'textured', overwrite: true }));
    expect(readFileSync(path.join(ws.dir, 'pinwheel.png')).equals(readFileSync(path.join(EXAMPLES_DIR, 'textured', 'pinwheel.png')))).toBe(true);
  });

  it('takes name and canvas size, appends the model extension to a bare name, and notes ignored sizes', async () => {
    const ws = await startWs();
    const res = await ok<OpenResult>(await post(ws.base, '/api/new', { file: 'hero', name: 'Hero', width: 300, height: 200 }));
    expect(res.file).toBe(path.join(ws.dir, 'hero.r2d.json'));
    expect(res.notes).toEqual(['created hero.r2d.json from template "blank"', 'added the model file extension: hero.r2d.json']);
    expect(JSON.parse(res.text).meta).toMatchObject({ name: 'Hero', width: 300, height: 200 });
    const empty = await ok<OpenResult>(await post(ws.base, '/api/new', { file: 'scratch.r2d.json', template: 'empty' }));
    expect(JSON.parse(empty.text)).toEqual({ format: 'rev2d', version: 1, meta: { name: 'scratch', width: 512, height: 512 } });
    const example = await ok<OpenResult>(await post(ws.base, '/api/new', { file: 'm.json', template: 'minimal', width: 10 }));
    expect(example.notes).toEqual([
      'created m.json from template "minimal"',
      'width/height apply only to the "blank" and "empty" templates; the example keeps its canvas size',
      'model files are conventionally named *.r2d.json',
    ]);
  });

  it('refuses existing files unless overwrite, unknown templates, bad sizes and bad names', async () => {
    const ws = await startWs();
    const exists = await fails(await post(ws.base, '/api/new', { file: 'model.r2d.json' }), 409);
    expect(exists).toMatchObject({ error: 'model.r2d.json already exists', hint: expect.stringContaining('"overwrite": true') });
    expect(readFileSync(ws.file, 'utf8')).toBe(formatModelJson(testModel()));
    const replaced = await ok<OpenResult>(await post(ws.base, '/api/new', { file: 'model.r2d.json', overwrite: true }));
    expect(JSON.parse(replaced.text).meta.name).toBe('model');

    const typo = await fails(await post(ws.base, '/api/new', { file: 'x.r2d.json', template: 'blnk' }), 400);
    expect(typo.error).toBe('unknown template "blnk"');
    expect(typo.hint).toMatch(/did you mean "blank"\?.*templates: blank, empty/);
    mkdirSync(path.join(ws.dir, 'folder.r2d.json'));
    expect((await fails(await post(ws.base, '/api/new', { file: 'folder.r2d.json' }), 400)).error).toBe('folder.r2d.json is a directory');
    for (const body of [{ file: 'x.r2d.json', width: 0 }, { file: 'x.r2d.json', height: 1.5 }, { file: 'x.r2d.json', width: 9000 }, { template: 'blank' }]) {
      await fails(await post(ws.base, '/api/new', body), 400);
    }
    for (const file of ['bad:name.r2d.json', 'nul.r2d.json', 'sub/CON/x.r2d.json', 'trailing./x.r2d.json', 'q?.r2d.json']) {
      const err = await fails(await post(ws.base, '/api/new', { file }), 400);
      expect(err.error, file).toMatch(/^invalid file name/);
    }
    expect(ws.server.file).toBe(ws.file);
  });
});

// ----------------------------------------------------------------------------- save as

describe('POST /api/save-as', () => {
  it('writes the doc to a new path, rewrites relative texture paths and opens the copy', async () => {
    const ws = await startWs();
    const tab = await events(ws.base);
    const doc = testModel();
    doc.meta.name = 'unsaved edit';
    const res = await ok<OpenResult>(await post(ws.base, '/api/save-as', { file: 'versions/v2.r2d.json', doc }));
    const abs = path.join(ws.dir, 'versions', 'v2.r2d.json');
    expect(res.file).toBe(abs);
    expect(res.notes).toEqual(['saved as versions/v2.r2d.json', 'texture "tex": path "tex.png" rewritten to "../tex.png" so it still points at the same file']);
    const written = JSON.parse(readFileSync(abs, 'utf8'));
    expect(written.meta.name).toBe('unsaved edit');
    expect(written.textures[0].path).toBe('../tex.png');
    expect(written.textures[1].path).toBe(doc.textures[1].path); // data: URIs stay
    expect(readFileSync(ws.file, 'utf8')).toBe(formatModelJson(testModel())); // the original is untouched
    expect((await tab.next(fileChanged)).data).toEqual({ file: abs, origin: 'editor' });
    // The copy renders with the same texture.
    const tex = decodePNG(new Uint8Array(await (await fetch(`${ws.base}/api/texture/tex`)).arrayBuffer()));
    expect(Array.from(tex.data.subarray(0, 4))).toEqual([255, 0, 0, 255]);

    // Back at the root level the path becomes "tex.png" again.
    const back = await ok<OpenResult>(await post(ws.base, '/api/save-as', { file: 'v3.r2d.json' }));
    expect(JSON.parse(back.text).textures[0].path).toBe('tex.png');
    expect(back.notes).toContain('texture "tex": path "../tex.png" rewritten to "tex.png" so it still points at the same file');
  });

  it('keeps raw text verbatim when no path changes, saves the file as it is without doc/text, and notes missing textures', async () => {
    const ws = await startWs();
    const text = formatModelJson(testModel()).replace('{', '{\n  // keep me');
    const same = await ok<OpenResult>(await post(ws.base, '/api/save-as', { file: 'copy.r2d.json', text }));
    expect(readFileSync(path.join(ws.dir, 'copy.r2d.json'), 'utf8')).toBe(text);
    expect(same.notes).toEqual(['saved as copy.r2d.json']);

    const moved = await ok<OpenResult>(await post(ws.base, '/api/save-as', { file: 'deep/er/copy.r2d.json', text }));
    expect(moved.notes).toContain('the text was reformatted to rewrite its texture paths (comments and custom formatting are not kept)');
    expect(JSON.parse(moved.text).textures[0].path).toBe('../../tex.png');

    rmSync(path.join(ws.dir, 'tex.png'));
    const plain = await ok<OpenResult>(await post(ws.base, '/api/save-as', { file: 'plain.r2d.json' }));
    // The open file is in the standard format: rewriting its paths loses nothing, so no such note.
    expect(plain.notes.some((n) => n.includes('reformatted'))).toBe(false);
    expect(plain.text).toBe(formatModelJson({ ...JSON.parse(moved.text), textures: [{ id: 'tex', path: 'tex.png' }, JSON.parse(moved.text).textures[1]] }));
    expect(plain.notes).toContain(`texture "tex": ${path.join(ws.dir, 'tex.png')} does not exist`);
  });

  it('guards existing files and refuses unparseable text or bad bodies, writing nothing', async () => {
    const ws = await startWs();
    writeFileSync(path.join(ws.dir, 'taken.r2d.json'), modelText('taken'));
    const taken = await fails(await post(ws.base, '/api/save-as', { file: 'taken.r2d.json', doc: testModel() }), 409);
    expect(taken.error).toBe('taken.r2d.json already exists');
    expect(readFileSync(path.join(ws.dir, 'taken.r2d.json'), 'utf8')).toBe(modelText('taken'));
    await ok(await post(ws.base, '/api/save-as', { file: 'taken.r2d.json', doc: testModel(), overwrite: true }));
    expect(JSON.parse(readFileSync(path.join(ws.dir, 'taken.r2d.json'), 'utf8')).meta.name).toBe('server-test');
    // Saving over the open model itself needs no overwrite.
    await ok(await post(ws.base, '/api/save-as', { file: 'taken.r2d.json', doc: { ...testModel(), meta: { ...testModel().meta, name: 'resaved' } } }));

    const syntax = await fails(await post(ws.base, '/api/save-as', { file: 'broken.r2d.json', text: '{ "format": ' }), 422);
    expect(syntax.diagnostics![0].code).toBe('json-syntax');
    expect(existsSync(path.join(ws.dir, 'broken.r2d.json'))).toBe(false);
    for (const body of [{ file: 'x.r2d.json', doc: {}, text: '{}' }, { file: 'x.r2d.json', doc: [1] }, { file: 'x.r2d.json', text: 5 }, { doc: {} }]) {
      await fails(await post(ws.base, '/api/save-as', body), 400);
    }
    expect(existsSync(path.join(ws.dir, 'x.r2d.json'))).toBe(false);
  });
});

// ----------------------------------------------------------------------------- import

describe('POST /api/import', () => {
  const pngB64 = (color = '#00ff00') => Buffer.from(texturePng(color)).toString('base64');
  const importedModel = () => {
    const doc = testModel();
    doc.meta.name = 'imported';
    return doc;
  };

  it('writes the model and its PNGs into the target directory and opens the model', async () => {
    const ws = await startWs();
    const tab = await events(ws.base);
    const res = await ok<OpenResult>(
      await post(ws.base, '/api/import', {
        dir: 'incoming',
        files: [
          { name: 'hero.r2d.json', text: formatModelJson(importedModel()) },
          { name: 'tex.png', base64: `data:image/png;base64,${pngB64()}` },
          { name: 'readme.txt', text: 'hello' },
        ],
      }),
    );
    const abs = path.join(ws.dir, 'incoming', 'hero.r2d.json');
    expect(res.file).toBe(abs);
    expect(res.notes).toEqual(['imported incoming/hero.r2d.json, incoming/tex.png into incoming', 'skipped readme.txt: only a model (.json) with its PNG textures, or a Spine export (.json + .atlas + PNG pages), is imported']);
    expect((await tab.next(fileChanged)).data).toEqual({ file: abs, origin: 'editor' });
    const tex = decodePNG(new Uint8Array(await (await fetch(`${ws.base}/api/texture/tex`)).arrayBuffer()));
    expect(Array.from(tex.data.subarray(0, 4))).toEqual([0, 255, 0, 255]);

    // Importing identical files again is fine; different ones need overwrite.
    const again = await ok<OpenResult>(await post(ws.base, '/api/import', { dir: 'incoming', files: [{ name: 'hero.r2d.json', text: formatModelJson(importedModel()) }] }));
    expect(again.notes).toEqual(['imported nothing new into incoming', 'incoming/hero.r2d.json is already there (identical)']);
    const changed = { dir: 'incoming', files: [{ name: 'hero.r2d.json', base64: Buffer.from(modelText('v2')).toString('base64') }, { name: 'tex.png', base64: pngB64('#0000ff') }] };
    const clash = await fails(await post(ws.base, '/api/import', changed), 409);
    expect(clash.error).toBe('files already exist: incoming/hero.r2d.json, incoming/tex.png; nothing was imported');
    expect(clash.hint).toContain('"overwrite": true');
    expect(JSON.parse(readFileSync(abs, 'utf8')).meta.name).toBe('imported');
    await ok(await post(ws.base, '/api/import', { ...changed, overwrite: true }));
    expect(JSON.parse(readFileSync(abs, 'utf8')).meta.name).toBe('v2');
  });

  it('imports into the root by default and notes textures that were not imported', async () => {
    const ws = await startWs();
    const doc = importedModel();
    doc.textures.push({ id: 'missing', path: 'art/missing.png' });
    const res = await ok<OpenResult>(await post(ws.base, '/api/import', { files: [{ name: 'hero.json', text: formatModelJson(doc) }] }));
    expect(res.file).toBe(path.join(ws.dir, 'hero.json'));
    expect(res.notes).toContain('texture "missing" (art/missing.png) was not imported and does not exist next to the model; import the PNG too, or fix the path');
    expect(res.notes.some((n) => n.includes('"tex"'))).toBe(false); // tex.png already exists in the root
  });

  it('rejects invalid JSON and non-models with diagnostics, bad PNGs, bad names and wrong model counts', async () => {
    const ws = await startWs();
    const bad = async (body: unknown, status: number) => {
      const err = await fails(await post(ws.base, '/api/import', body), status);
      expect(ws.server.file).toBe(ws.file);
      return err;
    };
    const syntax = await bad({ files: [{ name: 'a.r2d.json', text: '{ "format": "rev2d", ' }] }, 422);
    expect(syntax.error).toBe('a.r2d.json is not valid JSON; nothing was imported');
    expect(syntax.diagnostics![0]).toMatchObject({ severity: 'error', code: 'json-syntax' });
    const notModel = await bad({ files: [{ name: 'package.json', text: '{"name": "x"}' }] }, 422);
    expect(notModel.error).toBe('package.json is not a Rev2D model; nothing was imported');
    expect(notModel.diagnostics!.some((d) => d.path === '/format')).toBe(true);
    expect((await bad({ files: [{ name: 'm.r2d.json', text: modelText('m') }, { name: 'fake.png', text: 'not png' }] }, 422)).error).toBe('fake.png is not a PNG file; nothing was imported');
    expect((await bad({ files: [{ name: 'tex2.png', base64: pngB64() }] }, 400)).error).toBe('no model file among the imported files');
    expect((await bad({ files: [{ name: 'a.r2d.json', text: modelText('a') }, { name: 'b.r2d.json', text: modelText('b') }] }, 400)).error).toBe('import one model at a time (got a.r2d.json, b.r2d.json)');
    for (const name of ['../evil.r2d.json', 'a\\b.r2d.json', 'x/../../y.r2d.json', '/abs.r2d.json', 'con.r2d.json', 'a:b.r2d.json']) {
      expect((await bad({ files: [{ name, text: modelText('x') }] }, 400)).error, name).toMatch(/^invalid file name/);
    }
    await bad({ files: [{ name: 'm.r2d.json', text: modelText('m'), base64: 'AA==' }] }, 400);
    await bad({ files: [{ name: 'm.png', base64: '***' }, { name: 'm.r2d.json', text: modelText('m') }] }, 400);
    await bad({ files: [] }, 400);
    await bad({ files: [{ name: 'm.r2d.json', text: modelText('m') }, { name: 'm.r2d.json', text: modelText('m') }] }, 400);
    await bad({ dir: 'tex.png', files: [{ name: 'm.r2d.json', text: modelText('m') }] }, 400);
    expect(existsSync(path.join(ws.dir, 'm.r2d.json'))).toBe(false);
    expect(existsSync(path.join(ws.dir, 'a.r2d.json'))).toBe(false);
  });

  it('caps the import size', async () => {
    const ws = await startWs({ maxImportBytes: 4096 });
    const big = await fails(await post(ws.base, '/api/import', { files: [{ name: 'm.r2d.json', text: modelText('m'), extra: 'x'.repeat(8000) }] }), 413);
    expect(big.error).toContain('4096');
    const ws2 = await startWs({ maxBodyBytes: 2048 });
    const huge = formatModelJson({ ...blankModel({ name: 'huge' }), meta: { name: 'huge', width: 8, height: 8, description: 'x'.repeat(3000) } });
    const tooBig = await fails(await post(ws2.base, '/api/import', { files: [{ name: 'huge.r2d.json', text: huge }] }), 413);
    expect(tooBig.error).toMatch(/the editor saves models of at most 2048 bytes/);
  });
});

// ----------------------------------------------------------------------------- download

describe('GET /api/download', () => {
  it('sends the open model as an attachment', async () => {
    const ws = await startWs();
    const res = await fetch(`${ws.base}/api/download`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="model.r2d.json"; filename*=UTF-8''model.r2d.json`);
    expect(await res.text()).toBe(readFileSync(ws.file, 'utf8'));

    writeFileSync(path.join(ws.dir, 'héros (1).r2d.json'), modelText('h'));
    await ok(await post(ws.base, '/api/open', { file: 'héros (1).r2d.json' }));
    const named = await fetch(`${ws.base}/api/download`);
    expect(named.headers.get('content-disposition')).toBe(`attachment; filename="h_ros (1).r2d.json"; filename*=UTF-8''h%C3%A9ros%20%281%29.r2d.json`);
    expect(await named.text()).toBe(modelText('h'));
  });
});

// ----------------------------------------------------------------------------- recent files

describe('recent files', () => {
  it('persists the newest 10 existing files inside the root, shared by servers', async () => {
    const store = path.join(tempDir('rev2d-recent-'), 'nested', 'recent.json');
    const ws = await startWs({ recentFile: store });
    const names = Array.from({ length: 12 }, (_, i) => `m${i}.r2d.json`);
    for (const n of names) writeFileSync(path.join(ws.dir, n), modelText(n));
    for (const n of names) await ok(await post(ws.base, '/api/open', { file: n }));
    const expected = names.slice(2).reverse().map((n) => path.join(ws.dir, n));
    expect(JSON.parse(readFileSync(store, 'utf8'))).toEqual({ files: expected });
    expect((await ok<WorkspaceInfo>(await fetch(`${ws.base}/api/workspace`))).recent).toEqual(expected);

    // Reopening moves a file to the front; deleted files drop out.
    await ok(await post(ws.base, '/api/open', { file: 'm5.r2d.json' }));
    rmSync(path.join(ws.dir, 'm10.r2d.json'));
    const recent = (await ok<WorkspaceInfo>(await fetch(`${ws.base}/api/workspace`))).recent;
    expect(recent[0]).toBe(path.join(ws.dir, 'm5.r2d.json'));
    expect(recent).not.toContain(path.join(ws.dir, 'm10.r2d.json'));
    expect(new Set(recent).size).toBe(recent.length);

    // Another server (another workspace) shares the file but lists only its own root's files.
    const other = await startWs({ recentFile: store });
    const info = await ok<WorkspaceInfo>(await fetch(`${other.base}/api/workspace`));
    expect(info.recent).toEqual([other.file]);
    expect(JSON.parse(readFileSync(store, 'utf8')).files[0]).toBe(other.file);
    expect(JSON.parse(readFileSync(store, 'utf8')).files).toContain(path.join(ws.dir, 'm5.r2d.json'));
  });

  it('survives a corrupt list and keeps the list in memory when no file is given', async () => {
    const store = path.join(tempDir('rev2d-recent-'), 'recent.json');
    writeFileSync(store, 'not json');
    const ws = await startWs({ recentFile: store });
    expect((await ok<WorkspaceInfo>(await fetch(`${ws.base}/api/workspace`))).recent).toEqual([ws.file]);
    expect(JSON.parse(readFileSync(store, 'utf8'))).toEqual({ files: [ws.file] });

    const memory = await startWs({ recentFile: null });
    writeFileSync(path.join(memory.dir, 'b.r2d.json'), modelText('b'));
    await ok(await post(memory.base, '/api/open', { file: 'b.r2d.json' }));
    expect((await ok<WorkspaceInfo>(await fetch(`${memory.base}/api/workspace`))).recent).toEqual([path.join(memory.dir, 'b.r2d.json'), memory.file]);
  });
});
