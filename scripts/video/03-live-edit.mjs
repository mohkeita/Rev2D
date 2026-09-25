/**
 * Step 3 - AI LIVE-EDIT footage (the key scene): real CLI commands change a model while the real
 * editor, open in Chrome, follows along live.
 *
 *   node scripts/video/03-live-edit.mjs
 *
 * 1. `rev2d new out/video/work/hana.r2d.json --template hana --force` (a fresh copy)
 * 2. `rev2d edit out/video/work/hana.r2d.json --port <free> --no-open --json` (sandboxed home)
 * 3. Chrome (headless, 1600x900) opens the editor; the CDP screencast records it.
 * 4. While recording, at scripted moments, the "AI" runs REAL commands (stdout/exit code captured):
 *      a) rev2d validate                         b) rev2d info --json (find the hair parts)
 *      c) rev2d ops ... recolor (hair -> teal)   -> the editor live-reloads with the new colour
 *      d) rev2d editor command --params AngleX=25,EyeLOpen=0,MouthOpen=0.6
 *      e) rev2d editor command --play talk (~4 s), then --pause
 *      f) rev2d editor screenshot -o out/video/assets/ai-view.png
 *      g) rev2d editor command --message "..." (a note to the human in the editor)
 * 5. Encodes out/video/assets/live-edit/editor-live-edit.mp4 (1600x900, 30 fps CFR) and writes
 *    cues.json: every command with its start/end time on the video clock plus verbatim output.
 *
 * Key frames for review (taken from the encoded video after each command) go to
 * out/video/check/live-edit-video-*.png.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ASSETS, OUT, bytesOf, commandEntry, ensureDir, ffmpeg, log, must, pngSize, probe, rel, runCli, runCliAsync, updateManifest, writeTranscript } from './lib.mjs';
import { Screencast, launchChrome, startEditor } from './recorder.mjs';

/** Model-space region the viewport is framed on before recording (head and shoulders). */
const FOCUS = '0,8,512,500';
const W = 1600;
const H = 900;
const dir = ensureDir(path.join(ASSETS, 'live-edit'));
const checkDir = ensureDir(path.join(OUT, 'check'));
const work = ensureDir(path.join(OUT, 'work'));
const model = path.join(work, 'hana.r2d.json');
const modelRel = rel(model);
const aiView = path.join(ASSETS, 'ai-view.png');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------- setup (not recorded)
rmSync(model, { force: true });
const created = must(runCli(['new', modelRel, '--template', 'hana', '--force']));
log(created.stdout.trim().split('\n')[0]);

const editor = await startEditor([modelRel, '--port', '0']);
log('editor at', editor.url);
const url = editor.url;
const { browser, renderer, args: chromeArgs } = await launchChrome();
log('chrome renderer:', renderer);

const cues = [];
const commands = [created];
let rec;
try {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const consoleErrors = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  await page.goto(url);
  await page.locator('[data-testid=viewport]').waitFor({ timeout: 30000 });
  await page.waitForFunction(() => /hana\.r2d\.json/.test(document.querySelector('[data-testid=status-file]')?.textContent ?? ''), null, { timeout: 30000 });
  // Pre-roll (logged, not part of the scripted AI steps): clean view without rig overlays, framed on
  // head and shoulders (where every change of this scene happens).
  // No --url anywhere: the commands find this editor through the editor registry of the sandboxed
  // home (out/video/home/.rev2d/editors), where it is the only live editor, exactly like
  // `rev2d editor ...` finds the editor a user started.
  const setup = must(runCli(['editor', 'command', '--overlay', 'none', '--focus', FOCUS]));
  commands.push(setup);
  await sleep(2500);

  // --------------------------------------------------------------------------- recording
  rec = new Screencast(page, path.join(dir, 'frames'), { width: W, height: H });
  await rec.start();

  /** Run a real CLI command at the current moment and log it on the video clock. */
  const step = async (id, args, label) => {
    const t0 = rec.now();
    const r = await runCliAsync(args);
    const t1 = rec.now();
    commands.push(r);
    cues.push({ id, label, t: Number(t0.toFixed(3)), tEnd: Number(t1.toFixed(3)), ...commandEntry(id, r) });
    log(`${t0.toFixed(2)}s ${id}: exit ${r.exitCode} (${r.durationMs} ms)`);
    if (r.exitCode !== 0) throw new Error(`${r.command}\n${r.stderr}`);
    return r;
  };

  await sleep(2000);
  await step('a-validate', ['validate', modelRel], 'validate the model');
  await sleep(1500);

  const info = await step('b-info', ['info', modelRel, '--json'], 'find the hair parts');
  const hairParts = JSON.parse(info.stdout).parts.filter((p) => /^hair/.test(p.id)).map((p) => p.id);
  writeFileSync(path.join(dir, 'info-hana.json'), info.stdout);
  // What the AI takes from the info output (for a caption): the ids of the hair parts.
  cues[cues.length - 1].derived = { hairParts, rule: 'parts whose id starts with "hair" (hana has no tags)' };
  await sleep(1500);

  const recolorOp = { op: 'recolor', parts: hairParts, hsl: { h: -120, s: 0.25, l: 0.05 } };
  await step('c-recolor', ['ops', modelRel, '--op', JSON.stringify(recolorOp)], 'recolor the hair (teal)');
  // The editor learns about the change through its file watcher + SSE and reloads by itself.
  await sleep(3000);

  await step('d-params', ['editor', 'command', '--params', 'AngleX=25,EyeLOpen=0,MouthOpen=0.6'], 'set parameters in the open editor');
  await sleep(3000);

  await step('e-play', ['editor', 'command', '--play', 'talk'], 'play the talk animation');
  await sleep(2000);
  await sleep(2000);
  await step('e-pause', ['editor', 'command', '--pause'], 'pause');
  await sleep(1200);

  await step('f-screenshot', ['editor', 'screenshot', '-o', rel(aiView)], 'screenshot of what the human sees');
  await sleep(1200);
  await step('g-message', ['editor', 'command', '--message', 'Hair is teal now, pose set, talk played. Saved ai-view.png.'], 'tell the human');
  await sleep(3500);
  await rec.stop();

  // Not part of the transcript (its JSON holds absolute paths): kept as a data file only.
  const state = must(runCli(['editor', 'state', '--json']));
  writeFileSync(path.join(dir, 'editor-state-after.json'), state.stdout);
  if (consoleErrors.length) log('console errors:', consoleErrors);
  writeFileSync(path.join(dir, 'console-errors.json'), JSON.stringify(consoleErrors, null, 1));
} finally {
  await browser.close().catch(() => {});
  await editor.stop();
}

