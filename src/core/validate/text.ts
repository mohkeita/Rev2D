/**
 * Wording helpers for diagnostics: quoting, option lists, did-you-mean (with synonyms AI authors
 * commonly reach for) and compact JSON examples.
 */

/** JSON-style quoting ("head"), so messages can be pasted back into a model file. */
export function q(s: string): string {
  return JSON.stringify(s);
}

/** "a, b, c" capped at `max` entries ("…, +4 more"). */
export function formatList(items: readonly string[], max = 12): string {
  if (items.length <= max) return items.join(', ');
  return `${items.slice(0, max).join(', ')}, … (+${items.length - max} more)`;
}

/** Same as formatList but quotes every shown entry. */
export function formatQuotedList(items: readonly string[], max = 12): string {
  const shown = items.slice(0, max).map(q).join(', ');
  return items.length <= max ? shown : `${shown}, … (+${items.length - max} more)`;
}

/**
 * Words AI authors use for concepts that have a different name in Rev2D (keys are normalized:
 * lowercase, no separators). Only applied when the mapped value is one of the valid options.
 */
const SYNONYMS: Record<string, string> = {
  circle: 'ellipse',
  oval: 'ellipse',
  rectangle: 'rect',
  square: 'rect',
  box: 'rect',
  roundrect: 'rect',
  poly: 'polygon',
  triangle: 'polygon',
  svg: 'path',
  svgpath: 'path',
  bezier: 'path',
  curve: 'path',
  sprite: 'image',
  bitmap: 'image',
  picture: 'image',
  img: 'image',
  texture: 'image',
  gradient: 'linear',
  lineargradient: 'linear',
  radialgradient: 'radial',
  ease: 'inOutSine',
  easein: 'inSine',
  easeout: 'outSine',
  easeinout: 'inOutSine',
  hold: 'step',
  constant: 'step',
  catmullrom: 'smooth',
  catmull: 'smooth',
  spline: 'smooth',
  autotangent: 'smooth',
  additive: 'add',
  multiplicative: 'multiply',
};

function normalizeWord(s: string): string {
  return s.toLowerCase().replace(/[-_\s]/g, '');
}

/** "in-out-cubic" / "InOutCubic" -> "inOutCubic". */
function camel(s: string): string {
  const parts = s.split(/[-_\s]+/).filter(Boolean);
  return parts
    .map((p, i) => (i === 0 ? p[0].toLowerCase() + p.slice(1) : p[0].toUpperCase() + p.slice(1)))
    .join('');
}

// Reused DP rows for boundedDistance (grown on demand).
let rowPrev = new Int32Array(64);
let rowCur = new Int32Array(64);

/**
 * Edit distance of `a` and `b` if it is at most `limit`, else Infinity. Only the diagonal band
 * |i - j| <= limit is computed (Ukkonen), so did-you-mean stays cheap across thousands of ids.
 */
function boundedDistance(a: string, b: string, limit: number): number {
  const n = a.length;
  const m = b.length;
  if (Math.abs(n - m) > limit) return Infinity;
  // Each input code unit absent from the candidate needs a deletion or substitution.
  // This cheap lower bound rejects unrelated ids before filling the DP band.
  let absent = 0;
  for (let i = 0; i < n; i++) {
    if (!b.includes(a[i]) && ++absent > limit) return Infinity;
  }
  if (rowPrev.length < m + 2) {
    rowPrev = new Int32Array(2 * (m + 2));
    rowCur = new Int32Array(2 * (m + 2));
  }
  const out = limit + 1; // stands for "more than limit"; also fills cells outside the band
  let prev = rowPrev;
  let cur = rowCur;
  for (let j = 0; j <= m + 1; j++) prev[j] = Math.min(j, out);
  for (let i = 1; i <= n; i++) {
    const lo = Math.max(1, i - limit);
    const hi = Math.min(m, i + limit);
    cur[lo - 1] = lo === 1 ? Math.min(i, out) : out;
    let rowMin = cur[lo - 1];
    const ca = a.charCodeAt(i - 1);
    for (let j = lo; j <= hi; j++) {
      let d = prev[j - 1] + (ca === b.charCodeAt(j - 1) ? 0 : 1);
      if (prev[j] + 1 < d) d = prev[j] + 1;
      if (cur[j - 1] + 1 < d) d = cur[j - 1] + 1;
      if (d > out) d = out;
      cur[j] = d;
      if (d < rowMin) rowMin = d;
    }
    cur[hi + 1] = out; // the next row reads one cell past this row's band
    if (rowMin > limit) return Infinity;
    const done = cur;
    cur = prev;
    prev = done;
  }
  return prev[m] <= limit ? prev[m] : Infinity;
}

