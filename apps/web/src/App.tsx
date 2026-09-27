import { lazy, Suspense, type ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { getToken } from "./api/client";
import { AppShell } from "./components/AppShell";
import { LiveUpdates } from "./components/LiveUpdates";

function Page({ children }: { children: ReactNode }) {
  return <Suspense fallback={<div className="page-loading">正在载入…</div>}>{children}</Suspense>;
}

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
    <Routes>
      <Route
        path="/login"
        element={
          <Suspense fallback={<div className="route-loading">正在载入控制台…</div>}>
            <LoginPage />
          </Suspense>
        }
      />
      <Route element={<Protected />}>
        <Route
          path="/"
          element={
            <Page>
              <DashboardPage />
            </Page>
          }
        />
        <Route
          path="/groups/:id"
          element={
            <Page>
              <GroupPage />
            </Page>
          }
        />
        <Route
          path="/reliability-lab"
          element={
            <Page>
              <ReliabilityLabPage />
            </Page>
          }
        />
        <Route
          path="/sequences"
          element={
            <Page>
              <SequencePage />
            </Page>
          }
        />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
