/**
 * Stage 1 of the avatar build: the illustration -> layer images + LayersMeta (DESIGN.md §2).
 *
 * The base layer starts as a copy of the source; the feature modules (./features/) then cut their
 * moving layers out of it and fill what those hide. The result of this stage is everything stage 2
 * (compileAvatar) needs besides the spec: it never sees pixels.
 *
 *   images   "textures/<layerId>.png" -> ImageRGBA      ("textures/base.png" first)
 *   meta     LayersMeta: inputsHash, the layer list, accepted variants, plus one entry per feature
 *            that stored metadata (meta.eyes, meta.hair, ...)
 *
 * Pure and deterministic: the same spec and pixels give the same images and metadata.
 */
import type { ImageRGBA } from '../core/types.js';
import { cloneImage } from '../render/image.js';
import { AVATAR_FEATURES } from './features/index.js';
import { createReportSink } from './features/report.js';
import type { AvatarFeature, LayersContext } from './features/types.js';
import { avatarMetrics, type RectTuple } from './fields.js';
import { layerInputsHash } from './hash.js';
import { imageToLab, type LabImage } from './image/color.js';
import { createMask, pasteMask } from './image/mask.js';
import type { Mask } from './image/types.js';
import type { AvatarSpec, BuildLayersResult, LayerInfo, LayersMeta } from './types.js';

/** Id of the base layer (and of its texture and part in the model). */
export const BASE_LAYER = 'base';

/** Keys of LayersMeta that a feature's metadata must not replace. */
const RESERVED_META = ['version', 'inputsHash', 'image', 'layers', 'variants'];

/** File of a layer image inside the project folder. */
export function layerFile(id: string): string {
  return `textures/${id}.png`;
}

/** buildAvatarLayers with an explicit feature list (tests build with a subset). */
export function buildLayers(spec: AvatarSpec, source: ImageRGBA, previous: LayersMeta | undefined, features: readonly AvatarFeature[] = AVATAR_FEATURES): BuildLayersResult {
  const { width, height } = spec.image;
  if (source.width !== width || source.height !== height) {
    throw new RangeError(`buildAvatarLayers: the spec is for a ${width}x${height} image, but the source is ${source.width}x${source.height}`);
  }
  const report = createReportSink();
  const images: Record<string, ImageRGBA> = {};
  const layers: LayerInfo[] = [];
  const variants: string[] = [];
  const extra: Record<string, unknown> = {};
  let lab: LabImage | null = null;
  let claimed: Mask | null = null;

  const ctx: LayersContext = {
    spec,
    metrics: avatarMetrics(spec),
    source,
    base: cloneImage(source),
    previous,
    sourceLab: () => (lab ??= imageToLab(source)),
    addLayer(id, image, rect) {
      if (id === BASE_LAYER || layers.some((l) => l.id === id)) throw new Error(`buildAvatarLayers: the layer id "${id}" is used twice`);
      if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(id)) throw new Error(`buildAvatarLayers: "${id}" is not a valid layer id`);
      if (!rect.every(Number.isInteger) || rect[2] !== image.width || rect[3] !== image.height) {
        throw new Error(`buildAvatarLayers: layer "${id}" is ${image.width}x${image.height} but its rect is [${rect.join(', ')}] (whole pixels, the image's own size)`);
      }
      const info: LayerInfo = { id, file: layerFile(id), rect: [rect[0], rect[1], rect[2], rect[3]] };
      layers.push(info);
      images[info.file] = image;
      return info;
    },
    setMeta(key, value) {
      if (RESERVED_META.includes(key)) throw new Error(`buildAvatarLayers: "${key}" is a reserved key of layers.json`);
      extra[key] = value;
    },
    get claimed() {
      return (claimed ??= createMask(width, height));
    },
    claim(mask, x = 0, y = 0) {
      if (!Number.isInteger(x) || !Number.isInteger(y)) throw new Error(`buildAvatarLayers: a claimed mask sits on whole pixels, got (${x}, ${y})`);
      pasteMask((claimed ??= createMask(width, height)), mask, x, y, 'max');
    },
    addVariant(id) {
      if (!variants.includes(id)) variants.push(id);
    },
    report,
  };

  for (const feature of features) feature.layers?.(ctx);

  if (ctx.base.width !== width || ctx.base.height !== height) throw new Error('buildAvatarLayers: a feature changed the size of the base layer');
  const baseRect: RectTuple = [0, 0, width, height];
  if(spec.framing==='full'){let x0=width,y0=height,x1=0,y1=0;for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(ctx.base.data[(y*width+x)*4+3]){x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x+1);y1=Math.max(y1,y+1);}if(x1>x0)extra.fullBaseBounds=[x0,y0,x1,y1];}
  const base: LayerInfo = { id: BASE_LAYER, file: layerFile(BASE_LAYER), rect: baseRect };
  const meta: LayersMeta = { version: 1, inputsHash: layerInputsHash(spec), image: { width, height }, layers: [base, ...layers], variants, ...extra };
  report.stat('layers', meta.layers.length);
  return { images: { [base.file]: ctx.base, ...images }, meta, report: { issues: report.issues, stats: report.stats } };
}
