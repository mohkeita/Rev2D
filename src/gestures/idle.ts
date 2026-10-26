import { AnimationSchema } from '../core/schema.js';
import type { Model, Animation, Diagnostic } from '../core/types.js';
import { mulberry32 } from '../avatar/image/random.js';
import type { ActingResult } from './acting.js';

export function actingSeed(value: string | number): number {
  if (typeof value === 'number') return value >>> 0;
  let hash = 0x811c9dc5;
  for (const c of value) {
    hash ^= c.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
/** Events mark blink groups; a double pulse remains one group for interval measurements. */
export function generateIdle(
  model: Model,
  seed: string | number,
  duration = 60,
  id = 'idle_alive',
): ActingResult {
  if (!Number.isFinite(duration) || duration < 1 || duration > 3600)
    throw new RangeError('idle duration must be in 1..3600 seconds');
  const random = mulberry32(actingSeed(seed)),
    groups: { t: number; double: boolean }[] = [];
  for (let t = 2 + random() * 4; t < duration - 0.6; t += 2 + random() * 4)
    groups.push({ t: Math.round(t * 1e6) / 1e6, double: random() < 0.22 });
  const tracks: Record<string, unknown>[] = [],
    diagnostics: Diagnostic[] = [];
  for (const eye of ['EyeLOpen', 'EyeROpen']) {
    if (!model.parameters.some((p) => p.id === eye)) continue;
    const keys = [{ t: 0, v: 1, ease: 'inOutSine' }];
    for (const group of groups) {
      keys.push(
        { t: group.t, v: 1, ease: 'inOutSine' },
        { t: group.t + 0.07, v: 0, ease: 'inOutSine' },
        { t: group.t + 0.19, v: 1, ease: 'inOutSine' },
      );
      if (group.double)
        keys.push(
          { t: group.t + 0.28, v: 1, ease: 'inOutSine' },
          { t: group.t + 0.35, v: 0, ease: 'inOutSine' },
          { t: group.t + 0.47, v: 1, ease: 'inOutSine' },
        );
    }
    keys.push({ t: duration, v: 1, ease: 'inOutSine' });
    tracks.push({ target: 'param:' + eye, keys });
  }
  const parameters: [string, number, number][] = [
    ['Breath', 0.45, 0.4],
    ['BodyAngleX', 0, 0.7],
    ['AngleX', 0, 2.5],
    ['AngleY', 0, 1.5],
    ['AngleZ', 0, 0.7],
    ['EyeBallX', 0, 0.35],
    ['EyeBallY', 0, 0.2],
    ['HandR', 0, 1.8],
    ['HandL', 0, 1.8],
  ];
  for (const [param, center, amount] of parameters) {
    const p = model.parameters.find((p) => p.id === param);
    if (!p) continue;
    const phase = random() * Math.PI * 2,
      cycles =
        param === 'Breath'
          ? Math.max(1, Math.round(duration / (3.2 + random())))
          : Math.max(1, Math.round(duration / (5 + random() * 6)));
    const keys = Array.from({ length: Math.ceil(duration * 4) + 1 }, (_, i) => {
      const t = Math.min(duration, i / 4),
        v = center + amount * Math.sin((t / duration) * cycles * Math.PI * 2 + phase);
      return { t, v: Math.max(p.min, Math.min(p.max, v)), ease: 'smooth' };
    });
    if (keys.at(-1)!.t < duration) keys.push({ ...keys[0], t: duration });
    else keys[keys.length - 1] = { ...keys[0], t: duration };
    tracks.push({ target: 'param:' + param, keys });
  }
  const animation: Animation = AnimationSchema.parse({
    id,
    duration,
    loop: true,
    tracks,
    events: groups.map((g) => ({
      t: g.t,
      name: 'blink',
      data: { double: g.double, seed: actingSeed(seed) },
    })),
  });
  return { animation, diagnostics };
}
