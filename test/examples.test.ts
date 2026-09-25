/**
 * Example models (examples/<name>/<name>.r2d.json) are templates and reference material, so they must
 * stay valid, warning-free, renderable at every parameter extreme, physically stable and deterministic,
 * byte-identical to their generators, and exactly as documented in examples/README.md.
 * Per-example checks pin down the behaviour each example exists to demonstrate.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { formatModelJson } from '../src/core/format.js';
import { formatDiagnostics } from '../src/core/validate.js';
import { parseColor } from '../src/core/color.js';
import { resolveTarget } from '../src/core/address.js';
import { tryParsePath } from '../src/core/path.js';
import { valueToJSON } from '../src/core/values.js';
import type { ImageRGBA, Model, Pose } from '../src/core/types.js';
import { loadModelFile, loadModelObject, type LoadedModel } from '../src/node/load.js';
import { analyzeAnimation, inspectPose, parseSweep, renderFrame, sequenceTimes } from '../src/api/index.js';
import { EXAMPLES_DIR, listTemplates, loadTemplate, PACKAGE_ROOT } from '../src/api/templates.js';
import { decodePNG, diffImages, encodePNG } from '../src/render/index.js';
import { BUILDERS, TEXTURES } from '../scripts/examples/index.js';

const EXAMPLES = ['hana', 'minimal', 'robot-arm', 'slime', 'textured'];
/** Scale for bulk renders: enough pixels to see every part, cheap enough to render dozens of poses. */
const BULK_SCALE = 0.25;

const fileOf = (name: string) => path.join(EXAMPLES_DIR, name, `${name}.r2d.json`);

/** True when the package is a git work tree with git on PATH (not in an installed package). */
const inGitWorkTree = (() => {
  try {
    const out = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: PACKAGE_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.trim() === 'true';
  } catch {
    return false;
  }
})();

/** Same JSON value up to float noise (paths compare their numbers, colors/strings exactly). */
function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-3;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
  if (typeof a === 'string' && typeof b === 'string') {
    const pa = tryParsePath(a);
    const pb = tryParsePath(b);
    if (pa && pb && a !== b) return pa.template === pb.template && sameValue(pa.nums, pb.nums);
    return a === b;
  }
  return false;
}

/**
 * One predicate per row of the README feature matrix: true = ✓, a string = the literal cell text.
 * A new README row needs a predicate here, so the matrix can never claim what a model does not do.
 */
const FEATURES: Record<string, (m: Model) => boolean | string> = {
  'Parameters driving bindings': (m) => m.bindings.length > 0,
  'Warp keyforms (sparse or full point lists)': (m) => m.bindings.some((b) => b.target.startsWith('warp:')),
  'Nested warps (warp parented to a warp)': (m) => m.warps.some((w) => m.warps.some((p) => p.id === w.parent)),
  'Warp parented to a bone': (m) => m.warps.some((w) => m.bones.some((b) => b.id === w.parent)),
  '2D / 3D binding grids (2+ parameters)': (m) => m.bindings.some((b) => b.params.length >= 2),
  'Several bindings summed on one property': (m) => new Set(m.bindings.map((b) => b.target)).size < m.bindings.length,
  'Path morphs (`shape.d` keyforms)': (m) => m.bindings.some((b) => b.target.endsWith('.shape.d')),
  'Ellipse / polygon field bindings (`shape.ry`, `shape.points`)': (m) =>
    m.bindings.some((b) => {
      const hit = /^part:([^.]+)\.shape\./.exec(b.target);
      const type = hit && m.parts.find((p) => p.id === hit[1])?.shape.type;
      return type === 'ellipse' || type === 'polygon';
    }),
  'Opacity bindings': (m) => m.bindings.some((b) => b.target.endsWith('.opacity')),
  'Bone rotation / translation bindings': (m) => m.bindings.some((b) => /^bone:[^.]+\.(rotation|x|y)$/.test(b.target)),
  'Two-bone IK': (m) => m.ik.some((k) => k.bones.length === 2),
  'IK softness (`softness`)': (m) => m.ik.some((k) => k.softness > 0),
  'Skinning with auto weights (`skin`, `detail`)': (m) => m.parts.some((p) => p.skin?.weights === 'auto' && 'detail' in p.shape && p.shape.detail !== undefined),
  'Physics → parameters': (m) => m.physics.length > 0,
  'Masks (`mask`)': (m) => m.parts.some((p) => (p.mask?.length ?? 0) > 0),
  'Mask by texture alpha': (m) =>
    m.parts.some((p) => p.mask?.some((id) => {
      const s = m.parts.find((q) => q.id === id)?.shape;
      return s?.type === 'image' || (s?.type === 'mesh' && s.texture !== undefined);
    })),
  'Gradients (linear / radial)': (m) => m.parts.some((p) => typeof p.fill === 'object' && (p.fill.type === 'linear' || p.fill.type === 'radial')),
  Strokes: (m) => m.parts.some((p) => p.stroke !== undefined),
  'Stroke-only open paths (fill `transparent`)': (m) => m.parts.some((p) => p.fill === 'transparent' && p.stroke !== undefined),
  'Blend modes': (m) => [...new Set(m.parts.map((p) => p.blend).filter((b) => b !== 'normal'))].sort().map((b) => `\`${b}\``).join(' '),
  'Textures: `image` with `crop` + `cols`/`rows`': (m) => m.parts.some((p) => p.shape.type === 'image' && p.shape.crop !== undefined),
  'Textures: `mesh` with `uvs`': (m) => m.parts.some((p) => p.shape.type === 'mesh' && p.shape.uvs !== undefined),
  'Looping animations': (m) => m.animations.some((a) => a.loop),
  'One-shot animations (`loop: false`)': (m) => m.animations.some((a) => !a.loop),
  'One-shots that start and end at the defaults (layer with `once`)': (m) => m.animations.some((a) => !a.loop && startsAndEndsAtDefaults(m, a)),
  'Ease `smooth` (automatic tangents)': (m) => m.animations.some((a) => a.tracks.some((t) => t.keys.some((k) => k.ease === 'smooth'))),
  "Track `offset` (one track's keys replayed out of phase)": (m) => m.animations.some((a) => a.tracks.some((t) => t.offset !== 0)),
  'Animation events': (m) => m.animations.some((a) => (a.events?.length ?? 0) > 0),
};

