/**
 * Compose the final Rev2D media (docs/media/*) from the REAL assets captured by scripts/video/0*.mjs.
 *
 * REGENERATE
 *   1. capture (real CLI output, renders, editor screencasts):   node scripts/video/capture-all.mjs
 *   2. compose everything below:                                 node scripts/video/compose.mjs
 *      only some outputs:     node scripts/video/compose.mjs master clips gifs stills
 *      preview stills only:   node scripts/video/compose.mjs --preview master 3,12.5,30   (-> out/video/check/compose/)
 *      review frames:         node scripts/video/compose.mjs --check     (frames every 5 s + per clip -> out/video/check/compose/)
 *   Needs: node >= 22, playwright-core + Google Chrome, ffmpeg/ffprobe (FFMPEG_DIR or on PATH).
 *
 * OUTPUTS (media contract)
 *   docs/media/rev2d-demo.mp4         1280x720 30 fps H.264 yuv420p +faststart, silent (program "master")
 *   docs/media/clip-showcase.mp4      the four examples animating (program "showcase")
 *   docs/media/clip-ai-live-edit.mp4  AI runs real CLI commands -> the open editor reacts (program "live")
 *   docs/media/clip-verify.mp4        overlay render, sweep sheet, overview sheet, analyze (program "verify")
 *   docs/media/hero.gif               2x2 montage, 720 px, 12 fps, seamless 8 s loop (program "hero")
 *   docs/media/ai-live-edit.gif       terminal + editor, 800 px, 10 fps (program "gifLive")
 *   docs/media/poster.png             1280x720 poster / social card (program "poster")
 *   docs/media/verify.png             verification summary still, 1600x900 (program "verifyStill")
 *
 * HOW
 *   scripts/video/stage.html is a 1280x720 (or GIF-sized) HTML stage. Every frame is a pure function of
 *   time: window.__setTime(t) lays out the captured assets (frame sequences from `rev2d frames`,
 *   renders, verbatim command output with the captured timings, CDP screencast frames of the real
 *   editor) and resolves once every image is decoded. This script serves the repo over a local HTTP
 *   server (a free port, never 4777-4781), steps headless Chrome through the timeline at the target
 *   fps, pipes PNG screenshots into ffmpeg (libx264 crf 20 preset slow, yuv420p, +faststart) and
 *   builds GIFs with palettegen/paletteuse. No text or number on screen is typed in by hand except
 *   captions: all data comes from out/video/assets (manifest.json, cues.json, transcripts, examples).
 */
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { ASSETS, FFMPEG, OUT, ROOT, ensureDir, freePort, log, must, pngSize, probe, rel, runCli } from './lib.mjs';

const MEDIA = ensureDir(path.join(ROOT, 'docs', 'media'));
const COMPOSE = ensureDir(path.join(OUT, 'compose'));
const CHECK = ensureDir(path.join(OUT, 'check', 'compose'));
const url = (p) => '/' + rel(p);
/** Videos start this far into their timeline so the first frame is never an empty background. */
const COLD_OPEN = 0.4;

