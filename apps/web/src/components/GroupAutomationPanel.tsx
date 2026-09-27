import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Empty, Input, Modal, Progress, Select, Tag, message } from "antd";
import { ApiError, client, type Sequence } from "../api/client";
import { buildSequencePreview, UnresolvedVariableError, type SequencePreviewStep } from "./sequence-preview";
import { StatusTag } from "./StatusTag";

const variableLabels: Record<string, string> = {
  event: "活动名称",
  time: "开始时间",
  location: "资料位置",
  operator: "负责人",
};

interface PreflightIssue {
  stepIndex: number;
  key: string;
}

export function GroupAutomationPanel({
  groupId,
  activeRunId,
  readonly,
}: {
  groupId: string;
  activeRunId: string | null;
  readonly: boolean;
}) {
  const queryClient = useQueryClient();
  const sequences = useQuery({ queryKey: ["sequences"], queryFn: client.sequences });
  const [sequenceId, setSequenceId] = useState<string>();
  const [runId, setRunId] = useState<string>();
  const [values, setValues] = useState<Record<string, string>>({});
  const [stepValues, setStepValues] = useState<Record<string, Record<string, string>>>({});
  const [previewSteps, setPreviewSteps] = useState<SequencePreviewStep[]>();
  const [preflightIssue, setPreflightIssue] = useState<PreflightIssue>();
  const selected = sequences.data?.find((sequence) => sequence.id === sequenceId) ?? sequences.data?.[0];
  const selectedRunId = runId ?? activeRunId;
  const run = useQuery({
    queryKey: ["sequence-run", selectedRunId],
    queryFn: () => client.sequenceRun(selectedRunId!),
    enabled: Boolean(selectedRunId),
    refetchInterval: (query) => (query.state.data?.status === "running" ? 1_000 : false),
  });
  const variables = useMemo(() => extractVariables(selected), [selected]);
  const start = useMutation({
    mutationFn: () =>
      client.startSequence(groupId, {
        sequenceId: selected!.id,
        vars: values,
        stepVars: stepValues,
      }),
    onSuccess: ({ runId: createdRunId }) => {
      setRunId(createdRunId);
      setPreviewSteps(undefined);
      void queryClient.invalidateQueries({ queryKey: ["group", groupId] });
      void message.success("自动任务已启动，发送结果会出现在群聊中");
    },
    onError: (error: Error) => {
      if (error instanceof ApiError && error.body.error.code === "UNRESOLVED_PLACEHOLDER") {
        const issue = {
          stepIndex: Number(error.body.error.stepIndex),
          key: String(error.body.error.key),
        };
        setPreflightIssue(issue);
        setPreviewSteps(undefined);
        void message.error(`预检未通过：第 ${issue.stepIndex} 步缺少变量 ${issue.key}`);
        return;
      }
      void message.error(error.message);
    },
  });
  const completed = run.data?.steps.filter((step) => ["sent", "skipped"].includes(step.status)).length ?? 0;
  const total = run.data?.steps.length ?? 0;

  if (!sequences.isLoading && !sequences.data?.length) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有可用的自动任务模板" />;
  }

  return (
    <div className="automation-panel">
      <div className="automation-intro">
        <span className="automation-icon">⏱</span>
        <div>
          <b>群聊自动任务</b>
          <small>按预设步骤自动发送群消息</small>
        </div>
      </div>

      {run.data && (
        <div className="automation-run-card">
          <div className="automation-run-head">
            <b>{run.data.status === "running" ? "任务正在执行" : "最近一次任务"}</b>
            <StatusTag value={run.data.status} />
          </div>
          <Progress
            size="small"
            percent={total ? Math.round((completed / total) * 100) : 0}
            {...(run.data.status === "failed" ? { status: "exception" as const } : {})}
          />
          <div className="automation-progress-steps">
            {run.data.steps.map((step) => (
              <div key={step.index}>
                <i className={step.status}>{["sent", "skipped"].includes(step.status) ? "✓" : step.index}</i>
                <span>
                  <b>第 {step.index} 步</b>
                  <small>{stepStatusLabel(step.status)}</small>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <label className="automation-field-label">选择任务模板</label>
      <Select
        value={selected?.id}
        placeholder="选择一个任务模板"
        onChange={(value) => {
          setSequenceId(value);
          setValues({});
          setStepValues({});
          setPreflightIssue(undefined);
        }}
        options={(sequences.data ?? []).map((sequence) => ({ value: sequence.id, label: sequence.name }))}
      />

      {selected && (
        <>
          <div className="automation-step-list">
            {[...selected.steps]
              .sort((a, b) => a.index - b.index)
              .map((step) => (
                <div className="automation-step" key={step.index}>
                  <span>{step.index}</span>
                  <div>
                    <b>{step.accountRole === "admin" ? "管理员账号" : "成员账号"}</b>
                    <p>{step.text}</p>
                    <small>{step.delaySeconds ? `等待 ${step.delaySeconds} 秒后发送` : "立即发送"}</small>
                  </div>
                </div>
              ))}
          </div>

          {variables.length > 0 && (
            <div className="automation-variables">
              <div className="automation-section-title">
                <b>填写本次任务内容</b>
                <span>{variables.length} 项</span>
              </div>
              {variables.map((key) => (
                <label key={key}>
                  <span>{variableLabels[key] ?? key}</span>
                  <Input
                    value={values[key] ?? ""}
                    placeholder={`请输入${variableLabels[key] ?? key}`}
                    onChange={(event) => setValues((current) => ({ ...current, [key]: event.target.value }))}
                  />
                </label>
              ))}
            </div>
          )}

          {variables.length > 0 && (
            <details className="automation-overrides">
              <summary>
                <span>
                  <b>按步骤覆盖内容</b>
                  <small>从指定步骤起使用新的变量值</small>
                </span>
                <Tag>高级设置</Tag>
              </summary>
              <Alert
                type="info"
                showIcon
                message="留空表示沿用公共内容；填写后，从该步骤开始的后续步骤都会使用新值。"
              />
              <div className="automation-override-steps">
                {[...selected.steps]
                  .sort((a, b) => a.index - b.index)
                  .map((step) => (
                    <section key={step.index}>
                      <div>
                        <b>第 {step.index} 步</b>
                        <span>{step.accountRole === "admin" ? "管理员账号" : "成员账号"}</span>
                      </div>
                      {variables.map((key) => (
                        <label key={key}>
                          <span>{variableLabels[key] ?? key}</span>
                          <Input
                            value={stepValues[String(step.index)]?.[key] ?? ""}
                            placeholder="留空则沿用"
                            onChange={(event) =>
                              setStepValues((current) => ({
                                ...current,
                                [String(step.index)]: {
                                  ...current[String(step.index)],
                                  [key]: event.target.value,
                                },
                              }))
                            }
                          />
                        </label>
                      ))}
                    </section>
                  ))}
              </div>
            </details>
          )}

          {preflightIssue && (
            <Alert
              type="error"
              showIcon
              closable
              onClose={() => setPreflightIssue(undefined)}
              message={`预检未通过：第 ${preflightIssue.stepIndex} 步缺少变量 ${preflightIssue.key}`}
              description="请在公共内容中填写该变量，或在对应步骤的高级设置里提供覆盖值。"
            />
          )}

          <Button
            type="primary"
            block
            disabled={readonly || Boolean(activeRunId)}
            onClick={() => {
              try {
                setPreviewSteps(buildSequencePreview(selected, values, stepValues));
                setPreflightIssue(undefined);
              } catch (error) {
                if (error instanceof UnresolvedVariableError) {
                  setPreflightIssue({ stepIndex: error.stepIndex, key: error.key });
                  return;
                }
                throw error;
              }
            }}
          >
            {activeRunId ? "当前已有任务运行中" : "预览并启动任务"}
          </Button>
        </>
      )}

      <Modal
        title="确认自动发送内容"
        open={Boolean(previewSteps)}
        onCancel={() => setPreviewSteps(undefined)}
        onOk={() => start.mutate()}
        confirmLoading={start.isPending}
        okText="确认启动"
        cancelText="返回修改"
        width={620}
      >
        <Alert type="info" showIcon message="确认后将按以下顺序向当前群发送消息" />
        <div className="automation-preview-list">
          {(previewSteps ?? []).map((step) => (
            <div key={step.index}>
              <span>第 {step.index} 步</span>
              <Tag>{step.role}</Tag>
              <p>{step.text}</p>
              <small>{step.delaySeconds ? `上一条消息后等待 ${step.delaySeconds} 秒` : "立即发送"}</small>
              <div className="automation-preview-vars">
                {step.variables.map((variable) => (
                  <div key={variable.key}>
                    <span>{variableLabels[variable.key] ?? variable.key}</span>
                    <b>{variable.value}</b>
                    <Tag color={variable.source === "default" ? "blue" : "purple"}>{variable.source}</Tag>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Modal>
    </div>
  );
}

function extractVariables(sequence?: Sequence): string[] {
  if (!sequence) return [];
  return [
    ...new Set(
      sequence.steps.flatMap((step) =>
        [...step.text.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1]!),
      ),
    ),
  ];
}

function stepStatusLabel(status: string): string {
  return (
    { pending: "等待执行", accepted: "网关已受理", sent: "发送成功", skipped: "已跳过", failed: "发送失败" }[
      status
    ] ?? status
  );
}
