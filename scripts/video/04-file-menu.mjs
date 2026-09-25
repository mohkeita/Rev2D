/**
 * Step 4 - "and it's a real editor": the File menu / start screen, recorded from the real UI.
 *
 *   node scripts/video/04-file-menu.mjs
 *
 * A real `rev2d edit <empty workspace dir>` server (sandboxed home: empty recent list) and the built
 * editor UI in Chrome, driven with the real mouse and keyboard (Playwright), recorded with the CDP
 * screencast. Sequence:
 *   start screen -> File menu -> New... -> pick "Hana" -> Create (the model opens)
 *   -> File menu (Save / Save As / Close now enabled) -> Save As... "hana-v2" -> Save
 *   -> File > Close (back to the start screen, both files under Recent) -> click a recent file (opens again)
 * The files really land in out/video/work/rev2d-demo/ (checked at the end).
 *
 * Output: out/video/assets/file-menu/editor-file-menu.mp4 (1600x900, 30 fps), actions.json (what was
 * clicked when, video clock), key frames in out/video/check/file-menu-*.png.
 * The pointer is drawn by a small overlay that mirrors the real mouse events (headless Chrome has no
 * OS cursor); it is noted in the manifest.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ASSETS, OUT, bytesOf, ensureDir, ffmpeg, log, probe, rel, updateManifest } from './lib.mjs';
import { CURSOR_SCRIPT, Screencast, centerOf, glide, launchChrome, startEditor } from './recorder.mjs';

const W = 1600;
const H = 900;
const dir = ensureDir(path.join(ASSETS, 'file-menu'));
const checkDir = ensureDir(path.join(OUT, 'check'));
const WS_NAME = 'rev2d-demo';
const workDir = ensureDir(path.join(OUT, 'work'));
const ws = path.join(workDir, WS_NAME);
rmSync(ws, { recursive: true, force: true });
ensureDir(ws);
// Fresh recent list for this sandboxed home.
rmSync(path.join(OUT, 'home', '.rev2d', 'recent.json'), { force: true });

/**
 * The editor shows the workspace root's absolute path (start screen, status bar, File menu). So the
 * public footage does not show the local user profile path, out/video/work is mapped to a temporary
 * drive letter with `subst` (removed again at the end; VIDEO_NO_SUBST=1 disables it). The files still
 * live in out/video/work/rev2d-demo.
 */
