/**
 * Contact sheets: many images in one grid with captions and an optional title, so a parameter sweep
 * or an animation can be verified from a single picture. Pure TypeScript (browser-safe).
 *
 * Captions wrap onto up to CAPTION_MAX_LINES lines (subcaptions: SUBCAPTION_MAX_LINES) at natural
 * break points (spaces, then after "," or ";", then before "="); every cell's caption area is as tall
 * as the most wrapped caption, so the grid stays uniform. Only a caption that still does not fit is
 * abbreviated: parameter ids before "=" are shortened ("EyeL.,EyeR.=0.333") so the values stay
 * readable, and as a very last resort the text is cut with "..". The layout is a pure function of the
 * captions, the cell width and the options (deterministic).
 */
import type { ImageRGBA, RGBA } from '../core/types.js';
import { assertImage, blitImage, createImage, resizeNearest } from './image.js';
import { drawText, measureText, CELL_WIDTH } from './font.js';

export interface SheetCell {
  image: ImageRGBA;
  /** Caption under the cell; wrapped onto up to CAPTION_MAX_LINES lines to the cell width. */
  caption?: string;
  /**
   * Accent-colored line(s) under the caption (e.g. the animation events in this frame), wrapped onto
   * up to SUBCAPTION_MAX_LINES lines. The caption area gets them only when some cell has a subcaption.
   */
  subcaption?: string;
}

export interface SheetOptions {
  /** Cells per row (default ceil(sqrt(n))). */
  columns?: number;
  /** Space around and between cells in pixels (default 8). */
  padding?: number;
  /** Sheet color (default opaque dark gray). */
  background?: RGBA;
  /** Text drawn in a bar above the grid. */
  title?: string;
  /** Resample every cell image by this factor (nearest neighbour, default 1). */
  scale?: number;
  /** Integer magnification of caption/title text (default 1). */
  textScale?: number;
}

const DEFAULT_BACKGROUND: RGBA = [0.16, 0.16, 0.18, 1];
const CAPTION_GAP = 4;
/** Space between the caption and the subcaption lines. */
const SUBCAPTION_GAP = 2;
/** Space between two wrapped lines of one caption. */
const LINE_GAP = 2;
/** Most lines a caption wraps onto before it is abbreviated. */
export const CAPTION_MAX_LINES = 3;
/** Most lines a subcaption (events) wraps onto before it is cut. */
export const SUBCAPTION_MAX_LINES = 2;
/** Cells narrower than this many characters keep one truncated caption line (wrapping would be unreadable). */
const MIN_WRAP_CHARS = 4;

/** Characters of `textScale` text that fit in `width` pixels. */
function charsIn(width: number, textScale: number): number {
  return Math.max(0, Math.floor((width + textScale) / (CELL_WIDTH * textScale)));
}

/** Line breaks (LF, CRLF or CR) and surrounding blanks fold into one space. */
function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]\s*/g, ' ');
}

/** Cut a single line to `max` characters, marking the cut with "..". */
function cut(line: string, max: number): string {
  const chars = Array.from(line);
  if (chars.length <= max) return line;
  return max <= 2 ? chars.slice(0, Math.max(0, max)).join('') : chars.slice(0, max - 2).join('') + '..';
}

/** Truncate a single-line string so it fits `width` pixels, marking the cut with "..". */
function fit(text: string, width: number, textScale: number): string {
  return cut(oneLine(text), charsIn(width, textScale));
}

const len = (s: string): number => Array.from(s).length;

/**
 * Break points, most preferred first. Each splitter keeps every character: a piece ending in a space
 * ends a word, one ending in "," / ";" / ":" / "|" ends a list item, one starting with "=" starts a value.
 */
const SPLITTERS: Array<(s: string) => string[]> = [(s) => s.split(/(?<= )/), (s) => s.split(/(?<=[,;:|])/), (s) => s.split(/(?==)/)];
/** Splitter levels that keep "id=value" together (used once ids are abbreviated). */
const KEEP_VALUES = 2;

interface WrapMode {
  /** Splitters used: SPLITTERS.slice(0, levels). */
  levels: number;
  /** Split pieces without break points every `max` characters (else they stay too long). */
  hard: boolean;
}

