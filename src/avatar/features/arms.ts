/** Authored arm cuts, rigid sleeve/forearm skinning and connected gloves. No inferred landmarks. */
import type { ImageRGBA } from '../../core/types.js';
import type { AvatarSpec, LayerInfo } from '../types.js';
import type { AvatarFeature, CompileContext, LayersContext } from './types.js';
import { AVATAR_Z } from '../builder.js';
import { createMask, maskBounds } from '../image/mask.js';
import { cutLayer, cropRect } from '../image/compose.js';
import { inpaint, extendEdges } from '../image/inpaint.js';
import { pixelHull } from '../image/hull.js';
import { dilateMask } from '../image/distance.js';
import { polygonMask } from '../image/raster.js';
import { pointInPolygon } from '../image/polygon.js';
import { bodySwayField, breathField, bodyBounceField } from './body.js';
import { triangulatePolygon } from '../../core/geometry/triangulate.js';
import type { Field } from '../fields.js';

export type AuthoredArm = NonNullable<AvatarSpec['arms']>[number];
interface ArmMeta {
  arm: string;
  hand: string;
  joint?: { radius: number; color: string };
  handOutline?: number[];
}
export interface ArmsMeta {
  cuts: Record<string, ArmMeta>;
}
const distance = (p: readonly number[], a: readonly number[], b: readonly number[]) => {
  const dx = b[0] - a[0],
    dy = b[1] - a[1],
    u = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p[0] - a[0] - u * dx, p[1] - a[1] - u * dy);
};
function torsoPolygon(spec: AvatarSpec): number[] {
  const arms = spec.arms ?? [],
    hips = spec.legs?.hips ?? [
      spec.body.chest.center[0],
      spec.body.chest.center[1] + spec.body.chest.radius[1] * 1.4,
    ];
  const shoulders = arms.map((a) => a.shoulder),
    left =
      shoulders.length > 1
        ? Math.min(...shoulders.map((p) => p[0]))
        : spec.body.chest.center[0] - spec.body.chest.radius[0],
    right =
      shoulders.length > 1
        ? Math.max(...shoulders.map((p) => p[0]))
        : spec.body.chest.center[0] + spec.body.chest.radius[0];
  const top = Math.min(...shoulders.map((p) => p[1]), spec.body.chest.center[1] - spec.body.chest.radius[1]),
    half = (right - left) * 0.44;
  return [left, top, right, top, hips[0] + half, hips[1], hips[0] - half, hips[1]];
}
function addCrop(
  ctx: LayersContext,
  id: string,
  image: ReturnType<typeof cutLayer>['layer'],
  mask: ReturnType<typeof createMask>,
): void {
  const alpha = createMask(image.width, image.height);
  for (let i = 0; i < alpha.data.length; i++) alpha.data[i] = image.data[i * 4 + 3] / 255;
  const bounds = maskBounds(alpha);
  if (!bounds) return;
  const x = Math.max(0, Math.floor(bounds.x) - 2),
    y = Math.max(0, Math.floor(bounds.y) - 2),
    w = Math.min(ctx.source.width - x, Math.ceil(bounds.width) + 4),
    h = Math.min(ctx.source.height - y, Math.ceil(bounds.height) + 4);
  ctx.addLayer(id, extendEdges(cropRect(image, { x, y, width: w, height: h }), 2), [x, y, w, h]);
}
const inkColor = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
function forearmInk(source: ImageRGBA, arm: AuthoredArm) {
  const { width, height } = source,
    dx = arm.wrist[0] - arm.elbow[0],
    dy = arm.wrist[1] - arm.elbow[1],
    length = Math.hypot(dx, dy),
    nx = -dy / length,
    ny = dx / length;
  const px = arm.elbow[0] + dx * 0.45,
    py = arm.elbow[1] + dy * 0.45,
    max = Math.ceil(arm.width[1] * 0.65),
    occupied: number[] = [];
  for (let n = -max; n <= max; n++) {
    const x = Math.round(px + nx * n),
      y = Math.round(py + ny * n);
    if (x >= 0 && y >= 0 && x < width && y < height && source.data[(y * width + x) * 4 + 3] > 128)
      occupied.push(n);
  }
  const nearest = occupied.reduce((best, n) => (Math.abs(n) < Math.abs(best) ? n : best), occupied[0] ?? 0),
    sx = Math.max(0, Math.min(width - 1, Math.round(px + nx * nearest))),
    sy = Math.max(0, Math.min(height - 1, Math.round(py + ny * nearest))),
    sample = (sy * width + sx) * 4;
  const rgb = Array.from(source.data.slice(sample, sample + 3)),
    color = '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join(''),
    radius = occupied.length
      ? Math.min(arm.width[1] / 2, (occupied.at(-1)! - occupied[0] + 1) / 2)
      : arm.width[1] / 3;
  return { rgb, color, radius: Math.max(2, radius) };
}
function cutArms(ctx: LayersContext): void {
  const cuts: ArmsMeta['cuts'] = {},
    torso = torsoPolygon(ctx.spec),
    { width, height } = ctx.source;
  for (const arm of ctx.spec.arms ?? []) {
    const ink = forearmInk(ctx.source, arm),
      dx = arm.wrist[0] - arm.elbow[0],
      dy = arm.wrist[1] - arm.elbow[1],
      length2 = dx * dx + dy * dy;
    const handOutlineMask = arm.hand.outline
      ? dilateMask(
          polygonMask(width, height, arm.hand.outline),
          Math.max(1, Math.min(4, arm.hand.radius * 0.05)),
        )
      : undefined;
    const armMask = createMask(width, height),
      handMask = createMask(width, height),
      whole = createMask(width, height);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const p = [x + 0.5, y + 0.5],
          hand = handOutlineMask
            ? handOutlineMask.data[y * width + x] > 0
            : Math.hypot(p[0] - arm.hand.center[0], p[1] - arm.hand.center[1]) <= arm.hand.radius + 2;
        const body = arm.outline
          ? pointInPolygon(arm.outline, ...(p as [number, number]))
          : distance(p, arm.shoulder, arm.elbow) <= arm.width[0] / 2 + 2 ||
            distance(p, arm.elbow, arm.wrist) <= arm.width[1] / 2 + 2;
        const i = y * width + x;
        if (hand) {
          handMask.data[i] = 1;
          whole.data[i] = 1;
        } else if (body) {
          armMask.data[i] = 1;
          whole.data[i] = 1;
        }
      }
    const armTextureMask = dilateMask(armMask, 4);
    for (let i = 0; i < armTextureMask.data.length; i++)
      if (handMask.data[i] > 0 || (armMask.data[i] === 0 && ctx.base.data[i * 4 + 3] < 254))
        armTextureMask.data[i] = 0;
    const cut = cutLayer(ctx.base, whole),
      a = cutLayer(ctx.base, armTextureMask),
      h = cutLayer(ctx.base, handMask);
    // Locate the contrasting glove/cuff. Keep its outline, but remove the forearm stub from the glove.
    let gloveStart = 0,
      foundGlove = false;
    const foreLength = Math.sqrt(length2);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = y * width + x,
          j = i * 4;
        if (!handMask.data[i] || ctx.source.data[j + 3] < 128) continue;
        const r = ctx.source.data[j],
          g = ctx.source.data[j + 1],
          b = ctx.source.data[j + 2];
        if (Math.max(r, g, b) < 60 || Math.hypot(r - ink.rgb[0], g - ink.rgb[1], b - ink.rgb[2]) < 40)
          continue;
        const at = ((x + 0.5 - arm.wrist[0]) * dx + (y + 0.5 - arm.wrist[1]) * dy) / foreLength;
        if (!foundGlove || at < gloveStart) {
          gloveStart = at;
          foundGlove = true;
        }
      }
    const cutoff = foundGlove ? gloveStart - 2 : -arm.hand.radius * 0.3;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        if (
          h.layer.data[(y * width + x) * 4 + 3] &&
          ((x + 0.5 - arm.wrist[0]) * dx + (y + 0.5 - arm.wrist[1]) * dy) / foreLength < cutoff
        )
          h.layer.data[(y * width + x) * 4 + 3] = 0;
    const fill = createMask(width, height);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (cut.covered.data[i] && pointInPolygon(torso, x + 0.5, y + 0.5)) fill.data[i] = 1;
      }
    ctx.base = inpaint(cut.rest, fill, { alpha: 'opaque' });
    const armId = arm.id + 'Layer',
      handId = arm.id + 'HandLayer';
    addCrop(ctx, armId, a.layer, armMask);
    addCrop(ctx, handId, h.layer, handMask);
    ctx.claim(whole);
    cuts[arm.id] = {
      arm: armId,
      hand: handId,
      joint: { radius: ink.radius, color: ink.color },
      handOutline: pixelHull(h.layer, 0, 0),
    };
  }
  if (Object.keys(cuts).length) ctx.setMeta('arms', { cuts } satisfies ArmsMeta);
}
function followBody(ctx: CompileContext, root: string, arm: AuthoredArm): void {
  const drives: { id: string; keys: { v: number; field?: Field }[] }[] = [
    {
      id: 'BodyAngleX',
      keys: [-10, 0, 10].map((v) => ({ v, field: bodySwayField(ctx.spec, (v / 10) * ctx.metrics.sway) })),
    },
    { id: 'Breath', keys: [{ v: 0 }, { v: 1, field: breathField(ctx.spec, ctx.metrics) }] },
  ];
  if (ctx.spec.framing === 'full')
    drives.push(
      {
        id: 'BodyAngleZ',
        keys: [-15, -7.5, 0, 7.5, 15].map((v) => ({ v, field: bodySwayField(ctx.spec, v) })),
      },
      { id: 'BodyY', keys: [-8, 0, 8].map((v) => ({ v, field: bodyBounceField(ctx.spec, v) })) },
    );
  for (const drive of drives) {
    if (!ctx.model.hasParameter(drive.id)) continue;
    for (const prop of ['x', 'y', 'rotation'] as const) {
      const values = drive.keys.map((key) => {
        const [x, y] = arm.shoulder,
          delta = key.field?.(x, y) ?? [0, 0],
          near = key.field?.(x + 1, y) ?? [0, 0];
        return {
          at: [key.v],
          value:
            prop === 'x'
              ? x + delta[0]
              : prop === 'y'
                ? y + delta[1]
                : (Math.atan2(near[1] - delta[1], 1 + near[0] - delta[0]) * 180) / Math.PI,
        };
      });
      const setup = prop === 'x' ? arm.shoulder[0] : prop === 'y' ? arm.shoulder[1] : 0;
      if (values.every((k) => Math.abs(k.value - setup) < 1e-9)) continue;
      ctx.model.bind({
        id: root + '_' + drive.id + '_' + prop,
        target: `bone:${root}.${prop}`,
        params: [drive.id],
        keys: values,
      });
    }
  }
}
/** Independent rigid sections preserve drawn cuffs and thin forearms when the elbow bends. */
function section(
  a: readonly number[],
  b: readonly number[],
  width: number,
  layer: LayerInfo,
  before: number,
  after: number,
) {
  const angle = Math.atan2(b[1] - a[1], b[0] - a[0]),
    ux = Math.cos(angle),
    uy = Math.sin(angle),
    r = width / 2 + 3;
  const start = [a[0] - ux * before, a[1] - uy * before],
    end = [b[0] + ux * after, b[1] + uy * after];
  const vertices = [
    start[0] - uy * r,
    start[1] + ux * r,
    start[0] + uy * r,
    start[1] - ux * r,
    end[0] - uy * r,
    end[1] + ux * r,
    end[0] + uy * r,
    end[1] - ux * r,
  ];
  const [x, y, w, h] = layer.rect,
    uvs = vertices.map((v, i) => (v - (i % 2 ? y : x)) / (i % 2 ? h : w));
  return { vertices, uvs, triangles: [0, 1, 2, 1, 3, 2] };
}
export const arms: AvatarFeature = {
  id: 'arms',
  summary:
    'articulated arms with rigid sleeve and forearm sections, covered elbow joints and connected gloves',
  layers: cutArms,
  compile(ctx) {
    const meta = ctx.featureMeta<ArmsMeta>('arms');
    for (const arm of ctx.spec.arms ?? []) {
      const ids = meta?.cuts[arm.id],
        layer = ids && ctx.layer(ids.arm),
        hand = ids && ctx.layer(ids.hand);
      if (!layer || !hand) {
        ctx.report.warning('avatar-arm-layers-missing', `arm ${arm.id} has no built layers`, {
          path: '/arms',
          hint: 'rebuild avatar layers after placing the arm landmarks',
        });
        continue;
      }
      const side = arm.id === 'armR' ? 'R' : 'L',
        prefix = arm.id,
        model = ctx.model;
      const a = (Math.atan2(arm.elbow[1] - arm.shoulder[1], arm.elbow[0] - arm.shoulder[0]) * 180) / Math.PI,
        b = (Math.atan2(arm.wrist[1] - arm.elbow[1], arm.wrist[0] - arm.elbow[0]) * 180) / Math.PI;
      const upper = Math.hypot(arm.elbow[0] - arm.shoulder[0], arm.elbow[1] - arm.shoulder[1]),
        fore = Math.hypot(arm.wrist[0] - arm.elbow[0], arm.wrist[1] - arm.elbow[1]);
      model.bone({ id: prefix + 'Shoulder', x: arm.shoulder[0], y: arm.shoulder[1] });
      model.bone({ id: prefix + 'Upper', parent: prefix + 'Shoulder', rotation: a, length: upper });
      model.bone({ id: prefix + 'Fore', parent: prefix + 'Upper', x: upper, rotation: b - a, length: fore });
      model.bone({ id: prefix + 'Hand', parent: prefix + 'Fore', x: fore });
      followBody(ctx, prefix + 'Shoulder', arm);
      for (const [id, bone, setup] of [
        [`Arm${side}A`, prefix + 'Upper', a],
        [`Arm${side}B`, prefix + 'Fore', b - a],
        [`Hand${side}`, prefix + 'Hand', 0],
      ] as const) {
        const param = model.parameter(id),
          range = id.startsWith('Hand') ? 120 : id.endsWith('A') ? 170 : 150;
        model.bind({
          id: prefix + '_' + id,
          target: `bone:${bone}.rotation`,
          params: [param],
          keys: [
            { at: [-range], value: setup - range },
            { at: [0], value: setup },
            { at: [range], value: setup + range },
          ],
        });
      }
      const z = arm.front ? AVATAR_Z.arms : AVATAR_Z.armsBack,
        joint = ids?.joint ?? { radius: arm.width[1] / 3, color: '#111111' };
      const upperShape = section(arm.shoulder, arm.elbow, arm.width[0], layer, arm.width[0] / 2 + 3, 2);
      const foreShape = section(arm.elbow, arm.wrist, arm.width[1], layer, 0, arm.width[1] / 2 + 3);
      const connectorStart = Math.min(fore, arm.hand.radius + 6),
        fx = (arm.wrist[0] - arm.elbow[0]) / fore,
        fy = (arm.wrist[1] - arm.elbow[1]) / fore;
      const connectorPath = `M ${arm.wrist[0] - fx * connectorStart} ${arm.wrist[1] - fy * connectorStart} L ${arm.wrist[0]} ${arm.wrist[1]}`;
      const dark = Math.max(...inkColor(joint.color)) < 60 ? joint.color : '#26313c';
      model.part({
        id: prefix + 'WristOutline',
        parent: prefix + 'Fore',
        shape: { type: 'path', d: connectorPath },
        fill: 'transparent',
        stroke: { color: dark, width: joint.radius * 2 },
        z: z - 0.2,
      });
      model.part({
        id: prefix + 'WristFill',
        parent: prefix + 'Fore',
        shape: { type: 'path', d: connectorPath },
        fill: 'transparent',
        stroke: { color: joint.color, width: Math.max(1, joint.radius * 2 - 4) },
        z: z - 0.1,
      });
      model.part({
        id: prefix + 'ForeMesh',
        shape: { type: 'mesh', ...foreShape, texture: model.texture(layer) },
        skin: { bones: [prefix + 'Fore'], weights: 'auto' },
        z,
      });
      model.part({
        id: prefix + 'ElbowJoint',
        parent: prefix + 'Fore',
        shape: {
          type: 'ellipse',
          cx: arm.elbow[0],
          cy: arm.elbow[1],
          rx: Math.max(1, joint.radius - 1),
          ry: Math.max(1, joint.radius - 1),
          detail: Math.max(2, joint.radius / 3),
        },
        fill: joint.color,
        stroke: { color: parseInt(joint.color.slice(1, 3), 16) < 60 ? joint.color : '#26313c', width: 2 },
        z: AVATAR_Z.armsBack - 0.1,
      });
      model.part({
        id: prefix + 'Mesh',
        shape: { type: 'mesh', ...upperShape, texture: model.texture(layer) },
        skin: { bones: [prefix + 'Upper'], weights: 'auto' },
        z: AVATAR_Z.armsBack,
      });
      const perimeter =
        (ids?.handOutline?.length ? ids.handOutline : undefined) ??
        arm.hand.outline ??
        Array.from({ length: 32 }, (_, i) => {
          const angle = (i * Math.PI) / 16,
            r = (arm.hand.radius + 2) / Math.cos(Math.PI / 32);
          return [arm.hand.center[0] + Math.cos(angle) * r, arm.hand.center[1] + Math.sin(angle) * r];
        }).flat();
      const triangulated = triangulatePolygon(perimeter),
        hv = triangulated.positions,
        hu = Array.from(hv, (v, i) => (v - hand.rect[i % 2]) / (i % 2 ? hand.rect[3] : hand.rect[2]));
      model.part({
        id: prefix + 'HandImage',
        parent: prefix + 'Hand',
        z: z + 1,
        shape: {
          type: 'mesh',
          texture: model.texture(hand),
          vertices: Array.from(hv),
          uvs: hu,
          triangles: Array.from(triangulated.indices),
        },
      });
      for (const params of [
        { [`Arm${side}A`]: 90 },
        { [`Arm${side}B`]: 90 },
        { [`Arm${side}A`]: 145, [`Arm${side}B`]: 55 },
      ])
        ctx.folds.pose(params);
    }
  },
  poses(ctx) {
    return (ctx.spec.arms ?? []).flatMap((arm) => {
      const s = arm.id === 'armR' ? 'R' : 'L';
      return [
        {
          id: arm.id + '_raise',
          label: arm.id + ' shoulder',
          params: { [`Arm${s}A`]: arm.id === 'armR' ? 90 : -90 },
        },
        {
          id: arm.id + '_bend',
          label: arm.id + ' elbow',
          params: { [`Arm${s}B`]: arm.id === 'armR' ? 65 : -65 },
        },
      ];
    });
  },
};
