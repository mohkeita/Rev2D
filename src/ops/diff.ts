/**
 * Change descriptions for op messages: only what actually changed, before → after. Values too long
 * to show whole are summarized: objects by their changed fields ("shape.rx 40 → 20"), arrays by
 * what changed in them ("tracks: 1 of 13 changed (param:BodyY, 21 keys)").
 */
import { canonicalTarget } from './model.js';
import { isObject, jsonEqual, show } from './util.js';

/** Longest value shown whole in a change line (longer ones are summarized). */
const SHOW_MAX = 60;
/** Most change lines one field expands into (the rest are counted). */
const MAX_LINES = 8;
/** Most element labels listed in an array summary. */
const MAX_LABELS = 4;

function fits(v: unknown): boolean {
  return show(v, SHOW_MAX + 1).length <= SHOW_MAX;
}

/**
 * Lines describing how the value at `path` changed; empty when it did not. `before`/`after` are
 * `undefined` for an unset field.
 */
export function changeLines(path: string, before: unknown, after: unknown): string[] {
  if (jsonEqual(before, after)) return [];
  if (after === undefined) return [`${path} deleted (was ${brief(before)})`];
  if (before === undefined) return [`${path} (unset) → ${brief(after)}`];
  if (fits(before) && fits(after)) return [`${path} ${show(before)} → ${show(after)}`];
  if (isObject(before) && isObject(after)) {
    const keys = [...Object.keys(after), ...Object.keys(before).filter((k) => !Object.hasOwn(after, k))];
    const lines = keys.flatMap((k) => changeLines(`${path}.${k}`, before[k], after[k]));
    if (lines.length <= MAX_LINES) return lines;
    return [...lines.slice(0, MAX_LINES), `(+${lines.length - MAX_LINES} more changes in ${path})`];
  }
  if (Array.isArray(before) && Array.isArray(after)) return [`${path}: ${arrayChange(before, after)}`];
  return [`${path} ${show(before)} → ${show(after)}`];
}

/** A value for "(unset) → x" / "deleted (was x)": whole when short, else a summary. */
function brief(v: unknown): string {
  if (fits(v)) return show(v);
  if (Array.isArray(v)) return `${v.length} item${v.length === 1 ? '' : 's'}${v.length ? ` (${labels(v.map((x, i) => elementLabel(x, i)))})` : ''}`;
  if (isObject(v)) return `{${Object.keys(v).join(', ')}}`;
  return show(v, SHOW_MAX);
}

/** Identity of an array element for matching before/after: id, then target address, else none. */
function identity(v: unknown): string | undefined {
  if (!isObject(v)) return undefined;
  if (typeof v.id === 'string') return v.id;
  if (typeof v.target === 'string') return canonicalTarget(v.target);
  return undefined;
}

/** "param:BodyY, 21 keys" / "walk" / "#3". */
function elementLabel(v: unknown, index: number): string {
  const id = identity(v);
  const head = id ?? `#${index}`;
  if (isObject(v) && Array.isArray(v.keys)) return `${head}, ${v.keys.length} key${v.keys.length === 1 ? '' : 's'}`;
  return head;
}

function labels(list: string[]): string {
  const shown = list.slice(0, MAX_LABELS).join('; ');
  return list.length > MAX_LABELS ? `${shown}; +${list.length - MAX_LABELS} more` : shown;
}

/** Summary of how an array changed, e.g. "1 of 13 changed (param:BodyY, 21 keys)". */
function arrayChange(before: unknown[], after: unknown[]): string {
  const keyed = [...before, ...after].every((v) => identity(v) !== undefined);
  if (keyed) {
    const old = new Map(before.map((v) => [identity(v)!, v]));
    const now = new Set(after.map((v) => identity(v)!));
    const changed: string[] = [];
    const added: string[] = [];
    after.forEach((v, i) => {
      const id = identity(v)!;
      if (!old.has(id)) added.push(elementLabel(v, i));
      else if (!jsonEqual(old.get(id), v)) changed.push(elementLabel(v, i));
    });
    const removed = before.flatMap((v, i) => (now.has(identity(v)!) ? [] : [elementLabel(v, i)]));
    const parts: string[] = [];
    if (changed.length) parts.push(`${changed.length} of ${after.length} changed (${labels(changed)})`);
    if (added.length) parts.push(`${added.length} added (${labels(added)})`);
    if (removed.length) parts.push(`${removed.length} removed (${labels(removed)})`);
    const order = !parts.length ? 'same items, new order' : '';
    return parts.length ? parts.join(' + ') : order;
  }
  if (before.length !== after.length) return `${before.length} → ${after.length} items`;
  const diff = after.flatMap((v, i) => (jsonEqual(before[i], v) ? [] : [i]));
  const numeric = after.every((v) => typeof v === 'number');
  const noun = numeric ? 'values' : 'items';
  const where = diff.length > 8 ? `${diff.slice(0, 8).join(', ')}, …` : diff.join(', ');
  return `${diff.length} of ${after.length} ${noun} changed (index${diff.length === 1 ? '' : 'es'} ${where})`;
}
