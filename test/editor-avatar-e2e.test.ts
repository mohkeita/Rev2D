/**
 * End-to-end test of the editor's avatar mode: the real editor server on a temporary workspace with a
 * BUILT avatar project (the repository's own hana illustration, test/fixtures/avatar-hana.ts, at half
 * size), the built UI in headless Chrome.
 *
 *   avatar mode is the default -> drag an eye-opening vertex: the "rebuild the layers" banner ->
 *   pose the preview, drag the head ellipse's radius: the preview changes without a rebuild ->
 *   Ctrl+S writes avatar.json -> "Save and rebuild layers" runs a build job to the end -> undo / redo
 *   (keyboard and toolbar) -> the lip-sync tab drives the mouth -> the start screen's "Avatar from an
 *   illustration" sheet creates a project from a PNG (placing the landmarks by hand): Avatar mode
 *   shows it without a model, with its checklist, the toolbar's Save / Undo and the unsaved prompt
 *   before another file opens -> an agent's landmarks show at once -> the first build opens the model
 *   in the same mode, without "opened in another tab" -> drawn variants: drawings placed by hand are
 *   imported (one used, one rejected with the reason), shown in the preview, removed; "Draw with AI"
 *   says why it cannot run (and copies the request), or that the illustration goes to the image
 *   generator (agent bridge answered by the test: no real agent ever starts).
 *
 * The UI comes from REV2D_EDITOR_UI (a folder with a built editor; default dist/editor). Skips, with
 * the reason logged, when it is missing or Chrome cannot be launched.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PACKAGE_ROOT } from '../src/api/templates.js';
import { formatModelJson } from '../src/core/format.js';
import { buildAvatarProject } from '../src/node/avatar.js';
import { parseAvatarSpec, type AvatarSpec } from '../src/avatar/index.js';
import { drawClosedEyes, drawOpenMouth, shiftImage } from '../src/avatar/__tests__/variants-drawings.js';
import { encodePNG } from '../src/render/index.js';
import type { EditorServer } from '../src/server/index.js';
import { hanaIllustration } from './fixtures/avatar-hana.js';

const UI_DIR = path.resolve(PACKAGE_ROOT, process.env.REV2D_EDITOR_UI ?? path.join('dist', 'editor'));
const SHOTS = path.join(PACKAGE_ROOT, 'out');

interface Env {
  server: EditorServer;
  browser: Browser;
  root: string;
  project: string;
  png: string;
}

async function setup(): Promise<Env | string> {
  if (!existsSync(path.join(UI_DIR, 'index.html'))) return `no built editor UI at ${UI_DIR} (run \`npm run editor:build\`, or set REV2D_EDITOR_UI)`;
  const root = mkdtempSync(path.join(os.tmpdir(), 'rev2d-avatar-e2e-'));
  const hana = hanaIllustration(0.5);
  const png = path.join(root, '..', `${path.basename(root)}-pick.png`);
  const project = path.join(root, 'hana');
  mkdirSync(project);
  writeFileSync(path.join(project, 'avatar.json'), formatModelJson(hana.doc));
  writeFileSync(path.join(project, 'source.png'), Buffer.from(encodePNG(hana.image)));
  writeFileSync(png, Buffer.from(encodePNG(hana.image)));
  const cleanup = () => {
    rmSync(root, { recursive: true, force: true });
    rmSync(png, { force: true });
  };
  try {
    await buildAvatarProject(project, { folds: false });
  } catch (e) {
    cleanup();
    return `cannot build the fixture avatar: ${(e as Error).message}`;
  }
  let server: EditorServer;
  try {
    const { startEditorServer } = await import('../src/server/index.js');
    server = await startEditorServer({ root, file: path.join(project, 'hana.r2d.json'), port: 0, register: false, devVite: false, recentFile: null, staticDir: UI_DIR, log: () => {}, avatar: { build: 'inline' } });
  } catch (e) {
    cleanup();
    return `editor server unavailable: ${(e as Error).message}`;
  }
  try {
    const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    return { server, browser, root, project, png };
  } catch (e) {
    await server.close();
    cleanup();
    return `cannot launch Chrome: ${(e as Error).message.split('\n')[0]}`;
  }
}

const env = await setup();
if (typeof env === 'string') console.warn(`[editor-avatar-e2e] skipped: ${env}`);
const ready = typeof env !== 'string';

afterAll(async () => {
  if (typeof env === 'string') return;
  await Promise.race([env.browser.close(), new Promise((resolve) => setTimeout(resolve, 5000))]);
  await env.server.close();
  rmSync(env.root, { recursive: true, force: true });
  rmSync(env.png, { force: true });
}, 30000);

describe.skipIf(!ready)('editor avatar mode end to end (server + built avatar + Chrome)', () => {
  const e = env as Env;
  let page: Page;
  const pageErrors: string[] = [];

  const state = () => page.evaluate(() => {
    const s = window.__rev2dAvatar!.state();
    return { status: s.status, unsaved: s.unsaved, stale: s.stale, staleItems: s.staleItems, job: s.job?.state ?? null, previewVersion: s.previewVersion, mtimeMs: s.mtimeMs, canUndo: s.canUndo, canRedo: s.canRedo, doc: s.doc as any };
  });
  /** Screen position (page CSS px) of an image point on the avatar canvas. */
  const screenOf = (x: number, y: number) =>
    page.evaluate(
      ([px, py]) => {
        const s = window.__rev2dAvatar!.state();
        const r = document.querySelector('[data-testid=avatar-canvas]')!.getBoundingClientRect();
        return [r.left + (px - s.camera.cx) * s.camera.zoom + s.viewport.width / 2, r.top + (py - s.camera.cy) * s.camera.zoom + s.viewport.height / 2] as [number, number];
      },
      [x, y] as [number, number],
    );
  const drag = async (from: [number, number], to: [number, number]) => {
    await page.mouse.move(from[0], from[1]);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) await page.mouse.move(from[0] + ((to[0] - from[0]) * i) / 6, from[1] + ((to[1] - from[1]) * i) / 6);
    await page.mouse.up();
  };
  const previewPixels = () => page.locator('[data-testid=avatar-preview-gl]').screenshot();
  const shot = (name: string) => page.screenshot({ path: path.join(SHOTS, `editor-avatar-e2e-${name}.png`) });

  beforeAll(async () => {
    mkdirSync(SHOTS, { recursive: true });
    page = await e.browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
    page.on('pageerror', (err) => pageErrors.push(err.message));
    await page.goto(e.server.url);
    await page.waitForFunction(() => window.__rev2dAvatar?.state().status === 'ready' && window.__rev2dAvatar.state().previewVersion > 0, null, { timeout: 60000 });
  }, 90000);

  it('opens a built avatar project in avatar mode with the parts, the illustration and the live preview', async () => {
    await page.locator('[data-testid=avatar-canvas]').waitFor();
    await page.locator('[data-testid=avatar-parts]').waitFor();
    await page.locator('[data-testid=avatar-preview]').waitFor();
    expect(await page.locator('[data-testid=mode-switch] [data-value=avatar]').getAttribute('aria-checked')).toBe('true');
    expect(await page.locator('[data-testid=avatar-group-head]').textContent()).toContain('Head');
    expect(await page.locator('[data-testid=avatar-item-eyes\\.imageLeft\\.opening]').textContent()).toContain('Left Eye · Opening');
    expect(pageErrors).toEqual([]);
  }, 60000);

  it('drags an eye-opening vertex: the layers are stale and the banner offers to rebuild', async () => {
    await page.click('[data-testid=avatar-item-eyes\\.imageLeft\\.opening] button');
    await page.click('[data-testid=avatar-fit-selected]');
    const s = await state();
    const pts: number[] = s.doc.face.eyes.imageLeft.opening;
    const from = await screenOf(pts[6], pts[7]);
    await drag(from, [from[0], from[1] - 12]);
    await page.locator('[data-testid=avatar-stale-banner]').waitFor({ timeout: 10000 });
    const after = await state();
    expect(after.doc.face.eyes.imageLeft.opening[7]).toBeLessThan(pts[7] - 1);
    expect(after.doc.face.eyes.imageLeft.opening[6]).toBeCloseTo(pts[6], 0);
    expect(after.unsaved).toBe(true);
    expect(after.stale).toBe(true);
    expect(after.staleItems).toEqual(['eyes.imageLeft.opening']);
    expect(await page.locator('[data-testid=avatar-stale-banner]').textContent()).toContain('Left Eye · Opening');
    await shot('stale');
  }, 60000);

  it('changes the preview at once when the head ellipse is resized (no rebuild)', async () => {
    // Turn the head (the turn field lives inside the head ellipse), then shrink the ellipse.
    await page.locator('[data-testid=avatar-pose-AngleX] [role=slider]').focus();
    await page.keyboard.press('End');
    await page.waitForFunction(() => window.__rev2dAvatar!.state().previewParams.AngleX === 30);
    await page.click('[data-testid=avatar-item-head\\.ellipse] button');
    await page.click('[data-testid=avatar-fit]');
    await page.waitForTimeout(300);
    const before = await previewPixels();
    const v0 = (await state()).previewVersion;
    const s = await state();
    const [cx, cy] = s.doc.head.center;
    const [rx] = s.doc.head.radius;
    const from = await screenOf(cx + rx, cy);
    const to = await screenOf(cx + rx * 0.55, cy);
    await drag(from, to);
    await page.waitForFunction((v) => window.__rev2dAvatar!.state().previewVersion > v, v0, { timeout: 10000 });
    await page.waitForTimeout(400);
    const after = await previewPixels();
    expect(Buffer.compare(before, after)).not.toBe(0);
    expect((await state()).doc.head.radius[0]).toBeLessThan(rx * 0.7);
    expect((await state()).job).toBeNull();
    await shot('head');
  }, 60000);

  it('saves avatar.json with Ctrl+S', async () => {
    const file = path.join(e.project, 'avatar.json');
    const before = statSync(file).mtimeMs;
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => !window.__rev2dAvatar!.state().unsaved && !window.__rev2dAvatar!.state().saving, null, { timeout: 15000 });
    expect(statSync(file).mtimeMs).toBeGreaterThan(before);
    const disk = JSON.parse(readFileSync(file, 'utf8'));
    expect(disk.head.radius[0]).toBe((await state()).doc.head.radius[0]);
    expect(existsSync(`${file}.bak`)).toBe(true);
  }, 60000);

  it('saves and rebuilds the layers: the job runs to the end and the banner goes away', async () => {
    await page.click('[data-testid=avatar-rebuild]');
    // The job shows its steps while it runs (a fast build may already be done: its banner stays a moment).
    await page.waitForFunction(() => window.__rev2dAvatar!.state().job !== null, null, { timeout: 15000 }).catch(async (err) => {
      console.log('[editor-avatar-e2e] no job', await page.evaluate(() => JSON.stringify({ job: window.__rev2dAvatar!.state().job, stale: window.__rev2dAvatar!.state().stale, toasts: window.__rev2d!.state().toasts })));
      throw err;
    });
    await page.waitForFunction(() => window.__rev2dAvatar!.state().job?.state === 'done' || window.__rev2dAvatar!.state().job === null, null, { timeout: 120000 });
    await page.waitForFunction(() => !window.__rev2dAvatar!.state().stale, null, { timeout: 30000 });
    expect(await page.locator('[data-testid=avatar-stale-banner]').count()).toBe(0);
    const meta = JSON.parse(readFileSync(path.join(e.project, 'textures', 'layers.json'), 'utf8'));
    expect(meta.inputsHash).toBe(await page.evaluate(() => window.__rev2dAvatar!.state().meta!.inputsHash));
    await shot('rebuilt');
  }, 180000);

  it('undoes and redoes with the keyboard', async () => {
    const r0 = (await state()).doc.head.radius[0];
    await page.keyboard.press('Control+z');
    await page.waitForFunction((r) => window.__rev2dAvatar!.state().doc!.head && (window.__rev2dAvatar!.state().doc as any).head.radius[0] !== r, r0);
    const undone = await state();
    expect(undone.doc.head.radius[0]).toBeGreaterThan(r0);
    expect(undone.unsaved).toBe(true);
    expect(undone.canRedo).toBe(true);
    // The toolbar's Save writes avatar.json in avatar mode; its Undo / Redo are avatar.json's too.
    await page.click('[data-testid=save]');
    await page.waitForFunction(() => !window.__rev2dAvatar!.state().unsaved && !window.__rev2dAvatar!.state().saving, null, { timeout: 15000 });
    expect(JSON.parse(readFileSync(path.join(e.project, 'avatar.json'), 'utf8')).head.radius[0]).toBe(undone.doc.head.radius[0]);
    expect(await page.locator('[data-testid=redo]').isDisabled()).toBe(false);
    expect(await page.getAttribute('[data-testid=redo]', 'aria-label')).toMatch(/^Redo /);
    await page.keyboard.press('Control+Shift+z');
    await page.waitForFunction((r) => (window.__rev2dAvatar!.state().doc as any).head.radius[0] === r, r0);
    expect((await state()).unsaved).toBe(true);
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => !window.__rev2dAvatar!.state().unsaved && !window.__rev2dAvatar!.state().saving, null, { timeout: 15000 });
  }, 60000);

  it('follows an external change of avatar.json live, as a step of the history', async () => {
    const file = path.join(e.project, 'avatar.json');
    const disk = JSON.parse(readFileSync(file, 'utf8'));
    disk.face.nose = [disk.face.nose[0] + 3, disk.face.nose[1] + 2];
    writeFileSync(file, formatModelJson(disk));
    await page.waitForFunction((n) => JSON.stringify((window.__rev2dAvatar!.state().doc as any).face.nose) === JSON.stringify(n), disk.face.nose, { timeout: 20000 });
    const s = await state();
    expect(s.unsaved).toBe(false);
    expect(s.canUndo).toBe(true);
  }, 60000);

  it('drives the mouth from the lip-sync tab: a held vowel and spoken text', async () => {
    await page.click('[data-testid=avatar-tabs] [data-value=lipsync]');
    await page.locator('[data-testid=avatar-lipsync]').waitFor();
    const vowel = page.locator('[data-testid=avatar-vowel-a]');
    const box = (await vowel.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForFunction(() => (window.__rev2dAvatar!.store.previewInputs().params.MouthOpen ?? 0) > 0.8, null, { timeout: 10000 });
    await shot('lipsync');
    await page.mouse.up();
    await page.waitForFunction(() => window.__rev2dAvatar!.state().lipsync.mouth === null, null, { timeout: 10000 });
    await page.fill('input[data-testid=avatar-lip-text]', 'あいうえお');
    await page.click('[data-testid=avatar-lip-play]');
    await page.waitForFunction(() => (window.__rev2dAvatar!.store.previewInputs().params.MouthOpen ?? 0) > 0.3, null, { timeout: 10000 });
    await page.waitForFunction(() => window.__rev2dAvatar!.state().lipsync.startedAt === null, null, { timeout: 15000 });
  }, 60000);

  it('creates an avatar project from a PNG on the start screen and places the landmarks by hand', async () => {
    await page.click('[data-testid=file-menu-button]');
    await page.click('[data-testid=menu-close]');
    await page.locator('[data-testid=start-avatar]').waitFor({ timeout: 15000 });
    await page.click('[data-testid=start-avatar]');
    await page.locator('[data-testid=avatar-new-sheet]').waitFor();
    await page.setInputFiles('[data-testid=avatar-new-input]', e.png);
    await page.waitForFunction(() => (document.querySelector('input[data-testid=avatar-new-name]') as HTMLInputElement | null)?.value === 'avatar-e2e-pick' || !!(document.querySelector('input[data-testid=avatar-new-name]') as HTMLInputElement | null)?.value);
    await page.fill('input[data-testid=avatar-new-name]', 'mio');
    await page.click('label:has([data-testid=avatar-new-manual])');
    await shot('new-sheet');
    await page.click('[data-testid=avatar-new-create]');
    await page.waitForFunction(() => window.__rev2dAvatar!.state().status === 'ready' && window.__rev2dAvatar!.state().ref?.projectPath === 'mio', null, { timeout: 20000 });
    // Avatar mode shows the project without a model, through the shell (not the start screen).
    await page.locator('[data-testid=avatar-canvas]').waitFor({ timeout: 20000 });
    expect(await page.locator('[data-testid=start-screen]').count()).toBe(0);
    expect(await page.getAttribute('.ed-shell', 'data-mode')).toBe('avatar');
    expect(await page.evaluate(() => window.__rev2d!.stats().status)).toBe('empty');
    expect(existsSync(path.join(e.root, 'mio', 'source.png'))).toBe(true);
    expect(existsSync(path.join(e.root, 'mio', 'avatar.json'))).toBe(true);
    await page.locator('[data-testid=avatar-missing]').waitFor();
    expect(await page.locator('[data-testid=avatar-missing] li').count()).toBeGreaterThan(10);
    // Place the nose by hand: pick it in the checklist, click the picture.
    await page.click('[data-testid=avatar-missing-face\\.nose]');
    await page.locator('[data-testid=avatar-placing]').waitFor();
    const at = await screenOf(128, 120);
    await page.mouse.click(at[0], at[1]);
    await page.waitForFunction(() => Array.isArray((window.__rev2dAvatar!.state().doc as any).face.nose));
    const nose = (await state()).doc.face.nose;
    expect(nose[0]).toBeCloseTo(128, 0);
    expect(nose[1]).toBeCloseTo(120, 0);
    expect(await page.locator('[data-testid=avatar-missing-face\\.nose]').count()).toBe(0);
    await shot('project-screen');
    // The toolbar's Undo, Save and the unsaved marker are avatar.json's; the status line names it.
    expect(await page.locator('[data-testid=undo]').isDisabled()).toBe(false);
    await page.locator('[data-testid=unsaved-dot]').waitFor();
    expect(await page.textContent('[data-testid=status-file]')).toContain('mio/avatar.json');
    expect(await page.textContent('[data-testid=avatar-status]')).toMatch(/to place/);
    // Opening another file asks first about the unsaved avatar.json.
    await page.click('[data-testid=file-menu-button]');
    await page.click('[data-testid=menu-recent]');
    await page.click('[data-testid=menu-recent-item]:has-text("hana.r2d.json")');
    await page.locator('[data-testid=unsaved-dialog]').waitFor();
    expect(await page.textContent('[data-testid=unsaved-dialog]')).toContain('mio/avatar.json');
    await shot('unsaved-prompt');
    await page.click('[data-testid=unsaved-cancel]');
    await page.waitForFunction(() => window.__rev2d!.state().unsavedPrompt === null);
    expect(await page.evaluate(() => window.__rev2dAvatar!.state().ref?.projectPath)).toBe('mio');
    // The toolbar's Save writes the draft.
    await page.click('[data-testid=save]');
    await page.waitForFunction(() => !window.__rev2dAvatar!.state().unsaved && !window.__rev2dAvatar!.state().saving, null, { timeout: 15000 });
    expect(JSON.parse(readFileSync(path.join(e.root, 'mio', 'avatar.json'), 'utf8')).face.nose).toEqual(nose);
    expect(await page.locator('[data-testid=unsaved-dot]').count()).toBe(0);
    expect(pageErrors).toEqual([]);
  }, 90000);

  it('shows the landmarks an agent saves at once, then builds the draft into a model', async () => {
    // What the AI path does: an agent writes avatar.json in the project folder.
    const doc = { ...hanaIllustration(0.5).doc, name: 'mio' };
    writeFileSync(path.join(e.root, 'mio', 'avatar.json'), formatModelJson(doc));
    await page.waitForFunction(() => window.__rev2dAvatar!.state().spec !== null, null, { timeout: 20000 });
    expect(await page.locator('[data-testid=avatar-missing]').count()).toBe(0);
    await page.click('[data-testid=avatar-build]');
    await page.waitForFunction(() => window.__rev2d!.stats().status === 'ready' && window.__rev2dAvatar!.state().hasModel && window.__rev2dAvatar!.state().previewVersion > 0, null, { timeout: 120000 });
    expect(existsSync(path.join(e.root, 'mio', 'mio.r2d.json'))).toBe(true);
    await page.locator('[data-testid=avatar-preview]').waitFor();
    expect(await page.locator('[data-testid=mode-switch] [data-value=avatar]').getAttribute('aria-checked')).toBe('true');
    await page.waitForTimeout(1500);
    // The build of this tab is not announced as "opened in another tab".
    expect((await page.locator('[data-testid=toast]').allTextContents()).join(' | ')).not.toMatch(/another tab/);
    await shot('built-draft');
    expect(pageErrors).toEqual([]);
  }, 180000);
  // ---------------------------------------------------------------------------------- drawn variants
  // On the project built above ("mio": hana's landmarks), with drawings painted programmatically. The
  // pages here answer the agent bridge themselves, so no real AI agent can start from a test.

  /** A page of its own on the open project; `ai` decides what the agent bridge says. */
  const variantsPage = async (ai: 'off' | 'drawer') => {
    const context = await e.browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US', permissions: ['clipboard-read', 'clipboard-write'] });
    const p = await context.newPage();
    p.on('pageerror', (err) => pageErrors.push(err.message));
    const json = (body: unknown) => ({ contentType: 'application/json', body: JSON.stringify(body) });
    if (ai === 'off') {
      await p.route('**/api/session', (route) => route.fulfill(json({ token: null, agent: { enabled: false, reason: 'The AI bridge is off in this test.' } })));
    } else {
      await p.route('**/api/session', (route) => route.fulfill(json({ token: 'test-token', agent: { enabled: true } })));
      await p.route('**/api/agent/providers', (route) => route.fulfill(json([{ id: 'codex', name: 'Codex', available: true, version: '1.0.0', features: { imageGeneration: true }, efforts: [] }])));
      await p.route('**/api/agent/tasks', (route) => route.fulfill(json([])));
      await p.route('**/api/agent/settings', (route) => route.fulfill(json({ settings: { codexWindowsSandbox: 'unelevated' }, sources: { codexWindowsSandbox: 'default' }, user: {}, file: null, windows: false, notes: [] })));
      await p.route('**/api/agent/jobs', (route) => (route.request().method() === 'GET' ? route.fulfill(json({ jobs: [], active: null })) : route.abort()));
    }
    await p.goto(e.server.url);
    await p.waitForFunction(() => window.__rev2dAvatar?.state().status === 'ready' && window.__rev2dAvatar.state().variants !== null && window.__rev2dAvatar.state().previewVersion > 0, null, { timeout: 60000 });
    await p.locator('[data-testid=avatar-variants]').scrollIntoViewIfNeeded();
    return { p, close: () => context.close() };
  };
  const variantState = (p: Page, id: string) => p.locator(`[data-testid=avatar-variant-state-${id}]`).textContent();

  it('lists the drawn variants, imports drawings placed by hand and says why one was rejected', async () => {
    const dir = path.join(e.root, 'mio');
    const spec = parseAvatarSpec({ ...hanaIllustration(0.5).doc, name: 'mio' }).spec as AvatarSpec;
    const source = hanaIllustration(0.5).image;
    mkdirSync(path.join(dir, 'variants'), { recursive: true });
    writeFileSync(path.join(dir, 'variants', 'eyes_closed.png'), Buffer.from(encodePNG(drawClosedEyes(source, spec))));
    writeFileSync(path.join(dir, 'variants', 'mouth_a.png'), Buffer.from(encodePNG(shiftImage(drawOpenMouth(source, spec), 3, 0))));
    const { p, close } = await variantsPage('off');
    try {
      expect(await p.evaluate(() => window.__rev2dAvatar!.state().ref?.projectPath)).toBe('mio');
      await p.waitForFunction(() => window.__rev2dAvatar!.state().variants!.variants.filter((v) => v.drawn).length === 2, null, { timeout: 20000 });
      expect(await variantState(p, 'eyes_closed')).toBe('Not Imported');
      expect(await variantState(p, 'mouth_a')).toBe('Not Imported');
      expect(await p.locator('[data-testid^=avatar-variant-state-]').count()).toBe(2);

      // No AI here: "Draw with AI" says why, and the request can be copied for an agent in a terminal.
      expect(await p.locator('[data-testid=avatar-variants-draw]').isDisabled()).toBe(true);
      expect(await p.textContent('[data-testid=avatar-variants-why]')).toContain('The editor offers AI runs only on this computer');
      await p.click('[data-testid=avatar-variants-copy]');
      const copied = await p.evaluate(() => navigator.clipboard.readText());
      expect(copied).toContain('rev2d avatar variants request . eyes_closed mouth_a');
      expect(copied).toContain('rev2d avatar variants import .');

      // Import: a job with its banner; the good drawing is used, the shifted one rejected with the reason.
      await p.click('[data-testid=avatar-variants-import]');
      await p.locator('[data-testid=avatar-job][data-state=done]').waitFor({ timeout: 120000 });
      await p.waitForFunction(() => window.__rev2dAvatar!.state().variants!.counts.accepted === 1, null, { timeout: 20000 });
      expect(await variantState(p, 'eyes_closed')).toBe('In Use');
      expect(await variantState(p, 'mouth_a')).toBe('Rejected');
      expect(await p.textContent('[data-testid=avatar-variant-reason-mouth_a]')).toBe('The whole picture is shifted (3, 0 px)');
      expect(await p.textContent('[data-testid=avatar-variants-count]')).toBe('1 in use');
      expect(JSON.parse(readFileSync(path.join(dir, 'textures', 'layers.json'), 'utf8')).variants).toEqual(['eyes_closed']);
      // The preview shows the sprite at its pose.
      await p.click('[data-testid=avatar-variant-eyes_closed] .ed-avvariant-main');
      expect(await p.evaluate(() => window.__rev2dAvatar!.state().previewParams)).toMatchObject({ EyeLOpen: 0, EyeROpen: 0 });
      await p.screenshot({ path: path.join(SHOTS, 'editor-avatar-e2e-variants.png') });

      // Masks and prompts from the section's menu.
      await p.click('[data-testid=avatar-variants-menu]');
      await p.click('[role=menuitem]:has-text("Write Masks and Prompts")');
      await p.waitForFunction(() => window.__rev2dAvatar!.state().variants!.requests.readme !== null, null, { timeout: 20000 });
      expect(existsSync(path.join(dir, 'variant-requests', 'mouth_a.mask.png'))).toBe(true);

      // Remove a variant: its drawing and its sprite go.
      await p.click('[data-testid=avatar-variant-menu-eyes_closed]');
      await p.click('[role=menuitem]:has-text("Remove Drawing")');
      await p.locator('[data-testid=avatar-variants-remove-alert]').waitFor();
      await p.click('[data-testid=avatar-variants-remove-confirm]');
      await p.waitForFunction(() => window.__rev2dAvatar!.state().variants!.counts.accepted === 0 && window.__rev2dAvatar!.state().job?.state !== 'running', null, { timeout: 120000 });
      expect(existsSync(path.join(dir, 'variants', 'eyes_closed.png'))).toBe(false);
      expect(JSON.parse(readFileSync(path.join(dir, 'textures', 'layers.json'), 'utf8')).variants).toEqual([]);
      expect(await variantState(p, 'eyes_closed')).toBe('Not Drawn');
    } finally {
      await close();
    }
    expect(pageErrors).toEqual([]);
  }, 240000);

  it('says that the illustration goes to the image generator before an AI draws variants', async () => {
    const { p, close } = await variantsPage('drawer');
    try {
      const draw = p.locator('[data-testid=avatar-variants-draw]');
      await p.waitForFunction(() => !(document.querySelector('[data-testid=avatar-variants-draw]') as HTMLButtonElement | null)?.disabled, null, { timeout: 20000 });
      await draw.click();
      const sheet = p.locator('[data-testid=avatar-variants-draw-sheet]');
      await sheet.waitFor();
      expect(await p.textContent('[data-testid=avatar-variants-privacy]')).toBe('The illustration and the edit masks are sent to the image generator of Codex.');
      // The suggestion: the recommended variants not in use (and the rejected "a" among them).
      expect(await p.locator('[data-testid=avatar-variants-pick-eyes_closed]').isChecked()).toBe(true);
      expect(await p.locator('[data-testid=avatar-variants-pick-mouth_a]').isChecked()).toBe(true);
      expect(await p.textContent('[data-testid=avatar-variants-draw-start]')).toContain('Draw 2 Variants');
      await p.click('[data-testid=avatar-variants-pick-mouth_a]');
      expect(await p.textContent('[data-testid=avatar-variants-draw-start]')).toContain('Draw 1 Variant');
      await p.screenshot({ path: path.join(SHOTS, 'editor-avatar-e2e-variants-draw.png') });
      await p.keyboard.press('Escape');
      await sheet.waitFor({ state: 'detached' });
    } finally {
      await close();
    }
    expect(pageErrors).toEqual([]);
  }, 120000);
});
