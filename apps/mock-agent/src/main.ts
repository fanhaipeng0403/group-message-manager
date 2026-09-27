import Fastify from "fastify";
import { z } from "zod";
import { loadConfig, useDashscope } from "./config.js";
import { handleMockTurn, resetMockRuns, type MockMode } from "./mock-turn.js";
import { auditWithQwen, handleQwenTurn } from "./qwen-turn.js";

const app = Fastify({ logger: true });
const runtimeConfig = loadConfig();
let mode: MockMode = "normal";

const TurnBodySchema = z.object({
  runId: z.string(),
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      input_schema: z.record(z.string(), z.unknown()),
    }),
  ),
  messages: z.array(
    z.object({
      role: z.enum(["user", "assistant"]),
      content: z.array(z.record(z.string(), z.unknown())),
    }),
  ),
});

app.post("/__control", async (request) => {
  mode = z
    .object({
      mode: z.enum([
        "normal",
        "bad_json_once",
        "unknown_tool_once",
        "s5_retry_same_key",
        "s6_bad_then_unknown",
      ]),
    })
    .parse(request.body).mode;
  resetMockRuns();
  return {
    ok: true,
    mode,
    brain: useDashscope(runtimeConfig) && mode === "normal" ? "dashscope" : "script",
    model: runtimeConfig.dashscopeModel,
  };
});

app.get("/health", async () => ({
  ok: true,
  brain: useDashscope(runtimeConfig) ? "dashscope" : "script",
  model: runtimeConfig.dashscopeModel,
  demoMode: mode,
}));

app.post("/agent/audit", async (request, reply) => {
  const body = z.object({ text: z.string(), groupId: z.string() }).parse(request.body);
  if (!useDashscope(runtimeConfig)) {
    return { verdict: "pass", reason: "Mock policy permits this action" };
  }
  try {
    return await auditWithQwen(runtimeConfig, body.text, body.groupId);
  } catch (error) {
    app.log.error({ err: error }, "dashscope audit failed");
    return reply
      .status(502)
      .send({ error: { code: "AUDIT_UPSTREAM", message: "Audit provider unavailable" } });
  }
});

app.post("/agent/turn", async (request, reply) => {
  const body = TurnBodySchema.parse(request.body);
  const required = ["get_recent_messages", "send_message", "kick_user", "finish"];
  if (body.tools.length !== 4 || !required.every((name) => body.tools.some((tool) => tool.name === name))) {
    return reply.status(400).send({ error: { code: "TOOLS_INVALID" } });
  }

  const useScript = mode !== "normal" || !useDashscope(runtimeConfig);
  if (useScript) {
    return handleMockTurn({ runId: body.runId, mode, reply });
  }

  try {
    return await handleQwenTurn({
      config: runtimeConfig,
      runId: body.runId,
      tools: body.tools,
      messages: body.messages,
    });
  } catch (error) {
    app.log.error({ err: error, runId: body.runId }, "dashscope turn failed");
    return reply.status(502).send({ error: { code: "LLM_UPSTREAM", message: "Agent provider unavailable" } });
  }
});

app.addHook("onReady", () => {
  app.log.info(
    {
      brain: useDashscope(runtimeConfig) ? "dashscope" : "script",
      model: runtimeConfig.dashscopeModel,
      baseUrl: runtimeConfig.dashscopeBaseUrl,
    },
    "mock-agent started",
  );
});

await app.listen({ port: Number(process.env.PORT ?? 4002), host: "0.0.0.0" });
