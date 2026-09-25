/**
 * Zod input fragments shared by several tools. Descriptions are what the agent reads in tools/list,
 * so they spell out units and conventions.
 */
import { z } from 'zod';
import { parseColor } from '../core/color.js';
import { OVERLAY_LAYERS, type FrameInput, type PoseInput } from '../api/index.js';
import type { EditorCommand } from '../node/editor-registry.js';
import { ToolError } from './context.js';

export const pathField = z
  .string()
  .min(1)
  .describe('Model file (*.r2d.json), absolute or relative to the MCP server working directory.');

export const saveToField = z
  .string()
  .min(1)
  .optional()
  .describe('Also write the PNG to this path (relative to the working directory; directories are created).');

const rectDescription = '[x, y, width, height] in model (setup-space) px';

/**
 * Longest pose time accepted. Physics is simulated step by step from t=0 at 60 Hz, so an absurd time
 * (a timestamp, milliseconds) would stall the server; looping animations wrap anyway.
 */
export const MAX_TIME = 3600;

/** The layer string syntax (parsed by the API), for field descriptions. */
export const LAYER_STRINGS =
  '"id", "id@weight" (0..1), plus comma options: add | override (param tracks add on top instead of replacing), once | hold (once: nothing outside the layer window instead of holding its first/last key; a loop with once and start > 0 is silent before start), start=<s> (global time the layer starts; a loop without once also plays before it, phase-shifted), time=<s> (fixed layer time); e.g. ["idle", "blink@0.5"], ["look_around", "talk@0.8,add"], ["idle", "wink,once,start=2.5"]';

export const poseShape = {
  time: z
    .number()
    .min(0)
    .max(MAX_TIME)
    .optional()
    .describe(`Time in SECONDS (default 0, max ${MAX_TIME}). Drives the animations and physics (simulated from t=0 at 60 Hz).`),
  animations: z
    .array(
      z.union([
        z.string().min(1),
        z.strictObject({
          id: z.string().min(1),
          time: z.number().min(0).max(MAX_TIME).optional().describe('Fixed layer-local time in seconds (default: follows `time`, minus `start`).'),
          weight: z.number().min(0).max(1).optional().describe('Blend weight 0..1 (default 1).'),
          mode: z
            .enum(['override', 'add'])
            .optional()
            .describe('How param tracks combine with the layers below: "override" (default, blend toward the track value; later layers win) or "add" (add weight * (value - default) on top, e.g. talk over look_around).'),
          start: z.number().min(-MAX_TIME).max(MAX_TIME).optional().describe('Global time in seconds at which the layer starts (layer time = time - start). Default 0.'),
          hold: z
            .boolean()
            .optional()
            .describe('Outside the layer window: true (default) = a one-shot holds its first/last key values and a loop keeps playing (also before start); false = contributes nothing there: a one-shot only plays in [start, start + duration] (a wink that must stop), a loop only from start on (needs start > 0).'),
        }),
      ]),
    )
    .optional()
    .describe(`Animation layers, applied in order (later layers win for param tracks). Strings: ${LAYER_STRINGS}. Or objects {id, weight?, mode?, start?, hold?, time?}.`),
  params: z
    .record(z.string(), z.number())
    .optional()
    .describe('Parameter overrides, e.g. {"AngleX": 30, "EyeOpen": 0}. Override animation values; clamped to [min, max].'),
  physics: z.boolean().optional().describe('Simulate physics (default: true when the model has physics groups).'),
};

export const viewBoxField = z
  .union([z.literal('fit'), z.array(z.number()).length(4)])
  .optional()
  .describe(`Region to show: ${rectDescription}, or "fit" = bounds of the visible parts + padding. Default: the whole canvas.`);

export const frameShape = {
  ...poseShape,
  overlay: z
    .array(z.enum(OVERLAY_LAYERS))
    .optional()
    .describe(
      'Debug layers drawn on top: bones (joints + direction), mesh (triangles), warps (lattices), bounds (part boxes), labels (ids), grid (model-px grid with coordinates).',
    ),
  only: z
    .array(z.string().min(1))
    .min(1)
    .optional()
    .describe('Overlay focus: the bones/warps/mesh/bounds/labels layers draw only these bone, warp or part ids (the grid is unaffected), e.g. ["upperArm", "foreArm"].'),
  onlyChain: z.boolean().optional().describe('With `only`: also draw the ancestor bones of the listed bones (their chain up to the root).'),
  scale: z
    .number()
    .positive()
    .max(16)
    .optional()
    .describe(
      'Output px per model px. Default: auto (1; reduced so the longest side is <= 1024 px; small regions enlarged up to 4x to reach 512 px).',
    ),
  viewBox: viewBoxField,
  padding: z.number().min(0).optional().describe('Padding in model px around viewBox "fit" (default 16).'),
  background: z.string().min(1).optional().describe('Background color override, e.g. "#ffffff", "rgb(32, 36, 44)" or "transparent" (default: meta.background).'),
};

