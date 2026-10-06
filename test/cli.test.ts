import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { main, report } from '../src/cli/main.js';
import { Args, parseArgs, UsageError, type FlagSpec } from '../src/cli/args.js';
import { COMMANDS } from '../src/cli/commands/index.js';
import { commandFlags } from '../src/cli/help.js';
import { draftAvatarSpec } from '../src/avatar/index.js';
import { blankModel, listTemplates, PACKAGE_ROOT } from '../src/api/templates.js';
import { formatModelJson } from '../src/core/format.js';
import { decodePNG, encodePNG, createImage } from '../src/render/index.js';
import { loadModelFile } from '../src/node/load.js';
import { listEditors } from '../src/node/editor-registry.js';
import { ApiError, recipesDescription, renderFrame } from '../src/api/index.js';
import { DOC_TOPICS } from '../src/cli/commands/reference.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'rev2d-cli-'));
let n = 0;

/** Fresh directory with a small valid model (model.r2d.json, 128x128). */
function workspace(doc: Record<string, unknown> = blankModel({ name: 'fixture', width: 128, height: 128 })): string {
  const dir = path.join(root, `ws${n++}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'model.r2d.json'), formatModelJson(doc));
  return dir;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  json(): any;
}

interface RunOptions {
  cwd?: string;
  stdin?: string;
  signal?: AbortSignal;
}

function capture() {
  const buf = { stdout: '', stderr: '' };
  return {
    buf,
    io: {
      stdout: { write: (s: string) => ((buf.stdout += s), true) },
      stderr: { write: (s: string) => ((buf.stderr += s), true) },
    },
  };
}

async function run(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const { buf, io } = capture();
  const code = await main(args, {
    ...io,
    cwd: opts.cwd ?? root,
    stdin: opts.stdin !== undefined ? Readable.from([opts.stdin]) : undefined,
    signal: opts.signal,
    openUrl: () => {
      throw new Error('tests must not open a browser');
    },
  });
  return { code, stdout: buf.stdout, stderr: buf.stderr, json: () => JSON.parse(buf.stdout) };
}

/** Start a long-running command; stop() aborts it and resolves to its exit code. */
function start(args: string[], cwd: string) {
  const { buf, io } = capture();
  const controller = new AbortController();
  const done = main(args, { ...io, cwd, signal: controller.signal });
  return {
    buf,
    done,
    async stop() {
      controller.abort();
      return done;
    },
  };
}

async function until(cond: () => boolean, what: string, ms = 15000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function readModel(dir: string, file = 'model.r2d.json'): any {
  return JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
}

afterAll(() => rmSync(root, { recursive: true, force: true }));

// ----------------------------------------------------------------------------- argument parser

describe('parseArgs', () => {
  const specs: FlagSpec[] = [
    { name: 'out', short: 'o', type: 'string', description: '' },
    { name: 'scale', type: 'number', greaterThan: 0, description: '' },
    { name: 'time', type: 'number', description: '' },
    { name: 'frames', type: 'int', min: 1, description: '' },
    { name: 'physics', type: 'boolean', description: '' },
    { name: 'param', type: 'string', repeat: true, description: '' },
    { name: 'play', type: 'string', optionalValue: true, description: '' },
  ];

  it('supports every value form, repeats, negation and --', () => {
    const p = parseArgs(['m.json', '--out=a.png', '--scale', '2', '--param', 'A=1', '--param=B=2', '--no-physics', '--', '--x'], specs);
    expect(p.positionals).toEqual(['m.json', '--x']);
    expect(p.flags).toEqual({ out: 'a.png', scale: 2, param: ['A=1', 'B=2'], physics: false });
    expect(parseArgs(['-o', 'x.png'], specs).flags.out).toBe('x.png');
    expect(parseArgs(['-ox.png'], specs).flags.out).toBe('x.png');
    expect(parseArgs(['-o=x.png'], specs).flags.out).toBe('x.png');
    expect(parseArgs(['--physics=false'], specs).flags.physics).toBe(false);
  });

  it('treats "-" and negative numbers as positionals and accepts negative values', () => {
    const p = parseArgs(['-', '-12', '-.5', '--time', '-1.5'], specs);
    expect(p.positionals).toEqual(['-', '-12', '-.5']);
    expect(p.flags.time).toBe(-1.5);
    expect(() => parseArgs(['--scale', '-1'], specs)).toThrow(/must be > 0/);
  });

  it('handles optional values', () => {
    expect(parseArgs(['--play'], specs).flags.play).toBe('');
    expect(parseArgs(['--play', 'idle'], specs).flags.play).toBe('idle');
    expect(parseArgs(['--play', '--no-physics'], specs).flags).toEqual({ play: '', physics: false });
  });

  it('reports precise usage errors', () => {
    const err = (argv: string[]) => {
      try {
        parseArgs(argv, specs);
      } catch (e) {
        expect(e).toBeInstanceOf(UsageError);
        return e as UsageError;
      }
      throw new Error('expected a UsageError');
    };
    expect(err(['--scal', '2']).hint).toBe('did you mean "--scale"?');
    expect(err(['--scale']).message).toMatch(/--scale needs a value/);
    expect(err(['--scale', '--out', 'x']).message).toMatch(/needs a value/);
    expect(err(['--scale', 'abc']).message).toMatch(/expects a number, got "abc"/);
    expect(err(['--frames', '1.5']).message).toMatch(/whole number/);
    expect(err(['--frames', '0']).message).toMatch(/>= 1/);
    expect(err(['--out', 'a', '--out', 'b']).message).toMatch(/more than once/);
    expect(err(['--physics=maybe']).message).toMatch(/switch/);
    expect(err(['-z']).message).toMatch(/unknown flag "-z"/);
  });

  it('Args accessors flatten comma lists', () => {
    const a = new Args(parseArgs(['--param', 'A=1,B=2', '--param', 'C=3'], specs));
    expect(a.list('param')).toEqual(['A=1,B=2', 'C=3']);
    expect(a.csv('param')).toEqual(['A=1', 'B=2', 'C=3']);
    expect(a.has('out')).toBe(false);
  });

  it('every command has unique flag names', () => {
    for (const c of COMMANDS) {
      const names = commandFlags(c).map((f) => f.name);
      expect(new Set(names).size, c.name).toBe(names.length);
    }
  });
});

// ----------------------------------------------------------------------------- dispatcher & help

describe('help and dispatch', () => {
  it('prints general help with no arguments and for help/--help', async () => {
    for (const argv of [[], ['help'], ['--help'], ['-h']]) {
      const r = await run(argv);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('usage: rev2d <command>');
      for (const c of COMMANDS) expect(r.stdout).toContain(c.name.split(' ')[0]);
    }
  });

  it('prints per-command help with flags and examples', async () => {
    const a = await run(['help', 'render']);
    const b = await run(['render', '--help']);
    expect(a.code).toBe(0);
    expect(a.stdout).toBe(b.stdout);
    expect(a.stdout).toContain('Pose flags:');
    expect(a.stdout).toContain('Frame flags:');
    expect(a.stdout).toContain('--overlay');
    expect(a.stdout).toContain('Examples:');
    const e = await run(['help', 'editor']);
    expect(e.stdout).toContain('screenshot');
    const es = await run(['help', 'editor', 'command']);
    expect(es.stdout).toContain('--params');
    expect((await run(['editor', 'state', '-h'])).stdout).toContain('usage: rev2d editor state');
  });

  it('bin/rev2d.js runs from any cwd and exits with the command status', () => {
    const bin = path.join(PACKAGE_ROOT, 'bin', 'rev2d.js');
    const version = spawnSync(process.execPath, [bin, '--version'], { cwd: os.tmpdir(), encoding: 'utf8' });
    expect(version.status, version.stderr).toBe(0);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    const bad = spawnSync(process.execPath, [bin, 'rendr'], { cwd: os.tmpdir(), encoding: 'utf8' });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('did you mean "render"?');
  });

  it('loads the ops engine, editor server and MCP server only in the commands that need them', () => {
    // A broken or half-built module there must not take down validate/render/... (and startup stays fast).
    const dir = path.join(PACKAGE_ROOT, 'src', 'cli');
    const files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts'));
    for (const f of files) {
      const text = readFileSync(path.join(dir, f), 'utf8');
      const eager = text.split('\n').filter((l) => /^import (?!type )/.test(l) && /\/(ops|server|mcp)\//.test(l));
      expect(eager, f).toEqual([]);
    }
  });

  it('prints the version', async () => {
    const r = await run(['--version']);
    const pkg = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
    expect(r.stdout.trim()).toBe(pkg.version);
  });

  it('rejects unknown commands, subcommands and flags with did-you-mean (exit 2)', async () => {
    const a = await run(['rendr', 'x']);
    expect(a.code).toBe(2);
    expect(a.stderr).toContain('unknown command "rendr"');
    expect(a.stderr).toContain('did you mean "render"?');
    const b = await run(['editor', 'stat']);
    expect(b.code).toBe(2);
    expect(b.stderr).toContain('did you mean "state"?');
    const c = await run(['render', 'm.json', '-o', 'x.png', '--overlya', 'bones']);
    expect(c.code).toBe(2);
    expect(c.stderr).toContain('did you mean "--overlay"?');
    expect(c.stderr).toContain('usage: rev2d render');
    expect((await run(['editor'])).code).toBe(2);
    expect((await run(['--bogus'])).code).toBe(2);
    expect((await run(['help', 'nope'])).code).toBe(2);
  });

  it('checks positional counts', async () => {
    const a = await run(['render']);
    expect(a.code).toBe(2);
    expect(a.stderr).toContain('missing argument <model>');
    const b = await run(['info', 'a.json', 'b.json']);
    expect(b.code).toBe(2);
    expect(b.stderr).toContain('unexpected argument "b.json"');
    expect((await run(['mcp', 'extra'])).code).toBe(2);
  });

  it('explains a directory or a mistyped model path with the model files there', async () => {
    const dir = workspace(blankModel({ name: 'm' }));
    mkdirSync(path.join(dir, 'hero'));
    writeFileSync(path.join(dir, 'hero', 'hero.r2d.json'), formatModelJson(blankModel({ name: 'hero' })));
    const folder = await run(['info', 'hero'], { cwd: dir });
    expect(folder.code).toBe(1);
    expect(folder.stderr).toContain('error: hero is a directory, not a model file\nhint: did you mean hero/hero.r2d.json?');
    const typo = await run(['render', 'hero/her.r2d.json', '-o', 'x.png'], { cwd: dir });
    expect(typo.stderr).toContain('error: cannot read model file hero/her.r2d.json\nhint: model files in hero: hero/hero.r2d.json; or check the path');
    mkdirSync(path.join(dir, 'empty'));
    expect((await run(['info', 'empty'], { cwd: dir })).stderr).toContain('hint: it contains no *.r2d.json file; give the path of a model file');
    const validate = await run(['validate', 'hero', '--json'], { cwd: dir });
    expect(validate.code).toBe(1);
    expect(JSON.stringify(validate.json())).toContain('is a directory, not a model file');
  });

  it('prints errors as JSON on stdout with --json', async () => {
    const r = await run(['render', '--json']);
    expect(r.code).toBe(2);
    expect(r.json()).toMatchObject({ ok: false, exitCode: 2, error: { kind: 'usage', message: 'missing argument <model>' } });
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
    const f = await run(['info', 'missing.r2d.json', '--json']);
    expect(f.code).toBe(1);
    expect(f.json()).toMatchObject({ ok: false, exitCode: 1, error: { kind: 'failed' } });
    expect(f.json().error.message).toContain('cannot read model file');
    // --json=true counts; a "--json" after "--" is a positional, not the flag.
    expect((await run(['info', 'missing.r2d.json', '--json=true'])).json()).toMatchObject({ ok: false, exitCode: 1 });
    const positional = await run(['info', 'a.r2d.json', '--', '--json']);
    expect(positional.code).toBe(2);
    expect(positional.stdout).toBe('');
  });

  it('explains how to pass values that start with "-"', async () => {
    const r = await run(['sheet', 'm.r2d.json', '-o', 'x.png', '--title', '--x']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--title=--x');
  });
});

// ----------------------------------------------------------------------------- validate / info

describe('validate', () => {
  let dir: string;
  beforeAll(() => {
    dir = workspace();
    const bad = blankModel({ name: 'bad', width: 64, height: 64 }) as any;
    bad.parts[0].parent = 'bodyWarpp';
    writeFileSync(path.join(dir, 'bad.r2d.json'), formatModelJson(bad));
    // A duplicate key is a warning (the last value wins).
    writeFileSync(path.join(dir, 'warn.r2d.json'), formatModelJson(blankModel({ width: 64, height: 64 })).replace('{', '{\n  "format": "rev2d",'));
  });

  it('passes a valid model', async () => {
    const r = await run(['validate', 'model.r2d.json'], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('ok    model.r2d.json  (0 errors, 0 warnings)');
  });

  it('fails with located diagnostics and hints', async () => {
    const r = await run(['validate', 'bad.r2d.json'], { cwd: dir });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('FAIL  bad.r2d.json');
    expect(r.stdout).toContain('/parts/0/parent');
    expect(r.stdout).toContain('did you mean "bodyWarp"?');
  });

  it('--json reports every file', async () => {
    const r = await run(['validate', 'model.r2d.json', 'bad.r2d.json', 'warn.r2d.json', 'none.r2d.json', '--json'], { cwd: dir });
    expect(r.code).toBe(1);
    const reports = r.json();
    expect(reports.map((x: any) => [path.basename(x.file), x.ok, x.errors, x.warnings])).toEqual([
      ['model.r2d.json', true, 0, 0],
      ['bad.r2d.json', false, 1, 0],
      ['warn.r2d.json', true, 0, 1],
      ['none.r2d.json', false, 1, 0],
    ]);
    expect(path.isAbsolute(reports[0].file)).toBe(true);
    expect(reports[1].diagnostics[0]).toMatchObject({ severity: 'error', path: '/parts/0/parent' });
    expect(reports[3].diagnostics[0].code).toBe('file-not-found');
  });

  it('expands wildcards itself (cmd.exe and PowerShell pass them literally)', async () => {
    const r = await run(['validate', '*.r2d.json', '--json'], { cwd: dir });
    expect(r.json().map((x: any) => path.basename(x.file))).toEqual(['bad.r2d.json', 'model.r2d.json', 'warn.r2d.json']);
    const none = await run(['validate', 'nothing/*.r2d.json', 'model.r2d.json'], { cwd: dir });
    expect(none.code).toBe(1);
    expect(none.stdout).toContain('FAIL  nothing/*.r2d.json');
    expect(none.stdout).toContain('no file matches "nothing/*.r2d.json"');
    expect(none.stdout).toContain('2 files: 1 ok, 1 failed');
  });

  it('--strict fails on warnings', async () => {
    expect((await run(['validate', 'warn.r2d.json'], { cwd: dir })).code).toBe(0);
    const r = await run(['validate', 'warn.r2d.json', '--strict'], { cwd: dir });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('json-duplicate-key');
    const multi = await run(['validate', 'model.r2d.json', 'warn.r2d.json', '--strict'], { cwd: dir });
    expect(multi.stdout).toContain('2 files: 1 ok, 1 failed');
  });
});

describe('info', () => {
  it('prints the structure', async () => {
    const dir = workspace();
    const r = await run(['info', 'model.r2d.json'], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('fixture  128x128');
    expect(r.stdout).toContain('PARAMETERS');
    const j = await run(['info', path.join(dir, 'model.r2d.json'), '--json']);
    expect(j.json()).toMatchObject({ name: 'fixture', size: [128, 128], counts: { parameters: 2, parts: 2, animations: 1 } });
  });

  it('refuses invalid models with their diagnostics (exit 1)', async () => {
    const doc = blankModel() as any;
    doc.bones[0].parent = 'ghost';
    const dir = workspace(doc);
    const r = await run(['info', 'model.r2d.json'], { cwd: dir });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('model.r2d.json has 1 error');
    expect(r.stderr).toContain('/bones/0/parent');
    expect(r.stderr).toContain('rev2d validate model.r2d.json');
    const missing = await run(['info', 'nope.r2d.json'], { cwd: dir });
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('rev2d new nope.r2d.json');
  });
});

// ----------------------------------------------------------------------------- rendering

describe('render', () => {
  let dir: string;
  beforeAll(() => {
    dir = workspace();
  });

  it('writes a PNG and summarizes the frame', async () => {
    const r = await run(['render', 'model.r2d.json', '-o', 'out/a.png'], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('wrote out/a.png (128x128, viewBox 0,0,128,128, scale 1, t=0s)');
    expect(r.stdout).toContain('visible parts (2, back to front): body, eye');
    const img = decodePNG(readFileSync(path.join(dir, 'out/a.png')));
    expect([img.width, img.height]).toEqual([128, 128]);
  });

  it('--json shape with pose and frame flags', async () => {
    const r = await run(
      ['render', 'model.r2d.json', '-o', 'b.png', '--param', 'Lean=0.5,Squash=1', '--anim', 'idle@0.5', '--time', '0.25', '--overlay', 'all', '--viewbox', 'fit', '--padding', '4', '--scale', '2', '--bg', 'white', '--ss', '1', '--no-physics', '--json'],
      { cwd: dir },
    );
    expect(r.code).toBe(0);
    const j = r.json();
    expect(j).toMatchObject({ scale: 2, time: 0.25, visibleParts: ['body', 'eye'], hiddenParts: [], params: { Lean: 0.5, Squash: 1 }, notes: [] });
    expect(j.overlay).toEqual(['bones', 'mesh', 'warps', 'bounds', 'labels', 'grid']);
    expect(j.viewBox[2]).toBeLessThan(128);
    expect(j.width).toBe(j.viewBox[2] * 2);
    expect(j.file).toBe(path.join(dir, 'b.png'));
    expect(decodePNG(readFileSync(j.file)).width).toBe(j.width);
    // Without overlays (the grid covers the border) the corner shows the --bg color.
    const plain = await run(['render', 'model.r2d.json', '-o', 'c.png', '--viewbox', 'fit', '--bg', 'white', '--json'], { cwd: dir });
    const img = decodePNG(readFileSync(plain.json().file));
    expect(Array.from(img.data.slice(0, 4))).toEqual([255, 255, 255, 255]);
  });

  it('notes parameter values that are clamped', async () => {
    const r = await run(['render', 'model.r2d.json', '-o', 'clamp.png', '--param', 'Lean=5', '--json'], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.json().params.Lean).toBe(1);
    expect(r.json().notes).toEqual(['--param Lean=5 is outside its range [-1..1] and is clamped to 1']);
    const i = await run(['inspect', 'model.r2d.json', '--param', 'Lean=-2', '--json'], { cwd: dir });
    expect(i.json().params.Lean).toBe(-1);
    expect(i.stderr).toContain('note: --param Lean=-2 is outside its range [-1..1] and is clamped to -1');
  });

  it('notes when nothing is visible', async () => {
    const doc = blankModel({ width: 64, height: 64 }) as any;
    for (const p of doc.parts) p.opacity = 0;
    const d = workspace(doc);
    const r = await run(['render', 'model.r2d.json', '-o', 'x.png'], { cwd: d });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('hidden parts (2): body, eye');
    expect(r.stderr).toContain('note: no part is visible');
  });

  it('rejects bad flags with exit 2', async () => {
    const cases: Array<[string[], string]> = [
      [['--overlay', 'bone'], 'did you mean "bones"?'],
      [['--param', 'Laen=1'], 'did you mean "Lean"?'],
      [['--param', 'Lean'], 'expects id=value'],
      [['--param', 'Lean=x'], 'needs a number'],
      [['--anim', 'idel'], 'did you mean "idle"?'],
      [['--anim', 'idle@x'], 'weight of animation layer "idle@x" must be a number within 0..1, got "x"'],
      [['--anim', 'idle@1.5'], 'must be a number within 0..1'],
      [['--anim', 'idle,ad'], 'did you mean "add"?'],
      [['--time', '-1'], '--time must be >= 0, got -1'],
      [['--only', 'root'], '--only filters the overlay, but no --overlay is given'],
      [['--overlay', 'bones', '--only', 'rot'], 'did you mean "root"?'],
      [['--only-chain'], '--only-chain applies together with --only <ids>'],
      [['--viewbox', '1,2,3'], 'expects "x,y,w,h" or "fit"'],
      [['--viewbox', '0,0,0,10'], 'must be positive'],
      [['--padding', '3'], 'only applies to --viewbox fit'],
      [['--bg', 'blurple'], 'is not a color'],
      [['--ss', '9'], 'must be <= 4'],
      [['--scale', '0'], 'must be > 0'],
    ];
    for (const [flags, message] of cases) {
      const r = await run(['render', 'model.r2d.json', '-o', 'bad.png', ...flags], { cwd: dir });
      expect(r.code, flags.join(' ')).toBe(2);
      expect(r.stderr, flags.join(' ')).toContain(message);
    }
    mkdirSync(path.join(dir, 'adir'), { recursive: true });
    const isDir = await run(['render', 'model.r2d.json', '-o', 'adir'], { cwd: dir });
    expect(isDir.code).toBe(1);
    expect(isDir.stderr).toContain('cannot write adir (EISDIR)');
    const noOut = await run(['render', 'model.r2d.json'], { cwd: dir });
    expect(noOut.code).toBe(2);
    expect(noOut.stderr).toContain('missing output file');
    expect(existsSync(path.join(dir, 'bad.png'))).toBe(false);
  });
});

describe('sheet', () => {
  let dir: string;
  beforeAll(() => {
    dir = workspace();
  });

  it('renders sweeps', async () => {
    const r = await run(['sheet', 'model.r2d.json', '-o', 's.png', '--sweep', 'Lean=-1:1:3', '--sweep', 'Squash=0,1', '--scale', '0.5', '--json'], { cwd: dir });
    expect(r.code).toBe(0);
    const j = r.json();
    expect(j).toMatchObject({ mode: 'sweep', cells: 6, columns: 3, sweeps: [{ param: 'Lean', values: [-1, 0, 1] }, { param: 'Squash', values: [0, 1] }] });
    const img = decodePNG(readFileSync(j.file));
    expect([img.width, img.height]).toEqual([j.width, j.height]);
    const t = await run(['sheet', 'model.r2d.json', '-o', 's2.png', '--sweep', 'Lean', '--title', 'Lean check'], { cwd: dir });
    expect(t.code).toBe(0);
    expect(t.stdout).toContain('5 cells');
    expect(t.stdout).toContain('cells: Lean=-1,-0.5,0,0.5,1');
  });

  it('notes sweep values that are clamped to the parameter range', async () => {
    const r = await run(['sheet', 'model.r2d.json', '-o', 'c.png', '--sweep', 'Lean=0,5,10', '--scale', '0.25', '--json'], { cwd: dir });
    expect(r.code, r.stderr).toBe(0);
    expect(r.json().notes).toEqual(['sweep Lean: 5, 10 are outside its range [-1..1] and clamped (such cells look like the range end)']);
    const t = await run(['sheet', 'model.r2d.json', '-o', 'c.png', '--sweep', 'Lean=0:1:2', '--param', 'Squash=3', '--scale', '0.25'], { cwd: dir });
    expect(t.code).toBe(0);
    expect(t.stderr).toContain('note: --param Squash=3 is outside its range [0..1] and is clamped to 1');
    expect(t.stdout).toContain('cell viewBox 0,0,128,128');
  });

  it('renders animation sheets', async () => {
    const r = await run(['sheet', 'model.r2d.json', '-o', 'a.png', '--anim', 'idle', '--frames', '4', '--columns', '2', '--json'], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({ mode: 'animation', animation: 'idle', cells: 4, columns: 2, times: [0, 0.5, 1, 1.5] });
  });

  it('rejects inconsistent requests', async () => {
    const cases: Array<[string[], string]> = [
      [[], 'sheet needs --anim <id>, --sweep <spec> or --overview [ids]'],
      [['--sweep', 'Lean', '--sweep', 'Squash', '--sweep', 'Lean'], 'at most 2'],
      [['--sweep', 'Lean', '--sweep', 'Lean=0,1'], 'sweep two different parameters'],
      [['--sweep', 'Laen'], 'did you mean "Lean"?'],
      [['--sweep', 'Lean=a,b'], '--sweep: bad sweep "Lean=a,b": value 1 "a" is not a finite number'],
      [['--sweep', 'Lean', '--frames', '3'], '--frames applies to animation sheets'],
      [['--anim', 'idle', '--time', '1'], '--time does not apply'],
      [['--anim', 'idle@0.5'], 'use --anim idle'],
      [['--sweep', 'Lean=0:1:20', '--sweep', 'Squash=0:1:20'], '400 cells'],
      [['--sweep', 'Lean=0:1:0'], 'steps must be a whole number >= 2 (or 1 for just min), got 0'],
      [['--sweep', 'Lean=0:1:-3'], 'steps must be a whole number >= 2 (or 1 for just min), got -3'],
      [['--sweep', 'Lean=0:1:1.5'], 'steps must be a whole number >= 2 (or 1 for just min), got 1.5'],
      [['--sweep', 'Lean=0:1:2:3'], 'expected min:max or min:max:steps'],
      [['--sweep', 'Lean=0,,1'], 'value 2 is missing'],
      [['--sweep', 'Lean=:1:3'], 'min is missing'],
      [['--sweep', 'Lean='], 'no values after "="'],
      [['--sweep', 'Lean', '--overview'], '--sweep and --overview are different sheets'],
      [['--overview', 'Lean', '--frames', '3'], '--frames applies to animation sheets'],
      [['--steps', '3', '--sweep', 'Lean'], '--steps applies to --overview sheets'],
      [['--overview', 'Laen'], 'did you mean "Lean"?'],
      [['--anim', 'idle', '--frames', '3', '--times', '0,1'], '--times lists the sample times itself; drop --frames'],
      [['--anim', 'idle', '--from', '2', '--to', '1'], 'to (1) must be greater than from (2)'],
      [['--anim', 'idle,start=1'], 'the first --anim is sampled over time, so it cannot have its own clock'],
    ];
    for (const [flags, message] of cases) {
      const r = await run(['sheet', 'model.r2d.json', '-o', 'bad.png', ...flags], { cwd: dir });
      expect(r.code, flags.join(' ')).toBe(2);
      expect(r.stderr, flags.join(' ')).toContain(message);
    }
  });
});

describe('gif and frames', () => {
  let dir: string;
  beforeAll(() => {
    dir = workspace(blankModel({ name: 'anim', width: 48, height: 48 }));
  });

  it('gif writes a looping GIF at real-time speed', async () => {
    const r = await run(['gif', 'model.r2d.json', '-o', 'idle.gif', '--anim', 'idle', '--frames', '8', '--json'], { cwd: dir });
    expect(r.code).toBe(0);
    const j = r.json();
    expect(j).toMatchObject({ width: 48, height: 48, frames: 8, fps: 4, loop: true, animation: 'idle' });
    const bytes = readFileSync(j.file);
    expect(bytes.toString('latin1', 0, 6)).toBe('GIF89a');
    expect(bytes.toString('latin1').includes('NETSCAPE2.0')).toBe(true);
    expect(j.bytes).toBe(bytes.length);
    const once = await run(['gif', 'model.r2d.json', '-o', 'once.gif', '--anim', 'idle', '--fps', '5', '--no-loop'], { cwd: dir });
    expect(once.code).toBe(0);
    expect(once.stdout).toContain('10 frames at 5 fps, plays once');
    expect(readFileSync(path.join(dir, 'once.gif')).toString('latin1').includes('NETSCAPE2.0')).toBe(false);
  });

  it('gif requires a known --anim', async () => {
    const a = await run(['gif', 'model.r2d.json', '-o', 'x.gif'], { cwd: dir });
    expect(a.code).toBe(2);
    expect(a.stderr).toContain('missing --anim');
    expect(a.stderr).toContain('animations: idle');
    const b = await run(['gif', 'model.r2d.json', '-o', 'x.gif', '--anim', 'idl'], { cwd: dir });
    expect(b.code).toBe(2);
    expect(b.stderr).toContain('did you mean "idle"?');
    expect((await run(['gif', 'model.r2d.json', '-o', 'x.gif', '--anim', 'idle', '--fps', '5000'], { cwd: dir })).code).toBe(2);
  });

  it('frames writes a PNG sequence and manifest, removing stale frames', async () => {
    const r = await run(['frames', 'model.r2d.json', '-o', 'seq', '--anim', 'idle', '--frames', '4', '--json'], { cwd: dir });
    expect(r.code).toBe(0);
    const j = r.json();
    expect(j.files).toEqual(['frame_0000.png', 'frame_0001.png', 'frame_0002.png', 'frame_0003.png']);
    const manifest = JSON.parse(readFileSync(path.join(dir, 'seq', 'manifest.json'), 'utf8'));
    expect(manifest).toEqual({ animation: 'idle', layers: [], fps: 2, width: 48, height: 48, viewBox: [0, 0, 48, 48], times: [0, 0.5, 1, 1.5], files: j.files });
    writeFileSync(path.join(dir, 'seq', 'notes.txt'), 'keep me');
    const again = await run(['frames', 'model.r2d.json', '-o', 'seq', '--anim', 'idle', '--frames', '2'], { cwd: dir });
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('removed 2 stale frames');
    expect(readdirSync(path.join(dir, 'seq')).sort()).toEqual(['frame_0000.png', 'frame_0001.png', 'manifest.json', 'notes.txt']);
    expect(decodePNG(readFileSync(path.join(dir, 'seq', 'frame_0001.png'))).width).toBe(48);
  });

  it('--viewbox fit uses one view box for every frame (GIF frames must share a size)', async () => {
    // Guard: per-frame fitting really differs over this animation.
    const m = await loadModelFile(path.join(dir, 'model.r2d.json'));
    const sizes = new Set([0, 0.5, 1, 1.5].map((t) => renderFrame(m, { animations: ['idle'], time: t, viewBox: 'fit' }).viewBox.join(',')));
    expect(sizes.size).toBeGreaterThan(1);

    const g = await run(['gif', 'model.r2d.json', '-o', 'fit.gif', '--anim', 'idle', '--frames', '4', '--viewbox', 'fit', '--padding', '2', '--json'], { cwd: dir });
    expect(g.code, g.stderr).toBe(0);
    const [x, y, w, h] = g.json().viewBox;
    expect([g.json().width, g.json().height]).toEqual([w, h]);
    // The shared box covers every per-frame box.
    for (const t of [0, 0.5, 1, 1.5]) {
      const b = renderFrame(m, { animations: ['idle'], time: t, viewBox: 'fit', padding: 2 }).viewBox;
      expect(b[0]).toBeGreaterThanOrEqual(x);
      expect(b[1]).toBeGreaterThanOrEqual(y);
      expect(b[0] + b[2]).toBeLessThanOrEqual(x + w);
      expect(b[1] + b[3]).toBeLessThanOrEqual(y + h);
    }

    const f = await run(['frames', 'model.r2d.json', '-o', 'fitseq', '--anim', 'idle', '--frames', '4', '--viewbox', 'fit', '--padding', '2', '--json'], { cwd: dir });
    expect(f.code, f.stderr).toBe(0);
    expect(f.json().viewBox).toEqual([x, y, w, h]);
    for (const file of f.json().files) {
      const img = decodePNG(readFileSync(path.join(dir, 'fitseq', file)));
      expect([img.width, img.height], file).toEqual([w, h]);
    }
    const s = await run(['sheet', 'model.r2d.json', '-o', 'fitsheet.png', '--anim', 'idle', '--frames', '4', '--viewbox', 'fit', '--padding', '2', '--json'], { cwd: dir });
    expect(s.code, s.stderr).toBe(0);
    expect(s.json().viewBox).toEqual([x, y, w, h]);
  });

  it('gif warns about GIF playback limits and refuses to exhaust memory', async () => {
    const fast = await run(['gif', 'model.r2d.json', '-o', 'fast.gif', '--anim', 'idle', '--fps', '60', '--scale', '0.25'], { cwd: dir });
    expect(fast.code, fast.stderr).toBe(0);
    expect(fast.stderr).toContain('plays at about 50 fps');
    const big = await run(['gif', 'model.r2d.json', '-o', 'big.gif', '--anim', 'idle', '--frames', '40', '--scale', '40', '--ss', '1'], { cwd: dir });
    expect(big.code).toBe(2);
    expect(big.stderr).toContain('40 frames of 1920x1920');
    expect(big.stderr).toContain('lower --scale');
    expect(existsSync(path.join(dir, 'big.gif'))).toBe(false);
  });
});

// ----------------------------------------------------------------------------- inspect / hit

describe('inspect', () => {
  let dir: string;
  beforeAll(() => {
    dir = workspace();
  });

  it('prints readable tables', async () => {
    const r = await run(['inspect', 'model.r2d.json', '--param', 'Lean=1'], { cwd: dir });
    expect(r.code).toBe(0);
    for (const s of ['PARAMETERS', 'BONES', 'PARTS', 'WARPS', 'DRAW ORDER (back to front): body, eye', 'BOUND / ANIMATED PROPERTIES', 'warp:bodyWarp.offsets']) {
      expect(r.stdout).toContain(s);
    }
    expect(r.stdout).toMatch(/Lean\s+1\s+\[-1\.\.1\]/);
  });

  it('--json returns the full InspectResult', async () => {
    const r = await run(['inspect', 'model.r2d.json', '--anim', 'idle', '--time', '0.5', '--json'], { cwd: dir });
    const j = r.json();
    expect(Object.keys(j).sort()).toEqual(['bones', 'drawOrder', 'events', 'ik', 'params', 'parts', 'physics', 'properties', 'time', 'warps']);
    expect(j.time).toBe(0.5);
    expect(j.params.Squash).toBeCloseTo(0.4, 3);
    expect(j.parts[0]).toMatchObject({ id: 'body', visible: true, opacity: 1, z: 0 });
    expect(j.bones[0]).toMatchObject({ id: 'root', parent: null, x: 64 });
  });

  it('focuses on selected ids', async () => {
    const r = await run(['inspect', 'model.r2d.json', '--bone', 'root', '--json'], { cwd: dir });
    const j = r.json();
    expect(j.bones.map((b: any) => b.id)).toEqual(['root']);
    expect(j.parts).toBeUndefined();
    expect(j.warps).toBeUndefined();
    expect(Object.keys(j.properties).every((k) => k.startsWith('bone:root.'))).toBe(true);
    const t = await run(['inspect', 'model.r2d.json', '--part', 'eye', '--warp', 'bodyWarp'], { cwd: dir });
    expect(t.stdout).not.toContain('BONES');
    expect(t.stdout).toContain('eye');
    expect(t.stdout).toContain('row 2:');
    const bad = await run(['inspect', 'model.r2d.json', '--part', 'eyes'], { cwd: dir });
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('did you mean "eye"?');
  });
});

describe('hit', () => {
  let dir: string;
  beforeAll(() => {
    dir = workspace();
  });

  it('lists parts top-most first', async () => {
    const r = await run(['hit', 'model.r2d.json', '64', '58'], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('1. eye (fill)');
    expect(r.stdout).toContain('2. body (fill)');
    const j = (await run(['hit', 'model.r2d.json', '64', '58', '--json'], { cwd: dir })).json();
    expect(j).toMatchObject({ x: 64, y: 58 });
    expect(j.hits.slice(0, 2)).toEqual([
      { partId: 'eye', kind: 'fill' },
      { partId: 'body', kind: 'fill' },
    ]);
  });

  it('accepts negative coordinates and reports misses', async () => {
    const r = await run(['hit', 'model.r2d.json', '-5', '-5'], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('no part at (-5, -5)');
    const bad = await run(['hit', 'model.r2d.json', 'ten', '5'], { cwd: dir });
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('x must be a number');
  });
});

// ----------------------------------------------------------------------------- diff

describe('diff', () => {
  let dir: string;
  beforeAll(() => {
    dir = workspace();
    const a = createImage(4, 4, [0, 0, 0, 1]);
    const b = createImage(4, 4, [0, 0, 0, 1]);
    b.data.set([10, 0, 0, 255], 0);
    b.data.set([200, 0, 0, 255], 4);
    writeFileSync(path.join(dir, 'a.png'), encodePNG(a));
    writeFileSync(path.join(dir, 'b.png'), encodePNG(b));
    writeFileSync(path.join(dir, 'small.png'), encodePNG(createImage(2, 2)));
    writeFileSync(path.join(dir, 'text.png'), 'not a png');
  });

  it('reports identical images', async () => {
    const r = await run(['diff', 'a.png', 'a.png', '--fail-on-diff'], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('identical');
  });

  it('reports differences, threshold and visualization', async () => {
    const r = await run(['diff', 'a.png', 'b.png', '-o', 'd.png', '--json'], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({ width: 4, height: 4, identical: false, differentPixels: 2, totalPixels: 16, ratio: 0.125, maxDelta: 200, threshold: 0, region: [0, 0, 2, 1] });
    expect(decodePNG(readFileSync(path.join(dir, 'd.png'))).width).toBe(4);
    const t = await run(['diff', 'a.png', 'b.png', '--threshold', '50', '--fail-on-diff'], { cwd: dir });
    expect(t.code).toBe(1);
    expect(t.stdout).toContain('1 of 16 pixels differ (6.25%) at threshold 50');
    expect(t.stdout).toContain('changed region [1, 0, 1, 1] (x, y, w, h)');
    expect((await run(['diff', 'a.png', 'a.png', '--json'], { cwd: dir })).json().region).toBeNull();
    expect((await run(['diff', 'a.png', 'b.png', '--threshold', '200', '--fail-on-diff'], { cwd: dir })).code).toBe(0);
  });

  it('fails on size mismatch and unreadable files', async () => {
    const s = await run(['diff', 'a.png', 'small.png'], { cwd: dir });
    expect(s.code).toBe(1);
    expect(s.stderr).toContain('size mismatch: a.png is 4x4, small.png is 2x2');
    expect((await run(['diff', 'a.png', 'text.png'], { cwd: dir })).stderr).toContain('not a readable PNG');
    expect((await run(['diff', 'a.png', 'none.png'], { cwd: dir })).stderr).toContain('cannot read none.png');
    expect((await run(['diff', 'a.png', 'b.png', '--threshold', '300'], { cwd: dir })).code).toBe(2);
  });
});

// ----------------------------------------------------------------------------- schema / docs

describe('schema and docs', () => {
  it('prints and writes the JSON Schema', async () => {
    const r = await run(['schema']);
    expect(r.code).toBe(0);
    const schema = JSON.parse(r.stdout);
    expect(schema.type).toBe('object');
    expect(schema.properties.parts).toBeDefined();
    const dir = workspace();
    const w = await run(['schema', '-o', 'schema/rev2d.json'], { cwd: dir });
    expect(w.stdout).toContain('wrote schema/rev2d.json');
    expect(JSON.parse(readFileSync(path.join(dir, 'schema/rev2d.json'), 'utf8'))).toEqual(schema);
    expect((await run(['schema', '-o', 'schema/x.json', '--json'], { cwd: dir })).json()).toEqual({ file: path.join(dir, 'schema/x.json') });
  });

  it('lists topics and prints docs', async () => {
    const list = await run(['docs']);
    expect(list.code).toBe(0);
    for (const t of ['spec', 'ops', 'cli', 'mcp', 'agents', 'examples']) expect(list.stdout).toContain(t);
    const j = await run(['docs', '--json']);
    expect(j.json().find((t: any) => t.topic === 'spec')).toMatchObject({ available: true });
    const spec = await run(['docs', 'spec']);
    expect(spec.stdout).toBe(readFileSync(path.join(PACKAGE_ROOT, 'docs/SPEC.md'), 'utf8'));
    const cli = await run(['docs', 'cli', '--json']);
    expect(cli.json().text).toContain('AI verification loop');
    const bad = await run(['docs', 'spc']);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('did you mean "spec"?');
  });

  it('always has the op catalogue and the template list', async () => {
    const ops = await run(['docs', 'ops']);
    expect(ops.code).toBe(0);
    expect(ops.stdout).toContain('patch');
    // Without docs/OPS.md the catalogue compiled into src/ops is printed.
    const generated = await DOC_TOPICS.ops.generated!.text();
    for (const op of ['add', 'update', 'remove', 'rename', 'set', 'bind', 'key', 'patch']) expect(generated).toContain(`## ${op}\n`);
    const examples = await run(['docs', 'examples']);
    expect(examples.code).toBe(0);
    for (const t of listTemplates()) expect(examples.stdout).toContain(`## ${t}  (`);
    const list = (await run(['docs', '--json'])).json();
    expect(list.filter((t: any) => ['spec', 'ops', 'cli', 'examples'].includes(t.topic)).every((t: any) => t.available)).toBe(true);
  });

  it('docs/CLI.md documents every command and flag', () => {
    const doc = readFileSync(path.join(PACKAGE_ROOT, 'docs/CLI.md'), 'utf8');
    for (const c of COMMANDS) {
      expect(doc, c.name).toContain(`### rev2d ${c.name}`);
      for (const f of commandFlags(c)) expect(doc, `${c.name} --${f.name}`).toContain(`--${f.name}`);
    }
  });
});

