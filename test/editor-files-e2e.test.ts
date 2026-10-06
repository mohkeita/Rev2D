/**
 * End-to-end test of the editor's file management: the real editor server started WITHOUT a model
 * on a temporary workspace root, the built UI (dist/editor) in headless Chrome.
 *
 *   start screen -> New from the "minimal" example -> inspector edit -> Save As into a subfolder ->
 *   Close -> Open Recent -> Open dialog (keyboard) -> an AI opens a file -> Import a model + PNGs
 *   from the computer -> unsaved-changes guard (Cancel, then Save) when opening a file while dirty.
 *
 * Screenshots of the steps go to out/editor-files-*.png (1440x900, the main screens also 1024x640).
 *
 * Skips (with the reason logged) when the UI is not built (`npm run editor:build`), the server has
 * no workspace API, or Chrome cannot be launched.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PACKAGE_ROOT } from '../src/api/templates.js';
import type { EditorServer } from '../src/server/index.js';

const DIST_INDEX = path.join(PACKAGE_ROOT, 'dist', 'editor', 'index.html');
const SHOTS = path.join(PACKAGE_ROOT, 'out');

interface Env {
  server: EditorServer;
  browser: Browser;
  /** Workspace root (temp). */
  root: string;
  /** Folder outside the root with the files "picked on the computer" for the import. */
  outside: string;
}

async function setup(): Promise<Env | string> {
  if (!existsSync(DIST_INDEX)) return `no built editor UI at ${DIST_INDEX} (run \`npm run editor:build\`)`;
  const root = mkdtempSync(path.join(os.tmpdir(), 'rev2d-files-e2e-'));
  const outside = mkdtempSync(path.join(os.tmpdir(), 'rev2d-files-pick-'));
  mkdirSync(path.join(root, 'characters'));
  for (const f of ['textured.r2d.json', 'koi-atlas.png', 'pinwheel.png']) {
    copyFileSync(path.join(PACKAGE_ROOT, 'examples', 'textured', f), path.join(outside, f === 'textured.r2d.json' ? 'koi.r2d.json' : f));
  }
  const cleanup = () => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  };
  let server: EditorServer;
  try {
    const { startEditorServer } = await import('../src/server/index.js');
    // No `file`: the server starts with no model open. recentFile null keeps ~/.rev2d untouched.
    const opts = { root, port: 0, register: false, devVite: false, recentFile: null, log: () => {} };
    server = await startEditorServer(opts as Parameters<typeof startEditorServer>[0]);
  } catch (e) {
    cleanup();
    return `editor server unavailable: ${(e as Error).message}`;
  }
  const ws = await fetch(`${server.url}/api/workspace`).catch(() => null);
  if (!ws?.ok) {
    await server.close();
    cleanup();
    return 'the editor server has no workspace API (GET /api/workspace)';
  }
  try {
    const browser = await chromium.launch({
      channel: 'chrome',
      headless: true,
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    });
    return { server, browser, root, outside };
  } catch (e) {
    await server.close();
    cleanup();
    return `cannot launch Chrome: ${(e as Error).message.split('\n')[0]}`;
  }
}

const env = await setup();
if (typeof env === 'string') console.warn(`[editor-files-e2e] skipped: ${env}`);
const ready = typeof env !== 'string';

afterAll(async () => {
  if (typeof env === 'string') return;
  // Chrome sometimes keeps running long after browser.close() on some machines (a bare about:blank
  // page too): wait a bounded time; the launcher kills the process when the worker exits.
  await Promise.race([env.browser.close(), new Promise((resolve) => setTimeout(resolve, 5000))]);
  await env.server.close();
  rmSync(env.root, { recursive: true, force: true });
  rmSync(env.outside, { recursive: true, force: true });
}, 30000);

const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();

