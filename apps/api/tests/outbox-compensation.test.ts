import { describe, expect, it } from "vitest";
import { GatewayError } from "../src/integrations/gateway/client.js";
import { classifySendFailure, classifyUnknownReconciliation } from "../src/workers/outbox-policy.js";

describe("outbox compensation matrix", () => {
  it("treats an unknown transport failure as ambiguous instead of resending immediately", () => {
    expect(classifySendFailure(new Error("socket closed"))).toEqual({ kind: "mark_unknown" });
  });

  it("preserves the gateway retry window for rate limiting", () => {
    expect(classifySendFailure(new GatewayError(429, "RATE_LIMITED", "slow down", 7))).toEqual({
      kind: "rate_limit",
      retryAfterSeconds: 7,
    });
  });

  it.each([
    ["ACCOUNT_SUSPENDED", "suspended"],
    ["SESSION_EXPIRED", "session_expired"],
  ] as const)("maps %s to terminal cleanup state %s", (code, status) => {
    expect(classifySendFailure(new GatewayError(403, code, code))).toEqual({
      kind: "terminal_account",
      status,
    });
  });

  it("distinguishes transient service failure from permanent business failure", () => {
    expect(classifySendFailure(new GatewayError(503, "GATEWAY_BUSY", "busy"))).toEqual({
      kind: "retry_later",
    });
    expect(classifySendFailure(new GatewayError(400, "MESSAGE_REJECTED", "bad message"))).toEqual({
      kind: "fail_permanently",
      code: "MESSAGE_REJECTED",
    });
  });

  it("marks a forbidden group unreachable rather than retrying forever", () => {
    expect(classifySendFailure(new GatewayError(409, "GROUP_WRITE_FORBIDDEN", "closed"))).toEqual({
      kind: "mark_group_unreachable",
    });
  });

  it("reconciles an account that the gateway reports as offline", () => {
    expect(classifySendFailure(new GatewayError(409, "ACCOUNT_OFFLINE", "offline"))).toEqual({
      kind: "account_offline",
    });
  });

  it("retries an absent ambiguous message exactly once, then fails deterministically", () => {
    const absent = new GatewayError(404, "MESSAGE_NOT_FOUND", "missing");
    expect(classifyUnknownReconciliation(absent, 0)).toBe("retry_once");
    expect(classifyUnknownReconciliation(absent, 1)).toBe("fail_timeout");
  });

  it("defers reconciliation while the lookup endpoint is unavailable", () => {
    expect(classifyUnknownReconciliation(new GatewayError(503, "GATEWAY_BUSY", "busy"), 0)).toBe(
      "defer_reconciliation",
    );
  });
});
