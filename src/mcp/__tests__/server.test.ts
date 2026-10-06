import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from '../server.js';
import { autoScale, errorResult, mcpText, nativePath } from '../context.js';
import { ApiError } from '../../api/index.js';
import { blankModel, listTemplates, loadTemplate, PACKAGE_ROOT } from '../../api/templates.js';
import { readDoc, recipesTopicText } from '../tools/docs.js';
import { recipeTitles } from '../../api/docs.js';
import { describeOps } from '../../ops/index.js';
import { GUIDE } from '../guide.js';
import { formatModelJson } from '../../core/format.js';
import { parseModelText } from '../../core/validate.js';
import { createImage, decodePNG, encodePNG } from '../../render/index.js';

let dir: string;
let client: Client;
let close: () => Promise<void>;

const BLANK = 'blank.r2d.json';

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'rev2d-mcp-'));
  writeFileSync(path.join(dir, BLANK), formatModelJson(blankModel({ name: 'blank', width: 200, height: 200 })));
  const server = createMcpServer({ cwd: dir });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'rev2d-test', version: '0.0.0' });
  await client.connect(clientTransport);
  close = async () => {
    await client.close();
    await server.close();
  };
});

afterAll(async () => {
  await close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

function texts(r: CallToolResult): string[] {
  return r.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text);
}

/** The machine-readable block: the last text block that parses as a JSON object. */
function jsonOf<T = Record<string, unknown>>(r: CallToolResult): T {
  for (const t of texts(r).reverse()) {
    try {
      const v = JSON.parse(t) as unknown;
      if (v && typeof v === 'object') return v as T;
    } catch {
      // prose block
    }
  }
  throw new Error(`no JSON block in: ${texts(r).join('\n---\n')}`);
}

function images(r: CallToolResult) {
  return r.content
    .filter((c) => c.type === 'image')
    .map((c) => {
      const img = c as { data: string; mimeType: string };
      expect(img.mimeType).toBe('image/png');
      return decodePNG(Buffer.from(img.data, 'base64'));
    });
}

function writeModel(name: string, doc: unknown): string {
  mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  writeFileSync(path.join(dir, name), typeof doc === 'string' ? doc : formatModelJson(doc));
  return name;
}

describe('mcp server: discovery', () => {
  it('lists every tool with a description and an object input schema', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'rev2d_analyze',
        'rev2d_apply_ops',
        'rev2d_create_model',
        'rev2d_diff_images',
        'rev2d_docs',
        'rev2d_editor_command',
        'rev2d_editor_screenshot',
        'rev2d_editor_state',
        'rev2d_guide',
        'rev2d_hit_test',
        'rev2d_export',
        'rev2d_import',
        'rev2d_info',
        'rev2d_inspect',
        'rev2d_render',
        'rev2d_schema',
        'rev2d_sheet',
        'rev2d_validate',
      ].sort(),
    );
    for (const t of tools) {
      expect(t.description!.length).toBeGreaterThan(80);
      expect(t.inputSchema.type).toBe('object');
    }
    const render = tools.find((t) => t.name === 'rev2d_render')!;
    expect(render.description).toMatch(/\+y down/);
    expect(Object.keys(render.inputSchema.properties ?? {})).toEqual(expect.arrayContaining(['path', 'params', 'overlay', 'viewBox', 'save_to']));
    expect(render.annotations?.readOnlyHint).toBe(false);
    expect(tools.find((t) => t.name === 'rev2d_apply_ops')!.annotations?.destructiveHint).toBe(true);
  });

  it('serves instructions, the guide, docs, schemas and resources', async () => {
    expect(client.getInstructions()).toMatch(/rev2d_guide/);
    const guide = texts(await call('rev2d_guide')).join('');
    expect(guide).toMatch(/\+y DOWN/);
    expect(guide).toMatch(/bind_warp/);

    const spec = await call('rev2d_docs', { topic: 'spec' });
    expect(spec.isError).toBeFalsy();
    expect(texts(spec)[0]).toMatch(/Property addresses/);
    expect(texts(await call('rev2d_docs', { topic: 'examples' }))[0]).toMatch(/## blank/);

    const full = jsonOf<{ properties: Record<string, unknown> }>(await call('rev2d_schema'));
    expect(Object.keys(full.properties)).toEqual(expect.arrayContaining(['meta', 'parts', 'bindings']));
    const partResult = await call('rev2d_schema', { name: 'partSchema' });
    expect(texts(partResult)[0]).toBe('JSON Schema of Part:');
    const part = jsonOf<{ properties: Record<string, unknown> }>(partResult);
    expect(Object.keys(part.properties)).toEqual(expect.arrayContaining(['shape', 'fill', 'skin']));
    const bad = await call('rev2d_schema', { name: 'Prat' });
    expect(bad.isError).toBe(true);
    expect(texts(bad)[0]).toMatch(/did you mean "Part"/);

    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toEqual(expect.arrayContaining(['rev2d://guide', 'rev2d://docs/spec', 'rev2d://docs/ops', 'rev2d://schema']));
    const schema = await client.readResource({ uri: 'rev2d://schema' });
    expect(JSON.parse((schema.contents[0] as { text: string }).text).type).toBe('object');
  });
});