// ----------------------------------------------------------------------------- new

describe('new', () => {
  it('creates a valid blank model with next steps', async () => {
    const dir = workspace();
    const r = await run(['new', 'models/cat.r2d.json', '--size', '300x200'], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('created models/cat.r2d.json from template "blank" (300x200; 0 errors, 0 warnings)');
    expect(r.stdout).toContain('rev2d render models/cat.r2d.json -o models/cat.png --overlay bones,labels');
    const doc = readModel(dir, 'models/cat.r2d.json');
    expect(doc.meta).toMatchObject({ name: 'cat', width: 300, height: 200 });
    expect((await run(['validate', 'models/cat.r2d.json'], { cwd: dir })).code).toBe(0);
  });

  it('refuses to overwrite without --force', async () => {
    const dir = workspace();
    const r = await run(['new', 'model.r2d.json'], { cwd: dir });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('model.r2d.json already exists');
    expect(r.stderr).toContain('--force');
    expect(readModel(dir).meta.name).toBe('fixture');
    const f = await run(['new', 'model.r2d.json', '--force', '--name', 'Renamed', '--json'], { cwd: dir });
    expect(f.code).toBe(0);
    expect(f.json()).toMatchObject({ template: 'blank', name: 'Renamed', size: [512, 512], textures: [], diagnostics: [] });
    expect(f.json().next).toContain('rev2d info model.r2d.json');
    expect(readModel(dir).meta.name).toBe('Renamed');
  });

  it('rejects bad options', async () => {
    const dir = workspace();
    const cases: Array<[string[], string]> = [
      [['--template', 'blnk'], 'did you mean "blank"?'],
      [['--size', '100'], 'expects WxH'],
      [['--size', '0x10'], 'expects WxH'],
    ];
    for (const [flags, message] of cases) {
      const r = await run(['new', 'x.r2d.json', ...flags], { cwd: dir });
      expect(r.code, flags.join(' ')).toBe(2);
      expect(r.stderr).toContain(message);
    }
    const example = listTemplates().find((t) => t !== 'blank' && t !== 'empty');
    if (example) {
      const r = await run(['new', 'x.r2d.json', '--template', example, '--size', '10x10'], { cwd: dir });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('--size applies to the blank and empty templates only');
    }
  });

  it('creates models from every example template (copying textures)', async () => {
    for (const t of listTemplates().filter((x) => x !== 'blank')) {
      const dir = workspace();
      const r = await run(['new', `sub/${t}.r2d.json`, '--template', t, '--json'], { cwd: dir });
      expect(r.code, `${t}: ${r.stderr}`).toBe(0);
      const j = r.json();
      for (const tex of j.textures) expect(existsSync(tex), tex).toBe(true);
      expect((await run(['validate', `sub/${t}.r2d.json`], { cwd: dir })).code, t).toBe(0);
    }
  });
});

// ----------------------------------------------------------------------------- watch

describe('watch', () => {
  it('re-validates and re-renders on change until stopped', async () => {
    const dir = workspace(blankModel({ name: 'w', width: 32, height: 32 }));
    const w = start(['watch', 'model.r2d.json', '-o', 'live.png', '--json'], dir);
    const checks = () => w.buf.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.event === 'check');
    await until(() => checks().length === 1, 'the first check');
    expect(checks()[0]).toMatchObject({ ok: true, errors: 0, render: { width: 32, height: 32 }, renderError: null, notes: [] });
    expect(existsSync(path.join(dir, 'live.png'))).toBe(true);

    const doc = blankModel({ name: 'w', width: 32, height: 32 }) as any;
    doc.parts[0].parent = 'nowhere';
    writeFileSync(path.join(dir, 'model.r2d.json'), formatModelJson(doc));
    await until(() => checks().length >= 2, 'a check after the change');
    const second = checks().at(-1);
    expect(second).toMatchObject({ ok: false, errors: 1, render: null });
    expect(second.diagnostics[0].path).toBe('/parts/0/parent');

    expect(await w.stop()).toBe(0);
    expect(w.buf.stdout.trim().split('\n').at(-1)).toBe('{"event":"stopped"}');
  });

  it('prints readable text and fails fast on bad flags', async () => {
    const dir = workspace(blankModel({ width: 32, height: 32 }));
    const w = start(['watch', 'model.r2d.json'], dir);
    await until(() => w.buf.stdout.includes('model.r2d.json: ok (0 errors, 0 warnings)'), 'the first check');
    expect(await w.stop()).toBe(0);
    expect(w.buf.stdout).toContain('stopped');
    const bad = await run(['watch', 'model.r2d.json', '--overlay', 'bonez'], { cwd: dir });
    expect(bad.code).toBe(2);
  });
});

