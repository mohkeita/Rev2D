/**
 * Agent tools: coordinate grid, landmark overlay, vision check (image properties on a small
 * synthetic picture: sizes, a line / label / shape pixel where it must be) and the geometry helpers.
 */
import { describe, expect, it } from 'vitest';
import type { ImageRGBA } from '../../core/types.js';
import { parseColor } from '../../core/color.js';
import { draftAvatarSpec } from '../spec.js';
import { AVATAR_PART_GROUPS } from '../parts.js';
import { avatarGrid } from '../tools/grid.js';
import { avatarOverlay } from '../tools/overlay.js';
import { makeVisionCheck, scoreVisionCheck, VISION_CHECK_MARKERS, type VisionCheckKey } from '../tools/vision-check.js';
import { AvatarToolError } from '../tools/view.js';
import {
  distanceToOutline,
  ellipseBounds,
  ellipseLevel,
  ellipseOutline,
  outsideDistance,
  pointInPolygon,
  pointsBounds,
  polygonArea,
  polygonCentroid,
  polygonSelfIntersection,
  polygonsOverlap,
  segmentCrossing,
} from '../tools/geometry.js';
import { HEIGHT, testImage, validDoc, WIDTH } from './fixtures.js';

type Px = [number, number, number, number];

function px(img: ImageRGBA, x: number, y: number): Px {
  const i = (Math.round(y) * img.width + Math.round(x)) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
}

function rgb(color: string): Px {
  const c = parseColor(color)!;
  return [Math.round(c[0] * 255), Math.round(c[1] * 255), Math.round(c[2] * 255), 255];
}

function luma(p: Px): number {
  return p[0] + p[1] + p[2];
}

/** Number of pixels of exactly this colour inside a rectangle. */
function count(img: ImageRGBA, color: Px, x0 = 0, y0 = 0, x1 = img.width, y1 = img.height): number {
  let n = 0;
  const d = img.data;
  const xa = Math.max(0, Math.round(x0));
  const xb = Math.min(img.width, Math.round(x1));
  for (let y = Math.max(0, Math.round(y0)); y < Math.min(img.height, Math.round(y1)); y++) {
    for (let i = (y * img.width + xa) * 4, end = (y * img.width + xb) * 4; i < end; i += 4) {
      if (d[i] === color[0] && d[i + 1] === color[1] && d[i + 2] === color[2]) n++;
    }
  }
  return n;
}

function toolError(fn: () => unknown): AvatarToolError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AvatarToolError);
    return e as AvatarToolError;
  }
  throw new Error('expected an AvatarToolError');
}

const SOURCE = testImage();
const MARGIN = rgb('#1f2124');
const LABEL = rgb('#f2f2f2');
const BODY = rgb('#22262e');

