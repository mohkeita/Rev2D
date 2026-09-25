import { useApp } from '../state/context.js';
import { shallowEqual } from '../state/store.js';
import { formatZoom } from '../view/camera.js';

function fmt(v: number): string {
  return (Math.round(v * 10) / 10).toFixed(1);
}

export function StatusBar() {
  const pointer = useApp((s) => s.pointer);
  const zoom = useApp((s) => s.camera.zoom);
  const hover = useApp((s) => s.hover);
  const selection = useApp((s) => s.selection);
  const stats = useApp((s) => s.stats, shallowEqual);
  const mtimeMs = useApp((s) => s.mtimeMs);
  const size = useApp((s) => (s.model ? `${s.model.meta.width} × ${s.model.meta.height}` : null));
  return (
    <footer className="statusbar" data-testid="statusbar">
      <span className="status-item status-coords" title="Pointer position in model coordinates (canvas pixels, +y down)" data-testid="pointer-coords">
        <span className="k">x</span>
        <span className="v">{pointer ? fmt(pointer[0]) : '—'}</span>
        <span className="k">y</span>
        <span className="v">{pointer ? fmt(pointer[1]) : '—'}</span>
      </span>
      <span className="status-item" title="Zoom (CSS px per model px)">
        {formatZoom(zoom)}
      </span>
      {size && <span className="status-item muted" title="Canvas size">{size}</span>}
      <span className="status-item status-grow" title={selection.join(', ')}>
        {selection.length === 0 ? <span className="muted">No selection</span> : selection.length === 1 ? selection[0] : `${selection.length} selected`}
        {hover && !selection.includes(hover) && <span className="muted"> · hover {hover}</span>}
      </span>
      <span className="status-item muted" title="Draw calls / triangles of the last frame">
        {stats.draws} draws · {stats.triangles} tris
      </span>
      <span className="status-item muted" title="Viewport redraws per second (the viewport only redraws when something changes)">
        {stats.fps > 1 ? `${stats.fps} fps` : 'idle'}
      </span>
      {mtimeMs > 0 && (
        <span className="status-item muted" title="Modification time of the loaded file version">
          file {new Date(mtimeMs).toLocaleTimeString()}
        </span>
      )}
    </footer>
  );
}
