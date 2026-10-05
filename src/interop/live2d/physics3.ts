/**
 * physics3.json <-> Rev2D physics groups. This is a documented APPROXIMATION: both systems swing
 * pendulum chains from a pivot driven by parameters, but the integrators differ in detail.
 *
 * Mapping (Cubism -> Rev2D; export is the inverse):
 * - Units: 1 Cubism physics unit = 1 px. Cubism's physics x axis points to the screen's LEFT (its
 *   inputs are negated: +ParamAngleX moves the pivot to physics -x), so Rev2D x = -(physics x);
 *   y points down (along gravity) in both.
 * - Inputs: Cubism normalizes a parameter from the middle of its range onto the setting's
 *   Normalization range (Position for X / Y, Angle in degrees for Angle), negates it unless Reflect,
 *   and scales it by Weight / 100. Rev2D weight = slope × Weight / 100, slope = normalization half
 *   range / parameter half range (sign: + for X and Angle, - for Y; Reflect flips it). The parameter
 *   range comes from the target Rev2D model (else the Live2D standard range).
 * - Vertices: vertex 0 is the pivot; vertex k (k >= 1) ends Rev2D segment k-1 with length = Radius.
 *   Gravity = 900 × Acceleration × Delay² px/s² (Cubism integrates in 1/30 s units scaled by Delay),
 *   damping per 60 Hz step = 1 - Mobility^(Fps / 60) (Mobility is the velocity kept per Cubism step;
 *   Meta.Fps, else 60 assumed). Per-vertex values are averaged per group (reported when they differ).
 * - Outputs: VertexIndex k -> segment k-1. Angle outputs are radians × Scale in Cubism and degrees ×
 *   scale in Rev2D: scale = -Scale × π / 180 (Reflect flips); X outputs: scale = -Scale; Y: +Scale.
 *   The X output of vertex k >= 2 is the x extent of segment k-1 (its own direction), so it becomes
 *   that segment's angle: scale = Scale × Radius × π / 180. Weight < 100 % is folded into the scale.
 * - Angle inputs: Cubism turns the gravity (the chain swings over), Rev2D turns the rest direction the
 *   outputs are measured from (without stiffness the outputs follow at once). Both rest at the same
 *   value; the swing on the way is not reproduced (reported).
 * Checked against the Cubism SDK (CubismPhysics): for one-segment chains with X inputs the Rev2D group
 * swings exactly like the SDK at 60 fps. The SDKs never read the Scale of X / Y outputs (their
 * translation scale stays 0): such outputs are imported as described but reported, and the export
 * writes only Angle outputs of vertex 1 for angle / x outputs.
 * Not reproduced (reported): Cubism measures the angle of vertex k >= 2 relative to the previous
 * segment (Rev2D: from the rest direction; exported as the angle of vertex 1), the Y output's constant
 * radius offset, the swing after an Angle input change (and its partial pre-rotation, air resistance),
 * Rev2D stiffness (exported as extra per-vertex acceleration, Angle input weights scaled so the tilt at
 * rest matches, see restTilt), wind and custom gravity (ignored by the Cubism SDK too).
 */
import type { Model } from '../../core/types.js';
import type { InteropReport, Live2dExportOptions, Live2dImportOptions } from '../types.js';
import { compactLocations, LegacyIds, LIVE2D_STANDARD_PARAMS, modernLive2dId, resolveLive2dParam, STANDARD_PARAM_MAP, toLive2dId, UnknownParams } from './params.js';
import { arrayOf, finite, fmt, isObject, type Json, modelInfo, parseJsonInput, q, Reporter, round, sanitizeId, uniqueId } from './util.js';

/** Cubism scales a step's force by (Delay × dt × 30)²: acceleration 1 with Delay 1 is 900 units/s². */
const GRAVITY_UNIT = 900;
const REV2D_HZ = 60;
const DEG_PER_RAD = 180 / Math.PI;

