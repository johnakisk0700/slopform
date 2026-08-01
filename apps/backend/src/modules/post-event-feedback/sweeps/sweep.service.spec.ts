import { describe, expect, it, vi } from "vitest";

import type { ConfigService } from "@nestjs/config";

import type { Environment } from "../../../infrastructure/config/environment.js";
import type { AuditRepository } from "../../../infrastructure/audit/audit.repository.js";
import type { DatabaseService } from "../../../infrastructure/database/database.service.js";
import type { FeedbackConversationRepository } from "../post-event-feedback-conversation.repository.js";
import { buildFeedbackConversationGoals } from "../post-event-feedback-conversation.document.js";
import type { ParticipantsRepository } from "../../participants/participants.repository.js";
import { FeedbackOutboundTranscriptService } from "../outbox/outbound-transcript.service.js";
import type { FeedbackOutboundLogRepository } from "../outbox/outbound-log.repository.js";
import { FeedbackOutboundLogService } from "../outbox/outbound-log.service.js";
import { buildPostEventFeedbackQuestionLaunchSnapshot } from "../question-set.js";
import type { FeedbackCampaignRepository } from "../campaign/campaign.repository.js";
import type { FeedbackIngressRepository } from "../ingress/ingress.repository.js";
import type { FeedbackOutboxRepository } from "../outbox/outbox.repository.js";
import { PostEventFeedbackSweepService } from "./sweep.service.js";
import {
  createFeedbackMaterializeJobId,
  FEEDBACK_JOB_NAMES,
} from "../jobs.schemas.js";

const conversationId = "6f0f2f8a-2b73-5a02-9d0a-3f0b8f5b1c21";
const campaignId = "89eccaa5-9ce6-4dcf-a630-5e35e4ec6f0d";
const participantId = "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const ingressId = "b1c9e0a4-2c65-4a29-9a2e-2d0a3f2e1b77";
const reminderOutboxId = "c2d8f1b5-3d76-4b3a-8b3f-3e1b4f3d2c88";

