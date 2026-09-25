/** Pose inputs: JSON-friendly PoseInput -> checked core PoseOptions. */
import type { Model, PoseOptions } from '../core/types.js';
import type { Rig } from '../core/rig.js';
import { formatDiagnostics } from '../core/validate.js';
import { hasErrors, type LoadedModel } from '../node/load.js';
import { ApiError, idHint, show } from './errors.js';
import { toLayer, type LayerInput } from './layers.js';

export interface PoseInput {
  time?: number;
  /** Animation layers: layer strings ("idle", "blink@0.5", "talk@0.8,add", "wink,once,start=2") or objects. */
  animations?: Array<string | LayerInput>;
  params?: Record<string, number>;
  physics?: boolean;
}

export function requireRig(m: LoadedModel): Rig {
  if (!m.rig || hasErrors(m.diagnostics)) {
    throw new ApiError(
      `model has errors:\n${formatDiagnostics(m.diagnostics.filter((d) => d.severity === 'error'))}`,
      m.diagnostics,
    );
  }
  return m.rig;
}

/** Check a time in seconds (finite, >= 0). `what` names it in the message. */
export function checkTime(time: unknown, what = 'time'): number {
  if (typeof time !== 'number' || !Number.isFinite(time) || time < 0) {
    throw new ApiError(`${what} must be a finite number of seconds >= 0, got ${show(time)}`, [], 'time is measured from the start of the animations (physics is simulated from t = 0)');
  }
  return time;
}

/** Check explicit parameter values against the model (ids exist, values finite). */
export function checkParams(model: Model, params: Record<string, unknown> | undefined): void {
  const ids = model.parameters.map((p) => p.id);
  for (const [id, value] of Object.entries(params ?? {})) {
    if (!ids.includes(id)) throw new ApiError(`unknown parameter "${id}"`, [], idHint(id, ids, 'parameters'));
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      const p = model.parameters.find((q) => q.id === id)!;
      throw new ApiError(`parameter "${id}" needs a finite number, got ${show(value)}`, [], `its range is ${p.min}..${p.max}`);
    }
  }
}

/**
 * Convert PoseInput into core PoseOptions: parses layer strings (see LAYER_SYNTAX) and checks every
 * value, so a bad input is an ApiError with a did-you-mean hint rather than an evaluation failure.
 *
 * - animation ids must exist; layer weights must be within 0..1; layer times/starts finite
 * - `time` must be finite and >= 0 (seconds from the start; physics runs from t = 0)
 * - parameter ids must exist and values be finite (values outside [min, max] are clamped when evaluated)
 */
export function toPoseOptions(model: Model, input: PoseInput): PoseOptions {
  const time = checkTime(input.time ?? 0);
  const animations = (input.animations ?? []).map((a) => toLayer(model, a));
  checkParams(model, input.params);
  return { time, animations, params: input.params, physics: input.physics };
}