// ----------------------------------------------------------------------------- ops / set

describe('ops', () => {
  it('applies --op edits in place', async () => {
    const dir = workspace();
    const r = await run(['ops', 'model.r2d.json', '--op', '{"op":"set","target":"bone:root.x","value":70}'], { cwd: dir });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('applied 1 op on model.r2d.json');
    expect(r.stdout).toContain('wrote model.r2d.json');
    expect(readModel(dir).bones[0].x).toBe(70);
  });

  it('refuses to wait for ops typed into an interactive terminal', async () => {
    const dir = workspace();
    const { buf, io } = capture();
    const tty = Object.assign(Readable.from([]), { isTTY: true });
    const code = await main(['ops', 'model.r2d.json', '-'], { ...io, cwd: dir, stdin: tty });
    expect(code).toBe(2);
    expect(buf.stderr).toContain('stdin is a terminal');
    expect(buf.stderr).toContain('cat edits.json | rev2d ops model.r2d.json -');
  });

  it('reads ops from a file and from stdin, in order with --op', async () => {
    const dir = workspace();
    writeFileSync(path.join(dir, 'edits.json'), JSON.stringify({ ops: [{ op: 'set', target: 'bone:root.x', value: 10 }] }));
    const f = await run(['ops', 'model.r2d.json', 'edits.json', '--op', '{"op":"set","target":"bone:root.y","value":20}', '--json'], { cwd: dir });
    expect(f.code, f.stderr).toBe(0);
    const j = f.json();
    expect(j).toMatchObject({ ok: true, written: true, dryRun: false, changed: true, output: path.join(dir, 'model.r2d.json') });
    expect(j.results.map((x: any) => [x.index, x.op, x.ok])).toEqual([
      [0, 'set', true],
      [1, 'set', true],
    ]);
    expect(readModel(dir).bones[0]).toMatchObject({ x: 10, y: 20 });
    const s = await run(['ops', 'model.r2d.json', '-'], { cwd: dir, stdin: '[{"op":"set","target":"part:eye.opacity","value":0.5}]' });
    expect(s.code, s.stderr).toBe(0);
    expect(readModel(dir).parts[1].opacity).toBe(0.5);
  });

  it('--dry-run and -o do not touch the model', async () => {
    const dir = workspace();
    const before = readFileSync(path.join(dir, 'model.r2d.json'), 'utf8');
    const d = await run(['ops', 'model.r2d.json', '--op', '{"op":"set","target":"bone:root.x","value":1}', '--dry-run'], { cwd: dir });
    expect(d.code).toBe(0);
    expect(d.stdout).toContain('dry run: nothing written');
    const o = await run(['ops', 'model.r2d.json', '--op', '{"op":"set","target":"bone:root.x","value":1}', '-o', 'copy.r2d.json', '--render', 'copy.png', '--viewbox', 'fit'], { cwd: dir });
    expect(o.code, o.stderr).toBe(0);
    expect(readFileSync(path.join(dir, 'model.r2d.json'), 'utf8')).toBe(before);
    expect(readModel(dir, 'copy.r2d.json').bones[0].x).toBe(1);
    expect(o.stdout).toContain('rendered copy.png');
    expect(existsSync(path.join(dir, 'copy.png'))).toBe(true);
  });

  it('fails atomically with per-op messages (exit 1)', async () => {
    const dir = workspace();
    const before = readFileSync(path.join(dir, 'model.r2d.json'), 'utf8');
    const r = await run(['ops', 'model.r2d.json', '--op', '[{"op":"set","target":"bone:root.x","value":5},{"op":"set","target":"bone:rot.x","value":5}]', '--json'], { cwd: dir });
    expect(r.code).toBe(1);
    const j = r.json();
    expect(j).toMatchObject({ ok: false, written: false });
    expect(j.results.some((x: any) => !x.ok)).toBe(true);
    expect(readFileSync(path.join(dir, 'model.r2d.json'), 'utf8')).toBe(before);
    const text = await run(['ops', 'model.r2d.json', '--op', '{"op":"set","target":"bone:rot.x","value":5}', '--render', 'x.png'], { cwd: dir });
    expect(text.code).toBe(1);
    expect(text.stdout).toContain('FAIL');
    expect(text.stdout).toContain('not written');
    expect(text.stderr).toContain('--render not rendered');
  });

  it('reports a failed --render next to the op results when the model was already written', async () => {
    const dir = workspace();
    mkdirSync(path.join(dir, 'adir'));
    const r = await run(['set', 'model.r2d.json', 'bone:root.x=40', '--render', 'adir', '--json'], { cwd: dir });
    expect(r.code).toBe(1);
    const j = r.json();
    expect(j).toMatchObject({ ok: false, written: true, changed: true, render: null });
    expect(j.results).toHaveLength(1);
    expect(j.renderError).toContain('not rendered: cannot write adir (EISDIR)');
    expect(readModel(dir).bones[0].x).toBe(40);
    const text = await run(['set', 'model.r2d.json', 'bone:root.x=41', '--render', 'adir'], { cwd: dir });
    expect(text.code).toBe(1);
    expect(text.stdout).toContain('wrote model.r2d.json');
    expect(text.stderr).toContain('error: --render not rendered: cannot write adir (EISDIR)');
  });

  it('says why nothing was rendered when the result is invalid', async () => {
    const dir = workspace();
    const r = await run(['ops', 'model.r2d.json', '--op', '{"op":"patch","patch":[{"op":"replace","path":"/parts/1/parent","value":"nowhere"}]}', '--render', 'x.png', '--json'], { cwd: dir });
    expect(r.code).toBe(1);
    expect(r.json()).toMatchObject({ ok: false, written: false, renderError: 'not rendered: the result has validation errors' });
    expect(r.json().diagnostics[0]).toMatchObject({ severity: 'error', path: '/parts/1/parent' });
  });

  it('rejects pose/frame flags without --render instead of ignoring them', async () => {
    const dir = workspace();
    const before = readFileSync(path.join(dir, 'model.r2d.json'), 'utf8');
    for (const flags of [['--param', 'Lean=1'], ['--overlay', 'bones'], ['--no-physics']]) {
      const r = await run(['set', 'model.r2d.json', 'bone:root.x=5', ...flags], { cwd: dir });
      expect(r.code, flags.join(' ')).toBe(2);
      expect(r.stderr).toContain(`${flags[0]} only applies together with --render <out.png>`);
    }
    expect(readFileSync(path.join(dir, 'model.r2d.json'), 'utf8')).toBe(before);
  });

  it('leaves an unchanged model file alone and keeps CRLF line endings when rewriting', async () => {
    const dir = workspace();
    const jsonc = formatModelJson(blankModel({ width: 64, height: 64 })).replace('{', '{\n  // hand-written comment').replace(/\n/g, '\r\n');
    writeFileSync(path.join(dir, 'c.r2d.json'), jsonc);
    const same = await run(['set', 'c.r2d.json', 'bone:root.x=32', '--json'], { cwd: dir });
    expect(same.code, same.stderr).toBe(0);
    expect(same.json()).toMatchObject({ ok: true, written: false, changed: false, notes: [] });
    expect(readFileSync(path.join(dir, 'c.r2d.json'), 'utf8')).toBe(jsonc);
    expect((await run(['set', 'c.r2d.json', 'bone:root.x=32'], { cwd: dir })).stdout).toContain('unchanged: the ops do not change the model');

    const changed = await run(['set', 'c.r2d.json', 'bone:root.x=30'], { cwd: dir });
    expect(changed.code).toBe(0);
    expect(changed.stderr).toContain('does not keep the comments');
    const text = readFileSync(path.join(dir, 'c.r2d.json'), 'utf8');
    expect(text).not.toContain('comment');
    expect(text.split('\r\n').length).toBeGreaterThan(10);
    expect(/[^\r]\n/.test(text)).toBe(false);
    expect(readModel(dir, 'c.r2d.json').bones[0].x).toBe(30);
  });

  it('notes textures that do not resolve from a different -o directory', async () => {
    const dir = workspace();
    const doc = blankModel({ width: 32, height: 32 }) as any;
    doc.textures = [{ id: 'dot', path: 'dot.png' }];
    doc.parts.push({ id: 'img', shape: { type: 'image', texture: 'dot', x: 0, y: 0 } });
    writeFileSync(path.join(dir, 'tex.r2d.json'), formatModelJson(doc));
    writeFileSync(path.join(dir, 'dot.png'), encodePNG(createImage(2, 2, [1, 0, 0, 1])));
    expect((await run(['validate', 'tex.r2d.json'], { cwd: dir })).code).toBe(0);
    const r = await run(['set', 'tex.r2d.json', 'bone:root.x=1', '-o', 'sub/tex.r2d.json', '--json'], { cwd: dir });
    expect(r.code, r.stdout).toBe(0);
    expect(r.json().notes).toEqual(['textures dot do not resolve from sub (texture paths are relative to the model file): copy the texture files there or fix their paths']);
    const same = await run(['set', 'tex.r2d.json', 'bone:root.x=1', '-o', 'copy.r2d.json', '--json'], { cwd: dir });
    expect(same.json()).toMatchObject({ written: true, notes: [] });
  });

  it('rejects malformed input (exit 2) and unreadable models (exit 1)', async () => {
    const dir = workspace();
    expect((await run(['ops', 'model.r2d.json'], { cwd: dir })).stderr).toContain('no ops given');
    const bad = await run(['ops', 'model.r2d.json', '--op', '{op: set}'], { cwd: dir });
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('--op #1 is not valid JSON');
    const shape = await run(['ops', 'model.r2d.json', '--op', '[1]'], { cwd: dir });
    expect(shape.code).toBe(2);
    expect(shape.stderr).toContain('expected an op object');
    expect((await run(['ops', 'model.r2d.json', 'none.json'], { cwd: dir })).code).toBe(1);
    writeFileSync(path.join(dir, 'broken.r2d.json'), '{"format": ');
    const broken = await run(['ops', 'broken.r2d.json', '--op', '{"op":"set","target":"bone:root.x","value":1}'], { cwd: dir });
    expect(broken.code).toBe(1);
    expect(broken.stderr).toContain('json-syntax');
  });
});

