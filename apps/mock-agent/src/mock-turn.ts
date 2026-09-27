import type { FastifyReply } from "fastify";

export type MockMode =
  "normal" | "bad_json_once" | "unknown_tool_once" | "s5_retry_same_key" | "s6_bad_then_unknown";

const runs = new Map<string, number>();

export function resetMockRuns(): void {
  runs.clear();
}

export function handleMockTurn(input: { runId: string; mode: MockMode; reply: FastifyReply }): unknown {
  const count = runs.get(input.runId) ?? 0;
  runs.set(input.runId, count + 1);
  const { mode, runId, reply } = input;

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
          input: { text: "幂等重试消息", idempotency_key: `stable-${runId}` },
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
          input: { text: "已收到，我来协助处理。", idempotency_key: `reply-${runId}` },
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
}
