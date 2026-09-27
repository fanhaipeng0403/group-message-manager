import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Empty, Select, Spin, Tag, Typography, message } from "antd";
import { Link } from "react-router-dom";
import { client, currentRole, type DemoScenario, type ReliabilityExperiment } from "../api/client";

const evidenceLabels: Record<string, string> = {
  timelineRows: "时间线最终记录",
  agentRuns: "Agent 实际运行",
  deliveryStatus: "消息最终状态",
  rateLimitedObserved: "检测到网关限流",
  recoveredOnlineObserved: "账号自动恢复",
  sendSteps: "发消息工具调用",
  auditedSendSteps: "实际发送审计",
  idempotencyKeys: "幂等键数量",
  gatewayMessageCount: "网关实际收到",
  badJsonRecorded: "异常响应已留痕",
  unknownToolRecorded: "未知工具已处理",
  auditPassed: "安全审计",
  toolSequence: "Agent 执行顺序",
};

const scenarioJourneys: Record<string, string[]> = {
  s2_duplicate: [
    "向网关注入两次相同事件",
    "系统识别并去除重复事件",
    "时间线只保留一条消息",
    "Agent 只响应一次",
  ],
  s4_rate_limit: ["模拟账号触发网关限流", "消息进入等待队列", "到达恢复时间后自动重试", "确认消息最终送达"],
  s5_agent_idempotency: [
    "让 Agent 生成发消息动作",
    "模拟同一步骤被重复执行",
    "用幂等键拦截重复发送",
    "核对网关只收到一条",
  ],
  s6_agent_protocol: [
    "模拟 Agent 返回异常内容",
    "系统记录协议错误",
    "允许下一轮合法工具继续执行",
    "确认 Agent 正常完成回复",
  ],
  agent_happy: [
    "客户向群聊发送一条消息",
    "Agent 读取最近上下文",
    "Agent 通过工具发送回复",
    "完整记录执行与审计",
  ],
};

function statusTag(status: ReliabilityExperiment["status"]) {
  if (status === "passed") return <Tag color="success">验证通过</Tag>;
  if (status === "failed") return <Tag color="error">验证未通过</Tag>;
  return <Tag color="processing">验证中</Tag>;
}

