import { AgentTurnResponseSchema } from "@platform/contracts";
import { z } from "zod";
import type { DbPool } from "../db/pool.js";
import { EventHub } from "../common/event-hub.js";
import { AgentClient } from "../integrations/agent/client.js";
import { GatewayClient, GatewayError } from "../integrations/gateway/client.js";
import { sleep } from "../common/sleep.js";

const RecentInput = z.object({ limit: z.number() });
const SendInput = z.object({ text: z.string().min(1), idempotency_key: z.string().min(1) });
const KickInput = z.object({ platform_user_id: z.string().min(1), reason: z.string() });
const FinishInput = z.object({ summary: z.string() });

const tools = [
  {
    name: "get_recent_messages",
    description: "Read recent group messages",
    input_schema: {
      type: "object",
      properties: { limit: { type: "number" } },
      required: ["limit"],
      additionalProperties: false,
    },
  },
  {
    name: "send_message",
    description: "Send a message to the group",
    input_schema: {
      type: "object",
      properties: { text: { type: "string" }, idempotency_key: { type: "string" } },
      required: ["text", "idempotency_key"],
      additionalProperties: false,
    },
  },
  {
    name: "kick_user",
    description: "Remove a user from the group",
    input_schema: {
      type: "object",
      properties: { platform_user_id: { type: "string" }, reason: { type: "string" } },
      required: ["platform_user_id", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "finish",
    description: "Finish the current run",
    input_schema: {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
      additionalProperties: false,
    },
  },
];

interface RunRow {
  id: string;
  group_id: string;
  conversation: Array<Record<string, unknown>>;
  step_count: number;
  consecutive_protocol_errors: number;
  active_elapsed_ms: string;
}
interface Logger {
  error(obj: unknown, message: string): void;
}

interface ToolExecutionResult {
  body: Record<string, unknown>;
  isError?: boolean;
  errorCode?: string;
  auditVerdict?: string;
  finish?: string;
}

export function serializeToolResult(body: Record<string, unknown>, maxBytes = 8 * 1024): string {
  const serialized = JSON.stringify(body);
  if (Buffer.byteLength(serialized, "utf8") <= maxBytes) return serialized;
  let preview = serialized.slice(0, Math.max(0, maxBytes - 80));
  let result = JSON.stringify({ truncated: true, preview });
  while (Buffer.byteLength(result, "utf8") > maxBytes && preview.length) {
    preview = preview.slice(0, Math.max(0, preview.length - 128));
    result = JSON.stringify({ truncated: true, preview });
  }
  return result;
}

export function classifyAgentDelivery(input: {
  clientMsgId: string;
  deliveryStatus: string;
  failCode: string | null;
  groupStatus: string;
}): ToolExecutionResult {
  if (input.deliveryStatus === "failed" || input.deliveryStatus === "cancelled") {
    const code =
      input.groupStatus === "unreachable" || input.failCode === "GROUP_WRITE_FORBIDDEN"
        ? "GROUP_UNREACHABLE"
        : "SEND_FAILED";
    return { body: { code, message: input.failCode ?? code }, isError: true, errorCode: code };
  }
  return { body: { clientMsgId: input.clientMsgId, deliveryStatus: input.deliveryStatus } };
}

export class AgentRunWorker {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly pool: DbPool,
    private readonly agent: AgentClient,
    private readonly gateway: GatewayClient,
    private readonly events: EventHub,
    private readonly log: Logger,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), 300);
    void this.tick();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.createPendingRun();
      const run = await this.claimRun();
      if (run) await this.step(run);
    } catch (error) {
      this.log.error({ err: error }, "agent worker iteration failed");
    } finally {
      this.running = false;
    }
  }

  private async createPendingRun(): Promise<void> {
    const client = await this.pool.connect();
    let event;
    try {
      await client.query("BEGIN");
      const group = await client.query<{ group_id: string }>(
        `SELECT t.group_id FROM agent_trigger_messages t
         JOIN groups g ON g.id = t.group_id
         WHERE t.consumed_run_id IS NULL AND g.agent_enabled = true AND g.status = 'active'
           AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.group_id = t.group_id AND r.status = 'running')
         ORDER BY t.created_at FOR UPDATE SKIP LOCKED LIMIT 1`,
      );
      if (!group.rows[0]) {
        await client.query("ROLLBACK");
        return;
      }
      const messages = await client.query<{
        msg_id: string;
        sender_platform_user_id: string;
        text: string;
        sent_at: Date;
      }>(
        `SELECT m.msg_id, m.sender_platform_user_id, m.text, m.sent_at
         FROM agent_trigger_messages t JOIN messages m ON m.group_id = t.group_id AND m.msg_id = t.msg_id
         WHERE t.group_id = $1 AND t.consumed_run_id IS NULL ORDER BY m.sent_at ASC, m.id ASC`,
        [group.rows[0].group_id],
      );
      const ownIds = await client.query<{ platform_user_id: string }>(
        "SELECT platform_user_id FROM group_members WHERE group_id = $1 AND account_id IS NOT NULL",
        [group.rows[0].group_id],
      );
      const policy = await client.query<{ auto_kick_enabled: boolean }>(
        "SELECT auto_kick_enabled FROM groups WHERE id = $1",
        [group.rows[0].group_id],
      );
      const triggerMessages = messages.rows.map((message) => ({
        msgId: message.msg_id,
        senderPlatformUserId: message.sender_platform_user_id,
        text: message.text,
        sentAt: message.sent_at.getTime(),
      }));
      const context = JSON.stringify({
        groupId: group.rows[0].group_id,
        triggerMessages,
        policy: { autoKickEnabled: policy.rows[0]?.auto_kick_enabled ?? false },
        ownPlatformUserIds: ownIds.rows.map((row) => row.platform_user_id),
      });
      const created = await client.query<{ id: string }>(
        `INSERT INTO agent_runs (group_id, trigger_messages, conversation)
         VALUES ($1, $2, $3) RETURNING id`,
        [
          group.rows[0].group_id,
          JSON.stringify(triggerMessages),
          JSON.stringify([{ role: "user", content: [{ type: "text", text: context }] }]),
        ],
      );
      await client.query(
        "UPDATE agent_trigger_messages SET consumed_run_id = $2 WHERE group_id = $1 AND consumed_run_id IS NULL",
        [group.rows[0].group_id, created.rows[0]!.id],
      );
      event = await this.events.store(
        "agent_run",
        {
          runId: created.rows[0]!.id,
          groupId: group.rows[0].group_id,
          status: "running",
          endReason: null,
        },
        client,
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    if (event) this.events.publish(event);
  }

  private async claimRun(): Promise<RunRow | undefined> {
    const result = await this.pool.query<RunRow>(
      `UPDATE agent_runs SET lease_until = now() + interval '20 seconds', resumed_at = now(), updated_at = now()
       WHERE id = (
         SELECT id FROM agent_runs WHERE status = 'running' AND (lease_until IS NULL OR lease_until < now())
         ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
       ) RETURNING id, group_id, conversation, step_count, consecutive_protocol_errors, active_elapsed_ms`,
    );
    return result.rows[0];
  }

  private async step(run: RunRow): Promise<void> {
    if (run.step_count >= 12) {
      await this.finish(run, "failed", "budget_exhausted");
      return;
    }
    if (Number(run.active_elapsed_ms) >= 60_000) {
      await this.finish(run, "failed", "wall_clock");
      return;
    }
    const group = await this.pool.query<{ gateway_group_id: string; agent_enabled: boolean; status: string }>(
      "SELECT gateway_group_id, agent_enabled, status FROM groups WHERE id = $1",
      [run.group_id],
    );
    if (!group.rows[0]?.agent_enabled || group.rows[0]?.status !== "active") {
      await this.finish(run, "cancelled", "cancelled");
      return;
    }

    const started = Date.now();
    let raw = "";
    let parsed: z.infer<typeof AgentTurnResponseSchema>;
    try {
      const response = await this.agent.turn({ runId: run.id, tools, messages: run.conversation });
      raw = response.raw.slice(0, 2048);
      if (response.status < 200 || response.status >= 300) throw new Error("BAD_JSON");
      parsed = AgentTurnResponseSchema.parse(JSON.parse(response.raw));
    } catch (error) {
      const code =
        error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
          ? "TURN_TIMEOUT"
          : "BAD_JSON";
      await this.protocolError(run, code, raw, Date.now() - started);
      return;
    }

    if (parsed.stop_reason === "end_turn") {
      await this.recordFinal(run, parsed.content[0].text, raw, Date.now() - started);
      return;
    }
    const call = parsed.content[0];
    const duplicate = await this.pool.query(
      "SELECT 1 FROM agent_steps WHERE run_id = $1 AND tool_use_id = $2",
      [run.id, call.id],
    );
    if (duplicate.rowCount) {
      await this.protocolError(run, "DUPLICATE_TOOL_USE_ID", raw, Date.now() - started);
      return;
    }

    let result: ToolExecutionResult;
    try {
      result = await this.executeTool(run, group.rows[0].gateway_group_id, call.id, call.name, call.input);
    } catch (error) {
      result = {
        body: { code: "INVALID_INPUT", message: error instanceof Error ? error.message : String(error) },
        isError: true,
        errorCode: "INVALID_INPUT",
      };
    }
    await this.recordTool(run, call, raw, result, Date.now() - started);
  }

  private async executeTool(
    run: RunRow,
    gatewayGroupId: string,
    toolUseId: string,
    name: string,
    input: Record<string, unknown>,
  ): Promise<ToolExecutionResult> {
    if (name === "get_recent_messages") {
      const value = RecentInput.parse(input);
      const limit = Math.min(Math.max(Math.floor(value.limit), 1), 50);
      const rows = await this.pool.query<{
        msg_id: string;
        sender_platform_user_id: string;
        is_own: boolean;
        text: string;
        sent_at: Date;
      }>(
        `SELECT msg_id, sender_platform_user_id, is_own, text, sent_at FROM messages
         WHERE group_id = $1 AND msg_id IS NOT NULL ORDER BY sent_at DESC, id DESC LIMIT $2`,
        [run.group_id, limit],
      );
      let truncated = false;
      const messages = rows.rows.reverse().map((row) => {
        if (row.text.length > 500) truncated = true;
        return {
          msgId: row.msg_id,
          senderPlatformUserId: row.sender_platform_user_id,
          isOwn: row.is_own,
          text: row.text.slice(0, 500),
          sentAt: row.sent_at.getTime(),
        };
      });
      return { body: { messages, truncated } };
    }
    if (name === "send_message") {
      const value = SendInput.parse(input);
      const existing = await this.pool.query<{ message_id: string }>(
        "SELECT message_id FROM agent_send_keys WHERE run_id = $1 AND idempotency_key = $2",
        [run.id, value.idempotency_key],
      );
      if (existing.rows[0]) return this.deliveryToolResult(existing.rows[0].message_id);
      const audit = await this.audit(value.text, run.group_id);
      if (audit !== "pass")
        return {
          body: {
            code: "AUDIT_REJECTED",
            message:
              audit === "blocked"
                ? "Audit was unavailable after three attempts"
                : "Message rejected by audit",
          },
          isError: true,
          errorCode: "AUDIT_REJECTED",
          auditVerdict: audit,
        };
      const sender = await this.pool.query<{ account_id: string; platform_user_id: string }>(
        `SELECT gm.account_id, gm.platform_user_id FROM group_members gm JOIN accounts a ON a.id = gm.account_id
         WHERE gm.group_id = $1 AND a.status = 'online' ORDER BY CASE gm.role WHEN 'admin' THEN 0 WHEN 'creator' THEN 1 ELSE 2 END, gm.account_id LIMIT 1`,
        [run.group_id],
      );
      if (!sender.rows[0]?.account_id)
        return {
          body: { code: "NO_AVAILABLE_ACCOUNT", message: "No online group account" },
          isError: true,
          errorCode: "NO_AVAILABLE_ACCOUNT",
          auditVerdict: audit,
        };
      const client = await this.pool.connect();
      let messageId: string;
      try {
        await client.query("BEGIN");
        const message = await client.query<{ id: string }>(
          `INSERT INTO messages
           (group_id, account_id, client_msg_id, sender_platform_user_id, is_own, text, sent_at, delivery_status, next_attempt_at)
           VALUES ($1, $2, $3, $4, true, $5, now(), 'queued', now()) RETURNING id`,
          [
            run.group_id,
            sender.rows[0].account_id,
            crypto.randomUUID(),
            sender.rows[0].platform_user_id,
            value.text,
          ],
        );
        messageId = message.rows[0]!.id;
        await client.query(
          "INSERT INTO agent_send_keys (run_id, idempotency_key, message_id) VALUES ($1, $2, $3)",
          [run.id, value.idempotency_key, messageId],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const delivery = await this.deliveryToolResult(messageId);
        if (delivery.body.deliveryStatus !== "queued" && delivery.body.deliveryStatus !== "unknown") {
          return { ...delivery, auditVerdict: audit };
        }
        await sleep(100);
      }
      return {
        body: { code: "SEND_TIMEOUT", message: "Delivery was not confirmed within 5 seconds" },
        isError: true,
        errorCode: "SEND_TIMEOUT",
        auditVerdict: audit,
      };
    }
    if (name === "kick_user") {
      const value = KickInput.parse(input);
      const existingEffect = await this.pool.query<{ status: string; error_code: string | null }>(
        "SELECT status, error_code FROM agent_kick_effects WHERE run_id = $1 AND tool_use_id = $2",
        [run.id, toolUseId],
      );
      if (existingEffect.rows[0]?.status === "succeeded") return { body: { kicked: true } };
      if (existingEffect.rows[0]?.status === "failed") {
        const code = existingEffect.rows[0].error_code ?? "GROUP_UNREACHABLE";
        return { body: { code, message: code }, isError: true, errorCode: code };
      }
      if (existingEffect.rows[0]?.status === "pending") {
        const members = await this.gateway.members(gatewayGroupId);
        if (!members.some((member) => member.platformUserId === value.platform_user_id)) {
          await this.markKickEffect(run.id, toolUseId, "succeeded");
          return { body: { kicked: true } };
        }
      }
      const policy = await this.pool.query<{ auto_kick_enabled: boolean }>(
        "SELECT auto_kick_enabled FROM groups WHERE id = $1",
        [run.group_id],
      );
      if (!policy.rows[0]?.auto_kick_enabled)
        return {
          body: { code: "POLICY_DENIED", message: "Automatic kicking is disabled" },
          isError: true,
          errorCode: "POLICY_DENIED",
        };
      const auditText = JSON.stringify({
        action: "kick",
        platform_user_id: value.platform_user_id,
        reason: value.reason,
      });
      const audit = await this.audit(auditText, run.group_id);
      if (audit !== "pass")
        return {
          body: {
            code: "AUDIT_REJECTED",
            message:
              audit === "blocked" ? "Audit was unavailable after three attempts" : "Kick rejected by audit",
          },
          isError: true,
          errorCode: "AUDIT_REJECTED",
          auditVerdict: audit,
        };
      const actor = await this.pool.query<{ account_id: string }>(
        `SELECT gm.account_id FROM group_members gm JOIN accounts a ON a.id = gm.account_id
         WHERE gm.group_id = $1 AND gm.role IN ('creator', 'admin') AND a.status = 'online'
         ORDER BY CASE gm.role WHEN 'creator' THEN 0 ELSE 1 END LIMIT 1`,
        [run.group_id],
      );
      if (!actor.rows[0]?.account_id)
        return {
          body: { code: "NO_AVAILABLE_ACCOUNT", message: "No authorized account" },
          isError: true,
          errorCode: "NO_AVAILABLE_ACCOUNT",
          auditVerdict: audit,
        };
      await this.pool.query(
        `INSERT INTO agent_kick_effects (run_id, tool_use_id, group_id, target_platform_user_id, status)
         VALUES ($1, $2, $3, $4, 'pending') ON CONFLICT (run_id, tool_use_id) DO NOTHING`,
        [run.id, toolUseId, run.group_id, value.platform_user_id],
      );
      try {
        await this.gateway.kick(gatewayGroupId, actor.rows[0].account_id, value.platform_user_id);
      } catch (error) {
        const code = error instanceof GatewayError ? error.code : "NO_PERMISSION";
        if (code === "NETWORK_TIMEOUT") {
          await sleep(2_100);
          const members = await this.gateway.members(gatewayGroupId);
          if (!members.some((member) => member.platformUserId === value.platform_user_id)) {
            await this.markKickEffect(run.id, toolUseId, "succeeded");
            return { body: { kicked: true }, auditVerdict: audit };
          }
          try {
            await this.gateway.kick(gatewayGroupId, actor.rows[0].account_id, value.platform_user_id);
            await this.markKickEffect(run.id, toolUseId, "succeeded");
            return { body: { kicked: true }, auditVerdict: audit };
          } catch {
            await this.markKickEffect(run.id, toolUseId, "failed", "GROUP_UNREACHABLE");
            return {
              body: { code: "GROUP_UNREACHABLE", message: "Kick outcome could not be confirmed" },
              isError: true,
              errorCode: "GROUP_UNREACHABLE",
              auditVerdict: audit,
            };
          }
        }
        await this.markKickEffect(run.id, toolUseId, "failed", code);
        return { body: { code, message: code }, isError: true, errorCode: code, auditVerdict: audit };
      }
      await this.markKickEffect(run.id, toolUseId, "succeeded");
      return { body: { kicked: true }, auditVerdict: audit };
    }
    if (name === "finish") {
      const value = FinishInput.parse(input);
      return { body: { ok: true }, finish: value.summary };
    }
    return {
      body: { code: "UNKNOWN_TOOL", message: `Unknown tool: ${name}` },
      isError: true,
      errorCode: "UNKNOWN_TOOL",
    };
  }

  private async audit(text: string, groupId: string): Promise<"pass" | "fail" | "blocked"> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.agent.audit(text, groupId);
      } catch {
        if (attempt < 2) await sleep(100);
      }
    }
    return "blocked";
  }

  private async deliveryToolResult(messageId: string): Promise<ToolExecutionResult> {
    const result = await this.pool.query<{
      client_msg_id: string;
      delivery_status: string;
      fail_code: string | null;
      group_status: string;
    }>(
      `SELECT m.client_msg_id, m.delivery_status, m.fail_code, g.status AS group_status
       FROM messages m JOIN groups g ON g.id = m.group_id WHERE m.id = $1`,
      [messageId],
    );
    const row = result.rows[0]!;
    return classifyAgentDelivery({
      clientMsgId: row.client_msg_id,
      deliveryStatus: row.delivery_status,
      failCode: row.fail_code,
      groupStatus: row.group_status,
    });
  }

  private async markKickEffect(
    runId: string,
    toolUseId: string,
    status: "succeeded" | "failed",
    errorCode: string | null = null,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE agent_kick_effects SET status = $3, error_code = $4, updated_at = now()
       WHERE run_id = $1 AND tool_use_id = $2`,
      [runId, toolUseId, status, errorCode],
    );
  }

  private async recordTool(
    run: RunRow,
    call: { id: string; name: string; input: Record<string, unknown> },
    raw: string,
    result: ToolExecutionResult,
    elapsed: number,
  ): Promise<void> {
    const client = await this.pool.connect();
    let event;
    try {
      await client.query("BEGIN");
      const assistant = {
        role: "assistant",
        content: [{ type: "tool_use", id: call.id, name: call.name, input: call.input }],
      };
      const toolResult = {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: call.id,
            content: serializeToolResult(result.body),
            ...(result.isError ? { is_error: true } : {}),
          },
        ],
      };
      const nextConversation = [...run.conversation, assistant, toolResult];
      await client.query(
        `INSERT INTO agent_steps
         (run_id, step_index, kind, tool_use_id, name, input, result_summary, is_error, error_code, audit_verdict, raw_response)
         VALUES ($1, $2, 'tool_use', $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          run.id,
          run.step_count + 1,
          call.id,
          call.name,
          call.input,
          JSON.stringify(result.body).slice(0, 200),
          Boolean(result.isError),
          result.errorCode ?? null,
          result.auditVerdict ?? null,
          raw,
        ],
      );
      if (result.auditVerdict === "blocked") {
        await client.query(
          `UPDATE agent_runs SET status = 'blocked', end_reason = 'audit_blocked', conversation = $2,
             step_count = step_count + 1, active_elapsed_ms = active_elapsed_ms + $3,
             lease_until = NULL, updated_at = now() WHERE id = $1`,
          [run.id, JSON.stringify(nextConversation), elapsed],
        );
        event = await this.events.store(
          "agent_run",
          { runId: run.id, groupId: run.group_id, status: "blocked", endReason: "audit_blocked" },
          client,
        );
      } else if (result.finish) {
        await client.query(
          `UPDATE agent_runs SET status = 'finished', end_reason = 'final', summary = $2, conversation = $3,
             step_count = step_count + 1, active_elapsed_ms = active_elapsed_ms + $4, lease_until = NULL, updated_at = now() WHERE id = $1`,
          [run.id, result.finish, JSON.stringify(nextConversation), elapsed],
        );
        event = await this.events.store(
          "agent_run",
          { runId: run.id, groupId: run.group_id, status: "finished", endReason: "final" },
          client,
        );
      } else {
        const protocolResult = result.errorCode === "UNKNOWN_TOOL" || result.errorCode === "INVALID_INPUT";
        const protocolCount = protocolResult ? run.consecutive_protocol_errors + 1 : 0;
        const protocolFailed = protocolCount >= 3;
        await client.query(
          `UPDATE agent_runs SET conversation = $2, step_count = step_count + 1,
             active_elapsed_ms = active_elapsed_ms + $3, lease_until = NULL,
             consecutive_protocol_errors = $4,
             status = CASE WHEN $5 THEN 'failed' ELSE status END,
             end_reason = CASE WHEN $5 THEN 'protocol_errors' ELSE end_reason END,
             updated_at = now() WHERE id = $1`,
          [run.id, JSON.stringify(nextConversation), elapsed, protocolCount, protocolFailed],
        );
        if (protocolFailed)
          event = await this.events.store(
            "agent_run",
            {
              runId: run.id,
              groupId: run.group_id,
              status: "failed",
              endReason: "protocol_errors",
            },
            client,
          );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    if (event) this.events.publish(event);
  }

  private async protocolError(run: RunRow, code: string, raw: string, elapsed: number): Promise<void> {
    const count = run.consecutive_protocol_errors + 1;
    const step = run.step_count + 1;
    const shouldEnd = count >= 3 || step >= 12;
    const conversation = [
      ...run.conversation,
      {
        role: "user",
        content: [{ type: "text", text: `PROTOCOL_ERROR ${code}: Agent response was invalid` }],
      },
    ];
    await this.pool.query(
      `INSERT INTO agent_steps (run_id, step_index, kind, result_summary, is_error, error_code, raw_response)
       VALUES ($1, $2, 'protocol_error', $3, true, $4, $5)`,
      [run.id, step, code, code, raw],
    );
    await this.pool.query(
      `UPDATE agent_runs SET conversation = $2, step_count = $3, consecutive_protocol_errors = $4,
         active_elapsed_ms = active_elapsed_ms + $5, lease_until = NULL,
         status = CASE WHEN $6 THEN 'failed' ELSE status END,
         end_reason = CASE WHEN $6 THEN 'protocol_errors' ELSE end_reason END, updated_at = now() WHERE id = $1`,
      [run.id, JSON.stringify(conversation), step, count, elapsed, shouldEnd],
    );
    if (shouldEnd)
      await this.events.emit("agent_run", {
        runId: run.id,
        groupId: run.group_id,
        status: "failed",
        endReason: "protocol_errors",
      });
  }

  private async recordFinal(run: RunRow, summary: string, raw: string, elapsed: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_steps (run_id, step_index, kind, result_summary, raw_response)
       VALUES ($1, $2, 'final', $3, $4)`,
      [run.id, run.step_count + 1, summary.slice(0, 200), raw],
    );
    await this.pool.query(
      `UPDATE agent_runs SET status = 'finished', end_reason = 'final', summary = $2, step_count = step_count + 1,
       active_elapsed_ms = active_elapsed_ms + $3, lease_until = NULL, updated_at = now() WHERE id = $1`,
      [run.id, summary, elapsed],
    );
    await this.events.emit("agent_run", {
      runId: run.id,
      groupId: run.group_id,
      status: "finished",
      endReason: "final",
    });
  }

  private async finish(
    run: RunRow,
    status: "failed" | "blocked" | "cancelled",
    reason: string,
  ): Promise<void> {
    await this.pool.query(
      "UPDATE agent_runs SET status = $2, end_reason = $3, lease_until = NULL, updated_at = now() WHERE id = $1",
      [run.id, status, reason],
    );
    await this.events.emit("agent_run", { runId: run.id, groupId: run.group_id, status, endReason: reason });
  }
}