/**
 * Every track of the animation targets a parameter and starts and ends at that parameter's default:
 * played as a `once` layer, it then hands the pose back without a jump at either end of its window.
 */
function startsAndEndsAtDefaults(m: Model, a: Model['animations'][number]): boolean {
  return a.tracks.every((t) => {
    const p = m.parameters.find((q) => `param:${q.id}` === t.target);
    return p !== undefined && t.keys[0].v === p.default && t.keys[t.keys.length - 1].v === p.default;
  });
}

/** The README feature matrix as {row label: {example: cell text}}. */
function readmeMatrix(readme: string): Record<string, Record<string, string>> {
  const lines = readme.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\|\s*Feature\s*\|/.test(l));
  if (start < 0) throw new Error('examples/README.md has no "| Feature | ..." table');
  const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const columns = cells(lines[start]).slice(1);
  const rows: Record<string, Record<string, string>> = {};
  for (let i = start + 2; i < lines.length && lines[i].startsWith('|'); i++) {
    const [label, ...values] = cells(lines[i]);
    rows[label] = Object.fromEntries(columns.map((c, k) => [c, values[k] ?? '']));
  }
  return rows;
}
const loaded = new Map<string, LoadedModel>();

beforeAll(async () => {
  for (const name of EXAMPLES) loaded.set(name, await loadModelFile(fileOf(name)));
});

function get(name: string): LoadedModel {
  const m = loaded.get(name);
  if (!m) throw new Error(`example "${name}" was not loaded`);
  return m;
}

/** Pixels whose color differs from the background by more than a small tolerance. */
function foregroundPixels(img: ImageRGBA, background: string): number {
  const bg = parseColor(background)!.map((v) => Math.round(v * 255));
  let n = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    if (Math.abs(img.data[i] - bg[0]) + Math.abs(img.data[i + 1] - bg[1]) + Math.abs(img.data[i + 2] - bg[2]) + Math.abs(img.data[i + 3] - bg[3]) > 12) n++;
  }
  return n;
}

function center(m: LoadedModel, part: string, params: Record<string, number>): [number, number] {
  const p = inspectPose(m, { params, physics: false }).parts.find((q) => q.id === part);
  if (!p?.center) throw new Error(`part "${part}" has no geometry`);
  return p.center;
}

function expectFinitePose(pose: Pose, where: string): void {
  for (const [id, v] of Object.entries(pose.params)) expect(Number.isFinite(v), `${where}: param ${id} = ${v}`).toBe(true);
  for (const [id, b] of Object.entries(pose.bones)) expect([b.x, b.y, b.rotation].every(Number.isFinite), `${where}: bone ${id}`).toBe(true);
  for (const [id, p] of Object.entries(pose.parts)) {
    if (p.bounds) expect(p.bounds.every(Number.isFinite), `${where}: part ${id} bounds ${p.bounds}`).toBe(true);
  }
}

