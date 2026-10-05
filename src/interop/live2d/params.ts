/**
 * Parameter id mapping between Rev2D and Live2D Cubism, and the Live2D standard parameter table
 * (ids, ranges and defaults from the Cubism Editor manual, "Standard Parameter List").
 *
 * Rev2D examples name parameters like Live2D's standard parameters without the "Param" prefix
 * (AngleX <-> ParamAngleX); the one exception is MouthOpen <-> ParamMouthOpenY. Ids a map does not
 * list pass through unchanged in both directions.
 */
import type { ParamMap } from '../types.js';
import { didYouMean, fmt, isObject, type ModelInfo, type ParamInfo, parseJsonInput, q, type Reporter } from './util.js';

/** Live2D standard parameters: id -> [min, default, max, display name]; default null = model specific. */
export const LIVE2D_STANDARD_PARAMS: Readonly<Record<string, { min: number; default: number | null; max: number; name: string }>> = Object.freeze(
  Object.fromEntries(
    (
      [
        ['ParamAngleX', -30, 0, 30, 'Angle X'],
        ['ParamAngleY', -30, 0, 30, 'Angle Y'],
        ['ParamAngleZ', -30, 0, 30, 'Angle Z'],
        ['ParamEyeLOpen', 0, 1, 1, 'Left eye Open/Close'],
        ['ParamEyeLSmile', 0, 0, 1, 'Left eye Smiling'],
        ['ParamEyeROpen', 0, 1, 1, 'Right eye Open/Close'],
        ['ParamEyeRSmile', 0, 0, 1, 'Right eye Smiling'],
        ['ParamEyeBallX', -1, 0, 1, 'Eyeball X'],
        ['ParamEyeBallY', -1, 0, 1, 'Eyeball Y'],
        ['ParamEyeBallForm', -1, 0, 1, 'Eyeball scaling'],
        ['ParamBrowLY', -1, 0, 1, 'Left eyebrow Up/Down'],
        ['ParamBrowRY', -1, 0, 1, 'Right eyebrow Up/Down'],
        ['ParamBrowLX', -1, 0, 1, 'Left eyebrow Left/Right'],
        ['ParamBrowRX', -1, 0, 1, 'Right eyebrow Left/Right'],
        ['ParamBrowLAngle', -1, 0, 1, 'Left eyebrow Angle'],
        ['ParamBrowRAngle', -1, 0, 1, 'Right eyebrow Angle'],
        ['ParamBrowLForm', -1, 0, 1, 'Left eyebrow Deformation'],
        ['ParamBrowRForm', -1, 0, 1, 'Right eyebrow Deformation'],
        ['ParamMouthForm', -1, 0, 1, 'Mouth Deformation'],
        ['ParamMouthOpenY', 0, 0, 1, 'Mouth Open/Close'],
        ['ParamCheek', 0, null, 1, 'Cheek'],
        ['ParamBodyAngleX', -10, 0, 10, 'Body rotation X'],
        ['ParamBodyAngleY', -10, 0, 10, 'Body rotation Y'],
        ['ParamBodyAngleZ', -10, 0, 10, 'Body rotation Z'],
        ['ParamBreath', 0, 0, 1, 'Breath'],
        ['ParamArmLA', -30, 0, 30, 'Left arm A'],
        ['ParamArmRA', -30, 0, 30, 'Right arm A'],
        ['ParamArmLB', -30, 0, 30, 'Left arm B'],
        ['ParamArmRB', -30, 0, 30, 'Right arm B'],
        ['ParamHandL', -10, 0, 10, 'Left hand'],
        ['ParamHandR', -10, 0, 10, 'Right hand'],
        ['ParamHairFront', -1, 0, 1, 'Hair sway Front'],
        ['ParamHairSide', -1, 0, 1, 'Hair sway Sideways'],
        ['ParamHairBack', -1, 0, 1, 'Hair sway Back'],
        ['ParamHairFluffy', -1, 0, 1, 'Hair sway Fluffy'],
        ['ParamShoulderY', -10, 0, 10, 'Shrug'],
        ['ParamBustX', -1, 0, 1, 'Breast physics X'],
        ['ParamBustY', -1, 0, 1, 'Breast physics Y'],
        ['ParamBaseX', -10, 0, 10, 'Overall Left/right'],
        ['ParamBaseY', -10, 0, 10, 'Overall Up/down'],
      ] as Array<[string, number, number | null, number, string]>
    ).map(([id, min, def, max, name]) => [id, Object.freeze({ min, default: def, max, name })]),
  ),
);

