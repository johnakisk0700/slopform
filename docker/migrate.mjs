import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { fileURLToPath } from "node:url";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to run database migrations");
}

const pool = new Pool({
  application_name: "join-the-six-migrate",
  connectionString: databaseUrl,
  max: 1,
});

try {
  await migrate(drizzle(pool), {
    migrationsFolder: fileURLToPath(new URL("./drizzle", import.meta.url)),
    migrationsSchema: "drizzle",
    migrationsTable: "__drizzle_migrations",
  });
} finally {
  await pool.end();
}
