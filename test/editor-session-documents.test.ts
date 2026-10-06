/**
 * The editor session and the documents of the workspace modes, against a scripted workspace server
 * (editor/src/api.ts replaced by an in-memory fake) with an avatar project:
 *
 * - an avatar project WITHOUT a built model is a document of its own (status 'empty' with
 *   `workspace.avatar`), opened by POST /api/open or created by POST /api/avatar/new;
 * - its first build opening the model continues the same document (no "opened in another tab");
 *   a switch to another project is announced and its unsaved edits are reported lost;
 * - the unsaved-changes prompt asks about a mode's dirty document (avatar.json) before the model,
 *   unless the action keeps it open; Save calls the document's save;
 * - Save / Undo / Redo go to the document of the mode on screen, else to the model;
 * - the selected avatar part is published as EditorState.avatar.part.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AvatarNewRequest, AvatarRef, EditorState, EventHandlers, PutOptions, PutResult } from '../editor/src/api.js';
import { avatarDocumentState, projectKeptBy, specPath } from '../editor/src/avatar/document.js';
import { initialAvatarState } from '../editor/src/avatar/store.js';
import { registerMode, resolveMode, getModes, type ModeDocument, type ModeDocumentState } from '../editor/src/shell/registry.js';
import { documentKind, type AppState } from '../editor/src/state/app.js';
import { Session } from '../editor/src/state/session.js';
import { formatModelJson } from '../src/core/format.js';
import { blankModel } from '../src/api/templates.js';

const ROOT = '/ws';
const abs = (f: string) => (f.startsWith('/') ? f : `${ROOT}/${f}`);
const ref = (dir: string): AvatarRef => ({ project: abs(dir), projectPath: dir, specFile: abs(`${dir}/avatar.json`) });

const server = vi.hoisted(() => ({
  handlers: null as EventHandlers | null,
  current: null as string | null,
  avatar: null as AvatarRef | null,
  files: new Map<string, { text: string; mtimeMs: number }>(),
  /** Projects of the workspace by folder, with their built model (or none). */
  projects: new Map<string, string | null>(),
  clock: 10,
  calls: [] as string[],
  published: [] as EditorState[],
}));

vi.mock('../editor/src/api.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../editor/src/api.js')>();
  const projectOf = (file: string): AvatarRef | null => {
    const dir = file.slice(0, file.lastIndexOf('/'));
    if (!server.projects.has(dir)) return null;
    return { project: dir, projectPath: dir.slice(ROOT.length + 1), specFile: `${dir}/avatar.json` };
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
    fetchWorkspace: async () => ({ root: ROOT, current: server.current, recent: [], ...(server.avatar ? { avatar: server.avatar } : {}) }),
    fetchModel: async () => {
      server.calls.push('fetchModel');
      if (!server.current) throw new real.NoModelError('GET /api/model failed (HTTP 409): no model is open', 409, { detail: 'no model is open' });
      const f = server.files.get(server.current)!;
      return { file: server.current, text: f.text, mtimeMs: f.mtimeMs };
    },
    fetchTexture: async () => {
      throw new Error('no textures in these tests');
    },
    textureUrl: (id: string) => `/api/texture/${id}`,
    postState: async (s: EditorState) => {
      server.published.push(s);
    },
    putModel: async (body: { doc: unknown }, _opts: PutOptions = {}): Promise<PutResult> => {
      const mtimeMs = ++server.clock;
      server.files.set(server.current!, { text: formatModelJson(body.doc), mtimeMs });
      server.calls.push('putModel');
      return { ok: true, written: true, diagnostics: [], mtimeMs };
    },
    openModel: async (file: string) => {
      server.calls.push(`open ${file}`);
      const a = abs(file);
      // An avatar project (its avatar.json or folder): its built model, or the project alone.
      const dir = a.endsWith('/avatar.json') ? a.slice(0, -'/avatar.json'.length) : a;
      if (server.projects.has(dir)) {
        const model = server.projects.get(dir)!;
        server.avatar = { project: dir, projectPath: dir.slice(ROOT.length + 1), specFile: `${dir}/avatar.json` };
        if (!model) {
          server.current = null;
          return { file: null, text: null, mtimeMs: 0, notes: [], avatar: server.avatar };
        }
        server.current = model;
        const f = server.files.get(model)!;
        return { file: model, text: f.text, mtimeMs: f.mtimeMs, notes: [], avatar: server.avatar };
      }
      const f = server.files.get(a)!;
      server.current = a;
      server.avatar = projectOf(a);
      return { file: a, text: f.text, mtimeMs: f.mtimeMs, notes: [], ...(server.avatar ? { avatar: server.avatar } : {}) };
    },
    saveAs: async (req: { file: string; doc?: unknown }) => {
      server.calls.push(`saveAs ${req.file}`);
      const a = abs(req.file);
      server.files.set(a, { text: formatModelJson(req.doc), mtimeMs: ++server.clock });
      server.current = a;
      server.avatar = projectOf(a);
      return { file: a, text: server.files.get(a)!.text, mtimeMs: server.clock, notes: [], ...(server.avatar ? { avatar: server.avatar } : {}) };
    },
    closeModel: async () => {
      server.calls.push('close');
      server.current = null;
      server.avatar = null;
    },
    newAvatar: async (req: AvatarNewRequest) => {
      server.calls.push(`newAvatar ${req.name}`);
      const dir = abs(req.name!);
      server.projects.set(dir, null);
      server.current = null;
      server.avatar = { project: dir, projectPath: req.name!, specFile: `${dir}/avatar.json` };
      return { ...server.avatar, specPath: `${req.name}/avatar.json`, name: req.name, image: { file: 'source.png', path: `${req.name}/source.png`, width: 64, height: 64, bytes: 10 }, mtimeMs: 1, landmarksToPlace: 20, notes: [] };
    },
  };
});

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await tick();
}