describe("PostEventFeedbackSweepService", () => {
  it("queues one reminder when there is no participant reply", async () => {
    const { service, conversations, repository, auditAppend } = createService();
    const open = openConversation();
    conversations.listOpenDueForReminder.mockResolvedValue([open]);
    conversations.findById.mockResolvedValue(open);
    repository.findCampaignById.mockResolvedValue(launchedCampaign());
    repository.insertOutboxIfAbsent.mockResolvedValue({
      row: {
        id: reminderOutboxId,
        conversationId,
        campaignId,
        kind: "reminder",
        body: "Μια μικρή υπενθύμιση",
      },
      inserted: true,
    });

    const result = await service.sweepReminders("corr-1", ONE_DAY_LATER);

    expect(result).toEqual({ examined: 1, reminded: 1, skipped: 0 });
    expect(repository.insertOutboxIfAbsent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        kind: "reminder",
        dedupeKey: `feedback-reminder-${conversationId}-1`,
      }),
    );
    expect(conversations.markReminded).toHaveBeenCalled();
    expect(auditAppend).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "feedback_conversation.reminded" }),
    );
    expect(conversations.appendMessage).toHaveBeenCalledWith({
      conversationId,
      actor: "bot",
      text: "Μια μικρή υπενθύμιση",
      at: expect.any(Date),
      outboxId: reminderOutboxId,
    });
  });

  it("writes one reminder log with the due rung when a nudge is enqueued", async () => {
    const { service, conversations, repository } = createService();
    const open = openConversation();
    conversations.listOpenDueForReminder.mockResolvedValue([open]);
    conversations.findById.mockResolvedValue(open);
    repository.findCampaignById.mockResolvedValue(launchedCampaign());
    repository.insertOutboxIfAbsent.mockResolvedValue({
      row: {
        id: reminderOutboxId,
        conversationId,
        campaignId,
        kind: "reminder",
        body: "Μια μικρή υπενθύμιση",
      },
      inserted: true,
    });

    await service.sweepReminders("corr-1", ONE_DAY_LATER);

    expect(repository.insertOutboxLogIfAbsent).toHaveBeenCalledTimes(1);
    expect(repository.insertOutboxLogIfAbsent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        outboxId: reminderOutboxId,
        origin: "reminder",
        correlationId: "corr-1",
        decision: {
          origin: "reminder",
          rung: 1,
        },
      }),
    );
  });

  it("repairs a missing reminder transcript entry on the next sweep", async () => {
    const { service, conversations, repository } = createService();
    const open = openConversation();
    conversations.listOpenDueForReminder.mockResolvedValue([open]);
    conversations.findById.mockResolvedValue(open);
    repository.findCampaignById.mockResolvedValue(launchedCampaign());
    // The row exists from a sweep that crashed before `markReminded`, so this
    // sweep re-selects the conversation and finds the same row.
    repository.insertOutboxIfAbsent.mockResolvedValue({
      row: {
        id: reminderOutboxId,
        conversationId,
        campaignId,
        kind: "reminder",
        body: "Μια μικρή υπενθύμιση",
      },
      inserted: false,
    });

    const result = await service.sweepReminders("corr-repair", new Date());

    expect(result.reminded).toBe(0);
    expect(conversations.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ actor: "bot", outboxId: reminderOutboxId }),
    );
    expect(conversations.markReminded).toHaveBeenCalled();
  });

  it("does not write a duplicate reminder log when the sweep finds the same row", async () => {
    const { service, conversations, repository } = createService();
    const open = openConversation();
    conversations.listOpenDueForReminder.mockResolvedValue([open]);
    conversations.findById.mockResolvedValue(open);
    repository.findCampaignById.mockResolvedValue(launchedCampaign());
    repository.insertOutboxIfAbsent.mockResolvedValue({
      row: {
        id: reminderOutboxId,
        conversationId,
        campaignId,
        kind: "reminder",
        body: "Μια μικρή υπενθύμιση",
      },
      inserted: false,
    });

    await service.sweepReminders("corr-repair", new Date());

    expect(repository.insertOutboxLogIfAbsent).not.toHaveBeenCalled();
  });

  it("skips reminder for opted-out, human-controlled and already closed threads", async () => {
    const { service, conversations, repository, participants } =
      createService();
    const optedOut = openConversation();
    const human = {
      ...openConversation(),
      _id: "11111111-1111-4111-8111-111111111111",
      control: { mode: "human", source: "staff_action", changedAt: new Date() },
    };
    const closed = {
      ...openConversation(),
      _id: "22222222-2222-4222-8222-222222222222",
      lifecycle: {
        state: "closed",
        reason: "completed",
        closedAt: new Date(),
      },
    };
    conversations.listOpenDueForReminder.mockResolvedValue([
      optedOut,
      human,
      closed,
    ]);
    conversations.findById
      .mockResolvedValueOnce(optedOut)
      .mockResolvedValueOnce(human)
      .mockResolvedValueOnce(closed);
    repository.findCampaignById.mockResolvedValue(launchedCampaign());
    participants.findById.mockResolvedValue({
      id: participantId,
      preferredName: "Roula",
      emailNormalized: "roula@example.com",
      postEventFeedbackWhatsappOptIn: false,
    });

    const result = await service.sweepReminders("corr-1", new Date());

    expect(result).toEqual({ examined: 3, reminded: 0, skipped: 3 });
    expect(repository.insertOutboxIfAbsent).not.toHaveBeenCalled();
  });

  it("does not nudge a conversation whose extraction is parked", async () => {
    const { service, conversations, repository, participants } =
      createService();
    const stuck = openConversation();
    stuck.extraction.parkedSince = CONVERSATION_CREATED_AT;
    conversations.listOpenDueForReminder.mockResolvedValue([stuck]);
    conversations.findById.mockResolvedValue(stuck);
    repository.findCampaignById.mockResolvedValue(launchedCampaign());
    participants.findById.mockResolvedValue({
      id: participantId,
      preferredName: "Roula",
      emailNormalized: "roula@example.com",
      postEventFeedbackWhatsappOptIn: true,
    });

    const result = await service.sweepReminders("corr-1", ONE_DAY_LATER);

    // Their message is sitting unread behind the cursor, quite possibly with our
    // own «δεν έχουμε δει ακόμα το μήνυμά σου» already sent. «Πες μας πώς σου
    // φάνηκε η βραδιά» a day later reads as a machine that lost what they wrote.
    expect(result).toEqual({ examined: 1, reminded: 0, skipped: 1 });
    expect(repository.insertOutboxIfAbsent).not.toHaveBeenCalled();
  });

  it("expires an open bot conversation and cancels queued sends", async () => {
    const { service, conversations, repository, auditAppend } = createService();
    const open = openConversation();
    conversations.listOpenDueForExpiry.mockResolvedValue([open]);
    conversations.findById.mockResolvedValue(open);
    conversations.close.mockResolvedValue({
      changed: true,
      conversation: open,
    });
    repository.findCampaignById.mockResolvedValue(launchedCampaign());
    repository.cancelQueuedOutboxForConversation.mockResolvedValue(2);

    const result = await service.sweepExpiry("corr-1", THREE_DAYS_LATER);

    expect(result).toEqual({ examined: 1, expired: 1, skipped: 0 });
    expect(conversations.close).toHaveBeenCalledWith({
      conversationId,
      reason: "expired",
      at: expect.any(Date),
    });
    expect(repository.cancelQueuedOutboxForConversation).toHaveBeenCalled();
    expect(auditAppend).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "feedback_conversation.expired" }),
    );
  });

  it("skips expiry for human control and already closed conversations", async () => {
    const { service, conversations, repository } = createService();
    const human = {
      ...openConversation(),
      control: { mode: "human", source: "staff_action", changedAt: new Date() },
    };
    conversations.listOpenDueForExpiry.mockResolvedValue([human]);
    conversations.findById.mockResolvedValue(human);

    const result = await service.sweepExpiry("corr-1", new Date());

    expect(result).toEqual({ examined: 1, expired: 0, skipped: 1 });
    expect(conversations.close).not.toHaveBeenCalled();
    expect(repository.cancelQueuedOutboxForConversation).not.toHaveBeenCalled();
  });

  it("re-enqueues stuck pending ingress rows under the stable job id", async () => {
    const { service, repository, queue } = createService();
    const stuckAt = new Date("2026-07-25T00:00:00.000Z");
    repository.listPendingIngressOlderThan.mockResolvedValue([
      {
        id: ingressId,
        processingStatus: "pending",
        createdAt: stuckAt,
      },
    ]);

    const result = await service.sweepIngress(
      "corr-1",
      new Date("2026-07-25T00:10:00.000Z"),
    );

    expect(result).toEqual({ examined: 1, requeued: 1, failed: 0 });
    expect(repository.listPendingIngressOlderThan).toHaveBeenCalledWith(
      new Date("2026-07-25T00:05:00.000Z"),
      50,
    );
    expect(queue.add).toHaveBeenCalledWith(
      FEEDBACK_JOB_NAMES.materializeV1,
      expect.objectContaining({ ingressId }),
      expect.objectContaining({
        jobId: createFeedbackMaterializeJobId(ingressId),
      }),
    );
  });

  it("leaves fresh pending ingress rows untouched", async () => {
    const { service, repository, queue } = createService();
    repository.listPendingIngressOlderThan.mockResolvedValue([]);

    const now = new Date("2026-07-25T00:10:00.000Z");
    const result = await service.sweepIngress("corr-1", now);

    expect(result).toEqual({ examined: 0, requeued: 0, failed: 0 });
    expect(repository.listPendingIngressOlderThan).toHaveBeenCalledWith(
      new Date("2026-07-25T00:05:00.000Z"),
      50,
    );
    expect(queue.add).not.toHaveBeenCalled();
  });
});

