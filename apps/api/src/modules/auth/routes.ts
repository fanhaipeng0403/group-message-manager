import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { createHash, randomBytes } from "node:crypto";
import type { DbPool } from "../../db/pool.js";
import { AppError } from "../../common/errors.js";
import { verifyPassword } from "../../common/password.js";
import { authenticate } from "../../common/auth.js";
import { BearerSecurity, ErrorResponses, OkSchema } from "../../common/http-schemas.js";

const LoginSchema = z.object({
  username: z.string().min(1).describe("操作员用户名"),
  password: z.string().min(1).describe("操作员密码"),
});
const LoginResponseSchema = z.object({ accessToken: z.string().describe("15 分钟有效的 JWT access token") });
const REFRESH_COOKIE = "relayops_refresh_token";
const REFRESH_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}

function readRefreshToken(cookieHeader?: string): string | undefined {
  const pair = cookieHeader
    ?.split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${REFRESH_COOKIE}=`));
  return pair ? decodeURIComponent(pair.slice(REFRESH_COOKIE.length + 1)) : undefined;
}

function setRefreshCookie(reply: FastifyReply, token: string): void {
  reply.header(
    "set-cookie",
    `${REFRESH_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/api/auth; SameSite=Lax; Max-Age=${REFRESH_MAX_AGE_SECONDS}`,
  );
}

function clearRefreshCookie(reply: FastifyReply): void {
  reply.header("set-cookie", `${REFRESH_COOKIE}=; HttpOnly; Path=/api/auth; SameSite=Lax; Max-Age=0`);
}

export function registerAuthRoutes(app: FastifyInstance, pool: DbPool): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  api.post(
    "/api/auth/login",
    {
      schema: {
        operationId: "login",
        tags: ["Auth"],
        summary: "操作员登录",
        description: "演示账号：admin/admin（可写）与 viewer/viewer（只读）。",
        body: LoginSchema,
        response: { 200: LoginResponseSchema, 400: ErrorResponses[400], 401: ErrorResponses[401] },
      },
    },
    async (request, reply) => {
      const input = request.body;
      const result = await pool.query<{
        id: string;
        username: string;
        password_hash: string;
        role: "admin" | "viewer";
      }>("SELECT id, username, password_hash, role FROM users WHERE username = $1", [input.username]);
      const user = result.rows[0];
      if (!user || !(await verifyPassword(input.password, user.password_hash))) {
        throw new AppError(401, "UNAUTHORIZED", "Invalid username or password");
      }
      const refreshToken = newRefreshToken();
      const session = await pool.query<{ id: string }>(
        `WITH created AS (
         INSERT INTO auth_sessions (user_id) VALUES ($1) RETURNING id
       )
       INSERT INTO refresh_tokens (session_id, token_hash, expires_at)
       SELECT id, $2, now() + interval '7 days' FROM created
       RETURNING session_id AS id`,
        [user.id, hashToken(refreshToken)],
      );
      const sessionId = session.rows[0]!.id;
      const accessToken = app.jwt.sign(
        { sub: user.id, username: user.username, role: user.role, sessionId },
        { expiresIn: "15m" },
      );
      setRefreshCookie(reply, refreshToken);
      return { accessToken };
    },
  );

  api.post(
    "/api/auth/refresh",
    {
      schema: {
        operationId: "refreshSession",
        tags: ["Auth"],
        summary: "轮换 Refresh Token",
        response: { 200: LoginResponseSchema, 401: ErrorResponses[401] },
      },
    },
    async (request, reply) => {
      const token = readRefreshToken(request.headers.cookie);
      if (!token) throw new AppError(401, "UNAUTHORIZED", "Refresh token is missing");
      const client = await pool.connect();
      const replacement = newRefreshToken();
      let user: { id: string; username: string; role: "admin" | "viewer"; session_id: string } | undefined;
      try {
        await client.query("BEGIN");
        const found = await client.query<{
          id: string;
          session_id: string;
          used_at: Date | null;
          expires_at: Date;
          revoked_at: Date | null;
          user_id: string;
          username: string;
          role: "admin" | "viewer";
        }>(
          `SELECT rt.id, rt.session_id, rt.used_at, rt.expires_at, s.revoked_at,
                u.id AS user_id, u.username, u.role
         FROM refresh_tokens rt
         JOIN auth_sessions s ON s.id = rt.session_id
         JOIN users u ON u.id = s.user_id
         WHERE rt.token_hash = $1 FOR UPDATE`,
          [hashToken(token)],
        );
        const row = found.rows[0];
        if (!row) throw new AppError(401, "UNAUTHORIZED", "Refresh token is invalid");
        if (row.used_at || row.revoked_at || row.expires_at.getTime() <= Date.now()) {
          await client.query(
            "UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, now()), updated_at = now() WHERE id = $1",
            [row.session_id],
          );
          await client.query("COMMIT");
          clearRefreshCookie(reply);
          throw new AppError(401, "UNAUTHORIZED", "Refresh token reuse detected; session revoked");
        }
        await client.query("UPDATE refresh_tokens SET used_at = now() WHERE id = $1", [row.id]);
        await client.query(
          "INSERT INTO refresh_tokens (session_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '7 days')",
          [row.session_id, hashToken(replacement)],
        );
        await client.query("COMMIT");
        user = { id: row.user_id, username: row.username, role: row.role, session_id: row.session_id };
      } catch (error) {
        if (!user) await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      const accessToken = app.jwt.sign(
        { sub: user.id, username: user.username, role: user.role, sessionId: user.session_id },
        { expiresIn: "15m" },
      );
      setRefreshCookie(reply, replacement);
      return { accessToken };
    },
  );

  api.post(
    "/api/auth/logout",
    {
      preHandler: authenticate,
      schema: {
        operationId: "logoutSession",
        tags: ["Auth"],
        summary: "立即注销当前会话",
        security: BearerSecurity,
        response: { 200: OkSchema, 401: ErrorResponses[401] },
      },
    },
    async (request, reply) => {
      await pool.query("UPDATE auth_sessions SET revoked_at = now(), updated_at = now() WHERE id = $1", [
        request.user.sessionId,
      ]);
      clearRefreshCookie(reply);
      return { ok: true as const };
    },
  );
}
