import { describe, expect, it } from 'vitest';
import {
  clipTransform,
  fitRect,
  formatZoom,
  panBy,
  screenToWorld,
  stepZoom,
  unionRects,
  visibleRect,
  wheelZoomFactor,
  worldToScreen,
  zoomAt,
  MAX_ZOOM,
  MIN_ZOOM,
  type Camera,
} from '../editor/src/view/camera.js';
import { cyclePick, distanceToSegment, pickBone, pickParts, pointInTriangle, type PickItem } from '../editor/src/view/picking.js';

const vp = { width: 800, height: 600 };

describe('editor camera math', () => {
  const cam: Camera = { cx: 256, cy: 256, zoom: 2 };

  it('maps the camera center to the viewport center and round-trips', () => {
    expect(worldToScreen(cam, vp, 256, 256)).toEqual([400, 300]);
    expect(worldToScreen(cam, vp, 266, 246)).toEqual([420, 280]);
    const [wx, wy] = screenToWorld(cam, vp, 123.5, 77.25);
    const [sx, sy] = worldToScreen(cam, vp, wx, wy);
    expect(sx).toBeCloseTo(123.5, 9);
    expect(sy).toBeCloseTo(77.25, 9);
  });

  it('zooms about the cursor, keeping the model point under it fixed', () => {
    const before = screenToWorld(cam, vp, 100, 500);
    const next = zoomAt(cam, vp, 100, 500, 1.7);
    expect(next.zoom).toBeCloseTo(3.4, 9);
    const after = screenToWorld(next, vp, 100, 500);
    expect(after[0]).toBeCloseTo(before[0], 9);
    expect(after[1]).toBeCloseTo(before[1], 9);
  });

  it('clamps zoom to the supported range', () => {
    expect(zoomAt(cam, vp, 0, 0, 1e6).zoom).toBe(MAX_ZOOM);
    expect(zoomAt(cam, vp, 0, 0, 1e-9).zoom).toBe(MIN_ZOOM);
  });

  it('pans so content follows the pointer', () => {
    const next = panBy(cam, 20, -10);
    expect(worldToScreen(next, vp, 256, 256)).toEqual([420, 290]);
  });

  it('fits a rect with padding and centers it', () => {
    const fit = fitRect([0, 0, 512, 256], vp, 44);
    expect(fit.cx).toBe(256);
    expect(fit.cy).toBe(128);
    expect(fit.zoom).toBeCloseTo((800 - 88) / 512, 9);
    const [x0] = worldToScreen(fit, vp, 0, 0);
    expect(x0).toBeCloseTo(44, 9);
  });

  it('reports the visible model rect (published as EditorState.viewBox)', () => {
    expect(visibleRect(cam, vp)).toEqual([56, 106, 400, 300]);
    const fit = fitRect([10, 20, 100, 50], { width: 100, height: 50 }, 0);
    const r = visibleRect(fit, { width: 100, height: 50 });
    r.forEach((v, i) => expect(v).toBeCloseTo([10, 20, 100, 50][i], 9));
  });

  it('produces a world->clip transform matching worldToScreen', () => {
    const [sx, sy, ox, oy] = clipTransform(cam, vp);
    for (const [x, y] of [
      [256, 256],
      [0, 0],
      [400, 100],
    ]) {
      const [px, py] = worldToScreen(cam, vp, x, y);
      expect(x * sx + ox).toBeCloseTo((px / vp.width) * 2 - 1, 9);
      expect(y * sy + oy).toBeCloseTo(1 - (py / vp.height) * 2, 9);
    }
  });

  it('turns wheel deltas into smooth zoom factors (down = out)', () => {
    expect(wheelZoomFactor(0)).toBe(1);
    expect(wheelZoomFactor(100)).toBeLessThan(1);
    expect(wheelZoomFactor(-100)).toBeGreaterThan(1);
    expect(wheelZoomFactor(-100) * wheelZoomFactor(100)).toBeCloseTo(1, 9);
    expect(wheelZoomFactor(3, 1)).toBeCloseTo(wheelZoomFactor(99), 9);
  });

  it('steps through discrete zoom levels', () => {
    expect(stepZoom(1, 1)).toBe(1.5);
    expect(stepZoom(1, -1)).toBe(0.667);
    expect(stepZoom(1.2, -1)).toBe(1);
    expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
  });

  it('unions rects and formats zoom', () => {
    expect(unionRects([[0, 0, 10, 10], null, [5, -5, 10, 10]])).toEqual([0, -5, 15, 15]);
    expect(unionRects([])).toBeNull();
    expect(formatZoom(1)).toBe('100%');
    expect(formatZoom(0.125)).toBe('12.5%');
  });
});

