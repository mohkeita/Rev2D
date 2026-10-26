/**
 * Avatar mode of the editor (editor/src/avatar), the pure parts: handles and their hit tests at
 * constant screen size, every geometry edit, undo / redo, image <-> screen coordinates and framing,
 * the stale-layers comparison, placing landmarks by hand, diagnostics -> parts, the pose controls,
 * the names of every part in English, Korean and Japanese, the lip-sync clock of the store and the
 * AI requests. The spec is the hand-written fixture of the avatar tests (no third-party art).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { describeAvatarParts, draftAvatarSpec, layerInputsHash, parseAvatarSpec, resolveShape, type AvatarPartItemInfo, type LayersMeta } from '../src/avatar/index.js';
import { validDoc, WIDTH, HEIGHT } from '../src/avatar/__tests__/fixtures.js';
import type { AvatarInfo } from '../src/node/editor-registry.js';
import { avatarCreateRequest, fixPartRequest, projectImagePath, terminalRequest } from '../editor/src/avatar/ai.js';
import {
  HANDLE_HIT,
  MIN_VERTICES,
  dragHandle,
  hitBandLine,
  hitBody,
  hitEdge,
  hitHandle,
  insertVertex,
  isCircle,
  partHandles,
  removeVertex,
  sameJson,
  setValue,
  shapeBounds,
  translateItem,
  type Grab,
  type HitShape,
  type SpecDoc,
} from '../editor/src/avatar/geometry.js';
import { SpecHistory, HISTORY_LIMIT } from '../editor/src/avatar/history.js';
import {fullFigureAvatarDoc} from './fixtures/studio.js';
import { ITEM_PATTERNS, groupLabel, handleLabel, itemKeys, itemLabel, itemTip } from '../editor/src/avatar/labels.js';
import { avatarNameFrom, isAvatarName } from '../editor/src/avatar/naming.js';
import { controlValue, poseControls, resetControl, setControl } from '../editor/src/avatar/params.js';
import { addAttachment, addStrand, entryPointer, placeItem, removeEntry, removeItemValue } from '../editor/src/avatar/placement.js';
import { itemForPath, problemsByItem, worstSeverity } from '../editor/src/avatar/problems.js';
import { changedCutItems, layersStale } from '../editor/src/avatar/stale.js';
import { AvatarStore } from '../editor/src/avatar/store.js';
import { AVATAR_MAX_ZOOM, AVATAR_MIN_ZOOM, frameRect, projector, stepAvatarZoom, zoomAround, zoomToLevel } from '../editor/src/avatar/view.js';
import { DICTIONARIES, setLanguage, t, translate, type MessageKey } from '../editor/src/i18n/index.js';
import { freeCenter, type Camera } from '../editor/src/view/camera.js';

afterEach(() => setLanguage('en', false));

const doc = (): SpecDoc => validDoc();
const parts = (d: unknown) => describeAvatarParts(d);
const item = (d: unknown, id: string): AvatarPartItemInfo => {
  const found = parts(d)
    .flatMap((g) => g.items)
    .find((i) => i.id === id);
  if (!found) throw new Error(`no item ${id}`);
  return found;
};
const groupOf = (d: unknown, id: string) => parts(d).find((g) => g.items.some((i) => i.id === id))!.id;
const VP = { width: 1000, height: 800 };

/** Every handle of an item at a camera. */
function handlesOf(d: SpecDoc, id: string, cam: Camera) {
  const it = item(d, id);
  const { toScreen } = projector(cam, VP);
  return partHandles(it.id, groupOf(d, id), it.shape, resolveShape(d, it.shape)!, toScreen, { circle: isCircle(d, it.shape), bandX: 900 });
}

function hitShapes(d: SpecDoc): HitShape[] {
  return parts(d).flatMap((g) => g.items.flatMap((i) => {
    const r = resolveShape(d, i.shape);
    return r ? [{ item: i.id, group: g.id, shape: i.shape, resolved: r }] : [];
  }));
}

// ----------------------------------------------------------------------------- handles

