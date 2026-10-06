/**
 * Feature "attachments": things on the head or body that move on their own (spec.attachments).
 *
 *   pendulum  (a tassel, an earring, a ribbon end) cut into its own layer "att_<id>" and the base
 *             inpainted behind it. Its warp "att_<id>Warp" is nested in the root lattice; Sway_<id>
 *             (-1..1, written by physics) turns it about its pivot by up to `swing` degrees, with
 *             keyforms at -1, -0.5, 0, 0.5, 1 (a chord of the arc every quarter of the swing).
 *   jiggle    (a hair bun, a bow) nothing is cut: Sway_<id> shifts a soft ellipse of the root lattice
 *             sideways by up to `swing` px, driven by a springy physics group.
 *   cutout    (a hand in front of the chin) cut into its own layer drawn in front of everything,
 *             the base inpainted behind it. It moves with the body or the head (`follow`); with a
 *             `contact` point, that end follows the head a little, so a fingertip stays at the chin.
 *
 * FOLLOWING. Pendulum and cut-out warps are rigid pieces: the root lattice's motions (head turn,
 * tilt, body sway, breath, a wobbling bun) would bend them, so ./attachments-follow.ts adds
 * bindings that replace the root's deformation over the attachment by a rigid motion: the motion of
 * the root around the pendulum's pivot, or over the cut-out's outline. An attachment that follows
 * the BODY does not take part in the motions of the head and the face (only BodyAngleX, Breath and
 * jiggles that follow the body move it); one that follows the HEAD takes part in all of them.
 *
 * PHYSICS (./hair-physics.ts). A pendulum hangs mostly by gravity: when the head tilts, it swings and
 * settles hanging nearly straight down again. A jiggle is a stiff, bouncy spring. Inputs are the
 * parameters that move the pivot sideways (AngleX, AngleZ, BodyAngleX for the head; BodyAngleX for
 * the body) and, for pendulums, the rotations of their frame.
 *
 * Ids: layers, parts and warps "att_<id>", "att_<id>Warp"; bindings "att_<id>_..."; physics
 * "att_<id>"; parameters "Sway_<id>".
 */
import type { BindingInput } from '../builder.js';
import { AVATAR_Z, fieldOffsets, rotationField, ramp, shiftField, softEllipseWeight, type AvatarMetrics, type Field, type Vec2 } from '../fields.js';
import { cropRect, cutLayer } from '../image/compose.js';
import { featherMask } from '../image/distance.js';
import { extendEdges, inpaint } from '../image/inpaint.js';
import { createMask, maskBounds } from '../image/mask.js';
import { pointInPolygon, polygonBounds } from '../image/polygon.js';
import { pixelRect } from '../image/types.js';
import type { AvatarAttachment, AvatarSpec, LayerInfo } from '../types.js';
import { attachmentObject } from './attachments-object.js';
import { addFollowBindings, rigidFit, type FollowTarget } from './attachments-follow.js';
import { headDrives } from './hair.js';
import { swayPhysics, type SwayDrive, type SwayTilt } from './hair-physics.js';
import type { AvatarFeature, CompileContext } from './types.js';

export const ATTACHMENT_TUNING = {
  /** Pendulum: frequency (Hz) of a pendulum `referenceLength` head heights long (longer = slower, 1 / sqrt), within [min, max]. */
  frequency: 1.45,
  referenceLength: 0.3,
  minFrequency: 0.6,
  maxFrequency: 3,
  /** Pendulums swing for a while; their restoring force is mostly gravity. */
  pendulumDamping: 0.14,
  pendulumHang: 0.75,
  /** Output for the reference motion (the first drive over a third of its range in 1 s, ./hair-physics.ts). */
  pendulumPeak: 0.8,
  /** Jiggle: a stiff, bouncy spring. */
  jiggleFrequency: 2.4,
  jiggleDamping: 0.12,
  jigglePeak: 0.8,
  /** The jiggle moves the ellipse fully up to this share of its radii and nothing beyond `jiggleOuter` radii. */
  jiggleInner: 0.55,
  jiggleOuter: 1.3,
  /** Samples around a pendulum's pivot for its rigid follow: this share of its length (at least one root cell). */
  pivotReach: 0.12,
  /** How much of the head's motion at the contact point a cut-out that follows the body takes there. */
  contactShare: 0.85,
  /** Spacing of the samples over a cut-out's outline, in root cells. */
  sampleSpacing: 0.5,
} as const;