// ---------------------------------------------------------------- data (all from captured assets)
function buildData() {
  const manifest = JSON.parse(readFileSync(path.join(ASSETS, 'manifest.json'), 'utf8'));
  const byId = Object.fromEntries(manifest.assets.map((a) => [a.id, a]));
  const need = (id) => {
    if (!byId[id]) throw new Error(`manifest has no ${id}; run node scripts/video/capture-all.mjs`);
    return byId[id];
  };
  for (const a of manifest.assets) {
    if ('exitCode' in a && a.exitCode !== 0 && a.exitCode !== null) throw new Error(`${a.id} exited ${a.exitCode}`);
  }

  const showcase = {};
  for (const id of ['hana-idle', 'hana-look_around', 'hana-talk', 'slime-jump_loop', 'robot-arm-reach', 'robot-arm-drum', 'textured-flutter']) {
    const dir = path.join(ASSETS, 'showcase', id);
    const frames = readdirSync(dir).filter((f) => /^frame_\d{4}\.png$/.test(f)).length;
    const { width, height } = pngSize(path.join(dir, 'frame_0000.png'));
    showcase[id] = { base: url(dir), frames, width, height, command: need(`showcase/${id}`).command };
  }

  const tests = need('facts/tests');
  const facts = {
    cli: need('facts/cli-help').count,
    cliCommands: need('facts/cli-help').commands,
    examples: need('facts/examples').examples,
    mcpTools: need('mcp/tools').count,
    tests: { total: tests.total, passed: tests.passed, failed: tests.failed },
  };
  if (tests.failed !== 0 || tests.passed !== tests.total) throw new Error('the captured test run was not green');

  const verify = {
    overlay: { cmd: need('verify/render-overlay').command, stdout: need('verify/render-overlay').stdout, path: url(path.join(ASSETS, 'verify', 'hana-overlay.png')) },
    sweep: { cmd: need('verify/sheet-sweep').command, stdout: need('verify/sheet-sweep').stdout, path: url(path.join(ASSETS, 'verify', 'hana-sweep-anglex-angley.png')) },
    overview: { cmd: need('verify/sheet-overview').command, stdout: need('verify/sheet-overview').stdout, path: url(path.join(ASSETS, 'verify', 'hana-overview.png')) },
    analyze: { cmd: need('verify/analyze-hana-idle').command, text: need('verify/analyze-hana-idle').stdout },
  };

  const cuesFile = JSON.parse(readFileSync(path.join(ASSETS, 'live-edit', 'cues.json'), 'utf8'));
  const cues = cuesFile.cues.map((c) => ({ id: c.id, label: c.label, t: c.t, tEnd: c.tEnd, command: c.command, stdout: c.stdout, stderr: c.stderr, exitCode: c.exitCode, durationMs: c.durationMs }));
  for (const c of cues) if (c.exitCode !== 0) throw new Error(`live cue ${c.id} exited ${c.exitCode}`);
  const liveTl = JSON.parse(readFileSync(path.join(ASSETS, 'live-edit', 'frames', 'timeline.json'), 'utf8'));
  const hairParts = need('live-edit/cmd/b-info').derived.hairParts;
  const setupEdit = need('live-edit/setup-edit').command; // rev2d edit <model> --port 0 --no-open --json
  const modelPath = setupEdit.split(' ')[2];

  const filesTl = JSON.parse(readFileSync(path.join(ASSETS, 'file-menu', 'frames', 'timeline.json'), 'utf8'));

  const toolsJson = JSON.parse(readFileSync(path.join(ASSETS, 'mcp', 'tools.json'), 'utf8'));
  const toolNames = (Array.isArray(toolsJson) ? toolsJson : toolsJson.tools).map((t) => t.name);
  if (toolNames.length !== facts.mcpTools) throw new Error('tools.json and the manifest disagree on the tool count');
  const session = JSON.parse(readFileSync(path.join(ASSETS, 'mcp', 'session.json'), 'utf8'));
  const callReq = session.requests.find((r) => r.method === 'tools/call' && r.name === 'rev2d_render');
  const callText = callReq.content.find((c) => c.type === 'text').text;
  const register = need('mcp/register').command;
  const mcpImg = need('mcp/render-hana');

  // verbatim lines (with their real line numbers) from the example model
  const src = readFileSync(path.join(ROOT, 'examples', 'hana', 'hana.r2d.json'), 'utf8').split(/\r?\n/);
  const ex = need('json/hana-excerpt');
  const lines = (a, b) => {
    const out = [];
    for (let n = a; n <= b; n++) out.push({ n, text: src[n - 1] });
    const ind = Math.min(...out.map((l) => l.text.match(/^ */)[0].length));
    return out.map((l) => ({ n: l.n, text: l.text.slice(ind) }));
  };
  const headerLine = (key) => {
    const i = src.findIndex((l) => l.startsWith(`  "${key}": [`));
    return { n: i + 1, text: src[i].trim() };
  };
  // structure counts of the example itself: a real `rev2d info --json` run, done now
  const infoRun = must(runCli(['info', 'examples/hana/hana.r2d.json', '--json']));
  const exInfo = JSON.parse(infoRun.stdout);
  const json = {
    file: 'examples/hana/hana.r2d.json',
    paramsHeader: headerLine('parameters'),
    bindingsHeader: headerLine('bindings'),
    param: lines(...ex.lines.parameter),
    binding: lines(...ex.lines.binding),
    sweep: url(path.join(ASSETS, 'json', 'hana-anglez-sweep.png')),
    sweepCmd: need('json/anglez-sweep').command,
    infoCmd: infoRun.command,
    counts: Object.entries(exInfo.counts).filter(([, v]) => v > 0).map(([k, v]) => [k, v]),
  };

  const data = {
    showcase,
    facts,
    verify,
    json,
    live: {
      cues,
      timeline: { base: url(path.join(ASSETS, 'live-edit', 'frames')), duration: liveTl.duration, frames: liveTl.frames },
      hairParts,
      modelPath,
      aiView: url(path.join(ASSETS, 'ai-view.png')),
    },
    files: { timeline: { base: url(path.join(ASSETS, 'file-menu', 'frames')), duration: filesTl.duration, frames: filesTl.frames } },
    mcp: {
      tools: toolNames,
      register,
      call: { name: callReq.name, arguments: callReq.arguments, textHead: callText.split('\n').slice(0, 2).join('\n') },
      image: { path: url(path.join(ASSETS, 'mcp', 'render-hana.png')), width: mcpImg.width, height: mcpImg.height },
    },
  };
  const file = path.join(COMPOSE, 'stage-data.js');
  writeFileSync(file, `// generated by scripts/video/compose.mjs from out/video/assets (real captured output)\nwindow.STAGE_DATA = ${JSON.stringify(data)};\n`);
  return data;
}

