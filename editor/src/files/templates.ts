/**
 * Presentation of the model templates (GET /api/templates lists them with descriptions): thumbnails
 * and friendly titles. Unknown templates (a newer server, a custom examples folder) still work; they
 * get a generic tile.
 *
 * Thumbnails are renders of the templates made with the CLI, fitting 320x240, e.g.
 *   rev2d render examples/hana/hana.r2d.json -o editor/src/assets/templates/hana.png --scale 0.375 --anim idle --time 0.6
 * (blank: a `rev2d new` model; empty has none, being an empty canvas).
 */
import blankPng from '../assets/templates/blank.png';
import hanaPng from '../assets/templates/hana.png';
import minimalPng from '../assets/templates/minimal.png';
import robotArmPng from '../assets/templates/robot-arm.png';
import slimePng from '../assets/templates/slime.png';
import texturedPng from '../assets/templates/textured.png';

const THUMBNAILS: Record<string, string> = {
  blank: blankPng,
  hana: hanaPng,
  minimal: minimalPng,
  'robot-arm': robotArmPng,
  slime: slimePng,
  textured: texturedPng,
};

const TITLES: Record<string, string> = {
  blank: 'Blank rig',
  empty: 'Empty canvas',
  hana: 'Hana',
  minimal: 'Minimal',
  'robot-arm': 'Robot arm',
  slime: 'Slime',
  textured: 'Textured',
};

/** Templates generated in code: the only ones whose canvas size can be chosen. */
export const SIZED_TEMPLATES = new Set(['blank', 'empty']);

/** Example models shown on the start screen, in this order (those the server lists). */
export const EXAMPLE_ORDER = ['hana', 'robot-arm', 'slime', 'textured', 'minimal'];

export function templateThumbnail(name: string): string | null {
  return THUMBNAILS[name] ?? null;
}

export function templateTitle(name: string): string {
  return TITLES[name] ?? name.replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

/** First sentence of a description, for compact cards. */
export function shortDescription(text: string, max = 110): string {
  const t = text.trim();
  const dot = t.search(/[.!?](\s|$)/);
  const first = dot >= 0 ? t.slice(0, dot + 1) : t;
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
}
