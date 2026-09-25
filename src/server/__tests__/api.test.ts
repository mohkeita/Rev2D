import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { renderFrame, renderPose } from '../../api/index.js';
import type { AnimationLayer } from '../../core/types.js';
import { formatModelJson } from '../../core/format.js';
import { loadModelFile } from '../../node/load.js';
import { decodePNG } from '../../render/index.js';
import { startEditorServer } from '../index.js';
import { TEX_H, TEX_W, rawRequest, startFixture, testModel, type Fixture } from './helpers.js';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

let fx: Fixture;

beforeEach(async () => {
  fx = await startFixture();
});

afterEach(async () => {
  await fx.close();
});

const get = (p: string, init?: RequestInit) => fetch(fx.base + p, init);
const putModel = (body: unknown, query = '') =>
  fetch(`${fx.base}/api/model${query}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const postJson = (p: string, body: unknown) =>
  fetch(fx.base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function png(res: Response) {
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('image/png');
  const bytes = new Uint8Array(await res.arrayBuffer());
  expect(Array.from(bytes.subarray(0, 8))).toEqual(PNG_SIGNATURE);
  return decodePNG(bytes);
}

/** testModel plus a pendulum driven by Lean whose Swing output rotates the root bone. */
function physicsModel() {
  const doc = testModel();
  doc.parameters.push({ id: 'Swing', min: -30, max: 30, default: 0 });
  doc.physics = [{ id: 'swing', inputs: [{ param: 'Lean', type: 'x', weight: 40 }], outputs: [{ param: 'Swing', type: 'angle' }] }];
  doc.bindings.push({ target: 'bone:root.rotation', params: ['Swing'], keys: [{ at: [-30], value: -30 }, { at: [30], value: 30 }] });
  return doc;
}

function invalidModel() {
  const doc = testModel();
  doc.parts[0].parent = 'noSuchWarp';
  return doc;
}

describe('GET/PUT /api/model', () => {
  it('returns the absolute file path, raw text and mtime', async () => {
    const res = await get('/api/model');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.file).toBe(path.resolve(fx.file));
    expect(body.text).toBe(readFileSync(fx.file, 'utf8'));
    expect(body.mtimeMs).toBeGreaterThan(0);
  });

  it('writes a valid doc with the model formatter', async () => {
    const doc = testModel();
    doc.meta.name = 'renamed';
    const res = await putModel({ doc });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, written: true });
    expect(Array.isArray(body.diagnostics)).toBe(true);
    expect(readFileSync(fx.file, 'utf8')).toBe(formatModelJson(doc));
    expect((await (await get('/api/model')).json()).mtimeMs).toBe(body.mtimeMs);
  });

  it('writes JSONC text verbatim (comments and trailing commas kept)', async () => {
    const text = formatModelJson(testModel()).replace('{', '{\n  // hand-written comment').replace(/\n}\n$/, ',\n}\n');
    const body = await (await putModel({ text })).json();
    expect(body).toMatchObject({ ok: true, written: true });
    expect(readFileSync(fx.file, 'utf8')).toBe(text);
    expect((await (await get('/api/model')).json()).text).toBe(text);
  });

  it('refuses an invalid model unless forced', async () => {
    const before = readFileSync(fx.file, 'utf8');
    const refused = await (await putModel({ doc: invalidModel() })).json();
    expect(refused).toMatchObject({ ok: false, written: false });
    expect(refused.diagnostics.some((d: any) => d.severity === 'error' && d.path.startsWith('/parts/0'))).toBe(true);
    expect(refused.hint).toContain('force=1');
    expect(readFileSync(fx.file, 'utf8')).toBe(before);

    const forced = await (await putModel({ doc: invalidModel() }, '?force=1')).json();
    expect(forced).toMatchObject({ ok: false, written: true });
    expect(readFileSync(fx.file, 'utf8')).toBe(formatModelJson(invalidModel()));
  });

  it('keeps CRLF line endings when writing a doc over a CRLF file', async () => {
    writeFileSync(fx.file, formatModelJson(testModel()).replace(/\n/g, '\r\n'));
    const doc = testModel();
    doc.meta.name = 'crlf';
    expect(await (await putModel({ doc })).json()).toMatchObject({ ok: true, written: true });
    expect(readFileSync(fx.file, 'utf8')).toBe(formatModelJson(doc).replace(/\n/g, '\r\n'));

    // LF files stay LF, and raw text is always written verbatim.
    const lf = formatModelJson(doc);
    await putModel({ text: lf });
    expect(readFileSync(fx.file, 'utf8')).toBe(lf);
    await putModel({ doc });
    expect(readFileSync(fx.file, 'utf8')).toBe(lf);
  });

  it('reports JSON syntax errors in text as diagnostics', async () => {
    const body = await (await putModel({ text: '{ "format": "rev2d", ' })).json();
    expect(body.written).toBe(false);
    expect(body.diagnostics[0].code).toBe('json-syntax');
  });

  it('rejects malformed request bodies with 400 and a hint', async () => {
    for (const body of ['not json', JSON.stringify({}), JSON.stringify({ text: 'x', doc: {} }), JSON.stringify({ text: 42 }), JSON.stringify({ doc: [] })]) {
      const res = await fetch(`${fx.base}/api/model`, { method: 'PUT', body });
      expect(res.status, body).toBe(400);
      const err = await res.json();
      expect(typeof err.error).toBe('string');
    }
  });

  it('caps the request body size', async () => {
    await fx.close();
    fx = await startFixture({ maxBodyBytes: 1024 });
    const res = await putModel({ text: 'x'.repeat(4096) });
    expect(res.status).toBe(413);
    expect((await res.json()).error).toContain('1024');
  });

  it('refuses a write based on an older version when the file changed on disk since (409)', async () => {
    const { mtimeMs: base } = await (await get('/api/model')).json();
    const theirs = formatModelJson({ ...testModel(), meta: { ...testModel().meta, name: 'theirs' } });
    writeFileSync(fx.file, theirs);
    utimesSync(fx.file, new Date(), new Date(Math.floor(base) + 5000));
    const disk = statSync(fx.file).mtimeMs;

    const doc = testModel();
    doc.meta.name = 'mine';
    const res = await putModel({ doc, baseMtimeMs: base });
    expect(res.status).toBe(409);
    const err = await res.json();
    expect(err.error).toMatch(/changed on disk/);
    expect(err.hint).toMatch(/baseMtimeMs/);
    expect(err.mtimeMs).toBe(disk);
    expect(readFileSync(fx.file, 'utf8')).toBe(theirs);

    // Overwriting on purpose: base the write on the version the 409 named.
    const forced = await putModel({ doc, baseMtimeMs: err.mtimeMs });
    expect(forced.status).toBe(200);
    expect(await forced.json()).toMatchObject({ written: true });
    expect(readFileSync(fx.file, 'utf8')).toBe(formatModelJson(doc));
  });

  it('accepts a stale base when nothing would be lost: same content touched, or already the new text', async () => {
    const { mtimeMs: base, text } = await (await get('/api/model')).json();
    // Only the mtime changed (e.g. `touch`, or a tool rewrote identical bytes).
    utimesSync(fx.file, new Date(), new Date(Math.floor(base) + 5000));
    const doc = testModel();
    doc.meta.name = 'mine';
    const first = await putModel({ doc, baseMtimeMs: base });
    expect(first.status).toBe(200);
    const { mtimeMs: written } = await first.json();

    // Someone else already wrote exactly what this client writes.
    writeFileSync(fx.file, text);
    utimesSync(fx.file, new Date(), new Date(Math.floor(written) + 9000));
    const same = await putModel({ text, baseMtimeMs: written });
    expect(same.status).toBe(200);
    expect(await same.json()).toMatchObject({ written: true });

    // Without baseMtimeMs the write is unconditional (older clients, scripts).
    writeFileSync(fx.file, formatModelJson(testModel()).replace('server-test', 'external'));
    expect((await (await putModel({ doc })).json()).written).toBe(true);
  });

  it('validates baseMtimeMs', async () => {
    const res = await putModel({ doc: testModel(), baseMtimeMs: 'yesterday' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('baseMtimeMs');
  });

  it('returns 404 when the model file is gone', async () => {
    rmSync(fx.file);
    const res = await get('/api/model');
    expect(res.status).toBe(404);
    const err = await res.json();
    expect(err.error).toContain('not found');
    expect(err.hint).toBeTruthy();
  });
});

describe('GET /api/texture/:id', () => {
  it('serves file textures relative to the model', async () => {
    const img = await png(await get('/api/texture/tex'));
    expect([img.width, img.height]).toEqual([TEX_W, TEX_H]);
    expect(Array.from(img.data.subarray(0, 4))).toEqual([255, 0, 0, 255]);
  });

  it('serves data: URI textures', async () => {
    const img = await png(await get('/api/texture/inline'));
    expect([img.width, img.height]).toEqual([2, 2]);
  });

  it('404s unknown ids with the available ones', async () => {
    const res = await get('/api/texture/nope');
    expect(res.status).toBe(404);
    const err = await res.json();
    expect(err.error).toContain('nope');
    expect(err.hint).toContain('tex, inline');
  });

  it('refuses files that are not PNGs', async () => {
    writeFileSync(path.join(fx.dir, 'tex.png'), 'not a png');
    const res = await get('/api/texture/tex');
    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain('not a PNG');
  });
});

describe('editor state and commands', () => {
  it('404s before the UI publishes state, then round-trips it', async () => {
    const missing = await get('/api/state');
    expect(missing.status).toBe(404);
    expect((await missing.json()).hint).toBeTruthy();

    const state = {
      params: { Lean: 0.5 },
      time: 1.25,
      animations: [{ id: 'idle', weight: 0.5 }, { id: 'idle', mode: 'add', start: 0.5, hold: false }],
      playing: true,
      selection: ['body'],
      overlay: ['bones'],
      viewBox: [0, 0, 32, 32],
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const posted = await postJson('/api/state', { ...state, file: 'ignored.r2d.json' });
    expect(posted.status).toBe(204);
    const got = await (await get('/api/state')).json();
    expect(got).toEqual({ ...state, file: path.resolve(fx.file) });
  });

  it('fills defaults for omitted state fields and validates types', async () => {
    expect((await postJson('/api/state', { time: 2 })).status).toBe(204);
    const got = await (await get('/api/state')).json();
    expect(got).toMatchObject({ time: 2, params: {}, animations: [], playing: false, selection: [], overlay: [], viewBox: null });
    expect(typeof got.updatedAt).toBe('string');

    const bad = await postJson('/api/state', { time: 'soon' });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toContain('time');

    const emptyView = await postJson('/api/state', { viewBox: [0, 0, 0, 10] });
    expect(emptyView.status).toBe(400);
    expect((await emptyView.json()).error).toContain('viewBox.2');

    const badMode = await postJson('/api/state', { animations: [{ id: 'idle', mode: 'blend' }] });
    expect(badMode.status).toBe(400);
    const err = await badMode.json();
    expect(err.error).toContain('animations.0.mode');
    expect(err.hint).toContain('mode?: "override"|"add"');
  });

  it('validates commands and reports delivery count', async () => {
    const ok = await postJson('/api/command', { type: 'setParams', params: { Lean: 1 } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ delivered: 0 });

    const unknown = await postJson('/api/command', { type: 'explode' });
    expect(unknown.status).toBe(400);
    const err = await unknown.json();
    expect(err.error).toBe('unknown command type "explode"');
    expect(err.hint).toContain('setParams');

    const badField = await postJson('/api/command', { type: 'seek', time: 'later' });
    expect(badField.status).toBe(400);
    expect((await badField.json()).hint).toContain('"seek"');

    const extraKey = await postJson('/api/command', { type: 'pause', now: true });
    expect(extraKey.status).toBe(400);

    const layered = { type: 'setAnimations', animations: [{ id: 'idle' }, { id: 'wink', weight: 0.5, mode: 'add', start: 1, hold: false }] };
    const sent = await postJson('/api/command', layered);
    expect(sent.status).toBe(200);
    const badHold = await postJson('/api/command', { type: 'setAnimations', animations: [{ id: 'idle', hold: 'no' }] });
    expect(badHold.status).toBe(400);
    expect((await badHold.json()).hint).toContain('"hold"?:<boolean>');
  });
});

describe('GET /api/screenshot', () => {
  it('renders the default pose of the canvas when no state was published', async () => {
    const res = await get('/api/screenshot');
    expect(res.headers.get('x-rev2d-source')).toBe('default-pose');
    expect(res.headers.get('x-rev2d-viewbox')).toBe('0,0,64,64');
    const img = await png(res);
    expect([img.width, img.height]).toEqual([64, 64]);
  });

  it('honours scale, viewBox and overlay query parameters', async () => {
    expect((await png(await get('/api/screenshot?scale=2'))).width).toBe(128);
    const crop = await png(await get('/api/screenshot?viewBox=0,0,32,16&overlay=bones,grid'));
    expect([crop.width, crop.height]).toEqual([32, 16]);
    const fit = await get('/api/screenshot?viewBox=fit');
    expect(fit.headers.get('x-rev2d-viewbox')).toMatch(/^-?\d+,-?\d+,\d+,\d+$/);
    await png(fit);
  });

  it('renders what the editor shows: its params, time and viewBox', async () => {
    const shot = async (lean: number) => {
      await postJson('/api/state', { params: { Lean: lean, Gone: 3 }, animations: [{ id: 'missing' }], viewBox: [8, 8, 48, 48], time: 0 });
      const res = await get('/api/screenshot');
      expect(res.headers.get('x-rev2d-source')).toBe('editor-state');
      expect(res.headers.get('x-rev2d-ignored')).toBe('param:Gone,animation:missing');
      return png(res);
    };
    const left = await shot(-1);
    const right = await shot(1);
    expect([left.width, left.height]).toEqual([48, 48]);
    expect(Buffer.from(left.data).equals(Buffer.from(right.data))).toBe(false);
    // An explicit viewBox overrides the editor's.
    expect((await png(await get('/api/screenshot?viewBox=canvas'))).width).toBe(64);
  });

  it('shrinks the default scale when the editor view is zoomed far out', async () => {
    await postJson('/api/state', { viewBox: [-4000, -4000, 8064, 8064] });
    const res = await get('/api/screenshot');
    const scale = Number(res.headers.get('x-rev2d-scale'));
    expect(scale).toBeGreaterThan(0.2);
    expect(scale).toBeLessThan(1);
    const img = await png(res);
    expect(img.width * img.height).toBeLessThanOrEqual(2048 * 2048);
    expect(img.width).toBeGreaterThan(2000);
    expect(img.width).toBe(Math.round(8064 * scale));

    // An explicit scale is honoured or refused, never silently changed.
    const explicit = await get('/api/screenshot?scale=1');
    expect(explicit.status).toBe(400);
    expect((await explicit.json()).hint).toContain('omit scale');
  });

  it('renders the published params as the pose with physics off (they hold the physics results of the editor)', async () => {
    writeFileSync(fx.file, formatModelJson(physicsModel()));
    // Swing is the editor's own physics result (its pendulum history); the server must not re-simulate it.
    const state = { params: { Lean: 1, Squash: 0, Swing: 20 }, time: 0.5, viewBox: [0, 0, 64, 64] as [number, number, number, number] };
    await postJson('/api/state', { ...state, physics: true });
    const shot = await png(await get('/api/screenshot?overlay='));
    const m = await loadModelFile(fx.file);
    const expected = renderFrame(m, { ...state, scale: 1, physics: false }).image;
    expect(Buffer.from(shot.data).equals(Buffer.from(expected.data))).toBe(true);
    const rest = renderFrame(m, { ...state, params: { ...state.params, Swing: 0 }, scale: 1, physics: false }).image;
    expect(Buffer.from(shot.data).equals(Buffer.from(rest.data))).toBe(false);
    expect((await (await get('/api/state')).json()).physics).toBe(true);
  });

  it('leaves out parts hidden in the editor (render, overlay and "fit")', async () => {
    const noEye = testModel();
    noEye.parts = noEye.parts.filter((p: { id: string }) => p.id !== 'eye');
    const other = path.join(fx.dir, 'no-eye.r2d.json');
    writeFileSync(other, formatModelJson(noEye));
    const view = { params: { Lean: 0.5 }, viewBox: [0, 0, 64, 64] };
    await postJson('/api/state', { ...view, hidden: ['eye', 'ghost'], overlay: ['bounds'] });
    const res = await get('/api/screenshot');
    expect(res.headers.get('x-rev2d-hidden')).toBe('eye');
    expect(res.headers.get('x-rev2d-ignored')).toBe('part:ghost');
    const shot = await png(res);
    const expected = renderFrame(await loadModelFile(other), { ...view, viewBox: [0, 0, 64, 64], overlay: ['bounds'], physics: false }).image;
    expect(Buffer.from(shot.data).equals(Buffer.from(expected.data))).toBe(true);

    // "fit" frames the parts the editor shows: only the 8x4 badge at (4, 4), plus 16 px padding.
    await postJson('/api/state', { hidden: ['body', 'eye'] });
    const fit = await get('/api/screenshot?viewBox=fit');
    expect(fit.headers.get('x-rev2d-viewbox')).toBe('-12,-12,40,36');
    expect(fit.headers.get('x-rev2d-hidden')).toBe('body,eye');
    await png(fit);
  });

  it('accepts overlay=all and overlay=none', async () => {
    await postJson('/api/state', { overlay: ['bones'] });
    const plain = await png(await get('/api/screenshot?overlay='));
    const none = await png(await get('/api/screenshot?overlay=none'));
    expect(Buffer.from(none.data).equals(Buffer.from(plain.data))).toBe(true);
    const all = await png(await get('/api/screenshot?overlay=all'));
    const listed = await png(await get('/api/screenshot?overlay=bones,mesh,warps,bounds,labels,grid'));
    expect(Buffer.from(all.data).equals(Buffer.from(listed.data))).toBe(true);
    expect(Buffer.from(all.data).equals(Buffer.from(plain.data))).toBe(false);
  });

  it('rejects bad query parameters with hints', async () => {
    for (const q of ['overlay=bones,sparkles', 'scale=0', 'scale=abc', 'viewBox=1,2,3', 'viewBox=0,0,0,10', 'scale=16&viewBox=0,0,1000,1000']) {
      const res = await get(`/api/screenshot?${q}`);
      expect(res.status, q).toBe(400);
      expect((await res.json()).hint, q).toBeTruthy();
    }
  });

  it("renders the editor's layers with their options (mode, start, hold) like the core does", async () => {
    const doc = testModel();
    // A one-shot that leans the body right, played as an additive overlay starting at t = 1.
    doc.animations.push({ id: 'nudge', duration: 0.5, loop: false, tracks: [{ target: 'param:Lean', keys: [{ t: 0, v: 0.6 }, { t: 0.5, v: 0.6 }] }] });
    writeFileSync(fx.file, formatModelJson(doc));
    const m = await loadModelFile(fx.file);
    const rig = m.rig!;
    const layers: AnimationLayer[] = [{ id: 'idle' }, { id: 'nudge', mode: 'add', start: 1, hold: false }];
    const expected = (time: number, ls: AnimationLayer[]) => renderPose(m, rig, rig.pose({ time, animations: ls, physics: false }), { viewBox: [0, 0, 64, 64], scale: 1 }).image;
    const shot = async (time: number, animations: unknown[]) => {
      await postJson('/api/state', { time, animations, viewBox: [0, 0, 64, 64] });
      return png(await get('/api/screenshot?overlay='));
    };
    for (const time of [0.25, 1.25, 2]) {
      const img = await shot(time, layers);
      expect(Buffer.from(img.data).equals(Buffer.from(expected(time, layers).data)), `t=${time}`).toBe(true);
    }
    // The options matter: during the one-shot, "add" from t = 1 is not "override" from t = 0.
    const plain = await shot(1.25, [{ id: 'idle' }, { id: 'nudge' }]);
    expect(Buffer.from(plain.data).equals(Buffer.from(expected(1.25, layers).data))).toBe(false);
  });

  it('answers 422 with the error and its hint when the published state cannot be posed', async () => {
    await postJson('/api/state', { time: -1 });
    const res = await get('/api/screenshot');
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/time must be a finite number of seconds >= 0/);
    expect(body.hint).toMatch(/physics is simulated from t = 0/);
  });

  it('answers 422 with diagnostics when the model has errors', async () => {
    await putModel({ doc: invalidModel() }, '?force=1');
    const res = await get('/api/screenshot');
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.diagnostics.length).toBeGreaterThan(0);
    expect(body.diagnostics.every((d: any) => d.severity === 'error')).toBe(true);
  });
});

describe('GET /api/info', () => {
  it('summarizes the model with its diagnostics', async () => {
    const body = await (await get('/api/info')).json();
    expect(body.info.name).toBe('server-test');
    expect(body.info.size).toEqual([64, 64]);
    expect(body.info.counts.parts).toBe(3);
    expect(body.diagnostics.some((d: any) => d.code === 'unused-texture')).toBe(true);
  });

  it('reflects edits and reports null info for invalid models', async () => {
    await putModel({ doc: invalidModel() }, '?force=1');
    const body = await (await get('/api/info')).json();
    expect(body.info).toBeNull();
    expect(body.diagnostics.some((d: any) => d.severity === 'error')).toBe(true);
  });
});

describe('request guards and routing', () => {
  it('rejects foreign Host headers (DNS rebinding)', async () => {
    const port = new URL(fx.base).port;
    const evil = await rawRequest(fx.base, { path: '/api/model', headers: { Host: `evil.example:${port}` } });
    expect(evil.status).toBe(403);
    const err = JSON.parse(evil.body.toString());
    expect(err.error).toContain('evil.example');
    expect(err.hint).toContain('DNS-rebinding');
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `LOCALHOST:${port}`]) {
      expect((await rawRequest(fx.base, { path: '/api/model', headers: { Host: host } })).status, host).toBe(200);
    }
  });

  it('rejects malformed Host headers that merely contain a local name', async () => {
    const port = new URL(fx.base).port;
    for (const host of [`evil.example@127.0.0.1:${port}`, `127.0.0.1:${port}/evil`, `127.0.0.1:${port}:${port}`, `127.0.0.1:x`]) {
      const res = await rawRequest(fx.base, { path: '/api/model', headers: { Host: host } });
      expect(res.status, host).toBe(403);
    }
  });

  it('answers on its own URL when bound to a specific address', async (t) => {
    let server;
    try {
      server = await startEditorServer({ file: fx.file, host: '127.0.0.2', port: 0, devVite: false, register: false, staticDir: path.join(fx.dir, 'no-ui') });
    } catch (e) {
      if (/EADDRNOTAVAIL/.test(String((e as Error).cause))) return t.skip(); // 127.0.0.2 is not a loopback alias on this OS
      throw e;
    }
    try {
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.2:\d+$/);
      expect((await fetch(`${server.url}/api/info`)).status).toBe(200);
      const same = await rawRequest(server.url, { method: 'POST', path: '/api/command', headers: { Origin: server.url }, body: JSON.stringify({ type: 'reload' }) });
      expect(same.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it('rejects cross-origin writes', async () => {
    const res = await rawRequest(fx.base, {
      method: 'POST',
      path: '/api/command',
      headers: { Origin: 'https://evil.example', 'Content-Type': 'text/plain' },
      body: JSON.stringify({ type: 'reload' }),
    });
    expect(res.status).toBe(403);
    const same = await rawRequest(fx.base, { method: 'POST', path: '/api/command', headers: { Origin: fx.base }, body: JSON.stringify({ type: 'reload' }) });
    expect(same.status).toBe(200);
  });

  it('rejects writes from other local sites (another localhost port) but not from its own pages', async () => {
    const post = (headers: Record<string, string>) =>
      rawRequest(fx.base, { method: 'POST', path: '/api/command', headers: { 'Content-Type': 'text/plain', ...headers }, body: JSON.stringify({ type: 'reload' }) });
    const otherPort = await post({ Origin: 'http://localhost:3000', 'Sec-Fetch-Site': 'same-site' });
    expect(otherPort.status).toBe(403);
    expect(JSON.parse(otherPort.body.toString()).error).toContain('same-site');
    // The Vite dev server (npm run editor:dev) proxies its own page's same-origin requests here.
    expect((await post({ Origin: 'http://localhost:5173', 'Sec-Fetch-Site': 'same-origin' })).status).toBe(200);
    expect((await post({ 'Sec-Fetch-Site': 'none' })).status).toBe(200);
  });

  it('404s unknown endpoints and 405s unsupported methods', async () => {
    const unknown = await get('/api/nope');
    expect(unknown.status).toBe(404);
    const err = await unknown.json();
    expect(err.error).toBe('unknown endpoint GET /api/nope');
    expect(err.hint).toContain('GET /api/screenshot');

    const wrong = await get('/api/model', { method: 'DELETE' });
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('allow')).toBe('GET, PUT');
  });
});