interface Norm {
  min: number;
  def: number;
  max: number;
}

function readNorm(v: unknown, what: string, where: string, r: Reporter): Norm {
  if (isObject(v)) {
    const min = finite(v.Minimum);
    const def = finite(v.Default);
    const max = finite(v.Maximum);
    if (min !== undefined && def !== undefined && max !== undefined) return { min: Math.min(min, max), def, max: Math.max(min, max) };
  }
  r.warn('live2d-physics-invalid', `Normalization.${what} is missing or incomplete: -10..10 (default 0) assumed`, `${where}.Normalization.${what}`);
  return { min: -10, def: 0, max: 10 };
}

export function importPhysics3(json: string | Json, opts: Live2dImportOptions = {}): { physics: Json[]; report: InteropReport } {
  const r = new Reporter();
  const doc = parseJsonInput(json, 'physics3.json');
  const map = opts.paramMap ?? STANDARD_PARAM_MAP;
  const model = modelInfo(opts.model);
  if (doc.Version !== 3) r.warn('live2d-version', `Version is ${JSON.stringify(doc.Version)}, expected 3`, 'Version');
  if (!Array.isArray(doc.PhysicsSettings)) throw new Error('physics3.json: "PhysicsSettings" must be an array');
  const meta: Json = isObject(doc.Meta) ? doc.Meta : {};
  let fps = finite(meta.Fps) ?? 0;
  if (!(fps > 0)) {
    r.info('live2d-physics-fps-assumed', 'Meta.Fps is not set: the Cubism SDK then steps physics once per rendered frame; 60 fps assumed', 'Meta.Fps');
    fps = 60;
  }
  const names = new Map<string, string>();
  for (const d of arrayOf(meta.PhysicsDictionary)) if (isObject(d) && typeof d.Id === 'string' && typeof d.Name === 'string') names.set(d.Id, d.Name);
  const forces = isObject(meta.EffectiveForces) ? meta.EffectiveForces : {};
  const gx = isObject(forces.Gravity) ? (finite(forces.Gravity.X) ?? 0) : 0;
  const gy = isObject(forces.Gravity) ? (finite(forces.Gravity.Y) ?? -1) : -1;
  const wx = isObject(forces.Wind) ? (finite(forces.Wind.X) ?? 0) : 0;
  const wy = isObject(forces.Wind) ? (finite(forces.Wind.Y) ?? 0) : 0;
  if (gx !== 0 || gy !== -1 || wx !== 0 || wy !== 0) {
    r.info(
      'live2d-physics-forces-ignored',
      `EffectiveForces (gravity ${fmt(gx)}, ${fmt(gy)}; wind ${fmt(wx)}, ${fmt(wy)}) are not the defaults; the Cubism SDK ignores them too (it uses gravity 0, -1 and no wind unless the app sets options)`,
      'Meta.EffectiveForces',
    );
  }

  const physics: Json[] = [];
  const ids = new Set<string>();
  const unknown = new UnknownParams();
  const legacy = new LegacyIds();
  /** Imported settings with Angle inputs (their outputs follow the angle at once in Rev2D). */
  const angleInputs: string[] = [];
  let inputs = 0;
  let outputs = 0;
  let vertices = 0;
  doc.PhysicsSettings.forEach((s, i) => {
    const sid = isObject(s) && typeof s.Id === 'string' ? s.Id : `PhysicsSetting${i + 1}`;
    const where = `PhysicsSettings[${i}] (${sid}${names.has(sid) ? ` ${names.get(sid)}` : ''})`;
    if (!isObject(s)) {
      r.warn('live2d-physics-invalid', 'physics setting is not an object: skipped', where);
      return;
    }
    const norm = isObject(s.Normalization) ? s.Normalization : {};
    const posNorm = readNorm(norm.Position, 'Position', where, r);
    const angNorm = readNorm(norm.Angle, 'Angle', where, r);
    const verts = arrayOf(s.Vertices);
    vertices += verts.length;
    inputs += arrayOf(s.Input).length;
    outputs += arrayOf(s.Output).length;

    // ---- inputs
    const groupInputs: Json[] = [];
    arrayOf(s.Input).forEach((inp, j) => {
      const at = `${where}.Input[${j}]`;
      const src = isObject(inp) && isObject(inp.Source) && typeof inp.Source.Id === 'string' ? inp.Source.Id : undefined;
      const type = isObject(inp) ? inp.Type : undefined;
      const weight = isObject(inp) ? finite(inp.Weight) : undefined;
      if (!src || (type !== 'X' && type !== 'Y' && type !== 'Angle') || weight === undefined) {
        r.warn('live2d-physics-invalid', 'input needs Source.Id, Type X | Y | Angle and a numeric Weight: skipped', at);
        return;
      }
      const res = resolveLive2dParam(src, map, model);
      legacy.add(res, src);
      if (!res.ok) {
        unknown.add(src, res.id, `PhysicsSettings[${i}].Input[${j}]`, res.hint);
        return;
      }
      const range = res.param ?? LIVE2D_STANDARD_PARAMS[src] ?? LIVE2D_STANDARD_PARAMS[modernLive2dId(src) ?? ''];
      const n = type === 'Angle' ? angNorm : posNorm;
      let slope: number;
      let mid = 0;
      if (!range) {
        r.warn('live2d-physics-param-range-unknown', `range of ${q(src)} unknown (no target model, not a standard parameter): assumed to equal the normalization range`, at);
        slope = 1;
      } else {
        mid = (range.min + range.max) / 2;
        const hp = range.max - mid;
        const hn = mid - range.min;
        const sp = hp > 0 ? (n.max - n.def) / hp : 0;
        const sn = hn > 0 ? (n.def - n.min) / hn : 0;
        slope = (sp + sn) / 2;
        if (Math.abs(sp - sn) > 1e-6 * Math.max(Math.abs(sp), Math.abs(sn))) {
          r.warn('live2d-physics-normalization-asymmetric', `the normalization maps the two halves of ${q(src)} with different slopes (${fmt(sp)} vs ${fmt(sn)}); their mean is used`, at);
        }
      }
      const offset = n.def - slope * mid;
      if (type === 'Angle' && Math.abs(offset) > 1e-9) {
        r.warn(
          'live2d-physics-angle-offset',
          `${q(src)} at 0 tilts the Cubism pendulum by ${fmt(offset * weight / 100)}° (normalization centred on the middle of the range); Rev2D angle inputs are proportional to the value`,
          at,
        );
      }
      const sign = (type === 'Y' ? -1 : 1) * (inp && (inp as Json).Reflect === true ? -1 : 1);
      groupInputs.push({ param: res.id, type: type === 'Angle' ? 'angle' : type === 'X' ? 'x' : 'y', weight: round((sign * slope * weight) / 100) });
    });

    // ---- vertices
    if (verts.length < 2) {
      r.warn('live2d-physics-invalid', `a pendulum needs at least 2 vertices, got ${verts.length}: setting skipped`, `${where}.Vertices`);
      return;
    }
    const segs: Json[] = [];
    const gravities: number[] = [];
    const dampings: number[] = [];
    let zeroDelay = false;
    for (let k = 1; k < verts.length; k++) {
      const v = isObject(verts[k]) ? (verts[k] as Json) : {};
      let radius = finite(v.Radius) ?? 0;
      if (!(radius > 0)) {
        r.warn('live2d-physics-invalid', `vertex ${k} has Radius ${fmt(radius)}: a length of 0.001 px is used`, `${where}.Vertices[${k}]`);
        radius = 0.001;
      }
      const acc = finite(v.Acceleration) ?? 1;
      const delay = finite(v.Delay) ?? 1;
      const mobility = Math.min(1, Math.max(0, finite(v.Mobility) ?? 1));
      if (delay === 0) zeroDelay = true;
      gravities.push(GRAVITY_UNIT * acc * delay * delay);
      dampings.push(1 - Math.pow(mobility, fps / REV2D_HZ));
      segs.push({ length: round(radius), mass: 1 });
    }
    if (zeroDelay) r.warn('live2d-physics-invalid', 'a vertex has Delay 0 (it never moves in Cubism): approximated with the averaged gravity', `${where}.Vertices`);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const gravity = mean(gravities);
    const damping = Math.min(1, Math.max(0, mean(dampings)));
    const spread = (xs: number[]) => (Math.max(...xs) - Math.min(...xs)) / Math.max(1e-12, Math.abs(mean(xs)));
    if (gravities.length > 1 && (spread(gravities) > 0.05 || spread(dampings) > 0.05)) {
      r.warn(
        'live2d-physics-vertices-averaged',
        `vertices differ in acceleration / delay / mobility (gravity ${gravities.map(fmt).join(', ')} px/s², damping ${dampings.map(fmt).join(', ')}); Rev2D uses one gravity and damping per group: their means`,
        `${where}.Vertices`,
      );
    }

    // ---- outputs
    const groupOutputs: Json[] = [];
    arrayOf(s.Output).forEach((out, j) => {
      const at = `${where}.Output[${j}]`;
      const dst = isObject(out) && isObject(out.Destination) && typeof out.Destination.Id === 'string' ? out.Destination.Id : undefined;
      const type = isObject(out) ? out.Type : undefined;
      const vi = isObject(out) ? finite(out.VertexIndex) : undefined;
      const scale = isObject(out) ? finite(out.Scale) : undefined;
      if (!dst || (type !== 'X' && type !== 'Y' && type !== 'Angle') || vi === undefined || scale === undefined) {
        r.warn('live2d-physics-invalid', 'output needs Destination.Id, Type X | Y | Angle, VertexIndex and Scale: skipped', at);
        return;
      }
      if (vi < 1 || vi >= verts.length || !Number.isInteger(vi)) {
        r.warn('live2d-physics-invalid', `VertexIndex ${vi} is not a vertex 1..${verts.length - 1} (the Cubism SDK skips it too): output dropped`, at);
        return;
      }
      const res = resolveLive2dParam(dst, map, model);
      legacy.add(res, dst);
      if (!res.ok) {
        unknown.add(dst, res.id, `PhysicsSettings[${i}].Output[${j}]`, res.hint);
        return;
      }
      const reflect = (out as Json).Reflect === true ? -1 : 1;
      // Cubism's X output of vertex k >= 2 is the x extent of segment k (Radius × sin of its own direction
      // from straight down, in physics units where +x is the screen's left): the angle of that segment,
      // not an offset from rest (Rev2D x outputs add up the offsets of the segments before it).
      const xAsAngle = type === 'X' && vi >= 2;
      const length = (segs[vi - 1]?.length as number | undefined) ?? 0;
      let factor = type === 'Angle' ? -scale / DEG_PER_RAD : xAsAngle ? (scale * length) / DEG_PER_RAD : type === 'X' ? -scale : scale;
      factor *= reflect;
      const w = finite((out as Json).Weight) ?? 100;
      if (Math.abs(w - 100) > 1e-9) {
        r.warn('live2d-physics-output-weight', `output Weight ${fmt(w)} % (a blend with the parameter's current value) is folded into the scale`, at, 'exact only while the parameter is otherwise at 0');
        factor *= w / 100;
      }
      if (vi >= 2 && type === 'Angle') {
        r.warn(
          'live2d-physics-angle-relative',
          `Cubism outputs the angle of vertex ${vi} relative to the previous segment (0 whenever the chain is straight, e.g. at rest under an Angle input); Rev2D outputs the angle of segment ${vi - 1} from the rest direction`,
          at,
          'the Rev2D output keeps the tilt of the whole chain and swings more; lower the scale or output an earlier segment if that is too much',
        );
      } else if (xAsAngle) {
        r.info(
          'live2d-physics-x-as-angle',
          `Cubism's X output of vertex ${vi} is the x extent of segment ${vi - 1} (Radius × sin of its direction): imported as that segment's angle, scale = Scale × Radius × π / 180 (exact for small swings; at 30° the angle is ${fmt(100 * (Math.PI / 6 / Math.sin(Math.PI / 6) - 1))} % larger than the sine)`,
          at,
        );
      }
      if (type === 'Y') {
        r.warn('live2d-physics-y-offset', `Cubism's Y output is the segment's vertical extent (radius at rest); Rev2D outputs the offset from rest, so the value differs by a constant ${fmt(scale * (finite((verts[vi] as Json)?.Radius) ?? 0))}`, at);
      }
      if (type !== 'Angle') {
        r.warn(
          'live2d-physics-translation-output',
          `${type} output: the Cubism SDKs (Web, Native) never read the Scale of X / Y outputs and evaluate them as 0, so SDK apps write 0 (clamped to the range) to ${q(dst)}; imported as the file describes it`,
          at,
          'if the model was tuned in an SDK app, remove this output (physics "skip", or delete it from the group)',
        );
      }
      const segment = vi - 1;
      groupOutputs.push({
        param: res.id,
        type: type === 'Angle' || xAsAngle ? 'angle' : type === 'X' ? 'x' : 'y',
        ...(segment === verts.length - 2 ? {} : { segment }),
        scale: round(factor, 8),
      });
    });

    if (!groupInputs.length || !groupOutputs.length) {
      r.warn('live2d-physics-setting-dropped', `no usable ${groupInputs.length ? 'output' : 'input'} left: setting dropped`, where);
      return;
    }
    const id = uniqueId(sanitizeId(sid, `physics${i + 1}`), ids);
    const name = names.get(sid);
    if (groupInputs.some((g) => g.type === 'angle')) angleInputs.push(`PhysicsSettings[${i}]`);
    physics.push({
      id,
      inputs: groupInputs,
      outputs: groupOutputs,
      segments: segs,
      gravity: round(gravity, 4),
      damping: round(damping, 6),
      stiffness: 0,
      description: `Live2D physics${name ? ` "${name}"` : ''} (${sid}), approximated.`,
    });
  });

  unknown.report(r, 'physics input(s) / output(s)');
  legacy.report(r, 'PhysicsSettings');
  if (angleInputs.length) {
    r.info(
      'live2d-physics-angle-input',
      `${angleInputs.length} setting(s) have Angle inputs: Cubism turns the pendulum's gravity, so the chain swings over to the new direction (overshooting); Rev2D turns the rest direction its outputs are measured from, so without stiffness their outputs follow an Angle input at once, without swinging (same value at rest)`,
      compactLocations(angleInputs),
      'a head tilt moves the hair parameters immediately; X / Y inputs (and body sway) still swing as in Cubism',
    );
  }
  const pairs: Array<[string, number]> = [
    ['PhysicsSettingCount', doc.PhysicsSettings.length],
    ['TotalInputCount', inputs],
    ['TotalOutputCount', outputs],
    ['VertexCount', vertices],
  ];
  for (const [key, actual] of pairs) {
    const given = finite(meta[key]);
    if (given !== undefined && given !== actual) {
      r.warn('live2d-meta-count-mismatch', `Meta.${key} is ${given} but the settings have ${actual}`, `Meta.${key}`, 'the Cubism SDK sizes its buffers from Meta; the settings were read as they are');
    }
  }
  if (physics.length) {
    r.info(
      'live2d-physics-approximation',
      `${physics.length} Cubism physics setting(s) mapped to Rev2D pendulum groups (approximation: 1 unit = 1 px, gravity = 900 × Acceleration × Delay² px/s², damping = 1 - Mobility^(${fmt(fps)}/60) per 60 Hz step, angle outputs converted from radians to degrees)`,
      'PhysicsSettings',
      'check the swing with rev2d sheet <model> --anim <motion> --warmup 2 and tune weights, gravity, damping or output scales',
    );
  }
  r.count('physicsSettings', physics.length);
  r.count('inputs', physics.reduce((n, g) => n + (g.inputs as unknown[]).length, 0));
  r.count('outputs', physics.reduce((n, g) => n + (g.outputs as unknown[]).length, 0));
  return { physics, report: r.report('live2d-physics3', 'import') };
}

