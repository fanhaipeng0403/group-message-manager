import { loadEnv } from "../config/env.js";
import { createPool } from "./pool.js";
import { getSchemaVersion, runMigrations } from "./migrations.js";

const env = loadEnv();
const pool = createPool(env.DATABASE_URL);

try {
  await runMigrations(pool);
  console.log(`Database schema migrated to version ${await getSchemaVersion(pool)}`);
} finally {
  await pool.end();
}
