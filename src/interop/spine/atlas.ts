/**
 * Spine texture atlas (.atlas) reader and writer, implemented from the public atlas format
 * documentation. Two dialects exist:
 *
 * - Spine 4.x: page fields `size`, `format`, `filter`, `repeat`, `pma`, `scale`; region fields
 *   `bounds: x, y, w, h`, `offsets: left, bottom, originalW, originalH`, `rotate: 90` (degrees),
 *   `index`, `split`, `pad` and arbitrary named number lists.
 * - Legacy (libGDX / Spine 3.x): a leading blank line, unindented page fields and indented region
 *   fields `rotate: true|false`, `xy`, `size`, `orig`, `offset`, `index` (+ `split`, `pad`).
 *
 * The reader accepts both (and mixtures): after a blank line (or at the start) the first line names a
 * page, `key: values` lines after it are page fields until a line without a colon names a region, and
 * `key: values` lines after a region name are that region's fields. Indentation is ignored.
 *
 * Region geometry: `x, y` is the top-left of the packed pixels on the page; `width, height` is the
 * packed size in the image's ORIGINAL orientation (so a region rotated by 90 or 270 degrees occupies
 * `height x width` page pixels). Whitespace stripping keeps `offsetX` (pixels removed at the left) and
 * `offsetY` (pixels removed at the BOTTOM) within an original image of `originalWidth x originalHeight`.
 * A region rotated by 90 degrees has the image's top edge along the left edge of its page rect,
 * running upwards (the image was turned a quarter turn counter-clockwise on the page).
 */

export interface AtlasPage {
  /** Image file name as written in the atlas, e.g. "spineboy.png". */
  name: string;
  /** Page size in pixels (0 when the atlas does not say; use the image size then). */
  width: number;
  height: number;
  format?: string;
  minFilter?: string;
  magFilter?: string;
  /** "none" | "x" | "y" | "xy" */
  repeat?: string;
  /** Premultiplied alpha (4.x `pma: true`). Legacy atlases never say. */
  pma: boolean;
  /** 4.x `scale` (the packer's scale; informational). */
  scale?: number;
  /** Unknown page fields, verbatim. */
  extra?: Record<string, string[]>;
}

export interface AtlasRegion {
  name: string;
  /** Index into Atlas.pages. */
  page: number;
  /** Top-left of the packed pixels on the page. */
  x: number;
  y: number;
  /** Packed size in the original orientation. */
  width: number;
  height: number;
  /** Whitespace stripped at the left / bottom of the original image. */
  offsetX: number;
  offsetY: number;
  originalWidth: number;
  originalHeight: number;
  /** Rotation of the packed pixels: 0, 90, 180 or 270. */
  degrees: number;
  /** Frame index for regions sharing a name (-1 = none). */
  index: number;
  /** Nine-patch splits [left, right, top, bottom]. */
  splits?: number[];
  /** Nine-patch pads [left, right, top, bottom]. */
  pads?: number[];
  /** Other named values (4.x), verbatim numbers. */
  extra?: Record<string, number[]>;
}

export interface Atlas {
  pages: AtlasPage[];
  regions: AtlasRegion[];
}

export class AtlasParseError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`atlas line ${line}: ${message}`);
    this.name = 'AtlasParseError';
  }
}

interface Entry {
  key: string;
  values: string[];
}

function readEntry(line: string): Entry | null {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const key = line.slice(0, colon).trim();
  if (!key) return null;
  const values = line
    .slice(colon + 1)
    .split(',')
    .map((v) => v.trim());
  return { key, values };
}

function nums(e: Entry, count: number, lineNo: number): number[] {
  if (e.values.length < count) throw new AtlasParseError(`"${e.key}" needs ${count} values, got ${e.values.length}`, lineNo);
  return e.values.slice(0, count).map((v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new AtlasParseError(`"${e.key}" has a non-numeric value "${v}"`, lineNo);
    return n;
  });
}

function rotationDegrees(value: string, lineNo: number): number {
  const v = value.toLowerCase();
  if (v === 'true') return 90;
  if (v === 'false') return 0;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new AtlasParseError(`"rotate" must be true, false or degrees, got "${value}"`, lineNo);
  return ((Math.round(n) % 360) + 360) % 360;
}

