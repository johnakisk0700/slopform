import { describe, expect, it, vi } from "vitest";

import {
  inspectFeedbackExtractJobs,
  unreadParticipantSeqs,
} from "./inspect-extract-jobs.js";

describe("unreadParticipantSeqs", () => {
  it("counts only participant turns beyond the extraction cursor", () => {
    expect(
      unreadParticipantSeqs({
        extraction: { cursorSeq: 2 },
        messages: [
          { seq: 1, actor: "bot" },
          { seq: 2, actor: "participant" },
          { seq: 3, actor: "participant" },
          { seq: 4, actor: "bot" },
          { seq: 5, actor: "participant" },
        ],
      }),
    ).toEqual([3, 5]);
  });

  it("returns cursor positions in sequence order even when the transcript is rendered by time", () => {
    expect(
      unreadParticipantSeqs({
        extraction: { cursorSeq: 1 },
        messages: [
          { seq: 3, actor: "participant" },
          { seq: 2, actor: "participant" },
        ],
      }),
    ).toEqual([2, 3]);
  });
});

describe("inspectFeedbackExtractJobs", () => {
  it("reports delayed due time, active and failed without inventing idle", async () => {
    const delayed = {
      timestamp: Date.parse("2026-07-27T10:00:00.000Z"),
      opts: { delay: 45_000 },
      getState: vi.fn().mockResolvedValue("delayed"),
      failedReason: undefined,
    };
    const active = {
      timestamp: Date.parse("2026-07-27T09:00:00.000Z"),
      opts: { delay: 0 },
      getState: vi.fn().mockResolvedValue("active"),
      failedReason: undefined,
    };
    const failed = {
      timestamp: Date.parse("2026-07-27T08:00:00.000Z"),
      opts: { delay: 0 },
      getState: vi.fn().mockResolvedValue("failed"),
      failedReason: "Feedback extraction failed permanently: provider_refusal",
    };
    const queue = {
      getJob: vi
        .fn()
        .mockResolvedValueOnce(delayed)
        .mockResolvedValueOnce(active)
        .mockResolvedValueOnce(failed),
    };

    const result = await inspectFeedbackExtractJobs(
      queue,
      "6f0f2f8a-2b73-5a02-9d0a-3f0b8f5b1c21",
      [3, 4, 5],
    );

    expect(result).toEqual({
      active: true,
      pending: true,
      failedReason: "Feedback extraction failed permanently: provider_refusal",
      nextExtractionAt: new Date("2026-07-27T10:00:45.000Z"),
      jobFound: true,
    });
  });

  it("treats a missing job as unknown rather than idle", async () => {
    const result = await inspectFeedbackExtractJobs(
      { getJob: vi.fn().mockResolvedValue(null) },
      "6f0f2f8a-2b73-5a02-9d0a-3f0b8f5b1c21",
      [3],
    );

    expect(result).toEqual({
      active: false,
      pending: false,
      failedReason: null,
      nextExtractionAt: null,
      jobFound: false,
    });
  });
});
