/**
 * Editor Session behaviour against a scripted editor server: the protocol client (editor/src/api.ts)
 * is replaced by an in-memory fake, so reconnects, change events and write ordering are deterministic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictError, type EditorCommand, type EditorState, type EventHandlers, type ModelChangedEvent, type PutOptions, type PutResult } from '../editor/src/api.js';
import { Session } from '../editor/src/state/session.js';
import { formatModelJson } from '../src/core/format.js';
import { blankModel } from '../src/api/templates.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(v: T): void;
  reject(e: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const server = vi.hoisted(() => ({
  handlers: null as EventHandlers | null,
  text: '',
  mtimeMs: 1,
  fetches: 0,
  published: [] as EditorState[],
  puts: [] as Array<{ doc: unknown; force: boolean; base: number | undefined; reply: Deferred<PutResult> }>,
}));

vi.mock('../editor/src/api.js', async (importOriginal) => ({
  ApiRequestError: (await importOriginal<typeof import('../editor/src/api.js')>()).ApiRequestError,
  ConflictError: (await importOriginal<typeof import('../editor/src/api.js')>()).ConflictError,
  connectEvents: (h: EventHandlers) => {
    server.handlers = h;
    return () => {
      server.handlers = null;
    };
  },
  fetchModel: async () => {
    server.fetches++;
    return { file: '/models/m.r2d.json', text: server.text, mtimeMs: server.mtimeMs };
  },
  fetchTexture: async () => {
    throw new Error('no textures in these tests');
  },
  textureUrl: (id: string) => `/api/texture/${id}`,
  postState: async (s: EditorState) => {
    server.published.push(s);
  },
  putModel: (body: { doc: unknown }, opts: PutOptions = {}) => {
    const reply = deferred<PutResult>();
    server.puts.push({ doc: body.doc, force: opts.force ?? false, base: opts.baseMtimeMs, reply });
    return reply.promise;
  },
}));

/** The blank template plus two more animations (copies of its "idle"), for layer tests. */
function sessionModel(): string {
  const m = blankModel({ name: 'session' }) as { animations: Array<{ id: string }> };
  const idle = m.animations[0];
  m.animations.push({ ...idle, id: 'wave' }, { ...idle, id: 'blink' });
  return formatModelJson(m);
}

const MODEL = sessionModel();
const eye = (z: number) => ({ id: 'eye', parent: 'bodyWarp', shape: { type: 'rect', x: 0, y: 0, w: 4, h: 4 }, z });
const eyeZ = (doc: unknown) => (doc as { parts: Array<{ id: string; z?: number }> }).parts.find((p) => p.id === 'eye')?.z;
const written = (mtimeMs: number): PutResult => ({ ok: true, written: true, diagnostics: [], mtimeMs });
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Let queued promise continuations (fetch -> ingest -> store updates) run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await tick();
}

let session: Session;

beforeEach(async () => {
  server.handlers = null;
  server.text = MODEL;
  server.mtimeMs = 1;
  server.fetches = 0;
  server.published = [];
  server.puts = [];
  session = new Session();
  await session.start();
  server.handlers!.onOpen('/models/m.r2d.json');
});

afterEach(() => session.dispose());

function event(e: ModelChangedEvent): void {
  server.handlers!.onModelChanged(e);
}

function command(c: EditorCommand): void {
  server.handlers!.onCommand(c);
}

