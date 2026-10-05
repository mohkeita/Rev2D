/**
 * Recognizes the files interop works with, by name and content: Rev2D models, Spine skeleton JSON
 * and atlases, and the Live2D Cubism JSON files (model3, motion3, exp3, physics3, cdi3). Pure and
 * small (no converters), so the editor UI can use it to label picked files before they are sent.
 */
import { parseAtlas } from './spine/atlas.js';

export type DetectedFormat = 'rev2d' | 'spine' | 'live2d-model3' | 'live2d-motion3' | 'live2d-exp3' | 'live2d-physics3' | 'live2d-cdi3';

/** Live2D file kinds by their double extension (".motion3.json"). */
const LIVE2D_SUFFIX: Array<[RegExp, DetectedFormat]> = [
  [/\.model3\.json$/i, 'live2d-model3'],
  [/\.motion3\.json$/i, 'live2d-motion3'],
  [/\.exp3\.json$/i, 'live2d-exp3'],
  [/\.physics3\.json$/i, 'live2d-physics3'],
  [/\.cdi3\.json$/i, 'live2d-cdi3'],
];

const LABELS: Record<DetectedFormat, string> = {
  rev2d: 'Rev2D model',
  spine: 'Spine skeleton',
  'live2d-model3': 'Live2D model settings',
  'live2d-motion3': 'Live2D motion',
  'live2d-exp3': 'Live2D expression',
  'live2d-physics3': 'Live2D physics',
  'live2d-cdi3': 'Live2D display info',
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Human-readable name of a detected format ("Live2D motion"). */
export function formatLabel(format: DetectedFormat): string {
  return LABELS[format];
}

/** Whether a file name is a Live2D JSON file by its double extension. */
export function live2dFormatFromName(name: string): DetectedFormat | null {
  for (const [re, format] of LIVE2D_SUFFIX) if (re.test(name)) return format;
  return null;
}

/** Whether a file name looks like a Spine texture atlas (".atlas" or ".atlas.txt"). */
export function isAtlasName(name: string): boolean {
  return /\.atlas(\.txt)?$/i.test(name);
}

/**
 * Whether parsed JSON is a Spine skeleton export: a "bones" array of named bones plus the "skeleton"
 * header (hash, Spine version) or the other top-level sections of a skeleton (slots, skins,
 * animations). Rev2D models ("format": "rev2d") never match.
 */
export function looksLikeSpineSkeleton(value: unknown): boolean {
  if (!isObject(value) || value.format === 'rev2d') return false;
  const bones = value.bones;
  if (!Array.isArray(bones) || bones.length === 0 || !bones.every((b) => isObject(b) && typeof b.name === 'string')) return false;
  if (isObject(value.skeleton)) return true;
  return Array.isArray(value.slots) || value.skins !== undefined || isObject(value.animations);
}

/** The Live2D kind of parsed JSON from its content (used when the name does not say). */
function live2dFormatFromContent(value: Record<string, unknown>): DetectedFormat | null {
  if (isObject(value.FileReferences)) return 'live2d-model3';
  if (isObject(value.Meta) && Array.isArray(value.Curves)) return 'live2d-motion3';
  if (value.Type === 'Live2D Expression') return 'live2d-exp3';
  if (Array.isArray(value.PhysicsSettings)) return 'live2d-physics3';
  if (Array.isArray(value.Parameters) && (Array.isArray(value.ParameterGroups) || Array.isArray(value.Parts))) return 'live2d-cdi3';
  if (Array.isArray(value.Parameters) && value.Parameters.every((p) => isObject(p) && 'Blend' in p)) return 'live2d-exp3';
  return null;
}

/**
 * What a file is: the Live2D double extension decides first ("idle.motion3.json" is a motion even
 * when its content is broken: the converter reports what is wrong), then the content (`value` = the
 * parsed JSON; omit it to decide by name alone). Null when it is none of the known formats.
 */
export function detectInteropFile(name: string, value?: unknown): DetectedFormat | null {
  const byName = live2dFormatFromName(name);
  if (byName) return byName;
  if (value === undefined) return /\.r2d\.jsonc?$/i.test(name) ? 'rev2d' : null;
  if (!isObject(value)) return null;
  if (value.format === 'rev2d') return 'rev2d';
  if (looksLikeSpineSkeleton(value)) return 'spine';
  return live2dFormatFromContent(value);
}

/** Page image names of a Spine atlas ([] when the text is not a readable atlas). */
export function atlasPageNames(text: string): string[] {
  try {
    return parseAtlas(text).pages.map((p) => p.name);
  } catch {
    return [];
  }
}
