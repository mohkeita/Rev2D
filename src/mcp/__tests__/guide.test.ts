import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from '../server.js';
import { GUIDE, RECIPES } from '../guide.js';
import { formatModelJson } from '../../core/format.js';

/** A minimal character with the ids the recipes expect (unrotated head bone, ellipse eye with ry 12). */
const FIXTURE = {
  format: 'rev2d',
  version: 1,
  meta: { name: 'recipes', width: 512, height: 512 },
  bones: [
    { id: 'chest', x: 256, y: 420, length: 60 },
    { id: 'head', x: 256, y: 300, length: 40 },
  ],
  parts: [
    { id: 'hairBack', parent: 'head', shape: { type: 'rect', x: 186, y: 110, w: 140, h: 190 }, fill: '#402020' },
    { id: 'body', parent: 'chest', shape: { type: 'rect', x: 196, y: 330, w: 120, h: 160, radius: 20 }, fill: '#4060a0' },
    { id: 'face', parent: 'head', shape: { type: 'ellipse', cx: 256, cy: 210, rx: 75, ry: 90 }, fill: '#f0d0b0' },
    { id: 'eyeL', parent: 'head', shape: { type: 'ellipse', cx: 226, cy: 200, rx: 8, ry: 12 }, fill: '#202020' },
  ],
};

let dir: string;
let client: Client;
let close: () => Promise<void>;

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'rev2d-mcp-guide-'));
  writeFileSync(path.join(dir, 'char.r2d.json'), formatModelJson(FIXTURE));
  const server = createMcpServer({ cwd: dir });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  client = new Client({ name: 'rev2d-test', version: '0.0.0' });
  await client.connect(ct);
  close = async () => {
    await client.close();
    await server.close();
  };
});

afterAll(async () => {
  await close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

const json = <T>(r: CallToolResult): T => JSON.parse((r.content[1] as { text: string }).text) as T;
const eye = (r: CallToolResult) => json<{ parts: Array<{ bounds: number[]; center: number[] }> }>(r).parts[0];

describe('guide recipes', () => {
  it('are rendered into the guide', () => {
    for (const r of RECIPES) expect(GUIDE).toContain(`### ${r.title}`);
    expect(GUIDE).toContain(JSON.stringify(RECIPES[0].ops[3]));
  });

  it('apply cleanly, in order, with the real ops engine', async () => {
    for (const recipe of RECIPES) {
      const r = await call('rev2d_apply_ops', { path: 'char.r2d.json', ops: recipe.ops });
      expect(r.isError, `${recipe.title}:\n${(r.content[0] as { text: string }).text}`).toBeFalsy();
    }
    const v = await call('rev2d_validate', { path: 'char.r2d.json' });
    expect(json<{ errors: number; warnings: number }>(v)).toMatchObject({ errors: 0, warnings: 0 });
  });

  it('do what their notes claim', async () => {
    const at = (params: Record<string, number>) => call('rev2d_inspect', { path: 'char.r2d.json', params, parts: ['eyeL'] });
    // Head turn: the eye moves toward +x with AngleX.
    expect(eye(await at({ AngleX: 30 })).center[0]).toBeGreaterThan(eye(await at({ AngleX: -30 })).center[0] + 5);
    // Blink: EyeOpen=1 is the rest pose, 0 closes the eye.
    expect(eye(await at({ EyeOpen: 1 })).bounds[3]).toBeGreaterThan(20);
    expect(eye(await at({ EyeOpen: 0 })).bounds[3]).toBeLessThan(4);

    // Physics hair: swings only when AngleX changes over time.
    const turn = [{ op: 'key', animation: 'turn', target: 'param:AngleX', t: 0, v: -30, duration: 1 }, { op: 'key', animation: 'turn', target: 'param:AngleX', t: 0.3, v: 30 }];
    expect((await call('rev2d_apply_ops', { path: 'char.r2d.json', ops: turn })).isError).toBeFalsy();
    const still = json<{ params: Record<string, number> }>(await call('rev2d_inspect', { path: 'char.r2d.json', params: { AngleX: 30 }, bones: ['hairBone'] }));
    expect(still.params.HairSway).toBe(0);
    const moving = json<{ params: Record<string, number> }>(await call('rev2d_inspect', { path: 'char.r2d.json', animations: ['turn'], time: 0.4, bones: ['hairBone'] }));
    expect(Math.abs(moving.params.HairSway)).toBeGreaterThan(1);
  });

  it('pitfall holds: a bone\'s setup rotation moves its rest frame, not its parts', async () => {
    expect(GUIDE).toMatch(/Setup \(rest\) values are not poses/);
    writeFileSync(path.join(dir, 'pitfall.r2d.json'), formatModelJson(FIXTURE));
    const face = async () => {
      const r = await call('rev2d_inspect', { path: 'pitfall.r2d.json', bones: ['head'], parts: ['face'] });
      return json<{ bones: Array<{ rotation: number }>; parts: Array<{ bounds: number[] }> }>(r);
    };
    const before = await face();
    expect((await call('rev2d_apply_ops', { path: 'pitfall.r2d.json', ops: [{ op: 'set', target: 'bone:head.rotation', value: 30 }] })).isError).toBeFalsy();
    const after = await face();
    expect(after.bones[0].rotation).toBe(30);
    expect(after.parts[0].bounds).toEqual(before.parts[0].bounds);
  });
});