// ---------------------------------------------------------------------------- encode + manifest
const mp4 = rec.encode(path.join(dir, 'editor-live-edit.mp4'), { fps: 30, crf: 16 });
const info = probe(mp4);
// Key frames straight from the encoded video at each cue (+0.8 s: after the editor reacted).
for (const c of cues) {
  const t = Math.min(info.duration - 0.05, c.tEnd + 0.8);
  ffmpeg(['-ss', t.toFixed(3), '-i', mp4, '-frames:v', '1', path.join(checkDir, `live-edit-video-${c.id}.png`)]);
}
const cuesFile = path.join(dir, 'cues.json');
writeFileSync(cuesFile, JSON.stringify({ video: rel(mp4), clock: 'seconds from the start of the recording (= video time)', editorUrl: url, chrome: { renderer, args: chromeArgs }, cues }, null, 2));
const transcript = writeTranscript(path.join(dir, 'terminal.txt'), commands);

const entries = [
  {
    id: 'live-edit/video',
    kind: 'video',
    path: rel(mp4),
    bytes: bytesOf(mp4),
    ...info,
    captured: 'CDP screencast (Page.startScreencast, jpeg q92, every frame acked) of the real editor in headless Chrome, re-timed to 30 fps CFR from frame timestamps',
    chrome: { renderer, args: chromeArgs },
    rawFrames: rec.frames.length,
    note: 'AI runs real CLI commands; the open editor reloads (teal hair), takes the pose, plays talk, shows the AI message. Cue times in cues.json.',
  },
  { id: 'live-edit/cues', kind: 'cues', path: rel(cuesFile), bytes: bytesOf(cuesFile), note: 'per command: video time t/tEnd, exact command, stdout, stderr, exit code, timestamps' },
  { id: 'live-edit/terminal', kind: 'transcript', path: rel(transcript), bytes: bytesOf(transcript), note: 'every command of this step (setup included) as a terminal transcript' },
  { id: 'live-edit/frames', kind: 'screencast-frames', path: rel(path.join(dir, 'frames')), frames: rec.frames.length, bytes: bytesOf(path.join(dir, 'frames')), note: 'raw screencast JPEGs + timeline.json (timestamps) + frames.ffconcat' },
  { ...commandEntry('live-edit/ai-view', commands.find((c) => c.argv.includes('screenshot'))), kind: 'image', path: rel(aiView), bytes: bytesOf(aiView), ...pngSize(aiView), note: 'rev2d editor screenshot: server-side render of what the human sees (after talk, paused)' },
  ...cues.map((c) => ({ ...c, kind: 'command', id: `live-edit/cmd/${c.id}` })),
  { ...commandEntry('live-edit/setup-new', created), note: 'setup: fresh copy of the hana example' },
  { id: 'live-edit/setup-edit', kind: 'command', command: editor.command, stdout: JSON.stringify(editor.listening), exitCode: null, note: 'setup: editor server (stopped after the recording; USERPROFILE sandboxed to out/video/home)' },
];
updateManifest('03-live-edit', entries, { chromeRenderer: renderer, viewport: `${W}x${H}` });
log('done:', rel(mp4), JSON.stringify(info));
