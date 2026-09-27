import { describe, expect, it } from "vitest";
import { AgentTurnResponseSchema } from "./index.js";

describe("Agent turn response boundary", () => {
  it("accepts exactly one tool call", () => {
    expect(
      AgentTurnResponseSchema.parse({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "tool-1", name: "send_message", input: { text: "hello" } }],
      }).stop_reason,
    ).toBe("tool_use");
  });

  it("rejects multiple content blocks so execution stays deterministic", () => {
    expect(() =>
      AgentTurnResponseSchema.parse({
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", id: "tool-1", name: "send_message", input: {} },
          { type: "tool_use", id: "tool-2", name: "finish", input: {} },
        ],
      }),
    ).toThrow();
  });

  it("parses an unknown tool name at the envelope boundary", () => {
    const result = AgentTurnResponseSchema.parse({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tool-1", name: "browse_web", input: {} }],
    });
    expect(result.content[0].type).toBe("tool_use");
    expect(result.content[0]).toHaveProperty("name", "browse_web");
  });
});