/** The parameters of motions that move the body (anything else moves the head or the face). */
const BODY_PARAMS = ['BodyAngleX', 'Breath'];

/** What the layer stage tells the compile stage (layers.json, key "attachments"). */
export interface AttachmentsMeta {
  /** Per cut attachment: its layer id, the share of its outline that is the object, and whether the whole polygon was used. */
  cut: Record<string, { layer: string; share: number; wholePolygon: boolean }>;
}

const layerId = (id: string): string => `att_${id}`;
const swayParam = (id: string): string => `Sway_${id}`;
const round = (v: number, digits = 2): number => Math.round(v * 10 ** digits) / 10 ** digits;

// ----------------------------------------------------------------------------- fields

/** The jiggle's displacement at Sway = 1: the ellipse shifted sideways by `swing` px, softly. */
export function jiggleField(attachment: Extract<AvatarAttachment, { kind: 'jiggle' }>): Field {
  const T = ATTACHMENT_TUNING;
  return shiftField(attachment.swing, 0, softEllipseWeight({ center: attachment.center, radius: attachment.radius }, T.jiggleInner, T.jiggleOuter));
}

/** The pendulum's displacement at Sway = s: a rotation about its pivot by s x swing degrees (clockwise for s > 0). */
export function pendulumField(attachment: Extract<AvatarAttachment, { kind: 'pendulum' }>, s: number): Field {
  return rotationField(attachment.pivot, s * attachment.swing);
}

/** Points on a disk around (x, y): the centre and two rings of eight. */
function disk(x: number, y: number, radius: number): Vec2[] {
  const out: Vec2[] = [[x, y]];
  for (const r of [radius / 2, radius]) {
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      out.push([x + Math.cos(a) * r, y + Math.sin(a) * r]);
    }
  }
  return out;
}

/** Points inside a polygon on a grid of about `spacing` px (at most ~400); its vertices when the grid misses it. */
function insidePoints(outline: number[], spacing: number): Vec2[] {
  const b = polygonBounds(outline);
  const step = Math.max(spacing, Math.sqrt((b.width * b.height) / 400));
  const out: Vec2[] = [];
  for (let y = b.y + step / 2; y < b.y + b.height; y += step) {
    for (let x = b.x + step / 2; x < b.x + b.width; x += step) if (pointInPolygon(outline, x, y)) out.push([x, y]);
  }
  if (out.length === 0) for (let i = 0; i + 1 < outline.length; i += 2) out.push([outline[i], outline[i + 1]]);
  return out;
}

/** True when a root binding moves only the body (and things that follow it). */
function movesBody(binding: BindingInput, bodyParams: readonly string[]): boolean {
  return binding.params.every((p) => bodyParams.includes(p));
}

// ----------------------------------------------------------------------------- physics inputs

/** Drives and frame rotations of something at (x, y) that follows the head or the body. */
function drivesFor(spec: AvatarSpec, metrics: AvatarMetrics, has: (id: string) => boolean, follow: 'head' | 'body', x: number, y: number): { drives: SwayDrive[]; tilts: SwayTilt[] } {
  const tilts: SwayTilt[] = [];
  const sway = has('BodyAngleX') ? [{ param: 'BodyAngleX', degrees: metrics.sway / 10 }] : [];
  if (follow === 'head') {
    if (has('AngleZ')) tilts.push({ param: 'AngleZ', degrees: metrics.tilt / 30 });
    return { drives: headDrives(spec, metrics, has, x, y), tilts: [...tilts, ...sway] };
  }
  const drives: SwayDrive[] = [];
  if (has('BodyAngleX')) drives.push({ param: 'BodyAngleX', travel: (metrics.sway * (Math.PI / 180) * (spec.body.pivot[1] - y)) / 10, limit: 10 });
  return { drives: drives.filter((d) => Math.abs(d.travel) > 1e-9), tilts: sway };
}

