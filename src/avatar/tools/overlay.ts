/**
 * Landmark overlay: the parts of an avatar spec (describeAvatarParts) drawn over the illustration
 * in their group colours, so an agent or a person can SEE whether the polygons sit on the eyes, the
 * ellipse covers the head, the strands follow the hair.
 *
 *   avatarOverlay(source, doc)                          everything that is placed, with a legend
 *   avatarOverlay(source, doc, {part: 'eyes'})          one group, every item labelled with its id
 *   avatarOverlay(source, doc, {part: 'eyes.imageLeft', zoom: true})
 *                                                       cropped to those items plus a margin and
 *                                                       magnified; polygon and polyline vertices are
 *                                                       numbered from 0 (the index into the point list)
 *
 * `doc` is the RAW avatar.json value and may be an unfinished draft: what is not placed is skipped
 * and listed in the result. The rulers on all four sides are in source pixel coordinates, so a
 * vertex that is off can be corrected straight from the picture.
 *
 * How shapes are drawn: ellipses with a small cross at their centre; polygons closed; polylines
 * (strands, brows) open with a ring at their first point (the root); points as a ring around a dot;
 * a band as a solid line at yStart and a dashed line at yEnd; a segment (mouth corners, pendulum
 * pivot -> tip) as a line from a ring (first point) to a dot.
 */
import type { ImageRGBA } from '../../core/types.js';
import { fillRect, strokeRect } from '../../render/draw.js';
import { drawText, measureText } from '../../render/font.js';
import { didYouMean, formatList } from '../../core/validate/text.js';
import { describeAvatarParts, resolveShape, type AvatarPartGroupInfo, type AvatarPartItemInfo, type ResolvedShape } from '../parts.js';
import { ellipseBounds, ellipseOutline, pointCount, pointsBounds, polygonCentroid, unionBounds, type Bounds, type Vec2 } from './geometry.js';
import { AvatarToolError, createSourceView, dotOutput, drawFooterText, drawRulers, RULER_TEXT, strokeOutput, tagBox, tagOutput, type SourceRegion, type SourceView } from './view.js';

export interface OverlayOptions {
  /**
   * What to draw: a group id ("eyes", "strands", ...) or the start of an item id ("eyes.imageLeft",
   * "strand.bang1", "attachment.tassel"). Default: every group.
   */
  part?: string;
  /** Crop to the bounding box of what is drawn plus a margin, magnified, with numbered vertices. */
  zoom?: boolean;
  /** Output px per source px, a whole number (default: chosen so the long side is about 1000-1600 px). */
  scale?: number;
  /** Also draw the coordinate grid lines of avatarGrid over the picture (default: ruler ticks only). */
  grid?: boolean;
}

export interface OverlayResult {
  image: ImageRGBA;
  /** Source rectangle shown. */
  region: SourceRegion;
  /** Output px per source px. */
  scale: number;
  /** Output pixel of the source point (region x0, y0). */
  origin: [number, number];
  /** Ids of the items that were drawn. */
  drawn: string[];
  /** Ids of the selected REQUIRED items that are not placed yet (nothing to draw). */
  missing: string[];
}

interface Selected {
  group: AvatarPartGroupInfo;
  item: AvatarPartItemInfo;
  shape: ResolvedShape;
}

function select(groups: AvatarPartGroupInfo[], part: string | undefined): Array<{ group: AvatarPartGroupInfo; item: AvatarPartItemInfo }> {
  const all = groups.flatMap((group) => group.items.map((item) => ({ group, item })));
  if (part === undefined) return all;
  const group = groups.find((g) => g.id === part);
  if (group) return all.filter((s) => s.group === group);
  const items = all.filter((s) => s.item.id === part || s.item.id.startsWith(`${part}.`));
  if (items.length) return items;
  const names = [...groups.map((g) => g.id as string), ...new Set(all.flatMap((s) => prefixes(s.item.id)))];
  throw new AvatarToolError(`unknown part "${part}"`, `${didYouMean(part, names) ?? ''} groups: ${groups.map((g) => g.id).join(', ')}; or the start of an item id: ${formatList([...new Set(all.map((s) => s.item.id))], 14)}`.trim());
}

