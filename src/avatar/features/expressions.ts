/** Acting face patches and discrete glove drawings, with mesh fallbacks. Browser-safe. */
import { triangulatePolygon } from '../../core/geometry/triangulate.js';
import { AVATAR_Z } from '../builder.js';
import { polygonBounds } from '../image/polygon.js';
import { gaussianWeight } from '../fields.js';
import { VARIANTS } from '../variants-areas.js';
import { shownSprites, type SpriteRecord } from '../variants-sprites.js';
import { EYE_LAYERS_UNDER_SPRITES } from './sprites.js';
import { faceSkinColor, hexColor } from './eyes-matte.js';
import { BROW_Z } from './brows.js';
import type { AvatarFeature, CompileContext } from './types.js';

function patch(
  ctx: CompileContext,
  record: SpriteRecord,
  key: string,
  z: number,
  parent = ctx.root.id,
): string | undefined {
  const info = record.layers.find((l) => l.key === key),
    layer = info && ctx.layer(info.id);
  if (!layer) return;
  if (key === 'hand' && info?.outline?.length) {
    const mesh = triangulatePolygon(info.outline),
      vertices = Array.from(mesh.positions),
      uvs = vertices.map((v, i) => (v - layer.rect[i % 2]) / (i % 2 ? layer.rect[3] : layer.rect[2]));
    return ctx.model.part({
      id: layer.id,
      parent,
      z,
      opacity: 0,
      shape: {
        type: 'mesh',
        texture: ctx.model.texture(layer),
        vertices,
        uvs,
        triangles: Array.from(mesh.indices),
      },
      description: `Rigid glove drawing ${record.id}.`,
    });
  }
  return ctx.model.imagePart(layer, {
    parent,
    z,
    opacity: 0,
    cell: Math.max(2, ctx.metrics.cell.body / 2),
    description: `Acting drawing ${record.id}.`,
  });
}
function discrete(ctx: CompileContext, id: string, param: string, form: number, max: number): void {
  ctx.model.bind({
    id: id + 'ActingShow',
    target: `part:${id}.opacity`,
    params: [param],
    interpolation: 'step',
    keys: Array.from({ length: max + 1 }, (_, v) => ({ at: [v], value: v === form ? 1 : 0 })),
  });
}
function hideDiscrete(ctx: CompileContext, id: string, param: string, forms: Set<number>, max: number): void {
  const part = ctx.model.findPart(id);
  if (!part) return;
  const rest = part.opacity ?? 1;
  ctx.model.bind({
    id: id + 'ActingHide',
    target: `part:${id}.opacity`,
    params: [param],
    interpolation: 'step',
    keys: Array.from({ length: max + 1 }, (_, v) => ({ at: [v], value: forms.has(v) ? 0 : rest })),
  });
}
function fallbackMouth(ctx: CompileContext, param: string, forms: Set<number>): void {
  const {
    center: [cx, cy],
    radius: [rx, ry],
  } = ctx.spec.face.mouth.area;
  const skin = ctx.featureMeta<{ skin: string }>('expressions')?.skin ?? '#fff';
  const missing = new Set([1, 2, 3, 4].filter((form) => !forms.has(form)));
  if (!missing.size) return;
  const id = 'expressionMouthCover';
  ctx.model.part({
    id,
    parent: ctx.root.id,
    z: AVATAR_Z.mouthSprites + 3,
    opacity: 0,
    shape: { type: 'ellipse', cx, cy, rx: rx * 1.05, ry: ry * 1.05, detail: Math.max(2, rx / 12) },
    fill: skin,
    description: 'Analytic fallback mouth cover; drawn expression patches are preferred.',
  });
  ctx.model.bind({
    id: id + 'Show',
    target: `part:${id}.opacity`,
    params: [param],
    interpolation: 'step',
    keys: [0, 1, 2, 3, 4].map((v) => ({ at: [v], value: missing.has(v) ? 1 : 0 })),
  });
  for (const form of missing) {
    const mouth = 'expressionMouth' + form,
      z = AVATAR_Z.mouthSprites + 4;
    if (form <= 2)
      ctx.model.part({
        id: mouth,
        parent: ctx.root.id,
        z,
        opacity: 0,
        shape: {
          type: 'ellipse',
          cx,
          cy,
          rx: rx * (form === 1 ? 0.34 : 0.72),
          ry: ry * (form === 1 ? 0.75 : 0.55),
          detail: Math.max(2, rx / 12),
        },
        fill: '#24191b',
      });
    else
      ctx.model.part({
        id: mouth,
        parent: ctx.root.id,
        z,
        opacity: 0,
        shape: {
          type: 'path',
          d: `M ${cx - rx * 0.7} ${cy} Q ${cx} ${cy + (form === 3 ? -1 : 1) * ry} ${cx + rx * 0.7} ${cy}`,
        },
        fill: 'transparent',
        stroke: { color: '#24191b', width: Math.max(2, rx * 0.065) },
      });
    discrete(ctx, mouth, param, form, 4);
    forms.add(form);
    if (form === 2) {
      const teeth = mouth + 'Teeth';
      ctx.model.part({
        id: teeth,
        parent: ctx.root.id,
        z: z + 1,
        opacity: 0,
        shape: { type: 'ellipse', cx, cy: cy - ry * 0.12, rx: rx * 0.58, ry: ry * 0.22 },
        fill: '#fff',
      });
      discrete(ctx, teeth, param, form, 4);
    }
  }
}

