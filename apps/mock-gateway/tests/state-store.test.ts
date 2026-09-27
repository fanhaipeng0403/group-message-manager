import { describe, expect, it } from "vitest";
import { parseGatewayState, type GatewayState } from "../src/state-store.js";

describe("mock gateway state store", () => {
  it("validates the complete runtime snapshot restored from PostgreSQL", () => {
    const state: GatewayState = {
      version: 1,
      accounts: [["account-1", { platformUserId: "platform-account-1", online: true }]],
      groups: [
        [
          "group-1",
          {
            id: "group-1",
            creatorAccountId: "account-1",
            members: ["platform-account-1"],
            admins: ["platform-account-1"],
          },
        ],
      ],
      messages: [
        [
          "client-message-1",
          [
            {
              groupId: "group-1",
              clientMsgId: "client-message-1",
              msgId: "message-1",
              sentAt: 1,
              accountId: "account-1",
              text: "hello",
            },
          ],
        ],
      ],
      history: [{ eventId: 1, type: "message_sent", clientMsgId: "client-message-1" }],
      nextEventId: 2,
    };

    expect(parseGatewayState(state)).toEqual(state);
  });

  it("rejects a corrupt snapshot instead of silently starting with inconsistent state", () => {
    expect(() => parseGatewayState({ version: 1, accounts: [] })).toThrow();
  });
});
