/**
 * The AI panel for other editor modules (avatar mode, future features). Keep these names: other
 * modules code against them.
 *
 *   openAiPanel()                                  show the panel (and load what the bridge offers)
 *   startAiTask({kind, prompt?, context?, images?, allowImageGeneration?, provider?})
 *       -> Promise<{jobId} | {error}>              opens the panel, starts the job, shows its conversation
 *   useAiJob(jobId) -> {state, lastStatus, done}   inline progress of a job anywhere in the UI
 *   aiAvailability() -> {enabled, providers, reason?}
 *
 * `context` is the input of the task template; `project` (a folder of the workspace, relative to its
 * root) becomes the agent's working directory. Left out, the folder of the open model is used, and
 * `file` names the open model. `images` are paths relative to the workspace root (they must exist).
 * Nothing here throws: when the bridge is disabled or a request fails, `{error}` says why (in the
 * current language) and the panel shows the explanation.
 */
import { useContext, useEffect } from 'react';
import type { AgentJobInfo, AgentJobState, AgentProviderId, AgentProviderInfo } from '../../../src/node/editor-registry.js';
import { t as translate, useT } from '../i18n/index.js';
import { SessionContext } from '../state/context.js';
import { shallowEqual, useStore } from '../state/store.js';
import { isFinal, progressOf } from './conversation.js';
import type { AiProblem } from './errors.js';
import { explainProblem } from './errors.js';
import { ai, bindSession, showPanel } from './instance.js';
import type { AiState } from './store.js';
import { progressText } from './words.js';

export type { AiState } from './store.js';
export type { AiProblem, AiProblemKind } from './errors.js';

export interface AiTaskRequest {
  /** Task template (GET /api/agent/tasks), e.g. "avatar-create"; default "freeform" (needs `prompt`). */
  kind?: string;
  prompt?: string;
  context?: Record<string, unknown>;
  /** Images of the workspace (paths relative to the root). */
  images?: string[];
  allowImageGeneration?: boolean;
  /** Default: the provider chosen in the panel. */
  provider?: AgentProviderId;
}

export type AiTaskResult = { jobId: string } | { error: string; code?: string; hint?: string };

export interface AiJobStatus {
  /** null while the job is not known yet (or the bridge is off). */
  state: AgentJobState | null;
  /** What it does now, in the current language ("Running rev2d validate …", "Done"). */
  lastStatus: string | null;
  /** The job has ended (done, failed or cancelled). */
  done: boolean;
  job: AgentJobInfo | null;
  /** Why it failed, when it did. */
  error: string | null;
}

export interface AiAvailability {
  /** The bridge is on and at least one provider is installed. */
  enabled: boolean;
  providers: AgentProviderInfo[];
  /** Why it is not enabled (in the current language), or null. */
  reason?: string;
  /** The panel has not heard from the server yet. */
  loading: boolean;
}

/** Bind the editor session when a component of another module uses the AI API. */
function useBindSession(): void {
  const session = useContext(SessionContext);
  useEffect(() => {
    if (session) bindSession(session);
  }, [session]);
}

function problemMessage(p: AiProblem, provider: AgentProviderInfo | null): string {
  const text = explainProblem(p, provider);
  const title = translate(text.title.key, text.title.vars);
  return text.text ? `${title} ${translate(text.text.key, text.text.vars)}` : `${title}: ${text.detail ?? p.message}`;
}

/** Show the AI panel. */
export function openAiPanel(): void {
  showPanel();
  void ai.init();
}

/** Open the panel, start a job and show its conversation. */
export async function startAiTask(req: AiTaskRequest): Promise<AiTaskResult> {
  openAiPanel();
  const outcome = await ai.start({
    ...(req.kind ? { kind: req.kind } : {}),
    ...(req.prompt ? { prompt: req.prompt } : {}),
    ...(req.context ? { context: req.context } : {}),
    ...(req.images?.length ? { images: req.images } : {}),
    ...(req.allowImageGeneration !== undefined ? { allowImageGeneration: req.allowImageGeneration } : {}),
    ...(req.provider ? { provider: req.provider } : {}),
  });
  if ('jobId' in outcome) return { jobId: outcome.jobId };
  const s = ai.get();
  const provider = s.providers.find((p) => p.id === (req.provider ?? s.provider)) ?? null;
  return { error: problemMessage(outcome.problem, provider), ...(outcome.problem.code ? { code: outcome.problem.code } : {}), ...(outcome.problem.hint ? { hint: outcome.problem.hint } : {}) };
}

function availabilityOf(s: AiState): AiAvailability {
  const loading = s.status === 'idle' || s.status === 'loading';
  const any = s.providers.some((p) => p.available);
  const enabled = s.status === 'ready' && any;
  let reason: string | undefined;
  if (s.status === 'disabled') reason = translate('ai.disabled.short');
  else if (s.status === 'error' && s.loadProblem) reason = problemMessage(s.loadProblem, null);
  else if (s.status === 'ready' && !any) reason = translate('ai.noProvider.short');
  else if (loading) reason = translate('ai.loading');
  return { enabled, providers: s.providers, loading, ...(reason ? { reason } : {}) };
}

/**
 * Whether AI tasks can run. The answer is the current snapshot and also a promise of the answer once
 * the server was asked: `aiAvailability().enabled` or `(await aiAvailability()).enabled`.
 */
export function aiAvailability(): AiAvailability & PromiseLike<AiAvailability> {
  const loaded = ai.init().then(() => availabilityOf(ai.get()));
  const snapshot = availabilityOf(ai.get());
  return Object.assign(snapshot, { then: loaded.then.bind(loaded) as PromiseLike<AiAvailability>['then'] });
}

/** React: availability that updates when the server answers. */
export function useAiAvailability(): AiAvailability {
  useBindSession();
  useEffect(() => {
    void ai.init();
  }, []);
  return useStore(ai.store, availabilityOf, shallowEqual);
}

/** React: the state of a job and what it does now (for a progress strip outside the panel). */
export function useAiJob(jobId: string | null | undefined): AiJobStatus {
  useBindSession();
  const t = useT();
  useEffect(() => {
    if (jobId) ai.track(jobId);
  }, [jobId]);
  const view = useStore(ai.store, (s) => (jobId ? (s.jobs[jobId] ?? null) : null));
  if (!view) return { state: null, lastStatus: null, done: false, job: null, error: null };
  return {
    state: view.job.state,
    lastStatus: progressText(progressOf(view), t),
    done: isFinal(view.job.state),
    job: view.job,
    error: view.job.error?.message ?? null,
  };
}

/** The panel's store, for modules that want more than the hooks give (read only). */
export const aiStore = ai.store;
