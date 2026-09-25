/**
 * Semantic checks for the static scene: meta, parameters, textures, bones, warps and parts.
 */
import type { Fill, Part, Shape } from '../types.js';
import { parseColor } from '../color.js';
import { parsePath, PathSyntaxError } from '../path.js';
import { SINGULAR, type SemanticContext } from './context.js';
import { toPointer } from './diagnostics.js';
import { detailOverrun, MAX_DETAIL_VERTICES, overflowingPathNumber } from './geometry-limits.js';
import { findCycles } from './graph.js';
import { partSetupBounds } from './part-bounds.js';
import { formatQuotedList, q, referenceHint } from './text.js';

const COLOR_HINT = 'use "#rgb", "#rrggbb", "#rrggbbaa", "rgba(r, g, b, a)" or a basic name like "white", "black", "red", "transparent"';
const PATH_HINT = 'supported commands: M L H V C S Q T A Z (absolute and relative), e.g. "M0 0 L100 0 L50 80 Z"';

function checkColor(ctx: SemanticContext, value: string, path: readonly PropertyKey[]): void {
  if (parseColor(value) === null) ctx.sink.error('invalid-color', path, `invalid color ${q(value)}`, COLOR_HINT);
}

export function checkMeta(ctx: SemanticContext): void {
  checkColor(ctx, ctx.model.meta.background, ['meta', 'background']);
}

export function checkParameters(ctx: SemanticContext): void {
  ctx.checkDuplicateIds('parameters');
  ctx.model.parameters.forEach((p, i) => {
    const at = ['parameters', i];
    if (p.min > p.max) {
      ctx.sink.error('param-range-inverted', [...at, 'min'], `min (${p.min}) is greater than max (${p.max})`, 'swap "min" and "max"');
    } else if (p.min === p.max) {
      ctx.sink.warning('param-range-empty', [...at, 'max'], `min and max are both ${p.min}, so the parameter cannot move`, 'widen the range, e.g. "min": 0, "max": 1');
    } else if (p.default !== undefined && (p.default < p.min || p.default > p.max)) {
      const clamped = Math.min(p.max, Math.max(p.min, p.default));
      ctx.sink.warning(
        'param-default-out-of-range',
        [...at, 'default'],
        `default ${p.default} is outside [${p.min}, ${p.max}] and will be clamped to ${clamped}`,
        `set "default" within the range, e.g. ${clamped}`,
      );
    }
    if (!ctx.boundParams.has(p.id) && !ctx.physicsInputs.has(p.id)) {
      const animated = ctx.animatedParams.get(p.id);
      ctx.sink.info(
        'unused-parameter',
        at,
        `parameter ${q(p.id)} does not drive anything (no binding or physics input uses it)`,
        animated
          ? `it is animated (${animated}) but has no visible effect; add a binding with "params": [${q(p.id)}]`
          : `use it in a binding ("params": [${q(p.id)}]) or as a physics input, or remove it`,
      );
    }
  });
}

export function checkTextures(ctx: SemanticContext): void {
  ctx.checkDuplicateIds('textures');
  ctx.model.textures.forEach((t, i) => {
    if (t.path.trim() === '') {
      ctx.sink.error('texture-empty-path', ['textures', i, 'path'], `texture ${q(t.id)} has an empty path`, 'a PNG path relative to the model file, or a data:image/png;base64,... URI');
    }
    if (!ctx.usedTextures.has(t.id)) {
      ctx.sink.info('unused-texture', ['textures', i], `texture ${q(t.id)} is not used by any image or mesh shape`, 'reference it from a part shape ("texture") or remove it');
    }
  });
}

