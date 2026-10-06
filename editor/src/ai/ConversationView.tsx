/**
 * The conversation shown in the panel: the person's requests as bubbles, the agent's messages as
 * readable text, the activity in between, and how each turn ended. Without a conversation: a welcome
 * with requests that fit the open document and the task templates of the server.
 */
import { useLayoutEffect, useMemo, useRef } from 'react';
import { Icon } from '../design/index.js';
import { useT } from '../i18n/index.js';
import { useApp } from '../state/context.js';
import { shallowEqual, useStore } from '../state/store.js';
import { ActivityBlock, ErrorBlock, ModelUpdated, TodoCard } from './Activity.js';
import { suggestionsFor, workContext } from './context.js';
import { baseName, blocksOf, conversationJobs, isFinal, jobDuration, prominentErrors, requestText, SANDBOX_CODE, type JobView } from './conversation.js';
import { ai } from './instance.js';
import { MessageText } from './MessageText.js';
import { SandboxCard } from './SandboxCard.js';
import { durationText, formatCount, taskTitle } from './words.js';

function Welcome() {
  const t = useT();
  const model = useApp((s) => s.model);
  const file = useApp((s) => s.file);
  const root = useApp((s) => s.workspace?.root ?? null);
  const provider = useStore(ai.store, (s) => s.providers.find((p) => p.id === s.provider) ?? null);
  const mode = useApp((s) => s.mode);
  // Templates of a workspace mode ("avatar-create") are offered in that mode; general ones everywhere.
  const tasks = useStore(ai.store, (s) => s.tasks.filter((x) => x.kind !== 'freeform' && (!x.kind.includes('-') || x.kind.startsWith(`${mode}-`))), shallowEqual);
  const suggestions = useMemo(() => suggestionsFor(model), [model]);
  const folder = workContext(file, root).folder;
  const name = provider?.name ?? t('ai.theAgent');
  return (
    <div className="ed-ai-welcome" data-testid="ai-welcome">
      <div className="ed-ai-welcome-glyph" aria-hidden="true">
        <Icon name="sparkles" size={22} strokeWidth={1.7} />
      </div>
      <h3 className="ed-ai-welcome-title">{t('ai.welcome.title')}</h3>
      <p className="ed-ai-welcome-text">{folder ? t('ai.welcome.text', { name, folder }) : t('ai.welcome.textNoFolder', { name })}</p>
      <div className="ed-ai-group-title">{t('ai.welcome.suggestions')}</div>
      <div className="ed-ai-suggestions">
        {suggestions.map((s) => (
          <button
            key={s.id}
            type="button"
            className="ed-ai-suggestion"
            onClick={() => {
              ai.setDraft(t(s.key));
              requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('[data-testid=ai-input]')?.focus());
            }}
            data-testid="ai-suggestion"
          >
            <Icon name="sparkle" size={13} className="ed-ai-suggestion-icon" />
            <span>{t(s.key)}</span>
          </button>
        ))}
      </div>
      {tasks.length > 0 && (
        <>
          <div className="ed-ai-group-title">{t('ai.welcome.tasks')}</div>
          <div className="ed-ai-suggestions">
            {tasks.map((task) => (
              <button key={task.kind} type="button" className="ed-ai-suggestion" title={task.description} onClick={() => ai.selectTask(task)} data-testid={`ai-task-${task.kind}`}>
                <Icon name="wand" size={13} className="ed-ai-suggestion-icon" />
                <span>{taskTitle(task, t)}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Request({ view }: { view: JobView }) {
  const t = useT();
  const text = requestText(view);
  return (
    <div className="ed-ai-request">
      {view.job.kind !== 'freeform' && (
        <span className="ed-ai-request-kind">
          <Icon name="wand" size={11} />
          {taskTitle({ kind: view.job.kind, title: view.job.title }, t)}
        </span>
      )}
      {(view.prompt || view.job.kind === 'freeform') && (
        <div className="ed-ai-bubble" data-testid="ai-request">
          {text}
        </div>
      )}
      {view.job.images.length > 0 && (
        <div className="ed-ai-attachments">
          {view.job.images.map((img) => (
            <span key={img} className="ed-ai-attachment" title={img}>
              <Icon name="image" size={12} />
              {baseName(img)}
            </span>
          ))}
        </div>
      )}
      {view.job.allowImageGeneration && <span className="ed-ai-request-note">{t('ai.request.imageGeneration')}</span>}
    </div>
  );
}

function TurnEnd({ view }: { view: JobView }) {
  const t = useT();
  const { job } = view;
  const usage = view.usage ?? job.usage;
  const icon = job.state === 'done' ? 'checkCircle' : job.state === 'cancelled' ? 'stop' : 'error';
  const parts = [durationText(jobDuration(job, Date.now()), t)];
  if (usage) parts.push(t('ai.turn.tokens', { input: formatCount(usage.inputTokens), output: formatCount(usage.outputTokens) }));
  if (usage?.costUsd !== undefined) parts.push(`$${usage.costUsd.toFixed(usage.costUsd < 1 ? 3 : 2)}`);
  return (
    <div className="ed-ai-turn-end" data-state={job.state} data-testid="ai-turn-end">
      <Icon name={icon} size={12} />
      <span className="ed-ai-turn-state">{job.state === 'done' ? t('ai.state.done') : job.state === 'cancelled' ? t('ai.state.cancelled') : t('ai.state.failed')}</span>
      <span className="r2-num">{parts.join(' · ')}</span>
    </div>
  );
}

function Typing() {
  const t = useT();
  return (
    <div className="ed-ai-typing" role="status" aria-label={t('ai.progress.working')} data-testid="ai-typing">
      <span />
      <span />
      <span />
    </div>
  );
}

function Turn({ view }: { view: JobView }) {
  const t = useT();
  const blocks = useMemo(() => blocksOf(view.rows, prominentErrors(view)), [view]);
  const running = !isFinal(view.job.state);
  const lastActivity = blocks.map((b) => b.type).lastIndexOf('activity');
  const final = view.done?.message ?? view.job.finalMessage;
  // A final message that only came with the end of the job (no message event): show it once.
  const showFinal = !running && final && !view.rows.some((r) => r.kind === 'message' && r.text === final);
  return (
    <section className="ed-ai-turn" data-state={view.job.state} data-job={view.job.id} data-testid="ai-turn">
      <Request view={view} />
      {view.gap && <p className="ed-ai-gap">{t('ai.turn.gap')}</p>}
      {blocks.map((b, i) => {
        switch (b.type) {
          case 'message':
            return (
              <div key={b.row.key} className="ed-ai-answer" data-testid="ai-message">
                <MessageText text={b.row.text} />
              </div>
            );
          case 'activity':
            return <ActivityBlock key={b.key} rows={b.rows} live={running && i === lastActivity && i === blocks.length - 1} cwd={view.job.cwd} />;
          case 'todo':
            return <TodoCard key={b.row.key} row={b.row} />;
          case 'error':
            return b.row.code === SANDBOX_CODE ? null : <ErrorBlock key={b.row.key} row={b.row} />;
          case 'model-updated':
            return <ModelUpdated key={b.row.key} />;
        }
      })}
      {showFinal && (
        <div className="ed-ai-answer" data-testid="ai-message">
          <MessageText text={final} />
        </div>
      )}
      {view.sandbox && view.job.provider === 'codex' && <SandboxCard view={view} />}
      {running ? <Typing /> : <TurnEnd view={view} />}
    </section>
  );
}

export function ConversationView() {
  const jobs = useStore(ai.store, (s) => conversationJobs(s.jobs, s.conversation), shallowEqual);
  const conversation = useStore(ai.store, (s) => s.conversation);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Follow the newest activity while the person is at the bottom; a conversation opens at its end,
  // the welcome at its top.
  const empty = jobs.length === 0;
  useLayoutEffect(() => {
    stick.current = !empty;
    if (empty && scroller.current) scroller.current.scrollTop = 0;
  }, [conversation, empty]);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current && !empty) el.scrollTop = el.scrollHeight;
  });

  return (
    <div
      ref={scroller}
      className="ed-ai-scroll r2-scroll"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      }}
      data-testid="ai-conversation"
    >
      {jobs.length === 0 ? <Welcome /> : jobs.map((v) => <Turn key={v.job.id} view={v} />)}
    </div>
  );
}
