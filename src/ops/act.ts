import { actKeys } from '../gestures/curves.js';
import type { OpContext } from './context.js';
import { Fields, OpError } from './util.js';
import { resolveRaw, findItem } from './model.js';
import { opKey } from './values.js';

export function opAct(ctx: OpContext, f: Fields): string {
  const target = f.string('target', 'numeric property or parameter address'),
    name = f.string('animation', 'animation id');
  const resolved = resolveRaw(ctx.doc, target, 'act');
  if (resolved.resolved.valueType !== 'number')
    throw new OpError('act requires a numeric target', 'use a parameter or numeric bone/part property');
  let curve: ReturnType<typeof actKeys>;
  try {
    curve = actKeys({
      from: f.number('from', 'starting value'),
      to: f.number('to', 'destination value'),
      t: f.optNumber('t', 'start seconds'),
      duration: f.optNumber('duration', 'main move seconds'),
      anticipation: f.optNumber('anticipation', 'opposite amplitude share'),
      overshoot: f.optNumber('overshoot', 'overshoot share'),
      settle: f.optNumber('settle', 'settling seconds'),
      hold: f.optNumber('hold', 'hold seconds'),
      release: f.optNumber('release', 'return seconds'),
    });
  } catch (e) {
    throw new OpError((e as Error).message, 'correct the acting durations and amplitude shares');
  }
  if (resolved.address.kind === 'param') {
    const min = Number(resolved.item.min),
      max = Number(resolved.item.max);
    for (const key of curve.keys)
      if (key.v < min || key.v > max)
        throw new OpError(
          `act value ${key.v} is outside ${target} [${min}, ${max}]`,
          `clamp this value to ${Math.max(min, Math.min(max, key.v))}, reduce anticipation/overshoot, or choose a destination farther from the limit`,
        );
  }
  const existing = findItem(ctx.doc, 'animation', name)?.item;
  if (existing) existing.duration = Math.max(Number(existing.duration), curve.duration);
  for (const [index, key] of curve.keys.entries())
    opKey(
      ctx,
      new Fields(
        {
          animation: name,
          target,
          t: key.t,
          v: key.v,
          ease: key.ease,
          ...(!existing && index === 0 ? { duration: Math.max(0.001, curve.duration), loop: false } : {}),
        },
        'key',
      ),
    );
  return `acted ${target} in animation "${name}" (${curve.keys.length} keys)`;
}