describe('avatarGrid: the whole image', () => {
  const grid = avatarGrid(SOURCE);
  const [ox, oy] = grid.origin;

  it('magnifies by a whole number and frames the picture with ruler margins', () => {
    expect(grid.region).toEqual([0, 0, WIDTH, HEIGHT]);
    expect(grid.scale).toBe(3);
    expect(grid.image.width).toBe(WIDTH * 3 + 2 * ox);
    expect(grid.image.height).toBeGreaterThan(HEIGHT * 3 + 2 * oy);
    expect(px(grid.image, 2, 2)).toEqual(MARGIN);
    expect(px(grid.image, grid.image.width - 3, oy + 100)).toEqual(MARGIN);
    // The long side lands in the readable range.
    expect(Math.max(WIDTH, HEIGHT) * grid.scale).toBeGreaterThanOrEqual(1000);
    expect(Math.max(WIDTH, HEIGHT) * grid.scale).toBeLessThanOrEqual(1600);
  });

  it('keeps source pixels crisp and shows a checkerboard where the picture is transparent', () => {
    // Source pixel (200, 410) is flat "body" colour; away from grid lines every output pixel of it is exact.
    expect(px(grid.image, ox + 205 * 3 + 1, oy + 410 * 3 + 1)).toEqual(BODY);
    expect(px(grid.image, ox + 165 * 3 + 1, oy + 195 * 3 + 1)).toEqual([255, 255, 255, 255]);
    // Transparent corner: two checker greys, both opaque.
    const seen = new Set<string>();
    for (let x = 0; x < 40; x++) seen.add(px(grid.image, ox + 4 + x, oy + 4).join(','));
    expect([...seen].sort()).toEqual(['204,204,204,255', '240,240,240,255']);
  });

  it('draws each grid line as a dark and a light pixel with the coordinate between them', () => {
    expect(grid.step).toBe(20);
    expect(grid.labelStep).toBe(20);
    // Vertical line x = 200 over the flat body colour (row y = 410.3, not on a horizontal line).
    const X = ox + 200 * 3;
    const Y = oy + 410 * 3 + 1;
    expect(luma(px(grid.image, X - 1, Y))).toBeLessThan(luma(BODY));
    expect(luma(px(grid.image, X, Y))).toBeGreaterThan(luma(BODY) + 300);
    expect(px(grid.image, X - 2, Y)).toEqual(BODY);
    expect(px(grid.image, X + 1, Y)).toEqual(BODY);
    // Horizontal line y = 400, the same way.
    const Y2 = oy + 400 * 3;
    const X2 = ox + 205 * 3 + 1;
    expect(luma(px(grid.image, X2, Y2 - 1))).toBeLessThan(luma(BODY));
    expect(luma(px(grid.image, X2, Y2))).toBeGreaterThan(luma(BODY) + 300);
    // Lines on round coordinates (x = 200) are stronger than the others (x = 220).
    expect(luma(px(grid.image, X, Y))).toBeGreaterThan(luma(px(grid.image, ox + 220 * 3, Y)) + 100);
    // No line where none belongs (x = 210).
    expect(px(grid.image, ox + 210 * 3, Y)).toEqual(BODY);
  });

  it('labels the lines in source coordinates on all four sides', () => {
    const X = ox + 200 * 3;
    const Y = oy + 300 * 3;
    const near = (x0: number, y0: number, x1: number, y1: number) => count(grid.image, LABEL, x0, y0, x1, y1);
    expect(near(X - 25, 0, X + 25, oy)).toBeGreaterThan(40); // top: "200"
    expect(near(X - 25, oy + HEIGHT * 3, X + 25, oy + HEIGHT * 3 + oy)).toBeGreaterThan(40); // bottom
    expect(near(0, Y - 10, ox, Y + 10)).toBeGreaterThan(40); // left: "300"
    expect(near(ox + WIDTH * 3, Y - 10, grid.image.width, Y + 10)).toBeGreaterThan(40); // right
    // The footer explains the picture.
    expect(near(0, oy * 2 + HEIGHT * 3, grid.image.width, grid.image.height)).toBe(0);
    expect(count(grid.image, rgb('#9aa0a6'), 0, oy * 2 + HEIGHT * 3, grid.image.width, grid.image.height)).toBeGreaterThan(200);
  });

  it('is deterministic', () => {
    expect(Buffer.compare(Buffer.from(avatarGrid(SOURCE).image.data), Buffer.from(grid.image.data))).toBe(0);
  });
});

