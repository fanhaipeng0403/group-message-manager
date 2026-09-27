import { useEffect, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Avatar,
  Button,
  Card,
  Col,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  List,
  Popconfirm,
  Row,
  Select,
  Space,
  Switch,
  Tag,
  Timeline,
  Typography,
  message,
} from "antd";
import { Link, useParams } from "react-router-dom";
import { client, currentRole, type AgentRun } from "../api/client";
import { StatusTag } from "../components/StatusTag";

export function GroupPage() {
  const { id = "" } = useParams();
  const queryClient = useQueryClient();
  const admin = currentRole() === "admin";
  const [selectedRun, setSelectedRun] = useState<string>();
  const [leaveJobId, setLeaveJobId] = useState<string>();
  const group = useQuery({
    queryKey: ["group", id],
    queryFn: () => client.group(id),
    enabled: Boolean(id),
    refetchInterval: 30_000,
  });
  const messages = useInfiniteQuery({
    queryKey: ["messages", id],
    queryFn: ({ pageParam }) => client.messages(id, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: Boolean(id),
    refetchInterval: 30_000,
  });
  const runs = useQuery({
    queryKey: ["agent-runs", id],
    queryFn: () => client.agentRuns(id),
    enabled: Boolean(id),
    refetchInterval: 30_000,
  });
  const run = useQuery({
    queryKey: ["agent-run", selectedRun],
    queryFn: () => client.agentRun(selectedRun!),
    enabled: Boolean(selectedRun),
    refetchInterval: (query) => (query.state.data?.status === "running" ? 30_000 : false),
  });
  const leaveJob = useQuery({
    queryKey: ["job", leaveJobId],
    queryFn: () => client.job(leaveJobId!),
    enabled: Boolean(leaveJobId),
    refetchInterval: (query) => (query.state.data?.status === "running" ? 500 : false),
  });
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["group", id] });
    void queryClient.invalidateQueries({ queryKey: ["messages", id] });
  };
  const patch = useMutation({
    mutationFn: (value: { agentEnabled?: boolean; autoKickEnabled?: boolean }) =>
      client.patchGroup(id, value),
    onSuccess: invalidate,
    onError: (e: Error) => void message.error(e.message),
  });
  const send = useMutation({
    mutationFn: (value: { accountId: string; text: string }) => client.send(id, value.accountId, value.text),
    onSuccess: () => {
      invalidate();
      void message.success("消息已经进入可靠发送队列");
    },
    onError: (e: Error) => void message.error(e.message),
  });
  const leaveAll = useMutation({
    mutationFn: () => client.leaveAll(id),
    onSuccess: ({ jobId }) => {
      setLeaveJobId(jobId);
      void message.success("全员退群任务已经提交");
    },
    onError: (e: Error) => void message.error(e.message),
  });
  useEffect(() => {
    if (leaveJob.data?.status === "finished") {
      void queryClient.invalidateQueries({ queryKey: ["group", id] });
      void queryClient.invalidateQueries({ queryKey: ["groups"] });
    }
  }, [id, leaveJob.data?.status, queryClient]);
  if (group.isError) return <Alert type="error" message={(group.error as Error).message} />;
  const data = group.data;
  const messageItems = Array.from(
    new Map(
      (messages.data?.pages.flatMap((page) => page.items) ?? []).map((item) => [
        item.clientMsgId ?? item.msgId,
        item,
      ]),
    ).values(),
  );
  return (
    <>
      <Link className="back-link" to="/">
        ← 返回运行总览
      </Link>
      <section className="group-control-head">
        <div className="group-control-title">
          <div className="group-large-glyph">G</div>
          <div>
            <span className="section-kicker">LIVE ORCHESTRATION WORKSPACE</span>
            <Typography.Title>
              Group <span className="mono">{id.slice(0, 8)}</span>
            </Typography.Title>
            <Space>
              <StatusTag value={data?.status ?? null} />
              <Typography.Text>Gateway · {data?.gatewayGroupId ?? "—"}</Typography.Text>
            </Space>
          </div>
        </div>
        {admin && data && (
          <div className="policy-controls">
            <div>
              <span>
                <b>Agent Runtime</b>
                <small>自动响应外部消息</small>
              </span>
              <Switch
                checked={data.agentEnabled}
                onChange={(agentEnabled) => patch.mutate({ agentEnabled })}
              />
            </div>
            <div>
              <span>
                <b>Auto Moderation</b>
                <small>允许 Agent 移除成员</small>
              </span>
              <Switch
                checked={data.autoKickEnabled}
                disabled={!data.agentEnabled}
                onChange={(autoKickEnabled) => patch.mutate({ autoKickEnabled })}
              />
            </div>
            {data.status === "active" && (
              <Popconfirm
                title="确认让全部服务账号退出该群？"
                description="系统会保证群主最后退出。"
                okText="确认退群"
                cancelText="取消"
                onConfirm={() => leaveAll.mutate()}
              >
                <Button className="leave-all-button" danger loading={leaveAll.isPending}>
                  全员退群
                </Button>
              </Popconfirm>
            )}
          </div>
        )}
      </section>
      {leaveJobId && leaveJob.data && (
        <Alert
          className="viewer-alert"
          showIcon
          closable
          onClose={() => setLeaveJobId(undefined)}
          type={
            leaveJob.data.status === "failed"
              ? "error"
              : leaveJob.data.status === "finished"
                ? "success"
                : "info"
          }
          message={
            leaveJob.data.status === "running"
              ? "全员退群任务执行中"
              : leaveJob.data.status === "finished"
                ? "全员退群已完成"
                : "全员退群任务失败"
          }
          description={
            leaveJob.data.errors.length
              ? leaveJob.data.errors.map((error) => `${error.step}: ${error.code}`).join("；")
              : `Job ${leaveJobId.slice(0, 8)}`
          }
        />
      )}
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={16}>
          <Card
            title={
              <div className="card-title">
                <span>消息时间线</span>
                <small>DURABLE TIMELINE</small>
              </div>
            }
            className="timeline-card"
            extra={
              <span className="live-label">
                <i /> LIVE · 按网关时间排序
              </span>
            }
          >
            {messages.hasNextPage && (
              <div className="load-earlier">
                <Button loading={messages.isFetchingNextPage} onClick={() => void messages.fetchNextPage()}>
                  加载更早
                </Button>
              </div>
            )}
            {!messageItems.length ? (
              <Empty description="还没有消息" />
            ) : (
              <div className="message-list">
                {[...messageItems].reverse().map((item) => (
                  <div
                    className={`message-row ${item.isOwn ? "own" : "incoming"}`}
                    key={item.clientMsgId ?? item.msgId}
                  >
                    <Avatar>{item.senderPlatformUserId.slice(-2)}</Avatar>
                    <div className="message-content">
                      <Space>
                        <strong>{item.senderPlatformUserId}</strong>
                        <Typography.Text type="secondary">
                          {new Date(item.sentAt).toLocaleTimeString()}
                        </Typography.Text>
                        {item.isOwn && <StatusTag value={item.deliveryStatus} />}
                      </Space>
                      <p>{item.text}</p>
                      {item.failCode && <Tag color="error">{item.failCode}</Tag>}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {admin && data && (
              <Form layout="inline" className="composer" onFinish={(value) => send.mutate(value)}>
                <Form.Item name="accountId" rules={[{ required: true }]}>
                  <Select
                    placeholder="发送账号"
                    style={{ width: 160 }}
                    options={data.members
                      .filter((member) => member.accountId)
                      .map((member) => ({
                        label: `${member.accountId} · ${member.role}`,
                        value: member.accountId!,
                      }))}
                  />
                </Form.Item>
                <Form.Item name="text" rules={[{ required: true }]} style={{ flex: 1 }}>
                  <Input placeholder="输入消息，提交后立即写入本地 outbox" />
                </Form.Item>
                <Button type="primary" htmlType="submit" loading={send.isPending}>
                  发送
                </Button>
              </Form>
            )}
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card
            title={
              <div className="card-title">
                <span>成员</span>
                <small>GROUP IDENTITIES</small>
              </div>
            }
            className="section-card premium-card"
          >
            <List
              dataSource={data?.members ?? []}
              renderItem={(member) => (
                <List.Item>
                  <List.Item.Meta
                    avatar={<Avatar className="member-avatar">{member.role[0]?.toUpperCase()}</Avatar>}
                    title={member.accountId ?? member.platformUserId}
                    description={member.platformUserId}
                  />
                  <Tag>{member.role}</Tag>
                </List.Item>
              )}
            />
          </Card>
          <Card
            title={
              <div className="card-title">
                <span>Agent Runs</span>
                <small>AUDITABLE EXECUTIONS</small>
              </div>
            }
            className="section-card premium-card"
          >
            {runs.data?.some((item) => item.status === "blocked") && (
              <Alert
                className="blocked-run-alert"
                type="error"
                showIcon
                message="存在被审计阻断的 Agent Run"
                description="请打开对应运行查看审计结果和原始步骤。"
              />
            )}
            <List
              dataSource={runs.data ?? []}
              locale={{ emptyText: data?.agentEnabled ? "等待外部消息触发" : "Agent 未启用" }}
              renderItem={(item: AgentRun) => (
                <List.Item onClick={() => setSelectedRun(item.id)} className="clickable">
                  <List.Item.Meta
                    title={
                      <Space>
                        <span className="mono">{item.id.slice(0, 8)}</span>
                        <StatusTag value={item.status} />
                      </Space>
                    }
                    description={item.summary ?? item.endReason ?? "运行中"}
                  />
                </List.Item>
              )}
            />
          </Card>
        </Col>
      </Row>
      <Drawer
        width={640}
        title={`Agent Run ${selectedRun?.slice(0, 8) ?? ""}`}
        open={Boolean(selectedRun)}
        onClose={() => setSelectedRun(undefined)}
      >
        {run.data && (
          <>
            <Descriptions
              bordered
              size="small"
              column={2}
              items={[
                { key: "status", label: "状态", children: <StatusTag value={run.data.status} /> },
                { key: "reason", label: "结束原因", children: run.data.endReason ?? "—" },
                { key: "summary", label: "总结", children: run.data.summary ?? "—", span: 2 },
              ]}
            />
            <Typography.Title level={4}>执行步骤</Typography.Title>
            <Timeline
              items={run.data.steps.map((step, index) => ({
                color: step.isError ? "red" : "blue",
                children: (
                  <Card
                    size="small"
                    title={`${index + 1}. ${step.kind} · ${step.name ?? step.errorCode ?? "final"}`}
                  >
                    <Descriptions
                      size="small"
                      column={1}
                      items={[
                        {
                          key: "input",
                          label: "输入",
                          children: <pre>{JSON.stringify(step.input, null, 2)}</pre>,
                        },
                        { key: "result", label: "结果", children: step.resultSummary || "—" },
                        { key: "audit", label: "审计", children: step.auditVerdict ?? "—" },
                      ]}
                    />
                    {step.kind === "protocol_error" && (
                      <details>
                        <summary>原始响应</summary>
                        <pre>{step.rawResponse}</pre>
                      </details>
                    )}
                  </Card>
                ),
              }))}
            />
          </>
        )}
      </Drawer>
    </>
  );
}
