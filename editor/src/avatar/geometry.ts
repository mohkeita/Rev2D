/**
 * The handles of avatar mode (pure): where the draggable dots of every part sit on screen, what a
 * pointer hits, and what a drag does to the RAW avatar.json document.
 *
 *   partHandles(item, shape, ...)   one item's handles in screen space (constant size at every zoom)
 *   hitHandle / hitEdge / hitBody   what lies under a pointer (screen px tolerances)
 *   dragHandle(doc, grab, point)    the document after dragging a handle to an image point
 *   insertVertex / removeVertex / translateItem / setValue   the other edits
 *
 * Every edit returns a NEW document (the input is never changed) with coordinates rounded to 0.1 px;
 * the store records them in its undo history. Coordinates: image pixels of the source illustration
 * (origin top-left, +y down); screen = CSS px of the canvas (view/camera.ts maps between them).
 * Angles are degrees, clockwise on screen (an ellipse's local x axis is (cos θ, sin θ)).
 */
import type { AvatarPartGroupId, HandleShape, ResolvedShape, SpecPointer } from '../../../src/avatar/index.js';
import { pointInPolygon, distanceToSegment, ellipseLevel } from '../../../src/avatar/tools/geometry.js';
import { resolvePointer, setPointer } from '../../../src/avatar/parts.js';

/** A raw avatar.json document (possibly an unfinished draft). */
export type SpecDoc = Record<string, unknown>;
export type Vec2 = [number, number];
export type ToScreen = (x: number, y: number) => Vec2;

/** What a handle edits. */
export type HandleRole = 'vertex' | 'center' | 'radiusX' | 'radiusY' | 'rotation' | 'point' | 'bandStart' | 'bandEnd' | 'a' | 'b';

export interface Handle {
  /** Item id (describeAvatarParts), e.g. "eyes.imageLeft.opening". */
  item: string;
  group: AvatarPartGroupId;
  role: HandleRole;
  /**
   * The value the handle edits: the point list (vertex), the [x, y] (center, point, a, b), the
   * radius ([rx, ry] or a number for a circle), the rotation, or the band [yStart, yEnd].
   */
  pointer: SpecPointer;
  /** Vertex index (vertex) or band edge (0 = start, 1 = end). */
  index?: number;
  /** Screen position (CSS px of the canvas). */
  x: number;
  y: number;
}

/** Visual radius of a handle in CSS px (constant at every zoom), and how far from it a press still grabs it. */
export const HANDLE_RADIUS = 5;
export const HANDLE_RADIUS_SELECTED = 7;
export const HANDLE_HIT = 12;
/** A press this close to an edge or a line counts as on it (CSS px). */
export const EDGE_HIT = 7;
/** Distance of the rotation knob beyond the ellipse, CSS px. */
export const ROTATION_KNOB = 26;
/** Smallest radius a drag leaves (image px). */
const MIN_RADIUS = 1;
/** Coordinates are written with one decimal. */
const PRECISION = 10;

export const r1 = (v: number): number => {
  const r = Math.round(v * PRECISION) / PRECISION;
  return Object.is(r, -0) ? 0 : r;
};

const DEG = Math.PI / 180;

/** The local axes of an ellipse rotated by `deg` (clockwise on screen). */
export function ellipseAxes(deg: number): { ux: Vec2; uy: Vec2 } {
  const c = Math.cos(deg * DEG);
  const s = Math.sin(deg * DEG);
  return { ux: [c, s], uy: [-s, c] };
}

/** Whether the radius value of an ellipse is a single number (a circle, e.g. the iris). */
export function isCircle(doc: unknown, shape: HandleShape): boolean {
  return shape.type === 'ellipse' && typeof resolvePointer(doc, shape.radius) === 'number';
}

// ----------------------------------------------------------------------------- handles

export interface HandleOptions {
  /** The radius is one number (a circle): one radius handle, dragging keeps it round. */
  circle?: boolean;
  /** Screen x of the grips of a band (its lines run across the whole image). */
  bandX?: number;
}

