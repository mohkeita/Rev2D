/**
 * rev2d import spine | import live2d | export spine | export live2d, run in-process through main():
 * files written, text and --json output, reports, exit codes and usage errors. Hand-written fixtures
 * (the Spine importer's hero skeleton, a generated atlas page, small motion3 files).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/cli/main.js';
import { PACKAGE_ROOT } from '../src/api/templates.js';
import { createImage, encodePNG } from '../src/render/index.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'rev2d-interop-cli-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

const SPINE_FIXTURES = path.join(PACKAGE_ROOT, 'src', 'interop', 'spine', '__tests__', 'fixtures');
const LIVE2D_FIXTURES = path.join(PACKAGE_ROOT, 'src', 'interop', 'live2d', '__tests__', 'fixtures', 'mini');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  json(): any;
}

async function run(args: string[], cwd: string): Promise<RunResult> {
  const buf = { stdout: '', stderr: '' };
  const code = await main(args, {
    stdout: { write: (s: string) => ((buf.stdout += s), true) },
    stderr: { write: (s: string) => ((buf.stderr += s), true) },
    cwd,
  });
  return { code, ...buf, json: () => JSON.parse(buf.stdout) };
}

/** A workspace with a Spine export in spine/ (hero.json, hero.atlas, hero.png). */
function workspace(): string {
  const dir = path.join(root, `ws${n++}`);
  mkdirSync(path.join(dir, 'spine'), { recursive: true });
  copyFileSync(path.join(SPINE_FIXTURES, 'hero-4x.json'), path.join(dir, 'spine', 'hero.json'));
  copyFileSync(path.join(SPINE_FIXTURES, 'hero.atlas'), path.join(dir, 'spine', 'hero.atlas'));
  writeFileSync(path.join(dir, 'spine', 'hero.png'), encodePNG(createImage(64, 32, '#ffffffff')));
  return dir;
}

/** motion3.json moving AngleX 0 -> 10 -> 0 over 1 s (linear), plus optional extra curves. */
function motion3(extra: unknown[] = []): string {
  const curves = [{ Target: 'Parameter', Id: 'ParamAngleX', Segments: [0, 0, 0, 0.5, 10, 0, 1, 0] }, ...extra];
  return JSON.stringify({
    Version: 3,
    Meta: { Duration: 1, Fps: 30, Loop: true, AreBeziersRestricted: true, CurveCount: curves.length, TotalSegmentCount: 2, TotalPointCount: 3, UserDataCount: 0, TotalUserDataSize: 0 },
    Curves: curves,
  });
}

const animationIds = (file: string) => (JSON.parse(readFileSync(file, 'utf8')).animations ?? []).map((a: { id: string }) => a.id);

describe('rev2d import / export: help and dispatch', () => {
  it('lists the subcommands and suggests a misspelled one', async () => {
    const help = await run(['help', 'import'], root);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('spine');
    expect(help.stdout).toContain('live2d');
    expect((await run(['help'], root)).stdout).toContain('Import & export (Spine, Live2D):');
    const typo = await run(['export', 'spin', 'm.r2d.json'], root);
    expect(typo.code).toBe(2);
    expect(typo.stderr).toContain('did you mean "spine"?');
    expect((await run(['import'], root)).code).toBe(2);
    expect((await run(['help', 'export', 'live2d'], root)).stdout).toContain('--param-map');
  });

  it('serves docs/INTEROP.md as the interop docs topic', async () => {
    const r = await run(['docs', 'interop'], root);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(readFileSync(path.join(PACKAGE_ROOT, 'docs', 'INTEROP.md'), 'utf8'));
    expect(r.stdout).toContain('.moc3');
    const list = (await run(['docs', '--json'], root)).json();
    expect(list.find((t: { topic: string }) => t.topic === 'interop')).toMatchObject({ available: true });
  });
});

