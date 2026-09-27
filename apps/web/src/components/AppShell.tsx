import { Button, Layout, Space, Tag } from "antd";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { clearToken, client, currentRole } from "../api/client";

export function AppShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const role = currentRole();
  const active = location.pathname.startsWith("/reliability-lab")
    ? "lab"
    : location.pathname.startsWith("/overview")
      ? "overview"
      : "conversations";
  return (
    <Layout className="app-shell">
      <header className="topbar">
        <div className="topbar-inner">
          <Link to="/" className="brand">
            <span className="brand-mark">
              <i />
            </span>
            <span>
              <b>多账号群组消息平台</b>
            </span>
          </Link>
          <nav className="main-nav" aria-label="主导航">
            <Link to="/overview" className={active === "overview" ? "active" : ""}>
              运行总览
            </Link>
            <Link to="/" className={active === "conversations" ? "active" : ""}>
              群组与会话
            </Link>
            <Link to="/reliability-lab" className={active === "lab" ? "active" : ""}>
              系统验证
            </Link>
          </nav>
          <Space className="topbar-actions" size={12}>
            <Tag className="role-tag" color={role === "admin" ? "blue" : "default"}>
              {role}
            </Tag>
            <Button
              className="logout-button"
              type="text"
              onClick={() => {
                void client
                  .logout()
                  .catch(() => undefined)
                  .finally(() => {
                    clearToken();
                    navigate("/login");
                  });
              }}
            >
              退出
            </Button>
          </Space>
        </div>
      </header>
      <main className="main-content">
        <Outlet />
      </main>
    </Layout>
  );
}
