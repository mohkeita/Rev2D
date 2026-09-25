/**
 * Minimal external store for React 19 (useSyncExternalStore) with selector subscriptions, so
 * high-frequency fields (time, evaluated params, pointer) only re-render the components that read them.
 */
import { useCallback, useRef, useSyncExternalStore } from 'react';

export type Listener = () => void;

export class Store<T extends object> {
  private state: T;
  private readonly listeners = new Set<Listener>();

  constructor(initial: T) {
    this.state = initial;
  }

  get = (): T => this.state;

  /** Shallow-merge a patch (or the result of an updater). Listeners run only when something changed. */
  set = (patch: Partial<T> | ((s: T) => Partial<T>)): void => {
    const p = typeof patch === 'function' ? patch(this.state) : patch;
    let changed = false;
    for (const k in p) {
      if (!Object.is(this.state[k], p[k])) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.state = { ...this.state, ...p };
    for (const l of [...this.listeners]) l();
  };

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

/** Shallow equality for arrays and plain objects (one level). */
export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

/**
 * Subscribe to a derived slice of the store. `equal` decides whether the component re-renders
 * (default Object.is; pass shallowEqual for selectors that build arrays/objects).
 */
export function useStore<T extends object, S>(
  store: Store<T>,
  selector: (s: T) => S,
  equal: (a: S, b: S) => boolean = Object.is,
): S {
  const cache = useRef<{ state: T; selector: (s: T) => S; value: S } | null>(null);
  const getSnapshot = useCallback((): S => {
    const state = store.get();
    const prev = cache.current;
    if (prev && prev.state === state && prev.selector === selector) return prev.value;
    const value = selector(state);
    // Keep the previous reference when equal so React sees a stable snapshot.
    const stable = prev && equal(prev.value, value) ? prev.value : value;
    cache.current = { state, selector, value: stable };
    return stable;
  }, [store, selector, equal]);
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}