export function checkBones(ctx: SemanticContext): void {
  ctx.checkDuplicateIds('bones');
  const { bones } = ctx.ids;
  ctx.model.bones.forEach((b, i) => {
    if (b.color !== undefined) checkColor(ctx, b.color, ['bones', i, 'color']);
    if (b.parent == null || bones.has(b.parent)) return;
    const path = ['bones', i, 'parent'];
    const section = ctx.sectionOf(b.parent);
    if (section) {
      ctx.sink.error('invalid-parent', path, `${q(b.parent)} is a ${SINGULAR[section]}; a bone's parent must be another bone`, 'bones can only be parented to bones (parent warps and parts to bones instead)');
    } else {
      ctx.sink.error('unknown-bone', path, `unknown parent bone ${q(b.parent)}`, referenceHint(b.parent, ctx.idsOf('bones'), 'bones'));
    }
  });
  for (const cycle of findCycles(ctx.model.bones.map((b) => b.id), (id) => ctx.boneParent(id))) {
    ctx.sink.error(
      'bone-cycle',
      ['bones', bones.get(cycle[0])!, 'parent'],
      `bone parent cycle: ${[...cycle, cycle[0]].map(q).join(' → ')}`,
      'a bone cannot be its own ancestor; remove "parent" from one of these bones',
    );
  }
}

/** Parent of a part or warp: must be a bone or a warp. */
function checkDeformerParent(ctx: SemanticContext, owner: 'part' | 'warp', parent: string, path: readonly PropertyKey[]): void {
  const { bones, warps } = ctx.ids;
  if (bones.has(parent) || warps.has(parent)) return;
  const section = ctx.sectionOf(parent);
  if (section) {
    const hint =
      owner === 'part' && section === 'parts'
        ? `parts cannot be nested; parent it to the bone or warp that ${q(parent)} follows, or use "mask": [${q(parent)}] to clip it`
        : 'parent it to a bone or warp id';
    ctx.sink.error('invalid-parent', path, `${q(parent)} is a ${SINGULAR[section]}; a ${owner}'s parent must be a bone or warp`, hint);
    return;
  }
  ctx.sink.error(
    'unknown-parent',
    path,
    `unknown parent ${q(parent)} (must be a bone or warp id)`,
    referenceHint(parent, [...ctx.idsOf('bones'), ...ctx.idsOf('warps')], 'bones or warps'),
  );
}

export function checkWarps(ctx: SemanticContext): void {
  ctx.checkDuplicateIds('warps');
  const { bones, warps } = ctx.ids;
  ctx.model.warps.forEach((w, i) => {
    // SPEC §2: bones and warps share one namespace because either can be a part's or warp's parent.
    const bone = bones.get(w.id);
    if (bone !== undefined && warps.get(w.id) === i) {
      ctx.sink.error(
        'duplicate-id',
        ['warps', i, 'id'],
        `warp id ${q(w.id)} is already used by bone ${toPointer(['bones', bone])}`,
        `bones and warps share one id namespace (either can be a "parent"); rename one of them, e.g. ${q(`${w.id}Warp`)}`,
      );
    }
    if (w.parent !== undefined) checkDeformerParent(ctx, 'warp', w.parent, ['warps', i, 'parent']);
  });
  const warpParent = (id: string) => {
    const w = ctx.model.warps[warps.get(id)!];
    return w.parent !== undefined && warps.has(w.parent) ? w.parent : undefined;
  };
  for (const cycle of findCycles(ctx.model.warps.map((w) => w.id), warpParent)) {
    ctx.sink.error(
      'warp-cycle',
      ['warps', warps.get(cycle[0])!, 'parent'],
      `warp parent cycle: ${[...cycle, cycle[0]].map(q).join(' → ')}`,
      'a warp cannot be nested inside itself; parent one of them to a bone or leave it in model space',
    );
  }
  ctx.model.warps.forEach((w, i) => {
    // Skip ambiguous parents (a bone shares the id: duplicate-id) and self-parenting (warp-cycle).
    if (w.parent === undefined || bones.has(w.parent)) return;
    const parentIndex = warps.get(w.parent);
    if (parentIndex !== undefined && parentIndex !== i) checkWarpInsideParent(ctx, i, parentIndex);
  });
  ctx.model.warps.forEach((w, i) => {
    if (ctx.parentRefs.has(w.id)) return;
    const driven = ctx.drivenWarps.has(w.id);
    ctx.sink.info(
      'unused-warp',
      ['warps', i],
      driven
        ? `warp ${q(w.id)} is bound/animated but deforms nothing (no part or warp has it as parent)`
        : `warp ${q(w.id)} has no children and nothing drives it`,
      driven ? `set "parent": ${q(w.id)} on the parts it should deform` : `parent parts to it and bind "warp:${w.id}.offsets", or remove it`,
    );
  });
}