/** The handles of one placed item, in drawing order (the last one is on top). */
export function partHandles(item: string, group: AvatarPartGroupId, shape: HandleShape, resolved: ResolvedShape, S: ToScreen, opts: HandleOptions = {}): Handle[] {
  const out: Handle[] = [];
  const add = (role: HandleRole, pointer: SpecPointer, [x, y]: Vec2, index?: number) => out.push({ item, group, role, pointer, x, y, ...(index !== undefined ? { index } : {}) });
  switch (resolved.type) {
    case 'point':
      if (shape.type === 'point') add('point', shape.at, S(resolved.at[0], resolved.at[1]));
      break;
    case 'segment':
      if (shape.type === 'segment') {
        add('a', shape.a, S(resolved.a[0], resolved.a[1]));
        add('b', shape.b, S(resolved.b[0], resolved.b[1]));
      }
      break;
    case 'polygon':
    case 'polyline':
      if (shape.type === 'polygon' || shape.type === 'polyline') {
        for (let i = 0; i * 2 + 1 < resolved.points.length; i++) add('vertex', shape.points, S(resolved.points[i * 2], resolved.points[i * 2 + 1]), i);
      }
      break;
    case 'band':
      if (shape.type === 'band') {
        const x = opts.bandX ?? 0;
        add('bandStart', shape.range, [x, S(0, resolved.range[0])[1]], 0);
        add('bandEnd', shape.range, [x, S(0, resolved.range[1])[1]], 1);
      }
      break;
    case 'ellipse':
      if (shape.type === 'ellipse') {
        const [cx, cy] = resolved.center;
        const [rx, ry] = resolved.radius;
        const { ux, uy } = ellipseAxes(resolved.rotation);
        add('radiusX', shape.radius, S(cx + ux[0] * rx, cy + ux[1] * rx));
        if (!opts.circle) add('radiusY', shape.radius, S(cx + uy[0] * ry, cy + uy[1] * ry));
        if (shape.rotation !== undefined) {
          const top = S(cx - uy[0] * ry, cy - uy[1] * ry);
          const c = S(cx, cy);
          const len = Math.hypot(top[0] - c[0], top[1] - c[1]);
          const dir: Vec2 = len > 1e-6 ? [(top[0] - c[0]) / len, (top[1] - c[1]) / len] : [0, -1];
          add('rotation', shape.rotation, [top[0] + dir[0] * ROTATION_KNOB, top[1] + dir[1] * ROTATION_KNOB]);
        }
        add('center', shape.center, S(cx, cy));
      }
      break;
  }
  return out;
}

/** The handle nearest to a screen point within `radius`; later handles win ties (they are drawn on top). */
export function hitHandle(handles: readonly Handle[], x: number, y: number, radius = HANDLE_HIT): Handle | null {
  let best: Handle | null = null;
  let bestD = radius;
  for (const h of handles) {
    const d = Math.hypot(h.x - x, h.y - y);
    if (d <= bestD) {
      best = h;
      bestD = d;
    }
  }
  return best;
}

/** One placed item as the hit tests see it. */
export interface HitShape {
  item: string;
  group: AvatarPartGroupId;
  shape: HandleShape;
  resolved: ResolvedShape;
}

export interface EdgeHit {
  item: string;
  pointer: SpecPointer;
  /** The edge from vertex `edge` to vertex `edge + 1` (closing edge of a polygon: the last vertex to vertex 0). */
  edge: number;
  /** The point on the edge, image px. */
  at: Vec2;
}

