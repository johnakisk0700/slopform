import { describe, expect, it, vi } from "vitest";

import { inspectFeedbackDeliverJob } from "./inspect-deliver-job.js";

const OUTBOX_ID = "3f5a1c94-1f2c-4a8e-9c1a-2b6d0f7e5a11";
const JOB_ID = `feedback-deliver-v1-${OUTBOX_ID}`;

describe("inspectFeedbackDeliverJob", () => {
  it("reports the deterministic job id, its state and its attempt", async () => {
    const getJob = vi.fn().mockResolvedValue({
      timestamp: Date.parse("2026-07-27T11:41:00.000Z"),
      processedOn: Date.parse("2026-07-27T11:41:02.000Z"),
      finishedOn: undefined,
      attemptsMade: 0,
      opts: { attempts: 1, delay: 0 },
      failedReason: undefined,
      getState: vi.fn().mockResolvedValue("active"),
    });

    const result = await inspectFeedbackDeliverJob({ getJob }, OUTBOX_ID);

    expect(getJob).toHaveBeenCalledExactlyOnceWith(JOB_ID);
    expect(result).toEqual({
      jobId: JOB_ID,
      state: "active",
      attemptsMade: 0,
      attemptsAllowed: 1,
      enqueuedAt: new Date("2026-07-27T11:41:00.000Z"),
      dueAt: null,
      startedAt: new Date("2026-07-27T11:41:02.000Z"),
      finishedAt: null,
      failedReason: null,
    });
  });

  it("publishes a due time only for a delayed job", async () => {
    const getJob = vi.fn().mockResolvedValue({
      timestamp: Date.parse("2026-07-27T11:41:00.000Z"),
      processedOn: undefined,
      finishedOn: undefined,
      attemptsMade: 0,
      // The campaign stagger the relay applies to intros and reminders.
      opts: { attempts: 1, delay: 4_000 },
      failedReason: undefined,
      getState: vi.fn().mockResolvedValue("delayed"),
    });

    const result = await inspectFeedbackDeliverJob({ getJob }, OUTBOX_ID);

    expect(result.state).toBe("delayed");
    expect(result.dueAt).toEqual(new Date("2026-07-27T11:41:04.000Z"));
  });

  it("names the failure reason and bounds it", async () => {
    const getJob = vi.fn().mockResolvedValue({
      timestamp: Date.parse("2026-07-27T11:41:00.000Z"),
      processedOn: Date.parse("2026-07-27T11:41:01.000Z"),
      finishedOn: Date.parse("2026-07-27T11:41:03.000Z"),
      attemptsMade: 1,
      opts: { attempts: 1 },
      failedReason: `  ${"x".repeat(900)}  `,
      getState: vi.fn().mockResolvedValue("failed"),
    });

    const result = await inspectFeedbackDeliverJob({ getJob }, OUTBOX_ID);

    expect(result.state).toBe("failed");
    expect(result.failedReason).toHaveLength(500);
    expect(result.finishedAt).toEqual(new Date("2026-07-27T11:41:03.000Z"));
  });

  it("reports a missing job as unknown with nothing invented", async () => {
    const result = await inspectFeedbackDeliverJob(
      { getJob: vi.fn().mockResolvedValue(undefined) },
      OUTBOX_ID,
    );

    // Retention removal, a lease that has not happened yet and a lost job are
    // one read. `unknown` with every field null is the only honest answer.
    expect(result).toEqual({
      jobId: JOB_ID,
      state: "unknown",
      attemptsMade: null,
      attemptsAllowed: null,
      enqueuedAt: null,
      dueAt: null,
      startedAt: null,
      finishedAt: null,
      failedReason: null,
    });
  });

  it("does not publish a BullMQ state it does not know", async () => {
    const getJob = vi.fn().mockResolvedValue({
      timestamp: Date.parse("2026-07-27T11:41:00.000Z"),
      processedOn: undefined,
      finishedOn: undefined,
      attemptsMade: 0,
      opts: {},
      failedReason: undefined,
      getState: vi.fn().mockResolvedValue("hibernating"),
    });

    const result = await inspectFeedbackDeliverJob({ getJob }, OUTBOX_ID);

    expect(result.state).toBe("unknown");
    expect(result.attemptsAllowed).toBeNull();
  });
});
