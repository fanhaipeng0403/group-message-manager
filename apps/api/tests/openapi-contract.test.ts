import SwaggerParser from "@apidevtools/swagger-parser";
import { afterEach, describe, expect, it } from "vitest";
import type { DbPool } from "../src/db/pool.js";
import { loadEnv } from "../src/config/env.js";
import { buildApp } from "../src/app.js";

const built: Array<Awaited<ReturnType<typeof buildApp>>["app"]> = [];

afterEach(async () => {
  await Promise.all(built.splice(0).map((app) => app.close()));
});

async function specification() {
  const env = loadEnv({
    JWT_SECRET: "openapi-contract-test-secret",
    DEMO_MODE: "true",
  });
  const { app } = await buildApp(env, {} as DbPool, 2);
  built.push(app);
  await app.ready();
  return app.swagger() as Record<string, any>;
}

describe("OpenAPI contract", () => {
  it("is a valid OpenAPI document and contains every public API route", async () => {
    const spec = await specification();
    await expect(SwaggerParser.validate(spec as any)).resolves.toBeTruthy();

    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining([
        "/api/health",
        "/api/auth/login",
        "/api/auth/refresh",
        "/api/auth/logout",
        "/api/accounts",
        "/api/accounts/{id}/connect",
        "/api/accounts/{id}/transition",
        "/api/groups",
        "/api/groups/{id}",
        "/api/groups/{id}/leave-all",
        "/api/jobs/{jobId}",
        "/api/groups/{id}/send",
        "/api/groups/{id}/messages",
        "/api/agent-runs/{id}",
        "/api/groups/{id}/agent-runs",
        "/api/sequences",
        "/api/groups/{id}/sequence-runs",
        "/api/sequence-runs/{id}",
        "/api/demo/scenarios",
        "/api/demo/experiments",
      ]),
    );
    expect(spec.paths["/ws"]).toBeUndefined();
  });

  it("gives every operation a unique id and documents authentication", async () => {
    const spec = await specification();
    const operations = Object.entries(spec.paths).flatMap(([path, methods]: [string, any]) =>
      Object.entries(methods)
        .filter(([method]) => ["get", "post", "patch", "put", "delete"].includes(method))
        .map(([, operation]: [string, any]) => ({ path, operation })),
    );
    const ids = operations.map(({ operation }) => operation.operationId);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);

    for (const { path, operation } of operations) {
      if (["/api/health", "/api/auth/login", "/api/auth/refresh"].includes(path)) continue;
      expect(operation.security).toEqual([{ bearerAuth: [] }]);
      expect(operation.responses).toBeDefined();
    }
  });
});
