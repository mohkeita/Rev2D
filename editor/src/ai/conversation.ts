/**
 * The conversation model of the AI panel (pure: no DOM, no network, no i18n).
 *
 * The agent bridge reports a job as a stream of events (docs/AGENT-BRIDGE.md §2): `seq` counts from 1
 * inside a job; items (command, file, tool, todo) keep the provider's item id and are reported again
 * when they change or end. This module folds such a stream into a JobView:
 *
 * - one row per item id, replaced in place (a command keeps its place when it ends);
 * - one to-do checklist per job (Claude Code reports every update under a new id), updated in place;
 * - messages and errors as rows in arrival order; progress statuses (queued, running, session, turn)
 *   only as the job's latest status, notable ones (retry, stalled) also as a row;
 * - `done` ends the job: its error becomes a row unless the same error was already reported;
 * - events are applied once each and strictly in order: a stream that skips a seq reports `missing`
 *   (fetch `GET /api/agent/jobs/:id?since=<lastSeq>` and apply that), and an answer whose firstSeq lies
 *   past lastSeq + 1 (the server dropped old events) is accepted with `gap` set.
 *
 * A conversation is the jobs that share `job.conversation` (a follow-up is a new job that resumes the
 * provider session of the previous one), shown in the order they were created.
 */
import type { AgentEvent, AgentFileChange, AgentItemStatus, AgentJobInfo, AgentJobState, AgentUsage } from '../../../src/node/editor-registry.js';

/** The code the runner gives the Codex Windows sandbox problem (src/node/agent/types.ts). */
export const SANDBOX_CODE = 'codex-windows-sandbox';

export type DoneEvent = Extract<AgentEvent, { type: 'done' }>;

export type ActivityRow =
  | { kind: 'reasoning'; key: string; seq: number; text: string }
  | { kind: 'command'; key: string; seq: number; id: string; status: AgentItemStatus; command: string; exitCode: number | null; output: string; outputTruncated: boolean }
  | { kind: 'file'; key: string; seq: number; id: string; status: AgentItemStatus; changes: AgentFileChange[] }
  | { kind: 'tool'; key: string; seq: number; id: string; status: AgentItemStatus; tool: string; server?: string; input?: string; result?: string; error?: string }
  | { kind: 'todo'; key: string; seq: number; items: Array<{ text: string; done: boolean }> }
  | { kind: 'error'; key: string; seq: number; message: string; hint?: string; code?: string }
  /** A status worth a line of its own: a retry, or the provider going silent ("stalled"). */
  | { kind: 'notice'; key: string; seq: number; status: string; text: string; hint?: string; code?: string }
  /** The open model was reloaded because the file changed on disk while this job ran (added by the panel). */
  | { kind: 'model-updated'; key: string; seq: number };

export type MessageRow = { kind: 'message'; key: string; seq: number; text: string; truncated?: boolean };

export type Row = ActivityRow | MessageRow;

export interface JobView {
  job: AgentJobInfo;
  /** The request in the person's words (GET /api/agent/jobs/:id); null until fetched. */
  prompt: string | null;
  rows: Row[];
  /** Highest seq applied. */
  lastSeq: number;
  /** Older events were dropped by the server (the job's log file has them). */
  gap: boolean;
  /** Latest progress status (queued, running, session, turn, retry, stalled). */
  status: { status: string; text: string; seq: number } | null;
  done: DoneEvent | null;
  usage: AgentUsage | null;
  /** The job ran into the Codex Windows sandbox problem: an `error` event or a `stalled` status with its code. */
  sandbox: 'error' | 'stalled' | null;
}

export const FINAL_STATES: readonly AgentJobState[] = ['done', 'failed', 'cancelled'];

export function isFinal(state: AgentJobState): boolean {
  return FINAL_STATES.includes(state);
}

export function emptyJobView(job: AgentJobInfo, prompt: string | null = null): JobView {
  return { job, prompt, rows: [], lastSeq: 0, gap: false, status: null, done: null, usage: job.usage, sandbox: null };
}

/**
 * Take a newer snapshot of the job (an SSE payload carries the job as it is right after its event).
 * An older snapshot (lower lastSeq, or running after the view saw the end) is ignored.
 */
export function applyJobInfo(view: JobView, job: AgentJobInfo): JobView {
  if (job.id !== view.job.id) return view;
  if (job.lastSeq < view.job.lastSeq) return view;
  if (isFinal(view.job.state) && !isFinal(job.state)) return view;
  return { ...view, job, usage: job.usage ?? view.usage };
}

