/**
 * Problems panel: validation diagnostics of the current file version (validated in the browser with
 * the same code as `rev2d validate`), with JSON pointers. Clicking one selects the referenced object.
 */
import { useState } from 'react';
import { formatDiagnostics, type Diagnostic } from '../../../src/core/index.js';
import { errorCount, warningCount } from '../state/app.js';
import { useApp, useSession } from '../state/context.js';
import { refFromPointer, refKey } from '../state/doc.js';
import { Icon } from '../ui/icons.js';
import { DiagnosticList } from './Inspector.js';

export function Diagnostics() {
  const session = useSession();
  const diagnostics = useApp((s) => s.diagnostics);
  const stale = useApp((s) => s.stale);
  const [copied, setCopied] = useState(false);
  const errors = errorCount(diagnostics);
  const warnings = warningCount(diagnostics);

  const pick = (d: Diagnostic): void => {
    const ref = refFromPointer(session.get().doc, d.path);
    if (ref) session.select([refKey(ref)]);
    else session.toast('info', `${d.path || 'The document root'} is not an object that can be selected.`);
  };

  const copy = (): void => {
    void navigator.clipboard
      .writeText(formatDiagnostics(diagnostics))
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => session.toast('error', 'Clipboard is not available.'));
  };

  return (
    <div className="problems" data-testid="problems">
      <div className="problems-head">
        <span className={errors ? 'error-text' : warnings ? 'warning-text' : 'ok-text'}>
          {errors === 0 && warnings === 0 ? 'No problems — the model is valid.' : `${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`}
        </span>
        {stale && <span className="tag tag-error">viewport shows the last valid version</span>}
        <div className="section-actions">
          <button className="button button-small" disabled={diagnostics.length === 0} onClick={copy} title="Copy as text (same format as `rev2d validate`) to paste into an AI chat">
            <Icon name={copied ? 'check' : 'info'} size={12} /> {copied ? 'Copied' : 'Copy all'}
          </button>
        </div>
      </div>
      {diagnostics.length > 0 && <DiagnosticList items={diagnostics} onPick={pick} />}
    </div>
  );
}
