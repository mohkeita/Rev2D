import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadModelFile, loadModelObject } from '../src/node/load.js';
import {
  ApiError,
  analyzeAnimation,
  buildSheet,
  fitSheetScale,
  fitViewBox,
  formatAnalysis,
  formatLayerLabel,
  formatLayerSpec,
  hitTest,
  inspectPose,
  inspectSeries,
  modelInfo,
  formatInfo,
  parseLayerSpec,
  parseLayerSyntax,
  parsePointSpec,
  parseSweep,
  parseTimeSpec,
  parseTrackColumns,
  planOptions,
  planSamples,
  PoseStats,
  coverBounds,
  clipMasks,
  renderFrame,
  renderPose,
  renderSequence,
  renderSheet,
  resolveViewBox,
  sampleEvents,
  sequenceTimes,
  sharedViewBox,
  splitLayerList,
  toPoseOptions,
  trackSeries,
  unionBounds,
  viewSplit,
  type ViewBox,
  RECIPES_SUMMARY,
  recipeTitles,
  recipesDescription,
} from '../src/api/index.js';
import { blankModel, compareNames, emptyModel, EXAMPLES_DIR, listTemplates, loadTemplate } from '../src/api/templates.js';
import { encodePNG, decodePNG, sheetSize, wrapCaption } from '../src/render/index.js';
import type { Model, Pose } from '../src/core/types.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'rev2d-api-'));

async function blank() {
  return loadModelObject(blankModel({ name: 'blank', width: 200, height: 200 }), tmp);
}

function pixel(img: { width: number; data: Uint8ClampedArray }, x: number, y: number) {
  const i = (y * img.width + x) * 4;
  return Array.from(img.data.slice(i, i + 4));
}

describe('api', () => {
  it('blank template validates and compiles', async () => {
    const m = await blank();
    expect(m.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(m.rig).not.toBeNull();
  });

  it('renders a frame with the body in the middle', async () => {
    const m = await blank();
    const f = renderFrame(m, {});
    expect(f.image.width).toBe(200);
    expect(f.image.height).toBe(200);
    const center = pixel(f.image, 100, 110);
    expect(center[3]).toBe(255);
    // background is #20242c
    expect(pixel(f.image, 2, 2)).toEqual([0x20, 0x24, 0x2c, 255]);
    const png = encodePNG(f.image);
    expect(decodePNG(png).width).toBe(200);
  });

  it('overlays and fit viewBox', async () => {
    const m = await blank();
    const f = renderFrame(m, { overlay: ['bones', 'labels', 'grid'], viewBox: 'fit', scale: 2 });
    expect(f.viewBox[2]).toBeLessThan(200);
    expect(f.image.width).toBe(f.viewBox[2] * 2);
  });

  it('parameters change the pose', async () => {
    const m = await blank();
    const a = inspectPose(m, { params: { Lean: -1 } });
    const b = inspectPose(m, { params: { Lean: 1 } });
    const ca = a.parts.find((p) => p.id === 'body')!.center!;
    const cb = b.parts.find((p) => p.id === 'body')!.center!;
    expect(cb[0]).toBeGreaterThan(ca[0]);
    expect(() => inspectPose(m, { params: { Nope: 1 } })).toThrow(ApiError);
  });

  it('animation sequences and sheets', async () => {
    const m = await blank();
    expect(sequenceTimes(m.model!, { animation: 'idle', frames: 4 })).toEqual([0, 0.5, 1, 1.5]);
    const seq = renderSequence(m, { animation: 'idle', frames: 4 });
    expect(seq.frames).toHaveLength(4);
    const sheet = renderSheet(m, { animation: 'idle', frames: 4 });
    expect(sheet.width).toBeGreaterThan(200);
    const sweep = renderSheet(m, { sweeps: [parseSweep(m.model!, 'Lean=-1:1:3'), parseSweep(m.model!, 'Squash=0,1')] });
    expect(sweep.height).toBeGreaterThan(sweep.width / 3);
  });

  it('info and hit test', async () => {
    const m = await blank();
    const info = modelInfo(m.model!);
    expect(info.counts.parts).toBe(2);
    expect(formatInfo(info)).toContain('bodyWarp');
    const hits = hitTest(m, { x: 100, y: 110 });
    expect(hits[0].partId).toBe('body');
    expect(hitTest(m, { x: 1, y: 1 })).toEqual([]);
  });

  it('reports load errors as diagnostics', async () => {
    const file = path.join(tmp, 'bad.r2d.json');
    writeFileSync(file, '{ "format": "rev2d", "version": 1, "meta": { "name": "x", "width": 10, "height": 10 }, "bones": [{ "id": "a", "parent": "zz" }] }');
    const m = await loadModelFile(file);
    expect(m.rig).toBeNull();
    expect(m.diagnostics.some((d) => d.severity === 'error')).toBe(true);
    expect(() => renderFrame(m)).toThrow(ApiError);
    const missing = await loadModelFile(path.join(tmp, 'nope.r2d.json'));
    expect(missing.diagnostics[0].code).toBe('file-not-found');
  });
});

/** The ApiError thrown by `fn` (fails the test when nothing or something else is thrown). */
function apiError(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    return e as ApiError;
  }
  throw new Error('expected an ApiError, nothing was thrown');
}

describe('parseSweep', () => {
  it('parses the four forms', async () => {
    const model = (await blank()).model!;
    expect(parseSweep(model, 'Lean')).toEqual({ param: 'Lean', values: [-1, -0.5, 0, 0.5, 1] });
    expect(parseSweep(model, 'Squash=0:1')).toEqual({ param: 'Squash', values: [0, 0.25, 0.5, 0.75, 1] });
    expect(parseSweep(model, 'Lean=-1:1:3')).toEqual({ param: 'Lean', values: [-1, 0, 1] });
    expect(parseSweep(model, 'Lean=1:-1:2')).toEqual({ param: 'Lean', values: [1, -1] });
    expect(parseSweep(model, 'Lean=0.5:1:1')).toEqual({ param: 'Lean', values: [0.5] });
    expect(parseSweep(model, 'Lean=-1,0,0.25')).toEqual({ param: 'Lean', values: [-1, 0, 0.25] });
    expect(parseSweep(model, ' Lean = -1 : 1 : 3 ')).toEqual({ param: 'Lean', values: [-1, 0, 1] });
    // Out-of-range values are kept (evaluation clamps them).
    expect(parseSweep(model, 'Lean=-2,2')).toEqual({ param: 'Lean', values: [-2, 2] });
  });

  it('suggests the closest parameter for an unknown id', async () => {
    const model = (await blank()).model!;
    let e = apiError(() => parseSweep(model, 'Laen=-1:1:3'));
    expect(e.message).toBe('unknown parameter "Laen" in sweep "Laen=-1:1:3"');
    expect(e.hint).toBe('did you mean "Lean"?');
    e = apiError(() => parseSweep(model, 'Nope'));
    expect(e.hint).toBe('available parameters: Lean, Squash');
    e = apiError(() => parseSweep(model, '=0:1'));
    expect(e.message).toBe('sweep "=0:1" names no parameter');
    expect(e.hint).toBe('start with a parameter id, e.g. "Lean=-1:1:5"');
  });

  it.each([
    ['Lean=', 'no values after "="'],
    ['Lean=  ', 'no values after "="'],
    ['Lean=1=2', 'more than one "="'],
    ['Lean=0:1:2:3', 'expected min:max or min:max:steps, got 4 ":"-separated parts'],
    ['Lean=:1', 'min is missing'],
    ['Lean=0:', 'max is missing'],
    ['Lean=0:1:', 'steps is missing'],
    ['Lean=a:1', 'min "a" is not a finite number'],
    ['Lean=0:Infinity', 'max "Infinity" is not a finite number'],
    ['Lean=0:1:2.5', 'steps must be a whole number >= 2 (or 1 for just min), got 2.5'],
    ['Lean=0:1:0', 'steps must be a whole number >= 2 (or 1 for just min), got 0'],
    ['Lean=0:1:-3', 'steps must be a whole number >= 2 (or 1 for just min), got -3'],
    ['Lean=0:1:1e6', '1000000 steps is too many (max 1000)'],
    ['Lean=1,,2', 'value 2 is missing'],
    ['Lean=1,2,', 'value 3 is missing'],
    ['Lean=1,x', 'value 2 "x" is not a finite number'],
    ['Lean=NaN', 'value 1 "NaN" is not a finite number'],
  ])('rejects %s', async (spec, why) => {
    const model = (await blank()).model!;
    const e = apiError(() => parseSweep(model, spec));
    expect(e.message).toBe(`bad sweep "${spec}": ${why}`);
    expect(e.hint).toBe('forms: "Param" (5 values over its range), "Param=min:max" (5 values), "Param=min:max:steps" or "Param=v1,v2,..."; "A,B=..." links parameters (same values), e.g. "Lean=-1:1:5"');
  });

  it('caps comma lists too', async () => {
    const model = (await blank()).model!;
    const e = apiError(() => parseSweep(model, `Lean=${Array.from({ length: 1001 }, () => 0).join(',')}`));
    expect(e.message).toMatch(/: 1001 values is too many \(max 1000\)$/);
  });
});

