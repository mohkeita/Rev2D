import type { Animation, Diagnostic, Model, Parameter } from '../core/types.js';
import { AnimationSchema } from '../core/schema.js';
import { fromTRS, multiply, apply, wrapDeg } from '../core/math.js';
import type { Mat2D } from '../core/types.js';
import { suggest, paramDefault } from '../core/address.js';
import { actKeys, type ActingKey } from './curves.js';
import { GESTURES, EXPRESSIONS, type GestureName, type ExpressionName } from './catalog.js';

export interface ActingOptions {
  id?: string;
  t?: number;
  duration?: number;
  intensity?: number;
  side?: 'R' | 'L' | 'both';
  hold?: number;
  release?: number;
  count?: 1 | 2 | 3;
}
export interface ActingResult {
  animation: Animation;
  diagnostics: Diagnostic[];
}
export class ActingError extends Error {
  constructor(readonly diagnostics: Diagnostic[]) {
    super(diagnostics.map((d) => d.message).join('; '));
  }
}
const diag = (
  code: string,
  path: string,
  message: string,
  hint: string,
  severity: Diagnostic['severity'] = 'warning',
): Diagnostic => ({ code, path, message, hint, severity });
function checked(options: ActingOptions): void {
  if (
    (options.id !== undefined && !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(options.id)) ||
    Object.entries(options).some(
      ([key, v]) =>
        ['t', 'duration', 'hold', 'release', 'intensity', 'count'].includes(key) &&
        v !== undefined &&
        !Number.isFinite(v),
    ) ||
    (options.intensity !== undefined && (options.intensity < 0 || options.intensity > 1)) ||
    (options.t !== undefined && options.t < 0) ||
    (options.duration !== undefined && options.duration <= 0) ||
    (options.hold !== undefined && options.hold < 0) ||
    (options.release !== undefined && options.release <= 0) ||
    (options.count !== undefined && ![1, 2, 3].includes(options.count)) ||
    (options.side !== undefined && !['R', 'L', 'both'].includes(options.side))
  )
    throw new ActingError([
      diag(
        'gesture-options',
        '',
        'invalid acting options',
        'use intensity in 0..1, nonnegative t/hold, positive duration/release, side R/L/both, count 1/2/3 and a valid animation id',
        'error',
      ),
    ]);
}
const clip = (p: Parameter, v: number) => Math.max(p.min, Math.min(p.max, v));
function animation(
  model: Model,
  name: string,
  targets: Record<string, number>,
  options: ActingOptions,
  extra?: (tracks: { target: string; keys: ActingKey[] }[], duration: number) => void,
): ActingResult {
  checked(options);
  const diagnostics: Diagnostic[] = [],
    tracks: { target: string; keys: ActingKey[] }[] = [];
  let end =
    (options.t ?? 0) + (options.duration ?? 0.6) + 0.3 + (options.hold ?? 1.2) + (options.release ?? 0.4);
  for (const [id, value] of Object.entries(targets)) {
    const p = model.parameters.find((p) => p.id === id);
    if (!p) {
      diagnostics.push(
        diag(
          'gesture-missing-param',
          '/parameters',
          `${name} cannot control absent parameter ${id}`,
          suggest(
            id,
            model.parameters.map((p) => p.id),
          ) ?? 'build a full avatar with the corresponding limbs/face feature',
        ),
      );
      continue;
    }
    const rest = paramDefault(p),
      discrete = (id.endsWith('Form') && id.startsWith('Hand')) || id === 'MouthShape',
      target = discrete
        ? options.intensity === 0
          ? rest
          : value
        : rest + (value - rest) * (options.intensity ?? 1);
    if (discrete) {
      const start = options.t ?? 0,
        main = options.duration ?? 0.6,
        hold = options.hold ?? 1.2,
        release = options.release ?? 0.4;
      tracks.push({
        target: 'param:' + id,
        keys: [
          { t: start, v: rest, ease: 'step' },
          { t: start + main, v: Math.round(clip(p, target)), ease: 'step' },
          ...(id.startsWith('Hand')
            ? [{ t: start + main + 0.3 + hold, v: rest, ease: 'step' as const }]
            : []),
          { t: start + main + 0.3 + hold + release, v: rest },
        ],
      });
      continue;
    }
    const curve = actKeys({
      from: rest,
      to: clip(p, target),
      t: options.t,
      duration: options.duration,
      hold: options.hold ?? 1.2,
      release: options.release ?? 0.4,
      anticipation: /^Arm[RL]A$/.test(id) ? 0.04 : 0.1,
      overshoot: 0.08,
      settle: 0.3,
    });
    tracks.push({ target: 'param:' + id, keys: curve.keys.map((k) => ({ ...k, v: clip(p, k.v) })) });
    end = Math.max(end, curve.duration);
  }
  extra?.(tracks, end);
  return {
    animation: AnimationSchema.parse({ id: options.id ?? name, duration: end, loop: false, tracks }),
    diagnostics,
  };
}
function setupWorld(model: Model, id: string, seen = new Set<string>()): Mat2D | null {
  const b = model.bones.find((b) => b.id === id);
  if (!b || seen.has(id)) return null;
  seen.add(id);
  const local = fromTRS(b.x, b.y, b.rotation, b.scaleX, b.scaleY);
  if (!b.parent) return local;
  const parent = setupWorld(model, b.parent, seen);
  return parent ? multiply(parent, local) : null;
}
/** Solve both elbow branches; choose a reachable solution within the authored parameter ranges. */
function armTarget(
  model: Model,
  side: 'R' | 'L',
  dx: number,
  dy: number,
  form: number,
  pointAngle?: number,
): Record<string, number> {
  const prefix = 'arm' + side,
    upper = model.bones.find((b) => b.id === prefix + 'Upper'),
    fore = model.bones.find((b) => b.id === prefix + 'Fore'),
    world = upper && setupWorld(model, upper.id);
  if (!upper || !fore || !world)
    return {
      [`Arm${side}A`]: side === 'R' ? 70 : -70,
      [`Arm${side}B`]: side === 'R' ? 40 : -40,
      [`Hand${side}Form`]: form,
    };
  const l1 = upper.length,
    l2 = fore.length,
    length = l1 + l2,
    px = dx * length,
    py = dy * length;
  const cosine = Math.max(-0.9999, Math.min(0.9999, (px * px + py * py - l1 * l1 - l2 * l2) / (2 * l1 * l2)));
  const base = Math.atan2(world[1], world[0]),
    direction = Math.atan2(py, px),
    aParam = model.parameters.find((p) => p.id === `Arm${side}A`),
    bParam = model.parameters.find((p) => p.id === `Arm${side}B`);
  const candidates = [1, -1]
    .map((sign) => {
      const bend = Math.acos(cosine) * sign,
        a = direction - Math.atan2(l2 * Math.sin(bend), l1 + l2 * Math.cos(bend)),
        A = wrapDeg(((a - base) * 180) / Math.PI),
        B = wrapDeg((bend * 180) / Math.PI - fore.rotation),
        penalty = (aParam ? Math.abs(A - clip(aParam, A)) : 0) + (bParam ? Math.abs(B - clip(bParam, B)) : 0);
      return { A, B, a, bend, score: penalty * 1000 + Math.abs(A) + Math.abs(B) * 0.2 };
    })
    .sort((a, b) => a.score - b.score);
  const best = candidates[0],
    wrist = pointAngle === undefined ? 0 : wrapDeg(pointAngle - ((best.a + best.bend) * 180) / Math.PI);
  return {
    [`Arm${side}A`]: best.A,
    [`Arm${side}B`]: best.B,
    [`Hand${side}`]: wrist,
    [`Hand${side}Form`]: form,
  };
}
export function generateGesture(model: Model, name: string, options: ActingOptions = {}): ActingResult {
  if (!Object.hasOwn(GESTURES, name))
    throw new ActingError([
      diag(
        'gesture-unknown',
        '',
        'unknown gesture ' + name,
        suggest(name, Object.keys(GESTURES)) ?? 'use gesture list',
        'error',
      ),
    ]);
  checked(options);
  const gesture = name as GestureName;
  if (gesture === 'nod_yes' || gesture === 'shake_no') {
    const result = animation(
      model,
      name,
      { [gesture === 'nod_yes' ? 'AngleY' : 'AngleX']: gesture === 'nod_yes' ? -12 : 15 },
      options,
      (tracks, end) => {
        const track = tracks[0];
        if (!track) return;
        const t = options.t ?? 0,
          d = options.duration ?? 0.6,
          amount = (options.intensity ?? 1) * (gesture === 'nod_yes' ? 12 : 15);
        track.keys = [
          { t, v: 0, ease: 'inOutSine' },
          { t: t + d / 3, v: -amount, ease: 'inOutSine' },
          { t: t + (2 * d) / 3, v: amount * 0.5, ease: 'inOutSine' },
          { t: t + d, v: 0 },
          { t: end, v: 0 },
        ];
      },
    );
    return result;
  }
  if (gesture === 'lean_in')
    return animation(model, name, { BodyAngleZ: -5, BodyY: -4, AngleY: -5 }, options);
  const defaultsBoth = ['voila', 'shrug', 'celebrate', 'cross_arms'].includes(gesture),
    choice = options.side ?? (defaultsBoth ? 'both' : gesture === 'point_right' ? 'L' : 'R'),
    sides: ('R' | 'L')[] = choice === 'both' ? ['R', 'L'] : [choice];
  const targets: Record<string, number> = {};
  for (const side of sides) {
    const outward = side === 'R' ? -1 : 1,
      inward = -outward;
    let dx = outward * 0.9,
      dy = 0,
      form = 0,
      angle: number | undefined;
    switch (gesture) {
      case 'voila':
        dx = outward * 0.78;
        dy = 0.03;
        form = 2;
        break;
      case 'point_left':
        dx = -0.8;
        dy = -0.05;
        form = 3;
        angle = 180;
        break;
      case 'point_right':
        dx = 0.8;
        dy = -0.05;
        form = 3;
        angle = 0;
        break;
      case 'point_up':
        dx = outward * 0.1;
        dy = -0.95;
        form = 3;
        angle = -90;
        break;
      case 'shrug':
        dx = outward * 0.7;
        dy = -0.25;
        form = 2;
        targets.BodyY = -3;
        break;
      case 'think':
        dx = inward * 0.4;
        dy = -0.3;
        form = 4;
        targets.AngleZ = side === 'R' ? 4 : -4;
        targets.EyeBallX = 0.3;
        break;
      case 'scratch_head':
        dx = outward * 0.2;
        dy = -0.9;
        form = 4;
        targets.AngleZ = side === 'R' ? 5 : -5;
        break;
      case 'facepalm':
        dx = inward * 0.35;
        dy = -0.68;
        form = 1;
        angle = -90;
        targets.AngleY = -8;
        break;
      case 'count':
        dx = outward * 0.7;
        dy = -0.2;
        form = options.count === 2 ? 6 : options.count === 3 ? 7 : 3;
        break;
      case 'wave':
        dx = outward * 0.65;
        dy = -0.55;
        form = 1;
        break;
      case 'thumbs_up':
        dx = outward * 0.7;
        dy = -0.2;
        form = 5;
        break;
      case 'cross_arms':
        dx = inward * 0.75;
        dy = 0.15;
        form = 4;
        break;
      case 'celebrate':
        dx = outward * 0.5;
        dy = -0.8;
        form = 1;
        targets.BodyY = -4;
        targets.MouthForm = 0.7;
        break;
    }
    Object.assign(targets, armTarget(model, side, dx, dy, form, angle));
  }
  return animation(model, name, targets, options, (tracks) => {
    if ((gesture !== 'wave' && gesture !== 'scratch_head') || (options.hold ?? 1.2) === 0) return;
    const start = (options.t ?? 0) + (options.duration ?? 0.6) + 0.3,
      hold = options.hold ?? 1.2;
    for (const side of sides) {
      const id = gesture === 'wave' ? `Hand${side}` : `Arm${side}B`,
        p = model.parameters.find((p) => p.id === id),
        track = tracks.find((t) => t.target === 'param:' + id);
      if (!p || !track) continue;
      const base = clip(p, paramDefault(p) + (targets[id] - paramDefault(p)) * (options.intensity ?? 1));
      for (let i = 1; i <= 6; i++)
        track.keys.push({
          t: Math.round((start + (hold * i) / 7) * 1e6) / 1e6,
          v: clip(p, base + (i % 2 ? 1 : -1) * (gesture === 'wave' ? 18 : 5) * (options.intensity ?? 1)),
          ease: 'inOutSine',
        });
      track.keys.sort((a, b) => a.t - b.t);
    }
  });
}
const FACES: Record<ExpressionName, Record<string, number>> = {
  neutral: {
    EyeLOpen: 1,
    EyeROpen: 1,
    EyeWide: 0,
    EyeBallX: 0,
    EyeBallY: 0,
    BrowLY: 0,
    BrowRY: 0,
    MouthOpen: 0,
    MouthForm: 0,
    MouthShape: 0,
    AngleX: 0,
    AngleY: 0,
    AngleZ: 0,
  },
  happy: {
    EyeLOpen: 0.85,
    EyeROpen: 0.85,
    BrowLY: 0.25,
    BrowRY: 0.25,
    MouthForm: 0.7,
    MouthShape: 4,
    AngleY: 3,
  },
  laugh: {
    EyeLOpen: 0.3,
    EyeROpen: 0.3,
    BrowLY: 0.4,
    BrowRY: 0.4,
    MouthOpen: 0.65,
    MouthForm: 0.8,
    MouthShape: 2,
    AngleY: 6,
  },
  surprised: {
    EyeWide: 0.65,
    EyeLOpen: 1,
    EyeROpen: 1,
    BrowLY: 0.65,
    BrowRY: 0.65,
    MouthOpen: 0.45,
    MouthForm: -0.7,
    MouthShape: 1,
    AngleY: 3,
  },
  shocked: {
    EyeWide: 1,
    EyeLOpen: 1,
    EyeROpen: 1,
    BrowLY: 0.8,
    BrowRY: 0.8,
    MouthOpen: 0.9,
    MouthForm: -0.8,
    MouthShape: 1,
    AngleY: 5,
  },
  worried: { EyeWide: 0.15, BrowLY: 0.7, BrowRY: 0.5, MouthForm: -0.5, MouthShape: 3, AngleY: -5, AngleZ: 3 },
  thinking: {
    EyeBallX: 0.4,
    EyeBallY: 0.2,
    BrowLY: 0.5,
    BrowRY: -0.15,
    MouthForm: -0.15,
    AngleZ: 7,
    MouthShape: 0,
  },
  annoyed: {
    EyeLOpen: 0.65,
    EyeROpen: 0.65,
    BrowLY: -0.7,
    BrowRY: -0.7,
    EyeBallX: -0.3,
    MouthForm: -0.5,
    MouthShape: 3,
  },
  sad: {
    EyeLOpen: 0.7,
    EyeROpen: 0.7,
    BrowLY: 0.5,
    BrowRY: 0.5,
    MouthForm: -0.65,
    MouthShape: 3,
    AngleY: -8,
  },
  proud: { AngleY: 8, MouthForm: 0.6, MouthShape: 2, EyeLOpen: 0.85, EyeROpen: 0.85 },
  confused: { AngleZ: -8, BrowLY: 0.7, BrowRY: -0.4, EyeBallX: -0.2, MouthForm: -0.2, MouthShape: 0 },
};
export function generateExpression(model: Model, name: string, options: ActingOptions = {}): ActingResult {
  if (!Object.hasOwn(EXPRESSIONS, name))
    throw new ActingError([
      diag(
        'expression-unknown',
        '',
        'unknown expression ' + name,
        suggest(name, Object.keys(EXPRESSIONS)) ?? 'use expression list',
        'error',
      ),
    ]);
  return animation(model, options.id ?? 'expression_' + name, FACES[name as ExpressionName], {
    ...options,
    duration: options.duration ?? 0.35,
    release: options.release ?? 0.25,
  });
}