describe.skipIf(!ready)('editor file management end to end (server without a model + built UI + Chrome)', () => {
  const e = env as Env;
  let page: Page;
  const pageErrors: string[] = [];

  const stats = () => page.evaluate(() => window.__rev2d!.stats());
  /** Wait until `rel` (root-relative) is open, compiled and drawn. */
  const waitOpen = async (rel: string) => {
    const want = norm(path.join(e.root, rel));
    await page.waitForFunction(
      (w) => {
        const s = window.__rev2d!.stats();
        return s.ready && s.file.replace(/\\/g, '/').toLowerCase() === w;
      },
      want,
      { timeout: 20000 },
    );
  };
  const shot = async (name: string) => {
    await page.waitForTimeout(250); // let dialog / toast animations settle
    await page.screenshot({ path: path.join(SHOTS, `editor-files-${name}.png`) });
  };
  /** The same screen at the small window size too. */
  const shotBoth = async (name: string) => {
    await shot(`${name}-1440x900`);
    await page.setViewportSize({ width: 1024, height: 640 });
    await shot(`${name}-1024x640`);
    await page.setViewportSize({ width: 1440, height: 900 });
  };
  /**
   * Take the focus out of whatever has it, like a click on the empty canvas (which is full-bleed under
   * the floating chrome now, so there is no corner that is free at every window size).
   */
  const leaveFields = () => page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
  const menu = async (item: string) => {
    await page.click('[data-testid=file-menu-button]');
    await page.locator('[data-testid=file-menu]').waitFor();
    await page.click(`[data-testid=menu-${item}]`);
  };

  beforeAll(async () => {
    mkdirSync(SHOTS, { recursive: true });
    // The editor follows the browser's language: pin it, the assertions below read English labels.
    page = await e.browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
    page.on('pageerror', (err) => pageErrors.push(err.message));
    await page.goto(e.server.url);
  }, 60000);

  afterAll(async () => {
    await page?.close();
  });

  it('shows the start screen when no model is open', async () => {
    await page.locator('[data-testid=start-screen]').waitFor({ timeout: 20000 });
    expect((await stats()).status).toBe('empty');
    expect(await page.title()).toBe('Rev2D');
    // The five shipped examples are offered as cards; New / Open / Import are there.
    for (const name of ['hana', 'robot-arm', 'slime', 'textured', 'minimal']) {
      await page.locator(`[data-testid=example-${name}]`).waitFor();
    }
    for (const id of ['start-new', 'start-open', 'start-import']) expect(await page.locator(`[data-testid=${id}]`).isVisible()).toBe(true);
    await shotBoth('start');
    await page.click('[data-testid=file-menu-button]');
    await page.locator('[data-testid=file-menu]').waitFor();
    // Model commands are disabled while nothing is open.
    expect(await page.getAttribute('[data-testid=menu-save-as]', 'aria-disabled')).toBe('true');
    expect(await page.getAttribute('[data-testid=menu-new]', 'aria-disabled')).toBeNull();
    await shot('menu-empty-1440x900');
    await page.keyboard.press('Escape');
    await page.locator('[data-testid=file-menu]').waitFor({ state: 'detached' });
  });

  it('works from the keyboard: Alt+N, the File menu, Esc returns the focus', async () => {
    await page.keyboard.press('Alt+n');
    await page.locator('[data-testid=new-dialog]').waitFor();
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('new-name');
    await page.keyboard.press('Escape');
    await page.locator('[data-testid=new-dialog]').waitFor({ state: 'detached' });

    // Menu button: Enter opens with the first item focused, arrows move, Enter activates.
    await page.focus('[data-testid=file-menu-button]');
    await page.keyboard.press('Enter');
    await page.locator('[data-testid=file-menu]').waitFor();
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('menu-new');
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('menu-open');
    await page.keyboard.press('Enter');
    await page.locator('[data-testid=open-dialog]').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('[data-testid=open-dialog]').waitFor({ state: 'detached' });
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('file-menu-button');

    // The shortcut sheet lists the file shortcuts.
    await leaveFields();
    await page.keyboard.press('?');
    await page.locator('[data-testid=shortcuts-dialog]').waitFor();
    // "Alt" and "N" are separate key caps: compare without spacing and "+".
    expect(((await page.textContent('[data-testid=shortcuts-dialog]')) ?? '').replace(/[\s+]/g, '')).toContain('AltN');
    await shotBoth('shortcuts');
    await page.keyboard.press('Escape');
    await page.locator('[data-testid=shortcuts-dialog]').waitFor({ state: 'detached' });

    // With the menu open, a file shortcut it lists runs that command (not a jump to a letter).
    await page.click('[data-testid=file-menu-button]');
    await page.locator('[data-testid=file-menu]').waitFor();
    await page.keyboard.press('Control+o');
    await page.locator('[data-testid=file-menu]').waitFor({ state: 'detached' });
    await page.locator('[data-testid=open-dialog]').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('[data-testid=open-dialog]').waitFor({ state: 'detached' });
  });

  it('creates a model from an example as a copy (New dialog)', async () => {
    const example = path.join(PACKAGE_ROOT, 'examples', 'minimal', 'minimal.r2d.json');
    const before = sha(example);
    await page.click('[data-testid=example-minimal]');
    await page.locator('[data-testid=new-dialog]').waitFor();
    expect(await page.getAttribute('[data-testid=template-minimal]', 'aria-checked')).toBe('true');
    expect(await page.inputValue('[data-testid=new-name]')).toBe('minimal');
    expect(await page.inputValue('[data-testid=new-file]')).toBe('minimal.r2d.json');
    // The name field has focus with its text selected: typing replaces it and renames the file.
    await page.keyboard.type('Blob');
    expect(await page.inputValue('[data-testid=new-file]')).toBe('blob.r2d.json');
    await shotBoth('new');
    await page.keyboard.press('Enter');
    await waitOpen('blob.r2d.json');
    await page.locator('[data-testid=new-dialog]').waitFor({ state: 'detached' });
    expect(existsSync(path.join(e.root, 'blob.r2d.json'))).toBe(true);
    expect(JSON.parse(readFileSync(path.join(e.root, 'blob.r2d.json'), 'utf8')).meta.name).toBe('Blob');
    expect(sha(example)).toBe(before);
    expect(await page.title()).toBe('blob.r2d.json • Rev2D');
    // (The status reads "Creating…" until the operation has also refreshed the workspace.)
    await expect.poll(() => page.textContent('[data-testid=status-file]')).toContain('blob.r2d.json');
  });

  it('writes an inspector edit, then saves as a copy in a subfolder (Save As)', async () => {
    const blob = path.join(e.root, 'blob.r2d.json');
    await page.evaluate(() => window.__rev2d!.session.handleCommand({ type: 'select', ids: ['part:eye'] }));
    const editor = page.locator('[data-testid=inspector-json]');
    await expect.poll(() => editor.inputValue(), { timeout: 5000 }).toContain('"id": "eye"');
    await editor.fill((await editor.inputValue()).replace('"#14432f"', '"#ff0000"'));
    await page.click('[data-testid=inspector-apply]');
    await expect.poll(() => readFileSync(blob, 'utf8').includes('#ff0000'), { timeout: 5000 }).toBe(true);
    await shotBoth('editor');
    await page.click('[data-testid=file-menu-button]');
    await page.locator('[data-testid=file-menu]').waitFor();
    await shot('menu-open-1440x900');
    await page.keyboard.press('Escape');

    await leaveFields();
    await page.keyboard.press('Control+Shift+S');
    await page.locator('[data-testid=save-as-dialog]').waitFor();
    expect(await page.inputValue('[data-testid=save-as-name]')).toBe('blob-copy.r2d.json');
    await page.dblclick('[data-testid=fb-row][data-path=characters]');
    await page.locator('[data-testid=fb-crumb-1]', { hasText: 'characters' }).waitFor();
    await page.fill('[data-testid=save-as-name]', 'blob-final');
    await shotBoth('save-as');
    await page.click('[data-testid=save-as-confirm]');
    await waitOpen('characters/blob-final.r2d.json');
    const saved = path.join(e.root, 'characters', 'blob-final.r2d.json');
    expect(readFileSync(saved, 'utf8')).toContain('#ff0000');
    await expect.poll(() => page.textContent('[data-testid=status-file]')).toContain('characters/blob-final.r2d.json');
  });

  it('downloads a copy of the model and a PNG of the view', async () => {
    const [copy] = await Promise.all([page.waitForEvent('download'), menu('download')]);
    expect(copy.suggestedFilename()).toBe('blob-final.r2d.json');
    const copyPath = path.join(e.outside, 'download.json');
    await copy.saveAs(copyPath);
    expect(readFileSync(copyPath, 'utf8')).toBe(readFileSync(path.join(e.root, 'characters', 'blob-final.r2d.json'), 'utf8'));

    const [png] = await Promise.all([page.waitForEvent('download'), menu('export')]);
    expect(png.suggestedFilename()).toBe('blob-final.png');
    const pngPath = path.join(e.outside, 'view.png');
    await png.saveAs(pngPath);
    expect(readFileSync(pngPath).subarray(1, 4).toString()).toBe('PNG');
  });

  it('closes the model and reopens it from Open Recent', async () => {
    await menu('close');
    await page.locator('[data-testid=start-screen]').waitFor();
    await page.locator('[data-testid=start-recent-item]', { hasText: 'blob-final.r2d.json' }).waitFor();
    await shot('start-recent-1440x900');

    await page.click('[data-testid=file-menu-button]');
    await page.hover('[data-testid=menu-recent]');
    await page.locator('[data-testid=recent-menu]').waitFor();
    await shot('menu-recent-1440x900');
    await page.click('[data-testid=menu-recent-item]:has-text("blob-final.r2d.json")');
    await waitOpen('characters/blob-final.r2d.json');
  });

  it('opens a file with the Open dialog from the keyboard', async () => {
    await leaveFields();
    await page.keyboard.press('Control+o');
    await page.locator('[data-testid=open-dialog]').waitFor();
    // It starts in the open model's folder; Backspace goes up to the root.
    await page.locator('[data-testid=fb-row][data-path="characters/blob-final.r2d.json"]').waitFor();
    // While the root is still loading, keys must not act on the rows of the folder just left.
    let release: () => void = () => undefined;
    const slow = new Promise<void>((r) => (release = r));
    const rootListing = (u: URL) => u.pathname === '/api/files' && (u.searchParams.get('dir') ?? '') === '';
    await page.route(rootListing, async (route) => {
      await slow;
      await route.continue();
    });
    await page.keyboard.press('Backspace');
    await page.locator('[data-testid=fb-crumb-1]').waitFor({ state: 'detached' });
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    expect(await page.locator('[data-testid=fb-row][data-path="characters/blob-final.r2d.json"]').count()).toBe(0);
    release();
    await page.locator('[data-testid=fb-row][data-path="blob.r2d.json"]').waitFor();
    await page.unroute(rootListing);
    expect(await page.locator('[data-testid=open-dialog]').isVisible()).toBe(true);
    await page.fill('[data-testid=fb-filter]', '');
    await page.keyboard.type('blob');
    await page.keyboard.press('ArrowDown');
    expect(await page.getAttribute('[data-testid=fb-row][data-path="blob.r2d.json"]', 'aria-selected')).toBe('true');
    await shotBoth('open');
    await page.keyboard.press('Enter');
    await waitOpen('blob.r2d.json');
    await page.locator('[data-testid=open-dialog]').waitFor({ state: 'detached' });
  });

  it('follows a model opened by an AI (file-changed)', async () => {
    const res = await fetch(`${e.server.url}/api/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'open', file: 'characters/blob-final.r2d.json' }),
    });
    expect(res.status).toBe(200);
    await waitOpen('characters/blob-final.r2d.json');
    // "AI" badge + "opened <file>".
    const toast = page.locator('[data-testid=toast]', { has: page.locator('[data-testid=toast-source]', { hasText: 'AI' }), hasText: 'opened characters/blob-final.r2d.json' });
    await toast.waitFor({ timeout: 5000 });
  });

  it('answers a replace question with Esc without losing the dialog; Ctrl+S stays in the dialog', async () => {
    const blob = path.join(e.root, 'blob.r2d.json');
    const before = readFileSync(blob, 'utf8');
    await leaveFields();
    await page.keyboard.press('Control+Shift+S');
    await page.locator('[data-testid=save-as-dialog]').waitFor();
    await page.click('[data-testid=fb-crumb-0]');
    await page.locator('[data-testid=fb-row][data-path="blob.r2d.json"]').waitFor();
    await page.fill('[data-testid=save-as-name]', 'blob');
    await page.keyboard.press('Enter');
    // The question is an alert on top of the dialog: it names the file and Cancel has the focus.
    await page.locator('[data-testid=replace-confirm]').waitFor();
    expect(await page.textContent('[data-testid=replace-confirm]')).toContain('blob.r2d.json');
    expect(await page.getAttribute('[data-testid=replace-confirm] [role=alertdialog]', 'aria-modal')).toBe('true');
    await page.keyboard.press('Escape');
    await page.locator('[data-testid=replace-confirm]').waitFor({ state: 'detached' });
    expect(await page.locator('[data-testid=save-as-dialog]').isVisible()).toBe(true);
    expect(await page.inputValue('[data-testid=save-as-name]')).toBe('blob');
    // The browser's own "save page" must not open over the dialog.
    const prevented = await page.evaluate(() => {
      const ev = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true });
      document.querySelector('[data-testid=save-as-name]')!.dispatchEvent(ev);
      return ev.defaultPrevented;
    });
    expect(prevented).toBe(true);
    await page.keyboard.press('Escape');
    await page.locator('[data-testid=save-as-dialog]').waitFor({ state: 'detached' });
    expect(readFileSync(blob, 'utf8')).toBe(before);
  });

  it('opens the import dialog for files dropped on the window', async () => {
    const dt = await page.evaluateHandle(() => {
      const t = new DataTransfer();
      t.items.add(new File(['{"format": "rev2d", "version": 1, "meta": {"name": "d", "width": 8, "height": 8}}'], 'dropped.r2d.json', { type: 'application/json' }));
      return t;
    });
    await page.dispatchEvent('[data-testid=viewport]', 'dragenter', { dataTransfer: dt });
    await page.locator('[data-testid=drop-overlay]').waitFor();
    await page.dispatchEvent('[data-testid=viewport]', 'drop', { dataTransfer: dt });
    await page.locator('[data-testid=import-dialog]').waitFor();
    expect(await page.textContent('[data-testid=import-files]')).toContain('dropped.r2d.json');
    await page.keyboard.press('Escape');
    await page.locator('[data-testid=import-dialog]').waitFor({ state: 'detached' });
    expect(existsSync(path.join(e.root, 'dropped.r2d.json'))).toBe(false);
  });

  it('imports a model with its PNG textures from the computer', async () => {
    await page.setInputFiles(
      '[data-testid=import-input]',
      ['koi.r2d.json', 'koi-atlas.png', 'pinwheel.png'].map((f) => path.join(e.outside, f)),
    );
    await page.locator('[data-testid=import-dialog]').waitFor();
    expect(await page.textContent('[data-testid=import-files]')).toContain('koi-atlas.png');
    // It proposes the open model's folder; import into the workspace root instead.
    await page.locator('[data-testid=fb-crumb-1]', { hasText: 'characters' }).waitFor();
    await page.click('[data-testid=fb-crumb-0]');
    await page.locator('[data-testid=fb-row][data-path=characters]').waitFor();
    await shotBoth('import');
    await page.click('[data-testid=import-confirm]');
    await waitOpen('koi.r2d.json');
    for (const f of ['koi.r2d.json', 'koi-atlas.png', 'pinwheel.png']) expect(existsSync(path.join(e.root, f))).toBe(true);
    const s = await stats();
    expect(s.errors).toBe(0);
    expect(s.draws).toBeGreaterThan(3);
    await shot('imported-1440x900');
  });

  it('asks before opening another file while an edit is not saved', async () => {
    const koi = path.join(e.root, 'koi.r2d.json');
    // The write fails (server unreachable for PUT): the edit stays local, unsaved.
    await page.route('**/api/model*', (route) => (route.request().method() === 'PUT' ? route.abort() : route.continue()));
    await page.evaluate(() => window.__rev2d!.session.handleCommand({ type: 'select', ids: ['part:pinwheelPin'] }));
    const editor = page.locator('[data-testid=inspector-json]');
    await expect.poll(() => editor.inputValue(), { timeout: 5000 }).toContain('"id": "pinwheelPin"');
    await editor.fill((await editor.inputValue()).replace('"#5a3a1c"', '"#00ff00"'));
    await page.click('[data-testid=inspector-apply]');
    await page.locator('[data-testid=unsaved-dot]').waitFor({ timeout: 5000 });
    expect(await page.title()).toBe('● koi.r2d.json • Rev2D');
    expect(await page.evaluate(() => window.__rev2d!.state().unsaved)).toBe(true);
    // Leaving the page would warn.
    expect(
      await page.evaluate(() => {
        const ev = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(ev);
        return ev.defaultPrevented;
      }),
    ).toBe(true);

    const openBlob = async () => {
      await page.keyboard.press('Control+o');
      await page.locator('[data-testid=open-dialog]').waitFor();
      await page.dblclick('[data-testid=fb-row][data-path="blob.r2d.json"]');
      await page.locator('[data-testid=unsaved-dialog]').waitFor();
    };

    // Cancel: nothing happens, the Open dialog is still there.
    await leaveFields();
    await openBlob();
    expect(await page.textContent('[data-testid=unsaved-dialog]')).toContain('Save changes to koi.r2d.json?');
    await shotBoth('unsaved');
    await page.click('[data-testid=unsaved-cancel]');
    await page.locator('[data-testid=unsaved-dialog]').waitFor({ state: 'detached' });
    await page.locator('[data-testid=open-dialog]').waitFor();
    expect(norm((await stats()).file)).toBe(norm(koi));

    // Save fails (still unreachable): the prompt says why and stays. The Save button was disabled
    // while saving, which drops the focus out of the dialog: Esc must still cancel it.
    await page.dblclick('[data-testid=fb-row][data-path="blob.r2d.json"]');
    await page.locator('[data-testid=unsaved-dialog]').waitFor();
    await page.click('[data-testid=unsaved-save]');
    await page.locator('[data-testid=unsaved-dialog] [data-testid=unsaved-error]').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('[data-testid=unsaved-dialog]').waitFor({ state: 'detached' });
    expect(norm((await stats()).file)).toBe(norm(koi));
    await page.keyboard.press('Escape');
    await page.locator('[data-testid=open-dialog]').waitFor({ state: 'detached' });

    // Save: the edit is written, then the other file opens.
    await page.unroute('**/api/model*');
    await openBlob();
    await page.click('[data-testid=unsaved-save]');
    await waitOpen('blob.r2d.json');
    expect(readFileSync(koi, 'utf8')).toContain('#00ff00');
    expect(await page.evaluate(() => window.__rev2d!.state().unsaved)).toBe(false);
    expect(pageErrors).toEqual([]);
  });

  it('keeps a model deleted on disk open as unsaved; Ctrl+S writes it back', async () => {
    const blob = path.join(e.root, 'blob.r2d.json');
    const text = readFileSync(blob, 'utf8');
    rmSync(blob);
    await page.locator('[data-testid=unsaved-dot]').waitFor({ timeout: 10000 });
    expect(await page.title()).toBe('● blob.r2d.json • Rev2D');
    await page.locator('[data-testid=toast]', { hasText: 'blob.r2d.json was deleted or moved on disk' }).waitFor();
    expect(await page.locator('[data-testid=toast]', { hasText: 'Reload failed' }).count()).toBe(0);
    await leaveFields();
    await page.keyboard.press('Control+s');
    const written = () => {
      try {
        return JSON.parse(readFileSync(blob, 'utf8'));
      } catch {
        return null; // not there yet, or still being written
      }
    };
    await expect.poll(written, { timeout: 5000 }).toEqual(JSON.parse(text));
    await page.locator('[data-testid=unsaved-dot]').waitFor({ state: 'detached' });
    expect(pageErrors).toEqual([]);
  });
});
