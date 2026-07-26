import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import { UnrecoverableError } from "bullmq";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { ConversationPersistenceError } from "../conversations/conversation-persistence.errors.js";
import type { PostEventFeedbackExtractionFallback } from "./extraction/fallback.service.js";
import { FeedbackExtractionGenerationError } from "./extraction/model.service.js";
import {
  PostEventFeedbackConversationNotFoundError,
  type PostEventFeedbackExtractor,
} from "./extraction/extract.service.js";
import {
  PostEventFeedbackIngressNotFoundError,
  type PostEventFeedbackMaterializer,
} from "./ingress/materialize.service.js";
import type { MessageOutboxDeliveryService } from "./outbox/deliver.service.js";
import type { MessageOutboxRelayService } from "./outbox/relay.service.js";
import {
  FEEDBACK_WORKER_CONCURRENCY,
  PostEventFeedbackProcessor,
} from "./processor.js";
import {
  createFeedbackMaterializeJobId,
  FEEDBACK_JOB_NAMES,
  type FeedbackJobData,
  type FeedbackJobName,
} from "./jobs.schemas.js";

const ingressId = "b1c9e0a4-2c65-4a29-9a2e-2d0a3f2e1b77";
const conversationId = "6f0f2f8a-2b73-5a02-9d0a-3f0b8f5b1c21";
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
    expect(FEEDBACK_WORKER_CONCURRENCY).toBe(1);
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

  it("routes an extraction job to the extractor, not the materializer", async () => {
    const materializer = { materialize: vi.fn() };
    const extractor = {
      extract: vi.fn().mockResolvedValue({
        outcome: "extracted",
        conversationId,
        cursorSeq: 1,
        answersWritten: 1,
        notesWritten: 0,
      }),
    };
    const processor = createProcessor(materializer, extractor);

    await processor.process(createExtractJob());

    expect(extractor.extract).toHaveBeenCalledWith({
      schemaVersion: 1,
      conversationId,
      correlationId: "correlation-1",
    });
    expect(materializer.materialize).not.toHaveBeenCalled();
  });

  it("does not retry an extraction whose conversation is gone", async () => {
    const extractor = {
      extract: vi
        .fn()
        .mockRejectedValue(
          new PostEventFeedbackConversationNotFoundError(conversationId),
        ),
    };
    const processor = createProcessor({ materialize: vi.fn() }, extractor);

    await expect(processor.process(createExtractJob())).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
  });

  it("does not retry a permanent provider failure", async () => {
    const extractor = {
      extract: vi
        .fn()
        .mockRejectedValue(
          new FeedbackExtractionGenerationError("provider_unavailable", false),
        ),
    };
    const processor = createProcessor({ materialize: vi.fn() }, extractor);

    await expect(processor.process(createExtractJob())).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
  });

  it("retries a transient provider failure", async () => {
    const transient = new FeedbackExtractionGenerationError(
      "extraction_failed",
      true,
    );
    const extractor = { extract: vi.fn().mockRejectedValue(transient) };
    const processor = createProcessor({ materialize: vi.fn() }, extractor);

    await expect(processor.process(createExtractJob())).rejects.toBe(transient);
  });

  it("does not retry unsupported job names", async () => {
    const materializer = { materialize: vi.fn() };
    const processor = createProcessor(materializer);

    await expect(
      processor.process(createJob(validData, "feedback.unknown" as never)),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  describe("terminal extraction failure", () => {
    it("applies the fallback and names the cause in the failure reason", async () => {
      const extractor = {
        extract: vi
          .fn()
          .mockRejectedValue(
            new FeedbackExtractionGenerationError(
              "provider_rejected",
              false,
              "provider_refusal",
            ),
          ),
      };
      const fallback = { apply: vi.fn().mockResolvedValue({ applied: true }) };
      const processor = createProcessor(
        { materialize: vi.fn() },
        extractor,
        fallback,
      );

      // The message becomes BullMQ's `failedReason`, which is where an operator
      // reading the queue sees the class without opening the audit table.
      await expect(processor.process(createExtractJob())).rejects.toThrow(
        "Feedback extraction failed permanently: provider_refusal",
      );
      expect(fallback.apply).toHaveBeenCalledWith({
        conversationId,
        correlationId: "correlation-1",
        cause: "provider_refusal",
      });
    });

    it("applies the fallback once the last attempt is spent", async () => {
      const extractor = {
        extract: vi
          .fn()
          .mockRejectedValue(
            new FeedbackExtractionGenerationError(
              "extraction_failed",
              true,
              "validation_failed",
            ),
          ),
      };
      const fallback = { apply: vi.fn().mockResolvedValue({ applied: true }) };
      const processor = createProcessor(
        { materialize: vi.fn() },
        extractor,
        fallback,
      );

      await expect(
        processor.process(createExtractJob({ attemptsMade: 4, attempts: 5 })),
      ).rejects.toThrow(
        "Feedback extraction failed permanently: validation_failed",
      );
      expect(fallback.apply).toHaveBeenCalledWith(
        expect.objectContaining({ cause: "validation_failed" }),
      );
    });

    it("leaves a retryable failure alone while attempts remain", async () => {
      const transient = new FeedbackExtractionGenerationError(
        "extraction_failed",
        true,
        "provider_error",
      );
      const extractor = { extract: vi.fn().mockRejectedValue(transient) };
      const fallback = { apply: vi.fn() };
      const processor = createProcessor(
        { materialize: vi.fn() },
        extractor,
        fallback,
      );

      await expect(
        processor.process(createExtractJob({ attemptsMade: 1, attempts: 5 })),
      ).rejects.toBe(transient);
      expect(fallback.apply).not.toHaveBeenCalled();
    });

    it("classifies an unrecognised failure as unknown", async () => {
      const extractor = {
        extract: vi.fn().mockRejectedValue(new Error("mongo went away")),
      };
      const fallback = { apply: vi.fn().mockResolvedValue({ applied: true }) };
      const processor = createProcessor(
        { materialize: vi.fn() },
        extractor,
        fallback,
      );

      await expect(
        processor.process(createExtractJob({ attemptsMade: 4, attempts: 5 })),
      ).rejects.toThrow("Feedback extraction failed permanently: unknown");
    });

    it("does not attempt a fallback for a conversation that no longer exists", async () => {
      const extractor = {
        extract: vi
          .fn()
          .mockRejectedValue(
            new PostEventFeedbackConversationNotFoundError(conversationId),
          ),
      };
      const fallback = { apply: vi.fn() };
      const processor = createProcessor(
        { materialize: vi.fn() },
        extractor,
        fallback,
      );

      await expect(
        processor.process(createExtractJob()),
      ).rejects.toBeInstanceOf(UnrecoverableError);
      expect(fallback.apply).not.toHaveBeenCalled();
    });

    it("keeps the original diagnosis when the fallback itself fails", async () => {
      const extractor = {
        extract: vi
          .fn()
          .mockRejectedValue(
            new FeedbackExtractionGenerationError(
              "provider_rejected",
              false,
              "provider_refusal",
            ),
          ),
      };
      const fallback = {
        apply: vi.fn().mockRejectedValue(new Error("postgres unavailable")),
      };
      const processor = createProcessor(
        { materialize: vi.fn() },
        extractor,
        fallback,
      );

      await expect(processor.process(createExtractJob())).rejects.toThrow(
        "Feedback extraction failed permanently: provider_refusal",
      );
    });
  });
});

function createProcessor(
  materializer: { materialize: ReturnType<typeof vi.fn> },
  extractor: { extract: ReturnType<typeof vi.fn> } = { extract: vi.fn() },
  fallback: { apply: ReturnType<typeof vi.fn> } = {
    apply: vi.fn().mockResolvedValue({ applied: true }),
  },
): PostEventFeedbackProcessor {
  return new PostEventFeedbackProcessor(
    materializer as unknown as PostEventFeedbackMaterializer,
    { relay: vi.fn() } as unknown as MessageOutboxRelayService,
    { deliver: vi.fn() } as unknown as MessageOutboxDeliveryService,
    extractor as unknown as PostEventFeedbackExtractor,
    {
      sweepReminders: vi.fn(),
      sweepExpiry: vi.fn(),
      sweepIngress: vi.fn(),
    } as never,
    fallback as unknown as PostEventFeedbackExtractionFallback,
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
