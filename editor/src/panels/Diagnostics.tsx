/**
 * Problems (a page of the trailing inspector): validation diagnostics of the current file version
 * (validated in the browser with the same code as `rev2d validate`), with JSON pointers. Picking
 * one selects the referenced object and shows it in the inspector. The texts come from the Rev2D
 * core and are not translated: they match what the CLI and AI tools print.
 */
import { useState } from 'react';
import { formatDiagnostics, type Diagnostic } from '../../../src/core/index.js';
import { Badge, Button, EmptyState } from '../design/index.js';
import { useT } from '../i18n/index.js';
import { errorCount, warningCount } from '../state/app.js';
import { useApp, useSession } from '../state/context.js';
import { refFromPointer, refKey } from '../state/doc.js';
import { DiagnosticList } from './Inspector.js';

export function Diagnostics() {
  const session = useSession();
  const t = useT();
  const diagnostics = useApp((s) => s.diagnostics);
  const stale = useApp((s) => s.stale);
  const [copied, setCopied] = useState(false);
  const errors = errorCount(diagnostics);
  const warnings = warningCount(diagnostics);

  const pick = (d: Diagnostic): void => {
    const ref = refFromPointer(session.get().doc, d.path);
    if (ref) session.inspect([refKey(ref)]);
    else session.toast('info', t('problems.notSelectable', { path: d.path || t('problems.documentRoot') }));
  };

  const copy = (): void => {
    void navigator.clipboard
      .writeText(formatDiagnostics(diagnostics))
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => session.toast('error', t('problems.noClipboard')));
  };

  return (
    <div className="ed-problems" data-testid="problems">
      <div className="ed-pane-bar">
        <span className="ed-pane-bar-title" data-tone={errors ? 'danger' : warnings ? 'warning' : undefined}>
          {errors === 0 && warnings === 0 ? t('problems.none') : t('problems.summary', { errors, warnings })}
        </span>
        <span className="ed-pane-bar-space" />
        <Button variant="plain" size="sm" icon={copied ? 'check' : 'copy'} disabled={diagnostics.length === 0} title={t('problems.copy.tip')} onClick={copy}>
          {copied ? t('common.copied') : t('problems.copy')}
        </Button>
      </div>
      <div className="ed-pane-scroll r2-scroll">
        {stale && (
          <div className="ed-problems-stale">
            <Badge tone="danger" icon="warning">
              {t('problems.stale')}
            </Badge>
          </div>
        )}
        {diagnostics.length > 0 ? (
          <DiagnosticList items={diagnostics} onPick={pick} />
        ) : (
          <EmptyState size="sm" icon="checkCircle" title={t('problems.empty.title')} description={t('problems.empty.text')} />
        )}
      </div>
    </div>
  );
}
