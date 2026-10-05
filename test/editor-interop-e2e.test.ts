/**
 * End-to-end test of the editor's interop features: the real editor server with a copy of the
 * robot-arm example (plus a Live2D-style AngleX parameter; a light model, so the Spine export stays
 * quick), the built UI (dist/editor) in headless Chrome. Like the other *-e2e tests it runs in the
 * "chrome" project of vitest.config.ts: after the other test files, one file at a time.
 *
 *   File > Import Live2D motions… (a motion3.json into the open model, undoable) -> File > Export to >
 *   Spine… (into exports/, with the report) -> File > Export to > Live2D motions… -> Import from
 *   computer with the exported Spine files (converted on the way) -> the conversion report.
 *
 * Screenshots of the steps go to out/editor-interop-*.png (1440x900).
 *
 * Skips (with the reason logged) when the UI is not built (`npm run editor:build`) or Chrome cannot
 * be launched.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PACKAGE_ROOT, loadTemplate } from '../src/api/templates.js';
import { formatModelJson } from '../src/core/format.js';
import type { EditorServer } from '../src/server/index.js';

const DIST_INDEX = path.join(PACKAGE_ROOT, 'dist', 'editor', 'index.html');
const SHOTS = path.join(PACKAGE_ROOT, 'out');

interface Env {
  server: EditorServer;
  browser: Browser;
  root: string;
  /** Folder outside the root with the files "picked on the computer". */
  outside: string;
}

const MOTION3 = JSON.stringify({
  Version: 3,
  Meta: { Duration: 2, Fps: 30, Loop: true, AreBeziersRestricted: true, CurveCount: 2, TotalSegmentCount: 3, TotalPointCount: 5, UserDataCount: 0, TotalUserDataSize: 0 },
  Curves: [
    { Target: 'Parameter', Id: 'ParamAngleX', Segments: [0, 0, 0, 1, 25, 0, 2, 0] },
    { Target: 'Parameter', Id: 'ParamNotThere', Segments: [0, 0, 0, 2, 1] },
  ],
});

async function setup(): Promise<Env | string> {
  if (!existsSync(DIST_INDEX)) return `no built editor UI at ${DIST_INDEX} (run \`npm run editor:build\`)`;
  const root = mkdtempSync(path.join(os.tmpdir(), 'rev2d-interop-e2e-'));
  const outside = mkdtempSync(path.join(os.tmpdir(), 'rev2d-interop-pick-'));
  const doc = loadTemplate('robot-arm', { name: 'robot' }).doc as { parameters: unknown[] };
  doc.parameters.push({ id: 'AngleX', min: -30, max: 30, default: 0, description: 'driven by the imported Live2D motion' });
  writeFileSync(path.join(root, 'robot.r2d.json'), formatModelJson(doc));
  writeFileSync(path.join(outside, 'turn.motion3.json'), MOTION3);
  const cleanup = () => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  };
  let server: EditorServer;
  try {
    const { startEditorServer } = await import('../src/server/index.js');
    server = await startEditorServer({ file: path.join(root, 'robot.r2d.json'), root, port: 0, register: false, devVite: false, recentFile: null, log: () => {} });
  } catch (e) {
    cleanup();
    return `editor server unavailable: ${(e as Error).message}`;
  }
  try {
    const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    return { server, browser, root, outside };
  } catch (e) {
    await server.close();
    cleanup();
    return `cannot launch Chrome: ${(e as Error).message.split('\n')[0]}`;
  }
}

const env = await setup();
if (typeof env === 'string') console.warn(`[editor-interop-e2e] skipped: ${env}`);
const ready = typeof env !== 'string';

/**
 * Chrome sometimes keeps running long after browser.close() on some machines (seen with a bare
 * about:blank page as well): wait a bounded time, the launcher kills the process when the worker exits.
 */
async function closeBrowser(browser: Browser): Promise<void> {
  await Promise.race([browser.close(), new Promise((resolve) => setTimeout(resolve, 5000))]);
}

afterAll(async () => {
  if (typeof env === 'string') return;
  await closeBrowser(env.browser);
  await env.server.close();
  rmSync(env.root, { recursive: true, force: true });
  rmSync(env.outside, { recursive: true, force: true });
}, 30000);

const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();

