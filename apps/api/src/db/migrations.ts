import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { DbPool } from "./pool.js";
import { hashPassword } from "../common/password.js";

const migrationDirectory = fileURLToPath(new URL("../../migrations", import.meta.url));

export async function getMigrationFiles(): Promise<string[]> {
  return (await readdir(migrationDirectory)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
}

export async function getSchemaVersion(pool: DbPool): Promise<number> {
  const exists = await pool.query<{ exists: boolean }>(
    "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists",
  );
  if (!exists.rows[0]?.exists) return 0;
  const result = await pool.query<{ version: number }>(
    "SELECT COALESCE(MAX(version), 0)::int AS version FROM schema_migrations",
  );
  return result.rows[0]?.version ?? 0;
}

export async function expectedSchemaVersion(): Promise<number> {
  const files = await getMigrationFiles();
  const latest = files.at(-1);
  return latest ? Number.parseInt(latest.split("_", 1)[0] ?? "0", 10) : 0;
}

export async function assertSchemaCurrent(pool: DbPool): Promise<number> {
  const [actual, expected] = await Promise.all([getSchemaVersion(pool), expectedSchemaVersion()]);
  if (actual < expected) {
    throw new Error(
      `Database schema is outdated (current=${actual}, expected=${expected}). Run: pnpm db:migrate`,
    );
  }
  return actual;
}

export async function runMigrations(pool: DbPool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version integer PRIMARY KEY,
      name text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  for (const file of await getMigrationFiles()) {
    const version = Number.parseInt(file.split("_", 1)[0] ?? "0", 10);
    const alreadyApplied = await pool.query("SELECT 1 FROM schema_migrations WHERE version = $1", [version]);
    if (alreadyApplied.rowCount) continue;

    const sql = await readFile(path.join(migrationDirectory, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(718203041)");
      const raced = await client.query("SELECT 1 FROM schema_migrations WHERE version = $1", [version]);
      if (!raced.rowCount) {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version, name) VALUES ($1, $2)", [version, file]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  for (const [username, role] of [
    ["admin", "admin"],
    ["viewer", "viewer"],
  ] as const) {
    const exists = await pool.query("SELECT 1 FROM users WHERE username = $1", [username]);
    if (!exists.rowCount) {
      await pool.query("INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3)", [
        username,
        await hashPassword(username),
        role,
      ]);
    }
  }
}
