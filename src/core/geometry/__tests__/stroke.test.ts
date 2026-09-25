import { describe, expect, it } from 'vitest';
import { compileGeometry } from '../index.js';
import { strokeContours } from '../stroke.js';
import type { MeshBatch } from '../../types.js';
import { bounds, colorAt, expectBounds, part, totalArea, triangleArea } from './helpers.js';

const ctx = { textures: {} };
const rect = { type: 'rect', x: 0, y: 0, w: 100, h: 50 };
const rectPoints = [0, 0, 100, 0, 100, 50, 0, 50];

function stroke(shape: Record<string, unknown>, s: Record<string, unknown>): MeshBatch {
  const g = compileGeometry(part({ shape, stroke: { color: '#000', ...s } }), ctx);
  expect(g.stroke).not.toBeNull();
  return g.stroke!;
}

function reversed(p: number[]): number[] {
  const out: number[] = [];
  for (let i = p.length - 2; i >= 0; i -= 2) out.push(p[i], p[i + 1]);
  return out;
}

describe('stroke alignment', () => {
  it('centers, insets or outsets the band relative to the fill', () => {
    expectBounds(stroke(rect, { width: 10, join: 'miter' }).positions, [-5, -5, 105, 55]);
    expectBounds(stroke(rect, { width: 10, join: 'miter', align: 'outside' }).positions, [-10, -10, 110, 60]);
    expectBounds(stroke(rect, { width: 10, join: 'round', align: 'outside' }).positions, [-10, -10, 110, 60]);
    for (const join of ['round', 'miter', 'bevel']) {
      expectBounds(stroke(rect, { width: 10, join, align: 'inside' }).positions, [0, 0, 100, 50]);
    }
  });

  it('does not depend on the winding of the outline', () => {
    for (const points of [rectPoints, reversed(rectPoints)]) {
      const shape = { type: 'polygon', points };
      expectBounds(stroke(shape, { width: 4, join: 'miter', align: 'outside' }).positions, [-4, -4, 104, 54]);
      expectBounds(stroke(shape, { width: 4, join: 'miter', align: 'inside' }).positions, [0, 0, 100, 50]);
    }
  });

  it('offsets ellipse strokes along the radius', () => {
    const circle = { type: 'ellipse', cx: 0, cy: 0, rx: 50, ry: 50 };
    const radii = (b: MeshBatch) => {
      let min = Infinity;
      let max = 0;
      for (let i = 0; i < b.positions.length; i += 2) {
        const r = Math.hypot(b.positions[i], b.positions[i + 1]);
        min = Math.min(min, r);
        max = Math.max(max, r);
      }
      return [min, max];
    };
    const [outMin, outMax] = radii(stroke(circle, { width: 6, align: 'outside' }));
    expect(outMin).toBeGreaterThan(49.9);
    // The outline is a 79-gon, so the band follows its chords.
    expect(outMax).toBeGreaterThan(55.99);
    expect(outMax).toBeLessThanOrEqual(56 + 1e-4);
    const [inMin, inMax] = radii(stroke(circle, { width: 6, align: 'inside' }));
    expect(inMin).toBeGreaterThan(43.9);
    expect(inMax).toBeLessThanOrEqual(50 + 1e-4);
  });

  it('uses the implicitly closed fill of an open subpath to decide inside/outside', () => {
    // Arc over the top of (50, 0); its implicit fill is the half disc below the arc.
    const arc = { type: 'path', d: 'M0 0 A50 50 0 0 1 100 0' };
    const radii = (b: MeshBatch) => {
      const r: number[] = [];
      for (let i = 0; i < b.positions.length; i += 2) r.push(Math.hypot(b.positions[i] - 50, b.positions[i + 1]));
      return [Math.min(...r), Math.max(...r)];
    };
    const inside = radii(stroke(arc, { width: 4, align: 'inside' }));
    expect(inside[0]).toBeGreaterThan(45.9);
    expect(inside[1]).toBeLessThanOrEqual(50 + 1e-4);
    const outside = radii(stroke(arc, { width: 4, align: 'outside' }));
    expect(outside[0]).toBeGreaterThan(49.9);
    expect(outside[1]).toBeLessThanOrEqual(54 + 1e-4);
  });

  it('decides the side per subpath, whatever each one\'s winding', () => {
    // Clockwise square at the origin, counter-clockwise square at x = 200 (on screen).
    const d = 'M0 0 h100 v100 h-100 z M200 0 v100 h100 v-100 z';
    const outside = stroke({ type: 'path', d }, { width: 4, join: 'miter', align: 'outside' });
    const inside = stroke({ type: 'path', d }, { width: 4, join: 'miter', align: 'inside' });
    const split = (b: MeshBatch) => {
      const left: number[] = [];
      const right: number[] = [];
      for (let i = 0; i < b.positions.length; i += 2) (b.positions[i] < 150 ? left : right).push(b.positions[i], b.positions[i + 1]);
      return [left, right];
    };
    const [outLeft, outRight] = split(outside);
    expectBounds(outLeft, [-4, -4, 104, 104]);
    expectBounds(outRight, [196, -4, 304, 104]);
    const [inLeft, inRight] = split(inside);
    expectBounds(inLeft, [0, 0, 100, 100]);
    expectBounds(inRight, [200, 0, 300, 100]);
  });

  it('honours an explicit interior side and falls back to center when there is none', () => {
    const line = [0, 0, 100, 0];
    const style = { width: 4, join: 'round', align: 'inside' } as const;
    expectBounds(strokeContours([{ points: line, closed: false, interior: 1 }], style).positions, [0, 0, 100, 4]);
    expectBounds(strokeContours([{ points: line, closed: false, interior: -1 }], style).positions, [0, -4, 100, 0]);
    expectBounds(strokeContours([{ points: line, closed: false }], style).positions, [0, -2, 100, 2]);
  });
});