/** Round for messages: at most 2 decimals, no "-0". */
function px(n: number): string {
  const r = Number(n.toFixed(2));
  return String(Object.is(r, -0) ? 0 : r);
}

function fmtRect(r: readonly number[]): string {
  return `[${r.map(px).join(', ')}]`;
}

/** The bone a warp ultimately follows through its warp parents (undefined: model space, or a broken chain). */
function followedBone(ctx: SemanticContext, warpIndex: number): string | undefined {
  const seen = new Set<number>();
  for (let i: number | undefined = warpIndex; i !== undefined && !seen.has(i); ) {
    seen.add(i);
    const parent: string | undefined = ctx.model.warps[i].parent;
    if (parent === undefined) return undefined;
    if (ctx.ids.bones.has(parent)) return parent;
    i = ctx.ids.warps.get(parent);
  }
  return undefined;
}

/**
 * A nested warp's rect should lie inside its parent warp's rect: points outside the parent lattice are
 * mapped by extrapolating the parent's edge cells, which exaggerates any deformation near the edge.
 */
function checkWarpInsideParent(ctx: SemanticContext, i: number, parentIndex: number): void {
  const child = ctx.model.warps[i];
  const parent = ctx.model.warps[parentIndex];
  const [x, y, w, h] = child.rect;
  const [px0, py0, pw, ph] = parent.rect;
  const EPS = 1e-6;
  const sides: Array<[string, number]> = [
    ['on the left', px0 - x],
    ['at the top', py0 - y],
    ['on the right', x + w - (px0 + pw)],
    ['at the bottom', y + h - (py0 + ph)],
  ];
  const out = sides.filter(([, by]) => by > EPS);
  if (out.length === 0) return;
  const ux = Math.min(x, px0);
  const uy = Math.min(y, py0);
  const union = [ux, uy, Math.max(x + w, px0 + pw) - ux, Math.max(y + h, py0 + ph) - uy];
  const bone = followedBone(ctx, parentIndex);
  const reparent = bone !== undefined ? `, or parent ${q(child.id)} to bone ${q(bone)} (which ${q(parent.id)} follows) instead` : '';
  ctx.sink.warning(
    'warp-outside-parent',
    ['warps', i, 'rect'],
    `warp ${q(child.id)} rect ${fmtRect(child.rect)} extends outside its parent warp ${q(parent.id)} rect ${fmtRect(parent.rect)} by ${out
      .map(([side, by]) => `${px(by)} px ${side}`)
      .join(', ')}; lattice points there are extrapolated from ${q(parent.id)}'s edge cells, so they drift or stretch more than the parent's border when it deforms`,
    `enlarge ${q(parent.id)} to cover it ("rect": ${fmtRect(union)}), shrink this rect to fit inside ${fmtRect(parent.rect)}${reparent}`,
  );
}

export function checkParts(ctx: SemanticContext): void {
  ctx.checkDuplicateIds('parts');
  ctx.model.parts.forEach((part, i) => {
    const at = ['parts', i];
    if (part.parent !== undefined) {
      if (part.skin) {
        ctx.sink.error('skin-with-parent', [...at, 'parent'], `part ${q(part.id)} has both "parent" and "skin"`, 'remove "parent": a skinned part already follows its skin bones');
      } else {
        checkDeformerParent(ctx, 'part', part.parent, [...at, 'parent']);
      }
    }
    if (checkShape(ctx, part.shape, [...at, 'shape'])) {
      checkDetail(ctx, part.shape, [...at, 'shape']);
      checkPartInsideWarp(ctx, i);
    } else {
      ctx.brokenShapes.add(part.id);
    }
    checkSkin(ctx, part, at);
    checkPaint(ctx, part, at);
    part.mask?.forEach((m, j) => {
      if (m === part.id) {
        ctx.sink.error('mask-self', [...at, 'mask', j], `part ${q(part.id)} cannot mask itself`, 'list the parts whose shapes should clip this one (e.g. the eye white for an iris)');
      } else {
        ctx.checkRef('parts', m, [...at, 'mask', j]);
      }
    });
  });
}

/** Overhang (px) of a part's setup bounds past its warp's rect that `part-outside-warp` tolerates. */
export const PART_OUTSIDE_WARP_TOLERANCE = 0.5;

