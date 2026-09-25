/**
 * High-level operations shared by the CLI, the MCP server and the editor server.
 * Inputs/outputs are JSON-friendly so they can be exposed to AI agents unchanged.
 *
 *   errors.ts    ApiError and message helpers
 *   layers.ts    animation layer syntax ("talk@0.8,add", "wink,once,start=2")
 *   pose.ts      PoseInput -> checked PoseOptions
 *   frame.ts     single frames, overlays, view boxes
 *   sampling.ts  time lists, animation sample plans (window, warm-up), sequential poses, frame events
 *   stats.ts     statistics and notes over poses (IK reach, physics clamping, view box)
 *   sheet.ts     sweeps, sequences, contact sheets (animation, sweeps, overview)
 *   inspect.ts   numeric inspection, time series, track tables, posed points
 *   analyze.ts   animation analysis (ranges, physics, IK, events, loop seam, canvas)
 *   docs.ts      summaries derived from the bundled docs (recipe list of docs/RECIPES.md)
 */
import { buildRenderList } from '../core/rig.js';
import type { LoadedModel } from '../node/load.js';
import { requireRig, toPoseOptions, type PoseInput } from './pose.js';

export { ApiError, idHint, listIds } from './errors.js';
export {
  LAYER_SYNTAX,
  parseLayerSpec,
  parseLayerSyntax,
  splitLayerList,
  isLayerOption,
  toLayer,
  formatLayerLabel,
  formatLayerSpec,
  type LayerInput,
} from './layers.js';
export { requireRig, toPoseOptions, checkTime, checkParams, type PoseInput } from './pose.js';
export {
  OVERLAY_LAYERS,
  FIT_PADDING,
  RectAccumulator,
  checkOnlyIds,
  fitViewBox,
  posesBounds,
  renderFrame,
  renderPose,
  resolveViewBox,
  sharedViewBox,
  unionBounds,
  type FrameInput,
  type FrameResult,
  type ViewBox,
} from './frame.js';
export {
  MAX_SAMPLE_TIMES,
  parseTimeSpec,
  planOptions,
  planSamples,
  sampleEvents,
  samplePlanNotes,
  samplePoses,
  sequenceTimes,
  type SampleInput,
  type SamplePlan,
} from './sampling.js';
export { PoseStats, SNAP_EXTENSION, viewSplit, coverBounds, clipMasks, type IkStats, type ParamStats, type PartFrameStats, type PhysicsOutputStats } from './stats.js';
export {
  MAX_SWEEP_VALUES,
  SHEET_DEFAULT_FRAMES,
  SWEEP_DEFAULT_STEPS,
  buildSheet,
  fitSheetScale,
  linspace,
  parseSweep,
  renderSequence,
  renderSheet,
  sheetCaption,
  sweepClampNotes,
  sweepLabel,
  type OverviewInput,
  type SequenceInput,
  type SequenceResult,
  type SheetInput,
  type SheetResult,
  type Sweep,
} from './sheet.js';
export {
  TRACK_COLUMN_FORMS,
  inspectPose,
  inspectSeries,
  parsePointSpec,
  parseTrackColumns,
  summarizePose,
  trackSeries,
  type InspectInput,
  type InspectResult,
  type PointQuery,
  type PointResult,
  type SeriesInput,
  type TrackCell,
  type TrackResult,
} from './inspect.js';
export { ANALYZE_FPS, analyzeAnimation, formatAnalysis, type AnalyzeInput, type AnalyzeResult } from './analyze.js';
export { modelInfo, formatInfo, type ModelInfo } from './info.js';
export { RECIPES_SUMMARY, recipeTitles, recipesDescription } from './docs.js';

// ----------------------------------------------------------------------------- hit testing

export interface HitResult {
  partId: string;
  kind: 'fill' | 'stroke';
}

/** Parts whose deformed triangles contain (x, y), top-most first. Ignores masks and texture alpha. */
export function hitTest(m: LoadedModel, input: PoseInput & { x: number; y: number }): HitResult[] {
  const rig = requireRig(m);
  const pose = rig.pose(toPoseOptions(rig.model, input));
  const list = buildRenderList(rig, pose);
  const hits: HitResult[] = [];
  for (let d = list.draws.length - 1; d >= 0; d--) {
    const item = list.draws[d];
    const p = item.positions;
    const idx = item.indices;
    for (let t = 0; t + 2 < idx.length; t += 3) {
      if (pointInTriangle(input.x, input.y, p[idx[t] * 2], p[idx[t] * 2 + 1], p[idx[t + 1] * 2], p[idx[t + 1] * 2 + 1], p[idx[t + 2] * 2], p[idx[t + 2] * 2 + 1])) {
        if (!hits.some((h) => h.partId === item.partId && h.kind === item.kind)) hits.push({ partId: item.partId, kind: item.kind });
        break;
      }
    }
  }
  return hits;
}

function pointInTriangle(px: number, py: number, ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}
