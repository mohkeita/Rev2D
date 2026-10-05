/**
 * rev2d_import / rev2d_export over an in-memory MCP connection: files written, the report in the
 * result text and JSON, argument checks per format, errors as isError results with hints.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from '../server.js';
import { loadTemplate, PACKAGE_ROOT } from '../../api/templates.js';
import { formatModelJson } from '../../core/format.js';
import { createImage, encodePNG } from '../../render/index.js';

const SPINE_FIXTURES = path.join(PACKAGE_ROOT, 'src', 'interop', 'spine', '__tests__', 'fixtures');

let dir: string;
let client: Client;
let close: () => Promise<void>;

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'rev2d-mcp-interop-'));
  mkdirSync(path.join(dir, 'spine'));
  copyFileSync(path.join(SPINE_FIXTURES, 'hero-4x.json'), path.join(dir, 'spine', 'hero.json'));
  copyFileSync(path.join(SPINE_FIXTURES, 'hero.atlas'), path.join(dir, 'spine', 'hero.atlas'));
  writeFileSync(path.join(dir, 'spine', 'hero.png'), encodePNG(createImage(64, 32, '#ffffff')));
  writeFileSync(path.join(dir, 'hana.r2d.json'), formatModelJson(loadTemplate('hana', { name: 'hana' }).doc));
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

const text = (r: CallToolResult) => (r.content[0] as { text: string }).text;
const json = (r: CallToolResult) => JSON.parse((r.content[1] as { text: string }).text);

describe('rev2d_import / rev2d_export', () => {
  it('are listed with descriptions within the client limit', async () => {
    const { tools } = await client.listTools();
    for (const name of ['rev2d_import', 'rev2d_export']) {
      const t = tools.find((x) => x.name === name)!;
      expect(t.description!.length, name).toBeLessThanOrEqual(2048);
      expect(t.description).toMatch(/report/);
    }
    expect(tools.find((x) => x.name === 'rev2d_import')!.annotations?.destructiveHint).toBe(true);
    expect(tools.find((x) => x.name === 'rev2d_import')!.description).toMatch(/\.moc3 model binary is never read/);
    expect(tools.find((x) => x.name === 'rev2d_docs')!.description).toMatch(/interop = Spine \/ Live2D import and export/);
    const docs = await call('rev2d_docs', { topic: 'interop' });
    expect(text(docs)).toBe(readFileSync(path.join(PACKAGE_ROOT, 'docs', 'INTEROP.md'), 'utf8'));
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain('rev2d://docs/interop');
  });

  it('imports a Spine export into a new model, with the report in the text and the JSON', { timeout: 120_000 }, async () => {
    const r = await call('rev2d_import', { format: 'spine', path: 'spine/hero.json', out: 'models/hero.r2d.json' });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toMatch(/^imported Spine skeleton spine\/hero\.json into models\/hero\.r2d\.json: 12 bones, 9 parts, 2 animations \(move, soft\)/);
    expect(text(r)).toContain('atlas: spine/hero.atlas; pages: spine/hero.png');
    expect(text(r)).toContain('validation: 0 errors, 0 warnings');
    expect(text(r)).toMatch(/^ {2}spine-dark-color +slots\[4\]/m);
    expect(text(r)).toContain('next: rev2d_render {path: "models/hero.r2d.json"');
    const j = json(r);
    expect(j.ok).toBe(true);
    expect(j.report.issues.length).toBeGreaterThan(10);
    expect(existsSync(path.join(dir, 'models', 'textures', 'hero.png'))).toBe(true);
    const again = await call('rev2d_import', { format: 'spine', path: 'spine/hero.json', out: 'models/hero.r2d.json' });
    expect(again.isError).toBe(true);
    expect(text(again)).toBe('Error: models/hero.r2d.json already exists\nhint: pass overwrite: true to replace it, or choose another out path');
    expect((await call('rev2d_import', { format: 'spine', path: 'spine/hero.json', out: 'models/hero.r2d.json', overwrite: true })).isError).toBeFalsy();
    // Default output: next to the skeleton.
    expect((await call('rev2d_import', { format: 'spine', path: 'spine/hero.json' })).isError).toBeFalsy();
    expect(existsSync(path.join(dir, 'spine', 'hero.r2d.json'))).toBe(true);
  });

  it('imports Live2D motions into a model (dry run first) and checks arguments per format', async () => {
    const motion = {
      Version: 3,
      Meta: { Duration: 1, Fps: 30, Loop: true, AreBeziersRestricted: true, CurveCount: 1, TotalSegmentCount: 1, TotalPointCount: 2, UserDataCount: 0, TotalUserDataSize: 0 },
      Curves: [{ Target: 'Parameter', Id: 'ParamAngleX', Segments: [0, 0, 0, 1, 20] }],
    };
    writeFileSync(path.join(dir, 'turn.motion3.json'), JSON.stringify(motion));
    const before = readFileSync(path.join(dir, 'hana.r2d.json'), 'utf8');
    const dry = await call('rev2d_import', { format: 'live2d', path: 'turn.motion3.json', into: 'hana.r2d.json', dry_run: true });
    expect(dry.isError).toBeFalsy();
    expect(text(dry)).toContain('import into hana.r2d.json: 1 animation (turn)');
    expect(text(dry)).toContain('dry run: hana.r2d.json unchanged');
    expect(readFileSync(path.join(dir, 'hana.r2d.json'), 'utf8')).toBe(before);
    const r = await call('rev2d_import', { format: 'live2d', path: ['turn.motion3.json'], into: 'hana.r2d.json', id: 'turnHead', param_map: 'standard' });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain('written: hana.r2d.json');
    expect(json(r)).toMatchObject({ ok: true, written: true, summary: { animations: ['turnHead'] } });
    expect(JSON.parse(readFileSync(path.join(dir, 'hana.r2d.json'), 'utf8')).animations.some((a: { id: string }) => a.id === 'turnHead')).toBe(true);

    const noInto = await call('rev2d_import', { format: 'live2d', path: 'turn.motion3.json' });
    expect(text(noInto)).toMatch(/format "live2d" needs `into`/);
    const wrong = await call('rev2d_import', { format: 'spine', path: 'spine/hero.json', into: 'hana.r2d.json', physics: 'merge' });
    expect(wrong.isError).toBe(true);
    expect(text(wrong)).toBe('Error: into, physics do not apply to format "spine"\nhint: they apply to format "live2d" only; remove them');
    const spine = await call('rev2d_import', { format: 'live2d', path: 'spine/hero.json', into: 'hana.r2d.json' });
    expect(text(spine)).toMatch(/hint: this is a Spine skeleton/);
  });

  it('exports to Spine and Live2D files, with the report', { timeout: 180_000 }, async () => {
    const s = await call('rev2d_export', { format: 'spine', path: 'models/hero.r2d.json', out_dir: 'exp/spine', animations: ['move'], fps: 20 });
    expect(s.isError).toBeFalsy();
    expect(text(s)).toMatch(/^exported models\/hero\.r2d\.json to Spine in exp\/spine: \d+ bones, \d+ slots, 1 animation, 1 atlas page/);
    expect(text(s)).toMatch(/files: exp\/spine\/hero\.json \(new, \d+ bytes\), exp\/spine\/hero\.atlas \(new, \d+ bytes\), exp\/spine\/hero\.png \(new, \d+ bytes\)/);
    expect(json(s).files).toHaveLength(3);
    const l = await call('rev2d_export', { format: 'live2d', path: 'hana.r2d.json', out_dir: 'exp/l2d', animations: ['idle'], param_map: { MouthOpen: 'ParamMouthOpenY' } });
    expect(l.isError).toBeFalsy();
    expect(text(l)).toContain('exported hana.r2d.json as Live2D JSON in exp/l2d: 1 motion, 4 files');
    expect(existsSync(path.join(dir, 'exp', 'l2d', 'motions', 'idle.motion3.json'))).toBe(true);

    const typo = await call('rev2d_export', { format: 'spine', path: 'models/hero.r2d.json', out_dir: 'x', animations: ['mov'] });
    expect(text(typo)).toBe('Error: unknown animation id: "mov"\nhint: did you mean "move"?');
    const mixed = await call('rev2d_export', { format: 'live2d', path: 'hana.r2d.json', out_dir: 'x', texture_scale: 2 });
    expect(text(mixed)).toMatch(/texture_scale only apply to format "spine"/);
    const map = await call('rev2d_export', { format: 'spine', path: 'hana.r2d.json', out_dir: 'x', param_map: 'none' });
    expect(text(map)).toMatch(/param_map only applies to format "live2d"/);
  });
});