/**
 * World direction (radians from straight down, per radian of Angle input) at which each segment of a
 * Rev2D chain comes to rest when the rest direction is tilted: gravity pulls every particle down,
 * stiffness pulls it toward its place on the tilted rest line, and in equilibrium each particle's
 * acceleration points along its segment. Small-angle solution, segment by segment from the pivot:
 * x_i = (g x_{i-1} - k_i L_i d_i) / (g + k_i L_i) with k_i = stiffness / mass_i, d_i = distance of
 * particle i from the pivot, x_i its sideways offset (per radian); the segment's direction is
 * (x_{i-1} - x_i) / L_i. 0 without stiffness (the chain hangs straight down), 1 without gravity.
 */
export function restTilt(g: Pick<Model['physics'][number], 'gravity' | 'stiffness' | 'segments'>): number[] {
  const out: number[] = [];
  let x = 0;
  let along = 0;
  for (const seg of g.segments) {
    along += seg.length;
    const k = seg.mass > 0 ? g.stiffness / seg.mass : 0;
    const den = g.gravity + k * seg.length;
    const next = Math.abs(den) > 1e-12 ? (g.gravity * x - k * seg.length * along) / den : x;
    out.push(seg.length > 0 ? (x - next) / seg.length : 0);
    x = next;
  }
  return out;
}

