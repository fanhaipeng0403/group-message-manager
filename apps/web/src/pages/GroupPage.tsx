import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Avatar,
  Button,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  List,
  Popconfirm,
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
import { CreateGroupModal } from "../components/CreateGroupModal";
import { GroupAutomationPanel } from "../components/GroupAutomationPanel";
import { StatusTag } from "../components/StatusTag";

const toolLabels: Record<string, string> = {
  get_recent_messages: "读取最近消息",
  send_message: "发送群消息",
  kick_user: "移除群成员",
  finish: "完成本轮处理",
};

export function GroupPage() {
  const { id = "" } = useParams();
  const queryClient = useQueryClient();
  const admin = currentRole() === "admin";
  const [selectedRun, setSelectedRun] = useState<string>();
  const [leaveJobId, setLeaveJobId] = useState<string>();
  const [showDemoComposer, setShowDemoComposer] = useState(false);
  const [showTechnicalHistory, setShowTechnicalHistory] = useState(false);
  const [groupSearch, setGroupSearch] = useState("");
  const [demoText, setDemoText] = useState("");
  const [createGroupOpen, setCreateGroupOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<"agent" | "automation" | "members">("agent");
  const [sendForm] = Form.useForm();
  const conversationBodyRef = useRef<HTMLElement>(null);

  const groups = useQuery({ queryKey: ["groups"], queryFn: client.groups, refetchInterval: 30_000 });
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
  const activeRunId = group.data?.activeAgentRunId ?? runs.data?.[0]?.id;
  const visibleRunId = selectedRun ?? activeRunId;
  const run = useQuery({
    queryKey: ["agent-run", visibleRunId],
    queryFn: () => client.agentRun(visibleRunId!),
    enabled: Boolean(visibleRunId),
    refetchInterval: (query) => (query.state.data?.status === "running" ? 1_000 : false),
  });
  const leaveJob = useQuery({
    queryKey: ["job", leaveJobId],
    queryFn: () => client.job(leaveJobId!),
    enabled: Boolean(leaveJobId),
    refetchInterval: (query) => (query.state.data?.status === "running" ? 500 : false),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["group", id] });
    void queryClient.invalidateQueries({ queryKey: ["groups"] });
    void queryClient.invalidateQueries({ queryKey: ["messages", id] });
    void queryClient.invalidateQueries({ queryKey: ["agent-runs", id] });
  };
  const patch = useMutation({
    mutationFn: (value: { agentEnabled?: boolean; autoKickEnabled?: boolean }) =>
      client.patchGroup(id, value),
    onSuccess: invalidate,
    onError: (error: Error) => void message.error(error.message),
  });
  const send = useMutation({
    mutationFn: (value: { accountId: string; text: string }) => client.send(id, value.accountId, value.text),
    onSuccess: () => {
      sendForm.resetFields(["text"]);
      invalidate();
      void message.success("消息已进入可靠发送队列");
    },
    onError: (error: Error) => void message.error(error.message),
  });
  const injectDemo = useMutation({
    mutationFn: (value: { senderPlatformUserId: string; text: string }) =>
      client.injectDemoMessage(id, value.senderPlatformUserId, value.text),
    onSuccess: () => {
      setDemoText("");
      invalidate();
      void message.success("模拟客户消息已进入网关，Agent 将自动处理");
    },
    onError: (error: Error) => void message.error(error.message),
  });
  const leaveAll = useMutation({
    mutationFn: () => client.leaveAll(id),
    onSuccess: ({ jobId }) => {
      setLeaveJobId(jobId);
      void message.success("全员退群任务已经提交");
    },
    onError: (error: Error) => void message.error(error.message),
  });

  useEffect(() => {
    if (leaveJob.data?.status !== "finished") return;
    void queryClient.invalidateQueries({ queryKey: ["group", id] });
    void queryClient.invalidateQueries({ queryKey: ["groups"] });
    void queryClient.invalidateQueries({ queryKey: ["messages", id] });
    void queryClient.invalidateQueries({ queryKey: ["agent-runs", id] });
  }, [id, leaveJob.data?.status, queryClient]);

  const allMessageItems = useMemo(
    () =>
      Array.from(
        new Map(
          (messages.data?.pages.flatMap((page) => page.items) ?? []).map((item) => [
            item.clientMsgId ?? item.msgId,
            item,
          ]),
        ).values(),
      ).reverse(),
    [messages.data],
  );
  const classifiedMessages = useMemo(
    () =>
      allMessageItems.reduce<Array<{ item: (typeof allMessageItems)[number]; technical: boolean }>>(
        (entries, item) => {
          const previous = entries.at(-1)?.technical ?? false;
          const technical = isTechnicalTrigger(item.senderPlatformUserId, item.text)
            ? true
            : !item.isOwn
              ? false
              : previous;
          entries.push({ item, technical });
          return entries;
        },
        [],
      ),
    [allMessageItems],
  );
  const technicalMessageCount = classifiedMessages.filter((entry) => entry.technical).length;
  const messageItems = classifiedMessages
    .filter((entry) => showTechnicalHistory || !entry.technical)
    .map((entry) => entry.item);
  const latestMessageKey = allMessageItems.length
    ? (allMessageItems.at(-1)?.clientMsgId ?? allMessageItems.at(-1)?.msgId)
    : undefined;
  const visibleGroups = (groups.data ?? []).filter((item) =>
    `群聊 ${item.id} ${item.gatewayGroupId}`.toLowerCase().includes(groupSearch.trim().toLowerCase()),
  );

  useEffect(() => {
    const body = conversationBodyRef.current;
    if (!body) return;
    body.scrollTo({ top: body.scrollHeight, behavior: "smooth" });
  }, [latestMessageKey]);

  useEffect(() => {
    window.scrollTo({ top: 0 });
    conversationBodyRef.current?.scrollTo({ top: 0 });
  }, [id]);

  if (group.isError) return <Alert type="error" message={(group.error as Error).message} />;
  const data = group.data;
  const currentRun = run.data;

  return (
    <div className="chat-workspace">
      <aside className="chat-groups-panel">
        <div className="chat-panel-brand">
          <Link to="/overview">← 运营总览</Link>
          <div className="chat-panel-title-row">
            <Typography.Title level={3}>群组会话</Typography.Title>
            {admin && (
              <Button type="primary" shape="circle" size="small" onClick={() => setCreateGroupOpen(true)}>
                +
              </Button>
            )}
          </div>
          <Typography.Text type="secondary">统一管理所有服务群聊</Typography.Text>
        </div>
        <Input
          className="chat-group-search"
          placeholder="搜索群组"
          prefix="⌕"
          value={groupSearch}
          onChange={(event) => setGroupSearch(event.target.value)}
        />
        <div className="chat-group-list">
          {visibleGroups.map((item) => (
            <Link
              to={`/groups/${item.id}`}
              className={`chat-group-item ${item.id === id ? "active" : ""}`}
              key={item.id}
            >
              <Avatar className="chat-group-avatar">群</Avatar>
              <span className="chat-group-copy">
                <b>服务群聊 {item.id.slice(0, 4)}</b>
                <small>
                  {item.activeAgentRunId ? "Agent 正在处理消息" : `${item.members.length} 位成员`}
                </small>
              </span>
              <i className={`presence-dot ${item.status}`} />
            </Link>
          ))}
          {!groups.isLoading && !groups.data?.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />}
        </div>
        <div className="chat-groups-foot">
          <span className="live-pulse" />
          实时连接正常
        </div>
      </aside>

      <main className="conversation-panel">
        <header className="conversation-head">
          <div>
            <Space size={10}>
              <Typography.Title level={3}>服务群聊 {id.slice(0, 4)}</Typography.Title>
              <StatusTag value={data?.status ?? null} />
            </Space>
            <p>
              {data?.members.length ?? 0} 位成员 · 网关 {data?.gatewayGroupId ?? "连接中"}
            </p>
          </div>
          <Space>
            {admin && (
              <Button className="demo-message-button" onClick={() => setShowDemoComposer((value) => !value)}>
                {showDemoComposer ? "返回人工发送" : "模拟客户发消息"}
              </Button>
            )}
            <span className="conversation-live">
              <i /> 实时同步
            </span>
          </Space>
        </header>

        {leaveJobId && leaveJob.data && (
          <Alert
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
          />
        )}

        <section className="conversation-body" ref={conversationBodyRef}>
          {messages.hasNextPage && (
            <Button
              className="load-history-button"
              loading={messages.isFetchingNextPage}
              onClick={() => void messages.fetchNextPage()}
            >
              查看更早消息
            </Button>
          )}
          {!messageItems.length && technicalMessageCount === 0 ? (
            <div className="conversation-empty">
              <div className="empty-chat-icon">💬</div>
              <Typography.Title level={4}>还没有群消息</Typography.Title>
              <Typography.Text type="secondary">
                点击“模拟客户发消息”，现场查看 Agent 自动应答全过程。
              </Typography.Text>
            </div>
          ) : (
            <div className="wechat-message-list">
              <div className="chat-date-divider">
                <span>群聊已安全连接</span>
              </div>
              {technicalMessageCount > 0 && (
                <div className="technical-history-toggle">
                  <Button type="text" size="small" onClick={() => setShowTechnicalHistory((value) => !value)}>
                    {showTechnicalHistory
                      ? "收起系统测试记录"
                      : `已折叠 ${technicalMessageCount} 条系统测试记录 · 点击查看`}
                  </Button>
                </div>
              )}
              {messageItems.map((item) => (
                <article
                  className={`wechat-message ${item.isOwn ? "service-message" : "customer-message"}`}
                  key={item.clientMsgId ?? item.msgId}
                >
                  <Avatar className={item.isOwn ? "service-avatar" : "customer-avatar"}>
                    {item.isOwn ? "服" : "客"}
                  </Avatar>
                  <div className="wechat-message-main">
                    <div className="wechat-message-meta">
                      <b>
                        {item.isOwn ? item.senderPlatformUserId : `${item.senderPlatformUserId} · 外部客户`}
                      </b>
                      <time>
                        {new Date(item.sentAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </time>
                    </div>
                    <div className="wechat-bubble">{item.text}</div>
                    {item.isOwn && item.deliveryStatus && (
                      <div className={`delivery-state ${item.deliveryStatus}`}>
                        {deliveryLabel(item.deliveryStatus)}
                        {item.failCode ? ` · ${item.failCode}` : ""}
                      </div>
                    )}
                  </div>
                </article>
              ))}
              {currentRun?.status === "running" && (
                <article className="wechat-message service-message agent-typing-message">
                  <Avatar className="agent-avatar">AI</Avatar>
                  <div className="wechat-message-main">
                    <div className="wechat-message-meta">
                      <b>智能群助手</b>
                      <Tag color="processing">处理中</Tag>
                    </div>
                    <div className="wechat-bubble typing-bubble">
                      <i />
                      <i />
                      <i />
                    </div>
                  </div>
                </article>
              )}
            </div>
          )}
        </section>

        {admin && data && data.status === "active" && (
          <footer className="conversation-composer">
            {showDemoComposer ? (
              <div>
                <div className="demo-composer-label">
                  <span>
                    <b>演示模式</b> 模拟外部客户发消息，消息会经过网关并真实触发 Agent。
                  </span>
                </div>
                <div className="composer-line">
                  <div className="composer-text-item">
                    <Input.TextArea
                      autoSize={{ minRows: 1, maxRows: 3 }}
                      placeholder="输入客户问题，例如：今天有人值班吗？"
                      value={demoText}
                      onChange={(event) => setDemoText(event.target.value)}
                    />
                  </div>
                  <Button
                    type="primary"
                    disabled={!demoText.trim()}
                    loading={injectDemo.isPending}
                    onClick={() =>
                      injectDemo.mutate({ senderPlatformUserId: "customer-demo", text: demoText.trim() })
                    }
                  >
                    模拟发送
                  </Button>
                </div>
              </div>
            ) : (
              <Form form={sendForm} onFinish={(value) => send.mutate(value)}>
                <div className="composer-line">
                  <Form.Item name="accountId" rules={[{ required: true, message: "请选择发送账号" }]}>
                    <Select
                      placeholder="选择服务账号"
                      options={data.members
                        .filter((member) => member.accountId)
                        .map((member) => ({
                          label: `${member.accountId} · ${roleLabel(member.role)}`,
                          value: member.accountId!,
                        }))}
                    />
                  </Form.Item>
                  <Form.Item
                    name="text"
                    rules={[{ required: true, message: "请输入消息" }]}
                    className="composer-text-item"
                  >
                    <Input.TextArea
                      autoSize={{ minRows: 1, maxRows: 3 }}
                      placeholder="以服务账号身份回复群消息…"
                    />
                  </Form.Item>
                  <Button type="primary" htmlType="submit" loading={send.isPending}>
                    发送消息
                  </Button>
                </div>
                <small>消息会先写入可靠队列，再由网关异步发送。</small>
              </Form>
            )}
          </footer>
        )}
      </main>

      <aside className="chat-inspector">
        <div className="inspector-tabs" role="tablist" aria-label="群聊配置">
          <button
            className={inspectorTab === "agent" ? "active" : ""}
            onClick={() => setInspectorTab("agent")}
          >
            智能助手
          </button>
          <button
            className={inspectorTab === "automation" ? "active" : ""}
            onClick={() => setInspectorTab("automation")}
          >
            自动任务
            {data?.activeSequenceRunId && <i />}
          </button>
          <button
            className={inspectorTab === "members" ? "active" : ""}
            onClick={() => setInspectorTab("members")}
          >
            群成员
          </button>
        </div>

        {inspectorTab === "agent" && (
          <>
            <section className="inspector-section agent-console">
              <div className="inspector-title">
                <div>
                  <span className="agent-orb">AI</span>
                  <div>
                    <b>群聊 Agent</b>
                    <small>自动响应外部消息</small>
                  </div>
                </div>
                {data && admin && (
                  <Switch
                    checked={data.agentEnabled}
                    onChange={(agentEnabled) => patch.mutate({ agentEnabled })}
                  />
                )}
              </div>
              <div className={`agent-runtime-card ${currentRun?.status === "running" ? "running" : ""}`}>
                <div className="agent-runtime-head">
                  <span className="live-pulse" />
                  <b>
                    {currentRun?.status === "running"
                      ? "Agent 正在处理消息"
                      : data?.agentEnabled
                        ? "Agent 已待命"
                        : "Agent 已关闭"}
                  </b>
                  {currentRun && <StatusTag value={currentRun.status} />}
                </div>
                {currentRun ? (
                  <>
                    <p>{agentRunSummary(currentRun.summary, currentRun.endReason)}</p>
                    <div className="agent-mini-steps">
                      {currentRun.steps.slice(-4).map((step, index) => (
                        <button
                          key={`${step.toolUseId ?? step.kind}-${index}`}
                          onClick={() => setSelectedRun(currentRun.id)}
                        >
                          <i className={step.isError ? "error" : "done"}>{step.isError ? "!" : "✓"}</i>
                          <span>
                            <b>
                              {step.kind === "protocol_error"
                                ? "协议响应异常"
                                : (toolLabels[step.name ?? ""] ?? step.name ?? "生成最终回复")}
                            </b>
                            <small>{agentStepSummary(step.name, step.kind, step.isError)}</small>
                          </span>
                        </button>
                      ))}
                    </div>
                    <Button type="link" onClick={() => setSelectedRun(currentRun.id)}>
                      查看完整执行与审计 →
                    </Button>
                  </>
                ) : (
                  <p>收到外部客户消息后，这里会实时显示读取消息、工具调用、审计和回复过程。</p>
                )}
              </div>
              <div className="moderation-row">
                <span>
                  <b>自动成员管理</b>
                  <small>允许 Agent 按规则移除成员</small>
                </span>
                {data && admin && (
                  <Switch
                    size="small"
                    checked={data.autoKickEnabled}
                    disabled={!data.agentEnabled}
                    onChange={(autoKickEnabled) => patch.mutate({ autoKickEnabled })}
                  />
                )}
              </div>
            </section>

            <section className="inspector-section run-history">
              <div className="inspector-section-head">
                <b>最近 Agent 运行</b>
                <span>{runs.data?.length ?? 0} 次</span>
              </div>
              {(runs.data ?? []).slice(0, 4).map((item: AgentRun) => (
                <button key={item.id} onClick={() => setSelectedRun(item.id)}>
                  <span className="mono">{item.id.slice(0, 8)}</span>
                  <StatusTag value={item.status} />
                  <small>{agentRunSummary(item.summary, item.endReason)}</small>
                </button>
              ))}
            </section>
          </>
        )}

        {inspectorTab === "automation" && (
          <section className="inspector-section automation-console">
            <GroupAutomationPanel
              groupId={id}
              activeRunId={data?.activeSequenceRunId ?? null}
              readonly={!admin}
            />
          </section>
        )}

        {inspectorTab === "members" && (
          <>
            <section className="inspector-section">
              <div className="inspector-section-head">
                <b>群成员</b>
                <Tag>{data?.members.length ?? 0}</Tag>
              </div>
              <List
                className="compact-member-list"
                dataSource={data?.members ?? []}
                renderItem={(member) => (
                  <List.Item>
                    <List.Item.Meta
                      avatar={<Avatar>{member.accountId?.slice(-1) ?? "客"}</Avatar>}
                      title={member.accountId ?? member.platformUserId}
                      description={member.platformUserId}
                    />
                    <Tag
                      color={
                        member.role === "creator" ? "blue" : member.role === "admin" ? "purple" : "default"
                      }
                    >
                      {roleLabel(member.role)}
                    </Tag>
                  </List.Item>
                )}
              />
            </section>

            {admin && data?.status === "active" && (
              <Popconfirm
                title="确认让全部服务账号退出该群？"
                description="系统会保证群主最后退出。"
                okText="确认退群"
                cancelText="取消"
                onConfirm={() => leaveAll.mutate()}
              >
                <Button danger block loading={leaveAll.isPending}>
                  全员退出群聊
                </Button>
              </Popconfirm>
            )}
          </>
        )}
      </aside>

      <Drawer
        width={680}
        title={`Agent 运行 ${selectedRun?.slice(0, 8) ?? ""}`}
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
                  <div className="agent-drawer-step">
                    <b>
                      {index + 1}. {toolLabels[step.name ?? ""] ?? step.name ?? step.kind}
                    </b>
                    <p>{step.resultSummary || "—"}</p>
                    <Descriptions
                      size="small"
                      column={1}
                      items={[
                        {
                          key: "input",
                          label: "输入",
                          children: <pre>{JSON.stringify(step.input, null, 2)}</pre>,
                        },
                        { key: "audit", label: "审计", children: step.auditVerdict ?? "—" },
                        { key: "error", label: "错误码", children: step.errorCode ?? "—" },
                      ]}
                    />
                    {step.kind === "protocol_error" && (
                      <details>
                        <summary>查看原始响应</summary>
                        <pre>{step.rawResponse}</pre>
                      </details>
                    )}
                  </div>
                ),
              }))}
            />
          </>
        )}
      </Drawer>
      <CreateGroupModal open={createGroupOpen} onClose={() => setCreateGroupOpen(false)} />
    </div>
  );
}

