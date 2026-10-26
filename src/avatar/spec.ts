/**
 * Avatar spec parsing and validation (avatar.json), in the style of model validation: Diagnostics
 * with a severity, a stable code, a JSON pointer into the document and an actionable hint.
 *
 *   parseAvatarSpec(input, options?)  JSON / JSONC text or a parsed value -> {spec, diagnostics, doc}
 *   draftAvatarSpec(name, w, h)       a RAW document for a new project: every landmark still null
 *   avatarSpecName(text)              any text -> a valid spec name (an id)
 *
 * Three kinds of diagnostics, reported together:
 * 1. Structural ("schema-*", "json-syntax"): the zod issues of AvatarSpecSchema converted by the
 *    model validator (unknown keys with did-you-mean, wrong types, union hints).
 * 2. "avatar-missing-landmark": one per landmark that is still null / absent / an empty list, with
 *    the way to place it. A draft therefore validates to ONE list of what is left to do; the schema
 *    errors those gaps would cause are not shown.
 * 3. Semantic ("avatar-*", table below). They read the RAW document and check every landmark that
 *    is already well-formed, so an unfinished draft gets feedback on what has been placed so far.
 *
 * `spec` is the normalized spec (defaults filled) when there is no error; warnings and infos do not
 * block. Semantic codes (severity: meaning):
 *
 *   avatar-image-size-mismatch (error)       image.width / height differ from the actual image file
 *   avatar-image-size (warning)              very small or very large image
 *   avatar-points-odd (error)                a point list with an odd number of values
 *   avatar-too-few-points (error)            a polygon with < 3 points, a polyline with < 2
 *   avatar-polygon-self-intersects (warning) edges of a polygon cross
 *   avatar-outside-image (warning)           coordinates outside the image
 *   avatar-polygon-outside-image (error)     a shape that cuts layers lies entirely outside the image
 *   avatar-eye-opening-outside-region (error)   an eye opening that is not inside its region
 *   avatar-eye-opening-exceeds-region (warning) a few opening points stick out of the region
 *   avatar-eyes-swapped (error)              imageLeft is not left of imageRight
 *   avatar-eyes-overlap (error)              the two openings overlap
 *   avatar-eye-region-contains-other (error) a region reaches into the other eye
 *   avatar-outside-head (error)              an eye, the nose, a mouth corner or the chin outside the head ellipse
 *   avatar-face-outside-head (warning)       the face oval sticks out of the head ellipse
 *   avatar-band-order (error)                head.neck / body.fade with yStart >= yEnd
 *   avatar-neck-above-chin (warning)         the neck band starts well above the chin
 *   avatar-mouth-corners-swapped (error)     mouth.imageLeft is not left of mouth.imageRight
 *   avatar-mouth-area (error)                the mouth area does not contain a mouth corner
 *   avatar-duplicate-id (error)              two strands, or two attachments, share an id
 *   avatar-reserved-id (error)               an attachment id that names a generated layer
 *   avatar-strand-root-outside-head (info)   a strand starts outside the head ellipse
 *   avatar-pendulum-degenerate (error)       a pendulum whose pivot and tip coincide
 *   avatar-implausible-value (warning)       turn / tilt / sway / breath / swing far from usable values
 *   avatar-post-op (error)                   a post entry without an "op" (or with an unknown one)
 */
import { parseJsonc } from '../core/validate/jsonc.js';
import { DiagnosticSink, isPlainObject } from '../core/validate/diagnostics.js';
import { registerFieldExamples } from '../core/validate/schema-walk.js';
import { structuralDiagnostics } from '../core/validate/structural.js';
import { didYouMean, formatList } from '../core/validate/text.js';
import type { Diagnostic } from '../core/types.js';
import { ID_PATTERN } from '../core/schema.js';
import { OP_CATALOG } from '../ops/catalog.js';
import { validateArmLandmarks } from './arms-spec.js';
import {
  AVATAR_FORMAT,
  AVATAR_VERSION,
  AvatarCutoutSchema,
  AvatarEyeSchema,
  AvatarJiggleSchema,
  AvatarPendulumSchema,
  AvatarSpecSchema,
  AvatarStrandSchema,
} from './schema.js';
import type { AvatarSpecResult, ImageSide } from './types.js';
import { avatarLandmarks, describeAvatarParts, pointerSegments, readPoints, readRadius, readVec, resolvePointer, resolveShape } from './parts.js';
import {
  distance,
  ellipseBounds,
  ellipseLevel,
  ellipseOutline,
  outsideDistance,
  pointCount,
  pointInPolygon,
  pointsBounds,
  polygonArea,
  polygonCentroid,
  polygonSelfIntersection,
  polygonsOverlap,
  round,
  type Vec2,
} from './tools/geometry.js';

export interface ParseAvatarSpecOptions {
  /** Pixel size of the actual source image, when known: a spec that declares another size is an error. */
  imageSize?: { width: number; height: number };
  /** Name of that image in messages (default: image.file of the spec, else "the source image"). */
  imageName?: string;
}

export interface AvatarSpecParse extends AvatarSpecResult {
  /** The raw parsed document (what describeAvatarParts and the overlay tool read); undefined after a JSON syntax error. */
  doc: unknown;
}

