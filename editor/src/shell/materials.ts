/**
 * Materials of the chrome (pure parts; see settings.tsx): the preference, what a WebGL renderer
 * string says about the GPU, and what 'auto' resolves to.
 */
export type MaterialsPreference = 'auto' | 'glass' | 'solid';
export const MATERIALS: readonly MaterialsPreference[] = ['auto', 'glass', 'solid'];
export const MATERIALS_STORAGE_KEY = 'rev2d.materials';

export function parseMaterials(value: unknown, fallback: MaterialsPreference = 'auto'): MaterialsPreference {
  return value === 'glass' || value === 'solid' || value === 'auto' ? value : fallback;
}

/** Whether an (unmasked) WebGL renderer string names a software rasterizer. */
export function isSoftwareRenderer(renderer: string): boolean {
  return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer);
}

/** What 'auto' means here: solid without a GPU or when less transparency was asked for. */
export function resolveMaterials(preference: MaterialsPreference, env: { software: boolean; reducedTransparency: boolean }): 'glass' | 'solid' {
  if (preference !== 'auto') return preference;
  return env.software || env.reducedTransparency ? 'solid' : 'glass';
}

/** The unmasked renderer of a throwaway WebGL context ('' when WebGL is unavailable). */
export function readWebGLRenderer(): string {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!gl) return '';
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String((info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : null) ?? gl.getParameter(gl.RENDERER) ?? '');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return renderer;
  } catch {
    return '';
  }
}

let softwareRenderer: boolean | null = null;

/** Detected once per page (it needs a WebGL context). */
export function hasSoftwareRendererCached(): boolean {
  softwareRenderer ??= isSoftwareRenderer(readWebGLRenderer());
  return softwareRenderer;
}
