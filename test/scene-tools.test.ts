import { it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from '../src/mcp/server.js';
import { main } from '../src/cli/main.js';

it('runs all five scene MCP tools against real files and returns inline previews', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rev2d-scene-mcp-'));
  const server = createMcpServer({ cwd: dir }),
    [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 'scene-test', version: '1' });
  await client.connect(ct);
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as CallToolResult;
  try {
    await writeFile(
      path.join(dir, 'scene.json'),
      JSON.stringify({
        version: 1,
        duration: 0.5,
        width: 80,
        height: 60,
        fps: 8,
        layers: [
          {
            id: 'box',
            type: 'color',
            color: 'red',
            width: 20,
            height: 20,
            x: 30,
            y: 20,
            enter: { t: 0.1, type: 'pop' },
          },
        ],
      }),
    );
    const names = ['validate', 'frame', 'sheet', 'analyze', 'render'].map((v) => 'rev2d_scene_' + v);
    const discovery = await client.listTools();
    for (const name of names) {
      const tool = discovery.tools.find((t) => t.name === name)!;
      expect(tool).toBeDefined();
      expect(tool.description!.length).toBeLessThan(2048);
    }
    expect((await call(names[0], { path: 'scene.json' })).isError).toBeFalsy();
    const frame = await call(names[1], {
      path: 'scene.json',
      time: 0.4,
      overlay: ['camera', 'bounds', 'anchors', 'safe'],
      save_to: 'frame.png',
    });
    expect(frame.isError).toBeFalsy();
    expect(frame.content.some((c) => c.type === 'image')).toBe(true);
    const sheet = await call(names[2], { path: 'scene.json', times: [0, 0.4], save_to: 'sheet.png' });
    expect(sheet.isError).toBeFalsy();
    expect(sheet.content.some((c) => c.type === 'image')).toBe(true);
    expect((await call(names[3], { path: 'scene.json' })).isError).toBeFalsy();
    expect((await call(names[4], { path: 'scene.json', out: 'frames', format: 'png' })).isError).toBeFalsy();
    expect(JSON.parse(await readFile(path.join(dir, 'frames/manifest.json'), 'utf8')).frames).toBe(4);
    await writeFile(
      path.join(dir, 'bad.json'),
      JSON.stringify({
        version: 1,
        duration: 1,
        layers: [{ id: 'missing', type: 'image', src: 'missing.png' }],
      }),
    );
    const bad = await call(names[1], { path: 'bad.json' });
    expect(bad.isError).toBe(true);
    expect(JSON.stringify(bad)).toContain('scene-file-missing');
    expect((await call('rev2d_docs', { topic: 'scene' })).isError).toBeFalsy();
  } finally {
    await client.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it('runs all seven scene CLI commands with stable JSON and separate progress', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rev2d-scene-cli-'));
  const run = async (args: string[]) => {
    let stdout = '',
      stderr = '';
    const code = await main(['scene', ...args, '--json'], {
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
    return { code, stdout, stderr, json: JSON.parse(stdout) as Record<string, unknown> };
  };
  try {
    expect((await run(['new', 'scene.json', '--size', '80x60'])).code).toBe(0);
    await writeFile(
      path.join(dir, 'scene.json'),
      JSON.stringify({ version: 1, width: 80, height: 60, duration: 0.5, fps: 8 }),
    );
    for (const verb of ['validate', 'info', 'analyze'])
      expect((await run([verb, 'scene.json'])).code).toBe(0);
    expect((await run(['frame', 'scene.json', '-o', 'frame.png', '--time', '0.2'])).code).toBe(0);
    expect((await run(['sheet', 'scene.json', '-o', 'sheet.png', '--frames', '2'])).code).toBe(0);
    const render = await run(['render', 'scene.json', '-o', 'frames', '--format', 'png']);
    expect(render.code).toBe(0);
    expect(render.stderr).toContain('frame 4/4 100.0%');
    expect(render.stdout).not.toContain('ETA');
    expect(render.json.frames).toBe(4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
