import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { DbPool } from "../src/db/pool.js";
import { EventHub } from "../src/common/event-hub.js";

describe("WebSocket replay handoff", () => {
  it("buffers live events during replay and flushes only events after the replay watermark", () => {
    const hub = new EventHub({} as DbPool);
    const send = vi.fn();
    const socket = {
      OPEN: 1,
      readyState: 1,
      send,
      once: vi.fn(),
    } as unknown as WebSocket;

    hub.addBuffered(socket);
    hub.publish({ seq: 10, type: "message", payload: { id: "already-replayed" } });
    hub.publish({ seq: 11, type: "message", payload: { id: "arrived-during-replay" } });
    expect(send).not.toHaveBeenCalled();

    hub.activate(socket, 10);

    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(send.mock.calls[0]![0])).toMatchObject({ seq: 11 });
  });

  it("isolates a broken socket so publication cannot fail a committed business operation", () => {
    const hub = new EventHub({} as DbPool);
    const socket = {
      OPEN: 1,
      readyState: 1,
      send: vi.fn(() => {
        throw new Error("socket closed concurrently");
      }),
      once: vi.fn(),
    } as unknown as WebSocket;

    hub.addBuffered(socket);
    hub.activate(socket, 0);

    expect(() => hub.publish({ seq: 1, type: "message", payload: {} })).not.toThrow();
  });
});
