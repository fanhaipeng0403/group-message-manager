const API = process.env.API_URL ?? "http://localhost:3000";

async function request(path, init = {}) {
  const response = await fetch(`${API}${path}`, init);
  const body = await response.json().catch(() => ({}));
  return { response, body, cookie: response.headers.get("set-cookie")?.split(";", 1)[0] };
}

const login = await request("/api/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "admin", password: "admin" }),
});
if (!login.response.ok || !login.cookie) throw new Error("Login did not issue a refresh cookie");

const rotated = await request("/api/auth/refresh", { method: "POST", headers: { cookie: login.cookie } });
if (!rotated.response.ok || !rotated.cookie) throw new Error("Refresh rotation failed");

const replay = await request("/api/auth/refresh", { method: "POST", headers: { cookie: login.cookie } });
if (replay.response.status !== 401)
  throw new Error(`Old refresh token replay returned ${replay.response.status}`);

const revokedAccess = await request("/api/accounts", {
  headers: { authorization: `Bearer ${rotated.body.accessToken}` },
});
if (revokedAccess.response.status !== 401)
  throw new Error("Refresh replay did not revoke the rotated access token");

const secondLogin = await request("/api/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "admin", password: "admin" }),
});
const logout = await request("/api/auth/logout", {
  method: "POST",
  headers: { authorization: `Bearer ${secondLogin.body.accessToken}`, cookie: secondLogin.cookie },
});
if (!logout.response.ok) throw new Error("Logout failed");

const loggedOutAccess = await request("/api/accounts", {
  headers: { authorization: `Bearer ${secondLogin.body.accessToken}` },
});
if (loggedOutAccess.response.status !== 401)
  throw new Error("Logout did not invalidate the access token immediately");

console.log(
  JSON.stringify(
    {
      passed: true,
      refreshRotated: true,
      replayRevokedSession: true,
      logoutRevokedAccess: true,
    },
    null,
    2,
  ),
);