export const expressions: AvatarFeature = {
  id: 'expressions',
  summary: 'wide eyes, facial expression patches and discrete gloves on wrist bones',
  layers(ctx) {
    if (ctx.spec.framing === 'full')
      ctx.setMeta('expressions', { skin: hexColor(faceSkinColor(ctx.source, ctx.spec)) });
  },
  compile(ctx) {
    const wide = shownSprites(ctx.meta, 'eyes').find((s) => s.id === 'eyes_wide');
    if (ctx.spec.framing === 'full' || wide) {
      const param = ctx.model.parameter('EyeWide');
      if (!wide) {
        const regions = Object.values(ctx.spec.face.eyes).map((e) => polygonBounds(e.region));
        const fields = regions.map((r) => {
          const cx = r.x + r.width / 2,
            cy = r.y + r.height / 2,
            weight = gaussianWeight([cx, cy], r.width * 0.6);
          return (x: number, y: number): [number, number] => [0, (y - cy) * 0.12 * weight(x, y)];
        });
        ctx.model.bindField(ctx.root, {
          id: 'eyesWideFallback',
          params: [param],
          keys: [
            { at: [0] },
            {
              at: [1],
              field: (x, y) => {
                const ds = fields.map((f) => f(x, y));
                return [0, ds.reduce((s, p) => s + p[1], 0)];
              },
            },
          ],
        });
      } else
        for (const side of ['imageLeft', 'imageRight'] as const) {
          const eye = side === 'imageLeft' ? 'eyeR' : 'eyeL',
            open = ctx.model.parameter(side === 'imageLeft' ? 'EyeROpen' : 'EyeLOpen');
          const id = patch(ctx, wide, side, AVATAR_Z.eyeSprites + 0.5);
          if (!id) continue;
          const keys = [0, 1].flatMap((w) =>
            [0, 0.7, 1].map((o) => ({ at: [w, o], value: w * Math.max(0, (o - 0.7) / 0.3) })),
          );
          ctx.model.bind({
            id: id + 'ActingShow',
            target: `part:${id}.opacity`,
            params: [param, open],
            keys,
          });
          for (const name of EYE_LAYERS_UNDER_SPRITES) {
            const part = ctx.model.findPart(`${eye}_${name}`);
            if (part)
              ctx.model.bind({
                id: part.id + 'WideHide',
                target: `part:${part.id}.opacity`,
                params: [param, open],
                keys: keys.map((k) => ({ ...k, value: (part.opacity ?? 1) - k.value })),
              });
          }
        }
    }
    const mouths = shownSprites(ctx.meta, 'mouth').filter((s) => VARIANTS[s.id].expression !== undefined);
    if (mouths.length || ctx.spec.framing === 'full') {
      const param = ctx.model.parameter('MouthShape'),
        forms = new Set<number>();
      for (const record of mouths) {
        const form = VARIANTS[record.id].expression!,
          id = patch(ctx, record, 'mouth', AVATAR_Z.mouthSprites + 3);
        if (id) {
          discrete(ctx, id, param, form, 4);
          forms.add(form);
        }
      }
      if (ctx.spec.framing === 'full') fallbackMouth(ctx, param, forms);
      // The expression patch is opaque over its region; hide the independent opening layers too.
      for (const id of [
        'mouth',
        'mouthInner',
        'mouthTongue',
        ...shownSprites(ctx.meta, 'mouth')
          .filter((s) => VARIANTS[s.id].mouth)
          .flatMap((s) => s.layers.map((l) => l.id)),
      ])
        hideDiscrete(ctx, id, param, forms, 4);
    }
    for (const side of ['R', 'L'] as const) {
      const arm = ctx.spec.arms?.find((a) => a.id === 'arm' + side);
      if (!arm || !ctx.model.hasPart('arm' + side + 'HandImage')) continue;
      const records = shownSprites(ctx.meta, side === 'R' ? 'handR' : 'handL');
      if (!records.length) continue;
      const param = ctx.model.parameter(side === 'R' ? 'HandRForm' : 'HandLForm'),
        forms = new Set<number>();
      for (const record of records) {
        const form = VARIANTS[record.id].handForm!,
          id = patch(
            ctx,
            record,
            'hand',
            (arm.front ? AVATAR_Z.arms : AVATAR_Z.armsBack) + 2,
            'arm' + side + 'Hand',
          );
        if (id) {
          discrete(ctx, id, param, form, 7);
          forms.add(form);
        }
      }
      hideDiscrete(ctx, 'arm' + side + 'HandImage', param, forms, 7);
    }
    for (const record of shownSprites(ctx.meta, 'brows'))
      for (const side of ['imageLeft', 'imageRight'] as const) {
        const param = ctx.model.parameter(side === 'imageLeft' ? 'BrowRY' : 'BrowLY'),
          id = patch(ctx, record, side, BROW_Z + 1);
        if (!id) continue;
        const worried = record.id === 'brows_worried',
          keys = [-1, -0.7, 0, 0.5, 1].map((v) => ({
            at: [v],
            value: worried ? Math.max(0, Math.min(1, v / 0.5)) : Math.max(0, Math.min(1, -v / 0.7)),
          }));
        ctx.model.bind({ id: id + 'ActingShow', target: `part:${id}.opacity`, params: [param], keys });
        const original = ctx.model.findPart(side === 'imageLeft' ? 'browR' : 'browL');
        if (original)
          ctx.model.bind({
            id: original.id + 'Under' + record.id,
            target: `part:${original.id}.opacity`,
            params: [param],
            keys: keys.map((k) => ({ ...k, value: (original.opacity ?? 1) - k.value })),
          });
      }
  },
  poses(ctx) {
    return ctx.spec.framing === 'full'
      ? [{ id: 'eyes_wide', label: 'surprised eyes', params: { EyeWide: 1 }, zoom: 'eyes' }]
      : [];
  },
};