/**
 * A part parented to a warp should lie inside the warp's rect: vertices outside the rest lattice are
 * mapped by extrapolating the edge cells, so they drift or stretch more than the warp's border does.
 */
function checkPartInsideWarp(ctx: SemanticContext, partIndex: number): void {
  const part = ctx.model.parts[partIndex];
  // Skinned parts ignore `parent` (skin-with-parent); a bone sharing the id is a duplicate-id error.
  if (part.parent === undefined || part.skin || ctx.ids.bones.has(part.parent)) return;
  const warpIndex = ctx.ids.warps.get(part.parent);
  if (warpIndex === undefined) return;
  const box = partSetupBounds(part, ctx.model.textures);
  if (box === null) return;
  const warp = ctx.model.warps[warpIndex];
  const [wx, wy, ww, wh] = warp.rect;
  const [x0, y0, x1, y1] = box;
  const left = wx - x0;
  const top = wy - y0;
  const right = x1 - (wx + ww);
  const bottom = y1 - (wy + wh);
  const tol = PART_OUTSIDE_WARP_TOLERANCE;
  const sides: Array<[string, number]> = [
    ['on the left', left],
    ['at the top', top],
    ['on the right', right],
    ['at the bottom', bottom],
  ];
  const out = sides.filter(([, by]) => by > tol);
  if (out.length === 0) return;
  // Covering rect: only the overhanging sides move, outward to whole pixels (ignoring float noise such
  // as 166 - 1e-14 from a rotated outline).
  const NOISE = 1e-6;
  const cx0 = left > tol ? Math.floor(x0 + NOISE) : wx;
  const cy0 = top > tol ? Math.floor(y0 + NOISE) : wy;
  const cx1 = right > tol ? Math.ceil(x1 - NOISE) : wx + ww;
  const cy1 = bottom > tol ? Math.ceil(y1 - NOISE) : wy + wh;
  const cover = [cx0, cy0, cx1 - cx0, cy1 - cy0];
  const stroke = part.stroke && part.stroke.width > 0 && part.stroke.align !== 'inside' ? ' incl. stroke' : '';
  ctx.sink.warning(
    'part-outside-warp',
    ['parts', partIndex, 'parent'],
    `part ${q(part.id)} (setup bounds ${fmtRect([x0, y0, x1 - x0, y1 - y0])}${stroke}) extends outside its parent warp ${q(warp.id)} rect ${fmtRect(warp.rect)} by ${out
      .map(([side, by]) => `${px(by)} px ${side}`)
      .join(', ')}; vertices there are extrapolated from ${q(warp.id)}'s edge cells, so they drift or stretch more than the warp's border when it deforms`,
    `enlarge ${q(warp.id)} to cover it ("rect": ${fmtRect(cover)}; its lattice points move with the rect, so re-check its offset keyforms)${reparentHint(ctx, part.id, warpIndex, box)}`,
  );
}

/** ", or parent <part> to <the nearest ancestor warp containing it | the bone the warp follows>", or "". */
function reparentHint(ctx: SemanticContext, partId: string, warpIndex: number, box: readonly number[]): string {
  const warp = ctx.model.warps[warpIndex];
  const tol = PART_OUTSIDE_WARP_TOLERANCE;
  const seen = new Set([warpIndex]);
  for (let parent = warp.parent; parent !== undefined && !ctx.ids.bones.has(parent); ) {
    const i = ctx.ids.warps.get(parent);
    if (i === undefined || seen.has(i)) break;
    seen.add(i);
    const w = ctx.model.warps[i];
    const [x, y, ww, wh] = w.rect;
    if (box[0] >= x - tol && box[1] >= y - tol && box[2] <= x + ww + tol && box[3] <= y + wh + tol) {
      return `, or parent ${q(partId)} to warp ${q(w.id)} (an ancestor of ${q(warp.id)} whose rect ${fmtRect(w.rect)} contains it)`;
    }
    parent = w.parent;
  }
  const bone = followedBone(ctx, warpIndex);
  return bone !== undefined
    ? `, or parent ${q(partId)} to bone ${q(bone)} (which ${q(warp.id)} follows; give it its own warp there if it must bend)`
    : '';
}

