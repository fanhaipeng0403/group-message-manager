import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getToken } from "../api/client";

const WS_URL = import.meta.env.VITE_WS_URL ?? "ws://localhost:3000/ws";
const WS_SEQ_KEY = "relayops_ws_last_seq";

export function LiveUpdates() {
  const queryClient = useQueryClient();
  useEffect(() => {
    let socket: WebSocket | undefined;
    let retry: number | undefined;
    let stopped = false;
    let lastSeq = Number(localStorage.getItem(WS_SEQ_KEY) ?? 0);
    const connect = () => {
      socket = new WebSocket(WS_URL);
      socket.addEventListener("open", () =>
        socket?.send(
          JSON.stringify({
            type: "auth",
            accessToken: getToken(),
            ...(lastSeq > 0 ? { sinceSeq: lastSeq } : {}),
          }),
        ),
      );
      socket.addEventListener("message", (message) => {
        const event = JSON.parse(String(message.data));
        if (event.success) return;
        if (typeof event.seq === "number") {
          if (event.seq <= lastSeq) return;
          lastSeq = event.seq;
          localStorage.setItem(WS_SEQ_KEY, String(lastSeq));
        }
        if (event.type?.startsWith("account")) void queryClient.invalidateQueries({ queryKey: ["accounts"] });
        if (["message", "agent_run"].includes(event.type)) {
          void queryClient.invalidateQueries({ queryKey: ["group", event.payload?.groupId] });
          void queryClient.invalidateQueries({ queryKey: ["messages", event.payload?.groupId] });
          void queryClient.invalidateQueries({ queryKey: ["agent-runs", event.payload?.groupId] });
        }
      });
      socket.addEventListener("close", () => {
        if (!stopped) retry = window.setTimeout(connect, 1_000);
      });
    };
    connect();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      socket?.close();
    };
  }, [queryClient]);
  return null;
}