function mapDrive() {
  if (process.platform !== 'win32' || process.env.VIDEO_NO_SUBST === '1') return null;
  const used = new Set((spawnSync('cmd', ['/c', 'subst'], { encoding: 'utf8' }).stdout ?? '').split(/\r?\n/).map((l) => l.slice(0, 1).toUpperCase()));
  for (const l of 'RSTUVWXYZ') {
    if (used.has(l) || existsSync(`${l}:/`)) continue;
    if (spawnSync('cmd', ['/c', 'subst', `${l}:`, workDir]).status === 0) return `${l}:`;
  }
  return null;
}
const drive = mapDrive();
let mapped = !!drive;
const unmap = () => {
  if (!mapped) return;
  mapped = false;
  spawnSync('cmd', ['/c', 'subst', drive, '/D']);
};
process.on('exit', unmap);
const wsShown = drive ? path.win32.join(`${drive}\\`, WS_NAME) : rel(ws);
log('workspace as the editor sees it:', wsShown);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const editor = await startEditor([wsShown, '--port', '0']);
log('editor at', editor.url, '(no model: start screen)');
const { browser, renderer, args: chromeArgs } = await launchChrome();
const actions = [];
let rec;
let mouse = { x: W / 2, y: H - 120 };
try {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await page.addInitScript(CURSOR_SCRIPT);
  await page.goto(editor.url);
  await page.locator('[data-testid=start-screen]').waitFor({ timeout: 30000 });
  await page.locator('[data-testid=example-hana]').waitFor();
  await page.mouse.move(mouse.x, mouse.y);
  await sleep(1500);

  rec = new Screencast(page, path.join(dir, 'frames'), { width: W, height: H });
  await rec.start();
  const act = (what) => {
    actions.push({ t: Number(rec.now().toFixed(3)), action: what });
    log(`${rec.now().toFixed(2)}s ${what}`);
  };
  const clickOn = async (selector, what, ms = 650) => {
    const to = await centerOf(page, selector);
    mouse = await glide(page, mouse, to, ms);
    await sleep(120);
    act(what);
    await page.mouse.click(to.x, to.y);
  };

  await sleep(1400);
  await clickOn('[data-testid=file-menu-button]', 'click File');
  await page.locator('[data-testid=file-menu]').waitFor();
  await sleep(1100);
  await clickOn('[data-testid=menu-new]', 'click New…', 450);
  await page.locator('[data-testid=new-dialog]').waitFor();
  await sleep(900);
  await clickOn('[data-testid=template-hana]', 'pick template Hana');
  await sleep(900);
  await clickOn('[data-testid=new-confirm]', 'click Create');
  await page.waitForFunction(() => /hana\.r2d\.json/.test(document.querySelector('[data-testid=status-file] .status-path')?.textContent ?? ''), null, { timeout: 20000 });
  act('hana.r2d.json open');
  await sleep(1800);

  await clickOn('[data-testid=file-menu-button]', 'click File (model open)');
  await page.locator('[data-testid=file-menu]').waitFor();
  await sleep(1300);
  await clickOn('[data-testid=menu-save-as]', 'click Save As…', 450);
  await page.locator('[data-testid=save-as-dialog]').waitFor();
  await sleep(700);
  const nameBox = await centerOf(page, '[data-testid=save-as-name]');
  mouse = await glide(page, mouse, nameBox, 450);
  await page.mouse.click(nameBox.x, nameBox.y);
  await page.keyboard.press('Control+A');
  act('type hana-v2');
  await page.keyboard.type('hana-v2', { delay: 90 });
  await sleep(600);
  await clickOn('[data-testid=save-as-confirm]', 'click Save');
  await page.waitForFunction(() => /hana-v2\.r2d\.json/.test(document.querySelector('[data-testid=status-file] .status-path')?.textContent ?? ''), null, { timeout: 20000 });
  act('hana-v2.r2d.json open (saved as)');
  await sleep(1600);

  await clickOn('[data-testid=file-menu-button]', 'click File');
  await page.locator('[data-testid=file-menu]').waitFor();
  await sleep(700);
  await clickOn('[data-testid=menu-close]', 'click Close', 550);
  await page.locator('[data-testid=start-screen]').waitFor({ timeout: 20000 });
  act('start screen with Recent');
  await sleep(1800);
  await clickOn('[data-testid=start-recent-item]:has-text("hana.r2d.json")', 'open recent hana.r2d.json');
  await page.waitForFunction(() => /(^|[^-])hana\.r2d\.json/.test(document.querySelector('[data-testid=status-file] .status-path')?.textContent ?? ''), null, { timeout: 20000 });
  act('hana.r2d.json open again');
  await sleep(1800);
  await rec.stop();
} finally {
  await browser.close().catch(() => {});
  await editor.stop();
  unmap();
}

const mp4 = rec.encode(path.join(dir, 'editor-file-menu.mp4'), { fps: 30, crf: 16 });
const info = probe(mp4);
for (const [i, a] of actions.entries()) {
  const t = Math.min(info.duration - 0.05, a.t + 0.6);
  ffmpeg(['-ss', t.toFixed(3), '-i', mp4, '-frames:v', '1', path.join(checkDir, `file-menu-${String(i).padStart(2, '0')}.png`)]);
}
const filesOnDisk = readdirSync(ws).sort();
const actionsFile = path.join(dir, 'actions.json');
writeFileSync(actionsFile, JSON.stringify({ video: rel(mp4), clock: 'seconds from the start of the recording (= video time)', workspace: rel(ws), workspaceShownInEditor: wsShown, filesOnDiskAfter: filesOnDisk, actions }, null, 2));
if (!existsSync(path.join(ws, 'hana.r2d.json')) || !existsSync(path.join(ws, 'hana-v2.r2d.json'))) throw new Error(`files missing in ${ws}: ${filesOnDisk}`);

updateManifest('04-file-menu', [
  {
    id: 'file-menu/video',
    kind: 'video',
    path: rel(mp4),
    bytes: bytesOf(mp4),
    ...info,
    captured: 'CDP screencast of the real editor (built UI) in headless Chrome, driven by real mouse/keyboard input; re-timed to 30 fps CFR',
    cursor: 'pointer drawn by an injected overlay that mirrors the real mouse events (headless Chrome has no OS cursor)',
    chrome: { renderer, args: chromeArgs },
    server: editor.command,
    workspaceShownInEditor: wsShown,
    rawFrames: rec.frames.length,
    filesOnDiskAfter: filesOnDisk,
    note: 'start screen -> File > New (Hana) -> File menu -> Save As hana-v2 -> File > Close -> Recent -> reopen. Pick ~3 s for the "real editor" beat.',
  },
  { id: 'file-menu/actions', kind: 'cues', path: rel(actionsFile), bytes: bytesOf(actionsFile), note: 'what was clicked when (video clock) + the files that exist on disk afterwards' },
]);
log('done:', rel(mp4), JSON.stringify(info), 'files:', filesOnDisk.join(', '));