const CONVERSATION_CREATED_AT = new Date("2026-07-24T00:00:00.000Z");
/** Exactly one reminder spacing of silence: the first rung is due, not the second. */
const ONE_DAY_LATER = new Date("2026-07-25T00:00:00.000Z");
/** Exactly the expiry threshold of silence. */
const THREE_DAYS_LATER = new Date("2026-07-27T00:00:00.000Z");

function openConversation() {
  return {
    _id: conversationId,
    campaignId,
    respondentParticipantId: participantId,
    lifecycle: { state: "open", reason: null, closedAt: null },
    control: {
      mode: "bot",
      source: "launch",
      changedAt: CONVERSATION_CREATED_AT,
    },
    goals: buildFeedbackConversationGoals(),
    messages: [],
    extraction: {
      cursorSeq: 0,
      lastRunAt: null as Date | null,
      model: null as string | null,
      parkedSince: null as Date | null,
      parkedRuns: 0,
      parkedNoticeSentAt: null as Date | null,
    },
    needsAttention: false,
    attentionReasons: [],
    remindedAt: null,
    reminderCount: 0,
    awaitingHuman: false,
    createdAt: CONVERSATION_CREATED_AT,
  };
}

function launchedCampaign() {
  return {
    id: campaignId,
    status: "launched",
    questions: buildPostEventFeedbackQuestionLaunchSnapshot(),
  };
}

