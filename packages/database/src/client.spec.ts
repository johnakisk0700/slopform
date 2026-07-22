import { describe, expect, it } from "vitest";

import {
  createDatabase,
  createPoolConfig,
  DATABASE_POOL_DEFAULTS,
} from "./client.js";

const options = {
  applicationName: "database-test",
  connectionString: "postgresql://user:password@localhost:5432/database",
};

describe("createPoolConfig", () => {
  it("bounds connection, statement and idle-transaction work", () => {
    expect(createPoolConfig(options)).toMatchObject({
      application_name: "database-test",
      connectionString: options.connectionString,
      connectionTimeoutMillis: DATABASE_POOL_DEFAULTS.connectionTimeoutMillis,
      idle_in_transaction_session_timeout:
        DATABASE_POOL_DEFAULTS.idleInTransactionSessionTimeoutMillis,
      max: 10,
      query_timeout: DATABASE_POOL_DEFAULTS.queryTimeoutMillis,
      statement_timeout: DATABASE_POOL_DEFAULTS.statementTimeoutMillis,
    });
  });

  it.each([0, 101, 1.5])("rejects an invalid pool maximum: %s", (maximum) => {
    expect(() =>
      createPoolConfig({ ...options, maxConnections: maximum }),
    ).toThrow("maxConnections must be an integer between 1 and 100");
  });

  it("rejects blank required connection metadata", () => {
    expect(() =>
      createPoolConfig({ ...options, applicationName: " " }),
    ).toThrow("applicationName must not be empty");
    expect(() =>
      createPoolConfig({ ...options, connectionString: " " }),
    ).toThrow("connectionString must not be empty");
  });
});

describe("createDatabase", () => {
  it("creates one lazy pool and closes it cleanly", async () => {
    const client = createDatabase({ ...options, maxConnections: 3 });

    expect(client.pool.options.max).toBe(3);
    expect(client.pool.totalCount).toBe(0);

    await client.pool.end();
  });
});
