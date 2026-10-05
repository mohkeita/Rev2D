import { beforeAll, describe, expect, it } from 'vitest';
import { Rig, buildRenderList } from '../../../core/rig.js';
import type { ImageRGBA, Model, Pose } from '../../../core/types.js';
import { validateModel } from '../../../core/validate.js';
import { decodePNG, diffImages, renderImage } from '../../../render/index.js';
import type { SpineExportOptions, SpineExportResult } from '../../types.js';
import { parseAtlas } from '../atlas.js';
import { frameTimes, warmupCycles } from '../bake.js';
import { exportSpine, importSpine } from '../index.js';
import { CHECKER, PROBE, evalSpine, loadExample, toCanvas, type Example } from './export-helpers.js';

type Json = Record<string, any>;

function files(res: SpineExportResult) {
  const json = res.files.find((f) => f.path.endsWith('.json'))!;
  const atlas = res.files.find((f) => f.path.endsWith('.atlas'))!;
  const pages = res.files.filter((f) => f.path.endsWith('.png'));
  return { json: JSON.parse(json.text!) as Json, jsonText: json.text!, atlasText: atlas.text!, pages };
}

/** Rig poses at the exported times of an animation, with the exporter's physics warm-up. */
function posesAt(ex: Example, animId: string, times: number[]): Pose[] {
  const anim = ex.model.animations.find((a) => a.id === animId)!;
  const player = ex.rig.player();
  const t0 = warmupCycles(ex.rig, anim) * anim.duration;
  return times.map((t) => player.update({ time: t0 + t, animations: [animId] }));
}