/** "eyes.imageLeft.opening" -> ["eyes.imageLeft", "eyes.imageLeft.opening"] (the group prefix alone is a group id). */
function prefixes(id: string): string[] {
  const parts = id.split('.');
  return parts.slice(1).map((_, i) => parts.slice(0, i + 2).join('.'));
}

function shapeBounds(shape: ResolvedShape): Bounds | null {
  switch (shape.type) {
    case 'point':
      return [shape.at[0], shape.at[1], shape.at[0], shape.at[1]];
    case 'ellipse':
      return ellipseBounds(shape.center, shape.radius, shape.rotation);
    case 'polygon':
    case 'polyline':
      return pointsBounds(shape.points);
    case 'segment':
      return pointsBounds([...shape.a, ...shape.b]);
    case 'band':
      return null;
  }
}

function zoomRegion(source: ImageRGBA, selected: Selected[]): SourceRegion {
  let box: Bounds | null = null;
  for (const s of selected) box = unionBounds(box, shapeBounds(s.shape));
  for (const s of selected) {
    if (s.shape.type !== 'band') continue;
    // A band has no width of its own: the rows of the band, across what else is shown (or the image).
    const rows: Bounds = [box ? box[0] : 0, Math.min(...s.shape.range), box ? box[2] : source.width, Math.max(...s.shape.range)];
    box = unionBounds(box, rows);
  }
  if (!box) return [0, 0, source.width, source.height];
  const margin = Math.max(12, 0.14 * Math.max(box[2] - box[0], box[3] - box[1]));
  return [box[0] - margin, box[1] - margin, box[2] + margin, box[3] + margin];
}

type Box = [number, number, number, number];

/**
 * Places item labels so that they cover neither each other nor the vertex numbers: a taken spot
 * moves the label up or down in steps of its own height.
 */
class Labels {
  private readonly boxes: Box[] = [];
  private readonly pending: Array<{ x: number; y: number; text: string; color: string }> = [];
  constructor(private readonly view: SourceView) {}

  /** A box labels must keep clear of (a vertex number that is already drawn). */
  reserve(box: Box): void {
    this.boxes.push(box);
  }

  /** Queue an item label; flush() draws them once every vertex number is known. */
  add(x: number, y: number, text: string, color: string): void {
    this.pending.push({ x, y, text, color });
  }

  private free(box: Box): boolean {
    return !this.boxes.some((b) => box[0] < b[0] + b[2] && box[0] + box[2] > b[0] && box[1] < b[1] + b[3] && box[1] + box[3] > b[1]);
  }

  flush(): void {
    for (const label of this.pending) {
      const scale = this.view.textScale;
      const h = tagBox(this.view, label.x, label.y, label.text, scale, true)[3] + 1;
      let y = label.y;
      for (const step of [0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5, -6, 6]) {
        y = label.y + step * h;
        if (this.free(tagBox(this.view, label.x, y, label.text, scale, true))) break;
      }
      this.boxes.push(tagOutput(this.view, label.x, y, label.text, scale, label.color));
    }
    this.pending.length = 0;
  }
}

function mapPoints(view: SourceView, points: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < points.length; i += 2) out.push(...view.toOutput(points[i], points[i + 1]));
  return out;
}

