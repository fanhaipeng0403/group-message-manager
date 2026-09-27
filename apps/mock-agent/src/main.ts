import Fastify from "fastify";
import { z } from "zod";

const app = Fastify({ logger: true });
const runs = new Map<string, number>();
type Mode = "normal" | "bad_json_once" | "unknown_tool_once" | "s5_retry_same_key" | "s6_bad_then_unknown";
let mode: Mode = "normal";

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
  runs.clear();
  return { ok: true, mode };
});

app.post("/agent/audit", async () => ({ verdict: "pass", reason: "Mock policy permits this action" }));

app.post("/agent/turn", async (request, reply) => {
  const body = z
    .object({
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
    })
    .parse(request.body);
  const required = ["get_recent_messages", "send_message", "kick_user", "finish"];
  if (body.tools.length !== 4 || !required.every((name) => body.tools.some((tool) => tool.name === name))) {
    return reply.status(400).send({ error: { code: "TOOLS_INVALID" } });
  }
  const count = runs.get(body.runId) ?? 0;
  runs.set(body.runId, count + 1);
  if (mode === "bad_json_once" && count === 0) {
    return reply.type("text/plain").send("```json\n{not valid}\n```");
  }
  if (mode === "s6_bad_then_unknown" && count === 0) {
    return reply.type("text/plain").send("```json\n{not valid}\n```");
  }
  if (mode === "s6_bad_then_unknown" && count === 1) {
    return {
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "unknown-s6", name: "browse_web", input: {} }],
    };
  }
  if (mode === "s6_bad_then_unknown") {
    return {
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "finish-s6",
          name: "finish",
          input: { summary: "Recovered from protocol errors" },
        },
      ],
    };
  }
  if (mode === "s5_retry_same_key" && count < 2) {
    return {
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: `send-s5-${count + 1}`,
          name: "send_message",
          input: { text: "幂等重试消息", idempotency_key: `stable-${body.runId}` },
        },
      ],
    };
  }
  if (mode === "s5_retry_same_key") {
    return {
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "finish-s5",
          name: "finish",
          input: { summary: "Idempotent retry completed" },
        },
      ],
    };
  }
  if (mode === "unknown_tool_once" && count === 0) {
    return {
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "unknown-1", name: "browse_web", input: {} }],
    };
  }
  if (count === 0) {
    return {
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "recent-1", name: "get_recent_messages", input: { limit: 10 } }],
    };
  }
  if (count === 1) {
    return {
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "send-1",
          name: "send_message",
          input: { text: "已收到，我来协助处理。", idempotency_key: `reply-${body.runId}` },
        },
      ],
    };
  }
  return {
    stop_reason: "tool_use",
    content: [
      {
        type: "tool_use",
        id: "finish-1",
        name: "finish",
        input: { summary: "Responded to the latest group message" },
      },
    ],
  };
});

await app.listen({ port: Number(process.env.PORT ?? 4002), host: "0.0.0.0" });