const model = (name: string) => formatModelJson(blankModel({ name }));

/** A mode document like avatar.json's: a fake with counters. */
const doc = {
  state: null as ModeDocumentState | null,
  saves: 0,
  undos: 0,
  redos: 0,
  saveOk: true,
  set(patch: Partial<ModeDocumentState>) {
    doc.state = { name: 'hana', path: 'hana/avatar.json', dirty: false, saving: false, canUndo: true, canRedo: true, undoLabel: 'Move', redoLabel: 'Move', ...doc.state, ...patch };
  },
};
const document: ModeDocument = {
  subscribe: () => () => undefined,
  getState: () => doc.state,
  save: async () => {
    doc.saves++;
    if (doc.saveOk) doc.set({ dirty: false });
    return doc.saveOk;
  },
  undo: () => void doc.undos++,
  redo: () => void doc.redos++,
  // The project shown keeps it (as avatarStore's project does: it follows the session afterwards).
  keptBy: (next) => projectKeptBy(session?.get().workspace?.avatar ?? null, next),
};

const projectOpen = (s: AppState): boolean => !!s.workspace?.avatar;
let unregister: Array<() => void> = [];
let session: Session;

async function startWith(current: string | null, avatar: AvatarRef | null): Promise<void> {
  server.current = current;
  server.avatar = avatar;
  session = new Session();
  await session.start();
  await settle();
}

const toasts = () => session.get().toasts.map((t) => `${t.kind}: ${t.text}`);
const activeMode = () => resolveMode(getModes(), session.get())?.id ?? null;

beforeEach(() => {
  server.handlers = null;
  server.files = new Map([
    [abs('hana/hana.r2d.json'), { text: model('hana'), mtimeMs: 1 }],
    [abs('b.r2d.json'), { text: model('b'), mtimeMs: 2 }],
  ]);
  server.projects = new Map([
    [abs('hana'), null],
    [abs('mio'), null],
  ]);
  server.calls = [];
  server.published = [];
  doc.state = null;
  doc.saves = doc.undos = doc.redos = 0;
  doc.saveOk = true;
  unregister = [
    registerMode({ id: 'test-rig', label: 'Rig', icon: 'bone', order: 0, render: {} }),
    registerMode({ id: 'test-avatar', label: 'Avatar', icon: 'avatar', order: 10, isAvailable: projectOpen, showsWithoutModel: projectOpen, isDefault: projectOpen, document, render: {} }),
  ];
});

