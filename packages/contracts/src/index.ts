import { z } from "zod";

export const accountStatuses = [
  "idle",
  "online",
  "rate_limited",
  "disconnected",
  "suspended",
  "session_expired",
] as const;

export const AccountStatusSchema = z.enum(accountStatuses);
export type AccountStatus = z.infer<typeof AccountStatusSchema>;

export const terminalAccountStatuses = ["suspended", "session_expired"] as const;

export const AccountSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  status: AccountStatusSchema,
  platformUserId: z.string().nullable(),
  rateLimitedUntil: z.string().nullable(),
});
export type Account = z.infer<typeof AccountSchema>;

export const GroupMemberSchema = z.object({
  accountId: z.string().nullable(),
  platformUserId: z.string(),
  role: z.enum(["creator", "admin", "member"]),
});

export const GroupSchema = z.object({
  id: z.string(),
  gatewayGroupId: z.string(),
  status: z.enum(["active", "unreachable", "left"]),
  creatorAccountId: z.string(),
  agentEnabled: z.boolean(),
  autoKickEnabled: z.boolean(),
  members: z.array(GroupMemberSchema),
  activeSequenceRunId: z.string().nullable(),
  activeAgentRunId: z.string().nullable(),
  latestAgentRunStatus: z.enum(["running", "finished", "failed", "blocked", "cancelled"]).nullable(),
});
export type Group = z.infer<typeof GroupSchema>;

export const DeliveryStatusSchema = z.enum(["queued", "accepted", "sent", "failed", "unknown", "cancelled"]);

export const MessageSchema = z.object({
  msgId: z.string().nullable(),
  clientMsgId: z.string().nullable(),
  senderPlatformUserId: z.string(),
  isOwn: z.boolean(),
  text: z.string(),
  sentAt: z.string(),
  deliveryStatus: DeliveryStatusSchema.nullable(),
  failCode: z.string().nullable(),
});
export type Message = z.infer<typeof MessageSchema>;

export const ApiErrorSchema = z.object({
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      requestId: z.string(),
    })
    .passthrough(),
});

export const GatewayEventSchema = z.discriminatedUnion("type", [
  z.object({
    eventId: z.number().int().positive(),
    type: z.literal("message"),
    groupId: z.string(),
    msgId: z.string(),
    senderPlatformUserId: z.string(),
    text: z.string(),
    sentAt: z.number(),
    mediaUrl: z.string().optional(),
  }),
  z.object({
    eventId: z.number().int().positive(),
    type: z.literal("message_sent"),
    clientMsgId: z.string(),
    msgId: z.string(),
    sentAt: z.number(),
  }),
  z.object({
    eventId: z.number().int().positive(),
    type: z.literal("message_failed"),
    clientMsgId: z.string(),
    code: z.string(),
  }),
  z.object({
    eventId: z.number().int().positive(),
    type: z.enum(["member_joined", "member_left"]),
    groupId: z.string(),
    platformUserId: z.string(),
  }),
  z.object({
    eventId: z.number().int().positive(),
    type: z.literal("account_status"),
    accountId: z.string(),
    status: z.enum(["suspended", "session_expired"]),
  }),
]);
export type GatewayEvent = z.infer<typeof GatewayEventSchema>;

export const WsEventSchema = z.object({
  seq: z.number().int().positive(),
  type: z.string(),
  payload: z.record(z.string(), z.unknown()),
});
export type WsEvent = z.infer<typeof WsEventSchema>;

export const AgentToolNames = ["get_recent_messages", "send_message", "kick_user", "finish"] as const;

export const AgentTurnResponseSchema = z.discriminatedUnion("stop_reason", [
  z.object({
    stop_reason: z.literal("tool_use"),
    content: z.tuple([
      z.object({
        type: z.literal("tool_use"),
        id: z.string(),
        name: z.string(),
        input: z.record(z.string(), z.unknown()),
      }),
    ]),
  }),
  z.object({
    stop_reason: z.literal("end_turn"),
    content: z.tuple([z.object({ type: z.literal("text"), text: z.string() })]),
  }),
]);
export type AgentTurnResponse = z.infer<typeof AgentTurnResponseSchema>;
