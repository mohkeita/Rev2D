import { createContext, useContext } from 'react';
import type { AppState } from './app.js';
import type { Session } from './session.js';
import { useStore } from './store.js';

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error('useSession: no <SessionContext.Provider> above this component');
  return s;
}

/** Select a slice of the app state; re-renders only when the slice changes (per `equal`). */
export function useApp<S>(selector: (s: AppState) => S, equal?: (a: S, b: S) => boolean): S {
  return useStore(useSession().store, selector, equal);
}