// ---------------------------------------------------------------- static server (repo root)
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.css': 'text/css', '.svg': 'image/svg+xml' };
async function serve() {
  const port = await freePort();
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.resolve(ROOT, '.' + p);
    if (!file.startsWith(ROOT) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'max-age=3600' });
    createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${port}` };
}

// ---------------------------------------------------------------- rendering
async function openProgram(browser, base, program, scale = 1) {
  const probePage = await browser.newPage();
  const probeErrors = [];
  probePage.on('pageerror', (e) => probeErrors.push(String(e.stack || e)));
  await probePage.goto(`${base}/scripts/video/stage.html?program=${program}`);
  const info = await probePage.evaluate(() => window.__ready);
  if (!info) throw new Error(`stage failed to start (${program}): ${probeErrors.join(' | ')}`);
  await probePage.close();
  const page = await browser.newPage({ viewport: { width: info.w, height: info.h }, deviceScaleFactor: scale });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`${base}/scripts/video/stage.html?program=${program}`);
  await page.evaluate(() => window.__ready);
  return { page, info, errors };
}

async function shoot(page, t) {
  await page.evaluate((tt) => window.__setTime(tt), t);
  return page.screenshot({ type: 'png', animations: 'disabled', caret: 'initial' });
}

/** Render [from, to) of a program at fps and pipe PNG frames into ffmpeg with the given output args. */
async function renderVideo(browser, base, program, outArgs, { fps = 30, from = 0, to, scale = 1 } = {}) {
  const { page, info, errors } = await openProgram(browser, base, program, scale);
  const end = to ?? info.duration;
  const n = Math.round((end - from) * fps);
  const ff = spawn(FFMPEG, ['-hide_banner', '-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-', ...outArgs], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((resolve, reject) => ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)))));
  const t0 = Date.now();
  for (let i = 0; i < n; i++) {
    const buf = await shoot(page, from + i / fps);
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
    if (i % 150 === 0) log(`${program}: frame ${i}/${n} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  }
  ff.stdin.end();
  await done;
  await page.close();
  if (errors.length) throw new Error(`${program}: page errors:\n${errors.join('\n')}`);
  return { frames: n, duration: n / fps, info };
}

const X264 = (file, crf = 20) => ['-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-movflags', '+faststart', '-an', file];

async function renderGif(browser, base, program, file, { fps, width, maxBytes, colors = 256, dither = 'bayer:bayer_scale=4', from = 0 }) {
  const tmp = path.join(COMPOSE, `${program}.lossless.mkv`);
  await renderVideo(browser, base, program, ['-c:v', 'ffv1', tmp], { fps, from });
  const attempt = (cols, dith) => {
    const pal = path.join(COMPOSE, `${program}.palette.png`);
    const scale = width ? `scale=${width}:-1:flags=lanczos` : 'null';
    run([FFMPEG, '-hide_banner', '-y', '-loglevel', 'error', '-i', tmp, '-vf', `${scale},palettegen=max_colors=${cols}:stats_mode=diff`, pal]);
    run([FFMPEG, '-hide_banner', '-y', '-loglevel', 'error', '-i', tmp, '-i', pal, '-lavfi', `[0:v]${scale}[x];[x][1:v]paletteuse=dither=${dith}:diff_mode=rectangle`, '-loop', '0', file]);
    return statSync(file).size;
  };
  let size = attempt(colors, dither);
  const tries = [[192, dither], [160, 'bayer:bayer_scale=3'], [128, 'bayer:bayer_scale=2']];
  for (const [cols, d] of tries) {
    if (size <= maxBytes) break;
    log(`${path.basename(file)} is ${(size / 1e6).toFixed(2)} MB > ${(maxBytes / 1e6).toFixed(1)} MB, retrying with ${cols} colours`);
    size = attempt(cols, d);
  }
  if (size > maxBytes) throw new Error(`${file} is ${size} bytes (> ${maxBytes})`);
  return size;
}

