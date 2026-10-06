/**
 * Agent tools of the avatar builder: pure functions on ImageRGBA (the CLI and the editor server
 * encode the results as PNG).
 *
 *   avatarGrid(source, {region?, step?, scale?})         coordinate grid: how coordinates are read
 *   avatarOverlay(source, doc, {part?, zoom?, grid?})    the spec's parts drawn over the illustration
 *   makeVisionCheck({seed?, size?}) / scoreVisionCheck(key, answer)
 *                                                        can this agent read coordinates off an image?
 *
 * Failed calls (a region outside the image, an unknown part, nothing to draw) throw AvatarToolError
 * with a hint.
 */
export { avatarGrid, type GridOptions, type GridResult } from './grid.js';
export { avatarOverlay, type OverlayOptions, type OverlayResult } from './overlay.js';
export {
  makeVisionCheck,
  scoreVisionCheck,
  VISION_CHECK_MARKERS,
  type VisionCheck,
  type VisionCheckKey,
  type VisionCheckMarkerScore,
  type VisionCheckOptions,
  type VisionCheckScore,
} from './vision-check.js';
export { AvatarToolError, type SourceRegion } from './view.js';
