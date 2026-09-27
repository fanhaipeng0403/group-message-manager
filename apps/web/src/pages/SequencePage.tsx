import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Alert, Button, Card, Form, Input, Modal, Progress, Select, Space, Table, Tag, message } from "antd";
import { ApiError, client, currentRole, type Sequence } from "../api/client";
import { StatusTag } from "../components/StatusTag";

interface PreviewRow {
  index: number;
  text: string;
  values: string;
  sources: string;
}

function preview(
  sequence: Sequence,
  vars: Record<string, string>,
  stepVars: Record<string, Record<string, string>>,
): PreviewRow[] {
  const values = Object.fromEntries(Object.entries(vars).filter(([, value]) => value !== ""));
  const sources = Object.fromEntries(Object.keys(values).map((key) => [key, "default"]));
  return [...sequence.steps]
    .sort((a, b) => a.index - b.index)
    .map((step) => {
      for (const [key, value] of Object.entries(stepVars[String(step.index)] ?? {})) {
        if (value !== "") {
          values[key] = value;
          sources[key] = `step:${step.index}`;
        }
      }
      const keys = [...step.text.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1]!);
      const missing = keys.find((key) => !values[key]);
      if (missing) throw new Error(`第 ${step.index} 步缺少变量：${missing}`);
      return {
        index: step.index,
        text: step.text.replace(/\{([A-Za-z0-9_]+)\}/g, (_match, key: string) => values[key]!),
        values: keys.map((key) => `${key}=${values[key]}`).join(" · "),
        sources: keys.map((key) => `${key}:${sources[key]}`).join(" · "),
      };
    });
}

export function SequencePage() {
  const admin = currentRole() === "admin";
  const groups = useQuery({ queryKey: ["groups"], queryFn: client.groups, refetchInterval: 30_000 });
  const sequences = useQuery({ queryKey: ["sequences"], queryFn: client.sequences });
  const [groupId, setGroupId] = useState<string>();
  const [runId, setRunId] = useState<string>();
  const [pending, setPending] = useState<{
    sequenceId: string;
    vars: Record<string, string>;
    stepVars: Record<string, Record<string, string>>;
    rows: PreviewRow[];
  }>();
  const activeGroups = useMemo(
    () => groups.data?.filter((group) => group.status === "active") ?? [],
    [groups.data],
  );
  const selectedGroupId = groupId ?? activeGroups[0]?.id;
  const selectedGroup = activeGroups.find((group) => group.id === selectedGroupId);
  const selectedRunId = runId ?? selectedGroup?.activeSequenceRunId;
  const run = useQuery({
    queryKey: ["sequence-run", selectedRunId],
    queryFn: () => client.sequenceRun(selectedRunId!),
    enabled: Boolean(selectedRunId),
    refetchInterval: (query) => (query.state.data?.status === "running" ? 30_000 : false),
  });
  const start = useMutation({
    mutationFn: () => client.startSequence(selectedGroupId!, pending!),
    onSuccess: ({ runId: created }) => {
      setRunId(created);
      setPending(undefined);
      void message.success("序列已启动");
    },
    onError: (error: Error) => {
      const detail =
        error instanceof ApiError
          ? `（stepIndex=${String(error.body.error.stepIndex ?? "-")}，key=${String(error.body.error.key ?? "-")}）`
          : "";
      void message.error(`${error.message}${detail}`);
    },
  });
  const completed = run.data?.steps.filter((step) => ["sent", "skipped"].includes(step.status)).length ?? 0;
  const total = run.data?.steps.length ?? 0;

  return (
    <>
      {!admin && (
        <Alert className="viewer-alert" type="info" showIcon message="当前为只读查看者，不能启动序列。" />
      )}
      <Card className="section-card premium-card" title="启动定时序列">
        <Form
          layout="vertical"
          initialValues={{
            vars: '{\n  "event": "产品发布会",\n  "time": "20:00",\n  "location": "共享盘"\n}',
            stepVars: "{}",
          }}
          onFinish={(form) => {
            try {
              const sequence = sequences.data?.find((item) => item.id === form.sequenceId);
              if (!sequence) throw new Error("请选择序列");
              const vars = JSON.parse(form.vars) as Record<string, string>;
              const stepVars = JSON.parse(form.stepVars) as Record<string, Record<string, string>>;
              setPending({
                sequenceId: sequence.id,
                vars,
                stepVars,
                rows: preview(sequence, vars, stepVars),
              });
            } catch (error) {
              void message.error(error instanceof Error ? error.message : "变量 JSON 无效");
            }
          }}
        >
          <Space align="start" wrap size={16} style={{ width: "100%" }}>
            <Form.Item label="目标群组">
              <Select
                value={selectedGroupId}
                onChange={(value) => {
                  setGroupId(value);
                  setRunId(undefined);
                }}
                style={{ width: 260 }}
                options={activeGroups.map((group) => ({
                  value: group.id,
                  label: `Group ${group.id.slice(0, 8)}`,
                }))}
              />
            </Form.Item>
            <Form.Item label="消息序列" name="sequenceId" rules={[{ required: true }]}>
              <Select
                style={{ width: 260 }}
                options={
                  sequences.data?.map((sequence) => ({ value: sequence.id, label: sequence.name })) ?? []
                }
              />
            </Form.Item>
          </Space>
          <Form.Item label="vars" name="vars" rules={[{ required: true }]}>
            <Input.TextArea rows={6} className="mono" />
          </Form.Item>
          <Form.Item label="stepVars" name="stepVars" rules={[{ required: true }]}>
            <Input.TextArea rows={4} className="mono" />
          </Form.Item>
          <Button type="primary" htmlType="submit" disabled={!admin || !selectedGroupId}>
            预检并启动
          </Button>
        </Form>
      </Card>
      {run.data && (
        <Card
          className="section-card premium-card"
          title={
            <Space>
              运行进度 <StatusTag value={run.data.status} />
            </Space>
          }
        >
          <Progress percent={total ? Math.round((completed / total) * 100) : 0} />
          <Table
            pagination={false}
            rowKey="index"
            dataSource={run.data.steps}
            columns={[
              { title: "步骤", dataIndex: "index" },
              { title: "状态", dataIndex: "status", render: (value) => <StatusTag value={value} /> },
              {
                title: "计划时间",
                dataIndex: "scheduledAt",
                render: (value) => (value ? new Date(value).toLocaleTimeString() : "—"),
              },
              {
                title: "变量来源",
                dataIndex: "varSources",
                render: (value) => (
                  <Space wrap>
                    {Object.entries(value).map(([key, source]) => (
                      <Tag key={key}>
                        {key} · {String(source)}
                      </Tag>
                    ))}
                  </Space>
                ),
              },
            ]}
          />
        </Card>
      )}
      <Modal
        title="变量预检"
        open={Boolean(pending)}
        onCancel={() => setPending(undefined)}
        onOk={() => start.mutate()}
        confirmLoading={start.isPending}
        okText="确认启动"
      >
        <Table
          size="small"
          pagination={false}
          rowKey="index"
          dataSource={pending?.rows ?? []}
          columns={[
            { title: "步骤", dataIndex: "index", width: 64 },
            { title: "最终文本", dataIndex: "text" },
            { title: "取值", dataIndex: "values" },
            { title: "来源", dataIndex: "sources" },
          ]}
        />
      </Modal>
    </>
  );
}
