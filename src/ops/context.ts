/** State shared by the ops of one applyOps batch. */
import type { TextureInfo } from '../core/types.js';
import type { Doc } from './model.js';

export interface OpContext {
  /** The working copy of the model (mutated in place; discarded when any op fails). */
  doc: Doc;
  /** Known texture sizes by id (from ApplyOpsOptions.textures). */
  textures: Record<string, TextureInfo>;
}
