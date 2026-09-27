import type { AccountStatus } from "@platform/contracts";
import type { DbClient, DbPool } from "../../db/pool.js";
import { AppError } from "../../common/errors.js";
import { EventHub, type StoredEvent } from "../../common/event-hub.js";
import { GatewayClient } from "../../integrations/gateway/client.js";
import { canTransition } from "./state-machine.js";

const isTerminal = (status: AccountStatus) => status === "suspended" || status === "session_expired";

export class AccountService {
  constructor(
    private readonly pool: DbPool,
    private readonly events: EventHub,
  ) {}

  async connectThroughGateway(
    accountId: string,
    gateway: GatewayClient,
  ): Promise<{ platformUserId: string }> {
    const client = await this.pool.connect();
    let connectedExternally = false;
    let platformUserId: string | undefined;
    let event: StoredEvent | undefined;
    try {
      await client.query("BEGIN");
      await this.lock(client, accountId);
      const current = await this.currentStatus(client, accountId);
      if (current !== "idle" && current !== "disconnected") {
        throw new AppError(409, "ILLEGAL_TRANSITION", `Cannot connect account in ${current}`);
      }
      const connected = await gateway.connect(accountId);
      connectedExternally = true;
      platformUserId = connected.platformUserId;
      const updated = await client.query(
        `UPDATE accounts SET status = 'online', platform_user_id = $2, version = version + 1, updated_at = now()
         WHERE id = $1 AND status = $3 RETURNING id`,
        [accountId, connected.platformUserId, current],
      );
      if (!updated.rowCount) throw this.casConflict(current);
      event = await this.events.store(
        "account_status_changed",
        { accountId, from: current, to: "online" },
        client,
      );
      await client.query("COMMIT");
    } catch (error) {
      if (connectedExternally) await gateway.disconnect(accountId).catch(() => undefined);
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    if (event) this.events.publish(event);
    return { platformUserId: platformUserId! };
  }

  async operatorTransition(
    accountId: string,
    expectedFrom: AccountStatus,
    to: AccountStatus,
    gateway: GatewayClient,
  ): Promise<void> {
    const repeatedTerminal = expectedFrom === to && isTerminal(to);
    if (!repeatedTerminal && !canTransition(expectedFrom, to)) {
      throw new AppError(
        409,
        "ILLEGAL_TRANSITION",
        `Cannot transition account from ${expectedFrom} to ${to}`,
      );
    }

    const client = await this.pool.connect();
    let disconnectedExternally = false;
    let event: StoredEvent | undefined;
    try {
      await client.query("BEGIN");
      await this.lock(client, accountId);
      const current = await this.currentStatus(client, accountId);
      if (current !== expectedFrom) throw this.casConflict(expectedFrom, current);
      if (repeatedTerminal) {
        await client.query("COMMIT");
        return;
      }
      if (to === "idle" || to === "disconnected") {
        await gateway.disconnect(accountId);
        disconnectedExternally = true;
      }
      event = await this.transitionInTransaction(client, accountId, expectedFrom, to);
      await client.query("COMMIT");
    } catch (error) {
      if (disconnectedExternally) await gateway.connect(accountId).catch(() => undefined);
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    if (event) this.events.publish(event);
  }

  async transition(accountId: string, from: AccountStatus, to: AccountStatus): Promise<void> {
    if (from === to && isTerminal(to)) return;
    if (!canTransition(from, to)) {
      throw new AppError(409, "ILLEGAL_TRANSITION", `Cannot transition account from ${from} to ${to}`);
    }
    const client = await this.pool.connect();
    let event: StoredEvent | undefined;
    try {
      await client.query("BEGIN");
      await this.lock(client, accountId);
      event = await this.transitionInTransaction(client, accountId, from, to);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    if (event) this.events.publish(event);
  }

  private async transitionInTransaction(
    client: DbClient,
    accountId: string,
    from: AccountStatus,
    to: AccountStatus,
  ): Promise<StoredEvent> {
    const terminal = isTerminal(to);
    const updated = await client.query(
      `UPDATE accounts
       SET status = $3, rate_limited_until = CASE WHEN $3 = 'rate_limited' THEN rate_limited_until ELSE NULL END,
           version = version + 1, updated_at = now()
       WHERE id = $1 AND status = $2
       RETURNING id`,
      [accountId, from, to],
    );
    if (!updated.rowCount) {
      const current = await this.currentStatus(client, accountId);
      throw this.casConflict(from, current);
    }

    if (terminal) {
      await client.query("DELETE FROM group_members WHERE account_id = $1", [accountId]);
      await client.query(
        `UPDATE messages SET delivery_status = 'cancelled', fail_code = 'ACCOUNT_TERMINAL', updated_at = now()
         WHERE account_id = $1 AND delivery_status IN ('queued', 'accepted', 'unknown')`,
        [accountId],
      );
      await client.query(
        `UPDATE sequence_run_steps s SET status = 'skipped', sent_at = now()
         FROM messages m
         WHERE s.client_msg_id = m.client_msg_id AND m.account_id = $1
           AND s.status IN ('pending', 'accepted')`,
        [accountId],
      );
    }
    return this.events.store(
      terminal ? "account_terminal" : "account_status_changed",
      terminal ? { accountId, status: to } : { accountId, from, to },
      client,
    );
  }

  private async lock(client: DbClient, accountId: string): Promise<void> {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [accountId]);
  }

  private async currentStatus(client: DbClient, accountId: string): Promise<AccountStatus> {
    const current = await client.query<{ status: AccountStatus }>(
      "SELECT status FROM accounts WHERE id = $1",
      [accountId],
    );
    if (!current.rowCount) throw new AppError(404, "ACCOUNT_NOT_FOUND", "Account not found");
    return current.rows[0]!.status;
  }

  private casConflict(expectedFrom: AccountStatus, actual?: AccountStatus): AppError {
    return new AppError(409, "CAS_CONFLICT", "Account status changed concurrently", {
      expectedFrom,
      ...(actual ? { actual } : {}),
    });
  }
}
