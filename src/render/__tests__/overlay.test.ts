import { describe, expect, it } from 'vitest';
import type { BonePose, ImageRGBA, Model, PartPose, Pose, RenderList } from '../../core/types.js';
import { drawOverlay, type OverlayLayer } from '../overlay.js';
import { cloneImage, createImage, getPixel } from '../image.js';
import { drawText } from '../font.js';

interface BoneDef {
  id: string;
  parent?: string;
  color?: string;
  joint: [number, number];
  tip: [number, number];
}

function bonePose(joint: [number, number], tip: [number, number]): BonePose {
  const length = Math.hypot(tip[0] - joint[0], tip[1] - joint[1]);
  const rotation = (Math.atan2(tip[1] - joint[1], tip[0] - joint[0]) * 180) / Math.PI;
  return {
    world: [1, 0, 0, 1, joint[0], joint[1]],
    x: joint[0],
    y: joint[1],
    rotation,
    scaleX: 1,
    scaleY: 1,
    tip,
    local: { x: joint[0], y: joint[1], rotation, scaleX: 1, scaleY: 1, length },
  };
}

function partPose(bounds: [number, number, number, number] | null): PartPose {
  return { visible: true, opacity: 1, z: 0, tint: [1, 1, 1, 1], bounds, fill: null, stroke: null };
}

function scene(
  opts: {
    bones?: BoneDef[];
    warps?: Array<{ id: string; cols: number; rows: number; points: number[] }>;
    parts?: Record<string, [number, number, number, number]>;
    list?: RenderList;
  } = {},
) {
  const bones = opts.bones ?? [];
  const model = {
    format: 'rev2d',
    version: 1,
    meta: { name: 't', width: 200, height: 100, background: 'transparent', fps: 30 },
    parameters: [],
    textures: [],
    bones: bones.map((b) => ({
      id: b.id,
      parent: b.parent,
      color: b.color,
      x: 0,
      y: 0,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      length: 0,
    })),
    warps: (opts.warps ?? []).map((w) => ({ id: w.id, rect: [0, 0, 1, 1], cols: w.cols, rows: w.rows })),
    parts: [],
    bindings: [],
    ik: [],
    physics: [],
    animations: [],
  } as unknown as Model;
  const pose: Pose = {
    time: 0,
    params: {},
    bones: Object.fromEntries(bones.map((b) => [b.id, bonePose(b.joint, b.tip)])),
    warps: Object.fromEntries(
      (opts.warps ?? []).map((w) => [w.id, { points: Float32Array.from(w.points), cols: w.cols, rows: w.rows }]),
    ),
    parts: Object.fromEntries(Object.entries(opts.parts ?? {}).map(([id, b]) => [id, partPose(b)])),
    drawOrder: Object.keys(opts.parts ?? {}),
    ik: {},
    physics: {},
    properties: {},
    events: [],
  };
  const list: RenderList = opts.list ?? { width: 200, height: 100, background: [0, 0, 0, 0], draws: [] };
  return { model, pose, list };
}

function rgb(img: ImageRGBA, x: number, y: number): number[] {
  return getPixel(img, x, y).slice(0, 3);
}

function changed(a: ImageRGBA, b: ImageRGBA, x: number, y: number): boolean {
  return getPixel(a, x, y).some((v, i) => v !== getPixel(b, x, y)[i]);
}

/** Positions inside `rect` whose pixel is exactly `color` (RGBA8), as "x,y" strings. */
function pixelsOfColor(img: ImageRGBA, rect: [number, number, number, number], color: number[]): string[] {
  const out: string[] = [];
  const [x0, y0, w, h] = rect;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) if (getPixel(img, x, y).every((v, i) => v === color[i])) out.push(`${x},${y}`);
  }
  return out;
}