/**
 * Every "avatar-*" diagnostic code parseAvatarSpec reports, with its severity (the file comment
 * says what each one means). Codes are stable: tools and translations may key on them.
 */
export const AVATAR_DIAGNOSTIC_CODES = {
  'avatar-missing-landmark': 'error',
  'avatar-image-size-mismatch': 'error',
  'avatar-image-size': 'warning',
  'avatar-points-odd': 'error',
  'avatar-too-few-points': 'error',
  'avatar-polygon-self-intersects': 'warning',
  'avatar-outside-image': 'warning',
  'avatar-polygon-outside-image': 'error',
  'avatar-eye-opening-outside-region': 'error',
  'avatar-eye-opening-exceeds-region': 'warning',
  'avatar-eyes-swapped': 'error',
  'avatar-eyes-overlap': 'error',
  'avatar-eye-region-contains-other': 'error',
  'avatar-outside-head': 'error',
  'avatar-face-outside-head': 'warning',
  'avatar-band-order': 'error',
  'avatar-neck-above-chin': 'warning',
  'avatar-mouth-corners-swapped': 'error',
  'avatar-mouth-area': 'error',
  'avatar-duplicate-id': 'error',
  'avatar-reserved-id': 'error',
  'avatar-strand-root-outside-head': 'info',
  'avatar-pendulum-degenerate': 'error',
  'avatar-implausible-value': 'warning',
  'avatar-post-op': 'error',
  'avatar-legs-missing':'error',
  'avatar-arm-outside-image':'error',
  'avatar-arm-duplicate-id':'error',
  'avatar-arm-segment-short':'error',
  'avatar-arm-hand-detached':'error',
  'avatar-arm-shoulder-detached':'error',
  'avatar-arm-outline':'error',
  'avatar-arm-outline-crosses':'error',
  'avatar-arm-outline-joint':'error',
  'avatar-legs-outside-image':'error',
  'avatar-legs-feet-coincident':'error',
  'avatar-legs-order':'error',

} as const satisfies Record<string, Diagnostic['severity']>;

/**
 * Ids an attachment may not use: they name layers, warps and parts of every generated model
 * (attachment layers themselves are "att_<id>", so ordinary names never collide).
 */
export const AVATAR_RESERVED_IDS: readonly string[] = ['avatar', 'base', 'body', 'head', 'face', 'hair', 'mouth', 'eyes', 'eyeL', 'eyeR', 'brows', 'cheeks', 'blush', 'sprite'];

const FORMAT_HINT = `"format": "${AVATAR_FORMAT}", "version": ${AVATAR_VERSION}`;
const SKELETON =
  `an avatar spec looks like { ${FORMAT_HINT}, "name": "my-avatar", "image": { "width": 1024, "height": 1024 }, "head": { ... }, "face": { ... }, "body": { ... } }; ` +
  '"rev2d avatar new <image.png> <dir>" writes a draft';

// Examples shown in "missing required field" hints.
registerFieldExamples(AvatarSpecSchema, { name: 'my-avatar' });
registerFieldExamples(AvatarSpecSchema.shape.image, { width: 1024, height: 1024 });
registerFieldExamples(AvatarStrandSchema, { id: 'bang1', nodes: [300, 180, 290, 260, 285, 340], width: 30 });
registerFieldExamples(AvatarPendulumSchema, { id: 'tassel', outline: [400, 300, 440, 300, 440, 420, 400, 420], pivot: [420, 302], tip: [420, 418] });
registerFieldExamples(AvatarJiggleSchema, { id: 'bun', center: [300, 160], radius: [70, 60] });
registerFieldExamples(AvatarCutoutSchema, { id: 'hand', outline: [300, 600, 380, 600, 380, 760, 300, 760] });
registerFieldExamples(AvatarEyeSchema.shape.iris.unwrap(), { center: [400, 420], radius: 22 });

/** Any text -> a valid spec name: other characters become "_", a leading digit gets a "_" prefix. */
export function avatarSpecName(text: string): string {
  let name = text.trim().replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  if (name === '') name = 'avatar';
  if (!/^[A-Za-z_]/.test(name)) name = `_${name}`;
  return name;
}

/**
 * A raw document for a new project: the image size filled in and every landmark `null` (to be
 * placed). parseAvatarSpec reports each of them as "avatar-missing-landmark" with a placement hint.
 */
export function draftAvatarSpec(name: string, width: number, height: number): Record<string, unknown> {
  return {
    format: AVATAR_FORMAT,
    version: AVATAR_VERSION,
    name: ID_PATTERN.test(name) ? name : avatarSpecName(name),
    image: { file: 'source.png', width, height },
    head: { center: null, radius: null, pivot: null, neck: null },
    face: {
      center: null,
      radius: null,
      eyes: {
        imageLeft: { opening: null, region: null },
        imageRight: { opening: null, region: null },
      },
      nose: null,
      mouth: { imageLeft: null, imageRight: null, bow: 0, area: { center: null, radius: null, rotation: 0 } },
      chin: null,
    },
    hair: { strands: [] },
    attachments: [],
    body: { pivot: null, fade: null, sway: 2, chest: { center: null, radius: null } },
  };
}

