/**
 * The status line, folded into the chrome: one slim glass capsule at the leading bottom corner of
 * the free canvas area.
 *
 *   (✓ Valid) (⚡ AI ●) (file · saved) (x 120.0  y 48.5  part:eye)
 *
 * - validation state: opens the problems list (a mode with its own status items, e.g. Avatar mode's
 *   "landmarks to place", shows those instead: WorkspaceMode.render.status);
 * - AI bridge state: a dot (live / connecting / offline); pressing it opens the details that used
 *   to fill a status bar (last command, file, canvas size, draw calls, redraw rate, selection);
 * - the document on screen relative to the workspace root with its save state (the mode's own
 *   document, e.g. avatar.json, else the model; or the running file operation);
 * - pointer position in model coordinates and what is under the pointer.
 */
import type { ReactNode } from 'react';
import { Icon, Popover, Spinner, type IconName } from '../design/index.js';
import { relativeToRoot } from '../files/paths.js';
import { languageTag, useT } from '../i18n/index.js';
import { documentKind, errorCount, warningCount } from '../state/app.js';
import { useApp, useSession } from '../state/context.js';
import { shallowEqual } from '../state/store.js';
import { formatZoom } from '../view/camera.js';
import { useDocumentState, type ModeDocument, type WorkspaceMode } from './registry.js';

/**
 * One item of the status line, for a mode's own status (WorkspaceMode.render.status): an icon in
 * the tone's colour and a short text; with `onClick` it is a button.
 */
export function StatusItem({
  icon,
  tone,
  title,
  onClick,
  children,
  'data-testid': testId,
}: {
  icon?: IconName;
  tone?: 'success' | 'warning' | 'danger';
  title?: string;
  onClick?: () => void;
  children: ReactNode;
  'data-testid'?: string;
}) {
  const content = (
    <>
      {icon && <Icon name={icon} size={14} />}
      {children}
    </>
  );
  return onClick ? (
    <button type="button" className="ed-status-item ed-status-button" data-tone={tone} title={title} onClick={onClick} data-testid={testId}>
      {content}
    </button>
  ) : (
    <span className="ed-status-item" data-tone={tone} title={title} data-testid={testId}>
      {content}
    </span>
  );
}

function fmt(v: number): string {
  return (Math.round(v * 10) / 10).toFixed(1);
}

function Validation() {
  const session = useSession();
  const t = useT();
  const counts = useApp((s) => ({ e: errorCount(s.diagnostics), w: warningCount(s.diagnostics) }), shallowEqual);
  const clean = counts.e === 0 && counts.w === 0;
  return (
    <button
      type="button"
      className="ed-status-item ed-status-button"
      data-tone={counts.e ? 'danger' : counts.w ? 'warning' : 'success'}
      title={clean ? t('status.valid.tip') : t('status.problems.tip', { errors: counts.e, warnings: counts.w })}
      onClick={() => session.showProblems()}
      data-testid="problems-badge"
    >
      {clean ? (
        <>
          <Icon name="checkCircle" size={14} />
          <span>{t('status.valid')}</span>
        </>
      ) : (
        <>
          {counts.e > 0 && (
            <span className="ed-status-count" data-tone="danger">
              <Icon name="error" size={14} />
              <span className="r2-num">{counts.e}</span>
            </span>
          )}
          {counts.w > 0 && (
            <span className="ed-status-count" data-tone="warning">
              <Icon name="warning" size={14} />
              <span className="r2-num">{counts.w}</span>
            </span>
          )}
        </>
      )}
    </button>
  );
}

function Bridge() {
  const t = useT();
  const connection = useApp((s) => s.connection);
  const bridge = useApp((s) => s.bridge);
  const file = useApp((s) => s.file);
  const root = useApp((s) => s.workspace?.root ?? null);
  const mtimeMs = useApp((s) => s.mtimeMs);
  const size = useApp((s) => (s.model ? `${s.model.meta.width} × ${s.model.meta.height}` : null));
  const stateText = connection === 'live' ? t('status.bridge.live') : connection === 'connecting' ? t('status.bridge.connecting') : t('status.bridge.offline');
  return (
    <Popover
      placement="top-start"
      title={t('status.details')}
      width={300}
      trigger={
        <button type="button" className="ed-status-item ed-status-button" data-state={connection} title={`${t('status.bridge')}: ${stateText}`} data-testid="bridge">
          {/* Re-mounted per command so its flash animation replays. */}
          {bridge && <span key={bridge.at} className="ed-status-flash" />}
          <Icon name="bolt" size={14} />
          <span>AI</span>
          <span className="ed-status-dot" aria-hidden="true" />
          <span className="r2-visually-hidden">{stateText}</span>
        </button>
      }
    >
      <dl className="ed-status-details">
        <dt>{t('status.bridge')}</dt>
        <dd>
          <span className="ed-status-state" data-state={connection}>
            {stateText}
          </span>
          <div className="ed-muted">{connection === 'live' ? t('status.bridge.liveText') : t('status.bridge.offlineText')}</div>
        </dd>
        <dt>{t('status.lastCommand')}</dt>
        <dd>
          {bridge ? (
            <>
              <span className="ed-mono-small">{bridge.text}</span>
              <span className="ed-muted"> · {new Date(bridge.at).toLocaleTimeString(languageTag())}</span>
            </>
          ) : (
            <span className="ed-muted">{t('status.noCommand')}</span>
          )}
        </dd>
        {file && (
          <>
            <dt>{t('status.file')}</dt>
            <dd className="ed-mono-small">{file}</dd>
          </>
        )}
        {root && (
          <>
            <dt>{t('status.workspace')}</dt>
            <dd className="ed-mono-small">{root}</dd>
          </>
        )}
        {mtimeMs > 0 && (
          <>
            <dt>{t('status.modified')}</dt>
            <dd className="r2-num">{new Date(mtimeMs).toLocaleString(languageTag())}</dd>
          </>
        )}
        {size && (
          <>
            <dt>{t('status.canvas')}</dt>
            <dd className="r2-num">{size} px</dd>
          </>
        )}
        <RenderStats />
      </dl>
    </Popover>
  );
}

