import { describe, expect, it, vi } from "vitest";
import type { DbPool } from "../src/db/pool.js";
import type { EventHub, StoredEvent } from "../src/common/event-hub.js";
import { AppError } from "../src/common/errors.js";
import { AccountService } from "../src/modules/accounts/service.js";
import type { GatewayClient } from "../src/integrations/gateway/client.js";

function harness(updateRowCount: number, currentStatus = "online") {
  const sql: string[] = [];
  const client = {
    query: vi.fn(async (statement: string) => {
      sql.push(statement.replace(/\s+/g, " ").trim());
      if (statement.includes("UPDATE accounts"))
        return { rowCount: updateRowCount, rows: updateRowCount ? [{ id: "account-1" }] : [] };
      if (statement.includes("SELECT status FROM accounts"))
        return { rowCount: 1, rows: [{ status: currentStatus }] };
      return { rowCount: 1, rows: [] };
    }),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn(async () => client) } as unknown as DbPool;
  const event: StoredEvent = { seq: 1, type: "account_terminal", payload: {} };
  const events = {
    store: vi.fn(async () => event),
    publish: vi.fn(),
  } as unknown as EventHub;
  return { service: new AccountService(pool, events), client, events, sql, event };
}

describe("account terminal-state compensation", () => {
  it("removes memberships and cancels unfinished messages in the same transaction", async () => {
    const { service, client, events, sql, event } = harness(1);

    await service.transition("account-1", "online", "suspended");

    expect(sql[0]).toBe("BEGIN");
    expect(sql.some((statement) => statement.startsWith("DELETE FROM group_members"))).toBe(true);
    expect(
      sql.some(
        (statement) =>
          statement.includes("delivery_status = 'cancelled'") && statement.includes("ACCOUNT_TERMINAL"),
      ),
    ).toBe(true);
    expect(
      sql.some(
        (statement) =>
          statement.includes("UPDATE sequence_run_steps") && statement.includes("status = 'skipped'"),
      ),
    ).toBe(true);
    expect(sql.at(-1)).toBe("COMMIT");
    expect(events.store).toHaveBeenCalledWith(
      "account_terminal",
      { accountId: "account-1", status: "suspended" },
      client,
    );
    expect(events.publish).toHaveBeenCalledWith(event);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("silently accepts an account already in the same terminal state", async () => {
    const { service, client, events } = harness(1, "suspended");
    const gateway = { connect: vi.fn(), disconnect: vi.fn() } as unknown as GatewayClient;

    await expect(
      service.operatorTransition("account-1", "suspended", "suspended", gateway),
    ).resolves.toBeUndefined();

    expect(client.query).toHaveBeenCalledWith("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      "account-1",
    ]);
    expect(gateway.connect).not.toHaveBeenCalled();
    expect(gateway.disconnect).not.toHaveBeenCalled();
    expect(events.store).not.toHaveBeenCalled();
  });

  it("rolls back all cleanup work when compare-and-set detects a concurrent change", async () => {
    const { service, client, events, sql } = harness(0, "disconnected");

    await expect(service.transition("account-1", "online", "suspended")).rejects.toMatchObject<AppError>({
      code: "CAS_CONFLICT",
      details: { expectedFrom: "online", actual: "disconnected" },
    });

    expect(sql.at(-1)).toBe("ROLLBACK");
    expect(sql.some((statement) => statement.startsWith("DELETE FROM group_members"))).toBe(false);
    expect(events.store).not.toHaveBeenCalled();
    expect(events.publish).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledOnce();
  });
});
