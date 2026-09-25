/**
 * Geometry compiler: shape + paint -> triangle meshes in SETUP space (before deformation).
 * OWNER: geometry agent. Contract is fixed; the implementation lives in sibling files:
 *   compile.ts      compileGeometry (per-shape dispatch, fill / stroke batches)
 *   shapes.ts       ellipse / rect outlines, image grids, raw meshes and their boundary loops
 *   flatten.ts      SVG path flattening
 *   triangulate.ts  ear clipping + `detail` refinement (with trimesh.ts, a half-edge Delaunay mesh)
 *   stroke.ts       stroke tessellation (align, joins, caps)
 *   paint.ts        solid / gradient fills per vertex
 *   weights.ts      automatic skin weights
 */
export { compileGeometry, type GeometryContext } from './compile.js';
export { computeAutoWeights, type BoneSegment } from './weights.js';
export { GeometryError } from './errors.js';
export { flattenPath, type FlatSubpath } from './flatten.js';