describe('set', () => {
  it('sets setup values by address', async () => {
    const dir = workspace();
    const r = await run(['set', 'model.r2d.json', 'bone:root.rotation=15', 'part:eye.fill=#ff0000', 'part:eye.visible=false'], { cwd: dir });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const doc = readModel(dir);
    expect(doc.bones[0].rotation).toBe(15);
    expect(doc.parts[1].fill).toBe('#ff0000');
    expect(doc.parts[1].visible).toBe(false);
  });

  it('rejects malformed assignments (exit 2)', async () => {
    const dir = workspace();
    const a = await run(['set', 'model.r2d.json', 'bone:root.x'], { cwd: dir });
    expect(a.code).toBe(2);
    expect(a.stderr).toContain('expected <address>=<value>');
    const b = await run(['set', 'model.r2d.json', 'bon:root.x=1'], { cwd: dir });
    expect(b.code).toBe(2);
    expect(b.stderr).toContain('did you mean "bone"?');
    expect((await run(['set', 'model.r2d.json'], { cwd: dir })).code).toBe(2);
  });
});

// ----------------------------------------------------------------------------- live editor

describe('edit and editor', () => {
  // Editors register in ~/.rev2d/editors and remember recent files in ~/.rev2d/recent.json: keep
  // both in a temp home so the developer's real ~/.rev2d is never touched.
  let home: string;
  beforeAll(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'rev2d-cli-home-'));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
  });
  afterAll(() => {
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
  });

  it('validates arguments before starting anything', async () => {
    const dir = workspace();
    const missing = await run(['edit', 'nope.r2d.json', '--no-open'], { cwd: dir });
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('rev2d new nope.r2d.json');
    expect((await run(['edit', 'model.r2d.json', '--port', '70000'], { cwd: dir })).code).toBe(2);
    expect((await run(['edit', 'model.r2d.json', '--port', 'x'], { cwd: dir })).code).toBe(2);

    // The workspace root must exist and contain the model.
    mkdirSync(path.join(dir, 'other'));
    const outside = await run(['edit', 'model.r2d.json', '--root', 'other', '--no-open'], { cwd: dir });
    expect(outside.code).toBe(1);
    expect(outside.stderr).toContain('error: model.r2d.json is outside the workspace root other');
    expect(outside.stderr).toContain('hint: the root must contain the model');
    const noRoot = await run(['edit', '--root', 'missing', '--no-open'], { cwd: dir });
    expect(noRoot.code).toBe(1);
    expect(noRoot.stderr).toContain('error: workspace root missing does not exist');
    expect((await run(['edit', 'model.r2d.json', '--root', 'model.r2d.json', '--no-open'], { cwd: dir })).stderr).toContain('is not a directory');
    const both = await run(['edit', 'other', '--root', '.', '--no-open'], { cwd: dir });
    expect(both.code).toBe(2);
    expect(both.stderr).toContain('error: other is a directory');
    const openWithout = await run(['editor', 'command', '{"type":"open"}', '--url', 'http://127.0.0.1:9'], { cwd: dir });
    expect(openWithout.code).toBe(2);
    expect(openWithout.stderr).toContain('an "open" command needs "file"');
  });

  it('opens an avatar project (its folder or its avatar.json) with the folder above it as the workspace', async () => {
    const dir = workspace(blankModel({ name: 'first', width: 32, height: 32 }));
    const project = path.join(dir, 'neko');
    mkdirSync(project);
    // A draft spec: the avatar validator reports missing landmarks, the model validator is not used.
    writeFileSync(path.join(project, 'avatar.json'), JSON.stringify(draftAvatarSpec('neko', 64, 64)));
    for (const target of ['neko', 'neko/avatar.json']) {
      const e = start(['edit', target, '--port', '0', '--no-open', '--json'], dir);
      const events = () => e.buf.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
      await until(() => events().length > 0 || e.buf.stderr.includes('error:'), 'the editor to listen', 60000);
      const listening = events()[0];
      try {
        expect(listening, e.buf.stderr).toMatchObject({ event: 'listening', root: dir });
        expect(e.buf.stderr).not.toContain('error:');
        expect(e.buf.stderr).not.toContain('avatar.json has');
        expect(e.buf.stderr).toContain('the avatar spec has');
        const info = await (await fetch(`${listening.url}/api/avatar`)).json();
        expect(info.projectPath).toBe('neko');
      } finally {
        expect(await e.stop()).toBe(0);
      }
    }
  });

  it('starts without a model and switches models with --open / {"type":"open"}; "editor state" follows', async () => {
    const dir = workspace(blankModel({ name: 'first', width: 32, height: 32 }));
    mkdirSync(path.join(dir, 'sub'));
    writeFileSync(path.join(dir, 'sub', 'b.r2d.json'), formatModelJson(blankModel({ name: 'second', width: 48, height: 48 })));
    const e = start(['edit', '--port', '0', '--no-open', '--json'], dir);
    const events = () => e.buf.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    await until(() => events().length > 0 || e.buf.stderr.includes('error:'), 'the editor to listen', 60000);
    const listening = events()[0];
    expect(listening, e.buf.stderr).toMatchObject({ event: 'listening', file: null, root: dir });
    const url: string = listening.url;
    try {
      const empty = await run(['editor', 'state', '--url', url], { cwd: dir });
      expect(empty.code, empty.stderr).toBe(0);
      expect(empty.stdout).toContain(`editor ${url}  no model open (start screen)`);
      expect(empty.stdout).toContain('workspace root: .\n');
      expect(empty.stderr).toContain('rev2d editor command --open <model>');
      expect((await run(['editor', 'state', '--url', url, '--json'], { cwd: dir })).json()).toEqual({ editor: { url, file: null, root: dir, pid: expect.any(Number) }, state: null });
      // Model commands need a model; the server says how to open one.
      const early = await run(['editor', 'command', '--url', url, '--pause'], { cwd: dir });
      expect(early.code).toBe(1);
      expect(early.stderr).toContain('the editor rejected pause (409): no model is open');

      // --open (relative to the current directory), then the flags apply to the opened model.
      const opened = await run(['editor', 'command', '--url', url, '--open', 'model.r2d.json', '--params', 'Lean=0.5', '--json'], { cwd: dir });
      expect(opened.code, opened.stderr).toBe(0);
      expect(opened.json().sent).toEqual([
        { command: { type: 'open', file: path.join(dir, 'model.r2d.json') }, delivered: 0, file: path.join(dir, 'model.r2d.json'), notes: [] },
        { command: { type: 'setParams', params: { Lean: 0.5 } }, delivered: 0 },
      ]);
      const typo = await run(['editor', 'command', '--url', url, '--open', 'sub/b.r2d.json', '--params', 'Laen=1'], { cwd: dir });
      expect(typo.code).toBe(2);
      expect(typo.stderr).toContain('did you mean "Lean"?');

      // The registry follows the open model, so --model finds the editor by its current file.
      expect(listEditors(path.join(dir, 'model.r2d.json')).map((x) => x.url)).toEqual([url]);
      const json = await run(['editor', 'command', '{"type":"open","file":"b.r2d.json"}', '--model', '../model.r2d.json'], { cwd: path.join(dir, 'sub') });
      expect(json.code, json.stderr).toBe(0);
      expect(json.stdout).toContain(`opened b.r2d.json in the editor at ${url} -> 0 editor windows`);
      expect(listEditors(path.join(dir, 'sub', 'b.r2d.json')).map((x) => x.url)).toEqual([url]);

      const posted = await fetch(`${url}/api/state`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ params: { Lean: 1 } }) });
      expect(posted.status).toBe(204);
      const state = await run(['editor', 'state', '--model', 'sub/b.r2d.json', '--json'], { cwd: dir });
      expect(state.code, state.stderr).toBe(0);
      expect(state.json()).toMatchObject({ editor: { url, file: path.join(dir, 'sub', 'b.r2d.json'), root: dir }, state: { file: path.join(dir, 'sub', 'b.r2d.json'), params: { Lean: 1 } } });
      const text = await run(['editor', 'state', '--url', url], { cwd: dir });
      expect(text.stdout).toContain(`editor ${url}  sub/b.r2d.json\nworkspace root: .\n`);

      // Paths outside the workspace root are refused with the server's hint.
      const outside = await run(['editor', 'command', '--url', url, '--open', path.join(root, 'elsewhere.r2d.json')], { cwd: dir });
      expect(outside.code).toBe(1);
      expect(outside.stderr).toContain('the editor rejected open (403)');
      expect(outside.stderr).toContain('outside the workspace root');
      expect(outside.stderr).toContain('--root');
      const missing = await run(['editor', 'command', '--url', url, '--open', 'nope.r2d.json'], { cwd: dir });
      expect(missing.stderr).toContain('the editor rejected open (404): file not found: nope.r2d.json');
    } finally {
      expect(await e.stop()).toBe(0);
    }
    // The recent list lives in the (temporary) home.
    expect(JSON.parse(readFileSync(path.join(home, '.rev2d', 'recent.json'), 'utf8')).files.slice(0, 2)).toEqual([path.join(dir, 'sub', 'b.r2d.json'), path.join(dir, 'model.r2d.json')]);
  });

  it('finds an editor by its workspace root: --model of a file it has not open (start screen), a directory, or the file --open names', async () => {
    const dir = workspace(blankModel({ name: 'outer', width: 32, height: 32 }));
    mkdirSync(path.join(dir, 'ws'));
    writeFileSync(path.join(dir, 'ws', 'a.r2d.json'), formatModelJson(blankModel({ name: 'a', width: 32, height: 32 })));
    writeFileSync(path.join(dir, 'ws', 'b.r2d.json'), formatModelJson(blankModel({ name: 'b', width: 32, height: 32 })));
    mkdirSync(path.join(dir, 'other'));
    const listening = async (e: ReturnType<typeof start>) => {
      await until(() => e.buf.stdout.includes('listening') || e.buf.stderr.includes('error:'), 'the editor to listen', 60000);
      return JSON.parse(e.buf.stdout.split('\n')[0]).url as string;
    };
    // The start-screen editor of ws/ is the OLDER one: discovery must not just take the newest.
    const inWs = start(['edit', 'ws', '--port', '0', '--no-open', '--json'], dir);
    const wsUrl = await listening(inWs);
    const elsewhere = start(['edit', 'other', '--port', '0', '--no-open', '--json'], dir);
    const otherUrl = await listening(elsewhere);
    try {
      expect(listEditors({ root: path.join(dir, 'ws') })).toEqual([expect.objectContaining({ url: wsUrl, file: '', root: path.join(dir, 'ws') })]);

      // A file of the workspace that no editor has open: the editor whose root contains it answers, with a note.
      const state = await run(['editor', 'state', '--model', 'ws/a.r2d.json'], { cwd: dir });
      expect(state.code, state.stderr).toBe(0);
      expect(state.stdout).toContain(`editor ${wsUrl}  no model open (start screen)`);
      expect(state.stderr).toContain(
        `note: the editor at ${wsUrl} has no model open, not ws/a.r2d.json (it was chosen because its workspace root ws contains the file); open it with "rev2d editor command --open ws/a.r2d.json"`,
      );
      // A directory selects the editor of that workspace.
      expect((await run(['editor', 'state', '--model', 'ws', '--json'], { cwd: dir })).json()).toMatchObject({ editor: { url: wsUrl, file: null, root: path.join(dir, 'ws') } });
      expect((await run(['editor', 'state', '--model', 'other', '--json'], { cwd: dir })).json()).toMatchObject({ editor: { url: otherUrl } });
      // Commands for a model the editor does not have open are refused (they would act on another model) ...
      const refused = await run(['editor', 'command', '--model', 'ws/a.r2d.json', '--pause'], { cwd: dir });
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain(`error: the editor at ${wsUrl} has no model open, not ws/a.r2d.json; nothing was sent`);
      expect(refused.stderr).toContain('hint: add --open ws/a.r2d.json to switch the editor to it first (its workspace root ws contains the file)');

      // ... while --open without --model / --url goes to the editor whose workspace holds the file.
      const opened = await run(['editor', 'command', '--open', 'ws/a.r2d.json', '--json'], { cwd: dir });
      expect(opened.code, opened.stderr).toBe(0);
      expect(opened.json()).toMatchObject({ url: wsUrl, sent: [{ file: path.join(dir, 'ws', 'a.r2d.json') }] });
      expect(listEditors(path.join(dir, 'ws', 'a.r2d.json')).map((x) => x.url)).toEqual([wsUrl]);
      const json = await run(['editor', 'command', '{"type":"open","file":"ws/b.r2d.json"}', '--json'], { cwd: dir });
      expect(json.json()).toMatchObject({ url: wsUrl });
      // --model with --open is fine even though the model is not open yet.
      const both = await run(['editor', 'command', '--model', 'ws/a.r2d.json', '--open', 'ws/a.r2d.json', '--json'], { cwd: dir });
      expect(both.code, both.stderr).toBe(0);
      expect(both.json()).toMatchObject({ url: wsUrl });

      // A screenshot of a model the editor does not show is refused.
      const shot = await run(['editor', 'screenshot', '--model', 'ws/b.r2d.json', '-o', 'b.png'], { cwd: dir });
      expect(shot.code).toBe(1);
      expect(shot.stderr).toContain(`error: the editor at ${wsUrl} has ws/a.r2d.json open, not ws/b.r2d.json`);
      expect(shot.stderr).toContain('hint: open it first: rev2d editor command --open ws/b.r2d.json');
      expect((await run(['editor', 'screenshot', '--model', 'ws/a.r2d.json', '-o', 'a.png'], { cwd: dir })).code).toBe(0);

      // Outside every workspace: the error lists the running editors with their roots.
      const none = await run(['editor', 'state', '--model', 'model.r2d.json'], { cwd: dir });
      expect(none.code).toBe(1);
      expect(none.stderr).toContain('error: no running editor for model.r2d.json');
      expect(none.stderr).toContain(`${wsUrl} (ws/a.r2d.json open, workspace root ws)`);
      expect(none.stderr).toContain(`${otherUrl} (no model open, workspace root other)`);
      expect(none.stderr).toContain('start one with "rev2d edit model.r2d.json"');
    } finally {
      expect(await elsewhere.stop()).toBe(0);
      expect(await inWs.stop()).toBe(0);
    }
  });

  it('"rev2d edit <dir>" makes the directory the workspace root; --root widens the workspace of a model', async () => {
    const dir = workspace(blankModel({ name: 'ws', width: 32, height: 32 }));
    mkdirSync(path.join(dir, 'models'));
    writeFileSync(path.join(dir, 'models', 'm.r2d.json'), formatModelJson(blankModel({ name: 'm', width: 32, height: 32 })));
    const e = start(['edit', 'models', '--port', '0', '--no-open'], dir);
    await until(() => e.buf.stdout.includes('press Ctrl+C') || e.buf.stderr.includes('error:'), 'the editor to listen', 60000);
    try {
      expect(e.buf.stdout).toContain('editor started with no model open');
      expect(e.buf.stdout).toContain('workspace root: models');
      expect(e.buf.stderr).toContain('note: open or create a model in the browser (File menu)');
    } finally {
      expect(await e.stop()).toBe(0);
    }
    const w = start(['edit', 'models/m.r2d.json', '--root', '.', '--port', '0', '--no-open', '--json'], dir);
    await until(() => w.buf.stdout.includes('listening') || w.buf.stderr.includes('error:'), 'the editor to listen', 60000);
    try {
      const listening = JSON.parse(w.buf.stdout.split('\n')[0]);
      expect(listening, w.buf.stderr).toMatchObject({ file: path.join(dir, 'models', 'm.r2d.json'), root: dir });
      const files = await (await fetch(`${listening.url}/api/files`)).json();
      expect(files.entries.map((x: { path: string }) => x.path)).toEqual(['models', 'model.r2d.json']);
    } finally {
      expect(await w.stop()).toBe(0);
    }
  });

  it('editor commands fail clearly without a running editor', async () => {
    const dir = workspace();
    const r = await run(['editor', 'state', '--model', 'model.r2d.json'], { cwd: dir });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('no running editor for model.r2d.json');
    expect(r.stderr).toContain('rev2d edit');
    const unreachable = await run(['editor', 'state', '--url', 'http://127.0.0.1:9'], { cwd: dir });
    expect(unreachable.code).toBe(1);
    expect(unreachable.stderr).toContain('cannot reach the editor');
    expect((await run(['editor', 'state', '--url', 'localhost:4777'], { cwd: dir })).code).toBe(2);
    const badJson = await run(['editor', 'command', '{type: pause}', '--url', 'http://127.0.0.1:9'], { cwd: dir });
    expect(badJson.code).toBe(2);
    const badType = await run(['editor', 'command', '{"type":"pase"}', '--url', 'http://127.0.0.1:9'], { cwd: dir });
    expect(badType.code).toBe(2);
    expect(badType.stderr).toContain('did you mean "pause"?');
    expect((await run(['editor', 'screenshot', '--url', 'http://127.0.0.1:9'], { cwd: dir })).stderr).toContain('missing output file');
  });

  it('--allow-host adds host names the editor answers to (others stay rejected)', async () => {
    const dir = workspace(blankModel({ name: 'hosts', width: 32, height: 32 }));
    const e = start(['edit', 'model.r2d.json', '--port', '0', '--no-open', '--allow-host', 'rev2d.test', '--json'], dir);
    await until(() => e.buf.stdout.includes('listening') || e.buf.stderr.includes('error:'), 'the editor to listen', 60000);
    const port = Number(new URL(JSON.parse(e.buf.stdout.split('\n')[0]).url).port);
    const status = (host: string) =>
      new Promise<number>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/api/info', headers: { host: `${host}:${port}` } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on('error', reject);
        req.end();
      });
    try {
      expect(await status('rev2d.test')).toBe(200);
      expect(await status('evil.test')).toBe(403);
      expect(await status('127.0.0.1')).toBe(200);
    } finally {
      expect(await e.stop()).toBe(0);
    }
  });

  it('starts the editor server, serves the model and drives it via "editor"', async () => {
    const dir = workspace(blankModel({ name: 'live', width: 64, height: 64 }));
    const e = start(['edit', 'model.r2d.json', '--port', '0', '--no-open', '--json'], dir);
    const events = () => e.buf.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    await until(() => events().length > 0 || e.buf.stderr.includes('error:'), 'the editor to listen', 60000);
    const listening = events()[0];
    expect(listening, e.buf.stderr).toMatchObject({ event: 'listening', file: path.join(dir, 'model.r2d.json'), root: dir });
    const url: string = listening.url;
    try {
      const model = await (await fetch(`${url}/api/model`)).json();
      expect(model.text).toBe(readFileSync(path.join(dir, 'model.r2d.json'), 'utf8'));

      const none = await run(['editor', 'state', '--url', url], { cwd: dir });
      expect(none.code).toBe(1);
      expect(none.stderr).toContain('has not published its view state yet');
      const early = await run(['editor', 'screenshot', '--url', url, '-o', 'early.png'], { cwd: dir });
      expect(early.code, early.stderr).toBe(0);
      expect(early.stderr).toContain("note: no browser has published the editor's view state yet, so this shows the default pose");

      const state = { file: path.join(dir, 'model.r2d.json'), params: { Lean: 0.5 }, time: 0, animations: [{ id: 'idle', weight: 0.5, mode: 'add', start: 1, hold: false }], playing: false, selection: ['eye'], overlay: ['bones'], viewBox: null, updatedAt: new Date(0).toISOString() };
      const posted = await fetch(`${url}/api/state`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(state) });
      expect(posted.status).toBe(204);
      const s = await run(['editor', 'state', '--model', 'model.r2d.json', '--json'], { cwd: dir });
      expect(s.code, s.stderr).toBe(0);
      expect(s.json()).toMatchObject({ editor: { url }, state: { params: { Lean: 0.5 }, selection: ['eye'] } });
      const text = await run(['editor', 'state', '--url', url], { cwd: dir });
      expect(text.stdout).toContain('selection: eye');
      // Layers print as layer strings that --anims / --anim accept back.
      expect(text.stdout).toContain('animations: idle@0.5,add,once,start=1');
      expect(text.stdout).toMatch(/Lean\s+0\.5/);

      const c = await run(['editor', 'command', '--url', url, '--model', 'model.r2d.json', '--params', 'Lean=1', '--pause', '--message', 'hi', '--json'], { cwd: dir });
      expect(c.code, c.stderr).toBe(0);
      expect(c.json().sent.map((x: any) => x.command)).toEqual([{ type: 'setParams', params: { Lean: 1 } }, { type: 'pause' }, { type: 'message', text: 'hi' }]);
      // --anims takes layer strings; options attach to the layer before them.
      const layered = await run(['editor', 'command', '--url', url, '--model', 'model.r2d.json', '--anims', 'idle,idle@0.5,add,start=1', '--anims', 'idle,once,start=2', '--json'], { cwd: dir });
      expect(layered.code, layered.stderr).toBe(0);
      expect(layered.json().sent.map((x: any) => x.command)).toEqual([
        { type: 'setAnimations', animations: [{ id: 'idle' }, { id: 'idle', weight: 0.5, mode: 'add', start: 1 }, { id: 'idle', hold: false, start: 2 }] },
      ]);
      const fixedTime = await run(['editor', 'command', '--url', url, '--model', 'model.r2d.json', '--anims', 'idle,time=1'], { cwd: dir });
      expect(fixedTime.code).toBe(2);
      expect(fixedTime.stderr).toContain('error: --anims: "idle,time=1": the editor plays layers on its own clock, so time= is not supported');
      expect(fixedTime.stderr).toContain('hint: use start=<s> to delay the layer, e.g. "idle,start=1"');
      const badOption = await run(['editor', 'command', '--url', url, '--model', 'model.r2d.json', '--anims', 'idle,once'], { cwd: dir });
      expect(badOption.code).toBe(2);
      expect(badOption.stderr).toContain('error: --anims: "once" has no effect on looping animation "idle" without a start > 0');
      const badParam = await run(['editor', 'command', '--url', url, '--model', 'model.r2d.json', '--params', 'Laen=1'], { cwd: dir });
      expect(badParam.code).toBe(2);
      expect(badParam.stderr).toContain('did you mean "Lean"?');

      const shot = await run(['editor', 'screenshot', '--url', url, '-o', 'shot.png', '--overlay', 'bones', '--json'], { cwd: dir });
      expect(shot.code, shot.stderr).toBe(0);
      expect(shot.json()).toMatchObject({ width: 64, height: 64, source: 'editor-state', viewBox: [0, 0, 64, 64], scale: 1, time: 0, ignored: [] });
      expect(decodePNG(readFileSync(path.join(dir, 'shot.png'))).width).toBe(64);
      // Without --overlay the editor's overlays (bones) are drawn; "--overlay none" really turns them off.
      await run(['editor', 'screenshot', '--url', url, '-o', 'seen.png'], { cwd: dir });
      await run(['editor', 'screenshot', '--url', url, '-o', 'clean.png', '--overlay', 'none', '--viewbox', 'canvas'], { cwd: dir });
      const plain = await run(['render', 'model.r2d.json', '-o', 'plain.png', '--param', 'Lean=0.5'], { cwd: dir });
      expect(plain.code).toBe(0);
      const pixels = (f: string) => Buffer.from(decodePNG(readFileSync(path.join(dir, f))).data);
      const same = (a: string, b: string) => pixels(a).equals(pixels(b));
      expect(same('clean.png', 'plain.png')).toBe(true);
      expect(same('seen.png', 'plain.png')).toBe(false);
      expect(same('seen.png', 'shot.png')).toBe(true);

      // A second editor for the same model is allowed, with a note pointing at the first one.
      const second = start(['edit', 'model.r2d.json', '--port', '0', '--no-open', '--json'], dir);
      await until(() => second.buf.stdout.includes('listening') || second.buf.stderr.includes('error:'), 'the second editor', 60000);
      expect(second.buf.stderr).toContain(`model.r2d.json is already open in an editor at ${url}`);
      expect(await second.stop()).toBe(0);

      // Server-side failures keep their hint and diagnostics.
      const broken = blankModel({ name: 'live', width: 64, height: 64 }) as any;
      broken.parts[0].parent = 'nowhere';
      writeFileSync(path.join(dir, 'model.r2d.json'), formatModelJson(broken));
      const failed = await run(['editor', 'screenshot', '--url', url, '-o', 'broken.png', '--json'], { cwd: dir });
      expect(failed.code).toBe(1);
      const error = failed.stdout.trim().split('\n').map((l) => JSON.parse(l)).at(-1).error;
      expect(error.message).toContain('the editor could not take a screenshot (422)');
      expect(error.hint).toBeTruthy();
      expect(error.diagnostics[0]).toMatchObject({ severity: 'error', path: '/parts/0/parent' });
      expect(failed.stderr).toContain('/parts/0/parent');
    } finally {
      expect(await e.stop()).toBe(0);
    }
    expect(events().at(-1)).toEqual({ event: 'stopped' });
  });
});

