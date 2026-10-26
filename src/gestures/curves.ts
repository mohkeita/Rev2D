/** Numeric acting curve shared by the act op and the gesture libraries. */
export interface ActOptions {
  from: number;
  to: number;
  t?: number;
  duration?: number;
  anticipation?: number;
  overshoot?: number;
  settle?: number;
  hold?: number;
  release?: number;
}
export interface ActingKey {
  t: number;
  v: number;
  ease?: 'step' | 'inOutSine' | 'outSine';
}
export function actKeys(options: ActOptions): { keys: ActingKey[]; duration: number } {
  const {
    from,
    to,
    t = 0,
    duration = 0.6,
    anticipation = 0.15,
    overshoot = 0.12,
    settle = 0.3,
    hold = 0,
    release,
  } = options;
  if (
    ![
      from,
      to,
      t,
      duration,
      anticipation,
      overshoot,
      settle,
      hold,
      ...(release === undefined ? [] : [release]),
    ].every(Number.isFinite) ||
    t < 0 ||
    duration <= 0 ||
    anticipation < 0 ||
    anticipation > 1 ||
    overshoot < 0 ||
    overshoot > 1 ||
    settle < 0 ||
    hold < 0 ||
    (release !== undefined && release <= 0) ||
    (overshoot > 0 && settle === 0)
  )
    throw new RangeError(
      'act needs finite values, t >= 0, duration > 0, anticipation/overshoot in 0..1, settle/hold >= 0 and a positive optional release; overshoot requires settle > 0',
    );
  const delta = to - from,
    keys: ActingKey[] = [{ t, v: from, ease: 'outSine' }];
  if (anticipation > 0)
    keys.push({ t: t + duration * 0.2, v: from - delta * anticipation, ease: 'inOutSine' });
  keys.push({ t: t + duration, v: to + delta * overshoot, ease: 'outSine' });
  if (settle > 0) {
    if (overshoot > 0)
      keys.push({ t: t + duration + settle * 0.5, v: to - (delta * overshoot) / 3, ease: 'inOutSine' });
    keys.push({ t: t + duration + settle, v: to, ease: 'step' });
  }
  const end = t + duration + settle;
  if (hold > 0) keys.push({ t: end + hold, v: to, ease: release ? 'inOutSine' : 'step' });
  else keys[keys.length - 1].ease = release ? 'inOutSine' : 'step';
  if (release) keys.push({ t: end + hold + release, v: from });
  return {
    keys: keys.map((k) => ({ ...k, t: Math.round(k.t * 1e6) / 1e6, v: Math.round(k.v * 1e6) / 1e6 })),
    duration: Math.round((end + hold + (release ?? 0)) * 1e6) / 1e6,
  };
}
