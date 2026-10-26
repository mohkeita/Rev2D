/**
 * The feature pipeline in its fixed order. Both build stages (../layers.ts, ../compile.ts) and the
 * review poses (../poses.ts) walk this list from top to bottom, so:
 *
 * - `head` and `body` come first: they declare AngleX / AngleY / AngleZ / BodyAngleX / Breath, which
 *   later features use as physics inputs;
 * - the face features (eyes, mouth, brows, cheeks) cut and fill the base before `hair` and
 *   `attachments` take their layers (which lie in front of the face);
 * - `sprites` (drawn variants) comes after the features whose layers it replaces;
 * - `animations` is last: it only drives parameters and must see all of them.
 *
 * To implement a feature, edit its own file; this list does not change.
 */
import { animations } from './animations.js';
import { attachments } from './attachments.js';
import { body } from './body.js';
import { arms } from './arms.js';
import { brows } from './brows.js';
import { cheeks } from './cheeks.js';
import { expressions } from './expressions.js';
import { eyes } from './eyes.js';
import { hair } from './hair.js';
import { head } from './head.js';
import { mouth } from './mouth.js';
import { sprites } from './sprites.js';
import type { AvatarFeature } from './types.js';

export const AVATAR_FEATURES: readonly AvatarFeature[] = [head, body, arms, eyes, mouth, brows, cheeks, hair, attachments, sprites, expressions, animations];

export type { AvatarFeature, CompileContext, FeatureId, FoldPlanSink, LayersContext, PosesContext, ReportSink } from './types.js';
export { createReportSink, mergeReports } from './report.js';
export { HEAD_TUNING, headTiltField, headTiltWeight, headTurnField } from './head.js';
export { BODY_TUNING, bodySwayField, breathField } from './body.js';
