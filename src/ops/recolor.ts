/**
 * recolor: change the colours of a set of parts in one op, either by an exact colour map
 * ({"#old": "#new"}, alpha kept) or by an HSL shift ({"h": deg, "s": delta, "l": delta}).
 *
 * Applies to written colours only: solid fills (string or {"type": "solid"}), gradient stops,
 * stroke colours and, with "include": ["tint"], tints. Binding keyforms and animation keys on the
 * recoloured properties (part:<id>.fill, .stroke.color, .tint) get the same change, because their
 * values are absolute colours: recolouring only the setup value would not show while they exist.
 */
import { didYouMean, formatList, referenceHint } from '../core/validate/text.js';
import { clamp01, formatColor, parseColor } from '../core/color.js';
import type { RGBA } from '../core/types.js';
import type { OpContext } from './context.js';
import { canonicalTarget, type Doc, idsOf, type Item, requireItem, sectionItems } from './model.js';
import { choiceHint, describe, fieldHint, type Fields, isObject, OpError, q } from './util.js';

const INCLUDE = ['tint'] as const;
const HSL_FIELDS = ['h', 's', 'l'] as const;

/** One colour change: the new value, or undefined when the colour stays the same (or is not a colour). */
type Recolor = (value: string) => string | undefined;

export function opRecolor(ctx: OpContext, f: Fields): string {
  const { doc } = ctx;
  const parts = selectParts(doc, f);
  const include = readInclude(f);
  const { recolor, unmatched } = readTransform(f);

  /** Per part: what was recoloured, e.g. {"fill": 1, "gradient stop": 3}. */
  const counts = new Map<string, Map<string, number>>(parts.map((p) => [String(p.id), new Map()]));
  const found = new Map<string, string[]>(); // colour -> where (for the no-change hint)
  const note = (part: string, what: string) => {
    const m = counts.get(part)!;
    m.set(what, (m.get(what) ?? 0) + 1);
  };
  const visit = (part: string, what: string, value: unknown, write: (v: string) => void) => {
    if (typeof value !== 'string') return;
    const c = parseColor(value);
    if (!c) return;
    const hex = formatColor(c);
    if (!found.has(hex)) found.set(hex, []);
    found.get(hex)!.push(`${part} ${what}`);
    const next = recolor(value);
    if (next === undefined) return;
    write(next);
    note(part, what);
  };

  const targets = new Map<string, { part: string }>();
  for (const p of parts) {
    const id = String(p.id);
    const fill = p.fill;
    if (typeof fill === 'string') visit(id, 'fill', fill, (v) => (p.fill = v));
    else if (isObject(fill) && fill.type === 'solid') visit(id, 'fill', fill.color, (v) => (fill.color = v));
    else if (isObject(fill) && Array.isArray(fill.stops)) {
      for (const stop of fill.stops) if (Array.isArray(stop)) visit(id, 'gradient stop', stop[1], (v) => (stop[1] = v));
    }
    if (isObject(p.stroke)) {
      const stroke = p.stroke;
      visit(id, 'stroke', stroke.color, (v) => (stroke.color = v));
    }
    if (include.has('tint')) visit(id, 'tint', p.tint, (v) => (p.tint = v));
    for (const prop of ['fill', 'stroke.color', ...(include.has('tint') ? ['tint'] : [])]) targets.set(`part:${id}.${prop}`, { part: id });
  }

  for (const b of sectionItems(doc, 'binding') ?? []) {
    const hit = isObject(b) ? targets.get(canonicalTarget(b.target) ?? '') : undefined;
    if (!hit || !Array.isArray(b.keys)) continue;
    for (const k of b.keys) if (isObject(k)) visit(hit.part, 'binding keyform', k.value, (v) => (k.value = v));
  }
  for (const a of sectionItems(doc, 'animation') ?? []) {
    if (!isObject(a) || !Array.isArray(a.tracks)) continue;
    for (const t of a.tracks) {
      const hit = isObject(t) ? targets.get(canonicalTarget(t.target) ?? '') : undefined;
      if (!hit || !Array.isArray(t.keys)) continue;
      for (const k of t.keys) if (isObject(k)) visit(hit.part, 'animation key', k.v, (v) => (k.v = v));
    }
  }

  const changed = [...counts].filter(([, m]) => m.size > 0);
  const total = changed.reduce((n, [, m]) => n + [...m.values()].reduce((a, b) => a + b, 0), 0);
  const noMatch = unmatched();
  if (total === 0) {
    const colours = [...found].map(([hex, where]) => `${hex} (${formatList(where, 3)})`);
    const why = f.has('hsl') && [...found.keys()].every(isGrey) && !hasSL(f) ? '; greys, white and black have no hue, so an "h" shift leaves them unchanged (use "l" / "s", or "map")' : '';
    throw new OpError(
      `recolor: no colour changed in the ${parts.length} selected part${parts.length === 1 ? '' : 's'}`,
      colours.length ? `colours there: ${formatList(colours, 12)}${why}` : 'the selected parts have no written fill, stroke or tint colours (an unset fill is the default white; set one first)',
    );
  }
  const perPart = changed.map(([id, m]) => `${id} (${[...m].map(([what, n]) => (n === 1 ? what : `${n} ${plural(what)}`)).join(', ')})`);
  const same = [...counts].filter(([, m]) => m.size === 0).map(([id]) => id);
  return [
    `recolored ${total} colour${total === 1 ? '' : 's'} in ${changed.length} of ${parts.length} part${parts.length === 1 ? '' : 's'}: ${perPart.join(', ')}`,
    same.length ? `; unchanged: ${formatList(same, 12)}` : '',
    noMatch.length ? `; map entries that matched nothing: ${noMatch.map((k) => q(k)).join(', ')}` : '',
  ].join('');
}

