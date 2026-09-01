import type { MessageOutboxLogRow } from "@slopform/database";
import { describe, expect, it, vi } from "vitest";

import type { ParticipantsRepository } from "../../participants/participants.repository.js";
import type { FeedbackConversationRepository } from "../post-event-feedback-conversation.repository.js";
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

/** The default the controller's own query schema fills in. */
const HISTORY_QUERY = { limit: 25 };

const ID_0 = OUTBOX_ID;
const ID_1 = "1e4b4bd6-8a2f-4f0a-9f19-2c1a4a2b3c4d";
const ID_2 = "2f5c5ce7-9b30-4a1b-8e20-3d2b5b3c4d5e";
const HISTORY_IDS = [ID_0, ID_1, ID_2] as const;

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
  claimToken: null,
  claimExpiresAt: null,
  sendStartedAt: null,
  attemptCount: 0,
  lastError: null,
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

/** An outbox row wearing the campaign and event context the join adds. */
function withContext<TRow>(row: TRow) {
  return {
    row,
    campaignStatus: "launched" as const,
    eventId: EVENT_ID,
    eventTitle: "Δείπνο Ιουλίου",
  };
}

/** One joined history row, distinguishable from its neighbours by id alone. */
function historyRow(index: number) {
  return {
    row: { ...outboxRow, id: HISTORY_IDS[index] ?? OUTBOX_ID },
    campaignStatus: "launched" as const,
    eventId: EVENT_ID,
    eventTitle: "Δείπνο Ιουλίου",
  };
}

function createService(overrides: {
  outbox?: Partial<FeedbackOutboxRepository>;
  outboundLogs?: Partial<FeedbackOutboundLogRepository>;
  conversations?: Partial<FeedbackConversationRepository>;
  participants?: Partial<ParticipantsRepository>;
}) {
  const service = new FeedbackOutboxQueueViewService(
    {
      listUndeliveredOutbox: vi.fn().mockResolvedValue([]),
      countUndeliveredOutboxByStatus: vi.fn().mockResolvedValue(new Map()),
      listRecentOutbox: vi.fn().mockResolvedValue([]),
      countOutbox: vi.fn().mockResolvedValue(0),
      findOutboxWithContextById: vi.fn().mockResolvedValue(undefined),
      ...overrides.outbox,
    } as unknown as FeedbackOutboxRepository,
    {
      findLogByOutboxId: vi.fn().mockResolvedValue(undefined),
      findLogOriginsByOutboxIds: vi.fn().mockResolvedValue(new Map()),
      ...overrides.outboundLogs,
    } as unknown as FeedbackOutboundLogRepository,
    {
      listRespondentsByIds: vi.fn().mockResolvedValue([]),
      ...overrides.conversations,
    } as unknown as FeedbackConversationRepository,
    {
      findByIds: vi.fn().mockResolvedValue([]),
      ...overrides.participants,
    } as unknown as ParticipantsRepository,
  );
  return { service };
}

describe("FeedbackOutboxQueueViewService.listQueue", () => {
  it("lists a page without asking for per-row delivery details", async () => {
    const rows = Array.from({ length: 25 }, (_entry, index) => ({
      row: {
        ...outboxRow,
        id: `${index}`.padStart(8, "0") + OUTBOX_ID.slice(8),
      },
      campaignStatus: "launched" as const,
      eventId: EVENT_ID,
      eventTitle: "Δείπνο Ιουλίου",
    }));
    const findOutboxWithContextById = vi.fn();
    const { service } = createService({
      outbox: {
        listUndeliveredOutbox: vi.fn().mockResolvedValue(rows),
        countUndeliveredOutboxByStatus: vi
          .fn()
          .mockResolvedValue(new Map([["pending", 25]])),
        findOutboxWithContextById,
      },
    });

    const view = await service.listQueue(NOW);

    expect(view.items).toHaveLength(25);
    expect(findOutboxWithContextById).not.toHaveBeenCalled();
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
            ["claimed", 5],
            ["attempting", 3],
            ["ambiguous", 1],
            ["sending", 4],
            ["held", 2],
          ]),
        ),
      },
    });

    const view = await service.listQueue(NOW);

    expect(view.counts).toEqual({
      pending: 300,
      claimed: 5,
      attempting: 3,
      ambiguous: 1,
      sending: 4,
      held: 2,
      total: 315,
    });
    expect(view.truncated).toBe(true);
  });
});

