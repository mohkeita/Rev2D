/**
 * Shared contracts for format interop (Spine, Live2D JSON files). Pure (no Node APIs): converters
 * take parsed data / decoded images and return raw Rev2D JSON plus the files to write. File IO lives
 * in src/node/interop.ts.
 *
 * Coordinate systems: Spine is y-up with counter-clockwise degrees; Rev2D is y-down (canvas pixels)
 * with clockwise degrees. Live2D motion/physics files work on parameter ids and values only.
 */
import type { ImageRGBA } from '../core/types.js';

export type InteropFormat =
  | 'spine'
  | 'live2d-model3'
  | 'live2d-motion3'
  | 'live2d-physics3'
  | 'live2d-exp3'
  | 'live2d-cdi3';

export interface InteropIssue {
  severity: 'warning' | 'info';
  /** Stable kebab-case code, e.g. "spine-dark-color", "live2d-unknown-parameter". */
  code: string;
  message: string;
  /** Location in the SOURCE data, e.g. "bones[3] (hip)" or "animations.walk.slots.head.rgba2". */
  where?: string;
  /** How to work around it, when there is a way. */
  hint?: string;
}

export interface InteropReport {
  format: InteropFormat;
  direction: 'import' | 'export';
  /** Everything that was approximated, dropped or needs attention. Never silently lose data. */
  issues: InteropIssue[];
  /** Counts of what was converted, e.g. {bones: 12, slots: 20, animations: 3, deformKeys: 480}. */
  stats: Record<string, number>;
}

export interface OutputFile {
  /** Path relative to the output directory / the model file, '/'-separated. */
  path: string;
  /** Text content (JSON, atlas) or binary content (PNG). Exactly one is set. */
  text?: string;
  bytes?: Uint8Array;
}

// ----------------------------------------------------------------------------- Spine

export interface SpineImportInput {
  /** Skeleton JSON (text or parsed object), Spine 3.8 / 4.0 / 4.1 / 4.2 export format. */
  skeleton: string | Record<string, unknown>;
  /** Texture atlas text (.atlas); required when attachments reference regions. */
  atlas?: string;
  /** Decoded atlas page images by page file name as written in the atlas (e.g. "spineboy.png"). */
  pages?: Record<string, ImageRGBA>;
  /** Rev2D model name (default: skeleton file name or "spine"). */
  name?: string;
  /** Skin to import (default "default"; other skins are reported). */
  skin?: string;
  /** Extra uniform scale applied to the skeleton (default 1). */
  scale?: number;
  /** Canvas padding around the skeleton bounds in px (default 32). */
  padding?: number;
}

export interface SpineImportResult {
  /** Raw Rev2D model JSON (write with formatModelJson). Texture paths point at `files`. */
  doc: Record<string, unknown>;
  /** Files to write next to the model (atlas page PNGs). */
  files: OutputFile[];
  report: InteropReport;
}

export interface SpineExportOptions {
  /** Animations to export (default: all). */
  animations?: string[];
  /**
   * Sampling rate for baked motion (default 30). Key times are sampled too, and intervals where the
   * pose leaves the linear interpolation of its neighbours are halved (up to 5 times, not below
   * 1/480 s, or 1/60 s for models with physics).
   */
  fps?: number;
  /** Raster scale for part textures (default 1; 2 for crisper vector parts). */
  textureScale?: number;
  /** Maximum atlas page size in px (default 2048). */
  maxPageSize?: number;
  /**
   * Key reduction tolerance (default 0.05): px for translations and deform offsets, degrees for
   * rotations; scales use tolerance / 100 and colors tolerance × 0.04 (0.05 ≈ 0.5 / 255). Samples are
   * reduced to linear and Bézier keys within it. 0 keeps every sampled key (linear).
   */
  tolerance?: number;
  /** Also export each parameter's min / max pose as a one-frame animation "param/<id>/min|max". */
  paramPoses?: boolean;
  /** Base file name for the skeleton/atlas/pages (default: model name). */
  name?: string;
  /** Target Spine JSON version string written to skeleton.spine (default "4.2.00"). */
  spineVersion?: string;
  /**
   * Write premultiplied-alpha atlas pages ("pma: true", default true). Spine runtimes default to
   * premultiplied alpha, and their multiply / screen blend modes are only correct with it. false writes
   * straight alpha (with alpha bleeding); runtimes must then be configured with premultipliedAlpha false.
   */
  premultipliedAlpha?: boolean;
}

export interface SpineExportResult {
  /** <name>.json, <name>.atlas and the page PNGs. */
  files: OutputFile[];
  report: InteropReport;
}

// ----------------------------------------------------------------------------- Live2D

/**
 * Maps Rev2D parameter ids to Live2D parameter ids and back. The built-in "standard" preset maps the
 * names used by the Rev2D examples to Live2D's standard ids (AngleX <-> ParamAngleX,
 * MouthOpen <-> ParamMouthOpenY, ...); unmapped ids pass through unchanged.
 */
export interface ParamMap {
  toLive2d: Record<string, string>;
  fromLive2d: Record<string, string>;
}

export interface Live2dImportOptions {
  /** Parameter id mapping (default: the standard preset). */
  paramMap?: ParamMap;
  /** Target Rev2D model (raw JSON or normalized) used to check ids/ranges and report unknown parameters. */
  model?: Record<string, unknown>;
}

export interface Live2dExportOptions {
  paramMap?: ParamMap;
  /** Frame rate written to Meta.Fps and used where curves must be sampled (default 30). */
  fps?: number;
}