describe('avatar handles', () => {
  it('puts one handle per vertex, ellipse centre / radii / rotation, band edges, segment ends', () => {
    const d = doc();
    const cam = { cx: 200, cy: 250, zoom: 1 };
    expect(handlesOf(d, 'eyes.imageLeft.opening', cam).map((h) => h.role)).toEqual(Array(8).fill('vertex'));
    expect(handlesOf(d, 'head.ellipse', cam).map((h) => h.role)).toEqual(['radiusX', 'radiusY', 'center']);
    expect(handlesOf(d, 'mouth.area', cam).map((h) => h.role)).toEqual(['radiusX', 'radiusY', 'rotation', 'center']);
    // The iris radius is one number: a circle has one radius handle.
    expect(handlesOf(d, 'eyes.imageLeft.iris', cam).map((h) => h.role)).toEqual(['radiusX', 'center']);
    expect(handlesOf(d, 'head.neck', cam).map((h) => [h.role, h.x])).toEqual([
      ['bandStart', 900],
      ['bandEnd', 900],
    ]);
    expect(handlesOf(d, 'mouth.corners', cam).map((h) => h.role)).toEqual(['a', 'b']);
    expect(handlesOf(d, 'face.nose', cam).map((h) => h.role)).toEqual(['point']);
  });

  it('places handles in screen space and keeps their hit radius constant at every zoom', () => {
    const d = doc();
    for (const zoom of [0.25, 1, 4, 16]) {
      const cam = { cx: 200, cy: 200, zoom };
      const hs = handlesOf(d, 'face.nose', cam);
      const { toScreen } = projector(cam, VP);
      const [sx, sy] = toScreen(200, 225);
      expect(hs[0].x).toBeCloseTo(sx, 6);
      expect(hs[0].y).toBeCloseTo(sy, 6);
      // HANDLE_HIT screen px away still grabs it, a little more does not, whatever the zoom.
      expect(hitHandle(hs, sx + HANDLE_HIT - 0.5, sy)?.role).toBe('point');
      expect(hitHandle(hs, sx + HANDLE_HIT + 1, sy)).toBeNull();
    }
  });

  it('picks the nearest handle, and the later one on a tie (drawn on top)', () => {
    const hs = [
      { item: 'a', group: 'head' as const, role: 'point' as const, pointer: '/a', x: 10, y: 10 },
      { item: 'b', group: 'head' as const, role: 'point' as const, pointer: '/b', x: 14, y: 10 },
      { item: 'c', group: 'head' as const, role: 'point' as const, pointer: '/c', x: 14, y: 10 },
    ];
    expect(hitHandle(hs, 11, 10)?.item).toBe('a');
    expect(hitHandle(hs, 14, 10)?.item).toBe('c');
  });

  it('rotates radius handles and the rotation knob with the ellipse', () => {
    const d = setValue(doc(), '/face/mouth/area/rotation', 90);
    const hs = handlesOf(d, 'mouth.area', { cx: 200, cy: 250, zoom: 1 });
    const { toScreen } = projector({ cx: 200, cy: 250, zoom: 1 }, VP);
    const [cx, cy] = toScreen(200, 250);
    const rx = hs.find((h) => h.role === 'radiusX')!;
    // Rotated 90° clockwise: the local x axis points down the screen.
    expect(rx.x).toBeCloseTo(cx, 6);
    expect(rx.y).toBeCloseTo(cy + 24, 6);
    const knob = hs.find((h) => h.role === 'rotation')!;
    expect(knob.x).toBeGreaterThan(cx + 14);
  });

  it('finds edges for inserting a vertex and the smallest part under a point', () => {
    const d = doc();
    const cam = { cx: 200, cy: 250, zoom: 2 };
    const { toScreen, toImage } = projector(cam, VP);
    // The midpoint of the opening's first edge (vertex 0 -> 1).
    const [x, y] = toScreen((150 + 155) / 2, (195 + 188) / 2);
    const edge = hitEdge(hitShapes(d).filter((s) => s.item === 'eyes.imageLeft.opening'), x, y, toScreen, toImage);
    expect(edge).toMatchObject({ item: 'eyes.imageLeft.opening', pointer: '/face/eyes/imageLeft/opening', edge: 0 });
    // The nose point is inside the face oval, the head ellipse and the chest-free area: the point wins.
    expect(hitBody(hitShapes(d), 200, 225, 0.5)[0]).toBe('face.nose');
    // Inside the eye opening, which lies inside the region, the face oval and the head.
    const inEye = hitBody(hitShapes(d), 165, 196, 0.5);
    expect(inEye.indexOf('eyes.imageLeft.opening')).toBeLessThan(inEye.indexOf('eyes.imageLeft.region'));
    expect(inEye.indexOf('eyes.imageLeft.region')).toBeLessThan(inEye.indexOf('head.ellipse'));
  });

  it('grabs a band anywhere along its lines, within the picture', () => {
    const d = doc();
    const cam = { cx: 200, cy: 250, zoom: 2 };
    const { toScreen } = projector(cam, VP);
    const [x0] = toScreen(0, 0);
    const [x1] = toScreen(WIDTH, 0);
    const y = toScreen(0, 340)[1];
    const hit = hitBandLine(hitShapes(d), (x0 + x1) / 2, y + 3, toScreen, x0, x1);
    expect(hit).toMatchObject({ item: 'head.neck', role: 'bandEnd', pointer: '/head/neck', index: 1 });
    expect(hitBandLine(hitShapes(d), x1 + 20, y, toScreen, x0, x1)).toBeNull();
    expect(hitBandLine(hitShapes(d), (x0 + x1) / 2, y + 20, toScreen, x0, x1)).toBeNull();
  });

  it('measures the bounds of every shape', () => {
    const d = doc();
    expect(shapeBounds(resolveShape(d, item(d, 'head.ellipse').shape)!, WIDTH)).toEqual([70, 20, 260, 300]);
    expect(shapeBounds(resolveShape(d, item(d, 'head.neck').shape)!, WIDTH)).toEqual([0, 285, WIDTH, 55]);
    expect(shapeBounds(resolveShape(d, item(d, 'face.nose').shape)!, WIDTH)).toEqual([200, 225, 0, 0]);
  });
});

