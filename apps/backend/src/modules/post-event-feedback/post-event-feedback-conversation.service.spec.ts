import type {
  AppTransaction,
  EventRow,
  FeedbackAnswerRow,
  FeedbackCampaignRow,
  FeedbackNoteRow,
  MessageOutboxRow,
  ParticipantRow,
} from "@join-the-six/database";
import type { Queue } from "bullmq";
import { describe, expect, it, vi } from "vitest";

import type { AuditRepository } from "../../infrastructure/audit/audit.repository.js";
import type { DatabaseService } from "../../infrastructure/database/database.service.js";
import {
  FeedbackConversationCapacityError,
  type FeedbackConversationRepository,
} from "../conversations/feedback-conversation.repository.js";
import type { FeedbackConversationDocument } from "../conversations/feedback-conversation.schemas.js";
import type {
  FeedbackJobData,
  FeedbackJobName,
} from "./post-event-feedback.schemas.js";
import type { EventsRepository } from "../events/events.repository.js";
import type { EventsService } from "../events/events.service.js";
import type { ParticipantsRepository } from "../participants/participants.repository.js";
import { FeedbackOutboundTranscriptService } from "./feedback-outbound-transcript.service.js";
import { buildPostEventFeedbackQuestionLaunchSnapshot } from "./post-event-feedback-question-set.js";
import type { PostEventFeedbackRepository } from "./post-event-feedback.repository.js";
import {
  conversationCapabilities,
  FeedbackConversationActionNotAllowedError,
  PostEventFeedbackConversationService,
} from "./post-event-feedback-conversation.service.js";

const eventId = "7c57f3b8-2b13-48f5-8730-18ac71f490cd";
const campaignId = "89eccaa5-9ce6-4dcf-a630-5e35e4ec6f0d";
const participantId = "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const subjectId = "bbbbbbb1-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const conversationId = "6f0f2f8a-2b73-5a02-9d0a-3f0b8f5b1c21";
const noteId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const outboxId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

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

const eventRow: EventRow = {
  id: eventId,
  title: "Friday dinner",
  startsAt: new Date("2026-07-01T18:00:00.000Z"),
  status: "finished",
  createdAt: new Date("2026-07-01T00:00:00.000Z"),
  updatedAt: new Date("2026-07-01T00:00:00.000Z"),
};

describe("conversationCapabilities", () => {
  it("exposes take-over only while open under bot control", () => {
    expect(
      conversationCapabilities({
        lifecycle: { state: "open", reason: null },
        control: { mode: "bot", source: "launch" },
      }),
    ).toEqual({
      canTakeOver: true,
      canResumeBot: false,
      canClose: true,
      canSendStaffMessage: false,
    });
  });

  it("exposes resume and staff-send only while open under human control", () => {
    expect(
      conversationCapabilities({
        lifecycle: { state: "open", reason: null },
        control: { mode: "human", source: "staff_action" },
      }),
    ).toEqual({
      canTakeOver: false,
      canResumeBot: true,
      canClose: true,
      canSendStaffMessage: true,
    });
  });

  it("exposes no actions on a STOP-closed conversation", () => {
    expect(
      conversationCapabilities({
        lifecycle: { state: "closed", reason: "stopped" },
        control: { mode: "bot", source: "launch" },
      }),
    ).toEqual({
      canTakeOver: false,
      canResumeBot: false,
      canClose: false,
      canSendStaffMessage: false,
    });
  });

  it("exposes no actions on a completed conversation", () => {
    expect(
      conversationCapabilities({
        lifecycle: { state: "closed", reason: "completed" },
        control: { mode: "bot", source: "launch" },
      }),
    ).toEqual({
      canTakeOver: false,
      canResumeBot: false,
      canClose: false,
      canSendStaffMessage: false,
    });
  });
});