/** Counters that change every frame: only this part of the popover re-renders with them. */
function RenderStats() {
  const t = useT();
  const stats = useApp((s) => s.stats, shallowEqual);
  const zoom = useApp((s) => s.camera.zoom);
  const selection = useApp((s) => s.selection);
  return (
    <>
      <dt>{t('status.zoom')}</dt>
      <dd className="r2-num">{formatZoom(zoom)}</dd>
      <dt>{t('status.drawn')}</dt>
      <dd className="r2-num">
        {t('status.drawnValue', { draws: stats.draws, triangles: stats.triangles })}
        <span className="ed-muted"> · {stats.fps > 1 ? t('status.fps', { fps: stats.fps }) : t('status.idle')}</span>
      </dd>
      <dt>{t('status.selection')}</dt>
      <dd className="ed-mono-small">{selection.length ? selection.join(', ') : <span className="ed-muted">{t('status.noSelection')}</span>}</dd>
    </>
  );
}

/**
 * The document on screen relative to the workspace root (absolute when outside it), with its save
 * state: the mode's own document when it has one, else the model.
 */
function FileStatus({ document }: { document?: ModeDocument }) {
  const t = useT();
  const modelFile = useApp((s) => s.file);
  const root = useApp((s) => s.workspace?.root ?? null);
  const modelUnsaved = useApp((s) => s.unsaved);
  const modelSaving = useApp((s) => s.saving);
  const busy = useApp((s) => s.fileBusy);
  const doc = useDocumentState(document);
  const file = doc ? doc.path : modelFile;
  const unsaved = doc ? doc.dirty : modelUnsaved;
  const saving = doc ? doc.saving : modelSaving;
  if (busy) {
    return (
      <span className="ed-status-item ed-status-file" data-testid="status-file">
        <Spinner size={12} />
        <span className="ed-status-path">{busy}</span>
      </span>
    );
  }
  if (!file) {
    return (
      <span className="ed-status-item ed-status-file" title={root ?? undefined} data-testid="status-file">
        <Icon name="home" size={14} />
        <span className="ed-status-path">{root ?? t('status.noModel')}</span>
      </span>
    );
  }
  const rel = root ? relativeToRoot(file, root) : null;
  const state = saving ? 'saving' : unsaved ? 'unsaved' : 'saved';
  return (
    <span className="ed-status-item ed-status-file" title={`${file}${root ? `\n${t('status.workspace')}: ${root}` : ''}`} data-testid="status-file">
      <Icon name="file" size={14} />
      <span className="ed-status-path">{rel ?? file}</span>
      <span className="ed-status-save" data-state={state}>
        {state === 'saving' ? t('common.saving') : state === 'unsaved' ? t('status.unsaved') : t('status.saved')}
      </span>
    </span>
  );
}

function Pointer() {
  const t = useT();
  const pointer = useApp((s) => s.pointer);
  const hover = useApp((s) => s.hover);
  const selected = useApp((s) => (s.selection.length === 1 ? s.selection[0] : s.selection.length > 1 ? String(s.selection.length) : null));
  const subject = hover ?? (selected && /^\d+$/.test(selected) ? t('status.selected', { n: Number(selected) }) : selected);
  if (!pointer && !subject) return null;
  return (
    <span className="ed-status-item ed-status-coords" title={t('status.pointer.tip')} data-testid="pointer-coords">
      {pointer && (
        <span className="r2-num">
          <span className="ed-faint">x</span> {fmt(pointer[0])} <span className="ed-faint">y</span> {fmt(pointer[1])}
        </span>
      )}
      {subject && <span className="ed-status-subject">{subject}</span>}
    </span>
  );
}

/** `mode`: the workspace mode on screen (its status items and document replace the model's). */
export function StatusLine({ mode }: { mode: WorkspaceMode | null }) {
  const t = useT();
  const model = useApp((s) => documentKind(s) === 'model');
  const ModeStatus = mode?.render.status;
  return (
    <div className="ed-status r2-glass" role="group" aria-label={t('status.label')} data-testid="statusbar">
      {ModeStatus ? <ModeStatus /> : model && <Validation />}
      <Bridge />
      <FileStatus document={mode?.document} />
      {mode && <Pointer />}
    </div>
  );
}