/** The pixels `text` would ink when drawn at (x, y) in an opaque color. */
function textPixels(text: string, x: number, y: number, rect: [number, number, number, number]): string[] {
  const ref = createImage(rect[0] + rect[2], rect[1] + rect[3]);
  drawText(ref, x, y, text, [1, 0, 1, 1]);
  return pixelsOfColor(ref, rect, [255, 0, 255, 255]);
}

describe('drawOverlay: bones', () => {
  const bones: BoneDef[] = [
    { id: 'root', color: '#ff0000', joint: [20, 50], tip: [120, 50] },
    { id: 'child', parent: 'root', joint: [60, 90], tip: [90, 90] },
    { id: 'pin', joint: [170, 20], tip: [170, 20] },
  ];

  for (const bg of ['#ffffff', '#000000']) {
    it(`draws the bone line in the bone color over ${bg}`, () => {
      const img = createImage(200, 100, bg);
      const before = cloneImage(img);
      drawOverlay(img, scene({ bones }), { layers: ['bones'] });
      for (const x of [40, 70, 100]) {
        const [r, g, b] = rgb(img, x, 50);
        expect(r).toBeGreaterThan(200);
        expect(g).toBeLessThan(90);
        expect(b).toBeLessThan(90);
      }
      // The joint ring and tip dot are colored too; empty space stays untouched.
      expect(rgb(img, 24, 50)[0]).toBeGreaterThan(200);
      expect(rgb(img, 120, 50)[0]).toBeGreaterThan(200);
      expect(changed(img, before, 150, 70)).toBe(false);
      // A dark underlay borders the line so it reads on light backgrounds.
      if (bg === '#ffffff') expect(rgb(img, 70, 52)[0]).toBeLessThan(230);
    });
  }

  it('uses the default palette for bones without a color', () => {
    const img = createImage(200, 100, '#ffffff');
    drawOverlay(img, scene({ bones }), { layers: ['bones'] });
    const [r, g, b] = rgb(img, 75, 90);
    expect(g).toBeGreaterThan(200);
    expect(r).toBeLessThan(120);
    expect(b).toBeLessThan(140);
  });

  it('draws length-0 bones as a cross and links children to their parent joint', () => {
    const img = createImage(200, 100, '#808080');
    const before = cloneImage(img);
    drawOverlay(img, scene({ bones }), { layers: ['bones'] });
    // Cross arm ends lie outside the joint's ring and shadow; a pixel at the same radius off the arms is untouched.
    expect(changed(img, before, 175, 25)).toBe(true);
    expect(changed(img, before, 164, 25)).toBe(true);
    expect(changed(img, before, 177, 20)).toBe(false);
    // Dashed link from root joint (20,50) to child joint (60,90): the diagonal y = x + 30.
    const onLink = [30, 35, 40, 45].filter((x) => changed(img, before, x, x + 30)).length;
    expect(onLink).toBeGreaterThan(1);
  });

  it('lines up with renderImage viewBox and scale', () => {
    const img = createImage(200, 100, '#ffffff');
    const s = scene({ bones: [{ id: 'b', color: '#0000ff', joint: [60, 40], tip: [100, 40] }] });
    drawOverlay(img, s, { layers: ['bones'], viewBox: [50, 30, 100, 50], scale: 2 });
    // Joint -> pixel (20, 20), tip -> pixel (100, 20).
    expect(rgb(img, 60, 20)[2]).toBeGreaterThan(200);
    expect(rgb(img, 60, 20)[0]).toBeLessThan(90);
    expect(rgb(img, 60, 40)).toEqual([255, 255, 255]);
  });
});

