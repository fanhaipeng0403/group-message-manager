import { describe, expect, it } from "vitest";
import {
  classifyAgentDelivery,
  nextProtocolErrorCount,
  serializeToolResult,
} from "../src/workers/agent-runs.js";

describe("Agent tool compensation", () => {
  it("maps terminal-account delivery cancellation to SEND_FAILED", () => {
    expect(
      classifyAgentDelivery({
        clientMsgId: "client-1",
        deliveryStatus: "cancelled",
        failCode: "ACCOUNT_TERMINAL",
        groupStatus: "active",
      }),
    ).toMatchObject({ isError: true, errorCode: "SEND_FAILED" });
  });

  it("maps a forbidden group to GROUP_UNREACHABLE", () => {
    expect(
      classifyAgentDelivery({
        clientMsgId: "client-2",
        deliveryStatus: "failed",
        failCode: "GROUP_WRITE_FORBIDDEN",
        groupStatus: "unreachable",
      }),
    ).toMatchObject({ isError: true, errorCode: "GROUP_UNREACHABLE" });
  });

  it("returns accepted and sent deliveries as normal tool results", () => {
    expect(
      classifyAgentDelivery({
        clientMsgId: "client-3",
        deliveryStatus: "sent",
        failCode: null,
        groupStatus: "active",
      }),
    ).toEqual({ body: { clientMsgId: "client-3", deliveryStatus: "sent" } });
  });

  it("keeps oversized tool results valid JSON and marks them truncated", () => {
    const content = serializeToolResult({ value: "中".repeat(10_000) });
    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(8 * 1024);
    expect(JSON.parse(content)).toMatchObject({ truncated: true });
  });

  it("resets the protocol-error streak after any schema-valid Agent response", () => {
    expect(nextProtocolErrorCount(1, true)).toBe(0);
    expect(nextProtocolErrorCount(2, true)).toBe(0);
    expect(nextProtocolErrorCount(1, false)).toBe(2);
  });
});