function deliveryLabel(status: string): string {
  return (
    {
      queued: "排队中",
      accepted: "网关已受理",
      sent: "已送达",
      failed: "发送失败",
      unknown: "结果确认中",
      cancelled: "已取消",
    }[status] ?? status
  );
}

function roleLabel(role: string): string {
  return { creator: "群主", admin: "管理员", member: "成员" }[role] ?? role;
}

function isTechnicalTrigger(senderPlatformUserId: string, text: string): boolean {
  return (
    senderPlatformUserId.startsWith("experiment-user-") || /^\[(?:s\d+_|agent_happy|S\d+\s*实验)/i.test(text)
  );
}

function agentRunSummary(summary: string | null, endReason: string | null): string {
  const value = summary ?? endReason;
  return (
    {
      "Responded to the latest group message": "已读取客户消息并完成自动回复",
      "Recovered from protocol errors": "Agent 异常响应已恢复",
      "Idempotent retry completed": "消息重试成功，未重复发送",
      final: "本轮处理已完成",
    }[value ?? ""] ??
    (value || "正在执行工具调用链…")
  );
}

function agentStepSummary(name: string | null, kind: string, isError: boolean): string {
  if (isError) return "本步骤发生异常，点击查看详情";
  if (kind === "protocol_error") return "已记录异常响应并继续处理";
  return (
    {
      get_recent_messages: "已获取群聊上下文",
      send_message: "回复已进入可靠发送队列",
      kick_user: "成员操作已执行",
      finish: "本轮处理完成",
    }[name ?? ""] ?? "步骤已完成"
  );
}
