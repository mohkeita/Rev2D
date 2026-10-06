/**
 * What went wrong with a request to the agent bridge, as something the panel can explain (pure).
 *
 * The server answers errors as JSON {error, hint?, code?, ...} (docs/AGENT-BRIDGE.md, Errors). The
 * panel never shows that JSON: `problemFrom` sorts an answer into a kind, and `explainProblem` turns
 * the kind into a title, a sentence and, where there is one, the server's hint and an action.
 */
import type { AgentProviderInfo } from '../../../src/node/editor-registry.js';
import type { MessageKey, MessageVars } from '../i18n/index.js';

export type AiProblemKind =
  /** 404 agent-disabled: the editor is not bound to a loopback address. */
  | 'disabled'
  /** 401 token-required, also after fetching a fresh token. */
  | 'token'
  /** 409 busy: another job is queued or running (`jobId` names it). */
  | 'busy'
  /** 409 not-resumable: the job a follow-up continues is still running or never got a session. */
  | 'not-resumable'
  /** 409 unavailable: the provider's CLI is not installed or does not start. */
  | 'unavailable'
  /** 429 rate-limited (`retryAfter` seconds). */
  | 'rate-limited'
  /** 413 too-large. */
  | 'too-large'
  /** 409 settings-file: the person's settings file cannot be written. */
  | 'settings-file'
  /** 404 unknown-job: the server no longer remembers the job (it restarted, or it keeps the newest 20). */
  | 'unknown-job'
  /** 403: a path outside the workspace, or a foreign page. */
  | 'forbidden'
  /** 400 invalid (and any other 4xx). */
  | 'invalid'
  /** The server could not be reached. */
  | 'network'
  /** 5xx or an answer that is not JSON. */
  | 'server';

export interface AiProblem {
  kind: AiProblemKind;
  /** HTTP status (0 when the server could not be reached). */
  status: number;
  /** The server's own text (English), shown as the detail. */
  message: string;
  hint?: string;
  code?: string;
  /** busy: the job that runs. */
  jobId?: string;
  /** rate-limited: seconds to wait. */
  retryAfter?: number;
}

const CODE_KINDS: Record<string, AiProblemKind> = {
  'agent-disabled': 'disabled',
  'token-required': 'token',
  busy: 'busy',
  'not-resumable': 'not-resumable',
  unavailable: 'unavailable',
  'rate-limited': 'rate-limited',
  'too-large': 'too-large',
  'settings-file': 'settings-file',
  'unknown-job': 'unknown-job',
  invalid: 'invalid',
};

/** Sort an error answer (status + parsed JSON body, or null) into a problem. */
export function problemFrom(status: number, body: unknown): AiProblem {
  const b = (typeof body === 'object' && body !== null && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const message = typeof b.error === 'string' && b.error ? b.error : status ? `HTTP ${status}` : 'no answer';
  const code = typeof b.code === 'string' ? b.code : undefined;
  let kind: AiProblemKind;
  if (status === 0) kind = 'network';
  else if (code && CODE_KINDS[code]) kind = CODE_KINDS[code]!;
  else if (status === 401) kind = 'token';
  else if (status === 403) kind = 'forbidden';
  else if (status === 413) kind = 'too-large';
  else if (status === 429) kind = 'rate-limited';
  else if (status >= 500 || status < 400) kind = 'server';
  else kind = 'invalid';
  const p: AiProblem = { kind, status, message };
  if (typeof b.hint === 'string' && b.hint) p.hint = b.hint;
  if (code) p.code = code;
  if (typeof b.job === 'string') p.jobId = b.job;
  const retry = typeof b.retryAfter === 'number' ? b.retryAfter : undefined;
  if (retry !== undefined && Number.isFinite(retry)) p.retryAfter = retry;
  return p;
}

/** A problem for a request that never got an answer. */
export function networkProblem(error: unknown): AiProblem {
  return { kind: 'network', status: 0, message: error instanceof Error ? error.message : String(error) };
}

export type ProblemAction = 'show-job' | 'reload-page' | 'retry';

export interface ProblemText {
  title: { key: MessageKey; vars?: MessageVars };
  text: { key: MessageKey; vars?: MessageVars } | null;
  /** The server's hint (English, as it was written for the person: commands to run). */
  hint: string | null;
  /** The server's own message, shown as the detail line when the sentence does not already say it. */
  detail: string | null;
  action: ProblemAction | null;
  tone: 'warning' | 'danger' | 'info';
}

/**
 * The words for a problem (as i18n keys, so this stays pure). `provider` is the provider the request
 * was for: an "unavailable" answer is explained with its install / login hint.
 */
export function explainProblem(p: AiProblem, provider?: AgentProviderInfo | null): ProblemText {
  const name = provider?.name ?? 'the agent';
  switch (p.kind) {
    case 'disabled':
      return { title: { key: 'ai.problem.disabled.title' }, text: { key: 'ai.problem.disabled.text' }, hint: p.hint ?? null, detail: null, action: null, tone: 'info' };
    case 'token':
      return { title: { key: 'ai.problem.token.title' }, text: { key: 'ai.problem.token.text' }, hint: null, detail: null, action: 'reload-page', tone: 'warning' };
    case 'busy':
      return { title: { key: 'ai.problem.busy.title' }, text: { key: 'ai.problem.busy.text' }, hint: null, detail: null, action: p.jobId ? 'show-job' : null, tone: 'info' };
    case 'not-resumable':
      return { title: { key: 'ai.problem.notResumable.title' }, text: { key: 'ai.problem.notResumable.text' }, hint: null, detail: p.message, action: null, tone: 'info' };
    case 'unavailable':
      return {
        title: { key: 'ai.problem.unavailable.title', vars: { name } },
        text: { key: 'ai.problem.unavailable.text' },
        hint: p.hint ?? provider?.hint ?? null,
        detail: null,
        action: 'retry',
        tone: 'warning',
      };
    case 'rate-limited':
      return { title: { key: 'ai.problem.rate.title' }, text: { key: 'ai.problem.rate.text', vars: { s: p.retryAfter ?? 60 } }, hint: null, detail: null, action: null, tone: 'warning' };
    case 'too-large':
      return { title: { key: 'ai.problem.tooLarge.title' }, text: { key: 'ai.problem.tooLarge.text' }, hint: null, detail: p.message, action: null, tone: 'warning' };
    case 'settings-file':
      return { title: { key: 'ai.problem.settingsFile.title' }, text: null, hint: p.hint ?? null, detail: p.message, action: null, tone: 'danger' };
    case 'unknown-job':
      return { title: { key: 'ai.problem.unknownJob.title' }, text: { key: 'ai.problem.unknownJob.text' }, hint: null, detail: null, action: null, tone: 'info' };
    case 'forbidden':
      return { title: { key: 'ai.problem.forbidden.title' }, text: null, hint: p.hint ?? null, detail: p.message, action: null, tone: 'danger' };
    case 'network':
      return { title: { key: 'ai.problem.network.title' }, text: { key: 'ai.problem.network.text' }, hint: null, detail: null, action: 'retry', tone: 'warning' };
    case 'server':
      return { title: { key: 'ai.problem.server.title' }, text: null, hint: p.hint ?? null, detail: p.message, action: 'retry', tone: 'danger' };
    case 'invalid':
    default:
      return { title: { key: 'ai.problem.invalid.title' }, text: null, hint: p.hint ?? null, detail: p.message, action: null, tone: 'danger' };
  }
}