/**
 * Pieces of `text` no longer than `max` characters (trailing spaces not counted), split at the most
 * preferred break points that are needed.
 */
function pieces(text: string, max: number, mode: WrapMode, level = 0): string[] {
  if (len(text.trimEnd()) <= max) return [text];
  if (level >= mode.levels) {
    if (!mode.hard) return [text];
    const chars = Array.from(text);
    const out: string[] = [];
    for (let i = 0; i < chars.length; i += max) out.push(chars.slice(i, i + max).join(''));
    return out;
  }
  const parts = SPLITTERS[level](text).filter((p) => p !== '');
  return parts.flatMap((p) => pieces(p, max, mode, level + 1));
}

/** Greedy line filling: each line takes pieces while they fit (a trailing space may overhang). */
function pack(parts: string[], max: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const p of parts) {
    if (line !== '' && len((line + p).trimEnd()) > max) {
      lines.push(line.trimEnd());
      line = p.trimStart();
    } else {
      line += line === '' ? p.trimStart() : p;
    }
  }
  if (line.trimEnd() !== '') lines.push(line.trimEnd());
  return lines;
}

/** Wrapped lines when they fit `maxLines` lines of `max` characters, else null. */
function tryWrap(text: string, max: number, maxLines: number, mode: WrapMode): string[] | null {
  const lines = pack(pieces(text, max, mode), max);
  return lines.length <= maxLines && lines.every((l) => len(l) <= max) ? lines : null;
}

/** The ids before "=" in the "id=value" / "a,b=value" words of a caption. */
function captionIds(text: string): string[] {
  return text.split(' ').flatMap((word) => {
    const eq = word.indexOf('=');
    return eq > 0 ? word.slice(0, eq).split(',') : [];
  });
}

/**
 * "EyeLOpen,EyeROpen=0.333 AngleX=-30" with every id before a "=" cut to `keep` characters plus "."
 * ("EyeL.,EyeR.=0.333 Angl.=-30" for keep 4); ids that would not get shorter stay, values never change.
 */
function abbreviateIds(text: string, keep: number): string {
  const short = (id: string) => {
    const chars = Array.from(id);
    return chars.length <= keep + 1 ? id : chars.slice(0, keep).join('') + '.';
  };
  return text
    .split(' ')
    .map((word) => {
      const eq = word.indexOf('=');
      return eq > 0 ? word.slice(0, eq).split(',').map(short).join(',') + word.slice(eq) : word;
    })
    .join(' ');
}

/** `line` cut so that it plus a ".." mark fits `max` characters. */
function ellipsize(line: string, max: number): string {
  const chars = Array.from(line);
  return max <= 2 ? chars.slice(0, max).join('') : chars.slice(0, Math.min(chars.length, max - 2)).join('') + '..';
}

/**
 * Lines of a caption drawn `width` px wide: the text itself when it fits one line, else wrapped at
 * natural break points onto at most `maxLines` lines; if that is not enough, the parameter ids before
 * "=" are shortened step by step (values are never shortened), then words are split mid-way, and only
 * then is the last line cut with "..". Line breaks in the text count as spaces. Cells narrower than
 * 4 characters get one truncated line. Empty text gives no lines.
 */
export function wrapCaption(text: string, width: number, opts: { textScale?: number; maxLines?: number } = {}): string[] {
  const textScale = Math.max(1, Math.floor(opts.textScale ?? 1));
  const maxLines = Math.max(1, Math.floor(opts.maxLines ?? CAPTION_MAX_LINES));
  const line = oneLine(text).trim();
  if (line === '') return [];
  const max = charsIn(width, textScale);
  if (len(line) <= max) return [line];
  if (max < MIN_WRAP_CHARS || maxLines === 1) return [cut(line, max)];
  const soft: WrapMode = { levels: SPLITTERS.length, hard: false };
  const wrapped = tryWrap(line, max, maxLines, soft);
  if (wrapped) return wrapped;
  // Shorten ids as little as needed (keep = longest id length - 2 down to 1), first keeping each
  // "id=value" on one line, then also breaking before "=".
  const keeps: number[] = [];
  for (let keep = Math.max(0, ...captionIds(line).map(len)) - 2; keep >= 1; keep--) keeps.push(keep);
  for (const mode of [{ levels: KEEP_VALUES, hard: false }, soft]) {
    for (const keep of keeps) {
      const lines = tryWrap(abbreviateIds(line, keep), max, maxLines, mode);
      if (lines) return lines;
    }
  }
  const all: WrapMode = { levels: SPLITTERS.length, hard: true };
  const hard = tryWrap(line, max, maxLines, all);
  if (hard) return hard;
  // Last resort: the shortest form, wrapped, with the lines that do not fit dropped and the cut marked.
  const lines = pack(pieces(keeps.length ? abbreviateIds(line, 1) : line, max, all), max);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = ellipsize(kept[maxLines - 1], max);
  return kept;
}

