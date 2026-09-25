/**
 * Real editor capture helpers: start a real `rev2d edit` server, drive the real built editor UI in
 * Chrome (playwright-core, channel "chrome"), and record it with the CDP screencast
 * (Page.startScreencast -> Page.screencastFrame, every frame acknowledged, timestamps kept).
 *
 * The recording is turned into a constant-frame-rate H.264 file with ffmpeg's concat demuxer: each
 * captured frame is shown from its own timestamp until the next one (the screencast only sends a
 * frame when the page changes), so the video timing matches wall-clock time.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { BIN, ROOT, SANDBOX_HOME, ffmpeg, log, rel, sandboxEnv } from './lib.mjs';

/**
 * Start `rev2d edit <target> --port <port> --no-open --json` (sandboxed home, see lib.mjs).
 * Resolves {url, child, command, listening, stop()} once the server prints its "listening" line.
 */
export function startEditor(args) {
  const argv = ['edit', ...args, '--no-open', '--json'];
  // Start from an empty editor registry in the sandboxed home, so `rev2d editor ...` finds this one.
  rmSync(path.join(SANDBOX_HOME, '.rev2d', 'editors'), { recursive: true, force: true });
  const child = spawn(process.execPath, [BIN, ...argv], { cwd: ROOT, env: sandboxEnv() });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`editor did not start: ${stderr}`)), 30000);
    child.on('exit', (code) => reject(new Error(`editor exited (${code}): ${stderr}`)));
    child.stdout.setEncoding('utf8').on('data', (d) => {
      buf += d;
      for (const line of buf.split('\n')) {
        if (!line.trim().startsWith('{')) continue;
        let j;
        try {
          j = JSON.parse(line);
        } catch {
          continue;
        }
        if (j.event === 'listening') {
          clearTimeout(timer);
          resolve({
            url: j.url,
            listening: j,
            child,
            command: ['rev2d', ...argv].join(' '),
            stop: () =>
              new Promise((res) => {
                if (child.exitCode !== null) return res();
                child.once('exit', () => res());
                child.kill();
              }),
          });
        }
      }
    });
  });
}

/**
 * Chrome with the GPU when available (smooth 60 fps WebGL2), else SwiftShader (software GL).
 * Returns {browser, renderer, args}.
 */
export async function launchChrome() {
  const variants = [
    ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'],
    ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  ];
  let lastError;
  for (const args of variants) {
    try {
      const browser = await chromium.launch({ channel: 'chrome', headless: true, args });
      const page = await browser.newPage();
      const renderer = await page.evaluate(() => {
        const gl = document.createElement('canvas').getContext('webgl2');
        if (!gl) return null;
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'webgl2';
      });
      await page.close();
      if (!renderer) {
        await browser.close();
        continue;
      }
      return { browser, renderer, args };
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError ?? new Error('no Chrome with WebGL2');
}

/**
 * Draws the pointer on top of the page so a viewer can follow the (real, Playwright-driven) mouse:
 * headless Chrome captures no OS cursor. It only mirrors real pointer events; it is not editor UI.
 */
export const CURSOR_SCRIPT = `(() => {
  const install = () => {
    if (document.getElementById('__rec_cursor')) return;
    const c = document.createElement('div');
    c.id = '__rec_cursor';
    c.style.cssText = 'position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;transform:translate(-100px,-100px);transition:none';
    c.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2 L3 18 L7.5 14 L10.5 20.5 L13 19.4 L10.1 13 L16 13 Z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    const ring = document.createElement('div');
    ring.style.cssText = 'position:fixed;left:0;top:0;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;border:2px solid rgba(90,160,255,.95);background:rgba(90,160,255,.18);z-index:2147483646;pointer-events:none;opacity:0;transform:translate(-100px,-100px) scale(.4)';
    document.documentElement.append(ring, c);
    let x = -100, y = -100;
    addEventListener('mousemove', (e) => { x = e.clientX; y = e.clientY; c.style.transform = 'translate(' + (x - 3) + 'px,' + (y - 2) + 'px)'; }, true);
    addEventListener('mousedown', () => {
      ring.animate([{ opacity: 1, transform: 'translate(' + x + 'px,' + y + 'px) scale(.4)' }, { opacity: 0, transform: 'translate(' + x + 'px,' + y + 'px) scale(1.25)' }], { duration: 420, easing: 'ease-out' });
    }, true);
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', install); else install();
})();`;

/** Move the real mouse along an eased path (so the drawn cursor glides instead of jumping). */
export async function glide(page, from, to, ms = 600) {
  const steps = Math.max(2, Math.round(ms / 16));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    await page.mouse.move(from.x + (to.x - from.x) * e, from.y + (to.y - from.y) * e);
    await page.waitForTimeout(16);
  }
  return to;
}

export async function centerOf(page, selector) {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`no box for ${selector}`);
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
}

