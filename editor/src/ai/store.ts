/**
 * State and controller of the AI panel: one store (the editor's Store pattern, state/store.ts) and
 * one controller that talks to the agent bridge (client.ts) and follows its events.
 *
 * Lifecycle
 * - `init()` (idempotent; the panel and every public API call run it): GET /api/session. With the
 *   bridge disabled the state says so (`status: 'disabled'`) and nothing else is asked. Otherwise the
 *   providers, task templates, settings and jobs are read; the conversation shown is the one of the
 *   running job, else the one shown before a page reload (sessionStorage), else the newest one.
 * - Live: the editor's one event stream (api.ts listenToEvents): every "agent-job" event is applied
 *   to its job (conversation.ts: once each, in seq order; a gap triggers GET .../jobs/:id?since=).
 *   After a reconnect the jobs are read again and the shown ones caught up the same way.
 * - Requests: `send` continues the shown conversation (POST .../message) while its last job can be
 *   resumed, else starts a job; failures become `problem` (errors.ts), never thrown.
 */
import type {
  AgentEffort,
  AgentJobDetail,
  AgentJobEventPayload,
  AgentJobInfo,
  AgentProviderId,
  AgentProviderInfo,
  AgentSettingsInfo,
  AgentStartRequest,
  AgentTaskInfo,
  CodexWindowsSandbox,
} from '../../../src/node/editor-registry.js';
import { listenToEvents, type ModelChangedEvent } from '../api.js';
import { Store } from '../state/store.js';
import { createAgentClient, problemOf, type AgentClient } from './client.js';
import { applyEvents, applyJobInfo, emptyJobView, isFinal, isResumable, lastJob, noteModelUpdated, requestText, type JobView } from './conversation.js';
import type { AiProblem } from './errors.js';

export interface AiState {
  /** idle: not asked yet; disabled: the bridge is off (`reason`); error: the first requests failed (`loadProblem`). */
  status: 'idle' | 'loading' | 'ready' | 'disabled' | 'error';
  reason: string | null;
  loadProblem: AiProblem | null;
  providers: AgentProviderInfo[];
  tasks: AgentTaskInfo[];
  settings: AgentSettingsInfo | null;
  /** The provider new requests go to. */
  provider: AgentProviderId | null;
  /** Reasoning effort per provider (absent / null: the CLI's default). */
  efforts: Partial<Record<AgentProviderId, AgentEffort | null>>;
  /** Model name per provider ('' or absent: the CLI's default). */
  models: Partial<Record<AgentProviderId, string>>;
  allowImageGeneration: boolean;
  /** Every job the panel knows, by id. */
  jobs: Record<string, JobView>;
  /** The conversation shown (its id is the id of its first job); null = a new, empty one. */
  conversation: string | null;
  /** The queued or running job (the server runs one at a time). */
  active: string | null;
  /** A request is on its way. */
  sending: boolean;
  /** Why the last request failed (shown above the composer until the next one). */
  problem: { problem: AiProblem; provider: AgentProviderId | null } | null;
  /** A task template chosen for the next request (null: the person's own words). */
  task: AgentTaskInfo | null;
  draft: string;
  /** The Codex sandbox fix was applied from the card of these jobs. */
  sandboxFixed: string[];
  sandboxSaving: boolean;
  sandboxProblem: AiProblem | null;
  connection: 'live' | 'offline';
}

export function initialAiState(): AiState {
  return {
    status: 'idle',
    reason: null,
    loadProblem: null,
    providers: [],
    tasks: [],
    settings: null,
    provider: null,
    efforts: {},
    models: {},
    allowImageGeneration: false,
    jobs: {},
    conversation: null,
    active: null,
    sending: false,
    problem: null,
    task: null,
    draft: '',
    sandboxFixed: [],
    sandboxSaving: false,
    sandboxProblem: null,
    connection: 'live',
  };
}

/** What a request asks for (the panel's composer and startAiTask). */
export interface AiRequest {
  kind?: string;
  prompt?: string;
  context?: Record<string, unknown>;
  images?: string[];
  allowImageGeneration?: boolean;
  provider?: AgentProviderId;
}

export type StartOutcome = { jobId: string } | { error: string; problem: AiProblem };

const PROVIDER_KEY = 'rev2d.ai.provider';
const PREFS_KEY = 'rev2d.ai.prefs';
const CONVERSATION_KEY = 'rev2d.ai.conversation';
/** A model change this soon after a job ended still counts as that job's edit (the watcher is debounced). */
const LATE_CHANGE_MS = 4000;
/** While a job runs and no event arrived for this long, its events are fetched (a dropped stream). */
const QUIET_FETCH_MS = 5000;

