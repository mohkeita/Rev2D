/**
 * Spine interop: import Spine skeleton JSON + atlas into Rev2D, export Rev2D models as Spine JSON +
 * atlas + PNG pages (vector parts rasterized, parameter/warp deformation baked into timelines).
 * OWNER: spine agents.
 *
 * Shared building blocks (used by the importer and the exporter):
 *   types.ts      Spine skeleton JSON shapes (3.8 - 4.2)
 *   atlas.ts      .atlas reader / writer (4.x and legacy dialects), region <-> page mapping
 *   curves.ts     Spine curves <-> Rev2D eases
 *   transform.ts  Spine setup-pose world transforms, Spine <-> Rev2D coordinate mapping
 *   util.ts       ids, colors, report builder
 *
 * Exporter (export.ts is the driver; its header lists the conversion choices):
 *   export-parts.ts   part states, reference (largest) state, meshes, clipping polygons, vertex plans
 *   export-mesh.ts    per-part rasterization and the mesh covering it (fill + edge ring / stroke bands)
 *   export-morph.ts   maps of fixed points through shape animation (affine, nine-slice, control points)
 *   export-bones.ts   Spine bone table incl. warp lattice bones (exact bilinear warps via skinning)
 *   export-mask.ts    alpha contour tracing for clipping polygons
 *   export-anim.ts    sampled frames -> Spine timelines
 *   export-json.ts    rounding, JSON writer, skeleton hash
 *   bake.ts           frame sampling (Player, key times, adaptive refinement), part deformers
 *   bake-reduce.ts    key reduction with linear / Bézier segments
 *   pack.ts           MaxRects atlas packing, pages, premultiplication, alpha bleeding
 */
export { importSpine } from './import.js';
export { exportSpine } from './export.js';
// Shared helpers as namespaces (src/interop/index.ts re-exports several converters with `export *`,
// so generic names such as evalBezier must not leak into the flat namespace).
export * as spineAtlas from './atlas.js';
export * as spineCurves from './curves.js';
export * as spineTransform from './transform.js';
export type * from './types.js';
