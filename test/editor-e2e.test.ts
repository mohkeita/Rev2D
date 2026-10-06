/**
 * End-to-end test of the web editor: the real editor server (src/server) serving the built UI
 * (dist/editor) to headless Chrome (WebGL2 via SwiftShader).
 *
 * Skips (with the reason logged) when the UI is not built (`npm run editor:build`), the server is
 * not available, or Chrome cannot be launched.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatModelJson } from '../src/core/format.js';
import { blankModel, PACKAGE_ROOT } from '../src/api/templates.js';
import { cropImage, decodePNG, diffImages } from '../src/render/index.js';
import type { EditorState } from '../src/node/editor-registry.js';
import type { EditorServer } from '../src/server/index.js';

const DIST_INDEX = path.join(PACKAGE_ROOT, 'dist', 'editor', 'index.html');

interface Env {
  server: EditorServer;
  browser: Browser;
  dir: string;
  file: string;
}

/** Start everything the test needs, or explain why it cannot run here. */
async function setup(): Promise<Env | string> {
  if (!existsSync(DIST_INDEX)) return `no built editor UI at ${DIST_INDEX} (run \`npm run editor:build\`)`;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rev2d-editor-e2e-'));
  const file = path.join(dir, 'model.r2d.json');
  writeFileSync(file, formatModelJson(blankModel({ name: 'e2e' })));
  let server: EditorServer;
  try {
    const { startEditorServer } = await import('../src/server/index.js');
    server = await startEditorServer({ file, port: 0, register: false, devVite: false, log: () => {} });
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    return `editor server unavailable: ${(e as Error).message}`;
  }
  try {
    const browser = await chromium.launch({
      channel: 'chrome',
      headless: true,
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    });
    return { server, browser, dir, file };
  } catch (e) {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
    return `cannot launch Chrome: ${(e as Error).message.split('\n')[0]}`;
  }
}

const env = await setup();
if (typeof env === 'string') console.warn(`[editor-e2e] skipped: ${env}`);
const ready = typeof env !== 'string';

afterAll(async () => {
  if (typeof env === 'string') return;
  // Chrome sometimes keeps running long after browser.close() on some machines (a bare about:blank
  // page too): wait a bounded time; the launcher kills the process when the worker exits.
  await Promise.race([env.browser.close(), new Promise((resolve) => setTimeout(resolve, 5000))]);
  await env.server.close();
  rmSync(env.dir, { recursive: true, force: true });
}, 30000);