function run(argv) {
  const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${argv.join(' ')}\n${r.stderr}`);
  return r.stdout;
}

async function still(browser, base, program, file, { scale = 1, t = 0 } = {}) {
  const { page, errors } = await openProgram(browser, base, program, scale);
  await page.evaluate((tt) => window.__setTime(tt), t);
  await page.screenshot({ path: file, type: 'png' });
  await page.close();
  if (errors.length) throw new Error(`${program}: ${errors.join('\n')}`);
}

// ---------------------------------------------------------------- review frames
function extractFrames(video, times, prefix) {
  const out = [];
  for (const t of times) {
    const f = path.join(CHECK, `${prefix}-${String(t.toFixed(1)).padStart(5, '0')}s.png`);
    run([FFMPEG, '-hide_banner', '-y', '-loglevel', 'error', '-ss', String(t), '-i', video, '-frames:v', '1', f]);
    out.push(f);
  }
  return out;
}
function blackFrames(video) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-i', video, '-vf', 'blackdetect=d=0.03:pix_th=0.02', '-an', '-f', 'null', '-'], { encoding: 'utf8' });
  return (r.stderr.match(/black_start:[^\n]+/g) ?? []).length;
}

// ---------------------------------------------------------------- main
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const words = argv.filter((a) => !a.startsWith('--'));

const data = buildData();
log(`stage data: ${data.live.cues.length} live cues, ${data.mcp.tools.length} MCP tools, ${data.facts.tests.passed} tests, ${data.facts.cli} CLI commands`);
const { server, base } = await serve();
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--font-render-hinting=none', '--force-color-profile=srgb'] });
try {
  if (flags.has('--preview')) {
    const [program, times] = words;
    const { page, errors } = await openProgram(browser, base, program);
    for (const t of (times ?? '0').split(',').map(Number)) {
      const f = path.join(CHECK, `preview-${program}-${t.toFixed(2)}.png`);
      await page.evaluate((tt) => window.__setTime(tt), t);
      await page.screenshot({ path: f });
      log(rel(f));
    }
    if (errors.length) log('page errors:', errors.join('\n'));
  } else if (flags.has('--check')) {
    const report = {};
    for (const f of ['rev2d-demo.mp4', 'clip-showcase.mp4', 'clip-ai-live-edit.mp4', 'clip-verify.mp4']) {
      const file = path.join(MEDIA, f);
      const p = probe(file);
      const step = f === 'rev2d-demo.mp4' ? 5 : 2;
      const times = [];
      for (let t = 0.5; t < p.duration; t += step) times.push(Math.round(t * 10) / 10);
      extractFrames(file, times, f.replace('.mp4', ''));
      report[f] = { ...p, bytes: statSync(file).size, blackSegments: blackFrames(file) };
    }
    console.log(JSON.stringify(report, null, 2));
  } else {
    const want = (k) => words.length === 0 || words.includes(k);
    const results = {};
    if (want('master')) {
      const file = path.join(MEDIA, 'rev2d-demo.mp4');
      const r = await renderVideo(browser, base, 'master', X264(file, 20), { from: COLD_OPEN });
      results.master = { file: rel(file), scenes: r.info.scenes };
      writeFileSync(path.join(COMPOSE, 'master-timeline.json'), JSON.stringify(r.info, null, 2));
    }
    if (want('clips')) {
      for (const [program, name] of [['showcase', 'clip-showcase.mp4'], ['live', 'clip-ai-live-edit.mp4'], ['verify', 'clip-verify.mp4']]) {
        const file = path.join(MEDIA, name);
        await renderVideo(browser, base, program, X264(file, 20), { from: COLD_OPEN });
        results[program] = { file: rel(file) };
      }
    }
    if (want('gifs')) {
      await renderGif(browser, base, 'hero', path.join(MEDIA, 'hero.gif'), { fps: 12, maxBytes: 6e6 });
      await renderGif(browser, base, 'gifLive', path.join(MEDIA, 'ai-live-edit.gif'), { fps: 10, maxBytes: 8e6, from: COLD_OPEN });
    }
    if (want('stills')) {
      await still(browser, base, 'poster', path.join(MEDIA, 'poster.png'));
      await still(browser, base, 'verifyStill', path.join(MEDIA, 'verify.png'));
    }
    // summary of everything in docs/media
    const summary = {};
    for (const f of readdirSync(MEDIA).sort()) {
      const file = path.join(MEDIA, f);
      const bytes = statSync(file).size;
      summary[f] = /\.(mp4|gif)$/.test(f) ? { bytes, ...probe(file) } : { bytes, ...pngSize(file) };
    }
    writeFileSync(path.join(COMPOSE, 'media-summary.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary, null, 2));
  }
} finally {
  await browser.close();
  server.close();
  rmSync(path.join(COMPOSE, 'tmp'), { recursive: true, force: true });
}
