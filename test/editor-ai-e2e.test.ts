/**
 * End-to-end test of the AI panel (editor/src/ai): the real editor server with the agent bridge
 * pointed at the FAKE agent CLIs (test/fixtures/fake-agents; never the real Codex / Claude Code),
 * the built UI and headless Chrome.
 *
 * Open the panel, send a request and watch commands, file changes and the answer appear; stop a job
 * that hangs; continue a conversation; reload the page while a job runs; see "Model updated"; the
 * Codex Windows sandbox card and its one-click fix; a second request while one runs; the panel when
 * the bridge is disabled. Screenshots go to out/editor-ai-e2e-*.png.
 *
 * The UI is read from dist/editor (`npm run editor:build`), or from REV2D_E2E_UI (a build of your
 * own: npx vite build --config editor/vite.config.ts --outDir <dir>). Skips with a logged reason when
 * the UI is not built or Chrome cannot be launched.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blankModel, PACKAGE_ROOT } from '../src/api/templates.js';
import { formatModelJson } from '../src/core/format.js';
import type { AgentJobList, AgentSettingsInfo, SessionInfo } from '../src/node/editor-registry.js';
import type { EditorServer } from '../src/server/index.js';

const UI_DIR = process.env.REV2D_E2E_UI ? path.resolve(process.env.REV2D_E2E_UI) : path.join(PACKAGE_ROOT, 'dist', 'editor');
const FAKES = path.join(PACKAGE_ROOT, 'test', 'fixtures', 'fake-agents');
const SHOTS = path.join(PACKAGE_ROOT, 'out');

interface Env {
  server: EditorServer;
  browser: Browser;
  dir: string;
  file: string;
}

async function setup(): Promise<Env | string> {
  if (!existsSync(path.join(UI_DIR, 'index.html'))) return `no built editor UI at ${UI_DIR} (run \`npm run editor:build\`, or set REV2D_E2E_UI)`;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rev2d-ai-e2e-'));
  const file = path.join(dir, 'model.r2d.json');
  writeFileSync(file, formatModelJson(blankModel({ name: 'ai-e2e' })));
  let server: EditorServer;
  try {
    const { startEditorServer } = await import('../src/server/index.js');
    server = await startEditorServer({
      file,
      port: 0,
      register: false,
      devVite: false,
      staticDir: UI_DIR,
      log: () => undefined,
      agent: {
        commands: { codex: [process.execPath, path.join(FAKES, 'fake-codex.mjs')], claude: [process.execPath, path.join(FAKES, 'fake-claude.mjs')] },
        logDir: path.join(dir, '.logs'),
        maxStartsPerMinute: 1000,
        // The Codex Windows handling on every host (the fakes run either way); settings stay in memory.
        platform: 'win32',
        settingsFile: null,
      },
    });
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    return `editor server unavailable: ${(e as Error).message}`;
  }
  try {
    const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    return { server, browser, dir, file };
  } catch (e) {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
    return `cannot launch Chrome: ${(e as Error).message.split('\n')[0]}`;
  }
}

const env = await setup();
if (typeof env === 'string') console.warn(`[editor-ai-e2e] skipped: ${env}`);
const ready = typeof env !== 'string';

afterAll(async () => {
  if (typeof env === 'string') return;
  await Promise.race([env.browser.close(), new Promise((resolve) => setTimeout(resolve, 5000))]);
  await env.server.close();
  rmSync(env.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}, 30000);

/** The token and a GET of the bridge, as a test client (not the page). */
async function agentGet<T>(e: Env, p: string): Promise<T> {
  const session = (await (await fetch(`${e.server.url}/api/session`)).json()) as SessionInfo;
  return (await (await fetch(`${e.server.url}${p}`, { headers: { 'X-Rev2D-Token': session.token ?? '' } })).json()) as T;
}

async function openEditor(e: Env, query = '', size = { width: 1440, height: 900 }): Promise<Page> {
  const page = await e.browser.newPage({ viewport: size, locale: 'en-US' });
  await page.goto(`${e.server.url}/${query ? `?${query}` : ''}`);
  await page.waitForFunction(() => window.__rev2d?.stats().status === 'ready', null, { timeout: 30000 });
  return page;
}