// ----------------------------------------------------------------------------- the feature

export const attachments: AvatarFeature = {
  id: 'attachments',
  summary: 'attachments: pendulums that swing (Sway_<id>), jiggling masses, cut-outs in front of the face or body',

  layers(ctx) {
    const { spec, metrics, source } = ctx;
    const list = spec.attachments ?? [];
    const { width, height } = source;
    const n = width * height;
    const meta: AttachmentsMeta = { cut: {} };
    list.forEach((attachment, index) => {
      const object = attachmentObject(attachment, source, ctx.sourceLab(), metrics);
      if (!object) return;
      // Never take what another feature has cut already.
      const claimed = ctx.claimed;
      const hard = createMask(width, height);
      let area = 0;
      for (let i = 0; i < n; i++) {
        if (object.mask.data[i] >= 0.5 && claimed.data[i] < 0.5) {
          hard.data[i] = 1;
          area++;
        }
      }
      if (area === 0) {
        ctx.report.warning('avatar-attachment-empty', `attachment "${attachment.id}": nothing visible lies inside its outline (or other layers took it all): nothing is cut`, {
          path: `/attachments/${index}/outline`,
          hint: 'draw the outline around the object on the picture',
        });
        return;
      }
      const soft = featherMask(hard, metrics.feather, 'outward');
      for (let i = 0; i < n; i++) soft.data[i] *= 1 - Math.min(1, claimed.data[i]);
      const bounds = maskBounds(soft, 0);
      if (!bounds) return;
      const rect = pixelRect(bounds, 2, width, height);
      const { layer } = cutLayer(source, soft, { opaque: 250 });
      const { rest, covered } = cutLayer(ctx.base, soft, { opaque: 250 });
      ctx.base = inpaint(rest, covered);
      const info = ctx.addLayer(layerId(attachment.id), extendEdges(cropRect(layer, rect), 4), [rect.x, rect.y, rect.width, rect.height]);
      ctx.claim(soft);
      meta.cut[attachment.id] = { layer: info.id, share: round(object.share, 3), wholePolygon: object.wholePolygon };
      ctx.report.stat(`att_${attachment.id}Pixels`, area);
      if (attachment.kind === 'pendulum' && !object.wholePolygon && object.share < 0.6) {
        ctx.report.info('avatar-attachment-outline-trimmed', `pendulum "${attachment.id}": ${Math.round((1 - object.share) * 100)}% of its outline looked like its surroundings and was left in the picture`, {
          path: `/attachments/${index}/outline`,
          hint: 'trace the outline closer around the object if the cut layer (textures/att_' + attachment.id + '.png) misses a piece of it',
        });
      }
    });
    if (Object.keys(meta.cut).length) ctx.setMeta('attachments', meta);
  },

  compile(ctx) {
    const list = ctx.spec.attachments ?? [];
    if (list.length === 0) return;
    const meta = ctx.featureMeta<Partial<AttachmentsMeta>>('attachments');
    // Jiggles first: they move the root lattice, and the pendulums and cut-outs follow them.
    const bodyParams = [...BODY_PARAMS];
    const sways: string[] = [];
    list.forEach((a, index) => {
      if (a.kind !== 'jiggle') return;
      const param = compileJiggle(ctx, a, index);
      if (param) {
        sways.push(param);
        if (a.follow === 'body') bodyParams.push(param);
      }
    });
    list.forEach((a, index) => {
      if (a.kind === 'jiggle') return;
      const cut = meta?.cut?.[a.id];
      const layer = ctx.layer(cut?.layer ?? layerId(a.id));
      if (!layer) {
        ctx.report.warning('avatar-attachment-layer-missing', `attachment "${a.id}" has no layer image: it does not move`, {
          path: `/attachments/${index}`,
          hint: 'build the layers again ("rev2d avatar build")',
        });
        return;
      }
      const param = a.kind === 'pendulum' ? compilePendulum(ctx, a, layer, bodyParams) : compileCutout(ctx, a, layer, bodyParams);
      if (param) sways.push(param);
    });
    if (sways.length) {
      // Each one alone at its limits is a default pose: all of them together with the head and body moved.
      const all = (v: number) => Object.fromEntries(sways.map((p) => [p, v]));
      ctx.folds.pose({ ...all(1), AngleX: 30, AngleZ: 30, BodyAngleX: 10 });
      ctx.folds.pose({ ...all(-1), AngleX: -30, AngleZ: -30, BodyAngleX: -10 });
    }
  },

  poses(ctx) {
    const sways = (ctx.spec.attachments ?? []).filter((a) => a.kind !== 'cutout').map((a) => swayParam(a.id));
    if (sways.length === 0) return [];
    const all = (v: number) => Object.fromEntries(sways.map((p) => [p, v]));
    return [
      { id: 'attachments_left', label: 'attachments swung (Sway -1)', params: all(-1) },
      { id: 'attachments_right', label: 'attachments swung (Sway 1)', params: all(1) },
    ];
  },
};