function luminance(bg: RGBA): number {
  return (0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2]) * bg[3];
}

/** Legible text color for a background: dark on light, light on dark (transparent counts as dark). */
function contrastText(bg: RGBA): RGBA {
  return luminance(bg) > 0.5 ? [0.08, 0.08, 0.1, 1] : [0.92, 0.92, 0.94, 1];
}

/** Legible accent color for subcaptions: amber on dark, dark orange on light. */
function accentText(bg: RGBA): RGBA {
  return luminance(bg) > 0.5 ? [0.6, 0.3, 0, 1] : [1, 0.78, 0.3, 1];
}

/** Caption texts of the cells (undefined = none), or just whether some cell has one. */
type CaptionTexts = boolean | ReadonlyArray<string | undefined>;

interface CaptionLayout {
  /** Wrapped lines per cell (empty arrays when the texts are not known). */
  captions: string[][];
  subcaptions: string[][];
  /** Lines reserved in every cell's caption area. */
  captionRows: number;
  subRows: number;
  /** Height of the caption area under every cell (0 without captions). */
  height: number;
}

function textsOf(texts: CaptionTexts | undefined, fallback: boolean): { any: boolean; list: ReadonlyArray<string | undefined> } {
  if (Array.isArray(texts)) return { any: texts.some((t) => t), list: texts };
  return { any: texts === undefined ? fallback : texts === true, list: [] };
}

/**
 * Where the caption lines go: every cell reserves as many lines as the most wrapped caption (and
 * subcaption) needs, so rows stay aligned. Boolean inputs (texts unknown) reserve one line each.
 */
function layoutCaptions(captions: CaptionTexts | undefined, subcaptions: CaptionTexts | undefined, cellW: number, textScale: number): CaptionLayout {
  const cap = textsOf(captions, true);
  const sub = textsOf(subcaptions, false);
  const wrapAll = (list: ReadonlyArray<string | undefined>, maxLines: number) => list.map((t) => (t ? wrapCaption(t, cellW, { textScale, maxLines }) : []));
  const capLines = wrapAll(cap.list, CAPTION_MAX_LINES);
  const subLines = wrapAll(sub.list, SUBCAPTION_MAX_LINES);
  const most = (lines: string[][], any: boolean) => (any ? Math.max(1, ...lines.map((l) => l.length)) : 0);
  const subRows = most(subLines, sub.any);
  const captionRows = cap.any || subRows ? most(capLines, true) : 0;
  const lineH = measureText('X', { scale: textScale }).height;
  const block = (n: number) => (n ? n * lineH + (n - 1) * LINE_GAP : 0);
  const height = captionRows ? CAPTION_GAP + block(captionRows) + (subRows ? SUBCAPTION_GAP + block(subRows) : 0) : 0;
  return { captions: capLines, subcaptions: subLines, captionRows, subRows, height };
}

export interface SheetSizeOptions extends Pick<SheetOptions, 'columns' | 'padding' | 'title' | 'textScale'> {
  /**
   * The cells' captions (wrapped to the cell width exactly like composeSheet does, so the size is
   * exact), or just whether some cell has one (default true; reserves one line).
   */
  captions?: CaptionTexts;
  /** The cells' subcaptions, or whether some cell has one (reserves one line). */
  subcaptions?: CaptionTexts;
}

/**
 * Pixel size of the sheet composeSheet makes from `count` cells of at most cellW x cellH px (after
 * its own `scale`), with the same options: lets callers pick a cell scale before rendering any cell.
 * Pass the caption texts for an exact height (wrapped captions make the caption area taller).
 */
