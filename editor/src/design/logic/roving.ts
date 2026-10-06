/**
 * Keyboard navigation inside composite widgets (segmented controls, tabs, menus, lists, toolbars):
 * which item gets the focus after a key press, type-ahead, and the Tab order of a focus trap. Pure.
 */

export type Orientation = 'horizontal' | 'vertical' | 'both';

export interface RovingOptions {
  /** Which arrow keys move: Left/Right, Up/Down or all four. Default 'horizontal'. */
  orientation?: Orientation;
  /** Wrap around at the ends. Default true. */
  loop?: boolean;
  /** Right-to-left: ArrowLeft moves forward. */
  rtl?: boolean;
  /** Items that cannot take the focus. */
  isDisabled?: (index: number) => boolean;
}

/**
 * Index of the item to focus after `key`, or null when the key is not a navigation key (or there is
 * nowhere to go). `current` may be -1 (nothing focused yet): forward goes to the first item, backward
 * to the last.
 */
export function rovingIndex(key: string, current: number, count: number, opts: RovingOptions = {}): number | null {
  const { orientation = 'horizontal', loop = true, rtl = false, isDisabled } = opts;
  if (count <= 0) return null;
  const horizontal = orientation !== 'vertical';
  const vertical = orientation !== 'horizontal';
  let dir = 0;
  if (key === 'Home') return firstEnabled(0, 1, count, isDisabled);
  if (key === 'End') return firstEnabled(count - 1, -1, count, isDisabled);
  if (horizontal && key === 'ArrowRight') dir = rtl ? -1 : 1;
  else if (horizontal && key === 'ArrowLeft') dir = rtl ? 1 : -1;
  else if (vertical && key === 'ArrowDown') dir = 1;
  else if (vertical && key === 'ArrowUp') dir = -1;
  if (dir === 0) return null;

  let i = current;
  for (let n = 0; n < count; n++) {
    i += dir;
    if (i < 0 || i >= count) {
      if (!loop) return null;
      i = dir > 0 ? 0 : count - 1;
    }
    if (!isDisabled?.(i)) return i === current ? null : i;
  }
  return null;
}

function firstEnabled(from: number, dir: 1 | -1, count: number, isDisabled?: (index: number) => boolean): number | null {
  for (let i = from; i >= 0 && i < count; i += dir) {
    if (!isDisabled?.(i)) return i;
  }
  return null;
}

/**
 * Type-ahead: the next item whose label starts with what was typed. Typing one letter repeatedly
 * cycles through the items that start with it; a longer query keeps the current item when it still
 * matches.
 */
export function typeaheadIndex(labels: readonly string[], query: string, current: number, isDisabled?: (index: number) => boolean): number | null {
  const q = query.trim().toLocaleLowerCase();
  if (!q || labels.length === 0) return null;
  const repeated = q.length > 1 && [...q].every((c) => c === q[0]);
  const needle = repeated ? q[0]! : q;
  const start = repeated || q.length === 1 ? current + 1 : Math.max(current, 0);
  for (let n = 0; n < labels.length; n++) {
    const i = (start + n + labels.length) % labels.length;
    if (isDisabled?.(i)) continue;
    if (labels[i]!.trim().toLocaleLowerCase().startsWith(needle)) return i;
  }
  return null;
}

/**
 * Focus trap: the index of the control that Tab (or Shift+Tab) moves to among `count` focusable
 * controls, wrapping at the ends. `current` is -1 when the focus is on the container itself or
 * outside it. Returns -1 when there is nothing to focus.
 */
export function trapTabIndex(current: number, count: number, backwards: boolean): number {
  if (count <= 0) return -1;
  if (current < 0 || current >= count) return backwards ? count - 1 : 0;
  return (current + (backwards ? -1 : 1) + count) % count;
}
