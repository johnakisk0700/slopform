import type { ConfigService } from "@nestjs/config";
import type { Collection, Db, MongoClient } from "mongodb";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Environment } from "../config/environment.js";
import { MongoService } from "./mongo.service.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("MongoService", () => {
  it("connects lazily once and returns collections from the selected database", async () => {
    const collection = {} as Collection;
    const db = {
      collection: vi.fn().mockReturnValue(collection),
    } as unknown as Db;
    const client = createClient({ db });
    const service = createService(client);

    await expect(service.collection("conversation_threads")).resolves.toBe(
      collection,
    );
    await expect(service.collection("conversation_threads")).resolves.toBe(
      collection,
    );
    expect(client.connect).toHaveBeenCalledOnce();
  });

  it("bounds and coalesces readiness pings without an external MongoDB", async () => {
    vi.useFakeTimers();
    const command = vi.fn().mockReturnValue(new Promise(() => undefined));
    const client = createClient({
      db: { command } as unknown as Db,
    });
    const service = createService(client);

    const first = service.ping();
    const second = service.ping();
    const assertions = Promise.all([
      expect(first).rejects.toThrow("timed out after 1000ms"),
      expect(second).rejects.toThrow("timed out after 1000ms"),
    ]);

    await vi.advanceTimersByTimeAsync(1_000);
    await assertions;
    expect(command).toHaveBeenCalledOnce();

    command.mockResolvedValueOnce({ ok: 1 });
    await expect(service.ping()).resolves.toBeUndefined();
    expect(command).toHaveBeenCalledTimes(2);
  });

  it("closes the client once and refuses post-shutdown use", async () => {
    const client = createClient({ db: {} as Db });
    const service = createService(client);

    await service.onApplicationShutdown();
    await service.onApplicationShutdown();

    expect(client.close).toHaveBeenCalledOnce();
    await expect(service.ping()).rejects.toThrow(
      "used after application shutdown",
    );
  });
});

function createService(client: MongoClient): MongoService {
  const config = {
    get: vi.fn((key: keyof Environment) =>
      key === "MONGODB_URI"
        ? "mongodb://localhost:27017/join_the_six_test"
        : "mongo-service-test",
    ),
  } as unknown as ConfigService<Environment, true>;
  const service = new MongoService(config);
  (
    service as unknown as {
      client: MongoClient;
    }
  ).client = client;
  return service;
}

function createClient(input: { readonly db: Db }): MongoClient & {
  readonly close: ReturnType<typeof vi.fn>;
  readonly connect: ReturnType<typeof vi.fn>;
} {
  const client = {
    close: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn(),
    db: vi.fn().mockReturnValue(input.db),
  };
  client.connect.mockResolvedValue(client);
  return client as unknown as MongoClient & {
    readonly close: ReturnType<typeof vi.fn>;
    readonly connect: ReturnType<typeof vi.fn>;
  };
}