describe('stroke joins', () => {
  // Corner region of the rect outline around (0, 0): how far the join reaches along the diagonal.
  const diagonalReach = (b: MeshBatch) => {
    let m = -Infinity;
    for (let i = 0; i < b.positions.length; i += 2) m = Math.max(m, -(b.positions[i] + b.positions[i + 1]) / Math.SQRT2);
    return m;
  };

  it('miter reaches the corner, bevel cuts it, round follows the arc', () => {
    const s = { width: 10, align: 'outside' };
    expect(diagonalReach(stroke(rect, { ...s, join: 'miter' }))).toBeCloseTo(10 * Math.SQRT2, 4);
    expect(diagonalReach(stroke(rect, { ...s, join: 'bevel' }))).toBeCloseTo(10 / Math.SQRT2, 4);
    const round = stroke(rect, { ...s, join: 'round' });
    expect(diagonalReach(round)).toBeCloseTo(10, 4);
    // Round-join vertices near the corner stay on or inside the arc of radius 10.
    for (let i = 0; i < round.positions.length; i += 2) {
      const [x, y] = [round.positions[i], round.positions[i + 1]];
      if (x < 0 && y < 0) expect(Math.hypot(x, y)).toBeLessThanOrEqual(10 + 1e-4);
    }
  });

  it('falls back to bevel beyond the miter limit of 4', () => {
    // Apex at the origin opening towards +x with an interior angle of 30° (miter ratio 3.86) or 28° (4.13).
    const wedge = (deg: number) => {
      const h = 100 * Math.tan(((deg / 2) * Math.PI) / 180);
      return { type: 'polygon', points: [0, 0, 100, -h, 100, h] };
    };
    const minX = (b: MeshBatch) => bounds(b.positions)[0];
    const s = { width: 2, join: 'miter' };
    expect(minX(stroke(wedge(30), s))).toBeCloseTo(-1 / Math.sin((15 * Math.PI) / 180), 4);
    expect(minX(stroke(wedge(28), s))).toBeCloseTo(-Math.sin((14 * Math.PI) / 180), 4);
    expect(minX(stroke(wedge(28), { ...s, join: 'bevel' }))).toBeCloseTo(-Math.sin((14 * Math.PI) / 180), 4);
    // A 3-segment fan of radius 1 around the 152° turn.
    expect(minX(stroke(wedge(28), { ...s, join: 'round' }))).toBeCloseTo(-Math.cos((152 / 6) * (Math.PI / 180)), 4);
  });

  it('uses more round-join segments for sharper turns', () => {
    const right = stroke({ type: 'path', d: 'M0 0 L100 0 L100 100' }, { width: 20 });
    const sharp = stroke({ type: 'path', d: 'M0 0 L100 0 L0 20' }, { width: 20 });
    // Two segment quads (8 vertices) plus the join fan.
    const fan = (b: MeshBatch) => b.positions.length / 2 - 8;
    expect(fan(sharp)).toBeGreaterThan(fan(right));
    for (const b of [right, sharp]) {
      for (let i = 16; i < b.positions.length; i += 2) {
        expect(Math.hypot(b.positions[i] - 100, b.positions[i + 1])).toBeLessThanOrEqual(10 + 1e-4);
      }
    }
  });

  it('emits positively oriented triangles only', () => {
    for (const join of ['round', 'miter', 'bevel']) {
      for (const align of ['center', 'inside', 'outside']) {
        const b = stroke({ type: 'polygon', points: [0, 0, 60, 0, 60, 60, 30, 20, 0, 60] }, { width: 6, join, align });
        for (let t = 0; t < b.indices.length / 3; t++) expect(triangleArea(b.positions, b.indices, t)).toBeGreaterThan(0);
      }
    }
  });
});

