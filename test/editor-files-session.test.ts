/**
 * Editor Session file management against a scripted workspace server: the protocol client
 * (editor/src/api.ts) is replaced by an in-memory fake with a root, an open model (or none), files
 * and a recent list, so open / new / save as / import / close, the unsaved-changes guard and
 * "file-changed" events are deterministic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventHandlers, NewRequest, PutOptions, PutResult, SaveAsRequest } from '../editor/src/api.js';
import { Session } from '../editor/src/state/session.js';
import { formatModelJson } from '../src/core/format.js';
import { blankModel } from '../src/api/templates.js';

const ROOT = '/ws';
const abs = (f: string) => (f.startsWith('/') ? f : `${ROOT}/${f}`);

const server = vi.hoisted(() => ({
  handlers: null as EventHandlers | null,
  current: null as string | null,
  files: new Map<string, { text: string; mtimeMs: number }>(),
  recent: [] as string[],
  clock: 10,
  calls: [] as string[],
  puts: [] as Array<{ doc: unknown; force: boolean; file?: string }>,
  putMode: 'ok' as 'ok' | 'network' | 'invalid',
  /** Runs inside openModel after the switch, before it answers (to interleave events). */
  afterOpen: null as null | (() => void),
}));

vi.mock('../editor/src/api.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../editor/src/api.js')>();
  const opened = (file: string, notes: string[] = []) => {
    const f = server.files.get(file)!;
    server.current = file;
    server.recent = [file, ...server.recent.filter((r) => r !== file)];
    return { file, text: f.text, mtimeMs: f.mtimeMs, notes };
  };
  return {
    ApiRequestError: real.ApiRequestError,
    ConflictError: real.ConflictError,
    NoModelError: real.NoModelError,
    FileExistsError: real.FileExistsError,
    FileSwitchedError: real.FileSwitchedError,
    DOWNLOAD_URL: '/api/download',
    connectEvents: (h: EventHandlers) => {
      server.handlers = h;
      return () => {
        server.handlers = null;
      };
    },
    fetchWorkspace: async () => ({ root: ROOT, current: server.current, recent: [...server.recent] }),
    fetchModel: async () => {
      server.calls.push('fetchModel');
      if (!server.current) throw new real.NoModelError('GET /api/model failed (HTTP 409): no model is open', 409, { detail: 'no model is open' });
      const f = server.files.get(server.current);
      if (!f) throw new real.ApiRequestError(`GET /api/model failed (HTTP 404): model file not found: ${server.current}`, 404, { detail: `model file not found: ${server.current}` });
      return { file: server.current, text: f.text, mtimeMs: f.mtimeMs };
    },
    fetchTexture: async () => {
      throw new Error('no textures in these tests');
    },
    textureUrl: (id: string) => `/api/texture/${id}`,
    postState: async () => undefined,
    putModel: async (body: { doc: unknown }, opts: PutOptions = {}): Promise<PutResult> => {
      server.puts.push({ doc: body.doc, force: opts.force ?? false, file: opts.file });
      if (server.putMode === 'network') throw new TypeError('Failed to fetch');
      if (opts.file && opts.file !== server.current) throw new real.FileSwitchedError('the write is for another model', server.current ?? '');
      if (server.putMode === 'invalid' && !opts.force) {
        return { ok: false, written: false, diagnostics: [{ severity: 'error', code: 'x', message: 'bad', path: '' }], mtimeMs: server.files.get(server.current!)!.mtimeMs };
      }
      const mtimeMs = ++server.clock;
      server.files.set(server.current!, { text: formatModelJson(body.doc), mtimeMs });
      return { ok: true, written: true, diagnostics: [], mtimeMs };
    },
    openModel: async (file: string) => {
      server.calls.push(`open ${file}`);
      const a = abs(file);
      if (!server.files.has(a)) throw new real.ApiRequestError(`POST /api/open failed (HTTP 404): file not found: ${file}`, 404, { detail: `file not found: ${file}`, hint: 'GET /api/files lists the workspace' });
      const result = opened(a);
      server.afterOpen?.();
      return result;
    },
    newModel: async (req: NewRequest) => {
      server.calls.push(`new ${req.file} ${req.template}`);
      const a = abs(req.file);
      if (server.files.has(a) && !req.overwrite) throw new real.FileExistsError(`POST /api/new failed (HTTP 409): ${req.file} already exists`, 409, { detail: `${req.file} already exists` });
      server.files.set(a, { text: formatModelJson(blankModel({ name: req.name })), mtimeMs: ++server.clock });
      return opened(a, [`created ${req.file} from template "${req.template}"`]);
    },
    saveAs: async (req: SaveAsRequest) => {
      server.calls.push(`saveAs ${req.file}`);
      const a = abs(req.file);
      if (server.files.has(a) && !req.overwrite) throw new real.FileExistsError(`POST /api/save-as failed (HTTP 409): ${req.file} already exists`, 409, { detail: `${req.file} already exists` });
      server.files.set(a, { text: req.doc ? formatModelJson(req.doc) : req.text!, mtimeMs: ++server.clock });
      return opened(a, ['texture "t": path "a.png" rewritten to "../a.png" so it still points at the same file']);
    },
    importFiles: async (req: { dir?: string; files: Array<{ name: string; text?: string }> }) => {
      server.calls.push(`import ${req.files.map((f) => f.name).join(',')} -> ${req.dir}`);
      const model = req.files.find((f) => f.text !== undefined)!;
      const a = abs(req.dir ? `${req.dir}/${model.name}` : model.name);
      server.files.set(a, { text: model.text!, mtimeMs: ++server.clock });
      return opened(a);
    },
    closeModel: async () => {
      server.calls.push('close');
      server.current = null;
    },
  };
});

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await tick();
}

