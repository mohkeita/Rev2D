/** Internal isolated renderer. Never imported by the browser or registered as a public command. */
import { rm, copyFile } from 'node:fs/promises';
import { loadScene, requireScene } from './scene.js';
import { renderScene } from './video.js';
import { normalizeClip } from './episode-media.js';
import type { ShotRenderJob } from './episode-render.js';
if (process.argv.includes('--episode-worker'))
  process.once('message', async (job: ShotRenderJob) => {
    const stop = new AbortController();
    process.once('SIGTERM', () => stop.abort());
    const native = job.output + '.native.mp4';
    try {
      if (job.external)
        await normalizeClip(job.external.video, job.output, {
          ...job,
          from: job.external.from,
          fit: job.external.fit,
          signal: stop.signal,
        });
      else {
        const scene = await loadScene(job.scene);
        const p = requireScene(scene);
        let last = 0;
        await renderScene(scene, native, {
          audio: false,
          signal: stop.signal,
          progress: (p) => {
            if (p.frame === p.frames || performance.now() - last > 500) {
              process.send?.({ type: 'progress', frame: p.frame, frames: p.frames });
              last = performance.now();
            }
          },
        });
        if (p.scene.width === job.size[0] && p.scene.height === job.size[1])
          await copyFile(native, job.output);
        else await normalizeClip(native, job.output, { ...job, fit: 'contain', signal: stop.signal });
      }
      process.send?.({ type: 'done' });
      process.exitCode = 0;
    } catch (e) {
      process.send?.({ type: 'error', message: (e as Error).message });
      process.exitCode = 1;
    } finally {
      await rm(native, { force: true });
      process.disconnect?.();
    }
  });
