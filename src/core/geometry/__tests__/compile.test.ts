import { describe, expect, it } from 'vitest';
import { compileGeometry, GeometryError } from '../index.js';
import { MAX_DETAIL_VERTICES } from '../triangulate.js';
import type { MeshBatch, Part } from '../../types.js';
import { colorAt, expectBounds, expectValidTriangulation, maxEdge, minAngleDeg, part, shoelace, totalArea } from './helpers.js';

const ctx = { textures: { tex: { width: 200, height: 100 } } };

function fillOf(input: Record<string, unknown>): MeshBatch {
  const g = compileGeometry(part(input), ctx);
  expect(g.fill).not.toBeNull();
  return g.fill!;
}

/** Area of the inscribed n-gon of an ellipse (affine image of a regular n-gon). */
const ellipsePolygonArea = (rx: number, ry: number, n: number) => (n / 2) * rx * ry * Math.sin((2 * Math.PI) / n);

describe('ellipse', () => {
  it('uses auto segments clamp(ceil(perimeter / 4), 16, 128) and preserves the polygon area', () => {
    // Perimeter of a 50x30 ellipse ≈ 255.27 -> 64 segments.
    const f = fillOf({ shape: { type: 'ellipse', cx: 100, cy: 80, rx: 50, ry: 30 } });
    expect(f.positions.length / 2).toBe(64);
    expect(f.indices.length / 3).toBe(62);
    expectValidTriangulation(f.positions, f.indices, ellipsePolygonArea(50, 30, 64), 1e-5);
    expect(Math.abs(totalArea(f.positions, f.indices) - Math.PI * 1500) / (Math.PI * 1500)).toBeLessThan(0.002);
    expectBounds(f.positions, [50, 50, 150, 110]);
    expect(fillOf({ shape: { type: 'ellipse', cx: 0, cy: 0, rx: 2, ry: 2 } }).positions.length / 2).toBe(16);
    expect(fillOf({ shape: { type: 'ellipse', cx: 0, cy: 0, rx: 1000, ry: 900 } }).positions.length / 2).toBe(128);
  });

  it('honours explicit segments', () => {
    const f = fillOf({ shape: { type: 'ellipse', cx: 0, cy: 0, rx: 10, ry: 10, segments: 6 } });
    expect(f.positions.length / 2).toBe(6);
    expect(totalArea(f.positions, f.indices)).toBeCloseTo(ellipsePolygonArea(10, 10, 6), 4);
  });

  it('rotates clockwise on screen (+y is down) around the center', () => {
    const f = fillOf({ shape: { type: 'ellipse', cx: 10, cy: 20, rx: 50, ry: 20, rotation: 30 } });
    expect(f.positions[0]).toBeCloseTo(10 + 50 * Math.cos(Math.PI / 6), 4);
    expect(f.positions[1]).toBeCloseTo(20 + 50 * Math.sin(Math.PI / 6), 4);
    expectBounds(fillOf({ shape: { type: 'ellipse', cx: 0, cy: 0, rx: 50, ry: 20, rotation: 90, segments: 64 } }).positions, [-20, -50, 20, 50]);
  });

  it('refines with detail: edges <= detail, same area, well-shaped triangles', () => {
    const f = fillOf({ shape: { type: 'ellipse', cx: 100, cy: 100, rx: 100, ry: 60, detail: 8 } });
    expect(maxEdge(f.positions, f.indices)).toBeLessThanOrEqual(8 * (1 + 1e-5));
    const n = 128;
    expectValidTriangulation(f.positions, f.indices, ellipsePolygonArea(100, 60, n), 1e-5);
    expect(minAngleDeg(f.positions, f.indices)).toBeGreaterThan(20);
    for (let i = 0; i < f.positions.length; i += 2) {
      expect(((f.positions[i] - 100) / 100) ** 2 + ((f.positions[i + 1] - 100) / 60) ** 2).toBeLessThanOrEqual(1 + 1e-5);
    }
  });

  it('has no geometry when a radius is zero', () => {
    expect(compileGeometry(part({ shape: { type: 'ellipse', cx: 0, cy: 0, rx: 0, ry: 10 } }), ctx)).toEqual({ fill: null, stroke: null });
  });

  it('treats negative radii from bindings as their absolute values', () => {
    const p = part({ shape: { type: 'ellipse', cx: 5, cy: 5, rx: 30, ry: 20, rotation: 15 }, stroke: { color: '#000', width: 2 } });
    const negative = { ...p, shape: { ...p.shape, rx: -30, ry: -20 } as Part['shape'] };
    expect(compileGeometry(negative, ctx)).toEqual(compileGeometry(p, ctx));
  });
});

