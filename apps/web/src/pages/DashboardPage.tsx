import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Card, Col, Form, Modal, Row, Select, Space, Table, Typography, message } from "antd";
import { Link } from "react-router-dom";
import { client, currentRole } from "../api/client";
import { StatusTag } from "../components/StatusTag";

export function DashboardPage() {
  const queryClient = useQueryClient();
  const admin = currentRole() === "admin";
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
  const [open, setOpen] = useState(false);
  const [jobId, setJobId] = useState<string>();
  const job = useQuery({
    queryKey: ["job", jobId],
    queryFn: () => client.job(jobId!),
    enabled: Boolean(jobId),
    refetchInterval: (query) => (query.state.data?.status === "running" ? 500 : false),
  });
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
    mutationFn: ({
      creatorAccountId,
      memberAccountIds,
    }: {
      creatorAccountId: string;
      memberAccountIds: string[];
    }) => client.createGroup(creatorAccountId, memberAccountIds),
    onSuccess: ({ jobId: createdJobId }) => {
      setJobId(createdJobId);
      setOpen(false);
      void message.success("建群任务已经提交");
    },
    onError: (e: Error) => void message.error(e.message),
  });
  useEffect(() => {
    if (job.data?.status === "finished") refresh();
  }, [job.data?.status, refresh]);
  const activeGroups = groups.data?.filter((g) => g.status === "active").length ?? 0;
  const activeAgents = groups.data?.filter((g) => g.activeAgentRunId).length ?? 0;
  return (
    <>
      {!admin && (
        <Alert className="viewer-alert" type="info" showIcon message="当前为只读查看者，写操作已隐藏。" />
      )}
      <div className="section-intro">
        <div>
          <span className="section-kicker">实时运行</span>
          <Typography.Title level={2}>基础设施运行态势</Typography.Title>
        </div>
        <Typography.Text type="secondary">
          {health.isSuccess
            ? `控制面健康 · Schema v${health.data.schemaVersion}`
            : health.isError
              ? "控制面健康检查失败"
              : "正在检查控制面状态"}
        </Typography.Text>
      </div>
      {jobId && job.data && (
        <Alert
          className="viewer-alert"
          showIcon
          type={job.data.status === "failed" ? "error" : job.data.status === "finished" ? "success" : "info"}
          message={
            job.data.status === "running"
              ? "建群任务执行中"
              : job.data.status === "finished"
                ? "建群任务已完成"
                : "建群任务失败"
          }
          description={
            job.data.errors.length
              ? job.data.errors.map((error) => `${error.step}: ${error.code}`).join("；")
              : `Job ${jobId.slice(0, 8)}`
          }
          closable
          onClose={() => setJobId(undefined)}
        />
      )}
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
      <section className="architecture-strip">
        <div className="architecture-copy">
          <span className="section-kicker">系统架构</span>
        </div>
        <div className="architecture-flow">
          <div>
            <b>01</b>
            <span>消息网关</span>
            <small>重复 · 超时 · 限流</small>
          </div>
          <i>→</i>
          <div className="featured">
            <b>02</b>
            <span>持久化核心</span>
            <small>收件箱 · 发件箱 · 租约</small>
          </div>
          <i>→</i>
          <div>
            <b>03</b>
            <span>Agent 运行时</span>
            <small>校验 · 审计 · 执行</small>
          </div>
          <i>→</i>
          <div>
            <b>04</b>
            <span>操作员</span>
            <small>观察 · 解释 · 恢复</small>
          </div>
        </div>
      </section>
      <Card
        title={
          <div className="card-title">
            <span>服务账号</span>
            <small>账号状态机</small>
          </div>
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
              dataIndex: "id",
              render: (value) => (
                <Space>
                  <span className="account-glyph">{value.slice(-1)}</span>
                  <strong>{value}</strong>
                </Space>
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
      <Card
        title={
          <div className="card-title">
            <span>群组空间</span>
            <small>群组编排</small>
          </div>
        }
        className="section-card premium-card"
        extra={
          admin ? (
            <Button type="primary" onClick={() => setOpen(true)}>
              创建群组
            </Button>
          ) : null
        }
      >
        <Table
          rowKey="id"
          loading={groups.isLoading}
          dataSource={groups.data}
          pagination={false}
          columns={[
            {
              title: "群组",
              dataIndex: "id",
              render: (value) => (
                <Link className="group-link" to={`/groups/${value}`}>
                  <span className="group-glyph">G</span>
                  <span>
                    <b>Group {value.slice(0, 8)}</b>
                    <small>打开实时控制台 →</small>
                  </span>
                </Link>
              ),
            },
            { title: "创建账号", dataIndex: "creatorAccountId" },
            { title: "成员", dataIndex: "members", render: (members) => members.length },
            {
              title: "Agent",
              render: (_, record) =>
                record.agentEnabled ? (
                  <StatusTag value={record.activeAgentRunId ? "running" : "active"} />
                ) : (
                  <StatusTag value="disabled" />
                ),
            },
            { title: "状态", dataIndex: "status", render: (value) => <StatusTag value={value} /> },
          ]}
        />
      </Card>
      <Modal title="新建群组" open={open} onCancel={() => setOpen(false)} footer={null} destroyOnHidden>
        <Form layout="vertical" onFinish={(value) => create.mutate(value)}>
          <Form.Item label="群主账号" name="creatorAccountId" rules={[{ required: true }]}>
            <Select options={online.map((a) => ({ label: a.id, value: a.id }))} />
          </Form.Item>
          <Form.Item
            label="成员账号（第一个将提升为管理员）"
            name="memberAccountIds"
            rules={[{ required: true }]}
          >
            <Select mode="multiple" options={online.map((a) => ({ label: a.id, value: a.id }))} />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={create.isPending} block>
            提交异步建群任务
          </Button>
        </Form>
      </Modal>
    </>
  );
}

function RateLimitCountdown({ value }: { value: string | null }) {
  if (!value) return <>—</>;
  return <Typography.Text type="warning">{new Date(value).toLocaleTimeString()}</Typography.Text>;
}