/** Geometry checks; returns false when the shape cannot be built. */
function checkShape(ctx: SemanticContext, shape: Shape, at: readonly PropertyKey[]): boolean {
  const { sink } = ctx;
  switch (shape.type) {
    case 'polygon': {
      const n = shape.points.length;
      if (n % 2 !== 0) {
        sink.error('polygon-odd-length', [...at, 'points'], `"points" has ${n} numbers; it must be an even-length list [x0, y0, x1, y1, ...]`, 'every point needs both an x and a y');
        return false;
      }
      if (n < 6) {
        sink.error('polygon-too-few-points', [...at, 'points'], `a polygon needs at least 3 points, got ${n / 2}`, 'e.g. "points": [0, 0, 100, 0, 50, 80]');
        return false;
      }
      return true;
    }
    case 'path': {
      const overflow = overflowingPathNumber(shape.d);
      if (overflow !== null) {
        sink.error('path-syntax', [...at, 'd'], `invalid SVG path: number ${q(overflow)} is too large`, 'path numbers must be finite');
        return false;
      }
      try {
        parsePath(shape.d);
      } catch (e) {
        if (!(e instanceof PathSyntaxError)) throw e;
        sink.error('path-syntax', [...at, 'd'], `invalid SVG path: ${e.message}`, PATH_HINT);
        return false;
      }
      return true;
    }
    case 'mesh':
      return checkMesh(ctx, shape, at);
    case 'image':
      ctx.checkRef('textures', shape.texture, [...at, 'texture']);
      return true;
    default:
      return true;
  }
}

function checkMesh(ctx: SemanticContext, mesh: Extract<Shape, { type: 'mesh' }>, at: readonly PropertyKey[]): boolean {
  const { sink } = ctx;
  let ok = true;
  const vertexCount = Math.floor(mesh.vertices.length / 2);
  if (mesh.vertices.length % 2 !== 0) {
    sink.error('mesh-odd-vertices', [...at, 'vertices'], `"vertices" has ${mesh.vertices.length} numbers; it must be an even-length list [x0, y0, x1, y1, ...]`);
    ok = false;
  }
  if (mesh.triangles.length % 3 !== 0) {
    sink.error('mesh-triangles-length', [...at, 'triangles'], `"triangles" has ${mesh.triangles.length} indices; it must be a multiple of 3 (one triple per triangle)`);
    ok = false;
  } else if (mesh.triangles.length === 0) {
    sink.warning('mesh-empty', [...at, 'triangles'], 'the mesh has no triangles, so nothing is drawn', 'e.g. "triangles": [0, 1, 2]');
  }
  const bad = mesh.triangles.flatMap((v, k) => (v >= vertexCount ? [k] : []));
  if (bad.length) {
    const k = bad[0];
    const more = bad.length > 1 ? ` (+${bad.length - 1} more out-of-range)` : '';
    sink.error(
      'mesh-index-out-of-range',
      [...at, 'triangles', k],
      `triangle index ${mesh.triangles[k]} is out of range: the mesh has ${vertexCount} vertices (valid 0..${vertexCount - 1})${more}`,
    );
    ok = false;
  }
  if (mesh.uvs !== undefined) {
    if (mesh.uvs.length !== mesh.vertices.length) {
      sink.error('mesh-uv-count', [...at, 'uvs'], `"uvs" has ${mesh.uvs.length} numbers but "vertices" has ${mesh.vertices.length}; they need one [u, v] per vertex`);
      ok = false;
    }
    if (mesh.texture === undefined) {
      sink.warning('mesh-uvs-without-texture', [...at, 'uvs'], '"uvs" are ignored without a "texture"', 'add "texture": "<textureId>" or remove "uvs"');
    }
  } else if (mesh.texture !== undefined) {
    sink.error(
      'mesh-missing-uvs',
      [...at, 'uvs'],
      `a textured mesh needs "uvs" to sample ${q(mesh.texture)}`,
      'add "uvs": one [u, v] pair per vertex (0..1 across the texture), in "vertices" order',
    );
  }
  if (mesh.texture !== undefined) ctx.checkRef('textures', mesh.texture, [...at, 'texture']);
  return ok;
}

