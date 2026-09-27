import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { DeliveryStatusSchema, MessageSchema } from "@platform/contracts";
import { z } from "zod";
import type { DbPool } from "../../db/pool.js";
import { authenticate, requireAdmin } from "../../common/auth.js";
import { AppError } from "../../common/errors.js";
import { BearerSecurity, ErrorResponses, UuidIdParamsSchema } from "../../common/http-schemas.js";

const SendSchema = z.object({ accountId: z.string().min(1), text: z.string().trim().min(1).max(4_000) });
const SendResponseSchema = z.object({ clientMsgId: z.string().uuid() });
const MessageQuerySchema = z.object({
  before: z.string().optional().describe("上一页返回的稳定游标"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const MessagePageSchema = z.object({ items: z.array(MessageSchema), nextCursor: z.string().nullable() });

function encodeCursor(sentAt: Date, id: string): string {
  return Buffer.from(JSON.stringify([sentAt.toISOString(), id])).toString("base64url");
}

function decodeCursor(cursor?: string): [string, string] | undefined {
  if (!cursor) return undefined;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(value) && value.length === 2 && value.every((item) => typeof item === "string")) {
      return value as [string, string];
    }
  } catch {
    /* converted to validation error below */
  }
  throw new AppError(400, "VALIDATION_ERROR", "Invalid message cursor");
}

export function registerMessageRoutes(app: FastifyInstance, pool: DbPool): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  api.post(
    "/api/groups/:id/send",
    {
      preHandler: requireAdmin,
      schema: {
        operationId: "sendGroupMessage",
        tags: ["Messages"],
        summary: "将消息写入持久化 Outbox",
        description: "接口只确认本地入队；最终 queued/accepted/sent 状态通过消息时间线观察。",
        security: BearerSecurity,
        params: UuidIdParamsSchema,
        body: SendSchema,
        response: { 202: SendResponseSchema, ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const input = request.body;
      const result = await pool.query<{
        gateway_group_id: string;
        group_status: string;
        account_status: string;
        platform_user_id: string;
      }>(
        `SELECT g.gateway_group_id, g.status AS group_status, a.status AS account_status, a.platform_user_id
       FROM groups g
       JOIN group_members gm ON gm.group_id = g.id AND gm.account_id = $2
       JOIN accounts a ON a.id = gm.account_id
       WHERE g.id = $1`,
        [request.params.id, input.accountId],
      );
      const context = result.rows[0];
      if (!context) throw new AppError(409, "ACCOUNT_NOT_IN_GROUP", "Account is not a member of this group");
      if (["idle", "disconnected", "suspended", "session_expired"].includes(context.account_status)) {
        throw new AppError(409, "ACCOUNT_UNAVAILABLE", "Account cannot send messages");
      }
      if (context.group_status !== "active")
        throw new AppError(409, "GROUP_UNREACHABLE", "Group is not writable");
      const clientMsgId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO messages
       (group_id, account_id, client_msg_id, sender_platform_user_id, is_own, text, sent_at, delivery_status, next_attempt_at)
       VALUES ($1, $2, $3, $4, true, $5, now(), 'queued', now())`,
        [request.params.id, input.accountId, clientMsgId, context.platform_user_id, input.text],
      );
      return reply.status(202).send({ clientMsgId });
    },
  );

  api.get(
    "/api/groups/:id/messages",
    {
      preHandler: authenticate,
      schema: {
        operationId: "listGroupMessages",
        tags: ["Messages"],
        summary: "按稳定游标加载群消息时间线",
        security: BearerSecurity,
        params: UuidIdParamsSchema,
        querystring: MessageQuerySchema,
        response: { 200: MessagePageSchema, 400: ErrorResponses[400], 401: ErrorResponses[401] },
      },
    },
    async (request) => {
      const cursor = decodeCursor(request.query.before);
      const limit = request.query.limit;
      const result = await pool.query<{
        id: string;
        msg_id: string | null;
        client_msg_id: string | null;
        sender_platform_user_id: string;
        is_own: boolean;
        text: string;
        sent_at: Date;
        delivery_status: z.infer<typeof DeliveryStatusSchema> | null;
        fail_code: string | null;
      }>(
        `SELECT id, msg_id, client_msg_id, sender_platform_user_id, is_own, text, sent_at, delivery_status, fail_code
         FROM messages WHERE group_id = $1
           AND ($2::timestamptz IS NULL OR (sent_at, id) < ($2::timestamptz, $3::uuid))
         ORDER BY sent_at DESC, id DESC LIMIT $4`,
        [request.params.id, cursor?.[0] ?? null, cursor?.[1] ?? null, limit + 1],
      );
      const hasMore = result.rows.length > limit;
      const rows = result.rows.slice(0, limit);
      const last = rows.at(-1);
      return {
        items: rows.map((row) => ({
          msgId: row.msg_id,
          clientMsgId: row.client_msg_id,
          senderPlatformUserId: row.sender_platform_user_id,
          isOwn: row.is_own,
          text: row.text,
          sentAt: row.sent_at.toISOString(),
          deliveryStatus: row.delivery_status,
          failCode: row.fail_code,
        })),
        nextCursor: hasMore && last ? encodeCursor(last.sent_at, last.id) : null,
      };
    },
  );
}
