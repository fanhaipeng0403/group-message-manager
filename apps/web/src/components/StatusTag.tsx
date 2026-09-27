import { Tag } from "antd";

const colors: Record<string, string> = {
  online: "success",
  idle: "default",
  disconnected: "default",
  rate_limited: "warning",
  suspended: "error",
  session_expired: "error",
  active: "success",
  unreachable: "error",
  running: "processing",
  finished: "success",
  blocked: "error",
  failed: "error",
  cancelled: "default",
  queued: "default",
  accepted: "processing",
  sent: "success",
  unknown: "warning",
};

const labels: Record<string, string> = {
  online: "在线",
  idle: "空闲",
  disconnected: "离线",
  rate_limited: "限流中",
  suspended: "已封禁",
  session_expired: "会话过期",
  active: "运行中",
  unreachable: "不可达",
  running: "执行中",
  finished: "已完成",
  blocked: "已阻断",
  failed: "失败",
  cancelled: "已取消",
  queued: "队列中",
  accepted: "已受理",
  sent: "已送达",
  unknown: "确认中",
  disabled: "未启用",
};

export function StatusTag({ value }: { value: string | null }) {
  return (
    <Tag className="status-tag" color={value ? (colors[value] ?? "default") : "default"}>
      {value ? (labels[value] ?? value) : "—"}
    </Tag>
  );
}