describe('rect', () => {
  it('is two triangles without radius', () => {
    const f = fillOf({ shape: { type: 'rect', x: 10, y: 20, w: 100, h: 60 } });
    expect(Array.from(f.positions)).toEqual([10, 20, 110, 20, 110, 80, 10, 80]);
    expectValidTriangulation(f.positions, f.indices, 6000, 1e-12);
  });

  it('rounds corners smoothly and preserves the rounded area', () => {
    const f = fillOf({ shape: { type: 'rect', x: 0, y: 0, w: 100, h: 60, radius: 10 } });
    const segmentsPerCorner = (f.positions.length / 2) / 4 - 1;
    expect(segmentsPerCorner).toBeGreaterThanOrEqual(4);
    const exact = 6000 - 400 + 4 * (segmentsPerCorner / 2) * 100 * Math.sin(Math.PI / 2 / segmentsPerCorner);
    expectValidTriangulation(f.positions, f.indices, exact, 1e-6);
    expect(Math.abs(totalArea(f.positions, f.indices) - (6000 - (4 - Math.PI) * 100))).toBeLessThan(5);
    expectBounds(f.positions, [0, 0, 100, 60]);
  });

  it('clamps the radius to half the shorter side (stadium) without duplicate vertices', () => {
    const f = fillOf({ shape: { type: 'rect', x: 0, y: 0, w: 40, h: 20, radius: 50 } });
    for (let i = 0; i < f.positions.length; i += 2) {
      const j = (i + 2) % f.positions.length;
      expect(Math.hypot(f.positions[j] - f.positions[i], f.positions[j + 1] - f.positions[i + 1])).toBeGreaterThan(1e-6);
    }
    // Two straight 20 px edges plus four quarter arcs of radius 10.
    const segmentsPerCorner = (f.positions.length / 2 + 2) / 4 - 1;
    const exact = 800 - 400 + 4 * (segmentsPerCorner / 2) * 100 * Math.sin(Math.PI / 2 / segmentsPerCorner);
    expectValidTriangulation(f.positions, f.indices, exact, 1e-6);
  });

  it('normalizes negative sizes from bindings (the rect spans the same area)', () => {
    const p = part({ shape: { type: 'rect', x: 0, y: 0, w: 1, h: 1, radius: 10 } });
    const flipped = compileGeometry({ ...p, shape: { ...p.shape, x: 100, y: 60, w: -100, h: -60 } as Part['shape'] }, ctx).fill!;
    const plain = fillOf({ shape: { type: 'rect', x: 0, y: 0, w: 100, h: 60, radius: 10 } });
    expect(flipped).toEqual(plain);
  });

  it('refines with detail', () => {
    const f = fillOf({ shape: { type: 'rect', x: 0, y: 0, w: 100, h: 60, radius: 12, detail: 6 } });
    expect(maxEdge(f.positions, f.indices)).toBeLessThanOrEqual(6 * (1 + 1e-5));
    expect(Math.abs(totalArea(f.positions, f.indices) - (6000 - (4 - Math.PI) * 144))).toBeLessThan(5);
    expect(minAngleDeg(f.positions, f.indices)).toBeGreaterThan(20);
  });
});