function valueText(value: unknown): string {
  if (typeof value === "boolean") return value ? "是" : "否";
  if (Array.isArray(value)) return value.join(" → ");
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function resultSummary(experiment: ReliabilityExperiment): Array<[string, unknown]> {
  return Object.entries(experiment.evidence)
    .filter(
      ([key]) =>
        !["passed", "steps", "transitions", "runStatus", "endReason", "runId", "phase"].includes(key),
    )
    .slice(0, 6);
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
  const [scenarioId, setScenarioId] = useState<string>();
  const selectedGroupId = groupId ?? activeGroups[0]?.id;
  const selectedScenario = scenarios.data?.find((item) => item.id === scenarioId) ?? scenarios.data?.[0];
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
      void message.success("验证已启动，系统正在自动执行并收集结果");
    },
    onError: (error: Error) => void message.error(error.message),
  });
  const latestByScenario = useMemo(() => {
    const map = new Map<string, ReliabilityExperiment>();
    for (const item of experiments.data ?? []) if (!map.has(item.scenario)) map.set(item.scenario, item);
    return map;
  }, [experiments.data]);
  const latest = selectedScenario ? latestByScenario.get(selectedScenario.id) : undefined;
  const journey = selectedScenario ? (scenarioJourneys[selectedScenario.id] ?? selectedScenario.proves) : [];

  return (
    <div className="validation-page">
      <header className="validation-hero">
        <div>
          <span className="eyebrow">SYSTEM VERIFICATION</span>
          <Typography.Title level={2}>系统验证中心</Typography.Title>
          <Typography.Paragraph>
            用真实故障演练证明消息不会丢、不会重复，Agent 出错后也能恢复。
          </Typography.Paragraph>
        </div>
        <label>
          <span>验证群聊</span>
          <Select
            value={selectedGroupId}
            onChange={setGroupId}
            placeholder="选择一个运行中的群聊"
            options={activeGroups.map((group) => ({
              value: group.id,
              label: `群聊 ${group.id.slice(0, 8)}`,
            }))}
          />
        </label>
      </header>

      {!activeGroups.length && (
        <Alert type="warning" showIcon message="请先在运行总览连接账号并创建一个群聊。" />
      )}

      <div className="validation-layout">
        <aside className="validation-scenario-list">
          <div className="validation-list-title">
            <b>选择验证场景</b>
            <span>{scenarios.data?.length ?? 0} 个</span>
          </div>
          {(scenarios.data ?? []).map((scenario, index) => (
            <button
              key={scenario.id}
              className={selectedScenario?.id === scenario.id ? "active" : ""}
              onClick={() => setScenarioId(scenario.id)}
            >
              <i>{index + 1}</i>
              <span>
                <b>{customerScenarioTitle(scenario)}</b>
                <small>{scenario.summary}</small>
              </span>
              {latestByScenario.get(scenario.id) && statusDot(latestByScenario.get(scenario.id)!)}
            </button>
          ))}
        </aside>

        <main className="validation-stage">
          {!selectedScenario ? (
            <Empty description="正在加载验证场景" />
          ) : (
            <>
              <div className="validation-stage-head">
                <div>
                  <Tag color="geekblue">{selectedScenario.requirement}</Tag>
                  <Typography.Title level={3}>{customerScenarioTitle(selectedScenario)}</Typography.Title>
                  <Typography.Paragraph>{selectedScenario.summary}</Typography.Paragraph>
                </div>
                {latest && statusTag(latest.status)}
              </div>

              <div className="validation-journey">
                <div className="validation-section-title">
                  <b>系统将自动完成</b>
                  <span>整个过程通常只需几秒</span>
                </div>
                <div className="validation-steps">
                  {journey.map((step, index) => (
                    <div key={step} className={latest?.status === "passed" ? "complete" : ""}>
                      <i>{latest?.status === "passed" ? "✓" : index + 1}</i>
                      <span>{step}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="validation-action">
                <div>
                  <b>{running ? "正在验证，请稍候" : latest ? "可以再次运行验证" : "准备开始验证"}</b>
                  <span>不会修改业务配置，产生的测试消息会带有场景标记。</span>
                </div>
                <Button
                  type="primary"
                  size="large"
                  disabled={!admin || !selectedGroupId || running}
                  loading={start.isPending && start.variables === selectedScenario.id}
                  onClick={() => start.mutate(selectedScenario.id)}
                >
                  {latest ? "重新验证" : "开始验证"}
                </Button>
              </div>

              {running && (
                <div className="validation-running">
                  <Spin />
                  <div>
                    <b>系统正在执行故障演练</b>
                    <span>页面会自动更新，无需手动刷新。</span>
                  </div>
                </div>
              )}

              {latest && latest.status !== "running" && (
                <section className={`validation-result ${latest.status}`}>
                  <div className="validation-result-title">
                    <i>{latest.status === "passed" ? "✓" : "!"}</i>
                    <div>
                      <b>{latest.status === "passed" ? "本次验证通过" : "本次验证未通过"}</b>
                      <span>{new Date(latest.updatedAt).toLocaleString()}</span>
                    </div>
                    <Link to={`/groups/${latest.groupId}`}>打开群聊查看过程 →</Link>
                  </div>
                  <div className="validation-result-grid">
                    {resultSummary(latest).map(([key, value]) => (
                      <div key={key}>
                        <span>{evidenceLabels[key] ?? key}</span>
                        <b>{valueText(value)}</b>
                      </div>
                    ))}
                  </div>
                  {Array.isArray(latest.evidence.steps) && latest.evidence.steps.length > 0 && (
                    <details>
                      <summary>查看技术执行证据</summary>
                      <pre>{JSON.stringify(latest.evidence.steps, null, 2)}</pre>
                    </details>
                  )}
                </section>
              )}
            </>
          )}
        </main>
      </div>

      <section className="validation-history">
        <div className="validation-section-title">
          <b>最近验证记录</b>
          <span>自动保存每一次结果，方便演示和复盘</span>
        </div>
        {!experiments.data?.length ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="完成一次验证后，记录会显示在这里" />
        ) : (
          <div className="validation-history-list">
            {experiments.data.slice(0, 8).map((experiment) => {
              const scenario = scenarios.data?.find((item) => item.id === experiment.scenario);
              return (
                <button key={experiment.id} onClick={() => scenario && setScenarioId(scenario.id)}>
                  {statusDot(experiment)}
                  <span>
                    <b>{scenario ? customerScenarioTitle(scenario) : experiment.scenario}</b>
                    <small>{new Date(experiment.createdAt).toLocaleString()}</small>
                  </span>
                  {statusTag(experiment.status)}
                </button>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function statusDot(experiment: ReliabilityExperiment) {
  return <em className={`validation-status-dot ${experiment.status}`} />;
}

function customerScenarioTitle(scenario: DemoScenario): string {
  const titles: Record<string, string> = {
    s2_duplicate: "重复消息防护",
    s4_rate_limit: "限流后自动恢复",
    s5_agent_idempotency: "Agent 重试不重复发送",
    s6_agent_protocol: "Agent 异常响应恢复",
    agent_happy: "Agent 自动回复闭环",
  };
  return titles[scenario.id] ?? scenario.title;
}
