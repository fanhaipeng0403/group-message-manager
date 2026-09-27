import pg from "pg";

const { Pool } = pg;

export function createPool(connectionString: string): pg.Pool {
  return new Pool({ connectionString, max: 12 });
}

export type DbPool = pg.Pool;
export type DbClient = pg.PoolClient;