function freezeMap(toLive2d: Record<string, string>): ParamMap {
  const fromLive2d: Record<string, string> = {};
  for (const [rev, l2d] of Object.entries(toLive2d)) fromLive2d[l2d] = rev;
  return Object.freeze({ toLive2d: Object.freeze({ ...toLive2d }), fromLive2d: Object.freeze(fromLive2d) }) as ParamMap;
}

/**
 * Standard preset: the Rev2D example ids <-> Live2D standard ids (AngleX <-> ParamAngleX,
 * EyeLOpen <-> ParamEyeLOpen, MouthOpen <-> ParamMouthOpenY, ...). Unmapped ids pass through.
 */
export const STANDARD_PARAM_MAP: ParamMap = freezeMap(
  Object.fromEntries(
    Object.keys(LIVE2D_STANDARD_PARAMS).map((l2d) => [l2d === 'ParamMouthOpenY' ? 'MouthOpen' : l2d.slice('Param'.length), l2d]),
  ),
);

/** Every id passes through unchanged (for Rev2D models that already use Live2D ids). */
export const IDENTITY_PARAM_MAP: ParamMap = freezeMap({});

/**
 * A map from a user mapping file `{"AngleX": "ParamAngleX", ...}` (Rev2D id -> Live2D id), merged over
 * `base` (default: the standard preset; pass IDENTITY_PARAM_MAP for the user entries only). Throws on
 * non-string values and when two Rev2D ids map to the same Live2D id.
 */
export function paramMapFromJson(json: string | Record<string, unknown>, base: ParamMap = STANDARD_PARAM_MAP): ParamMap {
  const obj = parseJsonInput(json as string | Record<string, unknown>, 'parameter map');
  const user: Record<string, string> = {};
  for (const [rev, l2d] of Object.entries(obj)) {
    if (typeof l2d !== 'string' || !l2d) throw new Error(`parameter map: the value of ${q(rev)} must be a non-empty Live2D parameter id string, got ${JSON.stringify(l2d)}`);
    user[rev] = l2d;
  }
  const merged: Record<string, string> = {};
  // Base entries whose Rev2D id or Live2D id the user re-maps are dropped, so the map stays one-to-one.
  const userL2d = new Set(Object.values(user));
  for (const [rev, l2d] of Object.entries(base.toLive2d)) if (!(rev in user) && !userL2d.has(l2d)) merged[rev] = l2d;
  const seen = new Map<string, string>();
  for (const [rev, l2d] of Object.entries(user)) {
    const other = seen.get(l2d);
    if (other !== undefined) throw new Error(`parameter map: ${q(other)} and ${q(rev)} both map to the Live2D id ${q(l2d)} (the mapping must be one-to-one)`);
    seen.set(l2d, rev);
    merged[rev] = l2d;
  }
  return freezeMap(merged);
}

/**
 * The "prefix" strategy: Live2D id = prefix + Rev2D id for every id in `ids` (e.g. the model's
 * parameters), on top of `base` (default: identity). `prefixParamMap(["Blush"])` maps Blush <-> ParamBlush.
 */
export function prefixParamMap(ids: Iterable<string>, prefix = 'Param', base: ParamMap = IDENTITY_PARAM_MAP): ParamMap {
  const out: Record<string, string> = { ...base.toLive2d };
  const taken = new Set(Object.values(out));
  for (const id of ids) {
    if (id in out) continue;
    const l2d = id.startsWith(prefix) ? id : prefix + id;
    if (taken.has(l2d)) continue;
    out[id] = l2d;
    taken.add(l2d);
  }
  return freezeMap(out);
}

export function toLive2dId(id: string, map: ParamMap): string {
  return Object.hasOwn(map.toLive2d, id) ? map.toLive2d[id] : id;
}

export function fromLive2dId(id: string, map: ParamMap): string {
  return Object.hasOwn(map.fromLive2d, id) ? map.fromLive2d[id] : id;
}