// ----------------------------------------------------------------------------- round 2: layers, sampling, analysis

/** Two-bone IK arm (target bound to Reach, out of reach at Reach=1), clamping physics (Sway), events, a one-shot. */
function rigDoc(): Record<string, any> {
  return {
    format: 'rev2d',
    version: 1,
    meta: { name: 'rig', width: 200, height: 200 },
    parameters: [
      { id: 'Reach', min: -1, max: 1 },
      { id: 'Sway', min: -1, max: 1 },
      { id: 'Blink', min: 0, max: 1 },
    ],
    bones: [
      { id: 'root', x: 100, y: 100 },
      { id: 'upper', parent: 'root', length: 40 },
      { id: 'lower', parent: 'upper', x: 40, length: 40 },
      { id: 'target', x: 160, y: 100 },
      { id: 'tail', x: 30, y: 150, length: 20 },
    ],
    parts: [
      { id: 'arm', parent: 'lower', shape: { type: 'rect', x: 140, y: 95, w: 40, h: 10 }, fill: '#ff0000' },
      { id: 'dot', parent: 'target', shape: { type: 'ellipse', cx: 160, cy: 100, rx: 4, ry: 4 }, fill: '#00ff00' },
      { id: 'tailTip', parent: 'tail', shape: { type: 'ellipse', cx: 50, cy: 150, rx: 5, ry: 5 }, fill: '#0000ff' },
      { id: 'lid', shape: { type: 'rect', x: 10, y: 10, w: 20, h: 10 }, fill: '#888888' },
      { id: 'sleeve', shape: { type: 'rect', x: 100, y: 97, w: 80, h: 6, detail: 10 }, skin: { bones: ['upper', 'lower'] }, fill: '#ffaa00' },
    ],
    bindings: [
      { target: 'bone:target.x', params: ['Reach'], keys: [{ at: [-1], value: 100 }, { at: [1], value: 220 }] },
      { target: 'bone:tail.rotation', params: ['Sway'], keys: [{ at: [-1], value: -45 }, { at: [1], value: 45 }] },
      { target: 'part:lid.opacity', params: ['Blink'], keys: [{ at: [0], value: 0 }, { at: [1], value: 1 }] },
    ],
    ik: [{ id: 'armIk', bones: ['upper', 'lower'], target: 'target', softness: 0 }],
    physics: [{ id: 'swing', inputs: [{ param: 'Reach', type: 'x', weight: 60 }], outputs: [{ param: 'Sway', type: 'angle', scale: 0.2 }], segments: [{ length: 30 }] }],
    animations: [
      {
        id: 'reach',
        duration: 2,
        tracks: [{ target: 'param:Reach', keys: [{ t: 0, v: -1 }, { t: 1, v: 1 }, { t: 2, v: 0 }] }],
        events: [{ t: 0.5, name: 'half' }, { t: 1.5, name: 'late' }],
      },
      { id: 'wave', duration: 1, tracks: [{ target: 'param:Reach', keys: [{ t: 0, v: 0 }, { t: 0.5, v: 0.5 }, { t: 1, v: 0 }] }] },
      {
        id: 'wink',
        duration: 0.5,
        loop: false,
        tracks: [{ target: 'param:Blink', keys: [{ t: 0, v: 0 }, { t: 0.25, v: 1 }, { t: 0.5, v: 0 }] }],
        events: [{ t: 0.25, name: 'shut' }],
      },
    ],
  };
}

