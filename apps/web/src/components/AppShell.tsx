import { Button, Layout, Space, Tag } from "antd";
import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { API_URL, clearToken, client, currentRole } from "../api/client";

export function AppShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const role = currentRole();
  const health = useQuery({
    queryKey: ["health"],
    queryFn: client.health,
    retry: false,
    refetchInterval: 30_000,
  });
  const active = location.pathname.startsWith("/reliability-lab")
    ? "lab"
    : location.pathname.startsWith("/sequences")
      ? "sequences"
      : "overview";
  return (
    <Layout className="app-shell">
      <header className="topbar">
        <div className="topbar-inner">
          <Link to="/" className="brand">
            <span className="brand-mark">
              <i />
            </span>
            <span>
              <b>RelayOps</b>
              <small>CONTROL PLANE</small>
            </span>
          </Link>
          <nav className="main-nav" aria-label="主导航">
            <Link to="/" className={active === "overview" ? "active" : ""}>
              运行总览
            </Link>
            <Link to="/reliability-lab" className={active === "lab" ? "active" : ""}>
              可靠性实验室
            </Link>
            <Link to="/sequences" className={active === "sequences" ? "active" : ""}>
              定时序列
            </Link>
            <a href={`${API_URL}/docs`} target="_blank" rel="noreferrer">
              API 文档 <span>↗</span>
            </a>
          </nav>
          <Space className="topbar-actions" size={12}>
            <span className={`system-live ${health.isError ? "degraded" : ""}`}>
              <i /> {health.isSuccess ? "CONTROL LIVE" : health.isError ? "DEGRADED" : "CHECKING"}
            </span>
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
