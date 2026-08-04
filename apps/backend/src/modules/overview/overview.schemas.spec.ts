import { describe, expect, it } from "vitest";

import { overviewSchema } from "./overview.schemas.js";

const emptyOverview = {
  observedAt: "2026-08-05T00:00:00.000Z",
  events: {
    total: 0,
    byStatus: {
      draft: 0,
      scheduled: 0,
      finished: 0,
      cancelled: 0,
    },
    attendeeCount: 0,
    presentCount: 0,
    finishedWithoutFeedbackCampaignCount: 0,
    nextScheduled: null,
  },
  participants: {
    total: 0,
    whatsappFeedbackOptInCount: 0,
    withPhoneCount: 0,
    feedbackContactableCount: 0,
  },
  feedback: {
    campaigns: {
      total: 0,
      byStatus: {
        launched: 0,
        paused: 0,
        closed: 0,
      },
    },
    conversations: {
      total: 0,
      open: 0,
      closed: 0,
      byClosedReason: {
        completed: 0,
        declined: 0,
        stopped: 0,
        expired: 0,
        cancelled: 0,
      },
      needsAttention: 0,
      extractionParked: 0,
      attentionByReason: [],
    },
    outbox: {
      pending: 0,
      held: 0,
      claimed: 0,
      attempting: 0,
      ambiguous: 0,
      sending: 0,
      totalUndelivered: 0,
      oldestUndeliveredAt: null,
      failedLast24Hours: 0,
    },
    summaries: {
      none: 0,
      pending: 0,
      ready: 0,
      failed: 0,
    },
  },
} as const;

describe("overviewSchema", () => {
  it("accepts an all-zero snapshot", () => {
    expect(overviewSchema.parse(emptyOverview)).toEqual(emptyOverview);
  });

  it("rejects a missing event status key", () => {
    const { scheduled: _scheduled, ...byStatus } =
      emptyOverview.events.byStatus;
    expect(
      overviewSchema.safeParse({
        ...emptyOverview,
        events: {
          ...emptyOverview.events,
          byStatus,
        },
      }).success,
    ).toBe(false);
  });

  it("keeps only positive attention reason counts", () => {
    expect(
      overviewSchema.safeParse({
        ...emptyOverview,
        feedback: {
          ...emptyOverview.feedback,
          conversations: {
            ...emptyOverview.feedback.conversations,
            attentionByReason: [{ reason: "handoff", count: 0 }],
          },
        },
      }).success,
    ).toBe(false);
  });
});
