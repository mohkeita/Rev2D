import { it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/server.js';
import { main } from '../src/cli/main.js';
import { loadScene, requireScene } from '../src/node/scene.js';
import { renderSceneFrame } from '../src/scene/render.js';
const doc = {
  format: 'rev2d',
  version: 1,
  meta: { name: 'acting', width: 100, height: 100 },
  parameters: [{ id: 'AngleX', min: -30, max: 30, default: 0 }],
  parts: [{ id: 'dot', shape: { type: 'ellipse', cx: 50, cy: 50, rx: 10, ry: 10 }, fill: '#ee4433' }],
  bindings: [
    {
      target: 'part:dot.shape.cx',
      params: ['AngleX'],
      keys: [
        { at: [-30], value: 30 },
        { at: [0], value: 50 },
        { at: [30], value: 70 },
      ],
    },
  ],
};
async function workspace(fn: (dir: string, file: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rev2d-acting-')),
    file = path.join(dir, 'model.json');
  try {
    await writeFile(file, JSON.stringify(doc));
    await fn(dir, file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
it('CLI dry run preserves bytes; apply writes, rerun is idempotent, invalid side is usage error', () =>
  workspace(async (dir, file) => {
    const run = async (args: string[]) => {
      let out = '',
        err = '';
      const code = await main(args, {
        cwd: dir,
        stdout: { write: (s) => (out += s) },
        stderr: { write: (s) => (err += s) },
      });
      return { code, out, err };
    };
    const before = await readFile(file, 'utf8'),
      args = ['gesture', 'apply', file, '--gesture', 'shake_no', '--json'];
    const dry = await run([...args, '--dry-run']);
    expect(dry.code, dry.err).toBe(0);
    expect(JSON.parse(dry.out).written).toBe(false);
    expect(await readFile(file, 'utf8')).toBe(before);
    const applied = await run(args);
    expect(applied.code, applied.err).toBe(0);
    expect(JSON.parse(applied.out).written).toBe(true);
    const second = await run(args);
    expect(JSON.parse(second.out).changed).toBe(false);
    expect((await run([...args, '--side', 'up'])).code).toBe(2);
    expect((await run(['expression', 'list', '--json'])).out).toContain('surprised');
  }));
it('MCP lists both libraries and applies gestures/expressions with reviewable dry runs', () =>
  workspace(async (dir, file) => {
    const server = createMcpServer({ cwd: dir }),
      [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: 'acting-test', version: '1' });
    await client.connect(b);
    try {
      const list = await client.callTool({ name: 'rev2d_gesture_list', arguments: {} });
      expect(JSON.stringify(list)).toContain('scratch_head');
      expect(JSON.stringify(list)).toContain('shocked');
      const before = await readFile(file, 'utf8');
      for (const kind of ['gesture', 'expression']) {
        const r = await client.callTool({
          name: `rev2d_${kind}_apply`,
          arguments: { path: file, [kind]: kind === 'gesture' ? 'shake_no' : 'thinking', dry_run: true },
        });
        expect(r.isError).not.toBe(true);
        if (kind === 'expression') expect(JSON.stringify(r)).toContain('gesture-missing-param');
      }
      expect(await readFile(file, 'utf8')).toBe(before);
      const r = await client.callTool({
        name: 'rev2d_gesture_apply',
        arguments: { path: file, gesture: 'shake_no' },
      });
      expect(r.isError).not.toBe(true);
      expect(await readFile(file, 'utf8')).not.toBe(before);
    } finally {
      await client.close();
      await server.close();
    }
  }));
it('loading, cue resolution and rendering generated scene acting leave the model file hash unchanged', () =>
  workspace(async (dir, file) => {
    const before = hash(await readFile(file, 'utf8'));
    await writeFile(path.join(dir, 'words.json'), JSON.stringify([{ word: 'voilà', start: 0.3, end: 0.6 }]));
    await writeFile(
      path.join(dir, 'scene.json'),
      JSON.stringify({
        version: 1,
        id: 'shot',
        width: 100,
        height: 100,
        duration: 1,
        fps: 12,
        narration: { alignment: 'words.json' },
        layers: [
          {
            id: 'hero',
            type: 'model',
            src: 'model.json',
            x: 50,
            y: 50,
            animations: [
              'idle_alive',
              { gesture: 'shake_no', t: '@text:voilà' },
              { expression: 'thinking', t: 0.6 },
            ],
          },
        ],
      }),
    );
    const loaded = await loadScene(path.join(dir, 'scene.json'));
    expect(loaded.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const prepared = requireScene(loaded);
    renderSceneFrame(prepared, 0.6);
    expect(prepared.cues.some((c) => c.cue === '@text:voilà' && c.time === 0.3)).toBe(true);
    expect(hash(await readFile(file, 'utf8'))).toBe(before);
  }));
