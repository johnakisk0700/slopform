import type {
  AppTransaction,
  EventRow,
  FeedbackCampaignRow,
} from "@join-the-six/database";
import { describe, expect, it, vi } from "vitest";

import type { AuditRepository } from "../../infrastructure/audit/audit.repository.js";
import type { DatabaseService } from "../../infrastructure/database/database.service.js";
import {
  FeedbackConversationPhoneConflictError,
  type FeedbackConversationRepository,
} from "../conversations/feedback-conversation.repository.js";
import type { EventsRepository } from "../events/events.repository.js";
import { FeedbackOutboundTranscriptService } from "./outbox/outbound-transcript.service.js";
import {
  FeedbackCampaignLaunchNotAllowedError,
  PostEventFeedbackCampaignService,
} from "./post-event-feedback-campaign.service.js";
import type { FeedbackCampaignRepository } from "./campaign/campaign.repository.js";
import type { FeedbackOutboxRepository } from "./outbox/outbox.repository.js";
import { buildPostEventFeedbackQuestionLaunchSnapshot } from "./post-event-feedback-question-set.js";

const eventId = "7c57f3b8-2b13-48f5-8730-18ac71f490cd";
const campaignId = "89eccaa5-9ce6-4dcf-a630-5e35e4ec6f0d";
const participantId = "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const conversationId = "6f0f2f8a-2b73-5a02-9d0a-3f0b8f5b1c21";
const introOutboxId = "d3e9a2c6-4e87-4c4b-9c40-4f2c5a4e3d99";

const finishedEvent: EventRow = {
  id: eventId,
  title: "Friday dinner",
  startsAt: new Date("2026-07-01T18:00:00.000Z"),
  status: "finished",
  createdAt: new Date("2026-07-01T00:00:00.000Z"),
  updatedAt: new Date("2026-07-01T00:00:00.000Z"),
};

const campaignRow: FeedbackCampaignRow = {
  id: campaignId,
  eventId,
  questionSetVersion: 1,
  questions: buildPostEventFeedbackQuestionLaunchSnapshot(),
  status: "launched",
  launchedAt: new Date("2026-07-25T00:00:00.000Z"),
  launchedBy: "admin-1",
  createdAt: new Date("2026-07-25T00:00:00.000Z"),
  updatedAt: new Date("2026-07-25T00:00:00.000Z"),
};

const eligible = {
  participantId,
  preferredName: "Roula",
  emailNormalized: "roula@example.com",
  phoneE164: "+306900000001",
};

