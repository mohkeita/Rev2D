/**
 * Colours of what the editor paints outside CSS, resolved from the design tokens for the appearance
 * in effect: the Canvas 2D overlay (draw.ts) and the WebGL viewport (gl/renderer.ts). Read them
 * again when the appearance changes (`readCanvasTheme()` probes the document; it is not free).
 */
import type { RGBA } from '../../../src/core/index.js';
import { readColorToken } from '../design/appearance.js';

export interface OverlayTheme {
  /** Canvas font shorthands (the system UI and monospace stacks of the design system). */
  font: string;
  mono: string;
  /** Selection: the tint. `accentSoft` for wireframes, `accentFill` for filled glyphs. */
  accent: string;
  accentSoft: string;
  accentFill: string;
  /** Halo drawn under thin lines so they read on any artwork. */
  halo: string;
  haloSoft: string;
  /** Handles: discs filled with `handleFill`, ringed in their colour; `onAccent` inside a selected one. */
  handleFill: string;
  onAccent: string;
  hover: string;
  mesh: string;
  warp: string;
  bounds: string;
  boneLink: string;
  /** Colours of bones without a `color` of their own, by index. */
  bonePalette: string[];
  /** Model canvas frame: hairline, the steps of its soft shadow, its caption. */
  frame: string;
  frameShadow: string[];
  frameLabel: string;
  gridMinor: string;
  gridMajor: string;
  axisX: string;
  axisY: string;
  rulerPlate: string;
  rulerText: string;
  /** Id labels: a plate with text; parts use the part colour. */
  pillPlate: string;
  pillText: string;
  pillPartText: string;
}

/** Colours of the WebGL viewport as premultipliable RGBA in 0..1. */
export interface CanvasColors {
  /** The workspace around the model canvas (--r2-canvas). */
  workspace: RGBA;
  checkA: RGBA;
  checkB: RGBA;
  /** The fixed "dark" and "light" backdrops (the dark / light values of --r2-bg-2). */
  darkBackdrop: RGBA;
  lightBackdrop: RGBA;
}

export interface CanvasTheme {
  overlay: OverlayTheme;
  gl: CanvasColors;
}

type Tuple = [number, number, number, number];

function css(c: Tuple, alpha = 1): string {
  return `rgba(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])}, ${Math.round(c[3] * alpha * 1000) / 1000})`;
}

function unit(c: Tuple): RGBA {
  return [c[0] / 255, c[1] / 255, c[2] / 255, c[3]];
}

/** A hidden element with a fixed appearance, to read the light or dark value of a token. */
function withScope<T>(appearance: 'light' | 'dark', read: (scope: Element) => T): T {
  const scope = document.createElement('div');
  scope.setAttribute('data-appearance', appearance);
  scope.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;visibility:hidden';
  document.body.appendChild(scope);
  try {
    return read(scope);
  } finally {
    scope.remove();
  }
}

export function readCanvasTheme(scope: Element = document.documentElement): CanvasTheme {
  const token = (name: string): Tuple => readColorToken(name, scope);
  const style = getComputedStyle(scope);
  const family = style.getPropertyValue('--r2-font').trim() || 'system-ui, sans-serif';
  const monoFamily = style.getPropertyValue('--r2-font-mono').trim() || 'ui-monospace, monospace';
  const tint = token('--r2-tint-solid');
  const scrim = token('--r2-scrim');
  const label = token('--r2-label');
  const canvas = token('--r2-canvas');
  const elevated = token('--r2-bg-elevated');
  const overlay: OverlayTheme = {
    font: `500 11px ${family}`,
    mono: `10px ${monoFamily}`,
    accent: css(tint),
    accentSoft: css(tint, 0.35),
    accentFill: css(tint, 0.5),
    halo: css([scrim[0], scrim[1], scrim[2], Math.min(0.6, scrim[3] + 0.12)]),
    haloSoft: css([scrim[0], scrim[1], scrim[2], scrim[3] * 0.7]),
    handleFill: css(elevated),
    onAccent: css(token('--r2-on-tint')),
    hover: css(label, 0.8),
    mesh: css(token('--r2-cyan'), 0.5),
    warp: css(token('--r2-kind-warp'), 0.95),
    bounds: css(token('--r2-yellow'), 0.95),
    boneLink: css(label, 0.45),
    bonePalette: ['--r2-red', '--r2-green', '--r2-blue', '--r2-yellow', '--r2-pink', '--r2-cyan', '--r2-orange', '--r2-purple'].map((name) => css(token(name))),
    frame: css(token('--r2-separator-strong')),
    frameShadow: [0.5, 0.28, 0.12].map((k) => css([scrim[0], scrim[1], scrim[2], scrim[3] * k])),
    frameLabel: css(token('--r2-label-3')),
    gridMinor: css(token('--r2-canvas-grid')),
    gridMajor: css(token('--r2-separator-strong')),
    axisX: css(token('--r2-green'), 0.6),
    axisY: css(token('--r2-red'), 0.6),
    rulerPlate: css(canvas, 0.82),
    rulerText: css(token('--r2-label-2')),
    pillPlate: css(elevated, 0.92),
    pillText: css(label),
    pillPartText: css(token('--r2-tint')),
  };
  const gl: CanvasColors = {
    workspace: unit(canvas),
    checkA: unit(token('--r2-canvas-check-a')),
    checkB: unit(token('--r2-canvas-check-b')),
    darkBackdrop: withScope('dark', (s) => unit(readColorToken('--r2-bg-2', s))),
    lightBackdrop: withScope('light', (s) => unit(readColorToken('--r2-bg-2', s))),
  };
  return { overlay, gl };
}
