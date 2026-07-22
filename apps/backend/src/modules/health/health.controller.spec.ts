import { ServiceUnavailableException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import type { DatabaseService } from "../../infrastructure/database/database.service.js";
import type { QueueHealthService } from "../../infrastructure/queue/queue-health.service.js";
import { HealthController } from "./health.controller.js";

function createController(options?: {
  readonly databaseError?: Error;
  readonly redisError?: Error;
}): HealthController {
  const database = {
    ping: options?.databaseError
      ? vi.fn().mockRejectedValue(options.databaseError)
      : vi.fn().mockResolvedValue(undefined),
  } as unknown as DatabaseService;
  const queue = {
    ping: options?.redisError
      ? vi.fn().mockRejectedValue(options.redisError)
      : vi.fn().mockResolvedValue(undefined),
  } as unknown as QueueHealthService;

  return new HealthController(database, queue);
}

describe("HealthController", () => {
  it("reports both dependencies when readiness succeeds", async () => {
    await expect(createController().ready()).resolves.toMatchObject({
      status: "ready",
      checks: { database: "up", redis: "up" },
    });
  });

  it("reports each failed dependency without exposing its error", async () => {
    const operation = createController({
      databaseError: new Error("database credentials leaked here"),
      redisError: new Error("redis credentials leaked here"),
    }).ready();

    const error = await operation.catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toEqual({
      status: "not_ready",
      checks: { database: "down", redis: "down" },
    });
  });
});