describe('avatarGrid: a region', () => {
  it('magnifies the rectangle with a fine grid labelled in source coordinates', () => {
    const grid = avatarGrid(SOURCE, { region: [140, 170, 190, 220] });
    expect(grid.region).toEqual([140, 170, 190, 220]);
    expect(grid.scale).toBe(26);
    expect(50 * grid.scale).toBeGreaterThanOrEqual(1000);
    expect(grid.step).toBeLessThanOrEqual(5);
    expect(grid.image.width).toBe(50 * 26 + 2 * grid.origin[0]);
    // Source pixel (165.5, 195.5), the white eye, maps through the origin and the scale.
    const X = grid.origin[0] + (165.5 - 140) * 26;
    const Y = grid.origin[1] + (195.5 - 170) * 26;
    expect(px(grid.image, X, Y)).toEqual([255, 255, 255, 255]);
    // The line x = 150 lies exactly at origin + 10 * scale: light pixel on it, dark pixel left of it.
    const L = grid.origin[0] + 10 * 26;
    const skin = rgb('#f6d8c6');
    const row = grid.origin[1] + (212.5 - 170) * 26;
    expect(px(grid.image, L + 8, row)).toEqual(skin);
    expect(luma(px(grid.image, L - 1, row))).toBeLessThan(luma(skin) - 100);
    expect(luma(px(grid.image, L, row))).toBeGreaterThan(luma(skin));
  });

  it('accepts corners in any order, clips to the image and honours step and scale', () => {
    const grid = avatarGrid(SOURCE, { region: [420, 520, 300.4, 399.2], step: 10, scale: 4 });
    expect(grid.region).toEqual([300, 399, 400, 500]);
    expect(grid.scale).toBe(4);
    expect(grid.step).toBe(10);
    expect(grid.labelStep % 10).toBe(0);
    expect(grid.image.width).toBe(100 * 4 + 2 * grid.origin[0]);
  });

  it('fails with a hint for unusable input', () => {
    expect(toolError(() => avatarGrid(SOURCE, { region: [500, 0, 600, 100] })).message).toMatch(/does not overlap the 400x500 image/);
    expect(toolError(() => avatarGrid(SOURCE, { region: [1, 2, 3] })).hint).toMatch(/e\.g\. 420,380,580,520/);
    expect(toolError(() => avatarGrid(SOURCE, { scale: 2.5 })).message).toMatch(/whole number from 1 to 40/);
    expect(toolError(() => avatarGrid(SOURCE, { step: 0.5 })).message).toMatch(/too fine/);
    expect(toolError(() => avatarGrid(SOURCE, { step: -1 })).message).toMatch(/positive/);
  });
});

