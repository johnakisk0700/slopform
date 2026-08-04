import { getQueueToken } from "@nestjs/bullmq";
import { MODULE_METADATA } from "@nestjs/common/constants.js";
import { describe, expect, it } from "vitest";

import {
  ASSISTANT_QUEUE,
  EMAIL_QUEUE,
  FEEDBACK_CONVERSATION_QUEUE,
  FEEDBACK_INGRESS_QUEUE,
  FEEDBACK_MAINTENANCE_QUEUE,
  FEEDBACK_QUEUE,
  FEEDBACK_SUMMARY_QUEUE,
  REFERENCE_QUEUE,
} from "./queue.constants.js";
import {
  createQueueProducerOptions,
  createQueueWorkerOptions,
  QueueModule,
  QueueWorkerModule,
} from "./queue.module.js";

describe("queue process boundaries", () => {
  // Both registrations produce work, so both carry the policy. This assertion
  // used to require the worker's to be `undefined`, which read as a decision and
  // was really a description: `feedback.extract.v1` and `feedback.deliver.v1`
  // are enqueued by the worker, so those two — the only jobs that call a paid
  // provider and an external API — were reaching Redis with no `attempts` at
  // all. One timeout was terminal on the first try, and the extraction
  // processor's `attempts ?? 1` turned the missing policy into "already
  // exhausted", firing the deterministic fallback instead of retrying.
  it("keeps one retry and retention policy on every registration", () => {
    const policy = {
      attempts: 5,
      backoff: { type: "exponential", delay: 1_000, jitter: 0.5 },
      removeOnComplete: { age: 86_400, count: 1_000 },
      removeOnFail: { age: 604_800, count: 5_000 },
      stackTraceLimit: 10,
    };

    expect(
      createQueueProducerOptions("redis://localhost:6379/0").defaultJobOptions,
    ).toEqual(policy);
    expect(
      createQueueWorkerOptions("redis://localhost:6379/0").defaultJobOptions,
    ).toEqual(policy);
  });

  it.each([QueueModule, QueueWorkerModule])(
    "registers every queue through the public Nest API in %s",
    (moduleClass) => {
      const imports = Reflect.getMetadata(
        MODULE_METADATA.IMPORTS,
        moduleClass,
      ) as readonly unknown[];
      const queueTokens = [
        ASSISTANT_QUEUE,
        EMAIL_QUEUE,
        FEEDBACK_QUEUE,
        FEEDBACK_INGRESS_QUEUE,
        FEEDBACK_CONVERSATION_QUEUE,
        FEEDBACK_SUMMARY_QUEUE,
        FEEDBACK_MAINTENANCE_QUEUE,
        REFERENCE_QUEUE,
      ].map((queue) => getQueueToken(queue));

      for (const queueToken of queueTokens) {
        expect(
          imports.some((moduleImport) =>
            exportsProvider(moduleImport, queueToken),
          ),
        ).toBe(true);
      }
    },
  );
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
