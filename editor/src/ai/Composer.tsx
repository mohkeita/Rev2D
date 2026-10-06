/**
 * The bottom of the panel: the progress of a running job (status, elapsed time, Stop), what went wrong
 * with the last request, where the agent works, and the field.
 *
 * Enter sends, Shift+Enter starts a new line (never while an input method composes a syllable).
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Button, Icon, IconButton, Spinner, Switch } from '../design/index.js';
import { useT } from '../i18n/index.js';
import { useApp } from '../state/context.js';
import { useStore } from '../state/store.js';
import { Notice } from '../ui/kit.js';
import { workContext } from './context.js';
import { formatElapsed, isFinal, isResumable, jobDuration, lastJob, progressOf, type JobView } from './conversation.js';
import { explainProblem } from './errors.js';
import { ai } from './instance.js';
import { progressText, taskTitle } from './words.js';

/** Re-render every second while `on`. */
function useTicker(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [on]);
  return now;
}

function Progress({ view, here }: { view: JobView; here: boolean }) {
  const t = useT();
  const now = useTicker(true);
  const [stopping, setStopping] = useState(false);
  const progress = progressOf(view);
  // Stopping kills the agent and everything it started; that can take a moment.
  const text = stopping ? t('ai.progress.stopping') : progressText(progress, t);
  return (
    <div className="ed-ai-progress" data-kind={progress.kind} data-testid="ai-progress" role="status">
      {progress.kind === 'stalled' ? <Icon name="clock" size={14} className="ed-ai-progress-stalled" /> : <Spinner size={14} />}
      <div className="ed-ai-progress-text">
        <span className="ed-ai-progress-status" title={text} data-testid="ai-progress-status">
          {here ? text : t('ai.progress.elsewhere')}
        </span>
        <span className="ed-ai-progress-time r2-num" data-testid="ai-elapsed">
          {formatElapsed(jobDuration(view.job, now))}
        </span>
      </div>
      {here ? (
        <Button
          variant="gray"
          size="sm"
          icon="stop"
          loading={stopping}
          onClick={() => {
            setStopping(true);
            void ai.cancel(view.job.id).finally(() => setStopping(false));
          }}
          data-testid="ai-stop"
        >
          {t('ai.stop')}
        </Button>
      ) : (
        <Button variant="tinted" size="sm" onClick={() => void ai.showJob(view.job.id)} data-testid="ai-show-running">
          {t('common.show')}
        </Button>
      )}
    </div>
  );
}

function ProblemNotice() {
  const t = useT();
  const entry = useStore(ai.store, (s) => s.problem);
  const provider = useStore(ai.store, (s) => s.providers.find((p) => p.id === s.problem?.provider) ?? null);
  if (!entry) return null;
  const text = explainProblem(entry.problem, provider);
  const action =
    text.action === 'show-job' && entry.problem.jobId ? (
      <Button variant="tinted" size="sm" onClick={() => void ai.showJob(entry.problem.jobId!)} data-testid="ai-problem-show">
        {t('ai.problem.showJob')}
      </Button>
    ) : text.action === 'reload-page' ? (
      <Button variant="tinted" size="sm" onClick={() => location.reload()}>
        {t('ai.problem.reload')}
      </Button>
    ) : text.action === 'retry' ? (
      <Button variant="tinted" size="sm" onClick={() => void ai.init(true).then(() => ai.send())} data-testid="ai-problem-retry">
        {t('common.retry')}
      </Button>
    ) : null;
  return (
    <Notice
      tone={text.tone}
      className="ed-ai-problem"
      data-testid="ai-problem"
      data-kind={entry.problem.kind}
      hint={
        <>
          {text.text && <span className="ed-ai-problem-text">{t(text.text.key, text.text.vars)}</span>}
          {text.detail && <span className="ed-ai-problem-detail">{text.detail}</span>}
          {text.hint && <span className="ed-ai-problem-detail ed-mono-small">{text.hint}</span>}
        </>
      }
      actions={
        <>
          {action}
          <IconButton icon="close" size="sm" label={t('design.dismiss')} onClick={() => ai.dismissProblem()} />
        </>
      }
    >
      <strong>{t(text.title.key, text.title.vars)}</strong>
    </Notice>
  );
}