describe('avatarOverlay', () => {
  const doc = validDoc();
  const HEAD = rgb('#56B4E9');
  const EYES = rgb('#F0E442');

  it('draws every placed part over the picture in its group colour', () => {
    const o = avatarOverlay(SOURCE, doc);
    expect(o.region).toEqual([0, 0, WIDTH, HEIGHT]);
    expect(o.scale).toBe(3);
    expect(o.drawn).toHaveLength(31);
    expect(o.drawn).toContain('head.ellipse');
    expect(o.drawn).not.toContain('eyes.imageRight.iris');
    expect(o.missing).toEqual([]);
    // The left end of the head ellipse (x = 70, y = 170): the stroke is centred on it.
    expect(px(o.image, o.origin[0] + 70 * 3, o.origin[1] + 170 * 3)).toEqual(HEAD);
    // Every group leaves pixels of its colour.
    for (const g of AVATAR_PART_GROUPS.filter(g=>!['arms','legs'].includes(g.id))) expect(count(o.image, rgb(g.color)), g.id).toBeGreaterThan(30);
    // The picture itself is still there, exact, away from the shapes.
    expect(px(o.image, o.origin[0] + 300 * 3 + 1, o.origin[1] + 470 * 3 + 1)).toEqual(BODY);
  });

  it('draws one group, or the items whose id starts with the part', () => {
    const eyes = avatarOverlay(SOURCE, doc, { part: 'eyes' });
    expect(eyes.drawn).toEqual(['eyes.imageLeft.opening', 'eyes.imageLeft.region', 'eyes.imageLeft.iris', 'eyes.imageRight.opening', 'eyes.imageRight.region']);
    expect(count(eyes.image, HEAD)).toBe(0);
    expect(count(eyes.image, EYES)).toBeGreaterThan(200);
    expect(avatarOverlay(SOURCE, doc, { part: 'attachment.tassel' }).drawn).toEqual(['attachment.tassel.outline', 'attachment.tassel.swing']);
    expect(avatarOverlay(SOURCE, doc, { part: 'strand.sideR' }).drawn).toEqual(['strand.sideR']);
  });

  it('zooms to the selection plus a margin and numbers the vertices', () => {
    const plain = avatarOverlay(SOURCE, doc, { part: 'eyes.imageLeft' });
    const o = avatarOverlay(SOURCE, doc, { part: 'eyes.imageLeft', zoom: true });
    const [x0, y0, x1, y1] = o.region;
    // The region polygon spans x 142..188, y 176..214.
    expect(x0).toBeLessThanOrEqual(130);
    expect(x0).toBeGreaterThan(100);
    expect(y0).toBeLessThanOrEqual(164);
    expect(x1).toBeGreaterThanOrEqual(200);
    expect(y1).toBeGreaterThanOrEqual(226);
    expect(y1).toBeLessThan(260);
    expect(o.scale).toBeGreaterThan(plain.scale * 4);
    // The middle of the region's first edge, (142, 195) -> (150, 180), carries the eye colour.
    const X = o.origin[0] + (146 - x0) * o.scale;
    const Y = o.origin[1] + (187.5 - y0) * o.scale;
    expect(px(o.image, X, Y)).toEqual(EYES);
    // Vertex numbers and item labels are white text on dark boxes inside the picture.
    const inside = (img: ImageRGBA, origin: [number, number], w: number, h: number) => count(img, LABEL, origin[0], origin[1], origin[0] + w, origin[1] + h);
    expect(inside(o.image, o.origin, (x1 - x0) * o.scale, (y1 - y0) * o.scale)).toBeGreaterThan(600);
  });

  it('zooms to a band across the image', () => {
    const o = avatarOverlay(SOURCE, doc, { part: 'head.neck', zoom: true });
    expect(o.region[0]).toBe(0);
    expect(o.region[2]).toBe(WIDTH);
    expect(o.region[1]).toBeLessThan(285);
    expect(o.region[3]).toBeGreaterThan(340);
    // The solid yStart line in the head colour.
    expect(px(o.image, o.origin[0] + 300 * o.scale, o.origin[1] + (285 - o.region[1]) * o.scale)).toEqual(rgb('#56B4E9'));
  });

  it('adds the grid lines on request', () => {
    const a = avatarOverlay(SOURCE, doc, { part: 'body' });
    const b = avatarOverlay(SOURCE, doc, { part: 'body', grid: true });
    expect(a.image.width).toBe(b.image.width);
    expect(Buffer.compare(Buffer.from(a.image.data), Buffer.from(b.image.data))).not.toBe(0);
    const X = b.origin[0] + 300 * b.scale;
    const Y = b.origin[1] + 470 * b.scale + 1;
    expect(px(a.image, X, Y)).toEqual(BODY);
    expect(luma(px(b.image, X, Y))).toBeGreaterThan(luma(BODY) + 300);
  });

  it('works on an unfinished draft and reports what is not placed', () => {
    const draft = draftAvatarSpec('x', WIDTH, HEIGHT) as any;
    draft.head.center = [200, 170];
    draft.head.radius = [130, 150];
    draft.face.nose = [200, 225];
    const o = avatarOverlay(SOURCE, draft);
    expect(o.drawn).toEqual(['head.ellipse', 'face.nose']);
    expect(o.missing).toContain('eyes.imageLeft.opening');
    expect(o.missing).toHaveLength(13);
    expect(avatarOverlay(SOURCE, draft, { part: 'head' }).missing).toEqual(['head.pivot', 'head.neck']);
  });

  it('fails with a hint when there is nothing to draw or the part is unknown', () => {
    const empty = toolError(() => avatarOverlay(SOURCE, draftAvatarSpec('x', WIDTH, HEIGHT)));
    expect(empty.message).toBe('nothing to draw: no landmark is placed yet');
    expect(empty.hint).toContain('rev2d avatar validate');
    expect(toolError(() => avatarOverlay(SOURCE, validDoc(), { part: 'cheeks.imageUp' })).message).toBe('unknown part "cheeks.imageUp"');
    const typo = toolError(() => avatarOverlay(SOURCE, doc, { part: 'eye' }));
    expect(typo.hint).toContain('did you mean "eyes"?');
    expect(typo.hint).toContain('groups: head, eyes, mouth, face, cheeks, strands, attachments, arms, legs, body');
    const noCheeks = validDoc();
    delete noCheeks.face.cheeks;
    expect(toolError(() => avatarOverlay(SOURCE, noCheeks, { part: 'cheeks' })).message).toBe('nothing to draw: no landmark of "cheeks" is placed yet');
  });

  it('is deterministic', () => {
    const a = avatarOverlay(SOURCE, doc, { part: 'eyes', zoom: true });
    const b = avatarOverlay(SOURCE, validDoc(), { part: 'eyes', zoom: true });
    expect(Buffer.compare(Buffer.from(a.image.data), Buffer.from(b.image.data))).toBe(0);
  });
});

