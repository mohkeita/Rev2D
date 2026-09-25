/**
 * docs/RECIPES.md is executable documentation. Every ops batch marked `<!-- check:ops name=X -->`
 * is applied with applyOps to the starter model (`<!-- check:starter -->`, or the empty template for
 * `base=empty:WxH`) plus the batches it builds on, and must apply with 0 errors and 0 warnings.
 * Every command block marked `<!-- check:run chain=a,b -->` is then run in-process through the CLI
 * against that model and must exit 0. The numbers the recipes quote as evidence are asserted too, so
 * the page cannot drift from what the tools report.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/cli/main.js';
import { applyOps, type Op } from '../src/ops/index.js';
import { emptyModel, PACKAGE_ROOT } from '../src/api/templates.js';
import { formatModelJson } from '../src/core/format.js';

const RECIPES_PATH = path.join(PACKAGE_ROOT, 'docs', 'RECIPES.md');
const TEXTURE = path.join(PACKAGE_ROOT, 'examples', 'textured', 'koi-atlas.png');
const DEFAULT_MODEL = 'hero.r2d.json';

interface CheckBlock {
  kind: string;
  attrs: Record<string, string>;
  lang: string;
  body: string;
  /** 1-based line of the marker, for messages. */
  line: number;
}

/** Every `<!-- check:kind attrs -->` marker with the fenced code block right after it. */
export function parseCheckBlocks(md: string): CheckBlock[] {
  const re = /<!-- check:(\w+)([^>]*?)-->[ \t]*\r?\n```(\w+)\r?\n([\s\S]*?)\r?\n```/g;
  return [...md.matchAll(re)].map((m) => ({
    kind: m[1],
    attrs: Object.fromEntries([...m[2].matchAll(/(\w+)=(\S*)/g)].map((a) => [a[1], a[2]])),
    lang: m[3],
    body: m[4],
    line: md.slice(0, m.index).split('\n').length,
  }));
}

