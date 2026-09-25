/**
 * Capture every real asset for the Rev2D demo video into out/video/assets/ (manifest.json there).
 *
 *   node scripts/video/capture-all.mjs              # all steps
 *   node scripts/video/capture-all.mjs 03 04        # only these steps
 *   node scripts/video/capture-all.mjs --no-tests   # skip the test run in step 00
 *
 * Steps (each also runs on its own: node scripts/video/<step>.mjs):
 *   00-facts        CLI command list, examples, test count (vitest JSON reporter)
 *   01-showcase     30 fps frame sequences via `rev2d frames` (hana, slime, robot-arm, textured)
 *   02-verify       overlay render, sweep sheet, overview sheet, analyze + inspect --track output
 *   03-live-edit    AI runs real CLI commands while the real editor (Chrome, CDP screencast) follows
 *   04-file-menu    the editor's File menu / start screen, driven with real mouse + keyboard
 *   05-mcp          real stdio MCP client: tools/list + rev2d_render
 *   06-json-excerpt verbatim parameter + binding from hana.r2d.json
 *
 * Needs: node >= 22, npm install (playwright-core, @modelcontextprotocol/sdk), the built editor UI
 * (npm run editor:build), Google Chrome, ffmpeg/ffprobe (FFMPEG_DIR or on PATH).
 * Editor servers are started on free ports (never 4777-4781) with a sandboxed home directory
 * (out/video/home) and are always stopped again.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { ROOT, log } from './lib.mjs';

const ALL = ['00-facts', '01-showcase', '02-verify', '03-live-edit', '04-file-menu', '05-mcp', '06-json-excerpt'];
const picked = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const steps = picked.length ? ALL.filter((s) => picked.some((p) => s.startsWith(p))) : ALL;
const passThrough = process.argv.slice(2).filter((a) => a.startsWith('--'));

for (const step of steps) {
  log(`== ${step}`);
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'video', `${step}.mjs`), ...passThrough], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) {
    log(`${step} failed (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
}
log('all done: out/video/assets/manifest.json');