function drawShape(view: SourceView, s: Selected, labels: Labels | null, numbered: boolean): void {
  const color = s.group.color;
  const ts = view.textScale;
  const width = Math.max(2, Math.round(1.25 * ts));
  const id = s.item.id;
  const shape = s.shape;
  switch (shape.type) {
    case 'point': {
      const [x, y] = view.toOutput(shape.at[0], shape.at[1]);
      dotOutput(view, x, y, 4 * ts, color, true);
      dotOutput(view, x, y, Math.max(1, ts * 0.75), color);
      labels?.add(x + 6 * ts, y - 5 * ts, id, color);
      break;
    }
    case 'ellipse': {
      const outline = mapPoints(view, ellipseOutline(shape.center, shape.radius, shape.rotation, 144));
      strokeOutput(view, outline, color, width, true);
      const [cx, cy] = view.toOutput(shape.center[0], shape.center[1]);
      const arm = 4 * ts;
      strokeOutput(view, [cx - arm, cy, cx + arm, cy], color, width);
      strokeOutput(view, [cx, cy - arm, cx, cy + arm], color, width);
      const top = Math.min(...outline.filter((_, i) => i % 2 === 1));
      labels?.add(cx - (measureText(id, { scale: ts }).width + 2 * ts) / 2, top - 11 * ts, id, color);
      break;
    }
    case 'polygon':
    case 'polyline': {
      const pts = mapPoints(view, shape.points);
      const closed = shape.type === 'polygon';
      strokeOutput(view, pts, color, width, closed);
      const n = pointCount(pts);
      if (!closed) dotOutput(view, pts[0], pts[1], 4 * ts, color, true);
      if (numbered || !closed) for (let i = 0; i < n; i++) dotOutput(view, pts[i * 2], pts[i * 2 + 1], Math.max(1.5, ts), color);
      if (numbered) numberVertices(view, pts, labels);
      const b = pointsBounds(pts)!;
      if (closed) labels?.add(b[0], b[1] - 11 * ts, id, color);
      else labels?.add(pts[0] + 6 * ts, pts[1] - 10 * ts, id, color);
      break;
    }
    case 'segment': {
      const a = view.toOutput(shape.a[0], shape.a[1]);
      const b = view.toOutput(shape.b[0], shape.b[1]);
      strokeOutput(view, [...a, ...b], color, width);
      dotOutput(view, a[0], a[1], 3 * ts, color, true);
      dotOutput(view, b[0], b[1], 2 * ts, color);
      labels?.add((a[0] + b[0]) / 2 + 4 * ts, Math.min(a[1], b[1]) - 11 * ts, id, color);
      break;
    }
    case 'band': {
      const [x0, , x1] = view.region;
      const rows: Array<[number, boolean, string]> = [
        [shape.range[0], false, `${id} yStart ${Number(shape.range[0].toFixed(1))}`],
        [shape.range[1], true, `${id} yEnd ${Number(shape.range[1].toFixed(1))}`],
      ];
      for (const [y, dashed, text] of rows) {
        const a = view.toOutput(x0, y);
        const b = view.toOutput(x1, y);
        strokeOutput(view, [...a, ...b], color, width, false, dashed ? [10 * ts, 7 * ts] : undefined);
        // Bands are labelled even in the overview: two bare lines across the picture explain nothing.
        if (labels) labels.add(a[0] + 3 * ts, a[1] - 11 * ts, text, color);
        else tagOutput(view, a[0] + 3 * ts, a[1] - 11 * ts, text, ts, color);
      }
      break;
    }
  }
}

