import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FeedbackConversationRepository } from "../post-event-feedback/post-event-feedback-conversation.repository.js";
import type { FeedbackOutboxRepository } from "../post-event-feedback/outbox/outbox.repository.js";
import type { OverviewRepository } from "./overview.repository.js";
import { OverviewService } from "./overview.service.js";

describe("OverviewService", () => {
  const overview = {
    loadEventsSnapshot: vi.fn(),
    loadParticipantsSnapshot: vi.fn(),
    loadCampaignStatusCounts: vi.fn(),
    loadSummaryCounts: vi.fn(),
  };
  const conversations = {
    aggregateOverviewStats: vi.fn(),
  };
  const outbox = {
    countUndeliveredOutboxByStatus: vi.fn(),
    findOldestUndeliveredCreatedAt: vi.fn(),
    countFailedOutboxSince: vi.fn(),
  };

  let service: OverviewService;

  beforeEach(() => {
    vi.clearAllMocks();
    overview.loadEventsSnapshot.mockResolvedValue({
      total: 2,
      byStatus: { draft: 0, scheduled: 1, finished: 1, cancelled: 0 },
      attendeeCount: 10,
      presentCount: 8,
      finishedWithoutFeedbackCampaignCount: 1,
      nextScheduled: {
        id: "11111111-1111-4111-8111-111111111111",
        title: "August dinner",
        startsAt: "2026-08-15T18:00:00.000Z",
        attendeeCount: 6,
        venueLabel: "Athens",
      },
    });
    overview.loadParticipantsSnapshot.mockResolvedValue({
      total: 20,
      whatsappFeedbackOptInCount: 12,
      withPhoneCount: 15,
      feedbackContactableCount: 11,
    });
    overview.loadCampaignStatusCounts.mockResolvedValue({
      total: 1,
      byStatus: { launched: 1, paused: 0, closed: 0 },
    });
    overview.loadSummaryCounts.mockResolvedValue({
      none: 0,
      pending: 0,
      ready: 1,
      failed: 0,
    });
    conversations.aggregateOverviewStats.mockResolvedValue({
      total: 5,
      open: 2,
      closed: 3,
      byClosedReason: {
        completed: 2,
        declined: 1,
        stopped: 0,
        expired: 0,
        cancelled: 0,
      },
      needsAttention: 1,
      extractionParked: 0,
      attentionByReason: [{ reason: "handoff", count: 1 }],
    });
    outbox.countUndeliveredOutboxByStatus.mockResolvedValue(
      new Map([
        ["pending", 2],
        ["claimed", 0],
        ["attempting", 1],
        ["ambiguous", 0],
        ["sending", 0],
        ["held", 1],
      ]),
    );
    outbox.findOldestUndeliveredCreatedAt.mockResolvedValue(
      new Date("2026-08-04T22:00:00.000Z"),
    );
    outbox.countFailedOutboxSince.mockResolvedValue(3);

    service = new OverviewService(
      overview as unknown as OverviewRepository,
      conversations as unknown as FeedbackConversationRepository,
      outbox as unknown as FeedbackOutboxRepository,
    );
  });

  it("fans out exact aggregates into one Cache-Control-safe snapshot", async () => {
    const now = new Date("2026-08-05T12:00:00.000Z");
    const snapshot = await service.get(now);

    expect(snapshot.observedAt).toBe("2026-08-05T12:00:00.000Z");
    expect(snapshot.events.nextScheduled?.title).toBe("August dinner");
    expect(snapshot.feedback.conversations.needsAttention).toBe(1);
    expect(snapshot.feedback.outbox).toEqual({
      pending: 2,
      held: 1,
      claimed: 0,
      attempting: 1,
      ambiguous: 0,
      sending: 0,
      totalUndelivered: 4,
      oldestUndeliveredAt: "2026-08-04T22:00:00.000Z",
      failedLast24Hours: 3,
    });
    expect(outbox.countFailedOutboxSince).toHaveBeenCalledWith(
      new Date("2026-08-04T12:00:00.000Z"),
    );
  });
});
