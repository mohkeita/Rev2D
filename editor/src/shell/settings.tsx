/**
 * Display settings of the editor, remembered per browser:
 *
 * - appearance: 'auto' (default, follows the system) | 'light' | 'dark', applied as
 *   `data-appearance` on <html> by the design system's useAppearance;
 * - materials: 'auto' (default) | 'glass' | 'solid'. Glass blurs what is behind it on every frame;
 *   with a software rasterizer (no GPU: SwiftShader, llvmpipe, "Software"...) or when the person
 *   asked the system to reduce transparency, 'auto' switches the design system to solid materials
 *   (`data-materials="solid"` on <html>) so the UI stays fast.
 *
 * `?appearance=` and `?materials=` in the page URL override the stored choice for that page load
 * (screenshots, tests). The language lives in ../i18n (useLanguage, setLanguage).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { parseAppearance, useAppearance, type Appearance } from '../design/index.js';

import { hasSoftwareRendererCached, parseMaterials, resolveMaterials, MATERIALS_STORAGE_KEY, type MaterialsPreference } from './materials.js';

export { MATERIALS, type MaterialsPreference } from './materials.js';

function queryParam(name: string): string | null {
  try {
    return new URLSearchParams(location.search).get(name);
  } catch {
    return null;
  }
}

function readStoredMaterials(): MaterialsPreference {
  try {
    return parseMaterials(queryParam('materials') ?? localStorage.getItem(MATERIALS_STORAGE_KEY));
  } catch {
    return 'auto';
  }
}

function applyMaterials(resolved: 'glass' | 'solid'): void {
  if (resolved === 'solid') document.documentElement.setAttribute('data-materials', 'solid');
  else document.documentElement.removeAttribute('data-materials');
}

function prefersReducedTransparency(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-transparency: reduce)').matches;
}

/**
 * Apply the stored materials choice before the first paint (called from main.tsx), so the page does
 * not start with glass and then turn solid.
 */
export function initMaterials(): 'glass' | 'solid' {
  const preference = readStoredMaterials();
  const resolved = resolveMaterials(preference, { software: preference === 'auto' && hasSoftwareRendererCached(), reducedTransparency: prefersReducedTransparency() });
  applyMaterials(resolved);
  return resolved;
}

export interface Settings {
  appearance: Appearance;
  /** What is shown: 'auto' resolved against the system setting. */
  resolvedAppearance: 'light' | 'dark';
  setAppearance: (appearance: Appearance) => void;
  materials: MaterialsPreference;
  resolvedMaterials: 'glass' | 'solid';
  setMaterials: (materials: MaterialsPreference) => void;
}

const SettingsContext = createContext<Settings | null>(null);

export function useSettings(): Settings {
  const s = useContext(SettingsContext);
  if (!s) throw new Error('useSettings: no <SettingsProvider> above this component');
  return s;
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const initialAppearance = useMemo(() => {
    const query = queryParam('appearance');
    return query ? parseAppearance(query) : undefined;
  }, []);
  const { appearance, resolved, setAppearance } = useAppearance(initialAppearance);
  const [materials, setMaterialsState] = useState<MaterialsPreference>(readStoredMaterials);
  const [reduced, setReduced] = useState(prefersReducedTransparency);

  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const query = matchMedia('(prefers-reduced-transparency: reduce)');
    const onChange = (): void => setReduced(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const resolvedMaterials = resolveMaterials(materials, { software: materials === 'auto' && hasSoftwareRendererCached(), reducedTransparency: reduced });
  useEffect(() => applyMaterials(resolvedMaterials), [resolvedMaterials]);

  const setMaterials = useCallback((next: MaterialsPreference) => {
    setMaterialsState(next);
    try {
      localStorage.setItem(MATERIALS_STORAGE_KEY, next);
    } catch {
      // Private mode or blocked storage: the choice lasts for this page only.
    }
  }, []);

  const value = useMemo<Settings>(
    () => ({ appearance, resolvedAppearance: resolved, setAppearance, materials, resolvedMaterials, setMaterials }),
    [appearance, resolved, setAppearance, materials, resolvedMaterials, setMaterials],
  );
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}