describe('polygon', () => {
  const arrow = [0, 0, 60, 0, 60, -20, 100, 20, 60, 60, 60, 40, 0, 40];

  it('fills concave polygons of either winding with the exact area', () => {
    for (const points of [arrow, arrow.map((v, i) => arrow[arrow.length - 2 - i + 2 * (i % 2)])]) {
      const f = fillOf({ shape: { type: 'polygon', points } });
      expect(f.indices.length / 3).toBe(5);
      expectValidTriangulation(f.positions, f.indices, Math.abs(shoelace(arrow)), 1e-12);
    }
  });

  it('drops duplicate and collinear points; degenerate polygons have no fill', () => {
    const f = fillOf({ shape: { type: 'polygon', points: [0, 0, 5, 0, 10, 0, 10, 0, 10, 10, 0, 10] } });
    expect(f.positions.length / 2).toBe(4);
    expect(compileGeometry(part({ shape: { type: 'polygon', points: [0, 0, 5, 5, 10, 10] } }), ctx).fill).toBeNull();
    expect(compileGeometry(part({ shape: { type: 'polygon', points: [0, 0, 1, 1] } }), ctx).fill).toBeNull();
  });

  it('refines with detail', () => {
    const f = fillOf({ shape: { type: 'polygon', points: arrow, detail: 5 } });
    expect(maxEdge(f.positions, f.indices)).toBeLessThanOrEqual(5 * (1 + 1e-5));
    expectValidTriangulation(f.positions, f.indices, Math.abs(shoelace(arrow)), 1e-6);
  });
});

describe('path', () => {
  it('fills each subpath independently, closing open ones implicitly', () => {
    const f = fillOf({ shape: { type: 'path', d: 'M0 0 L100 0 L100 100 Z M200 0 h100 v100 h-100 M400 0 L500 0 L500 100' } });
    expectValidTriangulation(f.positions, f.indices, 5000 + 10000 + 5000, 1e-12);
  });

  it('skips subpaths with fewer than 3 points or no area', () => {
    const f = fillOf({ shape: { type: 'path', d: 'M0 0 L10 10 M0 0 L10 0 L20 0 Z M0 0 L10 0 L10 10 Z' } });
    expect(totalArea(f.positions, f.indices)).toBeCloseTo(50, 9);
    expect(compileGeometry(part({ shape: { type: 'path', d: 'M0 0 L10 10' } }), ctx).fill).toBeNull();
  });

  it('fills arcs: a semicircle has area πr²/2 within the flattening tolerance', () => {
    const f = fillOf({ shape: { type: 'path', d: 'M0 0 A50 50 0 0 1 100 0 Z', tolerance: 0.05 } });
    const area = totalArea(f.positions, f.indices);
    expect(area).toBeLessThanOrEqual((Math.PI * 2500) / 2);
    expect(area).toBeGreaterThan((Math.PI * 2500) / 2 - 0.05 * 160);
  });

  it('refines with detail, per subpath', () => {
    const d = 'M0 0 A50 50 0 0 1 100 0 Z M200 0 l60 0 l0 60 z';
    const coarse = fillOf({ shape: { type: 'path', d } });
    const fine = fillOf({ shape: { type: 'path', d, detail: 6 } });
    expect(maxEdge(fine.positions, fine.indices)).toBeLessThanOrEqual(6 * (1 + 1e-5));
    expect(fine.positions.length).toBeGreaterThan(coarse.positions.length * 4);
    // Same area as the plain fill; float32 positions allow a small relative error.
    expectValidTriangulation(fine.positions, fine.indices, totalArea(coarse.positions, coarse.indices), 1e-5);
    expect(minAngleDeg(fine.positions, fine.indices)).toBeGreaterThan(20);
  });
});

describe('mesh', () => {
  const vertices = [0, 0, 10, 0, 10, 10, 0, 10, 20, 20];

  it('passes vertices and triangles through unchanged (vertex order preserved)', () => {
    const f = fillOf({ shape: { type: 'mesh', vertices, triangles: [0, 1, 2, 0, 2, 3] }, fill: '#ff0000' });
    expect(Array.from(f.positions)).toEqual(vertices);
    expect(Array.from(f.indices)).toEqual([0, 1, 2, 0, 2, 3]);
    for (let i = 0; i < 5; i++) expect(colorAt(f, i)).toEqual([1, 0, 0, 1]);
    expect(f.uvs).toBeUndefined();
    expect(f.texture).toBeUndefined();
  });

  it('carries uvs and texture for textured meshes; fill acts as tint', () => {
    const uvs = [0, 0, 1, 0, 1, 1, 0, 1, 0.5, 0.5];
    const f = fillOf({ shape: { type: 'mesh', vertices, triangles: [0, 1, 2], uvs, texture: 'tex' } });
    expect(Array.from(f.uvs!)).toEqual(uvs);
    expect(f.texture).toBe('tex');
    expect(colorAt(f, 0)).toEqual([1, 1, 1, 1]);
  });

  it('has no fill without triangles', () => {
    expect(compileGeometry(part({ shape: { type: 'mesh', vertices, triangles: [] } }), ctx).fill).toBeNull();
  });
});

