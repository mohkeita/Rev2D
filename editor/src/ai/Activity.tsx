/**
 * The activity of a job between the agent's messages: one collapsible plate with a row per command,
 * file change, tool call, reasoning summary and notice (each row keeps its place and updates in place),
 * plus the blocks that stand on their own: the to-do checklist, errors, "Model updated".
 */
import { useState, type ReactNode } from 'react';
import { Badge, Icon, Spinner, type IconName } from '../design/index.js';
import { relativeToRoot, samePath } from '../files/paths.js';
import { useT } from '../i18n/index.js';
import { useApp, useSession } from '../state/context.js';
import { isModelPath, resolveAgentPath, summarize, type ActivityRow, type ErrorRow, type TodoRow } from './conversation.js';
import { MessageText } from './MessageText.js';
import { shortCommand } from './words.js';

type ItemStatus = 'running' | 'completed' | 'failed' | 'declined';

function StatusMark({ status, exitCode }: { status: ItemStatus; exitCode?: number | null }) {
  const t = useT();
  if (status === 'running') return <Spinner size={12} className="ed-ai-mark" />;
  if (status === 'declined') return <Badge tone="warning">{t('ai.row.declined')}</Badge>;
  const failed = status === 'failed' || (exitCode !== undefined && exitCode !== null && exitCode !== 0);
  if (failed) {
    return (
      <Badge tone="danger" className="ed-ai-mark">
        {exitCode !== undefined && exitCode !== null ? t('ai.row.exit', { code: exitCode }) : t('ai.row.failed')}
      </Badge>
    );
  }
  return <Icon name="check" size={14} strokeWidth={2.4} className="ed-ai-mark ed-ai-ok" aria-label={t('ai.row.ok')} />;
}

/** A row of the plate: icon, one line of text, a status mark; expandable when it has details. */
function Row({ kind, status, icon, children, mark, details, testid }: { kind: string; status?: string; icon: IconName; children: ReactNode; mark?: ReactNode; details?: ReactNode; testid: string }) {
  const [open, setOpen] = useState(false);
  const expandable = details != null;
  const main = (
    <>
      <Icon name={icon} size={14} className="ed-ai-row-icon" />
      <span className="ed-ai-row-text">{children}</span>
      {mark}
      {expandable && <Icon name="chevronRight" size={11} strokeWidth={2.4} className="ed-ai-row-chevron" />}
    </>
  );
  return (
    <li className="ed-ai-row" data-kind={kind} data-status={status} data-open={open ? '' : undefined} data-testid={testid}>
      {expandable ? (
        <button type="button" className="ed-ai-row-main" aria-expanded={open} onClick={() => setOpen(!open)}>
          {main}
        </button>
      ) : (
        <div className="ed-ai-row-main">{main}</div>
      )}
      {open && details}
    </li>
  );
}

function CommandRow({ row }: { row: Extract<ActivityRow, { kind: 'command' }> }) {
  const t = useT();
  const details = row.output ? (
    <div className="ed-ai-details">
      <div className="ed-ai-details-command ed-mono-small">{row.command}</div>
      <pre className="ed-ai-output r2-scroll">
        {row.outputTruncated && <span className="ed-faint">{`${t('ai.row.outputCut')}\n`}</span>}
        {row.output.replace(/\n+$/, '')}
      </pre>
    </div>
  ) : row.command.length > 48 ? (
    <div className="ed-ai-details">
      <div className="ed-ai-details-command ed-mono-small">{row.command}</div>
    </div>
  ) : undefined;
  return (
    <Row kind="command" status={row.status} icon="terminal" mark={<StatusMark status={row.status} exitCode={row.exitCode} />} details={details} testid="ai-command">
      <span className="ed-ai-code" title={row.command}>
        {shortCommand(row.command)}
      </span>
    </Row>
  );
}

const CHANGE_ICON = { add: 'fileNew', update: 'pencil', delete: 'trash' } as const;
const CHANGE_KEY = { add: 'ai.file.add', update: 'ai.file.update', delete: 'ai.file.delete' } as const;

