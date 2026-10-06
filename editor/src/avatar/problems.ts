/**
 * Diagnostics of the avatar spec mapped onto the parts the editor lists (pure): a problem row
 * selects the part it is about.
 *
 *   itemForPath(doc, path)   the item a diagnostic's JSON pointer belongs to, or null
 *   problemsByItem(doc, diagnostics)
 */
import type { Diagnostic } from '../../../src/core/types.js';
import { avatarLandmarks, pointerSegments } from '../../../src/avatar/index.js';

function isPrefix(prefix: string[], of: string[]): boolean {
  return prefix.length <= of.length && prefix.every((s, i) => s === of[i]);
}

/**
 * The item (describeAvatarParts id) a JSON pointer of avatar.json belongs to: the landmark at or
 * above the pointer ("/face/eyes/imageLeft/opening/4" -> eyes.imageLeft.opening), else the first
 * landmark below it ("/face/eyes/imageLeft" -> eyes.imageLeft.opening), else one of the same list
 * entry ("/hair/strands/2/width" -> the strand's item). Null when nothing matches ("/name").
 */
export function itemForPath(doc: unknown, path: string): string | null {
  const segs = pointerSegments(path);
  if (segs.length === 0) return null;
  const marks = avatarLandmarks(doc).map((l) => ({ item: l.item, segs: pointerSegments(l.pointer) }));
  let best: { item: string; score: number } | null = null;
  for (const m of marks) {
    let score = -1;
    if (isPrefix(m.segs, segs)) score = 1000 + m.segs.length;
    else if (isPrefix(segs, m.segs)) score = 500 - m.segs.length;
    else if (m.segs.length >= 2 && isPrefix(m.segs.slice(0, -1), segs) && m.segs.length - 1 >= 2) score = 100 + m.segs.length;
    if (score > (best?.score ?? -1)) best = { item: m.item, score };
  }
  return best?.item ?? null;
}

/** The diagnostics per item id ('' for those that belong to no item). */
export function problemsByItem(doc: unknown, diagnostics: readonly Diagnostic[]): Map<string, Diagnostic[]> {
  const out = new Map<string, Diagnostic[]>();
  for (const d of diagnostics) {
    const item = itemForPath(doc, d.path) ?? '';
    const list = out.get(item);
    if (list) list.push(d);
    else out.set(item, [d]);
  }
  return out;
}

/** The worst severity among diagnostics, or null. */
export function worstSeverity(list: readonly Diagnostic[] | undefined): Diagnostic['severity'] | null {
  if (!list?.length) return null;
  if (list.some((d) => d.severity === 'error')) return 'error';
  if (list.some((d) => d.severity === 'warning')) return 'warning';
  return 'info';
}

export const MISSING_LANDMARK = 'avatar-missing-landmark';
