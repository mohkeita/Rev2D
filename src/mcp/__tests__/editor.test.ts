/**
 * The editor bridge against the real editor server (src/server): discovery through the registry,
 * view state, commands (checked against the model the editor has open) and screenshots.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from '../server.js';
import { blankModel } from '../../api/templates.js';
import { formatModelJson } from '../../core/format.js';
import { registerEditor, type EditorState } from '../../node/editor-registry.js';
import { startEditorServer, type EditorServer } from '../../server/index.js';
import { decodePNG } from '../../render/index.js';

let home: string;
let dir: string;
let file: string;
let client: Client;
let closeMcp: () => Promise<void>;
let editor: EditorServer | null = null;

beforeAll(async () => {
  // Isolated registry (~/.rev2d/editors) so running editors of the developer do not interfere.
  home = mkdtempSync(path.join(os.tmpdir(), 'rev2d-mcp-home-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  dir = mkdtempSync(path.join(os.tmpdir(), 'rev2d-mcp-editor-'));
  file = path.join(dir, 'blank.r2d.json');
  writeFileSync(file, formatModelJson(blankModel({ name: 'blank', width: 200, height: 200 })));
  const server = createMcpServer({ cwd: dir });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  client = new Client({ name: 'rev2d-test', version: '0.0.0' });
  await client.connect(ct);
  closeMcp = async () => {
    await client.close();
    await server.close();
  };
});

afterAll(async () => {
  await editor?.close();
  await closeMcp();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

const firstText = (r: CallToolResult) => (r.content.find((c) => c.type === 'text') as { text: string }).text;

function imageOf(r: CallToolResult) {
  const img = r.content.find((c) => c.type === 'image') as { data: string; mimeType: string };
  expect(img.mimeType).toBe('image/png');
  return decodePNG(Buffer.from(img.data, 'base64'));
}

/** An SSE subscriber standing in for an open editor tab. */
async function editorTab(url: string) {
  const abort = new AbortController();
  const res = await fetch(`${url}/api/events`, { signal: abort.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: Array<{ event: string; data: unknown }> = [];
  let buf = '';
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const event = /^event: (.*)$/m.exec(chunk)?.[1];
          const data = /^data: (.*)$/m.exec(chunk)?.[1];
          if (event && data) events.push({ event, data: JSON.parse(data) });
        }
      }
    } catch {
      // aborted
    }
  })();
  await expect.poll(() => events.some((e) => e.event === 'hello')).toBe(true);
  return { events, close: () => abort.abort() };
}

async function publishState(url: string, state: Partial<EditorState>): Promise<void> {
  const res = await fetch(`${url}/api/state`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(state) });
  expect(res.status).toBe(204);
}

