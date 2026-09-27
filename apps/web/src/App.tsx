import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { getToken } from "./api/client";
import { AppShell } from "./components/AppShell";
import { LiveUpdates } from "./components/LiveUpdates";

const DashboardPage = lazy(() =>
  import("./pages/DashboardPage").then((module) => ({ default: module.DashboardPage })),
);
const GroupPage = lazy(() => import("./pages/GroupPage").then((module) => ({ default: module.GroupPage })));
const LoginPage = lazy(() => import("./pages/LoginPage").then((module) => ({ default: module.LoginPage })));
const ReliabilityLabPage = lazy(() =>
  import("./pages/ReliabilityLabPage").then((module) => ({ default: module.ReliabilityLabPage })),
);
const SequencePage = lazy(() =>
  import("./pages/SequencePage").then((module) => ({ default: module.SequencePage })),
);

function Protected() {
  return getToken() ? (
    <>
      <LiveUpdates />
      <AppShell />
    </>
  ) : (
    <Navigate to="/login" replace />
  );
}

export function App() {
  return (
    <Suspense fallback={<div className="route-loading">正在载入控制台…</div>}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<Protected />}>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/groups/:id" element={<GroupPage />} />
          <Route path="/reliability-lab" element={<ReliabilityLabPage />} />
          <Route path="/sequences" element={<SequencePage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
