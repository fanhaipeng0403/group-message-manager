import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { AccountSchema, AccountStatusSchema } from "@platform/contracts";
import { z } from "zod";
import type { DbPool } from "../../db/pool.js";
import { requireAdmin, authenticate } from "../../common/auth.js";
import { GatewayClient } from "../../integrations/gateway/client.js";
import { AccountService } from "./service.js";
import { AccountIdParamsSchema, BearerSecurity, ErrorResponses } from "../../common/http-schemas.js";

const TransitionSchema = z.object({ to: AccountStatusSchema, expectedFrom: AccountStatusSchema });
const ConnectedAccountSchema = z.object({ status: z.literal("online"), platformUserId: z.string() });
const TransitionResultSchema = z.object({ status: AccountStatusSchema });
const CreateAccountSchema = z.object({
  displayName: z.string().trim().min(2).max(30),
  avatarUrl: z.string().url().max(2_048).optional(),
});

export function registerAccountRoutes(
  app: FastifyInstance,
  pool: DbPool,
  gateway: GatewayClient,
  accounts: AccountService,
): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  api.post(
    "/api/accounts",
    {
      preHandler: requireAdmin,
      schema: {
        operationId: "createAccount",
        tags: ["Accounts"],
        summary: "新建服务账号",
        description: "创建一个 idle 状态的服务账号；连接外部消息网关仍需单独执行 connect。",
        security: BearerSecurity,
        body: CreateAccountSchema,
        response: { 201: AccountSchema, ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext('service-account-id'))");
        const next = await client.query<{ n: number }>(
          `SELECT COALESCE(MAX(SUBSTRING(id FROM '^account-([0-9]+)$')::int), 0) + 1 AS n FROM accounts`,
        );
        const id = `account-${Number(next.rows[0]!.n)}`;
        const avatarUrl =
          request.body.avatarUrl ??
          `https://api.dicebear.com/10.x/lorelei/svg?seed=${encodeURIComponent(id)}`;
        const result = await client.query<{
          id: string;
          display_name: string;
          avatar_url: string | null;
          status: z.infer<typeof AccountStatusSchema>;
          platform_user_id: string | null;
          rate_limited_until: Date | null;
        }>(
          `INSERT INTO accounts (id, display_name, avatar_url)
           VALUES ($1, $2, $3)
           RETURNING id, display_name, avatar_url, status, platform_user_id, rate_limited_until`,
          [id, request.body.displayName, avatarUrl],
        );
        await client.query("COMMIT");
        const account = result.rows[0]!;
        return reply.status(201).send({
          id: account.id,
          displayName: account.display_name,
          avatarUrl: account.avatar_url,
          status: account.status,
          platformUserId: account.platform_user_id,
          rateLimitedUntil: account.rate_limited_until?.toISOString() ?? null,
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  api.get(
    "/api/accounts",
    {
      preHandler: authenticate,
      schema: {
        operationId: "listAccounts",
        tags: ["Accounts"],
        summary: "列出服务账号",
        security: BearerSecurity,
        response: { 200: z.array(AccountSchema), 401: ErrorResponses[401] },
      },
    },
    async () => {
      const result = await pool.query<{
        id: string;
        display_name: string;
        avatar_url: string | null;
        status: z.infer<typeof AccountStatusSchema>;
        platform_user_id: string | null;
        rate_limited_until: Date | null;
      }>(
        "SELECT id, display_name, avatar_url, status, platform_user_id, rate_limited_until FROM accounts ORDER BY created_at, id",
      );
      return result.rows.map((row) => ({
        id: row.id,
        displayName: row.display_name,
        avatarUrl: row.avatar_url,
        status: row.status,
        platformUserId: row.platform_user_id,
        rateLimitedUntil: row.rate_limited_until?.toISOString() ?? null,
      }));
    },
  );

  api.post(
    "/api/accounts/:id/connect",
    {
      preHandler: requireAdmin,
      schema: {
        operationId: "connectAccount",
        tags: ["Accounts"],
        summary: "连接服务账号",
        security: BearerSecurity,
        params: AccountIdParamsSchema,
        response: { 200: ConnectedAccountSchema, ...ErrorResponses },
      },
    },
    async (request) => {
      const connected = await accounts.connectThroughGateway(request.params.id, gateway);
      return { status: "online" as const, platformUserId: connected.platformUserId };
    },
  );

  api.post(
    "/api/accounts/:id/transition",
    {
      preHandler: requireAdmin,
      schema: {
        operationId: "transitionAccount",
        tags: ["Accounts"],
        summary: "按 CAS 语义切换账号状态",
        description: "expectedFrom 必须与数据库当前状态一致，避免并发操作静默覆盖。",
        security: BearerSecurity,
        params: AccountIdParamsSchema,
        body: TransitionSchema,
        response: { 200: TransitionResultSchema, ...ErrorResponses },
      },
    },
    async (request) => {
      const input = request.body;
      await accounts.operatorTransition(request.params.id, input.expectedFrom, input.to, gateway);
      return { status: input.to };
    },
  );
}