describe('rev2d import spine', () => {
  it('writes the model and its atlas pages, prints the report and validates the result', { timeout: 180_000 }, async () => {
    const dir = workspace();
    const r = await run(['import', 'spine', 'spine/hero.json', '-o', 'models/hero.r2d.json'], dir);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('imported Spine skeleton spine/hero.json into models/hero.r2d.json: 12 bones, 9 parts, 2 animations');
    expect(r.stdout).toContain('wrote models/hero.r2d.json, models/textures/hero.png');
    expect(r.stdout).toMatch(/^report: \d+ warnings, \d+ info$/m);
    expect(r.stdout).toMatch(/^warnings:$/m);
    expect(r.stdout).toMatch(/^ {2}spine-dark-color +slots\[4\] \(head\): two-color tint/m);
    expect(r.stdout).toContain('validation: 0 errors, 0 warnings');
    expect(r.stdout).toContain('rev2d sheet models/hero.r2d.json -o models/hero-move.png --anim move --frames 8');
    const doc = JSON.parse(readFileSync(path.join(dir, 'models', 'hero.r2d.json'), 'utf8'));
    expect(doc.meta.name).toBe('hero');
    expect(doc.textures).toEqual([{ id: 'hero', path: 'textures/hero.png', width: 64, height: 32 }]);
    expect(existsSync(path.join(dir, 'models', 'textures', 'hero.png'))).toBe(true);
    // The written model renders.
    expect((await run(['render', 'models/hero.r2d.json', '-o', 'out/hero.png'], dir)).code).toBe(0);
  });

  it('refuses to overwrite without --force and prints JSON with --json', async () => {
    const dir = workspace();
    expect((await run(['import', 'spine', 'spine/hero.json', '-o', 'hero.r2d.json'], dir)).code).toBe(0);
    const again = await run(['import', 'spine', 'spine/hero.json', '-o', 'hero.r2d.json'], dir);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain('error: hero.r2d.json already exists\nhint: pass --force to overwrite it');
    const forced = await run(['import', 'spine', 'spine/hero.json', '-o', 'hero.r2d.json', '--force', '--name', 'Hero', '--json'], dir);
    expect(forced.code, forced.stderr).toBe(0);
    const j = forced.json();
    expect(j).toMatchObject({ ok: true, file: path.join(dir, 'hero.r2d.json'), sources: { atlas: path.join(dir, 'spine', 'hero.atlas') }, diagnostics: [] });
    expect(j.files.map((f: { status: string }) => f.status)).toEqual(['replaced', 'unchanged']);
    expect(j.report).toMatchObject({ format: 'spine', direction: 'import' });
    expect(j.report.issues.length).toBeGreaterThan(10);
    expect(JSON.parse(readFileSync(path.join(dir, 'hero.r2d.json'), 'utf8')).meta.name).toBe('Hero');
  });

  it('takes the atlas, skin, scale and padding options', async () => {
    const dir = workspace();
    rmSync(path.join(dir, 'spine', 'hero.atlas'));
    copyFileSync(path.join(SPINE_FIXTURES, 'hero.atlas'), path.join(dir, 'pages.atlas'));
    writeFileSync(path.join(dir, 'hero.png'), encodePNG(createImage(64, 32, '#ffffffff')));
    const r = await run(['import', 'spine', 'spine/hero.json', '-o', 'h.r2d.json', '--atlas', 'pages.atlas', '--skin', 'alt', '--scale', '2', '--padding', '0', '--json'], dir);
    expect(r.code, r.stderr).toBe(0);
    const j = r.json();
    expect(j.sources.atlas).toBe(path.join(dir, 'pages.atlas'));
    const doc = JSON.parse(readFileSync(path.join(dir, 'h.r2d.json'), 'utf8'));
    expect(doc.meta.description).toContain('skin "alt"');
    // A missing atlas imports untextured, with a note on stderr.
    rmSync(path.join(dir, 'pages.atlas'));
    const bare = await run(['import', 'spine', 'spine/hero.json', '-o', 'bare.r2d.json'], dir);
    expect(bare.code).toBe(0);
    expect(bare.stderr).toMatch(/note: no atlas found next to hero\.json/);
  });

  it('explains usage errors and unreadable inputs', async () => {
    const dir = workspace();
    const noOut = await run(['import', 'spine', 'spine/hero.json'], dir);
    expect(noOut.code).toBe(2);
    expect(noOut.stderr).toContain('missing output file: pass -o <file>');
    mkdirSync(path.join(dir, 'outdir'));
    expect((await run(['import', 'spine', 'spine/hero.json', '-o', 'outdir'], dir)).stderr).toContain('-o outdir is a directory');
    const missing = await run(['import', 'spine', 'spine/nope.json', '-o', 'x.r2d.json'], dir);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/error: skeleton not found: .*nope\.json/);
    copyFileSync(path.join(dir, 'spine', 'hero.atlas'), path.join(dir, 'spine', 'other.atlas'));
    rmSync(path.join(dir, 'spine', 'hero.atlas'));
    copyFileSync(path.join(dir, 'spine', 'other.atlas'), path.join(dir, 'spine', 'third.atlas'));
    const ambiguous = await run(['import', 'spine', 'spine/hero.json', '-o', 'x.r2d.json'], dir);
    expect(ambiguous.code).toBe(2);
    expect(ambiguous.stderr).toContain('several atlases next to hero.json (other.atlas, third.atlas)');
    expect((await run(['import', 'spine', 'spine/hero.json', '-o', 'x.r2d.json', '--scale', '0'], dir)).code).toBe(2);
    expect(existsSync(path.join(dir, 'x.r2d.json'))).toBe(false);
  });
});

