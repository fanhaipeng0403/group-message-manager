import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Empty, Spin } from "antd";
import { Navigate } from "react-router-dom";
import { client, currentRole } from "../api/client";
import { CreateGroupModal } from "../components/CreateGroupModal";

export function ConversationHomePage() {
  const [createOpen, setCreateOpen] = useState(false);
  const groups = useQuery({ queryKey: ["groups"], queryFn: client.groups });

  if (groups.isLoading) {
    return (
      <div className="conversation-home-loading">
        <Spin size="large" />
        <span>正在打开最近群聊…</span>
      </div>
    );
  }

  const latestGroup = groups.data?.find((group) => group.status === "active") ?? groups.data?.[0];
  if (latestGroup) return <Navigate to={`/groups/${latestGroup.id}`} replace />;

  return (
    <div className="conversation-home-empty">
      <Empty description="还没有群组会话">
        {currentRole() === "admin" && (
          <Button type="primary" onClick={() => setCreateOpen(true)}>
            创建第一个群聊
          </Button>
        )}
      </Empty>
      <CreateGroupModal open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}
