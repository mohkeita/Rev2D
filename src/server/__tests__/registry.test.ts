/**
 * ~/.rev2d/editors: one entry file per running editor server, keyed by pid and port, naming the model it
 * has open and its workspace root, so the CLI / MCP find an editor by any path of its workspace.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { editorHasFile, editorRootContains, findEditor, listEditors, registerEditor, registryDir, type EditorEntry } from '../../node/editor-registry.js';
import { startEditorServer } from '../index.js';
import { removeDir } from './helpers.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'rev2d-registry-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
});

afterEach(() => {
  vi.restoreAllMocks();
  removeDir(home);
});

const entry = (url: string, startedAt: string, file = path.join(home, 'm.r2d.json')): EditorEntry => ({ pid: process.pid, url, file, startedAt });

describe('editor registry', () => {
  it('names entry files <pid>-<port>.json, so servers of one process do not collide', () => {
    const a = registerEditor(entry('http://127.0.0.1:4777', '2026-01-01T00:00:00.000Z'));
    const b = registerEditor(entry('http://127.0.0.1:4778', '2026-01-01T00:00:01.000Z'));
    const c = registerEditor(entry('http://[::1]', '2026-01-01T00:00:02.000Z'));
    expect(readdirSync(registryDir()).sort()).toEqual([`${process.pid}-4777.json`, `${process.pid}-4778.json`, `${process.pid}-80.json`]);
    // Newest first.
    expect(listEditors().map((e) => e.url)).toEqual(['http://[::1]', 'http://127.0.0.1:4778', 'http://127.0.0.1:4777']);
    expect(findEditor()?.url).toBe('http://[::1]');
    b();
    expect(listEditors().map((e) => e.url)).toEqual(['http://[::1]', 'http://127.0.0.1:4777']);
    a();
    c();
    expect(readdirSync(registryDir())).toEqual([]);
  });

  it('filters by model file and removes entries of dead processes', () => {
    registerEditor(entry('http://127.0.0.1:4777', '2026-01-01T00:00:00.000Z', path.join(home, 'a.r2d.json')));
    registerEditor(entry('http://127.0.0.1:4778', '2026-01-01T00:00:01.000Z', path.join(home, 'b.r2d.json')));
    expect(listEditors(path.join(home, 'a.r2d.json')).map((e) => e.url)).toEqual(['http://127.0.0.1:4777']);

    // An entry left behind by a crashed server (legacy <pid>.json name included) is cleaned up.
    const dead = { pid: 2 ** 22 + 12345, url: 'http://127.0.0.1:4790', file: path.join(home, 'a.r2d.json'), startedAt: '2026-01-02T00:00:00.000Z' };
    mkdirSync(registryDir(), { recursive: true });
    const legacy = path.join(registryDir(), `${dead.pid}.json`);
    writeFileSync(legacy, JSON.stringify(dead));
    registerEditor(dead);
    expect(listEditors().map((e) => e.url)).toEqual(['http://127.0.0.1:4778', 'http://127.0.0.1:4777']);
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(path.join(registryDir(), `${dead.pid}-4790.json`))).toBe(false);
  });

  it('returns an explicit url without consulting the registry', () => {
    expect(findEditor({ url: 'http://127.0.0.1:9999/' })).toEqual({ pid: -1, url: 'http://127.0.0.1:9999', file: '', startedAt: '' });
    expect(findEditor()).toBeNull();
  });

  it('finds editors by workspace root: the open file first, else the innermost root containing the path', () => {
    const proj = path.join(home, 'proj');
    const models = path.join(proj, 'models');
    const withRoot = (url: string, startedAt: string, file: string, root?: string): EditorEntry => ({ pid: process.pid, url, file, ...(root ? { root } : {}), startedAt });
    registerEditor(withRoot('http://127.0.0.1:4801', '2026-01-01T00:00:01.000Z', path.join(proj, 'hero.r2d.json'), proj));
    registerEditor(withRoot('http://127.0.0.1:4802', '2026-01-01T00:00:02.000Z', '', models)); // start screen
    registerEditor(withRoot('http://127.0.0.1:4803', '2026-01-01T00:00:03.000Z', path.join(home, 'elsewhere', 'x.r2d.json'), path.join(home, 'elsewhere')));
    registerEditor(withRoot('http://127.0.0.1:4804', '2026-01-01T00:00:04.000Z', path.join(home, 'old.r2d.json'))); // predates roots
    const url = (e: EditorEntry | null) => e?.url ?? null;

    // A file an editor has open selects it, even when an inner workspace contains the file too.
    expect(url(findEditor({ file: path.join(proj, 'hero.r2d.json') }))).toBe('http://127.0.0.1:4801');
    // Nobody has it open: the innermost root containing it, e.g. the start-screen editor of models/.
    expect(url(findEditor({ file: path.join(models, 'cat', 'cat.r2d.json') }))).toBe('http://127.0.0.1:4802');
    expect(url(findEditor({ file: path.join(proj, 'new.r2d.json') }))).toBe('http://127.0.0.1:4801');
    expect(findEditor({ file: path.join(home, 'nowhere', 'n.r2d.json') })).toBeNull();
    // An entry without a root is only found by the file it has open.
    expect(url(findEditor({ file: path.join(home, 'old.r2d.json') }))).toBe('http://127.0.0.1:4804');
    expect(findEditor({ file: path.join(home, 'other.r2d.json') })).toBeNull();

    // {root}: the editor of exactly that root, else the innermost one containing it; combined with file.
    expect(url(findEditor({ root: models }))).toBe('http://127.0.0.1:4802');
    expect(url(findEditor({ root: path.join(models, 'cat') }))).toBe('http://127.0.0.1:4802');
    expect(url(findEditor({ root: proj }))).toBe('http://127.0.0.1:4801');
    expect(url(findEditor({ root: proj, file: path.join(models, 'm.r2d.json') }))).toBe('http://127.0.0.1:4801');
    expect(findEditor({ root: path.join(home, 'nowhere') })).toBeNull();

    // listEditors: {root} = exactly that root; {inside} = roots containing the path, innermost first.
    expect(listEditors({ root: proj }).map((e) => e.url)).toEqual(['http://127.0.0.1:4801']);
    expect(listEditors({ inside: path.join(models, 'a.r2d.json') }).map((e) => e.url)).toEqual(['http://127.0.0.1:4802', 'http://127.0.0.1:4801']);
    expect(listEditors({ inside: proj }).map((e) => e.url)).toEqual(['http://127.0.0.1:4801']);
    // Conditions combine.
    expect(listEditors({ file: path.join(proj, 'hero.r2d.json'), inside: models }).map((e) => e.url)).toEqual(['http://127.0.0.1:4801']);
    expect(listEditors({ file: path.join(proj, 'hero.r2d.json'), root: models })).toEqual([]);
    // The string form still filters by the open file only.
    expect(listEditors(path.join(models, 'a.r2d.json'))).toEqual([]);

    const start = findEditor({ file: path.join(models, 'a.r2d.json') })!;
    expect(editorHasFile(start, path.join(models, 'a.r2d.json'))).toBe(false);
    expect(editorRootContains(start, path.join(models, 'a.r2d.json'))).toBe(true);
    expect(editorRootContains(start, models)).toBe(true);
    expect(editorRootContains(start, `${models}-copy`)).toBe(false);
    expect(editorRootContains(start, proj)).toBe(false);
    if (process.platform === 'win32') {
      // Paths compare case-insensitively where the file system does.
      expect(url(findEditor({ file: path.join(proj, 'HERO.r2d.json').toUpperCase() }))).toBe('http://127.0.0.1:4801');
      expect(editorRootContains(start, path.join(models, 'A.R2D.JSON').toUpperCase())).toBe(true);
    }
  });

  it('matches a root reached through a link or junction by its real path', () => {
    const real = path.join(home, 'real-ws');
    mkdirSync(real);
    const link = path.join(home, 'link-ws');
    try {
      symlinkSync(real, link, 'junction');
    } catch (e) {
      console.warn(`skipped: cannot create a link here (${(e as Error).message})`);
      return;
    }
    registerEditor({ pid: process.pid, url: 'http://127.0.0.1:4811', file: '', root: real, startedAt: '2026-01-01T00:00:00.000Z' });
    expect(findEditor({ file: path.join(link, 'sub', 'm.r2d.json') })?.url).toBe('http://127.0.0.1:4811');
    expect(listEditors({ inside: link }).map((e) => e.url)).toEqual(['http://127.0.0.1:4811']);
  });

  it('is written by the editor server with its workspace root, also while no model is open', async () => {
    const ws = path.join(home, 'ws');
    mkdirSync(ws);
    const server = await startEditorServer({ root: ws, port: 0, devVite: false, staticDir: path.join(home, 'no-ui'), recentFile: null });
    try {
      const entry = JSON.parse(readFileSync(path.join(registryDir(), `${process.pid}-${server.port}.json`), 'utf8')) as EditorEntry;
      expect(entry).toMatchObject({ pid: process.pid, url: server.url, file: '', root: ws });
      expect(findEditor({ file: path.join(ws, 'later.r2d.json') })?.url).toBe(server.url);
      expect(findEditor({ root: ws })?.url).toBe(server.url);
    } finally {
      await server.close();
    }
    expect(findEditor({ root: ws })).toBeNull();
  });
});
