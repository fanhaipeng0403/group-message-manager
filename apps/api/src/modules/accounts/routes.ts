import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { AccountSchema, AccountStatusSchema } from "@platform/contracts";
import { z } from "zod";
import type { DbPool } from "../../db/pool.js";
import { requireAdmin, authenticate } from "../../common/auth.js";
import { AppError } from "../../common/errors.js";
import { GatewayClient } from "../../integrations/gateway/client.js";
import { AccountService } from "./service.js";
import { canTransition } from "./state-machine.js";
import { AccountIdParamsSchema, BearerSecurity, ErrorResponses } from "../../common/http-schemas.js";

const TransitionSchema = z.object({ to: AccountStatusSchema, expectedFrom: AccountStatusSchema });
const ConnectedAccountSchema = z.object({ status: z.literal("online"), platformUserId: z.string() });
const TransitionResultSchema = z.object({ status: AccountStatusSchema });

export function registerAccountRoutes(
  app: FastifyInstance,
  pool: DbPool,
  gateway: GatewayClient,
  accounts: AccountService,
): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
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
        status: z.infer<typeof AccountStatusSchema>;
        platform_user_id: string | null;
        rate_limited_until: Date | null;
      }>("SELECT id, status, platform_user_id, rate_limited_until FROM accounts ORDER BY id");
      return result.rows.map((row) => ({
        id: row.id,
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
      const current = await pool.query<{ status: string }>("SELECT status FROM accounts WHERE id = $1", [
        request.params.id,
      ]);
      if (!current.rowCount) throw new AppError(404, "ACCOUNT_NOT_FOUND", "Account not found");
      const from = AccountStatusSchema.parse(current.rows[0]!.status);
      if (from !== "idle" && from !== "disconnected") {
        throw new AppError(409, "ILLEGAL_TRANSITION", `Cannot connect account in ${from}`);
      }
      const connected = await gateway.connect(request.params.id);
      try {
        await accounts.connected(request.params.id, from, connected.platformUserId);
      } catch (error) {
        await gateway.disconnect(request.params.id).catch(() => undefined);
        throw error;
      }
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
      if (!canTransition(input.expectedFrom, input.to)) {
        throw new AppError(
          409,
          "ILLEGAL_TRANSITION",
          `Cannot transition account from ${input.expectedFrom} to ${input.to}`,
        );
      }
      const current = await pool.query<{ status: string }>("SELECT status FROM accounts WHERE id = $1", [
        request.params.id,
      ]);
      if (!current.rowCount) throw new AppError(404, "ACCOUNT_NOT_FOUND", "Account not found");
      if (current.rows[0]!.status !== input.expectedFrom) {
        throw new AppError(409, "CAS_CONFLICT", "Account status changed concurrently", {
          expectedFrom: input.expectedFrom,
          actual: current.rows[0]!.status,
        });
      }
      const disconnecting = input.to === "idle" || input.to === "disconnected";
      if (disconnecting) await gateway.disconnect(request.params.id);
      try {
        await accounts.transition(request.params.id, input.expectedFrom, input.to);
      } catch (error) {
        if (disconnecting) await gateway.connect(request.params.id).catch(() => undefined);
        throw error;
      }
      return { status: input.to };
    },
  );
}
