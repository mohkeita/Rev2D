import { describe, expect, it } from 'vitest';
import { subdivideEdges } from '../primitives.js';
import { earClip } from '../triangulate.js';
import { TriMesh } from '../trimesh.js';
import { expectValidTriangulation, maxEdge } from './helpers.js';

const EPS = 1e-9;

function squareMesh(side: number, spacing: number): TriMesh {
  const ring = subdivideEdges([0, 0, side, 0, side, side, 0, side], true, spacing);
  const mesh = new TriMesh(ring, earClip(ring, EPS).triangles, EPS);
  mesh.makeDelaunay();
  return mesh;
}

describe('TriMesh', () => {
  it('inserts interior points only (outside, boundary and duplicate points are ignored)', () => {
    const mesh = squareMesh(10, 5);
    const before = mesh.toTriangles().positions.length / 2;
    mesh.insertPoints([3, 3, 3, 3, 20, 5, -1, -1, 5, 0, 0, 0, 10, 7, 6, 8], 5);
    const { positions, indices } = mesh.toTriangles();
    // Only (3, 3) and (6, 8) are new vertices.
    expect(positions.length / 2).toBe(before + 2);
    expect(positions.slice(-4)).toEqual([3, 3, 6, 8]);
    expectValidTriangulation(positions, indices, 100, 1e-12);
  });

  it('refines until every edge is at most maxLen', () => {
    const mesh = squareMesh(40, 4);
    mesh.refine(4, 1e6);
    const { positions, indices } = mesh.toTriangles();
    expect(maxEdge(positions, indices)).toBeLessThanOrEqual(4 * (1 + 1e-9));
    expectValidTriangulation(positions, indices, 1600, 1e-12);
  });

  it('stops refining at the vertex cap and stays a valid triangulation', () => {
    const mesh = squareMesh(40, 4);
    const start = mesh.toTriangles().positions.length / 2;
    mesh.refine(1, start + 25);
    const { positions, indices } = mesh.toTriangles();
    expect(positions.length / 2).toBe(start + 25);
    expect(maxEdge(positions, indices)).toBeGreaterThan(1);
    expectValidTriangulation(positions, indices, 1600, 1e-12);
  });
});