export type PoseArgs = { time?: number; animations?: PoseInput['animations']; params?: Record<string, number>; physics?: boolean };

export type FrameArgs = PoseArgs & {
  overlay?: FrameInput['overlay'];
  only?: string[];
  onlyChain?: boolean;
  scale?: number;
  viewBox?: 'fit' | number[];
  padding?: number;
  background?: string;
};

export function toPoseInput(a: PoseArgs): PoseInput {
  return { time: a.time, animations: a.animations, params: a.params, physics: a.physics };
}

/** Validate a [x,y,w,h] array (schema checks the length; this checks the size). */
export function toViewBox(v: 'fit' | number[] | undefined, field = 'viewBox'): FrameInput['viewBox'] {
  if (v === undefined || v === 'fit') return v;
  const [x, y, w, h] = v;
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) {
    throw new ToolError(`${field} must be ${rectDescription} with positive width and height, got [${v.join(', ')}]`);
  }
  return [x, y, w, h];
}

export function toFrameInput(a: FrameArgs): FrameInput {
  if (a.background !== undefined && parseColor(a.background) === null) {
    throw new ToolError(`background "${a.background}" is not a color`, [], 'use "#rgb", "#rrggbb", "#rrggbbaa", "rgb(r, g, b)", "rgba(r, g, b, a)", a basic name like "white", or "transparent"');
  }
  return {
    ...toPoseInput(a),
    overlay: a.overlay,
    ...(a.only ? { only: a.only } : {}),
    ...(a.onlyChain !== undefined ? { onlyChain: a.onlyChain } : {}),
    scale: a.scale,
    viewBox: toViewBox(a.viewBox),
    padding: a.padding,
    background: a.background,
  };
}

// ----------------------------------------------------------------------------- editor commands

const animationLayer = z.strictObject({
  id: z.string().min(1),
  weight: z.number().min(0).max(1).optional().describe('Blend weight 0..1 (default 1).'),
  mode: z.enum(['override', 'add']).optional().describe('"override" (default) or "add" (param tracks add on top of the layers below).'),
  start: z.number().optional().describe('Global time in seconds at which the layer starts (default 0).'),
  hold: z.boolean().optional().describe('false = contributes nothing outside the layer window: a one-shot only plays in [start, start + duration], a loop only from start on (needs start > 0). Default true: a one-shot holds its first/last keys, a loop also plays before start.'),
});

/** Mirrors EditorCommand (src/node/editor-registry.ts). */
export const editorCommandSchema = z
  .discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('setParams'),
      params: z.record(z.string(), z.number()).describe('Parameter values to set, e.g. {"AngleX": 30}.'),
      reset: z.boolean().optional().describe('Reset all other parameters to their defaults first.'),
    }),
    z.strictObject({ type: z.literal('play'), animation: z.string().min(1).optional() }),
    z.strictObject({ type: z.literal('pause') }),
    z.strictObject({ type: z.literal('seek'), time: z.number().min(0).describe('Seconds.') }),
    z.strictObject({ type: z.literal('setAnimations'), animations: z.array(animationLayer) }),
    z.strictObject({
      type: z.literal('select'),
      ids: z
        .array(z.string())
        .describe('Ids to select: bare ids ("mouth") or "kind:id" with kind part, bone, warp, param, animation, binding (id or index), ik, physics or texture, e.g. "param:AngleX", "binding:0". [] clears the selection.'),
    }),
    z.strictObject({ type: z.literal('setOverlay'), overlay: z.array(z.enum(OVERLAY_LAYERS)) }),
    z.strictObject({
      type: z.literal('focus'),
      viewBox: z.union([z.literal('fit'), z.array(z.number()).length(4)]).describe(`"fit" or ${rectDescription}.`),
    }),
    z.strictObject({ type: z.literal('reload') }),
    z.strictObject({
      type: z.literal('open'),
      file: z
        .string()
        .min(1)
        .describe("Model file to open (relative to the working directory, or absolute); it must lie inside the editor's workspace root."),
    }),
    z.strictObject({ type: z.literal('message'), text: z.string().min(1).describe('Shown to the human in the editor.') }),
  ])
  .describe('Command for the editor UI; see the tool description for the variants.');

export type EditorCommandArgs = z.output<typeof editorCommandSchema>;

export function toEditorCommand(c: EditorCommandArgs): EditorCommand {
  if (c.type === 'focus') return { type: 'focus', viewBox: toViewBox(c.viewBox, 'focus.viewBox') ?? 'fit' };
  return c;
}
