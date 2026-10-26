/** Thin MCP adapters for the same episode IO used by the CLI. */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { addTool, json, result, resolvePath, ToolError, type ToolContext } from '../context.js';
import { EpisodeError } from '../../episode/index.js';
import { validateEpisode, planEpisode, buildEpisode } from '../../node/episode.js';
import { renderEpisode } from '../../node/episode-render.js';
import { assembleEpisode } from '../../node/episode-assemble.js';
import { reportEpisode, episodeThumbnails } from '../../node/episode-report.js';
const Path = z.string().min(1),
  only = z.array(z.string().min(1)).optional();
export function registerEpisodeTools(server: McpServer, ctx: ToolContext) {
  const guarded = async (fn: () => Promise<unknown>) => {
    try {
      const value = await fn();
      return result([json(value)], (value as { ok?: boolean }).ok === false);
    } catch (e) {
      if (e instanceof EpisodeError) throw new ToolError(e.message, e.diagnostics, e.diagnostics[0]?.hint);
      throw e;
    }
  };
  addTool(
    server,
    'rev2d_episode_validate',
    {
      title: 'Validate episode',
      description:
        'Validate a version 1 storyboard, shared frame boundaries, narration cues, scene assets and source files. Returns stable episode diagnostics. Read rev2d_docs topic episode first.',
      input: z.strictObject({ path: Path }),
      effect: 'read-only',
    },
    (a) => guarded(() => validateEpisode(resolvePath(ctx, a.path))),
  );
  addTool(
    server,
    'rev2d_episode_plan',
    {
      title: 'Plan missing assets',
      description:
        'List exact missing storyboard assets, deduplicated by kind, id and pose with requesting shot ids. out optionally writes original generation requests; no network generation is performed.',
      input: z.strictObject({ path: Path, out: Path.optional() }),
      effect: 'additive',
    },
    (a) => guarded(() => planEpisode(resolvePath(ctx, a.path), a.out ? resolvePath(ctx, a.out) : undefined)),
  );
  addTool(
    server,
    'rev2d_episode_build',
    {
      title: 'Build episode scenes',
      description:
        'Write explicit per-shot scenes into a managed episode directory. Authored scene sources are preserved. only selects shot ids; force explicitly replaces locally edited generated scenes.',
      input: z.strictObject({ path: Path, out: Path, only, force: z.boolean().optional() }),
      effect: 'destructive',
    },
    (a) =>
      guarded(() =>
        buildEpisode(resolvePath(ctx, a.path), resolvePath(ctx, a.out), { only: a.only, force: a.force }),
      ),
  );
  addTool(
    server,
    'rev2d_episode_render',
    {
      title: 'Render cached episode',
      description:
        'Render shot MP4 files with isolated Node workers and content hashes for transitive resources and output bytes. Unchanged shots are reused. Requires optional local ffmpeg and ffprobe.',
      input: z.strictObject({
        path: Path,
        only,
        jobs: z.number().int().min(1).max(16).optional(),
        force: z.boolean().optional(),
      }),
      effect: 'destructive',
    },
    (a) => guarded(() => renderEpisode(resolvePath(ctx, a.path), a)),
  );
  addTool(
    server,
    'rev2d_episode_assemble',
    {
      title: 'Assemble episode video',
      description:
        'Assemble cached shots at their original frame cuts with transitions, continuous narration and ducked music. size supports focus-aware portrait crops with episode-vertical-crop warnings. Writes a new MP4.',
      input: z.strictObject({
        path: Path,
        out: Path,
        size: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(),
      }),
      effect: 'additive',
    },
    (a) =>
      guarded(() => assembleEpisode(resolvePath(ctx, a.path), resolvePath(ctx, a.out), { size: a.size })),
  );
  addTool(
    server,
    'rev2d_episode_report',
    {
      title: 'Review entire episode',
      description:
        'Write a new review directory with a contact sheet and scene/model analysis per shot, plus HTML, Markdown and JSON indexes. Explicit external clips receive media notes instead of rig analysis.',
      input: z.strictObject({ path: Path, out: Path }),
      effect: 'additive',
    },
    (a) => guarded(() => reportEpisode(resolvePath(ctx, a.path), resolvePath(ctx, a.out))),
  );
  addTool(
    server,
    'rev2d_episode_thumbnails',
    {
      title: 'Export episode thumbnails',
      description:
        'Write one PNG per built shot at its middle, start or final frame, plus a JSON index. Handles native scenes and explicitly declared external clips. Source artwork and scenes remain unchanged.',
      input: z.strictObject({ path: Path, out: Path, at: z.enum(['middle', 'start', 'end']).optional() }),
      effect: 'additive',
    },
    (a) => guarded(() => episodeThumbnails(resolvePath(ctx, a.path), resolvePath(ctx, a.out), { at: a.at })),
  );
}
