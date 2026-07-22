import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";

import * as schema from "./schema/index.js";

export type AppDatabase = NodePgDatabase<typeof schema>;
export type AppTransaction = Parameters<
  Parameters<AppDatabase["transaction"]>[0]
>[0];

export interface DatabaseClient {
  readonly db: AppDatabase;
  readonly pool: Pool;
}

export interface CreateDatabaseOptions {
  readonly connectionString: string;
  readonly applicationName: string;
  readonly maxConnections?: number;
}

export const DATABASE_POOL_DEFAULTS = {
  connectionTimeoutMillis: 2_000,
  idleInTransactionSessionTimeoutMillis: 30_000,
  queryTimeoutMillis: 16_000,
  statementTimeoutMillis: 15_000,
} as const;

export function createPoolConfig(options: CreateDatabaseOptions): PoolConfig {
  const max = options.maxConnections ?? 10;

  if (!Number.isInteger(max) || max < 1 || max > 100) {
    throw new Error("maxConnections must be an integer between 1 and 100");
  }

  if (!options.applicationName.trim()) {
    throw new Error("applicationName must not be empty");
  }

  if (!options.connectionString.trim()) {
    throw new Error("connectionString must not be empty");
  }

  return {
    application_name: options.applicationName,
    connectionString: options.connectionString,
    connectionTimeoutMillis: DATABASE_POOL_DEFAULTS.connectionTimeoutMillis,
    idle_in_transaction_session_timeout:
      DATABASE_POOL_DEFAULTS.idleInTransactionSessionTimeoutMillis,
    max,
    query_timeout: DATABASE_POOL_DEFAULTS.queryTimeoutMillis,
    statement_timeout: DATABASE_POOL_DEFAULTS.statementTimeoutMillis,
  };
}

export function createDatabase(options: CreateDatabaseOptions): DatabaseClient {
  const pool = new Pool(createPoolConfig(options));

  return {
    db: drizzle({ client: pool, schema }),
    pool,
  };
}
