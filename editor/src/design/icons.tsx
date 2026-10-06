/**
 * The Rev2D icon set: original glyphs drawn for this project as inline SVG. No icon font, no icon
 * library, no SF Symbols.
 *
 * Grid and style (keep new glyphs consistent with these):
 * - 24 x 24 grid, live area 3..21 (a glyph may touch 2.5 / 21.5 with a round cap);
 * - one stroke weight, round caps and joins, `currentColor`: 1.75 px at 20 px and larger, 2 px
 *   (grid units) below, so the stroke stays close to 1.35 px on screen at the 16 px size;
 * - corners of containers (documents, panels, frames) are rounded by 1.5 - 2.5 units;
 * - transport glyphs (play, pause, stop, skip) are solid, everything else is outlined; small dots
 *   are solid circles of radius 1.1 - 1.4;
 * - optically centred: asymmetric glyphs (play, cursor) are shifted, not geometrically centred.
 *
 * The names of the legacy set (editor/src/ui/icons.tsx) all exist here with the same meaning, so a
 * screen can switch by changing its import.
 */
import type { SVGProps } from 'react';

/** A stroked path, or `[path, 'fill']` (solid) / `[path, 'soft']` (solid at 28 % opacity). */
type Shape = string | readonly [d: string, mode: 'fill' | 'soft'];

const n = (v: number): string => String(Math.round(v * 100) / 100);

/** Circle outline (or, with `fill`, a dot) as a path. */
function ring(cx: number, cy: number, r: number): string {
  return `M${n(cx - r)} ${n(cy)}a${n(r)} ${n(r)} 0 1 0 ${n(2 * r)} 0a${n(r)} ${n(r)} 0 1 0 ${n(-2 * r)} 0z`;
}

function dot(cx: number, cy: number, r = 1.15): Shape {
  return [ring(cx, cy, r), 'fill'];
}

/** Rounded rectangle as a path. */
function rrect(x: number, y: number, w: number, h: number, r: number): string {
  return (
    `M${n(x + r)} ${n(y)}h${n(w - 2 * r)}a${n(r)} ${n(r)} 0 0 1 ${n(r)} ${n(r)}v${n(h - 2 * r)}` +
    `a${n(r)} ${n(r)} 0 0 1 ${n(-r)} ${n(r)}h${n(-(w - 2 * r))}a${n(r)} ${n(r)} 0 0 1 ${n(-r)} ${n(-r)}` +
    `v${n(-(h - 2 * r))}a${n(r)} ${n(r)} 0 0 1 ${n(r)} ${n(-r)}z`
  );
}

/** Four-point sparkle star centred at (cx, cy) with radius r. */
function star4(cx: number, cy: number, r: number): string {
  const k = r * 0.12; // how far the control points sit from the axes: smaller = sharper waist
  const q = r * 0.42;
  return (
    `M${n(cx)} ${n(cy - r)}c${n(k)} ${n(r - q)} ${n(q)} ${n(r - k)} ${n(r)} ${n(r)}` +
    `c${n(-(r - q))} ${n(k)} ${n(-(r - k))} ${n(q)} ${n(-r)} ${n(r)}` +
    `c${n(-k)} ${n(-(r - q))} ${n(-q)} ${n(-(r - k))} ${n(-r)} ${n(-r)}` +
    `c${n(r - q)} ${n(-k)} ${n(r - k)} ${n(-q)} ${n(r)} ${n(-r)}z`
  );
}

/** Gear outline: `teeth` trapezoid teeth between the root and tip radius. */
function gear(cx: number, cy: number, tip: number, root: number, teeth: number): string {
  const step = (Math.PI * 2) / teeth;
  const tipHalf = step * 0.17;
  const rootHalf = step * 0.3;
  const pt = (r: number, a: number): string => `${n(cx + r * Math.sin(a))} ${n(cy - r * Math.cos(a))}`;
  let d = '';
  for (let i = 0; i < teeth; i++) {
    const a = i * step;
    d += `${i === 0 ? 'M' : 'L'}${pt(root, a - rootHalf)}L${pt(tip, a - tipHalf)}L${pt(tip, a + tipHalf)}L${pt(root, a + rootHalf)}`;
  }
  return `${d}z`;
}

