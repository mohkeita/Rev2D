import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { addTool, json, image, result, resolvePath, ToolError, type ToolContext } from '../context.js';
import { SceneError, sceneSheet, renderSceneFrame } from '../../scene/index.js';
import { encodePNG } from '../../render/png.js';
import { resizeNearest } from '../../render/browser.js';
import {
  loadScene,
  requireScene,
  analyzeLoadedScene,
  writeSceneFrame,
  writeSceneSheet,
} from '../../node/scene.js';
import { renderScene } from '../../node/video.js';

const Path = z.string().min(1);
const size = z.number().positive().max(4);
export function registerSceneTools(server: McpServer, ctx: ToolContext): void {
  const guarded = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof SceneError) throw new ToolError(e.message, e.diagnostics, e.diagnostics[0]?.hint);
      throw e;
    }
  };
  addTool(
    server,
    'rev2d_scene_validate',
    {
      title: 'Validate a scene',
      description:
        'Validate version 1 scene.json, library references, files, poses, anchors, model animations, parameter tracks and narration cues. Returns stable scene-* diagnostics with JSON pointers and hints. Read rev2d_docs topic scene first.',
      input: z.strictObject({ path: Path }),
      effect: 'read-only',
    },
    (a) =>
      guarded(async () => {
        const loaded = await loadScene(resolvePath(ctx, a.path));
        return result(
          [
            json({
              ok: Boolean(loaded.prepared),
              diagnostics: loaded.diagnostics,
              cues: loaded.prepared?.cues ?? [],
            }),
          ],
          !loaded.prepared,
        );
      }),
  );
  addTool(
    server,
    'rev2d_scene_frame',
    {
      title: 'Preview a scene frame',
      description:
        'Render a layered scene at one time in seconds and return its PNG inline. Use overlays to review camera, layer bounds, safe area and anchors. save_to writes a new PNG. Does not modify source assets.',
      input: z.strictObject({
        path: Path,
        time: z.number().nonnegative().default(0),
        scale: size.default(0.5),
        overlay: z.array(z.enum(['camera', 'bounds', 'safe', 'anchors'])).optional(),
        save_to: Path.optional(),
      }),
      effect: 'additive',
    },
    (a) =>
      guarded(async () => {
        const loaded = await loadScene(resolvePath(ctx, a.path)),
          p = requireScene(loaded);
        const rendered = renderSceneFrame(p, a.time, a);
        if (a.save_to) await writeSceneFrame(loaded, resolvePath(ctx, a.save_to), a.time, a);
        const ratio = Math.min(1, 1280 / Math.max(rendered.width, rendered.height));
        const preview =
          ratio < 1
            ? resizeNearest(rendered, Math.round(rendered.width * ratio), Math.round(rendered.height * ratio))
            : rendered;
        return result([
          image(encodePNG(preview)),
          json({
            time: a.time,
            width: rendered.width,
            height: rendered.height,
            cues: p.cues,
            save_to: a.save_to,
          }),
        ]);
      }),
  );
  addTool(
    server,
    'rev2d_scene_sheet',
    {
      title: 'Review scene motion',
      description:
        'Return a PNG contact sheet sampled across a scene, or at explicit times. Shows pose changes, appearances, camera motion and UI animation. save_to writes a new full sheet. Review the pictures before rendering video.',
      input: z.strictObject({
        path: Path,
        frames: z.number().int().min(1).max(100).optional(),
        times: z.array(z.number().nonnegative()).min(1).max(100).optional(),
        scale: size.default(0.25),
        save_to: Path.optional(),
      }),
      effect: 'additive',
    },
    (a) =>
      guarded(async () => {
        const loaded = await loadScene(resolvePath(ctx, a.path)),
          r = sceneSheet(requireScene(loaded), a);
        if (a.save_to) await writeSceneSheet(loaded, resolvePath(ctx, a.save_to), a);
        const ratio = Math.min(1, 1600 / Math.max(r.image.width, r.image.height));
        return result([
          image(
            encodePNG(
              ratio < 1
                ? resizeNearest(
                    r.image,
                    Math.round(r.image.width * ratio),
                    Math.round(r.image.height * ratio),
                  )
                : r.image,
            ),
          ),
          json({ times: r.times, save_to: a.save_to }),
        ]);
      }),
  );
  addTool(
    server,
    'rev2d_scene_analyze',
    {
      title: 'Analyze scene framing',
      description:
        'Sample a scene at its fps and report camera reveals with intervals and maximum overflow, fast camera motion, offscreen layers, cropped bubbles and character overlaps. Includes existing per-model animation analysis. Warnings need visual review.',
      input: z.strictObject({ path: Path }),
      effect: 'read-only',
    },
    (a) => guarded(async () => result([json(analyzeLoadedScene(await loadScene(resolvePath(ctx, a.path))))])),
  );
  addTool(
    server,
    'rev2d_scene_render',
    {
      title: 'Render a scene video',
      description:
        'Stream scene frames to a new MP4 (H.264 yuv420p plus optional AAC narration), GIF, or PNG sequence with manifest. MP4/GIF need ffmpeg on PATH or REV2D_FFMPEG; PNG needs none. Source files remain unchanged; existing outputs are refused.',
      input: z.strictObject({
        path: Path,
        out: Path,
        format: z.enum(['mp4', 'gif', 'png']).optional(),
        from: z.number().nonnegative().optional(),
        to: z.number().positive().optional(),
        scale: size.optional(),
        crf: z.number().min(0).max(51).optional(),
        audio: z.boolean().optional(),
      }),
      effect: 'additive',
    },
    (a) =>
      guarded(async () =>
        result([
          json(await renderScene(await loadScene(resolvePath(ctx, a.path)), resolvePath(ctx, a.out), a)),
        ]),
      ),
  );
}
