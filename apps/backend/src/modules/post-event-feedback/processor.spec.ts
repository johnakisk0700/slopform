import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import { UnrecoverableError } from "bullmq";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { ConversationPersistenceError } from "../conversations/conversation-persistence.errors.js";
import { PostEventFeedbackIngressNotFoundError } from "./ingress/materialize.service.js";
import type { PostEventFeedbackMaterializationCoordinator } from "./ingress/materialization-coordinator.service.js";
import type { FeedbackConversationWakeupService } from "./reconciliation/wakeup.service.js";
import {
  FEEDBACK_WORKER_CONCURRENCY,
  PostEventFeedbackProcessor,
} from "./processor.js";
import {
  createFeedbackDeliverJobId,
  createFeedbackMaterializeJobId,
  createFeedbackSummarizeCampaignJobId,
  FEEDBACK_JOB_NAMES,
  type FeedbackJobData,
  type FeedbackJobName,
} from "./jobs.schemas.js";

const ingressId = "b1c9e0a4-2c65-4a29-9a2e-2d0a3f2e1b77";
const conversationId = "6f0f2f8a-2b73-5a02-9d0a-3f0b8f5b1c21";
const campaignId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const validData = {
  schemaVersion: 1,
  ingressId,
  correlationId: "correlation-1",
};

