import type { DbPool } from "../db/pool.js";
import { EventHub } from "../common/event-hub.js";

interface Logger {
  error(obj: unknown, message: string): void;
}
interface RunRow {
  id: string;
  group_id: string;
  current_step_index: number;
}

export class SequenceWorker {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly pool: DbPool,
    private readonly events: EventHub,
    private readonly log: Logger,
  ) {}

  async start(): Promise<void> {
    await this.pool.query(
      `UPDATE sequence_run_steps s SET scheduled_at = now() + (s.delay_seconds * interval '1 second')
       FROM sequence_runs r
       WHERE r.id = s.run_id AND r.status = 'running' AND s.step_index = r.current_step_index
         AND s.status = 'pending' AND s.client_msg_id IS NULL AND s.scheduled_at < now()`,
    );
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
      const result = await this.pool.query<RunRow>(
        `UPDATE sequence_runs SET lease_until = now() + interval '10 seconds', updated_at = now()
         WHERE id = (
           SELECT id FROM sequence_runs WHERE status = 'running'
             AND (lease_until IS NULL OR lease_until < now())
           ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
         ) RETURNING id, group_id, current_step_index`,
      );
      if (result.rows[0]) await this.process(result.rows[0]);
    } catch (error) {
      this.log.error({ err: error }, "sequence worker iteration failed");
    } finally {
      this.running = false;
    }
  }

  private async process(run: RunRow): Promise<void> {
    const group = await this.pool.query<{ status: string }>("SELECT status FROM groups WHERE id = $1", [
      run.group_id,
    ]);
    if (group.rows[0]?.status !== "active") {
      await this.finish(run, "stopped");
      return;
    }
    const step = await this.pool.query<{
      step_index: number;
      account_role: "admin" | "member";
      text: string;
      delay_seconds: number;
      status: string;
      scheduled_at: Date | null;
      client_msg_id: string | null;
    }>("SELECT * FROM sequence_run_steps WHERE run_id = $1 AND step_index = $2", [
      run.id,
      run.current_step_index,
    ]);
    const current = step.rows[0];
    if (!current) {
      await this.finish(run, "finished");
      return;
    }

    if (current.client_msg_id) {
      const message = await this.pool.query<{ delivery_status: string; sent_at: Date }>(
        "SELECT delivery_status, sent_at FROM messages WHERE client_msg_id = $1",
        [current.client_msg_id],
      );
      const delivery = message.rows[0];
      if (!delivery || ["queued", "unknown"].includes(delivery.delivery_status)) {
        await this.release(run.id);
        return;
      }
      if (delivery.delivery_status === "accepted") {
        await this.pool.query(
          "UPDATE sequence_run_steps SET status = 'accepted' WHERE run_id = $1 AND step_index = $2",
          [run.id, current.step_index],
        );
        await this.release(run.id);
        return;
      }
      if (delivery.delivery_status === "sent") {
        await this.completeStep(run, current.step_index, "sent", delivery.sent_at);
        return;
      }
      if (delivery.delivery_status === "cancelled") {
        await this.completeStep(run, current.step_index, "skipped", new Date());
        return;
      }
      await this.pool.query(
        "UPDATE sequence_run_steps SET status = 'failed' WHERE run_id = $1 AND step_index = $2",
        [run.id, current.step_index],
      );
      await this.finish(run, "failed");
      return;
    }

    if (!current.scheduled_at || current.scheduled_at.getTime() > Date.now()) {
      await this.release(run.id);
      return;
    }
    const roleWhere =
      current.account_role === "admin" ? "gm.role IN ('admin', 'creator')" : "gm.role = 'member'";
    const account = await this.pool.query<{
      account_id: string;
      platform_user_id: string;
      status: string;
      rate_limited_until: Date | null;
    }>(
      `SELECT gm.account_id, gm.platform_user_id, a.status, a.rate_limited_until
       FROM group_members gm JOIN accounts a ON a.id = gm.account_id
       WHERE gm.group_id = $1 AND ${roleWhere} AND a.status IN ('online', 'rate_limited')
       ORDER BY CASE WHEN gm.role = 'admin' THEN 0 WHEN gm.role = 'creator' THEN 1 ELSE 2 END, gm.account_id LIMIT 1`,
      [run.group_id],
    );
    const sender = account.rows[0];
    if (!sender) {
      await this.completeStep(run, current.step_index, "skipped", new Date());
      return;
    }
    if (sender.status === "rate_limited") {
      await this.pool.query(
        "UPDATE sequence_run_steps SET scheduled_at = GREATEST(now(), $3) WHERE run_id = $1 AND step_index = $2",
        [run.id, current.step_index, sender.rate_limited_until],
      );
      await this.release(run.id);
      return;
    }
    const clientMsgId = crypto.randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO messages
         (group_id, account_id, client_msg_id, sender_platform_user_id, is_own, text, sent_at, delivery_status, next_attempt_at)
         VALUES ($1, $2, $3, $4, true, $5, now(), 'queued', now())`,
        [run.group_id, sender.account_id, clientMsgId, sender.platform_user_id, current.text],
      );
      await client.query(
        "UPDATE sequence_run_steps SET client_msg_id = $3 WHERE run_id = $1 AND step_index = $2 AND client_msg_id IS NULL",
        [run.id, current.step_index, clientMsgId],
      );
      await client.query("UPDATE sequence_runs SET lease_until = NULL, updated_at = now() WHERE id = $1", [
        run.id,
      ]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async completeStep(
    run: RunRow,
    stepIndex: number,
    status: "sent" | "skipped",
    sentAt: Date,
  ): Promise<void> {
    const next = await this.pool.query<{ step_index: number; delay_seconds: number }>(
      "SELECT step_index, delay_seconds FROM sequence_run_steps WHERE run_id = $1 AND step_index > $2 ORDER BY step_index LIMIT 1",
      [run.id, stepIndex],
    );
    const client = await this.pool.connect();
    let event;
    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE sequence_run_steps SET status = $3, sent_at = $4 WHERE run_id = $1 AND step_index = $2",
        [run.id, stepIndex, status, sentAt],
      );
      if (next.rows[0]) {
        await client.query(
          `UPDATE sequence_run_steps SET scheduled_at = $3 + (delay_seconds * interval '1 second')
           WHERE run_id = $1 AND step_index = $2`,
          [run.id, next.rows[0].step_index, sentAt],
        );
        await client.query(
          "UPDATE sequence_runs SET current_step_index = $2, lease_until = NULL, updated_at = now() WHERE id = $1",
          [run.id, next.rows[0].step_index],
        );
        event = await this.events.store(
          "sequence_run",
          {
            runId: run.id,
            groupId: run.group_id,
            status: "running",
            currentStepIndex: next.rows[0].step_index,
          },
          client,
        );
      } else {
        await client.query(
          "UPDATE sequence_runs SET status = 'finished', lease_until = NULL, updated_at = now() WHERE id = $1",
          [run.id],
        );
        event = await this.events.store(
          "sequence_run",
          { runId: run.id, groupId: run.group_id, status: "finished", currentStepIndex: stepIndex },
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

  private async finish(run: RunRow, status: "finished" | "failed" | "stopped"): Promise<void> {
    await this.pool.query(
      "UPDATE sequence_runs SET status = $2, lease_until = NULL, updated_at = now() WHERE id = $1",
      [run.id, status],
    );
    await this.events.emit("sequence_run", {
      runId: run.id,
      groupId: run.group_id,
      status,
      currentStepIndex: run.current_step_index,
    });
  }

  private async release(runId: string): Promise<void> {
    await this.pool.query("UPDATE sequence_runs SET lease_until = NULL, updated_at = now() WHERE id = $1", [
      runId,
    ]);
  }
}
