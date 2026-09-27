import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { DbPool } from "../../db/pool.js";
import { requireAdmin, authenticate } from "../../common/auth.js";
import { AppError } from "../../common/errors.js";
import { GatewayClient } from "../../integrations/gateway/client.js";
import { AgentClient } from "../../integrations/agent/client.js";
import { BearerSecurity, ErrorResponses } from "../../common/http-schemas.js";

const scenarios = [
  {
    id: "s2_duplicate",
    requirement: "S2",
    title: "重复事件不重复执行",
    summary: "网关把每个 SSE 事件投递两次，系统仍只保存一条消息、只触发一个 Agent run。",
    proves: ["Inbox 去重", "消息唯一约束", "Agent 不重复触发"],
  },
  {
    id: "s4_rate_limit",
    requirement: "S4",
    title: "限流期间不打爆网关",
    summary: "首次发送返回 429，消息留在队列；账号自动恢复 online 后按原顺序发送。",
    proves: ["账号状态机", "持久化 Outbox", "延迟恢复"],
  },
  {
    id: "s5_agent_idempotency",
    requirement: "S5",
    title: "Agent 重试不重复发消息",
    summary: "首次发送遇到 504 但稍后落地，Agent 使用相同 key 再调用；系统不重发、不重复审计。",
    proves: ["504 对账", "幂等 key", "审计只执行一次"],
  },
  {
    id: "s6_agent_protocol",
    requirement: "S6",
    title: "Agent 胡说八道也拖不垮服务",
    summary: "Agent 依次返回坏 JSON 和未知工具，系统记录原始响应与错误步骤，随后正常结束。",
    proves: ["严格协议校验", "协议错误预算", "可审计步骤"],
  },
  {
    id: "agent_happy",
    requirement: "A5",
    title: "完整 Agent 工具闭环",
    summary: "外部消息触发 Agent，依次读消息、通过审计、发送回复并结束。",
    proves: ["单群串行", "工具循环", "审计后执行"],
  },
] as const;