/** Parse atlas text (4.x or legacy dialect). Throws AtlasParseError on malformed values. */
export function parseAtlas(text: string): Atlas {
  const pages: AtlasPage[] = [];
  const regions: AtlasRegion[] = [];
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r?\n/);
  let page: AtlasPage | null = null;
  let region: AtlasRegion | null = null;
  const finish = () => {
    if (region) {
      if (region.originalWidth === 0 && region.originalHeight === 0) {
        region.originalWidth = region.width;
        region.originalHeight = region.height;
      }
      regions.push(region);
    }
    region = null;
  };
  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    const line = raw.trim();
    if (line === '') {
      finish();
      page = null;
      return;
    }
    if (page === null) {
      page = { name: line, width: 0, height: 0, pma: false };
      pages.push(page);
      return;
    }
    const entry = readEntry(line);
    if (!entry) {
      finish();
      region = {
        name: line,
        page: pages.length - 1,
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        offsetX: 0,
        offsetY: 0,
        originalWidth: 0,
        originalHeight: 0,
        degrees: 0,
        index: -1,
      };
      return;
    }
    if (region === null) readPageField(page, entry, lineNo);
    else readRegionField(region, entry, lineNo);
  });
  finish();
  return { pages, regions };
}

function readPageField(page: AtlasPage, e: Entry, lineNo: number): void {
  switch (e.key) {
    case 'size':
      [page.width, page.height] = nums(e, 2, lineNo);
      return;
    case 'format':
      page.format = e.values[0];
      return;
    case 'filter':
      page.minFilter = e.values[0];
      page.magFilter = e.values[1] ?? e.values[0];
      return;
    case 'repeat':
      page.repeat = e.values[0];
      return;
    case 'pma':
      page.pma = e.values[0]?.toLowerCase() === 'true';
      return;
    case 'scale':
      [page.scale] = nums(e, 1, lineNo);
      return;
    default:
      (page.extra ??= {})[e.key] = e.values;
  }
}

function readRegionField(r: AtlasRegion, e: Entry, lineNo: number): void {
  switch (e.key) {
    case 'xy':
      [r.x, r.y] = nums(e, 2, lineNo);
      return;
    case 'size':
      [r.width, r.height] = nums(e, 2, lineNo);
      return;
    case 'bounds':
      [r.x, r.y, r.width, r.height] = nums(e, 4, lineNo);
      return;
    case 'offset':
      [r.offsetX, r.offsetY] = nums(e, 2, lineNo);
      return;
    case 'orig':
      [r.originalWidth, r.originalHeight] = nums(e, 2, lineNo);
      return;
    case 'offsets':
      [r.offsetX, r.offsetY, r.originalWidth, r.originalHeight] = nums(e, 4, lineNo);
      return;
    case 'rotate':
      r.degrees = rotationDegrees(e.values[0] ?? '', lineNo);
      return;
    case 'index':
      [r.index] = nums(e, 1, lineNo);
      return;
    case 'split':
      r.splits = nums(e, 4, lineNo);
      return;
    case 'pad':
      r.pads = nums(e, 4, lineNo);
      return;
    default:
      (r.extra ??= {})[e.key] = nums(e, e.values.length, lineNo);
  }
}

/** First region with this name (and frame index, when given). */
export function findRegion(atlas: Atlas, name: string, index?: number): AtlasRegion | undefined {
  return atlas.regions.find((r) => r.name === name && (index === undefined || r.index === index));
}

/** Page pixels occupied by the region: [x, y, w, h] (w/h swapped for 90 / 270 degrees). */
export function regionPageRect(r: AtlasRegion): [number, number, number, number] {
  const turned = r.degrees === 90 || r.degrees === 270;
  return [r.x, r.y, turned ? r.height : r.width, turned ? r.width : r.height];
}

/**
 * Where a point of the ORIGINAL image (pixels, origin top-left, y down; 0..originalWidth x
 * 0..originalHeight) lies on the page (pixels). Points in stripped whitespace extrapolate linearly,
 * like texture coordinates do.
 */