/** The command lines of a run block, split into argv (recipes use no quoting). */
function commandLines(body: string): Array<{ text: string; argv: string[] }> {
  return body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((text) => ({ text, argv: text.replace(/\s+#.*$/, '').split(/\s+/) }));
}

const md = readFileSync(RECIPES_PATH, 'utf8');
const blocks = parseCheckBlocks(md);
const starterBlock = blocks.find((b) => b.kind === 'starter');
const opsBlocks = new Map(blocks.filter((b) => b.kind === 'ops').map((b) => [b.attrs.name, b]));
const runBlocks = blocks.filter((b) => b.kind === 'run');
const chainOf = (b: CheckBlock) => (b.attrs.chain ?? '').split(',').filter(Boolean);

/** Model file name used by a run block's commands (the walk cycle uses walker.r2d.json). */
function modelFileOf(run: CheckBlock): string {
  for (const { argv } of commandLines(run.body)) {
    const f = argv.find((a) => a.endsWith('.r2d.json'));
    if (f) return f;
  }
  return DEFAULT_MODEL;
}

/** Documents after each chain prefix, so shared prefixes (head-turn, ...) are applied once. */
const chainCache = new Map<string, unknown>();

function baseDoc(chain: string[], fileName: string): unknown {
  const first = chain.length ? opsBlocks.get(chain[0]) : undefined;
  const base = first?.attrs.base;
  if (base) {
    const m = /^empty:(\d+)x(\d+)$/.exec(base);
    if (!m) throw new Error(`ops block "${chain[0]}": base must be empty:WxH, got "${base}"`);
    return emptyModel({ name: fileName.replace(/\.r2d\.json$/, ''), width: Number(m[1]), height: Number(m[2]) });
  }
  return JSON.parse(starterBlock!.body);
}

function buildChain(chain: string[], fileName: string): unknown {
  let doc = baseDoc(chain, fileName);
  for (let i = 0; i < chain.length; i++) {
    const key = `${fileName}|${chain.slice(0, i + 1).join(',')}`;
    const cached = chainCache.get(key);
    if (cached !== undefined) {
      doc = cached;
      continue;
    }
    const block = opsBlocks.get(chain[i]);
    if (!block) throw new Error(`unknown ops block "${chain[i]}" in chain ${chain.join(',')}`);
    const r = applyOps(doc, JSON.parse(block.body) as Op[]);
    const failed = r.results.filter((x) => !x.ok).map((x) => `#${x.index} ${x.op}: ${x.message}${x.hint ? ` (hint: ${x.hint})` : ''}`);
    const problems = r.diagnostics.filter((d) => d.severity !== 'info').map((d) => `${d.severity} ${d.path} ${d.code}: ${d.message}`);
    expect(failed, `ops block "${chain[i]}" (RECIPES.md line ${block.line}) in chain ${chain.join(',')}`).toEqual([]);
    expect(problems, `validation after ops block "${chain[i]}" in chain ${chain.join(',')}`).toEqual([]);
    expect(r.ok).toBe(true);
    doc = r.doc;
    chainCache.set(key, doc);
  }
  return doc;
}

/** The op messages of ops block `name` applied on top of `chain` (e.g. to check a quoted message). */
function opMessages(chain: string[], name: string, edit: (ops: Op[]) => Op[] = (ops) => ops): string[] {
  const block = opsBlocks.get(name)!;
  const r = applyOps(buildChain(chain, DEFAULT_MODEL), edit(JSON.parse(block.body) as Op[]));
  expect(r.ok).toBe(true);
  return r.results.map((x) => x.message ?? '');
}

let root = '';
let dirCount = 0;

/** A fresh directory holding the chain's model (and the koi atlas that recipe 11 references). */
function workspace(chain: string[], fileName = DEFAULT_MODEL): string {
  const dir = path.join(root, `r${dirCount++}-${chain.join('+') || 'starter'}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, fileName), formatModelJson(buildChain(chain, fileName)));
  copyFileSync(TEXTURE, path.join(dir, 'koi-atlas.png'));
  return dir;
}

async function rev2d(argv: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const buf = { stdout: '', stderr: '' };
  const code = await main(argv, {
    cwd,
    stdout: { write: (s: string) => ((buf.stdout += s), true) },
    stderr: { write: (s: string) => ((buf.stderr += s), true) },
    openUrl: () => {
      throw new Error('recipes must not open a browser');
    },
  });
  return { code, ...buf };
}

/** Run a command and parse its --json output (the command must succeed). */
async function json(cwd: string, command: string): Promise<any> {
  const r = await rev2d([...command.split(/\s+/), '--json'], cwd);
  expect(r.code, `${command}\n${r.stderr}`).toBe(0);
  return JSON.parse(r.stdout);
}

beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'rev2d-recipes-'));
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('docs/RECIPES.md check markers', () => {
  it('has a starter model and well-formed ops and run blocks', () => {
    expect(starterBlock, 'no <!-- check:starter --> block').toBeDefined();
    expect(() => JSON.parse(starterBlock!.body)).not.toThrow();
    // Every marker must be followed by a code block (a typo would silently skip a recipe).
    expect(blocks.length).toBe((md.match(/<!-- check:/g) ?? []).length);
    for (const b of blocks) {
      expect(['starter', 'ops', 'run'], `unknown marker kind at line ${b.line}`).toContain(b.kind);
      if (b.kind === 'ops') {
        expect(b.lang, `ops block at line ${b.line}`).toBe('json');
        expect(b.attrs.name, `ops block at line ${b.line} has no name`).toBeTruthy();
        expect(Array.isArray(JSON.parse(b.body)), `ops block "${b.attrs.name}" must be a JSON array`).toBe(true);
      }
      if (b.kind === 'run') {
        expect(b.lang, `run block at line ${b.line}`).toBe('sh');
        for (const { text } of commandLines(b.body)) expect(text, `line ${b.line}`).toMatch(/^rev2d \w/);
      }
    }
    const names = blocks.filter((b) => b.kind === 'ops').map((b) => b.attrs.name);
    expect(new Set(names).size, 'ops block names must be unique').toBe(names.length);
  });

  it('exercises every ops block in some run block, with known names and bases only at a chain start', () => {
    const used = new Set(runBlocks.flatMap(chainOf));
    for (const name of opsBlocks.keys()) expect(used.has(name), `ops block "${name}" is never run`).toBe(true);
    for (const run of runBlocks) {
      const chain = chainOf(run);
      chain.forEach((name, i) => {
        expect(opsBlocks.has(name), `run block at line ${run.line}: unknown ops block "${name}"`).toBe(true);
        if (i > 0) expect(opsBlocks.get(name)!.attrs.base, `"${name}" has a base but is not first in its chain`).toBeUndefined();
      });
    }
  });

  it('lists every recipe section in the table of contents', () => {
    const sections = [...md.matchAll(/^## (\d+)\. /gm)].map((m) => m[1]);
    const rows = [...md.matchAll(/^\| (\d+) \| \[/gm)].map((m) => m[1]);
    expect(rows).toEqual(sections);
  });
});

describe('docs/RECIPES.md recipes apply and their commands succeed', () => {
  for (const run of runBlocks) {
    const chain = chainOf(run);
    it(`${chain.join(' + ') || 'starter'} (line ${run.line})`, async () => {
      const fileName = modelFileOf(run);
      const dir = workspace(chain, fileName);
      for (const { text, argv } of commandLines(run.body)) {
        const r = await rev2d(argv.slice(1), dir);
        expect(r.code, `${text}\n${r.stderr}`).toBe(0);
      }
    });
  }
});

describe('docs/RECIPES.md evidence is what the tools report', () => {
  it('recipe 1: AngleY = 30 looks up, AngleX = 30 moves the features right and narrows the far eye', async () => {
    const dir = workspace(['head-turn']);
    const up = await json(dir, 'inspect hero.r2d.json --param AngleY=30 --part mouth');
    const rest = await json(dir, 'inspect hero.r2d.json --part mouth');
    expect(up.parts[0].center[1]).toBeCloseTo(252.2, 0);
    expect(rest.parts[0].center[1]).toBeCloseTo(283.9, 0);
    const turned = await json(dir, 'inspect hero.r2d.json --param AngleX=30 --part eyeWhiteL,eyeWhiteR,mouth');
    const byId = Object.fromEntries(turned.parts.map((p: any) => [p.id, p]));
    expect(byId.mouth.center[0]).toBeCloseTo(298.6, 0);
    expect(byId.eyeWhiteL.bounds[2]).toBeLessThan(byId.eyeWhiteR.bounds[2]);
  });

  it('recipe 14: the closed eye white is a sliver inside the lash band, covered by the lash', async () => {
    const dir = workspace(['head-turn', 'eyes']);
    const r = await json(dir, 'inspect hero.r2d.json --param EyeLOpen=0 --part eyeWhiteL,lashL');
    const byId = Object.fromEntries(r.parts.map((p: any) => [p.id, p]));
    const [wx, wy, ww, wh] = byId.eyeWhiteL.bounds;
    const [lx, ly, lw, lh] = byId.lashL.bounds;
    expect(wh).toBeGreaterThan(0);
    expect(wx).toBeGreaterThanOrEqual(lx);
    expect(wy).toBeGreaterThanOrEqual(ly);
    expect(wx + ww).toBeLessThanOrEqual(lx + lw);
    expect(wy + wh).toBeLessThanOrEqual(ly + lh);
    const hit = await json(dir, 'hit hero.r2d.json 290 228.4 --param EyeLOpen=0');
    expect(hit.hits[0].partId).toBe('lashL');
    expect(hit.hits.map((h: any) => h.partId)).toContain('eyeWhiteL');
  });

  it('recipe 15: add keeps the idle motion, once hands the eye back, compose equals the layer stack', async () => {
    const dir = workspace(['head-turn', 'mouth', 'eyes', 'gestures']);
    const col = (t: any, name: string) => t.rows.map((row: unknown[]) => row[t.columns.indexOf(name)]);
    const over = await json(dir, 'inspect hero.r2d.json --anim look_around --anim talk --times 0.5,1 --track param:AngleY');
    const add = await json(dir, 'inspect hero.r2d.json --anim look_around --anim talk,add --times 0.5,1 --track param:AngleY');
    expect(col(over, 'param:AngleY')).toEqual([0, 0]);
    expect(col(add, 'param:AngleY')[0]).toBeCloseTo(7.4, 1);
    expect(col(add, 'param:AngleY')[1]).toBeCloseTo(12, 5);
    const hold = await json(dir, 'inspect hero.r2d.json --anim look_around --anim blink --anim wink,start=1.5 --times 3.82 --track param:EyeLOpen,param:EyeROpen');
    const once = await json(dir, 'inspect hero.r2d.json --anim look_around --anim blink --anim wink,once,start=1.5 --times 3.82 --track param:EyeLOpen,param:EyeROpen');
    expect(hold.rows[0]).toEqual([1, 0]);
    expect(once.rows[0]).toEqual([0, 0]);
    const cols = 'param:AngleY,param:EyeLOpen,param:MouthOpen';
    const layered = await json(dir, `inspect hero.r2d.json --anim look_around --anim blink --anim talk,add --anim wink,once,start=1.5 --times 0:4:9 --track ${cols}`);
    const baked = await json(dir, `inspect hero.r2d.json --anim chatter --times 0:4:9 --track ${cols}`);
    baked.rows.forEach((row: number[], i: number) => row.forEach((v, j) => expect(v, `t=${baked.times[i]} ${baked.columns[j]}`).toBeCloseTo(layered.rows[i][j], 2)));
    // The quoted compose messages: 100 fps as written, and the warning that suggests it at 60 fps.
    const chain = ['head-turn', 'mouth', 'eyes'];
    const at100 = opMessages(chain, 'gestures').at(-1)!;
    expect(at100).toContain('param:AngleY: look_around + talk → 401 keys');
    expect(at100).not.toMatch(/WARNING/);
    const at60 = opMessages(chain, 'gestures', (ops) => ops.map((op) => (op.op === 'compose' ? { ...op, fps: undefined } : op)) as Op[]).at(-1)!;
    expect(at60).toContain(
      'WARNING: 2 source times of the baked tracks fall between the 60 fps bake samples, so the baked keys can miss the values there: 1.62 s ("wink" key), 3.82 s ("blink" key); "fps": 100 puts a sample on each',
    );
  });

  it('recipe 16: follow keeps the brim center on the head lattice, the sides within 1 px', async () => {
    expect(opMessages(['head-turn'], 'hat').at(-1)).toMatch(/max residual 0\.0001 px at the 9 keyforms, 0\.0001 px at 16 grid midpoints/);
    const dir = workspace(['head-turn', 'hat']);
    const quoted = await json(dir, 'inspect hero.r2d.json --param AngleX=30,AngleY=30 --point 256,121@headWarp --point 256,121@hatWarp --point 190,124@headWarp --point 190,124@hatWarp');
    const expected = [[275.43, 114.96], [275.43, 114.96], [205.01, 117.45], [204.15, 117.96]];
    quoted.points.forEach((p: any, i: number) => p.posed.forEach((v: number, k: number) => expect(v, p.spec).toBeCloseTo(expected[i][k], 2)));
    for (const pose of ['AngleX=-30', 'AngleX=30', 'AngleY=30', 'AngleY=-30', 'AngleX=30,AngleY=30', 'AngleX=-30,AngleY=-30']) {
      const r = await json(dir, `inspect hero.r2d.json --param ${pose} --point 256,121@headWarp --point 256,121@hatWarp --point 190,124@headWarp --point 190,124@hatWarp --point 322,124@headWarp --point 322,124@hatWarp`);
      for (let i = 0; i < r.points.length; i += 2) {
        const [a, b] = [r.points[i].posed, r.points[i + 1].posed];
        // The anchor (256, 121) is exact; the rigid brim's sides stay within 1 px.
        expect(Math.hypot(a[0] - b[0], a[1] - b[1]), `${pose} ${r.points[i].spec}`).toBeLessThan(i === 0 ? 0.001 : 1);
      }
    }
  });

  it('recipe 17: the outline part draws above the clipped markings', async () => {
    const dir = workspace(['markings']);
    const hit = await json(dir, 'hit hero.r2d.json 168.5 246');
    expect(hit.hits.slice(0, 2)).toEqual([
      { partId: 'faceLine', kind: 'stroke' },
      { partId: 'cheekMarks', kind: 'fill' },
    ]);
  });

  it('recipe 18: bind_linear and relative bindings give the documented values', async () => {
    const dir = workspace(['param-rig']);
    const r = await json(dir, 'inspect hero.r2d.json --param BodyX=40,AngleZ=30,Shrug=1 --bone root,head --part torso');
    expect(r.properties['bone:root.x']).toBe(296);
    expect(r.properties['bone:head.rotation']).toBe(15);
    expect(r.properties['bone:head.y']).toBe(-130);
    expect(r.properties['part:torso.shape.w']).toBe(166);
  });

  it('recipe 19: the walk closes its loop, plants the foot and never needs a fix', async () => {
    const dir = workspace(['walk'], 'walker.r2d.json');
    const a = await json(dir, 'analyze walker.r2d.json --anim walk --no-pixels');
    expect(a.notes).toEqual([]);
    expect(a.seam.ok).toBe(true);
    for (const ik of a.ik) {
      expect(ik.maxExtension).toBeLessThan(1);
      expect(ik.maxExtension).toBeGreaterThan(0.98);
      expect(ik.maxError).toBe(0);
      expect(ik.maxStretch).toBeLessThanOrEqual(1.021);
    }
    expect(a.events.map((e: any) => [e.name, e.t])).toEqual([['footstep', 0], ['footstep', 0.5]]);
    const t = await json(dir, 'inspect walker.r2d.json --anim walk --times 0:0.5:6 --track bone:shinL.tip,bone:shinL.rotation');
    for (const [tip, rotation] of t.rows) {
      expect(tip[1]).toBeCloseTo(275, 5);
      expect(rotation).toBeGreaterThan(27);
    }
  });

  it('recipe 20: analyze finds the clamping, the scale fix removes it, warm-up closes the loop', async () => {
    const plain = workspace(['hair-physics']);
    const cold = await json(plain, 'analyze hero.r2d.json --anim sway --no-pixels');
    const warm = await json(plain, 'analyze hero.r2d.json --anim sway --warmup 10 --no-pixels');
    expect(cold.physics[0].clampedFrames).toBeGreaterThan(0);
    expect(cold.seam.ok).toBe(false);
    expect(warm.physics[0].clampedFrames).toBe(0);
    expect(warm.seam.ok).toBe(true);
    const lively = await json(workspace(['hair-physics', 'hair-lively']), 'analyze hero.r2d.json --anim sway --warmup 10 --no-pixels');
    expect(lively.physics[0].clampedShare).toBeCloseTo(0.3, 2);
    expect(lively.physics[0].rawMax).toBeCloseTo(33.552, 2);
    const tuned = await json(workspace(['hair-physics', 'hair-lively', 'hair-tune']), 'analyze hero.r2d.json --anim sway --warmup 10 --no-pixels');
    expect(tuned.physics[0].clampedFrames).toBe(0);
    expect(tuned.physics[0].rawMax).toBeCloseTo(28.519, 2);
    expect(tuned.seam.ok).toBe(true);
  });

  it('recipe 21: recolor produces the documented colours', async () => {
    const dir = workspace(['recolor']);
    const doc = JSON.parse(readFileSync(path.join(dir, 'hero.r2d.json'), 'utf8'));
    const part = (id: string) => doc.parts.find((p: any) => p.id === id);
    expect(part('hairBack').fill).toBe('#6c4b31');
    expect(part('face').fill).toBe('#c68e63');
    expect(part('face').stroke.color).toBe('#5c3a24');
  });
});
