import { Logger } from "@nestjs/common";
import { DelayedError, UnrecoverableError, type Job } from "bullmq";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { PostEventFeedbackExtractionFallback } from "../extraction/fallback.service.js";
import type { FeedbackConversationExecutionLimiter } from "../extraction/execution-limiter.service.js";
import { FeedbackExtractionGenerationError } from "../extraction/model.service.js";
import { FeedbackConversationExecutionGuardError } from "../extraction/extract.service.js";
import {
  createFeedbackReconcileConversationJobId,
  FEEDBACK_JOB_NAMES,
  type FeedbackJobData,
  type FeedbackJobName,
} from "../jobs.schemas.js";
import {
  FEEDBACK_CLAIM_BUSY_RETRY_MS,
  FeedbackConversationReconcileProcessor,
} from "./reconcile.processor.js";
import { FEEDBACK_RECONCILIATION_INVARIANT_FAILURE_REASON } from "./reconcile-failure.js";
import type { FeedbackConversationReconcileService } from "./reconcile.service.js";

const conversationId = "85b4e284-28d9-55e5-9d8b-e981671d37d2";
const data = {
  schemaVersion: 2 as const,
  conversationId,
  revision: 7,
  correlationId: "reconcile-processor-test",
};

describe("FeedbackConversationReconcileProcessor", () => {
  beforeAll(() => Logger.overrideLogger(false));

  it("runs a valid fenced revision through the reconciler", async () => {
    const harness = createHarness();

    await harness.processor.process(createJob());

    expect(harness.reconciler.reconcile).toHaveBeenCalledWith(data);
    expect(harness.legacyConversationExecutions.run).toHaveBeenCalledWith(
      conversationId,
      expect.any(Function),
    );
  });

  it("rejects a malformed reconciliation payload without touching durable state", async () => {
    const harness = createHarness();

    await expect(
      harness.processor.process(
        createJob({ data: { ...data, schemaVersion: 1 } }),
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);

    expect(harness.reconciler.reconcile).not.toHaveBeenCalled();
    expect(harness.legacyConversationExecutions.run).not.toHaveBeenCalled();
    expect(harness.fallback.apply).not.toHaveBeenCalled();
    expect(harness.fallback.park).not.toHaveBeenCalled();
  });

  it("rejects a job id that does not fence the payload revision", async () => {
    const harness = createHarness();

    await expect(
      harness.processor.process(createJob({ id: "hand-written-id" })),
    ).rejects.toBeInstanceOf(UnrecoverableError);

    expect(harness.reconciler.reconcile).not.toHaveBeenCalled();
  });

  it("keeps a successor wake-up live while the previous revision owns the claim", async () => {
    const harness = createHarness();
    const job = createJob();
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    harness.reconciler.reconcile.mockResolvedValue("claim_busy");

    await expect(harness.processor.process(job)).rejects.toBeInstanceOf(
      DelayedError,
    );

    expect(job.moveToDelayed).toHaveBeenCalledWith(
      now + FEEDBACK_CLAIM_BUSY_RETRY_MS,
      "worker-token",
    );
    expect(harness.fallback.apply).not.toHaveBeenCalled();
    expect(harness.fallback.park).not.toHaveBeenCalled();
    nowSpy.mockRestore();
  });

  it("leaves a transient failure untouched while BullMQ attempts remain", async () => {
    const harness = createHarness();
    const transient = new Error("MongoDB temporarily unavailable");
    harness.reconciler.reconcile.mockRejectedValue(transient);

    await expect(
      harness.processor.process(createJob({ attemptsMade: 1, attempts: 5 })),
    ).rejects.toBe(transient);

    expect(harness.fallback.apply).not.toHaveBeenCalled();
    expect(harness.fallback.park).not.toHaveBeenCalled();
  });

  it("treats authoritative state supersession as successful completion", async () => {
    const harness = createHarness();
    harness.reconciler.reconcile.mockRejectedValue(
      new FeedbackConversationExecutionGuardError(
        conversationId,
        "authoritative_state_changed",
      ),
    );

    await expect(
      harness.processor.process(createJob()),
    ).resolves.toBeUndefined();

    expect(harness.fallback.apply).not.toHaveBeenCalled();
    expect(harness.fallback.park).not.toHaveBeenCalled();
  });

  it("leaves execution claim loss retryable without participant fallback", async () => {
    const harness = createHarness();
    const failure = new FeedbackConversationExecutionGuardError(
      conversationId,
      "execution_claim_lost",
    );
    harness.reconciler.reconcile.mockRejectedValue(failure);

    await expect(harness.processor.process(createJob())).rejects.toBe(failure);

    expect(harness.fallback.apply).not.toHaveBeenCalled();
    expect(harness.fallback.park).not.toHaveBeenCalled();
  });

  it("quarantines execution invariants as unrecoverable without participant fallback", async () => {
    const harness = createHarness();
    harness.reconciler.reconcile.mockRejectedValue(
      new FeedbackConversationExecutionGuardError(
        conversationId,
        "execution_invariant_broken",
      ),
    );

    await expect(harness.processor.process(createJob())).rejects.toMatchObject({
      name: "UnrecoverableError",
      message: FEEDBACK_RECONCILIATION_INVARIANT_FAILURE_REASON,
    });

    expect(harness.fallback.apply).not.toHaveBeenCalled();
    expect(harness.fallback.park).not.toHaveBeenCalled();
  });

  it.each([
    ["planning", "campaign lookup unavailable"],
    ["reminder", "reminder outbox transaction failed"],
    ["expiry", "expiry close transaction failed"],
    ["settlement", "work settlement failed"],
  ])(
    "does not misclassify an exhausted %s failure as extraction failure",
    async (_stage, message) => {
      const harness = createHarness();
      const failure = new Error(message);
      harness.reconciler.reconcile.mockRejectedValue(failure);

      await expect(
        harness.processor.process(createJob({ attemptsMade: 4, attempts: 5 })),
      ).rejects.toBe(failure);

      expect(harness.fallback.apply).not.toHaveBeenCalled();
      expect(harness.fallback.park).not.toHaveBeenCalled();
    },
  );

  it("lets deterministic fallback own the atomic human handoff", async () => {
    const harness = createHarness();
    const events: string[] = [];
    harness.legacyConversationExecutions.run.mockImplementation(
      async (_conversationId: string, work: () => Promise<unknown>) => {
        events.push("lock_started");
        try {
          return await work();
        } finally {
          events.push("lock_finished");
        }
      },
    );
    harness.fallback.apply.mockImplementation(async () => {
      events.push("fallback_applied");
      return { applied: true };
    });
    harness.reconciler.reconcile.mockRejectedValue(
      new FeedbackExtractionGenerationError(
        "extraction_failed",
        false,
        "provider_refusal",
      ),
    );

    await expect(harness.processor.process(createJob())).rejects.toThrow(
      "Feedback extraction failed permanently: provider_refusal",
    );

    expect(harness.fallback.apply).toHaveBeenCalledWith({
      conversationId,
      correlationId: data.correlationId,
      cause: "provider_refusal",
    });
    expect(harness.fallback.park).not.toHaveBeenCalled();
    expect(events).toEqual([
      "lock_started",
      "fallback_applied",
      "lock_finished",
    ]);
  });

  it("parks a provider incident only after its transient retries are exhausted", async () => {
    const harness = createHarness();
    harness.reconciler.reconcile.mockRejectedValue(
      new FeedbackExtractionGenerationError(
        "extraction_failed",
        true,
        "provider_error",
      ),
    );

    await expect(
      harness.processor.process(createJob({ attemptsMade: 4, attempts: 5 })),
    ).rejects.toThrow("Feedback extraction parked on the provider");

    expect(harness.fallback.park).toHaveBeenCalledWith({
      conversationId,
      correlationId: data.correlationId,
      cause: "provider_error",
    });
    expect(harness.fallback.apply).not.toHaveBeenCalled();
  });
});

function createHarness() {
  const reconciler = { reconcile: vi.fn().mockResolvedValue("settled") };
  const fallback = {
    apply: vi.fn().mockResolvedValue({ applied: true }),
    park: vi.fn().mockResolvedValue({ parked: true }),
  };
  const legacyConversationExecutions = {
    run: vi.fn(async (_conversationId: string, work: () => Promise<unknown>) =>
      work(),
    ),
  };
  const processor = new FeedbackConversationReconcileProcessor(
    reconciler as unknown as FeedbackConversationReconcileService,
    fallback as unknown as PostEventFeedbackExtractionFallback,
    legacyConversationExecutions as unknown as FeedbackConversationExecutionLimiter,
  );
  return {
    processor,
    reconciler,
    fallback,
    legacyConversationExecutions,
  };
}

function createJob(
  options: {
    readonly data?: unknown;
    readonly id?: string;
    readonly attemptsMade?: number;
    readonly attempts?: number;
  } = {},
): Job<FeedbackJobData, void, FeedbackJobName> {
  return {
    id:
      options.id ??
      createFeedbackReconcileConversationJobId(
        data.conversationId,
        data.revision,
      ),
    name: FEEDBACK_JOB_NAMES.reconcileConversationV2,
    data: options.data ?? data,
    token: "worker-token",
    moveToDelayed: vi.fn().mockResolvedValue(undefined),
    attemptsMade: options.attemptsMade ?? 0,
    opts: { attempts: options.attempts ?? 5 },
  } as unknown as Job<FeedbackJobData, void, FeedbackJobName>;
}