// ----------------------------------------------------------------------------- parse

/**
 * Parse + validate an avatar spec. `input` is JSON text (comments and trailing commas allowed) or
 * an already-parsed value. See the file comment for the diagnostics.
 */
export function parseAvatarSpec(input: unknown, options: ParseAvatarSpecOptions = {}): AvatarSpecParse {
  let doc = input;
  const diagnostics: Diagnostic[] = [];
  if (typeof input === 'string') {
    const parsed = parseJsonc(input.charCodeAt(0) === 0xfeff ? input.slice(1) : input);
    if (!parsed.ok) return { spec: null, diagnostics: [parsed.error], doc: undefined };
    doc = parsed.value;
    diagnostics.push(...parsed.warnings);
  }

  const result = AvatarSpecSchema.safeParse(doc);
  const structural = result.success ? [] : structuralDiagnostics(result.error.issues, doc, { schema: AvatarSpecSchema, noun: 'an avatar spec', formatHint: FORMAT_HINT, skeleton: SKELETON });
  if (!isPlainObject(doc)) return { spec: null, diagnostics: [...diagnostics, ...structural], doc };
  // Another kind of document (a Rev2D model, a Mesh Avatar Studio rig): say that, not what it lacks.
  if (doc.format !== undefined && doc.format !== AVATAR_FORMAT) {
    return { spec: null, diagnostics: [...diagnostics, ...structural.filter((d) => d.path === '/format')], doc };
  }

  const sink = new DiagnosticSink();
  const missing = missingLandmarks(doc, sink);
  const badPost = checkPost(doc, sink);
  // The schema errors caused by a landmark that is not placed yet (or by a post entry reported
  // above) would only repeat it in other words.
  const hidden = (d: Diagnostic): boolean =>
    missing.some((m) => d.path === m || (m.startsWith(`${d.path}/`) && isMissing(resolvePointer(doc, d.path)))) || badPost.some((p) => d.path === p || d.path.startsWith(`${p}/`));
  diagnostics.push(...structural.filter((d) => !hidden(d)));
  semanticChecks(doc, sink, options);
  diagnostics.push(...sink.items);
  if (result.success) diagnostics.push(...validateArmLandmarks(result.data));

  const failed = diagnostics.some((d) => d.severity === 'error');
  return { spec: result.success && !failed ? result.data : null, diagnostics, doc };
}

/** A value that still has to be written: absent, null or an empty list. */
function isMissing(v: unknown): boolean {
  return v === undefined || v === null || (Array.isArray(v) && v.length === 0);
}

/** True when the pointer leads through a value of the wrong kind (a string where an object belongs): the schema reports that. */
function blocked(doc: unknown, pointer: string): boolean {
  let value = doc;
  for (const seg of pointerSegments(pointer)) {
    if (value === undefined || value === null) return false;
    if (typeof value !== 'object') return true;
    value = Object.hasOwn(value, seg) ? (value as Record<string, unknown>)[seg] : undefined;
  }
  return false;
}

function missingLandmarks(doc: unknown, sink: DiagnosticSink): string[] {
  const out: string[] = [];
  for (const l of avatarLandmarks(doc)) {
    if (!l.required || !isMissing(resolvePointer(doc, l.pointer)) || blocked(doc, l.pointer)) continue;
    const key = pointerSegments(l.pointer).pop()!;
    const name = /^\d+$/.test(key) ? 'this entry' : `"${key}"`;
    const tip = /^[A-Z][a-z]/.test(l.tip) ? l.tip[0].toLowerCase() + l.tip.slice(1) : l.tip;
    sink.error('avatar-missing-landmark', l.pointer, `${l.label} is not placed yet`, `set ${name} to ${l.form} in source-image pixels: ${tip.replace(/\.$/, '')}`);
    out.push(l.pointer);
  }
  return out;
}

const OP_NAMES = OP_CATALOG.map((o) => o.op);

function checkPost(doc: Record<string, unknown>, sink: DiagnosticSink): string[] {
  const post = doc.post;
  if (!Array.isArray(post)) return [];
  const bad: string[] = [];
  const example = 'each entry is an edit op as in "rev2d ops", e.g. { "op": "key", "animation": "wave", "target": "param:AngleZ", "t": 0, "v": 0, "duration": 2 }; see "rev2d docs ops"';
  post.forEach((entry, i) => {
    const path = `/post/${i}`;
    const op = isPlainObject(entry) ? entry.op : undefined;
    if (typeof op === 'string' && OP_NAMES.includes(op)) return;
    bad.push(path);
    if (typeof op === 'string' && op !== '') {
      sink.error('avatar-post-op', `${path}/op`, `post entry ${i} has an unknown op "${op}"`, `${didYouMean(op, OP_NAMES) ?? ''} ops: ${formatList(OP_NAMES, 30)}`.trim());
    } else {
      sink.error('avatar-post-op', path, isPlainObject(entry) ? `post entry ${i} has no "op"` : `post entry ${i} is not an op object`, example);
    }
  });
  return bad;
}

// ----------------------------------------------------------------------------- semantic checks

