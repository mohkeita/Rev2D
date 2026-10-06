/** Small shared helpers of the design-system components (hooks, focus utilities, class names). */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Ref, type RefCallback } from 'react';

/** Join class names, skipping falsy entries. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  let out = '';
  for (const p of parts) if (p) out = out ? `${out} ${p}` : p;
  return out;
}

/** One ref callback that feeds several refs (a trigger that is also a tooltip anchor). */
export function mergeRefs<T>(...refs: Array<Ref<T> | undefined | null>): RefCallback<T> {
  return (node) => {
    for (const ref of refs) {
      if (typeof ref === 'function') ref(node);
      else if (ref) (ref as { current: T | null }).current = node;
    }
  };
}

/** The latest value of a prop inside stable callbacks and effects. */
export function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/**
 * State that is controlled when `value` is given and internal otherwise. The setter always calls
 * `onChange` (when the value changes).
 */
export function useControllable<T>(value: T | undefined, defaultValue: T, onChange?: (value: T) => void): [T, (next: T) => void] {
  const [inner, setInner] = useState(defaultValue);
  const controlled = value !== undefined;
  const current = controlled ? value : inner;
  const latest = useLatest({ current, onChange, controlled });
  const set = useCallback(
    (next: T) => {
      const l = latest.current;
      if (Object.is(l.current, next)) return;
      if (!l.controlled) setInner(next);
      l.onChange?.(next);
    },
    [latest],
  );
  return [current, set];
}

export const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** Visible focusable controls inside `el`, in document order. */
export function focusablesIn(el: HTMLElement): HTMLElement[] {
  return [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (n) => !n.hasAttribute('data-focus-guard') && (n.offsetParent !== null || n === document.activeElement || n.getClientRects().length > 0),
  );
}

export function isRtl(el: Element | null): boolean {
  return !!el && getComputedStyle(el).direction === 'rtl';
}

/**
 * Keeps a closing surface mounted until its exit animation ends. Returns whether to render and the
 * phase to put on the element (`data-state="open" | "closing"`); the CSS animates `[data-state=closing]`.
 * Without an animation (reduced motion, display: none) the fallback timer unmounts it.
 */
export function usePresence(open: boolean, exitMs = 320): { mounted: boolean; state: 'open' | 'closing'; onAnimationEnd: (e: { target: EventTarget; currentTarget: EventTarget }) => void } {
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useLayoutEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (open) {
      setMounted(true);
      setClosing(false);
    } else if (mounted) {
      setClosing(true);
      timer.current = setTimeout(() => {
        setMounted(false);
        setClosing(false);
      }, exitMs);
    }
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // `mounted` is read, not a trigger: the effect runs when `open` changes.
  }, [open, exitMs]);

  const onAnimationEnd = useCallback(
    (e: { target: EventTarget; currentTarget: EventTarget }) => {
      if (e.target !== e.currentTarget || open) return;
      if (timer.current) clearTimeout(timer.current);
      setMounted(false);
      setClosing(false);
    },
    [open],
  );

  return { mounted: open || mounted, state: !open && closing ? 'closing' : 'open', onAnimationEnd };
}

/**
 * Call `handler` when a pointer goes down outside all of `refs` while `active`. A press inside a
 * layer that opened later (a select list opened from a popover) counts as inside: the first ref
 * names the surface whose layer is the reference.
 */
export function useOutsidePress(active: boolean, refs: ReadonlyArray<{ readonly current: Element | null }>, handler: (e: PointerEvent) => void): void {
  const latest = useLatest({ refs, handler });
  useEffect(() => {
    if (!active) return;
    const onDown = (e: PointerEvent): void => {
      const t = e.target instanceof Element ? e.target : null;
      if (!t) return;
      for (const r of latest.current.refs) if (r.current?.contains(t)) return;
      const own = latest.current.refs[0]?.current?.closest('.r2-layer');
      const other = t.closest('.r2-layer');
      if (own && other && other !== own && own.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING) return;
      latest.current.handler(e);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [active, latest]);
}

/** Size of an element, updated by a ResizeObserver (null before the first measurement). */
export function useElementSize<T extends HTMLElement>(): [RefCallback<T>, { width: number; height: number } | null] {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback<RefCallback<T>>((node) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node) return;
    const measure = (): void => {
      const { width, height } = node.getBoundingClientRect();
      setSize((prev) => (prev && prev.width === width && prev.height === height ? prev : { width, height }));
    };
    measure();
    observer.current = new ResizeObserver(measure);
    observer.current.observe(node);
  }, []);
  return [ref, size];
}
