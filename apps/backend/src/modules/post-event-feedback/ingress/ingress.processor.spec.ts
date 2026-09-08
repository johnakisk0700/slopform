import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import { UnrecoverableError } from "bullmq";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ConversationPersistenceError } from "../../conversations/conversation-persistence.errors.js";
import {
  createFeedbackMaterializeJobId,
  FEEDBACK_JOB_NAMES,
  type FeedbackJobData,
  type FeedbackJobName,
} from "../jobs.schemas.js";
import { PostEventFeedbackIngressProcessor } from "./ingress.processor.js";
import type { PostEventFeedbackMaterializationCoordinator } from "./materialization-coordinator.service.js";
import { PostEventFeedbackIngressNotFoundError } from "./materialize.service.js";

const ingressId = "b1c9e0a4-2c65-4a29-9a2e-2d0a3f2e1b77";
const validData = {
  schemaVersion: 1,
  ingressId,
  correlationId: "correlation-1",
};

describe("PostEventFeedbackIngressProcessor", () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  it("refuses a job id that does not derive from its own payload", async () => {
    const materializer = { materialize: vi.fn() };
    const job = createJob(validData, "feedback-materialize-v1-forged");

    await expect(createProcessor(materializer).process(job)).rejects.toThrow(
      UnrecoverableError,
    );
    expect(materializer.materialize).not.toHaveBeenCalled();
  });

  it("refuses a job this queue does not own", async () => {
    const materializer = { materialize: vi.fn() };
    const job = {
      ...createJob(validData),
      name: FEEDBACK_JOB_NAMES.extractV1,
    } as Job<FeedbackJobData, void, FeedbackJobName>;

    await expect(createProcessor(materializer).process(job)).rejects.toThrow(
      UnrecoverableError,
    );
    expect(materializer.materialize).not.toHaveBeenCalled();
  });

  it("buries an invalid payload instead of retrying it", async () => {
    const materializer = { materialize: vi.fn() };
    const job = createJob({ schemaVersion: 1, ingressId: "not-a-uuid" });

    await expect(createProcessor(materializer).process(job)).rejects.toThrow(
      UnrecoverableError,
    );
  });

  it.each([
    [
      "a missing ingress row",
      new PostEventFeedbackIngressNotFoundError(ingressId),
    ],
    ["a rejected transition", new ConversationPersistenceError("replayed")],
  ])("buries %s rather than retrying a permanent fault", async (_, error) => {
    const materializer = { materialize: vi.fn().mockRejectedValue(error) };

    await expect(
      createProcessor(materializer).process(createJob(validData)),
    ).rejects.toThrow(UnrecoverableError);
  });

  it("retries anything it cannot classify", async () => {
    const error = new Error("mongo is unreachable");
    const materializer = { materialize: vi.fn().mockRejectedValue(error) };

    await expect(
      createProcessor(materializer).process(createJob(validData)),
    ).rejects.toBe(error);
  });
});

function createProcessor(materializer: {
  materialize: unknown;
}): PostEventFeedbackIngressProcessor {
  return new PostEventFeedbackIngressProcessor(
    materializer as unknown as PostEventFeedbackMaterializationCoordinator,
  );
}

function createJob(
  data: unknown,
  id = createFeedbackMaterializeJobId(ingressId),
): Job<FeedbackJobData, void, FeedbackJobName> {
  return {
    id,
    name: FEEDBACK_JOB_NAMES.materializeV1,
    data,
    attemptsMade: 0,
    opts: { attempts: 5 },
  } as unknown as Job<FeedbackJobData, void, FeedbackJobName>;
}