/** Tolerance for "on the edge counts as inside", px. */
const EDGE = 1e-6;

interface Check {
  doc: Record<string, unknown>;
  sink: DiagnosticSink;
  /** Declared image size, when valid. */
  size: { width: number; height: number } | null;
  /** Point lists that are well-formed polygons / polylines, by pointer. */
  shapes: Map<string, number[]>;
}

function semanticChecks(doc: Record<string, unknown>, sink: DiagnosticSink, options: ParseAvatarSpecOptions): void {
  const c: Check = { doc, sink, size: null, shapes: new Map() };
  checkImage(c, options);
  checkPointLists(c);
  checkInsideImage(c);
  checkEyes(c);
  checkHeadEllipse(c);
  checkBands(c);
  checkMouth(c);
  checkIds(c);
  checkPendulums(c);
  checkAmounts(c);
}

function vec(c: Check, pointer: string): Vec2 | null {
  return readVec(resolvePointer(c.doc, pointer));
}

function num(c: Check, pointer: string): number | null {
  const v = resolvePointer(c.doc, pointer);
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function fmt(p: Vec2): string {
  return `(${round(p[0])}, ${round(p[1])})`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function checkImage(c: Check, options: ParseAvatarSpecOptions): void {
  const w = resolvePointer(c.doc, '/image/width');
  const h = resolvePointer(c.doc, '/image/height');
  if (!Number.isInteger(w) || !Number.isInteger(h) || (w as number) <= 0 || (h as number) <= 0) return;
  const width = w as number;
  const height = h as number;
  c.size = { width, height };
  const actual = options.imageSize;
  if (actual && (actual.width !== width || actual.height !== height)) {
    const file = resolvePointer(c.doc, '/image/file');
    const name = options.imageName ?? (typeof file === 'string' && file ? file : 'the source image');
    c.sink.error(
      'avatar-image-size-mismatch',
      '/image',
      `the spec says the image is ${width}x${height}, but ${name} is ${actual.width}x${actual.height}`,
      `set "width": ${actual.width}, "height": ${actual.height}; every coordinate refers to the pixels of that file, so landmarks placed on another size must be rescaled`,
    );
    return;
  }
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  if (short < 256) {
    c.sink.warning('avatar-image-size', '/image', `the image is only ${width}x${height}: landmarks cannot be placed precisely and the layers will look coarse`, 'use an illustration of about 1000-2000 px on its long side');
  } else if (long > 4096) {
    c.sink.warning('avatar-image-size', '/image', `the image is ${width}x${height}: building the layers (pure TypeScript) and rendering will be slow`, 'scale the illustration down to about 1000-2000 px on its long side (and the landmarks with it)');
  }
}

/** Odd lists, too few points, self-intersections; remembers the well-formed lists for the other checks. */
function checkPointLists(c: Check): void {
  for (const l of avatarLandmarks(c.doc)) {
    if (l.role !== 'points') continue;
    const points = readPoints(resolvePointer(c.doc, l.pointer));
    if (!points || points.length === 0) continue;
    const polygon = !l.item.startsWith('strand.') && !l.item.startsWith('face.brows.');
    if (points.length % 2) {
      c.sink.error('avatar-points-odd', l.pointer, `${l.label} has ${points.length} values, an odd number`, 'point lists are flat [x0, y0, x1, y1, ...]: one value is missing or extra');
      continue;
    }
    const n = pointCount(points);
    const need = polygon ? 3 : 2;
    if (n < need) {
      c.sink.error('avatar-too-few-points', l.pointer, `${l.label} has ${plural(n, 'point')}; a ${polygon ? 'polygon' : 'polyline'} needs at least ${need}`, l.tip);
      continue;
    }
    c.shapes.set(l.pointer, points);
    if (!polygon) continue;
    const cross = polygonSelfIntersection(points);
    if (cross) {
      c.sink.warning(
        'avatar-polygon-self-intersects',
        l.pointer,
        `${l.label} crosses itself: the edge from point ${cross.edgeA} and the edge from point ${cross.edgeB} intersect near ${fmt(cross.at)}`,
        'list the points in order around the outline (clockwise or counter-clockwise); the overlay with --zoom numbers them',
      );
    }
  }
}

function checkInsideImage(c: Check): void {
  if (!c.size) return;
  const { width, height } = c.size;
  const outside = (x: number, y: number) => x < -EDGE || y < -EDGE || x > width + EDGE || y > height + EDGE;
  const where = `the image is ${width}x${height}: x runs 0..${width} to the right, y runs 0..${height} downward`;
  for (const group of describeAvatarParts(c.doc)) {
    for (const item of group.items) {
      // The body pivot usually lies below the picture: the torso continues there.
      if (item.id === 'body.pivot') continue;
      const shape = resolveShape(c.doc, item.shape);
      if (!shape) continue;
      const cut = item.cutsLayers && item.id !== 'head.ellipse' && !item.id.startsWith('strand.');
      switch (shape.type) {
        case 'point':
          if (item.shape.type === 'point' && outside(shape.at[0], shape.at[1])) c.sink.warning('avatar-outside-image', item.shape.at, `${item.label} ${fmt(shape.at)} is outside the image`, where);
          break;
        case 'segment':
          if (item.shape.type !== 'segment') break;
          if (outside(shape.a[0], shape.a[1])) c.sink.warning('avatar-outside-image', item.shape.a, `${item.label}: ${fmt(shape.a)} is outside the image`, where);
          if (outside(shape.b[0], shape.b[1])) c.sink.warning('avatar-outside-image', item.shape.b, `${item.label}: ${fmt(shape.b)} is outside the image`, where);
          break;
        case 'ellipse': {
          if (item.shape.type !== 'ellipse') break;
          const b = ellipseBounds(shape.center, shape.radius, shape.rotation);
          if (cut && (b[2] <= 0 || b[3] <= 0 || b[0] >= width || b[1] >= height)) {
            c.sink.error('avatar-polygon-outside-image', item.shape.center, `${item.label} lies entirely outside the image`, where);
          } else if (outside(shape.center[0], shape.center[1])) {
            c.sink.warning('avatar-outside-image', item.shape.center, `${item.label}: its centre ${fmt(shape.center)} is outside the image`, where);
          }
          break;
        }
        case 'polygon':
        case 'polyline': {
          if (item.shape.type !== 'polygon' && item.shape.type !== 'polyline') break;
          const n = pointCount(shape.points);
          const out: number[] = [];
          for (let i = 0; i < n; i++) if (outside(shape.points[i * 2], shape.points[i * 2 + 1])) out.push(i);
          if (out.length === 0) break;
          const b = pointsBounds(shape.points)!;
          if (cut && (b[2] <= 0 || b[3] <= 0 || b[0] >= width || b[1] >= height)) {
            c.sink.error('avatar-polygon-outside-image', item.shape.points, `${item.label} lies entirely outside the image: there are no pixels to cut`, where);
            break;
          }
          const first: Vec2 = [shape.points[out[0] * 2], shape.points[out[0] * 2 + 1]];
          c.sink.warning(
            'avatar-outside-image',
            item.shape.points,
            `${item.label}: ${out.length} of ${plural(n, 'point')} ${out.length === 1 ? 'is' : 'are'} outside the image (point ${out[0]} at ${fmt(first)}${out.length > 1 ? `, also ${formatList(out.slice(1).map(String), 6)}` : ''})`,
            where,
          );
          break;
        }
        case 'band':
          if (item.shape.type === 'band' && ((shape.range[0] < 0 && shape.range[1] < 0) || (shape.range[0] > height && shape.range[1] > height))) {
            c.sink.warning('avatar-outside-image', item.shape.range, `${item.label} [${round(shape.range[0])}, ${round(shape.range[1])}] lies outside the image rows 0..${height}`, where);
          }
          break;
      }
    }
  }
}

const SIDES: readonly ImageSide[] = ['imageLeft', 'imageRight'];
const OTHER: Record<ImageSide, ImageSide> = { imageLeft: 'imageRight', imageRight: 'imageLeft' };

function checkEyes(c: Check): void {
  const opening = (s: ImageSide) => c.shapes.get(`/face/eyes/${s}/opening`);
  const region = (s: ImageSide) => c.shapes.get(`/face/eyes/${s}/region`);

  for (const side of SIDES) {
    const o = opening(side);
    const r = region(side);
    if (o && r) {
      const n = pointCount(o);
      const out: Array<[number, number]> = [];
      for (let i = 0; i < n; i++) {
        const d = outsideDistance(o[i * 2], o[i * 2 + 1], r);
        if (d > 1) out.push([i, d]);
      }
      const centre = polygonCentroid(o);
      const worst = out.reduce((m, [, d]) => Math.max(m, d), 0);
      if (!pointInPolygon(centre[0], centre[1], r) || out.length * 2 > n) {
        const swapped = pointInPolygon(polygonCentroid(r)[0], polygonCentroid(r)[1], o) && Math.abs(polygonArea(r)) < Math.abs(polygonArea(o));
        c.sink.error(
          'avatar-eye-opening-outside-region',
          `/face/eyes/${side}/opening`,
          `the opening of the ${side} eye is not inside its region (${out.length} of ${plural(n, 'point')} outside, up to ${round(worst)} px)`,
          swapped
            ? 'the region is smaller than the opening: the two polygons look swapped ("opening" = eye white + iris inside the lashes, "region" = a larger polygon around lashes and lids)'
            : 'the region must surround the whole eye, 10-20 px outside the lashes and the lower lid; the opening is the eye white + iris inside it',
        );
      } else if (out.length) {
        c.sink.warning(
          'avatar-eye-opening-exceeds-region',
          `/face/eyes/${side}/opening`,
          `${plural(out.length, 'point')} of the ${side} eye opening ${out.length === 1 ? 'sticks' : 'stick'} out of its region by up to ${round(worst)} px (${out.length === 1 ? 'point' : 'points'} ${formatList(out.map(([i]) => String(i)), 8)})`,
          'widen the region there (it should lie 10-20 px outside the lashes), or pull those points in: only pixels inside the region are cut into the eye layers',
        );
      }
    }
    // A region that reaches into the other eye would cut that eye's pixels into this eye's layers.
    const other = opening(OTHER[side]);
    if (r && other) {
      let inside = 0;
      for (let i = 0; i < pointCount(other); i++) if (pointInPolygon(other[i * 2], other[i * 2 + 1], r)) inside++;
      if (inside > 0) {
        c.sink.error(
          'avatar-eye-region-contains-other',
          `/face/eyes/${side}/region`,
          `the region of the ${side} eye reaches into the ${OTHER[side]} eye (${inside} of its ${plural(pointCount(other), 'opening point')} are inside)`,
          'each region surrounds ONE eye: its lashes, lids and crease, nothing of the other eye',
        );
      }
    }
  }

  const left = opening('imageLeft') ?? region('imageLeft');
  const right = opening('imageRight') ?? region('imageRight');
  if (left && right) {
    const lx = polygonCentroid(left)[0];
    const rx = polygonCentroid(right)[0];
    if (lx >= rx) {
      c.sink.error(
        'avatar-eyes-swapped',
        '/face/eyes',
        `the imageLeft eye (x = ${round(lx)}) is not left of the imageRight eye (x = ${round(rx)})`,
        '"imageLeft" is the eye on the LEFT SIDE OF THE IMAGE as you look at it (the character\'s own right eye): swap the two entries',
      );
    }
  }
  const lo = opening('imageLeft');
  const ro = opening('imageRight');
  if (lo && ro && polygonsOverlap(lo, ro)) {
    c.sink.error('avatar-eyes-overlap', '/face/eyes', 'the openings of the two eyes overlap', 'each opening traces the eye white + iris of ONE eye; check that both polygons are not on the same eye');
  }
}

function checkHeadEllipse(c: Check): void {
  const center = vec(c, '/head/center');
  const radius = readRadius(resolvePointer(c.doc, '/head/radius'));
  if (!center || !radius) return;
  const level = (p: Vec2) => ellipseLevel(center, radius, 0, p[0], p[1]);
  const hint = 'the head ellipse (head.center, head.radius) must cover the WHOLE head including all hair: enlarge or move it, or fix this landmark';

  const landmarks: Array<[string, string, Vec2 | null]> = [
    ['/face/nose', 'the nose tip', vec(c, '/face/nose')],
    ['/face/mouth/imageLeft', 'the mouth corner on the image left', vec(c, '/face/mouth/imageLeft')],
    ['/face/mouth/imageRight', 'the mouth corner on the image right', vec(c, '/face/mouth/imageRight')],
    ['/face/chin', 'the chin', vec(c, '/face/chin')],
  ];
  for (const side of SIDES) {
    const eye = c.shapes.get(`/face/eyes/${side}/opening`) ?? c.shapes.get(`/face/eyes/${side}/region`);
    landmarks.unshift([`/face/eyes/${side}`, `the ${side} eye`, eye ? polygonCentroid(eye) : null]);
  }
  for (const [pointer, name, p] of landmarks) {
    if (p && level(p) > 1 + EDGE) c.sink.error('avatar-outside-head', pointer, `${name} ${fmt(p)} is outside the head ellipse`, hint);
  }

  const faceCenter = vec(c, '/face/center');
  const faceRadius = readRadius(resolvePointer(c.doc, '/face/radius'));
  if (faceCenter && faceRadius) {
    const outline = ellipseOutline(faceCenter, faceRadius, 0, 72);
    let worst = 0;
    let at: Vec2 = faceCenter;
    for (let i = 0; i < 72; i++) {
      const p: Vec2 = [outline[i * 2], outline[i * 2 + 1]];
      const l = level(p);
      // Distance along the ray from the head centre between the point and the head outline.
      const over = l > 1 ? distance(center[0], center[1], p[0], p[1]) * (1 - 1 / l) : 0;
      if (over > worst) {
        worst = over;
        at = p;
      }
    }
    if (worst > 1) {
      c.sink.warning(
        'avatar-face-outside-head',
        '/face/radius',
        `the face oval sticks out of the head ellipse by up to ${round(worst)} px (near ${fmt(at)})`,
        'the face oval is skin only (hairline to chin, cheek to cheek) and lies inside the head ellipse, which covers the whole head with all hair',
      );
    }
  }

  const strands = resolvePointer(c.doc, '/hair/strands');
  if (Array.isArray(strands)) {
    strands.forEach((s, i) => {
      const nodes = c.shapes.get(`/hair/strands/${i}/nodes`);
      if (!nodes) return;
      const root: Vec2 = [nodes[0], nodes[1]];
      if (level(root) <= 1 + EDGE) return;
      const tip: Vec2 = [nodes[nodes.length - 2], nodes[nodes.length - 1]];
      const id = isPlainObject(s) && typeof s.id === 'string' ? s.id : `#${i}`;
      c.sink.info(
        'avatar-strand-root-outside-head',
        `/hair/strands/${i}/nodes`,
        `strand "${id}" starts at ${fmt(root)}, outside the head ellipse`,
        level(tip) <= 1
          ? 'nodes run from the ROOT of the lock (on the head) to its TIP: this list looks reversed'
          : 'nodes run from the ROOT of the lock (on the head) to its TIP; hair outside the head ellipse is not part of the hair mask (enlarge the head ellipse if it is head hair)',
      );
    });
  }
}

function smoothstep(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

function checkBands(c: Check): void {
  const bands: Array<[string, string, string]> = [
    ['/head/neck', 'the neck band', 'yStart = just below the chin, yEnd = near the collarbone (y grows downward)'],
    ['/body/fade', 'the body fade band', 'yStart = the upper body (full sway above it), yEnd = the anchored bottom (y grows downward)'],
  ];
  const ordered = new Map<string, Vec2>();
  for (const [pointer, name, hint] of bands) {
    const band = vec(c, pointer);
    if (!band) continue;
    if (band[0] >= band[1]) c.sink.error('avatar-band-order', pointer, `${name} is [${round(band[0])}, ${round(band[1])}]: yStart must be smaller than yEnd`, hint);
    else ordered.set(pointer, band);
  }
  const neck = ordered.get('/head/neck');
  const chin = vec(c, '/face/chin');
  if (neck && chin && chin[1] > neck[0]) {
    // Head weight at the chin row: 1 above the band, a smoothstep down to 0 at its end.
    const weight = 1 - smoothstep((chin[1] - neck[0]) / (neck[1] - neck[0]));
    if (weight < 0.9) {
      c.sink.warning(
        'avatar-neck-above-chin',
        '/head/neck',
        `the neck band starts at y = ${round(neck[0])}, above the chin (y = ${round(chin[1])}): the chin gets only ${Math.round(weight * 100)}% of the head motion`,
        `start the band just below the chin, e.g. [${Math.ceil(chin[1] + 2)}, ${round(Math.max(neck[1], chin[1] + 20))}]`,
      );
    }
  }
}

function checkMouth(c: Check): void {
  const left = vec(c, '/face/mouth/imageLeft');
  const right = vec(c, '/face/mouth/imageRight');
  if (left && right && left[0] >= right[0]) {
    c.sink.error(
      'avatar-mouth-corners-swapped',
      '/face/mouth',
      `the imageLeft mouth corner ${fmt(left)} is not left of the imageRight corner ${fmt(right)}`,
      '"imageLeft" is the corner on the LEFT SIDE OF THE IMAGE as you look at it: swap the two',
    );
  }
  const center = vec(c, '/face/mouth/area/center');
  const radius = readRadius(resolvePointer(c.doc, '/face/mouth/area/radius'));
  if (!center || !radius) return;
  const rotation = num(c, '/face/mouth/area/rotation') ?? 0;
  for (const [side, p] of [['imageLeft', left], ['imageRight', right]] as const) {
    if (!p) continue;
    const level = ellipseLevel(center, radius, rotation, p[0], p[1]);
    if (level > 1 + EDGE) {
      c.sink.error(
        'avatar-mouth-area',
        '/face/mouth/area',
        `the mouth area does not contain the ${side} mouth corner ${fmt(p)} (it lies at ${round(level, 2)}x the ellipse radius)`,
        'the area is an ellipse a little larger than the lips, centred on the mouth: move or enlarge it (and check its rotation: degrees, clockwise)',
      );
    }
  }
}

function checkIds(c: Check): void {
  const lists: Array<[string, string]> = [
    ['/hair/strands', 'strand'],
    ['/attachments', 'attachment'],
  ];
  for (const [pointer, kind] of lists) {
    const list = resolvePointer(c.doc, pointer);
    if (!Array.isArray(list)) continue;
    const first = new Map<string, number>();
    list.forEach((entry, i) => {
      const id = isPlainObject(entry) ? entry.id : undefined;
      if (typeof id !== 'string' || !ID_PATTERN.test(id)) return;
      const earlier = first.get(id);
      if (earlier !== undefined) {
        c.sink.error('avatar-duplicate-id', `${pointer}/${i}/id`, `duplicate ${kind} id "${id}" (first used by ${pointer}/${earlier})`, `every ${kind} needs its own id, e.g. "${id}2"`);
      } else {
        first.set(id, i);
      }
      if (kind === 'attachment' && AVATAR_RESERVED_IDS.includes(id)) {
        c.sink.error(
          'avatar-reserved-id',
          `${pointer}/${i}/id`,
          `the attachment id "${id}" is reserved for a generated layer`,
          `name the object itself, e.g. "tassel" or "${id}Accessory" (reserved: ${AVATAR_RESERVED_IDS.join(', ')})`,
        );
      }
    });
  }
}

function checkPendulums(c: Check): void {
  const list = resolvePointer(c.doc, '/attachments');
  if (!Array.isArray(list)) return;
  list.forEach((a, i) => {
    if (!isPlainObject(a) || a.kind !== 'pendulum') return;
    const pivot = readVec(a.pivot);
    const tip = readVec(a.tip);
    if (pivot && tip && distance(pivot[0], pivot[1], tip[0], tip[1]) < 1) {
      c.sink.error(
        'avatar-pendulum-degenerate',
        `/attachments/${i}/tip`,
        `pendulum "${typeof a.id === 'string' ? a.id : `#${i}`}": pivot and tip are the same point ${fmt(pivot)}`,
        'pivot = where the object hangs from, tip = its free end: the swing needs the direction and length between them',
      );
    }
  });
}

/** Amounts far from anything that renders well: almost always a unit mix-up (radians, fractions) or a typo. */
function checkAmounts(c: Check): void {
  const warn = (pointer: string, message: string, hint: string) => c.sink.warning('avatar-implausible-value', pointer, message, hint);
  const width = c.size?.width;
  const height = c.size?.height;
  const long = c.size ? Math.max(c.size.width, c.size.height) : undefined;
  const px = (share: number, of: number) => String(round(share * of, 0));

  const turnX = num(c, '/head/turn/x');
  if (turnX !== null) {
    if (turnX <= 0) warn('/head/turn/x', `head.turn.x is ${round(turnX, 2)}: the amount must be positive`, 'it is the distance in px the face centre moves at AngleX = 30 (the direction is fixed: the face turns toward the screen right)');
    else if (width && turnX > 0.12 * width) warn('/head/turn/x', `head.turn.x = ${round(turnX)} px is ${Math.round((turnX / width) * 100)}% of the image width: the mesh will tear or fold`, `typical: 2-5% of the width (${px(0.02, width)}-${px(0.05, width)} px)`);
  }
  const turnY = num(c, '/head/turn/y');
  if (turnY !== null) {
    if (turnY <= 0) warn('/head/turn/y', `head.turn.y is ${round(turnY, 2)}: the amount must be positive`, 'it is the distance in px the face centre moves at AngleY = 30 (the direction is fixed: the face looks up)');
    else if (height && turnY > 0.1 * height) warn('/head/turn/y', `head.turn.y = ${round(turnY)} px is ${Math.round((turnY / height) * 100)}% of the image height: the mesh will tear or fold`, `typical: 1.5-4% of the height (${px(0.015, height)}-${px(0.04, height)} px)`);
  }
  const tilt = num(c, '/head/tilt');
  if (tilt !== null && (tilt <= 0 || tilt > 25)) {
    warn('/head/tilt', `head.tilt = ${round(tilt, 2)} degrees ${tilt <= 0 ? 'must be positive' : 'is a very strong head roll'}`, `degrees of head roll at AngleZ = 30; typical 5-12${tilt > 0 && tilt < 1 ? ' (a value below 1 looks like radians)' : ''}`);
  } else if (tilt !== null && tilt < 1) {
    warn('/head/tilt', `head.tilt = ${round(tilt, 3)} degrees is barely visible`, 'degrees, not radians: typical 5-12');
  }
  const sway = num(c, '/body/sway');
  if (sway !== null && (sway < 0 || sway > 8)) {
    warn('/body/sway', `body.sway = ${round(sway, 2)} degrees ${sway < 0 ? 'must not be negative' : 'is a very strong body rotation'}`, 'degrees of body rotation at BodyAngleX = 10; typical 1-4 (0 switches the sway off)');
  }
  const breath = num(c, '/body/breath');
  if (breath !== null && (breath < 0 || (height !== undefined && breath > 0.02 * height))) {
    warn('/body/breath', `body.breath = ${round(breath, 2)} px ${breath < 0 ? 'must not be negative' : 'is a very deep breath'}`, `px the chest rises at Breath = 1; typical 0.2-0.6% of the image height${height ? ` (${round(0.002 * height)}-${round(0.006 * height)} px)` : ''}`);
  }

  const strands = resolvePointer(c.doc, '/hair/strands');
  if (Array.isArray(strands) && long) {
    strands.forEach((s, i) => {
      const swing = isPlainObject(s) && typeof s.swing === 'number' ? s.swing : null;
      if (swing !== null && swing > 0.08 * long) {
        warn(`/hair/strands/${i}/swing`, `strand swing = ${round(swing)} px is ${Math.round((swing / long) * 100)}% of the image: the lock would fly off`, `largest tip displacement in px; typical 0.5-1.5% of the image (${px(0.005, long)}-${px(0.015, long)} px)`);
      }
    });
  }
  const attachments = resolvePointer(c.doc, '/attachments');
  if (Array.isArray(attachments)) {
    attachments.forEach((a, i) => {
      if (!isPlainObject(a) || typeof a.swing !== 'number') return;
      if (a.kind === 'pendulum' && a.swing > 60) warn(`/attachments/${i}/swing`, `pendulum swing = ${round(a.swing)} degrees is more than a pendulum on a head can do`, 'largest swing angle in degrees; typical 8-20');
      if (a.kind === 'pendulum' && a.swing < 1) warn(`/attachments/${i}/swing`, `pendulum swing = ${round(a.swing, 3)} degrees is barely visible`, 'degrees, not radians: typical 8-20');
      if (a.kind === 'jiggle' && long && a.swing > 0.05 * long) warn(`/attachments/${i}/swing`, `jiggle swing = ${round(a.swing)} px is ${Math.round((a.swing / long) * 100)}% of the image`, `largest displacement in px; typical 0.2-0.6% of the image (${px(0.002, long)}-${px(0.006, long)} px)`);
    });
  }
}

/** Convenience for callers that only need to know whether a result has errors. */
export function avatarSpecHasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === 'error');
}