describe('mcp server: editor bridge', () => {
  it('explains how to start an editor when none is running or reachable', async () => {
    const none = await call('rev2d_editor_state', { model: 'blank.r2d.json' });
    expect(none.isError).toBe(true);
    expect(firstText(none)).toMatch(/no running Rev2D editor found[\s\S]*rev2d edit blank\.r2d\.json/);

    const dead = await call('rev2d_editor_state', { url: 'http://127.0.0.1:1' });
    expect(dead.isError).toBe(true);
    expect(firstText(dead)).toMatch(/cannot reach the Rev2D editor at http:\/\/127\.0\.0\.1:1/);
  });

  it('finds the editor of a model under the working directory and reports an unopened UI', async () => {
    editor = await startEditorServer({ file, port: 0, devVite: false, staticDir: path.join(dir, 'no-ui') });
    // A newer editor of another project (a live pid, an unreachable url) must not be picked by default.
    registerEditor({ pid: process.ppid, url: 'http://127.0.0.1:1', file: path.join(home, 'elsewhere', 'x.r2d.json'), startedAt: '2999-01-01T00:00:00.000Z' });

    const state = await call('rev2d_editor_state');
    expect(state.isError).toBe(true);
    expect(firstText(state)).toContain(`the editor at ${editor.url} has not published a view state yet`);
    expect(firstText(state)).toContain(`open ${editor.url}`);

    const shot = await call('rev2d_editor_screenshot', { model: 'blank.r2d.json' });
    expect(shot.isError).toBeFalsy();
    // The 200 px canvas (no view state yet) is enlarged to 512 px like rev2d_render.
    expect([imageOf(shot).width, imageOf(shot).height]).toEqual([512, 512]);
    expect(firstText(shot)).toMatch(/512x512 px screenshot of viewBox \[0, 0, 200, 200\] \(model px\) at scale 2\.56\nrendered the default pose/);

    const cmd = await call('rev2d_editor_command', { command: { type: 'pause' } });
    expect(cmd.isError).toBeFalsy();
    expect(firstText(cmd)).toMatch(/no editor tab is connected[\s\S]*hint:/);
  });

  it('reads the view state and forwards checked commands to the open tabs', async () => {
    const url = editor!.url;
    const tab = await editorTab(url);
    try {
      await publishState(url, {
        params: { Lean: 0.5, Squash: 0 },
        time: 1.25,
        animations: [{ id: 'idle' }],
        playing: true,
        selection: ['part:body'],
        overlay: ['bones'],
        viewBox: [0, 0, 100, 50],
      });
      const state = await call('rev2d_editor_state', { url: url.replace('http://', '') });
      expect(state.isError).toBeFalsy();
      const t = firstText(state);
      expect(t).toMatch(/time: 1\.25 s \(playing\), animations: \["idle"\]/);
      expect(t).toMatch(/params: Lean=0\.5\n/); // only parameters away from their default
      expect(t).toMatch(/selection: part:body; overlay: bones/);
      expect(t).toMatch(/view: \[0, 0, 100, 50\] \(model px\)/);

      const ok = await call('rev2d_editor_command', { model: 'blank.r2d.json', command: { type: 'setParams', params: { Lean: 1 } } });
      expect(firstText(ok)).toMatch(/sent setParams to 1 editor tab/);
      await expect.poll(() => tab.events.filter((e) => e.event === 'command').at(-1)?.data).toEqual({ type: 'setParams', params: { Lean: 1 } });

      // select accepts what the editor resolves: kind:id refs (bindings by index) and bare ids of any kind.
      const select = await call('rev2d_editor_command', { url, command: { type: 'select', ids: ['param:Lean', 'part:body', 'binding:0', 'eye', 'idle'] } });
      expect(select.isError).toBeFalsy();
      await expect.poll(() => tab.events.filter((e) => e.event === 'command').length).toBe(2);

      const before = tab.events.length;
      const typo = await call('rev2d_editor_command', { url, command: { type: 'select', ids: ['part:bdy', 'prat:body', 'binding:9'] } });
      expect(typo.isError).toBe(true);
      expect(firstText(typo)).toMatch(/"part:bdy" \(did you mean "part:body"\?\)/);
      expect(firstText(typo)).toMatch(/"prat:body" \(unknown kind "prat"/);
      expect(firstText(typo)).toMatch(/"binding:9" \(binding ids: 0, 1, 2\)/);

      // Checked against the model the editor has open, also when only the url is given.
      const anim = await call('rev2d_editor_command', { url, command: { type: 'play', animation: 'idel' } });
      expect(firstText(anim)).toMatch(/unknown animation id: "idel"[\s\S]*did you mean "idle"/);
      const param = await call('rev2d_editor_command', { url, command: { type: 'setParams', params: { Laen: 1 } } });
      expect(firstText(param)).toMatch(/unknown parameter id: "Laen"[\s\S]*did you mean "Lean"/);
      expect(tab.events.length).toBe(before);

      expect((await call('rev2d_editor_command', { url, command: { type: 'explode' } })).isError).toBe(true);

      // Layer options reach the editor as given; ones it could not apply are refused with a hint.
      const layered = { type: 'setAnimations', animations: [{ id: 'idle', start: 0.5 }, { id: 'idle', weight: 0.5, mode: 'add' }] };
      const sent = await call('rev2d_editor_command', { url, command: layered });
      expect(sent.isError, firstText(sent)).toBeFalsy();
      await expect.poll(() => tab.events.filter((e) => e.event === 'command').at(-1)?.data).toEqual(layered);
      const once = await call('rev2d_editor_command', { url, command: { type: 'setAnimations', animations: [{ id: 'idle', hold: false }] } });
      expect(once.isError).toBe(true);
      expect(firstText(once)).toMatch(/"once" has no effect on looping animation "idle" without a start > 0[\s\S]*\nhint: /);
      // With a start, "once" is meaningful on a loop (silent before it) and reaches the editor.
      const later = { type: 'setAnimations', animations: [{ id: 'idle', hold: false, start: 1 }] };
      const laterSent = await call('rev2d_editor_command', { url, command: later });
      expect(laterSent.isError, firstText(laterSent)).toBeFalsy();
    } finally {
      tab.close();
    }
  });

  it('reports the editor\'s layers as layer strings an agent can pass back', async () => {
    const url = editor!.url;
    await publishState(url, { animations: [{ id: 'idle' }, { id: 'idle', weight: 0.5, mode: 'add', start: 1.5, hold: false }], pinned: ['Lean'] });
    const state = await call('rev2d_editor_state', { url });
    expect(firstText(state)).toMatch(/animations: \["idle","idle@0\.5,add,once,start=1\.5"\]/);
    expect(firstText(state)).toMatch(/\nexplicit \(pinned\) params, beating animation and physics: Lean\n/);
  });

  it('takes screenshots of the view, sized like rev2d_render', async () => {
    const url = editor!.url;
    await publishState(url, { params: { Lean: 1, Gone: 3 }, overlay: ['bones'], viewBox: [0, 0, 100, 50] });

    // The published view [0, 0, 100, 50] is enlarged (max 4x) toward 512 px.
    const view = await call('rev2d_editor_screenshot', {});
    expect([imageOf(view).width, imageOf(view).height]).toEqual([400, 200]);
    expect(firstText(view)).toMatch(/400x200 px screenshot of viewBox \[0, 0, 100, 50\] \(model px\) at scale 4/);
    expect(firstText(view)).toMatch(/ignored \(no longer in the model\): param:Gone/);
    expect(firstText(view)).toMatch(/params: Lean=1\n/);

    const exact = await call('rev2d_editor_screenshot', { scale: 1, viewBox: [10, 20, 30, 40], overlay: [] });
    expect([imageOf(exact).width, imageOf(exact).height]).toEqual([30, 40]);

    // "fit" is sized after the server resolved the region.
    const fit = await call('rev2d_editor_screenshot', { viewBox: 'fit' });
    const img = imageOf(fit);
    expect(Math.max(img.width, img.height)).toBeGreaterThanOrEqual(512);
    expect(Math.max(img.width, img.height)).toBeLessThanOrEqual(1024);
  });

  it('sizes screenshots of a far zoomed-out view from the effective scale (never an out-of-range one)', async () => {
    const url = editor!.url;
    await publishState(url, { viewBox: [-1_000_000, -1_000_000, 2_200_000, 2_200_000], hidden: ['eye'], physics: false });
    const shot = await call('rev2d_editor_screenshot', {});
    expect(shot.isError).toBeFalsy();
    expect([imageOf(shot).width, imageOf(shot).height]).toEqual([1024, 1024]);
    expect(firstText(shot)).toMatch(/1024x1024 px screenshot of viewBox \[-1000000, -1000000, 2200000, 2200000\] \(model px\) at scale 0\.0004654\n/);
    expect(firstText(shot)).toMatch(/hidden in the editor \(not drawn\): eye/);
    expect(firstText(shot)).toMatch(/\(paused\), animations: none; physics off/);

    // An explicit scale is used as given, and reported as such.
    const big = await call('rev2d_editor_screenshot', { viewBox: [-2000, -1000, 4000, 3000], scale: 0.5 });
    expect([imageOf(big).width, imageOf(big).height]).toEqual([2000, 1500]);
    expect(firstText(big)).toMatch(/at scale 0\.5\n/);
  });

  it('renders the region its size was chosen for, even when the view changes meanwhile', async () => {
    const url = editor!.url;
    await publishState(url, { viewBox: [0, 0, 100, 50] });
    // The human zooms far out between the tool reading the view state and the screenshot request.
    const realFetch = globalThis.fetch;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input).includes('/api/screenshot') && spy.mock.calls.filter(([u]) => String(u).includes('/api/screenshot')).length === 1) {
        await realFetch(`${url}/api/state`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ viewBox: [-5000, -5000, 10200, 10200] }) });
      }
      return realFetch(input, init);
    });
    try {
      const shot = await call('rev2d_editor_screenshot', {});
      expect(shot.isError, firstText(shot)).toBeFalsy();
      expect([imageOf(shot).width, imageOf(shot).height]).toEqual([400, 200]);
      expect(firstText(shot)).toMatch(/400x200 px screenshot of viewBox \[0, 0, 100, 50\] \(model px\) at scale 4\n/);
    } finally {
      spy.mockRestore();
    }
  });

  it('passes on the editor server\'s errors with their hints and diagnostics', async () => {
    const doc = blankModel({ name: 'blank', width: 200, height: 200 }) as { parts: Array<Record<string, unknown>> };
    doc.parts[0].parent = 'bodyWrap';
    writeFileSync(file, formatModelJson(doc));
    const r = await call('rev2d_editor_screenshot', {});
    expect(r.isError).toBe(true);
    expect(firstText(r)).toMatch(/HTTP 422: the model has errors and cannot be rendered\nhint: fix the listed errors/);
    expect(firstText(r)).toMatch(/\/parts\/0\/parent/);
    writeFileSync(file, formatModelJson(blankModel({ name: 'blank', width: 200, height: 200 })));
  });

  it('opens another model of the workspace, reports the open file and root, and the start screen', async () => {
    const url = editor!.url;
    mkdirSync(path.join(dir, 'models'), { recursive: true });
    const other = path.join(dir, 'models', 'other.r2d.json');
    writeFileSync(other, formatModelJson(blankModel({ name: 'other', width: 100, height: 100 })));
    const tab = await editorTab(url);
    try {
      const opened = await call('rev2d_editor_command', { command: { type: 'open', file: 'models/other.r2d.json' } });
      expect(opened.isError, firstText(opened)).toBeFalsy();
      expect(firstText(opened)).toBe(`opened models/other.r2d.json in the editor at ${url}; 1 editor tab follows`);
      await expect.poll(() => tab.events.find((e) => e.event === 'file-changed')?.data).toEqual({ file: other, origin: 'ai' });
      expect(tab.events.some((e) => e.event === 'command')).toBe(false);

      // The registry follows, so the editor is found by the file it has open now.
      await publishState(url, { params: { Lean: 0.25 } });
      const state = await call('rev2d_editor_state', { model: 'models/other.r2d.json' });
      expect(state.isError, firstText(state)).toBeFalsy();
      expect(firstText(state)).toMatch(/\nmodel: models\/other\.r2d\.json\nworkspace root: \.\n/);
      // Commands are checked against the newly opened model.
      expect(firstText(await call('rev2d_editor_command', { url, command: { type: 'setParams', params: { Laen: 1 } } }))).toMatch(/did you mean "Lean"/);

      const outside = await call('rev2d_editor_command', { url, command: { type: 'open', file: path.join(home, 'x.r2d.json') } });
      expect(outside.isError).toBe(true);
      expect(firstText(outside)).toMatch(/HTTP 403: file ".*x\.r2d\.json" is outside the workspace root[\s\S]*hint: .*--root/);
      const missing = await call('rev2d_editor_command', { url, command: { type: 'open', file: 'nope.r2d.json' } });
      expect(firstText(missing)).toMatch(/HTTP 404: file not found: nope\.r2d\.json/);

      // No model open: the state tool describes the start screen instead of failing.
      expect((await fetch(`${url}/api/close`, { method: 'POST' })).status).toBe(200);
      const empty = await call('rev2d_editor_state', { url });
      expect(empty.isError, firstText(empty)).toBeFalsy();
      expect(firstText(empty)).toMatch(/no model is open \(the editor shows its start screen\)\nworkspace root: \.\nrecent: models\/other\.r2d\.json, blank\.r2d\.json\nhint: open one with rev2d_editor_command/);
      const shot = await call('rev2d_editor_screenshot', { url });
      expect(shot.isError).toBe(true);
      expect(firstText(shot)).toMatch(/HTTP 409: no model is open\nhint: open one first/);
      const back = await call('rev2d_editor_command', { url, command: { type: 'open', file: 'blank.r2d.json' } });
      expect(back.isError, firstText(back)).toBeFalsy();
    } finally {
      tab.close();
    }
  });

  it('finds an editor on its start screen by its workspace root (a file inside it, or the directory)', async () => {
    // A second editor whose workspace is ws/ (nested in the first editor's root), with no model open.
    const ws = path.join(dir, 'ws');
    mkdirSync(ws, { recursive: true });
    for (const name of ['a', 'b']) writeFileSync(path.join(ws, `${name}.r2d.json`), formatModelJson(blankModel({ name, width: 100, height: 100 })));
    const inner = await startEditorServer({ root: ws, port: 0, devVite: false, staticDir: path.join(dir, 'no-ui') });
    try {
      // A file no editor has open: the editor whose (innermost) root contains it, with a note.
      const state = await call('rev2d_editor_state', { model: 'ws/a.r2d.json' });
      expect(state.isError, firstText(state)).toBeFalsy();
      expect(firstText(state)).toMatch(new RegExp(`^editor ${inner.url}: no model is open \\(the editor shows its start screen\\)\\nworkspace root: ws\\n`));
      expect(firstText(state)).toContain('note: ws/a.r2d.json is not open in this editor (it was chosen because its workspace root ws contains the file); open it with rev2d_editor_command');
      expect(firstText(await call('rev2d_editor_state', { model: 'ws' }))).toContain(`editor ${inner.url}: no model is open`);
      // The file the outer editor has open still selects the outer editor.
      const outer = firstText(await call('rev2d_editor_state', { model: 'blank.r2d.json' }));
      expect(outer).toContain(editor!.url);
      expect(outer).not.toContain(inner.url);

      // Commands other than open, and screenshots, would act on another model: refused with the fix.
      const pause = await call('rev2d_editor_command', { model: 'ws/a.r2d.json', command: { type: 'pause' } });
      expect(pause.isError).toBe(true);
      expect(firstText(pause)).toMatch(new RegExp(`the editor at ${inner.url} has no model open, not ws/a\\.r2d\\.json, so it cannot apply pause to it\\nhint: open it first: rev2d_editor_command \\{command: \\{type: "open", file: "ws/a\\.r2d\\.json"\\}\\}`));
      const shot = await call('rev2d_editor_screenshot', { model: 'ws/a.r2d.json' });
      expect(shot.isError).toBe(true);
      expect(firstText(shot)).toContain('so it cannot take a screenshot of it');

      // "open" without model/url goes to the editor whose workspace holds the file (the innermost root).
      const opened = await call('rev2d_editor_command', { command: { type: 'open', file: 'ws/a.r2d.json' } });
      expect(opened.isError, firstText(opened)).toBeFalsy();
      expect(firstText(opened)).toContain(`opened ws/a.r2d.json in the editor at ${inner.url}`);
      expect(inner.file).toBe(path.join(ws, 'a.r2d.json'));
      expect(editor!.file).toBe(file);
      const other = await call('rev2d_editor_command', { model: 'ws/b.r2d.json', command: { type: 'open', file: 'ws/b.r2d.json' } });
      expect(firstText(other)).toContain(`in the editor at ${inner.url}`);

      // Outside every workspace: the error lists the running editors with their roots.
      const outside = await call('rev2d_editor_state', { model: path.join(home, 'x.r2d.json') });
      expect(outside.isError).toBe(true);
      expect(firstText(outside)).toContain('open or contains it in its workspace root');
      expect(firstText(outside)).toContain(`${inner.url} (ws/b.r2d.json open, workspace root ws)`);
    } finally {
      await inner.close();
    }
  });
});
