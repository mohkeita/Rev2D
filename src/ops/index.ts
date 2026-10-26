/**
 * Edit operations: high-level, id-addressed, atomic model edits for AI agents (and the editor).
 * Operates on the RAW model JSON (as authored, defaults not filled in) so edits stay minimal:
 * untouched items, fields and key order are preserved. See docs/OPS.md for the catalogue.
 *
 * A batch is atomic: ops run in order on a copy of the input; if any op fails, the remaining ops
 * are skipped and the ORIGINAL input is returned. The input object is never mutated.
 */
import type { Diagnostic, TextureInfo } from '../core/types.js';
import { validateModel } from '../core/validate.js';
import { OP_CATALOG, OP_NAMES, type OpDescription } from './catalog.js';
import type { OpContext } from './context.js';
import { opPatch } from './patch.js';
import { opAdd, opMove, opRemove, opRename, opUpdate } from './structure.js';
import { choiceHint, describe, fieldHint, Fields, isObject, type JsonObject, OpError, q } from './util.js';
import { opCompose } from './compose.js';
import { opFollow } from './follow.js';
import { opRecolor } from './recolor.js';
import { opAct } from './act.js';
import { opBind, opBindLinear, opKey, opSet, opUnbind, opUnkey } from './values.js';
import { opBindWarp } from './warp.js';

export type { OpDescription } from './catalog.js';
export { warpPoseOffsets, type WarpKeyPose } from './warp.js';

/** One edit. See docs/OPS.md for the full catalogue. */
export type Op = { op: string; [key: string]: unknown };

export interface OpResult {
  index: number;
  op: string;
  ok: boolean;
  /** What happened, e.g. 'added bone "arm" (local 12, -40)' or the error message. */
  message: string;
  hint?: string;
}

export interface ApplyOpsOptions {
  /** Validate the resulting model (default true). */
  validate?: boolean;
  /** Keep the result even when validation reports errors (default false). */
  allowInvalid?: boolean;
  /** Texture sizes (for ops that need image dimensions). */
  textures?: Record<string, TextureInfo>;
}

export interface ApplyOpsResult {
  /** True when every op applied and (unless allowInvalid) the result has no validation errors. */
  ok: boolean;
  /** Resulting raw model JSON (the ORIGINAL input, untouched, when !ok). */
  doc: unknown;
  results: OpResult[];
  diagnostics: Diagnostic[];
}

const HANDLERS: Record<string, (ctx: OpContext, f: Fields) => string> = {
  act: opAct,
  add: opAdd,
  update: opUpdate,
  remove: opRemove,
  rename: opRename,
  set: opSet,
  bind: opBind,
  bind_linear: opBindLinear,
  bind_warp: opBindWarp,
  follow: opFollow,
  unbind: opUnbind,
  key: opKey,
  unkey: opUnkey,
  move: opMove,
  recolor: opRecolor,
  compose: opCompose,
  patch: opPatch,
};

const SKIPPED = 'skipped: an earlier op failed, so nothing was applied (a batch is atomic; fix the failing op and resend the whole batch)';

export function applyOps(doc: unknown, ops: Op[], opts: ApplyOpsOptions = {}): ApplyOpsResult {
  const results: OpResult[] = [];
  const rejected = (): ApplyOpsResult => ({ ok: false, doc, results, diagnostics: [] });
  const list: unknown[] = Array.isArray(ops) ? ops : [ops];
  const nameOf = (op: unknown) => (isObject(op) && typeof op.op === 'string' ? op.op : '?');

  if (!Array.isArray(ops)) {
    results.push({ index: 0, op: nameOf(ops), ok: false, message: `ops must be an array of op objects, got ${describe(ops)}`, hint: 'e.g. [{"op": "set", "target": "bone:arm.rotation", "value": 30}]' });
    return rejected();
  }
  if (!isObject(doc)) {
    results.push({ index: 0, op: nameOf(list[0]), ok: false, message: `the model must be a JSON object, got ${describe(doc)}`, hint: 'pass the parsed model file ({"format": "rev2d", "version": 1, ...})' });
    return rejected();
  }

  let working: JsonObject;
  try {
    working = structuredClone(doc);
  } catch (e) {
    results.push({ index: 0, op: nameOf(list[0]), ok: false, message: `the model is not plain JSON data (${e instanceof Error ? e.message : String(e)})`, hint: 'pass the parsed model file' });
    return rejected();
  }
  const ctx: OpContext = { doc: working, textures: opts.textures ?? {} };
  let failed = false;
  list.forEach((op, index) => {
    const name = nameOf(op);
    if (failed) {
      results.push({ index, op: name, ok: false, message: SKIPPED });
      return;
    }
    try {
      results.push({ index, op: name, ok: true, message: runOp(ctx, op) });
    } catch (e) {
      failed = true;
      const error = e instanceof OpError ? e : new OpError(`internal error while applying the op: ${e instanceof Error ? e.message : String(e)}`, 'please report this; the model was left unchanged');
      results.push({ index, op: name, ok: false, message: error.message, ...(error.hint ? { hint: error.hint } : {}) });
    }
  });
  if (failed) return rejected();
  if (opts.validate === false) return { ok: true, doc: ctx.doc, results, diagnostics: [] };

  const { diagnostics } = validateModel(ctx.doc);
  if (!opts.allowInvalid && diagnostics.some((d) => d.severity === 'error')) return { ok: false, doc, results, diagnostics };
  return { ok: true, doc: ctx.doc, results, diagnostics };
}

function runOp(ctx: OpContext, raw: unknown): string {
  if (!isObject(raw)) throw new OpError(`each op must be an object like {"op": "add", ...}, got ${describe(raw)}`);
  // Work on a copy so no array or object of the caller's op ends up inside the result document.
  let op: JsonObject;
  try {
    op = structuredClone(raw);
  } catch (e) {
    throw new OpError(`the op is not plain JSON data (${e instanceof Error ? e.message : String(e)})`, 'ops are JSON objects: strings, numbers, booleans, null, arrays and objects');
  }
  const name = op.op;
  if (typeof name !== 'string') throw new OpError('the op has no "op" field', `ops: ${OP_NAMES.join(', ')}`);
  const entry = OP_CATALOG.find((d) => d.op === name);
  if (!entry) throw new OpError(`unknown op ${q(name)}`, choiceHint(name, OP_NAMES, 'ops'));
  const fields = Object.keys(entry.fields);
  for (const key of Object.keys(op)) {
    if (key !== 'op' && !fields.includes(key)) throw new OpError(`${name}: unknown field ${q(key)}`, fieldHint(key, fields, `fields of ${name}`));
  }
  return HANDLERS[name](ctx, new Fields(op, name));
}

/** The op catalogue (summary, fields, example per op) for tool descriptions and docs. */
export function describeOps(): OpDescription[] {
  return OP_CATALOG.map((d) => structuredClone(d));
}