function createService(): {
  service: PostEventFeedbackSweepService;
  conversations: {
    listOpenDueForReminder: ReturnType<typeof vi.fn>;
    listOpenDueForExpiry: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    markReminded: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    appendMessage: ReturnType<typeof vi.fn>;
  };
  repository: {
    findCampaignById: ReturnType<typeof vi.fn>;
    insertOutboxIfAbsent: ReturnType<typeof vi.fn>;
    insertOutboxLogIfAbsent: ReturnType<typeof vi.fn>;
    cancelQueuedOutboxForConversation: ReturnType<typeof vi.fn>;
    listPendingIngressOlderThan: ReturnType<typeof vi.fn>;
  };
  participants: {
    findById: ReturnType<typeof vi.fn>;
  };
  queue: {
    add: ReturnType<typeof vi.fn>;
  };
  auditAppend: ReturnType<typeof vi.fn>;
} {
  const conversations = {
    listOpenDueForReminder: vi.fn().mockResolvedValue([]),
    listOpenDueForExpiry: vi.fn().mockResolvedValue([]),
    findById: vi.fn(),
    markReminded: vi.fn().mockResolvedValue({ changed: true }),
    close: vi.fn(),
    appendMessage: vi
      .fn()
      .mockResolvedValue({ appended: true, message: {}, conversation: {} }),
  };
  const repository = {
    findCampaignById: vi.fn(),
    insertOutboxIfAbsent: vi.fn(),
    insertOutboxLogIfAbsent: vi.fn().mockResolvedValue({
      row: { id: "log-1" },
      inserted: true,
    }),
    cancelQueuedOutboxForConversation: vi.fn().mockResolvedValue(0),
    listPendingIngressOlderThan: vi.fn().mockResolvedValue([]),
  };
  const participants = {
    findById: vi.fn().mockResolvedValue({
      id: participantId,
      preferredName: "Roula",
      emailNormalized: "roula@example.com",
      postEventFeedbackWhatsappOptIn: true,
    }),
  };
  const queue = { add: vi.fn().mockResolvedValue({ id: "job-1" }) };
  const auditAppend = vi.fn().mockResolvedValue(undefined);
  const config = {
    get: vi.fn((key: keyof Environment) => {
      if (key === "FEEDBACK_REMINDER_AFTER_HOURS") return 24;
      if (key === "FEEDBACK_EXPIRE_AFTER_HOURS") return 72;
      if (key === "FEEDBACK_MAX_REMINDERS") return 2;
      if (key === "FEEDBACK_INGRESS_PENDING_RECOVERY_MINUTES") return 5;
      return undefined;
    }),
  };
  const database = {
    transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) =>
      work({}),
    ),
  };

  return {
    service: new PostEventFeedbackSweepService(
      queue as never,
      config as unknown as ConfigService<Environment, true>,
      database as unknown as DatabaseService,
      repository as unknown as FeedbackCampaignRepository,
      repository as unknown as FeedbackIngressRepository,
      repository as unknown as FeedbackOutboxRepository,
      conversations as unknown as FeedbackConversationRepository,
      participants as unknown as ParticipantsRepository,
      { append: auditAppend } as unknown as AuditRepository,
      new FeedbackOutboundTranscriptService(
        database as unknown as DatabaseService,
        repository as unknown as FeedbackOutboxRepository,
        conversations as unknown as FeedbackConversationRepository,
      ),
      new FeedbackOutboundLogService(
        repository as unknown as FeedbackOutboundLogRepository,
      ),
    ),
    conversations,
    repository,
    participants,
    queue,
    auditAppend,
  };
}