// ----------------------------------------------------------------------------- edits

describe('avatar geometry edits', () => {
  const grab = (role: Grab['role'], pointer: string, extra: Partial<Grab> = {}): Grab => ({ role, pointer, ...extra });

  it('moves a vertex, a point, a centre and segment ends (rounded to 0.1 px, input untouched)', () => {
    const d = doc();
    const before = structuredClone(d);
    const v = dragHandle(d, grab('vertex', '/face/eyes/imageLeft/opening', { index: 2 }), [166.04, 183.96]);
    expect((v as any).face.eyes.imageLeft.opening.slice(4, 6)).toEqual([166, 184]);
    expect((v as any).face.eyes.imageLeft.opening.slice(0, 4)).toEqual([150, 195, 155, 188]);
    expect(dragHandle(d, grab('point', '/face/nose'), [201.26, 230]) as any).toMatchObject({ face: { nose: [201.3, 230] } });
    expect((dragHandle(d, grab('center', '/head/center'), [210, 160]) as any).head.center).toEqual([210, 160]);
    expect((dragHandle(d, grab('b', '/face/mouth/imageRight'), [220, 250]) as any).face.mouth.imageRight).toEqual([220, 250]);
    expect(d).toEqual(before);
  });

  it('resizes ellipses along their own axes, and circles as one number', () => {
    const d = doc();
    const head = { center: [200, 170] as [number, number], radius: [130, 150] as [number, number], rotation: 0, circle: false };
    expect((dragHandle(d, grab('radiusX', '/head/radius', { ellipse: head }), [350, 400]) as any).head.radius).toEqual([150, 150]);
    expect((dragHandle(d, grab('radiusY', '/head/radius', { ellipse: head }), [0, 0]) as any).head.radius).toEqual([130, 170]);
    // Rotated by 90°: the x radius follows the screen's vertical.
    const rotated = { ...head, rotation: 90 };
    expect((dragHandle(d, grab('radiusX', '/head/radius', { ellipse: rotated }), [200, 270]) as any).head.radius).toEqual([100, 150]);
    // A radius never collapses.
    expect((dragHandle(d, grab('radiusX', '/head/radius', { ellipse: head }), [200, 170]) as any).head.radius[0]).toBe(1);
    const iris = { center: [165, 195] as [number, number], radius: [8, 8] as [number, number], rotation: 0, circle: true };
    expect((dragHandle(d, grab('radiusX', '/face/eyes/imageLeft/iris/radius', { ellipse: iris }), [168, 199]) as any).face.eyes.imageLeft.iris.radius).toBe(5);
  });

  it('rotates with the knob (above the centre = 0°), snapping to 15° on request', () => {
    const d = doc();
    const area = { center: [200, 250] as [number, number], radius: [24, 14] as [number, number], rotation: 0, circle: false };
    const g = grab('rotation', '/face/mouth/area/rotation', { ellipse: area });
    expect((dragHandle(d, g, [200, 200]) as any).face.mouth.area.rotation).toBe(0);
    expect((dragHandle(d, g, [250, 250]) as any).face.mouth.area.rotation).toBe(90);
    expect((dragHandle(d, g, [150, 250]) as any).face.mouth.area.rotation).toBe(-90);
    expect((dragHandle(d, g, [210, 200], { snap: true }) as any).face.mouth.area.rotation).toBe(15);
  });

  it('keeps band edges in order with at least 1 px between them', () => {
    const d = doc();
    expect((dragHandle(d, grab('bandStart', '/head/neck'), [0, 290]) as any).head.neck).toEqual([290, 340]);
    expect((dragHandle(d, grab('bandStart', '/head/neck'), [0, 400]) as any).head.neck).toEqual([339, 340]);
    expect((dragHandle(d, grab('bandEnd', '/head/neck'), [0, 100]) as any).head.neck).toEqual([285, 286]);
  });

  it('inserts and removes vertices, keeping a minimum count', () => {
    const d = doc();
    const ins = insertVertex(d, '/face/eyes/imageLeft/opening', 0, [152.55, 191.5]) as any;
    expect(ins.face.eyes.imageLeft.opening.slice(0, 6)).toEqual([150, 195, 152.6, 191.5, 155, 188]);
    expect(ins.face.eyes.imageLeft.opening).toHaveLength(18);
    const rem = removeVertex(d, '/face/eyes/imageLeft/opening', 1, MIN_VERTICES.polygon) as any;
    expect(rem.face.eyes.imageLeft.opening).toEqual([150, 195, 165, 185, 175, 188, 180, 195, 175, 202, 165, 205, 155, 202]);
    const tri = setValue(d, '/face/eyes/imageLeft/opening', [0, 0, 10, 0, 5, 5]);
    expect(removeVertex(tri, '/face/eyes/imageLeft/opening', 0, MIN_VERTICES.polygon)).toBeNull();
    const line = setValue(d, '/face/brows/imageLeft', [0, 0, 10, 0]);
    expect(removeVertex(line, '/face/brows/imageLeft', 0, MIN_VERTICES.polyline)).toBeNull();
  });

  it('moves whole items: polygons, ellipses (centre only), bands (y only), segments', () => {
    const d = doc();
    const eye = item(d, 'eyes.imageLeft.region');
    expect((translateItem(d, eye.shape, 2, -3) as any).face.eyes.imageLeft.region.slice(0, 4)).toEqual([144, 192, 152, 177]);
    const head = translateItem(d, item(d, 'head.ellipse').shape, 5, 5) as any;
    expect(head.head.center).toEqual([205, 175]);
    expect(head.head.radius).toEqual([130, 150]);
    expect((translateItem(d, item(d, 'head.neck').shape, 50, 10) as any).head.neck).toEqual([295, 350]);
    const swing = translateItem(d, item(d, 'attachment.tassel.swing').shape, 1, 1) as any;
    expect([swing.attachments[0].pivot, swing.attachments[0].tip]).toEqual([
      [333, 153],
      [333, 229],
    ]);
  });

  it('compares JSON documents deeply, ignoring key order', () => {
    expect(sameJson({ a: [1, { b: 2 }], c: 3 }, { c: 3, a: [1, { b: 2 }] })).toBe(true);
    expect(sameJson({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(sameJson({ a: 1, b: undefined }, { a: 1 })).toBe(true);
  });
});

// ----------------------------------------------------------------------------- history

describe('avatar undo / redo', () => {
  it('steps back and forth with labels and drops the redo steps on a new edit', () => {
    const h = new SpecHistory();
    h.reset({ v: 0 });
    expect(h.canUndo).toBe(false);
    h.push({ v: 1 }, 'one');
    h.push({ v: 2 }, 'two');
    expect(h.undoLabel).toBe('two');
    expect(h.undo()).toEqual({ doc: { v: 1 }, undone: 'two' });
    expect(h.undo()).toEqual({ doc: { v: 0 }, undone: 'one' });
    expect(h.undo()).toBeNull();
    expect(h.redoLabel).toBe('one');
    expect(h.redo()).toEqual({ doc: { v: 1 }, label: 'one' });
    h.push({ v: 3 }, 'three');
    expect(h.canRedo).toBe(false);
    expect(h.current?.doc).toEqual({ v: 3 });
  });

  it('keeps at most HISTORY_LIMIT versions', () => {
    const h = new SpecHistory();
    h.reset({ v: -1 });
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) h.push({ v: i }, `step ${i}`);
    expect(h.size).toBe(HISTORY_LIMIT);
    let n = 0;
    while (h.undo()) n++;
    expect(n).toBe(HISTORY_LIMIT - 1);
  });
});

// ----------------------------------------------------------------------------- coordinates

describe('avatar canvas coordinates', () => {
  it('maps image pixels to the screen and back', () => {
    const cam = { cx: 120, cy: 80, zoom: 2.5 };
    const { toScreen, toImage } = projector(cam, VP);
    const [sx, sy] = toScreen(33.3, 444.4);
    const [x, y] = toImage(sx, sy);
    expect(x).toBeCloseTo(33.3, 9);
    expect(y).toBeCloseTo(444.4, 9);
    expect(toScreen(120, 80)).toEqual([500, 400]);
  });

  it('zooms around the cursor within 10 % .. 1600 %', () => {
    const cam = { cx: 200, cy: 250, zoom: 1 };
    const next = zoomAround(cam, VP, 300, 200, 3);
    const before = projector(cam, VP).toImage(300, 200);
    const after = projector(next, VP).toImage(300, 200);
    expect(after[0]).toBeCloseTo(before[0], 9);
    expect(after[1]).toBeCloseTo(before[1], 9);
    expect(zoomAround(cam, VP, 0, 0, 1000).zoom).toBe(AVATAR_MAX_ZOOM);
    expect(zoomAround(cam, VP, 0, 0, 0.0001).zoom).toBe(AVATAR_MIN_ZOOM);
    expect(stepAvatarZoom(1, 1)).toBe(1.5);
    expect(stepAvatarZoom(1, -1)).toBe(0.75);
    expect(stepAvatarZoom(16, 1)).toBe(16);
  });

  it('frames a rect in the centre of the free area the chrome leaves', () => {
    const insets = { top: 60, right: 340, bottom: 20, left: 280 };
    const cam = frameRect([0, 0, WIDTH, HEIGHT], VP, insets, 32, 16);
    const [fx, fy] = freeCenter(VP, insets);
    const { toScreen } = projector(cam, VP);
    const [cx, cy] = toScreen(WIDTH / 2, HEIGHT / 2);
    expect(cx).toBeCloseTo(fx, 6);
    expect(cy).toBeCloseTo(fy, 6);
    // The whole rect fits into the free area with the padding.
    expect(HEIGHT * cam.zoom).toBeLessThanOrEqual(VP.height - insets.top - insets.bottom - 64 + 1e-6);
    // A point is framed as a small neighbourhood, never beyond the zoom cap.
    expect(frameRect([10, 10, 0, 0], VP, insets, 32, 8).zoom).toBe(8);
    // Zooming to a level keeps the free area's centre in place.
    const z = zoomToLevel(cam, VP, insets, 4);
    const keep = projector(cam, VP).toImage(fx, fy);
    const now = projector(z, VP).toImage(fx, fy);
    expect(now[0]).toBeCloseTo(keep[0], 6);
    expect(z.zoom).toBe(4);
  });
});

// ----------------------------------------------------------------------------- stale layers

describe('avatar stale layers', () => {
  const metaFor = (d: unknown): LayersMeta => {
    const spec = parseAvatarSpec(d, { imageSize: { width: WIDTH, height: HEIGHT } }).spec!;
    return { version: 1, inputsHash: layerInputsHash(spec), image: { width: WIDTH, height: HEIGHT }, layers: [], variants: [] };
  };
  const specOf = (d: unknown) => parseAvatarSpec(d, { imageSize: { width: WIDTH, height: HEIGHT } }).spec;

  it('is stale exactly when a value that cuts layers changed', () => {
    const d = doc();
    const meta = metaFor(d);
    expect(layersStale(specOf(d), meta)).toBe(false);
    expect(layersStale(specOf(setValue(d, '/face/nose', [201, 226])), meta)).toBe(false);
    expect(layersStale(specOf(setValue(d, '/face/eyes/imageLeft/opening/1', 196)), meta)).toBe(true);
    // No layers, or an invalid spec: nothing can be said.
    expect(layersStale(specOf(d), null)).toBe(false);
    expect(layersStale(null, meta)).toBe(false);
  });

  it('names the parts whose cut-outs changed since the build', () => {
    const d = doc();
    expect(changedCutItems(d, d)).toEqual([]);
    expect(changedCutItems(d, setValue(d, '/face/nose', [1, 1]))).toEqual([]);
    expect(changedCutItems(d, setValue(d, '/face/eyes/imageLeft/opening/1', 196))).toEqual(['eyes.imageLeft.opening']);
    expect(changedCutItems(d, setValue(d, '/hair/strands/1/width', 30))).toEqual(['strand.sideR']);
    expect(changedCutItems(d, setValue(d, '/face/mouth/area/rotation', 10))).toEqual(['mouth.area']);
    // A removed strand is listed too (it is in the build's layers).
    expect(changedCutItems(d, removeEntry(d, '/hair/strands/0'))).toEqual(['strand.bangL']);
    // A strand's swing does not cut anything.
    expect(changedCutItems(d, setValue(d, '/hair/strands/0/swing', 3))).toEqual([]);
  });
});

// ----------------------------------------------------------------------------- placing landmarks

describe('placing avatar landmarks by hand', () => {
  const size = { width: WIDTH, height: HEIGHT };

  it('places every landmark of a draft until nothing is missing', () => {
    let d = draftAvatarSpec('tester', WIDTH, HEIGHT) as SpecDoc;
    const missing = () => parseAvatarSpec(d, { imageSize: size }).diagnostics.filter((x) => x.code === 'avatar-missing-landmark');
    expect(missing().length).toBeGreaterThan(10);
    const spots: Record<string, [number, number]> = {
      'head.ellipse': [200, 170],
      'head.pivot': [200, 300],
      'head.neck': [0, 285],
      'eyes.imageLeft.opening': [165, 195],
      'eyes.imageLeft.region': [165, 195],
      'eyes.imageRight.opening': [235, 195],
      'eyes.imageRight.region': [235, 195],
      'mouth.corners': [200, 248],
      'mouth.area': [200, 250],
      'face.oval': [200, 200],
      'face.nose': [200, 225],
      'face.chin': [200, 278],
      'body.pivot': [200, 480],
      'body.fade': [0, 380],
      'body.chest': [200, 420],
    };
    for (const it of parts(d).flatMap((g) => g.items.filter((i) => i.required && !i.placed))) {
      const at = spots[it.id];
      expect(at, it.id).toBeDefined();
      d = placeItem(d, item(d, it.id), at, size);
      expect(item(d, it.id).placed, it.id).toBe(true);
    }
    expect(missing()).toEqual([]);
  });

  it('draws eye openings from the outer corner over the top', () => {
    const d = draftAvatarSpec('tester', WIDTH, HEIGHT) as SpecDoc;
    const left = placeItem(d, item(d, 'eyes.imageLeft.opening'), [165, 195], size) as any;
    const pts: number[] = left.face.eyes.imageLeft.opening;
    expect(pts).toHaveLength(32);
    // Image left: starts at the left corner, the next points go up (smaller y).
    expect(pts[0]).toBeLessThan(165);
    expect(pts[3]).toBeLessThan(195);
    const right = placeItem(d, item(d, 'eyes.imageRight.opening'), [235, 195], size) as any;
    const rp: number[] = right.face.eyes.imageRight.opening;
    expect(rp[0]).toBeGreaterThan(235);
    expect(rp[3]).toBeLessThan(195);
  });

  it('adds and removes strands and attachments, and takes optional landmarks out again', () => {
    let d = doc();
    const s = addStrand(d, [100, 100], size);
    expect(s.id).toBe('strand1');
    expect(item(s.doc, 'strand.strand1').placed).toBe(true);
    for (const kind of ['pendulum', 'jiggle', 'cutout'] as const) {
      const a = addAttachment(d, kind, [100, 300], size);
      expect(a.id).toBe(`${kind}1`);
      expect(parseAvatarSpec(a.doc, { imageSize: size }).diagnostics.filter((x) => x.severity === 'error' && x.path.startsWith('/attachments/3'))).toEqual([]);
    }
    const tassel = item(d, 'attachment.tassel.outline');
    expect(entryPointer(tassel)).toBe('/attachments/0');
    expect(entryPointer(item(d, 'strand.sideR'))).toBe('/hair/strands/1');
    expect(entryPointer(item(d, 'face.nose'))).toBeNull();
    d = removeEntry(d, '/attachments/0') as any;
    expect((d as any).attachments.map((a: any) => a.id)).toEqual(['bun', 'hand']);
    // Optional landmarks come out; required ones cannot.
    const noIris = removeItemValue(d, item(d, 'eyes.imageLeft.iris')) as any;
    expect(noIris.face.eyes.imageLeft.iris).toBeUndefined();
    expect(removeItemValue(d, item(d, 'face.nose'))).toBeNull();
    const noBrows = removeItemValue(d, item(d, 'face.brows.imageLeft')) as any;
    expect(noBrows.face.brows).toBeUndefined();
    const noShoulders = removeItemValue(d, item(d, 'body.shoulders.imageRight')) as any;
    expect(noShoulders.body.shoulders).toBeUndefined();
    expect(parseAvatarSpec(noShoulders, { imageSize: size }).spec).not.toBeNull();
  });
});

// ----------------------------------------------------------------------------- problems

describe('avatar problems -> parts', () => {
  it('maps diagnostic pointers onto the items the editor lists', () => {
    const d = doc();
    expect(itemForPath(d, '/face/eyes/imageLeft/opening/4')).toBe('eyes.imageLeft.opening');
    expect(itemForPath(d, '/face/eyes/imageLeft/opening')).toBe('eyes.imageLeft.opening');
    expect(itemForPath(d, '/face/eyes/imageRight')).toBe('eyes.imageRight.opening');
    expect(itemForPath(d, '/hair/strands/1/width')).toBe('strand.sideR');
    expect(itemForPath(d, '/attachments/0/swing')).toMatch(/^attachment\.tassel\./);
    expect(itemForPath(d, '/head/radius')).toBe('head.ellipse');
    expect(itemForPath(d, '/name')).toBeNull();
  });

  it('groups diagnostics per item and tells the worst severity', () => {
    const bad = setValue(doc(), '/face/mouth/imageLeft', [230, 248]);
    const diags = parseAvatarSpec(bad, { imageSize: { width: WIDTH, height: HEIGHT } }).diagnostics;
    const by = problemsByItem(bad, diags);
    expect(worstSeverity(by.get('mouth.corners'))).toBe('error');
    expect(worstSeverity(undefined)).toBeNull();
  });
});

// ----------------------------------------------------------------------------- pose controls

describe('avatar pose controls', () => {
  const model = {
    parameters: [
      { id: 'Breath', min: 0, max: 1, default: 0 },
      { id: 'EyeROpen', min: 0, max: 1, default: 1 },
      { id: 'AngleX', min: -30, max: 30, default: 0 },
      { id: 'Hair_bang1', min: -1, max: 1, default: 0 },
      { id: 'EyeLOpen', min: 0, max: 1, default: 1 },
    ],
  } as any;

  it('lists the parameters of the compiled model: friendly ones in order, linked eyes, the rest after', () => {
    const { main, more } = poseControls(model);
    expect(main.map((c) => [c.control, c.params])).toEqual([
      ['turnX', ['AngleX']],
      ['eyes', ['EyeLOpen', 'EyeROpen']],
      ['breath', ['Breath']],
    ]);
    expect(more.map((c) => c.params[0])).toEqual(['Hair_bang1']);
    expect(main[0].step).toBe(0.1);
    expect(main[1].step).toBe(0.01);
    expect(poseControls(null)).toEqual({ main: [], more: [] });
  });

  it('moves linked parameters together, clamped, and resets them', () => {
    const eyes = poseControls(model).main[1];
    const v = setControl({}, eyes, 1.7);
    expect(v).toEqual({ EyeLOpen: 1, EyeROpen: 1 });
    expect(controlValue(eyes, setControl({}, eyes, 0.25))).toBe(0.25);
    expect(controlValue(eyes, {})).toBe(1);
    expect(resetControl({ EyeLOpen: 0, EyeROpen: 0, AngleX: 5 }, eyes)).toEqual({ AngleX: 5 });
  });
});

// ----------------------------------------------------------------------------- names in three languages

describe('avatar part names', () => {
  const docs: Array<[string, unknown]> = [
    ['complete', doc()],
    ['full figure',fullFigureAvatarDoc()],
    ['draft', draftAvatarSpec('draft', WIDTH, HEIGHT)],
  ];
  const languages = ['en', 'ko', 'ja'] as const;

  it('has a message for every item-id pattern, in every language', () => {
    const seen = new Set<string>();
    for (const [name, d] of docs) {
      for (const g of parts(d)) {
        for (const it of g.items) {
          const keys = itemKeys(it, d);
          expect(keys.label, `${name}: ${it.id}`).not.toBe('avatar.item.unknown');
          for (const lang of languages) {
            const dict = DICTIONARIES[lang] as Record<string, string>;
            expect(dict[keys.label], `${lang} ${keys.label}`).toBeTruthy();
            expect(dict[keys.tip], `${lang} ${keys.tip}`).toBeTruthy();
            if (keys.side) expect(dict[keys.side]).toBeTruthy();
          }
          seen.add(it.id.replace(/^(eyes|cheeks)\.image(Left|Right)/, '$1.<side>').replace(/\.image(Left|Right)$/, '.<side>').replace(/^strand\..+$/, 'strand.<id>').replace(/^attachment\.[^.]+\./, 'attachment.<id>.').replace(/^arms\.[^.]+\./,'arms.<id>.').replace(/^legs\.foot1$/,'legs.foot0'));
        }
      }
    }
    // Every pattern the editor declares occurs in the fixtures, and nothing else does.
    expect([...seen].sort()).toEqual([...ITEM_PATTERNS].sort());
  });

  it('reads naturally in Korean and Japanese (sides, ids, the attachment kinds)', () => {
    const d = doc();
    setLanguage('ko', false);
    expect(itemLabel(t, item(d, 'eyes.imageLeft.opening'), d)).toBe('왼쪽 눈 · 트임');
    expect(itemLabel(t, item(d, 'attachment.tassel.outline'), d)).toBe('매달린 장식 “tassel” · 윤곽');
    expect(itemLabel(t, item(d, 'attachment.hand.outline'), d)).toBe('앞쪽 조각 “hand” · 윤곽');
    expect(itemTip(t, item(d, 'face.nose'), d)).toBe('코의 끝.');
    expect(groupLabel(t, 'strands')).toBe('머리카락 가닥');
    expect(handleLabel(t, item(d, 'eyes.imageLeft.opening'), 'vertex', 4)).toBe('점 5');
    setLanguage('ja', false);
    expect(itemLabel(t, item(d, 'face.brows.imageRight'), d)).toBe('右眉');
    expect(itemLabel(t, item(d, 'strand.bangL'), d)).toBe('髪束「bangL」');
    setLanguage('en', false);
    expect(itemLabel(t, item(d, 'body.shoulders.imageLeft'), d)).toBe('Left Shoulder');
    expect(handleLabel(t, item(d, 'mouth.corners'), 'b')).toBe('Right Corner');
    expect(handleLabel(t, item(d, 'attachment.tassel.swing'), 'a')).toBe('Pivot');
  });

  it('keeps every avatar message translated (no English left in Korean and Japanese)', () => {
    const keys = (Object.keys(DICTIONARIES.en) as MessageKey[]).filter((k) => k.startsWith('avatar.'));
    expect(keys.length).toBeGreaterThan(200);
    const english = (s: string) => /[A-Za-z]{4,}/.test(s.replace(/\{[^}]*\}|avatar\.json|JSON|Rev2D|PNG|Ctrl\+S|rev2d avatar overlay[^)]*|konnichiwa|MouthOpen/g, ''));
    for (const k of keys) {
      if (!english(translate('en', k))) continue;
      expect(english(translate('ko', k)), `ko ${k}: ${translate('ko', k)}`).toBe(false);
      expect(english(translate('ja', k)), `ja ${k}: ${translate('ja', k)}`).toBe(false);
    }
  });
});

