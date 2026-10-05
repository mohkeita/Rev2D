/**
 * Pure helpers of the editor's file management (editor/src/files): paths and breadcrumbs, file
 * names, listings and keyboard highlight, the unsaved-changes guard state machine, import planning,
 * file shortcuts and toast summaries.
 */
import { describe, expect, it } from 'vitest';
import type { FileEntry } from '../src/node/editor-registry.js';
import { GUARD_IDLE, guardStep, type GuardEvent, type GuardState } from '../editor/src/files/guard.js';
import { MAX_IMPORT_BYTES, jsonKind, modelTextProblem, planImport, planLive2d, spinePageCheck, textureCheck, texturePlacement, toBase64 } from '../editor/src/files/importing.js';
import { summarizeNotes } from '../editor/src/files/notes.js';
import {
  baseName,
  breadcrumbs,
  copyName,
  dirOf,
  fileNameProblem,
  formatSize,
  formatWhen,
  isOpenable,
  joinPath,
  modelFileName,
  moveHighlight,
  normalizeSlashes,
  parentDir,
  relativeToRoot,
  rootLabel,
  samePath,
  slugify,
  uniqueFileName,
  visibleEntries,
} from '../editor/src/files/paths.js';
import { FILE_SHORTCUTS, fileShortcut } from '../editor/src/files/shortcuts.js';
import { shortDescription, templateThumbnail, templateTitle } from '../editor/src/files/templates.js';

describe('workspace paths', () => {
  it('makes absolute paths relative to the root (either separator, Windows case-insensitive)', () => {
    expect(relativeToRoot('C:\\work\\chars\\hero.r2d.json', 'C:\\work')).toBe('chars/hero.r2d.json');
    expect(relativeToRoot('c:/WORK/chars/hero.r2d.json', 'C:\\work\\')).toBe('chars/hero.r2d.json');
    expect(relativeToRoot('/home/me/ws/a.r2d.json', '/home/me/ws')).toBe('a.r2d.json');
    expect(relativeToRoot('/home/me/ws', '/home/me/ws/')).toBe('');
    // Outside the root, including a sibling that merely shares the prefix.
    expect(relativeToRoot('/home/me/wsx/a.r2d.json', '/home/me/ws')).toBeNull();
    expect(relativeToRoot('D:\\other\\a.json', 'C:\\work')).toBeNull();
    // POSIX paths keep their case.
    expect(relativeToRoot('/Home/me/ws/a.json', '/home/me/ws')).toBeNull();
    expect(relativeToRoot('/', '/')).toBe('');
    expect(relativeToRoot('/a.json', '/')).toBe('a.json');
  });

  it('compares paths like the file system does', () => {
    expect(samePath('C:\\Work\\a.json', 'c:/work/a.json')).toBe(true);
    expect(samePath('/a/b.json', '/a/B.json')).toBe(false);
    expect(samePath('', '')).toBe(false);
    expect(samePath(null, '/a')).toBe(false);
  });

  it('splits and joins root-relative paths', () => {
    expect(normalizeSlashes('a\\b\\')).toBe('a/b');
    expect(normalizeSlashes('C:\\')).toBe('C:/');
    expect(baseName('C:\\a\\b\\hero.r2d.json')).toBe('hero.r2d.json');
    expect(baseName('hero.r2d.json')).toBe('hero.r2d.json');
    expect(dirOf('a/b/c.json')).toBe('a/b');
    expect(dirOf('c.json')).toBe('');
    expect(parentDir('a/b')).toBe('a');
    expect(parentDir('a')).toBe('');
    expect(parentDir('')).toBeNull();
    expect(joinPath('', 'x.json')).toBe('x.json');
    expect(joinPath('a/b', 'x.json')).toBe('a/b/x.json');
    expect(joinPath('a', 'sub/x.json')).toBe('a/sub/x.json');
  });

  it('builds breadcrumbs from the root', () => {
    expect(breadcrumbs('', 'ws')).toEqual([{ label: 'ws', path: '' }]);
    expect(breadcrumbs('chars/heroes', 'ws')).toEqual([
      { label: 'ws', path: '' },
      { label: 'chars', path: 'chars' },
      { label: 'heroes', path: 'chars/heroes' },
    ]);
    expect(rootLabel('C:\\Users\\me\\models\\')).toBe('models');
    expect(rootLabel('/')).toBe('/');
    expect(rootLabel(null)).toBe('Workspace');
  });
});

