/**
 * Coordinate grid over the illustration: how an agent reads landmark coordinates off a picture.
 *
 *   avatarGrid(source)                       the whole image; a 1254 px image gets a line every 50 px
 *                                            and a label every 100 px
 *   avatarGrid(source, {region: [x0, y0, x1, y1]})   that rectangle magnified by a whole number so
 *                                            its long side is about 1000-1600 px, with a fine grid
 *                                            (5 or 10 px between lines for an eye-sized region)
 *
 * Labels are SOURCE pixel coordinates on all four sides; transparent pixels show a checkerboard;
 * every line is a dark and a light pixel side by side with the coordinate exactly between them.
 * The footer states the region, the magnification and the spacing, so the picture explains itself.
 */
import type { ImageRGBA } from '../../core/types.js';
import { createSourceView, drawFooterText, drawRulers, type SourceRegion } from './view.js';

export interface GridOptions {
  /** Source rectangle [x0, y0, x1, y1] to magnify (default: the whole image). */
  region?: readonly number[];
  /** Source px between grid lines (default: chosen from the magnification). */
  step?: number;
  /** Output px per source px, a whole number (default: chosen so the long side is about 1000-1600 px). */
  scale?: number;
}

export interface GridResult {
  image: ImageRGBA;
  /** Source rectangle shown (whole pixels, clipped to the image). */
  region: SourceRegion;
  /** Output px per source px. */
  scale: number;
  /** Source px between grid lines, and between labelled lines. */
  step: number;
  labelStep: number;
  /** Output pixel of the source point (region x0, y0). */
  origin: [number, number];
}

export function avatarGrid(source: ImageRGBA, options: GridOptions = {}): GridResult {
  const view = createSourceView(source, { region: options.region, scale: options.scale, footerLines: 1 });
  const { step, labelStep, strongStep } = drawRulers(view, { step: options.step });
  const [x0, y0, x1, y1] = view.region;
  const whole = x0 === 0 && y0 === 0 && x1 === source.width && y1 === source.height;
  drawFooterText(view, [
    whole ? `image ${source.width}x${source.height}` : `x ${x0}..${x1}, y ${y0}..${y1} of ${source.width}x${source.height}`,
    `x${view.scale}`,
    `line every ${step} px${strongStep > step ? `, strong every ${strongStep}` : ''}`,
    'source px, +y down',
  ]);
  return { image: view.image, region: view.region, scale: view.scale, step, labelStep, origin: view.origin };
}
