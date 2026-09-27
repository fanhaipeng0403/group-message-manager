import type { Account, Group, Message } from "@platform/contracts";

export const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
const TOKEN_KEY = "group_message_manager_access_token";

export interface ApiErrorBody {
  error: { code: string; message: string; requestId: string; [key: string]: unknown };
}

interface FastifyErrorBody {
  error?: string;
  message?: string;
  statusCode?: number;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ApiErrorBody,
  ) {
    super(body.error.message);
  }
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}
let refreshPromise: Promise<string> | undefined;

export function currentRole(): "admin" | "viewer" | null {
  const token = getToken();
  if (!token) return null;
  try {
    const payload = JSON.parse(atob(token.split(".")[1]!.replaceAll("-", "+").replaceAll("_", "/")));
    return payload.role === "admin" || payload.role === "viewer" ? payload.role : null;
  } catch {
    return null;
  }
}

export async function refreshAccessToken(): Promise<string> {
  if (!refreshPromise) {
    refreshPromise = fetch(`${API_URL}/api/auth/refresh`, { method: "POST", credentials: "include" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Session refresh failed");
        const body = (await response.json()) as { accessToken: string };
        setToken(body.accessToken);
        return body.accessToken;
      })
      .finally(() => {
        refreshPromise = undefined;
      });
  }
  return refreshPromise;
}

export function expireSession(): void {
  clearToken();
  if (window.location.pathname !== "/login") window.location.assign("/login");
}

export async function api<T>(path: string, init: RequestInit = {}, allowRefresh = true): Promise<T> {
  const request = () => {
    const token = getToken();
    return fetch(`${API_URL}${path}`, {
      ...init,
      credentials: "include",
      headers: {
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
  };
  let response = await request();
  if (response.status === 401 && allowRefresh && !path.startsWith("/api/auth/")) {
    try {
      await refreshAccessToken();
      response = await request();
    } catch {
      expireSession();
    }
  }
  if (!response.ok) {
    const raw = (await response.json().catch(() => ({
      error: { code: `HTTP_${response.status}`, message: response.statusText, requestId: "unknown" },
    }))) as ApiErrorBody | FastifyErrorBody;
    const body: ApiErrorBody =
      typeof raw.error === "object" && raw.error !== null
        ? (raw as ApiErrorBody)
        : (() => {
            const fastifyError = raw as FastifyErrorBody;
            return {
              error: {
                code: fastifyError.error ?? `HTTP_${response.status}`,
                message: fastifyError.message ?? response.statusText ?? `请求失败（${response.status}）`,
                requestId: "unknown",
              },
            };
          })();
    if (response.status === 401) {
      expireSession();
    }
    throw new ApiError(response.status, body);
  }
  return response.json() as Promise<T>;
}

export const client = {
  health: () => api<{ ok: true; schemaVersion: number }>("/api/health", {}, false),
  login: (username: string, password: string) =>
    api<{ accessToken: string }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  logout: () => api<{ ok: true }>("/api/auth/logout", { method: "POST" }, false),
  accounts: () => api<Account[]>("/api/accounts"),
  createAccount: (displayName: string, avatarUrl: string) =>
    api<Account>("/api/accounts", {
      method: "POST",
      body: JSON.stringify({ displayName, avatarUrl }),
    }),
  connectAccount: (id: string) => api(`/api/accounts/${id}/connect`, { method: "POST" }),
  transitionAccount: (id: string, expectedFrom: string, to: string) =>
    api(`/api/accounts/${id}/transition`, { method: "POST", body: JSON.stringify({ expectedFrom, to }) }),
  groups: () => api<Group[]>("/api/groups"),
  group: (id: string) => api<Group>(`/api/groups/${id}`),
  createGroup: (creatorAccountId: string, memberAccountIds: string[]) =>
    api<{ jobId: string }>("/api/groups", {
      method: "POST",
      body: JSON.stringify({ creatorAccountId, memberAccountIds }),
    }),
  leaveAll: (id: string) => api<{ jobId: string }>(`/api/groups/${id}/leave-all`, { method: "POST" }),
  job: (id: string) => api<Job>(`/api/jobs/${id}`),
  messages: (id: string, before?: string) =>
    api<{ items: Message[]; nextCursor: string | null }>(
      `/api/groups/${id}/messages${before ? `?before=${encodeURIComponent(before)}` : ""}`,
    ),
  send: (id: string, accountId: string, text: string) =>
    api<{ clientMsgId: string }>(`/api/groups/${id}/send`, {
      method: "POST",
      body: JSON.stringify({ accountId, text }),
    }),
  patchGroup: (id: string, patch: { agentEnabled?: boolean; autoKickEnabled?: boolean }) =>
    api(`/api/groups/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  injectDemoMessage: (id: string, senderPlatformUserId: string, text: string) =>
    api<{ msgId: string }>(`/api/demo/groups/${id}/inbound`, {
      method: "POST",
      body: JSON.stringify({ senderPlatformUserId, text }),
    }),
  agentRuns: (id: string) => api<AgentRun[]>(`/api/groups/${id}/agent-runs`),
  agentRun: (id: string) => api<AgentRun & { steps: AgentStep[] }>(`/api/agent-runs/${id}`),
  sequences: () => api<Sequence[]>("/api/sequences"),
  startSequence: (
    groupId: string,
    input: {
      sequenceId: string;
      vars: Record<string, string>;
      stepVars: Record<string, Record<string, string>>;
    },
  ) =>
    api<{ runId: string }>(`/api/groups/${groupId}/sequence-runs`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  sequenceRun: (id: string) => api<SequenceRun>(`/api/sequence-runs/${id}`),
  demoScenarios: () => api<DemoScenario[]>("/api/demo/scenarios"),
  demoExperiments: (groupId?: string) =>
    api<ReliabilityExperiment[]>(
      `/api/demo/experiments${groupId ? `?groupId=${encodeURIComponent(groupId)}` : ""}`,
    ),
  startDemoExperiment: (scenario: string, groupId: string) =>
    api<{ experimentId: string }>("/api/demo/experiments", {
      method: "POST",
      body: JSON.stringify({ scenario, groupId }),
    }),
};

export interface AgentRun {
  id: string;
  groupId: string;
  status: string;
  endReason: string | null;
  summary: string | null;
}
export interface Job {
  status: "running" | "finished" | "failed";
  errors: Array<{ code: string; step: string }>;
}
export interface AgentStep {
  kind: string;
  toolUseId: string | null;
  name: string | null;
  input: unknown;
  resultSummary: string;
  isError: boolean;
  errorCode: string | null;
  auditVerdict: string | null;
  rawResponse: string;
}
export interface SequenceStep {
  index: number;
  accountRole: "admin" | "member";
  text: string;
  delaySeconds: number;
}
export interface Sequence {
  id: string;
  name: string;
  steps: SequenceStep[];
}
export interface SequenceRun {
  status: "running" | "finished" | "failed" | "stopped";
  currentStepIndex: number;
  steps: Array<{
    index: number;
    status: string;
    scheduledAt: string | null;
    sentAt: string | null;
    clientMsgId: string | null;
    resolvedVars: Record<string, string>;
    varSources: Record<string, string>;
  }>;
}
export interface DemoScenario {
  id: string;
  requirement: string;
  title: string;
  summary: string;
  proves: readonly string[];
}
export interface ReliabilityExperiment {
  id: string;
  scenario: string;
  groupId: string;
  status: "running" | "passed" | "failed";
  evidence: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
