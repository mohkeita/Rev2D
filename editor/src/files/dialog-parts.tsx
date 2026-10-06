/**
 * Pieces the file dialogs and the interop dialogs share: the "Replace x?" alert, the error note of a
 * failed operation, a row of a file list and the path line of a dialog's bottom row.
 */
import type { ReactNode } from 'react';
import { Button, Icon, type IconName } from '../design/index.js';
import { useT } from '../i18n/index.js';
import { Dialog, useLingering } from '../ui/Dialog.js';
import { Notice } from '../ui/kit.js';
import { baseName } from './paths.js';
import './file-dialogs.css';

/**
 * "Replace “x”?": an alert on top of the dialog that is about to write over existing files (`target`
 * may list several, comma-separated). Cancel is the default; Esc only closes the alert.
 */
export function ReplaceAlert({ target, onReplace, onCancel, busy }: { target: string | null; onReplace(): void; onCancel(): void; busy: boolean }) {
  const t = useT();
  const shown = useLingering(target);
  if (shown.value === null) return null;
  const names = shown.value.split(', ').filter(Boolean);
  const many = names.length > 1;
  return (
    <Dialog
      alert
      open={shown.open}
      icon="warning"
      className="ed-alert-warning"
      title={many ? t('files.replace.titleMany', { n: names.length }) : t('files.replace.title', { name: baseName(names[0] ?? shown.value) })}
      description={many ? t('files.replace.messageMany') : t('files.replace.message', { path: names[0] ?? shown.value })}
      onCancel={onCancel}
      testId="replace-confirm"
      actions={
        <>
          <Button size="lg" block onClick={onCancel} disabled={busy} data-autofocus="">
            {t('common.cancel')}
          </Button>
          <Button size="lg" block destructive onClick={onReplace} loading={busy} data-testid="replace-confirm-yes">
            {t('common.replace')}
          </Button>
        </>
      }
    >
      {many ? (
        <ul className="ed-replace-list ed-mono-small">
          {names.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
    </Dialog>
  );
}

export function ErrorNote({ result }: { result: { error?: string; hint?: string } | null }) {
  if (!result?.error) return null;
  return (
    <Notice tone="danger" hint={result.hint} data-testid="dialog-error">
      {result.error}
    </Notice>
  );
}

/** "Creates  characters/hero.r2d.json": a quiet label and the path it is about, in the dialog's bottom row. */
export function PathInfo({ label, path }: { label: string; path: string }) {
  return (
    <span className="ed-dialog-path" title={path}>
      <span className="ed-faint">{label}</span> <span className="ed-mono-small">{path || '…'}</span>
    </span>
  );
}

/** One row of a list of files (picked for an import, written by an export). */
export function FileRow({ icon, name, title, size, badge, dim }: { icon: IconName; name: string; title?: string; size: string; badge: ReactNode; dim?: boolean }) {
  return (
    <div className="ed-filelist-row" data-dim={dim ? '' : undefined}>
      <Icon name={icon} size={16} className="ed-filelist-icon" />
      <span className="ed-filelist-name ed-mono-small" title={title ?? name}>
        {name}
      </span>
      <span className="ed-filelist-size r2-num">{size}</span>
      {badge}
    </div>
  );
}
