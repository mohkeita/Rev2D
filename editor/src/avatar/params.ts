/**
 * The pose controls of the preview (pure): the parameters of the model compiled in the browser,
 * main ones first with friendly names, linked pairs as one slider (both eyes, both brows), the
 * rest (physics outputs such as Hair_<id> / Sway_<id>, anything a later feature adds) after them.
 * Built from the COMPILED model, so parameters appear as the builder features add them.
 */
import type { Model } from '../../../src/core/index.js';

/** Friendly controls in display order: one or two parameter ids each (two = moved together). */
export const POSE_CONTROLS = [
  { id: 'turnX', params: ['AngleX'] },
  { id: 'turnY', params: ['AngleY'] },
  { id: 'tilt', params: ['AngleZ'] },
  { id: 'eyes', params: ['EyeLOpen', 'EyeROpen'] },
  { id: 'smile', params: ['EyeLSmile', 'EyeRSmile'] },
  { id: 'gazeX', params: ['EyeBallX'] },
  { id: 'gazeY', params: ['EyeBallY'] },
  { id: 'brows', params: ['BrowLY', 'BrowRY'] },
  { id: 'mouthOpen', params: ['MouthOpen'] },
  { id: 'mouthForm', params: ['MouthForm'] },
  { id: 'cheek', params: ['Cheek'] },
  { id: 'body', params: ['BodyAngleX'] },
  { id: 'breath', params: ['Breath'] },
] as const;

export type PoseControlId = (typeof POSE_CONTROLS)[number]['id'];

export interface PoseControl {
  /** A friendly control id (POSE_CONTROLS) or, for other parameters, null. */
  control: PoseControlId | null;
  /** The parameters it sets (the first one gives range and default). */
  params: string[];
  min: number;
  max: number;
  default: number;
  step: number;
}

function stepFor(min: number, max: number): number {
  return max - min > 4 ? 0.1 : 0.01;
}

/** The controls of a model: {main} with friendly names, {more} for every other parameter. */
export function poseControls(model: Pick<Model, 'parameters'> | null): { main: PoseControl[]; more: PoseControl[] } {
  if (!model) return { main: [], more: [] };
  const byId = new Map(model.parameters.map((p) => [p.id, p]));
  const used = new Set<string>();
  const main: PoseControl[] = [];
  for (const c of POSE_CONTROLS) {
    const present = c.params.filter((id) => byId.has(id));
    if (!present.length) continue;
    const p = byId.get(present[0])!;
    present.forEach((id) => used.add(id));
    main.push({ control: c.id, params: present, min: p.min, max: p.max, default: p.default ?? 0, step: stepFor(p.min, p.max) });
  }
  const more = model.parameters
    .filter((p) => !used.has(p.id))
    .map((p): PoseControl => ({ control: null, params: [p.id], min: p.min, max: p.max, default: p.default ?? 0, step: stepFor(p.min, p.max) }));
  return { main, more };
}

/** The value a control shows: the first parameter's explicit value, else its default. */
export function controlValue(c: PoseControl, values: Readonly<Record<string, number>>): number {
  const v = values[c.params[0]];
  return typeof v === 'number' && Number.isFinite(v) ? v : c.default;
}

/** Explicit values after moving a control (clamped to the range; linked parameters move together). */
export function setControl(values: Readonly<Record<string, number>>, c: PoseControl, value: number): Record<string, number> {
  const v = Math.min(c.max, Math.max(c.min, value));
  const next = { ...values };
  for (const id of c.params) next[id] = v;
  return next;
}

/** Explicit values without a control's parameters (back to the default / animation). */
export function resetControl(values: Readonly<Record<string, number>>, c: PoseControl): Record<string, number> {
  const next = { ...values };
  for (const id of c.params) delete next[id];
  return next;
}