export function isParamMap(v: unknown): v is ParamMap {
  return isObject(v) && isObject(v.toLive2d) && isObject(v.fromLive2d);
}

/**
 * `legacy`: set when the id was resolved through its Cubism 3 form (a Cubism 2 id such as
 * PARAM_ANGLE_X read as ParamAngleX); report those with LegacyIds.
 */
export type ParamResolution = { ok: true; param: ParamInfo | undefined; id: string; legacy?: string } | { ok: false; id: string; hint?: string };

const LEGACY_ID = /^PARAM(?:_[A-Za-z0-9]+)+$/;

/**
 * The Cubism 3 form of a Cubism 2 parameter id: "PARAM_" dropped, each "_"-separated word capitalized
 * (PARAM_ANGLE_X -> ParamAngleX, PARAM_EYE_L_OPEN -> ParamEyeLOpen, PARAM_MOUTH_OPEN_Y ->
 * ParamMouthOpenY), which is how the Cubism 3 standard ids were named after the Cubism 2 ones.
 * Undefined for ids that are not in the Cubism 2 style.
 */
export function modernLive2dId(l2dId: string): string | undefined {
  if (!LEGACY_ID.test(l2dId)) return undefined;
  return `Param${l2dId
    .slice('PARAM_'.length)
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('')}`;
}

/**
 * Rev2D parameter for a Live2D id. With a target model: the mapped id, else the Live2D id itself, else
 * the id without "Param", if the model has it; then the same for the Cubism 3 form of a Cubism 2 id
 * (PARAM_ANGLE_X -> ParamAngleX -> AngleX); otherwise not found (with a did-you-mean hint).
 * Without a model: the mapped id (a Cubism 2 id whose Cubism 3 form is mapped or a standard id: that).
 */
export function resolveLive2dParam(l2dId: string, map: ParamMap, model: ModelInfo | undefined): ParamResolution {
  const mapped = fromLive2dId(l2dId, map);
  const modern = modernLive2dId(l2dId);
  const candidates = (id: string): Array<string | undefined> => [fromLive2dId(id, map), id, id.startsWith('Param') && id.length > 5 ? id.slice(5) : undefined];
  if (!model) {
    if (mapped === l2dId && modern !== undefined && (Object.hasOwn(map.fromLive2d, modern) || LIVE2D_STANDARD_PARAMS[modern])) {
      return { ok: true, param: undefined, id: fromLive2dId(modern, map), legacy: modern };
    }
    return { ok: true, param: undefined, id: mapped };
  }
  for (const candidate of candidates(l2dId)) {
    if (candidate !== undefined && model.params.has(candidate)) return { ok: true, param: model.params.get(candidate), id: candidate };
  }
  if (modern !== undefined) {
    for (const candidate of candidates(modern)) {
      if (candidate !== undefined && model.params.has(candidate)) return { ok: true, param: model.params.get(candidate), id: candidate, legacy: modern };
    }
  }
  const hint = [...candidates(l2dId), ...(modern !== undefined ? candidates(modern) : [])].reduce<string | undefined>(
    (h, c) => h ?? (c !== undefined ? didYouMean(c, model.paramIds) : undefined),
    undefined,
  );
  return { ok: false, id: mapped, ...(hint ? { hint } : {}) };
}

/**
 * Collects Cubism 2 style ids (PARAM_ANGLE_X) that were resolved through their Cubism 3 form, and
 * reports them as ONE info per file.
 */
export class LegacyIds {
  private readonly items = new Map<string, { modern: string; rev: string }>();

  add(res: ParamResolution, l2dId: string): void {
    if (res.ok && res.legacy !== undefined && !this.items.has(l2dId)) this.items.set(l2dId, { modern: res.legacy, rev: res.id });
  }

  report(r: Reporter, where: string): void {
    if (!this.items.size) return;
    const list = [...this.items].map(([l2d, e]) => `${l2d} -> ${e.modern}${e.rev !== e.modern ? ` (${e.rev})` : ''}`);
    r.info(
      'live2d-legacy-id',
      `${list.length} Cubism 2 parameter id(s) read by their Cubism 3 names: ${list.length > 12 ? `${list.slice(0, 12).join(', ')}, ...` : list.join(', ')}`,
      where,
      'Cubism 3 renamed the standard parameters (PARAM_ANGLE_X -> ParamAngleX); map other ids with a parameter map',
    );
  }
}

