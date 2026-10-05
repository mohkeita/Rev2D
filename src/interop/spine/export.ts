/**
 * Rev2D model -> Spine 4.x skeleton JSON + atlas + PNG pages.
 *
 * Choices (every approximation is reported with a stable code):
 * - Setup pose: the rig's default pose (parameters at defaults, no animation, physics at rest, IK
 *   solved). Canvas (X, Y) = Spine (X, −Y); a synthetic root bone at the canvas origin parents every
 *   Rev2D root bone; bone locals map as (x, −y, −rotation, scaleX, scaleY). The skeleton bounds are
 *   the canvas, so importing the export with padding 0 gives back the same canvas.
 * - Parts: one slot each in setup draw order (z, index) with one textured mesh attachment. The part's
 *   paint (fill + stroke, gradients and textures) is rasterized alone into its own region; tint and
 *   opacity go to the slot color (so tint animations stay exact). Parts hidden by `visible: false`
 *   are not exported (masks among them only become clipping polygons).
 * - Warps become grids of bones (one per used lattice point); parts inside a warp are weighted meshes
 *   with the bilinear weights, which reproduces warp deformation exactly (export-bones.ts).
 * - What bones cannot express (shape morphs, skinning differences) is baked into deform timelines;
 *   bones are baked after IK, so IK constraints are exported with mix 0 (editable, inactive; the baked
 *   rotations are exact). Physics is baked (steady-state loops for looping animations). Parameters are
 *   not runtime controls in Spine: their effect exists only in the baked animations and, with
 *   `paramPoses`, in one-frame animations "param/<id>/min|max".
 * - Animations are sampled with a Player (physics steps incrementally) at `fps`, at every key time and
 *   around step changes, refined where motion is faster than the samples follow, and reduced to linear
 *   and Bézier keys within `tolerance`.
 * - Masks: a Spine clipping attachment per contiguous draw-order range of parts sharing the same mask,
 *   its polygon traced from the mask part's coverage and deformed with it. Parts that never overlap may
 *   be reordered (same z) so that ranges become contiguous.
 * - Atlas: MaxRects into power-of-two pages, 2 px padding, premultiplied alpha by default (what Spine
 *   runtimes expect; their multiply / screen blend modes only work with it), or straight alpha with
 *   alpha bleeding.
 */
import { parseColor } from '../../core/color.js';
import type { Rig } from '../../core/rig.js';
import type { ImageRGBA, Model, Pose } from '../../core/types.js';
import { encodePNG } from '../../render/png.js';
import type { OutputFile, SpineExportOptions, SpineExportResult } from '../types.js';
import { writeAtlas, type Atlas } from './atlas.js';
import { sampleAnimation, sampleParamPose, type ClipSample } from './bake.js';
import { fitSegments } from './bake-reduce.js';
import { buildAnimation, slotColor, type AnimContext, type AnimStats, type SlotPlan } from './export-anim.js';
import { BoneTable } from './export-bones.js';
import { round, roundAll, skeletonHash, writeSpineJson } from './export-json.js';
import {
  PartStates,
  VertexPlan,
  bindPart,
  collectStates,
  latticePoints,
  planClipPolygon,
  planPartMesh,
  referenceState,
  type ClipPolygon,
  type PartMesh,
  type PartState,
} from './export-parts.js';
import { bleedAlpha, composePages, packRects, premultiply } from './pack.js';
import { ReportBuilder, fmt, toSpineColor } from './util.js';

type Json = Record<string, unknown>;

const PAGE_PADDING = 2;
const SKIN = 'default';
/** Overlay color of warp lattice bones in the Spine editor. */
const LATTICE_COLOR = '4fb3ffff';

interface Resolved {
  fps: number;
  textureScale: number;
  maxPageSize: number;
  tolerance: number;
  name: string;
  version: string;
  paramPoses: boolean;
  animations: string[];
  pma: boolean;
}

