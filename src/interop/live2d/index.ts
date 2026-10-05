/**
 * Live2D Cubism JSON interop (motion3, exp3, physics3, cdi3, model3). The .moc3 model binary is a
 * proprietary, undocumented format and is intentionally NOT read or written.
 * OWNER: live2d agent.
 *
 * Readers and writers follow the public Cubism file format specifications; every approximation or
 * dropped feature is reported as an InteropIssue (see docs/SPEC.md-style notes in each module):
 *   params.ts    id mapping (STANDARD_PARAM_MAP, paramMapFromJson, prefixParamMap), standard ranges
 *   curves.ts    segment <-> key math (exactness of every ease)
 *   motion3.ts   motions         exp3.ts     expressions      physics3.ts  physics (approximation)
 *   cdi3.ts      display info    model3.ts   model3 import (ops) and full export
 */
import type { Model } from '../../core/types.js';
import type { Op } from '../../ops/index.js';
import type { InteropReport, Live2dExportOptions, Live2dImportOptions, OutputFile } from '../types.js';
import { exportCdi3, importCdi3 } from './cdi3.js';
import { importExp3 } from './exp3.js';
import { exportAll, importModel3, type Model3ImportOptions } from './model3.js';
import { exportMotion3, importMotion3, type MotionExportOptions, type MotionImportOptions } from './motion3.js';
import { exportPhysics3, importPhysics3 } from './physics3.js';

export {
  IDENTITY_PARAM_MAP,
  LIVE2D_STANDARD_PARAMS,
  STANDARD_PARAM_MAP,
  fromLive2dId,
  paramMapFromJson,
  prefixParamMap,
  toLive2dId,
} from './params.js';
export type { Model3ImportOptions } from './model3.js';
export type { MotionExportOptions, MotionImportOptions } from './motion3.js';

/**
 * motion3.json -> raw Rev2D animation (param tracks, events from UserData). With `opts.model`, curves
 * for parameters the model lacks are dropped (reported with a did-you-mean) and PartOpacity curves
 * become part opacity tracks for parts with the same id. `opts.groups` (model3 Groups) applies the
 * Model EyeBlink / LipSync curves.
 */
export function importLive2dMotion(
  json: string | Record<string, unknown>,
  id: string,
  opts: MotionImportOptions = {},
): { animation: Record<string, unknown>; report: InteropReport } {
  return importMotion3(json, id, opts);
}

/** Rev2D animation -> motion3.json (param tracks and part opacity; other tracks are reported). */
export function exportLive2dMotion(
  model: Model,
  animationId: string,
  opts: MotionExportOptions = {},
): { motion3: Record<string, unknown>; report: InteropReport } {
  return exportMotion3(model, animationId, opts);
}

/** exp3.json -> raw Rev2D animation meant to be layered (mode "add"). */
export function importLive2dExpression(
  json: string | Record<string, unknown>,
  id: string,
  opts: Live2dImportOptions = {},
): { animation: Record<string, unknown>; report: InteropReport } {
  return importExp3(json, id, opts);
}

/** physics3.json -> raw Rev2D physics groups (approximation of Cubism physics). */
export function importLive2dPhysics(
  json: string | Record<string, unknown>,
  opts: Live2dImportOptions = {},
): { physics: Array<Record<string, unknown>>; report: InteropReport } {
  return importPhysics3(json, opts);
}

/** Rev2D physics groups -> physics3.json (approximation). */
export function exportLive2dPhysics(model: Model, opts: Live2dExportOptions = {}): { physics3: Record<string, unknown>; report: InteropReport } {
  return exportPhysics3(model, opts);
}

/** cdi3.json -> parameter display names / groups (and part names). */
export function importLive2dDisplayInfo(
  json: string | Record<string, unknown>,
  opts: Live2dImportOptions = {},
): { parameters: Array<{ id: string; name?: string; group?: string }>; parts: Array<{ id: string; name: string }>; report: InteropReport } {
  return importCdi3(json, opts);
}

/** Rev2D parameters -> cdi3.json. */
export function exportLive2dDisplayInfo(model: Model, opts: Live2dExportOptions = {}): { cdi3: Record<string, unknown>; report: InteropReport } {
  return exportCdi3(model, opts);
}

/**
 * model3.json (+ the files it references, read through `readFile`) -> edit ops that bring its
 * motions, expressions, physics and display info into an existing Rev2D model (apply with applyOps).
 */
export function importLive2dModel3(
  model3: string | Record<string, unknown>,
  readFile: (relativePath: string) => string | undefined,
  opts: Model3ImportOptions,
): { ops: Op[]; report: InteropReport } {
  return importModel3(model3, readFile, opts);
}

/** Everything exportable at once: motions/*.motion3.json, <name>.physics3.json, <name>.cdi3.json and a partial <name>.model3.json listing them. */
export function exportLive2d(
  model: Model,
  opts: Live2dExportOptions & { animations?: string[]; name?: string; tolerance?: number } = {},
): { files: OutputFile[]; report: InteropReport } {
  return exportAll(model, opts);
}
