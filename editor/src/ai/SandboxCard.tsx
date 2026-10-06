/**
 * The Codex Windows sandbox problem (docs/AGENT-BRIDGE.md §8): Codex starts every command through a
 * Windows sandbox; its default "elevated" one needs a one-time administrator setup, and when that is
 * missing or broken no command starts. The card explains it in plain words and offers the two fixes:
 * the unelevated sandbox (PUT /api/agent/settings, one click, then "Run again") or the repair steps.
 */
import { useEffect, useState } from 'react';
import { Button, Icon } from '../design/index.js';
import { useT } from '../i18n/index.js';
import { useStore } from '../state/store.js';
import type { JobView } from './conversation.js';
import { isFinal } from './conversation.js';
import { ai } from './instance.js';
import { sourceText } from './words.js';

export function SandboxCard({ view }: { view: JobView }) {
  const t = useT();
  const settings = useStore(ai.store, (s) => s.settings);
  const saving = useStore(ai.store, (s) => s.sandboxSaving);
  const failed = useStore(ai.store, (s) => s.sandboxProblem);
  const fixed = useStore(ai.store, (s) => s.sandboxFixed.includes(view.job.id));
  const busy = useStore(ai.store, (s) => s.sending || s.active !== null);
  const [repair, setRepair] = useState(false);
  useEffect(() => {
    void ai.refreshSettings();
  }, []);

  const value = settings?.settings.codexWindowsSandbox ?? 'config';
  const source = settings?.sources.codexWindowsSandbox ?? 'default';
  // Saved, but a flag or an option of this editor overrides the saved value.
  const overridden = fixed && value !== 'unelevated';
  const variant = fixed ? 'fixed' : value === 'unelevated' ? 'already' : 'offer';
  const running = !isFinal(view.job.state);

  return (
    <div className="ed-ai-card" data-variant={variant} data-testid="ai-sandbox-card">
      <div className="ed-ai-card-head">
        <span className="ed-ai-card-glyph" aria-hidden="true">
          <Icon name="terminal" size={16} />
        </span>
        <div className="ed-ai-card-title">{view.sandbox === 'stalled' && running ? t('ai.sandbox.stalledTitle') : t('ai.sandbox.title')}</div>
      </div>
      {variant === 'fixed' ? (
        <p className="ed-ai-card-text">{overridden ? t('ai.sandbox.overridden', { source: sourceText(source, t) }) : t('ai.sandbox.fixed')}</p>
      ) : variant === 'already' ? (
        <p className="ed-ai-card-text">{t('ai.sandbox.already')}</p>
      ) : (
        <p className="ed-ai-card-text">{view.sandbox === 'stalled' && running ? t('ai.sandbox.stalledText') : t('ai.sandbox.text')}</p>
      )}
      {failed && <p className="ed-ai-card-text ed-danger-text">{failed.message}</p>}
      {repair && (
        <ol className="ed-ai-steps" data-testid="ai-sandbox-steps">
          <li>{t('ai.sandbox.step1')}</li>
          <li>
            {t('ai.sandbox.step2')} <code className="ed-md-code">codex</code>
          </li>
          <li>{t('ai.sandbox.step3')}</li>
          {variant === 'already' && (
            <li>
              {t('ai.sandbox.step4')} <code className="ed-md-code">codex update</code>
            </li>
          )}
        </ol>
      )}
      <div className="ed-ai-card-actions">
        {variant === 'offer' && (
          <Button variant="filled" size="sm" loading={saving} onClick={() => void ai.setCodexSandbox('unelevated', view.job.id)} data-testid="ai-sandbox-fix">
            {t('ai.sandbox.useUnelevated')}
          </Button>
        )}
        {variant === 'fixed' && !running && (
          <Button variant="filled" size="sm" icon="refresh" disabled={busy} onClick={() => void ai.runAgain(view.job.id)} data-testid="ai-sandbox-again">
            {t('ai.sandbox.runAgain')}
          </Button>
        )}
        {running && (
          <Button variant="gray" size="sm" icon="stop" onClick={() => void ai.cancel(view.job.id)}>
            {t('ai.stop')}
          </Button>
        )}
        <Button variant="plain" size="sm" aria-expanded={repair} onClick={() => setRepair(!repair)} data-testid="ai-sandbox-repair">
          {repair ? t('ai.sandbox.hideRepair') : t('ai.sandbox.repair')}
        </Button>
      </div>
    </div>
  );
}
