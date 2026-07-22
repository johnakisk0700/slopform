import { getQueueToken } from "@nestjs/bullmq";
import { MODULE_METADATA } from "@nestjs/common/constants.js";
import { describe, expect, it } from "vitest";

import { REFERENCE_QUEUE } from "./queue.constants.js";
import {
  createQueueProducerOptions,
  createQueueWorkerOptions,
  QueueWorkerModule,
} from "./queue.module.js";

describe("queue process boundaries", () => {
  it("keeps retry and retention policy on producer registrations", () => {
    expect(
      createQueueProducerOptions("redis://localhost:6379/0").defaultJobOptions,
    ).toEqual({
      attempts: 5,
      backoff: { type: "exponential", delay: 1_000, jitter: 0.5 },
      removeOnComplete: { age: 86_400, count: 1_000 },
      removeOnFail: { age: 604_800, count: 5_000 },
      stackTraceLimit: 10,
    });
    expect(
      createQueueWorkerOptions("redis://localhost:6379/0").defaultJobOptions,
    ).toBeUndefined();
  });

  it("registers the worker queue through the public Nest API", () => {
    const imports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      QueueWorkerModule,
    ) as readonly unknown[];
    const queueToken = getQueueToken(REFERENCE_QUEUE);

    expect(
      imports.some((moduleImport) => exportsProvider(moduleImport, queueToken)),
    ).toBe(true);
  });
});

function exportsProvider(moduleImport: unknown, token: string): boolean {
  if (!moduleImport || typeof moduleImport !== "object") {
    return false;
  }

  const exportedProviders = (moduleImport as { exports?: readonly unknown[] })
    .exports;

  return (
    exportedProviders?.some(
      (provider) =>
        !!provider &&
        typeof provider === "object" &&
        "provide" in provider &&
        provider.provide === token,
    ) ?? false
  );
}