const ITEM_TYPES = new Set(['command', 'file', 'tool']);
/** Status events that only update the progress line. */
const QUIET_STATUSES = new Set(['queued', 'running', 'session', 'turn']);

function upsert(rows: Row[], row: Row): Row[] {
  const i = rows.findIndex((r) => r.key === row.key);
  if (i < 0) return [...rows, row];
  const next = rows.slice();
  // Keep the position (and the seq it was first seen at).
  next[i] = { ...row, seq: rows[i]!.seq } as Row;
  return next;
}

/** Fold one event into the view (the caller checked the order). */
function applyOne(view: JobView, e: AgentEvent): JobView {
  const v: JobView = { ...view, lastSeq: e.seq };
  switch (e.type) {
    case 'status': {
      v.status = { status: e.status, text: e.text, seq: e.seq };
      if (e.code === SANDBOX_CODE && !v.sandbox) v.sandbox = 'stalled';
      if (!QUIET_STATUSES.has(e.status)) {
        v.rows = [...v.rows, { kind: 'notice', key: `seq:${e.seq}`, seq: e.seq, status: e.status, text: e.text, ...(e.hint ? { hint: e.hint } : {}), ...(e.code ? { code: e.code } : {}) }];
      }
      return v;
    }
    case 'message':
      v.rows = [...v.rows, { kind: 'message', key: `seq:${e.seq}`, seq: e.seq, text: e.text, ...(e.truncated ? { truncated: true } : {}) }];
      return v;
    case 'reasoning':
      v.rows = [...v.rows, { kind: 'reasoning', key: `seq:${e.seq}`, seq: e.seq, text: e.text }];
      return v;
    case 'command':
      v.rows = upsert(v.rows, { kind: 'command', key: `command:${e.id}`, seq: e.seq, id: e.id, status: e.status, command: e.command, exitCode: e.exitCode, output: e.output, outputTruncated: e.outputTruncated });
      return v;
    case 'file':
      v.rows = upsert(v.rows, { kind: 'file', key: `file:${e.id}`, seq: e.seq, id: e.id, status: e.status, changes: e.changes });
      return v;
    case 'tool':
      v.rows = upsert(v.rows, {
        kind: 'tool',
        key: `tool:${e.id}`,
        seq: e.seq,
        id: e.id,
        status: e.status,
        tool: e.tool,
        ...(e.server !== undefined ? { server: e.server } : {}),
        ...(e.input !== undefined ? { input: e.input } : {}),
        ...(e.result !== undefined ? { result: e.result } : {}),
        ...(e.error !== undefined ? { error: e.error } : {}),
      });
      return v;
    case 'todo':
      // One checklist per job, whatever ids the provider gives its updates.
      v.rows = upsert(v.rows, { kind: 'todo', key: 'todo', seq: e.seq, items: e.items });
      return v;
    case 'usage': {
      const { seq: _s, time: _t, type: _y, ...usage } = e;
      v.usage = usage;
      return v;
    }
    case 'error':
      if (e.code === SANDBOX_CODE) v.sandbox = 'error';
      v.rows = [...v.rows, { kind: 'error', key: `seq:${e.seq}`, seq: e.seq, message: e.message, ...(e.hint ? { hint: e.hint } : {}), ...(e.code ? { code: e.code } : {}) }];
      return v;
    case 'done': {
      v.done = e;
      v.status = null;
      // A failure the stream did not report yet (a cancel is not an error: the panel says "Stopped").
      if (e.state === 'failed' && e.error && !v.rows.some((r) => r.kind === 'error' && r.message === e.error)) {
        v.rows = [...v.rows, { kind: 'error', key: `seq:${e.seq}`, seq: e.seq, message: e.error, ...(e.hint ? { hint: e.hint } : {}) }];
      }
      return v;
    }
    default:
      return v;
  }
}

export interface ApplyResult {
  view: JobView;
  /** Events are missing between lastSeq and the next one given: fetch them (since = view.lastSeq). */
  missing: boolean;
}

/**
 * Apply events in seq order, skipping the ones already applied. `firstSeq` (from GET .../jobs/:id) says
 * the server no longer has the events before it: then the jump is accepted and the view marks the gap.
 * Without it a jump stops the application and reports `missing`.
 */
