import type { Job, Queue } from "bullmq";
import { describe, expect, it, vi } from "vitest";

import type { FeedbackJobData, FeedbackJobName } from "../jobs.schemas.js";
import type { FeedbackIngressRepository } from "./ingress.repository.js";
import { FeedbackMaterializeWakeupService } from "./materialize-wakeup.service.js";

const ingressId = "b1c9e0a4-2c65-4a29-9a2e-2d0a3f2e1b77";
const jobId = `feedback-materialize-v1-${ingressId}`;

describe("FeedbackMaterializeWakeupService", () => {
  it("does nothing when PostgreSQL no longer owns pending work", async () => {
    const { service, queue } = createService({
      ingressStatuses: ["materialized"],
    });

    await expect(
      service.ensurePendingQueued({ ingressId, correlationId: "redelivery" }),
    ).resolves.toBeUndefined();
    expect(queue.getJob).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("adds one deterministic wake-up only for durable pending ingress", async () => {
    const { service, queue, ingress } = createService();

    await expect(
      service.ensurePendingQueued({ ingressId, correlationId: "webhook" }),
    ).resolves.toBe(jobId);

    expect(ingress.findIngressById).toHaveBeenCalledTimes(2);
    expect(queue.add).toHaveBeenCalledWith(
      "feedback.materialize.v1",
      { schemaVersion: 1, ingressId, correlationId: "webhook" },
      { jobId },
    );
  });

  it("leaves a live wake-up in place", async () => {
    const remove = vi.fn();
    const { service, queue } = createService({
      existing: job("active", remove),
    });

    await expect(
      service.ensurePendingQueued({ ingressId, correlationId: "redelivery" }),
    ).resolves.toBe(jobId);

    expect(remove).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it.each(["completed", "failed"])(
    "removes a retained %s wake-up and re-adds while ingress is pending",
    async (state) => {
      const remove = vi.fn().mockResolvedValue(undefined);
      const { service, queue } = createService({
        existing: job(state, remove),
      });

      await expect(
        service.ensurePendingQueued({ ingressId, correlationId: "repair" }),
      ).resolves.toBe(jobId);

      expect(remove).toHaveBeenCalledOnce();
      expect(queue.add).toHaveBeenCalledOnce();
    },
  );

  it("takes over the add when another producer removed the terminal job first", async () => {
    const removalRace = new Error("job disappeared");
    const remove = vi.fn().mockRejectedValue(removalRace);
    const { service, queue } = createService({
      existing: job("failed", remove),
    });

    await expect(
      service.ensurePendingQueued({ ingressId, correlationId: "repair" }),
    ).resolves.toBe(jobId);

    expect(queue.add).toHaveBeenCalledOnce();
  });

  it("accepts a live replacement that won the terminal-removal race", async () => {
    const remove = vi.fn().mockRejectedValue(new Error("job changed state"));
    const { service, queue } = createService({
      existing: job("failed", remove),
      getJobAfterRemovalRace: job("waiting"),
    });

    await expect(
      service.ensurePendingQueued({ ingressId, correlationId: "repair" }),
    ).resolves.toBe(jobId);

    expect(queue.add).not.toHaveBeenCalled();
  });

  it("fails a terminal-removal race that made no safe progress", async () => {
    const removalRace = new Error("redis remove failed");
    const remove = vi.fn().mockRejectedValue(removalRace);
    const { service, queue } = createService({
      existing: job("failed", remove),
      getJobAfterRemovalRace: job("failed"),
    });

    await expect(
      service.ensurePendingQueued({ ingressId, correlationId: "repair" }),
    ).rejects.toBe(removalRace);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("does not resurrect ingress that became terminal during queue repair", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const { service, queue } = createService({
      existing: job("completed", remove),
      ingressStatuses: ["pending", "materialized"],
    });

    await expect(
      service.ensurePendingQueued({ ingressId, correlationId: "repair" }),
    ).resolves.toBeUndefined();
    expect(queue.add).not.toHaveBeenCalled();
  });
});

function job(
  state: string,
  remove = vi.fn().mockResolvedValue(undefined),
): Job<FeedbackJobData, void, FeedbackJobName> {
  return {
    getState: vi.fn().mockResolvedValue(state),
    remove,
  } as unknown as Job<FeedbackJobData, void, FeedbackJobName>;
}

function createService(
  options: {
    existing?: Job<FeedbackJobData, void, FeedbackJobName>;
    getJobAfterRemovalRace?: Job<FeedbackJobData, void, FeedbackJobName>;
    ingressStatuses?: readonly string[];
  } = {},
) {
  const jobs = [options.existing, options.getJobAfterRemovalRace];
  const getJob = vi.fn().mockImplementation(() => jobs.shift());
  const queue = {
    getJob,
    add: vi.fn().mockResolvedValue({ id: jobId }),
  };
  const statuses = [...(options.ingressStatuses ?? ["pending", "pending"])];
  const ingress = {
    findIngressById: vi.fn().mockImplementation(() =>
      Promise.resolve({
        id: ingressId,
        processingStatus: statuses.shift() ?? "pending",
      }),
    ),
  };
  return {
    service: new FeedbackMaterializeWakeupService(
      queue as unknown as Queue<FeedbackJobData, void, FeedbackJobName>,
      ingress as unknown as FeedbackIngressRepository,
    ),
    queue,
    ingress,
  };
}
