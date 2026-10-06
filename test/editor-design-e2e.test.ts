/**
 * End-to-end test of the design-system gallery (dist/editor/gallery.html) in headless Chrome:
 * keyboard operation of the primitives (segmented control, switch, slider, menu, sheet with its
 * focus trap), appearance switching including nested scopes, the accessibility switches, and no
 * page errors on any page.
 *
 * Screenshots go to out/design-*.png: the editor mock at 1440x900 and 1024x700 in both appearances
 * (plus the sheet, Korean and reduced-transparency variants) and the three catalogue pages.
 *
 * Skips (with the reason logged) when the UI is not built (`npm run editor:build`) or Chrome cannot
 * be launched.
 */
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PACKAGE_ROOT } from '../src/api/templates.js';

const DIST = path.join(PACKAGE_ROOT, 'dist', 'editor');
const SHOTS = path.join(PACKAGE_ROOT, 'out');
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.map': 'application/json' };

interface Env {
  server: http.Server;
  browser: Browser;
  base: string;
}

async function setup(): Promise<Env | string> {
  if (!existsSync(path.join(DIST, 'gallery.html'))) return `no built gallery at ${path.join(DIST, 'gallery.html')} (run \`npm run editor:build\`)`;
  // The gallery is static: a file server on a free port is all it needs.
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const file = path.normalize(path.join(DIST, decodeURIComponent(url.pathname)));
    if (!file.startsWith(DIST) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/gallery.html`;
  try {
    const browser = await chromium.launch({
      channel: 'chrome',
      headless: true,
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    });
    return { server, browser, base };
  } catch (e) {
    server.close();
    return `cannot launch Chrome: ${(e as Error).message.split('\n')[0]}`;
  }
}

const env = await setup();
if (typeof env === 'string') console.warn(`[editor-design-e2e] skipped: ${env}`);
const ready = typeof env !== 'string';

afterAll(async () => {
  if (typeof env === 'string') return;
  // Chrome sometimes keeps running long after browser.close() on some machines: wait a bounded time.
  await Promise.race([env.browser.close(), new Promise((resolve) => setTimeout(resolve, 5000))]);
  env.server.closeAllConnections();
  env.server.close();
}, 30000);

describe.skipIf(!ready)('design-system gallery end to end (built UI + Chrome)', () => {
  const e = env as Env;
  let page: Page;
  const pageErrors: string[] = [];

  /** Open a gallery page; `query` like "appearance=dark&bare". */
  const open = async (hash: string, query = 'appearance=light'): Promise<void> => {
    await page.goto(`${e.base}?${query}#${hash}`);
    await page.waitForFunction(() => window.__r2Gallery?.ready === true, undefined, { timeout: 30000 });
    await page.locator('[data-testid=gallery]').waitFor();
  };
  const shot = async (name: string): Promise<void> => {
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SHOTS, `design-${name}.png`) });
  };
  /** What has the keyboard focus, as "tag|role|testid|text". */
  const focused = (): Promise<string> =>
    page.evaluate(() => {
      const a = document.activeElement;
      return a ? `${a.tagName.toLowerCase()}|${a.getAttribute('role') ?? ''}|${a.getAttribute('data-testid') ?? ''}|${(a.textContent ?? '').trim().slice(0, 24)}` : 'none';
    });
  const attr = (selector: string, name: string): Promise<string | null> => page.locator(selector).first().getAttribute(name);
  const bodyBackground = (): Promise<string> => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  beforeAll(async () => {
    mkdirSync(SHOTS, { recursive: true });
    page = await e.browser.newPage({ viewport: { width: 1440, height: 900 } });
    // Short fades instead of springs: the software rasterizer is slow, the tests assert end states.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    page.on('pageerror', (err) => pageErrors.push(err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') pageErrors.push(`console: ${msg.text()}`);
    });
  }, 60000);

  afterAll(async () => {
    await page?.close();
  });

  it('renders the editor mock with a real rig, in both appearances and at both window sizes', async () => {
    for (const appearance of ['light', 'dark'] as const) {
      for (const [w, h] of [
        [1440, 900],
        [1024, 700],
      ] as const) {
        await page.setViewportSize({ width: w, height: h });
        await open('mock', `appearance=${appearance}&bare`);
        await page.locator('.g-character[data-rendered=true]').waitFor({ timeout: 30000 });
        expect(await attr('html', 'data-appearance')).toBe(appearance);
        // The chrome floats: toolbar, sidebar, inspector and timeline are all inside the window.
        for (const name of ['mock-toolbar', 'mock-toast']) {
          const box = await page.locator(`[data-testid=${name}]`).boundingBox();
          expect(box, name).not.toBeNull();
          expect(box!.x).toBeGreaterThanOrEqual(0);
          expect(box!.x + box!.width).toBeLessThanOrEqual(w);
          expect(box!.y + box!.height).toBeLessThanOrEqual(h);
        }
        // The character is drawn in the part of the canvas the panels leave free.
        const art = (await page.locator('.g-artboard').boundingBox())!;
        const sidebar = (await page.locator('.r2-panel[data-kind=sidebar]').boundingBox())!;
        const inspector = (await page.locator('.r2-panel[data-kind=inspector]').boundingBox())!;
        const timeline = (await page.locator('.r2-panel[data-kind=drawer]').boundingBox())!;
        expect(art.x).toBeGreaterThanOrEqual(sidebar.x + sidebar.width);
        expect(art.x + art.width).toBeLessThanOrEqual(inspector.x);
        expect(art.y + art.height).toBeLessThanOrEqual(timeline.y);
        expect(art.height).toBeGreaterThan(200);
        await shot(`mock-${appearance}-${w}x${h}`);
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  }, 120000);

  it('drives the placeholder character from the inspector slider with the keyboard', async () => {
    await open('mock', 'appearance=light&bare');
    await page.locator('.g-character[data-rendered=true]').waitFor({ timeout: 30000 });
    const pixels = (): Promise<string> => page.evaluate(() => (document.querySelector('.g-character') as HTMLCanvasElement).toDataURL().slice(-4000));
    const before = await pixels();
    const thumb = page.locator('[data-testid=mock-slider-AngleX] [role=slider]');
    await thumb.focus();
    expect(await thumb.getAttribute('aria-valuenow')).toBe('12');
    await page.keyboard.press('Home');
    expect(await thumb.getAttribute('aria-valuenow')).toBe('-30');
    await page.waitForFunction((b) => (document.querySelector('.g-character') as HTMLCanvasElement).toDataURL().slice(-4000) !== b, before, { timeout: 20000 });
    expect(await pixels()).not.toBe(before);
  }, 60000);

  it('opens the mock sheet: focus goes to its marked field, Tab stays inside, Escape returns the focus', async () => {
    await open('mock', 'appearance=light&bare');
    const opener = page.locator('[data-testid=mock-open-sheet]');
    await opener.focus();
    await page.keyboard.press('Enter');
    const sheet = page.locator('[data-testid=mock-sheet] [role=dialog]');
    await sheet.waitFor();
    expect(await sheet.getAttribute('aria-modal')).toBe('true');
    await page.waitForFunction(() => document.activeElement?.tagName === 'INPUT');
    expect(await page.evaluate(() => (document.activeElement as HTMLInputElement).value)).toBe('Hana');
    await shot('mock-sheet-light-1440x900');

    // More Tabs than the sheet has controls: the focus never leaves it, forwards or backwards.
    const seen = new Set<string>();
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]'))).toBe(true);
      seen.add(await focused());
    }
    expect(seen.size).toBeGreaterThanOrEqual(6);
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('Shift+Tab');
      expect(await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]'))).toBe(true);
    }

    await page.keyboard.press('Escape');
    await page.locator('[data-testid=mock-sheet]').waitFor({ state: 'detached' });
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('mock-open-sheet');
  }, 60000);

  it('operates the segmented control with the keyboard (radio group)', async () => {
    await open('components');
    const radios = page.locator('[data-testid=segmented] [role=radio]');
    expect(await page.locator('[data-testid=segmented]').getAttribute('role')).toBe('radiogroup');
    expect(await radios.count()).toBe(3);
    // One tab stop: the selected segment.
    expect(await radios.evaluateAll((els) => els.map((el) => (el as HTMLElement).tabIndex))).toEqual([0, -1, -1]);
    await radios.nth(0).focus();
    await page.keyboard.press('ArrowRight');
    expect(await radios.evaluateAll((els) => els.map((el) => el.getAttribute('aria-checked')))).toEqual(['false', 'true', 'false']);
    expect(await focused()).toContain('Bones');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight'); // wraps
    expect(await focused()).toContain('Parts');
    await page.keyboard.press('End');
    expect(await radios.nth(2).getAttribute('aria-checked')).toBe('true');
    expect(await radios.evaluateAll((els) => els.map((el) => (el as HTMLElement).tabIndex))).toEqual([-1, -1, 0]);
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Home');
    expect(await radios.nth(0).getAttribute('aria-checked')).toBe('true');
    // The thumb follows the selection.
    expect(await page.locator('[data-testid=segmented]').evaluate((el) => (el as HTMLElement).style.getPropertyValue('--r2-seg-index'))).toBe('0');
  }, 60000);

  it('toggles the switch with Space, Enter and the arrow keys', async () => {
    await open('components');
    const sw = page.locator('[data-testid=switch]');
    expect(await sw.getAttribute('role')).toBe('switch');
    expect(await sw.getAttribute('aria-checked')).toBe('true');
    await sw.focus();
    await page.keyboard.press('Space');
    expect(await sw.getAttribute('aria-checked')).toBe('false');
    await page.keyboard.press('Enter');
    expect(await sw.getAttribute('aria-checked')).toBe('true');
    await page.keyboard.press('ArrowLeft');
    expect(await sw.getAttribute('aria-checked')).toBe('false');
    await page.keyboard.press('ArrowLeft');
    expect(await sw.getAttribute('aria-checked')).toBe('false');
    await page.keyboard.press('ArrowRight');
    expect(await sw.getAttribute('aria-checked')).toBe('true');
    await sw.click();
    expect(await sw.getAttribute('aria-checked')).toBe('false');
  }, 60000);

  it('operates the slider with the keyboard, by dragging, and resets it on double-click', async () => {
    await open('components');
    const slider = page.locator('[data-testid=slider]');
    const thumb = slider.locator('[role=slider]');
    const value = async (): Promise<number> => Number(await thumb.getAttribute('aria-valuenow'));
    expect(await thumb.getAttribute('aria-valuemin')).toBe('-30');
    expect(await thumb.getAttribute('aria-valuemax')).toBe('30');
    expect(await value()).toBe(12);
    expect(await thumb.getAttribute('aria-valuetext')).toBe('12°');
    await thumb.focus();
    await page.keyboard.press('ArrowRight');
    expect(await value()).toBe(13);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowLeft');
    expect(await value()).toBe(11);
    await page.keyboard.press('Shift+ArrowRight');
    expect(await value()).toBe(21);
    await page.keyboard.press('PageDown');
    expect(await value()).toBe(11);
    await page.keyboard.press('End');
    expect(await value()).toBe(30);
    await page.keyboard.press('ArrowRight');
    expect(await value()).toBe(30);
    await page.keyboard.press('Home');
    expect(await value()).toBe(-30);

    // Press on the track: the knob jumps there; drag: it follows.
    const box = (await slider.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    expect(await value()).toBe(0);
    expect(await slider.getAttribute('data-dragging')).toBe('');
    await page.mouse.move(box.x + box.width * 0.75, box.y + box.height / 2, { steps: 4 });
    expect(await value()).toBeGreaterThan(10);
    expect(await value()).toBeLessThan(20);
    await page.mouse.up();
    expect(await slider.getAttribute('data-dragging')).toBeNull();

    await slider.dblclick({ position: { x: 10, y: box.height / 2 } });
    expect(await value()).toBe(0);
  }, 60000);

  it('opens a menu from the keyboard, finds an item by typing, and returns the focus', async () => {
    await open('components');
    const button = page.locator('[data-testid=menu-button]');
    await button.focus();
    await page.keyboard.press('ArrowDown');
    const menu = page.locator('[role=menu]');
    await menu.waitFor();
    expect(await button.getAttribute('aria-expanded')).toBe('true');
    await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'menuitem');
    expect(await focused()).toContain('Rename');
    await page.keyboard.press('ArrowDown');
    expect(await focused()).toContain('Duplicate');
    await page.keyboard.press('End');
    expect(await focused()).toContain('Delete'); // the disabled "Export Layer…" is skipped on the way
    await page.keyboard.press('ArrowUp');
    expect(await focused()).toContain('Lock');
    // Type-ahead: "d" goes to the next item that starts with it, "du" narrows it down.
    await page.keyboard.type('d');
    expect(await focused()).toContain('Delete');
    await page.keyboard.type('u');
    expect(await focused()).toContain('Duplicate');
    await page.keyboard.press('Enter');
    await menu.waitFor({ state: 'detached' });
    expect(await page.locator('[data-testid=menu-result]').textContent()).toContain('duplicate');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('menu-button');

    // Escape closes without choosing.
    await page.keyboard.press('Enter');
    await menu.waitFor();
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'detached' });
    expect(await button.getAttribute('aria-expanded')).toBe('false');
    expect(await page.locator('[data-testid=menu-result]').textContent()).toContain('duplicate');
  }, 60000);

  it('operates number field, select, tabs, toolbar and split-view divider with the keyboard', async () => {
    await open('components');

    // NumberField: arrows step on the grid, typed text is committed on Enter, Escape restores.
    const number = page.locator('[data-testid=number]');
    await number.focus();
    expect(await number.getAttribute('role')).toBe('spinbutton');
    expect(await number.inputValue()).toBe('-12.5');
    await page.keyboard.press('ArrowUp');
    expect(await number.inputValue()).toBe('-12');
    await page.keyboard.press('Shift+ArrowDown');
    expect(await number.inputValue()).toBe('-17');
    await number.fill('33,25');
    await page.keyboard.press('Enter');
    expect(await number.getAttribute('aria-valuenow')).toBe('33.25');
    await number.fill('abc');
    await page.keyboard.press('Escape');
    expect(await number.inputValue()).toBe('33.25');

    // Select: opens at the current value, arrows move, Enter chooses, the focus returns.
    const select = page.locator('[data-testid=select]');
    await select.focus();
    await page.keyboard.press('ArrowDown');
    await page.locator('[role=listbox]').waitFor();
    await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'option');
    expect(await page.locator('[role=option][aria-selected=true]').textContent()).toBe('Normal');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.locator('[role=listbox]').waitFor({ state: 'detached' });
    expect((await select.textContent())?.trim()).toBe('Multiply');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('select');

    // Tabs: arrows select, disabled tabs are skipped, the panel follows.
    const tabs = page.locator('[data-testid=tabs] [role=tab]');
    await tabs.nth(0).focus();
    await page.keyboard.press('ArrowRight');
    expect(await tabs.evaluateAll((els) => els.map((el) => el.getAttribute('aria-selected')))).toEqual(['false', 'true', 'false', 'false']);
    expect(await page.locator('[data-testid=tabs] [role=tabpanel]').textContent()).toContain('parameters');
    await page.keyboard.press('End');
    expect(await tabs.nth(2).getAttribute('aria-selected')).toBe('true');

    // Toolbar: arrows move between its controls.
    const toolbar = page.locator('[data-testid=toolbar]');
    expect(await toolbar.getAttribute('role')).toBe('toolbar');
    await toolbar.locator('button').first().focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Pan');
    await page.keyboard.press('End');
    expect(await focused()).toContain('Done');

    // SplitView: the divider resizes with arrows, clamps at Home, collapses and expands on Enter.
    const divider = page.locator('[data-testid=splitview] [role=separator]').first();
    const pane = page.locator('[data-testid=splitview] [data-pane=left] .r2-split-pane');
    await divider.focus();
    expect(await divider.getAttribute('aria-valuenow')).toBe('180');
    await page.keyboard.press('ArrowRight');
    expect(await divider.getAttribute('aria-valuenow')).toBe('196');
    expect(Math.round((await pane.boundingBox())!.width)).toBe(196);
    await page.keyboard.press('Home');
    expect(await divider.getAttribute('aria-valuenow')).toBe('120');
    await page.keyboard.press('Enter');
    expect(await pane.getAttribute('data-collapsed')).toBe('');
    expect(await divider.getAttribute('aria-valuenow')).toBe('0');
    await page.keyboard.press('Enter');
    expect(await pane.getAttribute('data-collapsed')).toBeNull();
    expect(await divider.getAttribute('aria-valuenow')).toBe('120');
  }, 60000);

  it('traps the focus in a sheet, closes on Escape and gives the focus back; an alert never defaults to the destructive action', async () => {
    await open('components');
    const opener = page.locator('[data-testid=sheet-button]');
    await opener.focus();
    await page.keyboard.press('Enter');
    const dialog = page.locator('[data-testid=sheet] [role=dialog]');
    await dialog.waitFor();
    // The first control gets the focus, not the grabber.
    await page.waitForFunction(() => document.activeElement?.closest('[role=dialog]') !== null && document.activeElement?.tagName === 'BUTTON');
    expect(await focused()).toContain('sheet-cancel');
    const stops = new Set<string>();
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]'))).toBe(true);
      stops.add(await focused());
    }
    expect([...stops].some((s) => s.includes('sheet-done'))).toBe(true);
    expect([...stops].some((s) => s.includes('sheet-field'))).toBe(true);
    // Typing in the field does not trigger anything outside the sheet.
    await page.locator('[data-testid=sheet-field]').focus();
    await page.keyboard.type('x');
    expect(await page.locator('[data-testid=sheet-field]').inputValue()).toContain('x');
    await page.keyboard.press('Escape');
    await page.locator('[data-testid=sheet]').waitFor({ state: 'detached' });
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('sheet-button');

    // The scrim dismisses too.
    await opener.click();
    await dialog.waitFor();
    await page.mouse.click(20, 120);
    await page.locator('[data-testid=sheet]').waitFor({ state: 'detached' });

    // The grabber: a short drag springs back, a long one dismisses.
    await opener.click();
    await dialog.waitFor();
    const dragGrabber = async (distance: number): Promise<void> => {
      const g = (await page.locator('[data-testid=sheet] .r2-sheet-grabber').boundingBox())!;
      await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
      await page.mouse.down();
      await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2 + distance, { steps: 6 });
      await page.waitForTimeout(250); // not a flick
      await page.mouse.up();
    };
    await dragGrabber(40);
    await page.waitForTimeout(300);
    expect(await page.locator('[data-testid=sheet]').count()).toBe(1);
    expect(await dialog.getAttribute('data-dragging')).toBeNull();
    await dragGrabber(200);
    await page.locator('[data-testid=sheet]').waitFor({ state: 'detached' });

    await page.locator('[data-testid=alert-button]').click();
    const alert = page.locator('[data-testid=alert] [role=alertdialog]');
    await alert.waitFor();
    await page.waitForFunction(() => document.activeElement?.closest('[role=alertdialog]') !== null && document.activeElement?.tagName === 'BUTTON');
    expect(await focused()).toContain('Cancel');
    await page.keyboard.press('Escape');
    await page.locator('[data-testid=alert]').waitFor({ state: 'detached' });
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('alert-button');
  }, 90000);

  it('switches the appearance from the header, and nested scopes keep their own', async () => {
    await open('components', '');
    const group = page.locator('[data-testid=appearance-switch]');
    await group.locator('[role=radio][data-value=dark]').click();
    expect(await attr('html', 'data-appearance')).toBe('dark');
    expect(await bodyBackground()).toBe('rgb(0, 0, 0)');
    expect(await page.evaluate(() => getComputedStyle(document.body).color)).toBe('rgb(255, 255, 255)');
    await group.locator('[role=radio][data-value=light]').click();
    expect(await attr('html', 'data-appearance')).toBe('light');
    expect(await bodyBackground()).toBe('rgb(242, 242, 247)');
    expect(await page.evaluate(() => getComputedStyle(document.body).color)).toBe('rgb(0, 0, 0)');
    // Automatic follows the system setting.
    await group.locator('[role=radio][data-value=auto]').click();
    expect(await attr('html', 'data-appearance')).toBe('auto');
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    expect(await bodyBackground()).toBe('rgb(0, 0, 0)');
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    expect(await bodyBackground()).toBe('rgb(242, 242, 247)');
    // Code that paints outside CSS (WebGL, canvas overlays) reads the resolved colours.
    const token = (name: string, scope?: string): Promise<number[]> =>
      page.evaluate(([n, s]) => window.__r2Gallery!.readColorToken(n!, s ? document.querySelector(s)! : undefined), [name, scope] as const);
    expect(await token('--r2-canvas')).toEqual([232, 232, 237, 1]);
    expect(await token('--r2-tint-solid')).toEqual([0, 113, 227, 1]);
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    expect(await token('--r2-canvas')).toEqual([17, 17, 19, 1]);
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    // The choice is remembered.
    await group.locator('[role=radio][data-value=dark]').click();
    await open('components', '');
    expect(await attr('html', 'data-appearance')).toBe('dark');

    // Side by side: a light and a dark scope on one page, and a menu opened in one inherits it.
    await open('components', 'appearance=light&compare');
    const sides = await page.evaluate(() =>
      ['compare-light', 'compare-dark'].map((id) => {
        const el = document.querySelector(`[data-testid=${id}]`)!;
        const cs = getComputedStyle(el);
        return [cs.backgroundColor, cs.color];
      }),
    );
    expect(sides).toEqual([
      ['rgb(242, 242, 247)', 'rgb(0, 0, 0)'],
      ['rgb(0, 0, 0)', 'rgb(255, 255, 255)'],
    ]);
    await page.locator('[data-testid=compare-dark] [data-testid=menu-button]').click();
    await page.locator('[role=menu]').waitFor();
    expect(await page.locator('.r2-layer:has([role=menu])').getAttribute('data-appearance')).toBe('dark');
    expect(await page.locator('[role=menu]').evaluate((el) => getComputedStyle(el).color)).toBe('rgb(255, 255, 255)');
    await page.keyboard.press('Escape');
    await shot('compare');
  }, 90000);

  it('turns materials solid for Reduce Transparency and strengthens colours for Increase Contrast', async () => {
    await open('mock', 'appearance=light&bare');
    const panel = page.locator('.r2-panel[data-kind=sidebar]');
    const filter = (): Promise<string> => panel.evaluate((el) => getComputedStyle(el).backdropFilter);
    const label2 = (): Promise<string> => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--r2-label-2'));
    expect(await filter()).toContain('blur(');
    const standard = await label2();

    await open('mock', 'appearance=light&bare&transparency=reduce');
    expect(await attr('html', 'data-transparency')).toBe('reduce');
    expect(await filter()).toBe('none');
    expect(await panel.evaluate((el) => getComputedStyle(el).backgroundImage)).toBe('none');
    await page.locator('.g-character[data-rendered=true]').waitFor({ timeout: 30000 });
    await shot('mock-solid-light-1440x900');

    // The same switch from the system setting.
    await open('mock', 'appearance=light&bare');
    await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'none' });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
    expect(await filter()).toBe('none');
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-contrast', value: 'more' }] });
    expect(await label2()).not.toBe(standard);
    await cdp.send('Emulation.setEmulatedMedia', { features: [] });
    await cdp.detach();
    await page.emulateMedia({ reducedMotion: 'reduce' });

    await open('mock', 'appearance=dark&bare&contrast=more');
    expect(await attr('html', 'data-contrast')).toBe('more');
    expect(await label2()).not.toBe(standard);
  }, 90000);

  it('shows Korean interface text and every catalogue page without errors', async () => {
    await open('mock', 'appearance=light&bare&lang=ko&sheet');
    await page.locator('[data-testid=mock-sheet] [role=dialog]').waitFor();
    expect(await page.locator('[data-testid=editor-mock]').getAttribute('lang')).toBe('ko');
    expect(await page.locator('[data-testid=mock-save]').textContent()).toBe('저장');
    expect(await page.locator('[data-testid=mock-sheet] .r2-sheet-title').textContent()).toBe('새 아바타');
    // Korean wraps between words inside the sheet.
    expect(await page.locator('[data-testid=mock-sheet] .g-sheet-lead').evaluate((el) => getComputedStyle(el).wordBreak)).toBe('keep-all');
    await page.locator('.g-character[data-rendered=true]').first().waitFor({ timeout: 30000 });
    await shot('mock-ko-light-1440x900');
    await page.keyboard.press('Escape');

    for (const [name, height] of [
      ['components', 2900],
      ['tokens', 3100],
      ['icons', 1500],
    ] as const) {
      for (const appearance of ['light', 'dark'] as const) {
        await page.setViewportSize({ width: 1440, height });
        await open(name, `appearance=${appearance}`);
        expect(await page.locator('.g-specimen').count()).toBeGreaterThan(0);
        await shot(`${name}-${appearance}`);
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await open('icons');
    expect(await page.locator('[data-testid=icon-grid] svg').count()).toBeGreaterThan(100);
  }, 120000);

  it('reports no page errors', () => {
    expect(pageErrors).toEqual([]);
  });
});
