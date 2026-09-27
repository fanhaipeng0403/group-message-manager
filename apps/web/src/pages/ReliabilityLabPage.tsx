import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Row,
  Select,
  Space,
  Spin,
  Tag,
  Timeline,
  Typography,
  message,
} from "antd";
import { Link } from "react-router-dom";
import { client, currentRole, type ReliabilityExperiment } from "../api/client";

const evidenceLabels: Record<string, string> = {
  timelineRows: "时间线记录",
  agentRuns: "Agent Runs",
  deliveryStatus: "最终投递状态",
  rateLimitedObserved: "观察到限流",
  recoveredOnlineObserved: "恢复 Online",
  sendSteps: "send_message 调用",
  auditedSendSteps: "实际审计次数",
  idempotencyKeys: "幂等键记录",
  gatewayMessageCount: "网关实际消息",
  badJsonRecorded: "坏 JSON 已记录",
  unknownToolRecorded: "未知工具已记录",
  auditPassed: "审计通过",
  toolSequence: "工具顺序",
};

function statusTag(status: ReliabilityExperiment["status"]) {
  const config =
    status === "passed"
      ? { color: "success", text: "已通过" }
      : status === "failed"
        ? { color: "error", text: "未通过" }
        : { color: "processing", text: "运行中" };
  return <Tag color={config.color}>{config.text}</Tag>;
}