type ScenarioId = (typeof scenarios)[number]["id"];
const ScenarioSchema = z.enum(scenarios.map((item) => item.id) as [ScenarioId, ...ScenarioId[]]);
const StartSchema = z.object({ scenario: ScenarioSchema, groupId: z.string().uuid() });
const ScenarioCatalogSchema = z.object({
  id: ScenarioSchema,
  requirement: z.string(),
  title: z.string(),
  summary: z.string(),
  proves: z.array(z.string()),
});
const ExperimentQuerySchema = z.object({ groupId: z.string().uuid().optional() });
const ExperimentSchema = z.object({
  id: z.string().uuid(),
  scenario: ScenarioSchema,
  groupId: z.string().uuid(),
  status: z.enum(["running", "passed", "failed"]),
  evidence: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
const StartExperimentResponseSchema = z.object({ experimentId: z.string().uuid() });

interface ExperimentRow {
  id: string;
  scenario: ScenarioId;
  group_id: string;
  account_id: string | null;
  client_msg_id: string | null;
  trigger_msg_id: string | null;
  status: "running" | "passed" | "failed";
  evidence: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export function registerDemoRoutes(
  app: FastifyInstance,
  pool: DbPool,
  gateway: GatewayClient,
  agent: AgentClient,
): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  api.get(
    "/api/demo/scenarios",
    {
      preHandler: authenticate,
      schema: {
        operationId: "listReliabilityScenarios",
        tags: ["Reliability Lab"],
        summary: "列出可复现的可靠性场景",
        security: BearerSecurity,
        response: { 200: z.array(ScenarioCatalogSchema), 401: ErrorResponses[401] },
      },
    },
    async () => scenarios.map((item) => ({ ...item, proves: [...item.proves] })),
  );

  api.get(
    "/api/demo/experiments",
    {
      preHandler: authenticate,
      schema: {
        operationId: "listReliabilityExperiments",
        tags: ["Reliability Lab"],
        summary: "查询实验与持久化证据",
        security: BearerSecurity,
        querystring: ExperimentQuerySchema,
        response: { 200: z.array(ExperimentSchema), 401: ErrorResponses[401] },
      },
    },
    async (request) => {
      await refreshRunning(pool, gateway);
      const result = await pool.query<ExperimentRow>(
        `SELECT * FROM reliability_experiments
         WHERE ($1::uuid IS NULL OR group_id = $1)
         ORDER BY created_at DESC LIMIT 30`,
        [request.query.groupId ?? null],
      );
      return result.rows.map(formatExperiment);
    },
  );

  api.post(
    "/api/demo/experiments",
    {
      preHandler: requireAdmin,
      schema: {
        operationId: "startReliabilityExperiment",
        tags: ["Reliability Lab"],
        summary: "运行真实故障实验",
        description: "配置 Mock 故障、注入真实事件并由正常 Worker 执行；接口返回后通过查询接口轮询证据。",
        security: BearerSecurity,
        body: StartSchema,
        response: { 202: StartExperimentResponseSchema, ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const input = request.body;
      await refreshRunning(pool, gateway);
      const group = await pool.query<{
        gateway_group_id: string;
        status: string;
        creator_account_id: string;
      }>("SELECT gateway_group_id, status, creator_account_id FROM groups WHERE id = $1", [input.groupId]);
      if (!group.rows[0]) throw new AppError(404, "GROUP_NOT_FOUND", "Group not found");
      if (group.rows[0].status !== "active")
        throw new AppError(409, "GROUP_UNREACHABLE", "Experiment requires an active group");

      const sender = await pool.query<{ account_id: string; platform_user_id: string }>(
        `SELECT gm.account_id, gm.platform_user_id FROM group_members gm
       JOIN accounts a ON a.id = gm.account_id
       WHERE gm.group_id = $1 AND a.status = 'online'
       ORDER BY CASE gm.role WHEN 'admin' THEN 0 WHEN 'creator' THEN 1 ELSE 2 END, gm.account_id LIMIT 1`,
        [input.groupId],
      );
      if (!sender.rows[0]?.account_id)
        throw new AppError(409, "NO_AVAILABLE_ACCOUNT", "Experiment requires an online group account");

      // Mock gateway state is intentionally in-memory. Rehydrate it from the durable
      // database so a gateway restart cannot make the reliability lab reuse a ghost group.
      const demoMembers = await pool.query<{ account_id: string }>(
        "SELECT account_id FROM group_members WHERE group_id = $1 AND account_id IS NOT NULL ORDER BY account_id",
        [input.groupId],
      );
      const eventCursor = await pool.query<{ next_event_id: string }>(
        "SELECT (COALESCE(MAX(event_id), 0) + 1)::text AS next_event_id FROM gateway_events",
      );
      await gateway.restoreDemoGroup(
        group.rows[0].gateway_group_id,
        group.rows[0].creator_account_id,
        demoMembers.rows
          .map((row) => row.account_id)
          .filter((accountId) => accountId !== group.rows[0]!.creator_account_id),
        Number(eventCursor.rows[0]?.next_event_id ?? 1),
      );

      let created: { id: string };
      try {
        const result = await pool.query<{ id: string }>(
          `INSERT INTO reliability_experiments (scenario, group_id, account_id)
         VALUES ($1, $2, $3) RETURNING id`,
          [input.scenario, input.groupId, sender.rows[0].account_id],
        );
        created = result.rows[0]!;
      } catch (error: any) {
        if (error?.code === "23505")
          throw new AppError(409, "EXPERIMENT_ALREADY_RUNNING", "Wait for the current experiment to finish");
        throw error;
      }

      try {
        if (input.scenario === "s4_rate_limit") {
          await gateway.configureDemo({
            duplicateEvents: false,
            sendMode: "rate_limited",
            rateLimitSeconds: 2,
            resetRuntime: true,
          });
          const clientMsgId = crypto.randomUUID();
          await pool.query(
            `INSERT INTO messages
           (group_id, account_id, client_msg_id, sender_platform_user_id, is_own, text, sent_at, delivery_status, next_attempt_at)
           VALUES ($1, $2, $3, $4, true, $5, now(), 'queued', now())`,
            [
              input.groupId,
              sender.rows[0].account_id,
              clientMsgId,
              sender.rows[0].platform_user_id,
              "[S4 实验] 限流恢复后发送",
            ],
          );
          await pool.query("UPDATE reliability_experiments SET client_msg_id = $2 WHERE id = $1", [
            created.id,
            clientMsgId,
          ]);
        } else {
          await pool.query("UPDATE groups SET agent_enabled = true, updated_at = now() WHERE id = $1", [
            input.groupId,
          ]);
          if (input.scenario === "s2_duplicate") {
            await gateway.configureDemo({ duplicateEvents: true, sendMode: "success", resetRuntime: true });
            await agent.configureDemo("normal");
          } else if (input.scenario === "s5_agent_idempotency") {
            await gateway.configureDemo({
              duplicateEvents: false,
              sendMode: "timeout_sent",
              resetRuntime: true,
            });
            await agent.configureDemo("s5_retry_same_key");
          } else if (input.scenario === "s6_agent_protocol") {
            await gateway.configureDemo({ duplicateEvents: false, sendMode: "success", resetRuntime: true });
            await agent.configureDemo("s6_bad_then_unknown");
          } else {
            await gateway.configureDemo({ duplicateEvents: false, sendMode: "success", resetRuntime: true });
            await agent.configureDemo("normal");
          }
          const inbound = await gateway.injectInbound(
            group.rows[0].gateway_group_id,
            `[${input.scenario}] 请处理这条实验消息`,
            `experiment-user-${created.id.slice(0, 8)}`,
          );
          await pool.query("UPDATE reliability_experiments SET trigger_msg_id = $2 WHERE id = $1", [
            created.id,
            inbound.msgId,
          ]);
        }
      } catch (error) {
        await pool.query(
          "UPDATE reliability_experiments SET status = 'failed', evidence = $2, updated_at = now() WHERE id = $1",
          [created.id, { setupError: error instanceof Error ? error.message : String(error) }],
        );
        throw error;
      }

      return reply.status(202).send({ experimentId: created.id });
    },
  );
}

async function refreshRunning(pool: DbPool, gateway: GatewayClient): Promise<void> {
  const result = await pool.query<ExperimentRow>(
    "SELECT * FROM reliability_experiments WHERE status = 'running' ORDER BY created_at",
  );
  for (const experiment of result.rows) {
    const evidence = await collectEvidence(pool, gateway, experiment);
    const elapsedMs = Date.now() - experiment.created_at.getTime();
    const passed = Boolean(evidence.passed);
    const timedOut = elapsedMs > 25_000;
    await pool.query(
      `UPDATE reliability_experiments SET status = $2, evidence = $3, updated_at = now() WHERE id = $1`,
      [experiment.id, passed ? "passed" : timedOut ? "failed" : "running", evidence],
    );
  }
}

async function collectEvidence(
  pool: DbPool,
  gateway: GatewayClient,
  experiment: ExperimentRow,
): Promise<Record<string, unknown>> {
  if (experiment.scenario === "s4_rate_limit") {
    const message = await pool.query<{ delivery_status: string; fail_code: string | null }>(
      "SELECT delivery_status, fail_code FROM messages WHERE client_msg_id = $1",
      [experiment.client_msg_id],
    );
    const transitions = await pool.query<{ type: string; payload: Record<string, unknown> }>(
      `SELECT type, payload FROM ws_events WHERE created_at >= $1
       AND payload->>'accountId' = $2 ORDER BY seq`,
      [experiment.created_at, experiment.account_id],
    );
    const rateLimitedObserved = transitions.rows.some((row) => row.payload.to === "rate_limited");
    const recoveredOnlineObserved = transitions.rows.some(
      (row) => row.payload.from === "rate_limited" && row.payload.to === "online",
    );
    return {
      passed: message.rows[0]?.delivery_status === "sent" && rateLimitedObserved && recoveredOnlineObserved,
      deliveryStatus: message.rows[0]?.delivery_status ?? "queued",
      failCode: message.rows[0]?.fail_code ?? null,
      rateLimitedObserved,
      recoveredOnlineObserved,
      transitions: transitions.rows.map((row) => row.payload),
    };
  }

  const trigger = await pool.query<{ consumed_run_id: string | null }>(
    "SELECT consumed_run_id FROM agent_trigger_messages WHERE group_id = $1 AND msg_id = $2",
    [experiment.group_id, experiment.trigger_msg_id],
  );
  const runId = trigger.rows[0]?.consumed_run_id;
  if (!runId) return { passed: false, phase: "waiting_for_agent_trigger" };
  const run = await pool.query<{
    status: string;
    end_reason: string | null;
    consecutive_protocol_errors: number;
  }>("SELECT status, end_reason, consecutive_protocol_errors FROM agent_runs WHERE id = $1", [runId]);
  const steps = await pool.query<{
    kind: string;
    name: string | null;
    is_error: boolean;
    error_code: string | null;
    audit_verdict: string | null;
  }>(
    "SELECT kind, name, is_error, error_code, audit_verdict FROM agent_steps WHERE run_id = $1 ORDER BY step_index",
    [runId],
  );
  const base = {
    runId,
    runStatus: run.rows[0]?.status ?? "running",
    endReason: run.rows[0]?.end_reason ?? null,
    steps: steps.rows.map((step) => ({
      kind: step.kind,
      name: step.name,
      isError: step.is_error,
      errorCode: step.error_code,
      auditVerdict: step.audit_verdict,
    })),
  };

  if (experiment.scenario === "s2_duplicate") {
    const timeline = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM messages WHERE group_id = $1 AND msg_id = $2",
      [experiment.group_id, experiment.trigger_msg_id],
    );
    const runCount = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM agent_runs WHERE group_id = $1 AND created_at >= $2",
      [experiment.group_id, experiment.created_at],
    );
    const timelineRows = Number(timeline.rows[0]?.count ?? 0);
    const agentRuns = Number(runCount.rows[0]?.count ?? 0);
    return {
      ...base,
      timelineRows,
      agentRuns,
      passed: run.rows[0]?.status === "finished" && timelineRows === 1 && agentRuns === 1,
    };
  }

  if (experiment.scenario === "s5_agent_idempotency") {
    const keys = await pool.query<{ message_id: string }>(
      "SELECT message_id FROM agent_send_keys WHERE run_id = $1",
      [runId],
    );
    const message = keys.rows[0]
      ? await pool.query<{ client_msg_id: string }>("SELECT client_msg_id FROM messages WHERE id = $1", [
          keys.rows[0].message_id,
        ])
      : undefined;
    const group = await pool.query<{ gateway_group_id: string }>(
      "SELECT gateway_group_id FROM groups WHERE id = $1",
      [experiment.group_id],
    );
    const gatewayCount =
      message?.rows[0]?.client_msg_id && group.rows[0]?.gateway_group_id
        ? (await gateway.debugMessageCount(group.rows[0].gateway_group_id, message.rows[0].client_msg_id))
            .count
        : 0;
    const sendSteps = steps.rows.filter((step) => step.name === "send_message").length;
    const auditedSendSteps = steps.rows.filter(
      (step) => step.name === "send_message" && step.audit_verdict === "pass",
    ).length;
    return {
      ...base,
      sendSteps,
      auditedSendSteps,
      idempotencyKeys: keys.rowCount ?? 0,
      gatewayMessageCount: gatewayCount,
      passed:
        run.rows[0]?.status === "finished" &&
        sendSteps === 2 &&
        auditedSendSteps === 1 &&
        keys.rowCount === 1 &&
        gatewayCount === 1,
    };
  }

  if (experiment.scenario === "s6_agent_protocol") {
    const badJsonRecorded = steps.rows.some(
      (step) => step.kind === "protocol_error" && step.error_code === "BAD_JSON",
    );
    const unknownToolRecorded = steps.rows.some(
      (step) => step.name === "browse_web" && step.error_code === "UNKNOWN_TOOL",
    );
    return {
      ...base,
      badJsonRecorded,
      unknownToolRecorded,
      consecutiveProtocolErrors: run.rows[0]?.consecutive_protocol_errors ?? null,
      passed:
        run.rows[0]?.status === "finished" &&
        badJsonRecorded &&
        unknownToolRecorded &&
        run.rows[0]?.consecutive_protocol_errors === 0,
    };
  }

  const names = steps.rows.map((step) => step.name).filter(Boolean);
  const auditPassed = steps.rows.some(
    (step) => step.name === "send_message" && step.audit_verdict === "pass",
  );
  return {
    ...base,
    toolSequence: names,
    auditPassed,
    passed:
      run.rows[0]?.status === "finished" &&
      names.join(",") === "get_recent_messages,send_message,finish" &&
      auditPassed,
  };
}

function formatExperiment(row: ExperimentRow) {
  return {
    id: row.id,
    scenario: row.scenario,
    groupId: row.group_id,
    status: row.status,
    evidence: row.evidence,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