afterEach(() => {
  session?.dispose();
  for (const off of unregister) off();
});

describe('an avatar project without a model', () => {
  it('is a document of its own: Avatar mode shows it instead of the start screen', async () => {
    await startWith(null, ref('hana'));
    expect(session.get().status).toBe('empty');
    expect(documentKind(session.get())).toBe('avatar-project');
    expect(activeMode()).toBe('test-avatar');
    // Without the project it is the start screen.
    server.avatar = null;
    server.handlers!.onFileChanged!({ file: null, origin: 'editor' });
    await settle();
    expect(documentKind(session.get())).toBe('none');
    expect(activeMode()).toBeNull();
    expect(toasts()).toEqual(['info: hana/avatar.json was closed in another tab']);
  });

  it('follows its first build silently: the model opens in the same document and mode', async () => {
    await startWith(null, ref('hana'));
    doc.set({ dirty: true });
    // What the server sends when a build of this project (from this tab or any) opens its model.
    server.current = abs('hana/hana.r2d.json');
    server.projects.set(abs('hana'), server.current);
    server.handlers!.onFileChanged!({ file: server.current, origin: 'editor', avatar: ref('hana') });
    await settle();
    expect(session.get()).toMatchObject({ status: 'ready', file: abs('hana/hana.r2d.json') });
    expect(session.get().workspace?.avatar).toEqual(ref('hana'));
    expect(activeMode()).toBe('test-avatar');
    // Not news: no "opened in another tab", and the avatar edits were not lost.
    expect(toasts()).toEqual([]);
  });

  it('announces a switch to another project and reports its unsaved edits lost', async () => {
    await startWith(null, ref('hana'));
    doc.set({ dirty: true });
    server.avatar = ref('mio');
    server.handlers!.onFileChanged!({ file: null, origin: 'ai', avatar: ref('mio') });
    await settle();
    expect(session.get().workspace?.avatar).toEqual(ref('mio'));
    expect(toasts()).toEqual(['info: opened mio/avatar.json', 'warning: Your unsaved edit to hana/avatar.json was discarded.']);
    expect(session.get().toasts[0].source).toBe('AI');
  });

  it('opens by its avatar.json (POST /api/open answers the project alone) without announcing the echo', async () => {
    await startWith(abs('b.r2d.json'), null);
    expect(activeMode()).toBe('test-rig');
    expect((await session.openFile('mio/avatar.json')).ok).toBe(true);
    // The echo of this tab's own open arrives (deferred while the operation ran, or right after).
    server.handlers!.onFileChanged!({ file: null, origin: 'editor', avatar: ref('mio') });
    await settle();
    expect(session.get()).toMatchObject({ status: 'empty', file: '', workspace: { current: null, avatar: ref('mio') } });
    expect(activeMode()).toBe('test-avatar');
    expect(toasts()).toEqual(['success: Opened mio/avatar.json']);
    // Opening it again does nothing.
    server.calls = [];
    expect((await session.openFile(abs('mio'))).ok).toBe(true);
    expect(server.calls).toEqual([]);
  });

  it('is created from one picture (POST /api/avatar/new) after asking about unsaved edits', async () => {
    await startWith(null, ref('hana'));
    doc.set({ dirty: true });
    const creating = session.newAvatarProject({ name: 'mio', image: { name: 'mio.png', base64: '' } });
    await settle();
    expect(session.get().unsavedPrompt).toMatchObject({ phase: 'asking', file: 'hana/avatar.json', action: 'create a new avatar' });
    session.resolveUnsaved('save');
    const r = await creating;
    expect(r.ok && r.result.projectPath).toBe('mio');
    expect(doc.saves).toBe(1);
    expect(server.calls).toEqual(['newAvatar mio']);
    expect(session.get().workspace?.avatar).toEqual(ref('mio'));
    server.handlers!.onFileChanged!({ file: null, origin: 'editor', avatar: ref('mio') });
    await settle();
    // The sheet that created it says so itself; the echo is no news.
    expect(toasts()).toEqual([]);
  });

  it('closes with File > Close (the project too)', async () => {
    await startWith(null, ref('hana'));
    expect((await session.closeModel()).ok).toBe(true);
    expect(server.calls).toEqual(['close']);
    expect(documentKind(session.get())).toBe('none');
  });
});