/** The edge of a polygon or polyline under a screen point (for inserting a vertex). */
export function hitEdge(shapes: readonly HitShape[], x: number, y: number, S: ToScreen, toImage: ToScreen, tolerance = EDGE_HIT): EdgeHit | null {
  let best: EdgeHit | null = null;
  let bestD = tolerance;
  for (const s of shapes) {
    if ((s.resolved.type !== 'polygon' && s.resolved.type !== 'polyline') || (s.shape.type !== 'polygon' && s.shape.type !== 'polyline')) continue;
    const pts = s.resolved.points;
    const n = pts.length / 2;
    const edges = s.resolved.type === 'polygon' ? n : n - 1;
    for (let i = 0; i < edges; i++) {
      const j = (i + 1) % n;
      const [ax, ay] = S(pts[i * 2], pts[i * 2 + 1]);
      const [bx, by] = S(pts[j * 2], pts[j * 2 + 1]);
      const d = distanceToSegment(x, y, ax, ay, bx, by);
      if (d <= bestD) {
        bestD = d;
        best = { item: s.item, pointer: s.shape.points, edge: i, at: toImage(x, y) };
      }
    }
  }
  return best;
}

/**
 * A line of a band under a screen point (the bands' lines run across the picture, `x0`..`x1` on
 * screen): the edge to drag, as a handle.
 */
export function hitBandLine(shapes: readonly HitShape[], x: number, y: number, S: ToScreen, x0: number, x1: number, tolerance = EDGE_HIT): Handle | null {
  if (x < Math.min(x0, x1) || x > Math.max(x0, x1)) return null;
  let best: Handle | null = null;
  let bestD = tolerance;
  for (const s of shapes) {
    if (s.resolved.type !== 'band' || s.shape.type !== 'band') continue;
    for (const index of [0, 1] as const) {
      const ly = S(0, s.resolved.range[index])[1];
      const d = Math.abs(ly - y);
      if (d <= bestD) {
        bestD = d;
        best = { item: s.item, group: s.group, role: index === 0 ? 'bandStart' : 'bandEnd', pointer: s.shape.range, index, x, y: ly };
      }
    }
  }
  return best;
}

/**
 * The items whose shape covers an image point (inside a polygon or an ellipse, on a polyline, a
 * segment or a band line, on a point), the smallest first: what a click selects.
 */
export function hitBody(shapes: readonly HitShape[], px: number, py: number, pixelsPerScreenPx: number): string[] {
  const tol = EDGE_HIT * pixelsPerScreenPx;
  const hits: Array<{ item: string; area: number }> = [];
  for (const s of shapes) {
    const r = s.resolved;
    switch (r.type) {
      case 'polygon':
        if (r.points.length >= 6 && pointInPolygon(px, py, r.points)) hits.push({ item: s.item, area: polygonAreaAbs(r.points) });
        break;
      case 'ellipse':
        if (ellipseLevel(r.center, r.radius, r.rotation, px, py) <= 1) hits.push({ item: s.item, area: Math.PI * r.radius[0] * r.radius[1] });
        break;
      case 'polyline':
        for (let i = 0; i + 3 < r.points.length; i += 2) {
          if (distanceToSegment(px, py, r.points[i], r.points[i + 1], r.points[i + 2], r.points[i + 3]) <= tol) {
            hits.push({ item: s.item, area: tol * tol });
            break;
          }
        }
        break;
      case 'segment':
        if (distanceToSegment(px, py, r.a[0], r.a[1], r.b[0], r.b[1]) <= tol) hits.push({ item: s.item, area: tol * tol });
        break;
      case 'band':
        if (Math.abs(py - r.range[0]) <= tol || Math.abs(py - r.range[1]) <= tol) hits.push({ item: s.item, area: tol * tol * 2 });
        break;
      case 'point':
        if (Math.hypot(px - r.at[0], py - r.at[1]) <= tol * 1.5) hits.push({ item: s.item, area: 0 });
        break;
    }
  }
  return hits.sort((a, b) => a.area - b.area).map((h) => h.item);
}

function polygonAreaAbs(points: readonly number[]): number {
  let a = 0;
  const n = points.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += points[i * 2] * points[j * 2 + 1] - points[j * 2] * points[i * 2 + 1];
  }
  return Math.abs(a) / 2;
}

