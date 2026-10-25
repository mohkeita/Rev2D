import { easeFn } from '../core/easing.js';
import { keyTangents, hermiteValue } from '../core/rig/curves.js';
import { seconds, type Appearance, type NumberKey } from './schema.js';

export function sampleNumber(keys: readonly NumberKey[], t: number): number {
  if (!keys.length) return 0;
  const sorted = [...keys].sort((a, b) => seconds(a.t) - seconds(b.t));
  if (t <= seconds(sorted[0].t)) return sorted[0].v;
  const last = sorted.length - 1;
  if (t >= seconds(sorted[last].t)) return sorted[last].v;
  const i = sorted.findIndex((k, index) => index < last && t < seconds(sorted[index + 1].t));
  const a = sorted[i],
    b = sorted[i + 1],
    dt = seconds(b.t) - seconds(a.t),
    u = (t - seconds(a.t)) / dt;
  if (a.ease === 'smooth') {
    const tangents = keyTangents(
      sorted.map((k) => seconds(k.t)),
      sorted.map((k) => k.v),
      false,
      seconds(sorted[last].t),
    );
    return hermiteValue(a.v, b.v, tangents[i], tangents[i + 1], dt, u) as number;
  }
  return a.v + (b.v - a.v) * easeFn(a.ease)(u);
}

export interface AppearanceState {
  opacity: number;
  scale: number;
  x: number;
  y: number;
  reveal: number;
}
/** The exit is the exact reverse of the entry; pop uses a cubic back overshoot. */
export function appearanceAt(effect: Appearance | undefined, t: number, exit = false): AppearanceState {
  const out: AppearanceState = { opacity: 1, scale: 1, x: 0, y: 0, reveal: 1 };
  if (!effect) return out;
  const elapsed = (t - seconds(effect.t)) / effect.duration;
  const progress = Math.max(0, Math.min(1, elapsed));
  const u = exit ? 1 - progress : progress;
  if (u === 0) out.opacity = 0;
  if (effect.type === 'pop') {
    // The back coefficient maps authored overshoot to a visible, bounded settling motion.
    const c = effect.overshoot * 12;
    out.scale = u === 0 ? 0 : u === 1 ? 1 : 1 + (c + 1) * (u - 1) ** 3 + c * (u - 1) ** 2;
  } else {
    const p = effect.ease === 'smooth' ? u * u * (3 - 2 * u) : easeFn(effect.ease ?? 'inOutSine')(u);
    if (effect.type === 'fade') out.opacity = u === 0 ? 0 : p;
    if (effect.type.startsWith('slide-')) {
      const shift = (1 - p) * 160;
      if (effect.type === 'slide-left') out.x = -shift;
      if (effect.type === 'slide-right') out.x = shift;
      if (effect.type === 'slide-up') out.y = -shift;
      if (effect.type === 'slide-down') out.y = shift;
    }
    if (effect.type === 'wipe' || effect.type === 'draw-on') out.reveal = p;
  }
  return out;
}