function FileRow({ row, cwd }: { row: Extract<ActivityRow, { kind: 'file' }>; cwd: string }) {
  const t = useT();
  const session = useSession();
  const root = useApp((s) => s.workspace?.root ?? null);
  const open = useApp((s) => s.file);
  return (
    <>
      {row.changes.map((c, i) => {
        const abs = resolveAgentPath(c.path, cwd);
        const shown = (root ? relativeToRoot(abs, root) : null) ?? c.path;
        const isOpen = samePath(abs, open);
        const show = c.kind !== 'delete' && isModelPath(abs) ? (
          <button
            type="button"
            className="ed-link ed-ai-show"
            onClick={() => (isOpen ? session.focus('fit') : void session.openFile(abs))}
            data-testid="ai-file-show"
          >
            {isOpen ? t('ai.file.show') : t('ai.file.open')}
          </button>
        ) : null;
        return (
          <Row key={`${c.path}:${i}`} kind="file" status={row.status} icon={CHANGE_ICON[c.kind]} mark={row.status === 'running' ? <Spinner size={12} className="ed-ai-mark" /> : show} testid="ai-file">
            <span className="ed-ai-verb">{t(CHANGE_KEY[c.kind])}</span> <span className="ed-ai-path" title={abs}>{shown}</span>
          </Row>
        );
      })}
    </>
  );
}

const TOOL_ICON: Record<string, IconName> = { image_generation: 'image', web_search: 'search' };

function ToolRow({ row }: { row: Extract<ActivityRow, { kind: 'tool' }> }) {
  const t = useT();
  const name = row.server ? `${row.server} · ${row.tool}` : row.tool;
  const parts = [
    row.input ? [t('ai.tool.input'), row.input] : null,
    row.result ? [t('ai.tool.result'), row.result] : null,
    row.error ? [t('ai.tool.error'), row.error] : null,
  ].filter((p): p is [string, string] => p !== null);
  const details = parts.length ? (
    <dl className="ed-ai-details ed-ai-tool-details">
      {parts.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd className="ed-mono-small">{v}</dd>
        </div>
      ))}
    </dl>
  ) : undefined;
  return (
    <Row kind="tool" status={row.status} icon={TOOL_ICON[row.tool] ?? 'wand'} mark={<StatusMark status={row.status} />} details={details} testid="ai-tool">
      <span className="ed-ai-code">{name}</span>
      {row.input && <span className="ed-ai-row-muted"> {row.input}</span>}
    </Row>
  );
}

function ReasoningRow({ row }: { row: Extract<ActivityRow, { kind: 'reasoning' }> }) {
  const t = useT();
  const first = row.text.replace(/\*\*/g, '').split('\n').find((l) => l.trim()) ?? '';
  return (
    <Row kind="reasoning" icon="sparkle" details={<MessageText text={row.text} className="ed-ai-details ed-ai-reasoning" />} testid="ai-reasoning">
      <span className="ed-ai-verb">{t('ai.row.thinking')}</span> <span className="ed-ai-row-muted">{first}</span>
    </Row>
  );
}

function NoticeRow({ row }: { row: Extract<ActivityRow, { kind: 'notice' }> }) {
  const t = useT();
  const stalled = row.status === 'stalled';
  return (
    <Row kind="notice" status={row.status} icon={stalled ? 'clock' : 'refresh'} details={<p className="ed-ai-details ed-ai-row-muted">{row.text}</p>} testid="ai-notice">
      {stalled ? t('ai.notice.stalled') : row.status === 'retry' ? t('ai.notice.retry') : row.text}
    </Row>
  );
}

/** An error the job got past (or not yet): a quiet row; the panel shows the ones that matter as cards. */
function QuietErrorRow({ row }: { row: ErrorRow }) {
  return (
    <Row kind="error" icon="warning" details={row.message.length > 60 ? <p className="ed-ai-details ed-ai-row-muted">{row.message}</p> : undefined} testid="ai-error-row">
      <span className="ed-ai-row-muted">{row.message}</span>
    </Row>
  );
}