describe("FeedbackOutboxQueueViewService.listHistory", () => {
  it("lists terminal rows with the decision origin", async () => {
    const sentRow = {
      row: { ...outboxRow, status: "sent" as const },
      campaignStatus: "launched" as const,
      eventId: EVENT_ID,
      eventTitle: "Δείπνο Ιουλίου",
    };
    const { service } = createService({
      outbox: {
        listRecentOutbox: vi.fn().mockResolvedValue([sentRow]),
        countOutbox: vi.fn().mockResolvedValue(1),
      },
      outboundLogs: {
        findLogOriginsByOutboxIds: vi
          .fn()
          .mockResolvedValue(new Map([[OUTBOX_ID, "extraction_reply"]])),
      },
    });

    const view = await service.listHistory(HISTORY_QUERY, NOW);

    expect(view.items).toHaveLength(1);
    expect(view.items[0]).toMatchObject({
      id: OUTBOX_ID,
      status: "sent",
      origin: "extraction_reply",
    });
    expect(view.total).toBe(1);
    expect(view.nextCursor).toBeNull();
  });

  it("marks a row older than the decision log with a null origin", async () => {
    const { service } = createService({
      outbox: {
        listRecentOutbox: vi.fn().mockResolvedValue([
          {
            row: { ...outboxRow, status: "sent" as const },
            campaignStatus: "closed" as const,
            eventId: EVENT_ID,
            eventTitle: "Δείπνο Ιουλίου",
          },
        ]),
        countOutbox: vi.fn().mockResolvedValue(1),
      },
    });

    const view = await service.listHistory(HISTORY_QUERY, NOW);

    expect(view.items[0]?.origin).toBeNull();
  });

  it("reads one row past the page and returns a cursor without it", async () => {
    const listRecentOutbox = vi
      .fn()
      .mockResolvedValue([historyRow(0), historyRow(1), historyRow(2)]);
    const { service } = createService({
      outbox: { listRecentOutbox, countOutbox: vi.fn().mockResolvedValue(407) },
    });

    const view = await service.listHistory({ limit: 2 }, NOW);

    // The third row was read only to prove there is a next page; handing it
    // back would make every page one row longer than the caller asked for.
    expect(listRecentOutbox).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 3 }),
    );
    expect(view.items.map((item) => item.id)).toEqual([ID_0, ID_1]);
    expect(view.total).toBe(407);
    expect(view.nextCursor).not.toBeNull();
  });

  it("stops offering a next page when the log runs out", async () => {
    const { service } = createService({
      outbox: {
        listRecentOutbox: vi.fn().mockResolvedValue([historyRow(0)]),
        countOutbox: vi.fn().mockResolvedValue(1),
      },
    });

    const view = await service.listHistory({ limit: 2 }, NOW);

    expect(view.nextCursor).toBeNull();
  });

  it("continues from the cursor it handed out, at the row after the page", async () => {
    const listRecentOutbox = vi
      .fn()
      .mockResolvedValue([historyRow(0), historyRow(1)]);
    const { service } = createService({
      outbox: { listRecentOutbox, countOutbox: vi.fn().mockResolvedValue(9) },
    });

    const first = await service.listHistory({ limit: 1 }, NOW);
    await service.listHistory(
      { limit: 1, cursor: first.nextCursor ?? "" },
      NOW,
    );

    expect(listRecentOutbox).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cursor: { createdAt: outboxRow.createdAt, id: ID_0 },
      }),
    );
  });

  it("rewinds to the newest page when the cursor is not one we wrote", async () => {
    const listRecentOutbox = vi.fn().mockResolvedValue([]);
    const { service } = createService({
      outbox: { listRecentOutbox, countOutbox: vi.fn().mockResolvedValue(0) },
    });

    // A cursor travels in a URL a person can edit. A read-only log viewer
    // answering 400 to a mangled one is worse than showing them the top.
    await service.listHistory({ limit: 25, cursor: "not-a-cursor" }, NOW);

    expect(listRecentOutbox).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: null }),
    );
  });

  it("counts within the filter, so the total cannot describe other rows", async () => {
    const countOutbox = vi.fn().mockResolvedValue(3);
    const listRecentOutbox = vi.fn().mockResolvedValue([]);
    const { service } = createService({
      outbox: { listRecentOutbox, countOutbox },
    });

    const from = "2026-07-27T00:00:00.000Z";
    const view = await service.listHistory(
      { limit: 25, status: "failed", from },
      NOW,
    );

    const filter = { status: "failed", from: new Date(from), to: null };
    expect(countOutbox).toHaveBeenCalledWith(filter);
    expect(listRecentOutbox).toHaveBeenCalledWith(
      expect.objectContaining({ filter }),
    );
    expect(view.total).toBe(3);
  });
});