function resolveOptions(model: Model, opts: SpineExportOptions, report: ReportBuilder): Resolved {
  const positive = (v: number | undefined, def: number, what: string) => {
    const x = v ?? def;
    if (!(x > 0) || !Number.isFinite(x)) throw new Error(`exportSpine: ${what} must be a positive number, got ${v}`);
    return x;
  };
  const fps = positive(opts.fps, 30, 'fps');
  const textureScale = positive(opts.textureScale, 1, 'textureScale');
  const maxPageSize = Math.floor(positive(opts.maxPageSize, 2048, 'maxPageSize'));
  if (maxPageSize < 64) throw new Error(`exportSpine: maxPageSize must be at least 64, got ${opts.maxPageSize}`);
  const tolerance = opts.tolerance ?? 0.05;
  if (!(tolerance >= 0) || !Number.isFinite(tolerance)) throw new Error(`exportSpine: tolerance must be a number >= 0, got ${opts.tolerance}`);
  const name = (opts.name ?? model.meta.name).trim().replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '') || 'skeleton';
  const version = opts.spineVersion ?? '4.2.00';
  const m = /^(\d+)\.(\d+)/.exec(version);
  if (!m || Number(m[1]) !== 4) {
    report.warn(
      'spine-export-version',
      `the export uses the Spine 4.x JSON layout; version "${version}" is written as requested but readers of other major versions may reject the file`,
      'options.spineVersion',
      'use a 4.x version such as "4.2.00"',
    );
  }
  const ids = model.animations.map((a) => a.id);
  const animations = opts.animations ?? ids;
  for (const a of animations) {
    if (!ids.includes(a)) throw new Error(`exportSpine: unknown animation "${a}" (available: ${ids.join(', ') || 'none'})`);
  }
  return { fps, textureScale, maxPageSize, tolerance, name, version, paramPoses: opts.paramPoses ?? false, animations: [...new Set(animations)], pma: opts.premultipliedAlpha ?? true };
}

function deformLayout(version: string): 'attachments' | 'deform' {
  const m = /^(\d+)\.(\d+)/.exec(version);
  if (!m) return 'attachments';
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > 4 || (major === 4 && minor >= 1) ? 'attachments' : 'deform';
}

function maskKey(c: Rig['compiled'], index: number): string {
  const cp = c.parts[index];
  return cp.masks.length ? `${[...cp.masks].sort((a, b) => a - b).join(',')}|${cp.maskInvert}` : '';
}