function plural(what: string): string {
  return what.endsWith('y') ? `${what.slice(0, -1)}ies` : `${what}s`;
}

function isGrey(hex: string): boolean {
  const c = parseColor(hex)!;
  return Math.abs(c[0] - c[1]) < 1e-9 && Math.abs(c[1] - c[2]) < 1e-9;
}

function hasSL(f: Fields): boolean {
  const hsl = f.raw('hsl');
  return isObject(hsl) && ((typeof hsl.s === 'number' && hsl.s !== 0) || (typeof hsl.l === 'number' && hsl.l !== 0));
}

// ----------------------------------------------------------------------------- fields

function selectParts(doc: Doc, f: Fields): Item[] {
  const given = (['parts', 'tag', 'all'] as const).filter((k) => f.has(k));
  if (given.length !== 1) {
    throw new OpError(
      given.length ? `recolor: give only one of "parts", "tag", "all" (got ${given.join(', ')})` : 'recolor needs one of "parts", "tag", "all" (which parts to recolour)',
      'e.g. "parts": ["hairFront", "hairBack"], "tag": "hair" or "all": true',
    );
  }
  const all = (sectionItems(doc, 'part') ?? []).filter((p): p is Item => isObject(p) && typeof p.id === 'string');
  if (given[0] === 'all') {
    if (f.optBoolean('all', 'every part') !== true) throw new OpError('recolor: "all" must be true (or select parts with "parts" / "tag")');
    if (!all.length) throw new OpError('recolor: the model has no parts');
    return all;
  }
  if (given[0] === 'tag') {
    const tag = f.string('tag', 'a tag of the parts to recolour');
    const tagged = all.filter((p) => Array.isArray(p.tags) && p.tags.includes(tag));
    if (tagged.length) return tagged;
    const tags = [...new Set(all.flatMap((p) => (Array.isArray(p.tags) ? p.tags.filter((t): t is string => typeof t === 'string') : [])))];
    throw new OpError(`recolor: no part has the tag ${q(tag)}`, tags.length ? referenceHint(tag, tags, 'tags') : 'no part has "tags"; select parts with "parts": [ids] instead');
  }
  const ids = f.raw('parts');
  const list = typeof ids === 'string' ? [ids] : ids;
  if (!Array.isArray(list) || !list.length || list.some((id) => typeof id !== 'string')) {
    throw new OpError(`recolor: "parts" must be a non-empty list of part ids, got ${describe(ids)}`, `e.g. "parts": [${idsOf(doc, 'part').slice(0, 2).map(q).join(', ')}]`);
  }
  return [...new Set(list as string[])].map((id) => requireItem(doc, 'part', id).item);
}