describe('vision check', () => {
  const check = makeVisionCheck({ seed: 3, size: 512 });
  const exact = (key: VisionCheckKey) => Object.fromEntries(Object.entries(key.markers).map(([id, p]) => [id, [...p]]));
  const shifted = (key: VisionCheckKey, f: (p: [number, number]) => [number, number]) => Object.fromEntries(Object.entries(key.markers).map(([id, p]) => [id, f(p)]));

  it('makes a busy image with 12 numbered markers at whole pixels, apart from each other', () => {
    expect(check.image.width).toBe(512);
    expect(check.image.height).toBe(512);
    expect(check.key).toMatchObject({ version: 1, seed: 3, size: 512 });
    const points = Object.values(check.key.markers);
    expect(Object.keys(check.key.markers)).toEqual(Array.from({ length: VISION_CHECK_MARKERS }, (_, i) => String(i + 1)));
    for (const [x, y] of points) {
      expect(Number.isInteger(x) && Number.isInteger(y)).toBe(true);
      expect(x).toBeGreaterThanOrEqual(32);
      expect(x).toBeLessThan(480);
      expect(y).toBeGreaterThanOrEqual(32);
      expect(y).toBeLessThan(480);
    }
    for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) expect(Math.hypot(points[i][0] - points[j][0], points[i][1] - points[j][1])).toBeGreaterThanOrEqual(48);
    // Busy: many different colours, every pixel opaque.
    const colors = new Set<number>();
    for (let i = 0; i < check.image.data.length; i += 4 * 7) colors.add((check.image.data[i] << 16) | (check.image.data[i + 1] << 8) | check.image.data[i + 2]);
    expect(colors.size).toBeGreaterThan(300);
    expect(check.image.data[3]).toBe(255);
  });

  it('centres each crosshair exactly on its coordinate and leaves the centre open', () => {
    const white: Px = [255, 255, 255, 255];
    const black: Px = [0, 0, 0, 255];
    for (const [x, y] of Object.values(check.key.markers)) {
      // Upper arm: white columns x - 1 and x, black edges at x - 2 and x + 1.
      expect(px(check.image, x - 1, y - 6)).toEqual(white);
      expect(px(check.image, x, y - 6)).toEqual(white);
      expect(px(check.image, x - 2, y - 6)).toEqual(black);
      expect(px(check.image, x + 1, y - 6)).toEqual(black);
      // Right arm: white rows y - 1 and y.
      expect(px(check.image, x + 6, y - 1)).toEqual(white);
      expect(px(check.image, x + 6, y)).toEqual(white);
      expect(px(check.image, x + 6, y - 2)).toEqual(black);
      expect(px(check.image, x + 6, y + 1)).toEqual(black);
      // The centre is artwork: neither the white nor the black of the marker within one pixel of it.
      for (const p of [px(check.image, x - 1, y - 1), px(check.image, x, y), px(check.image, x - 1, y), px(check.image, x, y - 1)]) {
        expect(p).not.toEqual(white);
        expect(p).not.toEqual(black);
      }
    }
  });

  it('is deterministic per seed', () => {
    const again = makeVisionCheck({ seed: 3, size: 512 });
    expect(again.key).toEqual(check.key);
    expect(Buffer.compare(Buffer.from(again.image.data), Buffer.from(check.image.data))).toBe(0);
    const other = makeVisionCheck({ seed: 4, size: 512 });
    expect(other.key.markers).not.toEqual(check.key.markers);
    expect(makeVisionCheck().key).toMatchObject({ seed: 1, size: 1024 });
    expect(toolError(() => makeVisionCheck({ size: 100 })).message).toMatch(/256 to 4096/);
    expect(toolError(() => makeVisionCheck({ seed: 1.5 })).message).toMatch(/whole number/);
  });

  it('scores a perfect and a slightly-off answer as passes', () => {
    const perfect = scoreVisionCheck(check.key, exact(check.key));
    expect(perfect).toMatchObject({ pass: true, mean: 0, max: 0, answered: 12, total: 12, bias: [0, 0] });
    // Limits scale with the size: 4 and 10 px at 1024.
    expect(perfect.limits).toEqual({ mean: 2, max: 5 });
    expect(makeVisionCheck({ size: 2048 }).key.size).toBe(2048);
    expect(scoreVisionCheck({ ...check.key, size: 2048 }, exact(check.key)).limits).toEqual({ mean: 8, max: 20 });
    const off = scoreVisionCheck(check.key, shifted(check.key, ([x, y]) => [x + 1, y - 1]));
    expect(off.pass).toBe(true);
    expect(off.mean).toBeCloseTo(Math.SQRT2, 2);
    expect(off.markers[0]).toMatchObject({ id: '1', error: 1.41 });
    expect(off.advice).toMatch(/Mean error 1\.4 px, largest 1\.4 px \(limits 2 \/ 5 px\): you read coordinates well enough/);
    // {x, y} objects are accepted too.
    expect(scoreVisionCheck(check.key, Object.fromEntries(Object.entries(check.key.markers).map(([id, p]) => [id, { x: p[0], y: p[1] }]))).pass).toBe(true);
  });

  it('fails on the mean or on a single outlier', () => {
    const coarse = scoreVisionCheck(check.key, shifted(check.key, ([x, y]) => [x + 3, y]));
    expect(coarse).toMatchObject({ pass: false, mean: 3, max: 3 });
    const answer = exact(check.key);
    answer['7'] = [answer['7'][0] + 9, answer['7'][1]];
    const outlier = scoreVisionCheck(check.key, answer);
    expect(outlier).toMatchObject({ pass: false, max: 9 });
    expect(outlier.mean).toBeLessThan(2);
    expect(outlier.advice).toMatch(/Largest errors: marker 7 \(9 px\)/);
    expect(outlier.advice).toMatch(/rev2d avatar grid <image> --region/);
  });

  it('recognises a constant shift, a scale factor and swapped axes', () => {
    const shift = scoreVisionCheck(check.key, shifted(check.key, ([x, y]) => [x + 31, y + 15]));
    expect(shift.pass).toBe(false);
    expect(shift.bias).toEqual([31, 15]);
    expect(shift.advice).toMatch(/shifted by about \(31, 15\) px on average/);
    const scaled = scoreVisionCheck(check.key, shifted(check.key, ([x, y]) => [Math.round(x * 0.75), Math.round(y * 0.75)]));
    expect(scaled.advice).toMatch(/about 0\.75x the true ones: you are measuring in a resized copy/);
    const swapped = scoreVisionCheck(check.key, shifted(check.key, ([x, y]) => [y, x]));
    expect(swapped.advice).toMatch(/x and y look swapped/);
  });

  it('counts missing and malformed answers as failures', () => {
    const answer: Record<string, unknown> = exact(check.key);
    delete answer['4'];
    answer['9'] = 'top left';
    answer.note = 'hello';
    const r = scoreVisionCheck(check.key, answer);
    expect(r).toMatchObject({ pass: false, answered: 10, total: 12, mean: 0 });
    expect(r.markers.find((m) => m.id === '4')).toMatchObject({ answer: null, error: null });
    expect(r.advice).toMatch(/No usable answer for markers 4, 9/);
    expect(r.advice).toMatch(/Ignored entries that are not marker numbers: note/);
    expect(scoreVisionCheck(check.key, {})).toMatchObject({ pass: false, answered: 0, mean: null, max: null, bias: null });
    expect(toolError(() => scoreVisionCheck(check.key, [[1, 2]])).hint).toMatch(/\{"1": \[312, 148\]/);
    expect(toolError(() => scoreVisionCheck({ version: 1, seed: 1, size: 0, markers: {} }, {})).message).toMatch(/damaged/);
  });
});

