import { Injectable } from "@nestjs/common";

import { FeedbackConversationRepository } from "../post-event-feedback/post-event-feedback-conversation.repository.js";
import { FeedbackOutboxRepository } from "../post-event-feedback/outbox/outbox.repository.js";
import { OverviewRepository } from "./overview.repository.js";
import type { OverviewOutboxView, OverviewView } from "./overview.schemas.js";

@Injectable()
export class OverviewService {
  constructor(
    private readonly overview: OverviewRepository,
    private readonly conversations: FeedbackConversationRepository,
    private readonly outbox: FeedbackOutboxRepository,
  ) {}

  async get(now = new Date()): Promise<OverviewView> {
    const failedSince = new Date(now.getTime() - 24 * 60 * 60_000);

    const [
      events,
      participants,
      campaigns,
      summaries,
      conversationStats,
      undeliveredByStatus,
      oldestUndeliveredAt,
      failedLast24Hours,
    ] = await Promise.all([
      this.overview.loadEventsSnapshot(),
      this.overview.loadParticipantsSnapshot(),
      this.overview.loadCampaignStatusCounts(),
      this.overview.loadSummaryCounts(),
      this.conversations.aggregateOverviewStats(),
      this.outbox.countUndeliveredOutboxByStatus(),
      this.outbox.findOldestUndeliveredCreatedAt(),
      this.outbox.countFailedOutboxSince(failedSince),
    ]);

    return {
      observedAt: now.toISOString(),
      events,
      participants,
      feedback: {
        campaigns,
        conversations: conversationStats,
        outbox: toOutboxView(
          undeliveredByStatus,
          oldestUndeliveredAt,
          failedLast24Hours,
        ),
        summaries,
      },
    };
  }
}

function toOutboxView(
  totals: Awaited<
    ReturnType<FeedbackOutboxRepository["countUndeliveredOutboxByStatus"]>
  >,
  oldestUndeliveredAt: Date | null,
  failedLast24Hours: number,
): OverviewOutboxView {
  const pending = totals.get("pending") ?? 0;
  const claimed = totals.get("claimed") ?? 0;
  const attempting = totals.get("attempting") ?? 0;
  const ambiguous = totals.get("ambiguous") ?? 0;
  const sending = totals.get("sending") ?? 0;
  const held = totals.get("held") ?? 0;

  return {
    pending,
    held,
    claimed,
    attempting,
    ambiguous,
    sending,
    totalUndelivered:
      pending + claimed + attempting + ambiguous + sending + held,
    oldestUndeliveredAt: oldestUndeliveredAt?.toISOString() ?? null,
    failedLast24Hours,
  };
}