function compileJiggle(ctx: CompileContext, a: Extract<AvatarAttachment, { kind: 'jiggle' }>, index: number): string | null {
  const T = ATTACHMENT_TUNING;
  const { spec, metrics, model, root } = ctx;
  const field = jiggleField(a);
  if (Object.keys(fieldOffsets(root.lattice, field)).length === 0) {
    ctx.report.warning('avatar-attachment-still', `jiggle "${a.id}" moves no point of the root lattice: its ellipse is smaller than a lattice cell`, {
      path: `/attachments/${index}/radius`,
      hint: `the root lattice has cells of about ${round(metrics.cell.body, 1)} px: make the ellipse cover the whole mass`,
    });
    return null;
  }
  const param = model.parameter({ id: swayParam(a.id), min: -1, max: 1, default: 0, group: 'Attachments', description: `Wobble of "${a.id}" (written by physics): +1 = ${round(a.swing, 1)} px toward the screen right.` });
  model.bindField(root, {
    id: `att_${a.id}_jiggle`,
    params: [param],
    keys: [{ at: [-1], field: (x, y) => { const d = field(x, y); return [-d[0] + 0, -d[1] + 0]; } }, { at: [0] }, { at: [1], field }],
    description: `Wobble of "${a.id}": the ellipse shifts sideways by up to ${round(a.swing, 1)} px, fading out around it.`,
  });
  const has = (id: string) => model.hasParameter(id);
  const { drives } = drivesFor(spec, metrics, has, a.follow, a.center[0], a.center[1]);
  if (drives.length) {
    model.physics(
      swayPhysics({
        id: `att_${a.id}`,
        output: param,
        kind: 'x',
        full: a.swing,
        length: Math.max(a.radius[0], a.radius[1]) * 1.5,
        frequency: T.jiggleFrequency,
        dampingRatio: T.jiggleDamping,
        hang: 0.1,
        drives,
        peak: T.jigglePeak,
        description: `Wobble of "${a.id}" (follows the ${a.follow}): a bouncy spring of ${T.jiggleFrequency} Hz.`,
      }),
    );
  }
  return param;
}

/** The follow target of an attachment in one root binding (see the file header). */
function followTarget(follow: 'head' | 'body', bodyParams: readonly string[], samples: Vec2[], contact?: { at: Vec2; weight: (x: number, y: number) => number }): FollowTarget {
  const T = ATTACHMENT_TUNING;
  return (binding, rootField) => {
    if (follow === 'head' || movesBody(binding, bodyParams)) return rigidFit(rootField, samples);
    if (!contact) return () => [0, 0];
    const d = rootField(contact.at[0], contact.at[1]);
    return (x, y) => {
      const w = contact.weight(x, y) * T.contactShare;
      return [d[0] * w, d[1] * w];
    };
  };
}