/** Vertex indices beside the vertices, on the side away from the centre of the shape. */
function numberVertices(view: SourceView, pts: number[], labels: Labels | null): void {
  const n = pointCount(pts);
  const centre = polygonCentroid(pts);
  // Smaller digits when neighbouring vertices are close together on screen.
  let spacing = Infinity;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const d = Math.sqrt((pts[j * 2] - pts[i * 2]) ** 2 + (pts[j * 2 + 1] - pts[i * 2 + 1]) ** 2);
    if (d > 0 && d < spacing) spacing = d;
  }
  const scale = spacing >= 16 * view.textScale ? view.textScale : Math.max(1, view.textScale - 1);
  for (let i = 0; i < n; i++) {
    const x = pts[i * 2];
    const y = pts[i * 2 + 1];
    let dx = x - centre[0];
    let dy = y - centre[1];
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    dx /= len;
    dy /= len;
    const text = String(i);
    const m = measureText(text, { scale });
    const w = m.width + 2 * scale;
    const h = m.height + 2 * scale;
    const reach = 3 * view.textScale + Math.abs(dx) * (w / 2) + Math.abs(dy) * (h / 2);
    const box = tagOutput(view, x + dx * reach - w / 2, y + dy * reach - h / 2, text, scale);
    labels?.reserve(box);
  }
}

function drawLegend(view: SourceView, groups: AvatarPartGroupInfo[], line: number): void {
  const ts = view.textScale;
  let x = 4 * ts;
  const y = view.footer[0] + line * 10 * ts;
  for (const g of groups) {
    const w = measureText(g.label, { scale: ts }).width;
    if (x + 9 * ts + w > view.image.width) break;
    fillRect(view.image, x, y, 7 * ts, 7 * ts, g.color);
    strokeRect(view.image, x, y, 7 * ts, 7 * ts, '#ffffff', 1);
    drawText(view.image, x + 9 * ts, y, g.label, RULER_TEXT, { scale: ts });
    x += 9 * ts + w + 8 * ts;
  }
}

export function avatarOverlay(source: ImageRGBA, doc: unknown, options: OverlayOptions = {}): OverlayResult {
  const groups = describeAvatarParts(doc);
  const candidates = select(groups, options.part);
  const selected: Selected[] = [];
  const missing: string[] = [];
  for (const c of candidates) {
    const shape = resolveShape(doc, c.item.shape);
    if (shape) selected.push({ ...c, shape });
    else if (c.item.required) missing.push(c.item.id);
  }
  if (selected.length === 0) {
    throw new AvatarToolError(
      options.part === undefined ? 'nothing to draw: no landmark is placed yet' : `nothing to draw: no landmark of "${options.part}" is placed yet`,
      'place landmarks in avatar.json first ("rev2d avatar validate" lists what is missing); "rev2d avatar grid" shows the coordinates',
    );
  }

  const region = options.zoom ? zoomRegion(source, selected) : undefined;
  const view = createSourceView(source, { region, scale: options.scale, footerLines: 2 });
  drawRulers(view, { lines: options.grid ?? false });

  // Labels on every item only when the selection is small enough to stay readable.
  const labels = options.part !== undefined || options.zoom ? new Labels(view) : null;
  const numbered = options.zoom === true;
  // Large shapes first, so small ones stay on top.
  const area = (s: Selected) => {
    const b = shapeBounds(s.shape);
    return b ? (b[2] - b[0]) * (b[3] - b[1]) : Infinity;
  };
  for (const s of [...selected].sort((a, b) => area(b) - area(a))) drawShape(view, s, labels, numbered);
  labels?.flush();

  const shownGroups = groups.filter((g) => selected.some((s) => s.group === g));
  drawLegend(view, shownGroups, 0);
  const [x0, y0, x1, y1] = view.region;
  const whole = x0 === 0 && y0 === 0 && x1 === source.width && y1 === source.height;
  drawFooterText(
    view,
    [
      options.part ?? 'all parts',
      whole ? `image ${source.width}x${source.height}` : `x ${x0}..${x1}, y ${y0}..${y1}`,
      `x${view.scale}`,
      ...(missing.length ? [`${missing.length} not placed yet`] : []),
      ...(numbered && selected.some((s) => s.shape.type === 'polygon' || s.shape.type === 'polyline') ? ['vertex numbers = index into the point list (from 0)'] : []),
    ],
    1,
  );
  return { image: view.image, region: view.region, scale: view.scale, origin: view.origin, drawn: selected.map((s) => s.item.id), missing };
}
