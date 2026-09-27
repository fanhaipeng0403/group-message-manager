import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { App } from "antd";
import { expireSession, getToken, refreshAccessToken } from "../api/client";

const WS_URL = import.meta.env.VITE_WS_URL ?? "ws://localhost:3000/ws";
const WS_SEQ_KEY = "relayops_ws_last_seq";

export function LiveUpdates() {
  const queryClient = useQueryClient();
  const { notification } = App.useApp();
  useEffect(() => {
    let socket: WebSocket | undefined;
    let retry: number | undefined;
    let stopped = false;
    let lastSeq = Number(localStorage.getItem(WS_SEQ_KEY) ?? 0);
    const connect = async (refreshBeforeConnect = false) => {
      let accessToken = getToken();
      if (refreshBeforeConnect) {
        try {
          accessToken = await refreshAccessToken();
        } catch {
          expireSession();
          return;
        }
      }
      if (stopped || !accessToken) return;
      const activeSocket = new WebSocket(WS_URL);
      socket = activeSocket;
      activeSocket.addEventListener("open", () =>
        activeSocket.send(
          JSON.stringify({
            type: "auth",
            accessToken,
            ...(lastSeq > 0 ? { sinceSeq: lastSeq } : {}),
          }),
        ),
      );
      activeSocket.addEventListener("message", (message) => {
        let event: {
          success?: boolean;
          seq?: number;
          type?: string;
          payload?: Record<string, unknown>;
        };
        try {
          event = JSON.parse(String(message.data));
        } catch {
          return;
        }
        if (event.success) return;
        if (typeof event.seq === "number") {
          if (event.seq <= lastSeq) return;
          lastSeq = event.seq;
          localStorage.setItem(WS_SEQ_KEY, String(lastSeq));
        }
        if (event.type?.startsWith("account")) void queryClient.invalidateQueries({ queryKey: ["accounts"] });
        if (event.type === "account_terminal") {
          void queryClient.invalidateQueries({ queryKey: ["groups"] });
          void queryClient.invalidateQueries({ queryKey: ["group"] });
        }
        if (event.type === "inconsistency") {
          notification.error({
            key: `inconsistency-${event.seq ?? "latest"}`,
            message: "检测到外部状态不一致",
            description: String(event.payload?.message ?? "请检查相关账号或群组的最新状态。"),
            duration: 0,
          });
          void queryClient.invalidateQueries();
        }
        if (event.type && ["message", "agent_run"].includes(event.type)) {
          void queryClient.invalidateQueries({ queryKey: ["group", event.payload?.groupId] });
          void queryClient.invalidateQueries({ queryKey: ["messages", event.payload?.groupId] });
          void queryClient.invalidateQueries({ queryKey: ["agent-runs", event.payload?.groupId] });
          if (event.type === "agent_run" && event.payload?.runId) {
            void queryClient.invalidateQueries({ queryKey: ["agent-run", event.payload.runId] });
          }
        }
        if (event.type === "sequence_run") {
          void queryClient.invalidateQueries({ queryKey: ["groups"] });
          void queryClient.invalidateQueries({ queryKey: ["sequence-run", event.payload?.runId] });
        }
      });
      activeSocket.addEventListener("close", (closeEvent) => {
        if (!stopped) retry = window.setTimeout(() => void connect(closeEvent.code === 4401), 1_000);
      });
    };
    void connect();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      socket?.close();
    };
  }, [notification, queryClient]);
  return null;
}
