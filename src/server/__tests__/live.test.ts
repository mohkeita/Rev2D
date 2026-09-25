import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { formatModelJson } from '../../core/format.js';
import { decodePNG } from '../../render/index.js';
import { openEvents, sleep, startFixture, testModel, texturePng, type Fixture, type SseClient, type SseEvent } from './helpers.js';

let fx: Fixture | null = null;
const clients: SseClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await fx?.close();
  fx = null;
});

async function setup(opts: Parameters<typeof startFixture>[0] = {}) {
  fx = await startFixture(opts);
  const events = await openEvents(fx.base);
  clients.push(events);
  return { fx, events };
}

const changed = (origin: string) => (e: SseEvent) => e.event === 'model-changed' && e.data.origin === origin;

function renamed(name: string): string {
  const doc = testModel();
  doc.meta.name = name;
  return formatModelJson(doc);
}

describe('GET /api/events', () => {
  it('starts with a hello event naming the model file', async () => {
    const { fx, events } = await setup();
    expect(events.events[0]).toEqual({ event: 'hello', data: { file: path.resolve(fx.file), mtimeMs: expect.any(Number), root: path.resolve(fx.dir) } });
  });

  it('reports external writes as origin "external"', async () => {
    const { fx, events } = await setup();
    writeFileSync(fx.file, renamed('external'));
    const e = await events.next(changed('external'));
    expect(e.data.files).toEqual(['model.r2d.json']);
    const model = await (await fetch(`${fx.base}/api/model`)).json();
    expect(model.mtimeMs).toBe(e.data.mtimeMs);
    expect(model.text).toContain('"external"');
  });

  it('reports PUT writes once, as origin "editor", never echoed as external', async () => {
    const { fx, events } = await setup();
    const res = await fetch(`${fx.base}/api/model`, { method: 'PUT', body: JSON.stringify({ text: renamed('from-editor') }) });
    const { mtimeMs } = await res.json();
    const e = await events.next(changed('editor'));
    expect(e.data).toEqual({ origin: 'editor', mtimeMs, files: ['model.r2d.json'] });
    await sleep(500); // well past the watcher debounce: the write's own fs events must be recognized
    expect(events.pending((x) => x.event === 'model-changed')).toEqual([]);
  });

  it('follows editors that save by renaming a temp file over the model', async () => {
    const { fx, events } = await setup();
    const tmp = path.join(fx.dir, '.model.r2d.json.tmp');
    writeFileSync(tmp, renamed('atomic-save'));
    renameSync(tmp, fx.file);
    await events.next(changed('external'));
    // The watcher survives the replacement.
    writeFileSync(fx.file, renamed('after-rename'));
    await events.next(changed('external'));
    expect(readFileSync(fx.file, 'utf8')).toContain('after-rename');
  });

  it('reports texture edits and serves the new pixels', async () => {
    const { fx, events } = await setup();
    writeFileSync(path.join(fx.dir, 'tex.png'), texturePng('#0000ff', 3, 3));
    const e = await events.next(changed('external'));
    expect(e.data.files).toEqual(['tex.png']);
    const img = decodePNG(new Uint8Array(await (await fetch(`${fx.base}/api/texture/tex`)).arrayBuffer()));
    expect([img.width, img.height]).toEqual([3, 3]);
  });

  it('watches textures added by an edit, polling directories that do not exist yet', async () => {
    const { fx, events } = await setup();
    const doc = testModel();
    doc.textures.push({ id: 'extra', path: 'sub/extra.png' });
    await fetch(`${fx.base}/api/model`, { method: 'PUT', body: JSON.stringify({ doc }) });
    await events.next(changed('editor'));
    expect(fx.logs).toEqual([expect.stringMatching(/fs\.watch unavailable for .*sub \(ENOENT\); polling/)]);
    mkdirSync(path.join(fx.dir, 'sub'));
    writeFileSync(path.join(fx.dir, 'sub', 'extra.png'), texturePng());
    const e = await events.next(changed('external'));
    expect(e.data.files).toEqual(['sub/extra.png']);
  });

  it('reports the model file being deleted on disk, and again when it comes back', async () => {
    const { fx, events } = await setup();
    rmSync(fx.file);
    const gone = await events.next(changed('external'));
    expect(gone.data.files).toEqual(['model.r2d.json']);
    // The editor re-reads it and learns it is missing (it then keeps its document as unsaved).
    expect((await fetch(`${fx.base}/api/model`)).status).toBe(404);
    writeFileSync(fx.file, renamed('restored'));
    await events.next(changed('external'));
    expect((await (await fetch(`${fx.base}/api/model`)).json()).text).toContain('"restored"');
  });

  it('ignores rewrites with identical content', async () => {
    const { fx, events } = await setup();
    writeFileSync(fx.file, readFileSync(fx.file));
    await sleep(500);
    expect(events.pending((x) => x.event === 'model-changed')).toEqual([]);
  });

  it('detects changes with stat polling', async () => {
    const { fx, events } = await setup({ poll: true, pollIntervalMs: 50 });
    writeFileSync(fx.file, renamed('polled-change'));
    await events.next(changed('external'));
  });

  it('broadcasts commands to every connected client', async () => {
    const { fx, events } = await setup();
    const second = await openEvents(fx.base);
    clients.push(second);
    const command = { type: 'focus', viewBox: [0, 0, 32, 32] };
    const res = await fetch(`${fx.base}/api/command`, { method: 'POST', body: JSON.stringify(command) });
    expect(await res.json()).toEqual({ delivered: 2 });
    for (const c of [events, second]) expect((await c.next((e) => e.event === 'command')).data).toEqual(command);

    second.close();
    await sleep(100);
    const again = await fetch(`${fx.base}/api/command`, { method: 'POST', body: JSON.stringify({ type: 'reload' }) });
    expect(await again.json()).toEqual({ delivered: 1 });
  });

  it('close() ends event streams and stops listening', async () => {
    const { fx: f, events } = await setup();
    fx = null;
    await f.close();
    await events.ended;
    await expect(fetch(`${f.base}/api/model`)).rejects.toThrow();
  });
});
