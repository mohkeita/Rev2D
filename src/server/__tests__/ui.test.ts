import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listEditors, registryDir } from '../../node/editor-registry.js';
import { startEditorServer, type EditorServer } from '../index.js';
import { makeModelDir, rawRequest, removeDir } from './helpers.js';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  vi.restoreAllMocks();
});

function modelDir() {
  const m = makeModelDir();
  cleanups.push(() => removeDir(m.dir));
  return m;
}

async function start(opts: Parameters<typeof startEditorServer>[0]): Promise<EditorServer> {
  const server = await startEditorServer({ port: 0, devVite: false, register: false, ...opts });
  cleanups.push(() => server.close());
  return server;
}

describe('static editor UI', () => {
  function builtUi(root: string): string {
    const ui = path.join(root, 'dist');
    mkdirSync(path.join(ui, 'assets'), { recursive: true });
    writeFileSync(path.join(ui, 'index.html'), '<!doctype html><title>editor</title>');
    writeFileSync(path.join(ui, 'assets', 'app-1234.js'), 'console.log(1)');
    writeFileSync(path.join(root, 'secret.txt'), 'TOP SECRET');
    return ui;
  }

  it('serves the build with MIME types, cache headers and SPA fallback', async () => {
    const { dir, file } = modelDir();
    const server = await start({ file, staticDir: builtUi(dir) });
    expect(server.ui.mode).toBe('static');

    const index = await fetch(server.url + '/');
    expect(index.status).toBe(200);
    expect(index.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(index.headers.get('cache-control')).toBe('no-cache');
    expect(await index.text()).toContain('<title>editor</title>');

    const js = await fetch(server.url + '/assets/app-1234.js');
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(js.headers.get('cache-control')).toContain('immutable');
    expect(await js.text()).toBe('console.log(1)');

    const route = await fetch(server.url + '/some/client/route');
    expect(route.status).toBe(200);
    expect(await route.text()).toContain('<title>editor</title>');

    const missing = await fetch(server.url + '/assets/missing.js');
    expect(missing.status).toBe(404);

    const head = await fetch(server.url + '/assets/app-1234.js', { method: 'HEAD' });
    expect(head.headers.get('content-length')).toBe('14');
  });

  it('never serves files outside the UI directory', async () => {
    const { dir, file } = modelDir();
    const server = await start({ file, staticDir: builtUi(dir) });
    for (const p of ['/..%2fsecret.txt', '/%2e%2e/secret.txt', '/../secret.txt', '/..%5csecret.txt', '/assets/..%2f..%2fsecret.txt', `/${encodeURIComponent(path.join(dir, 'secret.txt'))}`]) {
      const res = await rawRequest(server.url, { path: p });
      expect(res.body.toString(), p).not.toContain('TOP SECRET');
      expect([400, 404], p).toContain(res.status);
    }
  });

  it('explains how to build the UI when there is none', async () => {
    const { dir, file } = modelDir();
    const server = await start({ file, staticDir: path.join(dir, 'nothing-here') });
    expect(server.ui.mode).toBe('none');
    expect(server.ui.detail).toContain('nothing-here');

    const page = await fetch(server.url + '/', { headers: { Accept: 'text/html' } });
    expect(page.status).toBe(503);
    expect(await page.text()).toContain('npm run editor:build');

    const api = await fetch(server.url + '/whatever', { headers: { Accept: 'application/json' } });
    expect(api.status).toBe(404);
    expect((await api.json()).hint).toContain('editor:build');

    // The API keeps working without a UI.
    expect((await fetch(server.url + '/api/model')).status).toBe(200);
  });
});

describe('Vite dev UI', () => {
  it('serves the editor sources through Vite middleware when no build exists', async () => {
    const { dir, file } = modelDir();
    const src = path.join(dir, 'ui-src');
    mkdirSync(src);
    writeFileSync(path.join(src, 'index.html'), '<!doctype html><html><head><title>dev</title></head><body><script type="module" src="/main.ts"></script></body></html>');
    writeFileSync(path.join(src, 'main.ts'), 'const answer: number = 42;\nconsole.log(answer);\n');
    const viteConfig = path.join(src, 'vite.config.mjs');
    writeFileSync(viteConfig, `export default { root: ${JSON.stringify(src)}, logLevel: 'silent' };\n`);

    const server = await start({ file, staticDir: path.join(dir, 'no-build'), devVite: true, viteConfig });
    expect(server.ui.mode).toBe('vite');
    const html = await (await fetch(server.url + '/deep/route', { headers: { Accept: 'text/html' } })).text();
    expect(html).toContain('/@vite/client');
    const ts = await fetch(server.url + '/main.ts');
    expect(ts.headers.get('content-type')).toContain('javascript');
    expect(await ts.text()).toContain('const answer = 42');
    // API routes take precedence over the UI.
    expect((await fetch(server.url + '/api/info')).status).toBe(200);

    // Vite reports compile errors to its log/overlay and then passes the request on: say so.
    writeFileSync(path.join(src, 'broken.ts'), 'const x: number = ;\n');
    const broken = await fetch(server.url + '/broken.ts');
    expect(broken.status).toBe(404);
    const err = await broken.json();
    expect(err.error).toBe('not found: /broken.ts');
    expect(err.hint).toContain('failed to compile');
  });

  it('reports why neither a build nor Vite is available', async () => {
    const { dir, file } = modelDir();
    const server = await start({ file, staticDir: path.join(dir, 'no-build'), devVite: true, viteConfig: path.join(dir, 'missing.config.ts') });
    expect(server.ui.mode).toBe('none');
    expect(server.ui.detail).toContain('no Vite config');
  });
});

describe('editor registry', () => {
  it('advertises every server of a process in its own entry and withdraws each on close', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'rev2d-home-'));
    cleanups.push(() => removeDir(home));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    expect(registryDir().startsWith(home)).toBe(true);

    const { file } = modelDir();
    const first = await startEditorServer({ file, port: 0, devVite: false, staticDir: path.join(home, 'no-ui') });
    const second = await startEditorServer({ file, port: 0, devVite: false, staticDir: path.join(home, 'no-ui') });
    cleanups.push(() => first.close(), () => second.close());

    // Entries are keyed by pid and port: two servers of one process do not overwrite each other.
    const firstEntry = path.join(registryDir(), `${process.pid}-${first.port}.json`);
    const secondEntry = path.join(registryDir(), `${process.pid}-${second.port}.json`);
    expect(JSON.parse(readFileSync(firstEntry, 'utf8'))).toMatchObject({ pid: process.pid, url: first.url, file: path.resolve(file) });
    expect(JSON.parse(readFileSync(secondEntry, 'utf8'))).toMatchObject({ pid: process.pid, url: second.url });
    expect(listEditors(file).map((e) => e.url).sort()).toEqual([first.url, second.url].sort());

    await second.close();
    expect(existsSync(secondEntry)).toBe(false);
    expect(listEditors(file)).toEqual([expect.objectContaining({ pid: process.pid, url: first.url, file: path.resolve(file) })]);
    await first.close();
    expect(existsSync(firstEntry)).toBe(false);
    expect(readdirSync(registryDir())).toEqual([]);
    expect(listEditors()).toEqual([]);
  });
});

describe('startup errors', () => {
  it('names a missing model file', async () => {
    const missing = path.join(os.tmpdir(), 'rev2d-missing', 'none.r2d.json');
    await expect(startEditorServer({ file: missing, port: 0, devVite: false, register: false })).rejects.toThrow(/model file not found: .*none\.r2d\.json/);
  });

  it('explains a busy port', async () => {
    const { dir, file } = modelDir();
    const first = await start({ file, staticDir: path.join(dir, 'no-ui') });
    await expect(start({ file, port: first.port, staticDir: path.join(dir, 'no-ui') })).rejects.toThrow(/already in use.*0 for any free port/);
  });
});
