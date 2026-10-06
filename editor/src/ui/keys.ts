/** Keyboard state shared between the global shortcut handler and the viewport (space + drag = pan). */
export const keyState = {
  /** Space is held down. */
  space: false,
  /** The current space press was used to pan (so releasing it must not toggle playback). */
  spaceUsed: false,
};

/** The element fields keyboard routing looks at (duck-typed so it works on any EventTarget). */
interface ElementLike {
  tagName?: string;
  type?: string;
  isContentEditable?: boolean;
  getAttribute?: (name: string) => string | null;
}

function asElement(target: EventTarget | null): ElementLike | null {
  return target && typeof (target as ElementLike).tagName === 'string' ? (target as ElementLike) : null;
}

/** Input types that do not take text (their keys can serve as editor shortcuts). */
const NON_TEXT_INPUTS = new Set(['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file', 'image']);

/** True when keyboard input belongs to a text field rather than to editor shortcuts. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = asElement(target);
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName === 'INPUT') return !NON_TEXT_INPUTS.has((el.type ?? 'text').toLowerCase());
  return false;
}

/** Keys a focused control uses for itself (slider steps, list navigation, caret movement). */
export const NAVIGATION_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

/** ARIA widgets of the design system that move or change with the arrow keys / Home / End. */
const NAVIGATION_ROLES = new Set(['slider', 'radio', 'tab', 'option', 'menuitem', 'menuitemcheckbox', 'spinbutton', 'separator', 'switch', 'combobox', 'listbox', 'treeitem']);

/**
 * True when the focused element handles NAVIGATION_KEYS itself, so global shortcuts (frame
 * stepping, go to start) must leave them alone: sliders, selects, radio groups, text fields and
 * the ARIA widgets that work like them (role="slider", "radio", "tab", ...).
 */
export function keepsNavigationKeys(target: EventTarget | null): boolean {
  const el = asElement(target);
  if (!el) return false;
  if (el.tagName === 'SELECT') return true;
  if (el.tagName === 'INPUT' && ['range', 'radio'].includes((el.type ?? '').toLowerCase())) return true;
  const role = typeof el.getAttribute === 'function' ? el.getAttribute('role') : null;
  if (role && NAVIGATION_ROLES.has(role)) return true;
  return isTypingTarget(target);
}
