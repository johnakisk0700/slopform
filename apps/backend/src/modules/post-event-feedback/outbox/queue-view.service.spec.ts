import type { MessageOutboxLogRow } from "@join-the-six/database";
import type { Queue } from "bullmq";
import { describe, expect, it, vi } from "vitest";

import type { ParticipantsRepository } from "../../participants/participants.repository.js";
import type { FeedbackCampaignRepository } from "../campaign/campaign.repository.js";
import type { FeedbackConversationRepository } from "../post-event-feedback-conversation.repository.js";
import type { FeedbackJobData, FeedbackJobName } from "../jobs.schemas.js";
import type { FeedbackOutboundLogRepository } from "./outbound-log.repository.js";
import type { FeedbackOutboxRepository } from "./outbox.repository.js";
import {
  FeedbackOutboxMessageNotFoundError,
  FeedbackOutboxQueueViewService,
} from "./queue-view.service.js";

const CONVERSATION_ID = "7c57f3b8-2b13-48f5-8730-18ac71f490cd";
const CAMPAIGN_ID = "89eccaa5-9ce6-4dcf-a630-5e35e4ec6f0d";
const EVENT_ID = "b0c3d1e2-5f47-4a9b-8c1d-6e2f3a4b5c6d";
const PARTICIPANT_ID = "d4e5f6a7-8b90-4c1d-9e2f-3a4b5c6d7e8f";
const OUTBOX_ID = "66de52a8-1a26-4cbb-b8d1-fcf8bdc2dd51";

const NOW = new Date("2026-07-27T11:43:27.000Z");

const outboxRow = {
  id: OUTBOX_ID,
  conversationId: CONVERSATION_ID,
  campaignId: CAMPAIGN_ID,
  kind: "reply" as const,
  body: "Ευχαριστούμε!",
  status: "pending" as const,
  dedupeKey: "conversation:1:cursor:3",
  createdByStaff: null,
  providerLogId: null,
  providerMessageId: null,
  deliveryStatus: null,
  sentAt: null,
  deliveredAt: null,
  readAt: null,
  playedAt: null,
  deliveryUpdatedAt: null,
  createdAt: new Date("2026-07-27T11:41:00.000Z"),
  updatedAt: new Date("2026-07-27T11:41:00.000Z"),
};

const outboundLogRow = {
  id: "a1b2c3d4-e5f6-4789-a012-3456789abcde",
  outboxId: OUTBOX_ID,
  conversationId: CONVERSATION_ID,
  campaignId: CAMPAIGN_ID,
  origin: "extraction_reply" as const,
  correlationId: "correlation-extract-1",
  decision: {
    origin: "extraction_reply" as const,
    model: "test-model",
    confidence: 0.91,
    closingReason: null,
    askedGoal: "event_score",
    goalStatuses: [{ key: "event_score", status: "asked" }],
  },
  conversationState: {
    lifecycle: { state: "open" as const, reason: null },
    control: { mode: "bot" as const, source: "launch" as const },
    awaitingHuman: false,
    needsAttention: false,
    unresolvedAttentionCount: 0,
    goals: [{ key: "event_score" as const, status: "asked" as const }],
    messageCount: 2,
    latestMessageSeq: 2,
    extractionCursorSeq: 2,
    reminderCount: 0,
  },
  createdAt: new Date("2026-07-27T11:41:00.500Z"),
} satisfies MessageOutboxLogRow;

function createService(overrides: {
  queue?: Partial<Queue>;
  outbox?: Partial<FeedbackOutboxRepository>;
  outboundLogs?: Partial<FeedbackOutboundLogRepository>;
  campaigns?: Partial<FeedbackCampaignRepository>;
  conversations?: Partial<FeedbackConversationRepository>;
  participants?: Partial<ParticipantsRepository>;
}) {
  const queue = {
    getJob: vi.fn().mockResolvedValue(undefined),
    ...overrides.queue,
  };
  const service = new FeedbackOutboxQueueViewService(
    queue as unknown as Queue<FeedbackJobData, void, FeedbackJobName>,
    {
      listUndeliveredOutbox: vi.fn().mockResolvedValue([]),
      countUndeliveredOutboxByStatus: vi.fn().mockResolvedValue(new Map()),
      findOutboxById: vi.fn().mockResolvedValue(undefined),
      ...overrides.outbox,
    } as unknown as FeedbackOutboxRepository,
    {
      findLogByOutboxId: vi.fn().mockResolvedValue(undefined),
      ...overrides.outboundLogs,
    } as unknown as FeedbackOutboundLogRepository,
    {
      findCampaignById: vi.fn().mockResolvedValue({ status: "launched" }),
      ...overrides.campaigns,
    } as unknown as FeedbackCampaignRepository,
    {
      listRespondentsByIds: vi.fn().mockResolvedValue([]),
      ...overrides.conversations,
    } as unknown as FeedbackConversationRepository,
    {
      findByIds: vi.fn().mockResolvedValue([]),
      ...overrides.participants,
    } as unknown as ParticipantsRepository,
  );
  return { service, queue };
}

