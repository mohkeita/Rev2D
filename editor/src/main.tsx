import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './design/index.js';
import { App } from './App.js';
import { initLanguage } from './i18n/index.js';
import { COMPACT_WIDTH, loadLayout } from './shell/layout.js';
import { initMaterials } from './shell/settings.js';
import type { AppState } from './state/app.js';
import { SessionContext } from './state/context.js';
import { Session } from './state/session.js';

/**
 * Automation hook for tests and AI-driven browsers: read-only state and render counters. Not a
 * control surface (use the server's POST /api/command for that).
 */
export interface Rev2dTestHook {
  session: Session;
  state(): AppState;
  stats(): {
    /** A valid model is loaded and at least one frame with draw calls was rendered. */
    ready: boolean;
    status: AppState['status'];
    /** Absolute path of the open model ('' when none is open: status 'empty', the start screen). */
    file: string;
    connection: AppState['connection'];
    modelVersion: number;
    mtimeMs: number;
    frames: number;
    draws: number;
    triangles: number;
    errors: number;
  };
}

declare global {
  interface Window {
    __rev2d?: Rev2dTestHook;
  }
}

// Before the first paint: the language (stored choice, else the browser's), solid materials when
// there is no GPU, and the remembered panes, so nothing flips right after it appears.
initLanguage();
initMaterials();

const session = new Session();
session.store.set({ panels: loadLayout().panels });
session.setCompact(window.innerWidth < COMPACT_WIDTH);

window.__rev2d = {
  session,
  state: () => session.get(),
  stats: () => {
    const s = session.get();
    const r = session.renderStats;
    return {
      ready: s.status === 'ready' && s.model !== null && r.frames > 0 && r.draws > 0,
      status: s.status,
      file: s.file,
      connection: s.connection,
      modelVersion: s.modelVersion,
      mtimeMs: s.mtimeMs,
      frames: r.frames,
      draws: r.draws,
      triangles: r.triangles,
      errors: s.diagnostics.filter((d) => d.severity === 'error').length,
    };
  },
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SessionContext.Provider value={session}>
      <App />
    </SessionContext.Provider>
  </StrictMode>,
);

void session.start();

// Close the event stream promptly when the page goes away (kept alive for back/forward cache restores).
window.addEventListener('pagehide', (e) => {
  if (!e.persisted) session.dispose();
});