function model(name: string): string {
  return formatModelJson(blankModel({ name }));
}

const eye = (fill: string) => ({ id: 'eye', parent: 'bodyWarp', shape: { type: 'ellipse', cx: 256, cy: 237, rx: 15, ry: 26 }, fill, z: 1 });

let session: Session;

async function startWith(current: string | null): Promise<void> {
  server.current = current ? abs(current) : null;
  session = new Session();
  await session.start();
  await settle();
}

beforeEach(() => {
  server.handlers = null;
  server.files = new Map([
    [abs('a.r2d.json'), { text: model('a'), mtimeMs: 1 }],
    [abs('b.r2d.json'), { text: model('b'), mtimeMs: 2 }],
    [abs('chars/c.r2d.json'), { text: model('c'), mtimeMs: 3 }],
  ]);
  server.recent = [];
  server.calls = [];
  server.puts = [];
  server.putMode = 'ok';
  server.afterOpen = null;
});

afterEach(() => session?.dispose());

/** An inspector edit whose write fails: the document is unsaved. */
async function makeUnsaved(): Promise<void> {
  server.putMode = 'network';
  const r = await session.applyEdit({ kind: 'part', id: 'eye' }, eye('#ff0000'));
  expect(r.ok).toBe(true);
  expect(session.get().unsaved).toBe(true);
  server.putMode = 'ok';
}