export function applyEvents(view: JobView, events: readonly AgentEvent[], opts: { firstSeq?: number } = {}): ApplyResult {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  let v = view;
  let missing = false;
  let gapAllowed = opts.firstSeq !== undefined && opts.firstSeq > v.lastSeq + 1;
  for (const e of sorted) {
    if (e.seq <= v.lastSeq) continue;
    if (e.seq > v.lastSeq + 1) {
      if (!gapAllowed) {
        missing = true;
        break;
      }
      v = { ...v, gap: true };
    }
    gapAllowed = false;
    v = applyOne(v, e);
  }
  return { view: v, missing };
}

/** A quiet row after the open model was reloaded because this job changed it (one per burst). */
export function noteModelUpdated(view: JobView): JobView {
  const last = view.rows[view.rows.length - 1];
  if (last?.kind === 'model-updated') return view;
  return { ...view, rows: [...view.rows, { kind: 'model-updated', key: `model:${view.lastSeq}:${view.rows.length}`, seq: view.lastSeq }] };
}

// ----------------------------------------------------------------------------- conversations

/** The jobs of a conversation, oldest first. */
export function conversationJobs(jobs: Readonly<Record<string, JobView>>, conversation: string | null): JobView[] {
  if (!conversation) return [];
  return Object.values(jobs)
    .filter((v) => v.job.conversation === conversation)
    .sort((a, b) => a.job.createdAt.localeCompare(b.job.createdAt) || a.job.id.localeCompare(b.job.id));
}

/** The newest job of a conversation (the one a follow-up continues). */
export function lastJob(jobs: Readonly<Record<string, JobView>>, conversation: string | null): JobView | null {
  const list = conversationJobs(jobs, conversation);
  return list[list.length - 1] ?? null;
}

/**
 * The errors a turn shows as a card of their own: those with a hint or a known code, and the one that
 * ended a failed job. Other errors (a reconnect, a tool that timed out) are rows of the activity.
 */
export function prominentErrors(view: JobView): (row: ErrorRow) => boolean {
  let last: string | null = null;
  if (view.job.state === 'failed') for (const r of view.rows) if (r.kind === 'error') last = r.key;
  return (row) => !!row.hint || !!row.code || row.key === last;
}

/** Whether a follow-up can continue the job's provider session (POST .../message). */
export function isResumable(job: AgentJobInfo): boolean {
  return isFinal(job.state) && !!job.sessionId;
}

export type ErrorRow = Extract<ActivityRow, { kind: 'error' }>;
export type ModelUpdatedRow = Extract<ActivityRow, { kind: 'model-updated' }>;
export type TodoRow = Extract<ActivityRow, { kind: 'todo' }>;

export type Block =
  | { type: 'message'; row: MessageRow }
  | { type: 'error'; row: ErrorRow }
  | { type: 'model-updated'; row: ModelUpdatedRow }
  | { type: 'todo'; row: TodoRow }
  | { type: 'activity'; key: string; rows: ActivityRow[] };

/**
 * Rows grouped for display: agent messages, the to-do checklist, "model updated" notes and the errors
 * that matter (`prominent`) on their own, and the activity between them as one collapsible block (a
 * passing error, such as a reconnect the provider recovered from, stays a quiet row in it).
 */
export function blocksOf(rows: readonly Row[], prominent: (row: ErrorRow) => boolean = () => true): Block[] {
  const out: Block[] = [];
  for (const row of rows) {
    if (row.kind === 'message') {
      out.push({ type: 'message', row });
      continue;
    }
    if (row.kind === 'error' && prominent(row)) {
      out.push({ type: 'error', row });
      continue;
    }
    if (row.kind === 'model-updated') {
      out.push({ type: 'model-updated', row });
      continue;
    }
    if (row.kind === 'todo') {
      out.push({ type: 'todo', row });
      continue;
    }
    const prev = out[out.length - 1];
    if (prev?.type === 'activity') prev.rows.push(row);
    else out.push({ type: 'activity', key: `activity:${row.key}`, rows: [row] });
  }
  return out;
}

export interface ActivitySummary {
  commands: number;
  failedCommands: number;
  /** Distinct paths changed. */
  files: number;
  tools: number;
  errors: number;
  running: boolean;
}