export function Composer() {
  const t = useT();
  const fieldId = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const draft = useStore(ai.store, (s) => s.draft);
  const task = useStore(ai.store, (s) => s.task);
  const sending = useStore(ai.store, (s) => s.sending);
  const provider = useStore(ai.store, (s) => s.providers.find((p) => p.id === s.provider) ?? null);
  const allowImages = useStore(ai.store, (s) => s.allowImageGeneration);
  const last = useStore(ai.store, (s) => lastJob(s.jobs, s.conversation));
  const active = useStore(ai.store, (s) => (s.active ? (s.jobs[s.active] ?? null) : null));
  const file = useApp((s) => s.file);
  const root = useApp((s) => s.workspace?.root ?? null);
  const where = workContext(file, root);

  const running = active !== null && !isFinal(active.job.state);
  const here = running && last?.job.id === active.job.id;
  const followUp = !!last && !task && last.job.provider === provider?.id && isResumable(last.job);
  const switching = !!last && !task && !!provider && last.job.provider !== provider.id;
  const name = provider?.name ?? t('ai.theAgent');
  const canSend = !running && !sending && !!provider && (draft.trim().length > 0 || (!!task && !task.needsPrompt));

  // Grow with the text, up to about eight lines.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [draft]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    if (canSend) void ai.send();
  };

  const placeholder = running
    ? t('ai.composer.waiting')
    : task
      ? task.needsPrompt
        ? t('ai.composer.taskPrompt')
        : t('ai.composer.taskDetails')
      : followUp
        ? t('ai.composer.followUp')
        : t('ai.composer.placeholder', { name });

  return (
    <div className="ed-ai-composer" data-testid="ai-composer">
      {running && <Progress view={active} here={here} />}
      <ProblemNotice />
      <div className="ed-ai-chips">
        <span className="ed-ai-where" title={where.folderPath ?? undefined} data-testid="ai-where">
          <Icon name="folder" size={12} />
          <span className="ed-ai-where-text">{where.folder ? t('ai.composer.where', { folder: where.folder }) : t('ai.composer.whereRoot')}</span>
        </span>
        <span className="ed-ai-sandbox-words" title={t('ai.composer.canEditTip')} data-testid="ai-sandbox-words">
          <Icon name="pencil" size={11} />
          {t('ai.composer.canEdit')}
        </span>
      </div>
      {task && (
        <div className="ed-ai-chips">
          <button
            type="button"
            className="ed-chip ed-ai-task-chip"
            data-tone="tint"
            title={task.description}
            onClick={() => ai.selectTask(null)}
            aria-label={t('ai.composer.removeTask', { task: taskTitle(task, t) })}
            data-testid="ai-task-chip"
          >
            <Icon name="wand" size={11} />
            <span className="ed-chip-text">{taskTitle(task, t)}</span>
            <Icon name="close" size={10} strokeWidth={2.6} />
          </button>
        </div>
      )}
      <div className="ed-ai-field" data-disabled={running ? '' : undefined}>
        <label htmlFor={fieldId} className="r2-visually-hidden">
          {t('ai.composer.label')}
        </label>
        <textarea
          id={fieldId}
          ref={input}
          className="ed-ai-input"
          rows={1}
          value={draft}
          placeholder={placeholder}
          onChange={(e) => ai.setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          data-testid="ai-input"
        />
        <IconButton
          icon="arrowUp"
          variant="filled"
          size="sm"
          label={followUp ? t('ai.composer.sendFollowUp') : t('ai.composer.send')}
          shortcut="Enter"
          disabled={!canSend}
          className="ed-ai-send"
          onClick={() => void ai.send()}
          data-testid="ai-send"
        >
          {sending ? <Spinner size={14} /> : undefined}
        </IconButton>
      </div>
      {switching && <p className="ed-ai-footnote">{t('ai.composer.newWith', { name })}</p>}
      {provider?.features.imageGeneration && (
        <div className="ed-ai-image">
          <Icon name="image" size={14} className="ed-ai-image-icon" />
          <Switch
            size="sm"
            label={t('ai.composer.imageGeneration')}
            checked={allowImages}
            onChange={(v) => ai.setAllowImageGeneration(v)}
            title={t('ai.composer.imageGenerationTip', { name })}
            data-testid="ai-image-switch"
          />
        </div>
      )}
      {provider?.features.imageGeneration && allowImages && (
        <p className="ed-ai-footnote" data-testid="ai-image-note">
          {t('ai.composer.imageGenerationTip', { name })}
        </p>
      )}
    </div>
  );
}
