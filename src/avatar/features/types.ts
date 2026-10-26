/**
 * The FEATURE PIPELINE of the avatar builder. An avatar is built by a fixed list of feature modules
 * (./index.ts: head, body, eyes, mouth, brows, cheeks, hair, attachments, sprites, animations);
 * each contributes to the stages through this one small interface and never touches shared code:
 *
 *   layers(ctx)   stage 1, buildAvatarLayers (slow, has the pixels): cut layer images out of the
 *                 base, fill what they hide, measure curves and colours; add metadata for stage 2.
 *   compile(ctx)  stage 2, compileAvatar (pure and fast, runs in the browser on every handle drag,
 *                 WITHOUT pixels): add parameters, warps, parts, bindings, physics and animations
 *                 to the model under construction.
 *   poses(ctx)    optional extra poses for the review sheets (`rev2d avatar poses`).
 *
 * Rules every feature follows:
 * - Only its own file changes. What it shares with others goes through the contexts below.
 * - Ids: model ids start with the feature's own prefix (eyeL..., mouth..., hair..., att_<id>...);
 *   layer ids likewise. The builder throws on a duplicate id.
 * - Draw order: every part gets a `z` from its feature's range in AVATAR_Z (../builder.ts).
 * - Everything a feature adds is parented (directly or through its own nested warps) to the root
 *   warp `ctx.root`, so it follows head turn, tilt, body sway and breath without doing anything.
 * - A layer drawn over the base either has the base cut / filled under it, or is an interior patch
 *   whose warp offsets vanish at its rect edge (DESIGN.md §3; fields.ts: rectFadeWeight, pinEdges).
 * - compile() must work with the metadata of an OLDER layer build of the same spec shape (the
 *   editor recompiles while handles are dragged; layers are rebuilt later) and without its own
 *   metadata at all (then it adds nothing, or falls back to what the spec alone allows).
 * - Deterministic: no clocks, no randomness (image/random.ts has a seeded generator).
 */
import type { ImageRGBA } from '../../core/types.js';
import type { ModelBuilder, WarpHandle } from '../builder.js';
import type { AvatarMetrics, RectTuple } from '../fields.js';
import type { LabImage } from '../image/color.js';
import type { Mask } from '../image/types.js';
import type { AvatarIssue, AvatarPose, AvatarSpec, LayerInfo, LayersMeta } from '../types.js';

export type FeatureId = 'head' | 'body' | 'arms' | 'expressions' | 'eyes' | 'mouth' | 'brows' | 'cheeks' | 'hair' | 'attachments' | 'sprites' | 'animations';

export interface AvatarFeature {
  id: FeatureId;
  /** One line: what the feature adds to an avatar. */
  summary: string;
  layers?(ctx: LayersContext): void;
  compile?(ctx: CompileContext): void;
  poses?(ctx: PosesContext): AvatarPose[];
}

/** Collects the issues and statistics of a stage; both end up in the AvatarReport. */
export interface ReportSink {
  /** Something the author should look at. `path` is a JSON pointer into avatar.json. */
  warning(code: string, message: string, extra?: { path?: string; hint?: string }): void;
  /** A note that needs no action. */
  info(code: string, message: string, extra?: { path?: string; hint?: string }): void;
  /** A count or measurement, e.g. stat('hairCoverage', 0.31). Names are camelCase, prefixed by the feature where ambiguous. */
  stat(name: string, value: number): void;
  readonly issues: AvatarIssue[];
  readonly stats: Record<string, number>;
}

// ----------------------------------------------------------------------------- stage 1: layers

export interface LayersContext {
  spec: AvatarSpec;
  metrics: AvatarMetrics;
  /** The illustration. NEVER modify it: every feature may read the original pixels. */
  readonly source: ImageRGBA;
  /**
   * The base layer under construction: starts as a copy of the source. A feature that cuts a moving
   * layer out of the picture replaces it with the picture behind that layer (`ctx.base = inpaint(...)`),
   * so later features and the final base see the hole filled. Same size as the source, always.
   */
  base: ImageRGBA;
  /** Metadata of the previous build of this project, when there is one (to reuse slow results). */
  readonly previous?: LayersMeta;
  /** CIE Lab of the source, computed once on first use and shared by all features. */
  sourceLab(): LabImage;
  /**
   * Add a layer image. `id` becomes the layer id, the texture id and the file name
   * (textures/<id>.png); `rect` is where the image sits in the source ([x, y, width, height], whole
   * pixels, the image's own size). Throws on a duplicate id or a size mismatch.
   */
  addLayer(id: string, image: ImageRGBA, rect: RectTuple): LayerInfo;
  /**
   * Store this feature's metadata for stage 2 (plain JSON: sampled curves, colours, rects). It is
   * written to textures/layers.json under `key`, by convention the feature id.
   */
  setMeta(key: string, value: unknown): void;
  /**
   * The pixels that moving layers have taken out of the picture so far: the union (per-pixel
   * maximum) of every mask passed to claim(), full size, 0..1. A feature that cuts a layer claims
   * the layer's coverage; a later feature reads `claimed` to stay out of it (a hair mask grown by
   * colour must not creep into lashes and irises the eye feature already took). Read only: change
   * it through claim().
   */
  readonly claimed: Mask;
  /** Add a mask to `claimed`. A mask smaller than the picture sits at (x, y) of the source. */
  claim(mask: Mask, x?: number, y?: number): void;
  /** Mark a drawn variant as accepted and cut into sprites (LayersMeta.variants). */
  addVariant(id: string): void;
  report: ReportSink;
}

// ----------------------------------------------------------------------------- stage 2: compile

/** What the fold checker should know about the model (see ../folds.ts FoldPlan). */
export interface FoldPlanSink {
  /** Also check this pose (explicit parameter values), e.g. a strand at its limit with the head turned. */
  pose(params: Record<string, number>): void;
  /** Cells of this warp / part collapse to zero area by design (a closing eye): report real flips only. */
  collapsible(kind: 'warp' | 'part', id: string): void;
  /** Do not check this warp / part. */
  skip(kind: 'warp' | 'part', id: string): void;
}

export interface CompileContext {
  spec: AvatarSpec;
  /** Layer metadata of the last layer build (possibly older than the spec, see the rules above). */
  meta: LayersMeta;
  metrics: AvatarMetrics;
  /** The model under construction. */
  model: ModelBuilder;
  /**
   * The root warp "avatarWarp": ONE lattice over the whole image. The base image is its child; so
   * is everything a feature adds. Small motions that need no cut (brows, a wobbling bun) are extra
   * bindings on it: `ctx.model.bindField(ctx.root, {...})`; bindings on one warp add up.
   */
  root: WarpHandle;
  /** A layer of the build by id (undefined when the layer stage did not produce it). */
  layer(id: string): LayerInfo | undefined;
  /** The metadata a feature stored with LayersContext.setMeta (undefined when absent). */
  featureMeta<T>(key: string): T | undefined;
  folds: FoldPlanSink;
  report: ReportSink;
}

// ----------------------------------------------------------------------------- review poses

export interface PosesContext {
  spec: AvatarSpec;
  meta: LayersMeta;
  metrics: AvatarMetrics;
}