export function exportSpine(model: Model, rig: Rig, textures: Record<string, ImageRGBA>, opts: SpineExportOptions = {}): SpineExportResult {
  const report = new ReportBuilder('spine', 'export');
  const o = resolveOptions(model, opts, report);
  if (rig.model !== model) throw new Error('exportSpine: `rig` must be compiled from `model`');
  const c = rig.compiled;

  // Textures used by parts must be given.
  for (const p of model.parts) {
    const tex = p.shape.type === 'image' || p.shape.type === 'mesh' ? p.shape.texture : undefined;
    if (tex !== undefined && !Object.hasOwn(textures, tex)) throw new Error(`exportSpine: texture "${tex}" (part "${p.id}") was not provided`);
  }

  const setupPose = rig.pose({ time: 0 });

  // ------------------------------------------------------------------ frames
  const clips: ClipSample[] = o.animations.map((id) => sampleAnimation(rig, model.animations.find((a) => a.id === id)!, o.fps, o.tolerance));
  if (o.paramPoses) {
    const bound = new Set(model.bindings.flatMap((b) => b.params));
    for (const p of model.parameters) {
      if (!bound.has(p.id) || p.min === p.max) continue;
      clips.push(sampleParamPose(rig, `param/${p.id}/min`, p.id, p.min));
      clips.push(sampleParamPose(rig, `param/${p.id}/max`, p.id, p.max));
    }
  }
  const allPoses: Pose[] = [setupPose, ...clips.flatMap((cl) => cl.poses)];

  // ------------------------------------------------------------------ bones
  const boneIds = new Set(model.bones.map((b) => b.id));
  let rootName = 'root';
  for (let k = 2; boneIds.has(rootName); k++) rootName = k === 2 ? 'rev2d-root' : `rev2d-root-${k - 1}`;
  if (rootName !== 'root') {
    report.info('spine-root-renamed', `the synthetic Spine root bone is "${rootName}" because a Rev2D bone is already called "root"`, 'bones');
  }
  const bones = new BoneTable(c, rootName);

  // ------------------------------------------------------------------ parts
  const statesOf = new Map<number, { states: PartStates; setup: PartState; ref: PartState }>();
  const partStates = (i: number) => {
    let s = statesOf.get(i);
    if (s) return s;
    const states = new PartStates(c, c.parts[i]);
    const setup = collectStates(states, setupPose, clips);
    s = { states, setup, ref: referenceState(states, setup) };
    statesOf.set(i, s);
    const ch = states.changes();
    const id = c.parts[i].id;
    if (ch.shape) {
      report.info('spine-morph-baked', `shape animation of part "${id}" is baked into deform timelines (the texture is drawn from its largest state)`, `parts.${id}`);
      report.count('morphedParts');
      const fill = c.parts[i].source.fill;
      if (fill && typeof fill === 'object' && (fill.type === 'linear' || fill.type === 'radial')) {
        report.info(
          'spine-gradient-morph',
          `part "${id}" has a gradient fill and a changing shape: Rev2D evaluates the gradient at the moved vertices, Spine stretches the texture with the mesh, so colors near the moving edges differ slightly`,
          `parts.${id}`,
          'use a solid fill (or a texture) on parts whose shape is animated for an exact match',
        );
      }
    }
    if (ch.paint) {
      report.warn(
        'spine-paint-animated',
        `the fill / stroke color of part "${id}" is bound or animated; Spine can only multiply a texture, so the part keeps the paint of its reference state (tint and opacity animations are exported)`,
        `parts.${id}`,
        "animate the part's tint instead of its fill color",
      );
    }
    if (ch.strokeWidth) {
      report.warn('spine-stroke-width-animated', `the stroke width of part "${id}" changes; the exported texture keeps the width of its reference state`, `parts.${id}`);
    }
    return s;
  };

  const maxRegion = o.maxPageSize - 2 * PAGE_PADDING;
  let meshes: PartMesh[] = [];
  const hidden: string[] = [];
  model.parts.forEach((p, i) => {
    if (!p.visible) {
      hidden.push(p.id);
      return;
    }
    const st = partStates(i);
    const mesh = planPartMesh(c, i, st.states, st.ref, textures, { textureScale: o.textureScale, maxRegion });
    if (!mesh) {
      report.info('spine-part-empty', `part "${p.id}" draws nothing (no visible fill or stroke in its largest state); no attachment exported`, `parts.${p.id}`);
      return;
    }
    if (mesh.downscaled) {
      report.warn(
        'spine-texture-downscaled',
        `part "${p.id}" is larger than an atlas page at the requested scale; its texture was rasterized at ${fmt(mesh.box.scale)} px per canvas px`,
        `parts.${p.id}`,
        'raise maxPageSize',
      );
    }
    meshes.push(mesh);
  });
  if (hidden.length) {
    report.info('spine-part-hidden', `${hidden.length} part(s) with "visible": false are not exported as attachments: ${hidden.join(', ')}`, 'parts', 'masks among them become clipping polygons');
  }

  // Setup draw order, then pull parts sharing a mask together where nothing in between overlaps them.
  const zOf = (i: number) => setupPose.parts[c.parts[i].id].z;
  meshes.sort((a, b) => zOf(a.index) - zOf(b.index) || a.index - b.index);
  meshes = groupMasked(meshes);

  function groupMasked(list: PartMesh[]): PartMesh[] {
    const boundsOf = new Map<number, Float64Array>();
    const bounds = (i: number) => {
      let b = boundsOf.get(i);
      if (!b) {
        b = new Float64Array(allPoses.length * 4);
        allPoses.forEach((pose, f) => {
          const r = pose.parts[c.parts[i].id].bounds;
          b!.set(r ? [r[0] - 1, r[1] - 1, r[0] + r[2] + 1, r[1] + r[3] + 1] : [Infinity, Infinity, -Infinity, -Infinity], f * 4);
        });
        boundsOf.set(i, b);
      }
      return b;
    };
    const overlap = (a: number, b: number) => {
      const A = bounds(a);
      const B = bounds(b);
      for (let f = 0; f < allPoses.length; f++) {
        const k = f * 4;
        if (A[k] < B[k + 2] && B[k] < A[k + 2] && A[k + 1] < B[k + 3] && B[k + 1] < A[k + 3]) return true;
      }
      return false;
    };
    const out: PartMesh[] = [];
    let moved = 0;
    for (const m of list) {
      const key = maskKey(c, m.index);
      let last = -1;
      if (key) for (let k = out.length - 1; k >= 0; k--) if (maskKey(c, out[k].index) === key) {
        last = k;
        break;
      }
      if (last >= 0 && last < out.length - 1) {
        const between = out.slice(last + 1);
        if (between.every((q) => zOf(q.index) === zOf(m.index) && !overlap(q.index, m.index))) {
          out.splice(last + 1, 0, m);
          moved++;
          continue;
        }
      }
      out.push(m);
    }
    if (moved) {
      report.info(
        'spine-draw-order-grouped',
        `${moved} masked part(s) were moved next to parts with the same mask (they never overlap the parts they were moved past, so the picture is unchanged) to share clipping ranges`,
        'parts',
      );
    }
    return out;
  }
  const rank = new Map<number, number>();
  meshes.forEach((m, r) => rank.set(m.index, r));

  // ------------------------------------------------------------------ clipping ranges
  const slotNames = new Set(model.parts.map((p) => p.id));
  const allocSlot = (base: string) => {
    let n = base;
    for (let k = 2; slotNames.has(n); k++) n = `${base}-${k}`;
    slotNames.add(n);
    return n;
  };
  interface Range {
    group: PartMesh[];
    clip: ClipPolygon | null;
    name: string;
  }
  const ranges: Range[] = [];
  for (let i = 0; i < meshes.length; ) {
    const key = maskKey(c, meshes[i].index);
    let j = i + 1;
    while (j < meshes.length && maskKey(c, meshes[j].index) === key) j++;
    const group = meshes.slice(i, j);
    ranges.push({ group, clip: key ? planClip(group) : null, name: '' });
    i = j;
  }

  function planClip(group: PartMesh[]): ClipPolygon | null {
    const cp = c.parts[group[0].index];
    const where = `parts.${group.map((g) => g.id).join(',')}`;
    const ids = group.map((g) => `"${g.id}"`).join(', ');
    if (cp.maskInvert) {
      report.warn('spine-mask-inverted', `inverted mask (maskInvert) of ${ids} cannot be expressed with Spine clipping; exported unclipped`, where, 'cut the shape into the parts instead');
      return null;
    }
    const plans = cp.masks.map((m) => {
      const st = partStates(m);
      return planClipPolygon(c, m, st.states, st.ref, textures);
    });
    let pick = 0;
    for (let k = 1; k < plans.length; k++) if ((plans[k]?.area ?? 0) > (plans[pick]?.area ?? 0)) pick = k;
    const plan = plans[pick];
    const maskId = c.parts[cp.masks[pick]].id;
    if (cp.masks.length > 1) {
      report.warn(
        'spine-mask-union',
        `${ids} are masked by several parts (${cp.masks.map((m) => `"${c.parts[m].id}"`).join(', ')}); Spine clips to one polygon, so only "${maskId}" (the largest) is used`,
        where,
        'merge the mask parts into one',
      );
    }
    if (!plan) {
      report.warn('spine-mask-empty', `mask part "${maskId}" covers nothing; ${ids} are exported unclipped (Rev2D draws them nowhere)`, where);
      return null;
    }
    if (plan.otherArea > 0.02 * plan.area) {
      report.warn(
        'spine-mask-regions',
        `mask part "${maskId}" covers several separate regions; the clipping polygon follows the largest one (${fmt(plan.otherArea)} px² of other regions dropped)`,
        where,
      );
    }
    report.info('spine-mask-clipping', `mask "${maskId}" of ${ids} is a clipping attachment traced from its coverage (hard edge at 50% alpha)`, where);
    report.count('clippingAttachments');
    return plan;
  }

  // ------------------------------------------------------------------ lattice bones, vertex plans, slots
  const lattice: Array<[number, number]> = [];
  for (const m of meshes) lattice.push(...latticePoints(c, m.index, m.mesh.positions));
  bones.addLattice(lattice);
  const latticeBones = bones.bones.filter((b) => b.lattice).length;

  const slots: SlotPlan[] = [];
  const meshBySlot = new Map<SlotPlan, PartMesh>();
  for (const r of ranges) {
    const partSlots = r.group.map((m): SlotPlan => {
      const st = partStates(m.index);
      const ref = Float64Array.from(m.mesh.positions);
      const binding = bindPart(c, bones, m.index, ref, !!m.morph);
      let plan = new VertexPlan(c, bones, m.index, ref, st.states, m.morph, binding, setupPose);
      if (m.morph && binding.influences && !c.parts[m.index].skin) {
        // A morphing part in a warp: weighted meshes carry the morph as per-influence offsets (4 values
        // per vertex and key), unweighted ones the warp motion too (1 value pair). Keep the smaller.
        const flat = new VertexPlan(c, bones, m.index, ref, st.states, m.morph, bindPart(c, bones, m.index, ref, true, true), setupPose);
        if (deformCost(flat) < deformCost(plan)) {
          plan = flat;
          report.info('spine-morph-unweighted', `part "${m.id}" morphs inside a warp; it is exported as an unweighted mesh whose deform timelines carry both the warp and the morph (smaller than per-influence offsets)`, `parts.${m.id}`);
        }
      }
      const slot: SlotPlan = { name: m.id, kind: 'part', partIndex: m.index, rank: rank.get(m.index)!, attachment: m.id, plan };
      meshBySlot.set(slot, m);
      return slot;
    });
    if (r.clip) {
      const st = partStates(r.clip.maskIndex);
      const binding = bindPart(c, bones, r.clip.maskIndex, r.clip.points, !!r.clip.morph, true);
      const plan = new VertexPlan(c, bones, r.clip.maskIndex, r.clip.points, st.states, r.clip.morph, binding, setupPose);
      const name = allocSlot(`${c.parts[r.clip.maskIndex].id}-clip`);
      slots.push({ name, kind: 'clip', partIndex: r.clip.maskIndex, rank: -1, attachment: name, plan, clipped: partSlots });
    }
    slots.push(...partSlots);
  }

  /** Numbers a vertex plan writes: setup vertices plus the reduced deform keys of every clip. */
  function deformCost(plan: VertexPlan): number {
    let cost = plan.weighted ? plan.weighted.bones.length * 4 + plan.weighted.counts.length : plan.local.length;
    const len = plan.deformLength;
    for (const clip of clips) {
      const n = clip.poses.length;
      const vals = new Float32Array(n * len);
      clip.poses.forEach((p, f) => plan.deform(p, vals, f * len));
      let dev = 0;
      for (let i = 0; i < vals.length; i++) dev = Math.max(dev, Math.abs(vals[i]));
      if (dev <= Math.max(o.tolerance, 1e-6)) continue;
      cost += (fitSegments(clip.times, vals, len, o.tolerance, 'shared').length + 1) * len;
    }
    return cost;
  }

  // ------------------------------------------------------------------ atlas
  const images = new Map<string, ImageRGBA>();
  for (const m of meshes) images.set(m.id, o.pma ? premultiply(m.image) : bleedAlpha(m.image));
  const packed = packRects(
    meshes.map((m) => ({ id: m.id, width: m.box.width, height: m.box.height })),
    { maxSize: o.maxPageSize, padding: PAGE_PADDING },
  );
  const pageNames = packed.pages.map((_, i) => (i === 0 ? `${o.name}.png` : `${o.name}_${i + 1}.png`));
  const atlas: Atlas = {
    pages: packed.pages.map((p, i) => ({ name: pageNames[i], width: p.width, height: p.height, minFilter: 'Linear', magFilter: 'Linear', pma: o.pma })),
    regions: packed.placements.map((pl) => ({
      name: pl.id,
      page: pl.page,
      x: pl.x,
      y: pl.y,
      width: pl.width,
      height: pl.height,
      offsetX: 0,
      offsetY: 0,
      originalWidth: pl.width,
      originalHeight: pl.height,
      degrees: 0,
      index: -1,
    })),
  };
  const pageImages = composePages(packed, images);
  if (meshes.length && !o.pma) {
    report.info(
      'spine-straight-alpha',
      'atlas pages use straight (non-premultiplied) alpha ("pma" is not set); configure the Spine runtime with premultipliedAlpha: false',
      'atlas',
    );
    const blended = meshes.filter((m) => c.parts[m.index].blend === 'multiply' || c.parts[m.index].blend === 'screen').map((m) => m.id);
    if (blended.length) {
      report.warn(
        'spine-blend-straight-alpha',
        `Spine runtimes blend multiply and screen slots as if textures were premultiplied; with straight alpha, translucent pixels of ${blended.join(', ')} come out too bright`,
        'atlas',
        'export with premultipliedAlpha: true (the default)',
      );
    }
  }

  // ------------------------------------------------------------------ skeleton JSON
  const W = model.meta.width;
  const H = model.meta.height;
  const bonesJson: Json[] = bones.bones.map((b) => {
    if (b.parent < 0) return { name: b.name };
    const L = b.local(setupPose);
    const out: Json = { name: b.name, parent: bones.bones[b.parent].name };
    const len = round(L.length, 3);
    if (len !== 0) out.length = len;
    const rot = round(-L.rotation, 4);
    if (rot !== 0) out.rotation = rot;
    const x = round(L.x, 4);
    const y = round(-L.y, 4);
    if (x !== 0) out.x = x;
    if (y !== 0) out.y = y;
    const sx = round(L.scaleX, 5);
    const sy = round(L.scaleY, 5);
    if (sx !== 1) out.scaleX = sx;
    if (sy !== 1) out.scaleY = sy;
    if (b.lattice) out.color = LATTICE_COLOR;
    else {
      const color = model.bones.find((m) => m.id === b.name)?.color;
      const rgba = color ? parseColor(color) : null;
      if (rgba) out.color = toSpineColor(rgba);
    }
    return out;
  });

  const blendOf: Record<string, string> = { add: 'additive', multiply: 'multiply', screen: 'screen' };
  const slotsJson: Json[] = slots.map((s) => {
    const out: Json = { name: s.name, bone: bones.bones[s.plan.slotBone].name };
    if (s.kind === 'part') {
      const color = toSpineColor(slotColor(setupPose, c.parts[s.partIndex].id));
      if (color !== 'ffffffff') out.color = color;
    }
    out.attachment = s.attachment;
    const blend = s.kind === 'part' ? blendOf[c.parts[s.partIndex].blend] : undefined;
    if (blend) out.blend = blend;
    return out;
  });

  const attachments: Record<string, Json> = {};
  for (const s of slots) {
    if (s.kind === 'part') {
      const m = meshBySlot.get(s)!;
      attachments[s.name] = {
        [s.attachment]: {
          type: 'mesh',
          uvs: roundAll(m.uvs, 6),
          triangles: m.mesh.triangles,
          vertices: vertexJson(s.plan),
          hull: m.mesh.hull,
          width: round(m.box.width / m.box.scale, 2),
          height: round(m.box.height / m.box.scale, 2),
        },
      };
    } else {
      attachments[s.name] = {
        [s.attachment]: { type: 'clipping', end: s.clipped![s.clipped!.length - 1].name, vertexCount: s.plan.ref.length / 2, vertices: vertexJson(s.plan), color: 'ce3a3aff' },
      };
    }
  }

  function vertexJson(plan: VertexPlan): number[] {
    const out: number[] = [];
    const wp = plan.weighted;
    if (!wp) {
      const L = plan.local;
      for (let i = 0; i + 1 < L.length; i += 2) out.push(round(L[i], 3), round(-L[i + 1], 3));
      return out;
    }
    let k = 0;
    for (const count of wp.counts) {
      out.push(count);
      const ws = roundAll(wp.weights.slice(k, k + count), 5);
      // Make the rounded weights sum to exactly 1 (the largest absorbs the rounding).
      let big = 0;
      for (let j = 1; j < count; j++) if (Math.abs(ws[j]) > Math.abs(ws[big])) big = j;
      ws[big] = round(1 - ws.reduce((a, b, j) => (j === big ? a : a + b), 0), 5);
      for (let j = 0; j < count; j++) out.push(wp.bones[k + j], round(wp.local[2 * (k + j)], 3), round(-wp.local[2 * (k + j) + 1], 3), ws[j]);
      k += count;
    }
    return out;
  }

  // ------------------------------------------------------------------ events
  const eventsJson: Record<string, Json> = {};
  for (const clip of clips) {
    for (const e of clip.events) {
      const def = (eventsJson[e.name] ??= {});
      const audio = e.data && typeof e.data === 'object' && typeof (e.data as { audio?: unknown }).audio === 'string' ? (e.data as { audio: string }).audio : undefined;
      if (audio === undefined) continue;
      if (def.audio === undefined) def.audio = audio;
      else if (def.audio !== audio) {
        report.warn('spine-event-audio', `event "${e.name}" uses several audio paths; Spine events have one (kept "${String(def.audio)}")`, `animations.${clip.name}.events`);
      }
    }
  }

  // ------------------------------------------------------------------ animations
  const tol = o.tolerance;
  const decimals = tol > 0 ? Math.min(4, Math.max(2, Math.ceil(-Math.log10(tol / 4)))) : 4;
  const actx: AnimContext = {
    c,
    setupPose,
    bones: bones.bones,
    slots,
    tol: { rotate: tol, translate: tol, scale: tol / 100, color: tol * 0.04, deform: tol, deformDecimals: decimals },
    report,
    deformLayout: deformLayout(o.version),
    skin: SKIN,
  };
  const stats: AnimStats = { sampledKeys: 0, keys: 0, deformTimelines: 0, deformKeys: 0 };
  const animationsJson: Record<string, Json> = {};
  for (const clip of clips) animationsJson[clip.name] = buildAnimation(actx, clip, stats);

  // ------------------------------------------------------------------ constraints and notes
  const ikJson: Json[] = model.ik.map((k, order) => {
    const out: Json = { name: k.id, order, bones: k.bones, target: k.target, mix: 0 };
    if (k.bones.length === 2 && k.softness > 0) out.softness = round(k.softness / ikSoftnessFactor(setupPose, k.bones), 4);
    out.bendPositive = !k.bendPositive;
    if (k.stretch) out.stretch = true;
    return out;
  });
  if (model.ik.length) {
    report.info(
      'spine-ik-baked',
      `${model.ik.length} IK constraint(s) are baked into the bone rotations of every animation and exported with mix 0 (inactive; raise the mix in Spine to drive the bones by IK again)`,
      'ik',
    );
  }
  if (model.physics.length) {
    const warm = clips.filter((cl) => cl.warmupCycles > 0).map((cl) => `${cl.name} after ${cl.warmupCycles} cycle(s)`);
    report.info(
      'spine-physics-baked',
      `${model.physics.length} physics group(s) are baked into the animations${warm.length ? ` (looping animations start in the steady state: ${warm.join(', ')})` : ''}; Spine gets no physics constraints`,
      'physics',
    );
  }
  if (model.warps.length) {
    const warpParts = meshes.filter((m) => c.parts[m.index].parent.kind === 'warp' && !c.parts[m.index].skin).length;
    report.info(
      'spine-warp-bones',
      `${model.warps.length} warp deformer(s) have no Spine equivalent: their ${latticeBones} used lattice point(s) are exported as bones, and the ${warpParts} part(s) inside warps as meshes weighted with the bilinear weights (exact); warp motion is baked into those bones' translate timelines`,
      'warps',
    );
  }
  if (model.parameters.length) {
    report.info(
      'spine-parameters-baked',
      `${model.parameters.length} parameter(s) are not Spine runtime controls; their effect exists only in the baked animations${o.paramPoses ? ' and the "param/<id>/min|max" poses' : ' (export with paramPoses for one-frame min/max poses)'}`,
      'parameters',
    );
  }
  if (clips.some((cl) => cl.animation)) {
    report.info(
      'spine-animations-sampled',
      `animations are sampled at ${fmt(o.fps)} fps plus their key times and reduced to linear / Bézier keys within ${fmt(tol)} px or degrees`,
      'animations',
    );
    const once = clips.filter((cl) => cl.animation && !cl.loop).map((cl) => cl.name);
    if (once.length) report.info('spine-animation-once', `Spine animations have no loop flag; play ${once.join(', ')} without looping`, 'animations');
  }

  // ------------------------------------------------------------------ assemble
  const skeleton: Json = { hash: '', spine: o.version, x: 0, y: -H, width: W, height: H, fps: o.fps, images: './', audio: '' };
  const doc: Json = { skeleton, bones: bonesJson, slots: slotsJson };
  if (ikJson.length) doc.ik = ikJson;
  doc.skins = [{ name: SKIN, attachments }];
  if (Object.keys(eventsJson).length) doc.events = eventsJson;
  if (Object.keys(animationsJson).length) doc.animations = animationsJson;
  skeleton.hash = skeletonHash(writeSpineJson(doc));
  const files: OutputFile[] = [
    { path: `${o.name}.json`, text: writeSpineJson(doc) },
    { path: `${o.name}.atlas`, text: writeAtlas(atlas) },
    ...pageImages.map((img, i) => ({ path: pageNames[i], bytes: encodePNG(img) })),
  ];

  report.count('bones', bones.bones.length);
  report.count('latticeBones', latticeBones);
  report.count('slots', slots.length);
  report.count('attachments', meshes.length);
  report.count('pages', pageImages.length);
  report.count('animations', clips.length);
  report.count('keysSampled', stats.sampledKeys);
  report.count('keys', stats.keys);
  report.count('deformTimelines', stats.deformTimelines);
  report.count('deformKeys', stats.deformKeys);
  report.count('ik', ikJson.length);
  report.count('events', clips.reduce((n, cl) => n + cl.events.length, 0));
  return { files, report: report.build() };
}

/**
 * Rev2D softness (px) per Spine softness unit: Spine measures it in the chain's parent space scaled by
 * the bones' local scaleX (the inverse of the importer's mapping).
 */
function ikSoftnessFactor(pose: Pose, bones: string[]): number {
  const first = pose.bones[bones[0]];
  const child = bones[1] ? pose.bones[bones[1]] : undefined;
  const parentScale = first.local.scaleX !== 0 ? Math.hypot(first.world[0], first.world[1]) / Math.abs(first.local.scaleX) : 1;
  const psx = Math.abs(first.local.scaleX);
  const csx = child ? Math.abs(child.local.scaleX) : 1;
  const f = parentScale * psx * ((csx + 1) / 2);
  return f > 1e-9 ? f : 1;
}