describe.skipIf(!ready)('editor interop end to end (server + built UI + Chrome)', () => {
  const e = env as Env;
  let page: Page;
  const pageErrors: string[] = [];
  const model = () => path.join(e.root, 'robot.r2d.json');
  const animationIds = () => (JSON.parse(readFileSync(model(), 'utf8')).animations as Array<{ id: string }>).map((a) => a.id);

  const stats = () => page.evaluate(() => window.__rev2d!.stats());
  const waitOpen = async (rel: string) => {
    const want = norm(path.join(e.root, rel));
    await page.waitForFunction(
      (w) => {
        const s = window.__rev2d!.stats();
        return s.ready && s.file.replace(/\\/g, '/').toLowerCase() === w;
      },
      want,
      { timeout: 120_000 },
    );
  };
  const shot = async (name: string) => {
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(SHOTS, `editor-interop-${name}.png`) });
  };
  const openMenu = async () => {
    await page.click('[data-testid=file-menu-button]');
    await page.locator('[data-testid=file-menu]').waitFor();
  };
  /**
   * Click a button that starts a conversion. The editor server runs in this process and converts
   * synchronously, so until it is done the event loop cannot take Chrome's answer to the click either:
   * on a loaded machine the click must be allowed as long as the conversion itself.
   */
  const CONVERT_TIMEOUT = 200_000;
  const clickConvert = (selector: string) => page.click(selector, { timeout: CONVERT_TIMEOUT });

  beforeAll(async () => {
    mkdirSync(SHOTS, { recursive: true });
    page = await e.browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', (err) => pageErrors.push(err.message));
    // Under heavy load Chrome occasionally aborts the first navigation (net::ERR_ABORTED): retry.
    for (let attempt = 1; ; attempt++) {
      try {
        await page.goto(e.server.url);
        break;
      } catch (err) {
        if (attempt >= 3) throw err;
        await page.waitForTimeout(1000);
      }
    }
    await waitOpen('robot.r2d.json');
  }, 120_000);

  afterAll(async () => {
    await page?.close();
  });

  it('imports a Live2D motion into the open model as one undoable edit, with the report', { timeout: 240_000 }, async () => {
    await openMenu();
    await shot('menu');
    // The menu item opens the file picker; the test hands the file to the input directly.
    expect(await page.getAttribute('[data-testid=menu-import-live2d]', 'aria-disabled')).toBeNull();
    await page.keyboard.press('Escape');
    await page.setInputFiles('[data-testid=live2d-input]', [path.join(e.outside, 'turn.motion3.json')]);
    await page.locator('[data-testid=live2d-dialog]').waitFor();
    expect(await page.textContent('[data-testid=live2d-files]')).toContain('motion');
    await page.fill('[data-testid=live2d-id]', 'turnHead');
    await shot('live2d-import');
    await clickConvert('[data-testid=live2d-confirm]');
    await page.locator('[data-testid=live2d-summary]').waitFor({ timeout: CONVERT_TIMEOUT });
    expect(await page.textContent('[data-testid=live2d-summary]')).toContain('Imported 1 animation (turnHead). Saved to robot.r2d.json.');
    // The unknown parameter is in the report.
    await page.locator('[data-testid=report]', { hasText: 'ParamNotThere' }).waitFor();
    await shot('live2d-report');
    expect(animationIds()).toContain('turnHead');
    await page.click('[data-testid=live2d-done]');
    await page.locator('[data-testid=live2d-dialog]').waitFor({ state: 'detached' });

    // Undo takes the whole import back (and writes it).
    await page.locator('body').click({ position: { x: 700, y: 860 } });
    await page.keyboard.press('Control+z');
    await expect.poll(() => animationIds().includes('turnHead'), { timeout: 10000 }).toBe(false);
    await page.keyboard.press('Control+y');
    await expect.poll(() => animationIds().includes('turnHead'), { timeout: 10000 }).toBe(true);
  });

  it('exports to Spine into exports/robot-spine and shows the files and the report', { timeout: 240_000 }, async () => {
    await openMenu();
    await page.hover('[data-testid=menu-export-to]');
    await page.locator('[data-testid=export-menu]').waitFor();
    await shot('menu-export');
    await page.click('[data-testid=menu-export-spine]');
    await page.locator('[data-testid=export-dialog]').waitFor();
    expect(await page.inputValue('[data-testid=export-dir]')).toBe('exports/robot-spine');
    // Only the wave animation, sampled at 15 fps.
    await page.click('[data-testid=export-dialog] .field-label-actions >> text=none');
    await page.click('[data-testid=export-anims] label:has-text("wave")');
    await page.fill('[data-testid=export-fps]', '15');
    await shot('export-spine');
    await clickConvert('[data-testid=export-confirm]');
    await page.locator('[data-testid=export-summary]').waitFor({ timeout: CONVERT_TIMEOUT });
    expect(await page.textContent('[data-testid=export-summary]')).toContain('Exported 3 files to exports/robot-spine');
    const dir = path.join(e.root, 'exports', 'robot-spine');
    for (const f of ['robot.json', 'robot.atlas', 'robot.png']) expect(existsSync(path.join(dir, f)), f).toBe(true);
    expect(Object.keys(JSON.parse(readFileSync(path.join(dir, 'robot.json'), 'utf8')).animations)).toEqual(['wave']);
    await page.locator('[data-testid=report-warnings]').waitFor();
    await shot('export-spine-done');
    await page.click('[data-testid=export-done]');
    await page.locator('[data-testid=export-dialog]').waitFor({ state: 'detached' });
  });

  it('exports Live2D motions with the keyboard through the submenu', { timeout: 240_000 }, async () => {
    await page.focus('[data-testid=file-menu-button]');
    await page.keyboard.press('Enter');
    await page.locator('[data-testid=file-menu]').waitFor();
    await page.focus('[data-testid=menu-export-to]');
    await page.keyboard.press('ArrowRight');
    await page.locator('[data-testid=export-menu]').waitFor();
    // → moves the focus to the first submenu item.
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'menu-export-spine', undefined, { timeout: 5000 });
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('menu-export-live2d');
    await page.keyboard.press('Enter');
    await page.locator('[data-testid=export-dialog]').waitFor();
    expect(await page.inputValue('[data-testid=export-dir]')).toBe('exports/robot-live2d');
    await clickConvert('[data-testid=export-confirm]');
    await page.locator('[data-testid=export-summary]').waitFor({ timeout: CONVERT_TIMEOUT });
    const dir = path.join(e.root, 'exports', 'robot-live2d');
    expect(existsSync(path.join(dir, 'robot.model3.json'))).toBe(true);
    expect(existsSync(path.join(dir, 'motions', 'turnHead.motion3.json'))).toBe(true);
    await shot('export-live2d-done');
    await page.keyboard.press('Escape');
    await page.locator('[data-testid=export-dialog]').waitFor({ state: 'detached' });
  });

  it('imports the Spine export from the computer: converted, opened, with its report', { timeout: 240_000 }, async () => {
    const spine = path.join(e.root, 'exports', 'robot-spine');
    copyFileSync(path.join(spine, 'robot.json'), path.join(e.outside, 'robot-spine.json'));
    copyFileSync(path.join(spine, 'robot.atlas'), path.join(e.outside, 'robot.atlas'));
    copyFileSync(path.join(spine, 'robot.png'), path.join(e.outside, 'robot.png'));
    await page.setInputFiles('[data-testid=import-input]', ['robot-spine.json', 'robot.atlas', 'robot.png'].map((f) => path.join(e.outside, f)));
    await page.locator('[data-testid=import-dialog]').waitFor();
    await page.locator('[data-testid=import-spine-note]').waitFor();
    const files = await page.textContent('[data-testid=import-files]');
    expect(files).toContain('Spine skeleton');
    expect(files).toContain('atlas');
    expect(files).toContain('page');
    expect(await page.textContent('[data-testid=import-confirm]')).toBe('Convert and open');
    await shot('import-spine');
    await clickConvert('[data-testid=import-confirm]');
    await waitOpen('robot-spine.r2d.json');
    const s = await stats();
    expect(s.errors).toBe(0);
    expect(s.draws).toBeGreaterThan(10);
    expect(existsSync(path.join(e.root, 'textures', 'robot.png'))).toBe(true);
    const toast = page.locator('.toast', { hasText: 'Imported Spine skeleton robot-spine.json as robot-spine.r2d.json' });
    await toast.waitFor({ timeout: 10000 });
    await shot('import-spine-done');
    await toast.locator('button', { hasText: 'Report' }).click();
    await page.locator('[data-testid=report-dialog]').waitFor();
    await shot('import-spine-report');
    await page.keyboard.press('Escape');
    await page.locator('[data-testid=report-dialog]').waitFor({ state: 'detached' });
    expect(pageErrors).toEqual([]);
  });
});