describe('file names', () => {
  it('derives model file names', () => {
    expect(slugify('My Hero!')).toBe('my-hero');
    expect(slugify('Café  Robot 2')).toBe('cafe-robot-2');
    expect(slugify('***')).toBe('untitled');
    // Hangul and other scripts keep their composed (NFC) form: the file name is what the user typed.
    expect(slugify('잉어 모델')).toBe('잉어-모델');
    expect(slugify('ｈｅｒｏ　１')).toBe('hero-1');
    expect(modelFileName('hero')).toBe('hero.r2d.json');
    expect(modelFileName(' hero.r2d ')).toBe('hero.r2d.json');
    expect(modelFileName('hero.json')).toBe('hero.json');
    expect(modelFileName('')).toBe('');
    expect(copyName('C:\\ws\\hero.r2d.json')).toBe('hero-copy.r2d.json');
    expect(copyName('plain.json')).toBe('plain-copy.json');
  });

  it('explains names that cannot be used', () => {
    expect(fileNameProblem('hero.r2d.json')).toBeNull();
    expect(fileNameProblem('poses/idle.r2d.json')).toBeNull();
    expect(fileNameProblem('')).toMatch(/Enter a file name/);
    expect(fileNameProblem('a\\b.json')).toMatch(/Use "\/"/);
    expect(fileNameProblem('/abs.json')).toMatch(/relative/);
    expect(fileNameProblem('../up.json')).toMatch(/"\.\."/);
    expect(fileNameProblem('a//b.json')).toMatch(/empty folder/);
    expect(fileNameProblem('what?.json')).toMatch(/cannot contain/);
    expect(fileNameProblem('CON.json')).toMatch(/reserved/);
    expect(fileNameProblem('dir./a.json')).toMatch(/dot or a space/);
    expect(fileNameProblem('hero.txt')).toMatch(/\.json/);
  });

  it('finds a free name', () => {
    expect(uniqueFileName('hero.r2d.json', ['other.json'])).toBe('hero.r2d.json');
    expect(uniqueFileName('hero.r2d.json', ['HERO.r2d.json', 'hero-2.r2d.json'])).toBe('hero-3.r2d.json');
    expect(uniqueFileName('x.json', ['x.json'])).toBe('x-2.json');
  });
});