describe("PostEventFeedbackCampaignService", () => {
  it("rejects launch when the event is not finished", async () => {
    const { service, events } = createService();
    events.findById.mockResolvedValue({ ...finishedEvent, status: "draft" });

    await expect(
      service.launch(eventId, "admin-1", "req-1"),
    ).rejects.toBeInstanceOf(FeedbackCampaignLaunchNotAllowedError);
  });

  it("rejects launch when no eligible attendees exist", async () => {
    const { service, repository } = createService();
    repository.listEligibleAttendeesForEvent.mockResolvedValue([]);

    await expect(
      service.launch(eventId, "admin-1", "req-1"),
    ).rejects.toBeInstanceOf(FeedbackCampaignLaunchNotAllowedError);
  });

  it("creates the campaign, conversations and intro outbox on first launch", async () => {
    const { service, repository, conversations, auditAppend } = createService();
    repository.findCampaignByEventId.mockResolvedValue(undefined);
    repository.createCampaign.mockResolvedValue(campaignRow);
    repository.insertOutboxIfAbsent.mockResolvedValue({
      row: introOutboxRow(),
      inserted: true,
    });
    conversations.createFromLaunch.mockResolvedValue({
      created: true,
      conversation: openConversation(),
    });
    conversations.listForCampaign.mockResolvedValue([{ id: conversationId }]);

    const result = await service.launch(eventId, "admin-1", "req-1");

    expect(result.id).toBe(campaignId);
    expect(result.conversationsCreated).toBe(1);
    expect(repository.createCampaign).toHaveBeenCalled();
    expect(conversations.createFromLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        campaignId,
        respondentParticipantId: participantId,
        phoneAtLaunch: "+306900000001",
      }),
    );
    expect(repository.insertOutboxIfAbsent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        kind: "intro",
        dedupeKey: `feedback-intro-${conversationId}`,
      }),
    );
    expect(auditAppend).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "feedback_campaign.launched" }),
    );
    // The intro is a bot turn in the transcript, correlated to its outbox row.
    expect(conversations.appendMessage).toHaveBeenCalledWith({
      conversationId,
      actor: "bot",
      text: introOutboxRow().body,
      at: expect.any(Date),
      outboxId: introOutboxId,
    });
  });

  it("skips an attendee whose phone is already in use and launches everyone else", async () => {
    // One stale open conversation on a shared or recycled number used to throw
    // out of the launch loop, leaving a campaign that had reached some
    // attendees, would never reach the rest, and failed at the same person on
    // every retry.
    const { service, repository, conversations, auditAppend } = createService();
    const blocked = {
      ...eligible,
      participantId: "b2c3d4e5-f607-4809-8a1b-2c3d4e5f6071",
      preferredName: "Kostas",
    };
    repository.findCampaignByEventId.mockResolvedValue(undefined);
    repository.createCampaign.mockResolvedValue(campaignRow);
    repository.listEligibleAttendeesForEvent.mockResolvedValue([
      blocked,
      eligible,
    ]);
    repository.insertOutboxIfAbsent.mockResolvedValue({
      row: introOutboxRow(),
      inserted: true,
    });
    conversations.createFromLaunch
      .mockRejectedValueOnce(new FeedbackConversationPhoneConflictError())
      .mockResolvedValueOnce({
        created: true,
        conversation: openConversation(),
      });
    conversations.listForCampaign.mockResolvedValue([{ id: conversationId }]);

    const result = await service.launch(eventId, "admin-1", "req-1");

    expect(result.conversationsCreated).toBe(1);
    expect(conversations.createFromLaunch).toHaveBeenCalledTimes(2);
    // The skip is not silent: an operator needs to know who was left out.
    expect(auditAppend).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "feedback_campaign.launch_phone_conflicts",
        context: expect.objectContaining({
          participantIds: [blocked.participantId],
        }),
      }),
    );
  });

  it("still fails the launch when a conversation error is not a phone conflict", async () => {
    const { service, repository, conversations } = createService();
    repository.findCampaignByEventId.mockResolvedValue(undefined);
    repository.createCampaign.mockResolvedValue(campaignRow);
    conversations.createFromLaunch.mockRejectedValue(
      new Error("mongo is unreachable"),
    );

    await expect(service.launch(eventId, "admin-1", "req-1")).rejects.toThrow(
      "mongo is unreachable",
    );
  });

  it("repairs a missing intro transcript entry when launch is replayed", async () => {
    const { service, repository, conversations } = createService();
    repository.findCampaignByEventId.mockResolvedValue(campaignRow);
    conversations.createFromLaunch.mockResolvedValue({
      created: false,
      conversation: openConversation(),
    });
    // The row already exists: the first launch crashed between the PostgreSQL
    // commit and the MongoDB append.
    repository.insertOutboxIfAbsent.mockResolvedValue({
      row: introOutboxRow(),
      inserted: false,
    });
    conversations.listForCampaign.mockResolvedValue([{ id: conversationId }]);

    await service.launch(eventId, "admin-1", "req-replay");

    expect(conversations.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ actor: "bot", outboxId: introOutboxId }),
    );
  });

  it("replays launch without creating a second campaign, conversation or intro", async () => {
    const { service, repository, conversations } = createService();
    repository.findCampaignByEventId.mockResolvedValue(campaignRow);
    conversations.createFromLaunch.mockResolvedValue({
      created: false,
      conversation: openConversation(),
    });
    repository.insertOutboxIfAbsent.mockResolvedValue({
      row: introOutboxRow(),
      inserted: false,
    });
    conversations.listForCampaign.mockResolvedValue([{ id: conversationId }]);

    const result = await service.launch(eventId, "admin-1", "req-replay");

    expect(repository.createCampaign).not.toHaveBeenCalled();
    expect(result.conversationsCreated).toBe(0);
    expect(conversations.createFromLaunch).toHaveBeenCalledTimes(1);
    expect(repository.insertOutboxIfAbsent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        dedupeKey: `feedback-intro-${conversationId}`,
      }),
    );
  });

  it("never recreates a STOP-closed conversation on startConversation", async () => {
    const { service, repository, conversations } = createService();
    repository.findCampaignById.mockResolvedValue(campaignRow);
    repository.listEligibleAttendeesForEvent.mockResolvedValue([eligible]);
    conversations.createFromLaunch.mockResolvedValue({
      created: false,
      conversation: {
        ...openConversation(),
        lifecycle: {
          state: "closed",
          reason: "stopped",
          closedAt: new Date("2026-07-25T01:00:00.000Z"),
        },
      },
    });

    const result = await service.startConversation(
      campaignId,
      participantId,
      "admin-1",
      "req-1",
    );

    expect(result.created).toBe(false);
    expect(result.introEnqueued).toBe(false);
    expect(result.lifecycleState).toBe("closed");
    expect(repository.insertOutboxIfAbsent).not.toHaveBeenCalled();
  });

  it("pauses and resumes the campaign kill switch", async () => {
    const { service, repository, auditAppend } = createService();
    repository.findCampaignById
      .mockResolvedValueOnce(campaignRow)
      .mockResolvedValueOnce({ ...campaignRow, status: "paused" });
    repository.updateCampaignStatus
      .mockResolvedValueOnce({ ...campaignRow, status: "paused" })
      .mockResolvedValueOnce({ ...campaignRow, status: "launched" });

    await expect(
      service.pause(campaignId, "admin-1", "req-1"),
    ).resolves.toMatchObject({ status: "paused" });
    await expect(
      service.resume(campaignId, "admin-1", "req-2"),
    ).resolves.toMatchObject({ status: "launched" });
    expect(auditAppend).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "feedback_campaign.paused" }),
    );
    expect(auditAppend).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "feedback_campaign.resumed" }),
    );
  });

  it("lists campaigns newest-first with conversation progress counts", async () => {
    const olderCampaignId = "a9eccaa5-9ce6-4dcf-a630-5e35e4ec6f0a";
    const olderEventId = "6c57f3b8-2b13-48f5-8730-18ac71f490cd";
    const { service, repository, conversations } = createService();
    repository.listCampaignsNewestFirst.mockResolvedValue([
      {
        campaign: campaignRow,
        eventTitle: "Friday dinner",
      },
      {
        campaign: {
          ...campaignRow,
          id: olderCampaignId,
          eventId: olderEventId,
          launchedAt: new Date("2026-07-20T00:00:00.000Z"),
          status: "paused",
        },
        eventTitle: "Thursday dinner",
      },
    ]);
    conversations.listForCampaign
      .mockResolvedValueOnce([
        {
          lifecycle: { state: "open" },
          needsAttention: true,
        },
        {
          lifecycle: { state: "closed" },
          needsAttention: false,
        },
        {
          lifecycle: { state: "open" },
          needsAttention: false,
        },
      ])
      .mockResolvedValueOnce([
        {
          lifecycle: { state: "closed" },
          needsAttention: false,
        },
      ]);

    const result = await service.list();

    expect(result.items).toEqual([
      {
        id: campaignId,
        eventId,
        eventTitle: "Friday dinner",
        status: "launched",
        launchedAt: "2026-07-25T00:00:00.000Z",
        conversationCount: 3,
        openCount: 2,
        needsAttentionCount: 1,
      },
      {
        id: olderCampaignId,
        eventId: olderEventId,
        eventTitle: "Thursday dinner",
        status: "paused",
        launchedAt: "2026-07-20T00:00:00.000Z",
        conversationCount: 1,
        openCount: 0,
        needsAttentionCount: 0,
      },
    ]);
    expect(conversations.listForCampaign).toHaveBeenNthCalledWith(
      1,
      campaignId,
    );
    expect(conversations.listForCampaign).toHaveBeenNthCalledWith(
      2,
      olderCampaignId,
    );
  });
});