describe('example catalog', () => {
  it('ships every example as a template with its textures', () => {
    expect(listTemplates()).toEqual(expect.arrayContaining(['blank', ...EXAMPLES]));
    for (const name of EXAMPLES) {
      const { doc, textureFiles } = loadTemplate(name, { name: `copy-of-${name}` });
      expect((doc.meta as { name: string }).name).toBe(`copy-of-${name}`);
      for (const f of textureFiles) expect(existsSync(f), `${name}: missing texture ${f}`).toBe(true);
    }
  });

  it('README documents every example', () => {
    const readme = readFileSync(path.join(EXAMPLES_DIR, 'README.md'), 'utf8');
    for (const name of EXAMPLES) expect(readme, `README misses ${name}`).toContain(`${name}/${name}.r2d.json`);
  });

  it('README feature matrix states exactly what each model contains', () => {
    const matrix = readmeMatrix(readFileSync(path.join(EXAMPLES_DIR, 'README.md'), 'utf8'));
    expect(Object.keys(matrix).sort(), 'README rows vs FEATURES predicates in this test').toEqual(Object.keys(FEATURES).sort());
    const wrong: string[] = [];
    for (const [feature, has] of Object.entries(FEATURES)) {
      for (const name of EXAMPLES) {
        const actual = has(get(name).model!);
        const expected = typeof actual === 'string' ? actual : actual ? '✓' : '';
        const cell = matrix[feature][name];
        if (cell !== expected) wrong.push(`${feature} / ${name}: README "${cell}", model "${expected}"`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it.skipIf(!inGitWorkTree)('checks example files out byte-exact on every OS (LF text, binary PNG)', () => {
    // With core.autocrlf=true (the Git for Windows default) text files are checked out with CRLF unless
    // an attribute pins LF; the models must stay byte-identical to formatModelJson output.
    const models = EXAMPLES.map((n) => `examples/${n}/${n}.r2d.json`);
    const textures = Object.entries(TEXTURES).flatMap(([n, files]) => Object.keys(files).map((f) => `examples/${n}/${f}`));
    const attrs = execFileSync('git', ['check-attr', 'eol', 'text', '--', ...models, ...textures], { cwd: PACKAGE_ROOT, encoding: 'utf8' });
    for (const f of models) expect(attrs, 'add "*.json text eol=lf" to examples/.gitattributes').toContain(`${f}: eol: lf`);
    for (const f of textures) expect(attrs, 'mark "*.png binary" in examples/.gitattributes').toContain(`${f}: text: unset`);
  });

  it('textures are exactly what scripts/gen-textures.ts paints (regenerate: npx tsx scripts/gen-textures.ts)', () => {
    for (const [name, files] of Object.entries(TEXTURES)) {
      for (const [file, paint] of Object.entries(files)) {
        const shipped = decodePNG(readFileSync(path.join(EXAMPLES_DIR, name, file)));
        const painted = paint();
        expect([shipped.width, shipped.height], `${name}/${file}`).toEqual([painted.width, painted.height]);
        expect(Buffer.from(shipped.data).equals(Buffer.from(painted.data)), `${name}/${file} pixels differ from its painter`).toBe(true);
      }
    }
  });
});

describe.each(EXAMPLES)('example "%s"', (name) => {
  it('validates with no errors or warnings and compiles a rig', () => {
    const m = get(name);
    expect(m.diagnostics, formatDiagnostics(m.diagnostics)).toEqual([]);
    expect(m.rig).not.toBeNull();
  });

  it('is stored in canonical formatModelJson form', () => {
    const text = readFileSync(fileOf(name), 'utf8');
    expect(text.includes('\r'), `${name}: CRLF line endings (see examples/.gitattributes)`).toBe(false);
    expect(formatModelJson(JSON.parse(text))).toBe(text);
  });

  it('is exactly the output of its builder in scripts/examples (regenerate: npx tsx scripts/build-examples.ts)', () => {
    expect(formatModelJson(BUILDERS[name]()) === readFileSync(fileOf(name), 'utf8'), `${name} drifted from scripts/examples`).toBe(true);
  });

  it('rests every bound property at its setup value when all parameters are at their defaults', () => {
    // Bindings add (value - setup) deltas, so a binding off its setup value at the default pose makes the
    // file lie about the default look and doubles up with other bindings on the same property.
    const m = get(name);
    const model = m.model!;
    const pose = m.rig!.pose({ physics: false });
    const off: string[] = [];
    for (const key of new Set(model.bindings.map((b) => resolveTarget(model, b.target).key))) {
      const t = resolveTarget(model, key);
      const setup = valueToJSON(t.setup, t.valueType);
      if (!sameValue(setup, pose.properties[key])) off.push(`${key}: setup ${JSON.stringify(setup)}, at defaults ${JSON.stringify(pose.properties[key])}`);
    }
    expect(off).toEqual([]);
  });

  it('loops seamlessly: every looping animation looks the same just before it wraps as at t=0', () => {
    const m = get(name);
    for (const a of m.model!.animations.filter((x) => x.loop)) {
      const at = (time: number) => renderFrame(m, { animations: [a.id], time, physics: false, scale: BULK_SCALE }).image;
      const seam = diffImages(at(0), at(a.duration - 1e-3), { threshold: 16 });
      // Loops that keep moving through the seam (ease "smooth") move a hair in that last millisecond,
      // which can flip a few antialiasing samples on thin lines; a real jump changes far more pixels.
      // The exact check (parameters and bones extrapolated to the seam) is the analysis test below.
      expect(seam.differentPixels / (seam.width * seam.height), `${a.id}: jump at the loop point (${seam.differentPixels} px, max delta ${seam.maxDelta})`).toBeLessThan(0.001);
    }
  });

  it('renders a non-empty frame at the default pose, at every parameter extreme and along every animation', () => {
    const m = get(name);
    const model = m.model!;
    const minForeground = model.meta.width * model.meta.height * BULK_SCALE * BULK_SCALE * 0.02;
    const check = (label: string, input: Parameters<typeof renderFrame>[1]) => {
      const { image } = renderFrame(m, { scale: BULK_SCALE, ...input });
      expect(foregroundPixels(image, model.meta.background), `${name} ${label}`).toBeGreaterThan(minForeground);
    };
    check('default pose', {});
    for (const p of model.parameters) {
      check(`${p.id}=${p.min}`, { params: { [p.id]: p.min }, physics: false });
      check(`${p.id}=${p.max}`, { params: { [p.id]: p.max }, physics: false });
    }
    for (const a of model.animations) {
      for (const t of sequenceTimes(model, { animation: a.id, frames: 3 })) check(`${a.id}@${t}`, { animations: [a.id], time: t });
    }
  });

  it('keeps every part finite and near the canvas across parameter sweeps and animations', () => {
    const m = get(name);
    const model = m.model!;
    const { width: W, height: H } = model.meta;
    // Parts may overdraw the edges (hems, floors) but never run away: a broken keyform or an
    // extrapolating warp shows up as a part far outside the canvas.
    const check = (label: string, pose: ReturnType<typeof inspectPose>) => {
      for (const part of pose.parts) {
        if (!part.bounds) continue;
        const [x, y, w, h] = part.bounds;
        expect(part.bounds.every(Number.isFinite), `${label}: ${part.id} bounds ${part.bounds}`).toBe(true);
        const overflow = Math.max(-x / W, -y / H, (x + w - W) / W, (y + h - H) / H);
        expect(overflow, `${label}: ${part.id} bounds ${part.bounds} leave the canvas`).toBeLessThan(0.25);
      }
    };
    for (const p of model.parameters) {
      for (const v of parseSweep(model, p.id).values) check(`${p.id}=${v}`, inspectPose(m, { params: { [p.id]: v }, physics: false }));
    }
    for (const a of model.animations) {
      for (const t of sequenceTimes(model, { animation: a.id, frames: 12 })) check(`${a.id}@${t}`, inspectPose(m, { animations: [a.id], time: t }));
    }
  });

  it('stays bounded while each animation plays for 10 s at 60 fps, physics never pinned at a limit', () => {
    const m = get(name);
    const model = m.model!;
    // Physics outputs are clamped to their parameter range; sitting on a limit means the tuning is off
    // (the motion flattens), so a well-tuned example never reaches one.
    const outputs = new Set(model.physics.flatMap((g) => g.outputs.map((o) => o.param)));
    for (const a of model.animations) {
      const player = m.rig!.player();
      for (let i = 0; i <= 600; i++) {
        const pose = player.update({ time: i / 60, animations: [a.id] });
        if (i % 30 === 0) expectFinitePose(pose, `${a.id} t=${(i / 60).toFixed(2)}`);
        for (const p of model.parameters) {
          const v = pose.params[p.id];
          expect(v >= p.min && v <= p.max, `${a.id}: ${p.id}=${v}`).toBe(true);
          if (outputs.has(p.id)) expect(v > p.min && v < p.max, `${a.id} t=${(i / 60).toFixed(2)}: physics output ${p.id} pinned at ${v}`).toBe(true);
        }
      }
    }
  });

  it('renders deterministically (identical PNG bytes twice)', () => {
    const m = get(name);
    const anim = m.model!.animations[0]?.id;
    const input = { time: 0.5, animations: anim ? [anim] : [], scale: 0.5 };
    const a = encodePNG(renderFrame(m, input).image);
    const b = encodePNG(renderFrame(m, input).image);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});

describe('example behaviour', () => {
  it('minimal: Lean bends the top of the body but keeps the base planted', () => {
    const m = get('minimal');
    const left = inspectPose(m, { params: { Lean: -1 } }).warps[0].points;
    const right = inspectPose(m, { params: { Lean: 1 } }).warps[0].points;
    expect(right[0][0] - left[0][0]).toBeCloseTo(56, 5);
    expect(right[8][0] - left[8][0]).toBeCloseTo(0, 5);
  });

  it('hana: closing an eye hides its iris (the eye white masks it) and the lash line remains', () => {
    const m = get('hana');
    // Screen-right eye (character's left); count bluish iris pixels inside the eye box.
    const viewBox: [number, number, number, number] = [270, 228, 70, 66];
    const irisPixels = (open: number) => {
      const { image } = renderFrame(m, { params: { EyeLOpen: open }, viewBox, physics: false });
      let n = 0;
      for (let i = 0; i < image.data.length; i += 4) {
        const [r, g, b] = [image.data[i], image.data[i + 1], image.data[i + 2]];
        if (b > r + 30 && b > g + 30) n++;
      }
      return n;
    };
    expect(irisPixels(1)).toBeGreaterThan(600);
    expect(irisPixels(0)).toBe(0);
    const lash = inspectPose(m, { params: { EyeLOpen: 0 }, physics: false }).parts.find((p) => p.id === 'lashL')!;
    expect(lash.visible).toBe(true);
  });

  it('hana: head turn moves the nose further than the face outline (pseudo-3D parallax)', () => {
    const m = get('hana');
    const nose = center(m, 'nose', { AngleX: 30 })[0] - center(m, 'nose', {})[0];
    const face = center(m, 'face', { AngleX: 30 })[0] - center(m, 'face', {})[0];
    const back = center(m, 'hairBack', { AngleX: 30 })[0] - center(m, 'hairBack', {})[0];
    expect(nose).toBeGreaterThan(25);
    expect(face).toBeLessThan(nose * 0.75);
    expect(back).toBeLessThan(0);
  });

  it('hana: AngleZ tilts the head bone and physics lets the hair swing, then settle', () => {
    const m = get('hana');
    expect(inspectPose(m, { params: { AngleZ: 30 } }).bones.find((b) => b.id === 'head')!.local.rotation).toBeCloseTo(10, 5);
    const player = m.rig!.player();
    let peak = 0;
    let last = 0;
    for (let i = 0; i <= 360; i++) {
      const pose = player.update({ time: i / 60, params: { AngleX: i < 30 ? 0 : 30 } });
      peak = Math.max(peak, Math.abs(pose.params.HairSide));
      last = pose.params.HairSide;
    }
    expect(peak).toBeGreaterThan(0.3);
    expect(Math.abs(last)).toBeLessThan(0.05);
  });

  it('robot-arm: two-bone IK puts the wrist on the target inside the reach', () => {
    const m = get('robot-arm');
    // Closer than reach - softness (285 - 30 px): the soft curve does not touch these targets.
    const targets: Array<Record<string, number>> = [{}, { ReachX: 0.3, ReachY: 0.3 }, { ReachX: -0.8, ReachY: -0.3 }, { ReachX: 0.3, ReachY: -0.97 }];
    for (const params of targets) {
      const pose = inspectPose(m, { params, physics: false });
      const tip = pose.bones.find((b) => b.id === 'foreArm')!.tip;
      const target = pose.bones.find((b) => b.id === 'ikTarget')!;
      expect(pose.ik.find((k) => k.id === 'armIk')!.distance, JSON.stringify(params)).toBeLessThan(255);
      expect(Math.hypot(tip[0] - target.x, tip[1] - target.y), JSON.stringify(params)).toBeLessThan(0.05);
    }
  });

  it('robot-arm: softness bends the arm smoothly near full reach instead of snapping it straight', () => {
    const m = get('robot-arm');
    expect(m.model!.ik.find((k) => k.id === 'armIk')!.softness).toBe(30);
    // Walk the target outward along ReachX (ReachY -0.9, as at the grab): the elbow angle opens
    // steadily, reaching 180 only past reach + softness; the tip trails by s/4 = 7.5 px at full reach.
    const samples: Array<ReturnType<typeof inspectPose>['ik'][number]> = [];
    for (let x = 0.5; x <= 1.0001; x += 0.02) samples.push(inspectPose(m, { params: { ReachX: x, ReachY: -0.9 }, physics: false }).ik.find((k) => k.id === 'armIk')!);
    const steps = samples.slice(1).map((k, i) => k.bend! - samples[i].bend!);
    // Without softness one 2.4 px step just before full reach opens the elbow by 10 degrees (the snap).
    expect(Math.max(...steps)).toBeLessThan(3);
    expect(steps.every((s) => s > 0)).toBe(true);
    expect(samples[samples.length - 1].bend).toBeLessThan(180);
    const full = samples.reduce((a, b) => (Math.abs(b.extension - 1) < Math.abs(a.extension - 1) ? b : a));
    expect(full.error).toBeGreaterThan(6);
    expect(full.error).toBeLessThan(9);
  });

  it('robot-arm: reach gets to 99% of the reach and softness is what keeps analyze from warning about a snap', async () => {
    const m = get('robot-arm');
    const ik = analyzeAnimation(m, { animation: 'reach', warmup: 8, pixels: false }).ik[0];
    expect(ik).toMatchObject({ id: 'armIk', outOfReachFrames: 0 });
    expect(ik.maxExtension).toBeGreaterThan(0.98);
    expect(ik.maxExtension).toBeLessThan(1);
    expect(ik.nearStraightFrames).toBeGreaterThan(0);
    expect(ik.maxError).toBeLessThan(7.5); // the soft chain trails the target by less than s/4
    // The same rig without softness: the chain would snap straight near the grab, and analyze says so.
    const doc = BUILDERS['robot-arm']() as { ik: Array<{ softness?: number }> };
    doc.ik[0].softness = 0;
    const hard = await loadModelObject(doc, path.join(EXAMPLES_DIR, 'robot-arm'));
    const notes = analyzeAnimation(hard, { animation: 'reach', warmup: 8, pixels: false }).notes;
    expect(notes).toEqual([expect.stringMatching(/^IK "armIk": chain nearly straight in .*Set "softness"/)]);
  });

  it('robot-arm: drum replays the TapTop keys on the other claws with offset 1/3 and 2/3 of the cycle', () => {
    const m = get('robot-arm');
    const drum = m.model!.animations.find((a) => a.id === 'drum')!;
    expect(drum.loop).toBe(true);
    const track = (id: string) => drum.tracks.find((t) => t.target === `param:${id}`)!;
    expect(track('TapMid').keys).toEqual(track('TapTop').keys);
    expect(track('TapBot').keys).toEqual(track('TapTop').keys);
    const third = drum.duration / 3;
    expect([track('TapTop').offset, track('TapMid').offset, track('TapBot').offset]).toEqual([0, third, 2 * third].map((v) => Math.round(v * 1000) / 1000));
    expect(track('TapTop').keys[0].ease).toBe('smooth');
    expect(track('ReachY').keys.slice(0, -1).every((k) => k.ease === 'smooth')).toBe(true);
    const at = (t: number) => inspectPose(m, { animations: ['drum'], time: t, physics: false }).params;
    const wrap = (t: number) => ((t % drum.duration) + drum.duration) % drum.duration;
    for (const t of [0.05, 0.15, 0.4, 0.62, 0.85]) {
      expect(at(t).TapMid, `t=${t}`).toBeCloseTo(at(wrap(t - third)).TapTop, 6);
      expect(at(t).TapBot, `t=${t}`).toBeCloseTo(at(wrap(t - 2 * third)).TapTop, 6);
      // One claw lifts at a time: the gait.
      const up = ['TapTop', 'TapMid', 'TapBot'].filter((id) => at(t)[id] > 0.05);
      expect(up.length, `t=${t}: ${up}`).toBeLessThanOrEqual(1);
    }
    expect(at(drum.duration / 6).TapTop).toBeCloseTo(1, 6);
  });

  it('hana: wink and blink are once-layers that hand the face back at both ends of their window', () => {
    const m = get('hana');
    const params = (animations: string[], time: number) => inspectPose(m, { animations, time, physics: false }).params;
    for (const [layer, start, duration] of [['wink', 1, 1], ['blink', 1.5, 0.5]] as const) {
      expect(m.model!.animations.find((a) => a.id === layer)!.duration).toBe(duration);
      for (const t of [start - 0.01, start, start + duration, start + duration + 0.01]) {
        const layered = params(['idle', `${layer},once,start=${start}`], t);
        const idle = params(['idle'], t);
        for (const id of Object.keys(idle)) expect(layered[id], `${layer} at t=${t}: ${id}`).toBeCloseTo(idle[id], 6);
      }
    }
    const wink = params(['idle', 'wink,once,start=1'], 1.3);
    expect(wink.EyeLOpen).toBe(0);
    expect(wink.EyeROpen).toBeLessThan(0.8);
    expect(wink.MouthForm).toBeGreaterThan(0.9);
  });

  it('hana: talk is built for add: head tracks swing around the defaults and its cycle divides idle and look_around', () => {
    const model = get('hana').model!;
    const dur = (id: string) => model.animations.find((a) => a.id === id)!.duration;
    for (const id of ['idle', 'look_around']) expect(Number.isInteger(dur(id) / dur('talk')), id).toBe(true);
    const talk = model.animations.find((a) => a.id === 'talk')!;
    for (const p of ['AngleX', 'AngleY', 'AngleZ']) {
      const values = talk.tracks.find((t) => t.target === `param:${p}`)!.keys.map((k) => k.v as number);
      expect(values[0], p).toBe(0);
      expect(Math.min(...values), p).toBeLessThan(0);
      expect(Math.max(...values), p).toBeGreaterThan(0);
      expect(Math.max(...values.map(Math.abs)), p).toBeLessThanOrEqual(5);
    }
  });

  it('slime: blink is a once-layer over idle', () => {
    const m = get('slime');
    const eye = (animations: string[], time: number) => inspectPose(m, { animations, time, physics: false }).params.EyeOpen;
    expect(eye(['idle', 'blink,once,start=0.5'], 0.56)).toBeLessThan(0.1);
    for (const t of [0.45, 0.5, 0.8, 0.85]) expect(eye(['idle', 'blink,once,start=0.5'], t), `t=${t}`).toBeCloseTo(eye(['idle'], t), 6);
  });

  it('textured: the calm streamers and the drifting clouds stay on the canvas', () => {
    const m = get('textured');
    const { width: W, height: H } = m.model!.meta;
    const poses: Array<Record<string, number>> = [{ Wind: 0 }, { Wind: 0, CloudDrift: -1 }, { Wind: 0, CloudDrift: 1 }, { Wind: 0.5 }];
    for (const params of poses) {
      for (const id of ['koiRed', 'koiBlue', 'cloudShapes']) {
        const [x, y, w, h] = inspectPose(m, { params, physics: false }).parts.find((p) => p.id === id)!.bounds!;
        expect([x, y].every((v) => v >= 0) && x + w <= W && y + h <= H, `${JSON.stringify(params)}: ${id} [${x}, ${y}, ${w}, ${h}]`).toBe(true);
      }
    }
  });

  it('robot-arm: reaching swings the physics cable', () => {
    const m = get('robot-arm');
    const player = m.rig!.player();
    let peak = 0;
    for (let i = 0; i <= 240; i++) peak = Math.max(peak, Math.abs(player.update({ time: i / 60, animations: ['reach'] }).params.Cable3));
    expect(peak).toBeGreaterThan(5);
    expect(peak).toBeLessThan(60);
  });

  it('slime: the jump lifts the body, shrinks the shadow and fires takeoff/land events once', () => {
    const m = get('slime');
    const apex = inspectPose(m, { animations: ['jump'], time: 0.72 });
    const rest = inspectPose(m, { animations: ['jump'], time: 0 });
    const top = (p: typeof apex) => p.parts.find((q) => q.id === 'body')!.bounds![1];
    const shadow = (p: typeof apex) => p.parts.find((q) => q.id === 'shadow')!.bounds![2];
    expect(top(rest) - top(apex)).toBeGreaterThan(120);
    expect(shadow(apex)).toBeLessThan(shadow(rest) * 0.7);
    const player = m.rig!.player();
    const names: string[] = [];
    for (let i = 0; i <= 45; i++) names.push(...player.update({ time: i / 30, animations: ['jump'] }).events.map((e) => e.name));
    expect(names).toEqual(['takeoff', 'land']);
  });

  it('textured: the sheen is clipped by the carp texture alpha', () => {
    const m = get('textured');
    // A point inside the sheen band (Sheen = 0.5) but above the carp's silhouette.
    const viewBox: [number, number, number, number] = [212, 95, 4, 4];
    const withSheen = renderFrame(m, { params: { Sheen: 0.5 }, viewBox }).image.data;
    const without = renderFrame(m, { params: { Sheen: 0 }, viewBox }).image.data;
    expect(Buffer.from(withSheen).equals(Buffer.from(without))).toBe(true);
    // Inside the carp the sheen brightens the texture.
    const inside: [number, number, number, number] = [206, 146, 4, 4];
    const lit = renderFrame(m, { params: { Sheen: 0.5 }, viewBox: inside }).image.data;
    const dark = renderFrame(m, { params: { Sheen: 0 }, viewBox: inside }).image.data;
    expect(lit[0] + lit[1] + lit[2]).toBeGreaterThan(dark[0] + dark[1] + dark[2] + 30);
  });
});

/** Looping animations of models with physics are analyzed after warm-up, so the steady state counts. */
function warmupFor(model: Model, animation: string): number | undefined {
  return model.physics.length && model.animations.find((a) => a.id === animation)!.loop ? 10 : undefined;
}

/**
 * Analyze notes an example animation is meant to produce; any other note is a regression. textured
 * flutter wraps Spin (a full turn) and Sheen (the band off the carp at 0 and 1): the parameters jump
 * at the seam, the pixels do not (examples/README.md, Analysis).
 */
const EXPECTED_NOTES: Record<string, RegExp[]> = {
  'textured/flutter': [/^the loop does not close: at t=1\.6 -> 0 Spin 1 -> 0, Sheen 1 -> 0; .*the rendered frames match/],
};

describe.each(EXAMPLES)('example "%s" analysis', (name) => {
  it('analyzes every animation clean: no clamped physics, no IK out of reach or snapping, no part leaving the canvas', () => {
    const m = get(name);
    const model = m.model!;
    for (const a of model.animations) {
      const where = `${name}/${a.id}`;
      const r = analyzeAnimation(m, { animation: a.id, warmup: warmupFor(model, a.id) });
      for (const p of r.physics) expect(p.clampedFrames, `${where}: ${p.param} clamped`).toBe(0);
      for (const k of r.ik) {
        expect(k.outOfReachFrames, `${where}: IK ${k.id} out of reach`).toBe(0);
        if (!(model.ik.find((c) => c.id === k.id)!.softness > 0)) expect(k.nearStraightFrames, `${where}: IK ${k.id} nearly straight without softness`).toBe(0);
      }
      for (const o of r.outsideCanvas) expect(o.always, `${where}: ${o.part} leaves the canvas during the animation`).toBe(true);
      const expected = EXPECTED_NOTES[where] ?? [];
      expect(r.notes.length, `${where} notes:\n${r.notes.join('\n')}`).toBe(expected.length);
      expected.forEach((re, i) => expect(r.notes[i], where).toMatch(re));
      if (!r.seam) continue;
      if (expected.length) {
        expect(r.seam.params.map((p) => p.id).sort(), where).toEqual(['Sheen', 'Spin']);
        expect(r.seam.pixels!.ratio, where).toBeLessThan(0.001);
      } else {
        expect(r.seam.ok, `${where}: seam ${JSON.stringify(r.seam)}`).toBe(true);
      }
    }
  });
});

describe('example layer stacks (examples/README.md)', () => {
  it.each([
    ['hana', 'look_around', ['talk,add']],
    ['hana', 'idle', ['talk,add']],
    ['hana', 'idle', ['wink,once,start=1']],
    ['hana', 'idle', ['blink,once,start=1.5']],
    ['hana', 'look_around', ['talk,add', 'wink,add,once,start=1.5']],
    ['slime', 'idle', ['blink,once,start=0.5']],
  ])('%s: %s + %j analyzes clean and closes its loop', (name, animation, layers) => {
    const m = get(name);
    const r = analyzeAnimation(m, { animation, animations: layers, warmup: warmupFor(m.model!, animation) });
    expect(r.notes).toEqual([]);
    expect(r.seam?.ok, JSON.stringify(r.seam)).toBe(true);
  });
});