function readInclude(f: Fields): Set<string> {
  if (!f.has('include')) return new Set();
  const v = f.raw('include');
  const list = typeof v === 'string' ? [v] : v;
  if (!Array.isArray(list) || list.some((x) => typeof x !== 'string')) throw new OpError(`recolor: "include" must be a list, got ${describe(v)}`, 'e.g. "include": ["tint"]');
  for (const x of list as string[]) {
    if (!(INCLUDE as readonly string[]).includes(x)) {
      const extra = x === 'fill' || x === 'stroke' ? ' (fills and strokes are always recoloured)' : '';
      throw new OpError(`recolor: unknown "include" entry ${q(x)}${extra}`, choiceHint(x, INCLUDE, 'valid "include" entries'));
    }
  }
  return new Set(list as string[]);
}

function readTransform(f: Fields): { recolor: Recolor; unmatched: () => string[] } {
  const given = (['map', 'hsl'] as const).filter((k) => f.has(k));
  if (given.length !== 1) {
    throw new OpError(
      given.length ? 'recolor: give either "map" or "hsl", not both (use two recolor ops to do both)' : 'recolor needs "map" (exact colour replacements) or "hsl" (a shift)',
      'e.g. "map": {"#ffcc99": "#e8b890"} or "hsl": {"h": 30, "s": -0.1, "l": 0.05}',
    );
  }
  return given[0] === 'map' ? readMap(f) : { recolor: readHsl(f), unmatched: () => [] };
}

/** 8-bit colour string for matching: "#rrggbb", or "#rrggbbaa" when `withAlpha`. */
function key(c: RGBA, withAlpha: boolean): string {
  const [r, g, b, a] = c.map((v) => Math.round(clamp01(v) * 255));
  const hex = (v: number) => v.toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}${withAlpha ? hex(a) : ''}`;
}

/** Does the colour string spell out an alpha ("#rgba", "#rrggbbaa", "rgba(r, g, b, a)", "transparent")? */
function explicitAlpha(s: string): boolean {
  const t = s.trim().toLowerCase();
  if (t === 'transparent') return true;
  if (t.startsWith('#')) return t.length === 5 || t.length === 9;
  const m = /^rgba?\(([^)]*)\)$/.exec(t);
  return !!m && m[1].split(/[\s,/]+/).filter(Boolean).length === 4;
}

function readMap(f: Fields): { recolor: Recolor; unmatched: () => string[] } {
  const map = f.object('map', '{"#old": "#new"}');
  const entries = Object.entries(map);
  if (!entries.length) throw new OpError('recolor: "map" is empty', 'e.g. "map": {"#ffcc99": "#e8b890"}');
  const rules: Array<{ from: string; match: string; alpha: boolean; to: RGBA }> = [];
  for (const [from, to] of entries) {
    const c = parseColor(from);
    if (!c) throw new OpError(`recolor: map key ${q(from)} is not a colour`, 'keys and values are colours like "#rrggbb", "#rgb", "rgb(r,g,b)" or basic names ("white")');
    if (typeof to !== 'string' || !parseColor(to)) throw new OpError(`recolor: map value for ${q(from)} must be a colour string, got ${describe(to)}`, 'e.g. "#e8b890"');
    const n = parseColor(to)!;
    if (n[3] < 0.999) {
      throw new OpError(`recolor: map value ${q(to)} has an alpha channel; recolor keeps each colour's own alpha`, 'give an opaque colour ("#rrggbb"); change transparency with part opacity or tint instead');
    }
    const alpha = explicitAlpha(from);
    const match = key(c, alpha);
    const dup = rules.find((r) => r.match === match && r.alpha === alpha);
    if (dup) throw new OpError(`recolor: map keys ${q(dup.from)} and ${q(from)} are the same colour (${match})`, 'list each colour once');
    rules.push({ from, match, alpha, to: n });
  }
  const used = new Set<string>();
  const recolor: Recolor = (value) => {
    const c = parseColor(value);
    if (!c) return undefined;
    // A key with an explicit alpha only matches that alpha; others match the RGB of any alpha.
    const rule = rules.find((r) => r.alpha && r.match === key(c, true)) ?? rules.find((r) => !r.alpha && r.match === key(c, false));
    if (!rule) return undefined;
    used.add(rule.from);
    const next = formatColor([rule.to[0], rule.to[1], rule.to[2], c[3]]);
    return next === formatColor(c) ? undefined : next;
  };
  return { recolor, unmatched: () => rules.filter((r) => !used.has(r.from)).map((r) => r.from) };
}

