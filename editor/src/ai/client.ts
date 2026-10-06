/**
 * Client of the agent bridge endpoints (docs/AGENT-BRIDGE.md §2).
 *
 * Every /api/agent request carries the per-server token from GET /api/session in X-Rev2D-Token. The
 * token changes whenever the editor server restarts: a 401 fetches the session again and retries the
 * request once. Failures are thrown as AgentApiError with an AiProblem (errors.ts), never as raw JSON.
 */
import type {
  AgentJobDetail,
  AgentJobInfo,
  AgentJobList,
  AgentMessageRequest,
  AgentProviderInfo,
  AgentSettingsInfo,
  AgentSettingsRequest,
  AgentStartRequest,
  AgentTaskInfo,
  SessionInfo,
} from '../../../src/node/editor-registry.js';
import { networkProblem, problemFrom, type AiProblem } from './errors.js';

export class AgentApiError extends Error {
  constructor(readonly problem: AiProblem) {
    super(problem.message);
    this.name = 'AgentApiError';
  }
}

export function problemOf(e: unknown): AiProblem {
  return e instanceof AgentApiError ? e.problem : networkProblem(e);
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface AgentClient {
  /** GET /api/session (cached; `fresh` asks again). */
  session(fresh?: boolean): Promise<SessionInfo>;
  providers(): Promise<AgentProviderInfo[]>;
  tasks(): Promise<AgentTaskInfo[]>;
  jobs(): Promise<AgentJobList>;
  job(id: string, since?: number): Promise<AgentJobDetail>;
  start(req: AgentStartRequest): Promise<AgentJobInfo>;
  message(id: string, req: AgentMessageRequest): Promise<AgentJobInfo>;
  cancel(id: string): Promise<AgentJobInfo>;
  settings(): Promise<AgentSettingsInfo>;
  putSettings(req: AgentSettingsRequest): Promise<AgentSettingsInfo>;
}

const TOKEN_HEADER = 'X-Rev2D-Token';

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => '');
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: text.slice(0, 200) };
  }
}

export function createAgentClient(fetchImpl: FetchLike = (input, init) => fetch(input, init)): AgentClient {
  let session: SessionInfo | null = null;
  let pending: Promise<SessionInfo> | null = null;

  const getSession = async (fresh = false): Promise<SessionInfo> => {
    if (session && !fresh) return session;
    if (pending) return pending;
    pending = (async () => {
      let res: Response;
      try {
        res = await fetchImpl('/api/session', { cache: 'no-store' });
      } catch (e) {
        throw new AgentApiError(networkProblem(e));
      }
      const body = await readBody(res);
      if (!res.ok) throw new AgentApiError(problemFrom(res.status, body));
      const b = (body ?? {}) as Partial<SessionInfo>;
      const agent = (b.agent ?? {}) as Partial<SessionInfo['agent']>;
      session = {
        token: typeof b.token === 'string' ? b.token : null,
        agent: { enabled: agent.enabled === true, ...(typeof agent.reason === 'string' ? { reason: agent.reason } : {}) },
      };
      return session;
    })();
    try {
      return await pending;
    } finally {
      pending = null;
    }
  };

  const request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      const s = await getSession(attempt > 0);
      if (!s.agent.enabled || !s.token) {
        throw new AgentApiError({ kind: 'disabled', status: 404, message: s.agent.reason ?? 'the agent bridge is disabled', code: 'agent-disabled' });
      }
      let res: Response;
      try {
        res = await fetchImpl(path, {
          method,
          cache: 'no-store',
          headers: { [TOKEN_HEADER]: s.token, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
      } catch (e) {
        throw new AgentApiError(networkProblem(e));
      }
      const parsed = await readBody(res);
      // The server restarted (new token): ask for the session again and retry once.
      if (res.status === 401 && attempt === 0) continue;
      if (!res.ok) throw new AgentApiError(problemFrom(res.status, parsed));
      return parsed as T;
    }
  };

  const job = (parsed: { job?: AgentJobInfo } | null): AgentJobInfo => {
    if (!parsed?.job || typeof parsed.job.id !== 'string') throw new AgentApiError({ kind: 'server', status: 200, message: 'the answer has no job' });
    return parsed.job;
  };

  return {
    session: getSession,
    providers: async () => {
      const list = await request<AgentProviderInfo[]>('GET', '/api/agent/providers');
      return Array.isArray(list) ? list : [];
    },
    tasks: async () => {
      const list = await request<AgentTaskInfo[]>('GET', '/api/agent/tasks');
      return Array.isArray(list) ? list : [];
    },
    jobs: async () => {
      const list = await request<AgentJobList>('GET', '/api/agent/jobs');
      return { jobs: Array.isArray(list?.jobs) ? list.jobs : [], active: typeof list?.active === 'string' ? list.active : null };
    },
    job: (id, since = 0) => request<AgentJobDetail>('GET', `/api/agent/jobs/${encodeURIComponent(id)}${since > 0 ? `?since=${since}` : ''}`),
    start: async (req) => job(await request<{ job?: AgentJobInfo }>('POST', '/api/agent/jobs', req)),
    message: async (id, req) => job(await request<{ job?: AgentJobInfo }>('POST', `/api/agent/jobs/${encodeURIComponent(id)}/message`, req)),
    cancel: async (id) => job(await request<{ job?: AgentJobInfo }>('POST', `/api/agent/jobs/${encodeURIComponent(id)}/cancel`, {})),
    settings: () => request<AgentSettingsInfo>('GET', '/api/agent/settings'),
    putSettings: (req) => request<AgentSettingsInfo>('PUT', '/api/agent/settings', req),
  };
}