/** Bounds [x, y, w, h] of a resolved shape in image px (a band spans the image width `imageWidth`). */
export function shapeBounds(r: ResolvedShape, imageWidth: number): [number, number, number, number] {
  const box = (xs: number[], ys: number[]): [number, number, number, number] => {
    const x0 = Math.min(...xs);
    const y0 = Math.min(...ys);
    return [x0, y0, Math.max(...xs) - x0, Math.max(...ys) - y0];
  };
  switch (r.type) {
    case 'point':
      return [r.at[0], r.at[1], 0, 0];
    case 'segment':
      return box([r.a[0], r.b[0]], [r.a[1], r.b[1]]);
    case 'band':
      return [0, Math.min(r.range[0], r.range[1]), imageWidth, Math.abs(r.range[1] - r.range[0])];
    case 'polygon':
    case 'polyline': {
      const xs: number[] = [];
      const ys: number[] = [];
      for (let i = 0; i + 1 < r.points.length; i += 2) {
        xs.push(r.points[i]);
        ys.push(r.points[i + 1]);
      }
      return box(xs, ys);
    }
    case 'ellipse': {
      const { ux, uy } = ellipseAxes(r.rotation);
      const hx = Math.hypot(r.radius[0] * ux[0], r.radius[1] * uy[0]);
      const hy = Math.hypot(r.radius[0] * ux[1], r.radius[1] * uy[1]);
      return [r.center[0] - hx, r.center[1] - hy, hx * 2, hy * 2];
    }
  }
}

// ----------------------------------------------------------------------------- edits

function clone(doc: SpecDoc): SpecDoc {
  return structuredClone(doc);
}

/** The document with one value replaced (a deep copy; `undefined` deletes it). */
export function setValue(doc: SpecDoc, pointer: SpecPointer, value: unknown): SpecDoc {
  const next = clone(doc);
  setPointer(next, pointer, value === undefined ? undefined : structuredClone(value));
  return next;
}

function finiteList(v: unknown): number[] | null {
  v=Array.isArray(v)?v.flat():v;
  return Array.isArray(v) && v.every((n) => typeof n === 'number' && Number.isFinite(n)) ? (v as number[]) : null;
}

/** What is being dragged: the handle as it was when the drag started. */
export interface Grab {
  role: HandleRole;
  pointer: SpecPointer;
  index?: number;
  /** The item's ellipse when the drag started (radius and rotation handles measure from its centre). */
  ellipse?: { center: Vec2; radius: Vec2; rotation: number; circle: boolean };
}

export interface DragOptions {
  /** Rotation: snap to 15°. */
  snap?: boolean;
}

/**
 * The document after dragging a handle to image point `p`. Returns the input itself when the drag
 * cannot apply (the value is missing or malformed).
 */
export function dragHandle(doc: SpecDoc, grab: Grab, p: Vec2, opts: DragOptions = {}): SpecDoc {
  const x = r1(p[0]);
  const y = r1(p[1]);
  switch (grab.role) {
    case 'center':
    case 'point':
    case 'a':
    case 'b':
      return setValue(doc, grab.pointer, [x, y]);
    case 'vertex': {
      const pts = finiteList(resolvePointer(doc, grab.pointer));
      const i = grab.index ?? -1;
      if (!pts || i < 0 || i * 2 + 1 >= pts.length) return doc;
      const next = pts.slice();
      next[i * 2] = x;
      next[i * 2 + 1] = y;
      return setValue(doc, grab.pointer, next);
    }
    case 'bandStart':
    case 'bandEnd': {
      const range = finiteList(resolvePointer(doc, grab.pointer));
      if (!range || range.length !== 2) return doc;
      // The edges keep their order (yStart < yEnd) and at least 1 px between them.
      const next: Vec2 = grab.role === 'bandStart' ? [r1(Math.min(p[1], range[1] - 1)), range[1]] : [range[0], r1(Math.max(p[1], range[0] + 1))];
      return setValue(doc, grab.pointer, next);
    }
    case 'radiusX':
    case 'radiusY': {
      const e = grab.ellipse;
      if (!e) return doc;
      const { ux, uy } = ellipseAxes(e.rotation);
      const dx = p[0] - e.center[0];
      const dy = p[1] - e.center[1];
      if (e.circle) return setValue(doc, grab.pointer, r1(Math.max(MIN_RADIUS, Math.hypot(dx, dy))));
      const along = grab.role === 'radiusX' ? Math.abs(dx * ux[0] + dy * ux[1]) : Math.abs(dx * uy[0] + dy * uy[1]);
      const current = finiteList(resolvePointer(doc, grab.pointer));
      const radius: Vec2 = current && current.length === 2 ? [current[0], current[1]] : [e.radius[0], e.radius[1]];
      radius[grab.role === 'radiusX' ? 0 : 1] = r1(Math.max(MIN_RADIUS, along));
      return setValue(doc, grab.pointer, radius);
    }
    case 'rotation': {
      const e = grab.ellipse;
      if (!e) return doc;
      // The knob sits on the ellipse's local -y axis: rotation 0 has it straight above the centre.
      let deg = (Math.atan2(p[1] - e.center[1], p[0] - e.center[0]) * 180) / Math.PI + 90;
      if (opts.snap) deg = Math.round(deg / 15) * 15;
      deg = ((((deg + 180) % 360) + 360) % 360) - 180;
      return setValue(doc, grab.pointer, r1(deg));
    }
  }
}