describe('listings', () => {
  const entry = (name: string, type: FileEntry['type']): FileEntry => ({ name, path: `d/${name}`, type, size: 10, mtimeMs: 1 });
  const entries = [entry('zeta.r2d.json', 'model'), entry('b.png', 'image'), entry('Alpha', 'dir'), entry('notes.json', 'other'), entry('beta', 'dir'), entry('a.r2d.json', 'model')];

  it('lists folders, then models, then other JSON files; hides images', () => {
    expect(visibleEntries(entries).map((e) => e.name)).toEqual(['Alpha', 'beta', 'a.r2d.json', 'zeta.r2d.json', 'notes.json']);
    expect(visibleEntries(entries, 'A').map((e) => e.name)).toEqual(['Alpha', 'beta', 'a.r2d.json', 'zeta.r2d.json']);
    expect(visibleEntries(entries, 'notes').map((e) => e.name)).toEqual(['notes.json']);
    expect(isOpenable(entry('x.r2d.json', 'model'))).toBe(true);
    expect(isOpenable(entry('x.json', 'other'))).toBe(true);
    expect(isOpenable(entry('x.png', 'image'))).toBe(false);
    expect(isOpenable(entry('x', 'dir'))).toBe(false);
  });

  it('moves the highlight with navigation keys', () => {
    expect(moveHighlight(-1, 'ArrowDown', 5)).toBe(0);
    expect(moveHighlight(-1, 'ArrowUp', 5)).toBe(4);
    expect(moveHighlight(4, 'ArrowDown', 5)).toBe(4);
    expect(moveHighlight(0, 'ArrowUp', 5)).toBe(0);
    expect(moveHighlight(2, 'Home', 5)).toBe(0);
    expect(moveHighlight(2, 'End', 5)).toBe(4);
    expect(moveHighlight(1, 'PageDown', 20)).toBe(9);
    expect(moveHighlight(3, 'PageUp', 20)).toBe(0);
    expect(moveHighlight(0, 'Enter', 5)).toBeNull();
    expect(moveHighlight(0, 'ArrowDown', 0)).toBeNull();
  });

  it('formats sizes and times', () => {
    expect(formatSize(812)).toBe('812 B');
    expect(formatSize(12_700)).toBe('12 KB');
    expect(formatSize(2_048)).toBe('2.0 KB');
    expect(formatSize(3.5 * 1024 * 1024)).toBe('3.5 MB');
    const now = new Date(2026, 8, 26, 15, 30).getTime();
    expect(formatWhen(now - 10_000, now)).toBe('just now');
    expect(formatWhen(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(formatWhen(now - 3 * 3_600_000, now)).toBe('3 h ago');
    expect(formatWhen(new Date(2026, 8, 26, 8, 5).getTime(), now)).toBe('today 08:05');
    expect(formatWhen(new Date(2026, 8, 25, 22, 1).getTime(), now)).toBe('yesterday 22:01');
    expect(formatWhen(new Date(2026, 0, 2, 9, 0).getTime(), now)).toBe('2026-01-02 09:00');
    expect(formatWhen(0, now)).toBe('');
  });
});

describe('unsaved-changes guard', () => {
  const run = (events: GuardEvent[], start: GuardState = GUARD_IDLE) => {
    let state = start;
    const effects: Array<string | null> = [];
    for (const ev of events) {
      const r = guardStep(state, ev);
      state = r.state;
      effects.push(r.effect);
    }
    return { state, effects };
  };
  const ask: GuardEvent = { type: 'request', dirty: true, file: 'hero.r2d.json', action: 'open blob.r2d.json' };

  it('lets a saved document through', () => {
    expect(run([{ type: 'request', dirty: false, file: 'x', action: 'close it' }])).toEqual({ state: GUARD_IDLE, effects: ['proceed'] });
  });

  it('asks for an unsaved one: cancel aborts, don\'t save proceeds', () => {
    const asked = run([ask]);
    expect(asked.state).toEqual({ phase: 'asking', file: 'hero.r2d.json', action: 'open blob.r2d.json', error: null, canForce: false });
    expect(asked.effects).toEqual([null]);
    expect(run([ask, { type: 'choose', choice: 'cancel' }])).toEqual({ state: GUARD_IDLE, effects: [null, 'abort'] });
    expect(run([ask, { type: 'choose', choice: 'discard' }])).toEqual({ state: GUARD_IDLE, effects: [null, 'proceed'] });
  });

  it('saves first, proceeding once the write succeeded', () => {
    const r = run([ask, { type: 'choose', choice: 'save' }, { type: 'saved', ok: true }]);
    expect(r).toEqual({ state: GUARD_IDLE, effects: [null, 'save', 'proceed'] });
  });

  it('keeps asking when the save fails, offering a forced save only for a rejected (invalid) model', () => {
    const failed = run([ask, { type: 'choose', choice: 'save' }, { type: 'saved', ok: false, error: 'offline' }]);
    expect(failed.state).toMatchObject({ phase: 'asking', error: 'offline', canForce: false });
    // "Save anyway" is ignored when not offered.
    expect(guardStep(failed.state, { type: 'choose', choice: 'saveAnyway' })).toEqual({ state: failed.state, effect: null });

    const invalid = run([ask, { type: 'choose', choice: 'save' }, { type: 'saved', ok: false, error: '2 errors', invalid: true }]);
    expect(invalid.state).toMatchObject({ phase: 'asking', canForce: true });
    const forced = run([{ type: 'choose', choice: 'saveAnyway' }, { type: 'saved', ok: false, error: 'disk full', invalid: true }], invalid.state);
    expect(forced.effects).toEqual(['saveAnyway', null]);
    // A forced write that failed is not offered again.
    expect(forced.state).toMatchObject({ phase: 'asking', error: 'disk full', canForce: false });
  });

  it('handles one prompt at a time and ignores stray events', () => {
    const asked = run([ask]).state;
    expect(guardStep(asked, { ...ask, action: 'close it' })).toEqual({ state: asked, effect: 'abort' });
    const saving = guardStep(asked, { type: 'choose', choice: 'save' }).state;
    expect(guardStep(saving, { type: 'choose', choice: 'cancel' })).toEqual({ state: saving, effect: null });
    expect(guardStep(GUARD_IDLE, { type: 'saved', ok: true })).toEqual({ state: GUARD_IDLE, effect: null });
    expect(guardStep(GUARD_IDLE, { type: 'choose', choice: 'discard' })).toEqual({ state: GUARD_IDLE, effect: null });
  });
});

describe('import from computer', () => {
  it('takes one model and its PNGs, skipping other files', () => {
    const plan = planImport([
      { name: 'koi.r2d.json', size: 100 },
      { name: 'atlas.PNG', size: 200 },
      { name: 'readme.txt', size: 5 },
    ]);
    expect(plan).toEqual({ model: 'koi.r2d.json', textures: ['atlas.PNG'], atlases: [], skipped: ['readme.txt'], totalBytes: 300, error: null });
    // A Spine export: the skeleton .json, its atlas and pages.
    expect(planImport([{ name: 'hero.json', size: 10 }, { name: 'hero.atlas', size: 5 }, { name: 'hero.png', size: 20 }])).toMatchObject({
      model: 'hero.json',
      atlases: ['hero.atlas'],
      textures: ['hero.png'],
      totalBytes: 35,
      error: null,
    });
    expect(planImport([{ name: 'a.png', size: 1 }]).error).toMatch(/Pick a model file/);
    // JSONC models (comments allowed) import like JSON ones.
    expect(planImport([{ name: 'hero.r2d.jsonc', size: 1 }])).toMatchObject({ model: 'hero.r2d.jsonc', error: null });
    expect(planImport([{ name: 'a.json', size: 1 }, { name: 'b.json', size: 1 }]).error).toMatch(/one model file at a time.*a\.json, b\.json/);
    expect(planImport([{ name: 'a.json', size: MAX_IMPORT_BYTES + 1 }]).error).toMatch(/too large/);
  });

  it('checks that the JSON is a Rev2D model', () => {
    expect(modelTextProblem('{"format": "rev2d", "version": 1}')).toBeNull();
    expect(modelTextProblem('\ufeff{ // comment\n"format": "rev2d"}')).toBeNull();
    expect(modelTextProblem('{"format": "other"}')).toMatch(/not a Rev2D model/);
    expect(modelTextProblem('[1, 2]')).toMatch(/JSON object/);
    expect(modelTextProblem('{nope')).toMatch(/not valid JSON/);
    // A Spine skeleton export is converted by the server.
    expect(modelTextProblem('{"skeleton": {"spine": "4.2.22"}, "bones": [{"name": "root"}]}')).toBeNull();
    expect(jsonKind('hero.json', '{"skeleton": {}, "bones": [{"name": "root"}]}')).toBe('spine');
    expect(jsonKind('m.json', '{"format": "rev2d"}')).toBe('rev2d');
    expect(jsonKind('idle.motion3.json', '{nope')).toBe('live2d-motion3');
    expect(jsonKind('x.json', '{"a": 1}')).toBeNull();
  });

  it('compares the pages a Spine atlas names with the picked PNGs', () => {
    const atlas = ['hero.png', 'size: 64, 32', 'head', 'bounds: 0, 0, 8, 8', '', 'hero_2.png', 'size: 8, 8', 'hand', 'bounds: 0, 0, 4, 4', ''].join('\n');
    expect(spinePageCheck([atlas], ['HERO.png', 'other.png'])).toEqual({ pages: ['hero.png', 'hero_2.png'], missing: ['hero_2.png'], unused: ['other.png'] });
    expect(spinePageCheck([], ['a.png'])).toEqual({ pages: [], missing: [], unused: ['a.png'] });
  });

  it('plans a Live2D import from the picked file names', () => {
    const plan = planLive2d([
      { name: 'idle.motion3.json', size: 10 },
      { name: 'F01.exp3.json', size: 5 },
      { name: 'readme.txt', size: 1 },
    ]);
    expect(plan.importable).toBe(2);
    expect(plan.error).toBeNull();
    expect(plan.files.map((f) => f.format)).toEqual(['live2d-motion3', 'live2d-exp3', null]);
    expect(planLive2d([{ name: 'a.json', size: 1 }]).error).toMatch(/Pick Live2D files/);
    // Live2D files picked for "Import from computer" (no model open) explain where they go.
    expect(planImport([{ name: 'idle.motion3.json', size: 1 }, { name: 'tap.motion3.json', size: 1 }]).error).toMatch(/Live2D files: they are imported into an open model/);
    expect(planLive2d([{ name: 'a.model3.json', size: 1 }, { name: 'b.model3.json', size: 1 }]).error).toMatch(/one \.model3\.json at a time/);
  });

  it('compares the textures a model uses with the picked PNGs', () => {
    const model = JSON.stringify({ format: 'rev2d', textures: [{ id: 'a', path: 'tex/atlas.png' }, { id: 'b', path: 'pin.png' }, { id: 'c', path: 'data:image/png;base64,AAAA' }] });
    expect(textureCheck(model, ['ATLAS.png', 'extra.png'])).toEqual({ referenced: ['tex/atlas.png', 'pin.png'], missing: ['pin.png'], unused: ['extra.png'] });
    expect(textureCheck('{', [])).toEqual({ referenced: [], missing: [], unused: [] });
  });

  it('places picked PNGs where the model references them (a file picker gives bare names)', () => {
    const model = JSON.stringify({
      format: 'rev2d',
      textures: [
        { id: 'a', path: 'textures/atlas.png' },
        { id: 'b', path: './textures\\sub/pin.png' },
        { id: 'c', path: 'flat.png' },
        { id: 'd', path: '../outside/up.png' },
        { id: 'e', path: 'C:/abs/abs.png' },
        { id: 'f', path: '/abs2.png' },
      ],
    });
    expect(texturePlacement(model, ['ATLAS.png', 'pin.png', 'flat.png', 'up.png', 'abs.png', 'abs2.png', 'extra.png'])).toEqual({
      'ATLAS.png': 'textures/atlas.png',
      'pin.png': 'textures/sub/pin.png',
    });
    expect(texturePlacement('{', ['a.png'])).toEqual({});
  });

  it('encodes binary data as base64, also beyond one chunk', () => {
    expect(toBase64(new Uint8Array([137, 80, 78, 71]))).toBe('iVBORw==');
    const big = new Uint8Array(100_000).map((_, i) => i % 256);
    expect(Buffer.from(toBase64(big), 'base64').equals(Buffer.from(big))).toBe(true);
  });
});

describe('file shortcuts', () => {
  const key = (k: string, mods: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey', boolean>> = {}, code?: string) => ({
    key: k,
    code,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  });

  it('maps key presses to file commands', () => {
    expect(fileShortcut(key('s', { ctrlKey: true }))).toBe('save');
    expect(fileShortcut(key('S', { ctrlKey: true, shiftKey: true }))).toBe('saveAs');
    expect(fileShortcut(key('s', { metaKey: true, shiftKey: true }))).toBe('saveAs');
    expect(fileShortcut(key('o', { ctrlKey: true }))).toBe('open');
    expect(fileShortcut(key('n', { altKey: true }))).toBe('new');
    // Option+N on a Mac types a dead key: the physical key still counts.
    expect(fileShortcut(key('Dead', { altKey: true }, 'KeyN'))).toBe('new');
    // Where the browser passes Ctrl+N through (installed app windows).
    expect(fileShortcut(key('n', { ctrlKey: true }))).toBe('new');
    expect(fileShortcut(key('n'))).toBeNull();
    expect(fileShortcut(key('o'))).toBeNull();
    expect(fileShortcut(key('s', { ctrlKey: true, altKey: true }))).toBeNull();
    expect(fileShortcut(key('n', { ctrlKey: true, altKey: true }))).toBeNull();
  });

  it('shows shortcuts the browser actually delivers', () => {
    expect(FILE_SHORTCUTS.new).toBe('Alt+N');
    expect(Object.values(FILE_SHORTCUTS)).not.toContain('Ctrl+N');
  });
});

describe('file operation messages and templates', () => {
  it('uses the server note as the headline when it says the same thing in more detail', () => {
    expect(summarizeNotes('Created hero.r2d.json', ['created hero.r2d.json from template "hana"', 'copied textures: a.png'])).toEqual({
      text: 'Created hero.r2d.json from template "hana"',
      details: ['copied textures: a.png'],
    });
    expect(summarizeNotes('Saved as b.r2d.json', ['texture "a": path "a.png" rewritten to "../a.png"'])).toEqual({
      text: 'Saved as b.r2d.json',
      details: ['texture "a": path "a.png" rewritten to "../a.png"'],
    });
    expect(summarizeNotes('Opened x.r2d.json', [])).toEqual({ text: 'Opened x.r2d.json', details: [] });
  });

  it('presents templates with titles, thumbnails and short descriptions', () => {
    expect(templateTitle('robot-arm')).toBe('Robot arm');
    expect(templateTitle('my_custom-thing')).toBe('My custom thing');
    expect(typeof templateThumbnail('hana')).toBe('string');
    expect(templateThumbnail('empty')).toBeNull();
    expect(shortDescription('First sentence. Second one.')).toBe('First sentence.');
    expect(shortDescription('x'.repeat(200), 20)).toBe(`${'x'.repeat(19)}…`);
  });
});
