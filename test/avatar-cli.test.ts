/**
 * rev2d avatar new | import-mas | validate | grid | overlay | vision-check | schema, run in-process
 * through main(): files written, text and --json output, exit codes (0 ok, 1 failed, 2 usage) and
 * did-you-mean. Synthetic pictures and hand-written specs only.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/cli/main.js';
import { COMMANDS, PARENTS } from '../src/cli/commands/index.js';
import { AVATAR_COMMANDS } from '../src/cli/commands/avatar.js';
import { formatModelJson } from '../src/core/format.js';
import { decodePNG, encodePNG } from '../src/render/index.js';
import { makeVisionCheck } from '../src/avatar/tools/vision-check.js';
import { HEIGHT, masRig, testImage, validDoc, WIDTH, type Json } from '../src/avatar/__tests__/fixtures.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'rev2d-avatar-cli-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

const PNG = encodePNG(testImage());
writeFileSync(path.join(root, 'art.png'), PNG);

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  json(): any;
}

async function run(args: string[], cwd = root): Promise<RunResult> {
  const buf = { stdout: '', stderr: '' };
  const code = await main(args, {
    stdout: { write: (s: string) => ((buf.stdout += s), true) },
    stderr: { write: (s: string) => ((buf.stderr += s), true) },
    cwd,
  });
  return { code, ...buf, json: () => JSON.parse(buf.stdout) };
}

/** A finished project "proj<n>" under the test root; returns its name relative to the root. */
function project(mutate: (doc: Json) => void = () => {}): string {
  const name = `proj${n++}`;
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  const doc = validDoc();
  mutate(doc);
  writeFileSync(path.join(dir, 'avatar.json'), formatModelJson(doc));
  writeFileSync(path.join(dir, 'source.png'), PNG);
  return name;
}

const png = (rel: string) => decodePNG(readFileSync(path.join(root, rel)));

