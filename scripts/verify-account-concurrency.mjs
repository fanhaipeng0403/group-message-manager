const API = process.env.API_URL ?? "http://localhost:3000";
const GATEWAY = process.env.GATEWAY_URL ?? "http://localhost:4001";
const ACCOUNT_ID = "account-3";

async function request(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

const login = await request(`${API}/api/auth/login`, {
  method: "POST",
  body: JSON.stringify({ username: "admin", password: "admin" }),
});
if (login.status !== 200) throw new Error(`Login failed: ${JSON.stringify(login)}`);
const headers = { authorization: `Bearer ${login.body.accessToken}` };
const api = (path, init = {}) =>
  request(`${API}${path}`, { ...init, headers: { ...headers, ...init.headers } });

const accounts = await api("/api/accounts");
const initial = accounts.body.find((item) => item.id === ACCOUNT_ID);
if (!initial) throw new Error(`${ACCOUNT_ID} is missing`);
if (initial.status === "online") {
  const disconnected = await api(`/api/accounts/${ACCOUNT_ID}/transition`, {
    method: "POST",
    body: JSON.stringify({ expectedFrom: "online", to: "disconnected" }),
  });
  if (disconnected.status !== 200)
    throw new Error(`Cannot normalize account: ${JSON.stringify(disconnected)}`);
} else if (!["idle", "disconnected"].includes(initial.status)) {
  throw new Error(`${ACCOUNT_ID} must be connectable, got ${initial.status}`);
}

const connectResults = await Promise.all([
  api(`/api/accounts/${ACCOUNT_ID}/connect`, { method: "POST" }),
  api(`/api/accounts/${ACCOUNT_ID}/connect`, { method: "POST" }),
]);
const connectStatuses = connectResults.map((result) => result.status).sort();
if (JSON.stringify(connectStatuses) !== JSON.stringify([200, 409])) {
  throw new Error(`Concurrent connect did not serialize: ${JSON.stringify(connectResults)}`);
}

const disconnectBody = JSON.stringify({ expectedFrom: "online", to: "disconnected" });
const disconnectResults = await Promise.all([
  api(`/api/accounts/${ACCOUNT_ID}/transition`, { method: "POST", body: disconnectBody }),
  api(`/api/accounts/${ACCOUNT_ID}/transition`, { method: "POST", body: disconnectBody }),
]);
const disconnectStatuses = disconnectResults.map((result) => result.status).sort();
if (JSON.stringify(disconnectStatuses) !== JSON.stringify([200, 409])) {
  throw new Error(`Concurrent disconnect did not serialize: ${JSON.stringify(disconnectResults)}`);
}

const [finalAccounts, gatewayAccount] = await Promise.all([
  api("/api/accounts"),
  request(`${GATEWAY}/__control/accounts/${ACCOUNT_ID}`),
]);
const final = finalAccounts.body.find((item) => item.id === ACCOUNT_ID);
if (
  final?.status !== "disconnected" ||
  gatewayAccount.status !== 200 ||
  gatewayAccount.body.online !== false
) {
  throw new Error(
    `Database and gateway diverged: ${JSON.stringify({ database: final, gateway: gatewayAccount })}`,
  );
}

console.log(
  JSON.stringify(
    {
      passed: true,
      accountId: ACCOUNT_ID,
      concurrentConnect: connectStatuses,
      concurrentDisconnect: disconnectStatuses,
      finalDatabaseStatus: final.status,
      finalGatewayOnline: gatewayAccount.body.online,
    },
    null,
    2,
  ),
);