describe('open and closed subpaths', () => {
  it('draws open subpaths with butt caps', () => {
    const b = stroke({ type: 'path', d: 'M0 0 L100 0' }, { width: 10 });
    expectBounds(b.positions, [0, -5, 100, 5]);
    expect(b.indices).toHaveLength(6);
    expect(totalArea(b.positions, b.indices)).toBeCloseTo(1000, 6);
  });

  it('joins every vertex of Z-closed subpaths, only interior vertices of open ones', () => {
    const open = stroke({ type: 'path', d: 'M0 0 L100 0 L100 100' }, { width: 10, join: 'miter' });
    expectBounds(open.positions, [0, -5, 105, 100]);
    expect(open.indices).toHaveLength(2 * 6 + 6); // two quads + one miter join
    const closed = stroke({ type: 'path', d: 'M0 0 L100 0 L100 100 Z' }, { width: 10, join: 'miter' });
    expect(closed.indices).toHaveLength(3 * 6 + 3 * 6);
    expect(bounds(closed.positions)[0]).toBeLessThan(-5);
  });

  it('strokes every subpath of a path', () => {
    const b = stroke({ type: 'path', d: 'M0 0 L10 0 L10 10 Z M50 50 L60 50' }, { width: 2 });
    expectBounds(b.positions, [-1, -1, 60, 51]);
  });

  it('strokes degenerate outlines that have no fill', () => {
    const g = compileGeometry(part({ shape: { type: 'polygon', points: [0, 0, 50, 0, 100, 0] }, stroke: { color: '#000', width: 2 } }), ctx);
    expect(g.fill).toBeNull();
    expectBounds(g.stroke!.positions, [-1, -1, 101, 1]);
  });

  it('caps U-turns with round joins only, without zero-area triangles', () => {
    const line = { type: 'polygon', points: [0, 0, 100, 0] };
    expectBounds(stroke(line, { width: 10, join: 'round' }).positions, [-5, -5, 105, 5]);
    for (const join of ['miter', 'bevel']) {
      const b = stroke(line, { width: 10, join });
      expectBounds(b.positions, [0, -5, 100, 5]);
      for (let t = 0; t < b.indices.length / 3; t++) expect(triangleArea(b.positions, b.indices, t)).toBeGreaterThan(0);
    }
  });
});

