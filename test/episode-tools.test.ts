import { it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from '../src/mcp/server.js';
import { main } from '../src/cli/main.js';
import { syntheticWav } from '../scripts/examples/scene-assets.js';
import { findFfmpeg } from '../src/node/video.js';
it('exposes seven episode MCP tools backed by real IO and stable CLI usage/error codes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rev2d-episode-tools-')),
    server = createMcpServer({ cwd: dir }),
    [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 'episode-tests', version: '1' });
  await client.connect(ct);
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name: 'rev2d_episode_' + name, arguments: args })) as CallToolResult;
  const run = async (args: string[]) => {
    let stdout = '',
      stderr = '';
    const code = await main(args, {
      cwd: dir,
      stdout: {
        write: (s) => {
          stdout += s;
        },
      },
      stderr: {
        write: (s) => {
          stderr += s;
        },
      },
    });
    return { code, stdout, stderr };
  };
  try {
    await writeFile(path.join(dir, 'voice.wav'), syntheticWav(0.5));
    await writeFile(
      path.join(dir, 'storyboard.json'),
      JSON.stringify({
        version: 1,
        id: 'tools',
        size: [160, 90],
        fps: 24,
        narration: { audio: 'voice.wav' },
        shots: [
          { id: 'A', start: 0, end: '@end', layers: [{ id: 'color', type: 'color', color: '#dd6a44' }] },
        ],
      }),
    );
    const discovery = await client.listTools();
    for (const verb of ['validate', 'plan', 'build', 'render', 'assemble', 'report', 'thumbnails'])
      expect(discovery.tools.find((t) => t.name === 'rev2d_episode_' + verb)).toBeDefined();
    expect((await call('validate', { path: 'storyboard.json' })).isError).toBeFalsy();
    expect((await call('plan', { path: 'storyboard.json', out: 'requests' })).isError).toBeFalsy();
    expect((await call('build', { path: 'storyboard.json', out: 'episode' })).isError).toBeFalsy();
    expect((await call('thumbnails', { path: 'episode', out: 'thumbs' })).isError).toBeFalsy();
    expect((await call('report', { path: 'episode', out: 'review' })).isError).toBeFalsy();
    expect(JSON.parse((await run(['episode', 'validate', 'storyboard.json', '--json'])).stdout).ok).toBe(
      true,
    );
    expect((await run(['episode', 'render', 'episode', '--jobs', '1.5', '--json'])).code).toBe(2);
    expect((await run(['episode', 'thumbnails', 'episode', '-o', 'bad', '--at', 'no', '--json'])).code).toBe(
      2,
    );
    expect(
      (await call('build', { path: 'storyboard.json', out: 'episode', only: ['unknown'] })).isError,
    ).toBe(true);
    let encoder = true;
    try {
      await findFfmpeg();
    } catch {
      encoder = false;
      console.warn('episode MCP encoding skipped: ffmpeg is unavailable');
    }
    if (encoder) {
      const rendered = await call('render', { path: 'episode', jobs: 1 });
      expect(rendered.isError, JSON.stringify(rendered)).toBeFalsy();
      const assembled = await call('assemble', { path: 'episode', out: 'final.mp4' });
      expect(assembled.isError, JSON.stringify(assembled)).toBeFalsy();
    }
  } finally {
    await client.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 60000);