describe('editor session: files', () => {
  it('shows the start screen when no model is open, without asking for one', async () => {
    await startWith(null);
    expect(session.get()).toMatchObject({ status: 'empty', file: '', model: null, workspace: { root: ROOT, current: null } });
    expect(server.calls).not.toContain('fetchModel');
    expect(session.editorState()).toBeNull();
  });

  it('opens another model: fresh document, history and view state', async () => {
    await startWith('a.r2d.json');
    session.setParam('Lean', 0.5);
    session.select(['part:eye']);
    session.seek(1);
    await session.applyEdit({ kind: 'part', id: 'eye' }, eye('#00ff00'));
    expect(session.get().canUndo).toBe(true);

    const r = await session.openFile('b.r2d.json');
    expect(r).toEqual({ ok: true });
    expect(session.get()).toMatchObject({ status: 'ready', file: abs('b.r2d.json'), overrides: {}, selection: [], time: 0, canUndo: false, unsaved: false });
    expect(session.get().model?.meta.name).toBe('b');
    expect(session.get().workspace?.recent[0]).toBe(abs('b.r2d.json'));
    expect(session.get().toasts.at(-1)).toMatchObject({ kind: 'success', text: 'Opened b.r2d.json' });
    expect(session.displayPath(abs('chars/c.r2d.json'))).toBe('chars/c.r2d.json');
  });

  it('reports a failed open without leaving the open model', async () => {
    await startWith('a.r2d.json');
    const r = await session.openFile('missing.r2d.json');
    expect(r).toEqual({ ok: false, error: 'file not found: missing.r2d.json', hint: 'GET /api/files lists the workspace' });
    expect(session.get()).toMatchObject({ status: 'ready', file: abs('a.r2d.json') });
  });

  it('creates a model from a template, asking before replacing an existing file', async () => {
    await startWith(null);
    const exists = await session.createModel({ file: 'a.r2d.json', template: 'hana', name: 'A' });
    expect(exists).toMatchObject({ ok: false, exists: true });
    expect(session.get().status).toBe('empty');
    const r = await session.createModel({ file: 'a.r2d.json', template: 'hana', name: 'A', overwrite: true });
    expect(r).toEqual({ ok: true });
    expect(session.get()).toMatchObject({ status: 'ready', file: abs('a.r2d.json') });
    // The server's note says the same in more detail: one toast.
    expect(session.get().toasts.map((t) => t.text)).toEqual(['Created a.r2d.json from template "hana"']);
  });

  it('saves as another file, keeping the view and sending the current document', async () => {
    await startWith('a.r2d.json');
    session.setParam('Lean', -0.25);
    await session.applyEdit({ kind: 'part', id: 'eye' }, eye('#123456'));
    const r = await session.saveAs('chars/copy.r2d.json');
    expect(r).toEqual({ ok: true });
    expect(session.get()).toMatchObject({ file: abs('chars/copy.r2d.json'), overrides: { Lean: -0.25 }, canUndo: false });
    expect(server.files.get(abs('chars/copy.r2d.json'))!.text).toContain('#123456');
    const toast = session.get().toasts.at(-1)!;
    expect(toast.text).toBe('Saved as chars/copy.r2d.json');
    expect(toast.details?.[0]).toMatch(/rewritten/);
    expect(await session.saveAs('b.r2d.json')).toMatchObject({ ok: false, exists: true });
  });

  it('closes the model: start screen, nothing published', async () => {
    await startWith('a.r2d.json');
    const r = await session.closeModel();
    expect(r).toEqual({ ok: true });
    expect(session.get()).toMatchObject({ status: 'empty', file: '', model: null, doc: null });
    expect(server.current).toBeNull();
    expect(session.editorState()).toBeNull();
  });

  it('asks before replacing an unsaved document: Cancel keeps it, Don\'t save drops it', async () => {
    await startWith('a.r2d.json');
    await makeUnsaved();

    const cancelled = session.openFile('b.r2d.json');
    await settle();
    expect(session.get().unsavedPrompt).toMatchObject({ phase: 'asking', file: 'a.r2d.json', action: 'open b.r2d.json' });
    session.resolveUnsaved('cancel');
    expect(await cancelled).toEqual({ ok: false, cancelled: true });
    expect(session.get()).toMatchObject({ unsavedPrompt: null, file: abs('a.r2d.json'), unsaved: true });
    expect(server.calls.filter((c) => c.startsWith('open'))).toEqual([]);

    const discarded = session.openFile('b.r2d.json');
    await settle();
    session.resolveUnsaved('discard');
    expect(await discarded).toEqual({ ok: true });
    expect(session.get()).toMatchObject({ file: abs('b.r2d.json'), unsaved: false });
    expect(server.files.get(abs('a.r2d.json'))!.text).not.toContain('#ff0000');
  });

  it('drops toast actions about the previous document when another file opens', async () => {
    await startWith('a.r2d.json');
    server.putMode = 'invalid';
    await session.applyEdit({ kind: 'part', id: 'eye' }, eye('#ff0000'));
    // "Save anyway" (forced write) is offered for a.
    expect(session.get().toasts.some((t) => t.action?.label === 'Save anyway')).toBe(true);
    const opening = session.openFile('b.r2d.json');
    await settle();
    session.resolveUnsaved('discard');
    expect(await opening).toEqual({ ok: true });
    // It would now force-write b: gone with the document it was about.
    expect(session.get().toasts.filter((t) => t.action)).toEqual([]);
    expect(server.puts.filter((p) => p.file === abs('b.r2d.json'))).toEqual([]);
  });

  it('saves first when asked to, then proceeds', async () => {
    await startWith('a.r2d.json');
    await makeUnsaved();
    const closing = session.closeModel();
    await settle();
    session.resolveUnsaved('save');
    expect(await closing).toEqual({ ok: true });
    expect(server.files.get(abs('a.r2d.json'))!.text).toContain('#ff0000');
    expect(server.puts.at(-1)).toMatchObject({ file: abs('a.r2d.json'), force: false });
    expect(session.get().status).toBe('empty');
  });

  it('keeps asking when saving fails; a model rejected for errors can be saved anyway', async () => {
    await startWith('a.r2d.json');
    await makeUnsaved();
    const errorToasts = () => session.get().toasts.filter((t) => t.kind === 'error').length;
    const before = errorToasts();
    server.putMode = 'invalid';
    const opening = session.openFile('b.r2d.json');
    await settle();
    session.resolveUnsaved('save');
    await settle();
    expect(session.get().unsavedPrompt).toMatchObject({ phase: 'asking', canForce: true, error: expect.stringMatching(/rejected the model \(1 error\)/) });
    // No toast on top of the prompt's own message.
    expect(errorToasts()).toBe(before);
    session.resolveUnsaved('saveAnyway');
    expect(await opening).toEqual({ ok: true });
    expect(server.puts.at(-1)).toMatchObject({ force: true, file: abs('a.r2d.json') });
    expect(session.get().file).toBe(abs('b.r2d.json'));
  });

  it('does not ask again for a document the user already chose to discard', async () => {
    await startWith('a.r2d.json');
    await makeUnsaved();
    // First attempt: "Don't save", but creating fails because the file exists.
    const first = session.createModel({ file: 'b.r2d.json', template: 'blank' });
    await settle();
    session.resolveUnsaved('discard');
    expect(await first).toMatchObject({ ok: false, exists: true });
    // The retry with overwrite goes straight through.
    const retry = await session.createModel({ file: 'b.r2d.json', template: 'blank', overwrite: true });
    expect(retry).toEqual({ ok: true });
  });

  it('follows a model opened by an AI, warning about a discarded edit', async () => {
    await startWith('a.r2d.json');
    await makeUnsaved();
    server.current = abs('chars/c.r2d.json');
    server.handlers!.onFileChanged!({ file: abs('chars/c.r2d.json'), origin: 'ai' });
    await settle();
    expect(session.get()).toMatchObject({ status: 'ready', file: abs('chars/c.r2d.json'), unsaved: false });
    const toasts = session.get().toasts;
    expect(toasts.find((t) => t.source === 'AI')?.text).toBe('opened chars/c.r2d.json');
    expect(toasts.find((t) => t.kind === 'warning')?.text).toBe('Your unsaved edit to a.r2d.json was discarded.');
  });

  it('applies commands an AI sends right after opening a file to that file, once it is loaded', async () => {
    await startWith('a.r2d.json');
    // `rev2d editor command --open b --params Squash=0.5 --select eye`: the commands arrive while the
    // tab is still loading b.
    server.current = abs('b.r2d.json');
    server.handlers!.onFileChanged!({ file: abs('b.r2d.json'), origin: 'ai' });
    server.handlers!.onCommand!({ type: 'setParams', params: { Squash: 0.5 } });
    server.handlers!.onCommand!({ type: 'select', ids: ['part:eye'] });
    await settle();
    expect(session.get()).toMatchObject({ status: 'ready', file: abs('b.r2d.json'), overrides: { Squash: 0.5 }, selection: ['part:eye'] });
    expect(session.get().toasts.filter((t) => t.kind === 'warning')).toEqual([]);
  });

  it('shows the start screen when the model is closed elsewhere, and ignores echoes', async () => {
    await startWith('a.r2d.json');
    server.handlers!.onFileChanged!({ file: abs('a.r2d.json'), origin: 'editor' });
    await settle();
    expect(session.get().toasts).toEqual([]);
    server.current = null;
    server.handlers!.onFileChanged!({ file: null, origin: 'editor' });
    await settle();
    expect(session.get()).toMatchObject({ status: 'empty', model: null });
    expect(session.get().toasts.at(-1)?.text).toBe('a.r2d.json was closed in another tab');
  });

  it('handles a switch by an AI that happens during its own open once that is done', async () => {
    await startWith('a.r2d.json');
    server.afterOpen = () => {
      // The echo of this open, then an AI opening c before this tab got the answer.
      server.handlers!.onFileChanged!({ file: abs('b.r2d.json'), origin: 'editor' });
      server.current = abs('chars/c.r2d.json');
      server.handlers!.onFileChanged!({ file: abs('chars/c.r2d.json'), origin: 'ai' });
    };
    const r = await session.openFile('b.r2d.json');
    expect(r).toEqual({ ok: true });
    await settle();
    expect(session.get().file).toBe(abs('chars/c.r2d.json'));
    expect(session.get().toasts.find((t) => t.source === 'AI')?.text).toBe('opened chars/c.r2d.json');
  });

  it('does not write into a model opened meanwhile, and follows the server', async () => {
    await startWith('a.r2d.json');
    // Another tab switched the server to b; this tab has not seen the event yet.
    server.current = abs('b.r2d.json');
    await session.applyEdit({ kind: 'part', id: 'eye' }, eye('#abcdef'));
    await settle();
    expect(server.files.get(abs('b.r2d.json'))!.text).not.toContain('#abcdef');
    expect(session.get().toasts.some((t) => /another model \(b\.r2d\.json\) was opened meanwhile/.test(t.text))).toBe(true);
    expect(session.get().file).toBe(abs('b.r2d.json'));
  });

  it('keeps the document as unsaved when its file is deleted on disk; Save writes it back', async () => {
    await startWith('a.r2d.json');
    server.files.delete(abs('a.r2d.json'));
    server.handlers!.onModelChanged!({ origin: 'external', mtimeMs: 1 });
    await tick(400);
    await settle();
    expect(session.get()).toMatchObject({ status: 'ready', file: abs('a.r2d.json'), unsaved: true });
    expect(session.get().model?.meta.name).toBe('a');
    const toasts = session.get().toasts;
    expect(toasts.at(-1)).toMatchObject({ kind: 'warning', text: expect.stringMatching(/a\.r2d\.json was deleted or moved on disk/) });
    expect(toasts.some((t) => /Reload failed|replaced by the new version/.test(t.text))).toBe(false);

    // Reload from disk (after "Don't save") does not claim to have reloaded anything.
    const reloading = session.reloadFromDisk();
    await settle();
    session.resolveUnsaved('discard');
    await reloading;
    expect(session.get().toasts.some((t) => /^Reloaded/.test(t.text))).toBe(false);

    // Save writes the document back to its file.
    expect(await session.save()).toBe(true);
    expect(server.files.get(abs('a.r2d.json'))!.text).toContain('"name": "a"');
    expect(session.get().unsaved).toBe(false);
  });

  it('downloads the document shown (not the file on disk) while it is unsaved', async () => {
    await startWith('a.r2d.json');
    await makeUnsaved();
    const clicked: Array<{ href: string; download: string }> = [];
    const blobs: Blob[] = [];
    const g = globalThis as { document?: unknown };
    const hadDocument = 'document' in g;
    const origDocument = g.document;
    // Minimal DOM for the temporary download link (these tests run without a browser environment).
    g.document = {
      createElement: () => {
        const a = { href: '', download: '', rel: '', remove() {}, click: () => clicked.push({ href: a.href, download: a.download }) };
        return a;
      },
      body: { appendChild() {} },
    };
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => {
      blobs.push(b as Blob);
      return 'blob:unsaved';
    });
    try {
      session.downloadCopy();
      expect(clicked).toEqual([{ href: 'blob:unsaved', download: 'a.r2d.json' }]);
      expect(await blobs[0].text()).toContain('#ff0000');
      // Saved: the file as on disk, from the server.
      await session.save();
      session.downloadCopy();
      expect(clicked.at(-1)).toEqual({ href: '/api/download', download: 'a.r2d.json' });
    } finally {
      createUrl.mockRestore();
      if (hadDocument) g.document = origDocument;
      else delete g.document;
    }
  });

  it('imports a model picked on the computer into a folder and opens it', async () => {
    await startWith(null);
    const koi = new File([model('koi')], 'koi.r2d.json', { type: 'application/json' });
    const png = new File([new Uint8Array([137, 80, 78, 71])], 'atlas.png', { type: 'image/png' });
    const r = await session.importFiles([koi, png], 'chars');
    expect(r).toEqual({ ok: true });
    expect(server.calls.at(-1)).toBe('import koi.r2d.json,atlas.png -> chars');
    expect(session.get()).toMatchObject({ status: 'ready', file: abs('chars/koi.r2d.json') });

    // Textures the model keeps in a subfolder go there (the picker only gives bare file names).
    const doc = JSON.parse(model('koi2'));
    doc.textures = [{ id: 'atlas', path: 'textures/atlas.png' }];
    const koi2 = new File([JSON.stringify(doc)], 'koi2.r2d.json', { type: 'application/json' });
    expect(await session.importFiles([koi2, png], '')).toEqual({ ok: true });
    expect(server.calls.at(-1)).toBe('import koi2.r2d.json,textures/atlas.png -> ');

    const notModel = new File(['{"hello": 1}'], 'x.json');
    expect(await session.importFiles([notModel], '')).toEqual({ ok: false, error: expect.stringMatching(/not a Rev2D model/) });
    expect(await session.importFiles([png], '')).toEqual({ ok: false, error: expect.stringMatching(/Pick a model file/) });
  });
});
