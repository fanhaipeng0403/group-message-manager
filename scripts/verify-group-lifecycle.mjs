const API = process.env.API_URL ?? "http://localhost:3000";
const GATEWAY = process.env.GATEWAY_URL ?? "http://localhost:4001";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
const headers = { authorization: `Bearer ${login.accessToken}` };
const call = (path, init = {}) =>
  json(`${API}${path}`, { ...init, headers: { ...headers, ...init.headers } });
for (const id of ["account-1", "account-2"]) {
  const account = (await call("/api/accounts")).find((item) => item.id === id);
  if (account.status === "online") {
    await call(`/api/accounts/${id}/transition`, {
      method: "POST",
      body: JSON.stringify({ expectedFrom: "online", to: "disconnected" }),
    });
    account.status = "disconnected";
  }
  if (["idle", "disconnected"].includes(account.status))
    await call(`/api/accounts/${id}/connect`, { method: "POST" });
}
await json(`${GATEWAY}/__control`, {
  method: "POST",
  body: JSON.stringify({ expireInviteOnce: true, resetRuntime: true }),
});
const created = await call("/api/groups", {
  method: "POST",
  body: JSON.stringify({ creatorAccountId: "account-1", memberAccountIds: ["account-2"] }),
});
let group;
for (let attempt = 0; attempt < 80; attempt++) {
  const job = await call(`/api/jobs/${created.jobId}`);
  if (job.status === "failed") throw new Error(`Invite-expiry recovery failed: ${JSON.stringify(job)}`);
  if (job.status === "finished") {
    group = (await call("/api/groups")).find(
      (item) => item.creatorAccountId === "account-1" && item.status === "active",
    );
    break;
  }
  await wait(200);
}
if (!group || group.members.length !== 2) throw new Error("Group did not recover from the expired invite");
const leaving = await call(`/api/groups/${group.id}/leave-all`, { method: "POST" });
for (let attempt = 0; attempt < 80; attempt++) {
  const job = await call(`/api/jobs/${leaving.jobId}`);
  if (job.status === "failed") throw new Error(`Leave-all failed: ${JSON.stringify(job)}`);
  if (job.status === "finished") break;
  await wait(200);
}
const left = await call(`/api/groups/${group.id}`);
if (left.status !== "left" || left.members.length !== 0)
  throw new Error(`Leave-all did not converge: ${JSON.stringify(left)}`);
console.log(
  JSON.stringify({ passed: true, inviteExpiredRecovered: true, ownerLeftLast: true, members: 0 }, null, 2),
);
