import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Avatar, Button, Card, Col, Input, Modal, Row, Space, Table, Typography, message } from "antd";
import { client, currentRole } from "../api/client";
import { StatusTag } from "../components/StatusTag";

export function DashboardPage() {
  const queryClient = useQueryClient();
  const admin = currentRole() === "admin";
  const [createOpen, setCreateOpen] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [avatarUrl, setAvatarUrl] = useState(() => createAvatarUrl());
  const health = useQuery({
    queryKey: ["health"],
    queryFn: client.health,
    retry: false,
    refetchInterval: 30_000,
  });
  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: client.accounts,
    refetchInterval: 30_000,
  });
  const groups = useQuery({ queryKey: ["groups"], queryFn: client.groups, refetchInterval: 30_000 });
  const online = useMemo(
    () => accounts.data?.filter((item) => item.status === "online") ?? [],
    [accounts.data],
  );
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["accounts"] });
    void queryClient.invalidateQueries({ queryKey: ["groups"] });
  }, [queryClient]);
  const connect = useMutation({
    mutationFn: client.connectAccount,
    onSuccess: refresh,
    onError: (e: Error) => void message.error(e.message),
  });
  const transition = useMutation({
    mutationFn: ({ id, from, to }: { id: string; from: string; to: string }) =>
      client.transitionAccount(id, from, to),
    onSuccess: refresh,
    onError: (e: Error) => void message.error(e.message),
  });
  const create = useMutation({
    mutationFn: () => client.createAccount(displayName.trim(), avatarUrl),
    onSuccess: (account) => {
      setCreateOpen(false);
      setDisplayName("");
      setAvatarUrl(createAvatarUrl());
      refresh();
      void message.success(`${account.displayName} 已创建，可继续连接消息网关`);
    },
    onError: (e: Error) => void message.error(e.message),
  });
  const activeGroups = groups.data?.filter((g) => g.status === "active").length ?? 0;
  const activeAgents = groups.data?.filter((g) => g.activeAgentRunId).length ?? 0;
  return (
    <>
      {!admin && (
        <Alert className="viewer-alert" type="info" showIcon message="当前为只读查看者，写操作已隐藏。" />
      )}
      <div className="section-intro">
        <Typography.Title level={2}>运行状态</Typography.Title>
        <Typography.Text type="secondary">
          {health.isSuccess
            ? `控制面健康 · Schema v${health.data.schemaVersion}`
            : health.isError
              ? "控制面健康检查失败"
              : "正在检查控制面状态"}
        </Typography.Text>
      </div>
      <Row gutter={[16, 16]} className="metric-row">
        <Col xs={24} md={8}>
          <Card className="metric-card metric-blue">
            <div className="metric-head">
              <span>服务账号</span>
              <i>01</i>
            </div>
            <strong>{accounts.data?.length ?? 0}</strong>
            <div className="metric-foot">
              <span className="metric-dot online" /> {online.length} 个账号在线
              <span className="metric-line" />
            </div>
          </Card>
        </Col>
        <Col xs={24} md={8}>
          <Card className="metric-card metric-violet">
            <div className="metric-head">
              <span>活跃群组</span>
              <i>02</i>
            </div>
            <strong>{activeGroups}</strong>
            <div className="metric-foot">
              <span className="metric-dot" /> 消息编排空间
              <span className="metric-line" />
            </div>
          </Card>
        </Col>
        <Col xs={24} md={8}>
          <Card className="metric-card metric-emerald">
            <div className="metric-head">
              <span>Agent 执行</span>
              <i>03</i>
            </div>
            <strong>{activeAgents}</strong>
            <div className="metric-foot">
              <span className="metric-dot" /> 当前运行中
              <span className="metric-line" />
            </div>
          </Card>
        </Col>
      </Row>
      <Card
        title={
          <div className="card-title">
            <span>服务账号</span>
            <small>账号状态机</small>
          </div>
        }
        extra={
          admin && (
            <Button
              type="primary"
              onClick={() => {
                setAvatarUrl(createAvatarUrl());
                setCreateOpen(true);
              }}
            >
              新建服务账号
            </Button>
          )
        }
        className="section-card premium-card"
      >
        <Table
          rowKey="id"
          loading={accounts.isLoading}
          dataSource={accounts.data}
          pagination={false}
          columns={[
            {
              title: "账号",
              render: (_, record) => (
                <div className="account-profile-cell">
                  <Avatar src={record.avatarUrl}>{record.displayName.slice(0, 1)}</Avatar>
                  <span>
                    <strong>{record.displayName}</strong>
                    <small>{record.id}</small>
                  </span>
                </div>
              ),
            },
            { title: "平台身份", dataIndex: "platformUserId", render: (value) => value ?? "尚未连接" },
            { title: "状态", dataIndex: "status", render: (value) => <StatusTag value={value} /> },
            {
              title: "限流恢复",
              dataIndex: "rateLimitedUntil",
              render: (value) => <RateLimitCountdown value={value} />,
            },
            {
              title: "操作",
              render: (_, record) =>
                admin ? (
                  <Space>
                    {record.status === "idle" && (
                      <Button onClick={() => connect.mutate(record.id)}>连接</Button>
                    )}
                    {record.status === "disconnected" && (
                      <Button onClick={() => connect.mutate(record.id)}>重连</Button>
                    )}
                    {["online", "rate_limited"].includes(record.status) && (
                      <Button
                        onClick={() =>
                          transition.mutate({ id: record.id, from: record.status, to: "disconnected" })
                        }
                      >
                        标记离线
                      </Button>
                    )}
                    {["online", "disconnected"].includes(record.status) && (
                      <Button
                        onClick={() => transition.mutate({ id: record.id, from: record.status, to: "idle" })}
                      >
                        释放账号
                      </Button>
                    )}
                  </Space>
                ) : null,
            },
          ]}
        />
      </Card>
      <Modal
        title="新建服务账号"
        open={createOpen}
        okText="创建账号"
        cancelText="取消"
        confirmLoading={create.isPending}
        okButtonProps={{ disabled: displayName.trim().length < 2 }}
        onOk={() => create.mutate()}
        onCancel={() => setCreateOpen(false)}
      >
        <div className="create-account-form">
          <div className="avatar-picker">
            <Avatar size={76} src={avatarUrl}>
              {displayName.trim().slice(0, 1) || "助"}
            </Avatar>
            <Button onClick={() => setAvatarUrl(createAvatarUrl())}>换一个头像</Button>
          </div>
          <label>
            <span>助手名称</span>
            <Input
              autoFocus
              maxLength={30}
              placeholder="例如：小林助手"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              onPressEnter={() => displayName.trim().length >= 2 && create.mutate()}
            />
          </label>
          <Typography.Text type="secondary">
            新账号会以空闲状态创建，连接消息网关后才能加入群聊。
          </Typography.Text>
        </div>
      </Modal>
    </>
  );
}

function createAvatarUrl(): string {
  return `https://api.dicebear.com/10.x/lorelei/svg?seed=${crypto.randomUUID()}`;
}

function RateLimitCountdown({ value }: { value: string | null }) {
  if (!value) return <>—</>;
  return <Typography.Text type="warning">{new Date(value).toLocaleTimeString()}</Typography.Text>;
}
