import { describe, expect, it } from "vitest";
import { accountStatuses, type AccountStatus } from "@platform/contracts";
import { allowedTargets, canTransition } from "../src/modules/accounts/state-machine.js";

describe("account state machine", () => {
  it("matches the transition table from the specification", () => {
    const expected: Record<AccountStatus, AccountStatus[]> = {
      idle: ["online", "suspended", "session_expired"],
      online: ["idle", "rate_limited", "disconnected", "suspended", "session_expired"],
      rate_limited: ["online", "disconnected", "suspended", "session_expired"],
      disconnected: ["idle", "online", "suspended", "session_expired"],
      suspended: [],
      session_expired: [],
    };
    for (const from of accountStatuses) expect(allowedTargets(from)).toEqual(expected[from]);
  });

  it("rejects every self transition and every transition out of terminal states", () => {
    for (const status of accountStatuses) expect(canTransition(status, status)).toBe(false);
    for (const to of accountStatuses) {
      expect(canTransition("suspended", to)).toBe(false);
      expect(canTransition("session_expired", to)).toBe(false);
    }
  });
});
