import { z } from "zod";

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().default("postgres://postgres:postgres@localhost:55432/messaging_platform"),
  GATEWAY_URL: z.string().url().default("http://localhost:4001"),
  AGENT_URL: z.string().url().default("http://localhost:4002"),
  JWT_SECRET: z.string().min(16).default("local-development-secret"),
  WEB_ORIGIN: z.string().default("http://localhost:5173"),
  AGENT_TURN_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(15_000).default(10_000),
  DEMO_MODE: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(input: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse(input);
}