describe('editor picking', () => {
  // Two overlapping squares: "back" drawn first, "front" on top; front has a stroke item too.
  const square = (x: number, y: number, s: number) => ({
    positions: new Float32Array([x, y, x + s, y, x + s, y + s, x, y + s]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  });
  const items: PickItem[] = [
    { partId: 'back', ...square(0, 0, 100) },
    { partId: 'front', ...square(50, 50, 100) },
    { partId: 'front', ...square(48, 48, 104) },
  ];

  it('tests points in triangles of either winding, edges inclusive', () => {
    expect(pointInTriangle(1, 1, 0, 0, 10, 0, 0, 10)).toBe(true);
    expect(pointInTriangle(1, 1, 0, 0, 0, 10, 10, 0)).toBe(true);
    expect(pointInTriangle(5, 5, 0, 0, 10, 0, 0, 10)).toBe(true);
    expect(pointInTriangle(6, 6, 0, 0, 10, 0, 0, 10)).toBe(false);
  });

  it('returns parts top-most first without duplicates', () => {
    expect(pickParts(items, 75, 75)).toEqual(['front', 'back']);
    expect(pickParts(items, 10, 10)).toEqual(['back']);
    expect(pickParts(items, 140, 140)).toEqual(['front']);
    expect(pickParts(items, 300, 300)).toEqual([]);
  });

  it('skips preview-hidden parts', () => {
    expect(pickParts(items, 75, 75, new Set(['front']))).toEqual(['back']);
  });

  it('respects masks: clipped-away points do not pick the part', () => {
    const maskItem = { partId: 'eyeWhite', ...square(0, 0, 20) };
    const iris: PickItem = { partId: 'iris', ...square(10, 0, 20), masks: [maskItem] };
    const outside: PickItem = { partId: 'shade', ...square(10, 0, 20), masks: [maskItem], maskInvert: true };
    expect(pickParts([maskItem, iris], 15, 5)).toEqual(['iris', 'eyeWhite']);
    expect(pickParts([maskItem, iris], 25, 5)).toEqual([]);
    expect(pickParts([outside], 25, 5)).toEqual(['shade']);
    expect(pickParts([outside], 15, 5)).toEqual([]);
  });

  it('treats a present but empty mask list as zero coverage (nothing picks; everything when inverted)', () => {
    const clipped: PickItem = { partId: 'iris', ...square(0, 0, 20), masks: [] };
    const inverted: PickItem = { partId: 'shade', ...square(0, 0, 20), masks: [], maskInvert: true };
    expect(pickParts([clipped], 5, 5)).toEqual([]);
    expect(pickParts([inverted], 5, 5)).toEqual(['shade']);
    // No `masks` field at all: unmasked.
    expect(pickParts([{ partId: 'plain', ...square(0, 0, 20) }], 5, 5)).toEqual(['plain']);
  });

  it('cycles through stacked parts on repeated clicks at the same spot', () => {
    const hits = ['front', 'back'];
    expect(cyclePick(hits, null, true)).toBe('front');
    expect(cyclePick(hits, 'front', true)).toBe('back');
    expect(cyclePick(hits, 'back', true)).toBe('front');
    expect(cyclePick(hits, 'front', false)).toBe('front');
    expect(cyclePick([], 'front', true)).toBeNull();
  });

  it('picks the nearest bone joint, then bone bodies', () => {
    const bones = [
      { id: 'root', x: 100, y: 100, tip: [100, 100] as [number, number] },
      { id: 'arm', x: 110, y: 100, tip: [210, 100] as [number, number] },
    ];
    expect(pickBone(bones, 103, 101, 8)).toBe('root');
    expect(pickBone(bones, 108, 100, 8)).toBe('arm');
    expect(pickBone(bones, 160, 102, 8)).toBe('arm');
    expect(pickBone(bones, 160, 106, 8)).toBeNull();
    expect(distanceToSegment(5, 5, 0, 0, 10, 0)).toBe(5);
    expect(distanceToSegment(-3, 4, 0, 0, 10, 0)).toBe(5);
  });
});
