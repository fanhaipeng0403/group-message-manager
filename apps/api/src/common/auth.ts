import type { FastifyRequest } from "fastify";
import { AppError } from "./errors.js";
import type { DbPool } from "../db/pool.js";

let authPool: DbPool | undefined;

export function configureAuth(pool: DbPool): void {
  authPool = pool;
}

export async function authenticate(request: FastifyRequest): Promise<void> {
  try {
    await request.jwtVerify();
    if (!authPool) throw new Error("Authentication database is not configured");
    const session = await authPool.query("SELECT 1 FROM auth_sessions WHERE id = $1 AND revoked_at IS NULL", [
      request.user.sessionId,
    ]);
    if (!session.rowCount) throw new Error("Session revoked");
  } catch {
    throw new AppError(401, "UNAUTHORIZED", "Authentication required");
  }
}

export async function requireAdmin(request: FastifyRequest): Promise<void> {
  await authenticate(request);
  if (request.user.role !== "admin") {
    throw new AppError(403, "FORBIDDEN", "This operation requires admin access");
  }
}
