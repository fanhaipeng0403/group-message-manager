import Fastify from "fastify";
import { z } from "zod";
import type { ServerResponse } from "node:http";
import { GatewayStateStore } from "./state-store.js";

type Account = {
  platformUserId: string;
  online: boolean;
  terminal?: "suspended" | "session_expired";
  limitedUntil?: number;
};
type Group = {
  id: string;
  creatorAccountId: string;
  members: Set<string>;
  admins: Set<string>;
  invite?: { link: string; readyAt: number; expired: boolean };
};
type StoredMessage = {
  groupId: string;
  clientMsgId: string;
  msgId: string;
  sentAt: number;
  accountId: string;
  text: string;
};

const ControlSchema = z.object({
  duplicateEvents: z.boolean().optional(),
  sendMode: z
    .enum(["success", "timeout_sent", "timeout_dropped", "rate_limited", "write_forbidden"])
    .optional(),
  rateLimitSeconds: z.number().int().positive().optional(),
  sendDelayMs: z.number().int().min(0).optional(),
  eventDelayMs: z.number().int().min(0).optional(),
  joinDelayMs: z.number().int().min(0).optional(),
  dropJoinEvent: z.boolean().optional(),
  inviteReadyAfterMs: z.number().int().min(0).optional(),
  messageBeforeSent: z.boolean().optional(),
  expireInviteOnce: z.boolean().optional(),
  resetRuntime: z.boolean().optional(),
});
interface Control {
  duplicateEvents: boolean;
  sendMode: "success" | "timeout_sent" | "timeout_dropped" | "rate_limited" | "write_forbidden";
  rateLimitSeconds: number;
  sendDelayMs: number;
  eventDelayMs: number;
  joinDelayMs: number;
  dropJoinEvent: boolean;
  inviteReadyAfterMs: number;
  messageBeforeSent: boolean;
  expireInviteOnce: boolean;
}

const defaults: Control = {
  duplicateEvents: false,
  sendMode: "success",
  rateLimitSeconds: 2,
  sendDelayMs: 25,
  eventDelayMs: 75,
  joinDelayMs: 100,
  dropJoinEvent: false,
  inviteReadyAfterMs: 0,
  messageBeforeSent: false,
  expireInviteOnce: false,
};

const app = Fastify({ logger: true });
const stateStore = new GatewayStateStore(process.env.DATABASE_URL);
const restored = await stateStore.load();
const accounts = new Map<string, Account>(
  restored?.accounts.map(([id, account]) => [
    id,
    {
      platformUserId: account.platformUserId,
      online: account.online,
      ...(account.terminal ? { terminal: account.terminal } : {}),
      ...(account.limitedUntil !== undefined ? { limitedUntil: account.limitedUntil } : {}),
    },
  ]) ?? [],
);
const groups = new Map<string, Group>(
  restored?.groups.map(([id, group]) => [
    id,
    {
      id: group.id,
      creatorAccountId: group.creatorAccountId,
      members: new Set(group.members),
      admins: new Set(group.admins),
      ...(group.invite ? { invite: group.invite } : {}),
    },
  ]) ?? [],
);
const messages = new Map<string, StoredMessage[]>(restored?.messages ?? []);
const history: Array<Record<string, unknown> & { eventId: number; type: string }> = restored?.history ?? [];
const clients = new Set<ServerResponse>();
const rateLimitTriggered = new Set<string>();
const expiredInviteTriggered = new Set<string>();
let control: Control = { ...defaults };
let nextEventId = restored?.nextEventId ?? 1;

function persistState(): Promise<void> {
  return stateStore.save({
    version: 1,
    accounts: [...accounts.entries()],
    groups: [...groups.entries()].map(([id, group]) => [
      id,
      { ...group, members: [...group.members], admins: [...group.admins] },
    ]),
    messages: [...messages.entries()],
    history,
    nextEventId,
  });
}

function error(code: string, message = code, extra: Record<string, unknown> = {}) {
  return { error: { code, message, ...extra } };
}