// ----------------------------------------------------------------------------- the store

function infoFor(d: unknown, meta: LayersMeta | null = null): AvatarInfo {
  return {
    project: '/ws/tester',
    projectPath: 'tester',
    specFile: '/ws/tester/avatar.json',
    name: 'tester',
    specText: JSON.stringify(d),
    mtimeMs: 1000,
    image: { file: 'source.png', width: WIDTH, height: HEIGHT },
    built: { model: meta ? '/ws/tester/tester.r2d.json' : null, modelMtimeMs: meta ? 1000 : null, meta, stale: false, variants: [] },
    files: [],
    diagnostics: [],
    job: null,
  };
}

describe('avatar store', () => {
  it('records edits and drags as undo steps and tracks unsaved changes', () => {
    const store = new AvatarStore();
    store.adopt(infoFor(doc()), 'reset');
    const s0 = store.get();
    expect(s0.status).toBe('ready');
    expect(s0.unsaved).toBe(false);
    expect(s0.parts.length).toBe(10);
    expect(store.edit('nose', setValue(s0.doc!, '/face/nose', [201, 225]))).toBe(true);
    expect(store.get().unsaved).toBe(true);
    // A drag: many moves, one step.
    store.beginGesture('drag');
    const base = store.gestureBase()!;
    for (let i = 1; i <= 5; i++) store.gestureUpdate(setValue(base, '/face/chin', [200, 278 + i]));
    store.endGesture();
    expect((store.get().doc as any).face.chin).toEqual([200, 283]);
    expect(store.get().undoLabel).toBe('drag');
    store.undo();
    expect((store.get().doc as any).face.chin).toEqual([200, 278]);
    store.undo();
    expect(store.get().unsaved).toBe(false);
    store.redo();
    expect(store.get().unsaved).toBe(true);
    // Unchanged or refused edits are no steps.
    expect(store.edit('none', store.get().doc)).toBe(false);
    expect(store.edit('none', null)).toBe(false);
  });

  it('validates on demand and reports stale layers with the changed parts', () => {
    const d = doc();
    const spec = parseAvatarSpec(d, { imageSize: { width: WIDTH, height: HEIGHT } }).spec!;
    const meta: LayersMeta = { version: 1, inputsHash: layerInputsHash(spec), image: { width: WIDTH, height: HEIGHT }, layers: [], variants: [] };
    const store = new AvatarStore();
    store.adopt(infoFor(d, meta), 'reset');
    expect(store.get().stale).toBe(false);
    expect(store.get().baseline).not.toBeNull();
    store.edit('eye', setValue(d, '/face/eyes/imageRight/region/0', 211));
    store.validateNow();
    expect(store.get().stale).toBe(true);
    expect(store.get().staleItems).toEqual(['eyes.imageRight.region']);
    store.undo();
    store.validateNow();
    expect(store.get().stale).toBe(false);
  });

  it('takes changes from disk as a history step, or asks while there are unsaved edits', () => {
    const d = doc();
    const store = new AvatarStore();
    store.adopt(infoFor(d), 'reset');
    const disk = setValue(d, '/face/nose', [190, 220]);
    store.adopt({ ...infoFor(disk), mtimeMs: 2000 }, 'external');
    expect((store.get().doc as any).face.nose).toEqual([190, 220]);
    expect(store.get().mtimeMs).toBe(2000);
    expect(store.get().canUndo).toBe(true);
    store.edit('mine', setValue(store.get().doc!, '/face/chin', [200, 270]));
    store.adopt({ ...infoFor(setValue(d, '/face/nose', [180, 220])), mtimeMs: 3000 }, 'external');
    // Unsaved edits stay; the person decides.
    expect((store.get().doc as any).face.chin).toEqual([200, 270]);
    expect(store.get().external).toEqual({ mtimeMs: 3000 });
  });

  it('eases the lip-sync mouth toward a held vowel and lets go after the release', () => {
    const store = new AvatarStore();
    store.holdVowel('a');
    expect(store.animating()).toBe(true);
    for (let i = 0; i < 30; i++) store.tick(i * 16, 1 / 60);
    expect(store.get().lipsync.mouth!.open).toBeGreaterThan(0.95);
    expect(store.previewInputs().params.MouthOpen).toBeCloseTo(store.get().lipsync.mouth!.open, 9);
    store.holdVowel(null);
    for (let i = 0; i < 60; i++) store.tick(500 + i * 16, 1 / 60);
    expect(store.get().lipsync.mouth).toBeNull();
    expect(store.animating()).toBe(false);
  });

  it('plays text through the lip-sync curves and stops at its end', () => {
    const store = new AvatarStore();
    store.setLipSync({ text: 'あいうえお', rate: 10 });
    expect(store.playLipSync()).toEqual([]);
    const t0 = store.get().lipsync.startedAt!;
    let open = 0;
    for (let i = 1; i <= 30; i++) {
      store.tick(t0 + i * 16, 0.016);
      open = Math.max(open, store.get().lipsync.mouth?.open ?? 0);
    }
    expect(open).toBeGreaterThan(0.5);
    store.tick(t0 + 5000, 0.016);
    expect(store.get().lipsync.startedAt).toBeNull();
  });
});

