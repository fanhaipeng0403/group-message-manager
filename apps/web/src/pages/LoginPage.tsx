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
      <div className="login-card">
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
            进入管理平台
          </Button>
        </Form>
      </div>
    </div>
  );
}