describe('the unsaved-changes prompt and a mode document', () => {
  it('asks about avatar.json before the action that leaves the project; Save calls its save', async () => {
    await startWith(abs('hana/hana.r2d.json'), ref('hana'));
    doc.set({ dirty: true });
    const opening = session.openFile('b.r2d.json');
    await settle();
    expect(session.get().unsavedPrompt).toMatchObject({ phase: 'asking', file: 'hana/avatar.json', action: 'open b.r2d.json' });
    session.resolveUnsaved('save');
    expect((await opening).ok).toBe(true);
    expect(doc.saves).toBe(1);
    expect(session.get().file).toBe(abs('b.r2d.json'));
    expect(session.get().workspace?.avatar).toBeUndefined();
  });

  it('keeps the prompt up when the save fails, and goes on after "Don\'t save" (not asked again)', async () => {
    await startWith(abs('hana/hana.r2d.json'), ref('hana'));
    doc.set({ dirty: true });
    doc.saveOk = false;
    const opening = session.openFile('b.r2d.json');
    await settle();
    session.resolveUnsaved('save');
    await settle();
    expect(session.get().unsavedPrompt).toMatchObject({ phase: 'asking', error: 'The file could not be saved.' });
    session.resolveUnsaved('cancel');
    expect(await opening).toEqual({ ok: false, cancelled: true });
    expect(session.get().file).toBe(abs('hana/hana.r2d.json'));
    // "Don't save" goes on; the same unsaved state is not asked about again.
    const again = session.openFile('b.r2d.json');
    await settle();
    session.resolveUnsaved('discard');
    expect((await again).ok).toBe(true);
    expect(session.get().unsavedPrompt).toBeNull();
  });

  it('does not ask when the action keeps the project open, nor for Reload from disk', async () => {
    await startWith(null, ref('hana'));
    doc.set({ dirty: true });
    server.projects.set(abs('hana'), abs('hana/hana.r2d.json'));
    // Opening the built model of the project shown keeps avatar.json open.
    expect((await session.openFile('hana/hana.r2d.json')).ok).toBe(true);
    expect(session.get().unsavedPrompt).toBeNull();
    expect(session.get().status).toBe('ready');
    await session.reloadFromDisk();
    expect(session.get().unsavedPrompt).toBeNull();
    expect(doc.saves).toBe(0);
  });

  it('asks about the mode document first, then about the model', async () => {
    await startWith(abs('hana/hana.r2d.json'), ref('hana'));
    doc.set({ dirty: true });
    session.store.set({ unsaved: true });
    const closing = session.closeModel();
    await settle();
    expect(session.get().unsavedPrompt).toMatchObject({ file: 'hana/avatar.json', action: 'close it' });
    session.resolveUnsaved('discard');
    await settle();
    expect(session.get().unsavedPrompt).toMatchObject({ file: 'hana.r2d.json', action: 'close it' });
    session.resolveUnsaved('cancel');
    expect(await closing).toEqual({ ok: false, cancelled: true });
    expect(server.calls).not.toContain('close');
  });

  it('asks before Save As takes the model out of the project (the model itself goes along)', async () => {
    await startWith(abs('hana/hana.r2d.json'), ref('hana'));
    doc.set({ dirty: true });
    // Inside the project folder: the project stays open, nothing to ask.
    expect((await session.saveAs('hana/copy.r2d.json')).ok).toBe(true);
    expect(session.get().workspace?.avatar).toEqual(ref('hana'));
    const saving = session.saveAs('elsewhere.r2d.json');
    await settle();
    expect(session.get().unsavedPrompt).toMatchObject({ file: 'hana/avatar.json', action: 'save the model as elsewhere.r2d.json' });
    session.resolveUnsaved('cancel');
    expect(await saving).toEqual({ ok: false, cancelled: true });
    expect(server.calls.filter((c) => c.startsWith('saveAs'))).toEqual(['saveAs hana/copy.r2d.json']);
  });

  it('counts the dirty document as unsaved work (leaving the page asks)', async () => {
    await startWith(null, ref('hana'));
    expect(session.hasUnsavedWork()).toBe(false);
    doc.set({ dirty: true });
    expect(session.hasUnsavedWork()).toBe(true);
  });
});

