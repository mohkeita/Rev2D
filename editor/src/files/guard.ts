/**
 * Unsaved-changes guard as a pure state machine.
 *
 * Before an action replaces the open document (New, Open, Open Recent, Import, Close, Reload from
 * disk, Save As out of an avatar project, a new avatar) the Session asks the guard, once per unsaved
 * document it replaces: a workspace mode's own document (avatar.json) first, then the model. A saved document proceeds at once; an unsaved one shows
 * "Save changes to X?" with [Save] [Don't save] [Cancel]. Save that fails keeps the prompt open with
 * the reason; when the model was rejected for validation errors, "Save anyway" (forced write) is
 * offered as well.
 *
 *   idle --request(clean)--> idle            effect: proceed
 *   idle --request(dirty)--> asking
 *   asking --save--> saving                  effect: save (the Session writes, then reports `saved`)
 *   asking --saveAnyway (canForce)--> saving effect: saveAnyway
 *   asking --discard--> idle                 effect: proceed
 *   asking --cancel--> idle                  effect: abort
 *   saving --saved ok--> idle                effect: proceed
 *   saving --saved failed--> asking (error, canForce = rejected as invalid)
 *   busy (asking/saving) --request--> unchanged, effect: abort (one prompt at a time)
 */
import { t } from '../i18n/index.js';

export type GuardChoice = 'save' | 'saveAnyway' | 'discard' | 'cancel';

export type GuardState =
  | { phase: 'idle' }
  | { phase: 'asking'; file: string; action: string; error: string | null; canForce: boolean }
  | { phase: 'saving'; file: string; action: string; force: boolean };

export type GuardEvent =
  | { type: 'request'; dirty: boolean; file: string; action: string }
  | { type: 'choose'; choice: GuardChoice }
  | { type: 'saved'; ok: boolean; error?: string; invalid?: boolean };

/** What the caller must do after a step. */
export type GuardEffect = 'proceed' | 'abort' | 'save' | 'saveAnyway' | null;

export const GUARD_IDLE: GuardState = { phase: 'idle' };

export function guardStep(state: GuardState, event: GuardEvent): { state: GuardState; effect: GuardEffect } {
  switch (event.type) {
    case 'request':
      if (state.phase !== 'idle') return { state, effect: 'abort' };
      if (!event.dirty) return { state, effect: 'proceed' };
      return { state: { phase: 'asking', file: event.file, action: event.action, error: null, canForce: false }, effect: null };

    case 'choose':
      if (state.phase !== 'asking') return { state, effect: null };
      switch (event.choice) {
        case 'save':
          return { state: { phase: 'saving', file: state.file, action: state.action, force: false }, effect: 'save' };
        case 'saveAnyway':
          if (!state.canForce) return { state, effect: null };
          return { state: { phase: 'saving', file: state.file, action: state.action, force: true }, effect: 'saveAnyway' };
        case 'discard':
          return { state: GUARD_IDLE, effect: 'proceed' };
        case 'cancel':
          return { state: GUARD_IDLE, effect: 'abort' };
      }
      return { state, effect: null };

    case 'saved':
      if (state.phase !== 'saving') return { state, effect: null };
      if (event.ok) return { state: GUARD_IDLE, effect: 'proceed' };
      return {
        state: {
          phase: 'asking',
          file: state.file,
          action: state.action,
          error: event.error ?? t('files.unsaved.saveFailed'),
          // A forced write can only help when the server refused the model for its errors.
          canForce: event.invalid === true && !state.force,
        },
        effect: null,
      };
  }
}
