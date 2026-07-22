import {
  drizzle,
  type NodePgDatabase,
  type NodePgQueryResultHKT,
} from "drizzle-orm/node-postgres";
import type { PgTransaction } from "drizzle-orm/pg-core";
import { Pool } from "pg";

import * as schema from "./schema/index.js";

export type AppDatabase = NodePgDatabase<typeof schema>;
export type AppTransaction = PgTransaction<
  NodePgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

type ExtractTablesWithRelations<TSchema extends Record<string, unknown>> =
  Parameters<
    Parameters<NodePgDatabase<TSchema>["transaction"]>[0]
  >[0] extends PgTransaction<NodePgQueryResultHKT, TSchema, infer TRelations>
    ? TRelations
    : never;

export type DatabaseExecutor = AppDatabase | AppTransaction;

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
    db: drizzle(pool, { schema }),
    pool,
  };
}
