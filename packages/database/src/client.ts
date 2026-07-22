import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

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

export function createDatabase(options: CreateDatabaseOptions): DatabaseClient {
  const pool = new Pool({
    application_name: options.applicationName,
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10,
  });

  return {
    db: drizzle({ client: pool, schema }),
    pool,
  };
}