describe('image', () => {
  it('builds a (cols+1)x(rows+1) grid sized from the texture with full-texture uvs', () => {
    const f = fillOf({ shape: { type: 'image', texture: 'tex', x: 10, y: 20, cols: 2, rows: 1 } });
    expect(Array.from(f.positions)).toEqual([10, 20, 110, 20, 210, 20, 10, 120, 110, 120, 210, 120]);
    expect(Array.from(f.uvs!)).toEqual([0, 0, 0.5, 0, 1, 0, 0, 1, 0.5, 1, 1, 1]);
    expect(f.texture).toBe('tex');
    expect(f.indices.length / 3).toBe(2 * 2 * 1);
    expectValidTriangulation(f.positions, f.indices, 200 * 100, 1e-12);
    for (let i = 0; i < 6; i++) expect(colorAt(f, i)).toEqual([1, 1, 1, 1]);
  });

  it('maps a crop rectangle (texture px) to uvs and defaults the size to the crop', () => {
    const f = fillOf({ shape: { type: 'image', texture: 'tex', x: 0, y: 0, crop: [50, 25, 100, 50], cols: 2, rows: 1 }, fill: '#808080' });
    expectBounds(f.positions, [0, 0, 100, 50]);
    expect(Array.from(f.uvs!)).toEqual([0.25, 0.25, 0.5, 0.25, 0.75, 0.25, 0.25, 0.75, 0.5, 0.75, 0.75, 0.75]);
    expect(colorAt(f, 0).slice(0, 3).map((v) => +v.toFixed(4))).toEqual([0.502, 0.502, 0.502]);
  });

  it('mirrors when a binding drives w negative: triangles stay positive, uvs follow the vertices', () => {
    const p = part({ shape: { type: 'image', texture: 'tex', x: 0, y: 0, w: 1, h: 1, cols: 2, rows: 1 } });
    const g = compileGeometry({ ...p, shape: { ...p.shape, x: 100, w: -100, h: 50 } as Part['shape'] }, ctx);
    expect(Array.from(g.fill!.positions)).toEqual([100, 0, 50, 0, 0, 0, 100, 50, 50, 50, 0, 50]);
    expect(Array.from(g.fill!.uvs!)).toEqual([0, 0, 0.5, 0, 1, 0, 0, 1, 0.5, 1, 1, 1]);
    expectValidTriangulation(g.fill!.positions, g.fill!.indices, 5000, 1e-12);
  });

  it('uses explicit w/h (and needs no texture size without a crop)', () => {
    const g = compileGeometry(part({ shape: { type: 'image', texture: 'unknown', x: 5, y: 5, w: 30, h: 10 } }), { textures: {} });
    expectBounds(g.fill!.positions, [5, 5, 35, 15]);
    expect(Array.from(g.fill!.uvs!)).toEqual([0, 0, 1, 0, 0, 1, 1, 1]);
  });
});