function sseFrame(event: Record<string, unknown> & { eventId: number; type: string }): string {
  return `id: ${event.eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function emit(type: string, payload: Record<string, unknown>, delayMs = control.eventDelayMs): void {
  const event = { eventId: nextEventId++, type, ...payload };
  history.push(event);
  void persistState().catch((error) => app.log.error({ err: error }, "failed to persist gateway state"));
  setTimeout(() => {
    for (const client of clients) {
      client.write(sseFrame(event));
      if (control.duplicateEvents) client.write(sseFrame(event));
    }
  }, delayMs);
}

function accountFor(id: string): Account {
  let account = accounts.get(id);
  if (!account) {
    account = { platformUserId: `platform-${id}`, online: false };
    accounts.set(id, account);
    void persistState().catch((error) => app.log.error({ err: error }, "failed to persist gateway state"));
  }
  return account;
}

function requireOnline(id: string) {
  const account = accountFor(id);
  if (account.terminal === "suspended") return { status: 403, body: error("ACCOUNT_SUSPENDED") };
  if (account.terminal === "session_expired") return { status: 401, body: error("SESSION_EXPIRED") };
  if (!account.online) return { status: 409, body: error("ACCOUNT_OFFLINE") };
  return undefined;
}

app.post("/__control/reset", async () => {
  control = { ...defaults };
  accounts.clear();
  groups.clear();
  messages.clear();
  history.length = 0;
  rateLimitTriggered.clear();
  expiredInviteTriggered.clear();
  nextEventId = 1;
  await persistState();
  return { ok: true, control };
});

app.post("/__control", async (request) => {
  const input = ControlSchema.parse(request.body);
  if (input.resetRuntime) {
    rateLimitTriggered.clear();
    expiredInviteTriggered.clear();
  }
  control = {
    duplicateEvents: input.duplicateEvents ?? control.duplicateEvents,
    sendMode: input.sendMode ?? control.sendMode,
    rateLimitSeconds: input.rateLimitSeconds ?? control.rateLimitSeconds,
    sendDelayMs: input.sendDelayMs ?? control.sendDelayMs,
    eventDelayMs: input.eventDelayMs ?? control.eventDelayMs,
    joinDelayMs: input.joinDelayMs ?? control.joinDelayMs,
    dropJoinEvent: input.dropJoinEvent ?? control.dropJoinEvent,
    inviteReadyAfterMs: input.inviteReadyAfterMs ?? control.inviteReadyAfterMs,
    messageBeforeSent: input.messageBeforeSent ?? control.messageBeforeSent,
    expireInviteOnce: input.expireInviteOnce ?? control.expireInviteOnce,
  };
  return { ok: true, control };
});

app.get("/__control", async () => ({
  control,
  counts: { accounts: accounts.size, groups: groups.size, events: history.length },
}));

app.get<{ Params: { accountId: string } }>("/__control/accounts/:accountId", async (request) => {
  const account = accountFor(request.params.accountId);
  return {
    accountId: request.params.accountId,
    platformUserId: account.platformUserId,
    online: account.online,
    terminal: account.terminal ?? null,
  };
});

app.post<{ Params: { groupId: string } }>("/__control/groups/:groupId/restore", async (request) => {
  const input = z
    .object({
      creatorAccountId: z.string(),
      memberAccountIds: z.array(z.string()),
      nextEventId: z.number().int().positive().optional(),
    })
    .parse(request.body);
  if (input.nextEventId) nextEventId = Math.max(nextEventId, input.nextEventId);
  const accountIds = [input.creatorAccountId, ...input.memberAccountIds];
  for (const accountId of accountIds) accountFor(accountId).online = true;
  const memberIds = accountIds.map((accountId) => accountFor(accountId).platformUserId);
  groups.set(request.params.groupId, {
    id: request.params.groupId,
    creatorAccountId: input.creatorAccountId,
    members: new Set(memberIds),
    admins: new Set(memberIds),
  });
  await persistState();
  return { ok: true, restoredMembers: memberIds.length, nextEventId };
});

app.post<{ Params: { groupId: string } }>("/__control/groups/:groupId/inbound", async (request, reply) => {
  const { senderPlatformUserId, text } = z
    .object({ senderPlatformUserId: z.string().default("external-user-1"), text: z.string().min(1) })
    .parse(request.body);
  const group = groups.get(request.params.groupId);
  if (!group) return reply.status(404).send(error("GROUP_NOT_FOUND"));
  group.members.add(senderPlatformUserId);
  const msgId = `msg-${crypto.randomUUID()}`;
  emit("message", { groupId: group.id, msgId, senderPlatformUserId, text, sentAt: Date.now() }, 0);
  await persistState();
  return reply.status(202).send({ msgId });
});

app.get<{ Params: { groupId: string; clientMsgId: string } }>(
  "/__control/groups/:groupId/messages/:clientMsgId",
  async (request) => {
    const count = (messages.get(request.params.clientMsgId) ?? []).filter(
      (item) => item.groupId === request.params.groupId,
    ).length;
    return { count };
  },
);

app.post<{ Params: { accountId: string } }>("/accounts/:accountId/connect", async (request, reply) => {
  const account = accountFor(request.params.accountId);
  if (account.terminal)
    return reply
      .status(account.terminal === "suspended" ? 403 : 401)
      .send(error(account.terminal === "suspended" ? "ACCOUNT_SUSPENDED" : "SESSION_EXPIRED"));
  account.online = true;
  await persistState();
  return { platformUserId: account.platformUserId };
});

app.post<{ Params: { accountId: string } }>("/accounts/:accountId/disconnect", async (request) => {
  accountFor(request.params.accountId).online = false;
  await persistState();
  return {};
});

app.post("/groups", async (request, reply) => {
  const { creatorAccountId } = z.object({ creatorAccountId: z.string() }).parse(request.body);
  const unavailable = requireOnline(creatorAccountId);
  if (unavailable) return reply.status(unavailable.status).send(unavailable.body);
  const id = `gateway-group-${crypto.randomUUID()}`;
  const account = accountFor(creatorAccountId);
  groups.set(id, {
    id,
    creatorAccountId,
    members: new Set([account.platformUserId]),
    admins: new Set([account.platformUserId]),
  });
  await persistState();
  return { groupId: id };
});

app.post<{ Params: { groupId: string } }>("/groups/:groupId/invite", async (request, reply) => {
  const group = groups.get(request.params.groupId);
  if (!group) return reply.status(404).send(error("GROUP_NOT_FOUND"));
  const invite = {
    link: `invite-${crypto.randomUUID()}`,
    readyAt: Date.now() + control.inviteReadyAfterMs,
    expired: false,
  };
  group.invite = invite;
  await persistState();
  return { inviteLink: invite.link, readyAfterMs: control.inviteReadyAfterMs };
});

app.post<{ Params: { groupId: string } }>("/groups/:groupId/join", async (request, reply) => {
  const { accountId, inviteLink } = z
    .object({ accountId: z.string(), inviteLink: z.string() })
    .parse(request.body);
  const group = groups.get(request.params.groupId);
  if (!group) return reply.status(404).send(error("GROUP_NOT_FOUND"));
  const unavailable = requireOnline(accountId);
  if (unavailable) return reply.status(unavailable.status).send(unavailable.body);
  if (!group.invite || group.invite.link !== inviteLink)
    return reply.status(410).send(error("INVITE_EXPIRED"));
  if (control.expireInviteOnce && !expiredInviteTriggered.has(group.id)) {
    expiredInviteTriggered.add(group.id);
    group.invite.expired = true;
    await persistState();
    return reply.status(410).send(error("INVITE_EXPIRED"));
  }
  if (group.invite.expired) return reply.status(410).send(error("INVITE_EXPIRED"));
  if (Date.now() < group.invite.readyAt) return reply.status(409).send(error("INVITE_NOT_READY"));
  const account = accountFor(accountId);
  if (group.members.has(account.platformUserId)) return reply.status(409).send(error("ALREADY_MEMBER"));
  setTimeout(() => {
    group.members.add(account.platformUserId);
    void persistState()
      .then(() => {
        if (!control.dropJoinEvent)
          emit("member_joined", { groupId: group.id, platformUserId: account.platformUserId }, 0);
      })
      .catch((error) => app.log.error({ err: error }, "failed to persist joined member"));
  }, control.joinDelayMs);
  return reply.status(202).send({ accepted: true });
});

app.post<{ Params: { groupId: string } }>("/groups/:groupId/promote", async (request, reply) => {
  const { byAccountId, accountId } = z
    .object({ byAccountId: z.string(), accountId: z.string() })
    .parse(request.body);
  const group = groups.get(request.params.groupId);
  if (!group) return reply.status(404).send(error("GROUP_NOT_FOUND"));
  accountFor(byAccountId);
  const target = accountFor(accountId);
  if (group.creatorAccountId !== byAccountId) return reply.status(403).send(error("NO_PERMISSION"));
  if (!group.members.has(target.platformUserId)) return reply.status(409).send(error("NOT_MEMBER_YET"));
  group.admins.add(target.platformUserId);
  await persistState();
  return {};
});

app.post<{ Params: { groupId: string } }>("/groups/:groupId/kick", async (request, reply) => {
  const { byAccountId, targetPlatformUserId } = z
    .object({ byAccountId: z.string(), targetPlatformUserId: z.string() })
    .parse(request.body);
  const group = groups.get(request.params.groupId);
  if (!group) return reply.status(404).send(error("GROUP_NOT_FOUND"));
  const by = accountFor(byAccountId);
  if (!group.admins.has(by.platformUserId)) return reply.status(403).send(error("NO_PERMISSION"));
  group.members.delete(targetPlatformUserId);
  emit("member_left", { groupId: group.id, platformUserId: targetPlatformUserId });
  return { kicked: true };
});

app.get<{ Params: { groupId: string } }>("/groups/:groupId/members", async (request, reply) => {
  const group = groups.get(request.params.groupId);
  if (!group) return reply.status(404).send(error("GROUP_NOT_FOUND"));
  return [...group.members].map((platformUserId) => ({ platformUserId }));
});

app.post<{ Params: { groupId: string } }>("/groups/:groupId/leave", async (request, reply) => {
  const { accountId } = z.object({ accountId: z.string() }).parse(request.body);
  const group = groups.get(request.params.groupId);
  if (!group) return reply.status(404).send(error("GROUP_NOT_FOUND"));
  const unavailable = requireOnline(accountId);
  if (unavailable) return reply.status(unavailable.status).send(unavailable.body);
  const account = accountFor(accountId);
  if (!group.members.has(account.platformUserId)) return {};
  group.members.delete(account.platformUserId);
  group.admins.delete(account.platformUserId);
  emit("member_left", { groupId: group.id, platformUserId: account.platformUserId });
  return {};
});

app.post<{ Params: { groupId: string } }>("/groups/:groupId/send", async (request, reply) => {
  const { accountId, clientMsgId, text } = z
    .object({ accountId: z.string(), clientMsgId: z.string(), text: z.string() })
    .parse(request.body);
  const group = groups.get(request.params.groupId);
  if (!group) return reply.status(403).send(error("GROUP_WRITE_FORBIDDEN"));
  const unavailable = requireOnline(accountId);
  if (unavailable) return reply.status(unavailable.status).send(unavailable.body);
  const account = accountFor(accountId);
  if (!group.members.has(account.platformUserId)) return reply.status(403).send(error("SENDER_NOT_IN_GROUP"));
  if (control.sendMode === "rate_limited") {
    if (!rateLimitTriggered.has(accountId) || (account.limitedUntil && account.limitedUntil > Date.now())) {
      rateLimitTriggered.add(accountId);
      account.limitedUntil = Date.now() + control.rateLimitSeconds * 1000;
      await persistState();
      return reply
        .status(429)
        .send(
          error("RATE_LIMITED", "Account is rate limited", { retryAfterSeconds: control.rateLimitSeconds }),
        );
    }
    delete account.limitedUntil;
    await persistState();
  }
  if (control.sendMode === "write_forbidden") return reply.status(403).send(error("GROUP_WRITE_FORBIDDEN"));
  const persist = async () => {
    const stored: StoredMessage = {
      groupId: group.id,
      clientMsgId,
      msgId: `msg-${crypto.randomUUID()}`,
      sentAt: Date.now(),
      accountId,
      text,
    };
    const list = messages.get(clientMsgId) ?? [];
    list.push(stored);
    messages.set(clientMsgId, list);
    await persistState();
    if (control.messageBeforeSent) {
      emit(
        "message",
        {
          groupId: group.id,
          msgId: stored.msgId,
          senderPlatformUserId: account.platformUserId,
          text,
          sentAt: stored.sentAt,
        },
        0,
      );
      emit("message_sent", { clientMsgId, msgId: stored.msgId, sentAt: stored.sentAt }, 10);
    } else {
      emit("message_sent", { clientMsgId, msgId: stored.msgId, sentAt: stored.sentAt }, 0);
      emit(
        "message",
        {
          groupId: group.id,
          msgId: stored.msgId,
          senderPlatformUserId: account.platformUserId,
          text,
          sentAt: stored.sentAt,
        },
        10,
      );
    }
  };
  if (control.sendMode === "timeout_sent") {
    setTimeout(persist, 1_500);
    return reply.status(504).send(error("NETWORK_TIMEOUT"));
  }
  if (control.sendMode === "timeout_dropped") return reply.status(504).send(error("NETWORK_TIMEOUT"));
  await new Promise((resolve) => setTimeout(resolve, control.sendDelayMs));
  setTimeout(persist, control.eventDelayMs);
  return reply.status(202).send({ accepted: true });
});

app.get<{ Params: { groupId: string; clientMsgId: string } }>(
  "/groups/:groupId/messages/by-client-id/:clientMsgId",
  async (request, reply) => {
    const found = (messages.get(request.params.clientMsgId) ?? [])
      .filter((item) => item.groupId === request.params.groupId)
      .sort((a, b) => a.sentAt - b.sentAt)[0];
    if (!found) return reply.status(404).send(error("NOT_FOUND"));
    return { msgId: found.msgId, sentAt: found.sentAt };
  },
);

app.get<{ Querystring: { since?: string } }>("/events", async (request, reply) => {
  const since = Number(request.query.since ?? 0);
  reply.hijack();
  const response = reply.raw;
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const event of history.filter((item) => item.eventId > since)) {
    response.write(sseFrame(event));
    if (control.duplicateEvents) response.write(sseFrame(event));
  }
  clients.add(response);
  request.raw.on("close", () => clients.delete(response));
});

await app.listen({ port: Number(process.env.PORT ?? 4001), host: "0.0.0.0" });

const shutdown = async () => {
  await app.close();
  await stateStore.close();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
