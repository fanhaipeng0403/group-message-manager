import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Form, Modal, Select, message } from "antd";
import { client } from "../api/client";

export function CreateGroupModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [form] = Form.useForm();
  const creatorAccountId = Form.useWatch("creatorAccountId", form);
  const [jobId, setJobId] = useState<string>();
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: client.accounts });
  const job = useQuery({
    queryKey: ["job", jobId],
    queryFn: () => client.job(jobId!),
    enabled: Boolean(jobId),
    refetchInterval: (query) => (query.state.data?.status === "running" ? 500 : false),
  });
  const onlineAccounts = useMemo(
    () => accounts.data?.filter((account) => account.status === "online") ?? [],
    [accounts.data],
  );
  const create = useMutation({
    mutationFn: (value: { creatorAccountId: string; memberAccountIds: string[] }) =>
      client.createGroup(value.creatorAccountId, value.memberAccountIds),
    onSuccess: ({ jobId: createdJobId }) => {
      setJobId(createdJobId);
      form.resetFields();
      onClose();
      void message.success("建群任务已提交，完成后会出现在左侧会话列表");
    },
    onError: (error: Error) => void message.error(error.message),
  });

  useEffect(() => {
    if (job.data?.status === "finished") {
      void queryClient.invalidateQueries({ queryKey: ["groups"] });
    }
    if (job.data?.status === "failed") {
      void message.error("建群任务失败，请到运行总览查看账号状态");
    }
  }, [job.data?.status, queryClient]);

  return (
    <Modal
      title="新建群聊"
      open={open}
      onCancel={() => {
        form.resetFields();
        onClose();
      }}
      footer={null}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" onFinish={(value) => create.mutate(value)}>
        <Form.Item
          label="群主账号"
          name="creatorAccountId"
          rules={[{ required: true, message: "请选择群主账号" }]}
        >
          <Select
            placeholder="选择一个在线账号作为群主"
            options={onlineAccounts.map((account) => ({
              label: `${account.displayName} · ${account.id.slice(0, 12)}`,
              value: account.id,
            }))}
            onChange={(nextCreatorId) => {
              const members = (form.getFieldValue("memberAccountIds") as string[] | undefined) ?? [];
              form.setFieldValue(
                "memberAccountIds",
                members.filter((accountId) => accountId !== nextCreatorId),
              );
            }}
          />
        </Form.Item>
        <Form.Item
          label="受邀成员（第一个成员将成为管理员）"
          name="memberAccountIds"
          rules={[{ required: true, message: "请至少选择一个成员" }]}
        >
          <Select
            mode="multiple"
            placeholder="选择其他在线账号"
            options={onlineAccounts
              .filter((account) => account.id !== creatorAccountId)
              .map((account) => ({
                label: `${account.displayName} · ${account.id.slice(0, 12)}`,
                value: account.id,
              }))}
          />
        </Form.Item>
        <Button type="primary" htmlType="submit" block loading={create.isPending}>
          创建群聊
        </Button>
      </Form>
    </Modal>
  );
}