describe('rev2d avatar: help and dispatch', () => {
  it('registers every subcommand under the avatar parent', async () => {
    expect(PARENTS.avatar.subcommands).toBe(AVATAR_COMMANDS);
    for (const c of AVATAR_COMMANDS) {
      expect(c.name.startsWith('avatar ')).toBe(true);
      expect(COMMANDS).toContain(c);
    }
    const names = AVATAR_COMMANDS.map((c) => c.name.split(' ')[1]);
    expect(names).toEqual(expect.arrayContaining(['new', 'import-mas', 'validate', 'grid', 'overlay', 'vision-check', 'schema']));
    const help = await run(['help', 'avatar']);
    expect(help.code).toBe(0);
    for (const name of names) expect(help.stdout).toContain(name);
    expect((await run(['help'])).stdout).toMatch(/avatar\s+an animated avatar from one illustration \(new, /);
    const one = await run(['avatar', 'grid', '--help']);
    expect(one.stdout).toContain('usage: rev2d avatar grid <project | image.png> [--region x0,y0,x1,y1]');
    expect(one.stdout).toContain('--region <x0,y0,x1,y1>');
  });

  it('suggests a misspelled subcommand and requires one', async () => {
    const typo = await run(['avatar', 'overlai', 'x']);
    expect(typo.code).toBe(2);
    expect(typo.stderr).toContain('did you mean "overlay"?');
    const none = await run(['avatar']);
    expect(none.code).toBe(2);
    expect(none.stderr).toContain('subcommands: new, import-mas');
    const flag = await run(['avatar', 'grid', 'x', '--regoin', '1,2,3,4']);
    expect(flag.code).toBe(2);
    expect(flag.stderr).toContain('did you mean "--region"?');
  });
});

describe('rev2d avatar new', () => {
  it('creates source.png and a draft avatar.json and says what comes next', async () => {
    const r = await run(['avatar', 'new', 'art.png', 'projects/hero']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`created avatar project projects/hero: "hero", ${WIDTH}x${HEIGHT}`);
    expect(r.stdout).toContain('draft spec: 20 landmarks to place');
    expect(r.stdout).toContain('rev2d avatar grid projects/hero -o projects/hero/work/grid.png');
    expect(r.stdout).toContain('rev2d avatar validate projects/hero');
    expect(Buffer.compare(readFileSync(path.join(root, 'projects/hero/source.png')), Buffer.from(PNG))).toBe(0);
    const doc = JSON.parse(readFileSync(path.join(root, 'projects/hero/avatar.json'), 'utf8'));
    expect(doc).toMatchObject({ format: 'rev2d-avatar', name: 'hero', image: { width: WIDTH, height: HEIGHT }, head: { center: null } });
  });

  it('prints JSON, takes --name and refuses to overwrite without --force', async () => {
    const r = await run(['avatar', 'new', 'art.png', 'projects/second', '--name', 'Bob', '--json']);
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({ ok: true, name: 'Bob', width: WIDTH, height: HEIGHT, landmarksToPlace: 20, dir: path.join(root, 'projects', 'second') });
    expect(r.json().next[0]).toContain('rev2d avatar grid projects/second');
    const again = await run(['avatar', 'new', 'art.png', 'projects/second', '--json']);
    expect(again.code).toBe(1);
    expect(again.json()).toMatchObject({ ok: false, exitCode: 1, error: { kind: 'failed' } });
    expect(again.stderr).toContain('already holds avatar.json');
    expect(again.stderr).toContain('--force');
    expect((await run(['avatar', 'new', 'art.png', 'projects/second', '--force'])).code).toBe(0);
  });

  it('rejects a bad name, a missing argument and another image format', async () => {
    const name = await run(['avatar', 'new', 'art.png', 'projects/x', '--name', '9 lives']);
    expect(name.code).toBe(1);
    expect(name.stderr).toContain('"9 lives" is not a valid avatar name');
    expect(existsSync(path.join(root, 'projects/x'))).toBe(false);
    const missing = await run(['avatar', 'new', 'art.png']);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('missing argument <dir>');
    writeFileSync(path.join(root, 'photo.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]));
    const jpeg = await run(['avatar', 'new', 'photo.jpg', 'projects/y']);
    expect(jpeg.code).toBe(1);
    expect(jpeg.stderr).toContain('is a JPEG image; avatar projects need a PNG');
    expect(jpeg.stderr).toContain('hint: convert the illustration to PNG');
  });
});

describe('rev2d avatar validate', () => {
  it('lists what a draft still needs and exits 1', async () => {
    await run(['avatar', 'new', 'art.png', 'drafts/a']);
    const r = await run(['avatar', 'validate', 'drafts/a']);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('FAIL  drafts/a/avatar.json');
    expect(r.stdout).toContain('error   /head/center');
    expect(r.stdout).toContain('avatar-missing-landmark  Head ellipse: centre is not placed yet  → set "center" to [x, y]');
    expect(r.stdout).toContain('20 errors, 0 warnings');
    expect(r.stdout).toContain('20 landmarks to place: read coordinates with "rev2d avatar grid drafts/a"');
    expect(r.stdout).not.toContain('schema-');
  });

  it('accepts a finished project, by folder or by file', async () => {
    const p = project();
    const r = await run(['avatar', 'validate', p]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(`ok    ${p}/avatar.json  (0 errors, 0 warnings)`);
    const j = await run(['avatar', 'validate', `${p}/avatar.json`, '--json']);
    expect(j.code).toBe(0);
    expect(j.json()).toMatchObject({ ok: true, errors: 0, warnings: 0, landmarksToPlace: 0, diagnostics: [], layers: 'not built', image: { width: WIDTH, height: HEIGHT } });
    expect(j.json().file).toBe(path.join(root, p, 'avatar.json'));
  });

  it('reports errors and warnings; --strict fails on warnings', async () => {
    const warn = project((d) => (d.face.radius = [150, 80]));
    const ok = await run(['avatar', 'validate', warn]);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain(`ok    ${warn}/avatar.json`);
    expect(ok.stdout).toContain('warning /face/radius  avatar-face-outside-head');
    expect((await run(['avatar', 'validate', warn, '--strict'])).code).toBe(1);
    const bad = project((d) => {
      d.head.neck = [340, 285];
      d.face.eys = {};
    });
    const r = await run(['avatar', 'validate', bad, '--json']);
    expect(r.code).toBe(1);
    expect(r.json().diagnostics.map((d: Json) => d.code)).toEqual(['schema-unrecognized-keys', 'avatar-band-order']);
    expect(r.json().diagnostics[0].hint).toBe('did you mean "eyes"?');
  });

  it('compares the declared size with the picture and fails without a project', async () => {
    const p = project((d) => Object.assign(d.image, { width: 512, height: 512 }));
    const r = await run(['avatar', 'validate', p]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('avatar-image-size-mismatch  the spec says the image is 512x512, but source.png is 400x500');
    const none = await run(['avatar', 'validate', 'nowhere']);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain('the project folder nowhere does not exist');
    expect(none.stderr).toContain('rev2d avatar new <image.png> <dir>');
  });
});

describe('rev2d avatar grid', () => {
  it('writes the whole-image grid of a project to its work folder by default', async () => {
    const p = project();
    const r = await run(['avatar', 'grid', p]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`^wrote ${p}/work/grid\\.png \\(\\d+x\\d+\\): x 0\\.\\.400, y 0\\.\\.500 of the 400x500 image at x3, a line every 20 px, labels every 20 px`));
    const img = png(`${p}/work/grid.png`);
    expect(img.width).toBeGreaterThan(WIDTH * 3);
    expect(img.height).toBeGreaterThan(HEIGHT * 3);
  });

  it('magnifies a region, of a project or of a plain PNG, and prints JSON', async () => {
    const p = project();
    const r = await run(['avatar', 'grid', p, '--region', '140,170,190,220', '--json']);
    expect(r.code).toBe(0);
    const j = r.json();
    expect(j).toMatchObject({ region: [140, 170, 190, 220], scale: 26, file: path.join(root, p, 'work', 'grid-140-170-190-220.png'), source: path.join(root, p, 'source.png') });
    expect(j.step).toBeLessThanOrEqual(5);
    expect(png(`${p}/work/grid-140-170-190-220.png`).width).toBe(j.width);
    // The origin maps source coordinates to output pixels: the white eye at (165.5, 195.5).
    const img = png(`${p}/work/grid-140-170-190-220.png`);
    const i = ((j.origin[1] + Math.round(25.5 * j.scale)) * img.width + j.origin[0] + Math.round(25.5 * j.scale)) * 4;
    expect([...img.data.subarray(i, i + 3)]).toEqual([255, 255, 255]);
    const plain = await run(['avatar', 'grid', 'art.png', '--region', '0,0,100,100', '--step', '10', '--scale', '5', '-o', 'out/corner.png']);
    expect(plain.code).toBe(0);
    expect(plain.stdout).toContain('wrote out/corner.png');
    expect(plain.stdout).toContain('at x5, a line every 10 px');
    expect(png('out/corner.png').width).toBeGreaterThan(500);
  });

  it('rejects bad input with usage errors and hints', async () => {
    const p = project();
    const noOut = await run(['avatar', 'grid', 'art.png']);
    expect(noOut.code).toBe(2);
    expect(noOut.stderr).toContain('missing output file: pass -o <out.png>');
    const region = await run(['avatar', 'grid', p, '--region', '10,20,30']);
    expect(region.code).toBe(2);
    expect(region.stderr).toContain('--region expects "x0,y0,x1,y1", got "10,20,30"');
    const size = await run(['avatar', 'grid', p, '--region', '100,100,50,50']);
    expect(size.code).toBe(2);
    expect(size.stderr).toContain('not x,y,width,height');
    const outside = await run(['avatar', 'grid', p, '--region', '900,900,950,950']);
    expect(outside.code).toBe(1);
    expect(outside.stderr).toContain('does not overlap the 400x500 image');
    const missing = await run(['avatar', 'grid', 'nothing.png', '-o', 'x.png']);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('nothing.png does not exist');
    const scale = await run(['avatar', 'grid', p, '--scale', '0']);
    expect(scale.code).toBe(2);
    writeFileSync(path.join(root, 'notes.txt'), 'hello');
    const text = await run(['avatar', 'grid', 'notes.txt', '-o', 'x.png']);
    expect(text.code).toBe(1);
    expect(text.stderr).toContain('is not a PNG image');
  });
});

describe('rev2d avatar overlay', () => {
  it('draws all landmarks, or one part zoomed, into the work folder', async () => {
    const p = project();
    const all = await run(['avatar', 'overlay', p]);
    expect(all.code).toBe(0);
    expect(all.stdout).toMatch(new RegExp(`^wrote ${p}/work/overlay\\.png \\(\\d+x\\d+\\): 31 landmark shapes, x 0\\.\\.400, y 0\\.\\.500 at x3`));
    expect(all.stderr).toBe('');
    const eye = await run(['avatar', 'overlay', p, '--part', 'eyes.imageLeft', '--zoom', '--grid', '--json']);
    expect(eye.code).toBe(0);
    const j = eye.json();
    expect(j.file).toBe(path.join(root, p, 'work', 'overlay-eyes-imageLeft-zoom.png'));
    expect(j.drawn).toEqual(['eyes.imageLeft.opening', 'eyes.imageLeft.region', 'eyes.imageLeft.iris']);
    expect(j.missing).toEqual([]);
    expect(j.scale).toBeGreaterThan(10);
    expect(j.region[0]).toBeLessThan(142);
    expect(png(`${p}/work/overlay-eyes-imageLeft-zoom.png`).width).toBe(j.width);
    const out = await run(['avatar', 'overlay', p, '--part', 'strands', '-o', 'out/strands.png']);
    expect(out.stdout).toContain('wrote out/strands.png');
    expect(out.stdout).toContain('2 landmark shapes of "strands"');
  });

  it('works on a draft with errors and notes what is not placed', async () => {
    await run(['avatar', 'new', 'art.png', 'drafts/b']);
    const empty = await run(['avatar', 'overlay', 'drafts/b']);
    expect(empty.code).toBe(1);
    expect(empty.stderr).toContain('nothing to draw: no landmark is placed yet');
    const file = path.join(root, 'drafts/b/avatar.json');
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    Object.assign(doc.head, { center: [200, 170], radius: [130, 150] });
    writeFileSync(file, JSON.stringify(doc));
    const r = await run(['avatar', 'overlay', 'drafts/b', '--part', 'head']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('1 landmark shape of "head"');
    expect(r.stderr).toContain('note: 2 landmarks of this selection are not placed yet: head.pivot, head.neck');
  });

  it('fails with a hint for an unknown part, broken JSON or a missing picture', async () => {
    const p = project();
    const part = await run(['avatar', 'overlay', p, '--part', 'mouths']);
    expect(part.code).toBe(1);
    expect(part.stderr).toContain('unknown part "mouths"');
    expect(part.stderr).toContain('did you mean "mouth"?');
    const broken = project();
    writeFileSync(path.join(root, broken, 'avatar.json'), '{ "format": "rev2d-avatar", ');
    const syntax = await run(['avatar', 'overlay', broken]);
    expect(syntax.code).toBe(1);
    expect(syntax.stderr).toContain('avatar.json is not valid JSON');
    expect(syntax.stderr).toContain('json-syntax');
    const noPicture = project();
    rmSync(path.join(root, noPicture, 'source.png'));
    const missing = await run(['avatar', 'overlay', noPicture]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('avatar-source-missing');
  });
});

describe('rev2d avatar vision-check', () => {
  it('makes the image and the key, and scores answers', async () => {
    const made = await run(['avatar', 'vision-check', 'make', 'vision', '--seed', '11', '--size', '512']);
    expect(made.code).toBe(0);
    expect(made.stdout).toContain('wrote vision/vision-check.png (512x512, seed 11) with 12 numbered crosshair markers');
    expect(made.stdout).toContain('rev2d avatar vision-check score vision vision/answer.json');
    expect(png('vision/vision-check.png').width).toBe(512);
    // Deterministic per seed: the same picture as the library call.
    expect(Buffer.compare(Buffer.from(png('vision/vision-check.png').data), Buffer.from(makeVisionCheck({ seed: 11, size: 512 }).image.data))).toBe(0);
    const key = makeVisionCheck({ seed: 11, size: 512 }).key.markers;
    expect(readFileSync(path.join(root, 'vision/vision-check.key.json'), 'utf8')).not.toContain(`[${key['1'][0]}, ${key['1'][1]}]`);

    writeFileSync(path.join(root, 'vision/answer.json'), `// read off the grid\n${JSON.stringify(Object.fromEntries(Object.entries(key).map(([id, p]) => [id, [p[0] + 1, p[1]]])))}`);
    const pass = await run(['avatar', 'vision-check', 'score', 'vision', 'vision/answer.json']);
    expect(pass.code).toBe(0);
    expect(pass.stdout).toContain('PASS  mean error 1 px (limit 2), largest 1 px (limit 5), 12 of 12 markers answered');
    expect(pass.stdout).toMatch(/1\s+\(\d+, \d+\)\s+\(\d+, \d+\)\s+1\n/);

    writeFileSync(path.join(root, 'vision/bad.json'), JSON.stringify(Object.fromEntries(Object.entries(key).map(([id, p]) => [id, [p[0] / 2, p[1] / 2]]))));
    const fail = await run(['avatar', 'vision-check', 'score', 'vision', 'vision/bad.json', '--json']);
    expect(fail.code).toBe(1);
    expect(fail.json()).toMatchObject({ ok: false, pass: false, answered: 12, total: 12, limits: { mean: 2, max: 5 } });
    expect(fail.json().advice).toContain('about 0.5x the true ones');
  });

  it('prints JSON for make and rejects wrong usage', async () => {
    const made = await run(['avatar', 'vision-check', 'make', 'vision2', '--json']);
    expect(made.json()).toMatchObject({ ok: true, seed: 1, size: 1024, markers: 12, image: path.join(root, 'vision2', 'vision-check.png') });
    const action = await run(['avatar', 'vision-check', 'mark', 'vision2']);
    expect(action.code).toBe(2);
    expect(action.stderr).toContain('did you mean "make"?');
    const noAnswer = await run(['avatar', 'vision-check', 'score', 'vision2']);
    expect(noAnswer.code).toBe(2);
    expect(noAnswer.stderr).toContain('missing argument [answer.json]');
    const extra = await run(['avatar', 'vision-check', 'make', 'vision2', 'answer.json']);
    expect(extra.code).toBe(2);
    const seed = await run(['avatar', 'vision-check', 'score', 'vision2', 'a.json', '--seed', '3']);
    expect(seed.code).toBe(2);
    expect(seed.stderr).toContain('--seed applies to "make" only');
    const noKey = await run(['avatar', 'vision-check', 'score', 'nowhere', 'a.json']);
    expect(noKey.code).toBe(1);
    expect(noKey.stderr).toContain('vision-check make');
    const noFile = await run(['avatar', 'vision-check', 'score', 'vision2', 'missing.json']);
    expect(noFile.code).toBe(1);
    expect(noFile.stderr).toContain('cannot read the answer file missing.json');
    writeFileSync(path.join(root, 'list.json'), '[1, 2]');
    const list = await run(['avatar', 'vision-check', 'score', 'vision2', 'list.json']);
    expect(list.code).toBe(1);
    expect(list.stderr).toContain('must be a JSON object that maps marker numbers to [x, y]');
    const size = await run(['avatar', 'vision-check', 'make', 'vision3', '--size', '64']);
    expect(size.code).toBe(2);
  });
});

describe('rev2d avatar import-mas', () => {
  function masFolder(): string {
    const name = `mas${n++}`;
    const dir = path.join(root, name);
    mkdirSync(path.join(dir, 'variants'), { recursive: true });
    writeFileSync(path.join(dir, 'rig.json'), JSON.stringify(masRig()));
    writeFileSync(path.join(dir, 'source.png'), PNG);
    writeFileSync(path.join(dir, 'variants', 'eyes_closed.png'), PNG);
    return name;
  }

  it('imports rig.json, the picture and known variants, and reports notes', async () => {
    const mas = masFolder();
    const r = await run(['avatar', 'import-mas', mas, 'imported/one', '--name', 'one']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`imported ${mas}/rig.json into avatar project imported/one: "one", 400x500, 2 strands, 3 attachments`);
    expect(r.stdout).toContain('imported/one/variants/eyes_closed.png  drawn variant');
    expect(r.stdout).toContain('validation: 0 errors, 0 warnings');
    expect(r.stdout).toContain('rev2d avatar overlay imported/one -o imported/one/work/overlay.png');
    expect(r.stderr).toContain('note: head.turnBand [290, 380] is not imported');
    expect(r.stderr).toContain('face.chin [200, 277.6] were estimated');
    // The result is an ordinary project.
    expect((await run(['avatar', 'validate', 'imported/one'])).code).toBe(0);
    expect((await run(['avatar', 'overlay', 'imported/one', '--part', 'attachments'])).code).toBe(0);
    const again = await run(['avatar', 'import-mas', mas, 'imported/one']);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain('--force');
  });

  it('prints JSON and exits 1 when the imported spec has errors', async () => {
    const mas = masFolder();
    const rig = masRig();
    rig.eyes.pop();
    writeFileSync(path.join(root, mas, 'rig.json'), JSON.stringify(rig));
    const r = await run(['avatar', 'import-mas', `${mas}/rig.json`, 'imported/two', '--json']);
    expect(r.code).toBe(1);
    const j = r.json();
    expect(j).toMatchObject({ ok: false, name: 'two', width: 400, height: 500, variants: ['variants/eyes_closed.png'], sources: { rig: path.join(root, mas, 'rig.json') } });
    expect(j.errors).toBe(2);
    expect(j.diagnostics.map((d: Json) => d.path)).toEqual(['/face/eyes/imageRight/opening', '/face/eyes/imageRight/region']);
    expect(j.notes.join(' ')).toContain('The rig lists 1 eyes');
    const missing = await run(['avatar', 'import-mas', 'no-such-mas', 'imported/three']);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('rig.json');
  });
});

describe('rev2d avatar schema', () => {
  it('prints the JSON Schema of avatar.json, or writes it', async () => {
    const r = await run(['avatar', 'schema']);
    expect(r.code).toBe(0);
    const schema = r.json();
    expect(schema.type).toBe('object');
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(['format', 'image', 'head', 'face', 'hair', 'attachments', 'body', 'post']));
    expect(JSON.stringify(schema)).toContain('CUTS LAYERS');
    const w = await run(['avatar', 'schema', '-o', 'out/avatar.schema.json', '--json']);
    expect(w.json()).toEqual({ file: path.join(root, 'out', 'avatar.schema.json') });
    expect(JSON.parse(readFileSync(path.join(root, 'out/avatar.schema.json'), 'utf8'))).toEqual(schema);
  });
});