// ----------------------------------------------------------------------------- AI requests and names

describe('avatar AI requests and project names', () => {
  it('builds the avatar-create job the server expects, and the same request as text', () => {
    expect(avatarCreateRequest('characters/hana', 'characters/hana/source.png')).toEqual({ kind: 'avatar-create', context: { project: 'characters/hana' }, images: ['characters/hana/source.png'] });
    expect(projectImagePath({ projectPath: '' }, 'source.png')).toBe('source.png');
    expect(projectImagePath({ projectPath: 'a/b' }, 'source.png')).toBe('a/b/source.png');
    expect(fixPartRequest('hana', 'fix it')).toEqual({ kind: 'freeform', prompt: 'fix it', context: { project: 'hana' } });
    const text = terminalRequest('/ws/hana', 'hana');
    expect(text).toContain('"hana" (/ws/hana)');
    expect(text).toContain('rev2d avatar validate .');
    expect(text).toContain('rev2d avatar build .');
  });

  it('makes avatar names from file names', () => {
    expect(avatarNameFrom('My Picture (1).png')).toBe('my-picture-1');
    expect(avatarNameFrom('2024_portrait.PNG')).toBe('avatar-2024_portrait');
    expect(avatarNameFrom('하나.png')).toBe('avatar');
    for (const n of ['my-picture-1', 'avatar-2024_portrait', 'avatar']) expect(isAvatarName(n)).toBe(true);
    expect(isAvatarName('1abc')).toBe(false);
    expect(isAvatarName('a b')).toBe(false);
  });
});