describe('drawOverlay: grid, mesh, warps, bounds', () => {
  it('draws a grid with stronger major lines and coordinate labels', () => {
    const img = createImage(300, 200, '#ffffff');
    drawOverlay(img, scene(), { layers: ['grid'], viewBox: [0, 0, 300, 200] });
    const minor = rgb(img, 150, 125)[0];
    const major = rgb(img, 100, 125)[0];
    expect(minor).toBeLessThan(255);
    expect(major).toBeLessThan(minor);
    expect(rgb(img, 125, 125)).toEqual([255, 255, 255]);
    // "100" label boxes along the top (x = 100) and the left edge (y = 100): dark box, exact glyph pixels.
    const ink = [204, 224, 255, 255];
    const top: [number, number, number, number] = [102, 1, 21, 11];
    const left: [number, number, number, number] = [1, 102, 21, 11];
    expect(rgb(img, 103, 2)[0]).toBeLessThan(100);
    expect(pixelsOfColor(img, top, ink)).toEqual(textPixels('100', 104, 3, top));
    expect(pixelsOfColor(img, left, ink)).toEqual(textPixels('100', 3, 104, left));
    expect(pixelsOfColor(img, [202, 1, 21, 11], ink)).toEqual(textPixels('200', 204, 3, [202, 1, 21, 11]));
  });

  it('maps grid lines through the viewBox and scale like renderImage', () => {
    const img = createImage(200, 200, '#ffffff');
    drawOverlay(img, scene(), { layers: ['grid'], viewBox: [25, 10, 100, 100], scale: 2 });
    const column = (x: number) => rgb(img, x, 120)[0];
    // Setup x = 50 (minor) -> px 50, x = 100 (major) -> px 150; y = 50 (minor) -> row 80.
    expect(column(50)).toBeLessThan(255);
    expect(column(150)).toBeLessThan(column(50));
    expect([49, 51, 100, 149, 151].map(column)).toEqual([255, 255, 255, 255, 255]);
    expect(rgb(img, 120, 80)[0]).toBeLessThan(255);
    expect(rgb(img, 120, 79)).toEqual([255, 255, 255]);
  });

  it('respects gridStep and rejects invalid steps', () => {
    const img = createImage(100, 100, '#ffffff');
    drawOverlay(img, scene(), { layers: ['grid'], viewBox: [0, 0, 100, 100], gridStep: 20 });
    expect(rgb(img, 40, 70)[0]).toBeLessThan(255);
    expect(rgb(img, 50, 70)).toEqual([255, 255, 255]);
    expect(() => drawOverlay(img, scene(), { layers: ['grid'], gridStep: 0 })).toThrow(/gridStep/);
    // A step below 4 output px is coarsened (here 1 -> 4) instead of flooding the image.
    const dense = createImage(100, 100, '#ffffff');
    drawOverlay(dense, scene(), { layers: ['grid'], viewBox: [0, 0, 100, 100], gridStep: 1 });
    expect(rgb(dense, 4, 50)[0]).toBeLessThan(255);
    expect(rgb(dense, 5, 50)).toEqual([255, 255, 255]);
  });

  it('draws triangle wireframes from the render list', () => {
    const list: RenderList = {
      width: 200,
      height: 100,
      background: [0, 0, 0, 0],
      draws: [
        {
          partId: 'p',
          kind: 'fill',
          positions: Float32Array.from([10, 10, 90, 10, 10, 90, 90, 90]),
          colors: new Float32Array(16).fill(1),
          indices: Uint32Array.from([0, 1, 2, 1, 3, 2]),
          blend: 'normal',
        },
      ],
    };
    const img = createImage(200, 100, '#000000');
    const before = cloneImage(img);
    drawOverlay(img, scene({ list }), { layers: ['mesh'] });
    expect(changed(img, before, 50, 10)).toBe(true);
    expect(changed(img, before, 50, 50)).toBe(true); // shared diagonal
    expect(changed(img, before, 30, 30)).toBe(false);
    // Thin and semi-transparent.
    expect(rgb(img, 50, 10)[2]).toBeLessThan(255);
    expect(changed(img, before, 50, 13)).toBe(false);
  });

  it('draws warp lattices with control points', () => {
    const img = createImage(200, 100, '#ffffff');
    const before = cloneImage(img);
    const warps = [{ id: 'w', cols: 2, rows: 1, points: [10, 10, 50, 10, 90, 10, 10, 90, 50, 80, 90, 90] }];
    drawOverlay(img, scene({ warps }), { layers: ['warps'] });
    const [r, g, b] = rgb(img, 50, 80);
    expect(r).toBeGreaterThan(200);
    expect(g).toBeLessThan(150);
    expect(b).toBeGreaterThan(150);
    expect(changed(img, before, 30, 10)).toBe(true);
    expect(changed(img, before, 50, 45)).toBe(true); // middle column line
    expect(changed(img, before, 30, 45)).toBe(false);
  });

  it('draws part bounds for parts in the draw order', () => {
    const img = createImage(200, 100, '#000000');
    const before = cloneImage(img);
    drawOverlay(img, scene({ parts: { p: [20, 30, 40, 20] } }), { layers: ['bounds'] });
    const [r, g, b] = rgb(img, 40, 30);
    expect(r).toBeGreaterThan(200);
    expect(g).toBeGreaterThan(150);
    expect(b).toBeLessThan(100);
    expect(changed(img, before, 40, 40)).toBe(false);
    expect(changed(img, before, 59, 40)).toBe(true);
    // Parts outside the draw order (hidden) get no bounds.
    const hidden = scene({ parts: { p: [20, 30, 40, 20] } });
    hidden.pose.drawOrder = [];
    const untouched = createImage(200, 100, '#000000');
    drawOverlay(untouched, hidden, { layers: ['bounds', 'labels'] });
    expect(untouched.data.every((v, i) => v === (i % 4 === 3 ? 255 : 0))).toBe(true);
  });
});

