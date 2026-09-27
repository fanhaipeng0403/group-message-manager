import { describe, expect, it } from "vitest";
import { anthropicMessagesToOpenAi, openAiChoiceToAgentTurn, toolsToOpenAi } from "./anthropic-openai.js";

describe("anthropic-openai bridge", () => {
  it("maps tools to OpenAI function definitions", () => {
    const tools = toolsToOpenAi([
      {
        name: "finish",
        description: "done",
        input_schema: {
          type: "object",
          properties: { summary: { type: "string" } },
          required: ["summary"],
        },
      },
    ]);
    expect(tools[0]?.function.name).toBe("finish");
  });

  it("maps tool_result blocks to OpenAI tool messages", () => {
    const messages = anthropicMessagesToOpenAi(
      [
        { role: "user", content: [{ type: "text", text: '{"groupId":"g1"}' }] },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu_1", name: "get_recent_messages", input: { limit: 5 } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu_1", content: '{"messages":[]}' }],
        },
      ],
      "system",
    );
    expect(messages.some((m) => m.role === "tool" && m.tool_call_id === "tu_1")).toBe(true);
  });

  it("maps a single tool call to Agent turn shape", () => {
    const turn = openAiChoiceToAgentTurn({
      message: {
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "send_message", arguments: '{"text":"hi","idempotency_key":"k1"}' },
          },
        ],
      },
    });
    expect(turn.stop_reason).toBe("tool_use");
    if (turn.stop_reason === "tool_use") {
      expect(turn.content[0].name).toBe("send_message");
      expect(turn.content[0].input.text).toBe("hi");
    }
  });
});
