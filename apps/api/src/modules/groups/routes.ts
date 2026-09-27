import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { GroupSchema } from "@platform/contracts";
import { z } from "zod";
import type { DbPool } from "../../db/pool.js";
import { authenticate, requireAdmin } from "../../common/auth.js";
import { AppError } from "../../common/errors.js";
import { BearerSecurity, ErrorResponses, OkSchema, UuidIdParamsSchema } from "../../common/http-schemas.js";

const CreateGroupSchema = z
  .object({
    creatorAccountId: z.string().min(1),
    memberAccountIds: z.array(z.string().min(1)).min(1),
  })
  .superRefine((value, context) => {
    if (value.memberAccountIds.includes(value.creatorAccountId)) {
      context.addIssue({ code: "custom", message: "受邀成员账号不能包含群主账号" });
    }
    if (new Set(value.memberAccountIds).size !== value.memberAccountIds.length) {
      context.addIssue({ code: "custom", message: "受邀成员账号不能重复" });
    }
  });

const PatchGroupSchema = z
  .object({
    agentEnabled: z.boolean().optional(),
    autoKickEnabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "At least one field is required");
const CreateGroupResponseSchema = z.object({ jobId: z.string().uuid() });
const JobIdParamsSchema = z.object({ jobId: z.string().uuid() });
const JobSchema = z.object({
  status: z.enum(["running", "finished", "failed"]),
  errors: z.unknown(),
});

export function registerGroupRoutes(app: FastifyInstance, pool: DbPool): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  api.post(
    "/api/groups",
    {
      preHandler: requireAdmin,
      schema: {
        operationId: "createGroup",
        tags: ["Groups"],
        summary: "提交异步建群任务",
        security: BearerSecurity,
        body: CreateGroupSchema,
        response: { 202: CreateGroupResponseSchema, ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const input = request.body;
      const ids = [input.creatorAccountId, ...input.memberAccountIds];
      const accounts = await pool.query<{ id: string; status: string }>(
        "SELECT id, status FROM accounts WHERE id = ANY($1::text[])",
        [ids],
      );
      const byId = new Map(accounts.rows.map((row) => [row.id, row.status]));
      const unavailable = ids.filter((id) => byId.get(id) !== "online");
      if (unavailable.length) {
        throw new AppError(422, "ACCOUNT_NOT_ONLINE", "All group accounts must be online", {
          accountIds: unavailable,
        });
      }
      const result = await pool.query<{ id: string }>(
        "INSERT INTO jobs (type, payload) VALUES ('create_group', $1) RETURNING id",
        [input],
      );
      return reply.status(202).send({ jobId: result.rows[0]!.id });
    },
  );

  api.get(
    "/api/groups",
    {
      preHandler: authenticate,
      schema: {
        operationId: "listGroups",
        tags: ["Groups"],
        summary: "列出群组",
        security: BearerSecurity,
        response: { 200: z.array(GroupSchema), 401: ErrorResponses[401] },
      },
    },
    async () => listGroups(pool),
  );

  api.get(
    "/api/groups/:id",
    {
      preHandler: authenticate,
      schema: {
        operationId: "getGroup",
        tags: ["Groups"],
        summary: "获取群组详情",
        security: BearerSecurity,
        params: UuidIdParamsSchema,
        response: { 200: GroupSchema, 401: ErrorResponses[401], 404: ErrorResponses[404] },
      },
    },
    async (request) => {
      const groups = await listGroups(pool, request.params.id);
      if (!groups[0]) throw new AppError(404, "GROUP_NOT_FOUND", "Group not found");
      return groups[0];
    },
  );

  api.patch(
    "/api/groups/:id",
    {
      preHandler: requireAdmin,
      schema: {
        operationId: "updateGroup",
        tags: ["Groups"],
        summary: "更新群组 Agent 策略",
        security: BearerSecurity,
        params: UuidIdParamsSchema,
        body: PatchGroupSchema,
        response: { 200: OkSchema, ...ErrorResponses },
      },
    },
    async (request) => {
      const input = request.body;
      const result = await pool.query(
        `UPDATE groups SET
         agent_enabled = COALESCE($2, agent_enabled),
         auto_kick_enabled = COALESCE($3, auto_kick_enabled), updated_at = now()
       WHERE id = $1`,
        [request.params.id, input.agentEnabled ?? null, input.autoKickEnabled ?? null],
      );
      if (!result.rowCount) throw new AppError(404, "GROUP_NOT_FOUND", "Group not found");
      return { ok: true as const };
    },
  );

  api.post(
    "/api/groups/:id/leave-all",
    {
      preHandler: requireAdmin,
      schema: {
        operationId: "leaveAllGroupAccounts",
        tags: ["Groups"],
        summary: "提交全员退群任务",
        security: BearerSecurity,
        params: UuidIdParamsSchema,
        response: { 202: CreateGroupResponseSchema, ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const group = await pool.query("SELECT 1 FROM groups WHERE id = $1 AND status = 'active'", [
        request.params.id,
      ]);
      if (!group.rowCount) throw new AppError(404, "GROUP_NOT_FOUND", "Active group not found");
      const result = await pool.query<{ id: string }>(
        "INSERT INTO jobs (type, payload) VALUES ('leave_all', $1) RETURNING id",
        [{ groupId: request.params.id }],
      );
      return reply.status(202).send({ jobId: result.rows[0]!.id });
    },
  );

  api.get(
    "/api/jobs/:jobId",
    {
      preHandler: authenticate,
      schema: {
        operationId: "getJob",
        tags: ["Groups"],
        summary: "查询异步任务进度",
        security: BearerSecurity,
        params: JobIdParamsSchema,
        response: { 200: JobSchema, 401: ErrorResponses[401], 404: ErrorResponses[404] },
      },
    },
    async (request) => {
      const result = await pool.query<{ status: z.infer<typeof JobSchema>["status"]; errors: unknown }>(
        "SELECT status, errors FROM jobs WHERE id = $1",
        [request.params.jobId],
      );
      if (!result.rows[0]) throw new AppError(404, "JOB_NOT_FOUND", "Job not found");
      return result.rows[0];
    },
  );
}

async function listGroups(pool: DbPool, id?: string) {
  const result = await pool.query<{
    id: string;
    gateway_group_id: string;
    status: z.infer<typeof GroupSchema>["status"];
    creator_account_id: string;
    agent_enabled: boolean;
    auto_kick_enabled: boolean;
  }>(
    `SELECT id, gateway_group_id, status, creator_account_id, agent_enabled, auto_kick_enabled
     FROM groups WHERE ($1::uuid IS NULL OR id = $1) ORDER BY created_at DESC`,
    [id ?? null],
  );
  return Promise.all(
    result.rows.map(async (row) => {
      const members = await pool.query<{
        account_id: string | null;
        platform_user_id: string;
        role: z.infer<typeof GroupSchema>["members"][number]["role"];
      }>(
        "SELECT account_id, platform_user_id, role FROM group_members WHERE group_id = $1 ORDER BY role, account_id",
        [row.id],
      );
      const agent = await pool.query<{
        id: string;
        status: "running" | "finished" | "failed" | "blocked" | "cancelled";
      }>("SELECT id, status FROM agent_runs WHERE group_id = $1 ORDER BY created_at DESC LIMIT 1", [row.id]);
      const sequence = await pool.query<{ id: string }>(
        "SELECT id FROM sequence_runs WHERE group_id = $1 AND status = 'running' LIMIT 1",
        [row.id],
      );
      return {
        id: row.id,
        gatewayGroupId: row.gateway_group_id,
        status: row.status,
        creatorAccountId: row.creator_account_id,
        agentEnabled: row.agent_enabled,
        autoKickEnabled: row.auto_kick_enabled,
        members: members.rows.map((member) => ({
          accountId: member.account_id,
          platformUserId: member.platform_user_id,
          role: member.role,
        })),
        activeSequenceRunId: sequence.rows[0]?.id ?? null,
        activeAgentRunId: agent.rows[0]?.status === "running" ? agent.rows[0].id : null,
        latestAgentRunStatus: agent.rows[0]?.status ?? null,
      };
    }),
  );
}