describe('toPoseOptions', () => {
  it('parses id@weight layers and keeps valid inputs', async () => {
    const model = (await blank()).model!;
    expect(toPoseOptions(model, {})).toEqual({ time: 0, animations: [], params: undefined, physics: undefined });
    const o = toPoseOptions(model, {
      time: 1.5,
      animations: ['idle@0.25', 'idle', { id: 'idle', weight: 0, time: 3 }, 'idle@1'],
      params: { Lean: 5 },
      physics: false,
    });
    expect(o).toEqual({
      time: 1.5,
      animations: [{ id: 'idle', weight: 0.25 }, { id: 'idle' }, { id: 'idle', weight: 0, time: 3 }, { id: 'idle', weight: 1 }],
      params: { Lean: 5 },
      physics: false,
    });
  });

  it('rejects unknown ids with did-you-mean hints', async () => {
    const model = (await blank()).model!;
    let e = apiError(() => toPoseOptions(model, { animations: ['idel@0.5'] }));
    expect(e.message).toBe('unknown animation "idel"');
    expect(e.hint).toBe('did you mean "idle"?');
    e = apiError(() => toPoseOptions(model, { animations: [{ id: 'walk' }] }));
    expect(e.hint).toBe('available animations: idle');
    e = apiError(() => toPoseOptions(model, { params: { Laen: 1 } }));
    expect(e.message).toBe('unknown parameter "Laen"');
    expect(e.hint).toBe('did you mean "Lean"?');
  });

  it.each([
    ['idle@1.5', 'weight of animation layer "idle@1.5" must be a number within 0..1, got "1.5"'],
    ['idle@-0.1', 'weight of animation layer "idle@-0.1" must be a number within 0..1, got "-0.1"'],
    ['idle@', 'weight of animation layer "idle@" must be a number within 0..1, got ""'],
    ['idle@half', 'weight of animation layer "idle@half" must be a number within 0..1, got "half"'],
    [{ id: 'idle', weight: 2 }, 'weight of animation layer "idle" must be a number within 0..1, got 2'],
    [{ id: 'idle', weight: Number.NaN }, 'weight of animation layer "idle" must be a number within 0..1, got NaN'],
    [{ id: 'idle', weight: '0.5' }, 'animation layer "idle": weight must be a number, got "0.5"'],
    [{ id: 'idle', time: Number.POSITIVE_INFINITY }, 'time of animation layer "idle" must be a finite number of seconds, got Infinity'],
    [42, 'bad animation layer 42'],
    [{ weight: 1 }, 'bad animation layer {"weight":1}'],
  ])('rejects the layer %j', async (layer, message) => {
    const model = (await blank()).model!;
    const e = apiError(() => toPoseOptions(model, { animations: [layer as string] }));
    expect(e.message).toBe(message);
    expect(e.hint).toBeTruthy();
  });

  it('rejects negative or non-finite times and non-finite parameter values', async () => {
    const model = (await blank()).model!;
    for (const time of [-0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const e = apiError(() => toPoseOptions(model, { time }));
      expect(e.message).toBe(`time must be a finite number of seconds >= 0, got ${time}`);
    }
    const e = apiError(() => toPoseOptions(model, { params: { Lean: Number.NaN } }));
    expect(e.message).toBe('parameter "Lean" needs a finite number, got NaN');
    expect(e.hint).toBe('its range is -1..1');
    // Every pose entry point validates the same way.
    const m = await blank();
    expect(() => renderFrame(m, { animations: ['idle@2'] })).toThrow(ApiError);
    expect(() => inspectPose(m, { time: -1 })).toThrow(/time must be a finite number of seconds >= 0/);
  });
});

describe('sequenceTimes', () => {
  it('validates the animation, frames and fps', async () => {
    const model = (await blank()).model!;
    expect(sequenceTimes(model, { animation: 'idle', fps: 2 })).toEqual([0, 0.5, 1, 1.5]);
    expect(apiError(() => sequenceTimes(model, { animation: 'idel' })).hint).toBe('did you mean "idle"?');
    expect(apiError(() => sequenceTimes(model, { animation: 'idle', frames: 0 })).message).toBe('frames must be a whole number >= 1, got 0');
    expect(apiError(() => sequenceTimes(model, { animation: 'idle', frames: 2.5 })).message).toBe('frames must be a whole number >= 1, got 2.5');
    expect(apiError(() => sequenceTimes(model, { animation: 'idle', fps: 0 })).message).toBe('fps must be a number > 0, got 0');
  });
});

describe('shared fit view box', () => {
  /** Blank model whose idle animation also slides the body far to the right, so per-frame fits differ a lot. */
  async function sliding() {
    const doc = blankModel({ name: 'slide', width: 200, height: 200 }) as any;
    doc.animations[0].tracks.push({ target: 'bone:root.x', keys: [{ t: 0, v: 60 }, { t: 1, v: 140 }, { t: 2, v: 60 }] });
    return loadModelObject(doc, tmp);
  }

  const sameSize = (boxes: ViewBox[]) => new Set(boxes.map((b) => `${b[2]}x${b[3]}`)).size === 1;
  const samePixels = (a: { data: Uint8ClampedArray }, b: { data: Uint8ClampedArray }) => Buffer.from(a.data).equals(Buffer.from(b.data));

  it('frames a whole sequence with the union of every frame', async () => {
    const m = await sliding();
    const seq = renderSequence(m, { animation: 'idle', frames: 4, viewBox: 'fit', padding: 4 });
    const poses: Pose[] = seq.frames.map((f) => f.pose);
    const perFrame = poses.map((p) => resolveViewBox(m.model!, p, { viewBox: 'fit', padding: 4 }));
    expect(sameSize(perFrame)).toBe(false);
    expect(seq.viewBox).toEqual(fitViewBox(poses, 4));
    for (const f of seq.frames) {
      expect(f.viewBox).toEqual(seq.viewBox);
      expect([f.image.width, f.image.height]).toEqual([seq.viewBox[2], seq.viewBox[3]]);
    }
    // The shared box covers every frame's own fit box (up to the sub-pixel rounding of "fit").
    for (const b of perFrame) {
      expect(b[0]).toBeGreaterThanOrEqual(seq.viewBox[0]);
      expect(b[1]).toBeGreaterThanOrEqual(seq.viewBox[1]);
      expect(b[0] + b[2]).toBeLessThanOrEqual(seq.viewBox[0] + seq.viewBox[2] + 1);
      expect(b[1] + b[3]).toBeLessThanOrEqual(seq.viewBox[1] + seq.viewBox[3] + 1);
    }
    // Same pixels as passing the shared box explicitly (what the CLI resolves up front).
    const explicit = renderSequence(m, { animation: 'idle', frames: 4, viewBox: seq.viewBox });
    expect(explicit.viewBox).toEqual(seq.viewBox);
    seq.frames.forEach((f, i) => expect(samePixels(f.image, explicit.frames[i].image)).toBe(true));
    // Without 'fit' every frame shows the canvas.
    expect(renderSequence(m, { animation: 'idle', frames: 2 }).viewBox).toEqual([0, 0, 200, 200]);
  });

  it('frames every sheet cell alike (sweeps and animation sheets)', async () => {
    const m = await sliding();
    const rig = m.rig!;
    const model = m.model!;
    const sweeps = [parseSweep(model, 'Lean=-1:1:3'), parseSweep(model, 'Squash=0,1')];
    const poses = sweeps[1].values.flatMap((vy) => sweeps[0].values.map((vx) => rig.pose(toPoseOptions(model, { params: { Lean: vx, Squash: vy } }))));
    const shared = fitViewBox(poses)!;
    expect(sameSize(poses.map((p) => fitViewBox([p])!))).toBe(false);
    const fit = renderSheet(m, { sweeps, viewBox: 'fit' });
    const explicit = renderSheet(m, { sweeps, viewBox: shared });
    expect([fit.width, fit.height]).toEqual([explicit.width, explicit.height]);
    expect(samePixels(fit, explicit)).toBe(true);

    const seq = renderSequence(m, { animation: 'idle', frames: 6, viewBox: 'fit' });
    const animFit = renderSheet(m, { animation: 'idle', frames: 6, viewBox: 'fit' });
    const animExplicit = renderSheet(m, { animation: 'idle', frames: 6, viewBox: seq.viewBox });
    expect(samePixels(animFit, animExplicit)).toBe(true);
  });

  it('matches the single-frame fit for one pose and falls back to the canvas when nothing is visible', async () => {
    const m = await blank();
    const pose = m.rig!.pose({});
    const b = unionBounds(pose)!;
    expect(fitViewBox([pose], 16)).toEqual([Math.floor(b[0] - 16), Math.floor(b[1] - 16), Math.ceil(b[2] + 32), Math.ceil(b[3] + 32)]);
    expect(renderFrame(m, { viewBox: 'fit' }).viewBox).toEqual(fitViewBox([pose]));

    const doc = blankModel({ width: 120, height: 90 }) as any;
    for (const part of doc.parts) part.opacity = 0;
    const hidden = await loadModelObject(doc, tmp);
    const hiddenPose = hidden.rig!.pose({});
    expect(fitViewBox([hiddenPose])).toBeNull();
    expect(sharedViewBox(hidden.model as Model, [hiddenPose], { viewBox: 'fit' })).toEqual([0, 0, 120, 90]);
    expect(renderSequence(hidden, { animation: 'idle', frames: 2, viewBox: 'fit' }).viewBox).toEqual([0, 0, 120, 90]);
  });

  it('validates padding and sheet inputs', async () => {
    const m = await blank();
    const pose = m.rig!.pose({});
    expect(apiError(() => sharedViewBox(m.model!, [pose], { viewBox: 'fit', padding: -1 })).message).toBe('padding must be a finite number of model px >= 0, got -1');
    // Padding only matters for 'fit'.
    expect(sharedViewBox(m.model!, [pose], { padding: -1 })).toEqual([0, 0, 200, 200]);
    const lean = parseSweep(m.model!, 'Lean=-1,1');
    expect(apiError(() => renderSheet(m, { sweeps: [lean, lean] })).message).toBe('both sweeps vary "Lean"');
    expect(apiError(() => renderSheet(m, { sweeps: [lean, lean, lean] })).message).toBe('at most 2 sweeps (columns x rows), got 3');
    expect(apiError(() => renderSheet(m, { sweeps: [{ param: 'Lean', values: [] }] })).message).toBe('sweep "Lean" has no values');
    expect(apiError(() => renderSheet(m, { animation: 'idle', sweeps: [lean] })).message).toBe(
      'a sheet shows one of an animation, parameter sweeps or a parameter overview, got animation and sweeps',
    );
    expect(apiError(() => renderSheet(m, {})).message).toBe('sheet needs an animation, parameter sweeps or a parameter overview');
    // renderPose keeps taking an explicit, already resolved view box.
    expect(renderPose(m, m.rig!, pose, { viewBox: [0, 0, 10, 10] }).image.width).toBe(10);
  });
});

describe('listTemplates', () => {
  it('lists "blank" and "empty" first, then the examples sorted by name', () => {
    const names = listTemplates();
    expect(names.slice(0, 2)).toEqual(['blank', 'empty']);
    const examples = names.slice(2);
    expect(examples.length).toBeGreaterThan(1);
    expect(examples).toEqual([...examples].sort(compareNames));
    expect(new Set(names).size).toBe(names.length);
    const onDisk = readdirSync(EXAMPLES_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    for (const name of examples) expect(onDisk).toContain(name);
  });

  it('sorts case-insensitively, independently of the directory order', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'rev2d-templates-'));
    for (const name of ['zeta', 'Beta', 'alpha', 'blank', 'empty', 'no-model']) {
      mkdirSync(path.join(dir, name));
      if (name !== 'no-model') writeFileSync(path.join(dir, name, `${name}.r2d.json`), '{}');
    }
    writeFileSync(path.join(dir, 'stray.r2d.json'), '{}');
    // "blank" and "empty" are built-in templates (examples of those names are shadowed, not listed twice).
    expect(listTemplates(dir)).toEqual(['blank', 'empty', 'alpha', 'Beta', 'zeta']);
    expect(listTemplates(path.join(dir, 'missing'))).toEqual(['blank', 'empty']);
    expect(['b', 'B', 'a', 'A'].sort(compareNames)).toEqual(['A', 'a', 'B', 'b']);
  });
});

