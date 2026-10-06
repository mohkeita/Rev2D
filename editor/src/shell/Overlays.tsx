/**
 * What floats above the workspace besides the panes: document banners (write conflict, stale model,
 * evaluation error), toasts, the keyboard shortcut sheet, the load-failure alert and the drop target.
 */
import { Badge, Button, Icon, Layer, Toast, type ToastTone } from '../design/index.js';
import { FILE_SHORTCUTS } from '../files/shortcuts.js';
import { languageTag, useT, type MessageKey } from '../i18n/index.js';
import { errorCount, type Toast as ToastItem } from '../state/app.js';
import { useApp, useSession } from '../state/context.js';
import { Dialog } from '../ui/Dialog.js';
import { Keys } from '../ui/kit.js';

// ------------------------------------------------------------------------------------ banners

/** Messages about the document that stay until resolved, at the top of the free canvas area. */
export function Banners() {
  const session = useSession();
  const t = useT();
  const stale = useApp((s) => s.stale);
  const errors = useApp((s) => errorCount(s.diagnostics));
  const validAt = useApp((s) => s.validAt);
  const evalError = useApp((s) => s.evalError);
  const conflict = useApp((s) => s.conflict);
  if (!conflict && !stale && !evalError) return null;
  return (
    <div className="ed-banners" onPointerDown={(e) => e.stopPropagation()}>
      {conflict && (
        <div className="ed-banner r2-glass-panel" data-tone="warning" role="alert" data-testid="conflict-banner">
          <Icon name="warning" size={18} className="ed-banner-icon" />
          <div className="ed-banner-text" title={t('banner.conflict.tip')}>
            <strong>{t('banner.conflict.title')}</strong>
            <span>{t('banner.conflict.text')}</span>
          </div>
          <div className="ed-banner-actions">
            <Button size="md" onClick={() => void session.resolveConflict('reload')} data-testid="conflict-reload">
              {t('banner.conflict.reload')}
            </Button>
            <Button size="md" destructive onClick={() => void session.resolveConflict('overwrite')} data-testid="conflict-overwrite">
              {t('banner.conflict.overwrite')}
            </Button>
          </div>
        </div>
      )}
      {stale && (
        <div className="ed-banner r2-glass-panel" data-tone="danger" role="alert" data-testid="stale-banner">
          <Icon name="error" size={18} className="ed-banner-icon" />
          <div className="ed-banner-text">
            <strong>{t('banner.stale.title', { n: errors })}</strong>
            <span>{validAt ? t('banner.stale.textAt', { time: new Date(validAt).toLocaleTimeString(languageTag()) }) : t('banner.stale.text')}</span>
          </div>
          <div className="ed-banner-actions">
            <Button size="md" variant="tinted" onClick={() => session.showProblems()}>
              {t('viewport.showProblems')}
            </Button>
          </div>
        </div>
      )}
      {evalError && (
        <div className="ed-banner r2-glass-panel" data-tone="danger" role="alert">
          <Icon name="error" size={18} className="ed-banner-icon" />
          <div className="ed-banner-text">
            <span>{evalError}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------ toasts

const TONE: Record<ToastItem['kind'], ToastTone> = { info: 'info', success: 'success', warning: 'warning', error: 'danger' };

/**
 * The session's toasts as glass capsules above the status line, centred in the free area. They live
 * in the toast layer (above sheets and menus); the shell mirrors the free area on <html> for them.
 */
export function Toasts() {
  const session = useSession();
  const t = useT();
  const toasts = useApp((s) => s.toasts);
  return (
    <Layer level="toast">
      <div className="ed-toasts" role="region" aria-label={t('design.notifications')} aria-live="polite" data-testid="toasts">
        {toasts.map((item) => (
          <Toast
            key={item.id}
            tone={TONE[item.kind]}
            title={
              <>
                {item.source && (
                  <Badge tone="tint" className="ed-toast-source" data-testid="toast-source">
                    {item.source}
                  </Badge>
                )}
                <span data-testid="toast-text">{item.text}</span>
              </>
            }
            description={
              item.details?.length ? (
                <>
                  {item.details.map((d, i) => (
                    <span key={i} className="ed-toast-detail">
                      {d}
                    </span>
                  ))}
                </>
              ) : undefined
            }
            action={
              item.action && {
                label: item.action.label,
                onSelect: () => {
                  item.action!.run();
                  session.dismissToast(item.id);
                },
              }
            }
            onDismiss={() => session.dismissToast(item.id)}
            data-testid="toast"
          />
        ))}
      </div>
    </Layer>
  );
}

// ------------------------------------------------------------------------------------ shortcuts

type ShortcutRow = [keys: string, what: MessageKey];

/** Keys separated by two spaces are alternatives or a set, each shown as its own caps. */
const SHORTCUTS: Array<[title: MessageKey, rows: ShortcutRow[]]> = [
  [
    'help.file',
    [
      [FILE_SHORTCUTS.new, 'help.file.new'],
      [FILE_SHORTCUTS.open, 'help.file.open'],
      [FILE_SHORTCUTS.save, 'help.file.save'],
      [FILE_SHORTCUTS.saveAs, 'help.file.saveAs'],
    ],
  ],
  [
    'help.view',
    [
      ['help.key.wheel', 'help.view.zoom'],
      ['help.key.middleDrag', 'help.view.pan'],
      ['Space+help.key.drag', 'help.view.pan'],
      ['help.key.click', 'help.view.select'],
      ['Shift+help.key.click', 'help.view.addSelect'],
      ['help.key.doubleClick', 'help.view.inspect'],
      ['F', 'help.view.frame'],
      ['Shift+F', 'help.view.frameCanvas'],
      ['1', 'help.view.zoom100'],
      ['+  −', 'help.view.zoomInOut'],
      ['Esc', 'help.view.clear'],
    ],
  ],
  [
    'help.overlays',
    [
      ['B  M  W  X  L  G', 'help.overlays.toggle'],
      ['H', 'help.overlays.hide'],
      ['Alt+H', 'help.overlays.showAll'],
    ],
  ],
  [
    'help.playback',
    [
      ['Space', 'help.playback.play'],
      ['←  →', 'help.playback.step'],
      ['Home', 'help.playback.start'],
    ],
  ],
  [
    'help.editing',
    [
      ['Ctrl+Z', 'help.editing.undo'],
      ['Ctrl+Shift+Z  Ctrl+Y', 'help.editing.redo'],
      ['Ctrl+Enter', 'help.editing.apply'],
      ['help.key.doubleClickSlider', 'help.editing.resetParam'],
      ['?', 'help.editing.help'],
    ],
  ],
];

export function HelpSheet() {
  const session = useSession();
  const t = useT();
  const open = useApp((s) => s.helpOpen);
  const close = (): void => session.store.set({ helpOpen: false });
  /** "Space+help.key.drag" -> "Space+Drag": words of a key combination that are translated. */
  const keyText = (keys: string): string =>
    keys
      .split('+')
      .map((k) => (k.startsWith('help.key.') ? t(k as MessageKey) : k))
      .join('+');
  return (
    <Dialog
      open={open}
      size="lg"
      title={t('help.title')}
      aria-label={t('help.title')}
      onCancel={close}
      onConfirm={close}
      testId="shortcuts-dialog"
      footer={t('help.note')}
      actions={
        <Button variant="filled" size="lg" onClick={close} data-autofocus="">
          {t('common.done')}
        </Button>
      }
    >
      <div className="ed-help">
        {SHORTCUTS.map(([title, rows]) => (
          <section key={title} className="ed-help-section">
            <h3 className="ed-help-title">{t(title)}</h3>
            <dl className="ed-help-list">
              {rows.map(([keys, what]) => (
                <div key={keys} className="ed-help-row">
                  <dt>{t(what)}</dt>
                  <dd>
                    {keys.split('  ').map((k) => (
                      <Keys key={k} keys={keyText(k)} />
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------------------------ load failure

export function LoadFailure() {
  const session = useSession();
  const t = useT();
  const status = useApp((s) => s.status);
  const error = useApp((s) => s.loadError);
  const canSwitch = useApp((s) => s.workspace !== null);
  const dialogOpen = useApp((s) => s.dialog !== null);
  // A file dialog opened from here goes on top of this alert.
  const open = status === 'failed' && !dialogOpen;
  return (
    <Dialog
      open={open}
      alert
      icon="error"
      title={t('loadFailure.title')}
      description={t('loadFailure.text')}
      onCancel={() => undefined}
      onConfirm={() => void session.reload('reset', true)}
      testId="load-failure"
      actions={
        <>
          {canSwitch && (
            <>
              <Button size="lg" block onClick={() => void session.closeModel()}>
                {t('loadFailure.close')}
              </Button>
              <Button size="lg" block onClick={() => session.openDialog({ kind: 'open' })}>
                {t('loadFailure.openOther')}
              </Button>
            </>
          )}
          <Button size="lg" block variant="filled" onClick={() => void session.reload('reset', true)} data-autofocus="">
            {t('common.retry')}
          </Button>
        </>
      }
    >
      {error && <p className="ed-mono-small ed-danger-text ed-load-error">{error}</p>}
    </Dialog>
  );
}

// ------------------------------------------------------------------------------------ drop target

export function DropOverlay() {
  const t = useT();
  return (
    <div className="ed-drop" aria-hidden="true" data-testid="drop-overlay">
      <div className="ed-drop-card r2-glass-panel">
        <div className="ed-drop-icon">
          <Icon name="import" size={28} />
        </div>
        <strong>{t('drop.title')}</strong>
        <span>{t('drop.text')}</span>
      </div>
    </div>
  );
}
