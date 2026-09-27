const API = process.env.API_URL ?? "http://localhost:3000";
const GATEWAY = process.env.GATEWAY_URL ?? "http://localhost:4001";
const AGENT = process.env.AGENT_URL ?? "http://localhost:4002";
const scenario = process.argv[2] ?? "smoke";

async function json(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(body)}`);
  return body;
}

const login = await json(`${API}/api/auth/login`, {
  method: "POST",
  body: JSON.stringify({ username: "admin", password: "admin" }),
});
const auth = { authorization: `Bearer ${login.accessToken}` };
const call = (path, init = {}) => json(`${API}${path}`, { ...init, headers: { ...auth, ...init.headers } });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function prepare() {
  for (const id of ["account-1", "account-2"]) {
    const accounts = await call("/api/accounts");
    const account = accounts.find((item) => item.id === id);
    if (["idle", "disconnected"].includes(account.status))
      await call(`/api/accounts/${id}/connect`, { method: "POST" });
  }
  const existing = await call("/api/groups");
  if (existing[0]) return existing[0];
  const job = await call("/api/groups", {
    method: "POST",
    body: JSON.stringify({ creatorAccountId: "account-1", memberAccountIds: ["account-2"] }),
  });
  for (let attempt = 0; attempt < 60; attempt++) {
    const status = await call(`/api/jobs/${job.jobId}`);
    if (status.status === "finished") return (await call("/api/groups"))[0];
    if (status.status === "failed") throw new Error(`Group job failed: ${JSON.stringify(status)}`);
    await wait(200);
  }
  throw new Error("Group creation timed out");
}

const group = await prepare();
if (scenario === "agent") {
  await json(`${GATEWAY}/__control`, {
    method: "POST",
    body: JSON.stringify({ duplicateEvents: false, sendMode: "success" }),
  });
  await json(`${AGENT}/__control`, { method: "POST", body: JSON.stringify({ mode: "normal" }) });
  await call(`/api/groups/${group.id}`, { method: "PATCH", body: JSON.stringify({ agentEnabled: true }) });
  const previousRunIds = new Set((await call(`/api/groups/${group.id}/agent-runs`)).map((run) => run.id));
  await json(`${GATEWAY}/__control/groups/${group.gatewayGroupId}/inbound`, {
    method: "POST",
    body: JSON.stringify({ senderPlatformUserId: "external-user-1", text: "请问今天有人值班吗？" }),
  });
  for (let attempt = 0; attempt < 80; attempt++) {
    const runs = await call(`/api/groups/${group.id}/agent-runs`);
    const createdRun = runs.find((run) => !previousRunIds.has(run.id));
    if (createdRun?.status === "finished") {
      const detail = await call(`/api/agent-runs/${createdRun.id}`);
      if (detail.steps.length < 3)
        throw new Error(`Expected at least 3 Agent steps, found ${detail.steps.length}`);
      console.log(
        JSON.stringify(
          {
            scenario,
            passed: true,
            runId: detail.id,
            status: detail.status,
            endReason: detail.endReason,
            steps: detail.steps.map((step) => step.name ?? step.kind),
          },
          null,
          2,
        ),
      );
      process.exit(0);
    }
    if (createdRun && ["failed", "blocked", "cancelled"].includes(createdRun.status))
      throw new Error(`Agent run ended unexpectedly: ${JSON.stringify(createdRun)}`);
    await wait(250);
  }
  throw new Error("Agent run did not finish");
} else if (scenario === "s6") {
  await json(`${GATEWAY}/__control`, {
    method: "POST",
    body: JSON.stringify({ duplicateEvents: false, sendMode: "success" }),
  });
  await json(`${AGENT}/__control`, { method: "POST", body: JSON.stringify({ mode: "bad_json_once" }) });
  await call(`/api/groups/${group.id}`, { method: "PATCH", body: JSON.stringify({ agentEnabled: true }) });
  const previousRunIds = new Set((await call(`/api/groups/${group.id}/agent-runs`)).map((run) => run.id));
  await json(`${GATEWAY}/__control/groups/${group.gatewayGroupId}/inbound`, {
    method: "POST",
    body: JSON.stringify({ senderPlatformUserId: "external-user-s6", text: "触发一次坏响应测试" }),
  });
  for (let attempt = 0; attempt < 80; attempt++) {
    const runs = await call(`/api/groups/${group.id}/agent-runs`);
    const createdRun = runs.find((run) => !previousRunIds.has(run.id));
    const detail = createdRun ? await call(`/api/agent-runs/${createdRun.id}`) : undefined;
    if (detail?.status === "finished") {
      if (!detail.steps.some((step) => step.kind === "protocol_error" && step.errorCode === "BAD_JSON"))
        throw new Error("BAD_JSON protocol step was not recorded");
      console.log(
        JSON.stringify(
          {
            scenario,
            passed: true,
            runId: detail.id,
            status: detail.status,
            steps: detail.steps.map((step) => ({
              kind: step.kind,
              name: step.name,
              errorCode: step.errorCode,
            })),
          },
          null,
          2,
        ),
      );
      process.exit(0);
    }
    await wait(250);
  }
  throw new Error("S6 Agent run did not finish");
} else if (scenario === "s2")
  await json(`${GATEWAY}/__control`, {
    method: "POST",
    body: JSON.stringify({ duplicateEvents: true, sendMode: "success", messageBeforeSent: false }),
  });
else if (scenario === "s3")
  await json(`${GATEWAY}/__control`, {
    method: "POST",
    body: JSON.stringify({ duplicateEvents: false, sendMode: "success", messageBeforeSent: true }),
  });
else if (scenario === "s4")
  await json(`${GATEWAY}/__control`, {
    method: "POST",
    body: JSON.stringify({ duplicateEvents: false, sendMode: "rate_limited", rateLimitSeconds: 2 }),
  });
else if (scenario === "s5")
  await json(`${GATEWAY}/__control`, {
    method: "POST",
    body: JSON.stringify({ duplicateEvents: false, sendMode: "timeout_sent" }),
  });
else
  await json(`${GATEWAY}/__control`, {
    method: "POST",
    body: JSON.stringify({ duplicateEvents: false, sendMode: "success", messageBeforeSent: false }),
  });

const sent = await call(`/api/groups/${group.id}/send`, {
  method: "POST",
  body: JSON.stringify({ accountId: "account-1", text: `scenario-${scenario}-${Date.now()}` }),
});
for (let attempt = 0; attempt < 60; attempt++) {
  const timeline = await call(`/api/groups/${group.id}/messages`);
  const matches = timeline.items.filter((item) => item.clientMsgId === sent.clientMsgId);
  if (matches[0]?.deliveryStatus === "sent") {
    if (matches.length !== 1) throw new Error(`Expected one timeline row, found ${matches.length}`);
    console.log(
      JSON.stringify(
        {
          scenario,
          passed: true,
          clientMsgId: sent.clientMsgId,
          deliveryStatus: "sent",
          timelineRows: matches.length,
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }
  if (matches[0]?.deliveryStatus === "failed") throw new Error(`Message failed: ${matches[0].failCode}`);
  await wait(250);
}
throw new Error("Message did not reach sent state");