describe('mcp server: model tools', () => {
  it('validates a clean model and reports broken ones with diagnostics', async () => {
    const ok = await call('rev2d_validate', { path: BLANK });
    expect(ok.isError).toBeFalsy();
    expect(texts(ok)[0]).toMatch(/valid/);
    expect(jsonOf(ok)).toMatchObject({ ok: true, errors: 0 });

    const doc = blankModel({ name: 'broken' }) as { parts: Array<Record<string, unknown>> };
    doc.parts[0].parent = 'bodyWrap';
    writeModel('broken.r2d.json', doc);
    const bad = await call('rev2d_validate', { path: 'broken.r2d.json' });
    expect(bad.isError).toBe(true);
    expect(texts(bad)[0]).toMatch(/INVALID/);
    expect(texts(bad)[0]).toMatch(/\/parts\/0\/parent/);
    const j = jsonOf<{ ok: boolean; diagnostics: Array<{ path: string; hint?: string }> }>(bad);
    expect(j.ok).toBe(false);
    expect(j.diagnostics.some((d) => d.path === '/parts/0/parent' && /bodyWarp/.test(d.hint ?? ''))).toBe(true);

    writeModel('syntax.r2d.json', '{ "format": "rev2d", ');
    const syntax = await call('rev2d_validate', { path: 'syntax.r2d.json' });
    expect(syntax.isError).toBe(true);
    expect(jsonOf<{ diagnostics: Array<{ code: string }> }>(syntax).diagnostics[0].code).toBe('json-syntax');
  });

  it('turns missing files and invalid models into isError results', async () => {
    const missing = await call('rev2d_render', { path: 'nope.r2d.json' });
    expect(missing.isError).toBe(true);
    expect(texts(missing)[0]).toMatch(/model file not found: nope\.r2d\.json/);
    expect(texts(missing)[0]).toMatch(/blank\.r2d\.json/); // nearby models are suggested

    const invalid = await call('rev2d_render', { path: 'broken.r2d.json' });
    expect(invalid.isError).toBe(true);
    expect(texts(invalid)[0]).toMatch(/1 error/);
    expect(jsonOf<{ diagnostics: unknown[] }>(invalid).diagnostics.length).toBeGreaterThan(0);

    const unknownParam = await call('rev2d_render', { path: BLANK, params: { Nope: 1 } });
    expect(unknownParam.isError).toBe(true);
    expect(texts(unknownParam)[0]).toMatch(/unknown parameter id: "Nope"\nhint: parameter ids in this model: Lean, Squash/);
    const typo = await call('rev2d_inspect', { path: BLANK, params: { Laen: 1 }, animations: ['idel@0.5'] });
    expect(texts(typo)[0]).toMatch(/unknown parameter id: "Laen"\nhint: did you mean "Lean"\?/);
    const anim = await call('rev2d_hit_test', { path: BLANK, x: 1, y: 1, animations: ['idel@0.5'] });
    expect(texts(anim)[0]).toMatch(/unknown animation id: "idel"\nhint: did you mean "idle"\?/);
    const weight = await call('rev2d_render', { path: BLANK, animations: ['idle@1.5'] });
    expect(texts(weight)[0]).toMatch(/bad layer weight in "idle@1\.5"\nhint: write "idle@0\.5"/);
    expect((await call('rev2d_render', { path: BLANK, animations: ['idle@0.5'], time: 0.5, scale: 0.1 })).isError).toBeFalsy();

    const badArgs = await call('rev2d_render', { path: BLANK, scael: 2 });
    expect(badArgs.isError).toBe(true);
  });

  it('describes a model as text and JSON', async () => {
    const r = await call('rev2d_info', { path: BLANK });
    expect(r.isError).toBeFalsy();
    expect(texts(r)[0]).toMatch(/PARAMETERS/);
    expect(jsonOf<{ counts: { parts: number } }>(r).counts.parts).toBe(2);
  });

  it('renders inline PNGs with auto scale, overrides and save_to', async () => {
    const r = await call('rev2d_render', { path: BLANK, params: { Lean: 1 }, overlay: ['bones', 'labels'], save_to: 'out/lean.png' });
    expect(r.isError).toBeFalsy();
    const [img] = images(r);
    // 200 px canvas is enlarged to the 512 px minimum.
    expect([img.width, img.height]).toEqual([512, 512]);
    const summary = texts(r)[0];
    expect(summary).toMatch(/512x512 px image of viewBox \[0, 0, 200, 200\]/);
    expect(summary).toMatch(/params: Lean=1/);
    expect(summary).toMatch(/visible parts \(2, back to front\): body, eye/);
    expect(summary).toMatch(/saved: out\/lean\.png/);
    expect(decodePNG(readFileSync(path.join(dir, 'out/lean.png'))).width).toBe(512);

    const exact = images(await call('rev2d_render', { path: BLANK, scale: 1, viewBox: [50, 50, 100, 60] }))[0];
    expect([exact.width, exact.height]).toEqual([100, 60]);

    writeModel('big.r2d.json', blankModel({ name: 'big', width: 2048, height: 1024 }));
    const big = images(await call('rev2d_render', { path: 'big.r2d.json' }))[0];
    expect([big.width, big.height]).toEqual([1024, 512]);

    const focus = await call('rev2d_render', { path: BLANK, overlay: ['bones', 'labels'], only: ['root'], onlyChain: true, scale: 0.5 });
    expect(focus.isError, texts(focus)[0]).toBeFalsy();
    const badFocus = await call('rev2d_render', { path: BLANK, overlay: ['bones'], only: ['rot'] });
    expect(texts(badFocus)[0]).toMatch(/unknown id "rot" in overlay only\nhint: did you mean "root"\?/);

    const badBox = await call('rev2d_render', { path: BLANK, viewBox: [0, 0, 0, 10] });
    expect(badBox.isError).toBe(true);
    expect(texts(badBox)[0]).toMatch(/positive width and height/);
  });

  it('renders sweep and animation sheets within the size limit', async () => {
    const sweep = await call('rev2d_sheet', { path: BLANK, sweeps: ['Lean=-1:1:3', 'Squash=0,1'], viewBox: 'fit' });
    expect(sweep.isError).toBeFalsy();
    expect(texts(sweep)[0]).toMatch(/6 cells in 3 columns/);
    expect(texts(sweep)[0]).toMatch(/columns: Lean = -1, 0, 1\nrows: Squash = 0, 1/);
    const [s] = images(sweep);
    expect(s.width).toBeGreaterThan(s.height);

    const anim = await call('rev2d_sheet', { path: 'big.r2d.json', animation: 'idle', frames: 4 });
    expect(texts(anim)[0]).toMatch(/t = 0, 0\.5, 1, 1\.5 s/);
    const [a] = images(anim);
    expect(Math.max(a.width, a.height)).toBeLessThanOrEqual(1030);

    // A zoomed region is enlarged toward 512 px like rev2d_render (3 cells of 60 px + padding).
    const zoom = await call('rev2d_sheet', { path: BLANK, sweeps: ['Lean=-1:1:3'], viewBox: [70, 70, 60, 40] });
    expect(texts(zoom)[0]).toMatch(/each cell: viewBox \[70, 70, 60, 40\] \(model px\) at scale 2\.66\d/);
    expect(images(zoom)[0].width).toBeLessThanOrEqual(512);
    expect(images(zoom)[0].width).toBeGreaterThan(500);

    const none = await call('rev2d_sheet', { path: BLANK });
    expect(none.isError).toBe(true);
    expect(texts(none)[0]).toMatch(/animations: idle; parameters: Lean, Squash/);
  });

  it('sizes sheets with the wrapped caption texts, so long captions in narrow cells still fit 1024 px', async () => {
    const doc = blankModel({ name: 'long', width: 200, height: 200 }) as { parameters: Array<Record<string, unknown>> };
    doc.parameters.push(
      { id: 'EyeLeftOpenness', min: 0, max: 1, default: 1 },
      { id: 'EyeRightOpenness', min: 0, max: 1, default: 1 },
      { id: 'MouthOpenAmount', min: 0, max: 1, default: 0 },
    );
    writeModel('long.r2d.json', doc);
    const r = await call('rev2d_sheet', { path: 'long.r2d.json', sweeps: ['EyeLeftOpenness,EyeRightOpenness=0:1:8', 'MouthOpenAmount=0:1:8'] });
    expect(r.isError, texts(r)[0]).toBeFalsy();
    const [img] = images(r);
    // Square cells: the captions wrap onto several lines, so the sheet is taller than wide...
    expect(img.height - img.width).toBeGreaterThan(8 * 20);
    // ...and the default scale still keeps it within 1024 px (and close to it).
    expect(Math.max(img.width, img.height)).toBeLessThanOrEqual(1024);
    expect(Math.max(img.width, img.height)).toBeGreaterThan(1000);
  });

  it('inspects poses with id filters', async () => {
    const all = jsonOf<{ bones: unknown[]; parts: unknown[]; warps: unknown[] }>(await call('rev2d_inspect', { path: BLANK }));
    expect(all.bones).toHaveLength(1);
    expect(all.parts).toHaveLength(2);

    const r = await call('rev2d_inspect', { path: BLANK, params: { Squash: 1 }, bones: ['root'] });
    expect(texts(r)[0]).toMatch(/params: Squash=1/);
    const j = jsonOf<{ bones: Array<{ id: string; scaleY: number }>; parts?: unknown; properties: Record<string, unknown> }>(r);
    expect(j.bones).toEqual([expect.objectContaining({ id: 'root', scaleY: 0.8 })]);
    expect(j.parts).toBeUndefined();
    expect(Object.keys(j.properties).every((k) => k.startsWith('bone:root.'))).toBe(true);

    const bad = await call('rev2d_inspect', { path: BLANK, bones: ['rot'] });
    expect(bad.isError).toBe(true);
    expect(texts(bad)[0]).toMatch(/unknown bone id: "rot"[\s\S]*did you mean "root"/);
  });

  it('plays layers with options: strings ("id@w,add,once,start=s") and objects, checked with hints', async () => {
    const doc = blankModel({ name: 'layers', width: 200, height: 200 }) as { animations: unknown[] };
    // A one-shot that pushes Lean by +0.6 while it plays.
    doc.animations.push({ id: 'nudge', duration: 0.5, loop: false, tracks: [{ target: 'param:Lean', keys: [{ t: 0, v: 0.6 }, { t: 0.5, v: 0.6 }] }] });
    writeModel('layers.r2d.json', doc);
    const lean = async (animations: unknown[], time: number) =>
      jsonOf<{ params: Record<string, number> }>(await call('rev2d_inspect', { path: 'layers.r2d.json', animations, time, bones: ['root'] })).params.Lean;
    const idle = await lean(['idle'], 1.25);
    // "add" puts the nudge on top of idle while it plays (from t = 1 to 1.5), "once" drops it afterwards.
    expect(await lean(['idle', 'nudge,add,once,start=1'], 1.25)).toBeCloseTo(Math.min(1, idle + 0.6), 3);
    expect(await lean(['idle', { id: 'nudge', mode: 'add', hold: false, start: 1 }], 1.25)).toBeCloseTo(Math.min(1, idle + 0.6), 3);
    expect(await lean(['idle', 'nudge,add,once,start=1'], 1.75)).toBeCloseTo(await lean(['idle'], 1.75), 3);
    // Without options the one-shot overrides and holds its last key.
    expect(await lean(['idle', 'nudge'], 1.75)).toBeCloseTo(0.6, 3);

    // API errors keep their hints.
    const loopOnce = await call('rev2d_render', { path: 'layers.r2d.json', animations: ['idle,once'] });
    expect(loopOnce.isError).toBe(true);
    expect(texts(loopOnce)[0]).toMatch(/"once" has no effect on looping animation "idle" without a start > 0[\s\S]*\nhint: to start the loop later/);
    const typo = await call('rev2d_render', { path: 'layers.r2d.json', animations: ['nudge,sttart=1'] });
    expect(texts(typo)[0]).toMatch(/unknown option "sttart=1" in animation layer "nudge,sttart=1"\nhint: did you mean "start"\?/);
    const weight = await call('rev2d_render', { path: 'layers.r2d.json', animations: ['nudge@2,add'] });
    expect(texts(weight)[0]).toMatch(/bad layer weight in "nudge@2,add"\nhint: write "nudge@0\.5"/);
  });

  it('samples animation sheets over a window, explicit times or after a physics warm-up', async () => {
    const window = await call('rev2d_sheet', { path: BLANK, animation: 'idle', from: 0.5, to: 1.5, frames: 3 });
    expect(window.isError, texts(window)[0]).toBeFalsy();
    expect(texts(window)[0]).toMatch(/3 cells in 2 columns\ncells: animation "idle" at t = 0\.5, 1, 1\.5 s\n/);
    const times = await call('rev2d_sheet', { path: BLANK, animation: 'idle', times: [0, 0.25] });
    expect(texts(times)[0]).toMatch(/cells: animation "idle" at t = 0, 0\.25 s\n/);
    const warm = await call('rev2d_sheet', { path: BLANK, animation: 'idle', frames: 2, warmup: 3 });
    expect(texts(warm)[0]).toMatch(/at t = 0, 1 s \(after 4 s warm-up\)/);
    expect(texts(warm)[0]).toMatch(/note: warmup changes nothing here: the model has no physics/);

    const both = await call('rev2d_sheet', { path: BLANK, animation: 'idle', times: [0], frames: 2 });
    expect(both.isError).toBe(true);
    expect(texts(both)[0]).toMatch(/times lists the sample times itself; drop frames\nhint: /);
    const stray = await call('rev2d_sheet', { path: BLANK, sweeps: ['Lean'], from: 1 });
    expect(texts(stray)[0]).toMatch(/from only apply to an animation sheet\nhint: pass `animation`/);
  });

  it('renders parameter overviews and linked sweeps', async () => {
    const overview = await call('rev2d_sheet', { path: BLANK, overview: true });
    expect(overview.isError, texts(overview)[0]).toBeFalsy();
    expect(texts(overview)[0]).toMatch(/10 cells in 5 columns\nrows: Lean -1\.\.1 \| Squash 0\.\.1 \(5 steps each\)/);
    const one = await call('rev2d_sheet', { path: BLANK, overview: { params: ['Squash'], steps: 3 } });
    expect(texts(one)[0]).toMatch(/3 cells in 3 columns\nrows: Squash 0\.\.1 \(3 steps each\)/);
    const typo = await call('rev2d_sheet', { path: BLANK, overview: { params: ['Sqush'] } });
    expect(texts(typo)[0]).toMatch(/unknown parameter id: "Sqush"\nhint: did you mean "Squash"\?/);

    const linked = await call('rev2d_sheet', { path: BLANK, sweeps: ['Lean,Squash=0:1:3'] });
    expect(linked.isError, texts(linked)[0]).toBeFalsy();
    expect(texts(linked)[0]).toMatch(/columns: Lean,Squash = 0, 0\.5, 1/);
    const ranges = await call('rev2d_sheet', { path: BLANK, sweeps: ['Lean,Squash'] });
    expect(ranges.isError).toBe(true);
    expect(texts(ranges)[0]).toMatch(/linked parameters in sweep "Lean,Squash" have different ranges[\s\S]*\nhint: give the values explicitly, e\.g\. "Lean,Squash=0:1:5"/);
  });

  it('inspects series of poses and compact track tables', async () => {
    const series = await call('rev2d_inspect', { path: BLANK, animations: ['idle'], times: [0, 0.5, 1], bones: ['root'] });
    expect(series.isError, texts(series)[0]).toBeFalsy();
    expect(texts(series)[0]).toMatch(/3 poses at t = 0, 0\.5, 1 s\./);
    const s = jsonOf<{ times: number[]; results: Array<{ params: Record<string, number>; bones: unknown[]; parts?: unknown }> }>(series);
    expect(s.times).toEqual([0, 0.5, 1]);
    expect(s.results.map((r) => r.params.Lean)).toEqual([-0.5, 0, 0.5]);
    expect(s.results[0].bones).toHaveLength(1);
    expect(s.results[0].parts).toBeUndefined();

    const track = await call('rev2d_inspect', { path: BLANK, animations: ['idle'], frames: 4, track: 'param:Lean,bone:root,part:eye.center' });
    expect(track.isError, texts(track)[0]).toBeFalsy();
    const t = jsonOf<{ times: number[]; columns: string[]; fields: Record<string, string[]>; rows: unknown[][] }>(track);
    expect(t.times).toEqual([0, 0.5, 1, 1.5]);
    expect(t.columns).toEqual(['param:Lean', 'bone:root', 'part:eye.center']);
    expect(t.fields['bone:root']).toEqual(['x', 'y', 'rotation']);
    expect(t.rows.map((r) => r[0])).toEqual([-0.5, 0, 0.5, 0]);
    expect(texts(track)[0]).toMatch(/4 times x 3 columns[\s\S]*\nt\s+param:Lean\s+bone:root \(x, y, rotation\)\s+part:eye\.center \(x, y\)\n0\s+-0\.5\s+\[100, 150, 0\]/);

    const noTimes = await call('rev2d_inspect', { path: BLANK, track: 'param:Lean' });
    expect(texts(noTimes)[0]).toMatch(/track needs times or frames[\s\S]*\nhint: /);
    const badColumn = await call('rev2d_inspect', { path: BLANK, times: [0], track: 'bone:rot' });
    expect(texts(badColumn)[0]).toMatch(/bad track column "bone:rot": unknown bone "rot"\nhint: did you mean "root"\?/);
    const clash = await call('rev2d_inspect', { path: BLANK, time: 1, times: [0] });
    expect(texts(clash)[0]).toMatch(/time and a series \(times \/ frames\) are exclusive\nhint: /);
  });

  it('maps setup-space points attached to bones, warps and parts through a pose', async () => {
    const r = await call('rev2d_inspect', { path: BLANK, params: { Squash: 1 }, points: ['100,100@root', { x: 100, y: 100 }], bones: ['root'] });
    expect(r.isError, texts(r)[0]).toBeFalsy();
    // Root joint (100, 150); Squash 1 scales the root bone by (1.15, 0.8): 50 px above the joint -> 40 px.
    expect(texts(r)[0]).toMatch(/point 100,100@root: setup \[100, 100\] -> posed \[100, 110\]/);
    const p = jsonOf<{ points: Array<{ spec: string; posed: number[] }> }>(r).points;
    expect(p).toEqual([expect.objectContaining({ spec: '100,100@root', posed: [100, 110] }), expect.objectContaining({ spec: '100,100', posed: [100, 100] })]);
    // A non-skinned part maps like its parent (eye -> bodyWarp); "part:" forces the kind.
    const part = await call('rev2d_inspect', { path: BLANK, params: { Lean: 1, Squash: 1 }, points: ['110,90@eye', '110,90@part:eye', '110,90@bodyWarp'] });
    expect(part.isError, texts(part)[0]).toBeFalsy();
    const pp = jsonOf<{ points: Array<{ spec: string; posed: number[] }> }>(part).points;
    expect(pp[0].posed).not.toEqual([110, 90]);
    expect(pp[1].posed).toEqual(pp[0].posed);
    expect(pp[2].posed).toEqual(pp[0].posed);
    const unknown = await call('rev2d_inspect', { path: BLANK, points: ['1,2@eey'] });
    expect(unknown.isError).toBe(true);
    expect(texts(unknown)[0]).toMatch(/unknown point parent "eey"\nhint: [^\n]*did you mean "eye"\?/);
    const wrongKind = await call('rev2d_inspect', { path: BLANK, points: ['1,2@bone:eye'] });
    expect(texts(wrongKind)[0]).toMatch(/unknown point parent "bone:eye": the model has no bone "eye"/);
  });

  it('analyzes animations: ranges, loop seam and notes', async () => {
    const ok = await call('rev2d_analyze', { path: BLANK, animation: 'idle' });
    expect(ok.isError, texts(ok)[0]).toBeFalsy();
    expect(texts(ok)[0]).toMatch(/^blank\.r2d\.json: analysis of idle \(2s loop\): 120 frames over t=0\.\.2s/);
    const r = jsonOf<{ frames: number; seam: { ok: boolean }; params: Array<{ id: string; min: number; max: number }> }>(ok);
    expect(r.frames).toBe(120);
    expect(r.seam.ok).toBe(true);
    expect(r.params.find((p) => p.id === 'Lean')).toMatchObject({ min: -0.5, max: 0.5 });

    const doc = blankModel({ name: 'seam', width: 200, height: 200 }) as { animations: Array<{ tracks: Array<{ keys: Array<{ v: number }> }> }> };
    doc.animations[0].tracks[0].keys[2].v = 0.5; // Lean ends at 0.5 but starts at -0.5
    writeModel('seam.r2d.json', doc);
    const seam = await call('rev2d_analyze', { path: 'seam.r2d.json', animation: 'idle', pixels: false });
    expect(texts(seam)[0]).toMatch(/the loop does not close: at t=2 -> 0 Lean 0\.5 -> -0\.5/);
    expect(jsonOf<{ seam: { ok: boolean } }>(seam).seam.ok).toBe(false);

    // Notes name tool arguments, not CLI flags.
    expect(mcpText('pass warmup (--warmup 10) to analyze the steady state')).toBe('pass warmup (warmup: 10) to analyze the steady state');
    expect(mcpText('use a "fit" view box (--viewbox fit) to include them')).toBe('use a "fit" view box (viewBox "fit") to include them');
    const outside = await call('rev2d_render', { path: BLANK, viewBox: [0, 0, 10, 10], scale: 1 });
    expect(texts(outside)[0]).toMatch(/note: the visible parts \[[^\]]+\] lie entirely outside the view box; use a "fit" view box \(viewBox "fit"\)/);

    const typo = await call('rev2d_analyze', { path: BLANK, animation: 'idel' });
    expect(texts(typo)[0]).toMatch(/unknown animation id: "idel"\nhint: did you mean "idle"\?/);
  });

  it('notes IK chains out of reach in renders', async () => {
    const { doc } = loadTemplate('robot-arm');
    writeModel('arm/robot-arm.r2d.json', doc);
    const far = await call('rev2d_render', { path: 'arm/robot-arm.r2d.json', params: { ReachX: 1, ReachY: 1 }, scale: 0.25 });
    expect(far.isError, texts(far)[0]).toBeFalsy();
    expect(texts(far)[0]).toMatch(/\nIK: armIk extension [\d.]+ \(out of reach: misses the target by [\d.]+ px\)/);
    expect(texts(far)[0]).toMatch(/\nnote: IK "armIk": target out of reach/);
    const near = await call('rev2d_render', { path: 'arm/robot-arm.r2d.json', scale: 0.25 });
    expect(texts(near)[0]).toMatch(/\nIK: armIk extension [\d.]+ \(reaches the target\)/);
  });

  it('hit-tests points and suggests the nearest parts on a miss', async () => {
    const hit = await call('rev2d_hit_test', { path: BLANK, x: 100, y: 92 });
    expect(jsonOf<{ hits: Array<{ partId: string }> }>(hit).hits.map((h) => h.partId)).toEqual(['eye', 'body']);
    const miss = await call('rev2d_hit_test', { path: BLANK, x: 2, y: 2 });
    expect(texts(miss)[0]).toMatch(/no part covers this point; nearest: body/);
  });
});

