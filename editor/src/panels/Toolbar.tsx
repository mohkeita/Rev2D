import { errorCount, warningCount, BACKGROUND_MODES, OVERLAY_LAYERS, type BackgroundMode, type OverlayLayer } from '../state/app.js';
import { useApp, useSession } from '../state/context.js';
import { shallowEqual } from '../state/store.js';
import { Icon, type IconName } from '../ui/icons.js';
import { basename } from '../ui/text.js';

const OVERLAY_META: Record<OverlayLayer, { icon: IconName; label: string; key: string }> = {
  bones: { icon: 'bone', label: 'Bones', key: 'B' },
  mesh: { icon: 'mesh', label: 'Mesh', key: 'M' },
  warps: { icon: 'warp', label: 'Warps', key: 'W' },
  bounds: { icon: 'bounds', label: 'Bounds', key: 'X' },
  labels: { icon: 'label', label: 'Labels', key: 'L' },
  grid: { icon: 'grid', label: 'Grid', key: 'G' },
};

const BACKGROUND_LABEL: Record<BackgroundMode, string> = {
  model: 'Model background',
  checker: 'Transparency checker',
  dark: 'Dark',
  light: 'Light',
};

export function Toolbar() {
  const session = useSession();
  const file = useApp((s) => s.file);
  const modelName = useApp((s) => s.model?.meta.name ?? null);
  const unsaved = useApp((s) => s.unsaved);
  const saving = useApp((s) => s.saving);
  const history = useApp((s) => ({ canUndo: s.canUndo, canRedo: s.canRedo, undo: s.undoLabel, redo: s.redoLabel }), shallowEqual);
  const overlays = useApp((s) => s.overlays);
  const background = useApp((s) => s.background);

  return (
    <header className="toolbar" data-testid="toolbar">
      <div className="brand" title="Rev2D editor">
        <span className="brand-mark" aria-hidden="true" />
        <span className="brand-name">Rev2D</span>
      </div>
      <div className="file-chip" title={file || 'no file'}>
        <span className="file-name">{file ? basename(file) : '—'}</span>
        {modelName && <span className="file-model">{modelName}</span>}
        {saving ? <span className="saving-dot" title="Saving…" /> : unsaved ? <span className="unsaved-dot" title="Not saved to disk (Ctrl+S)" /> : null}
      </div>

      <div className="tool-group">
        <button className="icon-button" disabled={!history.canUndo} title={history.undo ? `Undo ${history.undo} (Ctrl+Z)` : 'Undo (Ctrl+Z)'} onClick={() => void session.undo()}>
          <Icon name="undo" />
        </button>
        <button className="icon-button" disabled={!history.canRedo} title={history.redo ? `Redo ${history.redo} (Ctrl+Shift+Z)` : 'Redo (Ctrl+Shift+Z)'} onClick={() => void session.redo()}>
          <Icon name="redo" />
        </button>
        <button className="icon-button" title="Save (Ctrl+S)" onClick={() => void session.save()}>
          <Icon name="save" />
        </button>
      </div>

      <div className="tool-group segmented" role="group" aria-label="Overlays">
        {OVERLAY_LAYERS.map((layer) => {
          const meta = OVERLAY_META[layer];
          const on = overlays.includes(layer);
          return (
            <button
              key={layer}
              className={`seg-button${on ? ' is-on' : ''}`}
              aria-pressed={on}
              title={`${meta.label} overlay (${meta.key})`}
              onClick={() => session.toggleOverlay(layer)}
              data-testid={`overlay-${layer}`}
            >
              <Icon name={meta.icon} />
              <span className="seg-label">{meta.label}</span>
            </button>
          );
        })}
      </div>

      <div className="tool-group swatches" role="group" aria-label="Background">
        {BACKGROUND_MODES.map((mode) => (
          <button
            key={mode}
            className={`swatch swatch-${mode}${background === mode ? ' is-on' : ''}`}
            title={`Background: ${BACKGROUND_LABEL[mode]}`}
            aria-pressed={background === mode}
            onClick={() => session.setBackground(mode)}
          />
        ))}
      </div>

      <div className="toolbar-spacer" />
      <ProblemsBadge />
      <BridgeIndicator />
      <button className="icon-button" title="Keyboard shortcuts (?)" onClick={() => session.store.set({ helpOpen: true })}>
        <Icon name="help" />
      </button>
    </header>
  );
}

function ProblemsBadge() {
  const session = useSession();
  const counts = useApp((s) => ({ e: errorCount(s.diagnostics), w: warningCount(s.diagnostics) }), shallowEqual);
  const cls = counts.e ? 'has-errors' : counts.w ? 'has-warnings' : 'is-clean';
  return (
    <button
      className={`problems-badge ${cls}`}
      title="Validation problems (click to open)"
      onClick={() => session.showDock('problems')}
      data-testid="problems-badge"
    >
      {counts.e === 0 && counts.w === 0 ? (
        <>
          <Icon name="check" />
          <span>Valid</span>
        </>
      ) : (
        <>
          <Icon name="error" />
          <span>{counts.e}</span>
          <Icon name="warning" />
          <span>{counts.w}</span>
        </>
      )}
    </button>
  );
}

function BridgeIndicator() {
  const connection = useApp((s) => s.connection);
  const bridge = useApp((s) => s.bridge);
  const live = connection === 'live';
  const title = [
    live ? 'AI bridge live: AI tools can read this view (/api/state) and send commands.' : 'AI bridge offline: reconnecting to the editor server…',
    bridge ? `Last command: ${bridge.text} at ${new Date(bridge.at).toLocaleTimeString()}` : 'No commands received yet.',
  ].join('\n');
  return (
    <div className={`bridge ${live ? 'is-live' : connection === 'connecting' ? 'is-connecting' : 'is-offline'}`} title={title} data-testid="bridge">
      {/* Re-mounted per command so its CSS flash animation replays. */}
      {bridge && <span key={bridge.at} className="bridge-flash" />}
      <Icon name="bolt" size={14} />
      <span>AI bridge</span>
      <span className="bridge-state">{live ? 'live' : connection === 'connecting' ? '…' : 'offline'}</span>
    </div>
  );
}