describe('editor session', () => {
  it('publishes its view state again after the event stream reconnects (server restart)', async () => {
    await tick(260);
    expect(server.published).toHaveLength(1);
    // The server restarted: its copy of the view state is gone although nothing changed in the UI.
    server.handlers!.onError();
    server.handlers!.onOpen('/models/m.r2d.json');
    await settle();
    await tick(260);
    expect(server.published).toHaveLength(2);
    const { updatedAt: _a, ...first } = server.published[0];
    const { updatedAt: _b, ...second } = server.published[1];
    expect(second).toEqual(first);
  });

  it('selects ids of the displayed model while the file on disk does not parse', async () => {
    server.text = '{ "format": "rev2d", ';
    server.mtimeMs = 2;
    event({ origin: 'external', mtimeMs: 2 });
    await settle();
    expect(session.get()).toMatchObject({ stale: true, doc: null });
    command({ type: 'select', ids: ['eye', 'bone:root', 'missing'] });
    expect(session.get().selection).toEqual(['part:eye', 'bone:root']);
    expect(session.get().toasts.map((t) => t.text)).toEqual(['AI select: not found: missing']);
  });

  it('accepts "all" and "none" in setOverlay like the screenshot endpoint', () => {
    command({ type: 'setOverlay', overlay: ['all'] });
    expect(session.get().overlays).toEqual(['bones', 'mesh', 'warps', 'bounds', 'labels', 'grid']);
    command({ type: 'setOverlay', overlay: ['none'] });
    expect(session.get().overlays).toEqual([]);
    expect(session.get().toasts).toEqual([]);
  });

  it('plays exactly the layers setAnimations asks for: order and every weight', () => {
    // Earlier UI state: extra layers toggled in a different order.
    session.setLayer('blink', { enabled: true });
    session.setLayer('wave', { enabled: true, weight: 0.2 });
    command({ type: 'setAnimations', animations: [{ id: 'idle', weight: 0.4 }, { id: 'wave' }, { id: 'blink', weight: 0.5 }] });
    // Later layers win for param tracks, so the order is part of the pose.
    expect(session.editorState()?.animations).toEqual([{ id: 'idle', weight: 0.4 }, { id: 'wave' }, { id: 'blink', weight: 0.5 }]);
    expect(session.get()).toMatchObject({ animation: 'idle', animationWeight: 0.4 });
    expect(session.get().toasts).toEqual([]);
    // Picking an animation in the timeline plays it at full weight again.
    session.setAnimation('wave');
    expect(session.editorState()?.animations[0]).toEqual({ id: 'wave' });
  });

  it('plays setAnimations layers with their options and publishes them', () => {
    command({
      type: 'setAnimations',
      animations: [
        { id: 'idle', start: 0.5 },
        { id: 'wave', weight: 0.5, mode: 'add' },
        { id: 'blink', mode: 'override', start: 2, hold: false },
      ],
    });
    expect(session.editorState()?.animations).toEqual([
      { id: 'idle', start: 0.5 },
      { id: 'wave', weight: 0.5, mode: 'add' },
      { id: 'blink', start: 2, hold: false },
    ]);
    expect(session.get()).toMatchObject({ animation: 'idle', animationOptions: { start: 0.5 } });
    expect(session.get().layers.find((l) => l.id === 'blink')).toEqual({ id: 'blink', weight: 1, enabled: true, start: 2, hold: false });
    expect(session.get().toasts).toEqual([]);
    expect(session.get().bridge?.text).toBe('setAnimations idle (from 0.5s), wave@0.5 (add), blink (from 2s, once)');

    // The timeline's layer controls change the same options; clearing the main animation's options
    // (or picking another animation) plays it plainly.
    session.setLayer('wave', { mode: 'override', start: -1 });
    session.setAnimationOptions({});
    expect(session.editorState()?.animations).toEqual([{ id: 'idle' }, { id: 'wave', weight: 0.5, start: -1 }, { id: 'blink', start: 2, hold: false }]);
    command({ type: 'setAnimations', animations: [{ id: 'wave', hold: false }] });
    session.setAnimation('blink');
    expect(session.get().animationOptions).toEqual({});
  });

  it('warns about malformed layer options instead of applying them', () => {
    command({ type: 'setAnimations', animations: [{ id: 'idle', mode: 'blend', start: 'soon' } as never] });
    expect(session.editorState()?.animations).toEqual([{ id: 'idle' }]);
    expect(session.get().toasts.map((t) => t.text)).toEqual([
      'AI setAnimations: ignored bad layer options (idle: mode "blend", idle: start "soon"); mode is "override" or "add", start a number of seconds, hold true or false',
    ]);
  });

  it('pins a parameter at its current value and unpins it', () => {
    session.store.set({ values: { ...session.get().values, Lean: 0.25 } });
    session.setPinned('Lean', true);
    expect(session.get().overrides).toEqual({ Lean: 0.25 });
    expect(session.editorState()?.pinned).toEqual(['Lean']);
    // Pinning again keeps the explicit value.
    session.store.set({ values: { ...session.get().values, Lean: 0.7 } });
    session.setPinned('Lean', true);
    expect(session.get().overrides).toEqual({ Lean: 0.25 });
    session.setPinned('Lean', false);
    expect(session.get().overrides).toEqual({});
    session.setPinned('Nope', true);
    expect(session.get().overrides).toEqual({});
  });

  it('says when setAnimations weights are clamped to 0..1', () => {
    command({ type: 'setAnimations', animations: [{ id: 'idle', weight: 2 }, { id: 'wave', weight: -1 }] });
    expect(session.editorState()?.animations).toEqual([{ id: 'idle' }]);
    expect(session.get().toasts.map((t) => t.text)).toEqual(['AI setAnimations: weights are limited to 0..1 in the editor (idle@2 -> 1, wave@-1 -> 0)']);
  });

  it('writes one document at a time, in order', async () => {
    const first = session.applyEdit({ kind: 'part', id: 'eye' }, eye(2));
    const second = session.applyEdit({ kind: 'part', id: 'eye' }, eye(3));
    await settle();
    // The second PUT must wait for the first: otherwise the server may apply them in either order.
    expect(server.puts).toHaveLength(1);
    server.puts[0].reply.resolve({ ok: true, written: true, diagnostics: [], mtimeMs: 10 });
    await settle();
    expect(server.puts).toHaveLength(2);
    expect((server.puts[1].doc as { parts: Array<{ z?: number }> }).parts[1].z).toBe(3);
    server.puts[1].reply.resolve({ ok: true, written: true, diagnostics: [], mtimeMs: 11 });
    await Promise.all([first, second]);
    expect(session.get()).toMatchObject({ mtimeMs: 11, unsaved: false, undoLabel: 'Edit part:eye' });
  });

  it('recognizes the echo of its own earlier write and does not reload', async () => {
    const first = session.applyEdit({ kind: 'part', id: 'eye' }, eye(2));
    await settle();
    server.puts[0].reply.resolve({ ok: true, written: true, diagnostics: [], mtimeMs: 10 });
    await first;
    const second = session.applyEdit({ kind: 'part', id: 'eye' }, eye(3));
    await settle();
    server.puts[1].reply.resolve({ ok: true, written: true, diagnostics: [], mtimeMs: 11 });
    await second;
    const fetches = server.fetches;
    // Change events of both writes arrive late (after the second write finished).
    event({ origin: 'editor', mtimeMs: 10 });
    event({ origin: 'editor', mtimeMs: 11 });
    await settle();
    expect(server.fetches).toBe(fetches);
    expect(session.get().undoLabel).toBe('Edit part:eye');
    // A write by another client (same origin tag, unknown mtime) is still picked up.
    event({ origin: 'editor', mtimeMs: 12 });
    await settle();
    expect(server.fetches).toBe(fetches + 1);
  });

  it('publishes the physics toggle and the preview-hidden parts with the view state', () => {
    expect(session.editorState()).toMatchObject({ physics: true, hidden: [] });
    session.setPhysics(false);
    session.toggleHidden('eye');
    expect(session.editorState()).toMatchObject({ physics: false, hidden: ['eye'] });
  });

  it('bases every write on the file version it edits (baseMtimeMs)', async () => {
    const first = session.applyEdit({ kind: 'part', id: 'eye' }, eye(2));
    await settle();
    expect(server.puts[0].base).toBe(1);
    server.puts[0].reply.resolve(written(10));
    await first;
    const second = session.applyEdit({ kind: 'part', id: 'eye' }, eye(3));
    await settle();
    expect(server.puts[1].base).toBe(10);
    server.puts[1].reply.resolve(written(11));
    await second;
    // Undo writes an older document over the version on disk now.
    const undo = session.undo();
    await settle();
    expect(server.puts[2]).toMatchObject({ base: 11, force: true });
    server.puts[2].reply.resolve(written(12));
    await undo;
  });

  it('keeps the edit and offers reload or overwrite when the file changed on disk meanwhile', async () => {
    const edit = session.applyEdit({ kind: 'part', id: 'eye' }, eye(5));
    await settle();
    server.puts[0].reply.reject(new ConflictError('the model file changed on disk', 7));
    expect(await edit).toMatchObject({ ok: true });
    expect(session.get()).toMatchObject({ conflict: { mtimeMs: 7, force: false }, unsaved: true, saving: false });
    expect(eyeZ(session.get().doc)).toBe(5);
    expect(session.get().toasts).toEqual([]);

    // The other writer's change event must not throw the edit away while the user decides.
    const fetches = server.fetches;
    event({ origin: 'external', mtimeMs: 8 });
    await settle();
    expect(server.fetches).toBe(fetches);
    expect(session.get().conflict).toMatchObject({ mtimeMs: 8 });

    // Overwrite: the same document, now based on the version on disk.
    const overwrite = session.resolveConflict('overwrite');
    await settle();
    expect(server.puts[1]).toMatchObject({ base: 8, force: false });
    expect(eyeZ(server.puts[1].doc)).toBe(5);
    server.puts[1].reply.resolve(written(12));
    await overwrite;
    expect(session.get()).toMatchObject({ conflict: null, unsaved: false, mtimeMs: 12 });
  });

  it('reloads the version on disk when the user drops the conflicting edit', async () => {
    const edit = session.applyEdit({ kind: 'part', id: 'eye' }, eye(5));
    await settle();
    server.puts[0].reply.reject(new ConflictError('the model file changed on disk', 7));
    await edit;
    const doc = JSON.parse(MODEL) as { parts: Array<{ id: string; z?: number }> };
    doc.parts.find((p) => p.id === 'eye')!.z = 9;
    server.text = formatModelJson(doc);
    server.mtimeMs = 7;
    await session.resolveConflict('reload');
    expect(session.get()).toMatchObject({ conflict: null, unsaved: false, mtimeMs: 7 });
    expect(eyeZ(session.get().doc)).toBe(9);
    expect(server.puts).toHaveLength(1);
  });
});
