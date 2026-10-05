/**
 * exp3.json (Live2D expression) -> a Rev2D animation meant to be played as an additive layer.
 *
 * The Cubism SDK combines expression parameters as (current + Σ Add) × Π Multiply, or replaces the
 * value (Overwrite). The import writes a one-key, non-looping animation whose values are ABSOLUTE
 * (Rev2D convention): Add -> default + Value, Overwrite -> Value, Multiply -> default × Value. Played with
 * mode "add" (`--anim "<id>,add"`), a layer adds (value - default): exact for Add, and exact for
 * Overwrite / Multiply only while the parameter sits at its default (reported).
 */
import type { InteropReport, Live2dImportOptions } from '../types.js';
import { checkStandardRange, LegacyIds, LIVE2D_STANDARD_PARAMS, modernLive2dId, resolveLive2dParam, STANDARD_PARAM_MAP, UnknownParams } from './params.js';
import { arrayOf, finite, fmt, IMPORTED_EXPRESSION, isObject, type Json, modelInfo, parseJsonInput, q, Reporter } from './util.js';

export function importExp3(json: string | Json, animationId: string, opts: Live2dImportOptions & { checked?: Set<string> } = {}): { animation: Json; report: InteropReport } {
  const r = new Reporter();
  const doc = parseJsonInput(json, 'exp3.json');
  const map = opts.paramMap ?? STANDARD_PARAM_MAP;
  const model = modelInfo(opts.model);
  const checked = opts.checked ?? new Set<string>();
  if (doc.Type !== 'Live2D Expression') r.warn('live2d-exp-type', `Type is ${JSON.stringify(doc.Type)}, expected "Live2D Expression"`, 'Type');
  if (!Array.isArray(doc.Parameters)) throw new Error('exp3.json: "Parameters" must be an array');
  const tracks: Json[] = [];
  const seen = new Set<string>();
  const approximated: string[] = [];
  const unknown = new UnknownParams();
  const legacy = new LegacyIds();
  arrayOf(doc.Parameters).forEach((raw, i) => {
    const where = `Parameters[${i}]`;
    if (!isObject(raw) || typeof raw.Id !== 'string' || finite(raw.Value) === undefined) {
      r.warn('live2d-exp-invalid', 'expression parameter needs an Id string and a numeric Value: skipped', where);
      return;
    }
    const value = raw.Value as number;
    const blend = raw.Blend === undefined ? 'Add' : raw.Blend;
    if (blend !== 'Add' && blend !== 'Multiply' && blend !== 'Overwrite') {
      r.warn('live2d-exp-invalid', `unknown Blend ${JSON.stringify(blend)} (Add, Multiply or Overwrite): skipped`, `${where} (${raw.Id})`);
      return;
    }
    const res = resolveLive2dParam(raw.Id, map, model);
    legacy.add(res, raw.Id);
    if (!res.ok) {
      unknown.add(raw.Id, res.id, `Parameters[${i}]`, res.hint);
      r.count('droppedParameters');
      return;
    }
    if (res.param) checkStandardRange(res.param, raw.Id, r, checked, `${where} (${raw.Id})`);
    // Without a target model: the Live2D standard default, else 0.
    const def = res.param?.default ?? LIVE2D_STANDARD_PARAMS[res.ok && res.legacy ? res.legacy : raw.Id]?.default ?? LIVE2D_STANDARD_PARAMS[modernLive2dId(raw.Id) ?? '']?.default ?? 0;
    let v: number;
    if (blend === 'Add') v = def + value;
    else if (blend === 'Overwrite') v = value;
    else v = def * value;
    if (blend !== 'Add' && Math.abs(v - def) > 1e-12) approximated.push(`${res.id} (${blend})`);
    if (blend === 'Multiply' && Math.abs(v - def) <= 1e-12 && Math.abs(value - 1) > 1e-12) {
      r.info('live2d-exp-multiply-noop', `Multiply ${fmt(value)} of ${q(res.id)} changes nothing at its default ${fmt(def)}: the key keeps the default`, `${where} (${raw.Id})`);
    }
    if (seen.has(res.id)) r.warn('live2d-exp-duplicate', `${q(res.id)} is listed twice: the later entry wins`, `${where} (${raw.Id})`);
    seen.add(res.id);
    const target = `param:${res.id}`;
    const existing = tracks.findIndex((t) => t.target === target);
    if (existing >= 0) tracks.splice(existing, 1);
    tracks.push({ target, keys: [{ t: 0, v }] });
  });
  unknown.report(r, 'expression parameter(s)');
  legacy.report(r, 'Parameters');
  if (approximated.length) {
    r.warn(
      'live2d-exp-blend-approximated',
      `Overwrite / Multiply parameters (${approximated.join(', ')}) become absolute keys; layered with mode "add" they are exact only while the parameter is at its default`,
      'Parameters',
      'play the expression as an override layer instead when those parameters must be forced',
    );
  }
  const fadeIn = finite(doc.FadeInTime);
  const fadeOut = finite(doc.FadeOutTime);
  if (fadeIn !== undefined || fadeOut !== undefined) {
    r.info('live2d-fade-ignored', `fade times (${[fadeIn !== undefined ? `FadeInTime ${fmt(fadeIn)} s` : '', fadeOut !== undefined ? `FadeOutTime ${fmt(fadeOut)} s` : ''].filter(Boolean).join(', ')}) are not imported: Rev2D animations have no fades`, 'FadeInTime');
  }
  r.count('tracks', tracks.length);
  const animation: Json = {
    id: animationId,
    duration: 1,
    loop: false,
    tracks,
    description: `${IMPORTED_EXPRESSION}. Layer it additively on top of a motion: --anim <motion> --anim "${animationId},add" (keys are absolute; mode add applies value - default).`,
  };
  return { animation, report: r.report('live2d-exp3', 'import') };
}
