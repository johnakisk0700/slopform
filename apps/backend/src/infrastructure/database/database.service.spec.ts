import type { ConfigService } from "@nestjs/config";
import { Logger } from "@nestjs/common";
import type { AppDatabase, DatabaseClient } from "@join-the-six/database";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Environment } from "../config/environment.js";
import { DatabaseService } from "./database.service.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("DatabaseService", () => {
  it("creates one configured pool and observes idle-client errors", async () => {
    const config = createConfig();
    const logError = vi
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => undefined);
    const service = new DatabaseService(config);

    service.onModuleInit();
    const client = getClient(service);
    expect(config.get).toHaveBeenCalledWith("DATABASE_URL", { infer: true });
    expect(client.pool.listenerCount("error")).toBe(1);

    const error = new Error("idle connection failed");
    client.pool.emit("error", error);
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ event: "database.pool.error" }),
    );

    await service.onApplicationShutdown();
    expect(client.pool.listenerCount("error")).toBe(0);
    expect(() => service.db).toThrow(
      "DatabaseService used before module initialization",
    );
  });

  it("bounds and coalesces readiness checks", async () => {
    vi.useFakeTimers();
    const query = vi.fn().mockReturnValue(new Promise(() => undefined));
    const service = new DatabaseService(createConfig());
    setClient(service, createClient({ query }));

    const first = service.ping();
    const second = service.ping();
    const assertions = Promise.all([
      expect(first).rejects.toThrow("timed out after 1000ms"),
      expect(second).rejects.toThrow("timed out after 1000ms"),
    ]);

    await vi.advanceTimersByTimeAsync(1_000);
    await assertions;
    expect(query).toHaveBeenCalledOnce();
  });

  it("closes an initialized pool once", async () => {
    const end = vi.fn().mockResolvedValue(undefined);
    const service = new DatabaseService(createConfig());
    setClient(service, createClient({ end }));

    await service.onApplicationShutdown();
    await service.onApplicationShutdown();

    expect(end).toHaveBeenCalledOnce();
  });
});

function createConfig(): ConfigService<Environment, true> & {
  readonly get: ReturnType<typeof vi.fn>;
} {
  const values: Partial<Environment> = {
    DATABASE_POOL_MAX: 4,
    DATABASE_URL: "postgresql://user:password@localhost:5432/database",
    OTEL_SERVICE_NAME: "database-test",
  };

  return {
    get: vi.fn((key: keyof Environment) => values[key]),
  } as unknown as ConfigService<Environment, true> & {
    readonly get: ReturnType<typeof vi.fn>;
  };
}

function createClient(overrides: {
  readonly end?: ReturnType<typeof vi.fn>;
  readonly query?: ReturnType<typeof vi.fn>;
}): DatabaseClient {
  const pool = Object.assign(new EventEmitter(), {
    end: overrides.end ?? vi.fn().mockResolvedValue(undefined),
    query: overrides.query ?? vi.fn().mockResolvedValue({ rows: [] }),
  }) as unknown as DatabaseClient["pool"];

  return { db: {} as AppDatabase, pool };
}

function getClient(service: DatabaseService): DatabaseClient {
  return (
    service as unknown as {
      readonly client: DatabaseClient;
    }
  ).client;
}

function setClient(service: DatabaseService, client: DatabaseClient): void {
  (
    service as unknown as {
      client: DatabaseClient;
    }
  ).client = client;
}
