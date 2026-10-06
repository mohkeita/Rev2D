/**
 * The one AI controller of the editor page, and the editor session it works for.
 *
 * The panel binds the session when it mounts (and so does every hook of api.ts); before that the
 * session is taken from the page's automation hook (main.tsx sets window.__rev2d before anything can
 * call this module), so openAiPanel / startAiTask work from any module at any time.
 */
import { AI_PANEL_ID } from '../shell/registry.js';
import type { Session } from '../state/session.js';
import { jobContext, workContext, type WorkContext } from './context.js';
import { AiController } from './store.js';

let bound: Session | null = null;

export function bindSession(session: Session): void {
  bound = session;
}

export function currentSession(): Session | null {
  if (bound) return bound;
  const hook = (globalThis as { __rev2d?: { session?: Session } }).__rev2d;
  return hook?.session ?? null;
}

/** Where a request works: the open model and its folder. */
export function currentWorkContext(): WorkContext {
  const s = currentSession()?.get();
  return workContext(s?.file ?? null, s?.workspace?.root ?? null);
}

export const ai = new AiController({ context: (given) => jobContext(currentWorkContext(), given) });

/** Show the AI panel in the trailing sidebar. */
export function showPanel(): void {
  currentSession()?.showTrailingPanel(AI_PANEL_ID);
}