/** `detail` must not refine the shape past the geometry compiler's vertex budget. */
function checkDetail(ctx: SemanticContext, shape: Shape, at: readonly PropertyKey[]): void {
  const overrun = detailOverrun(shape);
  if (overrun === null) return;
  ctx.sink.error(
    'detail-too-fine',
    [...at, 'detail'],
    `detail ${overrun.detail} would refine this shape into ~${Math.round(overrun.estimate)} vertices (limit ${MAX_DETAIL_VERTICES})`,
    `use "detail" >= ${roundUp(overrun.minDetail)} (8–16 px is typical for parts in warps or skinned parts)`,
  );
}

/** Round up to two significant digits (0.2962 -> 0.3, 1.053 -> 1.1, 12.3 -> 13). */
function roundUp(x: number): number {
  const step = 10 ** (Math.floor(Math.log10(x)) - 1);
  return Number((Math.ceil(x / step) * step).toPrecision(2));
}

function checkSkin(ctx: SemanticContext, part: Part, at: readonly PropertyKey[]): void {
  const skin = part.skin;
  if (!skin) return;
  const skinAt = [...at, 'skin'];
  const seen = new Set<string>();
  skin.bones.forEach((b, j) => {
    if (seen.has(b)) {
      ctx.sink.warning('skin-duplicate-bone', [...skinAt, 'bones', j], `bone ${q(b)} is listed twice`, 'list each influencing bone once');
    }
    seen.add(b);
    ctx.checkRef('bones', b, [...skinAt, 'bones', j]);
  });
  if (skin.weights === 'auto') return;
  const weights = skin.weights;
  const weightsAt = [...skinAt, 'weights'];
  if (part.shape.type !== 'mesh') {
    ctx.sink.error('skin-weights-not-mesh', weightsAt, `explicit weights need a mesh shape, but this part's shape is ${q(part.shape.type)}`, 'use "weights": "auto", or convert the part to a mesh shape');
    return;
  }
  const vertexCount = Math.floor(part.shape.vertices.length / 2);
  if (weights.length !== vertexCount) {
    ctx.sink.error('skin-weights-count', weightsAt, `${weights.length} weight rows for ${vertexCount} vertices; there must be one row per vertex`);
  }
  const width = skin.bones.length;
  const wrongRows = weights.flatMap((row, j) => (row.length !== width ? [j] : []));
  if (wrongRows.length) {
    const j = wrongRows[0];
    const more = wrongRows.length > 1 ? ` (${wrongRows.length - 1} more rows too)` : '';
    ctx.sink.error(
      'skin-weights-row-length',
      [...weightsAt, j],
      `weight row ${j} has ${weights[j].length} values but the skin has ${width} bones${more}`,
      `one weight per bone in "bones" order: ${formatQuotedList(skin.bones)}`,
    );
  }
  // Skinning divides by the row sum and leaves a vertex in place when it is ~0 (e.g. [0, 0] or [1, -1]).
  const zeroRows = weights.flatMap((row, j) => (row.length === width && Math.abs(row.reduce((s, w) => s + w, 0)) <= 1e-12 ? [j] : []));
  if (zeroRows.length) {
    const more = zeroRows.length > 1 ? ` (and ${zeroRows.length - 1} more)` : '';
    ctx.sink.warning(
      'skin-weights-zero-row',
      [...weightsAt, zeroRows[0]],
      `the weights of vertex ${zeroRows[0]} sum to 0${more}, so no bone moves it`,
      'give every vertex non-negative weights with at least one above 0',
    );
  }
}

function checkPaint(ctx: SemanticContext, part: Part, at: readonly PropertyKey[]): void {
  if (part.fill !== undefined) checkFill(ctx, part.fill, [...at, 'fill']);
  checkColor(ctx, part.tint, [...at, 'tint']);
  if (part.stroke) checkColor(ctx, part.stroke.color, [...at, 'stroke', 'color']);
}

function checkFill(ctx: SemanticContext, fill: Fill, at: readonly PropertyKey[]): void {
  if (typeof fill === 'string') return checkColor(ctx, fill, at);
  if (fill.type === 'solid') return checkColor(ctx, fill.color, [...at, 'color']);
  fill.stops.forEach(([, color], k) => checkColor(ctx, color, [...at, 'stops', k, 1]));
}
