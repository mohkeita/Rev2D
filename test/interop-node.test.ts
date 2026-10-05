/**
 * The interop integration layer (src/node/interop.ts, src/interop/detect.ts): file detection, reading
 * a Spine export folder (atlas lookup, page decoding), writing converter output, parameter maps,
 * Live2D batches turned into ops (model3 references, ids, replacement, physics / display info), the
 * atomic model-file edit and report formatting. Hand-written fixtures only.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PACKAGE_ROOT } from '../src/api/templates.js';
import { formatModelJson } from '../src/core/format.js';
import { validateModel } from '../src/core/validate.js';
import { applyOps } from '../src/ops/index.js';
import { createImage, encodePNG } from '../src/render/index.js';
import { atlasPageNames, detectInteropFile, formatLabel, isAtlasName, live2dFormatFromName, looksLikeSpineSkeleton } from '../src/interop/detect.js';
import type { InteropReport } from '../src/interop/types.js';
import {
  InteropError,
  applyOpsToModelFile,
  atlasCandidates,
  convertLive2dSources,
  countsText,
  findSpineAtlas,
  importSpineFile,
  importSpineUpload,
  issueLine,
  live2dKind,
  mergeReports,
  paramMapFromSpec,
  readModelDoc,
  reportLines,
  spineModelText,
  summaryText,
  writeOutputFiles,
  type Live2dSource,
} from '../src/node/interop.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'rev2d-interop-node-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
function tempDir(): string {
  const dir = path.join(root, `t${n++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const SPINE_FIXTURES = path.join(PACKAGE_ROOT, 'src', 'interop', 'spine', '__tests__', 'fixtures');

/** A Spine export folder: the hand-written hero skeleton + atlas and a generated 64x32 page. */
function spineFolder(skeletonName = 'hero.json', atlasName: string | null = 'hero.atlas'): string {
  const dir = tempDir();
  copyFileSync(path.join(SPINE_FIXTURES, 'hero-4x.json'), path.join(dir, skeletonName));
  if (atlasName) copyFileSync(path.join(SPINE_FIXTURES, 'hero.atlas'), path.join(dir, atlasName));
  writeFileSync(path.join(dir, 'hero.png'), encodePNG(createImage(64, 32, '#80808080')));
  return dir;
}

/** A small Rev2D model with Live2D-style parameter ids (raw JSON). */
function miniModel(): Record<string, any> {
  return {
    format: 'rev2d',
    version: 1,
    meta: { name: 'mini', width: 100, height: 100 },
    parameters: [
      { id: 'AngleX', min: -30, max: 30, default: 0 },
      { id: 'EyeLOpen', min: 0, max: 1, default: 1 },
      { id: 'MouthOpen', min: 0, max: 1, default: 0 },
      { id: 'HairFront', min: -1, max: 1, default: 0 },
    ],
    parts: [{ id: 'face', shape: { type: 'ellipse', cx: 50, cy: 40, rx: 20, ry: 24 }, fill: '#f0d0c0' }],
    animations: [{ id: 'idle', duration: 1, tracks: [{ target: 'param:AngleX', keys: [{ t: 0, v: 0 }, { t: 1, v: 5 }] }] }],
  };
}

/** A hand-written motion3.json: AngleX 0 -> 10 -> 0 (linear) and MouthOpenY stepped, 1 s. */
function motion3(extraCurves: Array<{ Target: string; Id: string; Segments: number[] }> = []): string {
  const curves = [
    { Target: 'Parameter', Id: 'ParamAngleX', Segments: [0, 0, 0, 0.5, 10, 0, 1, 0] },
    { Target: 'Parameter', Id: 'ParamMouthOpenY', Segments: [0, 0, 2, 0.5, 1] },
    ...extraCurves,
  ];
  // Linear / stepped segments only here: one point each, after the curve's first point.
  const segments = curves.reduce((sum, c) => sum + (c.Segments.length - 2) / 3, 0);
  return JSON.stringify({
    Version: 3,
    Meta: { Duration: 1, Fps: 30, Loop: true, AreBeziersRestricted: true, CurveCount: curves.length, TotalSegmentCount: segments, TotalPointCount: segments + curves.length, UserDataCount: 0, TotalUserDataSize: 0 },
    Curves: curves,
  });
}