describe('mcp server: apply_ops', () => {
  const OPS = 'ops.r2d.json';
  const file = () => path.join(dir, OPS);
  const read = () => readFileSync(file(), 'utf8');

  it('documents every op in the tool description and the ops topic', async () => {
    const { tools } = await client.listTools();
    const desc = tools.find((t) => t.name === 'rev2d_apply_ops')!.description!;
    for (const op of ['add', 'update', 'remove', 'rename', 'set', 'bind', 'bind_warp', 'key', 'patch']) expect(desc).toContain(`- ${op} {`);
    expect(texts(await call('rev2d_docs', { topic: 'ops' }))[0]).toMatch(/bind_warp/);
  });

  it('dry-runs without touching the file', async () => {
    writeModel(OPS, blankModel({ name: 'ops', width: 200, height: 200 }));
    const before = read();
    const r = await call('rev2d_apply_ops', { path: OPS, dry_run: true, ops: [{ op: 'set', target: 'bone:root.rotation', value: 15 }] });
    expect(r.isError).toBeFalsy();
    expect(texts(r)[0]).toMatch(/1 op would apply cleanly; dry run, file unchanged/);
    expect(jsonOf(r)).toMatchObject({ ok: true, written: false, dryRun: true });
    expect(read()).toBe(before);
  });

  it('writes formatted, valid results and renders them on request', async () => {
    const r = await call('rev2d_apply_ops', {
      path: OPS,
      ops: [
        { op: 'set', target: 'bone:root.rotation', value: 15 },
        { op: 'add', kind: 'parameter', value: { id: 'Tilt', min: -1, max: 1 } },
      ],
      render_after: { overlay: ['bones'], scale: 1 },
    });
    expect(r.isError).toBeFalsy();
    expect(texts(r)[0]).toMatch(/2 ops applied and written/);
    expect(texts(r)[0]).toMatch(/ok   #1 add/);
    const after = parseModelText(read());
    expect(after.model!.bones[0].rotation).toBe(15);
    expect(after.model!.parameters.map((p) => p.id)).toContain('Tilt');
    expect(read()).toBe(formatModelJson(JSON.parse(read())));
    expect(texts(r).some((t) => /render of the result: 200x200 px/.test(t))).toBe(true);
    expect(images(r)[0].width).toBe(200);
  });

  it('is atomic: a failing op or an invalid result writes nothing', async () => {
    const before = read();
    const bad = await call('rev2d_apply_ops', {
      path: OPS,
      ops: [
        { op: 'set', target: 'bone:root.rotation', value: 30 },
        { op: 'set', target: 'bone:rot.rotation', value: 1 },
        { op: 'set', target: 'bone:root.x', value: 1 },
      ],
    });
    expect(bad.isError).toBe(true);
    const report = texts(bad)[0];
    expect(report).toMatch(/op #1 \(set\) failed; nothing was written/);
    expect(report).toMatch(/FAIL #1 set: .*rot/);
    expect(report).toMatch(/skip #2 set/);
    expect(read()).toBe(before);

    const breaking = [{ op: 'patch', patch: [{ op: 'replace', path: '/parts/0/parent', value: 'nope' }] }];
    const invalid = await call('rev2d_apply_ops', { path: OPS, ops: breaking });
    expect(invalid.isError).toBe(true);
    expect(texts(invalid)[0]).toMatch(/result has validation errors; nothing was written/);
    expect(jsonOf<{ diagnostics: Array<{ path: string }> }>(invalid).diagnostics.some((d) => d.path === '/parts/0/parent')).toBe(true);
    expect(read()).toBe(before);

    const forced = await call('rev2d_apply_ops', { path: OPS, ops: breaking, allow_invalid: true, render_after: true });
    expect(forced.isError).toBeFalsy();
    expect(texts(forced)[0]).toMatch(/applied and written WITH validation errors/);
    expect(texts(forced).some((t) => /render skipped/.test(t))).toBe(true);
    expect(JSON.parse(read()).parts[0].parent).toBe('nope');
  });

  it('reports unparseable files and unknown ops', async () => {
    writeModel('syntax2.r2d.json', '{ "format": ');
    const syntax = await call('rev2d_apply_ops', { path: 'syntax2.r2d.json', ops: [{ op: 'set', target: 'bone:root.x', value: 1 }] });
    expect(syntax.isError).toBe(true);
    expect(texts(syntax)[0]).toMatch(/not parseable JSON/);

    writeModel(OPS, blankModel({ name: 'ops', width: 200, height: 200 }));
    const unknown = await call('rev2d_apply_ops', { path: OPS, ops: [{ op: 'sett', target: 'bone:root.x', value: 1 }] });
    expect(unknown.isError).toBe(true);
    expect(texts(unknown)[0]).toMatch(/unknown op "sett"/);
  });
});

describe('mcp server: client limits and robustness', () => {
  it('keeps every tool description and the instructions within the 2048-char cap of Claude Code', async () => {
    const { tools } = await client.listTools();
    for (const t of tools) expect(t.description!.length, t.name).toBeLessThanOrEqual(2048);
    expect(client.getInstructions()!.length).toBeLessThanOrEqual(2048);
    // The op list survives intact; the examples live in the (uncapped) ops field description.
    const ops = tools.find((t) => t.name === 'rev2d_apply_ops')!;
    for (const d of describeOps()) expect(ops.description).toContain(`- ${d.op} {`);
    const patch = describeOps().find((d) => d.op === 'patch')!;
    expect(ops.description).toContain(`- patch {patch*}: ${patch.summary.split('. ')[0]}`);
    const field = (ops.inputSchema.properties as Record<string, { description?: string }>).ops.description!;
    expect(field).toContain('{"op":"bind_warp","warp":"faceWarp"');
  });

  it('turns API errors into error results with their hint (text and JSON)', () => {
    const plain = errorResult(new ApiError('padding must be >= 0, got -1', [], 'e.g. padding 16 (the default)'));
    expect(plain.isError).toBe(true);
    expect(texts(plain)[0]).toBe('Error: padding must be >= 0, got -1\nhint: e.g. padding 16 (the default)');
    const diag = { severity: 'error' as const, code: 'x', message: 'm', path: '/a' };
    const withDiags = errorResult(new ApiError('model has errors', [diag], 'fix the listed errors'));
    expect(texts(withDiags)[0]).toMatch(/^Error: model has errors\nhint: fix the listed errors/);
    expect(jsonOf(withDiags)).toMatchObject({ ok: false, hint: 'fix the listed errors', diagnostics: [diag] });
  });

  it('keeps the automatic scale positive for huge regions (never 0) and within 1024 px', () => {
    for (const side of [1e4, 2.2e6, 1e9]) {
      const s = autoScale(side, 10);
      expect(s, String(side)).toBeGreaterThan(0);
      expect(Math.round(side * s)).toBeLessThanOrEqual(1024);
      expect(Math.round(side * s)).toBeGreaterThanOrEqual(1000);
    }
    expect(autoScale(2048, 1024)).toBe(0.5);
    expect(autoScale(200, 200)).toBe(2.56);
    expect(autoScale(3000, 10)).toBe(0.341);
  });

  it('rejects oversized explicit renders and sheets before rendering', async () => {
    const big = await call('rev2d_render', { path: BLANK, scale: 16 });
    expect(big.isError).toBe(true);
    expect(texts(big)[0]).toMatch(/the image would be 3200x3200 px; the limit is 2048 px per side\nhint: lower scale.*viewBox/);
    const sheet = await call('rev2d_sheet', { path: BLANK, sweeps: ['Lean=-1:1:8', 'Squash=0:1:8'], scale: 4 });
    expect(sheet.isError).toBe(true);
    expect(texts(sheet)[0]).toMatch(/the sheet \(64 cells in 8 columns\) would be \d+x\d+ px; the limit is 4096 px per side/);
  });

  it('bounds pose time (physics steps from t=0) and names bad colors', async () => {
    const late = await call('rev2d_inspect', { path: BLANK, time: 1.7e9 });
    expect(late.isError).toBe(true);
    expect(texts(late)[0]).toMatch(/time/);
    const bg = await call('rev2d_render', { path: BLANK, background: 'blu' });
    expect(texts(bg)[0]).toMatch(/background "blu" is not a color\nhint: use "#rgb"/);
    expect((await call('rev2d_render', { path: BLANK, background: 'rgb(10, 20, 30)', scale: 0.1 })).isError).toBeFalsy();
  });

  it('checks sheet arguments precisely', async () => {
    const time = await call('rev2d_sheet', { path: BLANK, animation: 'idle', time: 1 });
    expect(texts(time)[0]).toMatch(/`time` does not apply to an animation sheet/);
    const steps = await call('rev2d_sheet', { path: BLANK, sweeps: ['Lean=-1:1:2.5'] });
    expect(texts(steps)[0]).toMatch(/bad sweep "Lean=-1:1:2\.5": steps must be a whole number/);
    const typo = await call('rev2d_sheet', { path: BLANK, sweeps: ['Laen=-1:1:3'] });
    expect(texts(typo)[0]).toMatch(/unknown parameter id: "Laen"\nhint: did you mean "Lean"\?/);
    const anim = await call('rev2d_sheet', { path: BLANK, animation: 'idel' });
    expect(texts(anim)[0]).toMatch(/did you mean "idle"/);
  });

  it('explains directory paths and accepts Git Bash drive paths on Windows', async () => {
    writeModel('sub/inner.r2d.json', blankModel({ name: 'inner' }));
    const r = await call('rev2d_validate', { path: 'sub' });
    expect(r.isError).toBe(true);
    expect(texts(r)[0]).toMatch(/sub is a directory, not a model file\nhint: \.r2d\.json files in sub: sub\/inner\.r2d\.json/);

    expect(nativePath('/c/Users/me/a.r2d.json', 'win32')).toBe('C:/Users/me/a.r2d.json');
    expect(nativePath('/d', 'win32')).toBe('D:/');
    expect(nativePath('/cd/a.r2d.json', 'win32')).toBe('/cd/a.r2d.json');
    expect(nativePath('/c/Users/me/a.r2d.json', 'linux')).toBe('/c/Users/me/a.r2d.json');
    if (process.platform === 'win32') {
      const msys = `/${dir[0].toLowerCase()}${dir.slice(2).split(path.sep).join('/')}/${BLANK}`;
      expect((await call('rev2d_validate', { path: msys })).isError).toBeFalsy();
    }
  });

  it('serves AGENTS.md for the agents docs topic, and the recipes and architecture docs', async () => {
    const agents = await call('rev2d_docs', { topic: 'agents' });
    expect(agents.isError).toBeFalsy();
    expect(texts(agents)[0]).toBe(readFileSync(path.join(PACKAGE_ROOT, 'AGENTS.md'), 'utf8'));
    expect(texts(agents)[0]).not.toMatch(/No AGENTS\.md in this installation/);

    // The tool description lists every numbered recipe of the installed RECIPES.md.
    const { tools } = await client.listTools();
    const docsTool = tools.find((t) => t.name === 'rev2d_docs')!;
    const titles = recipeTitles(readFileSync(path.join(PACKAGE_ROOT, 'docs', 'RECIPES.md'), 'utf8'));
    expect(titles.length).toBeGreaterThan(20);
    expect(docsTool.description).toContain(`(${titles.length} recipes: ${titles.join(', ')})`);
    expect(recipesTopicText(mkdtempSync(path.join(os.tmpdir(), 'rev2d-mcp-norecipes-')))).toBe('recipes = copy-paste op batches with the commands that verify them');

    const recipes = await call('rev2d_docs', { topic: 'recipes' });
    expect(recipes.isError).toBeFalsy();
    expect(texts(recipes)[0]).toBe(readFileSync(path.join(PACKAGE_ROOT, 'docs', 'RECIPES.md'), 'utf8'));
    const arch = await call('rev2d_docs', { topic: 'architecture' });
    expect(texts(arch)[0]).toBe(readFileSync(path.join(PACKAGE_ROOT, 'docs', 'ARCHITECTURE.md'), 'utf8'));
    const avatar = await call('rev2d_docs', { topic: 'avatar' });
    expect(texts(avatar)[0]).toBe(readFileSync(path.join(PACKAGE_ROOT, 'docs', 'AVATAR.md'), 'utf8'));
    expect(docsTool.description).toContain('avatar = ');
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toEqual(expect.arrayContaining(['rev2d://docs/recipes', 'rev2d://docs/avatar']));
  });

  it('falls back to the quickstart (agents) and the built-in op catalogue (ops) in an installation without those files', async () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), 'rev2d-mcp-nodocs-'));
    try {
      const agents = await readDoc('agents', empty);
      expect(agents).toMatch(/^\(No AGENTS\.md in this installation; this is the rev2d_guide quickstart for AI agents\.\)/);
      expect(agents).toContain(GUIDE);
      expect(await readDoc('ops', empty)).toMatch(/^# Rev2D edit ops \(rev2d_apply_ops\)[\s\S]*## bind_warp/);
      await expect(readDoc('recipes', empty)).rejects.toThrow(/the "recipes" documentation \(docs\/RECIPES\.md\) is not present/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('mcp server: apply_ops file handling', () => {
  const FILE = 'io.r2d.json';
  const abs = () => path.join(dir, FILE);

  it('keeps CRLF line endings and does not rewrite an unchanged model', async () => {
    writeModel(FILE, formatModelJson(blankModel({ name: 'io', width: 200, height: 200 })).replace(/\n/g, '\r\n'));
    const r = await call('rev2d_apply_ops', { path: FILE, ops: [{ op: 'set', target: 'bone:root.rotation', value: 5 }] });
    expect(jsonOf(r)).toMatchObject({ ok: true, written: true, changed: true });
    const written = readFileSync(abs(), 'utf8');
    expect(written).toContain('\r\n');
    expect(written.replace(/\r\n/g, '')).not.toContain('\n');

    const before = statSync(abs()).mtimeMs;
    const same = await call('rev2d_apply_ops', { path: FILE, ops: [{ op: 'set', target: 'bone:root.rotation', value: 5 }] });
    expect(same.isError).toBeFalsy();
    expect(texts(same)[0]).toMatch(/model is unchanged; file not rewritten/);
    expect(jsonOf(same)).toMatchObject({ ok: true, written: false, changed: false });
    expect(statSync(abs()).mtimeMs).toBe(before);
  });

  it('serializes parallel edits of one file so none is lost', async () => {
    writeModel(FILE, blankModel({ name: 'io', width: 200, height: 200 }));
    const ids = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5'];
    const results = await Promise.all(ids.map((id) => call('rev2d_apply_ops', { path: FILE, ops: [{ op: 'add', kind: 'parameter', value: { id, min: 0, max: 1 } }] })));
    expect(results.every((r) => !r.isError)).toBe(true);
    expect(parseModelText(readFileSync(abs(), 'utf8')).model!.parameters.map((p) => p.id)).toEqual(expect.arrayContaining(ids));
  });

  it('reports a failing render_after without hiding that the edit was written', async () => {
    writeModel(FILE, blankModel({ name: 'io', width: 200, height: 200 }));
    const r = await call('rev2d_apply_ops', { path: FILE, ops: [{ op: 'set', target: 'bone:root.x', value: 90 }], render_after: { params: { Laen: 1 } } });
    expect(r.isError).toBeFalsy();
    expect(jsonOf(r)).toMatchObject({ ok: true, written: true });
    expect(texts(r).join('\n')).toMatch(/render_after failed: unknown parameter id: "Laen"\nhint: did you mean "Lean"\?\n\(the ops were applied and written/);
    expect(images(r)).toHaveLength(0);
    expect(parseModelText(readFileSync(abs(), 'utf8')).model!.bones[0].x).toBe(90);
  });
});

describe('mcp server: files', () => {
  it('creates models from templates and refuses to overwrite', async () => {
    const r = await call('rev2d_create_model', { path: 'new/hero.r2d.json', width: 300, height: 400 });
    expect(r.isError).toBeFalsy();
    expect(texts(r)[0]).toMatch(/created new\/hero\.r2d\.json from template "blank"/);
    const doc = parseModelText(readFileSync(path.join(dir, 'new/hero.r2d.json'), 'utf8'));
    expect(doc.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(doc.model!.meta).toMatchObject({ name: 'hero', width: 300, height: 400 });

    const again = await call('rev2d_create_model', { path: 'new/hero.r2d.json' });
    expect(again.isError).toBe(true);
    expect(texts(again)[0]).toMatch(/already exists[\s\S]*overwrite: true/);
    expect((await call('rev2d_create_model', { path: 'new/hero.r2d.json', overwrite: true })).isError).toBeFalsy();

    const unknown = await call('rev2d_create_model', { path: 'x.r2d.json', template: 'blnk' });
    expect(unknown.isError).toBe(true);
    expect(texts(unknown)[0]).toMatch(/did you mean "blank"/);

    const intoDir = await call('rev2d_create_model', { path: 'new', overwrite: true });
    expect(texts(intoDir)[0]).toMatch(/new is a directory\nhint: give the new model's file path, e\.g\. "new\/model\.r2d\.json"/);
    // A name starting with ".." is still inside the working directory (shown relative); other extensions get a note.
    const odd = await call('rev2d_create_model', { path: '..odd.json' });
    expect(texts(odd)[0]).toMatch(/^created \.\.odd\.json from template "blank"\nnote: model files are conventionally named \*\.r2d\.json/);
  });

  it('creates the "empty" template at the requested size and points at the ops', async () => {
    const r = await call('rev2d_create_model', { path: 'new/scratch.r2d.json', template: 'empty', width: 300, height: 200 });
    expect(r.isError, texts(r)[0]).toBeFalsy();
    const t = texts(r)[0];
    expect(t).toMatch(/^created new\/scratch\.r2d\.json from template "empty"\n\nscratch {2}300x200/);
    expect(t).not.toContain('width/height apply only');
    expect(t).toContain('next: add parameters, bones and parts with rev2d_apply_ops {path: "new/scratch.r2d.json", ops: [...]}');
    expect(parseModelText(readFileSync(path.join(dir, 'new/scratch.r2d.json'), 'utf8')).model!.meta).toMatchObject({ width: 300, height: 200 });
    const example = listTemplates().find((x) => x !== 'blank' && x !== 'empty')!;
    const sized = await call('rev2d_create_model', { path: 'new/ex.r2d.json', template: example, width: 300 });
    expect(texts(sized)[0]).toContain('note: width/height apply only to the "blank" and "empty" templates; the example keeps its canvas size');
    const catalogue = texts(await call('rev2d_docs', { topic: 'examples' }))[0];
    expect(catalogue).toContain('## empty  (generated, 512x512)');
  });

  const textured = listTemplates().find((t) => loadTemplate(t).textureFiles.length > 0);
  it.skipIf(!textured)('copies template textures, shares identical copies and protects different files', async () => {
    const first = await call('rev2d_create_model', { path: 'tex/a.r2d.json', template: textured });
    expect(texts(first)[0]).toMatch(/copied textures: tex\//);
    expect((await call('rev2d_render', { path: 'tex/a.r2d.json', scale: 0.25 })).isError).toBeFalsy();

    const second = await call('rev2d_create_model', { path: 'tex/b.r2d.json', template: textured });
    expect(second.isError).toBeFalsy();
    expect(texts(second)[0]).toMatch(/reused identical textures: tex\//);

    const [tex] = jsonOf<{ textures: string[] }>(second).textures;
    writeFileSync(tex, encodePNG(createImage(2, 2, '#ff0000')));
    const third = await call('rev2d_create_model', { path: 'tex/c.r2d.json', template: textured });
    expect(third.isError).toBe(true);
    expect(texts(third)[0]).toMatch(/different texture files already exist: tex\/.*\nhint: pass overwrite: true/);
    expect(existsSync(path.join(dir, 'tex/c.r2d.json'))).toBe(false);
  });

  it('diffs PNGs', async () => {
    await call('rev2d_render', { path: BLANK, scale: 1, save_to: 'out/a.png' });
    await call('rev2d_render', { path: BLANK, scale: 1, save_to: 'out/a2.png' });
    await call('rev2d_render', { path: BLANK, scale: 1, params: { Lean: 1 }, save_to: 'out/b.png' });
    const same = await call('rev2d_diff_images', { a: 'out/a.png', b: 'out/a2.png' });
    expect(texts(same)[0]).toMatch(/identical/);
    expect(images(same)).toHaveLength(0);

    const diff = await call('rev2d_diff_images', { a: 'out/a.png', b: 'out/b.png', save_to: 'out/diff.png' });
    expect(jsonOf<{ differentPixels: number }>(diff).differentPixels).toBeGreaterThan(100);
    expect(images(diff)[0].width).toBe(200);
    expect(existsSync(path.join(dir, 'out/diff.png'))).toBe(true);

    const mismatch = await call('rev2d_diff_images', { a: 'out/a.png', b: 'out/lean.png' });
    expect(mismatch.isError).toBe(true);
    expect(texts(mismatch)[0]).toMatch(/size mismatch/);
    const missing = await call('rev2d_diff_images', { a: 'out/a.png', b: 'out/zzz.png' });
    expect(texts(missing)[0]).toMatch(/image not found: out\/zzz\.png/);
  });
});
