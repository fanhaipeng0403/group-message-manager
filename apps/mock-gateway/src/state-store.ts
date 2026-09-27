import { Pool } from "pg";
import { z } from "zod";

const AccountSchema = z.object({
  platformUserId: z.string(),
  online: z.boolean(),
  terminal: z.enum(["suspended", "session_expired"]).optional(),
  limitedUntil: z.number().optional(),
});

const GroupSchema = z.object({
  id: z.string(),
  creatorAccountId: z.string(),
  members: z.array(z.string()),
  admins: z.array(z.string()),
  invite: z.object({ link: z.string(), readyAt: z.number(), expired: z.boolean() }).optional(),
});

const StoredMessageSchema = z.object({
  groupId: z.string(),
  clientMsgId: z.string(),
  msgId: z.string(),
  sentAt: z.number(),
  accountId: z.string(),
  text: z.string(),
});

const EventSchema = z.object({ eventId: z.number().int().positive(), type: z.string() }).passthrough();

const GatewayStateSchema = z.object({
  version: z.literal(1),
  accounts: z.array(z.tuple([z.string(), AccountSchema])),
  groups: z.array(z.tuple([z.string(), GroupSchema])),
  messages: z.array(z.tuple([z.string(), z.array(StoredMessageSchema)])),
  history: z.array(EventSchema),
  nextEventId: z.number().int().positive(),
});

export type GatewayState = z.infer<typeof GatewayStateSchema>;

export function parseGatewayState(value: unknown): GatewayState {
  return GatewayStateSchema.parse(value);
}

export class GatewayStateStore {
  private readonly pool?: Pool;
  private writes: Promise<void> = Promise.resolve();

  constructor(databaseUrl: string | undefined) {
    if (databaseUrl) this.pool = new Pool({ connectionString: databaseUrl });
  }

  async load(): Promise<GatewayState | undefined> {
    if (!this.pool) return undefined;
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS mock_gateway_runtime (
        singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
        state jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const result = await this.pool.query<{ state: unknown }>(
      "SELECT state FROM mock_gateway_runtime WHERE singleton = true",
    );
    return result.rows[0] ? parseGatewayState(result.rows[0].state) : undefined;
  }

  save(state: GatewayState): Promise<void> {
    if (!this.pool) return Promise.resolve();
    this.writes = this.writes.then(async () => {
      await this.pool!.query(
        `INSERT INTO mock_gateway_runtime (singleton, state) VALUES (true, $1)
         ON CONFLICT (singleton) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
        [state],
      );
    });
    return this.writes;
  }

  async close(): Promise<void> {
    await this.writes;
    await this.pool?.end();
  }
}
