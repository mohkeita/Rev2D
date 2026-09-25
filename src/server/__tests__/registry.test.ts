/** ~/.rev2d/editors: one entry file per running editor server, keyed by pid and port. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findEditor, listEditors, registerEditor, registryDir, type EditorEntry } from '../../node/editor-registry.js';
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
});
