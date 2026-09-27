import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Card, Col, Form, Modal, Row, Select, Space, Table, Typography, message } from "antd";
import { Link } from "react-router-dom";
import { client, currentRole } from "../api/client";
import { StatusTag } from "../components/StatusTag";

export function DashboardPage() {
  const queryClient = useQueryClient();
  const admin = currentRole() === "admin";
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: client.accounts });
  const groups = useQuery({ queryKey: ["groups"], queryFn: client.groups, refetchInterval: 2_000 });
  const [open, setOpen] = useState(false);
  const online = useMemo(
    () => accounts.data?.filter((item) => item.status === "online") ?? [],
    [accounts.data],
  );
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["accounts"] });
    void queryClient.invalidateQueries({ queryKey: ["groups"] });
  };
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
    onSuccess: () => {
      setOpen(false);
      refresh();
      void message.success("建群任务已经提交");
    },
    onError: (e: Error) => void message.error(e.message),
  });
  const activeGroups = groups.data?.filter((g) => g.status === "active").length ?? 0;
  const activeAgents = groups.data?.filter((g) => g.activeAgentRunId).length ?? 0;
  return (
    <>
      <section className="hero-panel">
        <div className="hero-copy">
          <div className="eyebrow">
            <span /> RELIABLE MESSAGE & AGENT INFRASTRUCTURE
          </div>
          <Typography.Title>
            把不可靠的外部系统，
            <br />
            <em>变成确定性的业务能力。</em>
          </Typography.Title>
          <Typography.Paragraph>
            RelayOps 为多账号群消息提供持久化编排层。即使网关重复、超时、限流，Agent
            返回异常，业务仍然可恢复、可审计、可解释。
          </Typography.Paragraph>
          <Space size={12} wrap>
            {admin && (
              <Button type="primary" size="large" onClick={() => setOpen(true)}>
                创建编排群组 <span>→</span>
              </Button>
            )}
            <Link className="hero-secondary" to="/reliability-lab">
              运行故障实验
            </Link>
          </Space>
        </div>
        <div className="hero-system-card">
          <div className="system-card-top">
            <span>PLATFORM POSTURE</span>
            <b>
              <i /> HEALTHY
            </b>
          </div>
          <div className="system-orbit">
            <div className="orbit-ring ring-one" />
            <div className="orbit-ring ring-two" />
            <div className="orbit-core">
              <span>R</span>
              <small>DURABLE CORE</small>
            </div>
            <div className="orbit-node node-gateway">GATEWAY</div>
            <div className="orbit-node node-agent">AGENT</div>
            <div className="orbit-node node-ops">OPS</div>
          </div>
          <div className="posture-list">
            <span>
              <i /> Persistent inbox / outbox
            </span>
            <span>
              <i /> Audited tool execution
            </span>
            <span>
              <i /> Restart-safe workers
            </span>
          </div>
        </div>
      </section>
      {!admin && (
        <Alert className="viewer-alert" type="info" showIcon message="当前为只读查看者，写操作已隐藏。" />
      )}
      <div className="section-intro">
        <div>
          <span className="section-kicker">REAL-TIME OPERATIONS</span>
          <Typography.Title level={2}>基础设施运行态势</Typography.Title>
        </div>
        <Typography.Text type="secondary">所有状态均来自实时系统，不是演示数据</Typography.Text>
      </div>
      <Row gutter={[16, 16]} className="metric-row">
        <Col xs={24} md={8}>
          <Card className="metric-card metric-blue">
            <div className="metric-head">
              <span>MANAGED IDENTITIES</span>
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
              <span>ACTIVE GROUPS</span>
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
              <span>AGENT EXECUTION</span>
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
          <span className="section-kicker">SYSTEM ARCHITECTURE</span>
          <h3>一条消息，从不确定到可证明</h3>
          <p>每个外部副作用都有本地身份、持久化状态和恢复路径。</p>
        </div>
        <div className="architecture-flow">
          <div>
            <b>01</b>
            <span>Gateway</span>
            <small>重复 · 超时 · 限流</small>
          </div>
          <i>→</i>
          <div className="featured">
            <b>02</b>
            <span>Durable Core</span>
            <small>Inbox · Outbox · Lease</small>
          </div>
          <i>→</i>
          <div>
            <b>03</b>
            <span>Agent Runtime</span>
            <small>Validate · Audit · Execute</small>
          </div>
          <i>→</i>
          <div>
            <b>04</b>
            <span>Operator</span>
            <small>Observe · Explain · Recover</small>
          </div>
        </div>
      </section>
      <Card
        title={
          <div className="card-title">
            <span>服务账号</span>
            <small>ACCOUNT STATE MACHINE</small>
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
              title: "操作",
              render: (_, record) =>
                admin ? (
                  <Space>
                    {["idle", "disconnected"].includes(record.status) && (
                      <Button onClick={() => connect.mutate(record.id)}>连接</Button>
                    )}
                    {record.status === "online" && (
                      <Button
                        onClick={() =>
                          transition.mutate({ id: record.id, from: record.status, to: "disconnected" })
                        }
                      >
                        标记离线
                      </Button>
                    )}
                    {record.status === "disconnected" && (
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
            <small>ORCHESTRATION WORKSPACES</small>
          </div>
        }
        className="section-card premium-card"
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