const exp3 = JSON.stringify({ Type: 'Live2D Expression', Parameters: [{ Id: 'ParamMouthOpenY', Value: 0.5, Blend: 'Add' }] });
const cdi3 = JSON.stringify({ Version: 3, Parameters: [{ Id: 'ParamAngleX', GroupId: '', Name: 'Head turn' }], ParameterGroups: [], Parts: [] });

/** Report with 2 warnings and 1 info. */
const REPORT: InteropReport = {
  format: 'spine',
  direction: 'import',
  issues: [
    { severity: 'info', code: 'x-info', message: 'noted', where: 'bones[0]' },
    { severity: 'warning', code: 'x-warn', message: 'approximated', where: 'slots[1]', hint: 'do this' },
    { severity: 'warning', code: 'x-other', message: 'dropped' },
  ],
  stats: { bones: 2, slots: 1 },
};

describe('file detection (src/interop/detect.ts)', () => {
  it('recognizes Live2D files by their double extension, then by content', () => {
    expect(detectInteropFile('idle.motion3.json')).toBe('live2d-motion3');
    expect(detectInteropFile('a/b/HIYORI.MODEL3.JSON')).toBe('live2d-model3');
    expect(detectInteropFile('smile.exp3.json', 'broken')).toBe('live2d-exp3');
    expect(detectInteropFile('x.json', JSON.parse(motion3()))).toBe('live2d-motion3');
    expect(detectInteropFile('x.json', JSON.parse(exp3))).toBe('live2d-exp3');
    expect(detectInteropFile('x.json', JSON.parse(cdi3))).toBe('live2d-cdi3');
    expect(detectInteropFile('x.json', { Version: 3, PhysicsSettings: [] })).toBe('live2d-physics3');
    expect(detectInteropFile('x.json', { Version: 3, FileReferences: {} })).toBe('live2d-model3');
    expect(live2dFormatFromName('a.physics3.json')).toBe('live2d-physics3');
    expect(live2dFormatFromName('a.json')).toBeNull();
    expect(formatLabel('live2d-exp3')).toBe('Live2D expression');
  });

  it('tells Spine skeletons from Rev2D models and other JSON', () => {
    const spine = JSON.parse(readFileSync(path.join(SPINE_FIXTURES, 'hero-4x.json'), 'utf8'));
    expect(looksLikeSpineSkeleton(spine)).toBe(true);
    expect(detectInteropFile('hero.json', spine)).toBe('spine');
    expect(looksLikeSpineSkeleton({ bones: [{ name: 'root' }], slots: [] })).toBe(true);
    expect(looksLikeSpineSkeleton({ format: 'rev2d', bones: [{ name: 'x' }], skeleton: {} })).toBe(false);
    expect(looksLikeSpineSkeleton({ bones: [{ id: 'root' }], skeleton: {} })).toBe(false);
    expect(looksLikeSpineSkeleton({ bones: [] })).toBe(false);
    expect(detectInteropFile('m.json', miniModel())).toBe('rev2d');
    expect(detectInteropFile('hero.r2d.json')).toBe('rev2d');
    expect(detectInteropFile('package.json', { name: 'x' })).toBeNull();
    expect(detectInteropFile('x.json', [1])).toBeNull();
  });

  it('reads atlas page names and knows atlas file names', () => {
    expect(atlasPageNames(readFileSync(path.join(SPINE_FIXTURES, 'hero.atlas'), 'utf8'))).toEqual(['hero.png']);
    expect(atlasPageNames('')).toEqual([]);
    expect(isAtlasName('a.atlas')).toBe(true);
    expect(isAtlasName('a.atlas.txt')).toBe(true);
    expect(isAtlasName('a.txt')).toBe(false);
  });
});

