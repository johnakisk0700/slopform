import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { fileURLToPath } from "node:url";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to run database migrations");
}

function readPositiveInteger(name, fallback) {
  const rawValue = process.env[name];

  if (rawValue === undefined || rawValue === "") {
    return fallback;
  }

  if (!/^[1-9]\d*$/.test(rawValue)) {
    throw new Error(`${name} must be a positive integer in milliseconds`);
  }

  const value = Number(rawValue);

  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} exceeds JavaScript's safe integer range`);
  }

  return value;
}

const connectTimeoutMs = readPositiveInteger(
  "MIGRATION_CONNECT_TIMEOUT_MS",
  10_000,
);
const executionTimeoutMs = readPositiveInteger(
  "MIGRATION_EXECUTION_TIMEOUT_MS",
  600_000,
);
const lockTimeoutMs = readPositiveInteger("MIGRATION_LOCK_TIMEOUT_MS", 15_000);
const statementTimeoutMs = readPositiveInteger(
  "MIGRATION_STATEMENT_TIMEOUT_MS",
  300_000,
);

if (lockTimeoutMs >= statementTimeoutMs) {
  throw new Error(
    "MIGRATION_LOCK_TIMEOUT_MS must be lower than MIGRATION_STATEMENT_TIMEOUT_MS",
  );
}

if (statementTimeoutMs >= executionTimeoutMs) {
  throw new Error(
    "MIGRATION_STATEMENT_TIMEOUT_MS must be lower than MIGRATION_EXECUTION_TIMEOUT_MS",
  );
}

const pool = new Pool({
  application_name: "join-the-six-migrate",
  connectionTimeoutMillis: connectTimeoutMs,
  connectionString: databaseUrl,
  lock_timeout: lockTimeoutMs,
  max: 1,
  query_timeout: statementTimeoutMs + 5_000,
  statement_timeout: statementTimeoutMs,
});

const startedAt = Date.now();
const executionTimer = setTimeout(() => {
  console.error(
    JSON.stringify({
      elapsedMs: Date.now() - startedAt,
      event: "migration.execution_timeout",
      executionTimeoutMs,
    }),
  );
  process.exit(124);
}, executionTimeoutMs);

console.log(
  JSON.stringify({
    connectTimeoutMs,
    event: "migration.started",
    executionTimeoutMs,
    lockTimeoutMs,
    statementTimeoutMs,
  }),
);

try {
  await migrate(drizzle(pool), {
    migrationsFolder: fileURLToPath(new URL("./drizzle", import.meta.url)),
    migrationsSchema: "drizzle",
    migrationsTable: "__drizzle_migrations",
  });
  console.log(
    JSON.stringify({
      durationMs: Date.now() - startedAt,
      event: "migration.completed",
    }),
  );
} finally {
  try {
    await pool.end();
  } finally {
    clearTimeout(executionTimer);
  }
}
