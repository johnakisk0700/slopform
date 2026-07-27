import { getQueueToken } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { SELF_DECLARED_DEPS_METADATA } from "@nestjs/common/constants.js";
import type { Job } from "bullmq";
import { UnrecoverableError } from "bullmq";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  FEEDBACK_INGRESS_QUEUE,
  FEEDBACK_QUEUE,
} from "../../../infrastructure/queue/queue.constants.js";
import { ConversationPersistenceError } from "../../conversations/conversation-persistence.errors.js";
import {
  createFeedbackMaterializeJobId,
  FEEDBACK_JOB_NAMES,
  type FeedbackJobData,
  type FeedbackJobName,
} from "../jobs.schemas.js";
import { PostEventFeedbackSweepService } from "../sweeps/sweep.service.js";
import {
  FEEDBACK_INGRESS_WORKER_CONCURRENCY,
  PostEventFeedbackIngressProcessor,
} from "./ingress.processor.js";
import {
  PostEventFeedbackIngressNotFoundError,
  type PostEventFeedbackMaterializer,
} from "./materialize.service.js";
import { PostEventFeedbackIngressService } from "./ingress.service.js";

const ingressId = "b1c9e0a4-2c65-4a29-9a2e-2d0a3f2e1b77";
const conversationId = "6f0f2f8a-2b73-5a02-9d0a-3f0b8f5b1c21";
const validData = {
  schemaVersion: 1,
  ingressId,
  correlationId: "correlation-1",
};

/**
 * The separation itself, asserted on the wiring rather than on behaviour.
 *
 * Nothing about a shared queue is wrong in a unit test: materialization and
 * extraction both work, one after the other, in milliseconds. What went wrong
 * only appeared under load, where extraction held every slot for the length of
 * a model call and inbound messages waited an average of 118 seconds to reach
 * the transcript. A test that runs one job at a time can never reproduce that,
 * so it guards the structural fact that prevents it instead.
 */
describe("feedback ingress queue separation", () => {
  it.each([
    ["the webhook edge", PostEventFeedbackIngressService],
    ["ingress recovery", PostEventFeedbackSweepService],
  ])("enqueues materialization off the model-call queue from %s", (_, type) => {
    const declared = (Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, type) ??
      []) as readonly { param: unknown }[];
    const tokens = declared.map((dependency) => dependency.param);

    expect(tokens).toContain(getQueueToken(FEEDBACK_INGRESS_QUEUE));
    expect(tokens).not.toContain(getQueueToken(FEEDBACK_QUEUE));
  });

  it("keeps the two queues distinct", () => {
    expect(FEEDBACK_INGRESS_QUEUE).not.toBe(FEEDBACK_QUEUE);
  });
});

describe("PostEventFeedbackIngressProcessor", () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  it("keeps the documented per-process ordering limit explicit", () => {
    expect(FEEDBACK_INGRESS_WORKER_CONCURRENCY).toBe(1);
  });

  it("materializes a valid job through the durable consumer", async () => {
    const materializer = {
      materialize: vi
        .fn()
        .mockResolvedValue({ outcome: "inbound_materialized", conversationId }),
    };

    await createProcessor(materializer).process(createJob(validData));

    expect(materializer.materialize).toHaveBeenCalledWith(validData);
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
    materializer as unknown as PostEventFeedbackMaterializer,
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