export function sheetSize(count: number, cellW: number, cellH: number, opts: SheetSizeOptions = {}): { width: number; height: number; columns: number; rows: number } {
  const n = Math.max(1, count);
  const columns = Math.max(1, Math.min(n, Math.floor(opts.columns ?? Math.ceil(Math.sqrt(n)))));
  const rows = Math.ceil(n / columns);
  const pad = Math.max(0, Math.round(opts.padding ?? 8));
  const textScale = Math.max(1, Math.floor(opts.textScale ?? 1));
  const lineH = measureText('X', { scale: textScale }).height;
  const captionH = layoutCaptions(opts.captions, opts.subcaptions, cellW, textScale).height;
  const titleH = opts.title ? lineH + pad : 0;
  return { width: columns * cellW + (columns + 1) * pad, height: titleH + rows * (cellH + captionH) + (rows + 1) * pad, columns, rows };
}

/**
 * Compose cells into one image: a grid of cells (images centered), a caption (and optional
 * subcaption) under each, wrapped to the cell width, and an optional title bar.
 */
export function composeSheet(cells: SheetCell[], opts: SheetOptions = {}): ImageRGBA {
  if (cells.length === 0) throw new Error('composeSheet: no cells');
  cells.forEach((c, i) => assertImage(c.image, `composeSheet: cell ${i}`));
  const n = cells.length;
  for (const key of ['columns', 'padding', 'scale', 'textScale'] as const) {
    const v = opts[key];
    if (v !== undefined && !Number.isFinite(v)) throw new RangeError(`composeSheet: ${key} must be a finite number, got ${v}`);
  }
  const columns = Math.max(1, Math.min(n, Math.floor(opts.columns ?? Math.ceil(Math.sqrt(n)))));
  const rows = Math.ceil(n / columns);
  const pad = Math.max(0, Math.round(opts.padding ?? 8));
  const scale = opts.scale ?? 1;
  if (!(scale > 0)) throw new RangeError(`composeSheet: scale must be positive, got ${scale}`);
  const textScale = Math.max(1, Math.floor(opts.textScale ?? 1));
  const background = opts.background ?? DEFAULT_BACKGROUND;
  const ink = contrastText(background);

  const images = cells.map(({ image }) =>
    scale === 1
      ? image
      : resizeNearest(
          image,
          Math.max(1, Math.round(image.width * scale)),
          Math.max(1, Math.round(image.height * scale)),
        ),
  );
  const cellW = Math.max(...images.map((i) => i.width));
  const cellH = Math.max(...images.map((i) => i.height));
  const lineH = measureText('X', { scale: textScale }).height;
  const layout = layoutCaptions(
    cells.map((c) => c.caption),
    cells.map((c) => c.subcaption),
    cellW,
    textScale,
  );
  const captionH = layout.height;
  const titleH = opts.title ? lineH + pad : 0;
  const width = columns * cellW + (columns + 1) * pad;
  const height = titleH + rows * (cellH + captionH) + (rows + 1) * pad;

  const sheet = createImage(width, height, background);
  if (opts.title) drawText(sheet, pad, pad, fit(opts.title, width - 2 * pad, textScale), ink, { scale: textScale });
  const centered = (lines: string[], x: number, y: number, color: RGBA) => {
    lines.forEach((text, k) => {
      const tw = measureText(text, { scale: textScale }).width;
      drawText(sheet, x + Math.floor((cellW - tw) / 2), y + k * (lineH + LINE_GAP), text, color, { scale: textScale });
    });
  };
  images.forEach((img, i) => {
    const x = pad + (i % columns) * (cellW + pad);
    const y = titleH + pad + Math.floor(i / columns) * (cellH + captionH + pad);
    blitImage(sheet, img, x + Math.floor((cellW - img.width) / 2), y + Math.floor((cellH - img.height) / 2));
    const top = y + cellH + CAPTION_GAP;
    centered(layout.captions[i], x, top, ink);
    const subTop = top + layout.captionRows * lineH + (layout.captionRows - 1) * LINE_GAP + SUBCAPTION_GAP;
    centered(layout.subcaptions[i], x, subTop, accentText(background));
  });
  return sheet;
}