describe('rev2d export spine', () => {
  it('writes the skeleton, atlas and pages with a report; re-exports report unchanged files', { timeout: 180_000 }, async () => {
    const dir = workspace();
    // A light model: the suite runs files in parallel, and Spine exports rasterize every part.
    expect((await run(['new', 'm.r2d.json', '--template', 'minimal'], dir)).code).toBe(0);
    const r = await run(['export', 'spine', 'm.r2d.json', '-o', 'out/m-spine', '--fps', '15'], dir);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^exported m\.r2d\.json to Spine in out\/m-spine: \d+ bones, \d+ slots, 1 animation, 1 atlas page$/m);
    // Files are named after meta.name ("m", from the file name given to rev2d new).
    expect(r.stdout).toMatch(/out\/m-spine\/m\.json +[\d.]+ kB +new/);
    expect(r.stdout).toContain('pages have premultiplied alpha (pma: true)');
    for (const f of ['m.json', 'm.atlas', 'm.png']) expect(existsSync(path.join(dir, 'out', 'm-spine', f)), f).toBe(true);
    const skeleton = JSON.parse(readFileSync(path.join(dir, 'out', 'm-spine', 'm.json'), 'utf8'));
    expect(skeleton.skeleton.spine).toBe('4.2.00');
    expect(readFileSync(path.join(dir, 'out', 'm-spine', 'm.atlas'), 'utf8')).toContain('pma: true');

    const again = await run(['export', 'spine', 'm.r2d.json', '-o', 'out/m-spine', '--fps', '15', '--json'], dir);
    expect(again.code).toBe(0);
    const j = again.json();
    expect(j.files.map((f: { status: string }) => f.status)).toEqual(['unchanged', 'unchanged', 'unchanged']);
    expect(j.report).toMatchObject({ format: 'spine', direction: 'export' });
  });

  it('exports chosen animations under another name, straight alpha', { timeout: 180_000 }, async () => {
    const dir = workspace();
    expect((await run(['new', 'm.r2d.json', '--template', 'minimal'], dir)).code).toBe(0);
    const anims = JSON.parse(readFileSync(path.join(dir, 'm.r2d.json'), 'utf8')).animations.map((a: { id: string }) => a.id);
    const r = await run(['export', 'spine', 'm.r2d.json', '-o', 'o', '--anim', anims[0], '--name', 'arm', '--straight-alpha', '--param-poses', '--json'], dir);
    expect(r.code, r.stderr).toBe(0);
    const skeleton = JSON.parse(readFileSync(path.join(dir, 'o', 'arm.json'), 'utf8'));
    const names = Object.keys(skeleton.animations);
    expect(names[0]).toBe(anims[0]);
    expect(names.some((a) => a.startsWith('param/'))).toBe(true);
    expect(readFileSync(path.join(dir, 'o', 'arm.atlas'), 'utf8')).not.toContain('pma: true');
  });

  it('checks animation ids and the model', async () => {
    const dir = workspace();
    expect((await run(['new', 'm.r2d.json'], dir)).code).toBe(0);
    const typo = await run(['export', 'spine', 'm.r2d.json', '-o', 'o', '--anim', 'idel'], dir);
    expect(typo.code).toBe(2);
    expect(typo.stderr).toContain('unknown animation "idel" in --anim\nhint: did you mean "idle"?');
    expect((await run(['export', 'spine', 'nope.r2d.json', '-o', 'o'], dir)).code).toBe(1);
    expect((await run(['export', 'spine', 'm.r2d.json'], dir)).code).toBe(2);
  });
});