function hasVisibleFill(model: Model, id: string): boolean {
  const p = model.parts.find((x) => x.id === id)!;
  return !(typeof p.fill === 'string' && /^(transparent|#[0-9a-f]{6}00)$/i.test(p.fill));
}

/** For each Rev2D fill vertex of a part (setup pose), the index of the Spine vertex at the same place. */
function matchVertices(rev: Float32Array, spine: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < rev.length; i += 2) {
    let best = -1;
    let bestD = Infinity;
    for (let j = 0; j < spine.length; j += 2) {
      const d = Math.hypot(spine[j] - rev[i], spine[j + 1] - rev[i + 1]);
      if (d < bestD) {
        bestD = d;
        best = j / 2;
      }
    }
    out.push(bestD < 0.01 ? best : -1);
  }
  return out;
}

const physics = (model: Model) => model.physics.length > 0;

/** Time limit of hooks and tests that run whole exports. */
const EXPORT_TIMEOUT = 120_000;

const morphing = (model: Model, id: string) => [...model.bindings, ...model.animations.flatMap((a) => a.tracks)].some((b) => b.target.startsWith(`part:${id}.shape.`));

// ----------------------------------------------------------------------------- examples

describe.each(['minimal', 'slime', 'robot-arm'])('spine export of examples/%s', (name) => {
  let ex: Example;
  let exact: SpineExportResult;
  let res: SpineExportResult;
  // Two full exports: a few seconds alone, much longer on a loaded machine (parallel test workers).
  beforeAll(async () => {
    ex = await loadExample(name);
    exact = exportSpine(ex.model, ex.rig, ex.textures, { tolerance: 0 });
    res = exportSpine(ex.model, ex.rig, ex.textures);
  }, EXPORT_TIMEOUT);

  it('writes a consistent Spine 4.2 skeleton, atlas and pages', () => {
    const { json, atlasText, pages } = files(res);
    expect(res.files.map((f) => f.path)).toEqual([`${ex.model.meta.name}.json`, `${ex.model.meta.name}.atlas`, ...pages.map((p) => p.path)]);
    const { width: W, height: H } = ex.model.meta;
    expect(json.skeleton).toMatchObject({ spine: '4.2.00', x: 0, y: -H, width: W, height: H, images: './' });
    expect(json.skeleton.hash).toMatch(/^[A-Za-z0-9+/]{11}$/);
    const boneNames = (json.bones as Json[]).map((b) => b.name);
    expect(json.bones[0].parent).toBeUndefined();
    (json.bones as Json[]).forEach((b, i) => {
      if (i > 0) expect(boneNames.indexOf(b.parent), b.name).toBeGreaterThanOrEqual(0);
      if (i > 0) expect(boneNames.indexOf(b.parent)).toBeLessThan(i);
    });
    expect(new Set(boneNames).size).toBe(boneNames.length);
    const atlas = parseAtlas(atlasText);
    expect(atlas.pages.map((p) => p.name)).toEqual(pages.map((p) => p.path));
    atlas.pages.forEach((p, i) => {
      const img = decodePNG(pages[i].bytes!);
      expect([img.width, img.height]).toEqual([p.width, p.height]);
      expect(p.pma).toBe(true);
    });
    const skin = (json.skins as Json[])[0];
    expect(skin.name).toBe('default');
    for (const slot of json.slots as Json[]) {
      expect(boneNames).toContain(slot.bone);
      const att = skin.attachments[slot.name][slot.attachment];
      expect(att, slot.name).toBeDefined();
      if (att.type === 'clipping') {
        expect((json.slots as Json[]).some((s) => s.name === att.end)).toBe(true);
        expect(att.vertices).toHaveLength(att.vertexCount * 2);
        continue;
      }
      expect(att.type).toBe('mesh');
      const region = atlas.regions.find((r) => r.name === slot.attachment);
      expect(region, slot.name).toBeDefined();
      const n = att.uvs.length / 2;
      expect(att.hull).toBeGreaterThanOrEqual(3);
      expect(att.hull).toBeLessThanOrEqual(n);
      expect(att.uvs.every((u: number) => u >= 0 && u <= 1)).toBe(true);
      expect(att.triangles.every((t: number) => Number.isInteger(t) && t >= 0 && t < n)).toBe(true);
      if (att.vertices.length !== n * 2) {
        // Weighted: [count, (bone, x, y, weight) * count] per vertex, weights summing to 1.
        let i = 0;
        for (let v = 0; v < n; v++) {
          const c = att.vertices[i++];
          let sum = 0;
          for (let k = 0; k < c; k++) {
            expect(att.vertices[i]).toBeLessThan(boneNames.length);
            sum += att.vertices[i + 3];
            i += 4;
          }
          expect(sum).toBeCloseTo(1, 4);
        }
        expect(i).toBe(att.vertices.length);
      }
    }
    expect(Object.keys(json.animations)).toEqual(ex.model.animations.map((a) => a.id));
    for (const issue of res.report.issues) {
      expect(issue.code).toMatch(/^spine-[a-z0-9-]+$/);
      expect(issue.where, issue.code).toBeTruthy();
    }
    expect(res.report).toMatchObject({ format: 'spine', direction: 'export' });
    expect(res.report.stats.bones).toBe(json.bones.length);
    expect(res.report.stats.keys).toBeLessThan(res.report.stats.keysSampled);
  });

  it('reproduces every sampled frame exactly with tolerance 0 (independent Spine evaluation)', () => {
    const { json } = files(exact);
    const setup = ex.rig.pose({ time: 0 });
    const sp0 = evalSpine(json, null, 0);
    const matches = new Map<string, number[]>();
    for (const part of ex.model.parts) {
      const spine = sp0.vertices.get(part.id);
      const fill = setup.parts[part.id].fill;
      // Morphing parts are drawn from their largest state, so their setup mesh is not the default fill.
      if (!spine || !fill || !hasVisibleFill(ex.model, part.id) || morphing(ex.model, part.id)) continue;
      const m = matchVertices(fill, toCanvas(spine));
      expect(m.filter((i) => i < 0), `setup vertices of ${part.id}`).toHaveLength(0);
      matches.set(part.id, m);
    }
    expect(matches.size).toBeGreaterThan(0);
    for (const anim of ex.model.animations) {
      const times = frameTimes(anim.duration, 30, anim);
      const pick = [0, 1, Math.floor(times.length / 3), Math.floor((2 * times.length) / 3), times.length - 1];
      const poses = posesAt(ex, anim.id, times);
      for (const f of pick) {
        const pose = poses[f];
        const sp = evalSpine(json, anim.id, times[f]);
        let worst = 0;
        for (const [id, m] of matches) {
          const fill = pose.parts[id].fill!;
          if (fill.length !== m.length * 2) continue;
          const v = toCanvas(sp.vertices.get(id)!);
          m.forEach((j, i) => (worst = Math.max(worst, Math.hypot(v[2 * j] - fill[2 * i], v[2 * j + 1] - fill[2 * i + 1]))));
          const c = sp.colors.get(id)!;
          const pp = pose.parts[id];
          const want = [pp.tint[0], pp.tint[1], pp.tint[2], pp.visible ? pp.tint[3] * pp.opacity : 0];
          c.forEach((x, k) => expect(Math.abs(x - want[k]), `${anim.id}@${times[f]} color ${id}`).toBeLessThanOrEqual(1 / 255));
        }
        expect(worst, `${anim.id}@${times[f]}`).toBeLessThan(0.02);
        const drawn = new Set(pose.drawOrder);
        expect(sp.order.filter((s) => drawn.has(s)), `${anim.id}@${times[f]} draw order`).toEqual(pose.drawOrder);
      }
    }
  }, EXPORT_TIMEOUT);

  it('stays close between keys with the default tolerance', () => {
    const { json } = files(res);
    const setup = ex.rig.pose({ time: 0 });
    const sp0 = evalSpine(json, null, 0);
    const matches = new Map<string, number[]>();
    for (const part of ex.model.parts) {
      const spine0 = sp0.vertices.get(part.id);
      const fill0 = setup.parts[part.id].fill;
      if (!spine0 || !fill0 || morphing(ex.model, part.id) || !hasVisibleFill(ex.model, part.id)) continue;
      matches.set(part.id, matchVertices(fill0, toCanvas(spine0)));
    }
    for (const anim of ex.model.animations) {
      // Between the 30 fps samples, on the 60 Hz physics steps (Rev2D physics output changes per step).
      const times = Array.from({ length: Math.floor(anim.duration * 30) }, (_, i) => (2 * i + 1) / 60 + 1e-6).filter((t) => t < anim.duration);
      const poses = posesAt(ex, anim.id, times);
      let sum = 0;
      let n = 0;
      let worst = 0;
      times.forEach((t, f) => {
        const sp = evalSpine(json, anim.id, t);
        for (const [id, m] of matches) {
          const fill = poses[f].parts[id].fill;
          if (!fill || fill.length !== m.length * 2) continue;
          const v = toCanvas(sp.vertices.get(id)!);
          m.forEach((j, i) => {
            const d = Math.hypot(v[2 * j] - fill[2 * i], v[2 * j + 1] - fill[2 * i + 1]);
            sum += d;
            n++;
            worst = Math.max(worst, d);
          });
        }
      });
      expect(sum / n, `${anim.id} mean px error`).toBeLessThan(0.15);
      // Sampling refines wherever motion leaves the interpolation of its neighbours, and curves must
      // follow the samples between them too (slime's jump_loop was 2.6 px off between keys before).
      expect(worst, `${anim.id} worst px error`).toBeLessThan(physics(ex.model) ? 2 : 0.5);
    }
  }, EXPORT_TIMEOUT);

  it('round-trips through importSpine with a small pixel difference', () => {
    const { jsonText, atlasText, pages } = files(res);
    const imp = importSpine({ skeleton: jsonText, atlas: atlasText, pages: Object.fromEntries(pages.map((p) => [p.path, decodePNG(p.bytes!)])), padding: 0 });
    expect(imp.report.issues.filter((i) => i.severity === 'warning')).toEqual([]);
    const v = validateModel(imp.doc);
    expect(v.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const model = v.model!;
    expect([model.meta.width, model.meta.height]).toEqual([ex.model.meta.width, ex.model.meta.height]);
    const tex: Record<string, ImageRGBA> = {};
    for (const t of model.textures) tex[t.id] = decodePNG(imp.files.find((f) => f.path === t.path)!.bytes!);
    const rig = new Rig(model, { textures: Object.fromEntries(Object.entries(tex).map(([k, i]) => [k, { width: i.width, height: i.height }])) });
    let total = 0;
    let count = 0;
    let worst = 0;
    for (const anim of ex.model.animations) {
      const times = [0.2, 0.5, 0.8].map((f) => f * anim.duration);
      const poses = posesAt(ex, anim.id, times);
      times.forEach((t, i) => {
        const a = renderImage(buildRenderList(ex.rig, poses[i]), ex.textures, { background: [1, 1, 1, 1] });
        const b = renderImage(buildRenderList(rig, rig.pose({ time: t, animations: [anim.id] })), tex, { background: [1, 1, 1, 1] });
        const d = diffImages(a, b).meanDelta;
        total += d;
        count++;
        worst = Math.max(worst, d);
      });
    }
    expect(total / count).toBeLessThan(0.9);
    expect(worst).toBeLessThan(1.5);
  }, EXPORT_TIMEOUT);

  it('is deterministic', () => {
    const again = exportSpine(ex.model, ex.rig, ex.textures);
    expect(again.files.map((f) => f.text ?? Buffer.from(f.bytes!).toString('base64'))).toEqual(res.files.map((f) => f.text ?? Buffer.from(f.bytes!).toString('base64')));
    expect(again.report).toEqual(res.report);
  }, EXPORT_TIMEOUT);
});

// ----------------------------------------------------------------------------- a probe model

describe('spine export of a probe model', () => {
  let model: Model;
  let rig: Rig;
  let res: SpineExportResult;
  let json: Json;
  const textures = { checker: CHECKER };
  const run = (opts: SpineExportOptions = {}) => exportSpine(model, rig, textures, opts);
  beforeAll(() => {
    const v = validateModel(PROBE);
    expect(v.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    model = v.model!;
    rig = new Rig(model, { textures: { checker: { width: 8, height: 8 } } });
    res = run({ paramPoses: true });
    json = files(res).json;
  }, EXPORT_TIMEOUT);

  it('reports what it converts, approximates or drops, with stable codes and locations', () => {
    const codes = res.report.issues.map((i) => i.code);
    for (const code of [
      'spine-root-renamed',
      'spine-warp-bones',
      'spine-morph-baked',
      'spine-gradient-morph',
      'spine-ik-baked',
      'spine-part-hidden',
      'spine-mask-inverted',
      'spine-mask-clipping',
      'spine-paint-animated',
      'spine-event-data-dropped',
      'spine-parameters-baked',
      'spine-animations-sampled',
      'spine-animation-once',
    ]) {
      expect(codes, code).toContain(code);
    }
    for (const issue of res.report.issues) {
      expect(issue.where, issue.code).toBeTruthy();
      expect(['info', 'warning']).toContain(issue.severity);
    }
    expect(res.report.stats).toMatchObject({ ik: 1, clippingAttachments: 1, morphedParts: 1, events: 2 });
    expect(res.report.stats.latticeBones).toBeGreaterThan(0);
  });

  it('writes bones, IK, events, clipping and parameter poses', () => {
    const names = (json.bones as Json[]).map((b) => b.name);
    expect(names[0]).toBe('rev2d-root');
    expect(names.slice(1, 6).sort()).toEqual(['arm', 'forearm', 'root', 'spine', 'target']);
    expect(names.filter((n) => n.startsWith('faceWarp-')).length).toBe(res.report.stats.latticeBones);
    const spine = (json.bones as Json[]).find((b) => b.name === 'spine')!;
    // Rev2D (x, y, rotation) = (0, -40, -90) -> Spine (0, 40, 90); color kept.
    expect(spine).toMatchObject({ parent: 'root', y: 40, rotation: 90, length: 40, color: 'ff8800ff' });
    expect(json.ik).toEqual([{ name: 'armIk', order: 0, bones: ['arm', 'forearm'], target: 'target', mix: 0, softness: expect.any(Number), bendPositive: true }]);
    expect(json.events).toEqual({ hit: {}, tick: {} });
    expect(json.animations.wave.events).toEqual([
      { time: 0.25, name: 'tick', float: 2.5 },
      { time: 0.5, name: 'hit', int: 3, string: 'x' },
    ]);
    const slots = (json.slots as Json[]).map((s) => s.name);
    expect(slots).not.toContain('hidden');
    const clip = (json.slots as Json[]).find((s) => s.name === 'face-clip')!;
    expect(slots.indexOf('face-clip')).toBe(slots.indexOf('eye') - 1);
    expect(json.skins[0].attachments['face-clip']['face-clip']).toMatchObject({ type: 'clipping', end: 'eye' });
    expect(clip.bone).toBe('spine');
    expect(Object.keys(json.animations)).toEqual(['wave', 'talk', 'paint', 'param/Bend/min', 'param/Bend/max', 'param/Mouth/min', 'param/Mouth/max']);
    expect(json.animations['param/Mouth/max'].attachments.default.mouth.mouth.deform).toHaveLength(1);
  });

  it('keeps step keys sharp and reorders slots with z', () => {
    const at = (t: number) => evalSpine(json, 'wave', t);
    const eyeAlpha = (t: number) => at(t).colors.get('eye')![3];
    // Rev2D holds a step key's value up to and including the next key's time; Spine follows 1 ms later.
    expect(eyeAlpha(0.39)).toBeCloseTo(1, 2);
    expect(eyeAlpha(0.4)).toBeCloseTo(1, 2);
    // Stepped keys, not a 1 ms ramp: no frame shows a half-faded eye (a sprite-swap cross-fade).
    expect(eyeAlpha(0.4005)).toBeCloseTo(1, 2);
    expect(eyeAlpha(0.4015)).toBeCloseTo(0.25, 2);
    expect(eyeAlpha(0.6005)).toBeCloseTo(1, 2);
    expect(json.animations.wave.slots.eye.rgba.filter((k: Json) => k.curve === 'stepped')).toHaveLength(2);
    expect(eyeAlpha(0.5)).toBeCloseTo(0.25, 2);
    expect(eyeAlpha(0.5985)).toBeCloseTo(0.25, 2);
    expect(eyeAlpha(0.6)).toBeCloseTo(1, 2);
    const order0 = at(0.2).order;
    const order1 = at(0.7).order;
    expect(order0.indexOf('strand')).toBeGreaterThan(order0.indexOf('sleeve'));
    expect(order1.indexOf('strand')).toBeLessThan(order1.indexOf('body'));
    // The body tint animates through the slot color.
    const c = at(0.5).colors.get('body')!;
    expect(c[0]).toBeCloseTo(1, 2);
    expect(c[1]).toBeCloseTo(0x80 / 255, 2);
  });

  it('bakes IK, skinning, warp lattice bones and morphs exactly at the sampled frames', () => {
    const exact = files(run({ tolerance: 0 })).json;
    const setup = rig.pose({ time: 0 });
    const sp0 = evalSpine(exact, null, 0);
    for (const anim of ['wave', 'talk']) {
      const a = model.animations.find((x) => x.id === anim)!;
      const times = frameTimes(a.duration, 30, a);
      const player = rig.player();
      for (const [f, t] of times.entries()) {
        const pose = player.update({ time: t, animations: [anim] });
        if (f % 5 !== 0) continue;
        const sp = evalSpine(exact, anim, t);
        for (const id of ['body', 'face', 'badge', 'sleeve']) {
          const m = matchVertices(setup.parts[id].fill!, toCanvas(sp0.vertices.get(id)!));
          expect(m.filter((i) => i < 0), `${id} setup`).toHaveLength(0);
          const v = toCanvas(sp.vertices.get(id)!);
          const fill = pose.parts[id].fill!;
          m.forEach((j, i) => expect(Math.hypot(v[2 * j] - fill[2 * i], v[2 * j + 1] - fill[2 * i + 1]), `${id} ${anim}@${t}`).toBeLessThan(0.02));
        }
      }
    }
  }, EXPORT_TIMEOUT);

  it('validates options', () => {
    expect(() => run({ animations: ['nope'] })).toThrow(/unknown animation "nope"/);
    expect(() => run({ fps: 0 })).toThrow(/fps/);
    expect(() => run({ tolerance: -1 })).toThrow(/tolerance/);
    expect(() => exportSpine(model, rig, {})).toThrow(/texture "checker"/);
    const sub = run({ animations: ['talk'], name: 'my probe', fps: 10 });
    expect(sub.files.map((f) => f.path)).toEqual(['my_probe.json', 'my_probe.atlas', 'my_probe.png']);
    const j = files(sub).json;
    expect(Object.keys(j.animations)).toEqual(['talk']);
    expect(j.skeleton.fps).toBe(10);
  });

  it('writes straight-alpha pages and the Spine 4.0 deform layout on request', () => {
    const straight = run({ premultipliedAlpha: false, spineVersion: '4.0.64', animations: ['wave'] });
    const { json: j, atlasText, pages } = files(straight);
    expect(parseAtlas(atlasText).pages[0].pma).toBe(false);
    expect(j.skeleton.spine).toBe('4.0.64');
    expect(j.animations.wave.deform).toBeDefined();
    expect(j.animations.wave.attachments).toBeUndefined();
    expect(straight.report.issues.map((i) => i.code)).toContain('spine-straight-alpha');
    // Straight pages keep full color on translucent texels; premultiplied ones scale it by alpha.
    const pma = decodePNG(files(run({ animations: ['wave'] })).pages[0].bytes!);
    const str = decodePNG(pages[0].bytes!);
    let checked = 0;
    for (let i = 0; i < str.data.length; i += 4) {
      const a = str.data[i + 3];
      if (a < 40 || a > 200) continue;
      expect(Math.abs(pma.data[i] - Math.round((str.data[i] * a) / 255))).toBeLessThanOrEqual(1);
      checked++;
    }
    expect(checked).toBeGreaterThan(10);
    expect(run({ spineVersion: '3.8.99', animations: [] }).report.issues.map((i) => i.code)).toContain('spine-export-version');
  }, EXPORT_TIMEOUT);
});