describe("FeedbackOutboxQueueViewService.getMessageDelivery", () => {
  it("carries the message, the person and the event the pane names them by", async () => {
    const { service } = createService({
      outbox: {
        findOutboxWithContextById: vi
          .fn()
          .mockResolvedValue(withContext(outboxRow)),
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

    const view = await service.getMessageDelivery(OUTBOX_ID, NOW);

    // The one place «what did we actually say to this person» is answerable.
    expect(view.body).toBe("Ευχαριστούμε!");
    expect(view).toMatchObject({
      respondentDisplayName: "Ελένη Ριπομηνυματού",
      phoneAtLaunch: "+30690000102",
      eventTitle: "Δείπνο Ιουλίου",
    });
  });

  it("publishes durable dispatcher state for the row an operator opened", async () => {
    const claimed = {
      ...outboxRow,
      status: "claimed" as const,
      claimToken: "118234ec-14f8-4c2a-90f3-330a092e4f60",
      claimExpiresAt: new Date("2026-07-27T11:45:00.000Z"),
    };
    const { service } = createService({
      outbox: {
        findOutboxWithContextById: vi
          .fn()
          .mockResolvedValue(withContext(claimed)),
      },
    });

    const view = await service.getMessageDelivery(OUTBOX_ID, NOW);

    expect(view.dispatch).toEqual({
      state: "claimed",
      claimExpiresAt: "2026-07-27T11:45:00.000Z",
      sendStartedAt: null,
      attemptCount: 0,
      lastError: null,
    });
    expect(view.waitingSeconds).toBe(147);
  });

  it("shows the honest legacy sending bridge without fabricating an attempt", async () => {
    const sending = {
      ...outboxRow,
      status: "sending" as const,
      updatedAt: new Date("2026-07-27T11:42:00.000Z"),
    };
    const { service } = createService({
      outbox: {
        findOutboxWithContextById: vi
          .fn()
          .mockResolvedValue(withContext(sending)),
      },
    });

    const view = await service.getMessageDelivery(OUTBOX_ID, NOW);

    expect(view.dispatch).toEqual({
      state: "sending",
      claimExpiresAt: null,
      sendStartedAt: null,
      attemptCount: 0,
      lastError: null,
    });

    const { service: pendingService } = createService({
      outbox: {
        findOutboxWithContextById: vi
          .fn()
          .mockResolvedValue(withContext(outboxRow)),
      },
    });
    await expect(
      pendingService.getMessageDelivery(OUTBOX_ID, NOW),
    ).resolves.toMatchObject({
      dispatch: {
        state: "pending",
        claimExpiresAt: null,
        sendStartedAt: null,
        attemptCount: 0,
        lastError: null,
      },
    });
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
      outbox: {
        findOutboxWithContextById: vi.fn().mockResolvedValue(withContext(sent)),
      },
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
      outbox: {
        findOutboxWithContextById: vi
          .fn()
          .mockResolvedValue(withContext(outboxRow)),
      },
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
      outbox: {
        findOutboxWithContextById: vi
          .fn()
          .mockResolvedValue(withContext(outboxRow)),
      },
    });

    await expect(
      service.getMessageDelivery(OUTBOX_ID, NOW),
    ).resolves.toMatchObject({ log: null });
  });

  it("returns log null when the stored decision no longer parses", async () => {
    const { service } = createService({
      outbox: {
        findOutboxWithContextById: vi
          .fn()
          .mockResolvedValue(withContext(outboxRow)),
      },
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
