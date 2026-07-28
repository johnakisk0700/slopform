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

import type { AuditRepository } from "../../../infrastructure/audit/audit.repository.js";
import type { DatabaseService } from "../../../infrastructure/database/database.service.js";
import {
  FeedbackConversationCapacityError,
  type FeedbackConversationRepository,
} from "../post-event-feedback-conversation.repository.js";
import type { FeedbackConversationDocument } from "../post-event-feedback-conversation.document.js";
import type { FeedbackJobData, FeedbackJobName } from "../jobs.schemas.js";
import type { EventsRepository } from "../../events/events.repository.js";
import type { EventsService } from "../../events/events.service.js";
import type { ParticipantsRepository } from "../../participants/participants.repository.js";
import { FeedbackOutboundTranscriptService } from "../outbox/outbound-transcript.service.js";
import { buildPostEventFeedbackQuestionLaunchSnapshot } from "../question-set.js";
import type { FeedbackCampaignRepository } from "../campaign/campaign.repository.js";
import type { FeedbackResultsRepository } from "../extraction/results.repository.js";
import type { FeedbackOutboxRepository } from "../outbox/outbox.repository.js";
import { conversationCapabilities } from "./conversation.view.js";
import {
  closeFeedbackConversationSchema,
  feedbackConversationMessageSchema,
  sendFeedbackStaffMessageSchema,
} from "./conversation.schemas.js";
import {
  FEEDBACK_CONVERSATION_MESSAGE_MAX_STORED_TEXT_LENGTH,
  FEEDBACK_CONVERSATION_MESSAGE_MAX_TEXT_LENGTH,
} from "../post-event-feedback-conversation.document.js";
import {
  FeedbackAnswerNotFoundError,
  FeedbackAttentionReasonNotFoundError,
  FeedbackConversationActionNotAllowedError,
  PostEventFeedbackConversationService,
} from "./conversation.service.js";

const eventId = "7c57f3b8-2b13-48f5-8730-18ac71f490cd";
const campaignId = "89eccaa5-9ce6-4dcf-a630-5e35e4ec6f0d";
const participantId = "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const subjectId = "bbbbbbb1-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const conversationId = "6f0f2f8a-2b73-5a02-9d0a-3f0b8f5b1c21";
const noteId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const answerId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const outboxId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const reasonId = "99999999-9999-4999-8999-999999999901";
const secondReasonId = "99999999-9999-4999-8999-999999999902";
const attentionMessageId = "11111111-1111-4111-8111-111111111199";

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