/** CDP screencast recorder. Frames go to `dir` as JPEGs as they arrive. */
export class Screencast {
  constructor(page, dir, { width, height, quality = 92 } = {}) {
    this.page = page;
    this.dir = dir;
    this.opts = { format: 'jpeg', quality, maxWidth: width, maxHeight: height, everyNthFrame: 1 };
    this.frames = [];
    this.startWall = 0;
    this.endWall = 0;
  }

  /** Seconds since the recording started (same clock as the frame timestamps: wall time). */
  now() {
    return Date.now() / 1000 - this.startWall;
  }

  async start() {
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true });
    this.cdp = await this.page.context().newCDPSession(this.page);
    this.cdp.on('Page.screencastFrame', (f) => {
      const i = this.frames.length;
      const file = `f${String(i).padStart(5, '0')}.jpg`;
      writeFileSync(path.join(this.dir, file), Buffer.from(f.data, 'base64'));
      this.frames.push({ file, ts: f.metadata.timestamp, w: f.metadata.deviceWidth, h: f.metadata.deviceHeight });
      this.cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
    });
    this.startWall = Date.now() / 1000;
    await this.cdp.send('Page.startScreencast', this.opts);
    log('screencast started');
  }

  async stop() {
    this.endWall = Date.now() / 1000;
    await this.cdp.send('Page.stopScreencast');
    await this.cdp.detach().catch(() => {});
    log('screencast stopped:', this.frames.length, 'frames over', (this.endWall - this.startWall).toFixed(2), 's');
  }

  /** Frame list with times relative to the recording start. */
  timeline() {
    return this.frames.map((f) => ({ file: f.file, t: Number((f.ts - this.startWall).toFixed(4)) }));
  }

  /**
   * Encode to a constant-rate H.264 mp4 (yuv420p, +faststart). Frames before the first capture
   * are covered by the first frame; each frame lasts until the next one's timestamp.
   */
  encode(outFile, { fps = 30, crf = 16, scale } = {}) {
    const tl = this.timeline();
    if (!tl.length) throw new Error('no frames captured');
    const end = this.endWall - this.startWall;
    const lines = ['ffconcat version 1.0'];
    for (let i = 0; i < tl.length; i++) {
      const start = i === 0 ? 0 : tl[i].t;
      const next = i + 1 < tl.length ? tl[i + 1].t : end;
      const d = Math.max(0.001, next - start);
      lines.push(`file '${tl[i].file}'`, `duration ${d.toFixed(4)}`);
    }
    // The concat demuxer needs the last file repeated for its duration to count.
    lines.push(`file '${tl[tl.length - 1].file}'`);
    const list = path.join(this.dir, 'frames.ffconcat');
    writeFileSync(list, lines.join('\n') + '\n');
    const vf = [`fps=${fps}`, ...(scale ? [`scale=${scale}:flags=lanczos`] : []), 'pad=ceil(iw/2)*2:ceil(ih/2)*2', 'scale=in_range=full:out_range=limited', 'format=yuv420p'].join(',');
    ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-vf', vf, '-t', end.toFixed(3), '-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-an', '-movflags', '+faststart', outFile]);
    writeFileSync(path.join(this.dir, 'timeline.json'), JSON.stringify({ start: new Date(this.startWall * 1000).toISOString(), duration: end, frames: tl }, null, 1));
    log('encoded', rel(outFile));
    return outFile;
  }
}