describe('render notes and view split', () => {
  let dir: string;
  beforeAll(() => {
    dir = workspace(rigDoc());
  });

  it('splits visible parts into in view / outside the view box and notes IK and physics', async () => {
    const r = await run(['render', 'model.r2d.json', '-o', 'a.png', '--param', 'Reach=1', '--viewbox', '0,0,120,200', '--json'], { cwd: dir });
    expect(r.code, r.stderr).toBe(0);
    const j = r.json();
    expect(j.inView).toEqual(['tailTip', 'sleeve']);
    expect(j.outsideView).toEqual(['arm', 'dot']);
    expect(j.visibleParts).toEqual(['arm', 'dot', 'tailTip', 'sleeve']);
    expect(j.notes).toContain(
      'IK "armIk": target out of reach in this frame; extension 1.5, the chain tip misses the target by 40 px and the chain snaps straight. Move the target closer, lengthen the bones, or set "stretch": true',
    );
    // A deliberate --viewbox crop: the split is reported, but no note about the parts it leaves out.
    expect(j.notes.some((n: string) => n.includes('entirely outside the view box'))).toBe(false);
    const t = await run(['render', 'model.r2d.json', '-o', 'a.png', '--param', 'Reach=1', '--viewbox', '0,0,120,200'], { cwd: dir });
    expect(t.stdout).toContain('visible parts in view (2, back to front): tailTip, sleeve');
    expect(t.stdout).toContain('visible parts outside the view box (2): arm, dot');
    expect(t.stderr).not.toContain('entirely outside the view box');
    // The default canvas view box notes parts that left it (the target dot at x = 216..224 of 200).
    const canvas = (await run(['render', 'model.r2d.json', '-o', 'a.png', '--param', 'Reach=1', '--json'], { cwd: dir })).json();
    expect(canvas.outsideView).toEqual(['dot']);
    expect(canvas.notes).toContain('visible parts entirely outside the view box: dot; use a "fit" view box (--viewbox fit) to include them');
    // An explicit crop that misses everything visible is still noted.
    const miss = (await run(['render', 'model.r2d.json', '-o', 'a.png', '--viewbox', '300,300,10,10', '--json'], { cwd: dir })).json();
    expect(miss.inView).toEqual([]);
    expect(miss.notes.some((n: string) => /^the visible parts \[[^\]]+\] lie entirely outside the view box; use a "fit" view box \(--viewbox fit\)$/.test(n))).toBe(true);
    expect(t.stderr).toContain('note: IK "armIk": target out of reach');
    // Clamped physics outputs are noted with their raw value.
    const p = await run(['render', 'model.r2d.json', '-o', 'b.png', '--anim', 'reach', '--time', '0.5', '--json'], { cwd: dir });
    expect(p.json().notes.some((n: string) => /^physics "swing": Sway clamped in this frame; raw output -?[\d.]+ vs range -1\.\.1/.test(n))).toBe(true);
    // Everything in view: one line as before.
    const all = await run(['render', 'model.r2d.json', '-o', 'c.png'], { cwd: dir });
    expect(all.stdout).toContain('visible parts (4, back to front): arm, dot, tailTip, sleeve');
  });

  it('accepts the layer syntax and overlay focus', async () => {
    const r = await run(['render', 'model.r2d.json', '-o', 'l.png', '--anim', 'reach', '--anim', 'wave@0.5,add', '--anim', 'wink,once,start=1', '--time', '1.2', '--overlay', 'bones,labels', '--only', 'lower', '--only-chain', '--json'], { cwd: dir });
    expect(r.code, r.stderr).toBe(0);
    expect(r.json().params.Blink).toBeGreaterThan(0.5);
    const bad = await run(['render', 'model.r2d.json', '-o', 'l.png', '--anim', 'reach,once'], { cwd: dir });
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('error: --anim: "once" has no effect on looping animation "reach" without a start > 0');
    expect(bad.stderr).toContain('hint: to start the loop later, give a start: "reach,once,start=2"');
  });
});