async function openPanel(page: Page): Promise<void> {
  await page.click('[data-testid=toggle-ai]');
  await page.waitForSelector('[data-testid=ai-panel][data-status=ready]', { timeout: 15000 });
}

/** Start from an empty conversation. */
async function fresh(page: Page): Promise<void> {
  if (await page.isEnabled('[data-testid=ai-new]')) await page.click('[data-testid=ai-new]');
  await page.waitForSelector('[data-testid=ai-welcome]', { timeout: 5000 });
}

async function send(page: Page, text: string): Promise<void> {
  await page.fill('[data-testid=ai-input]', text);
  await page.keyboard.press('Enter');
}

/** The last turn of the conversation shown. */
const lastTurn = '[data-testid=ai-turn]:last-of-type';

async function waitTurnEnd(page: Page, state?: string): Promise<void> {
  await page.waitForSelector(`${lastTurn} [data-testid=ai-turn-end]${state ? `[data-state=${state}]` : ''}`, { timeout: 30000 });
}

async function stopActive(e: Env): Promise<void> {
  const list = await agentGet<AgentJobList>(e, '/api/agent/jobs');
  if (!list.active) return;
  const session = (await (await fetch(`${e.server.url}/api/session`)).json()) as SessionInfo;
  await fetch(`${e.server.url}/api/agent/jobs/${list.active}/cancel`, { method: 'POST', headers: { 'X-Rev2D-Token': session.token ?? '', 'Content-Type': 'application/json' }, body: '{}' });
}