async function api<T>(e: Env, pathname: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${e.server.url}${pathname}`, init);
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

async function command(e: Env, cmd: unknown): Promise<number> {
  const r = await api<{ delivered: number }>(e, '/api/command', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  expect(r.status).toBe(200);
  return r.body.delivered;
}

function stats(page: Page) {
  return page.evaluate(() => window.__rev2d!.stats());
}

/** The value of a parameter slider (the design system's slider: role="slider" on its knob). */
function sliderValue(page: Page, param: string): Promise<string | null> {
  return page.getAttribute(`[data-testid="param-slider-${param}"] [role=slider]`, 'aria-valuenow');
}

/** Show a page of the trailing inspector: 'parameters' | 'selection' | 'problems'. */
async function showInspectorPage(page: Page, tab: string): Promise<void> {
  await page.click(`[data-testid=inspector-tabs] [data-value=${tab}]`);
}

/** Pixels of the blank model's blue body in the WebGL canvas (the workspace and backdrop are grey). */
async function bluePixels(page: Page): Promise<number> {
  const img = decodePNG(await page.locator('[data-testid=viewport-gl]').screenshot());
  let blue = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    const r = img.data[i];
    const b = img.data[i + 2];
    if (b > 150 && b > r + 60) blue++;
  }
  return blue;
}

describe.skipIf(!ready)('editor UI end to end (server + built UI + Chrome)', () => {
  const e = env as Env;
  let page: Page;
  const pageErrors: string[] = [];

  beforeAll(async () => {
    // The UI follows the browser's language: pin it, so the texts read below are the English ones.
    page = await e.browser.newPage({ viewport: { width: 1400, height: 900 }, locale: 'en-US' });
    page.on('pageerror', (err) => pageErrors.push(err.message));
    await page.goto(e.server.url);
    await page.waitForFunction(() => window.__rev2d?.stats().ready === true, null, { timeout: 30000 });
  }, 60000);

  afterAll(async () => {
    await page.close();
  });

  it('renders the model with WebGL (non-background pixels in the canvas)', async () => {
    const s = await stats(page);
    expect(s).toMatchObject({ ready: true, status: 'ready', errors: 0 });
    expect(s.draws).toBeGreaterThan(0);
    expect(s.triangles).toBeGreaterThan(10);
    // The blank model is a blue gradient body on a #20242c background inside the workspace.
    expect(await bluePixels(page)).toBeGreaterThan(2000);
    // The language was taken from the browser and the appearance follows the system by default.
    expect(await page.evaluate(() => [document.documentElement.lang, document.documentElement.getAttribute('data-appearance')])).toEqual(['en', 'auto']);
    await page.screenshot({ path: path.join(PACKAGE_ROOT, 'out', 'editor-e2e.png') }).catch(() => undefined);
  });

  it('redraws after the WebGL context is lost and restored', async () => {
    await page.evaluate(() => {
      const gl = document.querySelector<HTMLCanvasElement>('[data-testid=viewport-gl]')!.getContext('webgl2')!;
      const ext = gl.getExtension('WEBGL_lose_context')!;
      ext.loseContext();
      setTimeout(() => ext.restoreContext(), 100);
    });
    await expect.poll(() => bluePixels(page), { timeout: 5000 }).toBeGreaterThan(2000);
  });

  it('publishes the view state when a parameter slider moves', async () => {
    const slider = page.locator('[data-testid="param-slider-Lean"] [role=slider]');
    await slider.focus();
    await page.keyboard.press('End');
    await expect.poll(async () => (await api<{ params: Record<string, number> }>(e, '/api/state')).body?.params?.Lean, { timeout: 5000 }).toBe(1);
    const state = (await api<Record<string, unknown>>(e, '/api/state')).body;
    expect(state).toMatchObject({ playing: false, animations: [], file: e.server.file });
    expect(Array.isArray(state.viewBox)).toBe(true);
    // Arrow keys belong to the focused slider (not to the timeline's frame stepping).
    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => sliderValue(page, 'Lean'), { timeout: 5000 }).toBe('0.998');
    expect((await page.evaluate(() => window.__rev2d!.state())).time).toBe(0);
  });

  it('applies AI commands sent through POST /api/command', async () => {
    expect(await command(e, { type: 'setParams', params: { Squash: 0.5 } })).toBeGreaterThan(0);
    await expect.poll(() => sliderValue(page, 'Squash'), { timeout: 5000 }).toBe('0.5');
    await command(e, { type: 'select', ids: ['eye'] });
    await expect.poll(() => page.evaluate(() => window.__rev2d!.state().selection), { timeout: 5000 }).toEqual(['part:eye']);
    await expect.poll(async () => (await api<{ selection: string[] }>(e, '/api/state')).body.selection, { timeout: 5000 }).toEqual(['part:eye']);
    await command(e, { type: 'message', text: 'hello from the test' });
    const toast = page.locator('[data-testid=toast]', { hasText: 'hello from the test' });
    await toast.waitFor({ timeout: 5000 });
    // Messages sent through the bridge carry the "AI" caption.
    expect(await toast.locator('[data-testid=toast-source]').textContent()).toBe('AI');
    // An AI selection is shown: the trailing panel turned to the selection inspector.
    await page.locator('[data-testid=inspector-json]').waitFor({ state: 'visible', timeout: 5000 });
  });

  it('reloads when the model file changes on disk, keeping parameter values', async () => {
    const before = await stats(page);
    const doc = JSON.parse(readFileSync(e.file, 'utf8')) as { parameters: unknown[] };
    doc.parameters.push({ id: 'Extra', min: 0, max: 2, default: 1 });
    writeFileSync(e.file, formatModelJson(doc));
    await showInspectorPage(page, 'parameters');
    await page.locator('[data-testid="param-slider-Extra"]').waitFor({ state: 'visible', timeout: 10000 });
    const after = await stats(page);
    expect(after.modelVersion).toBeGreaterThan(before.modelVersion);
    expect(await sliderValue(page, 'Squash')).toBe('0.5');

    // A broken version keeps the last valid model on screen and says so.
    writeFileSync(e.file, readFileSync(e.file, 'utf8').replace('"parent": "bodyWarp"', '"parent": "missingWarp"'));
    await page.locator('[data-testid=stale-banner]').waitFor({ state: 'visible', timeout: 10000 });
    expect((await stats(page)).errors).toBeGreaterThan(0);
    writeFileSync(e.file, formatModelJson(doc));
    await page.locator('[data-testid=stale-banner]').waitFor({ state: 'hidden', timeout: 10000 });
  });

  it('writes inspector edits to the file and undoes them', async () => {
    await command(e, { type: 'select', ids: ['part:eye'] });
    const editor = page.locator('[data-testid=inspector-json]');
    await expect.poll(() => editor.inputValue(), { timeout: 5000 }).toContain('"id": "eye"');
    const text = await editor.inputValue();
    await editor.fill(text.replace('"#10325e"', '"#ff0000"'));
    await page.click('[data-testid=inspector-apply]');
    await expect.poll(() => readFileSync(e.file, 'utf8').includes('"#ff0000"'), { timeout: 5000 }).toBe(true);
    await page.locator('[data-testid=viewport]').hover();
    await page.keyboard.press('Control+z');
    await expect.poll(() => readFileSync(e.file, 'utf8').includes('"#ff0000"'), { timeout: 5000 }).toBe(false);
    expect(pageErrors).toEqual([]);
  });

  it('does not overwrite a change saved on disk meanwhile: reload or overwrite, as the user picks', async () => {
    await command(e, { type: 'select', ids: ['part:eye'] });
    const editor = page.locator('[data-testid=inspector-json]');
    await expect.poll(() => editor.inputValue(), { timeout: 5000 }).toContain('"id": "eye"');
    // Another program saves the file between the editor's last load and its write.
    const theirs = readFileSync(e.file, 'utf8').replace('"Lean the body left/right"', '"edited elsewhere"');
    let races = 0;
    await page.route('**/api/model*', async (route) => {
      if (route.request().method() === 'PUT' && races > 0) {
        races--;
        const before = statSync(e.file).mtimeMs;
        writeFileSync(e.file, theirs);
        utimesSync(e.file, new Date(), new Date(Math.floor(before) + 5000));
      }
      await route.continue();
    });
    try {
      const edit = async (color: string): Promise<void> => {
        await expect.poll(() => editor.inputValue(), { timeout: 5000 }).toContain('"fill": "#10325e"');
        await editor.fill((await editor.inputValue()).replace('"#10325e"', color));
        races = 1;
        await page.click('[data-testid=inspector-apply]');
        await page.locator('[data-testid=conflict-banner]').waitFor({ state: 'visible', timeout: 5000 });
        expect(readFileSync(e.file, 'utf8')).toBe(theirs);
      };

      // Reload: their version is shown, nothing is written.
      await edit('"#00ff00"');
      await page.click('[data-testid=conflict-reload]');
      await page.locator('[data-testid=conflict-banner]').waitFor({ state: 'hidden', timeout: 5000 });
      expect(readFileSync(e.file, 'utf8')).toBe(theirs);
      expect(await editor.inputValue()).toContain('"#10325e"');

      // Overwrite: the edit replaces their change on purpose.
      writeFileSync(e.file, readFileSync(e.file, 'utf8').replace('"edited elsewhere"', '"Lean the body left/right"'));
      await expect.poll(() => page.evaluate(() => window.__rev2d!.state().text.includes('edited elsewhere')), { timeout: 5000 }).toBe(false);
      await edit('"#0000ff"');
      await page.click('[data-testid=conflict-overwrite]');
      await page.locator('[data-testid=conflict-banner]').waitFor({ state: 'hidden', timeout: 5000 });
      const saved = readFileSync(e.file, 'utf8');
      expect(saved).toContain('"#0000ff"');
      expect(saved).not.toContain('edited elsewhere');
      expect((await stats(page)).mtimeMs).toBe(statSync(e.file).mtimeMs);
    } finally {
      await page.unroute('**/api/model*');
    }
    expect(pageErrors).toEqual([]);
  });

  it('floats the chrome over a full-bleed canvas; collapsing panes frees room, and it is remembered', async () => {
    type Box = { x: number; y: number; width: number; height: number };
    const box = async (id: string): Promise<Box> => (await page.locator(`[data-testid=${id}]`).boundingBox())!;
    const overlaps = (a: Box, b: Box): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    const insets = () => page.evaluate(() => window.__rev2d!.session.getInsets());
    const visible = (id: string) => page.locator(`[data-testid=${id}]`).isVisible();
    /** The model canvas rectangle on screen. */
    const canvasOnScreen = () =>
      page.evaluate(() => {
        const s = window.__rev2d!.state();
        const { camera: c, viewport: v, model } = s;
        const x = (0 - c.cx) * c.zoom + v.width / 2;
        const y = (0 - c.cy) * c.zoom + v.height / 2;
        return { x, y, width: model!.meta.width * c.zoom, height: model!.meta.height * c.zoom };
      });

    // The canvas runs edge to edge under the chrome...
    expect(await box('viewport')).toEqual({ x: 0, y: 0, width: 1400, height: 900 });
    await page.evaluate(() => window.__rev2d!.session.focus('canvas'));
    const before = await insets();
    expect(before.top).toBeGreaterThan(40);
    expect(before.left).toBeGreaterThan(200);
    expect(before.right).toBeGreaterThan(250);
    expect(before.bottom).toBeGreaterThan(200);
    // ...and the model is framed in the part the panes leave free: no pane covers it.
    const framed = await canvasOnScreen();
    for (const id of ['toolbar', 'outliner', 'inspector-panel', 'timeline']) expect(overlaps(framed, await box(id)), id).toBe(false);
    // The view controls sit in the free area too: they never hide under a pane.
    const bar = await box('view-bar');
    for (const id of ['outliner', 'inspector-panel', 'timeline']) expect(overlaps(bar, await box(id)), id).toBe(false);

    await page.click('[data-testid=toggle-outliner]');
    await page.click('[data-testid=toggle-inspector]');
    await page.click('[data-testid=toggle-dock]');
    await expect.poll(async () => (await insets()).left).toBe(0);
    const collapsed = await insets();
    expect(collapsed.right).toBe(0);
    // The timeline drawer collapses to its slim transport bar.
    expect(collapsed.bottom).toBeLessThan(before.bottom - 100);
    expect((await box('timeline')).height).toBeLessThan(60);
    expect(await visible('play')).toBe(true);
    expect(await visible('tracks')).toBe(false);
    await expect.poll(() => visible('outliner')).toBe(false);
    await expect.poll(() => visible('inspector-panel')).toBe(false);
    // The framing followed: the model is larger now.
    expect((await canvasOnScreen()).height).toBeGreaterThan(framed.height + 100);

    await page.reload();
    await page.waitForFunction(() => window.__rev2d?.stats().ready === true, null, { timeout: 30000 });
    expect(await visible('inspector-panel')).toBe(false);
    expect(await visible('outliner')).toBe(false);
    expect((await box('timeline')).height).toBeLessThan(60);
    // Asking for the problems list brings the inspector back, on its problems page.
    await page.click('[data-testid=problems-badge]');
    await page.locator('[data-testid=problems]').waitFor({ state: 'visible', timeout: 5000 });

    await page.click('[data-testid=toggle-outliner]');
    await page.locator('[data-testid=outliner]').waitFor({ state: 'visible', timeout: 5000 });
    await page.click('[data-testid=toggle-dock]');
    await page.locator('[data-testid=layers]').waitFor({ state: 'visible', timeout: 5000 });
    await showInspectorPage(page, 'parameters');
    await page.locator('[data-testid=parameters]').waitFor({ state: 'visible', timeout: 5000 });
    expect(pageErrors).toEqual([]);
  });

  it('switches the appearance and the language from the toolbar and remembers both', async () => {
    const root = () => page.evaluate(() => ({ appearance: document.documentElement.getAttribute('data-appearance'), lang: document.documentElement.lang, scheme: getComputedStyle(document.documentElement).colorScheme }));
    /** The workspace colour the WebGL viewport clears with (a pixel in the top-left corner of the canvas). */
    const workspace = async (): Promise<number> => {
      const img = decodePNG(await page.screenshot({ clip: { x: 2, y: 2, width: 4, height: 4 } }));
      return img.data[0] + img.data[1] + img.data[2];
    };
    await page.click('[data-testid=appearance-menu]');
    await page.click('[role=menuitemcheckbox]:has-text("Dark")');
    await expect.poll(async () => (await root()).appearance).toBe('dark');
    expect((await root()).scheme).toBe('dark');
    // The viewport backdrop follows the appearance.
    await expect.poll(workspace, { timeout: 5000 }).toBeLessThan(120);
    await page.click('[data-testid=appearance-menu]');
    await page.click('[role=menuitemcheckbox]:has-text("Light")');
    await expect.poll(workspace, { timeout: 5000 }).toBeGreaterThan(600);

    await page.click('[data-testid=language-menu]');
    await page.click('[role=menuitemcheckbox]:has-text("한국어")');
    await expect.poll(async () => (await root()).lang).toBe('ko');
    expect(await page.textContent('[data-testid=save]')).toBe('저장');
    expect(await page.getAttribute('[data-testid=undo]', 'aria-label')).toContain('실행 취소');
    await page.click('[data-testid=language-menu]');
    await page.click('[role=menuitemcheckbox]:has-text("日本語")');
    await expect.poll(() => page.textContent('[data-testid=save]')).toBe('保存');

    await page.reload();
    await page.waitForFunction(() => window.__rev2d?.stats().ready === true, null, { timeout: 30000 });
    expect(await root()).toMatchObject({ appearance: 'light', lang: 'ja' });
    expect(await page.textContent('[data-testid=save]')).toBe('保存');
    // Back to the defaults for the tests that follow.
    await page.click('[data-testid=language-menu]');
    await page.click('[role=menuitemcheckbox]:has-text("English")');
    await page.click('[data-testid=appearance-menu]');
    await page.click('[role=menuitemcheckbox]:has-text("Automatic") >> nth=0');
    await expect.poll(async () => (await root()).appearance).toBe('auto');
    expect(await page.textContent('[data-testid=save]')).toBe('Save');
    expect(pageErrors).toEqual([]);
  });

  it('opens the AI panel from its toolbar button, and keeps solid materials on a software rasterizer', async () => {
    // The AI panel is part of the editor: its button toggles it in the trailing sidebar (what the
    // panel shows, also with the agent bridge off, is test/editor-ai-e2e.test.ts).
    const ai = page.locator('[data-testid=toggle-ai]');
    expect(await ai.getAttribute('aria-label')).toBe('AI Assistant');
    expect(await ai.getAttribute('aria-disabled')).toBeNull();
    await ai.click();
    await page.locator('[data-testid=ai-panel]').waitFor({ timeout: 10000 });
    expect(await ai.getAttribute('aria-pressed')).toBe('true');
    expect(await page.evaluate(() => window.__rev2d!.state().trailingPanel)).toBe('ai');
    // Pressed again it closes the sidebar; the inspector button brings the inspector back.
    await ai.click();
    await expect.poll(() => ai.getAttribute('aria-pressed')).toBe('false');
    expect(await page.evaluate(() => window.__rev2d!.state().panels.inspector)).toBe(false);
    await page.click('[data-testid=toggle-inspector]');
    await page.locator('[data-testid=inspector-panel]').waitFor();
    expect(await page.evaluate(() => [window.__rev2d!.state().trailingPanel, window.__rev2d!.state().panels.inspector])).toEqual(['inspector', true]);
    // Headless Chrome renders WebGL with SwiftShader here: glass would be recomputed on the CPU.
    const renderer = await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      const info = gl?.getExtension('WEBGL_debug_renderer_info');
      return String(gl && info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : '');
    });
    const solid = await page.evaluate(() => document.documentElement.getAttribute('data-materials'));
    if (/swiftshader|llvmpipe|software/i.test(renderer)) expect(solid).toBe('solid');
    else expect(solid).toBeNull();
  });
});

/** The pixels of the model canvas in the viewport, with the camera at zoom 1 over the canvas. */
async function canvasPixels(page: Page, w: number, h: number) {
  const vp = await page.evaluate(
    ({ w, h }) => {
      const s = window.__rev2d!.session;
      const v = s.get().viewport;
      s.setCamera({ cx: w / 2 + (v.width % 2) / 2, cy: h / 2 + (v.height % 2) / 2, zoom: 1 });
      return v;
    },
    { w, h },
  );
  // The chrome floats over the canvas: hide it while the pixels of the canvas are read.
  const hide = await page.addStyleTag({ content: '.r2-split-pane, .r2-split-divider, .ed-hud, .ed-view-controls, .ed-toasts { visibility: hidden !important; }' });
  await page.waitForTimeout(500);
  const box = (await page.locator('[data-testid=viewport-gl]').boundingBox())!;
  const shot = decodePNG(await page.screenshot({ clip: box }));
  await hide.evaluate((el) => (el as HTMLElement).remove());
  return cropImage(shot, Math.round(vp.width / 2 - w / 2 - (vp.width % 2) / 2), Math.round(vp.height / 2 - h / 2 - (vp.height % 2) / 2), w, h);
}

describe.skipIf(!ready)('editor screenshots match the WebGL viewport (hana)', () => {
  const e = env as Env;
  let server: EditorServer;
  let dir: string;
  let page: Page;
  const pageErrors: string[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'rev2d-editor-fidelity-'));
    cpSync(path.join(PACKAGE_ROOT, 'examples', 'hana'), dir, { recursive: true });
    const { startEditorServer } = await import('../src/server/index.js');
    server = await startEditorServer({ file: path.join(dir, 'hana.r2d.json'), port: 0, register: false, devVite: false, log: () => {} });
    page = await e.browser.newPage({ viewport: { width: 1600, height: 1000 }, locale: 'en-US' });
    page.on('pageerror', (err) => pageErrors.push(err.message));
    await page.goto(server.url);
    await page.waitForFunction(() => window.__rev2d?.stats().ready === true, null, { timeout: 30000 });
  }, 60000);

  afterAll(async () => {
    await page?.close();
    await server?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const post = (cmd: unknown) =>
    fetch(`${server.url}/api/command`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cmd) });

  /** GL canvas vs GET /api/screenshot, once the published view state satisfies `published`. */
  async function compare(published: (state: EditorState) => boolean): Promise<{ differentPixels: number; hidden: string | null }> {
    await expect.poll(async () => published((await (await fetch(`${server.url}/api/state`)).json()) as EditorState), { timeout: 5000 }).toBe(true);
    const gl = await canvasPixels(page, 512, 640);
    const res = await fetch(`${server.url}/api/screenshot?viewBox=canvas&overlay=&scale=1`);
    const sw = decodePNG(new Uint8Array(await res.arrayBuffer()));
    const d = diffImages(gl, sw, { threshold: 24 });
    return { differentPixels: d.differentPixels, hidden: res.headers.get('x-rev2d-hidden') };
  }

  it('renders the published pose (physics results included) and the preview-hidden parts like the UI', async () => {
    await post({ type: 'setOverlay', overlay: [] });
    await post({ type: 'setParams', params: { AngleX: 25 } });
    await post({ type: 'setAnimations', animations: [{ id: 'talk' }] });
    await post({ type: 'seek', time: 1.3 });
    // Edge anti-aliasing differs between WebGL and the software rasterizer: allow ~1% of the canvas.
    // (Re-simulating physics on the server used to move the hair: ~2% of the canvas differed.)
    const talk = await compare((st) => st.time === 1.3 && st.animations[0]?.id === 'talk' && st.params.AngleX === 25);
    expect(talk.differentPixels, 'talk').toBeLessThan(512 * 640 * 0.01);

    // Parts hidden in the outliner preview are left out of the screenshot too.
    await post({ type: 'select', ids: ['hairFront'] });
    await page.locator('[data-testid=viewport]').hover();
    await page.keyboard.press('h');
    await expect.poll(() => page.evaluate(() => window.__rev2d!.state().hidden), { timeout: 5000 }).toEqual(['hairFront']);
    // No hover / selection outlines on top of the model.
    await page.mouse.move(0, 0);
    await post({ type: 'select', ids: [] });
    const hidden = await compare((st) => st.hidden?.[0] === 'hairFront' && st.selection.length === 0);
    expect(hidden.hidden).toBe('hairFront');
    expect(hidden.differentPixels, 'hidden').toBeLessThan(512 * 640 * 0.01);
  });

  it('plays extra layers with their options (UI -> published state -> matching screenshot)', async () => {
    await post({ type: 'setParams', params: {}, reset: true });
    await post({ type: 'setAnimations', animations: [{ id: 'idle' }] });
    const toggle = page.locator('[data-testid=layer-toggle-blink]');
    await toggle.click();
    expect(await toggle.getAttribute('aria-checked')).toBe('true');
    await page.click('[data-testid=layer-mode-blink] [data-value=add]');
    await page.click('[data-testid=layer-after-blink] [data-value=once]');
    await page.fill('[data-testid=layer-start-blink]', '1');
    await page.keyboard.press('Enter');
    await post({ type: 'seek', time: 1.2 });
    const phase = () => page.getAttribute('[data-testid=layer-phase-blink]', 'data-phase');
    await expect.poll(phase, { timeout: 5000 }).toBe('playing');
    expect(await page.textContent('[data-testid=layer-phase-blink]')).toBe('Playing');
    const blink = { id: 'blink', mode: 'add', start: 1, hold: false };
    const shot = await compare((st) => st.time === 1.2 && JSON.stringify(st.animations) === JSON.stringify([{ id: 'idle' }, blink]));
    expect(shot.differentPixels, 'layers').toBeLessThan(512 * 640 * 0.01);
    // After its end the "once" layer no longer affects the pose.
    await post({ type: 'seek', time: 2.2 });
    await expect.poll(phase, { timeout: 5000 }).toBe('done');
    await toggle.click();
    expect(await toggle.getAttribute('aria-checked')).toBe('false');
    expect(pageErrors).toEqual([]);
  });

  it('pins a physics output at its value and unpins it (explicit values beat physics)', async () => {
    await showInspectorPage(page, 'parameters');
    await page.fill('[data-testid=outliner-search]', 'Hair');
    // The sidebar search filters the sliders too, and says so.
    await page.locator('[data-testid=params-filter]').waitFor({ timeout: 5000 });
    const pin = page.locator('[data-testid=param-pin-HairFront]');
    const pinState = async () => `${await pin.getAttribute('aria-pressed')} ${await pin.textContent()}`;
    await expect.poll(pinState, { timeout: 5000 }).toBe('false Physics');
    await pin.click();
    await expect.poll(pinState, { timeout: 5000 }).toBe('true Pinned');
    const pinned = (await page.evaluate(() => window.__rev2d!.state().overrides)).HairFront;
    expect(typeof pinned).toBe('number');
    // Physics keeps simulating: the pinned value holds while the ghost tick shows the physics output.
    await post({ type: 'play', animation: 'look_around' });
    await page.waitForTimeout(600);
    await post({ type: 'pause' });
    await expect.poll(async () => (await page.evaluate(() => window.__rev2d!.state().values)).HairFront, { timeout: 5000 }).toBe(pinned);
    expect(await page.locator('[data-testid=param-ghost-HairFront]').count()).toBe(1);
    await pin.click();
    await expect.poll(pinState, { timeout: 5000 }).toBe('false Physics');
    expect(await page.evaluate(() => window.__rev2d!.state().overrides)).toEqual({});
    await page.fill('[data-testid=outliner-search]', '');
    expect(pageErrors).toEqual([]);
  });

  it('scrubs the timeline, and works the outline rows: context menu, inspect, preview visibility', async () => {
    await post({ type: 'setAnimations', animations: [{ id: 'idle' }] });
    await post({ type: 'seek', time: 0 });
    const ruler = (await page.locator('[data-testid=tracks] .ed-tl-ruler').boundingBox())!;
    await page.mouse.click(ruler.x + ruler.width / 2, ruler.y + ruler.height / 2);
    // idle lasts 4 s: the middle of the ruler is 2 s (snapped to a frame).
    await expect.poll(() => page.evaluate(() => window.__rev2d!.state().time), { timeout: 5000 }).toBeCloseTo(2, 1);
    expect(await page.textContent('[data-testid=time-readout]')).toContain('2.00');

    // A row's context menu shows it in the inspector (the panel turns to the selection page).
    await showInspectorPage(page, 'parameters');
    await page.click('[data-testid=outliner-tabs] [data-value=parts]');
    const row = page.locator('[data-key="part:mouth"]');
    await row.click({ button: 'right' });
    await page.click('[role=menuitem]:has-text("Show in Inspector")');
    await expect.poll(() => page.evaluate(() => window.__rev2d!.state().selection), { timeout: 5000 }).toEqual(['part:mouth']);
    const json = page.locator('[data-testid=inspector-json]');
    await expect.poll(() => json.inputValue(), { timeout: 5000 }).toContain('"id": "mouth"');
    expect(await json.isVisible()).toBe(true);
    expect(await row.getAttribute('data-selected')).toBe('');
    // Shift-click extends the selection; a plain click replaces it.
    await page.locator('[data-key="part:nose"] .r2-row-main').click({ modifiers: ['Shift'] });
    expect(await page.evaluate(() => window.__rev2d!.state().selection)).toEqual(['part:mouth', 'part:nose']);
    await page.locator('[data-key="part:nose"] .r2-row-main').click();
    expect(await page.evaluate(() => window.__rev2d!.state().selection)).toEqual(['part:nose']);
    // The eye of a part row hides it in the preview only (nothing is written).
    const hiddenBefore = await page.evaluate(() => window.__rev2d!.state().hidden);
    await row.hover();
    await row.locator('.ed-row-eye').click();
    expect(await page.evaluate(() => window.__rev2d!.state().hidden)).toEqual([...hiddenBefore, 'mouth']);
    expect(await page.evaluate(() => window.__rev2d!.state().selection)).toEqual(['part:nose']);
    await page.click('[data-testid=show-all-parts]');
    expect(await page.evaluate(() => window.__rev2d!.state().hidden)).toEqual([]);
    await post({ type: 'select', ids: [] });
    await post({ type: 'setAnimations', animations: [] });
    expect(pageErrors).toEqual([]);
  });
});