describe('drawOverlay: labels', () => {
  it('labels bones near the joint and parts at the top-left of their bounds', () => {
    const img = createImage(200, 100, '#ffffff');
    drawOverlay(
      img,
      scene({ bones: [{ id: 'arm', joint: [30, 50], tip: [80, 50] }], parts: { hat: [100, 20, 60, 40] } }),
      {
        layers: ['labels'],
      },
    );
    // Bone label: box 8px right of the joint, vertically centered on it -> (38, 45) 21x11, white "arm" at (40, 47).
    const bone: [number, number, number, number] = [38, 45, 21, 11];
    expect(rgb(img, 45, 46)[0]).toBeLessThan(100);
    expect(pixelsOfColor(img, bone, [255, 255, 255, 255])).toEqual(textPixels('arm', 40, 47, bone));
    // Part label: box at the top-left of the bounds + 2 -> (102, 22), text in the bounds color.
    const part: [number, number, number, number] = [102, 22, 21, 11];
    expect(rgb(img, 103, 23)[0]).toBeLessThan(100);
    expect(pixelsOfColor(img, part, [255, 217, 51, 255])).toEqual(textPixels('hat', 104, 24, part));
  });

  it('nudges overlapping labels apart vertically', () => {
    const img = createImage(200, 100, '#ffffff');
    const bones: BoneDef[] = [
      { id: 'a', joint: [50, 50], tip: [90, 50] },
      { id: 'b', joint: [50, 50], tip: [50, 90] },
    ];
    drawOverlay(img, scene({ bones }), { layers: ['labels'] });
    // Each label has a 2px strip in its bone color on its left edge (x = 58): palette red and green.
    const redRows: number[] = [];
    const greenRows: number[] = [];
    for (let y = 0; y < 100; y++) {
      const [r, g, b] = rgb(img, 58, y);
      if (r === 255 && g === 84 && b === 84) redRows.push(y);
      if (r === 84 && g === 255 && b === 102) greenRows.push(y);
    }
    expect(redRows.length).toBe(11);
    expect(greenRows.length).toBe(11);
    expect(redRows.some((y) => greenRows.includes(y))).toBe(false);
  });

  it('skips labels for bones outside the image', () => {
    const img = createImage(100, 100, '#ffffff');
    drawOverlay(img, scene({ bones: [{ id: 'far', joint: [500, 50], tip: [600, 50] }] }), { layers: ['labels'] });
    expect(img.data.every((v) => v === 255)).toBe(true);
  });
});