describe('reports', () => {
  it('formats issues grouped by severity, with counts and stats', () => {
    expect(countsText(REPORT)).toBe('2 warnings, 1 info');
    expect(issueLine(REPORT.issues[1])).toBe('x-warn  slots[1]: approximated  → do this');
    expect(reportLines(REPORT)).toEqual([
      'report: 2 warnings, 1 info',
      'warnings:',
      '  x-warn   slots[1]: approximated  → do this',
      '  x-other  dropped',
      'info:',
      '  x-info   bones[0]: noted',
      'stats: bones 2, slots 1',
    ]);
    const capped = reportLines(REPORT, { max: 1, stats: false });
    expect(capped.at(-1)).toBe('  ... 2 more (the JSON output lists every issue)');
    expect(capped).toHaveLength(4);
  });

  it('merges reports, prefixing locations and summing stats', () => {
    const merged = mergeReports([{ label: 'a.json', report: REPORT }, { report: REPORT }], 'live2d-model3', 'import');
    expect(merged.issues).toHaveLength(6);
    expect(merged.issues[0].where).toBe('a.json: bones[0]');
    expect(merged.issues[2].where).toBe('a.json');
    expect(merged.issues[3].where).toBe('bones[0]');
    expect(merged.stats).toEqual({ bones: 4, slots: 2 });
  });
});

