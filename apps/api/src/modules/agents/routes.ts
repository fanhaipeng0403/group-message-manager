import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { DbPool } from "../../db/pool.js";
import { authenticate } from "../../common/auth.js";
import { AppError } from "../../common/errors.js";
import { BearerSecurity, ErrorResponses, UuidIdParamsSchema } from "../../common/http-schemas.js";

const AgentRunSchema = z.object({
  id: z.string().uuid(),
  groupId: z.string().uuid(),
  status: z.string(),
  endReason: z.string().nullable(),
  summary: z.string().nullable(),
});
const AgentStepSchema = z.object({
  kind: z.string(),
  toolUseId: z.string().nullable(),
  name: z.string().nullable(),
  input: z.unknown(),
  resultSummary: z.string(),
  isError: z.boolean(),
  errorCode: z.string().nullable(),
  auditVerdict: z.string().nullable(),
  rawResponse: z.string(),
});
const AgentRunDetailSchema = AgentRunSchema.extend({ steps: z.array(AgentStepSchema) });

export function registerAgentRoutes(app: FastifyInstance, pool: DbPool): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  api.get(
    "/api/agent-runs/:id",
    {
      preHandler: authenticate,
      schema: {
        operationId: "getAgentRun",
        tags: ["Agent Runs"],
        summary: "获取 Agent Run 与完整工具步骤",
        security: BearerSecurity,
        params: UuidIdParamsSchema,
        response: { 200: AgentRunDetailSchema, 401: ErrorResponses[401], 404: ErrorResponses[404] },
      },
    },
    async (request) => {
      const run = await pool.query<{
        id: string;
        group_id: string;
        status: string;
        end_reason: string | null;
        summary: string | null;
      }>("SELECT id, group_id, status, end_reason, summary FROM agent_runs WHERE id = $1", [
        request.params.id,
      ]);
      if (!run.rows[0]) throw new AppError(404, "AGENT_RUN_NOT_FOUND", "Agent run not found");
      const steps = await pool.query<{
        kind: string;
        tool_use_id: string | null;
        name: string | null;
        input: unknown;
        result_summary: string;
        is_error: boolean;
        error_code: string | null;
        audit_verdict: string | null;
        raw_response: string;
      }>(
        `SELECT kind, tool_use_id, name, input, result_summary, is_error, error_code, audit_verdict, raw_response
       FROM agent_steps WHERE run_id = $1 ORDER BY step_index`,
        [request.params.id],
      );
      return { ...formatRun(run.rows[0]), steps: steps.rows.map(formatStep) };
    },
  );

  api.get(
    "/api/groups/:id/agent-runs",
    {
      preHandler: authenticate,
      schema: {
        operationId: "listGroupAgentRuns",
        tags: ["Agent Runs"],
        summary: "列出群组最近的 Agent Runs",
        security: BearerSecurity,
        params: UuidIdParamsSchema,
        response: { 200: z.array(AgentRunSchema), 401: ErrorResponses[401] },
      },
    },
    async (request) => {
      const result = await pool.query<{
        id: string;
        group_id: string;
        status: string;
        end_reason: string | null;
        summary: string | null;
      }>(
        "SELECT id, group_id, status, end_reason, summary FROM agent_runs WHERE group_id = $1 ORDER BY created_at DESC LIMIT 20",
        [request.params.id],
      );
      return result.rows.map((run) => formatRun(run));
    },
  );
}

function formatRun(run: {
  id: string;
  group_id: string;
  status: string;
  end_reason: string | null;
  summary: string | null;
}) {
  return {
    id: run.id,
    groupId: run.group_id,
    status: run.status,
    endReason: run.end_reason,
    summary: run.summary,
  };
}

function formatStep(step: {
  kind: string;
  tool_use_id: string | null;
  name: string | null;
  input: unknown;
  result_summary: string;
  is_error: boolean;
  error_code: string | null;
  audit_verdict: string | null;
  raw_response: string;
}) {
  return {
    kind: step.kind,
    toolUseId: step.tool_use_id,
    name: step.name,
    input: step.input,
    resultSummary: step.result_summary,
    isError: step.is_error,
    errorCode: step.error_code,
    auditVerdict: step.audit_verdict,
    rawResponse: step.raw_response,
  };
}