describe('the document on screen', () => {
  it('gets Save, Undo and Redo; the model gets them while its own mode is on screen', async () => {
    await startWith(abs('hana/hana.r2d.json'), ref('hana'));
    doc.set({ dirty: true });
    expect(activeMode()).toBe('test-avatar');
    expect(await session.saveDocument()).toBe(true);
    await session.undoDocument();
    await session.redoDocument();
    expect([doc.saves, doc.undos, doc.redos]).toEqual([1, 1, 1]);
    // Nothing to undo: the document is not asked.
    doc.set({ canUndo: false });
    await session.undoDocument();
    expect(doc.undos).toBe(1);
    // The person picks Rig: the model is the document (Save with nothing unsaved says so).
    session.setMode('test-rig');
    expect(activeMode()).toBe('test-rig');
    expect(await session.saveDocument()).toBe(true);
    expect(doc.saves).toBe(1);
    expect(toasts()).toContain('info: No unsaved changes: the file on disk is up to date.');
    // The pick is remembered for this project only.
    server.current = abs('b.r2d.json');
    server.avatar = null;
    server.handlers!.onFileChanged!({ file: abs('b.r2d.json'), origin: 'editor' });
    await settle();
    expect(activeMode()).toBe('test-rig');
  });

  it('publishes the selected avatar part with the view state', async () => {
    await startWith(abs('hana/hana.r2d.json'), ref('hana'));
    session.setViewport({ width: 800, height: 600 });
    session.setAvatarPart('eyes.imageLeft.opening');
    expect(session.editorState()?.avatar).toEqual({ part: 'eyes.imageLeft.opening' });
    await tick(450);
    expect(server.published.at(-1)?.avatar).toEqual({ part: 'eyes.imageLeft.opening' });
    session.setAvatarPart(null);
    expect(session.editorState()?.avatar).toEqual({ part: null });
    // A model outside an avatar project publishes no avatar part.
    server.current = abs('b.r2d.json');
    server.avatar = null;
    server.handlers!.onFileChanged!({ file: abs('b.r2d.json'), origin: 'editor' });
    await settle();
    expect(session.editorState()?.avatar).toBeUndefined();
  });
});

describe('avatar.json as Avatar mode\'s document', () => {
  it('names the file and the avatar, and is null while nothing can be saved', () => {
    const r = ref('chars/hana');
    expect(specPath(r)).toBe('chars/hana/avatar.json');
    expect(specPath({ projectPath: '' })).toBe('avatar.json');
    const s = { ...initialAvatarState(), ref: r, status: 'ready' as const, doc: { name: 'hana' }, unsaved: true, canUndo: true, undoLabel: 'Move Nose' };
    expect(avatarDocumentState(s)).toEqual({ name: 'hana', path: 'chars/hana/avatar.json', dirty: true, saving: false, canUndo: true, canRedo: false, undoLabel: 'Move Nose', redoLabel: null });
    expect(avatarDocumentState({ ...s, doc: {} })?.name).toBe('hana');
    expect(avatarDocumentState({ ...s, status: 'loading' })).toBeNull();
    expect(avatarDocumentState({ ...s, ref: null })).toBeNull();
  });

  it('is kept by opening the project again or its built model, and lost by anything else', () => {
    const r = ref('hana');
    expect(projectKeptBy(r, abs('hana'))).toBe(true);
    expect(projectKeptBy(r, abs('hana/avatar.json'))).toBe(true);
    expect(projectKeptBy(r, abs('hana/hana.r2d.json'))).toBe(true);
    expect(projectKeptBy({ project: 'C:\\ws\\hana', specFile: 'C:\\ws\\hana\\avatar.json' }, 'c:/WS/hana/hana.r2d.json')).toBe(true);
    expect(projectKeptBy(r, abs('hana/sub/x.r2d.json'))).toBe(false);
    expect(projectKeptBy(r, abs('b.r2d.json'))).toBe(false);
    expect(projectKeptBy(r, null)).toBe(false);
    expect(projectKeptBy(null, abs('hana'))).toBe(false);
  });
});