describe("FeedbackOutboxQueueViewService.listQueue", () => {
  it("never opens the queue, however many rows are waiting", async () => {
    const rows = Array.from({ length: 25 }, (_entry, index) => ({
      row: {
        ...outboxRow,
        id: `${index}`.padStart(8, "0") + OUTBOX_ID.slice(8),
      },
      campaignStatus: "launched" as const,
      eventId: EVENT_ID,
      eventTitle: "Δείπνο Ιουλίου",
    }));
    const { service, queue } = createService({
      outbox: {
        listUndeliveredOutbox: vi.fn().mockResolvedValue(rows),
        countUndeliveredOutboxByStatus: vi
          .fn()
          .mockResolvedValue(new Map([["pending", 25]])),
      },
    });

    const view = await service.listQueue(NOW);

    expect(view.items).toHaveLength(25);
    // The whole point of the screen: a polled list must not cost one Redis
    // round trip per row.
    expect(queue.getJob).not.toHaveBeenCalled();
  });

  it("measures age against the server clock and reports the campaign context", async () => {
    const { service } = createService({
      outbox: {
        listUndeliveredOutbox: vi.fn().mockResolvedValue([
          {
            row: outboxRow,
            campaignStatus: "paused" as const,
            eventId: EVENT_ID,
            eventTitle: "Δείπνο Ιουλίου",
          },
        ]),
        countUndeliveredOutboxByStatus: vi
          .fn()
          .mockResolvedValue(new Map([["pending", 1]])),
      },
      conversations: {
        listRespondentsByIds: vi.fn().mockResolvedValue([
          {
            _id: CONVERSATION_ID,
            respondentParticipantId: PARTICIPANT_ID,
            phoneAtLaunch: "+30690000102",
          },
        ]),
      },
      participants: {
        findByIds: vi.fn().mockResolvedValue([
          {
            id: PARTICIPANT_ID,
            preferredName: "Ελένη Ριπομηνυματού",
            emailNormalized: "eleni@example.com",
          },
        ]),
      },
    });

    const view = await service.listQueue(NOW);

    expect(view.observedAt).toBe("2026-07-27T11:43:27.000Z");
    expect(view.items[0]).toMatchObject({
      waitingSeconds: 147,
      status: "pending",
      campaignStatus: "paused",
      respondentDisplayName: "Ελένη Ριπομηνυματού",
      phoneAtLaunch: "+30690000102",
      eventTitle: "Δείπνο Ιουλίου",
    });
  });

  it("falls back to nothing rather than a name when the conversation is missing", async () => {
    const { service } = createService({
      outbox: {
        listUndeliveredOutbox: vi.fn().mockResolvedValue([
          {
            row: outboxRow,
            campaignStatus: "launched" as const,
            eventId: EVENT_ID,
            eventTitle: "Δείπνο Ιουλίου",
          },
        ]),
        countUndeliveredOutboxByStatus: vi
          .fn()
          .mockResolvedValue(new Map([["pending", 1]])),
      },
    });

    const view = await service.listQueue(NOW);

    expect(view.items[0]).toMatchObject({
      respondentParticipantId: null,
      respondentDisplayName: null,
      phoneAtLaunch: null,
    });
  });

  it("reports the real total when the page is capped", async () => {
    const { service } = createService({
      outbox: {
        listUndeliveredOutbox: vi.fn().mockResolvedValue([
          {
            row: outboxRow,
            campaignStatus: "launched" as const,
            eventId: EVENT_ID,
            eventTitle: "Δείπνο Ιουλίου",
          },
        ]),
        countUndeliveredOutboxByStatus: vi.fn().mockResolvedValue(
          new Map([
            ["pending", 300],
            ["sending", 4],
            ["held", 2],
          ]),
        ),
      },
    });

    const view = await service.listQueue(NOW);

    expect(view.counts).toEqual({
      pending: 300,
      sending: 4,
      held: 2,
      total: 306,
    });
    expect(view.truncated).toBe(true);
  });
});

