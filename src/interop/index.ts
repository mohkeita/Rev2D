/**
 * Format interop: Spine skeleton JSON + atlas (import and export) and the Live2D Cubism JSON files
 * (motion3, exp3, physics3, cdi3, model3). Pure converters; file IO for the CLI, the MCP server and
 * the editor server lives in src/node/interop.ts. See docs/INTEROP.md.
 */
export * from './types.js';
export * from './spine/index.js';
export * from './live2d/index.js';
export { atlasPageNames, detectInteropFile, formatLabel, isAtlasName, live2dFormatFromName, looksLikeSpineSkeleton, type DetectedFormat } from './detect.js';