describe("PostEventFeedbackProcessor", () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  it("keeps the documented per-process ordering limit explicit", () => {
    expect(FEEDBACK_WORKER_CONCURRENCY).toBe(10);
  });

  it("materializes a valid job through the durable consumer", async () => {
    const materializer = {
      materialize: vi
        .fn()
        .mockResolvedValue({ outcome: "inbound_materialized", conversationId }),
    };
    const processor = createProcessor(materializer);

    await processor.process(createJob(validData));

    expect(materializer.materialize).toHaveBeenCalledWith(validData);
  });

  it("does not retry a payload that cannot become valid", async () => {
    const materializer = { materialize: vi.fn() };
    const processor = createProcessor(materializer);

    await expect(
      processor.process(createJob({ schemaVersion: 2, ingressId })),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(materializer.materialize).not.toHaveBeenCalled();
  });

  it("rejects a job whose id does not match its ingress row", async () => {
    const materializer = { materialize: vi.fn() };
    const processor = createProcessor(materializer);

    await expect(
      processor.process(
        createJob(validData, FEEDBACK_JOB_NAMES.materializeV1, "hand-made-id"),
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(materializer.materialize).not.toHaveBeenCalled();
  });

  it("does not retry a job whose authoritative ingress row is gone", async () => {
    const materializer = {
      materialize: vi
        .fn()
        .mockRejectedValue(
          new PostEventFeedbackIngressNotFoundError(ingressId),
        ),
    };
    const processor = createProcessor(materializer);

    await expect(
      processor.process(createJob(validData)),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it("does not retry a rejected conversation replay", async () => {
    const materializer = {
      materialize: vi
        .fn()
        .mockRejectedValue(
          new ConversationPersistenceError("replayed with different content"),
        ),
    };
    const processor = createProcessor(materializer);

    await expect(
      processor.process(createJob(validData)),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it("preserves transient dependency failures for configured retries", async () => {
    const transient = new Error("mongo temporarily unavailable");
    const materializer = {
      materialize: vi.fn().mockRejectedValue(transient),
    };
    const processor = createProcessor(materializer);

    await expect(processor.process(createJob(validData))).rejects.toBe(
      transient,
    );
  });

  it("converts a retained extraction job into durable V2 work without model entry", async () => {
    const materializer = { materialize: vi.fn() };
    const wakeups = {
      schedule: vi.fn().mockResolvedValue("feedback-reconcile-v2-job"),
    };
    const processor = createProcessor(materializer, wakeups);

    await processor.process(createExtractJob());

    expect(wakeups.schedule).toHaveBeenCalledWith({
      conversationId,
      nextActionAt: expect.any(Date),
      correlationId: "correlation-1",
    });
    expect(materializer.materialize).not.toHaveBeenCalled();
  });

  it("discards a retained relay wake-up after validating its envelope", async () => {
    const processor = createProcessor({ materialize: vi.fn() });

    await processor.process(
      createJob(
        { schemaVersion: 1, correlationId: "legacy-relay" },
        FEEDBACK_JOB_NAMES.relayOutboxV1,
        FEEDBACK_JOB_NAMES.relayOutboxV1,
      ),
    );
  });

  it("discards a retained delivery job without entering a delivery service", async () => {
    const processor = createProcessor({ materialize: vi.fn() });
    const outboxId = "39f8136d-bde4-4600-8e63-1602270b3574";

    await processor.process(
      createJob(
        {
          schemaVersion: 1,
          outboxId,
          correlationId: "legacy-delivery",
        },
        FEEDBACK_JOB_NAMES.deliverV1,
        createFeedbackDeliverJobId(outboxId),
      ),
    );
  });

  it("rejects a retained delivery job whose id does not match its row", async () => {
    const processor = createProcessor({ materialize: vi.fn() });
    const outboxId = "39f8136d-bde4-4600-8e63-1602270b3574";

    await expect(
      processor.process(
        createJob(
          {
            schemaVersion: 1,
            outboxId,
            correlationId: "legacy-delivery",
          },
          FEEDBACK_JOB_NAMES.deliverV1,
          "hand-made-delivery-id",
        ),
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it.each([
    FEEDBACK_JOB_NAMES.sweepRemindersV1,
    FEEDBACK_JOB_NAMES.sweepExpiryV1,
  ])("converts retained %s work into current-state recovery", async (name) => {
    const wakeups = {
      schedule: vi.fn(),
      recoverDue: vi.fn().mockResolvedValue({ examined: 0, queued: 0 }),
    };
    const sweeps = {
      sweepIngress: vi.fn(),
    };
    const processor = createProcessor(
      { materialize: vi.fn() },
      wakeups,
      sweeps,
    );

    await processor.process(
      createJob(
        { schemaVersion: 1, correlationId: "legacy-sweep" },
        name,
        name,
      ),
    );

    expect(wakeups.recoverDue).toHaveBeenCalledWith("legacy-sweep");
  });

  it("does not retry unsupported job names", async () => {
    const materializer = { materialize: vi.fn() };
    const processor = createProcessor(materializer);

    await expect(
      processor.process(createJob(validData, "feedback.unknown" as never)),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it("converts a retained summary job into its durable V2 attempt", async () => {
    const summaries = {
      convertLegacyWakeup: vi
        .fn()
        .mockResolvedValue("feedback-summarize-v2-job"),
    };
    const processor = new PostEventFeedbackProcessor(
      { materialize: vi.fn() } as never,
      {
        sweepIngress: vi.fn(),
      } as never,
      summaries as never,
      { schedule: vi.fn() } as never,
    );

    const data = {
      schemaVersion: 1,
      campaignId,
      correlationId: "correlation-summary",
    };
    const jobId = createFeedbackSummarizeCampaignJobId(campaignId, 1);

    await processor.process(
      createJob(data, FEEDBACK_JOB_NAMES.summarizeCampaignV1, jobId),
    );

    expect(summaries.convertLegacyWakeup).toHaveBeenCalledWith({
      campaignId,
      attempt: 1,
      correlationId: "correlation-summary",
    });
  });
});

function createProcessor(
  materializer: { materialize: ReturnType<typeof vi.fn> },
  wakeups: {
    schedule: ReturnType<typeof vi.fn>;
    recoverDue?: ReturnType<typeof vi.fn>;
  } = {
    schedule: vi.fn().mockResolvedValue("feedback-reconcile-v2-job"),
  },
  sweeps: {
    sweepIngress: ReturnType<typeof vi.fn>;
  } = {
    sweepIngress: vi.fn(),
  },
): PostEventFeedbackProcessor {
  return new PostEventFeedbackProcessor(
    materializer as unknown as PostEventFeedbackMaterializationCoordinator,
    sweeps as never,
    { convertLegacyWakeup: vi.fn() } as never,
    wakeups as unknown as FeedbackConversationWakeupService,
  );
}

function createExtractJob(
  attempt: { attemptsMade?: number; attempts?: number } = {},
): Job<FeedbackJobData, void, FeedbackJobName> {
  return createJob(
    { schemaVersion: 1, conversationId, correlationId: "correlation-1" },
    FEEDBACK_JOB_NAMES.extractV1,
    `feedback-extract-v1-${conversationId}-1`,
    attempt,
  );
}

function createJob(
  data: unknown,
  name: FeedbackJobName = FEEDBACK_JOB_NAMES.materializeV1,
  id = createFeedbackMaterializeJobId(ingressId),
  // The queue configures five attempts, so a job fixture that omits them would
  // read every first failure as an exhausted one.
  attempt: { attemptsMade?: number; attempts?: number } = {},
): Job<FeedbackJobData, void, FeedbackJobName> {
  return {
    id,
    name,
    data,
    attemptsMade: attempt.attemptsMade ?? 0,
    opts: { attempts: attempt.attempts ?? 5 },
  } as unknown as Job<FeedbackJobData, void, FeedbackJobName>;
}
