import { loadEnv } from "./config/env.js";
import { createPool } from "./db/pool.js";
import { assertSchemaCurrent } from "./db/migrations.js";
import { buildApp } from "./app.js";
import { GatewayEventWorker } from "./workers/gateway-events.js";
import { GroupJobWorker } from "./workers/group-jobs.js";
import { OutboxWorker } from "./workers/outbox.js";
import { AgentRunWorker } from "./workers/agent-runs.js";
import { SequenceWorker } from "./workers/sequences.js";

const env = loadEnv();
const pool = createPool(env.DATABASE_URL);

try {
  const schemaVersion = await assertSchemaCurrent(pool);
  const { app, eventHub, gateway, agent, accounts } = await buildApp(env, pool, schemaVersion);
  const gatewayEvents = new GatewayEventWorker(pool, gateway, eventHub, accounts, app.log);
  const groupJobs = new GroupJobWorker(pool, gateway, app.log);
  const outbox = new OutboxWorker(pool, gateway, accounts, eventHub, app.log);
  const agentRuns = new AgentRunWorker(pool, agent, gateway, eventHub, app.log);
  const sequences = new SequenceWorker(pool, eventHub, app.log);

  await app.listen({ port: env.PORT, host: "0.0.0.0" });
  gatewayEvents.start();
  groupJobs.start();
  outbox.start();
  agentRuns.start();
  await sequences.start();

  const shutdown = async () => {
    gatewayEvents.stop();
    groupJobs.stop();
    outbox.stop();
    agentRuns.stop();
    sequences.stop();
    await app.close();
    await pool.end();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  await pool.end();
  process.exitCode = 1;
}
