/**
 * `rev2d editor state` with an avatar project open in the editor: before its first build it names
 * the project (no model, exit 0); with a model it shows the avatar part the editor published
 * (EditorState.avatar.part, POST /api/state) and `--json` adds the project as `editor.avatar`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { draftAvatarSpec } from '../src/avatar/index.js';
import { blankModel } from '../src/api/templates.js';
import { main } from '../src/cli/main.js';
import { formatModelJson } from '../src/core/format.js';
import type { EditorServer } from '../src/server/index.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'rev2d-editor-state-avatar-'));
const project = path.join(root, 'hana');
let server: EditorServer;

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const buf = { stdout: '', stderr: '' };
  const code = await main(args, {
    stdout: { write: (s: string) => ((buf.stdout += s), true) },
    stderr: { write: (s: string) => ((buf.stderr += s), true) },
    cwd: root,
    openUrl: () => {
      throw new Error('tests must not open a browser');
    },
  });
  return { code, ...buf };
}

beforeAll(async () => {
  mkdirSync(project);
  writeFileSync(path.join(project, 'avatar.json'), formatModelJson(draftAvatarSpec('hana', 64, 80)));
  const { startEditorServer } = await import('../src/server/index.js');
  server = await startEditorServer({ root, file: path.join(project, 'avatar.json'), port: 0, register: false, devVite: false, recentFile: null, log: () => {} });
}, 120000);

afterAll(async () => {
  await server?.close();
  rmSync(root, { recursive: true, force: true });
});

describe('rev2d editor state in avatar mode', () => {
  it('names an avatar project that has no built model yet', async () => {
    const r = await run(['editor', 'state', '--url', server.url]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(`editor ${server.url}  avatar project hana (no built model yet)`);
    expect(r.stderr).toContain('rev2d avatar build hana');
    const json = JSON.parse((await run(['editor', 'state', '--url', server.url, '--json'])).stdout);
    expect(json).toEqual({ editor: { url: server.url, file: null, root, pid: expect.any(Number), avatar: { project, projectPath: 'hana', specFile: path.join(project, 'avatar.json') } }, state: null });
  });

  it('shows the avatar part the editor selected', async () => {
    // A model of the project ("built"): opening the project opens it.
    const model = path.join(project, 'hana.r2d.json');
    writeFileSync(model, formatModelJson(blankModel({ name: 'hana', width: 64, height: 80 })));
    const opened = await run(['editor', 'command', '--url', server.url, '--open', 'hana/avatar.json']);
    expect(opened.code, opened.stderr).toBe(0);
    const state = { file: model, params: {}, time: 0, animations: [], playing: false, selection: [], overlay: [], viewBox: null, avatar: { part: 'eyes.imageLeft.opening' }, updatedAt: new Date(0).toISOString() };
    const posted = await fetch(`${server.url}/api/state`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(state) });
    expect(posted.status).toBe(204);
    const r = await run(['editor', 'state', '--url', server.url]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('avatar part: eyes.imageLeft.opening  (project hana)');
    const json = JSON.parse((await run(['editor', 'state', '--url', server.url, '--json'])).stdout);
    expect(json.editor.avatar.projectPath).toBe('hana');
    expect(json.state.avatar).toEqual({ part: 'eyes.imageLeft.opening' });
  });
});