describe("PostEventFeedbackConversationService", () => {
  it("lists conversations with campaign summary, display names and capabilities", async () => {
    const { service, conversations, participants } = createService();
    conversations.listForCampaign.mockResolvedValue([
      listSummary({
        control: { mode: "bot", source: "launch" },
        needsAttention: true,
      }),
    ]);
    participants.findByIds.mockResolvedValue([participantRow()]);

    const result = await service.listForCampaign(campaignId);

    expect(result.campaign).toMatchObject({
      id: campaignId,
      eventId,
      eventTitle: "Friday dinner",
      conversationCount: 1,
      openCount: 1,
      needsAttentionCount: 1,
    });
    expect(result.conversations[0]).toMatchObject({
      id: conversationId,
      respondentDisplayName: "Roula",
      capabilities: {
        canTakeOver: true,
        canResumeBot: false,
        canClose: true,
        canSendStaffMessage: false,
      },
    });
  });

  it("rejects staff send while the conversation is under bot control", async () => {
    const { service, conversations, repository } = createService();
    conversations.findById.mockResolvedValue(openConversation());

    await expect(
      service.sendStaffMessage(
        campaignId,
        conversationId,
        "Γεια σου",
        "admin-1",
        "req-1",
      ),
    ).rejects.toBeInstanceOf(FeedbackConversationActionNotAllowedError);
    expect(repository.insertOutboxIfAbsent).not.toHaveBeenCalled();
  });

  it("enqueues a staff outbox row and appends the transcript under human control", async () => {
    const { service, conversations, repository, auditAppend } = createService();
    const human = openConversation({
      control: {
        mode: "human",
        source: "staff_action",
        changedAt: new Date("2026-07-25T00:30:00.000Z"),
      },
    });
    conversations.findById.mockResolvedValue(human);
    repository.insertOutboxIfAbsent.mockResolvedValue({
      row: outboxRow(),
      inserted: true,
    });
    conversations.appendMessage.mockResolvedValue({
      appended: true,
      message: {
        id: randomMessageId(),
        seq: 1,
        actor: "staff",
        text: "Γεια σου",
        providerMessageId: null,
        ingressId: null,
        outboxId,
        at: new Date("2026-07-25T00:31:00.000Z"),
      },
      conversation: {
        ...human,
        messages: [
          {
            id: randomMessageId(),
            seq: 1,
            actor: "staff",
            text: "Γεια σου",
            providerMessageId: null,
            ingressId: null,
            outboxId,
            at: new Date("2026-07-25T00:31:00.000Z"),
          },
        ],
      },
    });
    repository.listOutboxByConversation.mockResolvedValue([outboxRow()]);

    const result = await service.sendStaffMessage(
      campaignId,
      conversationId,
      "Γεια σου",
      "admin-1",
      "req-1",
    );

    expect(repository.insertOutboxIfAbsent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        kind: "staff",
        body: "Γεια σου",
        createdByStaff: "admin-1",
      }),
    );
    // The staff send goes through the same outbound-transcript path as the bot
    // producers; only the row's `kind` makes this turn `staff`.
    expect(conversations.appendMessage).toHaveBeenCalledWith({
      conversationId,
      actor: "staff",
      outboxId,
      text: "Γεια σου",
      at: expect.any(Date),
    });
    expect(auditAppend).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "feedback_conversation.staff_message_enqueued",
      }),
    );
    expect(result.messages[0]?.delivery).toMatchObject({
      outboxId,
      outboxStatus: "pending",
    });
    expect(result.capabilities.canSendStaffMessage).toBe(true);
  });

  it("cancels the staff row and refuses the send when the transcript is full", async () => {
    const { service, conversations, repository } = createService();
    conversations.findById.mockResolvedValue(
      openConversation({
        control: {
          mode: "human",
          source: "staff_action",
          changedAt: new Date("2026-07-25T00:30:00.000Z"),
        },
      }),
    );
    repository.insertOutboxIfAbsent.mockResolvedValue({
      row: outboxRow(),
      inserted: true,
    });
    conversations.appendMessage.mockRejectedValue(
      new FeedbackConversationCapacityError(),
    );

    await expect(
      service.sendStaffMessage(
        campaignId,
        conversationId,
        "Γεια σου",
        "admin-1",
        "req-1",
      ),
    ).rejects.toBeInstanceOf(FeedbackConversationCapacityError);
    // A message the transcript cannot record must not be sent either.
    expect(repository.updateOutboxStatus).toHaveBeenCalledWith(
      expect.anything(),
      outboxId,
      "cancelled",
    );
  });

  it("closes an open conversation with reason cancelled and is idempotent after", async () => {
    const { service, conversations, repository, auditAppend } = createService();
    const open = openConversation();
    const closed = {
      ...open,
      lifecycle: {
        state: "closed" as const,
        reason: "cancelled" as const,
        closedAt: new Date("2026-07-25T02:00:00.000Z"),
      },
    };
    conversations.findById
      .mockResolvedValueOnce(open)
      .mockResolvedValueOnce(closed);
    conversations.close.mockResolvedValue({
      changed: true,
      conversation: closed,
    });

    const first = await service.close(
      campaignId,
      conversationId,
      "admin-1",
      "req-1",
    );
    expect(first.lifecycle).toEqual({
      state: "closed",
      reason: "cancelled",
      closedAt: "2026-07-25T02:00:00.000Z",
    });
    expect(first.capabilities.canClose).toBe(false);
    expect(repository.cancelQueuedOutboxForConversation).toHaveBeenCalled();
    expect(auditAppend).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "feedback_conversation.closed" }),
    );

    const second = await service.close(
      campaignId,
      conversationId,
      "admin-1",
      "req-2",
    );
    expect(second.lifecycle.reason).toBe("cancelled");
    expect(conversations.close).toHaveBeenCalledTimes(1);
  });

  it("rejects staff close on a STOP-closed conversation", async () => {
    const { service, conversations } = createService();
    conversations.findById.mockResolvedValue({
      ...openConversation(),
      lifecycle: {
        state: "closed",
        reason: "stopped",
        closedAt: new Date("2026-07-25T01:00:00.000Z"),
      },
    });

    await expect(
      service.close(campaignId, conversationId, "admin-1", "req-1"),
    ).rejects.toBeInstanceOf(FeedbackConversationActionNotAllowedError);
    expect(conversations.close).not.toHaveBeenCalled();
  });

  it("takes over from bot and resumes bot under human control", async () => {
    const { service, conversations, auditAppend } = createService();
    const open = openConversation();
    const human = {
      ...open,
      control: {
        mode: "human" as const,
        source: "staff_action" as const,
        changedAt: new Date("2026-07-25T00:30:00.000Z"),
      },
    };
    conversations.findById
      .mockResolvedValueOnce(open)
      .mockResolvedValueOnce(human);
    conversations.takeOver.mockResolvedValue({
      changed: true,
      conversation: human,
    });
    conversations.resumeBot.mockResolvedValue({
      changed: true,
      conversation: open,
    });

    const taken = await service.takeOver(
      campaignId,
      conversationId,
      "admin-1",
      "req-1",
    );
    expect(taken.control.mode).toBe("human");
    expect(taken.capabilities).toMatchObject({
      canTakeOver: false,
      canResumeBot: true,
      canSendStaffMessage: true,
    });

    const resumed = await service.resumeBot(
      campaignId,
      conversationId,
      "admin-1",
      "req-2",
    );
    expect(resumed.control.mode).toBe("bot");
    expect(auditAppend).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "feedback_conversation.taken_over" }),
    );
    expect(auditAppend).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "feedback_conversation.bot_resumed" }),
    );
  });

  it("lists campaign results with resolved display names", async () => {
    const { service, repository, participants } = createService();
    repository.listAnswersByCampaign.mockResolvedValue([answerRow()]);
    repository.listNotesByCampaign.mockResolvedValue([noteRow()]);
    participants.findByIds.mockResolvedValue([
      participantRow(),
      participantRow({
        id: subjectId,
        preferredName: "Kostas",
        emailNormalized: "kostas@example.com",
      }),
    ]);

    const result = await service.listCampaignResults(campaignId, {
      questionKey: "liked",
      participantId,
      reviewStatus: "new",
    });

    expect(repository.listAnswersByCampaign).toHaveBeenCalledWith(campaignId, {
      questionKey: "liked",
      participantId,
    });
    expect(repository.listNotesByCampaign).toHaveBeenCalledWith(campaignId, {
      participantId,
      reviewStatus: "new",
    });
    expect(result.answers[0]?.respondentDisplayName).toBe("Roula");
    expect(result.answers[0]?.subjectDisplayName).toBe("Kostas");
    expect(result.notes[0]?.status).toBe("new");
  });

  it("records a staff note with staff provenance and no borrowed evidence", async () => {
    const { service, repository, conversations, eventsService, auditAppend } =
      createService();
    conversations.findById.mockResolvedValue(openConversation());
    eventsService.listFeedbackCandidatesForRespondent.mockResolvedValue({
      items: [{ participantId: subjectId, displayName: "Kostas" }],
    });
    repository.insertNote.mockResolvedValue(
      noteRow({
        subjectParticipantId: subjectId,
        sourceMessageIds: [],
        extractionMeta: {
          origin: "staff",
          staffUserId: "admin-1",
          candidateIds: [subjectId],
        },
      }),
    );

    const note = await service.addStaffNote(
      campaignId,
      conversationId,
      {
        noteType: "general",
        text: "Called to check in",
        subjectParticipantId: subjectId,
      },
      "admin-1",
      "req-9",
    );

    expect(repository.insertNote).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        campaignId,
        conversationId,
        respondentParticipantId: participantId,
        subjectParticipantId: subjectId,
        noteType: "general",
        text: "Called to check in",
        // No message was quoted, and no model ran: neither is invented.
        sourceMessageIds: [],
        extractionMeta: {
          origin: "staff",
          staffUserId: "admin-1",
          candidateIds: [subjectId],
        },
        status: "new",
      }),
    );
    const [, inserted] = repository.insertNote.mock.calls[0] as [
      unknown,
      { extractionMeta: Record<string, unknown> },
    ];
    expect(inserted.extractionMeta).not.toHaveProperty("model");
    expect(inserted.extractionMeta).not.toHaveProperty("confidence");

    expect(note.origin).toBe("staff");
    expect(note.sourceMessageIds).toStrictEqual([]);
    expect(auditAppend).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "feedback_note.staff_created",
        actorType: "admin",
        actorId: "admin-1",
        entityType: "feedback_note",
      }),
    );
  });

  it("refuses to direct a staff note at someone outside the D16 candidates", async () => {
    const { service, repository, conversations, eventsService } =
      createService();
    conversations.findById.mockResolvedValue(openConversation());
    eventsService.listFeedbackCandidatesForRespondent.mockResolvedValue({
      items: [],
    });

    await expect(
      service.addStaffNote(
        campaignId,
        conversationId,
        {
          noteType: "general",
          text: "About someone else",
          subjectParticipantId: subjectId,
        },
        "admin-1",
        "req-10",
      ),
    ).rejects.toBeInstanceOf(FeedbackConversationActionNotAllowedError);
    expect(repository.insertNote).not.toHaveBeenCalled();
  });

  it("accepts an undirected staff note on a closed conversation", async () => {
    const { service, repository, conversations } = createService();
    conversations.findById.mockResolvedValue(
      openConversation({
        lifecycle: {
          state: "closed",
          reason: "completed",
          closedAt: new Date("2026-07-25T01:00:00.000Z"),
        },
      }),
    );
    repository.insertNote.mockResolvedValue(
      noteRow({
        sourceMessageIds: [],
        extractionMeta: {
          origin: "staff",
          staffUserId: "admin-1",
          candidateIds: [],
        },
      }),
    );

    // Writing down what happened is not steering the conversation, so it is
    // not gated on the capability flags that stop messages going out.
    const note = await service.addStaffNote(
      campaignId,
      conversationId,
      { noteType: "activity_interest", text: "Wants a hiking group" },
      "admin-1",
      "req-11",
    );

    expect(note.origin).toBe("staff");
    expect(note.subjectParticipantId).toBeNull();
  });

  it("reports extraction output as conversation-origin, including legacy rows", async () => {
    const { service, repository } = createService();
    repository.listNotesByCampaign.mockResolvedValue([
      noteRow(),
      noteRow({
        id: "dddddddd-cccc-4ccc-8ccc-cccccccccccc",
        extractionMeta: {
          origin: "deterministic_fallback",
          candidateIds: [],
        },
      }),
    ]);

    const result = await service.listCampaignResults(campaignId, {});

    expect(result.notes.map((note) => note.origin)).toStrictEqual([
      "conversation",
      "conversation",
    ]);
  });

  it("returns null display names for dangling participant ids (D18)", async () => {
    const { service, conversations, participants } = createService();
    conversations.listForCampaign.mockResolvedValue([listSummary()]);
    participants.findByIds.mockResolvedValue([]);

    const result = await service.listForCampaign(campaignId);

    expect(result.conversations[0]?.respondentDisplayName).toBeNull();
  });
});

