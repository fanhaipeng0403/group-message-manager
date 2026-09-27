import Fastify from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import websocket from "@fastify/websocket";
import type { WebSocket } from "ws";
import type { Env } from "./config/env.js";
import type { DbPool } from "./db/pool.js";
import { registerErrorHandler } from "./common/errors.js";
import { EventHub } from "./common/event-hub.js";
import { GatewayClient } from "./integrations/gateway/client.js";
import { AgentClient } from "./integrations/agent/client.js";
import { AccountService } from "./modules/accounts/service.js";
import { configureAuth } from "./common/auth.js";
import { registerAuthRoutes } from "./modules/auth/routes.js";
import { registerAccountRoutes } from "./modules/accounts/routes.js";
import { registerGroupRoutes } from "./modules/groups/routes.js";
import { registerMessageRoutes } from "./modules/messages/routes.js";
import { registerAgentRoutes } from "./modules/agents/routes.js";
import { registerDemoRoutes } from "./modules/demo/routes.js";
import { registerSequenceRoutes } from "./modules/sequences/routes.js";
import { registerOpenApi } from "./openapi.js";
import { z } from "zod";

export async function buildApp(env: Env, pool: DbPool, schemaVersion: number) {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  await app.register(cors, { origin: env.WEB_ORIGIN, credentials: true });
  await app.register(jwt, { secret: env.JWT_SECRET });
  await app.register(websocket);
  await registerOpenApi(app);
  registerErrorHandler(app);

  const eventHub = new EventHub(pool);
  const gateway = new GatewayClient(env.GATEWAY_URL);
  const agent = new AgentClient(env.AGENT_URL, env.AGENT_TURN_TIMEOUT_MS);
  const accounts = new AccountService(pool, eventHub);
  configureAuth(pool);

  app.get(
    "/api/health",
    {
      schema: {
        operationId: "getHealth",
        tags: ["System"],
        summary: "检查服务和数据库 Schema 版本",
        response: { 200: z.object({ ok: z.literal(true), schemaVersion: z.number().int().nonnegative() }) },
      },
    },
    async () => ({ ok: true as const, schemaVersion }),
  );
  registerAuthRoutes(app, pool);
  registerAccountRoutes(app, pool, gateway, accounts);
  registerGroupRoutes(app, pool);
  registerMessageRoutes(app, pool);
  registerAgentRoutes(app, pool);
  registerSequenceRoutes(app, pool);
  if (env.DEMO_MODE) registerDemoRoutes(app, pool, gateway, agent);

  app.get("/ws", { websocket: true, schema: { hide: true } }, (socket) => {
    let authenticated = false;
    const timeout = setTimeout(() => socket.close(4401, "Authentication timeout"), 5_000);
    socket.once("message", async (raw) => {
      try {
        const input = JSON.parse(raw.toString()) as {
          type?: string;
          accessToken?: string;
          sinceSeq?: number;
        };
        if (input.type !== "auth" || !input.accessToken) throw new Error("Invalid auth frame");
        const user = await app.jwt.verify<{ sessionId: string }>(input.accessToken);
        const session = await pool.query("SELECT 1 FROM auth_sessions WHERE id = $1 AND revoked_at IS NULL", [
          user.sessionId,
        ]);
        if (!session.rowCount) throw new Error("Session revoked");
        authenticated = true;
        clearTimeout(timeout);
        eventHub.addBuffered(socket as WebSocket);
        socket.send(JSON.stringify({ type: "auth", success: true }));
        let replayedThrough = input.sinceSeq ?? 0;
        if (input.sinceSeq !== undefined) {
          while (true) {
            const batch = await eventHub.since(replayedThrough);
            for (const event of batch) {
              socket.send(JSON.stringify(event));
              replayedThrough = event.seq;
            }
            if (batch.length < 1_000) break;
          }
        }
        eventHub.activate(socket as WebSocket, replayedThrough);
      } catch {
        socket.close(4401, "Unauthorized");
      }
    });
    socket.on("close", () => {
      clearTimeout(timeout);
      if (!authenticated) app.log.debug("unauthenticated websocket closed");
    });
  });

  return { app, eventHub, gateway, agent, accounts };
}
