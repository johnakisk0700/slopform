import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import { UnrecoverableError } from "bullmq";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { ConversationPersistenceError } from "../conversations/conversation-persistence.errors.js";
import { FeedbackExtractionGenerationError } from "./post-event-feedback-extraction.service.js";
import {
  PostEventFeedbackConversationNotFoundError,
  type PostEventFeedbackExtractor,
} from "./post-event-feedback-extractor.service.js";
import {
  PostEventFeedbackIngressNotFoundError,
  type PostEventFeedbackMaterializer,
} from "./post-event-feedback-materializer.service.js";
import type { MessageOutboxDeliveryService } from "./message-outbox-delivery.service.js";
import type { MessageOutboxRelayService } from "./message-outbox-relay.service.js";
import { PostEventFeedbackProcessor } from "./post-event-feedback.processor.js";
import {
  createFeedbackMaterializeJobId,
  FEEDBACK_JOB_NAMES,
  type FeedbackJobData,
  type FeedbackJobName,
} from "./post-event-feedback.schemas.js";

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
});

function createProcessor(
  materializer: { materialize: ReturnType<typeof vi.fn> },
  extractor: { extract: ReturnType<typeof vi.fn> } = { extract: vi.fn() },
): PostEventFeedbackProcessor {
  return new PostEventFeedbackProcessor(
    materializer as unknown as PostEventFeedbackMaterializer,
    { relay: vi.fn() } as unknown as MessageOutboxRelayService,
    { deliver: vi.fn() } as unknown as MessageOutboxDeliveryService,
    extractor as unknown as PostEventFeedbackExtractor,
  );
}

function createExtractJob(): Job<FeedbackJobData, void, FeedbackJobName> {
  return createJob(
    { schemaVersion: 1, conversationId, correlationId: "correlation-1" },
    FEEDBACK_JOB_NAMES.extractV1,
    `feedback-extract-v1-${conversationId}-1`,
  );
}

function createJob(
  data: unknown,
  name: FeedbackJobName = FEEDBACK_JOB_NAMES.materializeV1,
  id = createFeedbackMaterializeJobId(ingressId),
): Job<FeedbackJobData, void, FeedbackJobName> {
  return { id, name, data } as unknown as Job<
    FeedbackJobData,
    void,
    FeedbackJobName
  >;
}