function valueText(value: unknown): string {
  if (typeof value === "boolean") return value ? "是" : "否";
  if (Array.isArray(value)) return value.join(" → ");
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function Evidence({ experiment }: { experiment: ReliabilityExperiment }) {
  const visible = Object.entries(experiment.evidence).filter(
    ([key]) =>
      key !== "passed" &&
      key !== "steps" &&
      key !== "transitions" &&
      key !== "runStatus" &&
      key !== "endReason" &&
      key !== "runId" &&
      key !== "phase",
  );
  return (
    <div className="evidence-panel">
      <div className="evidence-header">
        <Space>
          {statusTag(experiment.status)}
          <Typography.Text className="mono" type="secondary">
            {experiment.id.slice(0, 8)}
          </Typography.Text>
        </Space>
        <Typography.Text type="secondary">
          {new Date(experiment.createdAt).toLocaleTimeString()}
        </Typography.Text>
      </div>
      {typeof experiment.evidence.phase === "string" && (
        <Alert type="info" showIcon message="正在等待 Worker 接管消息" />
      )}
      <div className="evidence-grid">
        {visible.map(([key, value]) => (
          <div className="evidence-item" key={key}>
            <span>{evidenceLabels[key] ?? key}</span>
            <strong className={typeof value === "boolean" ? (value ? "evidence-good" : "evidence-bad") : ""}>
              {valueText(value)}
            </strong>
          </div>
        ))}
      </div>
      {typeof experiment.evidence.runId === "string" && (
        <Link to={`/groups/${experiment.groupId}`}>查看群消息与 Agent 完整步骤 →</Link>
      )}
      {Array.isArray(experiment.evidence.steps) && experiment.evidence.steps.length > 0 && (
        <details>
          <summary>展开工具与错误步骤</summary>
          <pre>{JSON.stringify(experiment.evidence.steps, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}

export function ReliabilityLabPage() {
  const admin = currentRole() === "admin";
  const queryClient = useQueryClient();
  const groups = useQuery({ queryKey: ["groups"], queryFn: client.groups });
  const scenarios = useQuery({ queryKey: ["demo-scenarios"], queryFn: client.demoScenarios });
  const activeGroups = useMemo(
    () => groups.data?.filter((group) => group.status === "active") ?? [],
    [groups.data],
  );
  const [groupId, setGroupId] = useState<string>();
  const selectedGroupId = groupId ?? activeGroups[0]?.id;
  const experiments = useQuery({
    queryKey: ["experiments", selectedGroupId],
    queryFn: () => client.demoExperiments(selectedGroupId),
    enabled: Boolean(selectedGroupId),
    refetchInterval: (query) =>
      (query.state.data as ReliabilityExperiment[] | undefined)?.some((item) => item.status === "running")
        ? 800
        : false,
  });
  const running = experiments.data?.some((item) => item.status === "running") ?? false;
  const start = useMutation({
    mutationFn: (scenario: string) => client.startDemoExperiment(scenario, selectedGroupId!),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["experiments", selectedGroupId] });
      void message.success("实验已启动，正在收集真实运行证据");
    },
    onError: (error: Error) => void message.error(error.message),
  });
  const latestByScenario = useMemo(() => {
    const map = new Map<string, ReliabilityExperiment>();
    for (const item of experiments.data ?? []) if (!map.has(item.scenario)) map.set(item.scenario, item);
    return map;
  }, [experiments.data]);

  return (
    <>
      <section className="lab-hero">
        <div>
          <div className="eyebrow">
            <span /> FAILURE IS A FIRST-CLASS INPUT
          </div>
          <Typography.Title>
            可靠性不是承诺，
            <br />
            <em>而是可重复的证据。</em>
          </Typography.Title>
          <Typography.Paragraph>
            主动注入重复事件、限流、504 和异常 Agent 响应。真实 Worker 执行、PostgreSQL
            留痕、系统自动判定结果。
          </Typography.Paragraph>
          <Select
            className="lab-group-select"
            value={selectedGroupId}
            onChange={setGroupId}
            placeholder="选择一个活跃群组"
            options={activeGroups.map((group) => ({
              value: group.id,
              label: `实验群组 · ${group.id.slice(0, 8)}`,
            }))}
          />
        </div>
        <div className="lab-method">
          <span>HOW IT WORKS</span>
          <div>
            <b>01</b>
            <p>
              <strong>Inject</strong>
              <small>注入确定性故障</small>
            </p>
          </div>
          <div>
            <b>02</b>
            <p>
              <strong>Execute</strong>
              <small>走正常业务 Worker</small>
            </p>
          </div>
          <div>
            <b>03</b>
            <p>
              <strong>Prove</strong>
              <small>从数据库反查证据</small>
            </p>
          </div>
        </div>
      </section>
      <Alert
        className="viewer-alert"
        type="info"
        showIcon
        message="这里不是前端演示动画"
        description="按钮会真实配置故障、注入消息并运行 Inbox / Outbox / Agent Worker；通过条件来自 PostgreSQL 记录和网关反查。实验能力可通过 DEMO_MODE=false 在生产关闭。"
      />
      {!activeGroups.length && (
        <Alert type="warning" showIcon message="请先回到运行总览：连接账号并创建一个群组。" />
      )}
      <div className="section-intro">
        <div>
          <span className="section-kicker">FAULT CATALOG</span>
          <Typography.Title level={2}>五种高价值故障实验</Typography.Title>
        </div>
        <Typography.Text type="secondary">点击即可复现 · 同一时间运行一个场景</Typography.Text>
      </div>
      <Row gutter={[16, 16]}>
        {scenarios.data?.map((scenario) => {
          const latest = latestByScenario.get(scenario.id);
          return (
            <Col xs={24} md={12} xl={8} key={scenario.id}>
              <Card
                className="scenario-card"
                title={
                  <Space>
                    <Tag color="geekblue">{scenario.requirement}</Tag>
                    {scenario.title}
                  </Space>
                }
                extra={latest ? statusTag(latest.status) : null}
              >
                <Typography.Paragraph type="secondary">{scenario.summary}</Typography.Paragraph>
                <div className="proof-tags">
                  {scenario.proves.map((proof) => (
                    <Tag key={proof}>{proof}</Tag>
                  ))}
                </div>
                <Button
                  type="primary"
                  ghost
                  block
                  disabled={!admin || !selectedGroupId || running}
                  loading={start.isPending && start.variables === scenario.id}
                  onClick={() => start.mutate(scenario.id)}
                >
                  运行真实故障实验
                </Button>
              </Card>
            </Col>
          );
        })}
      </Row>
      <Card
        className="section-card lab-history premium-card"
        title={
          <div className="card-title">
            <span>实验记录</span>
            <small>PERSISTED EVIDENCE LEDGER</small>
          </div>
        }
        extra={
          running ? (
            <Space>
              <Spin size="small" /> 正在采集证据
            </Space>
          ) : null
        }
      >
        {!experiments.data?.length ? (
          <Empty description="运行一个场景后，证据会保存在这里" />
        ) : (
          <Timeline
            items={experiments.data.map((experiment) => ({
              color:
                experiment.status === "passed" ? "green" : experiment.status === "failed" ? "red" : "blue",
              children: <Evidence experiment={experiment} />,
            }))}
          />
        )}
      </Card>
    </>
  );
}