function compilePendulum(ctx: CompileContext, a: Extract<AvatarAttachment, { kind: 'pendulum' }>, layer: LayerInfo, bodyParams: readonly string[]): string | null {
  const T = ATTACHMENT_TUNING;
  const { spec, metrics, model, root } = ctx;
  const rect = layer.rect;
  const id = layerId(a.id);
  const warp = model.warp({ id: `${id}Warp`, parent: root.id, rect, cell: metrics.cell.head, description: `Pendulum "${a.id}": swings about its pivot (Sway_${a.id}) and moves rigidly with the root lattice around its pivot.` });
  model.imagePart(layer, { id, parent: warp.id, z: AVATAR_Z.attachments, description: `Pendulum "${a.id}", cut from the picture (the base is inpainted behind it).` });

  const length = Math.hypot(a.tip[0] - a.pivot[0], a.tip[1] - a.pivot[1]);
  const reach = Math.max(metrics.cell.body, T.pivotReach * length);
  addFollowBindings(model, root, warp, `${id}_follow`, followTarget(a.follow, bodyParams, disk(a.pivot[0], a.pivot[1], reach)));

  const param = model.parameter({ id: swayParam(a.id), min: -1, max: 1, default: 0, group: 'Attachments', description: `Swing of "${a.id}" (written by physics): +1 = ${round(a.swing, 1)} degrees clockwise about its pivot.` });
  model.bindField(warp, {
    id: `${id}_swing`,
    params: [param],
    keys: [-1, -0.5, 0, 0.5, 1].map((s) => (s === 0 ? { at: [s] } : { at: [s], field: pendulumField(a, s) })),
    description: `Pendulum "${a.id}": a rotation about its pivot by up to ${round(a.swing, 1)} degrees.`,
  });

  const has = (p: string) => model.hasParameter(p);
  const { drives, tilts } = drivesFor(spec, metrics, has, a.follow, a.pivot[0], a.pivot[1]);
  if (drives.length) {
    const relative = Math.max(0.02, length / (2 * spec.head.radius[1]));
    const frequency = Math.min(T.maxFrequency, Math.max(T.minFrequency, T.frequency * Math.sqrt(T.referenceLength / relative)));
    model.physics(
      swayPhysics({
        id,
        output: param,
        kind: 'angle',
        full: a.swing,
        length,
        frequency,
        dampingRatio: T.pendulumDamping,
        hang: T.pendulumHang,
        drives,
        tilts,
        peak: T.pendulumPeak,
        description: `Pendulum "${a.id}" (follows the ${a.follow}): ${round(frequency)} Hz, hangs mostly by gravity.`,
      }),
    );
  }
  return param;
}

function compileCutout(ctx: CompileContext, a: Extract<AvatarAttachment, { kind: 'cutout' }>, layer: LayerInfo, bodyParams: readonly string[]): string | null {
  const T = ATTACHMENT_TUNING;
  const { metrics, model, root } = ctx;
  const rect = layer.rect;
  const id = layerId(a.id);
  const warp = model.warp({ id: `${id}Warp`, parent: root.id, rect, cell: metrics.cell.head, description: `Cut-out "${a.id}": moves rigidly with the ${a.follow}${a.contact ? ', its contact end follows the head a little' : ''}.` });
  model.imagePart(layer, { id, parent: warp.id, z: AVATAR_Z.cutouts, description: `Cut-out "${a.id}" in front of everything (the base is inpainted behind it).` });
  const samples = insidePoints(a.outline, metrics.cell.body * T.sampleSpacing);
  let contact: { at: Vec2; weight: (x: number, y: number) => number } | undefined;
  if (a.contact) {
    const at: Vec2 = [a.contact[0], a.contact[1]];
    let far = 0;
    for (let i = 0; i + 1 < a.outline.length; i += 2) far = Math.max(far, Math.hypot(a.outline[i] - at[0], a.outline[i + 1] - at[1]));
    const span = Math.max(1, far * 0.85);
    contact = { at, weight: (x, y) => 1 - ramp(0, span, Math.hypot(x - at[0], y - at[1])) };
  }
  const added = addFollowBindings(model, root, warp, `${id}_follow`, followTarget(a.follow, bodyParams, samples, contact));
  ctx.report.stat(`${id}Follow`, added);
  return null;
}