describe.skipIf(!ready)('AI panel end to end (server + fake agents + built UI + Chrome)', () => {
  const e = env as Env;
  let page: Page;
  const pageErrors: string[] = [];

  beforeAll(async () => {
    page = await openEditor(e);
    page.on('pageerror', (err) => pageErrors.push(err.message));
  }, 60000);

  afterAll(async () => {
    await page?.close();
  });

  it('turns on the toolbar button and opens on the welcome with the providers', async () => {
    const button = page.locator('[data-testid=toggle-ai]');
    expect(await button.getAttribute('aria-disabled')).toBeNull();
    await openPanel(page);
    expect(await button.getAttribute('aria-pressed')).toBe('true');
    await page.waitForSelector('[data-testid=ai-welcome]');
    expect(await page.locator('[data-testid=ai-provider-picker] [role=radio]').allInnerTexts()).toEqual(['Codex CLI', 'Claude Code']);
    expect(await page.innerText('[data-testid=ai-provider-version]')).toBe('Version 0.0.0-fake');
    // The blank model has animations? It has none: the suggestions fit that.
    expect(await page.locator('[data-testid=ai-suggestion]').count()).toBeGreaterThan(1);
    expect(await page.innerText('[data-testid=ai-where]')).toMatch(/^Working in rev2d-ai-e2e-/);
    expect(await page.innerText('[data-testid=ai-sandbox-words]')).toBe('Can edit files here');
    // Codex has an image generator: the switch is there, off.
    expect(await page.getAttribute('[data-testid=ai-image-switch]', 'aria-checked')).toBe('false');
    // A suggestion fills the field; Shift+Enter makes a new line instead of sending.
    await page.click('[data-testid=ai-suggestion] >> nth=0');
    expect((await page.inputValue('[data-testid=ai-input]')).length).toBeGreaterThan(5);
    await page.focus('[data-testid=ai-input]');
    await page.keyboard.press('Shift+Enter');
    expect(await page.inputValue('[data-testid=ai-input]')).toMatch(/\n$/);
    expect(await page.locator('[data-testid=ai-turn]').count()).toBe(0);
    await page.fill('[data-testid=ai-input]', '');
  });

  it('sends a request and shows the commands, file changes, to-dos and the answer', async () => {
    await send(page, 'Widen the head warp and check it. [[fake:full]]');
    await page.waitForSelector(`${lastTurn} [data-testid=ai-request]`);
    expect(await page.innerText(`${lastTurn} [data-testid=ai-request]`)).toBe('Widen the head warp and check it. [[fake:full]]');
    await waitTurnEnd(page, 'done');
    expect(await page.innerText(`${lastTurn} [data-testid=ai-message]`)).toContain('Widened the head warp; validate shows 0 errors.');
    expect(await page.innerText(`${lastTurn} [data-testid=ai-message] code`)).toBe('validate');
    // The checklist, updated in place: one card with the final state.
    expect(await page.locator(`${lastTurn} [data-testid=ai-todo]`).count()).toBe(1);
    expect(await page.locator(`${lastTurn} [data-testid=ai-todo-item][data-done]`).count()).toBe(1);
    expect(await page.innerText(`${lastTurn} [data-testid=ai-turn-end]`)).toMatch(/Done\s+\d+ s · 48\.2K tokens in · 1\.6K out/);
    // The activity is folded to a summary once the job ended; opening it shows one row per item.
    const activity = page.locator(`${lastTurn} [data-testid=ai-activity]`, { hasText: 'Ran 2 commands' });
    expect(await activity.innerText()).toContain('Changed 3 files');
    await activity.locator('.ed-ai-activity-head').click();
    expect(await activity.locator('[data-testid=ai-command]').count()).toBe(2);
    expect(await activity.locator('[data-testid=ai-command] >> nth=0').innerText()).toContain('rev2d validate hero.r2d.json --json');
    expect(await activity.locator('[data-testid=ai-command][data-status=failed]').count()).toBe(1);
    expect(await activity.locator('[data-testid=ai-file]').allInnerTexts()).toEqual([expect.stringMatching(/Edited\s+hero\.r2d\.json/), expect.stringMatching(/Created\s+out\/head\.png/), expect.stringMatching(/Deleted\s+old\.r2d\.json/)]);
    // A model file offers to open it.
    expect(await activity.locator('[data-testid=ai-file] [data-testid=ai-file-show]').count()).toBe(1);
    // A command's output opens below it.
    await activity.locator('[data-testid=ai-command] >> nth=0').locator('button').click();
    expect(await activity.locator('.ed-ai-output').innerText()).toContain('"ok":true');
    await page.screenshot({ path: path.join(SHOTS, 'editor-ai-e2e-full-light.png') }).catch(() => undefined);
  });

  it('continues the conversation with a follow-up in the same provider session', async () => {
    expect(await page.getAttribute('[data-testid=ai-input]', 'placeholder')).toBe('Reply…');
    await send(page, 'And tell me what you received.');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid=ai-turn]').length === 2, null, { timeout: 15000 });
    await waitTurnEnd(page, 'done');
    expect(await page.locator(`${lastTurn} [data-testid=ai-message]`).count()).toBe(1);
    // The echo of the fake: the follow-up resumed the provider session of the first job.
    const list = await agentGet<AgentJobList>(e, '/api/agent/jobs');
    expect(list.jobs[0]!.resumeOf).toBe(list.jobs[1]!.id);
    const echo = JSON.parse(list.jobs[0]!.finalMessage!) as { resumed: boolean; argv: string[] };
    expect(echo.resumed).toBe(true);
    expect(echo.argv).toContain('resume');
  });

  it('stops a job that hangs', async () => {
    await fresh(page);
    await send(page, 'Work on it for a long time [[fake:hang]]');
    await page.waitForSelector('[data-testid=ai-progress]', { timeout: 15000 });
    await page.waitForSelector('[data-testid=ai-typing]');
    expect(await page.innerText('[data-testid=ai-elapsed]')).toMatch(/^0:0\d$/);
    // While it runs the field waits.
    expect(await page.isDisabled('[data-testid=ai-send]')).toBe(true);
    await page.click('[data-testid=ai-stop]');
    await waitTurnEnd(page, 'cancelled');
    expect(await page.locator('[data-testid=ai-progress]').count()).toBe(0);
    expect(await page.innerText(`${lastTurn} [data-testid=ai-turn-end]`)).toContain('Stopped');
    expect((await agentGet<AgentJobList>(e, '/api/agent/jobs')).active).toBeNull();
  });

  it('restores the conversation after a page reload and keeps streaming', async () => {
    await fresh(page);
    await send(page, 'Think out loud [[fake:chatty]]');
    await page.waitForSelector(`${lastTurn} [data-testid=ai-reasoning]`, { timeout: 15000 });
    await page.reload();
    await page.waitForFunction(() => window.__rev2d?.stats().status === 'ready', null, { timeout: 30000 });
    await openPanel(page);
    // The request, the activity so far and the progress are back.
    await page.waitForSelector(`${lastTurn} [data-testid=ai-request]`, { timeout: 15000 });
    expect(await page.innerText(`${lastTurn} [data-testid=ai-request]`)).toBe('Think out loud [[fake:chatty]]');
    await page.waitForSelector('[data-testid=ai-progress]');
    const count = () => page.locator(`${lastTurn} [data-testid=ai-reasoning]`).count();
    const before = await count();
    expect(before).toBeGreaterThan(0);
    // New events keep arriving over the event stream after the reload.
    await expect.poll(count, { timeout: 15000 }).toBeGreaterThan(before + 5);
    await page.click('[data-testid=ai-stop]');
    await waitTurnEnd(page, 'cancelled');
  });

  it('notes "Model updated" when the agent changes the open model, and the editor reloads it', async () => {
    await fresh(page);
    const version = await page.evaluate(() => window.__rev2d!.stats().modelVersion);
    await send(page, 'Rename the model [[fake:edit-model]]');
    await waitTurnEnd(page, 'done');
    await page.waitForSelector(`${lastTurn} [data-testid=ai-model-updated]`, { timeout: 15000 });
    expect(await page.innerText(`${lastTurn} [data-testid=ai-model-updated]`)).toBe('Model updated');
    await expect.poll(() => page.evaluate(() => window.__rev2d!.stats().modelVersion), { timeout: 10000 }).toBeGreaterThan(version);
    expect(JSON.parse(readFileSync(e.file, 'utf8')).meta.name).toBe('edited-by-agent');
  });

  it('explains a second request while one runs, and shows the running one', async () => {
    await fresh(page);
    await send(page, 'Busy [[fake:hang]]');
    await page.waitForSelector('[data-testid=ai-progress]', { timeout: 15000 });
    const running = (await agentGet<AgentJobList>(e, '/api/agent/jobs')).active;
    expect(running).not.toBeNull();
    // Another tab (or an AI tool) asks too: the panel says so instead of showing raw JSON.
    const other = await openEditor(e);
    try {
      await openPanel(other);
      await other.waitForSelector(`[data-testid=ai-turn][data-job="${running}"]`, { timeout: 15000 });
      await fresh(other);
      // The running job of the other conversation is shown in the progress strip.
      expect(await other.innerText('[data-testid=ai-progress-status]')).toBe('Another request is running');
      await other.fill('[data-testid=ai-input]', 'me too');
      // The send button waits while a job runs; the composer does not send.
      expect(await other.isDisabled('[data-testid=ai-send]')).toBe(true);
      await other.click('[data-testid=ai-show-running]');
      await other.waitForSelector(`[data-testid=ai-turn][data-job="${running}"]`);
    } finally {
      await other.close();
    }
    await page.click('[data-testid=ai-stop]');
    await waitTurnEnd(page, 'cancelled');
  });

  it('shows the Codex Windows sandbox card and applies the fix', async () => {
    await fresh(page);
    await send(page, 'Validate the model [[fake:helper-exit]]');
    await page.waitForSelector(`${lastTurn} [data-testid=ai-sandbox-card][data-variant=offer]`, { timeout: 20000 });
    await waitTurnEnd(page);
    expect(await page.innerText(`${lastTurn} [data-testid=ai-sandbox-card]`)).toContain('Codex cannot run commands on this PC');
    await page.click(`${lastTurn} [data-testid=ai-sandbox-repair]`);
    expect(await page.innerText(`${lastTurn} [data-testid=ai-sandbox-steps]`)).toContain('administrator');
    await page.screenshot({ path: path.join(SHOTS, 'editor-ai-e2e-sandbox-light.png') }).catch(() => undefined);
    await page.click(`${lastTurn} [data-testid=ai-sandbox-fix]`);
    await page.waitForSelector(`${lastTurn} [data-testid=ai-sandbox-card][data-variant=fixed]`);
    const settings = await agentGet<AgentSettingsInfo>(e, '/api/agent/settings');
    expect(settings).toMatchObject({ settings: { codexWindowsSandbox: 'unelevated' }, sources: { codexWindowsSandbox: 'user' } });
    // The settings popover shows the same, with where it comes from.
    await page.click('[data-testid=ai-settings]');
    expect(await page.getAttribute('[data-testid=ai-settings-unelevated]', 'aria-checked')).toBe('true');
    expect(await page.innerText('[data-testid=ai-settings-source]')).toBe('Now: chosen here');
    await page.keyboard.press('Escape');
    // Run it again: the new job runs with the unelevated sandbox; this fake still fails, and the card no longer offers it.
    await page.click(`${lastTurn} [data-testid=ai-sandbox-again]`);
    await page.waitForFunction(() => document.querySelectorAll('[data-testid=ai-turn]').length === 1 && !!document.querySelector('[data-testid=ai-turn] [data-testid=ai-sandbox-card][data-variant=already]'), null, { timeout: 20000 });
    const list = await agentGet<AgentJobList>(e, '/api/agent/jobs');
    expect(list.jobs[0]!.title).toBe('Validate the model [[fake:helper-exit]]');
    // Back to the person's Codex configuration from the settings popover.
    await page.click('[data-testid=ai-settings]');
    await page.click('[data-testid=ai-settings-unelevated]');
    await expect.poll(async () => (await agentGet<AgentSettingsInfo>(e, '/api/agent/settings')).settings.codexWindowsSandbox, { timeout: 5000 }).toBe('config');
    await page.keyboard.press('Escape');
  });

  it('keeps the conversation readable in Korean and in the dark appearance', async () => {
    const ko = await openEditor(e, 'lang=ko&appearance=dark&materials=glass');
    try {
      await openPanel(ko);
      await fresh(ko);
      expect(await ko.innerText('.ed-ai .r2-panel-title')).toBe('AI 어시스턴트');
      expect(await ko.innerText('[data-testid=ai-sandbox-words]')).toBe('파일 수정 가능');
      await ko.screenshot({ path: path.join(SHOTS, 'editor-ai-e2e-welcome-ko-dark.png') }).catch(() => undefined);
      await send(ko, '헤드 워프를 넓히고 확인해 줘 [[fake:full]]');
      await waitTurnEnd(ko, 'done');
      expect(await ko.innerText(`${lastTurn} [data-testid=ai-turn-end]`)).toMatch(/^완료/);
      await ko.screenshot({ path: path.join(SHOTS, 'editor-ai-e2e-full-ko-dark.png') }).catch(() => undefined);
    } finally {
      await ko.close();
    }
    await stopActive(e);
  });

  it('explains how to turn the bridge on when it is disabled', async () => {
    const off = await e.browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
    try {
      await off.route('**/api/session', (route) =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify({ token: null, agent: { enabled: false, reason: 'the editor is bound to 0.0.0.0, not a loopback address' } } satisfies SessionInfo) }),
      );
      await off.goto(e.server.url);
      await off.waitForFunction(() => window.__rev2d?.stats().status === 'ready', null, { timeout: 30000 });
      await off.click('[data-testid=toggle-ai]');
      await off.waitForSelector('[data-testid=ai-disabled]', { timeout: 10000 });
      const text = await off.innerText('[data-testid=ai-disabled]');
      expect(text).toContain('AI Is Turned Off Here');
      expect(text).toContain('--allow-agent');
      expect(text).toContain('bound to 0.0.0.0');
      expect(await off.locator('[data-testid=ai-input]').count()).toBe(0);
    } finally {
      await off.close();
    }
  });

  it('raised no page errors', () => {
    expect(pageErrors).toEqual([]);
  });
});
