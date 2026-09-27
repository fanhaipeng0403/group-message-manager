import type { WebSocket } from "ws";
import type { DbClient, DbPool } from "../db/pool.js";

type Queryable = Pick<DbPool, "query"> | Pick<DbClient, "query">;

export interface StoredEvent {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
}

export class EventHub {
  private readonly sockets = new Set<WebSocket>();

  constructor(private readonly pool: DbPool) {}

  add(socket: WebSocket): void {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
  }

  async store(
    type: string,
    payload: Record<string, unknown>,
    queryable: Queryable = this.pool,
  ): Promise<StoredEvent> {
    const result = await queryable.query<{ seq: string }>(
      "INSERT INTO ws_events (type, payload) VALUES ($1, $2) RETURNING seq",
      [type, payload],
    );
    return { seq: Number(result.rows[0]!.seq), type, payload };
  }

  publish(event: StoredEvent): void {
    const body = JSON.stringify(event);
    for (const socket of this.sockets) {
      if (socket.readyState === socket.OPEN) socket.send(body);
    }
  }

  async emit(type: string, payload: Record<string, unknown>): Promise<StoredEvent> {
    const event = await this.store(type, payload);
    this.publish(event);
    return event;
  }

  async since(seq: number): Promise<StoredEvent[]> {
    const result = await this.pool.query<{
      seq: string;
      type: string;
      payload: Record<string, unknown>;
    }>("SELECT seq, type, payload FROM ws_events WHERE seq > $1 ORDER BY seq ASC LIMIT 1000", [seq]);
    return result.rows.map((row) => ({ ...row, seq: Number(row.seq) }));
  }
}