describe('geometry helpers', () => {
  const square = [0, 0, 10, 0, 10, 10, 0, 10];
  const concave = [0, 0, 10, 0, 10, 10, 5, 4, 0, 10];

  it('measures polygons', () => {
    expect(polygonArea(square)).toBe(100);
    expect(polygonArea([...square].reverse().flatMap((_, i, a) => (i % 2 ? [] : [a[i + 1], a[i]])))).toBe(-100);
    expect(polygonCentroid(square)).toEqual([5, 5]);
    expect(polygonCentroid([0, 0, 4, 0])).toEqual([2, 0]);
    expect(pointsBounds([3, 4, -1, 9, 5])).toEqual([-1, 4, 3, 9]);
    expect(pointsBounds([])).toBeNull();
  });

  it('tests points against polygons of both windings, concave ones included', () => {
    expect(pointInPolygon(5, 5, square)).toBe(true);
    expect(pointInPolygon(11, 5, square)).toBe(false);
    expect(pointInPolygon(5, 8, concave)).toBe(false);
    expect(pointInPolygon(2, 3, concave)).toBe(true);
    expect(outsideDistance(5, 5, square)).toBe(0);
    expect(outsideDistance(13, 5, square)).toBe(3);
    expect(outsideDistance(13, 14, square)).toBe(5);
    expect(distanceToOutline(5, 5, square)).toBe(5);
    expect(distanceToOutline(5, -2, [0, 0, 10, 0], false)).toBe(2);
  });

  it('finds crossings, self-intersections and overlaps', () => {
    expect(segmentCrossing(0, 0, 10, 10, 0, 10, 10, 0)).toEqual([5, 5]);
    expect(segmentCrossing(0, 0, 10, 0, 10, 0, 10, 10)).toBeNull(); // touching ends
    expect(segmentCrossing(0, 0, 10, 0, 2, 0, 8, 0)).toBeNull(); // collinear
    expect(polygonSelfIntersection(square)).toBeNull();
    expect(polygonSelfIntersection(concave)).toBeNull();
    expect(polygonSelfIntersection([0, 0, 10, 10, 10, 0, 0, 10])).toEqual({ edgeA: 0, edgeB: 2, at: [5, 5] });
    expect(polygonsOverlap(square, [5, 5, 15, 5, 15, 15, 5, 15])).toBe(true);
    expect(polygonsOverlap(square, [2, 2, 4, 2, 4, 4, 2, 4])).toBe(true); // containment
    expect(polygonsOverlap(square, [20, 0, 30, 0, 30, 10, 20, 10])).toBe(false);
  });

  it('handles rotated ellipses (degrees, clockwise with +y down)', () => {
    expect(ellipseLevel([0, 0], [10, 5], 0, 10, 0)).toBe(1);
    expect(ellipseLevel([0, 0], [10, 5], 0, 0, 2.5)).toBe(0.5);
    // Rotated by 90 degrees clockwise the long axis points down.
    expect(ellipseLevel([0, 0], [10, 5], 90, 0, 10)).toBeCloseTo(1, 9);
    expect(ellipseLevel([0, 0], [10, 5], 90, 10, 0)).toBeCloseTo(2, 9);
    const b = ellipseBounds([100, 50], [10, 5], 90);
    expect(b.map((v) => Math.round(v))).toEqual([95, 40, 105, 60]);
    const outline = ellipseOutline([100, 50], [10, 5], 30, 64);
    expect(outline).toHaveLength(128);
    for (let i = 0; i < 64; i++) expect(ellipseLevel([100, 50], [10, 5], 30, outline[i * 2], outline[i * 2 + 1])).toBeCloseTo(1, 9);
    // A quarter turn clockwise on screen: the point that started on +x ends on +y (down).
    const quarter = ellipseOutline([0, 0], [10, 5], 90, 4);
    expect(quarter[0]).toBeCloseTo(0, 9);
    expect(quarter[1]).toBeCloseTo(10, 9);
  });
});
