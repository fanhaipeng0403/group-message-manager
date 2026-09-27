import { GatewayEventSchema, type GatewayEvent, type AccountStatus } from "@platform/contracts";
import type { DbPool } from "../db/pool.js";
import { EventHub } from "../common/event-hub.js";
import { GatewayClient } from "../integrations/gateway/client.js";
import { AccountService } from "../modules/accounts/service.js";
import { sleep } from "../common/sleep.js";

interface Logger {
  info(obj: unknown, message: string): void;
  warn(obj: unknown, message: string): void;
  error(obj: unknown, message: string): void;
}

export class GatewayEventWorker {
  private abortController?: AbortController;

  constructor(
    private readonly pool: DbPool,
    private readonly gateway: GatewayClient,
    private readonly events: EventHub,
    private readonly accounts: AccountService,
    private readonly log: Logger,
  ) {}

  start(): void {
    this.abortController = new AbortController();
    void this.run(this.abortController.signal);
  }

  stop(): void {
    this.abortController?.abort();
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.processBacklog();
        const cursor = await this.lastReceivedEventId();
        await this.consumeStream(cursor, signal);
      } catch (error) {
        if (signal.aborted) return;
        this.log.warn({ err: error }, "gateway event stream disconnected; retrying");
        await sleep(750, signal).catch(() => undefined);
      }
    }
  }

  private async lastReceivedEventId(): Promise<number> {
    const result = await this.pool.query<{ event_id: string }>(
      "SELECT last_contiguous_event_id AS event_id FROM gateway_stream_cursor WHERE singleton = true",
    );
    return Number(result.rows[0]?.event_id ?? 0);
  }

  private async consumeStream(since: number, signal: AbortSignal): Promise<void> {
    const response = await fetch(this.gateway.eventsUrl(since), {
      headers: { accept: "text/event-stream" },
      signal,
    });
    if (!response.ok || !response.body) throw new Error(`SSE request failed: ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) throw new Error("SSE stream ended");
      buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        const event = GatewayEventSchema.parse(JSON.parse(data));
        await this.receive(event);
      }
    }
  }

  private async receive(event: GatewayEvent): Promise<void> {
    const inserted = await this.pool.query(
      `INSERT INTO gateway_events (event_id, event_type, payload)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [event.eventId, event.type, event],
    );
    await this.advanceContiguousCursor();
    if (!inserted.rowCount) return;
    await this.process(event).catch((error) => this.recordFailure(event.eventId, error));
  }

  private async processBacklog(): Promise<void> {
    const result = await this.pool.query<{ payload: unknown }>(
      "SELECT payload FROM gateway_events WHERE processed_at IS NULL ORDER BY event_id ASC LIMIT 100",
    );
    for (const row of result.rows) {
      const event = GatewayEventSchema.parse(row.payload);
      await this.process(event).catch((error) => this.recordFailure(event.eventId, error));
    }
  }

  private async process(event: GatewayEvent): Promise<void> {
    if (event.type === "account_status") {
      const result = await this.pool.query<{ status: AccountStatus }>(
        "SELECT status FROM accounts WHERE id = $1",
        [event.accountId],
      );
      const current = result.rows[0]?.status;
      if (current && current !== event.status && current !== "suspended" && current !== "session_expired") {
        await this.accounts.transition(event.accountId, current, event.status);
      }
      await this.markProcessed(event.eventId);
      return;
    }

    if (event.type === "message_failed" && ["ACCOUNT_SUSPENDED", "SESSION_EXPIRED"].includes(event.code)) {
      const message = await this.pool.query<{ account_id: string; status: AccountStatus }>(
        `SELECT m.account_id, a.status FROM messages m
         JOIN accounts a ON a.id = m.account_id WHERE m.client_msg_id = $1`,
        [event.clientMsgId],
      );
      const row = message.rows[0];
      if (row && row.status !== "suspended" && row.status !== "session_expired") {
        await this.accounts.transition(
          row.account_id,
          row.status,
          event.code === "ACCOUNT_SUSPENDED" ? "suspended" : "session_expired",
        );
      }
      await this.markProcessed(event.eventId);
      return;
    }

    const client = await this.pool.connect();
    let emitted: Awaited<ReturnType<EventHub["store"]>> | undefined;
    try {
      await client.query("BEGIN");
      if (event.type === "message") {
        const group = await client.query<{ id: string }>(
          "SELECT id FROM groups WHERE gateway_group_id = $1",
          [event.groupId],
        );
        if (!group.rows[0]) throw new Error(`Unknown gateway group ${event.groupId}`);
        const own = await client.query<{ id: string }>(
          "SELECT id FROM accounts WHERE platform_user_id = $1",
          [event.senderPlatformUserId],
        );
        await client.query(
          `INSERT INTO messages
             (group_id, msg_id, sender_platform_user_id, is_own, text, sent_at, delivery_status)
           VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0), NULL)
           ON CONFLICT (group_id, msg_id) DO UPDATE
             SET sender_platform_user_id = EXCLUDED.sender_platform_user_id,
                 is_own = messages.is_own OR EXCLUDED.is_own,
                 text = EXCLUDED.text, sent_at = EXCLUDED.sent_at`,
          [
            group.rows[0].id,
            event.msgId,
            event.senderPlatformUserId,
            Boolean(own.rowCount),
            event.text,
            event.sentAt,
          ],
        );
        if (!own.rowCount) {
          await client.query(
            `INSERT INTO agent_trigger_messages (group_id, msg_id)
             SELECT id, $2 FROM groups WHERE id = $1 AND agent_enabled = true AND status = 'active'
             ON CONFLICT DO NOTHING`,
            [group.rows[0].id, event.msgId],
          );
        }
        emitted = await this.events.store(
          "message",
          {
            groupId: group.rows[0].id,
            msgId: event.msgId,
            isOwn: Boolean(own.rowCount),
          },
          client,
        );
      } else if (event.type === "message_sent") {
        const outbound = await client.query<{ id: string; group_id: string }>(
          "SELECT id, group_id FROM messages WHERE client_msg_id = $1 FOR UPDATE",
          [event.clientMsgId],
        );
        const target = outbound.rows[0];
        if (target) {
          await client.query("DELETE FROM messages WHERE group_id = $1 AND msg_id = $2 AND id <> $3", [
            target.group_id,
            event.msgId,
            target.id,
          ]);
        }
        const updated = target
          ? await client.query<{ group_id: string }>(
              `UPDATE messages SET msg_id = $2, sent_at = to_timestamp($3 / 1000.0),
             delivery_status = 'sent', fail_code = NULL, updated_at = now()
           WHERE id = $1 RETURNING group_id`,
              [target.id, event.msgId, event.sentAt],
            )
          : { rows: [] };
        if (updated.rows[0])
          emitted = await this.events.store(
            "message",
            {
              groupId: updated.rows[0].group_id,
              msgId: event.msgId,
              isOwn: true,
            },
            client,
          );
      } else if (event.type === "message_failed") {
        await client.query(
          `UPDATE messages SET delivery_status = 'failed', fail_code = $2, updated_at = now()
           WHERE client_msg_id = $1`,
          [event.clientMsgId, event.code],
        );
        if (event.code === "GROUP_WRITE_FORBIDDEN") {
          await client.query(
            `UPDATE groups SET status = 'unreachable', updated_at = now()
             WHERE id = (SELECT group_id FROM messages WHERE client_msg_id = $1)`,
            [event.clientMsgId],
          );
        }
      } else {
        const group = await client.query<{ id: string }>(
          "SELECT id FROM groups WHERE gateway_group_id = $1",
          [event.groupId],
        );
        if (group.rows[0] && event.type === "member_joined") {
          const account = await client.query<{ id: string }>(
            "SELECT id FROM accounts WHERE platform_user_id = $1",
            [event.platformUserId],
          );
          await client.query(
            `INSERT INTO group_members (group_id, account_id, platform_user_id, role)
             VALUES ($1, $2, $3, 'member') ON CONFLICT DO NOTHING`,
            [group.rows[0].id, account.rows[0]?.id ?? null, event.platformUserId],
          );
        } else if (group.rows[0]) {
          await client.query("DELETE FROM group_members WHERE group_id = $1 AND platform_user_id = $2", [
            group.rows[0].id,
            event.platformUserId,
          ]);
        }
      }
      await client.query(
        "UPDATE gateway_events SET processed_at = now(), attempts = attempts + 1, last_error = NULL WHERE event_id = $1",
        [event.eventId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    if (emitted) this.events.publish(emitted);
  }

  private async markProcessed(eventId: number): Promise<void> {
    await this.pool.query(
      "UPDATE gateway_events SET processed_at = now(), attempts = attempts + 1, last_error = NULL WHERE event_id = $1",
      [eventId],
    );
  }

  private async recordFailure(eventId: number, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.pool.query(
      "UPDATE gateway_events SET attempts = attempts + 1, last_error = $2 WHERE event_id = $1",
      [eventId, message],
    );
    await this.events.emit("inconsistency", {
      kind: "gateway_event_processing",
      ref: String(eventId),
      message,
    });
  }

  private async advanceContiguousCursor(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const cursor = await client.query<{ last_contiguous_event_id: string }>(
        "SELECT last_contiguous_event_id FROM gateway_stream_cursor WHERE singleton = true FOR UPDATE",
      );
      let next = Number(cursor.rows[0]?.last_contiguous_event_id ?? 0) + 1;
      while ((await client.query("SELECT 1 FROM gateway_events WHERE event_id = $1", [next])).rowCount)
        next += 1;
      await client.query(
        "UPDATE gateway_stream_cursor SET last_contiguous_event_id = $1 WHERE singleton = true",
        [next - 1],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
