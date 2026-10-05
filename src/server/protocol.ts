/**
 * Validation of editor-protocol payloads: view state (POST /api/state), commands (POST /api/command),
 * workspace requests (POST /api/open|new|save-as|import), interop requests (POST /api/live2d-import,
 * /api/export) and screenshot query parameters. Errors are HttpErrors naming the offending field and
 * the fix.
 */
import { z } from 'zod';
import type { EditorCommand, EditorState, ImportRequest, NewRequest, OpenRequest, SaveAsRequest } from '../node/editor-registry.js';
import type { ExportRequest, Live2dImportRequest } from '../node/interop.js';
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
  open: {
    schema: z.strictObject({ type: z.literal('open'), file: z.string().min(1, 'expected a non-empty path') }),
    shape: '{"type":"open","file":"<model path: absolute, or relative to the workspace root>"}',
  },
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

// ----------------------------------------------------------------------------- workspace requests

const FilePath = z.string().min(1, 'expected a non-empty path');
const CanvasSize = z.number().int('expected an integer').positive('expected a size > 0').max(8192, 'expected at most 8192');

function parseRequest<T>(what: string, schema: z.ZodType<T>, body: unknown, shape: string): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new HttpError(400, `invalid ${what} request: ${issuesText(r.error)}`, `expected ${shape}`);
  return r.data;
}

export function parseOpenRequest(body: unknown): OpenRequest {
  return parseRequest('open', z.strictObject({ file: FilePath }), body, '{"file": "<model path: absolute, or relative to the workspace root>"}');
}

export function parseNewRequest(body: unknown): NewRequest {
  return parseRequest(
    'new',
    z.strictObject({
      file: FilePath,
      template: z.string().min(1).optional(),
      name: z.string().optional(),
      width: CanvasSize.optional(),
      height: CanvasSize.optional(),
      overwrite: z.boolean().optional(),
    }),
    body,
    '{"file": "<path>.r2d.json", "template"?: "<name from GET /api/templates, default blank>", "name"?: "<meta.name>", "width"?: 1..8192, "height"?: 1..8192, "overwrite"?: <boolean>}',
  );
}

export function parseSaveAsRequest(body: unknown): SaveAsRequest {
  const req = parseRequest(
    'save-as',
    z.strictObject({
      file: FilePath,
      doc: z.unknown().optional(),
      text: z.string().optional(),
      overwrite: z.boolean().optional(),
    }),
    body,
    '{"file": "<path>.r2d.json", "doc"?: {<model>} | "text"?: "<raw JSON/JSONC>" (neither: the open model file as it is on disk), "overwrite"?: <boolean>}',
  );
  if (req.doc !== undefined && req.text !== undefined) {
    throw new HttpError(400, 'invalid save-as request: send "doc" or "text", not both', 'doc = the model object (formatted on write), text = the raw file contents');
  }
  if (req.doc !== undefined && (typeof req.doc !== 'object' || req.doc === null || Array.isArray(req.doc))) {
    throw new HttpError(400, 'invalid save-as request: "doc" must be a JSON object (the whole model)', 'or send the raw file contents as "text"');
  }
  return req;
}

/** Most files one import may carry. */
export const MAX_IMPORT_FILES = 64;

export function parseImportRequest(body: unknown): ImportRequest {
  const req = parseRequest(
    'import',
    z.strictObject({
      dir: z.string().optional(),
      files: z
        .array(z.strictObject({ name: z.string().min(1, 'expected a file name'), text: z.string().optional(), base64: z.string().optional() }))
        .min(1, 'expected at least one file')
        .max(MAX_IMPORT_FILES, `expected at most ${MAX_IMPORT_FILES} files`),
      overwrite: z.boolean().optional(),
    }),
    body,
    '{"dir"?: "<target directory relative to the workspace root>", "files": [{"name": "hero.r2d.json", "text": "<JSON>"}, {"name": "hero.png", "base64": "<PNG bytes>"}], "overwrite"?: <boolean>}',
  );
  req.files.forEach((f, i) => {
    if ((f.text === undefined) === (f.base64 === undefined)) {
      throw new HttpError(400, `invalid import request: files.${i} (${JSON.stringify(f.name)}) needs exactly one of "text" (UTF-8) or "base64"`, 'models may be sent as text or base64, PNG textures as base64');
    }
  });
  return req;
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

// ----------------------------------------------------------------------------- interop requests

const ParamMapSpec = z.union([z.enum(['standard', 'none', 'prefix']), z.record(z.string(), z.string())]);
const PARAM_MAP_SHAPE = '"standard" | "none" | "prefix" | {"<Rev2D id>": "<Live2D id>"}';

export function parseLive2dImportRequest(body: unknown): Live2dImportRequest {
  return parseRequest(
    'live2d-import',
    z.strictObject({
      files: z
        .array(z.strictObject({ name: z.string().min(1, 'expected a file name'), text: z.string() }))
        .min(1, 'expected at least one file')
        .max(MAX_IMPORT_FILES, `expected at most ${MAX_IMPORT_FILES} files`),
      doc: z.record(z.string(), z.unknown()).optional(),
      paramMap: ParamMapSpec.optional(),
      id: z.string().min(1).optional(),
      physics: z.enum(['replace', 'merge', 'skip']).optional(),
      displayInfo: z.enum(['fill', 'overwrite', 'skip']).optional(),
      motions: z.boolean().optional(),
      expressions: z.boolean().optional(),
    }),
    body,
    `{"files": [{"name": "idle.motion3.json", "text": "<JSON>"}], "doc"?: {<model>}, "paramMap"?: ${PARAM_MAP_SHAPE}, "id"?: "<animation id>", "physics"?: "replace"|"merge"|"skip", "displayInfo"?: "fill"|"overwrite"|"skip", "motions"?: <boolean>, "expressions"?: <boolean>}`,
  );
}

export function parseExportRequest(body: unknown): ExportRequest {
  const req = parseRequest(
    'export',
    z.strictObject({
      format: z.enum(['spine', 'live2d']),
      dir: z.string().min(1).optional(),
      doc: z.record(z.string(), z.unknown()).optional(),
      overwrite: z.boolean().optional(),
      animations: z.array(z.string().min(1)).optional(),
      fps: Size.optional(),
      name: z.string().min(1).optional(),
      tolerance: z.number().min(0).optional(),
      textureScale: Size.optional(),
      paramPoses: z.boolean().optional(),
      premultipliedAlpha: z.boolean().optional(),
      paramMap: ParamMapSpec.optional(),
    }),
    body,
    `{"format": "spine"|"live2d", "dir"?: "<folder relative to the workspace root>", "doc"?: {<model>}, "overwrite"?: <boolean>, "animations"?: ["<id>"], "fps"?: <n>, "name"?: "<base file name>", "tolerance"?: <n>, spine: "textureScale"?, "paramPoses"?, "premultipliedAlpha"?; live2d: "paramMap"?: ${PARAM_MAP_SHAPE}}`,
  );
  const spineOnly = (['textureScale', 'paramPoses', 'premultipliedAlpha'] as const).filter((k) => req[k] !== undefined);
  if (req.format === 'live2d' && spineOnly.length) throw new HttpError(400, `invalid export request: ${spineOnly.join(', ')} only apply to "spine"`, 'remove them');
  if (req.format === 'spine' && req.paramMap !== undefined) throw new HttpError(400, 'invalid export request: paramMap only applies to "live2d"', 'remove it');
  return req;
}
