import { describe, expect, it } from "vitest";
import { createPool } from "../src/db/pool.js";
import { getSchemaVersion, runMigrations } from "../src/db/migrations.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const databaseIt = testDatabaseUrl ? it : it.skip;

describe("database migrations", () => {
  databaseIt(
    "keeps tool calls unique while allowing three protocol-error steps in one run",
    async () => {
      const pool = createPool(testDatabaseUrl!);
      let groupId: string | undefined;
      try {
        await pool.query("DROP SCHEMA public CASCADE");
        await pool.query("CREATE SCHEMA public");
        await runMigrations(pool);

        expect(await getSchemaVersion(pool)).toBe(7);

        const group = await pool.query<{ id: string }>(
          "INSERT INTO groups (creator_account_id) VALUES ('account-1') RETURNING id",
        );
        groupId = group.rows[0]!.id;
        const run = await pool.query<{ id: string }>(
          "INSERT INTO agent_runs (group_id) VALUES ($1) RETURNING id",
          [groupId],
        );
        const runId = run.rows[0]!.id;

        for (let step = 1; step <= 3; step += 1) {
          await pool.query(
            `INSERT INTO agent_steps
               (run_id, step_index, kind, result_summary, is_error, error_code, raw_response)
             VALUES ($1, $2, 'protocol_error', 'BAD_JSON', true, 'BAD_JSON', '{')`,
            [runId, step],
          );
        }

        await pool.query(
          `INSERT INTO agent_steps (run_id, step_index, kind, tool_use_id, name)
           VALUES ($1, 4, 'tool_use', 'tool-1', 'finish')`,
          [runId],
        );
        await expect(
          pool.query(
            `INSERT INTO agent_steps (run_id, step_index, kind, tool_use_id, name)
             VALUES ($1, 5, 'tool_use', 'tool-1', 'finish')`,
            [runId],
          ),
        ).rejects.toMatchObject({ code: "23505" });

        const steps = await pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM agent_steps WHERE run_id = $1",
          [runId],
        );
        expect(steps.rows[0]?.count).toBe(4);
      } finally {
        if (groupId) await pool.query("DELETE FROM groups WHERE id = $1", [groupId]);
        await pool.end();
      }
    },
    30_000,
  );
});