describe('sheet: overview, linked sweeps, windows, warm-up, events', () => {
  let dir: string;
  beforeAll(() => {
    const doc = rigDoc();
    doc.parameters.push({ id: 'Blink2', min: 0, max: 1 });
    dir = workspace(doc);
  });

  it('overview: one row per parameter', async () => {
    const r = await run(['sheet', 'model.r2d.json', '-o', 'ov.png', '--overview', '--steps', '3', '--scale', '0.2', '--json'], { cwd: dir });
    expect(r.code, r.stderr).toBe(0);
    expect(r.json()).toMatchObject({ mode: 'overview', cells: 12, columns: 3, overview: { params: ['Reach', 'Sway', 'Blink', 'Blink2'], steps: 3 }, title: 'rig - overview: 4 parameters x 3 steps' });
    const some = await run(['sheet', 'model.r2d.json', '-o', 'ov2.png', '--overview', 'Reach,Blink', '--scale', '0.2'], { cwd: dir });
    expect(some.code, some.stderr).toBe(0);
    expect(some.stdout).toContain('10 cells, 5 per row');
    expect(some.stdout).toContain('cells: Reach, Blink (5 steps each)');
    // Without --scale a sheet larger than 4096 px is drawn smaller (200 px cells x 30 columns = 6248 px).
    const big = await run(['sheet', 'model.r2d.json', '-o', 'big.png', '--overview', 'Reach', '--steps', '30', '--json'], { cwd: dir });
    expect(big.code, big.stderr).toBe(0);
    expect(big.json().width).toBeLessThanOrEqual(4096);
    expect(big.json().scale).toBeLessThan(1);
    expect(big.json().notes.join('\n')).toMatch(/^cells are drawn at scale 0\.\d+ so the 30-cell sheet fits 4096 px per side \(at scale 1 it would be 6248x\d+ px\); set scale explicitly \(--scale\)/m);
    const text = await run(['sheet', 'model.r2d.json', '-o', 'big.png', '--overview', 'Reach', '--steps', '30'], { cwd: dir });
    expect(text.stdout).toMatch(/30 cells, 30 per row, cell viewBox 0,0,200,200, scale 0\.\d+\)/);
  });

  it('linked sweeps give several parameters the same values', async () => {
    const r = await run(['sheet', 'model.r2d.json', '-o', 'ln.png', '--sweep', 'Blink,Blink2=0:1:3', '--scale', '0.2', '--json'], { cwd: dir });
    expect(r.code, r.stderr).toBe(0);
    expect(r.json()).toMatchObject({ mode: 'sweep', cells: 3, sweeps: [{ param: 'Blink', values: [0, 0.5, 1], linked: ['Blink2'] }], title: 'rig - sweep Blink,Blink2' });
    const t = await run(['sheet', 'model.r2d.json', '-o', 'ln.png', '--sweep', 'Blink,Blink2=0,1', '--scale', '0.2'], { cwd: dir });
    expect(t.stdout).toContain('cells: Blink,Blink2=0,1');
    const bad = await run(['sheet', 'model.r2d.json', '-o', 'ln.png', '--sweep', 'Blink,Reach'], { cwd: dir });
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('have different ranges');
  });

  it('animation sheets: window, explicit times, warm-up, events and layers in the title', async () => {
    const r = await run(['sheet', 'model.r2d.json', '-o', 'an.png', '--anim', 'reach', '--anim', 'wave@0.5,add', '--frames', '4', '--scale', '0.2', '--json'], { cwd: dir });
    expect(r.code, r.stderr).toBe(0);
    const j = r.json();
    expect(j).toMatchObject({ mode: 'animation', animation: 'reach', layers: ['wave@0.5,add'], times: [0, 0.5, 1, 1.5], warmup: 0, title: 'rig - reach + wave@0.5(add)' });
    expect(j.events).toEqual([
      { cell: 1, animation: 'reach', name: 'half', t: 0.5 },
      { cell: 3, animation: 'reach', name: 'late', t: 1.5 },
    ]);
    expect(j.notes.some((n: string) => n.startsWith('IK "armIk": target out of reach in'))).toBe(true);
    const w = await run(['sheet', 'model.r2d.json', '-o', 'w.png', '--anim', 'reach', '--from', '0.5', '--to', '1.5', '--frames', '3', '--warmup', '3', '--scale', '0.2', '--json'], { cwd: dir });
    expect(w.code, w.stderr).toBe(0);
    expect(w.json()).toMatchObject({ times: [0.5, 1, 1.5], warmup: 4, title: 'rig - reach t=0.5..1.5s after 4s warm-up' });
    const t = await run(['sheet', 'model.r2d.json', '-o', 't.png', '--anim', 'wink', '--times', '0:0.5:3', '--scale', '0.2'], { cwd: dir });
    expect(t.code, t.stderr).toBe(0);
    expect(t.stdout).toContain('wink at t=0,0.25,0.5s');
    expect(t.stdout).toContain('events: wink:shut@0.25s (cell 1)');
    const once = await run(['sheet', 'model.r2d.json', '-o', 't.png', '--anim', 'wink', '--warmup', '1'], { cwd: dir });
    expect(once.code).toBe(2);
    expect(once.stderr).toContain('warmup only applies to looping animations: "wink" does not loop');
    const time = await run(['sheet', 'model.r2d.json', '-o', 't.png', '--anim', 'reach', '--time', '1'], { cwd: dir });
    expect(time.code).toBe(2);
    expect(time.stderr).toContain('hint: choose the window with --from/--to, the count with --frames, or list --times a:b:n');
  });
});

