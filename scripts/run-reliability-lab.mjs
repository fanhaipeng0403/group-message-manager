const API = process.env.API_URL ?? "http://localhost:3000";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function json(path, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(body)}`);
  return body;
}

const login = await json("/api/auth/login", {
  method: "POST",
  body: JSON.stringify({ username: "admin", password: "admin" }),
});
const call = (path, init = {}) =>
  json(path, { ...init, headers: { authorization: `Bearer ${login.accessToken}`, ...init.headers } });

for (const id of ["account-1", "account-2"]) {
  const account = (await call("/api/accounts")).find((item) => item.id === id);
  if (["idle", "disconnected"].includes(account.status))
    await call(`/api/accounts/${id}/connect`, { method: "POST" });
}

let group = (await call("/api/groups")).find((item) => item.status === "active");
if (!group) {
  const job = await call("/api/groups", {
    method: "POST",
    body: JSON.stringify({ creatorAccountId: "account-1", memberAccountIds: ["account-2"] }),
  });
  for (let attempt = 0; attempt < 80; attempt++) {
    const state = await call(`/api/jobs/${job.jobId}`);
    if (state.status === "failed") throw new Error(`Group job failed: ${JSON.stringify(state)}`);
    if (state.status === "finished") {
      group = (await call("/api/groups")).find((item) => item.status === "active");
      break;
    }
    await wait(200);
  }
}
if (!group) throw new Error("No active group available for the reliability lab");

const scenarios = [
  "s2_duplicate",
  "s4_rate_limit",
  "s5_agent_idempotency",
  "s6_agent_protocol",
  "agent_happy",
];
const results = [];
for (const scenario of scenarios) {
  const started = await call("/api/demo/experiments", {
    method: "POST",
    body: JSON.stringify({ scenario, groupId: group.id }),
  });
  let finished;
  for (let attempt = 0; attempt < 100; attempt++) {
    const experiments = await call(`/api/demo/experiments?groupId=${group.id}`);
    finished = experiments.find((item) => item.id === started.experimentId && item.status !== "running");
    if (finished) break;
    await wait(300);
  }
  if (!finished) throw new Error(`${scenario} timed out`);
  if (finished.status !== "passed")
    throw new Error(`${scenario} failed: ${JSON.stringify(finished.evidence)}`);
  results.push({ scenario, status: finished.status, evidence: finished.evidence });
  console.log(`✓ ${scenario}`);
}

console.log(JSON.stringify({ passed: true, groupId: group.id, experiments: results }, null, 2));