/**
 * Warn once per parameter when a Rev2D parameter mapped to a Live2D standard id has a different range
 * or default: values are copied as they are, not rescaled.
 */
export function checkStandardRange(param: ParamInfo, l2dId: string, r: Reporter, checked: Set<string>, where?: string): void {
  const std = LIVE2D_STANDARD_PARAMS[l2dId];
  if (!std || checked.has(param.id)) return;
  checked.add(param.id);
  const rangeDiffers = Math.abs(param.min - std.min) > 1e-9 || Math.abs(param.max - std.max) > 1e-9;
  const defaultDiffers = std.default !== null && Math.abs(param.default - std.default) > 1e-9;
  if (!rangeDiffers && !defaultDiffers) return;
  const stdText = `[${fmt(std.min)}, ${fmt(std.max)}]${std.default !== null ? ` default ${fmt(std.default)}` : ''}`;
  r.warn(
    'live2d-param-range-mismatch',
    `Rev2D parameter ${q(param.id)} [${fmt(param.min)}, ${fmt(param.max)}] default ${fmt(param.default)} differs from the Live2D standard ${q(l2dId)} ${stdText}`,
    where,
    'values are copied unchanged (not rescaled), so motions made for the standard range may overshoot (clamped) or under-use this parameter; match the parameter range to the standard or rescale the curves',
  );
}

/**
 * Collects Live2D parameter ids the target model lacks and reports them as ONE warning per file
 * (ids, mapped names, locations and did-you-mean hints), instead of one warning per curve.
 */
export class UnknownParams {
  private readonly items = new Map<string, { mapped: string; at: string[]; hint?: string }>();

  add(l2dId: string, mapped: string, where: string, hint?: string): void {
    const item = this.items.get(l2dId) ?? { mapped, at: [], ...(hint ? { hint } : {}) };
    item.at.push(where);
    this.items.set(l2dId, item);
  }

  get size(): number {
    return this.items.size;
  }

  report(r: Reporter, what: string): void {
    if (!this.items.size) return;
    const entries = [...this.items];
    const count = entries.reduce((n, [, e]) => n + e.at.length, 0);
    const ids = entries.map(([id, e]) => (e.mapped !== id ? `${id} (as ${e.mapped})` : id)).join(', ');
    const hints = entries.filter(([, e]) => e.hint).map(([id, e]) => `${id}: ${e.hint}`);
    r.warn(
      'live2d-unknown-parameter',
      `${count} ${what} for ${entries.length} parameter(s) the target model does not have were dropped: ${ids}`,
      compactLocations(entries.flatMap(([, e]) => e.at)),
      `${hints.length ? `${hints.join('; ')}. ` : ''}Add these parameters to the model, or map them to existing ones with a parameter map ({"<Rev2D id>": "<Live2D id>"})`,
    );
  }
}

/**
 * Compact location list: locations that differ only in their last index are merged, with runs as
 * ranges ("Curves[3]", "Curves[4]", "Curves[5]", "Curves[9]" -> "Curves[3-5, 9]").
 */
export function compactLocations(locs: string[]): string {
  const groups = new Map<string, number[]>();
  const plain: string[] = [];
  for (const l of locs) {
    const m = /^(.*)\[(\d+)\]$/.exec(l);
    if (!m) {
      if (!plain.includes(l)) plain.push(l);
      continue;
    }
    const list = groups.get(m[1]) ?? [];
    list.push(Number(m[2]));
    groups.set(m[1], list);
  }
  const out = [...groups].map(([prefix, nums]) => {
    const sorted = [...new Set(nums)].sort((a, b) => a - b);
    const runs: string[] = [];
    for (let i = 0; i < sorted.length; ) {
      let j = i;
      while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
      runs.push(j - i >= 2 ? `${sorted[i]}-${sorted[j]}` : sorted.slice(i, j + 1).join(', '));
      i = j + 1;
    }
    return `${prefix}[${runs.join(', ')}]`;
  });
  return [...out, ...plain].join(', ');
}
