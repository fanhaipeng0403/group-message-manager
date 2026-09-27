import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { DbPool } from "../../db/pool.js";
import { authenticate, requireAdmin } from "../../common/auth.js";
import { AppError } from "../../common/errors.js";
import { BearerSecurity, ErrorResponses, UuidIdParamsSchema } from "../../common/http-schemas.js";

const SequenceStepSchema = z.object({
  index: z.number().int().positive(),
  accountRole: z.enum(["admin", "member"]),
  text: z.string().min(1),
  delaySeconds: z.number().int().min(0),
});
const CreateSequenceSchema = z
  .object({
    name: z.string().trim().min(1),
    steps: z.array(SequenceStepSchema).min(1),
  })
  .superRefine((value, context) => {
    const indexes = value.steps.map((step) => step.index);
    if (new Set(indexes).size !== indexes.length)
      context.addIssue({ code: "custom", message: "Step indexes must be unique" });
  });
const StartRunSchema = z.object({
  sequenceId: z.string().uuid(),
  vars: z.record(z.string(), z.string()).default({}),
  stepVars: z.record(z.string(), z.record(z.string(), z.string())).default({}),
});
const IdResponseSchema = z.object({ id: z.string().uuid() });
const RunResponseSchema = z.object({ runId: z.string().uuid() });
const SequenceSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  steps: z.array(SequenceStepSchema),
});
const RunDetailSchema = z.object({
  status: z.enum(["running", "finished", "failed", "stopped"]),
  currentStepIndex: z.number().int(),
  steps: z.array(
    z.object({
      index: z.number().int(),
      status: z.enum(["pending", "accepted", "sent", "skipped", "failed"]),
      scheduledAt: z.string().datetime().nullable(),
      sentAt: z.string().datetime().nullable(),
      clientMsgId: z.string().nullable(),
      resolvedVars: z.record(z.string(), z.string()),
      varSources: z.record(z.string(), z.string()),
    }),
  ),
});

interface StoredStep {
  index: number;
  accountRole: "admin" | "member";
  text: string;
  delaySeconds: number;
}

