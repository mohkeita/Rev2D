/**
 * Validation of editor-protocol payloads: view state (POST /api/state), commands (POST /api/command)
 * and screenshot query parameters. Errors are HttpErrors naming the offending field and the fix.
 */
import { z } from 'zod';
import type { EditorCommand, EditorState } from '../node/editor-registry.js';
import { OVERLAY_LAYERS } from '../api/index.js';
import type { OverlayLayer } from '../render/index.js';
import { HttpError } from './http.js';

const Finite = z.number().refine(Number.isFinite, 'expected a finite number');
const Size = z.number().refine((n) => Number.isFinite(n) && n > 0, 'expected a width/height > 0');
const ViewBox = z.tuple([Finite, Finite, Size, Size]);
const Params = z.record(z.string(), Finite);
const AnimationLayers = z.array(
  z.strictObject({
    id: z.string(),
    weight: Finite.optional(),
    mode: z.enum(['override', 'add']).optional(),
    start: Finite.optional(),
    hold: z.boolean().optional(),
  }),
);
const LAYER_SHAPE = '{id, weight?: 0..1, mode?: "override"|"add", start?: seconds, hold?: boolean}';

function issuesText(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`).join('; ');
}

// ----------------------------------------------------------------------------- view state

/** Missing fields get neutral defaults; unknown extra fields are kept for the UI's own use. */
const StateSchema = z.looseObject({
  file: z.string().optional(),
  params: Params.default({}),
  time: Finite.default(0),
  animations: AnimationLayers.default([]),
  playing: z.boolean().default(false),
  selection: z.array(z.string()).default([]),
  overlay: z.array(z.string()).default([]),
  viewBox: ViewBox.nullable().default(null),
  physics: z.boolean().optional(),
  hidden: z.array(z.string()).optional(),
  pinned: z.array(z.string()).optional(),
  updatedAt: z.string().optional(),
});

export function parseEditorState(body: unknown, file: string): EditorState {
  const r = StateSchema.safeParse(body);
  if (!r.success) {
    throw new HttpError(
      400,
      `invalid editor state: ${issuesText(r.error)}`,
      `expected {params: {<id>: number}, time: seconds, animations: [${LAYER_SHAPE}], playing, selection: [ids], overlay: [layers], viewBox: [x, y, w > 0, h > 0] | null, physics?: boolean, hidden?: [part ids], pinned?: [param ids], updatedAt}`,
    );
  }
  return { ...r.data, file, updatedAt: r.data.updatedAt ?? new Date().toISOString() };
}

// ----------------------------------------------------------------------------- commands

const COMMANDS: Record<EditorCommand['type'], { schema: z.ZodType<EditorCommand>; shape: string }> = {
  setParams: {
    schema: z.strictObject({ type: z.literal('setParams'), params: Params, reset: z.boolean().optional() }),
    shape: '{"type":"setParams","params":{"<id>":<number>},"reset"?:<boolean>}',
  },
  play: { schema: z.strictObject({ type: z.literal('play'), animation: z.string().optional() }), shape: '{"type":"play","animation"?:"<id>"}' },
  pause: { schema: z.strictObject({ type: z.literal('pause') }), shape: '{"type":"pause"}' },
  seek: { schema: z.strictObject({ type: z.literal('seek'), time: Finite }), shape: '{"type":"seek","time":<seconds>}' },
  setAnimations: {
    schema: z.strictObject({ type: z.literal('setAnimations'), animations: AnimationLayers }),
    shape: '{"type":"setAnimations","animations":[{"id":"<id>","weight"?:<0..1>,"mode"?:"override"|"add","start"?:<seconds>,"hold"?:<boolean>}]}',
  },
  select: { schema: z.strictObject({ type: z.literal('select'), ids: z.array(z.string()) }), shape: '{"type":"select","ids":["<id>"]}' },
  setOverlay: {
    schema: z.strictObject({ type: z.literal('setOverlay'), overlay: z.array(z.string()) }),
    shape: `{"type":"setOverlay","overlay":[${OVERLAY_LAYERS.map((l) => `"${l}"`).join('|')}]}`,
  },
  focus: {
    schema: z.strictObject({ type: z.literal('focus'), viewBox: z.union([ViewBox, z.literal('fit')]) }),
    shape: '{"type":"focus","viewBox":[x,y,w,h] (w, h > 0) | "fit"}',
  },
  reload: { schema: z.strictObject({ type: z.literal('reload') }), shape: '{"type":"reload"}' },
  message: { schema: z.strictObject({ type: z.literal('message'), text: z.string() }), shape: '{"type":"message","text":"<text>"}' },
};

export const COMMAND_TYPES = Object.keys(COMMANDS) as Array<EditorCommand['type']>;

export function parseCommand(body: unknown): EditorCommand {
  const type = (body as { type?: unknown } | null)?.type;
  if (typeof body !== 'object' || body === null || Array.isArray(body) || typeof type !== 'string') {
    throw new HttpError(400, 'a command must be a JSON object with a string "type"', `types: ${COMMAND_TYPES.join(', ')}`);
  }
  const spec = Object.hasOwn(COMMANDS, type) ? COMMANDS[type as EditorCommand['type']] : undefined;
  if (!spec) throw new HttpError(400, `unknown command type "${type}"`, `types: ${COMMAND_TYPES.join(', ')}`);
  const r = spec.schema.safeParse(body);
  if (!r.success) throw new HttpError(400, `invalid "${type}" command: ${issuesText(r.error)}`, `expected ${spec.shape}`);
  return r.data;
}

// ----------------------------------------------------------------------------- screenshots

/** Largest screenshot the server renders, in output pixels. */
export const MAX_SCREENSHOT_PIXELS = 2048 * 2048;
const MAX_SCALE = 16;

export interface ScreenshotQuery {
  /** Undefined: use the editor's overlay. */
  overlay?: OverlayLayer[];
  /** Undefined: 1, reduced when that would exceed MAX_SCREENSHOT_PIXELS. */
  scale?: number;
  /** Undefined: the editor's visible region (else the canvas). */
  viewBox?: [number, number, number, number] | 'fit' | 'canvas';
}

export function parseScreenshotQuery(q: URLSearchParams): ScreenshotQuery {
  const out: ScreenshotQuery = {};
  const overlay = q.get('overlay');
  if (overlay !== null) {
    const layers = overlay.split(',').map((s) => s.trim()).filter(Boolean);
    const bad = layers.filter((l) => l !== 'all' && l !== 'none' && !(OVERLAY_LAYERS as string[]).includes(l));
    if (bad.length) {
      throw new HttpError(400, `unknown overlay layer(s): ${bad.join(', ')}`, `layers: ${OVERLAY_LAYERS.join(', ')}, or all / none (comma-separated; empty = none)`);
    }
    out.overlay = layers.includes('all') ? [...OVERLAY_LAYERS] : (layers.filter((l) => l !== 'none') as OverlayLayer[]);
  }
  const scale = q.get('scale');
  if (scale !== null) {
    const s = Number(scale);
    if (!scale.trim() || !Number.isFinite(s) || s <= 0 || s > MAX_SCALE) {
      throw new HttpError(400, `bad scale "${scale}"`, `a number in (0, ${MAX_SCALE}], e.g. scale=0.5`);
    }
    out.scale = s;
  }
  const vb = q.get('viewBox');
  if (vb !== null) {
    if (vb === 'fit' || vb === 'canvas') {
      out.viewBox = vb;
    } else {
      const n = vb.split(',').map((s) => (s.trim() ? Number(s) : NaN));
      if (n.length !== 4 || !n.every(Number.isFinite) || n[2] <= 0 || n[3] <= 0) {
        throw new HttpError(400, `bad viewBox "${vb}"`, 'use "fit", "canvas" or "x,y,w,h" in model pixels with w, h > 0');
      }
      out.viewBox = n as [number, number, number, number];
    }
  }
  return out;
}