export function regionImageToPage(r: AtlasRegion, px: number, py: number): [number, number] {
  // Coordinates within the packed (stripped) pixels, in the original orientation.
  const cx = px - r.offsetX;
  const cy = py - (r.originalHeight - r.offsetY - r.height);
  switch (r.degrees) {
    case 90:
      return [r.x + cy, r.y + r.width - cx];
    case 180:
      return [r.x + r.width - cx, r.y + r.height - cy];
    case 270:
      return [r.x + r.height - cy, r.y + cx];
    default:
      return [r.x + cx, r.y + cy];
  }
}

/** Inverse of regionImageToPage: page pixel -> original image pixel. */
export function regionPageToImage(r: AtlasRegion, qx: number, qy: number): [number, number] {
  let cx: number;
  let cy: number;
  switch (r.degrees) {
    case 90:
      cx = r.width - (qy - r.y);
      cy = qx - r.x;
      break;
    case 180:
      cx = r.width - (qx - r.x);
      cy = r.height - (qy - r.y);
      break;
    case 270:
      cx = qy - r.y;
      cy = r.height - (qx - r.x);
      break;
    default:
      cx = qx - r.x;
      cy = qy - r.y;
  }
  return [cx + r.offsetX, cy + r.originalHeight - r.offsetY - r.height];
}

// ----------------------------------------------------------------------------- writer

export interface WriteAtlasOptions {
  /** "4" (default): Spine 4.x dialect. "legacy": libGDX / Spine 3.x dialect. */
  dialect?: '4' | 'legacy';
}

function num(n: number): string {
  return String(Math.round(n * 1e6) / 1e6);
}

/** Serialize an atlas. Regions are written under their page, in array order. */
export function writeAtlas(atlas: Atlas, opts: WriteAtlasOptions = {}): string {
  const legacy = opts.dialect === 'legacy';
  const out: string[] = [];
  atlas.pages.forEach((page, p) => {
    if (legacy || p > 0) out.push('');
    out.push(page.name);
    const field = (key: string, values: Array<string | number>) =>
      out.push(`${legacy ? '' : '\t'}${key}: ${values.map((v) => (typeof v === 'number' ? num(v) : v)).join(legacy ? ',' : ', ')}`);
    if (page.width > 0 && page.height > 0) field('size', [page.width, page.height]);
    if (legacy || page.format) field('format', [page.format ?? 'RGBA8888']);
    if (legacy || page.minFilter) field('filter', [page.minFilter ?? 'Linear', page.magFilter ?? page.minFilter ?? 'Linear']);
    if (legacy || (page.repeat && page.repeat !== 'none')) field('repeat', [page.repeat ?? 'none']);
    if (!legacy && page.pma) field('pma', ['true']);
    if (!legacy && page.scale !== undefined && page.scale !== 1) field('scale', [page.scale]);
    for (const [k, v] of Object.entries(page.extra ?? {})) field(k, v);
    for (const r of atlas.regions) {
      if (r.page !== p) continue;
      out.push(r.name);
      const rf = (key: string, values: Array<string | number>) =>
        out.push(`${legacy ? '  ' : '\t'}${key}: ${values.map((v) => (typeof v === 'number' ? num(v) : v)).join(', ')}`);
      const trimmed = r.offsetX !== 0 || r.offsetY !== 0 || r.originalWidth !== r.width || r.originalHeight !== r.height;
      if (legacy) {
        rf('rotate', [r.degrees === 90 ? 'true' : r.degrees === 0 ? 'false' : r.degrees]);
        rf('xy', [r.x, r.y]);
        rf('size', [r.width, r.height]);
        if (r.splits) rf('split', r.splits);
        if (r.pads) rf('pad', r.pads);
        rf('orig', [r.originalWidth, r.originalHeight]);
        rf('offset', [r.offsetX, r.offsetY]);
        rf('index', [r.index]);
      } else {
        rf('bounds', [r.x, r.y, r.width, r.height]);
        if (trimmed) rf('offsets', [r.offsetX, r.offsetY, r.originalWidth, r.originalHeight]);
        if (r.degrees !== 0) rf('rotate', [r.degrees]);
        if (r.index !== -1) rf('index', [r.index]);
        if (r.splits) rf('split', r.splits);
        if (r.pads) rf('pad', r.pads);
      }
      for (const [k, v] of Object.entries(r.extra ?? {})) rf(k, v);
    }
  });
  return out.join('\n') + '\n';
}