describe('drawOverlay: general', () => {
  const s = scene({
    bones: [{ id: 'root', joint: [20, 50], tip: [120, 50] }],
    parts: { p: [10, 10, 50, 50] },
    warps: [{ id: 'w', cols: 1, rows: 1, points: [0, 0, 100, 0, 0, 100, 100, 100] }],
  });

  it('leaves the image untouched with no layers', () => {
    const img = createImage(200, 100, '#336699');
    const before = cloneImage(img);
    drawOverlay(img, s, { layers: [] });
    expect(Buffer.from(img.data).equals(Buffer.from(before.data))).toBe(true);
  });

  it('tolerates a model and pose that disagree, including ids that are Object.prototype keys', () => {
    const img = createImage(40, 40, '#ffffff');
    const bare = scene();
    const model = {
      ...bare.model,
      bones: [{ id: 'constructor', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, length: 10 }],
      warps: [{ id: 'toString', rect: [0, 0, 10, 10], cols: 1, rows: 1 }],
    } as unknown as Model;
    const layers: OverlayLayer[] = ['bones', 'warps', 'labels', 'bounds'];
    expect(() => drawOverlay(img, { ...bare, model }, { layers })).not.toThrow();
    expect(img.data.every((v) => v === 255)).toBe(true);
  });

  it('draws many long bones on a large image quickly (work scales with drawn pixels)', () => {
    const size = 2048;
    const bones: BoneDef[] = Array.from({ length: 60 }, (_, i) => {
      const joint: [number, number] = [(i * 37) % size, (i * 91) % size];
      return { id: `b${i}`, parent: i ? `b${i - 1}` : undefined, joint, tip: [size - 1 - joint[0], size - 1 - ((i * 53) % size)] };
    });
    const img = createImage(size, size, '#ffffff');
    const t0 = performance.now();
    drawOverlay(img, scene({ bones }), { layers: ['bones', 'labels'] });
    expect(performance.now() - t0).toBeLessThan(1000);
    for (const b of bones) {
      const mid = [0, 1].map((k) => Math.floor((b.joint[k] + b.tip[k]) / 2));
      expect(rgb(img, mid[0], mid[1]), b.id).not.toEqual([255, 255, 255]);
    }
  });

  it('draws layers in a fixed order regardless of the option order', () => {
    const layers: OverlayLayer[] = ['labels', 'bones', 'bounds', 'warps', 'mesh', 'grid'];
    const a = createImage(200, 100, '#ffffff');
    const b = createImage(200, 100, '#ffffff');
    drawOverlay(a, s, { layers });
    drawOverlay(b, s, { layers: [...layers].reverse() });
    expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(true);
  });
});