describe('writing output files', () => {
  it('reports new, unchanged and replaced files; refuses different files without overwrite', async () => {
    const dir = tempDir();
    const files = [
      { path: 'a.json', text: '{}' },
      { path: 'sub/b.png', bytes: new Uint8Array([1, 2, 3]) },
    ];
    expect((await writeOutputFiles(dir, files, { overwrite: false })).map((f) => [f.rel, f.status, f.bytes])).toEqual([
      ['a.json', 'new', 2],
      ['sub/b.png', 'new', 3],
    ]);
    expect(readFileSync(path.join(dir, 'sub', 'b.png'))).toEqual(Buffer.from([1, 2, 3]));
    expect((await writeOutputFiles(dir, files, { overwrite: false })).map((f) => f.status)).toEqual(['unchanged', 'unchanged']);
    const changed = [{ path: 'a.json', text: '{"x":1}' }, files[1]];
    const err = await writeOutputFiles(dir, changed, { overwrite: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InteropError);
    expect((err as InteropError).kind).toBe('exists');
    expect((err as InteropError).files).toEqual([path.join(dir, 'a.json')]);
    expect(readFileSync(path.join(dir, 'a.json'), 'utf8')).toBe('{}');
    const dry = await writeOutputFiles(dir, changed, { overwrite: true, dryRun: true });
    expect(dry[0].status).toBe('replaced');
    expect(readFileSync(path.join(dir, 'a.json'), 'utf8')).toBe('{}');
    await writeOutputFiles(dir, changed, { overwrite: true });
    expect(readFileSync(path.join(dir, 'a.json'), 'utf8')).toBe('{"x":1}');
  });

  it('never writes outside the output directory', async () => {
    const dir = tempDir();
    for (const bad of ['../x.json', '/abs.json', 'a/../../x', 'C:/x.json', 'a\\b.json', '']) {
      await expect(writeOutputFiles(dir, [{ path: bad, text: '' }], { overwrite: true }), bad).rejects.toThrow(/output paths must be relative/);
    }
    writeFileSync(path.join(dir, 'file'), '');
    await expect(writeOutputFiles(path.join(dir, 'file'), [{ path: 'a', text: '' }], { overwrite: true })).rejects.toThrow(/is a file, not a directory/);
  });
});

describe('Spine export folders', () => {
  it('finds the atlas named after the skeleton, the sample layout (x-pro.json + x.atlas), or the only atlas', () => {
    expect(atlasCandidates('/d/spineboy-pro.json')).toEqual([
      'spineboy-pro.atlas',
      'spineboy-pro.atlas.txt',
      'spineboy-pro-pma.atlas',
      'spineboy-pro-pma.atlas.txt',
      'spineboy.atlas',
      'spineboy.atlas.txt',
      'spineboy-pma.atlas',
      'spineboy-pma.atlas.txt',
    ]);
    const a = spineFolder('hero.json', 'hero.atlas.txt');
    expect(findSpineAtlas(path.join(a, 'hero.json'))).toEqual({ atlas: path.join(a, 'hero.atlas.txt'), notes: [] });
    const b = spineFolder('hero-pro.json', 'hero.atlas');
    expect(findSpineAtlas(path.join(b, 'hero-pro.json')).atlas).toBe(path.join(b, 'hero.atlas'));
    const c = spineFolder('char.json', 'pages.atlas');
    expect(findSpineAtlas(path.join(c, 'char.json'))).toEqual({ atlas: path.join(c, 'pages.atlas'), notes: ['using pages.atlas, the only atlas next to the skeleton'] });
    copyFileSync(path.join(c, 'pages.atlas'), path.join(c, 'other.atlas'));
    expect(() => findSpineAtlas(path.join(c, 'char.json'))).toThrow(/several atlases next to char\.json \(other\.atlas, pages\.atlas\)/);
    const d = spineFolder('hero.json', null);
    const none = findSpineAtlas(path.join(d, 'hero.json'));
    expect(none.atlas).toBeNull();
    expect(none.notes[0]).toMatch(/no atlas found next to hero\.json \(looked for hero\.atlas, hero\.atlas\.txt\)/);
  });

  it('imports the skeleton with its atlas and decoded pages into a valid model', async () => {
    const dir = spineFolder();
    const imp = await importSpineFile(path.join(dir, 'hero.json'), { name: 'hero' });
    expect(imp.sources).toEqual({ skeleton: path.join(dir, 'hero.json'), atlas: path.join(dir, 'hero.atlas'), pages: [path.join(dir, 'hero.png')] });
    expect(imp.notes).toEqual([]);
    expect(imp.files.map((f) => f.path)).toEqual(['textures/hero.png']);
    expect(imp.report.issues.some((i) => i.code === 'spine-page-missing')).toBe(false);
    expect((imp.doc.meta as { name: string }).name).toBe('hero');
    const text = spineModelText(imp.doc);
    expect(validateModel(JSON.parse(text)).diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('imports untextured (with a note) without an atlas, and names missing or broken pages', async () => {
    const bare = spineFolder('hero.json', null);
    const imp = await importSpineFile(path.join(bare, 'hero.json'));
    expect(imp.sources.atlas).toBeNull();
    expect(imp.files).toEqual([]);
    expect(imp.notes[0]).toMatch(/no atlas found/);
    expect((imp.doc.meta as { name: string }).name).toBe('hero');

    const broken = spineFolder();
    writeFileSync(path.join(broken, 'hero.png'), 'not a png');
    const b = await importSpineFile(path.join(broken, 'hero.json'));
    expect(b.notes[0]).toMatch(/atlas page .*hero\.png cannot be decoded .*only PNG pages are supported/);
    expect(b.report.issues.some((i) => i.code === 'spine-page-missing')).toBe(true);

    const missing = spineFolder();
    rmSync(path.join(missing, 'hero.png'));
    expect((await importSpineFile(path.join(missing, 'hero.json'))).notes[0]).toBe('atlas page hero.png not found next to the atlas: its regions are imported untextured');
  });

  it('explains wrong inputs', async () => {
    const dir = spineFolder();
    await expect(importSpineFile(path.join(dir, 'nope.json'))).rejects.toMatchObject({ kind: 'not-found' });
    await expect(importSpineFile(path.join(dir, 'hero.skel'))).rejects.toThrow(/binary skeleton; only Spine JSON exports are supported/);
    writeFileSync(path.join(dir, 'model.json'), formatModelJson(miniModel()));
    await expect(importSpineFile(path.join(dir, 'model.json'), { atlas: path.join(dir, 'hero.atlas') })).rejects.toThrow(/no "bones" array/);
    writeFileSync(path.join(dir, 'bad.atlas'), 'page.png\nsize: nope, 1\n');
    await expect(importSpineFile(path.join(dir, 'hero.json'), { atlas: path.join(dir, 'bad.atlas') })).rejects.toThrow(/is not a readable Spine atlas/);
  });

  it('imports uploaded files (the editor): picks the atlas by name, matches pages, notes the rest', () => {
    const skeleton = { name: 'hero.json', text: readFileSync(path.join(SPINE_FIXTURES, 'hero-4x.json'), 'utf8') };
    const atlas = { name: 'hero.atlas', text: readFileSync(path.join(SPINE_FIXTURES, 'hero.atlas'), 'utf8') };
    const page = { name: 'HERO.png', bytes: encodePNG(createImage(64, 32, '#ffffff')) };
    const extra = { name: 'readme.png', bytes: encodePNG(createImage(2, 2, '#000')) };
    const r = importSpineUpload(skeleton, [{ name: 'other.atlas', text: atlas.text }, atlas], [page, extra]);
    expect(r.atlas).toBe('hero.atlas');
    expect(r.pages).toEqual(['HERO.png']);
    expect(r.notes).toEqual(['used hero.atlas; skipped other.atlas', 'not atlas pages, skipped: readme.png']);
    expect(r.files.map((f) => f.path)).toEqual(['textures/hero.png']);
    expect(() => importSpineUpload(skeleton, [{ name: 'a.atlas', text: atlas.text }, { name: 'b.atlas', text: atlas.text }], [])).toThrow(/several atlases/);
    const bare = importSpineUpload(skeleton, [], []);
    expect(bare.notes[0]).toMatch(/no atlas \(\.atlas or \.atlas\.txt\) was imported with hero\.json/);
  });
});

describe('parameter maps', () => {
  it('knows the presets, objects and JSON files', () => {
    expect(paramMapFromSpec(undefined, [], root).toLive2d.MouthOpen).toBe('ParamMouthOpenY');
    expect(paramMapFromSpec('standard', [], root).toLive2d.AngleX).toBe('ParamAngleX');
    expect(paramMapFromSpec('none', [], root).toLive2d).toEqual({});
    expect(paramMapFromSpec('prefix', ['Blush'], root).toLive2d).toEqual({ Blush: 'ParamBlush' });
    expect(paramMapFromSpec({ Blush: 'ParamCheek' }, [], root).fromLive2d.ParamCheek).toBe('Blush');
    const dir = tempDir();
    writeFileSync(path.join(dir, 'map.json'), '{"Smile": "ParamMouthForm"}');
    expect(paramMapFromSpec('map.json', [], dir).toLive2d.Smile).toBe('ParamMouthForm');
    expect(() => paramMapFromSpec('missing.json', [], dir)).toThrow(/neither a preset nor a readable file/);
    writeFileSync(path.join(dir, 'dup.json'), '{"A": "ParamX", "B": "ParamX"}');
    expect(() => paramMapFromSpec('dup.json', [], dir)).toThrow(/one-to-one/);
    try {
      paramMapFromSpec('nope', [], dir);
    } catch (e) {
      expect(e).toMatchObject({ kind: 'usage', hint: expect.stringContaining('"standard", "none", "prefix"') });
    }
  });
});

describe('Live2D files to ops', () => {
  const none = () => undefined;

  it('knows the kind of each file', () => {
    expect(live2dKind('a.motion3.json')).toBe('motion3');
    expect(live2dKind('a.json', exp3)).toBe('exp3');
    expect(live2dKind('a.json', '{nope')).toBeNull();
  });

  it('turns a motion into an animation (the file name is its id) and replaces an existing one', () => {
    const conv = convertLive2dSources([{ name: 'look.motion3.json', text: motion3() }], miniModel(), none);
    expect(conv.ops).toHaveLength(1);
    expect(conv.ops[0]).toMatchObject({ op: 'add', kind: 'animation', value: { id: 'look' } });
    expect(conv.report.format).toBe('live2d-motion3');
    expect(conv.summary).toEqual({ animations: ['look'], replaced: [], physics: [], removedPhysics: [], updates: 0 });
    expect(summaryText(conv.summary)).toBe('1 animation (look)');
    const tracks = (conv.ops[0] as unknown as { value: { tracks: Array<{ target: string }> } }).value.tracks.map((t) => t.target);
    expect(tracks).toEqual(['param:AngleX', 'param:MouthOpen']);

    const replaced = convertLive2dSources([{ name: 'idle.motion3.json', text: motion3() }], miniModel(), none);
    expect(replaced.ops.map((o) => o.op)).toEqual(['remove', 'add']);
    expect(replaced.summary.replaced).toEqual(['idle']);
    // The model's own "idle" was made in Rev2D: replacing it is a warning that says how to keep it.
    const issue = replaced.report.issues.find((i) => i.code === 'live2d-animation-replaced');
    expect(issue).toMatchObject({ severity: 'warning', where: 'idle.motion3.json' });
    expect(issue?.message).toMatch(/"idle".*not .*Live2D import.*replace/);
    expect(issue?.hint).toMatch(/rename.*another animation id/);
    expect(reportLines(replaced.report).join('\n')).toMatch(/^warnings:\n\s+live2d-animation-replaced\s+idle\.motion3\.json: /m);

    // Importing the same files again replaces what the first import wrote: expected, so only noted.
    const batch = [
      { name: 'idle.motion3.json', text: motion3() },
      { name: 'smile.exp3.json', text: exp3 },
    ];
    const first = applyOps(miniModel(), convertLive2dSources(batch, miniModel(), none).ops);
    expect(first.ok).toBe(true);
    const again = convertLive2dSources(batch, first.doc as Record<string, unknown>, none);
    expect(again.summary.replaced).toEqual(['idle', 'exp_smile']);
    expect(again.report.issues.filter((i) => i.code === 'live2d-animation-replaced').map((i) => [i.severity, i.where])).toEqual([
      ['info', 'idle.motion3.json'],
      ['info', 'smile.exp3.json'],
    ]);

    const named = convertLive2dSources([{ name: 'idle.motion3.json', text: motion3() }], miniModel(), none, { id: 'lookAround' });
    expect(named.ops).toEqual([expect.objectContaining({ op: 'add', value: expect.objectContaining({ id: 'lookAround' }) })]);
  });

  it('reports unknown parameters with the file name, and names expressions exp_<name>', () => {
    const conv = convertLive2dSources(
      [
        { name: 'a.motion3.json', text: motion3([{ Target: 'Parameter', Id: 'ParamAngelX', Segments: [0, 0, 0, 1, 1] }]) },
        { name: 'smile.exp3.json', text: exp3 },
      ],
      miniModel(),
      none,
    );
    expect(conv.summary.animations).toEqual(['a', 'exp_smile']);
    const unknown = conv.report.issues.find((i) => i.code === 'live2d-unknown-parameter');
    expect(unknown?.where).toMatch(/^a\.motion3\.json: /);
    expect(unknown?.hint).toMatch(/did you mean "AngleX"/);
  });

  it('keeps ids unique within a batch and checks explicit ids', () => {
    const conv = convertLive2dSources(
      [
        { name: 'a/walk.motion3.json', text: motion3() },
        { name: 'b/walk.motion3.json', text: motion3() },
      ],
      miniModel(),
      none,
    );
    expect(conv.summary.animations).toEqual(['walk', 'walk_2']);
    expect(conv.report.issues.find((i) => i.code === 'live2d-id-renamed')?.where).toBe('b/walk.motion3.json');
    const two = [
      { name: 'a.motion3.json', text: motion3() },
      { name: 'b.motion3.json', text: motion3() },
    ];
    expect(() => convertLive2dSources(two, miniModel(), none, { id: 'x' })).toThrow(/exactly one motion3 or exp3 file/);
    expect(() => convertLive2dSources([two[0]], miniModel(), none, { id: '9lives' })).toThrow(/invalid animation id "9lives"/);
  });

  it('imports physics and display info through a one-file model3 (replace / merge, fill / overwrite)', () => {
    const model = miniModel();
    model.physics = [{ id: 'hair', inputs: [{ param: 'AngleX', type: 'x', weight: 1 }], outputs: [{ param: 'HairFront', type: 'angle', scale: 1 }], segments: [{ length: 30 }] }];
    const physics3 = readFileSync(path.join(PACKAGE_ROOT, 'src', 'interop', 'live2d', '__tests__', 'fixtures', 'mini', 'mini.physics3.json'), 'utf8');
    const replace = convertLive2dSources([{ name: 'mini.physics3.json', text: physics3 }], model, none);
    expect(replace.report.format).toBe('live2d-physics3');
    expect(replace.summary.removedPhysics).toEqual(['hair']);
    expect(replace.summary.physics.length).toBeGreaterThan(0);
    expect(replace.report.issues.every((i) => i.where?.startsWith('mini.physics3.json'))).toBe(true);
    const merge = convertLive2dSources([{ name: 'mini.physics3.json', text: physics3 }], model, none, { physics: 'merge' });
    expect(merge.summary.removedPhysics).toEqual([]);
    const names = convertLive2dSources([{ name: 'x.cdi3.json', text: cdi3 }], model, none);
    expect(names.ops).toEqual([{ op: 'update', kind: 'parameter', id: 'AngleX', set: { description: 'Head turn' } }]);
    expect(convertLive2dSources([{ name: 'x.cdi3.json', text: cdi3 }], model, none, { displayInfo: 'skip' }).ops).toEqual([]);
  });

  it('reads the files a model3.json lists, and imports those given as well only once', () => {
    const texts: Record<string, string> = { 'motions/look.motion3.json': motion3(), 'names.cdi3.json': cdi3 };
    const model3: Live2dSource = {
      name: 'char/char.model3.json',
      text: JSON.stringify({ Version: 3, FileReferences: { Moc: 'char.moc3', DisplayInfo: 'names.cdi3.json', Motions: { Idle: [{ File: 'motions/look.motion3.json' }] } } }),
    };
    const reads: string[] = [];
    const reader = (ref: string, m3: Live2dSource): Live2dSource | undefined => {
      reads.push(`${m3.name}:${ref}`);
      return texts[ref] === undefined ? undefined : { name: `char/${ref}`, text: texts[ref] };
    };
    const conv = convertLive2dSources([model3, { name: 'char/motions/look.motion3.json', text: motion3() }], miniModel(), reader);
    expect(reads).toEqual(['char/char.model3.json:names.cdi3.json', 'char/char.model3.json:motions/look.motion3.json']);
    expect(conv.summary.animations).toEqual(['look']);
    expect(conv.sources).toEqual([
      { name: 'char/char.model3.json', kind: 'model3', report: expect.anything() },
      { name: 'char/motions/look.motion3.json', kind: 'motion3', via: 'char/char.model3.json' },
    ]);
    expect(conv.report.format).toBe('live2d-model3');
    expect(conv.report.issues.find((i) => i.code === 'live2d-moc-ignored')?.message).toMatch(/proprietary and undocumented/);
    const noMotions = convertLive2dSources([model3], miniModel(), reader, { motions: false });
    expect(noMotions.summary.animations).toEqual([]);
  });

  it('refuses files that are not Live2D JSON (with a hint for Spine and Rev2D), and several model3 files', () => {
    const spine = readFileSync(path.join(SPINE_FIXTURES, 'hero-4x.json'), 'utf8');
    expect(() => convertLive2dSources([{ name: 'hero.json', text: spine }], miniModel(), none)).toThrow(/is not a Live2D motion/);
    try {
      convertLive2dSources([{ name: 'hero.json', text: spine }], miniModel(), none);
    } catch (e) {
      expect((e as InteropError).hint).toMatch(/Spine skeleton: convert it with rev2d import spine/);
    }
    try {
      convertLive2dSources([{ name: 'm.json', text: JSON.stringify(miniModel()) }], miniModel(), none);
    } catch (e) {
      expect((e as InteropError).hint).toMatch(/this is a Rev2D model/);
    }
    const m3 = { name: 'a.model3.json', text: '{"Version": 3, "FileReferences": {}}' };
    expect(() => convertLive2dSources([m3, { ...m3, name: 'b.model3.json' }], miniModel(), none)).toThrow(/one model3\.json at a time/);
    expect(() => convertLive2dSources([], miniModel(), none)).toThrow(/no Live2D files given/);
    expect(() => convertLive2dSources([{ name: 'x.motion3.json', text: '{oops' }], miniModel(), none)).toThrow(/x\.motion3\.json: .*invalid JSON/);
  });
});

describe('editing a model file atomically', () => {
  const write = (text: string) => {
    const file = path.join(tempDir(), 'm.r2d.json');
    writeFileSync(file, text);
    return file;
  };

  it('writes formatted results, keeps CRLF, leaves unchanged files and dry runs alone', async () => {
    const file = write(formatModelJson(miniModel()).replace(/\n/g, '\r\n'));
    const src = await readModelDoc(file);
    const conv = convertLive2dSources([{ name: 'look.motion3.json', text: motion3() }], src.doc, () => undefined);
    const dry = await applyOpsToModelFile(src, conv.ops, { dryRun: true });
    expect(dry).toMatchObject({ ok: true, changed: true, written: false, dryRun: true });
    expect(readFileSync(file, 'utf8')).toBe(src.text);
    const edit = await applyOpsToModelFile(src, conv.ops);
    expect(edit).toMatchObject({ ok: true, changed: true, written: true });
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('\r\n');
    expect(JSON.parse(text).animations.map((a: { id: string }) => a.id)).toEqual(['idle', 'look']);
    const again = await applyOpsToModelFile(await readModelDoc(file), []);
    expect(again).toMatchObject({ ok: true, changed: false, written: false });
  });

  it('writes nothing when an op fails, the result is invalid, or the file changed meanwhile', async () => {
    const file = write(formatModelJson(miniModel()));
    const src = await readModelDoc(file);
    const failed = await applyOpsToModelFile(src, [{ op: 'remove', kind: 'animation', id: 'nope' }]);
    expect(failed.ok).toBe(false);
    expect(failed.results[0]).toMatchObject({ ok: false });
    const invalid = await applyOpsToModelFile(src, [{ op: 'add', kind: 'animation', value: { id: 'bad', duration: 1, tracks: [{ target: 'param:Nope', keys: [{ t: 0, v: 0 }] }] } }]);
    expect(invalid.ok).toBe(false);
    expect(invalid.diagnostics.some((d) => d.severity === 'error')).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(src.text);
    writeFileSync(file, src.text + ' ');
    await expect(applyOpsToModelFile(src, [{ op: 'set', target: 'part:face.opacity', value: 0.5 }])).rejects.toThrow(/changed on disk while the import was converted/);
  });

  it('explains unreadable model files', async () => {
    await expect(readModelDoc(path.join(root, 'missing.r2d.json'))).rejects.toMatchObject({ kind: 'not-found' });
    await expect(readModelDoc(write('{ nope'))).rejects.toThrow(/is not valid JSON/);
    await expect(readModelDoc(write('[1]'))).rejects.toThrow(/does not hold a model object/);
    expect(existsSync(root)).toBe(true);
  });
});