describe('rev2d export live2d', () => {
  it('writes motions, physics, display info and a partial model3.json', async () => {
    const dir = workspace();
    expect((await run(['new', 'hana.r2d.json', '--template', 'hana'], dir)).code).toBe(0);
    const r = await run(['export', 'live2d', 'hana.r2d.json', '-o', 'l2d', '--anim', 'idle,blink'], dir);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('exported hana.r2d.json as Live2D JSON in l2d: 2 motions, 5 files');
    expect(r.stdout).toContain('merge the FileReferences (Motions, Physics, DisplayInfo) of l2d/hana.model3.json into its model3.json');
    const model3 = JSON.parse(readFileSync(path.join(dir, 'l2d', 'hana.model3.json'), 'utf8'));
    expect(model3.FileReferences.Motions.Idle).toEqual([{ File: 'motions/idle.motion3.json' }]);
    expect(model3.FileReferences.Moc).toBeUndefined();
    const idle = JSON.parse(readFileSync(path.join(dir, 'l2d', 'motions', 'idle.motion3.json'), 'utf8'));
    expect(idle.Curves.some((c: { Id: string }) => c.Id === 'ParamAngleX')).toBe(true);
    const none = await run(['export', 'live2d', 'hana.r2d.json', '-o', 'l2d-ids', '--anim', 'idle', '--param-map', 'none', '--json'], dir);
    const motion = JSON.parse(readFileSync(path.join(dir, 'l2d-ids', 'motions', 'idle.motion3.json'), 'utf8'));
    expect(motion.Curves.some((c: { Id: string }) => c.Id === 'AngleX')).toBe(true);
    expect(none.json().report.format).toBe('live2d-model3');
    const bad = await run(['export', 'live2d', 'hana.r2d.json', '-o', 'x', '--param-map', 'nope'], dir);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('parameter map "nope" is neither a preset nor a readable file');
  });
});

