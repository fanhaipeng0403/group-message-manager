import { AppError } from "../../common/errors.js";

interface GatewayErrorBody {
  error?: { code?: string; message?: string; retryAfterSeconds?: number };
  code?: string;
  message?: string;
  retryAfterSeconds?: number;
}

export class GatewayError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

async function parseResponse<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as GatewayErrorBody;
  if (!response.ok) {
    const code = body.error?.code ?? body.code ?? `HTTP_${response.status}`;
    throw new GatewayError(
      response.status,
      code,
      body.error?.message ?? body.message ?? code,
      body.error?.retryAfterSeconds ?? body.retryAfterSeconds,
    );
  }
  return body as T;
}

export class GatewayClient {
  constructor(private readonly baseUrl: string) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers },
        signal: init?.signal ?? AbortSignal.timeout(8_000),
      });
    } catch (error) {
      throw new AppError(503, "GATEWAY_UNAVAILABLE", "Message gateway is unavailable", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    return parseResponse<T>(response);
  }

  connect(accountId: string) {
    return this.request<{ platformUserId: string }>(`/accounts/${accountId}/connect`, { method: "POST" });
  }

  disconnect(accountId: string) {
    return this.request<Record<string, never>>(`/accounts/${accountId}/disconnect`, { method: "POST" });
  }

  createGroup(creatorAccountId: string) {
    return this.request<{ groupId: string }>("/groups", {
      method: "POST",
      body: JSON.stringify({ creatorAccountId }),
    });
  }

  invite(groupId: string) {
    return this.request<{ inviteLink: string; readyAfterMs: number }>(`/groups/${groupId}/invite`, {
      method: "POST",
    });
  }

  join(groupId: string, accountId: string, inviteLink: string) {
    return this.request<{ accepted: true }>(`/groups/${groupId}/join`, {
      method: "POST",
      body: JSON.stringify({ accountId, inviteLink }),
    });
  }

  promote(groupId: string, byAccountId: string, accountId: string) {
    return this.request<Record<string, never>>(`/groups/${groupId}/promote`, {
      method: "POST",
      body: JSON.stringify({ byAccountId, accountId }),
    });
  }

  kick(groupId: string, byAccountId: string, targetPlatformUserId: string) {
    return this.request<{ kicked: true }>(`/groups/${groupId}/kick`, {
      method: "POST",
      body: JSON.stringify({ byAccountId, targetPlatformUserId }),
      signal: AbortSignal.timeout(8_000),
    });
  }

  members(groupId: string) {
    return this.request<Array<{ platformUserId: string }>>(`/groups/${groupId}/members`);
  }

  leave(groupId: string, accountId: string) {
    return this.request<Record<string, never>>(`/groups/${groupId}/leave`, {
      method: "POST",
      body: JSON.stringify({ accountId }),
    });
  }

  send(groupId: string, accountId: string, clientMsgId: string, text: string) {
    return this.request<{ accepted: true }>(`/groups/${groupId}/send`, {
      method: "POST",
      body: JSON.stringify({ accountId, clientMsgId, text }),
      signal: AbortSignal.timeout(10_000),
    });
  }

  findMessage(groupId: string, clientMsgId: string) {
    return this.request<{ msgId: string; sentAt: number }>(
      `/groups/${groupId}/messages/by-client-id/${clientMsgId}`,
    );
  }

  eventsUrl(since: number): string {
    return `${this.baseUrl}/events?since=${since}`;
  }

  configureDemo(input: Record<string, unknown>) {
    return this.request<{ ok: true; control: Record<string, unknown> }>("/__control", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  restoreDemoGroup(
    groupId: string,
    creatorAccountId: string,
    memberAccountIds: string[],
    nextEventId: number,
  ) {
    return this.request<{ ok: true; restoredMembers: number; nextEventId: number }>(
      `/__control/groups/${groupId}/restore`,
      {
        method: "POST",
        body: JSON.stringify({ creatorAccountId, memberAccountIds, nextEventId }),
      },
    );
  }

  injectInbound(groupId: string, text: string, senderPlatformUserId: string) {
    return this.request<{ msgId: string }>(`/__control/groups/${groupId}/inbound`, {
      method: "POST",
      body: JSON.stringify({ text, senderPlatformUserId }),
    });
  }

  debugMessageCount(groupId: string, clientMsgId: string) {
    return this.request<{ count: number }>(`/__control/groups/${groupId}/messages/${clientMsgId}`);
  }
}