/** Insert a vertex at image point `p` after vertex `edge` (on the edge edge -> edge + 1). */
export function insertVertex(doc: SpecDoc, pointer: SpecPointer, edge: number, p: Vec2): SpecDoc {
  const pts = finiteList(resolvePointer(doc, pointer));
  if (!pts || edge < 0 || edge * 2 + 1 >= pts.length) return doc;
  const next = pts.slice();
  next.splice((edge + 1) * 2, 0, r1(p[0]), r1(p[1]));
  return setValue(doc, pointer, next);
}

/** The fewest vertices a polygon / polyline keeps when one is removed. */
export const MIN_VERTICES = { polygon: 3, polyline: 2 } as const;

/** Remove vertex `index`; null when the list would get fewer than `min` vertices. */
export function removeVertex(doc: SpecDoc, pointer: SpecPointer, index: number, min: number): SpecDoc | null {
  const pts = finiteList(resolvePointer(doc, pointer));
  if (!pts || index < 0 || index * 2 + 1 >= pts.length || pts.length / 2 <= min) return null;
  const next = pts.slice();
  next.splice(index * 2, 2);
  return setValue(doc, pointer, next);
}

/** Every pointer of a handle shape whose value moves with the shape (the radius and rotation do not). */
function movingPointers(shape: HandleShape): Array<{ pointer: SpecPointer; kind: 'vec' | 'points' | 'band' }> {
  switch (shape.type) {
    case 'point':
      return [{ pointer: shape.at, kind: 'vec' }];
    case 'segment':
      return [
        { pointer: shape.a, kind: 'vec' },
        { pointer: shape.b, kind: 'vec' },
      ];
    case 'ellipse':
      return [{ pointer: shape.center, kind: 'vec' }];
    case 'polygon':
    case 'polyline':
      return [{ pointer: shape.points, kind: 'points' }];
    case 'band':
      return [{ pointer: shape.range, kind: 'band' }];
  }
}

/** Move a whole item by (dx, dy) image px, starting from `base` (the document when the drag began). */
export function translateItem(base: SpecDoc, shape: HandleShape, dx: number, dy: number): SpecDoc {
  const next = clone(base);
  for (const { pointer, kind } of movingPointers(shape)) {
    const v = finiteList(resolvePointer(base, pointer));
    if (!v) continue;
    if (kind === 'band') setPointer(next, pointer, [r1(v[0] + dy), r1(v[1] + dy)]);
    else setPointer(next, pointer, v.map((n, i) => r1(n + (i % 2 === 0 ? dx : dy))));
  }
  return next;
}

/** Deep equality of two JSON documents (key order ignored). */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((v, i) => sameJson(v, bb[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ka = Object.keys(ao).filter((k) => ao[k] !== undefined);
  const kb = Object.keys(bo).filter((k) => bo[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(bo, k) && sameJson(ao[k], bo[k]));
}