export function registerSequenceRoutes(app: FastifyInstance, pool: DbPool): void {
  const api = app.withTypeProvider<ZodTypeProvider>();

  api.get(
    "/api/sequences",
    {
      preHandler: authenticate,
      schema: {
        operationId: "listSequences",
        tags: ["Sequences"],
        summary: "列出定时消息序列",
        security: BearerSecurity,
        response: { 200: z.array(SequenceSchema), 401: ErrorResponses[401] },
      },
    },
    async () => {
      const result = await pool.query<{ id: string; name: string; steps: StoredStep[] }>(
        "SELECT id, name, steps FROM sequences ORDER BY created_at",
      );
      return result.rows;
    },
  );

  api.post(
    "/api/sequences",
    {
      preHandler: requireAdmin,
      schema: {
        operationId: "createSequence",
        tags: ["Sequences"],
        summary: "创建定时消息序列",
        security: BearerSecurity,
        body: CreateSequenceSchema,
        response: { 200: IdResponseSchema, ...ErrorResponses },
      },
    },
    async (request) => {
      const steps = [...request.body.steps].sort((a, b) => a.index - b.index);
      const result = await pool.query<{ id: string }>(
        "INSERT INTO sequences (name, steps) VALUES ($1, $2) RETURNING id",
        [request.body.name, JSON.stringify(steps)],
      );
      return { id: result.rows[0]!.id };
    },
  );

  api.post(
    "/api/groups/:id/sequence-runs",
    {
      preHandler: requireAdmin,
      schema: {
        operationId: "startSequenceRun",
        tags: ["Sequences"],
        summary: "预检并启动群组序列",
        security: BearerSecurity,
        params: UuidIdParamsSchema,
        body: StartRunSchema,
        response: { 201: RunResponseSchema, ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const group = await pool.query("SELECT 1 FROM groups WHERE id = $1 AND status = 'active'", [
        request.params.id,
      ]);
      if (!group.rowCount) throw new AppError(404, "GROUP_NOT_FOUND", "Active group not found");
      const sequence = await pool.query<{ steps: StoredStep[] }>(
        "SELECT steps FROM sequences WHERE id = $1",
        [request.body.sequenceId],
      );
      if (!sequence.rows[0]) throw new AppError(404, "SEQUENCE_NOT_FOUND", "Sequence not found");
      const prepared = prepareSteps(sequence.rows[0].steps, request.body.vars, request.body.stepVars);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const run = await client.query<{ id: string }>(
          "INSERT INTO sequence_runs (group_id, sequence_id, current_step_index) VALUES ($1, $2, $3) RETURNING id",
          [request.params.id, request.body.sequenceId, prepared[0]!.index],
        );
        for (const [offset, step] of prepared.entries()) {
          await client.query(
            `INSERT INTO sequence_run_steps
           (run_id, step_index, account_role, text, delay_seconds, scheduled_at, resolved_vars, var_sources)
           VALUES ($1, $2, $3, $4, $5,
             CASE WHEN $6::integer = 0 THEN now() + ($5::integer * interval '1 second') ELSE NULL END, $7, $8)`,
            [
              run.rows[0]!.id,
              step.index,
              step.accountRole,
              step.text,
              step.delaySeconds,
              offset,
              step.resolvedVars,
              step.varSources,
            ],
          );
        }
        await client.query("COMMIT");
        return reply.status(201).send({ runId: run.rows[0]!.id });
      } catch (error: any) {
        await client.query("ROLLBACK");
        if (error?.code === "23505")
          throw new AppError(409, "SEQUENCE_ALREADY_RUNNING", "A sequence is already running in this group");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  api.get(
    "/api/sequence-runs/:id",
    {
      preHandler: authenticate,
      schema: {
        operationId: "getSequenceRun",
        tags: ["Sequences"],
        summary: "查询序列运行进度",
        security: BearerSecurity,
        params: UuidIdParamsSchema,
        response: { 200: RunDetailSchema, 401: ErrorResponses[401], 404: ErrorResponses[404] },
      },
    },
    async (request) => {
      const run = await pool.query<{
        status: "running" | "finished" | "failed" | "stopped";
        current_step_index: number;
      }>("SELECT status, current_step_index FROM sequence_runs WHERE id = $1", [request.params.id]);
      if (!run.rows[0]) throw new AppError(404, "SEQUENCE_RUN_NOT_FOUND", "Sequence run not found");
      const steps = await pool.query<{
        step_index: number;
        status: "pending" | "accepted" | "sent" | "skipped" | "failed";
        scheduled_at: Date | null;
        sent_at: Date | null;
        client_msg_id: string | null;
        resolved_vars: Record<string, string>;
        var_sources: Record<string, string>;
      }>("SELECT * FROM sequence_run_steps WHERE run_id = $1 ORDER BY step_index", [request.params.id]);
      return {
        status: run.rows[0].status,
        currentStepIndex: run.rows[0].current_step_index,
        steps: steps.rows.map((step) => ({
          index: step.step_index,
          status: step.status,
          scheduledAt: step.scheduled_at?.toISOString() ?? null,
          sentAt: step.sent_at?.toISOString() ?? null,
          clientMsgId: step.client_msg_id,
          resolvedVars: step.resolved_vars,
          varSources: step.var_sources,
        })),
      };
    },
  );
}

export function prepareSteps(
  steps: StoredStep[],
  defaults: Record<string, string>,
  stepVars: Record<string, Record<string, string>>,
) {
  const values = Object.fromEntries(Object.entries(defaults).filter(([, value]) => value !== ""));
  const sources = Object.fromEntries(Object.keys(values).map((key) => [key, "default"]));
  return [...steps]
    .sort((a, b) => a.index - b.index)
    .map((step) => {
      for (const [key, value] of Object.entries(stepVars[String(step.index)] ?? {})) {
        if (value !== "") {
          values[key] = value;
          sources[key] = `step:${step.index}`;
        }
      }
      const keys = [...step.text.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1]!);
      for (const key of keys) {
        if (!values[key])
          throw new AppError(422, "UNRESOLVED_PLACEHOLDER", `Unresolved placeholder: ${key}`, {
            stepIndex: step.index,
            key,
          });
      }
      return {
        ...step,
        text: step.text.replace(/\{([A-Za-z0-9_]+)\}/g, (_match, key: string) => values[key]!),
        resolvedVars: { ...values },
        varSources: { ...sources },
      };
    });
}