function openConversation(
  overrides: Partial<FeedbackConversationDocument> = {},
): FeedbackConversationDocument {
  const now = new Date("2026-07-25T00:00:00.000Z");
  return {
    _id: conversationId,
    schemaVersion: 2,
    purpose: "post_event_feedback",
    channel: "whatsapp",
    campaignId,
    respondentParticipantId: participantId,
    phoneAtLaunch: "+306900000001",
    lifecycle: { state: "open", reason: null, closedAt: null },
    control: { mode: "bot", source: "launch", changedAt: now },
    goals: [
      {
        key: "event_score",
        ordinal: 1,
        prompt: "score?",
        status: "pending",
      },
    ],
    messages: [],
    extraction: { cursorSeq: 0, lastRunAt: null, model: null },
    needsAttention: false,
    remindedAt: null,
    reminderCount: 0,
    awaitingHuman: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function listSummary(
  overrides: {
    control?: { mode: "bot" | "human"; source: "launch" | "staff_action" };
    needsAttention?: boolean;
    lifecycle?: { state: "open" | "closed"; reason: null | "stopped" };
  } = {},
) {
  const now = new Date("2026-07-25T00:00:00.000Z");
  return {
    _id: conversationId,
    campaignId,
    respondentParticipantId: participantId,
    phoneAtLaunch: "+306900000001",
    lifecycle: overrides.lifecycle ?? { state: "open" as const, reason: null },
    control: overrides.control ?? {
      mode: "bot" as const,
      source: "launch" as const,
    },
    goals: [{ key: "event_score", ordinal: 1, status: "pending" as const }],
    messageCount: 0,
    lastMessageAt: null,
    lastMessageActor: null,
    cursorSeq: 0,
    needsAttention: overrides.needsAttention ?? false,
    remindedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function participantRow(
  overrides: Partial<ParticipantRow> = {},
): ParticipantRow {
  return {
    id: participantId,
    preferredName: "Roula",
    emailNormalized: "roula@example.com",
    phoneE164: "+306900000001",
    ageBand: null,
    preferredNeighborhood: null,
    conversationStyle: null,
    postEventFeedbackWhatsappOptIn: true,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    ...overrides,
  };
}

function outboxRow(): MessageOutboxRow {
  return {
    id: outboxId,
    conversationId,
    campaignId,
    kind: "staff",
    body: "Γεια σου",
    status: "pending",
    dedupeKey: `feedback-staff-${conversationId}-1`,
    createdByStaff: "admin-1",
    providerLogId: null,
    providerMessageId: null,
    deliveryStatus: null,
    sentAt: null,
    deliveredAt: null,
    readAt: null,
    playedAt: null,
    deliveryUpdatedAt: null,
    createdAt: new Date("2026-07-25T00:31:00.000Z"),
    updatedAt: new Date("2026-07-25T00:31:00.000Z"),
  };
}

function answerRow(): FeedbackAnswerRow {
  return {
    id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    campaignId,
    conversationId,
    respondentParticipantId: participantId,
    subjectParticipantId: subjectId,
    questionKey: "liked",
    valueInt: null,
    sourceMessageIds: ["ffffffff-ffff-4fff-8fff-ffffffffffff"],
    extractionMeta: { candidateIds: [subjectId] },
    createdAt: new Date("2026-07-25T00:40:00.000Z"),
    updatedAt: new Date("2026-07-25T00:40:00.000Z"),
  };
}

function noteRow(overrides: Partial<FeedbackNoteRow> = {}): FeedbackNoteRow {
  return {
    id: noteId,
    campaignId,
    conversationId,
    respondentParticipantId: participantId,
    subjectParticipantId: null,
    noteType: "general",
    text: "Ωραία βραδιά",
    sourceMessageIds: ["ffffffff-ffff-4fff-8fff-ffffffffffff"],
    extractionMeta: { candidateIds: [] },
    status: "new",
    createdAt: new Date("2026-07-25T00:41:00.000Z"),
    updatedAt: new Date("2026-07-25T00:41:00.000Z"),
    ...overrides,
  };
}

function randomMessageId(): string {
  return "11111111-1111-4111-8111-111111111111";
}

function createService(): {
  service: PostEventFeedbackConversationService;
  repository: {
    findCampaignById: ReturnType<typeof vi.fn>;
    insertOutboxIfAbsent: ReturnType<typeof vi.fn>;
    listOutboxByConversation: ReturnType<typeof vi.fn>;
    cancelQueuedOutboxForConversation: ReturnType<typeof vi.fn>;
    updateOutboxStatus: ReturnType<typeof vi.fn>;
    listAnswersByConversation: ReturnType<typeof vi.fn>;
    listNotesByConversation: ReturnType<typeof vi.fn>;
    listAnswersByCampaign: ReturnType<typeof vi.fn>;
    listNotesByCampaign: ReturnType<typeof vi.fn>;
    findNoteById: ReturnType<typeof vi.fn>;
    updateNoteStatus: ReturnType<typeof vi.fn>;
    insertNote: ReturnType<typeof vi.fn>;
  };
  eventsService: {
    listFeedbackCandidatesForRespondent: ReturnType<typeof vi.fn>;
  };
  conversations: {
    listForCampaign: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    takeOver: ReturnType<typeof vi.fn>;
    resumeBot: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    appendMessage: ReturnType<typeof vi.fn>;
    setNeedsAttention: ReturnType<typeof vi.fn>;
  };
  participants: {
    findByIds: ReturnType<typeof vi.fn>;
  };
  auditAppend: ReturnType<typeof vi.fn>;
} {
  const transaction = {} as AppTransaction;
  const repository = {
    findCampaignById: vi.fn().mockResolvedValue(campaignRow),
    insertOutboxIfAbsent: vi.fn(),
    listOutboxByConversation: vi.fn().mockResolvedValue([]),
    cancelQueuedOutboxForConversation: vi.fn().mockResolvedValue(0),
    updateOutboxStatus: vi.fn(),
    listAnswersByConversation: vi.fn().mockResolvedValue([]),
    listNotesByConversation: vi.fn().mockResolvedValue([]),
    listAnswersByCampaign: vi.fn().mockResolvedValue([]),
    listNotesByCampaign: vi.fn().mockResolvedValue([]),
    findNoteById: vi.fn(),
    updateNoteStatus: vi.fn(),
    insertNote: vi.fn(),
  };
  const conversations = {
    listForCampaign: vi.fn().mockResolvedValue([]),
    findById: vi.fn(),
    takeOver: vi.fn(),
    resumeBot: vi.fn(),
    close: vi.fn(),
    appendMessage: vi.fn(),
    setNeedsAttention: vi.fn().mockResolvedValue({ changed: true }),
  };
  const events = {
    findById: vi.fn().mockResolvedValue(eventRow),
  };
  const eventsService = {
    listFeedbackCandidatesForRespondent: vi
      .fn()
      .mockResolvedValue({ items: [] }),
  };
  const participants = {
    findByIds: vi.fn().mockResolvedValue([participantRow()]),
  };
  const auditAppend = vi.fn().mockResolvedValue(undefined);
  const database = {
    transaction: vi.fn(async (work: (tx: AppTransaction) => Promise<unknown>) =>
      work(transaction),
    ),
  };

  const service = new PostEventFeedbackConversationService(
    { add: vi.fn().mockResolvedValue({ id: "job" }) } as unknown as Queue<
      FeedbackJobData,
      void,
      FeedbackJobName
    >,
    database as unknown as DatabaseService,
    repository as unknown as PostEventFeedbackRepository,
    conversations as unknown as FeedbackConversationRepository,
    events as unknown as EventsRepository,
    eventsService as unknown as EventsService,
    participants as unknown as ParticipantsRepository,
    { append: auditAppend } as unknown as AuditRepository,
    new FeedbackOutboundTranscriptService(
      database as unknown as DatabaseService,
      repository as unknown as PostEventFeedbackRepository,
      conversations as unknown as FeedbackConversationRepository,
    ),
  );

  return {
    service,
    repository,
    eventsService,
    conversations,
    participants,
    auditAppend,
  };
}