describe("FeedbackOutboxQueueViewService.getMessageDelivery", () => {
  it("spends exactly one queue lookup on the row an operator opened", async () => {
    const { service, queue } = createService({
      outbox: { findOutboxById: vi.fn().mockResolvedValue(outboxRow) },
    });

    const view = await service.getMessageDelivery(OUTBOX_ID, NOW);

    expect(queue.getJob).toHaveBeenCalledExactlyOnceWith(
      `feedback-deliver-v1-${OUTBOX_ID}`,
    );
    expect(view.job.state).toBe("unknown");
    expect(view.waitingSeconds).toBe(147);
  });

  it("puts a `sending` row on the relay's recovery clock and nothing else", async () => {
    const sending = {
      ...outboxRow,
      status: "sending" as const,
      updatedAt: new Date("2026-07-27T11:42:00.000Z"),
    };
    const { service } = createService({
      outbox: { findOutboxById: vi.fn().mockResolvedValue(sending) },
    });

    const view = await service.getMessageDelivery(OUTBOX_ID, NOW);

    expect(view.reclaimAt).toBe("2026-07-27T11:47:00.000Z");

    const { service: pendingService } = createService({
      outbox: { findOutboxById: vi.fn().mockResolvedValue(outboxRow) },
    });
    await expect(
      pendingService.getMessageDelivery(OUTBOX_ID, NOW),
    ).resolves.toMatchObject({ reclaimAt: null });
  });

  it("answers for a row that has already been sent", async () => {
    const sent = {
      ...outboxRow,
      status: "sent" as const,
      deliveryStatus: "delivered" as const,
      providerMessageId: "wa-123",
      sentAt: new Date("2026-07-27T11:41:30.000Z"),
      deliveredAt: new Date("2026-07-27T11:41:31.000Z"),
    };
    const { service } = createService({
      outbox: { findOutboxById: vi.fn().mockResolvedValue(sent) },
    });

    // A row that left the list between two polls must explain itself rather
    // than 404 as if the screen had linked to nothing.
    await expect(
      service.getMessageDelivery(OUTBOX_ID, NOW),
    ).resolves.toMatchObject({
      status: "sent",
      deliveryStatus: "delivered",
      providerMessageId: "wa-123",
      sentAt: "2026-07-27T11:41:30.000Z",
    });
  });

  it("returns the decision log when one exists for the row", async () => {
    const { service } = createService({
      outbox: { findOutboxById: vi.fn().mockResolvedValue(outboxRow) },
      outboundLogs: {
        findLogByOutboxId: vi.fn().mockResolvedValue(outboundLogRow),
      },
    });

    const view = await service.getMessageDelivery(OUTBOX_ID, NOW);

    expect(view.log).toEqual({
      origin: "extraction_reply",
      correlationId: "correlation-extract-1",
      decision: outboundLogRow.decision,
      conversationState: outboundLogRow.conversationState,
      createdAt: "2026-07-27T11:41:00.500Z",
    });
  });

  it("returns log null when the row has no decision log", async () => {
    const { service } = createService({
      outbox: { findOutboxById: vi.fn().mockResolvedValue(outboxRow) },
    });

    await expect(
      service.getMessageDelivery(OUTBOX_ID, NOW),
    ).resolves.toMatchObject({ log: null });
  });

  it("returns log null when the stored decision no longer parses", async () => {
    const { service } = createService({
      outbox: { findOutboxById: vi.fn().mockResolvedValue(outboxRow) },
      outboundLogs: {
        findLogByOutboxId: vi.fn().mockResolvedValue({
          ...outboundLogRow,
          decision: {
            origin: "extraction_reply",
            // Missing every field the schema requires.
          },
        }),
      },
    });

    await expect(
      service.getMessageDelivery(OUTBOX_ID, NOW),
    ).resolves.toMatchObject({ log: null });
  });

  it("rejects an unknown outbox id", async () => {
    const { service } = createService({});

    await expect(service.getMessageDelivery(OUTBOX_ID)).rejects.toBeInstanceOf(
      FeedbackOutboxMessageNotFoundError,
    );
  });
});
