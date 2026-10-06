import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as image from '../index.js';
import { imageFrom } from './helpers.js';

const FUNCTIONS = [
  // types.ts
  'expandRect', 'unionRect', 'intersectRect', 'pixelRect', 'assertSize',
  // mask.ts
  'createMask', 'cloneMask', 'assertMask', 'assertSameSize', 'maskFromAlpha', 'maskToImage', 'maskToGray', 'alpha8',
  'maskUnion', 'maskIntersect', 'maskMultiply', 'maskSubtract', 'maskInvert', 'maskThreshold', 'maskBounds', 'maskArea',
  'maskCount', 'cropMask', 'pasteMask', 'sampleMask',
  // raster.ts
  'fillPolygon', 'polygonMask', 'ellipseMask', 'smoothstep', 'bandValue', 'bandMask', 'strokeMask',
  // distance.ts
  'distanceTransform', 'signedDistance', 'featherMask', 'dilateMask', 'erodeMask',
  // blur.ts
  'blurMask', 'blurImage', 'boxBlurMask', 'boxBlurImage',
  // components.ts
  'connectedComponents', 'keepLargestComponent', 'removeSmallComponents', 'fillHoles', 'growRegion',
  // color.ts
  'srgbToLinear', 'linearToSrgb', 'rgbToLab', 'labToRgb', 'deltaE', 'deltaERgb', 'imageToLab', 'writeLab', 'colorMatchMask',
  'colorStats', 'dominantColors',
  // inpaint.ts
  'inpaint', 'extendEdges',
  // compose.ts
  'applyMask', 'cutLayer', 'cropRect', 'pasteImage', 'compositeOver', 'alphaBounds', 'tintMask', 'resizeBilinear',
  'upscaleBilinear', 'resizeMaskBilinear', 'upscaleMask', 'resizeArea', 'downscaleArea', 'resizeMaskArea', 'downscaleMask',
  // polygon.ts
  'pointCount', 'polygonBounds', 'polygonArea', 'polygonCentroid', 'pointInPolygon', 'polylineLength', 'polylinePointAt',
  'resamplePolyline', 'closestOnPolyline', 'polygonEnvelope', 'simplifyPolyline', 'smoothPolyline', 'segmentsIntersect',
  'polygonSelfIntersects', 'ellipsePolygon', 'translatePoints',
  // random.ts
  'mulberry32', 'randomInt',
  // re-exported from src/render/image.ts
  'createImage', 'cloneImage', 'cropImage', 'getPixel',
];

describe('avatar image toolkit: public API', () => {
  it('exports every documented function from index.ts, and nothing undocumented', () => {
    const exported = image as Record<string, unknown>;
    for (const name of FUNCTIONS) expect(typeof exported[name], name).toBe('function');
    expect(Object.keys(exported).sort()).toEqual([...FUNCTIONS].sort());
  });

  it('stays browser-safe: no Node APIs and no PNG codec in the sources', () => {
    const files = ['types', 'mask', 'raster', 'distance', 'blur', 'components', 'color', 'inpaint', 'compose', 'polygon', 'random', 'index'];
    for (const file of files) {
      const text = readFileSync(new URL(`../${file}.ts`, import.meta.url), 'utf8');
      const imports = [...text.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
      for (const spec of imports) {
        expect(spec.startsWith('node:'), `${file}.ts imports ${spec}`).toBe(false);
        expect(/render\/(index|png)\.js$/.test(spec), `${file}.ts imports ${spec}`).toBe(false);
        expect(spec.startsWith('.'), `${file}.ts imports the package ${spec}`).toBe(true);
      }
      expect(/\b(Date\.now|Math\.random|process\.|require\()/.test(text), `${file}.ts uses a non-deterministic or Node API`).toBe(false);
    }
  });
});

describe('avatar image toolkit: the layer pipeline end to end', () => {
  // A small "illustration": a shaded body on a transparent background with a dark object on it.
  const source = imageFrom(72, 60, (x, y) => {
    const inside = ((x - 36) / 30) ** 2 + ((y - 34) / 24) ** 2 < 1;
    if (!inside) return [0, 0, 0, 0];
    const object = Math.abs(x - 40) < 7 && Math.abs(y - 30) < 5;
    return object ? [40, 30, 90] : [230 - x, 180 + y / 2, 160 + x / 3];
  });
  const outline = [31.5, 23.5, 48.5, 23.5, 48.5, 36.5, 31.5, 36.5];

  function build(): { texture: image.ImageRGBA; base: image.ImageRGBA; rect: image.Rect; layer: image.ImageRGBA } {
    const shape = image.polygonMask(source.width, source.height, outline);
    const { layer, rest, covered } = image.cutLayer(source, image.featherMask(shape, 2, 'outward'));
    const base = image.inpaint(rest, covered);
    const rect = image.pixelRect(image.polygonBounds(outline), 4, source.width, source.height);
    const texture = image.extendEdges(image.cropRect(layer, rect), 4);
    return { texture, base, rect, layer };
  }

  it('rest pose: the layer over the filled base is the illustration, pixel for pixel', () => {
    const { texture, base, rect } = build();
    const composed = image.cloneImage(base);
    image.compositeOver(composed, texture, rect.x, rect.y);
    let worst = 0;
    for (let i = 0; i < source.data.length; i += 4) {
      worst = Math.max(worst, Math.abs(composed.data[i + 3] - source.data[i + 3]));
      if (source.data[i + 3] === 0) continue;
      for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(composed.data[i + c] - source.data[i + c]));
    }
    expect(worst).toBe(0);
  });

  it('the base no longer shows the object: the fill continues the shading', () => {
    const { base } = build();
    for (let y = 26; y <= 34; y++) {
      for (let x = 34; x <= 46; x++) {
        const i = (y * source.width + x) * 4;
        expect(base.data[i + 3]).toBe(255);
        expect(Math.abs(base.data[i] - (230 - x))).toBeLessThan(5);
        expect(Math.abs(base.data[i + 1] - (180 + y / 2))).toBeLessThan(5);
        expect(Math.abs(base.data[i + 2] - (160 + x / 3))).toBeLessThan(5);
      }
    }
  });

  it('is deterministic: two builds are byte-identical', () => {
    const a = build();
    const b = build();
    expect(Array.from(a.texture.data)).toEqual(Array.from(b.texture.data));
    expect(Array.from(a.base.data)).toEqual(Array.from(b.base.data));
    expect(a.rect).toEqual(b.rect);
  });

  it('measures the object and the picture with the analysis helpers', () => {
    const lab = image.imageToLab(source);
    const object = image.growRegion(lab, [40, 30], { tolerance: 5 });
    expect(image.maskBounds(object)).toEqual({ x: 34, y: 26, width: 13, height: 9 });
    const parts = image.connectedComponents(image.maskFromAlpha(source));
    expect(parts.count).toBe(1);
    const tones = image.dominantColors(source, object, 2);
    expect(tones.length).toBe(1);
    expect(tones[0].rgb.map(Math.round)).toEqual([40, 30, 90]);
    const skin = image.colorStats(source, image.maskSubtract(image.maskFromAlpha(source), image.dilateMask(object, 1)))!;
    expect(skin.median[0]).toBeGreaterThan(150);
    expect(image.alphaBounds(source)).toEqual(image.maskBounds(image.maskFromAlpha(source)));
  });
});