export function exportPhysics3(model: Model, opts: Live2dExportOptions = {}): { physics3: Json; report: InteropReport } {
  const r = new Reporter();
  const map = opts.paramMap ?? STANDARD_PARAM_MAP;
  const params = new Map(model.parameters.map((p) => [p.id, p]));
  const settings: Json[] = [];
  const dictionary: Json[] = [];
  let totalIn = 0;
  let totalOut = 0;
  let totalVerts = 0;
  model.physics.forEach((g, gi) => {
    const where = `physics[${gi}] (${g.id})`;
    const half = (id: string) => {
      const p = params.get(id);
      return p ? { half: (p.max - p.min) / 2, mid: (p.max + p.min) / 2 } : { half: 0, mid: 0 };
    };
    const maxIn = (types: string[]) => Math.max(0, ...g.inputs.filter((i) => types.includes(i.type)).map((i) => Math.abs(i.weight) * half(i.param).half));
    const posN = round(maxIn(['x', 'y'])) || 10;
    const angN = round(maxIn(['angle'])) || 10;
    // Cubism's chain follows an Angle input fully (it turns gravity); a Rev2D chain with stiffness keeps
    // only part of the tilt at rest (restTilt), and outputs measure from the tilted rest direction: its
    // outputs settle at (1 - restTilt) of the tilt. Angle weights are scaled by that share so both rest
    // at the same value (mean over the output segments).
    const tilt = restTilt(g);
    const outSegs = g.outputs.map((o) => (o.segment < 0 ? g.segments.length - 1 : o.segment));
    const shares = outSegs.map((s) => 1 - (tilt[s] ?? 0));
    const angleShare = shares.length ? shares.reduce((a, b) => a + b, 0) / shares.length : 1;
    const scaleAngles = g.inputs.some((i) => i.type === 'angle') && Math.abs(angleShare - 1) > 1e-9;
    if (scaleAngles) {
      const spread = Math.max(...shares) - Math.min(...shares);
      r.info(
        'live2d-physics-angle-weight-scaled',
        `Angle input weights × ${fmt(angleShare)}: with stiffness ${fmt(g.stiffness)} the Rev2D chain keeps part of an Angle input's tilt at rest and its outputs settle at ${fmt(angleShare)} of the tilt, while Cubism's chain follows the tilt fully${spread > 0.05 ? ` (the output segments settle at ${shares.map(fmt).join(', ')}: their mean is used)` : ''}`,
        where,
        'small-angle equilibrium of gravity and stiffness; the swing on the way there differs',
      );
    }
    const inputs = g.inputs.map((inp, j) => {
      const { half: h, mid } = half(inp.param);
      const n = inp.type === 'angle' ? angN : posN;
      if (!(h > 0)) r.warn('live2d-physics-param-range-empty', `input parameter ${q(inp.param)} has an empty range: its weight is 0`, `${where}.inputs[${j}]`);
      if (inp.type === 'angle' && Math.abs(mid) > 1e-9) {
        r.warn(
          'live2d-physics-angle-offset',
          `Cubism normalizes ${q(inp.param)} from the middle of its range (${fmt(mid)}), not from 0: the pendulum is tilted by ${fmt(-mid * inp.weight)}° at 0`,
          `${where}.inputs[${j}]`,
        );
      }
      const weight = (h > 0 ? (100 * Math.abs(inp.weight) * h) / n : 0) * (inp.type === 'angle' && scaleAngles ? Math.max(0, angleShare) : 1);
      const negative = inp.weight < 0;
      return {
        Source: { Target: 'Parameter', Id: toLive2dId(inp.param, map) },
        Weight: round(weight),
        Type: inp.type === 'angle' ? 'Angle' : inp.type === 'x' ? 'X' : 'Y',
        Reflect: inp.type === 'y' ? !negative && inp.weight !== 0 : negative,
      };
    });
    if (g.inputs.some((i) => i.type === 'y')) {
      r.info('live2d-physics-y-input', 'Y inputs are written with Type "Y": the Cubism SDK reads them, the Cubism Editor offers only X and Angle', where);
    }
    const n = g.segments.length;
    const vertices: Json[] = [{ Position: { X: 0, Y: 0 }, Mobility: 1, Delay: 1, Acceleration: 1, Radius: 0 }];
    let along = 0;
    g.segments.forEach((seg) => {
      along += seg.length;
      const acc = (g.gravity + (g.stiffness / seg.mass) * along) / GRAVITY_UNIT;
      vertices.push({ Position: { X: 0, Y: round(along) }, Mobility: round(1 - g.damping), Delay: 1, Acceleration: round(acc), Radius: round(seg.length) });
    });
    if (g.stiffness > 0) {
      r.warn(
        'live2d-physics-stiffness-approximated',
        `stiffness ${fmt(g.stiffness)} has no Cubism equivalent: added to each vertex's acceleration (stiffness × distance from the pivot, which restores small swings equally)`,
        where,
        'large swings behave differently, and so does the swing after an Angle input (Angle weights are scaled so the rest tilt matches); compare the motion in Cubism Viewer',
      );
    }
    if (!(g.gravity > 0) && !(g.stiffness > 0)) r.warn('live2d-physics-no-gravity', `gravity ${fmt(g.gravity)}: the Cubism pendulum has no restoring force`, where);
    const outputs = g.outputs.map((o, j) => {
      const seg = o.segment < 0 ? n - 1 : o.segment;
      const at = `${where}.outputs[${j}]`;
      // Rev2D value = scale × (degrees | px); Cubism value = ±Scale × (radians | physics units).
      // Only the Angle output of vertex 1 means what Rev2D outputs mean in the Cubism SDKs: Angle outputs
      // of vertex k >= 2 are relative to the previous segment (0 whenever the chain is straight, the
      // opposite sign during much of a swing), and X / Y outputs are always 0 (the SDKs never read their
      // Scale). So angle and x outputs are written as the Angle of vertex 1, the chain's first segment.
      let vi = seg + 1;
      let type: 'Angle' | 'Y' = o.type === 'y' ? 'Y' : 'Angle';
      let cubism: number;
      if (o.type === 'angle') {
        cubism = -o.scale * DEG_PER_RAD;
        if (vi >= 2) {
          vi = 1;
          r.warn(
            'live2d-physics-output-first-segment',
            `the angle of segment ${seg} is written as the Angle output of vertex 1 (the chain's first segment): Cubism's Angle output of vertex ${seg + 1} is relative to the previous segment, which reads 0 at rest and often has the opposite sign`,
            at,
            'the first segment swings in the same direction and rests at the same angle, with less of the lag and whip of the outer segments',
          );
        }
      } else if (o.type === 'x') {
        // Offset of the end of segment `seg` ≈ -(distance from the pivot) × angle (small swings, straight
        // chain; +angle = clockwise on screen, +x_screen = -x_physics).
        let along = 0;
        for (let k = 0; k <= seg; k++) along += g.segments[k].length;
        cubism = o.scale * along;
        vi = 1;
        r.info(
          'live2d-physics-x-as-angle',
          `x output written as the Angle output of vertex 1 with Scale = scale × ${fmt(along)} px (the end of segment ${seg} moves sideways by about ${fmt(along)} px per radian): the Cubism SDKs ignore the Scale of X outputs`,
          at,
          seg > 0 ? 'exact for small swings of a straight chain; the segments of a bending chain move by different angles' : 'exact for small swings (sin θ ≈ θ)',
        );
      } else {
        cubism = o.scale;
        r.warn('live2d-physics-y-offset', `Cubism's Y output is the segment's vertical extent (radius at rest), not the offset from rest: it is ${fmt(Math.abs(o.scale) * g.segments[seg].length)} higher at rest`, at);
        r.warn('live2d-physics-translation-output', 'written as a Y output, which the Cubism SDKs (Web, Native) evaluate as 0: they never read the Scale of X / Y outputs', at, 'drive the parameter from an angle output instead');
        type = 'Y';
      }
      return {
        Destination: { Target: 'Parameter', Id: toLive2dId(o.param, map) },
        VertexIndex: vi,
        Scale: round(Math.abs(cubism), 8),
        Weight: 100,
        Type: type,
        Reflect: cubism < 0,
      };
    });
    settings.push({
      Id: g.id,
      Input: inputs,
      Output: outputs,
      Vertices: vertices,
      Normalization: {
        Position: { Minimum: -posN, Default: 0, Maximum: posN },
        Angle: { Minimum: -angN, Default: 0, Maximum: angN },
      },
    });
    dictionary.push({ Id: g.id, Name: g.description ?? g.id });
    totalIn += inputs.length;
    totalOut += outputs.length;
    totalVerts += vertices.length;
  });
  if (settings.length) {
    r.info(
      'live2d-physics-approximation',
      `${settings.length} Rev2D physics group(s) written as Cubism physics settings (approximation: 1 px = 1 unit, Fps 60, Mobility = 1 - damping, Acceleration = gravity / 900, angle scales converted from degrees to radians)`,
      'physics',
      'check the swing in Cubism Viewer and tune Weight / Scale there',
    );
  }
  const physics3: Json = {
    Version: 3,
    Meta: {
      PhysicsSettingCount: settings.length,
      TotalInputCount: totalIn,
      TotalOutputCount: totalOut,
      VertexCount: totalVerts,
      Fps: REV2D_HZ,
      EffectiveForces: { Gravity: { X: 0, Y: -1 }, Wind: { X: 0, Y: 0 } },
      PhysicsDictionary: dictionary,
    },
    PhysicsSettings: settings,
  };
  r.count('physicsSettings', settings.length);
  r.count('inputs', totalIn);
  r.count('outputs', totalOut);
  r.count('vertices', totalVerts);
  return { physics3, report: r.report('live2d-physics3', 'export') };
}
