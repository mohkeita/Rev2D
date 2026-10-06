/**
 * React access to the avatar store, and whether avatar mode is what the window shows.
 */
import { useStore, shallowEqual } from '../state/store.js';
import type { AppState } from '../state/app.js';
import { getModes, resolveMode } from '../shell/registry.js';
import { avatarStore, type AvatarState } from './store.js';

export { shallowEqual };

/** Select a slice of the avatar state (re-renders when it changes per `equal`). */
export function useAvatar<S>(selector: (s: AvatarState) => S, equal?: (a: S, b: S) => boolean): S {
  return useStore(avatarStore.store, selector, equal);
}

export const AVATAR_MODE = 'avatar';

/** Whether the window shows avatar mode (also for an avatar project without a built model). */
export function avatarActive(app: AppState): boolean {
  return resolveMode(getModes(), app)?.id === AVATAR_MODE;
}