describe('drawOverlay: focus (only)', () => {
  const bones: BoneDef[] = [
    { id: 'root', joint: [20, 50], tip: [60, 50] },
    { id: 'arm', parent: 'root', joint: [60, 50], tip: [100, 50] },
    { id: 'hand', parent: 'arm', joint: [100, 50], tip: [140, 50] },
    { id: 'other', joint: [170, 80], tip: [190, 80] },
  ];

  it('draws only the listed bones, and their ancestors with onlyChain', () => {
    const img = createImage(200, 100, '#ffffff');
    const before = cloneImage(img);
    drawOverlay(img, scene({ bones }), { layers: ['bones'], only: ['hand'] });
    expect(changed(img, before, 120, 50)).toBe(true);
    expect(changed(img, before, 40, 50)).toBe(false);
    expect(changed(img, before, 80, 50)).toBe(false);
    expect(changed(img, before, 180, 80)).toBe(false);
    const chain = createImage(200, 100, '#ffffff');
    drawOverlay(chain, scene({ bones }), { layers: ['bones'], only: ['hand'], onlyChain: true });
    for (const x of [40, 80, 120]) expect(changed(chain, before, x, 50)).toBe(true);
    expect(changed(chain, before, 180, 80)).toBe(false);
  });

  it('filters labels, bounds, warps and mesh by id; the grid stays', () => {
    const s = scene({
      bones,
      parts: { p: [20, 10, 30, 20], q: [120, 10, 30, 20] },
      warps: [
        { id: 'w', cols: 1, rows: 1, points: [10, 60, 50, 60, 10, 95, 50, 95] },
        { id: 'v', cols: 1, rows: 1, points: [110, 60, 150, 60, 110, 95, 150, 95] },
      ],
    });
    const all = createImage(200, 100, '#000000');
    drawOverlay(all, s, { layers: ['bounds', 'warps', 'labels'] });
    const img = createImage(200, 100, '#000000');
    const before = cloneImage(img);
    drawOverlay(img, s, { layers: ['bounds', 'warps', 'labels'], only: ['q', 'v'] });
    expect(changed(img, before, 135, 10)).toBe(true); // q's bounds
    expect(changed(img, before, 35, 10)).toBe(false); // p's bounds
    expect(changed(img, before, 130, 60)).toBe(true); // v's lattice
    expect(changed(img, before, 30, 60)).toBe(false); // w's lattice
    expect(changed(all, before, 30, 60)).toBe(true);
    // No bone is listed: no bone labels (the "root" label box right of its joint stays black).
    expect(changed(all, before, 32, 50)).toBe(true);
    expect(changed(img, before, 32, 50)).toBe(false);
    const grid = createImage(200, 100, '#000000');
    drawOverlay(grid, s, { layers: ['grid'], only: ['nothing'] });
    expect(changed(grid, before, 50, 5)).toBe(true);
  });
});