/**
 * Closest option by (case-insensitive) edit distance, first one on ties. An option qualifies within
 * the address.ts `suggest` threshold (max(2, ⌊longest/3⌋)) unless it differs from the input in
 * every character (so "a" never becomes "ik").
 */
function closest(got: string, options: readonly string[]): string | null {
  const g = got.toLowerCase();
  let best: string | null = null;
  let bestD = Infinity;
  for (const o of options) {
    const longest = Math.max(got.length, o.length);
    const limit = Math.min(Math.max(2, Math.floor(longest / 3)), longest - 1, bestD - 1);
    if (limit < 0 || Math.abs(got.length - o.length) > limit) continue;
    const d = boundedDistance(g, o.toLowerCase(), limit);
    if (d <= limit) {
      best = o;
      bestD = d;
      if (d === 0) break;
    }
  }
  return best;
}

/** The closest valid option phrased as `did you mean "x"?`, or null when nothing is close. */
export function didYouMean(got: string, options: readonly string[]): string | null {
  const word = normalizeWord(got);
  if (Object.hasOwn(SYNONYMS, word) && options.includes(SYNONYMS[word])) return `did you mean ${q(SYNONYMS[word])}?`;
  // Penner/CSS style ease names: "easeInOutSine" / "ease-in-out-sine" -> "inOutSine".
  const ease = /^ease[-_\s]?(.+)$/i.exec(got);
  if (ease) {
    const name = camel(ease[1]);
    if (options.includes(name)) return `did you mean ${q(name)}?`;
  }
  const match = closest(got, options);
  return match === null ? null : `did you mean ${q(match)}?`;
}

/**
 * Key names AI authors use for fields Rev2D spells differently, in priority order. Edit distance
 * cannot find these ("time" is closer to "name" than to "t").
 */
const KEY_ALIASES: Record<string, readonly string[]> = {
  time: ['t'],
  value: ['v'],
  val: ['v', 'value'],
  v: ['value'],
  name: ['id'],
  easing: ['ease'],
  keyframes: ['keys'],
  frames: ['keys'],
  parameter: ['param', 'params'],
  parameters: ['params', 'param'],
  rotate: ['rotation'],
  angle: ['rotation'],
  width: ['w'],
  height: ['h'],
  color: ['fill', 'background'],
  alpha: ['opacity'],
  zindex: ['z'],
  points: ['vertices'],
  vertices: ['points'],
  indices: ['triangles'],
  path: ['d'],
  data: ['d'],
  length: ['duration'],
  bone: ['bones', 'parent'],
};

/** The allowed key that `got` is a known alias of, if any. */
export function keyAlias(got: string, allowed: readonly string[]): string | null {
  const word = normalizeWord(got);
  return Object.hasOwn(KEY_ALIASES, word) ? (KEY_ALIASES[word].find((a) => allowed.includes(a)) ?? null) : null;
}

/** The allowed key an unknown key most likely means (alias first, then edit distance), or null. */
export function suggestKey(got: string, allowed: readonly string[]): string | null {
  return keyAlias(got, allowed) ?? closest(got, allowed);
}

/** did-you-mean, falling back to the list of valid options. */
export function optionsHint(got: string, options: readonly string[], noun = 'valid'): string {
  const dym = didYouMean(got, options);
  const list = `${noun}: ${formatList([...options])}`;
  return dym ? `${dym} (${list})` : list;
}

/** Hint for an unknown id reference: did-you-mean, else the known ids of that kind. */
export function referenceHint(got: string, known: readonly string[], kindPlural: string): string {
  const dym = didYouMean(got, known);
  if (dym) return dym;
  return known.length ? `known ${kindPlural}: ${formatQuotedList(known, 10)}` : `no ${kindPlural} are defined`;
}

/** Compact single-line JSON: { "a": 1, "b": [0, 0] }. */
export function compactJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(compactJson).join(', ')}]`;
  if (v !== null && typeof v === 'object') {
    const entries = Object.entries(v);
    if (entries.length === 0) return '{}';
    return `{ ${entries.map(([k, x]) => `${q(k)}: ${compactJson(x)}`).join(', ')} }`;
  }
  return JSON.stringify(v) ?? String(v);
}

/** Short description of a JSON value for "got ..." phrases: `string "5"`, `null`, `array (3 items)`. */
export function describeJson(v: unknown): string {
  if (v === undefined) return 'nothing';
  if (v === null) return 'null';
  if (Array.isArray(v)) return `array (${v.length} item${v.length === 1 ? '' : 's'})`;
  switch (typeof v) {
    case 'string':
      return `string ${q(v.length > 40 ? v.slice(0, 40) + '…' : v)}`;
    case 'number':
    case 'boolean':
      return `${typeof v} ${String(v)}`;
    case 'object':
      return 'object';
    default:
      return typeof v;
  }
}