function storage(kind: 'local' | 'session'): Storage | null {
  try {
    return kind === 'local' ? globalThis.localStorage ?? null : globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function read(kind: 'local' | 'session', key: string): string | null {
  try {
    return storage(kind)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(kind: 'local' | 'session', key: string, value: string | null): void {
  try {
    const s = storage(kind);
    if (!s) return;
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
  } catch {
    // Storage unavailable: the choice lasts for this page.
  }
}

export interface AiControllerOptions {
  client?: AgentClient;
  /** Follow the editor's event stream (default true; unit tests feed events by hand). */
  listen?: boolean;
  /**
   * The context of a request from what the caller gave: adds the open model and its folder (the panel
   * knows the editor session; this module does not). Default: the given context as it is.
   */
  context?: (given: Record<string, unknown>) => Record<string, unknown>;
  now?: () => number;
}

export class AiController {
  readonly store = new Store<AiState>(initialAiState());
  readonly client: AgentClient;
  private readonly listen: boolean;
  private readonly now: () => number;
  private context: (given: Record<string, unknown>) => Record<string, unknown>;
  private initPromise: Promise<void> | null = null;
  private unlisten: (() => void) | null = null;
  /** In-flight catch-up fetches by job id; `again` asks for one more round when it ends. */
  private readonly fetching = new Map<string, { promise: Promise<void>; again: boolean }>();
  private lastEnded: { id: string; at: number } | null = null;
  private lastEventAt = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;

  constructor(opts: AiControllerOptions = {}) {
    this.client = opts.client ?? createAgentClient();
    this.listen = opts.listen ?? true;
    this.now = opts.now ?? (() => Date.now());
    this.context = opts.context ?? ((given) => given);
  }

  get(): AiState {
    return this.store.get();
  }

  /** Where requests work by default (set by the panel, which knows the editor session). */
  setContextProvider(fn: (given: Record<string, unknown>) => Record<string, unknown>): void {
    this.context = fn;
  }

  // ---------------------------------------------------------------------------------- loading

  /** Ask the server what is available and restore the conversation (once; `force` asks again). */
  init(force = false): Promise<void> {
    if (this.initPromise && !force) return this.initPromise;
    this.initPromise = this.load();
    return this.initPromise;
  }

  private async load(): Promise<void> {
    if (this.listen && !this.unlisten) {
      this.unlisten = listenToEvents({
        onHello: () => {
          const wasOffline = this.get().connection === 'offline';
          this.store.set({ connection: 'live' });
          if (wasOffline && this.get().status === 'ready') void this.refresh();
        },
        onError: () => this.store.set({ connection: 'offline' }),
        onAgentJob: (p) => this.onAgentJob(p),
        onModelChanged: (e) => this.onModelChanged(e),
      });
      // The event stream can miss events (a reconnect, a proxy): a running job that stays quiet is
      // caught up by asking the server.
      this.watchdog = setInterval(() => {
        const s = this.get();
        if (s.status === 'ready' && s.active && this.now() - this.lastEventAt > QUIET_FETCH_MS) {
          this.lastEventAt = this.now();
          void this.catchUp(s.active);
        }
      }, 1000);
      (this.watchdog as { unref?: () => void }).unref?.();
    }
    this.store.set({ status: this.get().status === 'ready' ? 'ready' : 'loading', loadProblem: null });
    try {
      const session = await this.client.session(true);
      if (!session.agent.enabled) {
        this.store.set({ status: 'disabled', reason: session.agent.reason ?? null });
        return;
      }
      const [providers, tasks, list] = await Promise.all([this.client.providers(), this.client.tasks(), this.client.jobs()]);
      const settings = await this.client.settings().catch(() => null);
      this.restorePrefs();
      const jobs = { ...this.get().jobs };
      for (const job of list.jobs) jobs[job.id] = jobs[job.id] ? applyJobInfo(jobs[job.id]!, job) : emptyJobView(job);
      const stored = read('session', CONVERSATION_KEY);
      const activeJob = list.active ? list.jobs.find((j) => j.id === list.active) : undefined;
      const known = new Set(list.jobs.map((j) => j.conversation));
      const conversation = activeJob
        ? activeJob.conversation
        : stored === ''
          ? null
          : stored && known.has(stored)
            ? stored
            : (list.jobs[0]?.conversation ?? null);
      const preferred = read('local', PROVIDER_KEY) as AgentProviderId | null;
      const provider = this.pickProvider(providers, this.get().provider ?? preferred);
      this.store.set({ status: 'ready', reason: null, providers, tasks, settings, jobs, active: list.active, provider, conversation: this.get().conversation ?? conversation });
      await this.catchUpConversation(this.get().conversation);
    } catch (e) {
      const problem = problemOf(e);
      if (problem.kind === 'disabled') this.store.set({ status: 'disabled', reason: problem.message });
      else this.store.set({ status: 'error', loadProblem: problem });
      this.initPromise = null;
    }
  }

  /** After a reconnect: jobs may have started, run and ended meanwhile. */
  async refresh(): Promise<void> {
    try {
      const list = await this.client.jobs();
      const jobs = { ...this.get().jobs };
      for (const job of list.jobs) jobs[job.id] = jobs[job.id] ? applyJobInfo(jobs[job.id]!, job) : emptyJobView(job);
      this.store.set({ jobs, active: list.active });
      const conv = this.get().conversation;
      await Promise.all(
        Object.values(this.get().jobs)
          .filter((v) => v.job.conversation === conv || v.job.id === list.active)
          .map((v) => this.catchUp(v.job.id)),
      );
      const providers = await this.client.providers().catch(() => null);
      if (providers) this.store.set({ providers });
    } catch (e) {
      const problem = problemOf(e);
      if (problem.kind === 'disabled') this.store.set({ status: 'disabled', reason: problem.message });
    }
  }

  private pickProvider(providers: readonly AgentProviderInfo[], wanted: AgentProviderId | null): AgentProviderId | null {
    if (wanted && providers.some((p) => p.id === wanted)) return wanted;
    return (providers.find((p) => p.available) ?? providers[0])?.id ?? null;
  }

  private restorePrefs(): void {
    try {
      const raw = read('local', PREFS_KEY);
      if (!raw) return;
      const p = JSON.parse(raw) as { efforts?: AiState['efforts']; models?: AiState['models'] };
      this.store.set({
        ...(p.efforts && typeof p.efforts === 'object' ? { efforts: p.efforts } : {}),
        ...(p.models && typeof p.models === 'object' ? { models: p.models } : {}),
      });
    } catch {
      // A broken stored value: defaults.
    }
  }

  private savePrefs(): void {
    const { efforts, models } = this.get();
    write('local', PREFS_KEY, JSON.stringify({ efforts, models }));
  }

  /** Fetch the events of every job of a conversation the panel does not have yet. */
  private async catchUpConversation(conversation: string | null): Promise<void> {
    if (!conversation) return;
    const ids = Object.values(this.get().jobs)
      .filter((v) => v.job.conversation === conversation)
      .map((v) => v.job.id);
    await Promise.all(ids.map((id) => this.catchUp(id)));
  }

  /** GET .../jobs/:id?since=<lastSeq> and apply it (one fetch per job at a time). */
  catchUp(id: string): Promise<void> {
    const running = this.fetching.get(id);
    if (running) {
      running.again = true;
      return running.promise;
    }
    const entry = { promise: Promise.resolve(), again: false };
    entry.promise = (async () => {
      try {
        for (let round = 0; round < 4; round++) {
          entry.again = false;
          const view = this.get().jobs[id];
          const since = view && view.prompt !== null ? view.lastSeq : 0;
          const detail = await this.client.job(id, since);
          const more = this.applyDetail(detail);
          if (!more && !entry.again) break;
        }
      } catch (e) {
        const problem = problemOf(e);
        if (problem.kind === 'unknown-job') this.forget(id);
      } finally {
        this.fetching.delete(id);
      }
    })();
    this.fetching.set(id, entry);
    return entry.promise;
  }

  /** Apply an answer of GET .../jobs/:id; true when events are still missing. */
  private applyDetail(detail: AgentJobDetail): boolean {
    const current = this.get().jobs[detail.job.id];
    let view = current ? applyJobInfo(current, detail.job) : emptyJobView(detail.job);
    if (view.prompt === null) view = { ...view, prompt: detail.prompt ?? null };
    const result = applyEvents(view, detail.events ?? [], { firstSeq: detail.firstSeq });
    this.putJob(result.view);
    return result.missing;
  }

  private forget(id: string): void {
    const jobs = { ...this.get().jobs };
    delete jobs[id];
    this.store.set({ jobs });
  }

  private putJob(view: JobView): void {
    const s = this.get();
    const active = !isFinal(view.job.state) ? view.job.id : s.active === view.job.id ? null : s.active;
    if (isFinal(view.job.state) && s.active === view.job.id) this.lastEnded = { id: view.job.id, at: this.now() };
    this.store.set({ jobs: { ...s.jobs, [view.job.id]: view }, active });
  }

  // ---------------------------------------------------------------------------------- live events

  onAgentJob(p: AgentJobEventPayload): void {
    this.lastEventAt = this.now();
    const s = this.get();
    if (s.status !== 'ready' && s.status !== 'loading') return;
    const known = s.jobs[p.job.id];
    let view = known ? applyJobInfo(known, p.job) : emptyJobView(p.job);
    let missing = false;
    if (p.event) {
      const r = applyEvents(view, [p.event]);
      view = r.view;
      missing = r.missing;
    }
    this.putJob(view);
    // A job started elsewhere (another tab, an AI tool): show it when nothing else of ours runs.
    if (!known && !isFinal(p.job.state)) this.adoptConversation(p.job);
    if (missing || (!known && view.prompt === null)) void this.catchUp(p.job.id);
  }

  /** Switch to the conversation of a job that just started, unless the shown one is still running. */
  private adoptConversation(job: AgentJobInfo): void {
    const s = this.get();
    if (s.conversation === job.conversation) return;
    const last = lastJob(s.jobs, s.conversation);
    if (last && !isFinal(last.job.state) && last.job.id !== job.id) return;
    this.showConversation(job.conversation);
  }

  onModelChanged(e: ModelChangedEvent): void {
    if (e.origin !== 'external') return;
    const s = this.get();
    const id = s.active ?? (this.lastEnded && this.now() - this.lastEnded.at < LATE_CHANGE_MS ? this.lastEnded.id : null);
    const view = id ? s.jobs[id] : undefined;
    if (!view) return;
    this.store.set({ jobs: { ...s.jobs, [view.job.id]: noteModelUpdated(view) } });
  }

  // ---------------------------------------------------------------------------------- requests

  /** The request in the composer: a follow-up of the shown conversation when it can be resumed. */
  async send(): Promise<StartOutcome | null> {
    const s = this.get();
    const prompt = s.draft.trim();
    if (s.sending || (!prompt && !(s.task && !s.task.needsPrompt))) return null;
    const last = lastJob(s.jobs, s.conversation);
    const provider = s.provider;
    if (last && !s.task && provider === last.job.provider && isResumable(last.job)) {
      const outcome = await this.request(provider, async () => {
        try {
          return await this.client.message(last.job.id, { prompt, ...(s.allowImageGeneration !== last.job.allowImageGeneration ? { allowImageGeneration: s.allowImageGeneration } : {}) });
        } catch (e) {
          // Cannot continue after all (the session is gone): a new conversation.
          if (problemOf(e).kind === 'not-resumable') return this.client.start(this.startRequest({ prompt }));
          throw e;
        }
      }, prompt);
      return outcome;
    }
    return this.start({ ...(s.task ? { kind: s.task.kind } : {}), ...(prompt ? { prompt } : {}) });
  }

  /** Start a job (a new conversation). Resolves to the job id or a localized-later problem. */
  async start(req: AiRequest): Promise<StartOutcome> {
    await this.init();
    const s = this.get();
    if (s.status !== 'ready') {
      const problem: AiProblem = s.loadProblem ?? { kind: 'disabled', status: 404, message: s.reason ?? 'the agent bridge is disabled', code: 'agent-disabled' };
      return { error: problem.message, problem };
    }
    const provider = req.provider ?? s.provider;
    if (!provider) {
      const problem: AiProblem = { kind: 'unavailable', status: 409, message: 'no agent CLI is available', code: 'unavailable' };
      this.store.set({ problem: { problem, provider: null } });
      return { error: problem.message, problem };
    }
    if (req.provider && req.provider !== s.provider) this.setProvider(req.provider);
    return this.request(provider, () => this.client.start(this.startRequest(req, provider)), req.prompt ?? null);
  }

  private startRequest(req: AiRequest, provider = this.get().provider!): AgentStartRequest {
    const s = this.get();
    const effort = s.efforts[provider];
    const model = s.models[provider]?.trim();
    const context = this.context(req.context ?? {});
    return {
      provider,
      ...(req.kind ? { kind: req.kind } : {}),
      ...(req.prompt ? { prompt: req.prompt } : {}),
      ...(Object.keys(context).length ? { context } : {}),
      ...(req.images?.length ? { images: req.images } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      allowImageGeneration: req.allowImageGeneration ?? s.allowImageGeneration,
    };
  }

  private async request(provider: AgentProviderId, run: () => Promise<AgentJobInfo>, prompt: string | null): Promise<StartOutcome> {
    this.store.set({ sending: true, problem: null });
    try {
      const job = await run();
      const current = this.get().jobs[job.id];
      let view = current ? applyJobInfo(current, job) : emptyJobView(job);
      if (view.prompt === null) view = { ...view, prompt: prompt ?? '' };
      this.putJob(view);
      this.store.set({ sending: false, draft: '', task: null });
      this.showConversation(job.conversation);
      void this.catchUp(job.id);
      return { jobId: job.id };
    } catch (e) {
      const problem = problemOf(e);
      this.store.set({ sending: false, problem: { problem, provider } });
      if (problem.kind === 'disabled') this.store.set({ status: 'disabled', reason: problem.message });
      // The running job of another conversation: make sure it is known, so "Show" can show it.
      if (problem.kind === 'busy' && problem.jobId && !this.get().jobs[problem.jobId]) void this.catchUp(problem.jobId);
      return { error: problem.message, problem };
    }
  }

  async cancel(id: string): Promise<void> {
    try {
      const job = await this.client.cancel(id);
      const view = this.get().jobs[job.id];
      if (view) this.putJob(applyJobInfo(view, job));
      void this.catchUp(id);
    } catch (e) {
      this.store.set({ problem: { problem: problemOf(e), provider: this.get().jobs[id]?.job.provider ?? null } });
    }
  }

  /** Run the request of a job again, as a new conversation (after the sandbox fix). */
  async runAgain(id: string): Promise<StartOutcome> {
    const view = this.get().jobs[id];
    if (!view) return { error: 'unknown job', problem: { kind: 'unknown-job', status: 404, message: 'unknown job' } };
    return this.start({ provider: view.job.provider, ...(view.job.kind !== 'freeform' ? { kind: view.job.kind } : {}), ...(view.prompt || view.job.kind === 'freeform' ? { prompt: requestText(view) } : {}) });
  }

  // ---------------------------------------------------------------------------------- the panel's choices

  showConversation(conversation: string | null): void {
    this.store.set({ conversation, problem: null });
    write('session', CONVERSATION_KEY, conversation ?? '');
    if (conversation) void this.catchUpConversation(conversation);
  }

  newConversation(): void {
    this.store.set({ task: null });
    this.showConversation(null);
  }

  /** Show the conversation of a job (fetching it when the panel does not know it yet). */
  async showJob(id: string): Promise<void> {
    if (!this.get().jobs[id]) await this.catchUp(id);
    const view = this.get().jobs[id];
    if (view) this.showConversation(view.job.conversation);
  }

  /** Follow a job the panel may not know (useAiJob of another module). */
  track(id: string): void {
    void this.init().then(() => {
      if (this.get().status === 'ready' && !this.get().jobs[id]) void this.catchUp(id);
    });
  }

  setProvider(provider: AgentProviderId): void {
    this.store.set({ provider, problem: null });
    write('local', PROVIDER_KEY, provider);
  }

  setEffort(provider: AgentProviderId, effort: AgentEffort | null): void {
    this.store.set((s) => ({ efforts: { ...s.efforts, [provider]: effort } }));
    this.savePrefs();
  }

  setModel(provider: AgentProviderId, model: string): void {
    this.store.set((s) => ({ models: { ...s.models, [provider]: model } }));
    this.savePrefs();
  }

  setAllowImageGeneration(allow: boolean): void {
    this.store.set({ allowImageGeneration: allow });
  }

  setDraft(draft: string): void {
    this.store.set({ draft });
  }

  selectTask(task: AgentTaskInfo | null): void {
    this.store.set({ task, problem: null });
  }

  dismissProblem(): void {
    this.store.set({ problem: null });
  }

  // ---------------------------------------------------------------------------------- settings

  async refreshSettings(): Promise<void> {
    try {
      this.store.set({ settings: await this.client.settings() });
    } catch {
      // Keep what is shown.
    }
  }

  /** Save the Codex Windows sandbox setting (from the settings popover or a sandbox card). */
  async setCodexSandbox(value: CodexWindowsSandbox, fromJob?: string): Promise<boolean> {
    this.store.set({ sandboxSaving: true, sandboxProblem: null });
    try {
      const settings = await this.client.putSettings({ codexWindowsSandbox: value });
      this.store.set((s) => ({
        settings,
        sandboxSaving: false,
        sandboxFixed: fromJob && value === 'unelevated' ? [...s.sandboxFixed.filter((id) => id !== fromJob), fromJob] : s.sandboxFixed,
      }));
      const providers = await this.client.providers().catch(() => null);
      if (providers) this.store.set({ providers });
      return true;
    } catch (e) {
      this.store.set({ sandboxSaving: false, sandboxProblem: problemOf(e) });
      return false;
    }
  }

  dispose(): void {
    this.unlisten?.();
    this.unlisten = null;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
  }
}