function openConversation() {
  return {
    _id: conversationId,
    campaignId,
    respondentParticipantId: participantId,
    lifecycle: { state: "open", reason: null, closedAt: null },
    control: { mode: "bot", source: "launch", changedAt: new Date() },
    messages: [],
    remindedAt: null,
  };
}

function introOutboxRow() {
  return {
    id: introOutboxId,
    conversationId,
    campaignId,
    kind: "intro",
    body: "Γεια σου Roula! Πώς σου φάνηκε η βραδιά;",
    status: "pending",
  };
}

function createService(): {
  service: PostEventFeedbackCampaignService;
  repository: {
    findCampaignByEventId: ReturnType<typeof vi.fn>;
    findCampaignById: ReturnType<typeof vi.fn>;
    listCampaignsNewestFirst: ReturnType<typeof vi.fn>;
    createCampaign: ReturnType<typeof vi.fn>;
    updateCampaignStatus: ReturnType<typeof vi.fn>;
    listEligibleAttendeesForEvent: ReturnType<typeof vi.fn>;
    insertOutboxIfAbsent: ReturnType<typeof vi.fn>;
    cancelQueuedOutboxForCampaign: ReturnType<typeof vi.fn>;
  };
  conversations: {
    createFromLaunch: ReturnType<typeof vi.fn>;
    listForCampaign: ReturnType<typeof vi.fn>;
    appendMessage: ReturnType<typeof vi.fn>;
    setNeedsAttention: ReturnType<typeof vi.fn>;
  };
  events: {
    findById: ReturnType<typeof vi.fn>;
  };
  auditAppend: ReturnType<typeof vi.fn>;
} {
  const transaction = {} as AppTransaction;
  const repository = {
    findCampaignByEventId: vi.fn().mockResolvedValue(undefined),
    findCampaignById: vi.fn().mockResolvedValue(campaignRow),
    listCampaignsNewestFirst: vi.fn().mockResolvedValue([]),
    createCampaign: vi.fn(),
    updateCampaignStatus: vi.fn(),
    listEligibleAttendeesForEvent: vi.fn().mockResolvedValue([eligible]),
    insertOutboxIfAbsent: vi.fn(),
    cancelQueuedOutboxForCampaign: vi.fn().mockResolvedValue(0),
  };
  const conversations = {
    createFromLaunch: vi.fn(),
    listForCampaign: vi.fn().mockResolvedValue([]),
    appendMessage: vi
      .fn()
      .mockResolvedValue({ appended: true, message: {}, conversation: {} }),
    setNeedsAttention: vi.fn().mockResolvedValue({ changed: true }),
  };
  const events = {
    findById: vi.fn().mockResolvedValue(finishedEvent),
  };
  const auditAppend = vi.fn().mockResolvedValue(undefined);
  const database = {
    transaction: vi.fn(async (work: (tx: AppTransaction) => Promise<unknown>) =>
      work(transaction),
    ),
  };

  return {
    service: new PostEventFeedbackCampaignService(
      database as unknown as DatabaseService,
      repository as unknown as FeedbackCampaignRepository,
      repository as unknown as FeedbackOutboxRepository,
      conversations as unknown as FeedbackConversationRepository,
      events as unknown as EventsRepository,
      { append: auditAppend } as unknown as AuditRepository,
      new FeedbackOutboundTranscriptService(
        database as unknown as DatabaseService,
        repository as unknown as FeedbackOutboxRepository,
        conversations as unknown as FeedbackConversationRepository,
      ),
    ),
    repository,
    conversations,
    events,
    auditAppend,
  };
}