describe('mesh boundary strokes', () => {
  // 3x3 grid over [0, 20]², 8 triangles.
  const gridVertices = [0, 0, 10, 0, 20, 0, 0, 10, 10, 10, 20, 10, 0, 20, 10, 20, 20, 20];
  const gridTriangles = [0, 1, 4, 0, 4, 3, 1, 2, 5, 1, 5, 4, 3, 4, 7, 3, 7, 6, 4, 5, 8, 4, 8, 7];
  // Square ring: outer [0, 30]², hole [10, 20]².
  const ringVertices = [0, 0, 30, 0, 30, 30, 0, 30, 10, 10, 20, 10, 20, 20, 10, 20];
  const ringTriangles: number[] = [];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    ringTriangles.push(i, j, 4 + j, i, 4 + j, 4 + i);
  }
  const chebyshev = (b: MeshBatch, i: number) => Math.max(Math.abs(b.positions[i] - 15), Math.abs(b.positions[i + 1] - 15));

  it('strokes the outer boundary loop of a mesh', () => {
    const b = stroke({ type: 'mesh', vertices: gridVertices, triangles: gridTriangles }, { width: 2, join: 'miter', align: 'outside' });
    expectBounds(b.positions, [-2, -2, 22, 22]);
    // No stroke along interior edges: nothing near the grid center.
    for (let i = 0; i < b.positions.length; i += 2) {
      expect(Math.max(Math.abs(b.positions[i] - 10), Math.abs(b.positions[i + 1] - 10))).toBeGreaterThanOrEqual(10 - 1e-6);
    }
  });

  it('strokes holes on the correct side', () => {
    const shape = { type: 'mesh', vertices: ringVertices, triangles: ringTriangles };
    const outside = stroke(shape, { width: 2, join: 'miter', align: 'outside' });
    expectBounds(outside.positions, [-2, -2, 32, 32]);
    for (let i = 0; i < outside.positions.length; i += 2) {
      const d = chebyshev(outside, i);
      // Outer loop band beyond 15, hole band inside the hole (3..5).
      expect(d >= 15 - 1e-6 || (d >= 3 - 1e-6 && d <= 5 + 1e-6)).toBe(true);
    }
    const inside = stroke(shape, { width: 2, join: 'miter', align: 'inside' });
    for (let i = 0; i < inside.positions.length; i += 2) {
      const d = chebyshev(inside, i);
      expect((d >= 13 - 1e-6 && d <= 15 + 1e-6) || (d >= 5 - 1e-6 && d <= 7 + 1e-6)).toBe(true);
    }
  });

  it('does not depend on the triangle winding', () => {
    const flipped = ringTriangles.slice();
    for (let t = 0; t < flipped.length; t += 6) [flipped[t + 1], flipped[t + 2]] = [flipped[t + 2], flipped[t + 1]];
    const s = { width: 2, align: 'outside' };
    expect(stroke({ type: 'mesh', vertices: ringVertices, triangles: flipped }, s)).toEqual(
      stroke({ type: 'mesh', vertices: ringVertices, triangles: ringTriangles }, s),
    );
  });
});

describe('stroke batch', () => {
  it('paints every vertex with the stroke color and never samples the texture', () => {
    const g = compileGeometry(
      part({ shape: { type: 'image', texture: 't', x: 0, y: 0, w: 10, h: 10 }, stroke: { color: 'rgba(255, 0, 0, 0.5)', width: 1 } }),
      ctx,
    );
    const b = g.stroke!;
    for (let i = 0; i < b.positions.length / 2; i++) expect(colorAt(b, i)).toEqual([1, 0, 0, 0.5]);
    expect(b.uvs).toBeUndefined();
    expect(b.texture).toBeUndefined();
    expectBounds(b.positions, [-0.5, -0.5, 10.5, 10.5]);
  });

  it('is omitted without a stroke, with zero width, or for zero-size shapes', () => {
    expect(compileGeometry(part({ shape: rect }), ctx).stroke).toBeNull();
    expect(compileGeometry(part({ shape: rect, stroke: { color: '#000', width: 0 } }), ctx).stroke).toBeNull();
    const flat = compileGeometry(part({ shape: { type: 'ellipse', cx: 0, cy: 0, rx: 0, ry: 5 }, stroke: { color: '#000', width: 2 } }), ctx);
    expect(flat).toEqual({ fill: null, stroke: null });
  });

  it('subdivides the stroke outline with detail', () => {
    const b = stroke({ ...rect, detail: 10 }, { width: 2, join: 'bevel' });
    // 30 outline segments of 10 px (quads), plus 4 corner bevels.
    expect(b.indices.length / 3).toBe(30 * 2 + 4);
  });
});
