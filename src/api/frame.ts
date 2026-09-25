/** Single frames: pose -> render list -> image (+ overlays), and the view boxes frames are cut from. */
import type { ImageRGBA, Model, Pose, RenderList } from '../core/types.js';
import { Rig, buildRenderList } from '../core/rig.js';
import { parseColor } from '../core/color.js';
import { drawOverlay, renderImage, type OverlayLayer } from '../render/index.js';
import type { LoadedModel } from '../node/load.js';
import { ApiError, idHint, show } from './errors.js';
import { requireRig, toPoseOptions, type PoseInput } from './pose.js';

export const OVERLAY_LAYERS: OverlayLayer[] = ['bones', 'mesh', 'warps', 'bounds', 'labels', 'grid'];

export interface FrameInput extends PoseInput {
  overlay?: OverlayLayer[];
  /**
   * Overlay focus: only these bone / warp / part ids are drawn by the bones, warps, mesh, bounds and
   * labels layers (the grid is unaffected). Unknown ids are an ApiError with a did-you-mean hint.
   */
  only?: string[];
  /** With `only`: also draw the ancestor bones of the listed bones (their chain up to the root). */
  onlyChain?: boolean;
  /** Output pixels per model pixel. */
  scale?: number;
  /**
   * Explicit region [x,y,w,h] or 'fit' = bounds of the visible parts (+padding). Default: the canvas.
   * Multi-frame outputs (renderSequence, renderSheet) fit ONE box around the parts of all frames.
   */
  viewBox?: [number, number, number, number] | 'fit';
  /** Padding in model px used by viewBox 'fit' (finite, >= 0). Default 16. */
  padding?: number;
  background?: string;
  supersample?: number;
}

export interface FrameResult {
  image: ImageRGBA;
  pose: Pose;
  list: RenderList;
  viewBox: [number, number, number, number];
  scale: number;
}

export function renderFrame(m: LoadedModel, input: FrameInput = {}): FrameResult {
  const rig = requireRig(m);
  const pose = rig.pose(toPoseOptions(rig.model, input));
  return renderPose(m, rig, pose, input);
}

/** Check overlay `only` ids against the model's bones, warps and parts. */
export function checkOnlyIds(model: Model, only: unknown): string[] {
  if (only === undefined) return [];
  if (!Array.isArray(only) || !only.every((s) => typeof s === 'string')) {
    throw new ApiError(`only must be a list of bone, warp or part ids, got ${show(only)}`, [], 'e.g. ["upperArm", "foreArm"]');
  }
  const ids = [...model.bones.map((b) => b.id), ...model.warps.map((w) => w.id), ...model.parts.map((p) => p.id)];
  for (const id of only) {
    if (!ids.includes(id)) throw new ApiError(`unknown id "${id}" in overlay only`, [], idHint(id, ids, 'bones, warps or parts'));
  }
  return only as string[];
}

/** Render an already evaluated pose (used for sequential playback). */
export function renderPose(m: LoadedModel, rig: Rig, pose: Pose, input: FrameInput = {}): FrameResult {
  const list = buildRenderList(rig, pose, input.background ? { background: input.background } : {});
  const viewBox = resolveViewBox(rig.model, pose, input);
  const scale = input.scale ?? 1;
  const only = checkOnlyIds(rig.model, input.only);
  const image = renderImage(list, m.textures, {
    viewBox,
    scale,
    supersample: input.supersample,
    background: input.background ? parseColor(input.background) : null,
  });
  if (input.overlay?.length) {
    drawOverlay(
      image,
      { model: rig.model, pose, list },
      { layers: input.overlay, viewBox, scale, ...(only.length ? { only, onlyChain: input.onlyChain === true } : {}) },
    );
  }
  return { image, pose, list, viewBox, scale };
}

/** [x, y, w, h] in model px. */
export type ViewBox = [number, number, number, number];

/** Default padding (model px) around the visible parts for viewBox 'fit'. */
export const FIT_PADDING = 16;

/** The view box of one frame: explicit, 'fit' (visible parts + padding) or the canvas. */
export function resolveViewBox(model: Model, pose: Pose, input: FrameInput): ViewBox {
  return sharedViewBox(model, [pose], input);
}

/**
 * The one view box used for every frame of a multi-frame output (animation frames, sheet cells):
 * explicit `viewBox` as given; 'fit' = the union of the visible bounds of ALL poses plus padding
 * (so frames neither jitter nor change size); otherwise, or when no pose shows anything, the canvas.
 */
export function sharedViewBox(model: Model, poses: Iterable<Pose>, input: Pick<FrameInput, 'viewBox' | 'padding'>): ViewBox {
  if (Array.isArray(input.viewBox)) return input.viewBox;
  if (input.viewBox === 'fit') {
    const pad = input.padding ?? FIT_PADDING;
    if (typeof pad !== 'number' || !Number.isFinite(pad) || pad < 0) {
      throw new ApiError(`padding must be a finite number of model px >= 0, got ${show(pad)}`, [], `e.g. padding ${FIT_PADDING} (the default)`);
    }
    const fit = fitViewBox(poses, pad);
    if (fit) return fit;
  }
  return [0, 0, model.meta.width, model.meta.height];
}

/**
 * The 'fit' view box of several poses: the union of their visible bounds plus `padding` model px,
 * x/y floored and w/h ceiled (for one pose this is exactly the single-frame 'fit'). Null when no pose
 * shows anything.
 */
export function fitViewBox(poses: Iterable<Pose>, padding = FIT_PADDING): ViewBox | null {
  const b = posesBounds(poses);
  if (!b) return null;
  return [Math.floor(b[0] - padding), Math.floor(b[1] - padding), Math.ceil(b[2] + padding * 2), Math.ceil(b[3] + padding * 2)];
}

/** Union of the visible part bounds of several poses, or null when none shows anything. */
export function posesBounds(poses: Iterable<Pose>): ViewBox | null {
  const acc = new RectAccumulator();
  for (const pose of poses) acc.add(unionBounds(pose));
  return acc.rect();
}

/** Bounds of the visible parts of one pose, or null when nothing is visible. */
export function unionBounds(pose: Pose): ViewBox | null {
  const acc = new RectAccumulator();
  for (const id of pose.drawOrder) acc.add(pose.parts[id]?.bounds ?? null);
  return acc.rect();
}

/** Running union of [x, y, w, h] rects (min/max of the corners, so no float drift). */
export class RectAccumulator {
  private x0 = Infinity;
  private y0 = Infinity;
  private x1 = -Infinity;
  private y1 = -Infinity;
  add(b: readonly [number, number, number, number] | null | undefined): void {
    if (!b) return;
    this.x0 = Math.min(this.x0, b[0]);
    this.y0 = Math.min(this.y0, b[1]);
    this.x1 = Math.max(this.x1, b[0] + b[2]);
    this.y1 = Math.max(this.y1, b[1] + b[3]);
  }
  rect(): ViewBox | null {
    return this.x0 === Infinity ? null : [this.x0, this.y0, this.x1 - this.x0, this.y1 - this.y0];
  }
}