describe('paint', () => {
  const strip = { type: 'rect', x: 0, y: 0, w: 100, h: 10, detail: 5 };

  function expectEachVertex(f: MeshBatch, expected: (x: number, y: number) => number[]): void {
    for (let i = 0; i < f.positions.length / 2; i++) {
      const want = expected(f.positions[2 * i], f.positions[2 * i + 1]);
      colorAt(f, i).forEach((v, k) => expect(v).toBeCloseTo(want[k], 5));
    }
  }

  it('defaults to white and accepts color strings and solid fills', () => {
    expectEachVertex(fillOf({ shape: strip }), () => [1, 1, 1, 1]);
    expectEachVertex(fillOf({ shape: strip, fill: 'rgba(0, 0, 255, 0.25)' }), () => [0, 0, 1, 0.25]);
    expectEachVertex(fillOf({ shape: strip, fill: { type: 'solid', color: '#00ff0080' } }), () => [0, 1, 0, 128 / 255]);
  });

  it('evaluates linear gradients by projection onto from->to, clamped outside', () => {
    const f = fillOf({ shape: strip, fill: { type: 'linear', from: [25, 0], to: [75, 0], stops: [[0, '#000000'], [1, '#ffffff']] } });
    expectEachVertex(f, (x) => {
      const t = Math.min(1, Math.max(0, (x - 25) / 50));
      return [t, t, t, 1];
    });
    // Diagonal gradient: t is the projection, not the x coordinate.
    const d = fillOf({ shape: strip, fill: { type: 'linear', from: [0, 0], to: [10, 10], stops: [[0, '#000'], [1, '#fff']] } });
    expectEachVertex(d, (x, y) => {
      const t = Math.min(1, Math.max(0, (x + y) / 20));
      return [t, t, t, 1];
    });
  });

  it('sorts stops, interpolates between neighbours and supports hard stops', () => {
    const multi = fillOf({ shape: strip, fill: { type: 'linear', from: [0, 0], to: [100, 0], stops: [[1, 'blue'], [0, 'red'], [0.5, 'lime']] } });
    expectEachVertex(multi, (x) => {
      const t = x / 100;
      return t <= 0.5 ? [1 - 2 * t, 2 * t, 0, 1] : [0, 2 - 2 * t, 2 * t - 1, 1];
    });
    const hard = fillOf({
      shape: strip,
      fill: { type: 'linear', from: [0, 0], to: [100, 0], stops: [[0, 'red'], [0.5, 'red'], [0.5, 'blue'], [1, 'blue']] },
    });
    expectEachVertex(hard, (x) => (x <= 50 ? [1, 0, 0, 1] : [0, 0, 1, 1]));
    const single = fillOf({ shape: strip, fill: { type: 'linear', from: [0, 0], to: [100, 0], stops: [[0.3, '#ff0000']] } });
    expectEachVertex(single, () => [1, 0, 0, 1]);
  });

  it('paints a zero-length linear gradient with the last stop', () => {
    const f = fillOf({ shape: strip, fill: { type: 'linear', from: [5, 5], to: [5, 5], stops: [[0, 'red'], [1, 'blue']] } });
    expectEachVertex(f, () => [0, 0, 1, 1]);
  });

  it('evaluates radial gradients by distance / radius, clamped', () => {
    const f = fillOf({
      shape: { type: 'ellipse', cx: 50, cy: 50, rx: 60, ry: 60, detail: 10 },
      fill: { type: 'radial', center: [50, 50], radius: 50, stops: [[0, '#ffffff'], [1, '#00000000']] },
    });
    expectEachVertex(f, (x, y) => {
      const t = Math.min(1, Math.hypot(x - 50, y - 50) / 50);
      return [1 - t, 1 - t, 1 - t, 1 - t];
    });
    // The lattice is centred on the shape, so a vertex sits at the center and gets the first stop.
    let center = 0;
    const dist = (i: number) => Math.hypot(f.positions[2 * i] - 50, f.positions[2 * i + 1] - 50);
    for (let i = 1; i < f.positions.length / 2; i++) if (dist(i) < dist(center)) center = i;
    expect(dist(center)).toBeLessThan(1e-4);
    colorAt(f, center).forEach((v) => expect(v).toBeCloseTo(1, 5));
  });
});