function rowOf(row: ActivityRow, cwd: string): ReactNode {
  switch (row.kind) {
    case 'command':
      return <CommandRow key={row.key} row={row} />;
    case 'file':
      return <FileRow key={row.key} row={row} cwd={cwd} />;
    case 'tool':
      return <ToolRow key={row.key} row={row} />;
    case 'reasoning':
      return <ReasoningRow key={row.key} row={row} />;
    case 'notice':
      return <NoticeRow key={row.key} row={row} />;
    case 'error':
      return <QuietErrorRow key={row.key} row={row} />;
    default:
      return null;
  }
}

/** The words of a collapsed block: "Ran 2 commands · Changed 3 files". */
function useSummary(rows: readonly ActivityRow[]): string {
  const t = useT();
  const s = summarize(rows);
  const parts: string[] = [];
  if (s.commands) parts.push(t('ai.activity.commands', { n: s.commands }));
  if (s.files) parts.push(t('ai.activity.files', { n: s.files }));
  if (s.tools) parts.push(t('ai.activity.tools', { n: s.tools }));
  if (!parts.length) parts.push(rows.some((r) => r.kind === 'reasoning') ? t('ai.activity.thought') : t('ai.activity.steps', { n: rows.length }));
  return parts.join(' · ');
}

/**
 * A plate of activity rows. Open while it is the newest activity of a running job (the person sees
 * what happens), folded to a one-line summary afterwards; a click opens or folds it for good.
 */
export function ActivityBlock({ rows, live, cwd }: { rows: ActivityRow[]; live: boolean; cwd: string }) {
  const t = useT();
  const [choice, setChoice] = useState<boolean | null>(null);
  const open = choice ?? live;
  const summary = useSummary(rows);
  const s = summarize(rows);
  return (
    <div className="ed-ai-activity" data-open={open ? '' : undefined} data-live={live ? '' : undefined} data-testid="ai-activity">
      <button type="button" className="ed-ai-activity-head" aria-expanded={open} onClick={() => setChoice(!open)}>
        {live && s.running ? <Spinner size={12} /> : <Icon name="chevronRight" size={11} strokeWidth={2.4} className="ed-ai-activity-chevron" />}
        <span className="ed-ai-activity-summary">{live ? t('ai.activity.working') : summary}</span>
        {live && <span className="ed-ai-activity-count r2-num">{summary}</span>}
        {!live && s.failedCommands > 0 && <Badge tone="danger">{t('ai.activity.failed', { n: s.failedCommands })}</Badge>}
      </button>
      {open && <ul className="ed-ai-rows">{rows.map((r) => rowOf(r, cwd))}</ul>}
    </div>
  );
}

/** The agent's to-do list: a checklist that updates in place. */
export function TodoCard({ row }: { row: TodoRow }) {
  const t = useT();
  const done = row.items.filter((i) => i.done).length;
  return (
    <div className="ed-ai-todo" data-testid="ai-todo">
      <div className="ed-ai-todo-head">
        <span>{t('ai.todo.title')}</span>
        <span className="r2-num ed-ai-todo-count">{t('ai.todo.count', { done, total: row.items.length })}</span>
      </div>
      <ul>
        {row.items.map((item, i) => (
          <li key={i} data-done={item.done ? '' : undefined} data-testid="ai-todo-item">
            <span className="ed-ai-todo-check" aria-hidden="true">
              {item.done && <Icon name="check" size={10} strokeWidth={3.2} />}
            </span>
            <span className="r2-visually-hidden">{item.done ? t('ai.todo.done') : t('ai.todo.open')}: </span>
            <span className="ed-ai-todo-text">{item.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** An error the provider or the runner reported, with its hint. */
export function ErrorBlock({ row }: { row: ErrorRow }) {
  const t = useT();
  return (
    <div className="ed-ai-error" role="alert" data-testid="ai-error">
      <Icon name="warning" size={16} className="ed-ai-error-icon" />
      <div className="ed-ai-error-text">
        <div className="ed-ai-error-title">{t('ai.error.title')}</div>
        <MessageText text={row.message} className="ed-ai-error-message" />
        {row.hint && <MessageText text={row.hint} className="ed-ai-error-hint" />}
      </div>
    </div>
  );
}

export function ModelUpdated() {
  const t = useT();
  return (
    <div className="ed-ai-system" data-testid="ai-model-updated">
      <Icon name="checkCircle" size={13} />
      <span>{t('ai.modelUpdated')}</span>
    </div>
  );
}
