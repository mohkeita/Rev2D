/**
 * Animation events. Stateless poses report events exactly at each layer's local time; the Player
 * reports events crossed since its previous update. Layers with weight <= 0 emit no events, and
 * neither do layers outside their active window (hold = false, see layerActive).
 */
import type { Pose } from '../types.js';
import type { CompiledAnimation, CompiledEvent } from './compiled.js';
import { layerActive, layerTime, type FrameInputs, type ResolvedLayer } from './sampling.js';

type PoseEvent = Pose['events'][number];

const EXACT = 1e-6;
/**
 * Crossing tests use event times shifted down by this amount so that an event whose time is computed
 * with float error (k·duration + t) still fires in the update whose time equals it. Consecutive
 * (prev, cur] windows chain, so every event still fires exactly once.
 */
const CROSS_EPS = 1e-9;

function toPoseEvent(anim: CompiledAnimation, e: CompiledEvent): PoseEvent {
  return e.data === undefined ? { animation: anim.id, name: e.name, t: e.t } : { animation: anim.id, name: e.name, t: e.t, data: e.data };
}

/**
 * Events of `anim` at unwrapped layer time `raw`. Looping: compared modulo the duration (an event at
 * `duration` also matches 0). Non-looping: compared against the unclamped time, so an end event does
 * not repeat on every later frame; events after `duration` are never reached.
 */
export function eventsAt(anim: CompiledAnimation, raw: number, out: PoseEvent[]): void {
  const d = anim.duration;
  for (const e of anim.events) {
    let diff = e.t - raw;
    if (anim.loop) diff -= d * Math.round(diff / d);
    else if (e.t > d) continue;
    if (Math.abs(diff) < EXACT) out.push(toPoseEvent(anim, e));
  }
}

/**
 * Events with time in (prevRaw, curRaw] of unwrapped layer time, in chronological order. For looping
 * animations every crossed cycle counts, but when more than a full cycle elapsed each event is reported
 * once (the window is limited to the last `duration` seconds). Looping events before unwrapped time
 * `from` never fire (a non-holding layer before its start); an event at unwrapped 0 still does.
 */
export function eventsBetween(anim: CompiledAnimation, prevRaw: number, curRaw: number, out: PoseEvent[], from = -Infinity): void {
  if (!(curRaw > prevRaw) || anim.events.length === 0) return;
  const d = anim.duration;
  if (!anim.loop) {
    // Local time is clamped to [0, d], so nothing after d is ever crossed. The lower bound stays
    // unclamped: a layer whose clock starts negative still crosses an event at t = 0.
    const a = Math.min(d, prevRaw);
    const b = Math.min(d, curRaw);
    for (const e of anim.events) {
      const t = e.t - CROSS_EPS;
      if (t > a && t <= b) out.push(toPoseEvent(anim, e));
    }
    return;
  }
  const start = Math.max(prevRaw, curRaw - d, from - 2 * CROSS_EPS);
  for (let k = Math.floor(start / d); k * d <= curRaw + CROSS_EPS; k++) {
    for (const e of anim.events) {
      const t = k * d + e.t - CROSS_EPS;
      if (t > start && t <= curRaw) out.push(toPoseEvent(anim, e));
    }
  }
}

/** Stateless events for a frame. */
export function frameEvents(inputs: FrameInputs): PoseEvent[] {
  const out: PoseEvent[] = [];
  for (const layer of inputs.layers) {
    const raw = layerTime(layer, inputs, inputs.time);
    if (layer.weight > 0 && layerActive(layer, raw)) eventsAt(layer.anim, raw, out);
  }
  return out;
}

/**
 * Events a layer crossed between two updates of a Player (`prevRaw` undefined = first update, or its
 * clock went backwards: only the events exactly at `curRaw`).
 */
export function layerEventsBetween(layer: ResolvedLayer, prevRaw: number | undefined, curRaw: number, out: PoseEvent[]): void {
  if (layer.weight <= 0) return;
  if (prevRaw === undefined || curRaw < prevRaw) {
    if (layerActive(layer, curRaw)) eventsAt(layer.anim, curRaw, out);
  } else {
    eventsBetween(layer.anim, prevRaw, curRaw, out, layer.hold ? -Infinity : 0);
  }
}