const CIRCLE = ring(12, 12, 9);
const PANEL = rrect(3.5, 4.5, 17, 15, 2.5);
const SQUARE = rrect(4, 4, 16, 16, 2.5);
const DOCUMENT = 'M7.5 3.5h6L19 9v10a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 6 19V5a1.5 1.5 0 0 1 1.5-1.5zM13.5 3.5V9H19';
const TRAY = 'M8 10H6.5A1.5 1.5 0 0 0 5 11.5v7A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5v-7a1.5 1.5 0 0 0-1.5-1.5H16';
const SHELF = 'M4.5 16.5V18a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-1.5';
const LENS = `${ring(10.5, 10.5, 6.5)}M20 20l-4.6-4.6`;
const PERSON = `${ring(12, 8, 3.5)}M5 20c0-3.9 3.1-7 7-7s7 3.1 7 7`;

const GLYPHS = {
  // ------------------------------------------------------------------------------------- transport
  play: [['M8.5 5.9v12.2a.8.8 0 0 0 1.2.7l10-6.1a.8.8 0 0 0 0-1.4l-10-6.1a.8.8 0 0 0-1.2.7z', 'fill']],
  pause: [[`${rrect(6.5, 5, 4, 14, 1.2)}${rrect(13.5, 5, 4, 14, 1.2)}`, 'fill']],
  stop: [[rrect(6, 6, 12, 12, 2), 'fill']],
  record: [[ring(12, 12, 6), 'fill']],
  toStart: [['M18.5 6.4v11.2a.7.7 0 0 1-1.1.6l-8.2-5.6a.7.7 0 0 1 0-1.2l8.2-5.6a.7.7 0 0 1 1.1.6z', 'fill'], 'M6 6v12'],
  toEnd: [['M5.5 6.4v11.2a.7.7 0 0 0 1.1.6l8.2-5.6a.7.7 0 0 0 0-1.2L6.6 5.8a.7.7 0 0 0-1.1.6z', 'fill'], 'M18 6v12'],
  stepBack: [['M14.5 6.9v10.2a.7.7 0 0 1-1.1.6L6 12.6a.7.7 0 0 1 0-1.2l7.4-5.1a.7.7 0 0 1 1.1.6z', 'fill'], 'M18.5 6.5v11'],
  stepFwd: [['M9.5 6.9v10.2a.7.7 0 0 0 1.1.6l7.4-5.1a.7.7 0 0 0 0-1.2l-7.4-5.1a.7.7 0 0 0-1.1.6z', 'fill'], 'M5.5 6.5v11'],
  repeat: ['M17 3.5l3 3-3 3M4 11.5v-1a4 4 0 0 1 4-4h12M7 20.5l-3-3 3-3M20 12.5v1a4 4 0 0 1-4 4H4'],
  speaker: ['M4 9.5h3l4.5-4v13L7 14.5H4zM15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11'],
  mic: ['M12 3.5a3 3 0 0 0-3 3V12a3 3 0 0 0 6 0V6.5a3 3 0 0 0-3-3zM6 11.5a6 6 0 0 0 12 0M12 17.5V21M9 21h6'],
  waveform: ['M4 10.5v3M8 7v10M12 4v16M16 8v8M20 10.5v3'],

  // ------------------------------------------------------------------------------------ navigation
  chevronRight: ['M9.5 6l6 6-6 6'],
  chevronLeft: ['M14.5 6l-6 6 6 6'],
  chevronDown: ['M6 9.5l6 6 6-6'],
  chevronUp: ['M6 14.5l6-6 6 6'],
  chevronUpDown: ['M8 9.5l4-4 4 4M8 14.5l4 4 4-4'],
  arrowUp: ['M12 19V5M6 11l6-6 6 6'],
  arrowDown: ['M12 5v14M6 13l6 6 6-6'],
  arrowLeft: ['M19 12H5M11 6l-6 6 6 6'],
  arrowRight: ['M5 12h14M13 6l6 6-6 6'],
  external: ['M13.5 4.5h6v6M19.5 4.5l-8 8M17.5 14v4a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18V8A1.5 1.5 0 0 1 6 6.5h4'],
  expand: ['M14 4.5h5.5V10M19.5 4.5l-6 6M10 19.5H4.5V14M4.5 19.5l6-6'],
  home: ['M4 11l8-7 8 7M6 9.5V19a1 1 0 0 0 1 1h3.5v-5.5h3V20H17a1 1 0 0 0 1-1V9.5'],
  menu: ['M4 7h16M4 12h16M4 17h16'],
  more: [dot(5.5, 12, 1.5), dot(12, 12, 1.5), dot(18.5, 12, 1.5)],
  grip: [dot(9, 6, 1.3), dot(15, 6, 1.3), dot(9, 12, 1.3), dot(15, 12, 1.3), dot(9, 18, 1.3), dot(15, 18, 1.3)],

  // --------------------------------------------------------------------------------------- actions
  plus: ['M12 5v14M5 12h14'],
  minus: ['M5 12h14'],
  close: ['M6 6l12 12M18 6L6 18'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  search: [LENS],
  zoomIn: [`${LENS}M10.5 8v5M8 10.5h5`],
  zoomOut: [`${LENS}M8 10.5h5`],
  fit: ['M4 9V6a2 2 0 0 1 2-2h3M15 4h3a2 2 0 0 1 2 2v3M20 15v3a2 2 0 0 1-2 2h-3M9 20H6a2 2 0 0 1-2-2v-3'],
  undo: ['M9 5L4.5 9.5 9 14M4.5 9.5H14a5.5 5.5 0 0 1 0 11h-3'],
  redo: ['M15 5l4.5 4.5L15 14M19.5 9.5H10a5.5 5.5 0 0 0 0 11h3'],
  reset: ['M4.5 4.5v5h5M5 15a7.5 7.5 0 1 0 1.7-7.8L4.5 9.5'],
  refresh: ['M19.5 4.5v5h-5M19 15a7.5 7.5 0 1 1-1.7-7.8l2.2 2.3'],
  save: [TRAY, 'M12 3.5v11M8.5 11l3.5 3.5 3.5-3.5'],
  saveAs: ['M7.5 10h-1A1.5 1.5 0 0 0 5 11.5v7A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V13', 'M11 4v10.5M7.5 11l3.5 3.5 3.5-3.5', 'M18.5 4v5M16 6.5h5'],
  export: [TRAY, 'M12 14.5v-11M8.5 7L12 3.5 15.5 7'],
  import: [SHELF, 'M12 4v10.5M7.5 10.5L12 15l4.5-4.5'],
  download: [SHELF, 'M12 4v10.5M7.5 10.5L12 15l4.5-4.5'],
  upload: [SHELF, 'M12 15V4.5M7.5 9L12 4.5 16.5 9'],
  trash: ['M4.5 6.5h15M9.5 6.5V5A1.5 1.5 0 0 1 11 3.5h2A1.5 1.5 0 0 1 14.5 5v1.5M6.5 6.5l.8 12.1A1.5 1.5 0 0 0 8.8 20h6.4a1.5 1.5 0 0 0 1.5-1.4l.8-12.1M10 10.5V16M14 10.5V16'],
  copy: [rrect(8, 8, 12, 12, 2), 'M5.5 16A1.5 1.5 0 0 1 4 14.5v-9A1.5 1.5 0 0 1 5.5 4h9A1.5 1.5 0 0 1 16 5.5'],
  pencil: ['M4.5 19.5l.9-4L15.8 5.1a1.7 1.7 0 0 1 2.4 0l.7.7a1.7 1.7 0 0 1 0 2.4L8.5 18.6zM14 7l3 3'],
  link: ['M10 14a4 4 0 0 0 5.7 0l3-3A4 4 0 0 0 13 5.3l-1.2 1.2M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1.2-1.2'],
  pin: ['M9 4h6M10 4v5.5L7 13.5h10l-3-4V4M12 13.5v7'],
  lock: [rrect(6, 10.5, 12, 9.5, 2), 'M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5'],
  unlock: [rrect(6, 10.5, 12, 9.5, 2), 'M8.5 10.5V8a3.5 3.5 0 0 1 6.8-1.2'],
  filter: ['M4 6.5h16M7 12h10M10 17.5h4'],
  swap: ['M8 4.5v15M4.5 16L8 19.5l3.5-3.5M16 19.5v-15M12.5 8L16 4.5 19.5 8'],
  star: ['M12 3.8l2.5 5.2 5.7.8-4.1 4 1 5.7L12 16.8l-5.1 2.7 1-5.7-4.1-4 5.7-.8z'],

  // ---------------------------------------------------------------------------------------- status
  info: [CIRCLE, 'M12 11v6', dot(12, 7.6, 1.2)],
  help: [CIRCLE, 'M9.2 9.3a2.9 2.9 0 1 1 4.2 2.6c-.9.5-1.4 1.1-1.4 2.1v.3', dot(12, 17.3, 1.2)],
  warning: ['M12 4.2c.6 0 1.1.3 1.4.8l7 12.2c.6 1.1-.2 2.4-1.4 2.4H5c-1.2 0-2-1.3-1.4-2.4l7-12.2c.3-.5.8-.8 1.4-.8z', 'M12 9.5v4.3', dot(12, 16.7, 1.2)],
  error: [CIRCLE, 'M9 9l6 6M15 9l-6 6'],
  checkCircle: [CIRCLE, 'M8 12.3l2.7 2.7L16 9.5'],
  clock: [CIRCLE, 'M12 7v5l3.2 2'],
  bolt: ['M13 3L5 13.5h6L10 21l8.5-11h-6z'],

  // ------------------------------------------------------------------------------------- AI, media
  sparkle: [star4(11, 10.5, 6.5), star4(18.5, 18, 2.6)],
  sparkles: [star4(10, 13, 6.5), star4(18, 6.5, 3.2), star4(18.5, 18.5, 2)],
  wand: ['M4.2 17.8L13.5 8.5l2 2-9.3 9.3a1 1 0 0 1-1.4 0l-.6-.6a1 1 0 0 1 0-1.4zM11.5 10.5l2 2', 'M18 3.5v3M16.5 5h3M20 10.5v2M19 11.5h2M10.5 3.5v2M9.5 4.5h2'],
  agent: [rrect(4, 8, 16, 11.5, 3), 'M12 8V5', dot(12, 4, 1.3), dot(9.2, 13.5, 1.25), dot(14.8, 13.5, 1.25)],
  chat: ['M5.5 5h13A1.5 1.5 0 0 1 20 6.5V15a1.5 1.5 0 0 1-1.5 1.5H11l-4.5 3.5v-3.5h-1A1.5 1.5 0 0 1 4 15V6.5A1.5 1.5 0 0 1 5.5 5z'],
  image: [PANEL, 'M3.5 16l4.5-4.5 4 4 3-3 5.5 5.5', ring(15.5, 9, 1.6)],
  camera: ['M4 9a2 2 0 0 1 2-2h1.6a1 1 0 0 0 .8-.4l.9-1.2a1 1 0 0 1 .8-.4h3.8a1 1 0 0 1 .8.4l.9 1.2a1 1 0 0 0 .8.4H18a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z', ring(12, 13, 3.2)],
  film: [SQUARE, 'M8 4v16M16 4v16M4 9h4M4 15h4M16 9h4M16 15h4'],
  avatar: [SQUARE, ring(12, 10, 2.6), 'M6.8 19.7c.6-2.7 2.7-4.4 5.2-4.4s4.6 1.7 5.2 4.4'],

  // ------------------------------------------------------------------------------------- character
  face: [ring(12, 12, 8.5), dot(9, 10.6, 1.25), dot(15, 10.6, 1.25), 'M8.8 14.5c.8 1.3 1.9 2 3.2 2s2.4-.7 3.2-2'],
  hair: ['M12 4a7 7 0 0 0-7 7v6.5c0 1 .8 1.8 1.8 1.6l1.2-.3V12c1.8-.4 3.2-1.6 4-3.5.8 1.9 2.2 3.1 4 3.5v6.8l1.2.3c1 .2 1.8-.6 1.8-1.6V11a7 7 0 0 0-7-7z'],
  body: ['M9.5 3.5v2.3c0 .9-.6 1.6-1.5 1.9l-2.3.7A2.5 2.5 0 0 0 4 10.8v9.7h16v-9.7a2.5 2.5 0 0 0-1.7-2.4L16 7.7c-.9-.3-1.5-1-1.5-1.9V3.5', 'M8 12.5v8M16 12.5v8'],
  person: [PERSON],
  mouth: ['M3.5 12c2.5-3 5-4.2 6.5-3.2.8.5 1.3.9 2 .9s1.2-.4 2-.9c1.5-1 4 .2 6.5 3.2-2.3 3.4-5.2 5-8.5 5s-6.2-1.6-8.5-5z', 'M3.5 12c3 .9 5.8 1.3 8.5 1.3s5.5-.4 8.5-1.3'],
  eye: ['M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z', ring(12, 12, 3)],
  eyeOff: ['M4 4l16 16M9.9 9.9a3 3 0 0 0 4.2 4.2M6.6 6.9C4 8.6 2.5 12 2.5 12S6 18.5 12 18.5c1.9 0 3.5-.6 4.9-1.5M10 5.7c.6-.1 1.3-.2 2-.2 6 0 9.5 6.5 9.5 6.5s-.9 1.7-2.6 3.4'],
  eyeClosed: ['M3 10c2 3.2 5.2 5 9 5s7-1.8 9-5M12 15v3.5M6.8 13.6l-1.6 2.8M17.2 13.6l1.6 2.8'],

  // ---------------------------------------------------------------------------------------- rigging
  bone: [ring(6.5, 17.5, 2.3), 'M7.2 15.3l1-3.2L20 4l-8.1 11.8-3.2 1'],
  part: ['M12 3.8l7.8 5.4-3 9.3H7.2l-3-9.3z'],
  warp: ['M3.5 6c5.5 1.5 11.5 1.5 17 0M3.5 12c5.5 1.5 11.5 1.5 17 0M3.5 18c5.5 1.5 11.5 1.5 17 0M6.5 3.5c-1.5 5.5-1.5 11.5 0 17M12.5 4.5c-1.5 5-1.5 10.5 0 15.5M18.5 3.5c-1.5 5.5-1.5 11.5 0 17'],
  mesh: ['M4 19L12 4.5 20 19zM8 11.8h8M8 11.8l4 7.2 4-7.2'],
  param: ['M4 8h10M18 8h2M4 16h2M10 16h10', ring(16, 8, 2), ring(8, 16, 2)],
  sliders: ['M4 6.5h9M17 6.5h3M4 12h3M11 12h9M4 17.5h10M18 17.5h2', ring(15, 6.5, 2), ring(9, 12, 2), ring(16, 17.5, 2)],
  constraint: [ring(5, 18, 1.8), ring(11, 8.5, 1.8), 'M6 16.4l4-6.3M12.7 9.3l3.9 2', ring(19, 12.8, 2.5), dot(19, 12.8, 0.9)],
  physics: ['M8 4h8M12 4L8.8 14.6', ring(8, 17, 2.5), 'M14 19.5c2-.6 3.6-2 4.5-3.8'],
  layers: ['M12 3.5l8.5 4.5-8.5 4.5L3.5 8z', 'M3.5 12l8.5 4.5 8.5-4.5', 'M3.5 16l8.5 4.5 8.5-4.5'],
  texture: [SQUARE, 'M12 4v16M4 12h16', [`M4 6.5A2.5 2.5 0 0 1 6.5 4H12v8H4zM12 12h8v5.5a2.5 2.5 0 0 1-2.5 2.5H12z`, 'soft']],
  mask: [SQUARE, ring(12, 12, 4.2), [ring(12, 12, 4.2), 'soft']],
  model: ['M12 3l8 4.5v9L12 21l-8-4.5v-9z', 'M12 12l8-4.5M12 12v9M12 12L4 7.5'],
  keyframe: ['M12 4.5l7.5 7.5-7.5 7.5L4.5 12z'],
  keyframeFilled: [['M12 4.5l7.5 7.5-7.5 7.5L4.5 12z', 'fill'], 'M12 4.5l7.5 7.5-7.5 7.5L4.5 12z'],
  timeline: [rrect(4, 9, 16, 10.5, 2), 'M4 14.2h16M9.5 7V19.5', ['M7.3 3.5h4.4a.5.5 0 0 1 .4.8L9.9 7.2a.5.5 0 0 1-.8 0L6.9 4.3a.5.5 0 0 1 .4-.8z', 'fill']],
  target: [ring(12, 12, 5), 'M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4', dot(12, 12, 1.1)],
  move: ['M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3'],
  bounds: ['M8 4h8M8 20h8M4 8v8M20 8v8', dot(4, 4, 1.2), dot(20, 4, 1.2), dot(4, 20, 1.2), dot(20, 20, 1.2)],
  label: ['M4 6.5A1.5 1.5 0 0 1 5.5 5H14l6 7-6 7H5.5A1.5 1.5 0 0 1 4 17.5z'],
  grid: [SQUARE, 'M4 9.5h16M4 14.5h16M9.5 4v16M14.5 4v16'],

  // ------------------------------------------------------------------------------ files, workspace
  file: [DOCUMENT],
  document: [DOCUMENT],
  fileNew: [DOCUMENT, 'M12 12v5M9.5 14.5h5'],
  fileClose: [DOCUMENT, 'M10.2 12.7l3.6 3.6M13.8 12.7l-3.6 3.6'],
  folder: ['M3.5 7a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.5.7l1 1.1a1 1 0 0 0 .8.4h6.1a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z'],
  folderOpen: ['M3.5 17V7a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.5.7l1 1.1a1 1 0 0 0 .8.4h5.1a2 2 0 0 1 2 2v1.8', 'M3.5 17l2.2-5.1a1.5 1.5 0 0 1 1.4-.9h12.4a1 1 0 0 1 .9 1.4l-2.1 5.3a2 2 0 0 1-1.9 1.3H5a1.5 1.5 0 0 1-1.5-2z'],
  code: ['M8.5 7l-5 5 5 5M15.5 7l5 5-5 5'],
  terminal: [PANEL, 'M7.5 9.5l3 2.5-3 2.5M13 14.5h3.5'],
  sidebarLeft: [PANEL, 'M9.5 4.5v15M5.9 8.5h1.3M5.9 11.5h1.3'],
  sidebarRight: [PANEL, 'M14.5 4.5v15M16.8 8.5h1.3M16.8 11.5h1.3'],
  bottomPanel: [PANEL, 'M3.5 14.5h17'],
  settings: [gear(12, 12, 9.2, 7, 8), ring(12, 12, 3)],
  globe: [CIRCLE, 'M3 12h18M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.5-3.8-9S9.5 5.5 12 3z'],
  sun: [ring(12, 12, 4), 'M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4'],
  moon: ['M20 14.5A8.5 8.5 0 1 1 9.5 4 6.8 6.8 0 0 0 20 14.5z'],
  appearance: [CIRCLE, ['M12 3a9 9 0 0 1 0 18z', 'fill']],

  // ----------------------------------------------------------------------------------------- tools
  cursor: ['M5.5 4.5l5 14 2.3-5.7 5.7-2.3z'],
  hand: [
    'M8 14.5V6.2a1.3 1.3 0 0 1 2.6 0V11',
    'M10.6 10.5V4.8a1.3 1.3 0 0 1 2.6 0v5.7',
    'M13.2 10.8V5.8a1.3 1.3 0 0 1 2.6 0v5.7',
    'M15.8 11.5V8.3a1.3 1.3 0 0 1 2.6 0v6.2c0 3.6-2.6 6-6 6h-.8c-2 0-3.3-.8-4.5-2.3l-3-4a1.4 1.4 0 0 1 2.2-1.7L8 14.5',
  ],
} as const satisfies Record<string, readonly Shape[]>;

export type IconName = keyof typeof GLYPHS;

/** Every icon name, in the order of the source (grouped by purpose): for galleries and pickers. */
export const ICON_NAMES = Object.keys(GLYPHS) as IconName[];

export function isIconName(name: string): name is IconName {
  return Object.hasOwn(GLYPHS, name);
}

/** Stroke weight in grid units for a rendered size: heavier below 20 px so small icons stay crisp. */
export function iconStrokeWidth(size: number): number {
  return size < 20 ? 2 : 1.75;
}

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  /** Rendered width and height in px. Default 18; use 16 in dense rows, 20 in toolbars. */
  size?: number;
  /** Stroke weight in grid units (24 px grid). Default: see iconStrokeWidth. */
  strokeWidth?: number;
  /** Accessible name. Without it the icon is decorative (aria-hidden): label the control instead. */
  title?: string;
}

export function Icon({ name, size = 18, strokeWidth, title, className, ...rest }: IconProps) {
  const shapes: readonly Shape[] = GLYPHS[name];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth ?? iconStrokeWidth(size)}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ? `r2-icon ${className}` : 'r2-icon'}
      data-icon={name}
      {...(title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true })}
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {shapes.map((shape, i) =>
        typeof shape === 'string' ? (
          <path key={i} d={shape} />
        ) : (
          <path key={i} d={shape[0]} fill="currentColor" stroke="none" fillOpacity={shape[1] === 'soft' ? 0.28 : undefined} />
        ),
      )}
    </svg>
  );
}
