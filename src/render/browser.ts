/**
 * Browser-safe render entry point: everything in ./index.ts except the node:zlib-based PNG codec.
 * Import this from the editor/web code.
 */
export { renderImage, type RenderOptions } from './raster.js';
export { drawOverlay, type OverlayLayer, type OverlayOptions, type OverlayScene } from './overlay.js';
export {
  drawText,
  drawLabel,
  measureText,
  measureLabel,
  glyphRows,
  GLYPH_WIDTH,
  GLYPH_HEIGHT,
  CELL_WIDTH,
  CELL_HEIGHT,
  type TextOptions,
  type LabelOptions,
} from './font.js';
export {
  Coverage,
  fillRect,
  strokeRect,
  drawLine,
  drawDashedLine,
  drawPolyline,
  drawCircle,
  type LineOptions,
  type PolylineOptions,
  type DashOptions,
  type CircleOptions,
} from './draw.js';
export {
  createImage,
  cloneImage,
  getPixel,
  blitImage,
  blendOver,
  cropImage,
  resizeNearest,
  resolveColor,
  toRGBA8,
  assertImage,
  type ColorInput,
  type PixelRect,
} from './image.js';
export { composeSheet, sheetSize, wrapCaption, CAPTION_MAX_LINES, SUBCAPTION_MAX_LINES, type SheetCell, type SheetOptions, type SheetSizeOptions } from './sheet.js';
export { diffImages, type DiffOptions, type DiffResult } from './diff.js';
export { encodeGIF, type GifOptions } from './gif.js';