function readHsl(f: Fields): Recolor {
  const hsl = f.object('hsl', '{"h"?: degrees, "s"?: delta, "l"?: delta}');
  for (const k of Object.keys(hsl)) {
    if ((HSL_FIELDS as readonly string[]).includes(k)) continue;
    const long = didYouMean(k, ['hue', 'saturation', 'lightness']);
    const short = /hue/i.test(k) ? 'h' : /sat/i.test(k) ? 's' : /light|lum/i.test(k) ? 'l' : undefined;
    throw new OpError(`recolor: unknown hsl field ${q(k)}`, long || short ? `did you mean ${q(short ?? k.slice(0, 1).toLowerCase())}? (hsl fields: h, s, l)` : fieldHint(k, HSL_FIELDS, 'hsl fields'));
  }
  const read = (k: 'h' | 's' | 'l'): number => {
    const v = hsl[k];
    if (v === undefined) return 0;
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new OpError(`recolor: hsl.${k} must be a number, got ${describe(v)}`);
    if (k !== 'h' && Math.abs(v) > 1) {
      throw new OpError(`recolor: hsl.${k} must be between -1 and 1, got ${v}`, `"${k}" is a delta in 0..1 units (${k === 's' ? 'saturation' : 'lightness'}): -0.2 = 20 percentage points less, e.g. "${k}": ${v / 100}`);
    }
    return v;
  };
  const dh = read('h');
  const ds = read('s');
  const dl = read('l');
  if (dh === 0 && ds === 0 && dl === 0) throw new OpError('recolor: "hsl" changes nothing (h, s and l are all 0 or missing)', 'e.g. "hsl": {"h": 30} (hue +30°), {"s": -0.2} (less saturated), {"l": 0.1} (lighter)');
  return (value) => {
    const c = parseColor(value);
    if (!c) return undefined;
    const [h, s, l] = rgbToHsl(c);
    const [r, g, b] = hslToRgb((((h + dh) % 360) + 360) % 360, clamp01(s + ds), clamp01(l + dl));
    const next = formatColor([r, g, b, c[3]]);
    return next === formatColor(c) ? undefined : next;
  };
}

// ----------------------------------------------------------------------------- HSL

/** RGB 0..1 -> [hue 0..360, saturation 0..1, lightness 0..1]. */
export function rgbToHsl([r, g, b]: RGBA | [number, number, number]): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d < 1e-12) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

/** [hue 0..360, saturation 0..1, lightness 0..1] -> RGB 0..1. */
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l];
  const q2 = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q2;
  const channel = (t: number) => {
    const u = ((t % 1) + 1) % 1;
    if (u < 1 / 6) return p + (q2 - p) * 6 * u;
    if (u < 1 / 2) return q2;
    if (u < 2 / 3) return p + (q2 - p) * (2 / 3 - u) * 6;
    return p;
  };
  const x = h / 360;
  return [channel(x + 1 / 3), channel(x), channel(x - 1 / 3)];
}