describe("feedbackConversationMessageSchema", () => {
  it("renders a message longer than we are allowed to send", () => {
    // A 4,476-character message made the whole conversation unopenable: the
    // read model bounded transcript text by the *send* limit, so the detail
    // endpoint 500'd and an operator could not read any of the thread. The
    // stored limit is deliberately far above the send limit precisely because
    // people write their way up to the hard thing, and the tail this refused
    // to render is where a disclosure lives.
    const message = {
      id: "6f0f2f8a-2b73-5a02-9d0a-3f0b8f5b1c21",
      seq: 1,
      actor: "participant" as const,
      text: "α".repeat(FEEDBACK_CONVERSATION_MESSAGE_MAX_TEXT_LENGTH + 380),
      providerMessageId: null,
      ingressId: null,
      outboxId: null,
      attention: null,
      at: "2026-07-27T10:00:00.000Z",
      delivery: null,
    };

    expect(feedbackConversationMessageSchema.parse(message).text).toHaveLength(
      FEEDBACK_CONVERSATION_MESSAGE_MAX_TEXT_LENGTH + 380,
    );
    expect(
      feedbackConversationMessageSchema.safeParse({
        ...message,
        text: "α".repeat(
          FEEDBACK_CONVERSATION_MESSAGE_MAX_STORED_TEXT_LENGTH + 1,
        ),
      }).success,
    ).toBe(false);
  });

  it("still holds a staff-written message to what WhatsApp will accept", () => {
    // The other half of the same distinction: reading is bounded by what was
    // stored, writing by what can actually leave the building.
    expect(
      sendFeedbackStaffMessageSchema.safeParse({
        text: "α".repeat(FEEDBACK_CONVERSATION_MESSAGE_MAX_TEXT_LENGTH + 1),
      }).success,
    ).toBe(false);
  });
});

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

  it("reports a provider incident once for the campaign, not once per row", async () => {
    const { service, conversations, participants } = createService();
    conversations.listForCampaign.mockResolvedValue([
      listSummary({ extractionParked: true }),
      listSummary({ extractionParked: true }),
      listSummary({ needsAttention: true }),
    ]);
    participants.findByIds.mockResolvedValue([participantRow()]);

    const result = await service.listForCampaign(campaignId);

    // Two conversations waiting on the model and one wanting a person. The
    // counts stay apart: a parked conversation wants a working provider, and
    // rolling it into the attention count is how one outage became thirty-six
    // things for somebody to read.
    expect(result.campaign).toMatchObject({
      conversationCount: 3,
      extractionParkedCount: 2,
      needsAttentionCount: 1,
    });
  });

  it("reports a parked conversation as waiting on the model, not as a failed run", async () => {
    const { service, conversations, queue, repository } = createService();
    const at = new Date("2026-07-27T10:00:00.000Z");
    conversations.findById.mockResolvedValue(
      openConversation({
        messages: [
          {
            id: "11111111-1111-4111-8111-111111111102",
            seq: 1,
            actor: "participant",
            text: "Καλά, θα έβαζα 4",
            providerMessageId: "p-1",
            ingressId: "22222222-2222-4222-8222-222222222201",
            outboxId: null,
            attention: null,
            at,
          },
        ],
        extraction: {
          cursorSeq: 0,
          lastRunAt: null,
          model: null,
          parkedSince: at,
          parkedRuns: 3,
          parkedNoticeSentAt: null,
        },
      }),
    );
    repository.listNotesByConversation.mockResolvedValue([]);
    // The positional job is the one that died; the parked retry is the one that
    // matters, and it is delayed under its own id.
    queue.getJob.mockImplementation(async (jobId: string) =>
      jobId.endsWith("-parked-3")
        ? {
            timestamp: Date.parse("2026-07-27T10:05:00.000Z"),
            opts: { delay: 300_000 },
            getState: vi.fn().mockResolvedValue("delayed"),
            failedReason: undefined,
          }
        : {
            timestamp: Date.parse("2026-07-27T10:00:00.000Z"),
            opts: { delay: 0 },
            getState: vi.fn().mockResolvedValue("failed"),
            failedReason: "Feedback extraction parked on the provider",
          },
    );

    const result = await service.get(campaignId, conversationId);

    // Not `lastRunFailed`: the admin renders that as «απάντησε η εναλλακτική
    // διαδικασία», and for a parked conversation no fallback answered anybody.
    expect(result.extraction).toMatchObject({
      unreadParticipantMessages: 1,
      nextRunAt: "2026-07-27T10:10:00.000Z",
      runQueued: true,
      lastRunFailed: false,
      failedReason: null,
    });
    expect(queue.getJob).toHaveBeenCalledWith(
      `feedback-extract-v1-${conversationId}-1-parked-3`,
    );
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

  it("reports unread testimony and delayed extract job state on the detail view", async () => {
    const { service, conversations, queue } = createService();
    const at = new Date("2026-07-27T10:00:00.000Z");
    conversations.findById.mockResolvedValue(
      openConversation({
        messages: [
          {
            id: "11111111-1111-4111-8111-111111111101",
            seq: 1,
            actor: "bot",
            text: "Πώς σου φάνηκε;",
            providerMessageId: null,
            ingressId: null,
            outboxId: outboxId,
            attention: null,
            at,
          },
          {
            id: "11111111-1111-4111-8111-111111111102",
            seq: 2,
            actor: "participant",
            text: "Καλά",
            providerMessageId: "p-1",
            ingressId: "22222222-2222-4222-8222-222222222201",
            outboxId: null,
            attention: null,
            at,
          },
          {
            id: "11111111-1111-4111-8111-111111111103",
            seq: 3,
            actor: "participant",
            text: "Θα έβαζα 4",
            providerMessageId: "p-2",
            ingressId: "22222222-2222-4222-8222-222222222202",
            outboxId: null,
            attention: null,
            at,
          },
        ],
        extraction: {
          cursorSeq: 1,
          lastRunAt: null,
          model: null,
          parkedSince: null,
          parkedRuns: 0,
          parkedNoticeSentAt: null,
        },
      }),
    );
    queue.getJob.mockResolvedValue({
      timestamp: Date.parse("2026-07-27T10:01:00.000Z"),
      opts: { delay: 45_000 },
      getState: vi.fn().mockResolvedValue("delayed"),
      failedReason: undefined,
    });

    const result = await service.get(campaignId, conversationId);

    expect(result.extraction).toEqual({
      unreadParticipantMessages: 2,
      lastRunAt: null,
      model: null,
      nextRunAt: "2026-07-27T10:01:45.000Z",
      runInFlight: false,
      runQueued: true,
      lastRunFailed: false,
      failedReason: null,
    });
    expect(queue.getJob).toHaveBeenCalledWith(
      `feedback-extract-v1-${conversationId}-2`,
    );
    expect(queue.getJob).toHaveBeenCalledWith(
      `feedback-extract-v1-${conversationId}-3`,
    );
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
      staffClose: {
        reason: "handled_offline" as const,
        note: "Called them back",
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
      { reason: "handled_offline", note: "Called them back" },
      "admin-1",
      "req-1",
    );
    expect(first.lifecycle).toEqual({
      state: "closed",
      reason: "cancelled",
      closedAt: "2026-07-25T02:00:00.000Z",
    });
    expect(first.staffClose).toEqual({
      reason: "handled_offline",
      note: "Called them back",
    });
    expect(first.capabilities.canClose).toBe(false);
    expect(conversations.close).toHaveBeenCalledWith({
      conversationId,
      reason: "cancelled",
      at: expect.any(Date),
      staffClose: {
        reason: "handled_offline",
        note: "Called them back",
      },
    });
    expect(repository.cancelQueuedOutboxForConversation).toHaveBeenCalled();
    expect(auditAppend).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "feedback_conversation.closed",
        context: {
          campaignId,
          reason: "cancelled",
          staffReason: "handled_offline",
          staffNote: "Called them back",
        },
      }),
    );

    const second = await service.close(
      campaignId,
      conversationId,
      { reason: "abusive" },
      "admin-1",
      "req-2",
    );
    expect(second.lifecycle.reason).toBe("cancelled");
    expect(second.staffClose).toEqual({
      reason: "handled_offline",
      note: "Called them back",
    });
    expect(conversations.close).toHaveBeenCalledTimes(1);
  });

  it("records a staff close without a note and publishes null on the read model", async () => {
    const { service, conversations, auditAppend } = createService();
    const open = openConversation();
    const closed = {
      ...open,
      lifecycle: {
        state: "closed" as const,
        reason: "cancelled" as const,
        closedAt: new Date("2026-07-25T02:00:00.000Z"),
      },
      staffClose: { reason: "abusive" as const, note: null },
    };
    conversations.findById.mockResolvedValue(open);
    conversations.close.mockResolvedValue({
      changed: true,
      conversation: closed,
    });

    const result = await service.close(
      campaignId,
      conversationId,
      { reason: "abusive" },
      "admin-1",
      "req-1",
    );

    expect(result.staffClose).toEqual({ reason: "abusive", note: null });
    expect(auditAppend).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        context: {
          campaignId,
          reason: "cancelled",
          staffReason: "abusive",
        },
      }),
    );
  });

  it("rejects a staff close body with a missing or unknown reason", () => {
    // The controller never reaches the service with a bare close: Zod refuses
    // the request first. A close with no why is exactly the month-later
    // confusion this body exists to stop.
    expect(closeFeedbackConversationSchema.safeParse({}).success).toBe(false);
    expect(
      closeFeedbackConversationSchema.safeParse({ reason: "cancelled" })
        .success,
    ).toBe(false);
    expect(
      closeFeedbackConversationSchema.safeParse({ reason: "abusive" }).success,
    ).toBe(true);
    expect(
      closeFeedbackConversationSchema.parse({
        reason: "other",
        note: "  followed up by phone  ",
      }),
    ).toEqual({ reason: "other", note: "followed up by phone" });
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
      service.close(
        campaignId,
        conversationId,
        { reason: "other" },
        "admin-1",
        "req-1",
      ),
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

  it("corrects a score in place and keeps what the model proposed", async () => {
    const { service, repository, conversations, auditAppend } = createService();
    conversations.findById.mockResolvedValue(openConversation());
    repository.findAnswerById.mockResolvedValue(scoreRow());
    repository.updateAnswerValue.mockImplementation(
      async (_transaction: unknown, input: { extractionMeta: unknown }) =>
        scoreRow({
          valueInt: 2,
          extractionMeta:
            input.extractionMeta as FeedbackAnswerRow["extractionMeta"],
        }),
    );

    const view = await service.correctAnswerValue(
      campaignId,
      conversationId,
      answerId,
      { valueInt: 2, note: "Είπε 2 στο τέλος" },
      "admin-1",
      "req-20",
    );

    const [, update] = repository.updateAnswerValue.mock.calls[0] as [
      unknown,
      { id: string; valueInt: number; extractionMeta: Record<string, unknown> },
    ];
    expect(update.id).toBe(answerId);
    expect(update.valueInt).toBe(2);
    // What the model said survives beside what the operator decided: the
    // correction is appended to the same blob rather than replacing it, which is
    // the whole reason this needs no migration and no reader changes.
    expect(update.extractionMeta).toMatchObject({
      model: "google/gemini-3.6-flash",
      confidence: 0.82,
      candidateIds: [subjectId],
      corrections: [
        {
          by: "admin-1",
          from: { valueInt: 4 },
          to: { valueInt: 2 },
          note: "Είπε 2 στο τέλος",
        },
      ],
    });
    // Serialized against a running extraction by the same advisory lock the
    // persist path takes.
    expect(repository.lockConversation).toHaveBeenCalled();

    expect(view.valueInt).toBe(2);
    expect(view.correction).toMatchObject({ by: "admin-1" });
    expect(auditAppend).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "feedback_answer.corrected",
        actorType: "admin",
        actorId: "admin-1",
        entityType: "feedback_answer",
        entityId: answerId,
        context: expect.objectContaining({
          questionKey: "event_score",
          from: { valueInt: 4 },
          to: { valueInt: 2 },
          note: "Είπε 2 στο τέλος",
        }),
      }),
    );
  });

  it("corrects a score on a closed conversation, which is the case it exists for", async () => {
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
    repository.findAnswerById.mockResolvedValue(scoreRow());
    repository.updateAnswerValue.mockResolvedValue(scoreRow({ valueInt: 3 }));

    // Once a thread closes the model will never read it again, so a wrong
    // number is wrong for good unless a person can change it. Recording what is
    // true is not steering the conversation, so this is not capability-gated.
    const view = await service.correctAnswerValue(
      campaignId,
      conversationId,
      answerId,
      { valueInt: 3 },
      "admin-1",
      "req-21",
    );

    expect(view.valueInt).toBe(3);
    expect(repository.updateAnswerValue).toHaveBeenCalled();
  });

  it("does nothing when the value is already the one recorded", async () => {
    const { service, repository, conversations, auditAppend } = createService();
    conversations.findById.mockResolvedValue(openConversation());
    repository.findAnswerById.mockResolvedValue(scoreRow({ valueInt: 2 }));

    const view = await service.correctAnswerValue(
      campaignId,
      conversationId,
      answerId,
      { valueInt: 2 },
      "admin-1",
      "req-22",
    );

    // A double-clicked or retried request must not append a second identical
    // correction. The consequence is stated rather than hidden: re-affirming the
    // model's own value is not a way to freeze it.
    expect(view.valueInt).toBe(2);
    expect(repository.updateAnswerValue).not.toHaveBeenCalled();
    expect(auditAppend).not.toHaveBeenCalled();
  });

  it("refuses to put a number on a question whose answer is a person", async () => {
    const { service, repository, conversations } = createService();
    conversations.findById.mockResolvedValue(openConversation());
    repository.findAnswerById.mockResolvedValue(answerRow());

    // `value_int` is null on every liked / meet_again / avoid row because the
    // subject is the answer. A 3 there would assert something the question
    // cannot express; the wrong-person case is a withdrawal.
    await expect(
      service.correctAnswerValue(
        campaignId,
        conversationId,
        answerId,
        { valueInt: 3 },
        "admin-1",
        "req-23",
      ),
    ).rejects.toBeInstanceOf(FeedbackConversationActionNotAllowedError);
    expect(repository.updateAnswerValue).not.toHaveBeenCalled();
  });

  it("will not touch an answer belonging to another conversation", async () => {
    const { service, repository, conversations } = createService();
    conversations.findById.mockResolvedValue(openConversation());
    repository.findAnswerById.mockResolvedValue(
      scoreRow({ conversationId: "7f0f2f8a-2b73-5a02-9d0a-3f0b8f5b1c22" }),
    );

    await expect(
      service.correctAnswerValue(
        campaignId,
        conversationId,
        answerId,
        { valueInt: 3 },
        "admin-1",
        "req-24",
      ),
    ).rejects.toBeInstanceOf(FeedbackAnswerNotFoundError);
    await expect(
      service.withdrawAnswer(
        campaignId,
        conversationId,
        answerId,
        "admin-1",
        "req-25",
      ),
    ).rejects.toBeInstanceOf(FeedbackAnswerNotFoundError);
  });

  it("withdraws a wrong-subject answer with the whole row in the audit context", async () => {
    const { service, repository, conversations, auditAppend } = createService();
    conversations.findById.mockResolvedValue(
      openConversation({
        lifecycle: {
          state: "closed",
          reason: "cancelled",
          closedAt: new Date("2026-07-25T01:00:00.000Z"),
        },
      }),
    );
    const withdrawn = answerRow({ questionKey: "avoid" });
    repository.findAnswerById.mockResolvedValue(withdrawn);
    repository.deleteAnswer.mockResolvedValue(withdrawn);

    const result = await service.withdrawAnswer(
      campaignId,
      conversationId,
      answerId,
      "admin-1",
      "req-26",
    );

    expect(result).toStrictEqual({ id: answerId });
    expect(repository.deleteAnswer).toHaveBeenCalledWith(
      expect.anything(),
      answerId,
    );
    expect(repository.lockConversation).toHaveBeenCalled();
    // The tombstone on the slot the row occupied, in the same transaction as the
    // delete. Without it the withdrawal is indistinguishable from an answer
    // nobody ever gave, and the next run that reads the participant's words
    // records it again over the operator's decision.
    expect(repository.recordAnswerWithdrawal).toHaveBeenCalledWith(
      expect.anything(),
      {
        campaignId,
        conversationId,
        questionKey: "avoid",
        subjectParticipantId: subjectId,
        answerId,
        withdrawnBy: "admin-1",
      },
    );
    // A hard delete, as the contradiction path already is, because a
    // soft-deleted row would have to be filtered out of every read of the table.
    // So the audit context is the only place the withdrawn assertion itself
    // survives, and it carries the whole row.
    expect(auditAppend).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "feedback_answer.withdrawn",
        entityType: "feedback_answer",
        entityId: answerId,
        context: expect.objectContaining({
          campaignId,
          conversationId,
          answer: {
            id: answerId,
            campaignId,
            conversationId,
            respondentParticipantId: participantId,
            subjectParticipantId: subjectId,
            questionKey: "avoid",
            valueInt: null,
            sourceMessageIds: ["ffffffff-ffff-4fff-8fff-ffffffffffff"],
            extractionMeta: { candidateIds: [subjectId] },
            matchingHold: false,
            createdAt: "2026-07-25T00:40:00.000Z",
            updatedAt: "2026-07-25T00:40:00.000Z",
          },
        }),
      }),
    );
  });

  it("publishes a correction on the answers read model, and nothing more", async () => {
    const { service, repository } = createService();
    repository.listAnswersByCampaign.mockResolvedValue([
      scoreRow({
        valueInt: 2,
        extractionMeta: {
          model: "google/gemini-3.6-flash",
          confidence: 0.82,
          candidateIds: [subjectId],
          corrections: [
            {
              at: "2026-07-27T10:00:00.000Z",
              by: "admin-1",
              from: { valueInt: 4 },
              to: { valueInt: 2 },
              note: "Είπε 2 στο τέλος",
            },
          ],
        },
      }),
    ]);

    const result = await service.listCampaignResults(campaignId, {});

    // Enough for the admin to say who decided this value and when. The
    // before/after and the operator's note stay in `audit_events`: publishing
    // them here would put a second, editable history in the read model, and the
    // model's confidence score is a number an operator cannot calibrate.
    expect(result.answers[0]?.correction).toStrictEqual({
      at: "2026-07-27T10:00:00.000Z",
      by: "admin-1",
    });
    expect(result.answers[0]).not.toHaveProperty("extractionMeta");
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

  it("exposes attention reasons, resolved ones included, on the detail view", async () => {
    const { service, conversations } = createService();
    conversations.findById.mockResolvedValue(
      openConversation({
        needsAttention: true,
        attentionReasons: [
          attentionReason(),
          attentionReason({
            id: secondReasonId,
            kind: "answer_revision",
            messageId: null,
            resolvedAt: new Date("2026-07-25T02:00:00.000Z"),
            resolvedBy: "admin-2",
          }),
        ],
      }),
    );

    const detail = await service.get(campaignId, conversationId);

    expect(detail.attentionReasons).toStrictEqual([
      {
        id: reasonId,
        kind: "safety",
        messageId: attentionMessageId,
        at: "2026-07-25T01:00:00.000Z",
        resolvedAt: null,
        resolvedBy: null,
      },
      {
        id: secondReasonId,
        kind: "answer_revision",
        messageId: null,
        at: "2026-07-25T01:00:00.000Z",
        resolvedAt: "2026-07-25T02:00:00.000Z",
        resolvedBy: "admin-2",
      },
    ]);
  });

  it("dismisses one reason and records who dismissed it", async () => {
    const { service, conversations, auditAppend } = createService();
    const flagged = openConversation({
      needsAttention: true,
      attentionReasons: [attentionReason()],
    });
    conversations.findById.mockResolvedValue(flagged);
    conversations.resolveAttentionReason.mockResolvedValue({
      changed: true,
      conversation: {
        ...flagged,
        needsAttention: false,
        attentionReasons: [
          attentionReason({
            resolvedAt: new Date("2026-07-25T03:00:00.000Z"),
            resolvedBy: "admin-1",
          }),
        ],
      },
    });

    const detail = await service.resolveAttentionReason(
      campaignId,
      conversationId,
      reasonId,
      "admin-1",
      "req-12",
    );

    expect(conversations.resolveAttentionReason).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId,
        reasonId,
        resolvedBy: "admin-1",
      }),
    );
    expect(detail.needsAttention).toBe(false);
    expect(detail.attentionReasons[0]?.resolvedBy).toBe("admin-1");
    expect(auditAppend).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "feedback_conversation.attention_resolved",
        actorType: "admin",
        actorId: "admin-1",
        entityType: "feedback_conversation",
        entityId: conversationId,
        context: expect.objectContaining({
          reasonId,
          kind: "safety",
          stillNeedsAttention: false,
        }),
      }),
    );
  });

  it("treats dismissing an already-resolved reason as a no-op", async () => {
    const { service, conversations, auditAppend } = createService();
    conversations.findById.mockResolvedValue(
      openConversation({
        attentionReasons: [
          attentionReason({
            resolvedAt: new Date("2026-07-25T03:00:00.000Z"),
            resolvedBy: "admin-2",
          }),
        ],
      }),
    );

    // A double click must not write a second audit row saying it was cleared
    // again by somebody else.
    const detail = await service.resolveAttentionReason(
      campaignId,
      conversationId,
      reasonId,
      "admin-1",
      "req-13",
    );

    expect(conversations.resolveAttentionReason).not.toHaveBeenCalled();
    expect(auditAppend).not.toHaveBeenCalled();
    expect(detail.attentionReasons[0]?.resolvedBy).toBe("admin-2");
  });

  it("refuses to dismiss a reason this conversation never carried", async () => {
    const { service, conversations } = createService();
    conversations.findById.mockResolvedValue(openConversation());

    await expect(
      service.resolveAttentionReason(
        campaignId,
        conversationId,
        reasonId,
        "admin-1",
        "req-14",
      ),
    ).rejects.toBeInstanceOf(FeedbackAttentionReasonNotFoundError);
    expect(conversations.resolveAttentionReason).not.toHaveBeenCalled();
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
    extraction: {
      cursorSeq: 0,
      lastRunAt: null,
      model: null,
      parkedSince: null,
      parkedRuns: 0,
      parkedNoticeSentAt: null,
    },
    needsAttention: false,
    attentionReasons: [],
    remindedAt: null,
    reminderCount: 0,
    awaitingHuman: false,
    hostileTurns: 0,
    extractionFallbackAckSent: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function attentionReason(
  overrides: Partial<
    FeedbackConversationDocument["attentionReasons"][number]
  > = {},
): FeedbackConversationDocument["attentionReasons"][number] {
  return {
    id: reasonId,
    kind: "safety",
    messageId: attentionMessageId,
    at: new Date("2026-07-25T01:00:00.000Z"),
    resolvedAt: null,
    resolvedBy: null,
    ...overrides,
  };
}

function listSummary(
  overrides: {
    control?: { mode: "bot" | "human"; source: "launch" | "staff_action" };
    needsAttention?: boolean;
    extractionParked?: boolean;
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
    extractionParked: overrides.extractionParked ?? false,
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

function answerRow(
  overrides: Partial<FeedbackAnswerRow> = {},
): FeedbackAnswerRow {
  return {
    id: answerId,
    campaignId,
    conversationId,
    respondentParticipantId: participantId,
    subjectParticipantId: subjectId,
    questionKey: "liked",
    valueInt: null,
    sourceMessageIds: ["ffffffff-ffff-4fff-8fff-ffffffffffff"],
    extractionMeta: { candidateIds: [subjectId] },
    matchingHold: false,
    createdAt: new Date("2026-07-25T00:40:00.000Z"),
    updatedAt: new Date("2026-07-25T00:40:00.000Z"),
    ...overrides,
  };
}

/** The one question whose answer is a number, so the one that can be corrected. */
function scoreRow(
  overrides: Partial<FeedbackAnswerRow> = {},
): FeedbackAnswerRow {
  return answerRow({
    questionKey: "event_score",
    subjectParticipantId: null,
    valueInt: 4,
    extractionMeta: {
      model: "google/gemini-3.6-flash",
      confidence: 0.82,
      candidateIds: [subjectId],
    },
    ...overrides,
  });
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
  queue: {
    add: ReturnType<typeof vi.fn>;
    getJob: ReturnType<typeof vi.fn>;
  };
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
    findAnswerById: ReturnType<typeof vi.fn>;
    updateAnswerValue: ReturnType<typeof vi.fn>;
    deleteAnswer: ReturnType<typeof vi.fn>;
    recordAnswerWithdrawal: ReturnType<typeof vi.fn>;
    lockConversation: ReturnType<typeof vi.fn>;
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
    resolveAttentionReason: ReturnType<typeof vi.fn>;
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
    findAnswerById: vi.fn(),
    updateAnswerValue: vi.fn(),
    deleteAnswer: vi.fn(),
    recordAnswerWithdrawal: vi.fn(),
    lockConversation: vi.fn().mockResolvedValue(undefined),
  };
  const conversations = {
    listForCampaign: vi.fn().mockResolvedValue([]),
    findById: vi.fn(),
    takeOver: vi.fn(),
    resumeBot: vi.fn(),
    close: vi.fn(),
    appendMessage: vi.fn(),
    resolveAttentionReason: vi.fn(),
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
  const queue = {
    add: vi.fn().mockResolvedValue({ id: "job" }),
    getJob: vi.fn().mockResolvedValue(null),
  };

  const service = new PostEventFeedbackConversationService(
    queue as unknown as Queue<FeedbackJobData, void, FeedbackJobName>,
    database as unknown as DatabaseService,
    repository as unknown as FeedbackCampaignRepository,
    repository as unknown as FeedbackResultsRepository,
    repository as unknown as FeedbackOutboxRepository,
    conversations as unknown as FeedbackConversationRepository,
    events as unknown as EventsRepository,
    eventsService as unknown as EventsService,
    participants as unknown as ParticipantsRepository,
    { append: auditAppend } as unknown as AuditRepository,
    new FeedbackOutboundTranscriptService(
      database as unknown as DatabaseService,
      repository as unknown as FeedbackOutboxRepository,
      conversations as unknown as FeedbackConversationRepository,
    ),
  );

  return {
    service,
    queue,
    repository,
    eventsService,
    conversations,
    participants,
    auditAppend,
  };
}