describe('rev2d import live2d', () => {
  it('imports a motion as an animation (dry run first), replacing one with the same id', async () => {
    const dir = workspace();
    expect((await run(['new', 'hana.r2d.json', '--template', 'hana'], dir)).code).toBe(0);
    const file = path.join(dir, 'hana.r2d.json');
    writeFileSync(path.join(dir, 'look.motion3.json'), motion3());
    const before = readFileSync(file, 'utf8');
    const dry = await run(['import', 'live2d', 'look.motion3.json', '--into', 'hana.r2d.json', '--dry-run'], dir);
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.stdout).toContain('import into hana.r2d.json (dry run): 1 animation (look)');
    expect(dry.stdout).toContain('dry run: nothing written; without --dry-run this would write hana.r2d.json');
    expect(readFileSync(file, 'utf8')).toBe(before);
    const r = await run(['import', 'live2d', 'look.motion3.json', '--into', 'hana.r2d.json'], dir);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('wrote hana.r2d.json');
    expect(animationIds(file)).toContain('look');
    const replaced = await run(['import', 'live2d', 'look.motion3.json', '--into', 'hana.r2d.json', '--id', 'idle', '--json'], dir);
    expect(replaced.code).toBe(0);
    const j = replaced.json();
    expect(j).toMatchObject({ ok: true, written: true, dryRun: false, summary: { animations: ['idle'], replaced: ['idle'] }, sources: [{ file: 'look.motion3.json', kind: 'motion3' }] });
    // hana's own "idle" was made in Rev2D: replacing it is a warning.
    const replacedIssue = (x: RunResult) => x.json().report.issues.find((i: { code: string }) => i.code === 'live2d-animation-replaced');
    expect(replacedIssue(replaced)).toMatchObject({ severity: 'warning', where: 'look.motion3.json' });
    expect(animationIds(file).filter((a: string) => a === 'idle')).toHaveLength(1);
    // The text output lists it first, under the warnings (here for hana's own "blink", as a dry run).
    const text = await run(['import', 'live2d', 'look.motion3.json', '--into', 'hana.r2d.json', '--id', 'blink', '--dry-run'], dir);
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toContain('1 animation (blink; replaced: blink)');
    expect(text.stdout).toMatch(/\nwarnings:\n {2}live2d-animation-replaced\s+look\.motion3\.json: animation "blink" .*→ .*rename/);
    // Importing again over an animation an earlier import wrote ("look", "idle" by now) is only noted.
    const again = await run(['import', 'live2d', 'look.motion3.json', '--into', 'hana.r2d.json', '--id', 'idle', '--json'], dir);
    expect(replacedIssue(again)).toMatchObject({ severity: 'info', where: 'look.motion3.json' });
    expect((await run(['validate', 'hana.r2d.json'], dir)).code).toBe(0);
  });

  it('imports a model3.json with the files it lists (physics, expressions, names), mapping ids with a map file', async () => {
    const dir = workspace();
    expect((await run(['new', 'hana.r2d.json', '--template', 'hana'], dir)).code).toBe(0);
    cpSync(LIVE2D_FIXTURES, path.join(dir, 'mini'), { recursive: true });
    writeFileSync(path.join(dir, 'map.json'), '{"HairFront": "ParamHairFront"}');
    const r = await run(['import', 'live2d', 'mini/mini.model3.json', 'mini/motions/wave.motion3.json', '--into', 'hana.r2d.json', '--param-map', 'map.json', '--physics', 'merge', '--json'], dir);
    expect(r.code, r.stdout).toBe(0);
    const j = r.json();
    expect(j.sources).toEqual([
      { file: 'mini/mini.model3.json', kind: 'model3' },
      { file: 'mini/motions/wave.motion3.json', kind: 'motion3', via: 'mini/mini.model3.json' },
    ]);
    expect(j.summary.animations).toEqual(expect.arrayContaining(['wave', 'free']));
    expect(j.summary.removedPhysics).toEqual([]);
    const codes = j.report.issues.map((i: { code: string }) => i.code);
    expect(codes).toContain('live2d-moc-ignored');
    expect(codes).toContain('live2d-file-missing'); // expressions/gone.exp3.json does not exist
    const missing = j.report.issues.find((i: { code: string }) => i.code === 'live2d-file-missing');
    expect(missing.message).toContain('gone.exp3.json');
    expect(missing.where).toBe('mini/mini.model3.json: FileReferences.Expressions[1]');
    expect((await run(['validate', 'hana.r2d.json'], dir)).code).toBe(0);
  });

  it('writes nothing when the result is invalid, and explains usage errors', async () => {
    const dir = workspace();
    expect((await run(['new', 'hana.r2d.json', '--template', 'hana'], dir)).code).toBe(0);
    writeFileSync(path.join(dir, 'a.motion3.json'), motion3());
    writeFileSync(path.join(dir, 'b.motion3.json'), motion3());
    const noInto = await run(['import', 'live2d', 'a.motion3.json'], dir);
    expect(noInto.code).toBe(2);
    expect(noInto.stderr).toContain('missing --into <model.r2d.json>');
    expect((await run(['import', 'live2d', 'a.motion3.json', '--into', 'hana.r2d.json', '--physics', 'keep'], dir)).stderr).toContain('--physics must be one of replace, merge, skip, got "keep"');
    const twoIds = await run(['import', 'live2d', 'a.motion3.json', 'b.motion3.json', '--into', 'hana.r2d.json', '--id', 'x'], dir);
    expect(twoIds.code).toBe(2);
    expect(twoIds.stderr).toContain('an explicit animation id applies to exactly one motion3 or exp3 file');
    const spine = await run(['import', 'live2d', 'spine/hero.json', '--into', 'hana.r2d.json'], dir);
    expect(spine.code).toBe(1);
    expect(spine.stderr).toContain('hint: this is a Spine skeleton: convert it with rev2d import spine');
    expect((await run(['import', 'live2d', 'a.motion3.json', '--into', 'nope.r2d.json'], dir)).stderr).toMatch(/model file not found/);
    // The target model has an error: the import is applied and validated, but not written.
    const broken = JSON.parse(readFileSync(path.join(dir, 'hana.r2d.json'), 'utf8'));
    broken.parts[0].parent = 'nope';
    writeFileSync(path.join(dir, 'broken.r2d.json'), JSON.stringify(broken));
    const before = readFileSync(path.join(dir, 'broken.r2d.json'), 'utf8');
    const invalid = await run(['import', 'live2d', 'a.motion3.json', '--into', 'broken.r2d.json'], dir);
    expect(invalid.code).toBe(1);
    expect(invalid.stdout).toContain('not written: the result has validation errors');
    expect(readFileSync(path.join(dir, 'broken.r2d.json'), 'utf8')).toBe(before);
  });

  it('round-trips hana: export live2d, then import the model3.json into a copy', { timeout: 180_000 }, async () => {
    const dir = workspace();
    expect((await run(['new', 'hana.r2d.json', '--template', 'hana'], dir)).code).toBe(0);
    expect((await run(['new', 'copy.r2d.json', '--template', 'hana'], dir)).code).toBe(0);
    expect((await run(['export', 'live2d', 'hana.r2d.json', '-o', 'l2d'], dir)).code).toBe(0);
    const r = await run(['import', 'live2d', 'l2d/hana.model3.json', '--into', 'copy.r2d.json', '--physics', 'skip', '--display-info', 'skip', '--json'], dir);
    expect(r.code, r.stdout).toBe(0);
    const j = r.json();
    const ids = animationIds(path.join(dir, 'hana.r2d.json'));
    expect(j.summary.animations.sort()).toEqual([...ids].sort());
    expect(j.summary.replaced.sort()).toEqual([...ids].sort());
    expect(j.summary.physics).toEqual([]);
    expect(animationIds(path.join(dir, 'copy.r2d.json')).sort()).toEqual([...ids].sort());
    // The imported idle samples like the original (Live2D motions carry exact Bézier eases).
    const a = await run(['inspect', 'hana.r2d.json', '--anim', 'idle', '--times', '0:3.5:8', '--track', 'param:AngleX', '--json', '--no-physics'], dir);
    const b = await run(['inspect', 'copy.r2d.json', '--anim', 'idle', '--times', '0:3.5:8', '--track', 'param:AngleX', '--json', '--no-physics'], dir);
    const rows = (x: RunResult) => x.json().rows.map((row: number[]) => row.map((v) => Math.round(v * 100) / 100));
    expect(rows(b)).toEqual(rows(a));
  });
});
