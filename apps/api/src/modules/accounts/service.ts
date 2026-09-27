import type { AccountStatus } from "@platform/contracts";
import type { DbPool } from "../../db/pool.js";
import { AppError } from "../../common/errors.js";
import { EventHub } from "../../common/event-hub.js";
import { canTransition } from "./state-machine.js";

export class AccountService {
  constructor(
    private readonly pool: DbPool,
    private readonly events: EventHub,
  ) {}

  async connected(accountId: string, from: "idle" | "disconnected", platformUserId: string): Promise<void> {
    const client = await this.pool.connect();
    let event;
    try {
      await client.query("BEGIN");
      const updated = await client.query(
        `UPDATE accounts SET status = 'online', platform_user_id = $2, version = version + 1, updated_at = now()
         WHERE id = $1 AND status = $3 RETURNING id`,
        [accountId, platformUserId, from],
      );
      if (!updated.rowCount)
        throw new AppError(409, "CAS_CONFLICT", "Account status changed concurrently", {
          expectedFrom: from,
        });
      event = await this.events.store("account_status_changed", { accountId, from, to: "online" }, client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    this.events.publish(event);
  }

  async transition(accountId: string, from: AccountStatus, to: AccountStatus): Promise<void> {
    if (!canTransition(from, to)) {
      throw new AppError(409, "ILLEGAL_TRANSITION", `Cannot transition account from ${from} to ${to}`);
    }
    const terminal = to === "suspended" || to === "session_expired";
    const client = await this.pool.connect();
    let storedEvent;
    try {
      await client.query("BEGIN");
      const updated = await client.query(
        `UPDATE accounts
         SET status = $3, rate_limited_until = CASE WHEN $3 = 'rate_limited' THEN rate_limited_until ELSE NULL END,
             version = version + 1, updated_at = now()
         WHERE id = $1 AND status = $2
         RETURNING id`,
        [accountId, from, to],
      );
      if (!updated.rowCount) {
        const current = await client.query<{ status: AccountStatus }>(
          "SELECT status FROM accounts WHERE id = $1",
          [accountId],
        );
        if (!current.rowCount) throw new AppError(404, "ACCOUNT_NOT_FOUND", "Account not found");
        throw new AppError(409, "CAS_CONFLICT", "Account status changed concurrently", {
          expectedFrom: from,
          actual: current.rows[0]!.status,
        });
      }

      if (terminal) {
        await client.query("DELETE FROM group_members WHERE account_id = $1", [accountId]);
        await client.query(
          `UPDATE messages SET delivery_status = 'cancelled', fail_code = 'ACCOUNT_TERMINAL', updated_at = now()
           WHERE account_id = $1 AND delivery_status IN ('queued', 'accepted', 'unknown')`,
          [accountId],
        );
      }
      storedEvent = await this.events.store(
        terminal ? "account_terminal" : "account_status_changed",
        terminal ? { accountId, status: to } : { accountId, from, to },
        client,
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    this.events.publish(storedEvent);
  }
}