describe('gif and frames sampling windows', () => {
  let dir: string;
  beforeAll(() => {
    dir = workspace(rigDoc());
  });

  it('samples --from/--to, --times and --warmup; --time is rejected and not advertised', async () => {
    const g = await run(['gif', 'model.r2d.json', '-o', 'a.gif', '--anim', 'reach', '--from', '0.5', '--to', '1.5', '--frames', '3', '--scale', '0.2', '--json'], { cwd: dir });
    expect(g.code, g.stderr).toBe(0);
    expect(g.json()).toMatchObject({ frames: 3, times: [0.5, 1, 1.5], fps: 2, warmup: 0 });
    expect(g.json().notes.some((n: string) => n.startsWith('IK "armIk"'))).toBe(true);
    const f = await run(['frames', 'model.r2d.json', '-o', 'seq', '--anim', 'reach', '--times', '0,0.25', '--warmup', '4', '--scale', '0.2', '--json'], { cwd: dir });
    expect(f.code, f.stderr).toBe(0);
    const manifest = JSON.parse(readFileSync(path.join(dir, 'seq', 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ animation: 'reach', times: [0, 0.25], warmup: 4, files: ['frame_0000.png', 'frame_0001.png'] });
    const t = await run(['gif', 'model.r2d.json', '-o', 'a.gif', '--anim', 'reach', '--time', '1'], { cwd: dir });
    expect(t.code).toBe(2);
    expect(t.stderr).toContain('--time does not apply here');
    expect(t.stderr).toContain('--from/--to');
    for (const cmd of ['gif', 'frames']) {
      const help = (await run(['help', cmd])).stdout;
      expect(help, cmd).not.toContain('--time ');
      expect(help, cmd).toContain('--from <seconds>');
      expect(help, cmd).toContain('--warmup <seconds>');
      expect(help, cmd).toContain('Sampling flags:');
    }
    const sheetHelp = (await run(['help', 'sheet'])).stdout;
    expect(sheetHelp).toContain('animation sheets reject it: use --from/--to or --times');
    const weight = await run(['frames', 'model.r2d.json', '-o', 'seq2', '--anim', 'reach,start=1'], { cwd: dir });
    expect(weight.code).toBe(2);
    expect(weight.stderr).toContain('cannot have its own clock');
  });
});

describe('inspect: IK, physics, points, series, tracks', () => {
  let dir: string;
  beforeAll(() => {
    dir = workspace(rigDoc());
  });

  it('prints IK, physics and point sections', async () => {
    const r = await run(['inspect', 'model.r2d.json', '--param', 'Reach=1', '--point', '180,100@lower', '--point', '5,5'], { cwd: dir });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('IK (extension = distance / max reach');
    expect(r.stdout).toMatch(/armIk\s+upper>lower\s+NO\s+1\.5 !\s+40/);
    expect(r.stdout).toContain('PHYSICS (raw output before clamping');
    expect(r.stdout).toContain('POINTS (setup-space point -> posed position)');
    expect(r.stdout).toContain('180,100@lower  (180, 100) -> (180, 100)');
    const j = (await run(['inspect', 'model.r2d.json', '--param', 'Reach=0', '--point', '180,100@lower', '--bone', 'lower', '--json'], { cwd: dir })).json();
    expect(j.points).toEqual([{ spec: '180,100@lower', parent: 'lower', setup: [180, 100], posed: [160, 100] }]);
    expect(j.ik[0]).toMatchObject({ id: 'armIk', reached: true, extension: 0.75 });
    expect(j.physics[0].id).toBe('swing');
    const bad = await run(['inspect', 'model.r2d.json', '--point', '1,2@nowhere'], { cwd: dir });
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('unknown point parent "nowhere"');
    expect(bad.stderr).toContain('hint: available bones, warps or parts: root, upper, lower, target, tail, arm, dot, tailTip, lid, sleeve');
    expect((await run(['inspect', 'model.r2d.json', '--point', '1,2@sleve'], { cwd: dir })).stderr).toContain('hint: did you mean "sleeve"?');
  });

  it('maps points through parts: skinned parts blend their bones, "part:" picks the kind', async () => {
    const pts = ['150,100@sleeve', '150,100@part:sleeve', '150,100@lower', '150,100@upper', '150,100@arm'];
    const r = await run(['inspect', 'model.r2d.json', '--param', 'Reach=0', '--json', ...pts.flatMap((p) => ['--point', p])], { cwd: dir });
    expect(r.code, r.stderr).toBe(0);
    const [skinned, prefixed, lower, upper, arm] = r.json().points as Array<{ spec: string; parent: string; posed: [number, number] }>;
    expect(skinned).toMatchObject({ spec: '150,100@sleeve', parent: 'sleeve', setup: [150, 100] });
    expect(prefixed).toMatchObject({ spec: '150,100@part:sleeve', parent: 'part:sleeve', posed: skinned.posed });
    // Linear blend skinning: between the rigid mappings of its two bones, closer to the lower bone it lies on.
    const w = (skinned.posed[1] - lower.posed[1]) / (upper.posed[1] - lower.posed[1]);
    expect(w).toBeGreaterThan(0);
    expect(w).toBeLessThan(0.5);
    // A part with a parent bone maps like that bone.
    expect(arm.posed).toEqual(lower.posed);
    const text = await run(['inspect', 'model.r2d.json', '--param', 'Reach=0', '--point', '150,100@sleeve'], { cwd: dir });
    expect(text.stdout).toContain(`150,100@sleeve  (150, 100) -> (${skinned.posed.map((v) => Number(v.toFixed(2))).join(', ')})`);
  });

  it('labels soft and aim IK rows instead of calling them unreached', async () => {
    const doc = rigDoc();
    doc.ik[0].softness = 10;
    doc.ik.push({ id: 'tailAim', bones: ['tail'], target: 'target' });
    const soft = workspace(doc);
    // Reach=0: target 60 px away, reach 80, softness 10: within reach, the tip trails slightly only near full reach.
    const near = await run(['inspect', 'model.r2d.json', '--param', 'Reach=0.25'], { cwd: soft });
    expect(near.code, near.stderr).toBe(0);
    expect(near.stdout).toContain('reached: yes | NO (target out of reach) | soft (within reach; softness lets the tip trail) | aim (one bone: points at the target)');
    expect(near.stdout).toMatch(/armIk\s+upper>lower\s+soft\s+0\.9/);
    expect(near.stdout).toMatch(/tailAim\s+tail\s+aim\s/);
    expect((await run(['inspect', 'model.r2d.json', '--param', 'Reach=1'], { cwd: soft })).stdout).toMatch(/armIk\s+upper>lower\s+NO\s+1\.5/);
  });

  it('series: --times and --frames give one result per time', async () => {
    const r = await run(['inspect', 'model.r2d.json', '--anim', 'reach', '--times', '0:1:3', '--bone', 'target', '--json'], { cwd: dir });
    expect(r.code, r.stderr).toBe(0);
    const j = r.json();
    expect(j.times).toEqual([0, 0.5, 1]);
    expect(j.results.map((x: any) => x.bones[0].x)).toEqual([100, 160, 220]);
    expect(j.results[1].events).toEqual([{ animation: 'reach', name: 'half', t: 0.5 }]);
    const t = await run(['inspect', 'model.r2d.json', '--anim', 'reach', '--frames', '2', '--part', 'dot'], { cwd: dir });
    expect(t.stdout).toContain('=== t=0s (1 of 2) ===');
    expect(t.stdout).toContain('=== t=1s (2 of 2) ===');
    for (const [flags, message] of [
      [['--times', '0,1', '--time', '1'], '--time sets one time; a series (--times/--frames) sets them all'],
      [['--times', '0,1', '--frames', '2'], 'give --times or --frames, not both'],
      [['--frames', '2'], '--frames samples the first --anim, but no --anim is given'],
      [['--times', '1:0:2'], 'bad --times "1:0:2": end 0 is before start 1'],
    ] as Array<[string[], string]>) {
      const e = await run(['inspect', 'model.r2d.json', ...flags], { cwd: dir });
      expect(e.code, flags.join(' ')).toBe(2);
      expect(e.stderr, flags.join(' ')).toContain(message);
    }
  });

  it('--track prints a compact table (or {times, columns, fields, rows})', async () => {
    const r = await run(['inspect', 'model.r2d.json', '--anim', 'reach', '--times', '0.5,1', '--track', 'ik:armIk,param:Reach', '--track', 'point:180,100@lower,bone:target.x', '--json'], { cwd: dir });
    expect(r.code, r.stderr).toBe(0);
    expect(r.json()).toEqual({
      times: [0.5, 1],
      columns: ['ik:armIk', 'param:Reach', 'point:180,100@lower', 'bone:target.x'],
      fields: { 'ik:armIk': ['extension', 'error'], 'point:180,100@lower': ['x', 'y'] },
      rows: [
        [[0.75, 0], 0, [160, 100], 160],
        [[1.5, 40], 1, [180, 100], 220],
      ],
    });
    const t = await run(['inspect', 'model.r2d.json', '--param', 'Reach=0', '--track', 'param:Reach,bone:target'], { cwd: dir });
    expect(t.code, t.stderr).toBe(0);
    expect(t.stdout.split('\n')[0]).toMatch(/^t\s+param:Reach\s+bone:target \(x, y, rotation\)$/);
    expect(t.stdout.split('\n')[1]).toMatch(/^0\s+0\s+160, 100, 0$/);
    const bad = await run(['inspect', 'model.r2d.json', '--track', 'param:Rech'], { cwd: dir });
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('--track: bad track column "param:Rech": unknown parameter "Rech"');
    expect(bad.stderr).toContain('did you mean "Reach"?');
    const mixed = await run(['inspect', 'model.r2d.json', '--track', 'param:Reach', '--bone', 'root'], { cwd: dir });
    expect(mixed.code).toBe(2);
    expect(mixed.stderr).toContain('--track prints only its columns');
  });
});

describe('analyze', () => {
  let dir: string;
  beforeAll(() => {
    dir = workspace(rigDoc());
  });

  it('reports ranges, physics, IK, events, the seam and the canvas', async () => {
    const r = await run(['analyze', 'model.r2d.json', '--anim', 'reach', '--fps', '10'], { cwd: dir });
    expect(r.code, r.stderr).toBe(0);
    for (const s of [
      'analysis of reach (2s loop): 20 frames over t=0..2s',
      'PARAMETERS (min..max over the frames, [range])',
      'Reach  -1..1  [-1..1]  reaches min, reaches max',
      'swing: Sway clamped in',
      'armIk: max extension 1.5 at t=1s',
      'reach:half  t=0.5s',
      'LOOP SEAM',
      'param Reach: 0 at the end -> -1 at the start (jump -1)',
      'dot leaves the canvas',
      'NOTES',
      '--warmup 10',
    ]) {
      expect(r.stdout, s).toContain(s);
    }
    const j = (await run(['analyze', 'model.r2d.json', '--anim', 'reach', '--anim', 'wave@0.5,add', '--frames', '8', '--warmup', '4', '--no-pixels', '--param', 'Blink=2', '--json'], { cwd: dir })).json();
    expect(j).toMatchObject({ animation: 'reach', layers: ['wave@0.5(add)'], frames: 8, warmup: 4, loop: true });
    expect(Object.keys(j).sort()).toEqual(['animation', 'bounds', 'canvas', 'duration', 'events', 'fps', 'frames', 'ik', 'layers', 'loop', 'notes', 'outsideCanvas', 'params', 'physics', 'seam', 'warmup', 'window']);
    expect(j.seam.pixels).toBeNull();
    expect(j.notes[0]).toBe('--param Blink=2 is outside its range [0..1] and is clamped to 1');
  });

  it('rejects bad requests with usage errors', async () => {
    for (const [flags, message] of [
      [[], 'missing --anim <id>'],
      [['--anim', 'reach', '--time', '1'], '--time does not apply to analyze'],
      [['--anim', 'wink', '--warmup', '2'], 'warmup only applies to looping animations'],
      [['--anim', 'reach@0.5'], 'the sampled animation plays at full weight here; use --anim reach'],
      [['--anim', 'reach', '--frames', '4', '--fps', '10'], 'give --frames or --fps, not both'],
    ] as Array<[string[], string]>) {
      const r = await run(['analyze', 'model.r2d.json', ...flags], { cwd: dir });
      expect(r.code, flags.join(' ')).toBe(2);
      expect(r.stderr, flags.join(' ')).toContain(message);
    }
    expect((await run(['help'])).stdout).toContain('analyze');
  });
});

describe('ops with several files', () => {
  it('applies every file in order as one atomic batch', async () => {
    const dir = workspace();
    writeFileSync(path.join(dir, 'a.json'), JSON.stringify([{ op: 'set', target: 'bone:root.x', value: 10 }]));
    writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ ops: [{ op: 'set', target: 'bone:root.x', value: 20 }, { op: 'set', target: 'bone:root.y', value: 5 }] }));
    const r = await run(['ops', 'model.r2d.json', 'a.json', 'b.json', '--op', '{"op":"set","target":"part:eye.opacity","value":0.5}', '--json'], { cwd: dir });
    expect(r.code, r.stderr).toBe(0);
    expect(r.json().results.map((x: any) => [x.index, x.source])).toEqual([
      [0, 'a.json'],
      [1, 'b.json'],
      [2, 'b.json'],
      [3, '--op #1'],
    ]);
    expect(readModel(dir).bones[0]).toMatchObject({ x: 20, y: 5 });
    // One failing op in the second file: nothing is written; the text names the file of each op.
    const before = readFileSync(path.join(dir, 'model.r2d.json'), 'utf8');
    writeFileSync(path.join(dir, 'c.json'), JSON.stringify([{ op: 'set', target: 'bone:nope.x', value: 1 }]));
    const f = await run(['ops', 'model.r2d.json', 'a.json', 'c.json'], { cwd: dir });
    expect(f.code).toBe(1);
    expect(f.stdout).toMatch(/FAIL\s+#1\s+c\.json\s+set/);
    expect(readFileSync(path.join(dir, 'model.r2d.json'), 'utf8')).toBe(before);
    // A single source keeps the old result shape (no "source").
    const one = await run(['ops', 'model.r2d.json', 'a.json', '--json', '--dry-run'], { cwd: dir });
    expect(one.json().results[0].source).toBeUndefined();
    const twice = await run(['ops', 'model.r2d.json', '-', '-'], { cwd: dir, stdin: '[]' });
    expect(twice.code).toBe(2);
    expect(twice.stderr).toContain('"-" (stdin) can be given only once');
  });
});

describe('error reporting', () => {
  it('prints ApiError hints in text and JSON', () => {
    const { buf, io } = capture();
    const code = report(new ApiError('unknown thing "x"', [], 'did you mean "y"?'), { ...io, cwd: root }, true, null);
    expect(code).toBe(1);
    expect(buf.stderr).toContain('error: unknown thing "x"\nhint: did you mean "y"?');
    expect(JSON.parse(buf.stdout)).toEqual({ ok: false, exitCode: 1, error: { kind: 'failed', message: 'unknown thing "x"', hint: 'did you mean "y"?' } });
  });
});

describe('docs topics, templates and info', () => {
  it('prints the recipes and architecture docs', async () => {
    const list = await run(['docs']);
    expect(list.stdout).toContain('recipes');
    expect(list.stdout).toContain('architecture');
    const recipes = await run(['docs', 'recipes']);
    expect(recipes.code).toBe(0);
    expect(recipes.stdout).toBe(readFileSync(path.join(PACKAGE_ROOT, 'docs/RECIPES.md'), 'utf8'));
    expect((await run(['docs', 'architecture'])).stdout).toBe(readFileSync(path.join(PACKAGE_ROOT, 'docs/ARCHITECTURE.md'), 'utf8'));
    expect((await run(['docs', 'recipe'])).stderr).toContain('did you mean "recipes"?');
  });

  it('describes the recipes topic with every numbered recipe heading of docs/RECIPES.md', async () => {
    const md = readFileSync(path.join(PACKAGE_ROOT, 'docs/RECIPES.md'), 'utf8');
    const headings = [...md.matchAll(/^## (\d+)\. (.+)$/gm)];
    expect(headings.length).toBeGreaterThan(10);
    const entry = (await run(['docs', '--json'])).json().find((t: any) => t.topic === 'recipes');
    expect(entry.description).toBe(recipesDescription(md));
    expect(entry.description).toContain(`(${headings.length} recipes: `);
    // Every recipe, in file order, named by its heading up to ": ".
    const names = headings.map((h) => h[2].split(': ')[0]);
    let at = 0;
    for (const name of names) {
      const i = entry.description.toLowerCase().indexOf(name.toLowerCase(), at);
      expect(i, name).toBeGreaterThan(at - 1);
      at = i + name.length;
    }
    // Text mode: the long description wraps under its column instead of running off.
    const list = (await run(['docs'])).stdout.split('\n');
    const row = list.findIndex((l: string) => l.startsWith('  recipes '));
    const column = list[row].indexOf('task-oriented');
    expect(list[row + 1].slice(0, column).trim()).toBe('');
    expect(list[row + 1].length).toBeGreaterThan(column);
    for (const l of list) expect(l.length).toBeLessThanOrEqual(120);
  });

  it('creates an empty model (format, version, meta) with a size', async () => {
    const dir = workspace();
    const r = await run(['new', 'e.r2d.json', '--template', 'empty', '--size', '300x100', '--json'], { cwd: dir });
    expect(r.code, r.stderr).toBe(0);
    expect(readModel(dir, 'e.r2d.json')).toEqual({ format: 'rev2d', version: 1, meta: { name: 'e', width: 300, height: 100 } });
    expect(r.json().next[0]).toBe('rev2d docs ops');
    const docs = await run(['docs', 'examples']);
    expect(docs.stdout).toContain('## empty  (generated, 512x512)');
  });

  it('info lists skinned parts under their bones and the IK options', async () => {
    const dir = workspace(rigDoc());
    const r = await run(['info', 'model.r2d.json'], { cwd: dir });
    expect(r.stdout).toContain('upper (0, 0) 0° len 40  <- skin:sleeve');
    expect(r.stdout).toContain('armIk: upper -> lower reaching target (mix 1, bendPositive true, stretch false, softness 0)');
    const j = (await run(['info', 'model.r2d.json', '--json'], { cwd: dir })).json();
    expect(j.ik[0]).toEqual({ id: 'armIk', bones: ['upper', 'lower'], target: 'target', mix: 1, bendPositive: true, stretch: false, softness: 0 });
  });
});
