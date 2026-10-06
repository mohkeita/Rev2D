/**
 * Image processing for the avatar builder: pure TypeScript on ImageRGBA and Float32 masks.
 * No native dependencies, no Node APIs (browser-safe), deterministic: the same input gives the same
 * numbers and bytes.
 *
 * DATA
 * - ImageRGBA (src/core/types.ts): straight-alpha RGBA8, row-major, top-down.
 * - Mask: {width, height, data: Float32Array}, one coverage value 0..1 per pixel
 *   (`data[y * width + x]`). 0 = outside, 1 = inside, in between = soft / antialiased edge.
 *   Functions that need a yes / no answer read "inside" as value >= 0.5 unless they take a threshold.
 * - DistanceField: the same layout with distances in px.
 * - Points: flat lists [x0, y0, x1, y1, ...]. Pixel (x, y) covers [x, x+1) x [y, y+1), centre at +0.5.
 * - Rect: {x, y, width, height}. Colours: RGB = [r, g, b] in 0..255 (sRGB), Lab = [L, a, b].
 * - Angles are degrees, clockwise-positive on screen (+y is down), as everywhere in Rev2D.
 * Functions return new images / masks and leave their inputs alone, except the few marked
 * "IN PLACE" (fillPolygon, pasteMask, pasteImage, compositeOver).
 *
 * API BY TASK (each file's header explains the method)
 *
 * types.ts      Mask, DistanceField, Rect, Points, RGB, Lab;
 *               expandRect, unionRect, intersectRect, pixelRect (polygon bounds -> crop rectangle),
 *               assertSize
 * mask.ts       createMask, cloneMask, maskFromAlpha, maskToImage (colour + alpha = mask), maskToGray,
 *               maskUnion, maskIntersect, maskSubtract, maskMultiply, maskInvert, maskThreshold,
 *               maskBounds, maskArea (sum), maskCount, cropMask, pasteMask, sampleMask (bilinear, for
 *               lattice points), alpha8, assertMask, assertSameSize
 * raster.ts     polygonMask / fillPolygon (exact area coverage, any winding, concave), ellipseMask
 *               (rotated), bandMask + bandValue (full above yStart, smoothstep to 0 at yEnd),
 *               strokeMask (radius around a polyline), smoothstep
 * distance.ts   distanceTransform (exact, binary, Felzenszwalb), signedDistance (sub-pixel, to the
 *               0.5 level, negative inside), featherMask (inward / outward / centered), dilateMask,
 *               erodeMask
 * blur.ts       blurMask, blurImage (Gaussian; RGBA premultiplied), boxBlurMask, boxBlurImage
 * components.ts connectedComponents (labels, areas, bounds), keepLargestComponent,
 *               removeSmallComponents, fillHoles, growRegion (seeds + colour tolerance + limit mask)
 * color.ts      srgbToLinear, linearToSrgb, rgbToLab, labToRgb, deltaE, deltaERgb, imageToLab (+ writeLab
 *               for one pixel), colorMatchMask, colorStats (mean, median, trimmed mean, std under a
 *               mask), dominantColors (seeded k-means in Lab)
 * inpaint.ts    inpaint (smooth membrane fill of a hole, alpha-aware), extendEdges (colour bleed into
 *               transparent neighbours, alpha unchanged)
 * compose.ts    applyMask (mask -> alpha), cutLayer (layer + rest + covered: layer over rest = image),
 *               cropRect, pasteImage, compositeOver, alphaBounds, tintMask,
 *               resizeBilinear / upscaleBilinear, resizeArea / downscaleArea, and the mask versions
 *               resizeMaskBilinear / upscaleMask, resizeMaskArea / downscaleMask
 * polygon.ts    pointCount, polygonBounds, polygonArea (signed: > 0 = clockwise on screen),
 *               polygonCentroid, pointInPolygon, polylineLength, polylinePointAt, resamplePolyline,
 *               closestOnPolyline (distance + projection parameter), polygonEnvelope (upper / lower
 *               boundary curves at N x positions), simplifyPolyline, smoothPolyline (corner cutting),
 *               polygonSelfIntersects, segmentsIntersect, ellipsePolygon, translatePoints
 * random.ts     mulberry32 (seeded PRNG), randomInt
 * Also re-exported from src/render/image.ts: createImage, cloneImage, cropImage, getPixel.
 *
 * TYPICAL USE (cut an object into its own layer and fill what it hid)
 *
 *   const shape = polygonMask(src.width, src.height, outline);          // antialiased, a little outside the object
 *   const { layer, rest, covered } = cutLayer(src, featherMask(shape, 2, 'outward'));
 *   const base = inpaint(rest, covered);                                // the picture behind the object
 *   const rect = pixelRect(polygonBounds(outline), 4, src.width, src.height);
 *   const texture = extendEdges(cropRect(layer, rect), 4);              // LayerInfo.rect = [rect.x, rect.y, rect.width, rect.height]
 *
 * `layer` drawn over `base` is the source again (see cutLayer), so the rest pose of the rig equals
 * the illustration; when the layer moves, `base` shows the smooth fill. To keep unwanted colours out
 * of a fill (lashes and hair around an eye region), pass inpaint a `sources` mask, e.g.
 * colorMatchMask(lab, [skinLab], 10, 6). A hair mask: strokeMask along the strands as seeds,
 * dominantColors under the seeds as references, growRegion inside the head ellipse, then
 * removeSmallComponents / fillHoles / featherMask.
 *
 * PERFORMANCE: measured on one 1254 x 1254 RGBA image (Node 22, one thread, best of 7), every
 * operation finishes in well under half a second. Whole-image passes: polygon / ellipse / stroke
 * rasterisation 2-8 ms, boolean ops, bounds and area 1-12 ms, distanceTransform 20 ms,
 * signedDistance 65 ms, full-image feather / dilate / erode 50-120 ms, blurMask 30-120 ms, blurImage
 * 290-420 ms, box blurs 30 / 160 ms, connectedComponents / keepLargestComponent / fillHoles 55-65 ms,
 * imageToLab 100 ms, growRegion 15-25 ms, colorMatchMask 15 ms, colorStats 9 ms, dominantColors
 * 30 ms, extendEdges 55 ms, cutLayer 17 ms, downscaleArea 50-65 ms, upscaleBilinear x1.5 130 ms. The
 * distance-based operations and inpaint only work on the window around the shape: an eye-sized
 * shape costs about 4 ms to feather or dilate, a 200 x 120 px hole 56 ms to inpaint, a 500 x 400 px
 * hole about 350 ms.
 */
export * from './types.js';
export * from './mask.js';
export * from './raster.js';
export * from './distance.js';
export * from './blur.js';
export * from './components.js';
export * from './color.js';
export * from './inpaint.js';
export * from './compose.js';
export * from './polygon.js';
export * from './random.js';
export { createImage, cloneImage, cropImage, getPixel } from '../../render/image.js';
