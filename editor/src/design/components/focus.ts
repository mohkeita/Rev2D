/**
 * Focus scope for surfaces that take the keyboard (sheets, dialogs, popovers): moves the focus in
 * when they open, keeps Tab inside, gives the focus back to where it was when they close.
 */
import { useEffect, useRef, type KeyboardEvent, type RefObject } from 'react';
import { trapTabIndex } from '../logic/roving.js';
import { focusablesIn } from '../util.js';

export interface FocusScopeOptions {
  active: boolean;
  /** Keep Tab / Shift+Tab inside the container. Default true. */
  trap?: boolean;
  /**
   * Where the focus goes on open: the element marked `data-autofocus`, else the first control that
   * is not marked `data-autofocus-skip` (`true`, default), or the container itself (`'container'`: nothing looks focused, the next Tab
   * goes to the first control). `false` leaves the focus alone.
   */
  autoFocus?: boolean | 'container';
  /** Give the focus back on close. Default true. */
  restore?: boolean;
}

export function useFocusScope(container: RefObject<HTMLElement | null>, opts: FocusScopeOptions): { onKeyDown: (e: KeyboardEvent<HTMLElement>) => void } {
  const { active, trap = true, autoFocus = true, restore = true } = opts;
  const previous = useRef<HTMLElement | null>(null);

  // After the layout phase: a floating surface is hidden (unfocusable) until Floating positioned it.
  useEffect(() => {
    if (!active) return;
    const el = container.current;
    previous.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (el && autoFocus !== false && !el.contains(document.activeElement)) {
      const target = autoFocus === 'container' ? el : (el.querySelector<HTMLElement>('[data-autofocus]') ?? focusablesIn(el).find((n) => !n.hasAttribute('data-autofocus-skip')) ?? el);
      target.focus({ preventScroll: true });
      if (target instanceof HTMLInputElement && typeof target.select === 'function' && target.type !== 'checkbox' && target.type !== 'radio') target.select();
    }
    return () => {
      const back = previous.current;
      previous.current = null;
      if (!restore || !back?.isConnected) return;
      const now = document.activeElement;
      // Only when the focus is still ours to give: inside the closing surface, or dropped to <body>.
      if (now === null || now === document.body || (el !== null && el.contains(now))) back.focus({ preventScroll: true });
    };
  }, [active, autoFocus, restore, container]);

  // A focused control that disappears (or becomes disabled) drops the focus to <body>: pull it back.
  useEffect(() => {
    if (!active || !trap) return;
    const onFocusOut = (): void => {
      setTimeout(() => {
        const el = container.current;
        if (el?.isConnected && (document.activeElement === document.body || document.activeElement === null)) el.focus({ preventScroll: true });
      }, 0);
    };
    const el = container.current;
    el?.addEventListener('focusout', onFocusOut);
    return () => el?.removeEventListener('focusout', onFocusOut);
  }, [active, trap, container]);

  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (!active || !trap || e.key !== 'Tab' || e.defaultPrevented) return;
    const el = container.current;
    if (!el) return;
    const items = focusablesIn(el);
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next = trapTabIndex(current, items.length, e.shiftKey);
    // Only intervene at the ends (and when the focus is not on a control): in between, the browser's
    // own Tab order is right and respects radio groups and roving tab stops.
    const atEnd = current < 0 || (e.shiftKey ? current === 0 : current === items.length - 1);
    if (!atEnd) return;
    e.preventDefault();
    if (next >= 0) items[next]!.focus();
    else el.focus();
  };

  return { onKeyDown };
}
