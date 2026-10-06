/**
 * Appearance switching in the browser: writes `data-appearance` on the root element (tokens.css does
 * the rest) and remembers the choice. The pure parts live in logic/appearance.ts.
 */
import { useCallback, useEffect, useState } from 'react';
import { parseAppearance, resolveAppearance, type Appearance } from './logic/appearance.js';

export const APPEARANCE_STORAGE_KEY = 'rev2d.appearance';

/** Apply a preference to an element (default: <html>). 'auto' follows the system setting. */
export function applyAppearance(appearance: Appearance, root: HTMLElement = document.documentElement): void {
  root.setAttribute('data-appearance', appearance);
  // Native form controls, scrollbars and the canvas default follow the meta tag where present.
  if (root === document.documentElement) {
    const meta = document.querySelector('meta[name="color-scheme"]');
    meta?.setAttribute('content', appearance === 'auto' ? 'light dark' : appearance);
  }
}

export function readStoredAppearance(fallback: Appearance = 'auto'): Appearance {
  try {
    return parseAppearance(localStorage.getItem(APPEARANCE_STORAGE_KEY), fallback);
  } catch {
    return fallback;
  }
}

export function storeAppearance(appearance: Appearance): void {
  try {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, appearance);
  } catch {
    // Private mode or a blocked storage: the choice lasts for this page only.
  }
}

function systemPrefersDark(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * The appearance preference of the app: applied to <html>, stored, and resolved to what is shown
 * ('light' | 'dark', following the system while the preference is 'auto').
 */
export function useAppearance(initial?: Appearance): { appearance: Appearance; resolved: 'light' | 'dark'; setAppearance: (appearance: Appearance) => void } {
  const [appearance, setState] = useState<Appearance>(() => initial ?? readStoredAppearance());
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  useEffect(() => {
    applyAppearance(appearance);
  }, [appearance]);

  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const query = matchMedia('(prefers-color-scheme: dark)');
    const onChange = (): void => setSystemDark(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const setAppearance = useCallback((next: Appearance) => {
    setState(next);
    storeAppearance(next);
  }, []);

  return { appearance, resolved: resolveAppearance(appearance, systemDark), setAppearance };
}

/**
 * The value of a colour token as the browser resolves it for `scope` (its appearance, contrast and
 * transparency settings): `[r, g, b, a]` with r, g, b in 0..255 and a in 0..1. For code that paints
 * outside CSS: the WebGL clear colour (`--r2-canvas`), canvas overlays (`--r2-tint`, `--r2-kind-bone`).
 * Tokens hold `light-dark(...)`, so reading the custom property itself returns that text, not a
 * colour: this probes a real element instead. Call it again when the appearance changes.
 */
export function readColorToken(token: string, scope: Element = document.documentElement): [number, number, number, number] {
  const probe = document.createElement('span');
  probe.style.cssText = `position:absolute;width:0;height:0;visibility:hidden;pointer-events:none;color:var(${token})`;
  scope.appendChild(probe);
  const value = getComputedStyle(probe).color;
  probe.remove();
  return parseComputedColor(value);
}

/** Parse a computed colour: `rgb(r, g, b)`, `rgba(r, g, b, a)` or `color(srgb r g b / a)`. */
export function parseComputedColor(value: string): [number, number, number, number] {
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(value.trim());
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), alpha(rgb[4])];
  const srgb = /^color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/.exec(value.trim());
  if (srgb) return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255, alpha(srgb[4])];
  return [0, 0, 0, 0];
}

function alpha(text: string | undefined): number {
  if (text === undefined) return 1;
  return text.endsWith('%') ? Number(text.slice(0, -1)) / 100 : Number(text);
}
