const API = process.env.API_URL ?? "http://localhost:3000";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function json(path, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

const login = await json("/api/auth/login", {
  method: "POST",
  body: JSON.stringify({ username: "admin", password: "admin" }),
});
const headers = { authorization: `Bearer ${login.body.accessToken}` };
const call = (path, init = {}) => json(path, { ...init, headers: { ...headers, ...init.headers } });
const groups = await call("/api/groups");
const group = groups.body.find((item) => item.status === "active");
if (!group) throw new Error("No active group for sequence verification");

const unresolvedSequence = await call("/api/sequences", {
  method: "POST",
  body: JSON.stringify({
    name: `S8-${Date.now()}`,
    steps: [
      { index: 1, accountRole: "admin", text: "{event}", delaySeconds: 0 },
      { index: 2, accountRole: "admin", text: "{event} 即将开始", delaySeconds: 0 },
      { index: 3, accountRole: "admin", text: "资料位置：{location}", delaySeconds: 0 },
    ],
  }),
});
const s8 = await call(`/api/groups/${group.id}/sequence-runs`, {
  method: "POST",
  body: JSON.stringify({ sequenceId: unresolvedSequence.body.id, vars: { event: "发布会" }, stepVars: {} }),
});
if (
  s8.response.status !== 422 ||
  s8.body.error?.code !== "UNRESOLVED_PLACEHOLDER" ||
  s8.body.error?.stepIndex !== 3 ||
  s8.body.error?.key !== "location"
) {
  throw new Error(`S8 failed: ${s8.response.status} ${JSON.stringify(s8.body)}`);
}

const sequence = await call("/api/sequences", {
  method: "POST",
  body: JSON.stringify({
    name: `S7-${Date.now()}`,
    steps: [{ index: 1, accountRole: "admin", text: "并发启动验证", delaySeconds: 0 }],
  }),
});
const start = () =>
  call(`/api/groups/${group.id}/sequence-runs`, {
    method: "POST",
    body: JSON.stringify({ sequenceId: sequence.body.id, vars: {}, stepVars: {} }),
  });
const concurrent = await Promise.all([start(), start()]);
const statuses = concurrent.map((item) => item.response.status).sort();
if (statuses[0] !== 201 || statuses[1] !== 409) throw new Error(`S7 failed: ${statuses.join(",")}`);
const runId = concurrent.find((item) => item.response.status === 201).body.runId;
let final;
for (let attempt = 0; attempt < 60; attempt++) {
  const state = await call(`/api/sequence-runs/${runId}`);
  final = state.body;
  if (state.body.status !== "running") break;
  await wait(250);
}
if (final?.status !== "finished" || final.steps[0]?.status !== "sent") {
  throw new Error(`Sequence execution failed: ${JSON.stringify(final)}`);
}

console.log(
  JSON.stringify(
    { passed: true, s7: "one 201 and one 409", s8: "step 3 location rejected before run", runId },
    null,
    2,
  ),
);
