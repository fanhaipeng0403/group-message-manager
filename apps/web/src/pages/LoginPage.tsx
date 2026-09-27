import { useState } from "react";
import { Alert, Button, Form, Input, Typography } from "antd";
import { useNavigate } from "react-router-dom";
import { client, setToken } from "../api/client";

export function LoginPage() {
  const navigate = useNavigate();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const submit = async (value: { username: string; password: string }) => {
    setLoading(true);
    setError(undefined);
    try {
      const result = await client.login(value.username, value.password);
      setToken(result.accessToken);
      navigate("/");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "登录失败");
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="login-page">
      <section className="login-story">
        <div className="brand inverse">
          <span className="brand-mark">R</span>
          <span>RelayOps</span>
        </div>
        <Typography.Title>
          让不可靠的外部世界，
          <br />
          拥有可靠的操作界面。
        </Typography.Title>
        <Typography.Paragraph>
          统一管理服务账号、群组时间线与 Agent 执行过程。每一次状态变化都有记录，每一次异常都可以追踪。
        </Typography.Paragraph>
        <div className="signal-grid">
          <span>SSE INBOX</span>
          <span>DURABLE OUTBOX</span>
          <span>AGENT AUDIT</span>
          <span>LIVE EVENTS</span>
        </div>
        <div className="login-proof">
          <div>
            <strong>01</strong>
            <span>
              Exactly-once effects<small>幂等副作用</small>
            </span>
          </div>
          <div>
            <strong>02</strong>
            <span>
              Restart safe<small>重启可恢复</small>
            </span>
          </div>
          <div>
            <strong>03</strong>
            <span>
              Evidence driven<small>故障可证明</small>
            </span>
          </div>
        </div>
      </section>
      <section className="login-panel">
        <div className="login-card">
          <Typography.Text type="secondary">OPERATOR CONSOLE</Typography.Text>
          <Typography.Title level={2}>登录控制台</Typography.Title>
          <Typography.Paragraph type="secondary">演示账号：admin/admin 或 viewer/viewer</Typography.Paragraph>
          {error && <Alert type="error" message={error} showIcon />}
          <Form layout="vertical" onFinish={submit} initialValues={{ username: "admin", password: "admin" }}>
            <Form.Item label="用户名" name="username" rules={[{ required: true }]}>
              <Input size="large" />
            </Form.Item>
            <Form.Item label="密码" name="password" rules={[{ required: true }]}>
              <Input.Password size="large" />
            </Form.Item>
            <Button type="primary" htmlType="submit" size="large" loading={loading} block>
              进入 RelayOps
            </Button>
          </Form>
        </div>
      </section>
    </div>
  );
}