describe('errors', () => {
  const expectError = (input: Record<string, unknown> | Part, pattern: RegExp, context = ctx) => {
    const p = 'shape' in input && (input as Part).opacity !== undefined ? (input as Part) : part(input);
    expect(() => compileGeometry(p, context)).toThrow(GeometryError);
    expect(() => compileGeometry(p, context)).toThrow(pattern);
  };

  it('reports invalid colors with the part id', () => {
    expectError({ shape: { type: 'rect', x: 0, y: 0, w: 1, h: 1 }, fill: 'nope' }, /part "p": invalid fill color "nope"/);
    expectError({ shape: { type: 'rect', x: 0, y: 0, w: 1, h: 1 }, stroke: { color: '#12', width: 1 } }, /invalid stroke color/);
    expectError(
      { shape: { type: 'rect', x: 0, y: 0, w: 1, h: 1 }, fill: { type: 'radial', center: [0, 0], radius: 1, stops: [[0, 'bad']] } },
      /gradient stop color/,
    );
  });

  it('reports invalid path data', () => {
    expectError({ shape: { type: 'path', d: 'M0 0 X 5' } }, /invalid path data/);
  });

  it('reports unknown textures when their size is needed', () => {
    expectError({ shape: { type: 'image', texture: 'missing', x: 0, y: 0 } }, /unknown texture "missing".*default image w\/h/);
    expectError({ shape: { type: 'image', texture: 'missing', x: 0, y: 0, w: 5, h: 5, crop: [0, 0, 1, 1] } }, /unknown texture "missing".*crop/);
    // Prototype keys are not textures.
    expectError({ shape: { type: 'image', texture: 'constructor', x: 0, y: 0 } }, /unknown texture "constructor"/);
    expectError({ shape: { type: 'image', texture: 'z', x: 0, y: 0 } }, /invalid size/, { textures: { z: { width: 0, height: 5 } } } as never);
  });

  it('reports malformed meshes', () => {
    expectError({ shape: { type: 'mesh', vertices: [0, 0, 1, 0, 1], triangles: [] } }, /odd length/);
    expectError({ shape: { type: 'mesh', vertices: [0, 0, 1, 0, 1, 1], triangles: [0, 1] } }, /3 indices per triangle/);
    expectError({ shape: { type: 'mesh', vertices: [0, 0, 1, 0, 1, 1], triangles: [0, 1, 3] } }, /index 3 is out of range/);
    expectError({ shape: { type: 'mesh', vertices: [0, 0, 1, 0, 1, 1], triangles: [0, 1, 2], texture: 'tex' } }, /needs "uvs"/);
    expectError({ shape: { type: 'mesh', vertices: [0, 0, 1, 0, 1, 1], triangles: [0, 1, 2], texture: 'tex', uvs: [0, 0] } }, /uvs length/);
  });

  it('reports non-finite coordinates and malformed polygons', () => {
    const base = part({ shape: { type: 'ellipse', cx: 0, cy: 0, rx: 5, ry: 5 } });
    expectError({ ...base, shape: { ...base.shape, cx: Number.NaN } as Part['shape'] }, /must be finite/);
    expectError({ shape: { type: 'polygon', points: [0, 0, 1, 0, 1] } }, /odd length/);
    expectError({ ...base, shape: { type: 'polygon', points: [0, 0, 1, Infinity, 1, 1] } }, /must be finite/);
  });

  it('rejects a detail that would create too many vertices', () => {
    expectError({ shape: { type: 'rect', x: 0, y: 0, w: 4000, h: 4000, detail: 1 } }, new RegExp(`limit ${MAX_DETAIL_VERTICES}`));
  });
});

describe('determinism and performance', () => {
  const heavy = part({
    shape: { type: 'path', d: 'M10 80 C 40 10, 65 10, 95 80 S 150 150, 180 80 L180 200 L10 200 Z', detail: 6 },
    fill: { type: 'linear', from: [0, 0], to: [200, 200], stops: [[0, 'red'], [1, 'blue']] },
    stroke: { color: '#000', width: 3, join: 'round', align: 'outside' },
  });

  it('produces identical arrays when compiled twice', () => {
    const a = compileGeometry(heavy, ctx);
    const b = compileGeometry(heavy, ctx);
    expect(a.fill!.positions.length).toBeGreaterThan(100);
    expect(b).toEqual(a);
  });

  it('compiles an r=100 ellipse with detail 8 well under 20 ms', () => {
    const p = part({ shape: { type: 'ellipse', cx: 100, cy: 100, rx: 100, ry: 100, detail: 8 }, stroke: { color: '#000', width: 2 } });
    compileGeometry(p, ctx); // warm up the JIT
    const runs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      compileGeometry(p, ctx);
      runs.push(performance.now() - t0);
    }
    expect(Math.min(...runs)).toBeLessThan(20);
  });
});