export function summarize(rows: readonly ActivityRow[]): ActivitySummary {
  const paths = new Set<string>();
  const s: ActivitySummary = { commands: 0, failedCommands: 0, files: 0, tools: 0, errors: 0, running: false };
  for (const r of rows) {
    if (r.kind === 'command') {
      s.commands++;
      if (r.status === 'failed' || r.status === 'declined' || (r.exitCode !== null && r.exitCode !== 0)) s.failedCommands++;
    } else if (r.kind === 'file') {
      for (const c of r.changes) paths.add(c.path);
    } else if (r.kind === 'tool') s.tools++;
    else if (r.kind === 'error') s.errors++;
    if ((r.kind === 'command' || r.kind === 'file' || r.kind === 'tool') && r.status === 'running') s.running = true;
  }
  s.files = paths.size;
  return s;
}

/** What the job is doing now, for the progress line: the panel turns it into words. */
export type Progress =
  | { kind: 'starting' }
  | { kind: 'working' }
  | { kind: 'thinking' }
  | { kind: 'command'; detail: string }
  | { kind: 'editing'; detail: string }
  | { kind: 'tool'; detail: string }
  | { kind: 'retry'; detail: string }
  | { kind: 'stalled' }
  | { kind: 'ended'; state: AgentJobState };

export function progressOf(view: JobView): Progress {
  if (isFinal(view.job.state)) return { kind: 'ended', state: view.job.state };
  if (view.job.state === 'queued' || !view.status || view.status.status === 'queued') {
    if (view.rows.length === 0) return { kind: 'starting' };
  }
  // A stalled notice newer than everything else.
  const newest = view.rows[view.rows.length - 1];
  if (view.status?.status === 'stalled' && (!newest || newest.seq <= view.status.seq)) return { kind: 'stalled' };
  for (let i = view.rows.length - 1; i >= 0; i--) {
    const r = view.rows[i]!;
    if ((r.kind === 'command' || r.kind === 'file' || r.kind === 'tool') && r.status === 'running') {
      if (r.kind === 'command') return { kind: 'command', detail: r.command };
      if (r.kind === 'file') return { kind: 'editing', detail: r.changes.map((c) => baseName(c.path)).join(', ') };
      return { kind: 'tool', detail: r.tool };
    }
  }
  if (view.status?.status === 'retry' && (!newest || newest.seq <= view.status.seq)) return { kind: 'retry', detail: view.status.text };
  // (An agent message in the middle of a turn is not the end of it: it keeps working.)
  if (newest?.kind === 'reasoning') return { kind: 'thinking' };
  return { kind: 'working' };
}

// ----------------------------------------------------------------------------- time, numbers, paths

function parseTime(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** Milliseconds the job ran (until now while it runs). */
export function jobDuration(job: AgentJobInfo, now: number): number {
  const start = parseTime(job.startedAt) ?? parseTime(job.createdAt);
  if (start === null) return 0;
  const end = parseTime(job.endedAt) ?? (isFinal(job.state) ? start : now);
  return Math.max(0, end - start);
}

/** "0:07", "4:12", "1:02:03": an elapsed time that changes in place. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function normalize(p: string): string {
  return p.replace(/\\/g, '/');
}

export function baseName(p: string): string {
  const s = normalize(p).replace(/\/+$/, '');
  return s.slice(s.lastIndexOf('/') + 1) || s;
}

export function isAbsolutePath(p: string): boolean {
  return /^([a-zA-Z]:[\\/]|[\\/])/.test(p);
}

/** A path the provider reported (absolute, or relative to the job's working directory) as an absolute path. */
export function resolveAgentPath(p: string, cwd: string): string {
  if (isAbsolutePath(p)) return normalize(p);
  const base = normalize(cwd).replace(/\/+$/, '');
  const parts = [...base.split('/'), ...normalize(p).split('/')];
  const out: string[] = [];
  for (const part of parts) {
    if (part === '.' || (part === '' && out.length > 0)) continue;
    if (part === '..' && out.length > 1) out.pop();
    else out.push(part);
  }
  return out.join('/');
}

/** Files the editor can open: Rev2D models and avatar projects. */
export function isModelPath(p: string): boolean {
  return /\.r2d\.jsonc?$/i.test(p) || /(^|[\\/])avatar\.json$/i.test(p);
}

/** The agent's request as one line (for lists and the follow-up "run again"). */
export function requestText(view: JobView): string {
  return view.prompt || view.job.title;
}