// ----------------------------------------------------------------------------- round-2 features

/**
 * A small rig with everything the analysis tools look at: a two-bone IK arm whose target (bound to
 * Reach) goes out of reach, a physics group whose output (Sway) clamps, events, a looping animation
 * whose last key does not match its first, and a non-looping one-shot.
 */
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
    ],
    bindings: [
      { target: 'bone:target.x', params: ['Reach'], keys: [{ at: [-1], value: 100 }, { at: [1], value: 220 }] },
      { target: 'bone:tail.rotation', params: ['Sway'], keys: [{ at: [-1], value: -45 }, { at: [1], value: 45 }] },
      { target: 'part:lid.opacity', params: ['Blink'], keys: [{ at: [0], value: 0 }, { at: [1], value: 1 }] },
    ],
    ik: [{ id: 'armIk', bones: ['upper', 'lower'], target: 'target' }],
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

async function rig(doc: Record<string, any> = rigDoc()) {
  const m = await loadModelObject(doc, tmp);
  expect(m.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  return m;
}

describe('animation layer syntax', () => {
  it('parses weights and comma options into AnimationLayer fields', async () => {
    const model = (await rig()).model!;
    expect(parseLayerSpec(model, 'reach')).toEqual({ id: 'reach' });
    expect(parseLayerSpec(model, 'wave@0.8,add')).toEqual({ id: 'wave', weight: 0.8, mode: 'add' });
    expect(parseLayerSpec(model, 'reach,override')).toEqual({ id: 'reach', mode: 'override' });
    expect(parseLayerSpec(model, 'wink,once')).toEqual({ id: 'wink', hold: false });
    expect(parseLayerSpec(model, 'wink, hold ,start=2.5')).toEqual({ id: 'wink', hold: true, start: 2.5 });
    expect(parseLayerSpec(model, 'wave,time=0.25')).toEqual({ id: 'wave', time: 0.25 });
    expect(parseLayerSpec(model, 'wink,start=-1')).toEqual({ id: 'wink', start: -1 });
    // A looping layer with "once" and a positive start is silent before its start, then loops (core layerActive).
    expect(parseLayerSpec(model, 'wave,add,once,start=1.5')).toEqual({ id: 'wave', mode: 'add', hold: false, start: 1.5 });
    // The same forms reach PoseOptions (strings and objects).
    expect(toPoseOptions(model, { animations: ['wave@0.5,add', { id: 'wink', start: 1, hold: false, mode: 'add' }] }).animations).toEqual([
      { id: 'wave', weight: 0.5, mode: 'add' },
      { id: 'wink', start: 1, hold: false, mode: 'add' },
    ]);
  });

  it.each([
    ['wave,ad', 'unknown option "ad" in animation layer "wave,ad"', 'did you mean "add"? (options: add, override, once, hold, start=<seconds>, time=<seconds>)'],
    ['wave,', 'empty option in animation layer "wave," (two commas in a row, or a trailing comma)', undefined],
    ['wave,add,override', 'animation layer "wave,add,override" gives "add"/"override" more than once', undefined],
    ['wink,once,hold', 'animation layer "wink,once,hold" gives "once"/"hold" more than once', undefined],
    ['wink,start=abc', 'option "start=abc" in animation layer "wink,start=abc" needs a number of seconds', 'e.g. "wink,start=1.5"'],
    ['wink,start', 'option "start" in animation layer "wink,start" needs a number of seconds', undefined],
    ['wave,add=1', 'option "add" in animation layer "wave,add=1" takes no value', undefined],
    ['wave,once', '"once" has no effect on looping animation "wave" without a start > 0: a loop never ends, so "once" can only silence it before its start', 'to start the loop later, give a start: "wave,once,start=2" or {"id": "wave", "hold": false, "start": 2} (nothing before 2 s, then it loops); otherwise drop "once" (to stop a looping layer, remove it or give it weight 0)'],
    ['wave,once,start=0', '"once" has no effect on looping animation "wave" without a start > 0: a loop never ends, so "once" can only silence it before its start', undefined],
    ['wave,once,time=1', '"once" has no effect on looping animation "wave" without a start > 0: a loop never ends, so "once" can only silence it before its start', undefined],
    ['wink,start=1,time=0', 'animation layer "wink,start=1,time=0" sets both start and time', undefined],
    ['@0.5', 'animation layer "@0.5" names no animation', 'start with an animation id, e.g. "reach" or "reach@0.5"'],
    ['wave@2,add', 'weight of animation layer "wave@2,add" must be a number within 0..1, got "2"', undefined],
    ['wav,add', 'unknown animation "wav"', 'did you mean "wave"?'],
  ])('rejects %s', async (spec, message, hint) => {
    const model = (await rig()).model!;
    const e = apiError(() => parseLayerSpec(model, spec));
    expect(e.message).toBe(message);
    if (hint) expect(e.hint).toBe(hint);
    else expect(e.hint).toBeTruthy();
  });

  it('plays a looping layer with once and a start only from its start (without once, start shifts its phase)', async () => {
    const m = await rig();
    const model = m.model!;
    const reach = (time: number, animations: Array<string | Record<string, unknown>>) =>
      m.rig!.pose(toPoseOptions(model, { time, animations: animations as any, physics: false })).params.Reach;
    expect(reach(0.25, ['wave,start=1'])).toBeCloseTo(0.25, 6);
    expect(reach(0.25, ['wave,once,start=1'])).toBe(0);
    expect(reach(0.25, [{ id: 'wave', hold: false, start: 1 }])).toBe(0);
    expect(reach(1.25, ['wave,once,start=1'])).toBeCloseTo(0.25, 6);
    expect(reach(3.25, ['wave,once,start=1'])).toBeCloseTo(0.25, 6);
  });

  it('splits comma lists of layers, parses syntax without a model and formats layers back', async () => {
    expect(splitLayerList('idle,talk@0.8,add,wink,once,start=2')).toEqual(['idle', 'talk@0.8,add', 'wink,once,start=2']);
    expect(splitLayerList('idle, blink@0.5')).toEqual(['idle', 'blink@0.5']);
    expect(parseLayerSyntax('anything@0.5,add,start=1')).toEqual({ id: 'anything', weight: 0.5, mode: 'add', start: 1 });
    expect(apiError(() => parseLayerSyntax('x,ad')).message).toBe('unknown option "ad" in animation layer "x,ad"');
    const model = (await rig()).model!;
    for (const spec of ['reach', 'wave@0.5', 'wave@0.8,add,once,start=1.5', 'wink,once,start=2', 'wave,time=0.25']) {
      const layer = parseLayerSpec(model, spec);
      expect(formatLayerSpec(layer)).toBe(spec);
      expect(parseLayerSpec(model, formatLayerSpec(layer))).toEqual(layer);
    }
    expect(formatLayerSpec({ id: 'idle', weight: 1, mode: 'override', start: 0, hold: true })).toBe('idle');
  });

  it('checks object layers field by field', async () => {
    const model = (await rig()).model!;
    expect(apiError(() => toPoseOptions(model, { animations: [{ id: 'wave', mode: 'plus' } as any] })).message).toBe('animation layer "wave": mode must be "override" or "add", got "plus"');
    expect(apiError(() => toPoseOptions(model, { animations: [{ id: 'wink', hold: 'no' } as any] })).message).toBe('animation layer "wink": hold must be true or false, got "no"');
    const unknown = apiError(() => toPoseOptions(model, { animations: [{ id: 'wave', wieght: 1 } as any] }));
    expect(unknown.message).toBe('animation layer "wave": unknown field "wieght"');
    expect(unknown.hint).toBe('did you mean "weight"?');
  });

  it('labels layers for titles', () => {
    expect(formatLayerLabel({ id: 'talk', mode: 'add' })).toBe('talk(add)');
    expect(formatLayerLabel({ id: 'talk', weight: 0.8, mode: 'add' })).toBe('talk@0.8(add)');
    expect(formatLayerLabel({ id: 'wink', hold: false, start: 2.5 })).toBe('wink(once, start 2.5s)');
    expect(formatLayerLabel({ id: 'idle', weight: 1, mode: 'override', start: 0 })).toBe('idle');
  });
});

describe('time lists and sample plans', () => {
  it('parses a:b:n and lists', () => {
    expect(parseTimeSpec('0:2:5')).toEqual([0, 0.5, 1, 1.5, 2]);
    expect(parseTimeSpec('1:1:1')).toEqual([1]);
    expect(parseTimeSpec('0, 0.25,3')).toEqual([0, 0.25, 3]);
    for (const [spec, why] of [
      ['0:1', 'expected a:b:n (start:end:count), got 2 ":"-separated parts'],
      ['0:1:0', 'count must be a whole number >= 1, got "0"'],
      ['2:1:3', 'end 1 is before start 2'],
      ['0,,1', 'time 2 is missing'],
      ['-1,2', 'time 1 -1 is negative (times are seconds >= 0)'],
      ['0:1:x', 'count must be a whole number >= 1, got "x"'],
    ]) {
      expect(apiError(() => parseTimeSpec(spec)).message).toBe(`bad times "${spec}": ${why}`);
    }
  });

  it('samples a window: full loops exclude the end, partial windows include it', async () => {
    const model = (await rig()).model!;
    expect(planSamples(model, { animation: 'reach', frames: 4 })).toMatchObject({ times: [0, 0.5, 1, 1.5], fullLoop: true, end: 2, offset: 0, fps: 2 });
    expect(planSamples(model, { animation: 'reach', frames: 3, from: 0.5, to: 1.5 })).toMatchObject({ times: [0.5, 1, 1.5], fullLoop: false, end: 1.5, fps: 2 });
    // A window of exactly one cycle that does not start at 0 is still a full loop.
    expect(planSamples(model, { animation: 'reach', frames: 2, from: 1, to: 3 }).times).toEqual([1, 2]);
    expect(planSamples(model, { animation: 'wink', fps: 4 }).times).toEqual([0, 0.25, 0.5]);
    expect(planSamples(model, { animation: 'reach', times: [0.2, 1.7] })).toMatchObject({ times: [0.2, 1.7], end: 1.7, fullLoop: false });
  });

  it('warms up whole cycles and shifts every layer clock by them', async () => {
    const model = (await rig()).model!;
    const plan = planSamples(model, { animation: 'reach', frames: 2, warmup: 3 });
    expect(plan).toMatchObject({ offset: 4, times: [0, 1], evalTimes: [4, 5] });
    expect(planSamples(model, { animation: 'reach', frames: 2, warmup: 4 }).offset).toBe(4);
    expect(planSamples(model, { animation: 'reach', frames: 2, warmup: 0 }).offset).toBe(0);
    const opts = planOptions(toPoseOptions(model, { animations: ['reach', 'wave,time=0.5', 'wink,start=1'] }), plan);
    expect(opts.animations).toEqual([
      { id: 'reach', start: 4 },
      { id: 'wave', time: 0.5 },
      { id: 'wink', start: 5 },
    ]);
  });

  it.each([
    [{ animation: 'wink', warmup: 2 }, 'warmup only applies to looping animations: "wink" does not loop, so there is no steady state to run into'],
    [{ animation: 'reach', from: 1, to: 1 }, 'to (1) must be greater than from (1)'],
    [{ animation: 'reach', from: -1 }, 'from must be a finite number of seconds >= 0, got -1'],
    [{ animation: 'reach', times: [0.5], frames: 2 }, 'times lists the sample times itself; drop frames'],
    [{ animation: 'reach', times: [] }, 'times must be a non-empty list of seconds, got []'],
    [{ animation: 'reach', warmup: -1 }, 'warmup must be a finite number of seconds >= 0, got -1'],
    [{ animation: 'reach', fps: 5000 }, '10000 frames is too many (max 2000)'],
  ])('rejects %j', async (input, message) => {
    const model = (await rig()).model!;
    const e = apiError(() => planSamples(model, input as any));
    expect(e.message).toBe(message);
    expect(e.hint).toBeTruthy();
  });

  it('puts events into the frame interval [t, next t) they fall in', async () => {
    const m = await rig();
    const model = m.model!;
    const base = toPoseOptions(model, { animations: ['reach'] });
    const names = (plan: ReturnType<typeof planSamples>) => sampleEvents(m.rig!, base, plan).map((list) => list.map((e) => e.name));
    expect(names(planSamples(model, { animation: 'reach', frames: 4 }))).toEqual([[], ['half'], [], ['late']]);
    // Events exactly on a frame time belong to that frame; the loop end (t = 2 = next t = 0) is excluded.
    expect(names(planSamples(model, { animation: 'reach', frames: 8 }))).toEqual([[], [], ['half'], [], [], [], ['late'], []]);
    // With warm-up the layer clocks are shifted, so the same frames get the same events.
    expect(names(planSamples(model, { animation: 'reach', frames: 4, warmup: 5 }))).toEqual([[], ['half'], [], ['late']]);
    const wink = toPoseOptions(model, { animations: ['wink'] });
    expect(sampleEvents(m.rig!, wink, planSamples(model, { animation: 'wink', times: [0, 0.25, 0.4] })).map((l) => l.map((e) => e.name))).toEqual([[], ['shut'], []]);
    // No events anywhere: nothing is evaluated, every cell is empty.
    const idle = await blank();
    expect(sampleEvents(idle.rig!, toPoseOptions(idle.model!, { animations: ['idle'] }), planSamples(idle.model!, { animation: 'idle', frames: 3 }))).toEqual([[], [], []]);
  });
});

describe('pose statistics and notes', () => {
  it('notes IK out of reach, clamped physics and parts outside the view box', async () => {
    const m = await rig();
    const model = m.model!;
    const far = m.rig!.pose(toPoseOptions(model, { params: { Reach: 1 } }));
    const stats = new PoseStats(model, [0, 0, 100, 200]);
    stats.add(far);
    const notes = stats.notes();
    expect(notes.find((n) => n.startsWith('IK "armIk"'))).toBe(
      'IK "armIk": target out of reach in this frame; extension 1.5, the chain tip misses the target by 40 px and the chain snaps straight. Move the target closer, lengthen the bones, or set "stretch": true',
    );
    // An explicit crop leaves parts out on purpose: no per-part note, but the statistics still split them.
    expect(stats.notePartsOutsideView).toBe(false);
    expect(notes.some((n) => n.startsWith('visible parts entirely outside'))).toBe(false);
    expect(stats.parts().filter((s) => s.outsideView > 0).map((s) => s.id)).toEqual(['arm', 'dot']);
    expect(viewSplit(far, [0, 0, 100, 200])).toEqual({ inView: ['tailTip'], outsideView: ['arm', 'dot'] });
    const forced = new PoseStats(model, [0, 0, 100, 200], { partsOutsideView: true });
    forced.add(far);
    expect(forced.notes()).toContain('visible parts entirely outside the view box: arm, dot; use a "fit" view box (--viewbox fit) to include them');
    // The canvas view box (the default) lists them: the target dot (x = 216..224) is off the 200 px canvas.
    const canvas = new PoseStats(model, [0, 0, 200, 200]);
    canvas.add(far);
    expect(canvas.notePartsOutsideView).toBe(true);
    expect(canvas.notes()).toContain('visible parts entirely outside the view box: dot; use a "fit" view box (--viewbox fit) to include them');
    expect(new PoseStats(model, [0, 0, 200, 200], { partsOutsideView: false }).notePartsOutsideView).toBe(false);
    // Nothing visible in the view box at all: one note with the bounds of what is visible (explicit crops too).
    const none = new PoseStats(model, [0, 0, 20, 20]);
    none.add(far);
    expect(none.notes()).toContain('the visible parts [45, 95, 179, 60] lie entirely outside the view box; use a "fit" view box (--viewbox fit)');

    // Over an animation: shares of frames, clamped physics output with its peak.
    const many = new PoseStats(model, null);
    for (const t of [0.25, 0.5, 0.75, 1]) many.add(m.rig!.pose(toPoseOptions(model, { animations: ['reach'], time: t })), t);
    const all = many.notes();
    expect(all.some((n) => /^physics "swing": Sway clamped in (\d of 4|all 4) frames; raw output up to -?[\d.]+ vs range -1\.\.1/.test(n))).toBe(true);
    expect(many.ik()[0]).toMatchObject({ id: 'armIk', frames: 4, maxExtension: 1.5, maxExtensionAt: 1 });
    expect(many.ik()[0].outOfReach).toBeGreaterThan(0);
    // Physics off: no physics statistics at all.
    const off = new PoseStats(model, null);
    off.add(m.rig!.pose(toPoseOptions(model, { physics: false, params: { Reach: 1 } })));
    expect(off.physics()).toEqual([]);
  });

  it('bounds a masked part by its masks (a clipped glow cannot leave the canvas)', async () => {
    const doc = rigDoc();
    // 100 px wide, reaching 50 px past the left canvas edge, but clipped to the lid (10,10 20x10).
    doc.parts.push({ id: 'glow', shape: { type: 'rect', x: -50, y: 0, w: 100, h: 40 }, fill: '#ffffff', mask: ['lid'] });
    doc.parts.push({ id: 'shade', shape: { type: 'rect', x: -50, y: 0, w: 100, h: 40 }, fill: '#000000', mask: ['lid'], maskInvert: true });
    doc.parts.push({ id: 'miss', shape: { type: 'rect', x: 100, y: 100, w: 10, h: 10 }, fill: '#000000', mask: ['lid'] });
    const m = await rig(doc);
    const pose = m.rig!.pose(toPoseOptions(m.model!, { params: { Blink: 1 } }));
    const stats = new PoseStats(m.model!, [0, 0, 200, 200]);
    stats.add(pose);
    const part = (id: string) => stats.parts().find((s) => s.id === id)!;
    expect(part('glow')).toMatchObject({ visible: 1, outsideCanvas: 0, outsideView: 0 });
    // An inverted mask draws outside the mask parts: the full rect counts.
    expect(part('shade')).toMatchObject({ outsideCanvas: 1, maxOverflow: 50 });
    // A mask that misses the part leaves nothing to show: not "outside the view" either.
    expect(part('miss')).toMatchObject({ visible: 1, outsideView: 0, outsideCanvas: 0 });
    expect(coverBounds(pose, 'glow', clipMasks(m.model!))).toEqual([10, 10, 20, 10]);
    expect(coverBounds(pose, 'miss', clipMasks(m.model!))).toBeNull();
    expect(viewSplit(pose, [0, 0, 5, 5], m.model!).outsideView).toContain('glow');
  });

  it('notes nearly straight chains unless softness is set, and skips aim constraints', async () => {
    const doc = rigDoc();
    const m = await rig(doc);
    // Target 79 px away from the root: reachable, extension 79/80 > 0.98.
    const reach = -1 + (79 / 120) * 2;
    const pose = m.rig!.pose(toPoseOptions(m.model!, { params: { Reach: reach } }));
    const stats = new PoseStats(m.model!, null);
    stats.add(pose);
    expect(stats.ikNotes()).toEqual([
      'IK "armIk": chain nearly straight in this frame; extension 0.988 (> 0.98), so the joint may visibly snap as it straightens. Set "softness" (px, e.g. 10) or keep the target closer',
    ]);
    doc.ik[0].softness = 10;
    const soft = await rig(doc);
    const s2 = new PoseStats(soft.model!, null);
    s2.add(soft.rig!.pose(toPoseOptions(soft.model!, { params: { Reach: reach } })));
    expect(s2.ikNotes()).toEqual([]);
    doc.ik = [{ id: 'aim', bones: ['tail'], target: 'target' }];
    const aim = await rig(doc);
    const s3 = new PoseStats(aim.model!, null);
    s3.add(aim.rig!.pose(toPoseOptions(aim.model!, { params: { Reach: 1 } })));
    expect(s3.ikNotes()).toEqual([]);
  });
});

describe('inspect: IK, physics, points, series and tracks', () => {
  it('reports IK and physics sections and maps points', async () => {
    const m = await rig();
    const r = inspectPose(m, { params: { Reach: 0 }, points: ['180,100@lower', { x: 10, y: 20 }, '50,150@tail'] });
    expect(r.ik).toEqual([expect.objectContaining({ id: 'armIk', bones: ['upper', 'lower'], target: 'target', reached: true, extension: 0.75, error: 0, distance: 60, maxReach: 80 })]);
    expect(r.physics).toEqual([{ id: 'swing', outputs: [expect.objectContaining({ param: 'Sway', clamped: false, overridden: false })] }]);
    // The lower bone's tip (setup 180,100) follows the chain to the target (160,100).
    expect(r.points).toEqual([
      { spec: '180,100@lower', parent: 'lower', setup: [180, 100], posed: [160, 100] },
      { spec: '10,20', parent: null, setup: [10, 20], posed: [10, 20] },
      { spec: '50,150@tail', parent: 'tail', setup: [50, 150], posed: expect.any(Array) },
    ]);
    // Without points the key is absent; explicit parameters beat physics (overridden).
    const plain = inspectPose(m, { params: { Sway: 0.5 } });
    expect(plain.points).toBeUndefined();
    expect(plain.physics[0].outputs[0]).toMatchObject({ value: 0.5, overridden: true });
    expect(inspectPose(m, { physics: false }).physics).toEqual([]);
  });

  it('maps points through parts: a skinned part blends its skin bones (like Rig.mapPoint)', async () => {
    const doc = rigDoc();
    doc.parts.push({ id: 'sleeve', skin: { bones: ['upper', 'lower'] }, shape: { type: 'rect', x: 100, y: 96, w: 80, h: 8 }, fill: '#ffffff' });
    const m = await rig(doc);
    const input = { params: { Reach: 0 } };
    const r = inspectPose(m, { ...input, points: ['150,100@sleeve', '150,100@part:sleeve', '150,100@upper', '150,100@lower', '150,100@arm', '10,20@lid'] });
    const [skinned, prefixed, upper, lower, arm, lid] = r.points!;
    const pose = m.rig!.pose(toPoseOptions(m.model!, input));
    const r3 = (v: number) => Math.round(v * 1000) / 1000;
    expect(skinned).toEqual({ spec: '150,100@sleeve', parent: 'sleeve', setup: [150, 100], posed: m.rig!.mapPoint(pose, 'sleeve', 150, 100).map(r3) });
    expect(prefixed.posed).toEqual(skinned.posed);
    // Linear blend skinning: the posed point is a weighted average of the two rigid mappings, strictly between them.
    // (150,100 lies on the lower bone, so the lower bone dominates.)
    const w = (skinned.posed[1] - lower.posed[1]) / (upper.posed[1] - lower.posed[1]);
    expect(w).toBeGreaterThan(0);
    expect(w).toBeLessThan(0.5);
    expect(skinned.posed[0]).toBeCloseTo(lower.posed[0] + w * (upper.posed[0] - lower.posed[0]), 2);
    // A part with a parent maps like that parent; a part in model space leaves the point where it is.
    expect(arm.posed).toEqual(lower.posed);
    expect(lid.posed).toEqual([10, 20]);
    // Track columns take the same parents.
    const t = trackSeries(m, { ...input, times: [0], columns: ['point:150,100@sleeve'] });
    expect(t.rows[0][0]).toEqual(skinned.posed);
  });

  it('parses points with precise errors', async () => {
    const model = (await rig()).model!;
    expect(parsePointSpec(model, ' 1.5 , -2 @lower')).toEqual({ x: 1.5, y: -2, parent: 'lower' });
    expect(apiError(() => parsePointSpec(model, '1,2@lowr')).hint).toBe('did you mean "lower"?');
    expect(apiError(() => parsePointSpec(model, '1,2@tailTp')).hint).toBe('did you mean "tailTip"?');
    const unknown = apiError(() => parsePointSpec(model, '1,2@nowhere'));
    expect([unknown.message, unknown.hint]).toEqual(['unknown point parent "nowhere"', 'available bones, warps or parts: root, upper, lower, target, tail, arm, dot, tailTip, lid']);
    // Parts are parents too (a part with a parent maps like it, one in model space leaves the point).
    expect(parsePointSpec(model, '1,2@arm')).toEqual({ x: 1, y: 2, parent: 'arm' });
    expect(parsePointSpec(model, '1,2@lid')).toEqual({ x: 1, y: 2, parent: 'lid' });
    expect(parsePointSpec(model, '1,2@part:arm')).toEqual({ x: 1, y: 2, parent: 'part:arm' });
    expect(parsePointSpec(model, '1,2@bone:lower')).toEqual({ x: 1, y: 2, parent: 'bone:lower' });
    const noPart = apiError(() => parsePointSpec(model, '1,2@part:lower'));
    expect([noPart.message, noPart.hint]).toEqual(['unknown point parent "part:lower": the model has no part "lower"', 'available parts: arm, dot, tailTip, lid']);
    const kind = apiError(() => parsePointSpec(model, '1,2@prt:arm'));
    expect([kind.message, kind.hint]).toEqual(['bad point parent "prt:arm": unknown kind "prt"', 'write a bare id or prefix it with "bone:", "warp:" or "part:" (did you mean "part"?)']);
    const m = await rig();
    expect(apiError(() => inspectPose(m, { points: [{ x: 1, y: 2, parent: 5 as never }] })).message).toBe('point parent must be a bone, warp or part id, got 5');
    // A bone and a warp sharing an id (invalid, but API callers may pass any model): the bare id is ambiguous.
    const both = { ...model, warps: [{ id: 'tail', rect: [0, 0, 40, 40], cols: 1, rows: 1 }] } as unknown as typeof model;
    const amb = apiError(() => parsePointSpec(both, '1,2@tail'));
    expect([amb.message, amb.hint]).toEqual(['point parent "tail" is ambiguous: a bone and a warp share this id', 'write "bone:tail" or "warp:tail"']);
    expect(parsePointSpec(both, '1,2@warp:tail').parent).toBe('warp:tail');
    expect(apiError(() => parsePointSpec(model, '1@lower')).message).toBe('bad point "1@lower": expected two coordinates "x,y"');
    expect(apiError(() => parsePointSpec(model, 'a,2')).message).toBe('bad point "a,2": coordinates must be finite numbers (setup-space px)');
    expect(apiError(() => parsePointSpec(model, '1,2@')).message).toBe('bad point "1,2@": nothing after "@"');
  });

  it('evaluates a series sequentially (crossed events) or statelessly (any order)', async () => {
    const m = await rig();
    const s = inspectSeries(m, { animations: ['reach'], times: [0, 0.6, 1.6] });
    expect(s.times).toEqual([0, 0.6, 1.6]);
    expect(s.results.map((r) => r.time)).toEqual([0, 0.6, 1.6]);
    expect(s.results.map((r) => r.events.map((e) => e.name))).toEqual([[], ['half'], ['late']]);
    const frames = inspectSeries(m, { animations: ['reach'], frames: 4 });
    expect(frames.times).toEqual([0, 0.5, 1, 1.5]);
    const unordered = inspectSeries(m, { animations: ['reach'], times: [1.5, 0.5] });
    expect(unordered.results.map((r) => r.events.map((e) => e.name))).toEqual([['late'], ['half']]);
    expect(apiError(() => inspectSeries(m, { times: [0], time: 1 })).message).toBe('time and a series (times / frames) are exclusive');
    expect(apiError(() => inspectSeries(m, { frames: 3 })).message).toBe('frames samples the first animation layer, but no animation is given');
    expect(apiError(() => inspectSeries(m, {})).message).toBe('a series needs times or frames');
    expect(apiError(() => inspectSeries(m, { times: [-1] })).message).toBe('times[0] must be a finite number of seconds >= 0, got -1');
  });

  it('splits track columns, keeping the comma inside point columns', () => {
    expect(parseTrackColumns('param:A,point:10,20@head,bone:b, point:1.5,-2 ,ik:x')).toEqual(['param:A', 'point:10,20@head', 'bone:b', 'point:1.5,-2', 'ik:x']);
    expect(parseTrackColumns(['param:A', 'bone:b,bone:c'])).toEqual(['param:A', 'bone:b', 'bone:c']);
  });

  it('tracks chosen columns per time', async () => {
    const m = await rig();
    const t = trackSeries(m, {
      animations: ['reach'],
      times: [0.5, 1],
      columns:
        'param:Reach,bone:lower,bone:lower.tip,bone:upper.rotation,part:dot.center,part:dot.bounds,part:lid.opacity,part:lid.visible,ik:armIk,ik:armIk.reached,physics:swing.Sway,point:180,100@lower,bone:target.x',
    });
    expect(t.times).toEqual([0.5, 1]);
    expect(t.columns).toEqual([
      'param:Reach',
      'bone:lower',
      'bone:lower.tip',
      'bone:upper.rotation',
      'part:dot.center',
      'part:dot.bounds',
      'part:lid.opacity',
      'part:lid.visible',
      'ik:armIk',
      'ik:armIk.reached',
      'physics:swing.Sway',
      'point:180,100@lower',
      'bone:target.x',
    ]);
    expect(t.fields).toMatchObject({ 'bone:lower': ['x', 'y', 'rotation'], 'bone:lower.tip': ['x', 'y'], 'part:dot.bounds': ['x', 'y', 'w', 'h'], 'ik:armIk': ['extension', 'error'] });
    const [row0, row1] = t.rows;
    expect(row0[0]).toBe(0);
    expect(row0[4]).toEqual([160, 100]);
    expect(row0[8]).toEqual([0.75, 0]);
    expect(row0[9]).toBe(true);
    expect(row0[11]).toEqual([160, 100]);
    expect(row0[12]).toBe(160);
    expect(row1[0]).toBe(1);
    expect(row1[8]).toEqual([1.5, 40]);
    expect(row1[9]).toBe(false);
    expect(typeof row1[10]).toBe('number');
    // A property address that exists in the poses (warp offsets, shape fields, ...) is a column too.
    const lean = await blank();
    const w = trackSeries(lean, { animations: ['idle'], times: [0.5], columns: ['warp:bodyWarp.offsets'] });
    expect(Array.isArray(w.rows[0][0])).toBe(true);
  });

  it.each([
    ['param:Rech', 'bad track column "param:Rech": unknown parameter "Rech"', 'did you mean "Reach"?'],
    ['bone:lower.tipp', 'bad track column "bone:lower.tipp": unknown bone property "tipp"', 'did you mean "tip"?'],
    ['part:dot', 'bad track column "part:dot": a part column needs a property', undefined],
    ['ik:armIk.reach', 'bad track column "ik:armIk.reach": unknown IK field "reach"', 'did you mean "reached"?'],
    ['physics:swing.Swy', 'bad track column "physics:swing.Swy": physics group "swing" has no output "Swy"', 'outputs of "swing": physics:swing.Sway'],
    ['point:1,2@nowhere', 'unknown point parent "nowhere"', undefined],
    ['bogus:x', 'bad track column "bogus:x": unknown column kind "bogus"', undefined],
    ['part:dot.shape.rx', 'bad track column "part:dot.shape.rx": not a special column and no animated or bound property with that address', undefined],
  ])('rejects the column %s', async (column, message, hint) => {
    const m = await rig();
    const e = apiError(() => trackSeries(m, { times: [0], columns: column }));
    expect(e.message).toBe(message);
    if (hint) expect(e.hint).toBe(hint);
  });
});

describe('analyzeAnimation', () => {
  it('reports ranges, physics clamping, IK reach, events, the loop seam and the canvas', async () => {
    const m = await rig();
    const r = analyzeAnimation(m, { animation: 'reach', fps: 10 });
    expect(r).toMatchObject({ animation: 'reach', layers: [], duration: 2, loop: true, frames: 20, window: [0, 2], warmup: 0, canvas: [200, 200] });
    expect(r.params.find((p) => p.id === 'Reach')).toEqual({ id: 'Reach', min: -1, max: 1, range: [-1, 1], changes: true });
    expect(r.params.find((p) => p.id === 'Blink')).toMatchObject({ changes: false });
    expect(r.physics[0]).toMatchObject({ group: 'swing', param: 'Sway', range: [-1, 1], overriddenFrames: 0 });
    expect(r.physics[0].clampedFrames).toBeGreaterThan(10);
    expect(Math.abs(r.physics[0].peak)).toBeGreaterThan(1);
    expect(r.ik[0]).toMatchObject({ id: 'armIk', maxExtension: 1.5, maxExtensionAt: 1 });
    expect(r.events).toEqual([
      { animation: 'reach', name: 'half', t: 0.5, frame: 5, at: 0.5 },
      { animation: 'reach', name: 'late', t: 1.5, frame: 15, at: 1.5 },
    ]);
    // The last key (0) does not match the first (-1): the seam jumps.
    expect(r.seam!.ok).toBe(false);
    expect(r.seam!.params.find((p) => p.id === 'Reach')).toEqual({ id: 'Reach', start: -1, end: 0, jump: -1 });
    expect(r.seam!.bones.map((b) => b.id)).toContain('target');
    expect(r.seam!.pixels).toMatchObject({ threshold: 8, scale: 1 });
    expect(r.outsideCanvas).toEqual([expect.objectContaining({ part: 'dot', always: false })]);
    expect(r.notes.some((n) => n.startsWith('the loop does not close: at t=2 -> 0 Reach 0 -> -1'))).toBe(true);
    expect(r.notes.some((n) => n.startsWith('physics starts at rest at t=0'))).toBe(true);
    const text = formatAnalysis(r);
    for (const s of [
      'analysis of reach (2s loop): 20 frames over t=0..2s',
      'PHYSICS',
      'swing: Sway clamped in',
      'IK',
      'EVENTS',
      'reach:half  t=0.5s',
      'LOOP SEAM',
      'param Reach: 0 at the end -> -1 at the start (jump -1)',
      'dot leaves the canvas',
    ]) {
      expect(text).toContain(s);
    }
  });

  it('finds a closed loop closed, runs warm-up cycles and plays extra layers', async () => {
    const doc = rigDoc();
    doc.animations[0].tracks[0].keys = [
      { t: 0, v: -0.5, ease: 'inOutSine' },
      { t: 1, v: 0.5, ease: 'inOutSine' },
      { t: 2, v: -0.5 },
    ];
    const m = await rig(doc);
    const r = analyzeAnimation(m, { animation: 'reach', frames: 16, warmup: 6, animations: ['wink,start=0.5'], pixels: false });
    expect(r).toMatchObject({ warmup: 6, frames: 16, layers: ['wink(start 0.5s)'] });
    expect(r.seam!.params.filter((p) => p.id === 'Reach')).toEqual([]);
    expect(r.seam!.pixels).toBeNull();
    expect(r.events.map((e) => `${e.animation}:${e.name}`)).toEqual(['reach:half', 'wink:shut', 'reach:late']);
    expect(r.notes.some((n) => n.startsWith('physics starts at rest'))).toBe(false);
    // Non-looping animations have no seam.
    expect(analyzeAnimation(m, { animation: 'wink', fps: 8 }).seam).toBeNull();
    expect(apiError(() => analyzeAnimation(m, { animation: 'wink', warmup: 1 })).message).toMatch(/^warmup only applies to looping animations/);
  });

  it('does not mistake an ease arriving at the last key for a seam jump, and gives advice by cause', async () => {
    const doc = rigDoc();
    // inOutSine from 1 back to 0 over the last 0.2 s: continuous, but curved enough that a linear
    // extrapolation over 1/60 s misses the end by ~0.034 (> 1% of the range).
    doc.animations[1].tracks[0].keys = [{ t: 0, v: 0 }, { t: 0.8, v: 1, ease: 'inOutSine' }, { t: 1, v: 0 }];
    const closed = analyzeAnimation(await rig(doc), { animation: 'wave', physics: false, pixels: false });
    expect(closed.seam).toMatchObject({ ok: true, params: [], bones: [] });

    // A real jump in a keyed parameter plus physics settling: advice for each cause.
    const r = analyzeAnimation(await rig(), { animation: 'reach', fps: 10, pixels: false });
    const seam = r.notes.find((n) => n.startsWith('the loop does not close'))!;
    expect(seam).toContain('make the last keys of Reach equal the first (or use ease "smooth")');
    if (r.seam!.params.some((p) => p.id === 'Sway')) expect(seam).toContain('physics outputs Sway start at rest, so the first cycle cannot close');
    expect(seam).not.toContain('invisible');
  });

  it('explains seam jumps caused by looping layers whose cycle does not fit the loop', async () => {
    const fits = analyzeAnimation(await rig(), { animation: 'reach', frames: 4, animations: ['wave,add'], pixels: false });
    expect(fits.notes.some((n) => n.startsWith('layer "wave"'))).toBe(false);
    const doc = rigDoc();
    doc.animations[1].duration = 0.75;
    doc.animations[1].tracks[0].keys = [{ t: 0, v: 0 }, { t: 0.375, v: 0.5 }, { t: 0.75, v: 0 }];
    const r = analyzeAnimation(await rig(doc), { animation: 'reach', frames: 4, animations: ['wave,add'], pixels: false });
    expect(r.notes).toContain(
      'layer "wave" (0.75s loop) does not repeat a whole number of times in "reach" (2s), so the parameters it drives cannot close the loop; seam jumps there are expected (make the durations divide, or analyze the layers separately)',
    );
  });

  it('marks parts that are outside the canvas in every frame (intended framing) and does not note them', async () => {
    const doc = rigDoc();
    doc.parts.push({ id: 'floor', shape: { type: 'rect', x: -10, y: 190, w: 220, h: 20 }, fill: '#333333' });
    const r = analyzeAnimation(await rig(doc), { animation: 'wave', frames: 4, pixels: false });
    expect(r.outsideCanvas.find((o) => o.part === 'floor')).toMatchObject({ always: true, maxOverflow: 10, frames: 4 });
    expect(r.notes.some((n) => n.includes('floor'))).toBe(false);
    expect(formatAnalysis(r)).toContain('floor extends beyond the canvas in every frame (up to 10 px)');
  });
});

describe('docs summaries', () => {
  it('lists the numbered recipe headings, skipping code blocks and unnumbered sections', () => {
    const md = [
      '# Rev2D recipes',
      '## 0. Starter model',
      '## 1. Head turn: AngleX × AngleY warp grid',
      '```sh',
      '## 9. Not a heading: inside a code block',
      '```',
      '## 6. Arm IK: two-bone constraint',
      '## 16. Rigid accessory on a turning head (hat)',
      '## Troubleshooting',
    ].join('\n');
    expect(recipeTitles(md)).toEqual(['starter model', 'head turn', 'arm IK', 'rigid accessory on a turning head (hat)']);
    expect(recipesDescription(md)).toBe(`${RECIPES_SUMMARY} (4 recipes: starter model, head turn, arm IK, rigid accessory on a turning head (hat))`);
    expect(recipeTitles('## 1. IK chains: x')).toEqual(['IK chains']);
    // Missing file or no numbered recipes: the static summary.
    expect(recipesDescription(null)).toBe(RECIPES_SUMMARY);
    expect(recipesDescription('# nothing here')).toBe(RECIPES_SUMMARY);
    expect(recipesDescription('## 1. One')).toBe(`${RECIPES_SUMMARY} (1 recipe: one)`);
  });
});

describe('buildSheet', () => {
  it('animation sheets: title with extra layers, events per cell, notes', async () => {
    const m = await rig();
    const r = buildSheet(m, { animation: 'reach', frames: 4, animations: ['wave@0.5,add'], scale: 0.25 });
    expect(r).toMatchObject({ mode: 'animation', cells: 4, columns: 2, animation: 'reach', layers: ['wave@0.5(add)'], times: [0, 0.5, 1, 1.5], title: 'rig - reach + wave@0.5(add)' });
    expect(r.events).toEqual([
      { cell: 1, animation: 'reach', name: 'half', t: 0.5 },
      { cell: 3, animation: 'reach', name: 'late', t: 1.5 },
    ]);
    expect(r.captions).toEqual(['t=0.00s', 't=0.50s', 't=1.00s', 't=1.50s']);
    expect(r.notes.some((n) => n.startsWith('IK "armIk": target out of reach in'))).toBe(true);
    // The events line makes the caption area one line taller than without events.
    const quiet = buildSheet(m, { animation: 'wave', frames: 4, scale: 0.25 });
    expect(r.image.height).toBeGreaterThan(quiet.image.height);
    // Windows and warm-up show in the title.
    expect(buildSheet(m, { animation: 'reach', frames: 2, from: 0.5, to: 1, warmup: 3, scale: 0.1 }).title).toBe('rig - reach t=0.5..1s after 4s warm-up');
    expect(buildSheet(m, { animation: 'wink', times: [0, 0.25, 1], scale: 0.1 }).notes).toContain('"wink" does not loop: after 0.5s it holds its last pose (1 frame samples that)');
  });

  it('linked sweeps set every listed parameter', async () => {
    const doc = rigDoc();
    doc.parameters.push({ id: 'Blink2', min: 0, max: 1 });
    doc.bindings.push({ target: 'part:lid.tint', params: ['Blink2'], keys: [{ at: [0], value: '#ffffff' }, { at: [1], value: '#ff0000' }] });
    const m = await rig(doc);
    const model = m.model!;
    const sweep = parseSweep(model, 'Blink,Blink2=0:1:3');
    expect(sweep).toEqual({ param: 'Blink', values: [0, 0.5, 1], linked: ['Blink2'] });
    expect(parseSweep(model, 'Blink,Blink2')).toEqual({ param: 'Blink', values: [0, 0.25, 0.5, 0.75, 1], linked: ['Blink2'] });
    const r = buildSheet(m, { sweeps: [sweep], scale: 0.25 });
    expect(r.captions).toEqual(['Blink,Blink2=0', 'Blink,Blink2=0.5', 'Blink,Blink2=1']);
    expect(r.title).toBe('rig - sweep Blink,Blink2');
    // Both parameters really change: the lid (opacity from Blink, tint from Blink2) is red and opaque in the last cell.
    const last = m.rig!.pose(toPoseOptions(model, { params: { Blink: 1, Blink2: 1 } }));
    expect(last.parts.lid.opacity).toBe(1);
    expect(apiError(() => parseSweep(model, 'Blink,Reach')).message).toBe('linked parameters in sweep "Blink,Reach" have different ranges (Blink 0..1, Reach -1..1)');
    expect(apiError(() => parseSweep(model, 'Blink,Blink=0:1')).message).toBe('sweep "Blink,Blink=0:1" lists "Blink" twice');
    expect(apiError(() => parseSweep(model, 'Blink,Blnk2=0:1')).hint).toBe('did you mean "Blink2"?');
    expect(apiError(() => parseSweep(model, 'Blink,=0:1')).message).toBe('sweep "Blink,=0:1" has an empty parameter id in its list');
    expect(apiError(() => buildSheet(m, { sweeps: [sweep, parseSweep(model, 'Blink2=0,1')] })).message).toBe('both sweeps vary "Blink2"');
  });

  it('overview sheets: one row per parameter over its range', async () => {
    const m = await rig();
    const r = buildSheet(m, { overview: { params: ['Reach', 'Blink'], steps: 3 }, scale: 0.2 });
    expect(r).toMatchObject({ mode: 'overview', cells: 6, columns: 3, title: 'rig - overview: 2 parameters x 3 steps' });
    expect(r.overview).toEqual({
      params: ['Reach', 'Blink'],
      steps: 3,
      rows: [
        { param: 'Reach', values: [-1, 0, 1] },
        { param: 'Blink', values: [0, 0.5, 1] },
      ],
    });
    expect(r.captions).toEqual(['Reach=-1', 'Reach=0', 'Reach=1', 'Blink=0', 'Blink=0.5', 'Blink=1']);
    expect(buildSheet(m, { overview: {}, scale: 0.1 }).cells).toBe(15);
    expect(apiError(() => buildSheet(m, { overview: { params: ['Rech'] } })).hint).toBe('did you mean "Reach"?');
    expect(apiError(() => buildSheet(m, { overview: { steps: 0 } })).message).toBe('overview steps must be a whole number within 1..64, got 0');
    expect(apiError(() => buildSheet(m, { overview: {}, animation: 'reach' })).message).toMatch(/got animation and overview$/);
  });

  it('draws cells smaller when the sheet would exceed maxSide (only without an explicit scale)', async () => {
    const m = await rig();
    // 15 cells of the 200x200 canvas at scale 1: 5 x 3 cells, far wider than 400 px.
    const r = buildSheet(m, { overview: {}, maxSide: 400 });
    expect(r.scale).toBeLessThan(1);
    expect(Math.max(r.image.width, r.image.height)).toBeLessThanOrEqual(400);
    expect(r.image.width).toBeGreaterThan(380); // as large as fits, not needlessly small
    expect(r.notes).toContain(`cells are drawn at scale ${r.scale} so the 15-cell sheet fits 400 px per side (at scale 1 it would be 1048x680 px); set scale explicitly (--scale) to override, or show fewer cells or a smaller view box`);
    expect(fitSheetScale(r.viewBox, 15, 400, { columns: 5, title: r.title })).toBe(r.scale);
    // An explicit scale wins; a sheet that fits keeps scale 1 and gets no note.
    const explicit = buildSheet(m, { overview: {}, maxSide: 400, scale: 0.5 });
    expect([explicit.scale, explicit.image.width]).toEqual([0.5, 5 * 100 + 6 * 8]);
    expect(explicit.notes.some((n) => n.startsWith('cells are drawn'))).toBe(false);
    const small = buildSheet(m, { overview: { params: ['Reach'], steps: 2 }, maxSide: 4096 });
    expect(small.scale).toBe(1);
    expect(small.notes.some((n) => n.startsWith('cells are drawn'))).toBe(false);
  });

  it('wraps long sweep captions instead of cutting them, and fits maxSide with the taller captions', async () => {
    const doc = rigDoc();
    doc.parameters.push({ id: 'Blink2', min: 0, max: 1 });
    const m = await rig(doc);
    const sweeps = [parseSweep(m.model!, 'Blink,Blink2=0:1:4'), parseSweep(m.model!, 'Reach=-1:1:3')];
    // 80 px cells hold 13 characters: "Blink," / "Blink2=0.333" / "Reach=-1".
    const r = buildSheet(m, { sweeps, scale: 0.4 });
    expect(r.captions[1]).toBe('Blink,Blink2=0.333 Reach=-1');
    expect(wrapCaption(r.captions[1], 80)).toEqual(['Blink,', 'Blink2=0.333', 'Reach=-1']);
    const layout = { columns: 4, title: r.title, captions: r.captions };
    expect(r.image.height).toBe(sheetSize(12, 80, 80, layout).height);
    expect(r.image.height).toBe(sheetSize(12, 80, 80, { columns: 4, title: r.title }).height + 3 * 2 * (7 + 2));
    // maxSide: the fitted scale accounts for the extra caption lines of the narrower cells.
    const fit = buildSheet(m, { sweeps, maxSide: 300 });
    expect(fit.scale).toBeLessThan(1);
    expect(Math.max(fit.image.width, fit.image.height)).toBeLessThanOrEqual(300);
    expect(Math.max(fit.image.width, fit.image.height)).toBeGreaterThan(280);
    expect(fitSheetScale(fit.viewBox, 12, 300, { ...layout, title: fit.title })).toBe(fit.scale);
  });

  it('renderSequence reports notes and the sample plan', async () => {
    const m = await rig();
    const seq = renderSequence(m, { animation: 'reach', frames: 4, from: 0, to: 1, scale: 0.2 });
    expect(seq.times).toEqual([0, 1 / 3, 2 / 3, 1].map((t) => +t.toFixed(6)));
    expect(seq.plan.fullLoop).toBe(false);
    expect(seq.notes.some((n) => n.startsWith('IK "armIk"'))).toBe(true);
  });
});

describe('overlay focus through the api', () => {
  it('checks overlay only ids', async () => {
    const m = await rig();
    expect(renderFrame(m, { overlay: ['bones'], only: ['lower'], onlyChain: true }).image.width).toBe(200);
    const e = apiError(() => renderFrame(m, { overlay: ['bones'], only: ['lowr'] }));
    expect(e.message).toBe('unknown id "lowr" in overlay only');
    expect(e.hint).toBe('did you mean "lower"?');
  });
});

describe('templates and info', () => {
  it('"empty" is format, version and meta only, and validates', async () => {
    expect(emptyModel({ name: 'x', width: 300, height: 200 })).toEqual({ format: 'rev2d', version: 1, meta: { name: 'x', width: 300, height: 200 } });
    const { doc, textureFiles } = loadTemplate('empty', { name: 'scratch' });
    expect(doc).toEqual({ format: 'rev2d', version: 1, meta: { name: 'scratch', width: 512, height: 512 } });
    expect(textureFiles).toEqual([]);
    const m = await loadModelObject(doc, tmp);
    expect(m.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(renderFrame(m).image.width).toBe(512);
  });

  it('lists skinned parts under their bones and IK options', async () => {
    const doc = rigDoc();
    doc.parts.push({ id: 'sleeve', shape: { type: 'rect', x: 100, y: 95, w: 80, h: 10, detail: 10 }, skin: { bones: ['upper', 'lower'] } });
    doc.ik[0].softness = 6;
    const info = modelInfo((await rig(doc)).model!);
    const upper = info.bones[0].children[0];
    expect(upper).toMatchObject({ id: 'upper', attached: [], skinned: ['skin:sleeve'] });
    expect(upper.children[0]).toMatchObject({ id: 'lower', attached: ['part:arm'], skinned: ['skin:sleeve'] });
    expect(info.ik).toEqual([{ id: 'armIk', bones: ['upper', 'lower'], target: 'target', mix: 1, bendPositive: true, stretch: false, softness: 6 }]);
    const text = formatInfo(info);
    expect(text).toContain('upper (0, 0) 0° len 40  <- skin:sleeve');
    expect(text).toContain('lower (40, 0) 0° len 40  <- part:arm, skin:sleeve');
    expect(text).toContain('armIk: upper -> lower reaching target (mix 1, bendPositive true, stretch false, softness 6)');
  });
});
