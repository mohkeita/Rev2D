/** Floating UI layers: toasts, the keyboard shortcut sheet and the load-failure screen. */
import { useEffect } from 'react';
import { useApp, useSession } from '../state/context.js';
import { Icon } from '../ui/icons.js';

export function Toasts() {
  const session = useSession();
  const toasts = useApp((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite" data-testid="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
          <Icon name={t.kind === 'error' ? 'error' : t.kind === 'warning' ? 'warning' : t.kind === 'success' ? 'check' : 'info'} />
          <div className="toast-body">
            {t.source && <span className="toast-source">{t.source}</span>}
            <span className="toast-text">{t.text}</span>
          </div>
          {t.action && (
            <button
              className="button button-small"
              onClick={() => {
                t.action!.run();
                session.dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button className="icon-button icon-button-small" title="Dismiss" onClick={() => session.dismissToast(t.id)}>
            <Icon name="close" size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

const SHORTCUTS: Array<[string, Array<[string, string]>]> = [
  [
    'Viewport',
    [
      ['Wheel', 'Zoom at cursor'],
      ['Middle / right drag', 'Pan'],
      ['Space + drag', 'Pan'],
      ['Click', 'Select part / bone joint (click again to cycle stacked parts)'],
      ['Shift + click', 'Add / remove from selection'],
      ['F', 'Frame selection (or the whole model)'],
      ['Shift + F', 'Frame the canvas'],
      ['1', 'Zoom 100%'],
      ['+ / −', 'Zoom in / out'],
      ['Esc', 'Clear selection'],
    ],
  ],
  [
    'Overlays & preview',
    [
      ['B  M  W  X  L  G', 'Bones, mesh, warps, bounds, labels, grid'],
      ['H', 'Hide selected parts (preview only)'],
      ['Alt + H', 'Show all parts'],
    ],
  ],
  [
    'Playback',
    [
      ['Space', 'Play / pause'],
      ['← / →', 'Previous / next frame'],
      ['Home', 'Go to start'],
    ],
  ],
  [
    'Editing',
    [
      ['Ctrl + S', 'Save the document'],
      ['Ctrl + Z', 'Undo inspector edit'],
      ['Ctrl + Shift + Z  Ctrl + Y', 'Redo'],
      ['Ctrl + Enter', 'Apply inspector JSON (Ctrl + S also applies while editing it)'],
      ['Double-click slider', 'Reset parameter'],
      ['?', 'This help'],
    ],
  ],
];

export function ShortcutsHelp() {
  const session = useSession();
  const open = useApp((s) => s.helpOpen);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') session.store.set({ helpOpen: false });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, session]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onClick={() => session.store.set({ helpOpen: false })}>
      <div className="modal" role="dialog" aria-label="Keyboard shortcuts" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Keyboard shortcuts</h2>
          <button className="icon-button" title="Close (Esc)" onClick={() => session.store.set({ helpOpen: false })}>
            <Icon name="close" />
          </button>
        </div>
        <div className="shortcut-grid">
          {SHORTCUTS.map(([title, rows]) => (
            <section key={title}>
              <h3>{title}</h3>
              <dl>
                {rows.map(([keys, what]) => (
                  <div key={keys} className="shortcut-row">
                    <dt>
                      {keys.split('  ').map((k) => (
                        <kbd key={k}>{k}</kbd>
                      ))}
                    </dt>
                    <dd>{what}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <p className="modal-foot muted">
          AI tools drive this editor through the local server: they read what you see (GET /api/state, /api/screenshot) and send
          commands (POST /api/command). Pointer coordinates in the status bar are model pixels you can quote to them.
        </p>
      </div>
    </div>
  );
}

export function LoadFailure() {
  const session = useSession();
  const status = useApp((s) => s.status);
  const error = useApp((s) => s.loadError);
  if (status !== 'failed') return null;
  return (
    <div className="modal-backdrop is-opaque">
      <div className="modal modal-narrow" role="alertdialog" aria-label="Model failed to load" data-testid="load-failure">
        <div className="modal-head">
          <h2>
            <Icon name="error" /> Could not load the model
          </h2>
        </div>
        <p className="mono error-text">{error}</p>
        <p className="muted">Check that the Rev2D editor server is still running and can read the model file, then retry.</p>
        <div className="modal-actions">
          <button className="button button-primary" onClick={() => void session.reload('reset', true)}>
            Retry
          </button>
        </div>
      </div>
    </div>
  );
}