describe('drawOverlay: label placement', () => {
  it('stacks labels that share an anchor directly below each other, without leader lines', () => {
    const img = createImage(200, 100, '#ffffff');
    const bones: BoneDef[] = [
      { id: 'a', joint: [50, 50], tip: [90, 50] },
      { id: 'b', joint: [50, 50], tip: [50, 90] },
      { id: 'c', joint: [50, 50], tip: [10, 50] },
    ];
    drawOverlay(img, scene({ bones }), { layers: ['labels'] });
    // Color strips at x = 58: red (a), green (b), blue (c), each 11 rows, in that order top to bottom.
    const rows = (rgbWant: number[]) =>
      Array.from({ length: 100 }, (_, y) => y).filter((y) => {
        const [r, g, b] = rgb(img, 58, y);
        return r === rgbWant[0] && g === rgbWant[1] && b === rgbWant[2];
      });
    const a = rows([255, 84, 84]);
    const b = rows([84, 255, 102]);
    const c = rows([89, 153, 255]);
    expect([a.length, b.length, c.length]).toEqual([11, 11, 11]);
    expect(a[0]).toBe(45); // the first label keeps its spot: centered on the joint
    expect(b[0]).toBe(a[a.length - 1] + 2);
    expect(c[0]).toBe(b[b.length - 1] + 2);
    // Nothing is drawn between the joint and the stack (no leader line for an unmoved block).
    for (let x = 51; x < 57; x++) expect(rgb(img, x, 50)).toEqual([255, 255, 255]);
  });

  it('draws a leader line from a displaced label back to its anchor', () => {
    const bones: BoneDef[] = [
      { id: 'a', joint: [50, 50], tip: [90, 50] },
      { id: 'b', joint: [50, 53], tip: [90, 53] },
    ];
    const img = createImage(200, 100, '#ffffff');
    drawOverlay(img, scene({ bones }), { layers: ['labels'] });
    // "b" wanted (58, 48) but "a" occupies (58, 45)-(79, 56): it moves one row down to y = 57, and a
    // dashed line runs from its joint (50, 53) to the middle of the box's left side (58, 62.5).
    const onLine = [51, 52, 53, 54, 55, 56].filter((x) => rgb(img, x, Math.floor(53 + ((x + 0.5 - 50) * 9.5) / 8))[0] < 250);
    expect(onLine.length).toBeGreaterThanOrEqual(3);
    // Without the crowding "b" sits at its spot and no line is drawn.
    const alone = createImage(200, 100, '#ffffff');
    drawOverlay(alone, scene({ bones: [bones[1]] }), { layers: ['labels'] });
    for (const x of [52, 54, 56]) expect(rgb(alone, x, Math.round(53 + ((x - 50) * 4) / 8))).toEqual([255, 255, 255]);
  });

  it('indents a displaced part label so its leader leaves the bounds edge at an angle', () => {
    // "a" labels its bounds at (22, 22) 9x11; "b" (corner 2 px lower) wants (22, 24), moves one row
    // down and 10 px right: box (32, 36), text at (34, 38).
    const img = createImage(200, 100, '#ffffff');
    drawOverlay(img, scene({ parts: { a: [20, 20, 60, 60], b: [20, 22, 60, 60] } }), { layers: ['labels'] });
    const box: [number, number, number, number] = [32, 36, 9, 11];
    expect(pixelsOfColor(img, box, [255, 217, 51, 255])).toEqual(textPixels('b', 34, 38, box));
    // The leader runs diagonally from the corner (20, 22) to the middle of the box's left side
    // (32, 41.5): nothing along the bounds' left edge (x = 20).
    for (let y = 28; y <= 40; y++) for (const x of [20, 21]) expect(rgb(img, x, y), `${x},${y}`).toEqual([255, 255, 255]);
    expect(rgb(img, 30, 39)).not.toEqual([255, 255, 255]);
  });

  it('draws leader lines dashed, lighter than the label color, with a dot on the anchor', () => {
    // On black: the dark shadow leaves black, so every lit pixel shows the leader color alone.
    const img = createImage(200, 100, '#000000');
    drawOverlay(img, scene({ parts: { a: [20, 20, 60, 60], b: [20, 22, 60, 60] } }), { layers: ['labels'] });
    // Samples along the leader (20, 22) -> (32, 41.5) below label "a" (which is drawn over it) and before label "b".
    const samples = Array.from({ length: 17 }, (_, i) => {
      const t = 0.62 + (i * 0.36) / 16;
      return rgb(img, Math.floor(20 + 12 * t), Math.floor(22 + 19.5 * t));
    });
    const lit = samples.filter(([r]) => r > 100);
    expect(lit.length).toBeGreaterThan(2);
    // Dashed: some samples fall into gaps.
    expect(samples.some(([r]) => r < 30)).toBe(true);
    // Paler than the bounds/label yellow (blue/red 0.2): a lighter tint (blue/red 0.56).
    for (const [r, , b] of lit) expect(b / r).toBeGreaterThan(0.4);
    // The dot: the anchor pixel is lit in the leader color.
    const [r, g, b] = rgb(img, 20, 22);
    expect(r).toBeGreaterThan(200);
    expect(g).toBeGreaterThan(180);
    expect(b / r).toBeGreaterThan(0.4);
  });

  it('is deterministic', () => {
    const bones: BoneDef[] = Array.from({ length: 12 }, (_, i) => ({ id: `bone${i}`, joint: [40 + (i % 3) * 2, 40 + i] as [number, number], tip: [80, 40 + i] as [number, number] }));
    const a = createImage(200, 100, '#ffffff');
    const b = createImage(200, 100, '#ffffff');
    drawOverlay(a, scene({ bones, parts: { p: [30, 30, 40, 40] } }), { layers: ['labels', 'bones'] });
    drawOverlay(b, scene({ bones, parts: { p: [30, 30, 40, 40] } }), { layers: ['labels', 'bones'] });
    expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(true);
  });
});
