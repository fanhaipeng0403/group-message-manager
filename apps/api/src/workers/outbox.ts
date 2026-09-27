import type { AccountStatus } from "@platform/contracts";
import type { DbPool } from "../db/pool.js";
import { GatewayClient } from "../integrations/gateway/client.js";
import { AccountService } from "../modules/accounts/service.js";
import { EventHub } from "../common/event-hub.js";
import { classifySendFailure, classifyUnknownReconciliation } from "./outbox-policy.js";

interface OutboxRow {
  id: string;
  group_id: string;
  gateway_group_id: string;
  account_id: string;
  client_msg_id: string;
  text: string;
  retry_count: number;
}

interface Logger {
  error(obj: unknown, message: string): void;
}

export class OutboxWorker {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly pool: DbPool,
    private readonly gateway: GatewayClient,
    private readonly accounts: AccountService,
    private readonly events: EventHub,
    private readonly log: Logger,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), 250);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.recoverInflight();
      await this.reconcileUnknown();
      await this.recoverRateLimits();
      const row = await this.claim();
      if (row) await this.send(row);
    } catch (error) {
      this.log.error({ err: error }, "outbox worker iteration failed");
    } finally {
      this.running = false;
    }
  }

  private async claim(): Promise<OutboxRow | undefined> {
    const result = await this.pool.query<OutboxRow>(
      `UPDATE messages m SET dispatch_state = 'inflight', claimed_at = now(), updated_at = now()
       FROM groups g, accounts a
       WHERE m.id = (
         SELECT m2.id FROM messages m2 JOIN accounts a2 ON a2.id = m2.account_id
         WHERE m2.delivery_status = 'queued' AND m2.dispatch_state = 'pending'
           AND (m2.next_attempt_at IS NULL OR m2.next_attempt_at <= now())
           AND a2.status = 'online'
         ORDER BY m2.created_at FOR UPDATE SKIP LOCKED LIMIT 1
       ) AND g.id = m.group_id AND a.id = m.account_id
       RETURNING m.id, m.group_id, g.gateway_group_id, m.account_id, m.client_msg_id, m.text, m.retry_count`,
    );
    return result.rows[0];
  }

  private async send(row: OutboxRow): Promise<void> {
    try {
      await this.gateway.send(row.gateway_group_id, row.account_id, row.client_msg_id, row.text);
      await this.pool.query(
        `UPDATE messages SET delivery_status = 'accepted', dispatch_state = 'done', claimed_at = NULL, updated_at = now()
         WHERE id = $1`,
        [row.id],
      );
    } catch (error) {
      const compensation = classifySendFailure(error);
      if (compensation.kind === "rate_limit") {
        const retrySeconds = compensation.retryAfterSeconds;
        await this.pool.query(
          `UPDATE accounts SET rate_limited_until = now() + ($2 * interval '1 second') WHERE id = $1`,
          [row.account_id, retrySeconds],
        );
        const status = await this.currentStatus(row.account_id);
        if (status === "online") await this.accounts.transition(row.account_id, "online", "rate_limited");
        await this.pool.query(
          `UPDATE messages SET dispatch_state = 'pending', claimed_at = NULL,
             next_attempt_at = now() + ($2 * interval '1 second'), updated_at = now() WHERE id = $1`,
          [row.id, retrySeconds],
        );
      } else if (compensation.kind === "mark_unknown") {
        await this.markUnknown(row.id);
      } else if (compensation.kind === "terminal_account") {
        const status = await this.currentStatus(row.account_id);
        if (status && status !== "suspended" && status !== "session_expired") {
          await this.accounts.transition(row.account_id, status, compensation.status);
        }
      } else if (compensation.kind === "account_offline") {
        await this.accounts.reconcileGatewayOffline(row.account_id);
        await this.pool.query(
          `UPDATE messages SET dispatch_state = 'pending', claimed_at = NULL,
             next_attempt_at = NULL, updated_at = now() WHERE id = $1`,
          [row.id],
        );
      } else if (compensation.kind === "mark_group_unreachable") {
        await this.pool.query("UPDATE groups SET status = 'unreachable', updated_at = now() WHERE id = $1", [
          row.group_id,
        ]);
        await this.pool.query(
          `UPDATE messages SET delivery_status = 'failed', fail_code = 'GROUP_WRITE_FORBIDDEN', dispatch_state = 'done', updated_at = now()
           WHERE id = $1`,
          [row.id],
        );
        await this.events.emit("message", { groupId: row.group_id, msgId: row.client_msg_id, isOwn: true });
      } else if (compensation.kind === "retry_later") {
        await this.pool.query(
          `UPDATE messages SET dispatch_state = 'pending', claimed_at = NULL,
             next_attempt_at = now() + interval '1 second', updated_at = now() WHERE id = $1`,
          [row.id],
        );
      } else {
        await this.pool.query(
          `UPDATE messages SET delivery_status = 'failed', fail_code = $2, dispatch_state = 'done', updated_at = now()
           WHERE id = $1`,
          [row.id, compensation.code],
        );
      }
    }
  }

  private async markUnknown(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE messages SET delivery_status = 'unknown', dispatch_state = 'done', claimed_at = NULL,
         next_attempt_at = now() + interval '2 seconds', updated_at = now() WHERE id = $1`,
      [id],
    );
  }

  private async reconcileUnknown(): Promise<void> {
    const result = await this.pool.query<OutboxRow>(
      `SELECT m.id, m.group_id, g.gateway_group_id, m.account_id, m.client_msg_id, m.text, m.retry_count
       FROM messages m JOIN groups g ON g.id = m.group_id
       WHERE m.delivery_status = 'unknown' AND m.next_attempt_at <= now()
       ORDER BY m.updated_at FOR UPDATE SKIP LOCKED LIMIT 1`,
    );
    const row = result.rows[0];
    if (!row) return;
    try {
      const found = await this.gateway.findMessage(row.gateway_group_id, row.client_msg_id);
      await this.pool.query(
        `UPDATE messages SET msg_id = $2, sent_at = to_timestamp($3 / 1000.0), delivery_status = 'sent',
           fail_code = NULL, updated_at = now() WHERE id = $1`,
        [row.id, found.msgId, found.sentAt],
      );
    } catch (error) {
      const compensation = classifyUnknownReconciliation(error, row.retry_count);
      if (compensation === "retry_once") {
        await this.pool.query(
          `UPDATE messages SET delivery_status = 'queued', dispatch_state = 'pending', retry_count = retry_count + 1,
             next_attempt_at = now(), updated_at = now() WHERE id = $1`,
          [row.id],
        );
      } else if (compensation === "fail_timeout") {
        await this.pool.query(
          `UPDATE messages SET delivery_status = 'failed', fail_code = 'NETWORK_TIMEOUT', updated_at = now()
           WHERE id = $1`,
          [row.id],
        );
      } else {
        await this.pool.query(
          "UPDATE messages SET next_attempt_at = now() + interval '1 second' WHERE id = $1",
          [row.id],
        );
      }
    }
  }

  private async recoverInflight(): Promise<void> {
    await this.pool.query(
      `UPDATE messages SET delivery_status = 'unknown', dispatch_state = 'done',
         next_attempt_at = now(), updated_at = now()
       WHERE dispatch_state = 'inflight' AND claimed_at < now() - interval '12 seconds'`,
    );
  }

  private async recoverRateLimits(): Promise<void> {
    const result = await this.pool.query<{ id: string }>(
      "SELECT id FROM accounts WHERE status = 'rate_limited' AND rate_limited_until <= now() LIMIT 10",
    );
    for (const row of result.rows) await this.accounts.transition(row.id, "rate_limited", "online");
  }

  private async currentStatus(id: string): Promise<AccountStatus | undefined> {
    const result = await this.pool.query<{ status: AccountStatus }>(
      "SELECT status FROM accounts WHERE id = $1",
      [id],
    );
    return result.rows[0]?.status;
  }
}
