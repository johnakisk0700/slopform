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
import type { FeedbackMaterializeWakeupService } from "../ingress/materialize-wakeup.service.js";
import type { FeedbackOutboxRepository } from "../outbox/outbox.repository.js";
import { PostEventFeedbackSweepService } from "./sweep.service.js";
import type {
  FeedbackMaintenanceCheckpointRepository,
  FeedbackPendingIngressRecoveryCursor,
} from "./maintenance-checkpoint.repository.js";
import { noopSummaries } from "../post-event-feedback-doubles.harness.js";

const conversationId = "6f0f2f8a-2b73-5a02-9d0a-3f0b8f5b1c21";
const campaignId = "89eccaa5-9ce6-4dcf-a630-5e35e4ec6f0d";
const participantId = "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const ingressId = "b1c9e0a4-2c65-4a29-9a2e-2d0a3f2e1b77";
const reminderOutboxId = "c2d8f1b5-3d76-4b3a-8b3f-3e1b4f3d2c88";

describe("PostEventFeedbackSweepService", () => {
  it("queues one reminder when there is no participant reply", async () => {
    const { service, conversations, repository, auditAppend } = createService();
    const open = openConversation();
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

    const result = await service.remindConversation({
      conversationId,
      ordinal: 1,
      correlationId: "corr-1",
      now: ONE_DAY_LATER,
    });

    expect(result).toBe(true);
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

    await service.remindConversation({
      conversationId,
      ordinal: 1,
      correlationId: "corr-1",
      now: ONE_DAY_LATER,
    });

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

  it("repairs a missing reminder transcript entry on the next reconciliation", async () => {
    const { service, conversations, repository } = createService();
    const open = openConversation();
    conversations.findById.mockResolvedValue(open);
    repository.findCampaignById.mockResolvedValue(launchedCampaign());
    // The row exists from reconciliation that crashed before `markReminded`,
    // so the replay resolves the same planner action and finds the same row.
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

    const result = await service.remindConversation({
      conversationId,
      ordinal: 1,
      correlationId: "corr-repair",
      now: ONE_DAY_LATER,
    });

    expect(result).toBe(false);
    expect(conversations.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ actor: "bot", outboxId: reminderOutboxId }),
    );
    expect(conversations.markReminded).toHaveBeenCalled();
  });

  it("does not write a duplicate reminder log when reconciliation finds the same row", async () => {
    const { service, conversations, repository } = createService();
    const open = openConversation();
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

    await service.remindConversation({
      conversationId,
      ordinal: 1,
      correlationId: "corr-repair",
      now: ONE_DAY_LATER,
    });

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
    conversations.findById
      .mockResolvedValueOnce(optedOut)
      .mockResolvedValueOnce(optedOut)
      .mockResolvedValueOnce(human)
      .mockResolvedValueOnce(human)
      .mockResolvedValueOnce(closed)
      .mockResolvedValueOnce(closed);
    repository.findCampaignById.mockResolvedValue(launchedCampaign());
    participants.findById.mockResolvedValue({
      id: participantId,
      preferredName: "Roula",
      emailNormalized: "roula@example.com",
      postEventFeedbackWhatsappOptIn: false,
    });

    const results = [
      await service.remindConversation({
        conversationId,
        ordinal: 1,
        correlationId: "corr-opted-out",
        now: ONE_DAY_LATER,
      }),
      await service.remindConversation({
        conversationId: human._id,
        ordinal: 1,
        correlationId: "corr-human",
        now: ONE_DAY_LATER,
      }),
      await service.remindConversation({
        conversationId: closed._id,
        ordinal: 1,
        correlationId: "corr-closed",
        now: ONE_DAY_LATER,
      }),
    ];

    expect(results).toEqual([false, false, false]);
    expect(repository.insertOutboxIfAbsent).not.toHaveBeenCalled();
  });

  it("does not nudge a conversation whose extraction is parked", async () => {
    const { service, conversations, repository, participants } =
      createService();
    const stuck = openConversation();
    stuck.extraction.parkedSince = CONVERSATION_CREATED_AT;
    conversations.findById.mockResolvedValue(stuck);
    repository.findCampaignById.mockResolvedValue(launchedCampaign());
    participants.findById.mockResolvedValue({
      id: participantId,
      preferredName: "Roula",
      emailNormalized: "roula@example.com",
      postEventFeedbackWhatsappOptIn: true,
    });

    const result = await service.remindConversation({
      conversationId,
      ordinal: 1,
      correlationId: "corr-1",
      now: ONE_DAY_LATER,
    });

    // Their message is sitting unread behind the cursor, quite possibly with our
    // own «δεν έχουμε δει ακόμα το μήνυμά σου» already sent. «Πες μας πώς σου
    // φάνηκε η βραδιά» a day later reads as a machine that lost what they wrote.
    expect(result).toBe(false);
    expect(repository.insertOutboxIfAbsent).not.toHaveBeenCalled();
  });

  it("drops a reminder when durable inbound lands after the Mongo silence snapshot", async () => {
    const { service, conversations, repository } = createService();
    const open = openConversation();
    conversations.findById.mockResolvedValue(open);
    repository.findCampaignById.mockResolvedValue(launchedCampaign());
    repository.hasInboundBeyondSnapshot.mockResolvedValue(true);

    const result = await service.remindConversation({
      conversationId,
      ordinal: 1,
      correlationId: "corr-race",
      now: ONE_DAY_LATER,
    });

    expect(result).toBe(false);
    expect(repository.lockInboundPhone).toHaveBeenCalledWith(
      expect.anything(),
      open.phoneAtLaunch,
    );
    expect(repository.hasInboundBeyondSnapshot).toHaveBeenCalledWith(
      expect.anything(),
      {
        phoneE164: open.phoneAtLaunch,
        conversationId,
        snapshotIngressIds: [],
      },
    );
    expect(repository.insertOutboxIfAbsent).not.toHaveBeenCalled();
    expect(conversations.markReminded).not.toHaveBeenCalled();
  });

  it("expires an open bot conversation and cancels queued sends", async () => {
    const { service, conversations, repository, auditAppend } = createService();
    const open = openConversation();
    conversations.findById.mockResolvedValue(open);
    conversations.close.mockResolvedValue({
      changed: true,
      conversation: open,
    });
    repository.findCampaignByIdForShare.mockResolvedValue(launchedCampaign());
    repository.cancelQueuedOutboxForConversation.mockResolvedValue(2);

    const result = await service.expireConversation({
      conversationId,
      correlationId: "corr-1",
      now: THREE_DAYS_LATER,
    });

    expect(result).toBe(true);
    expect(conversations.close).toHaveBeenCalledWith({
      conversationId,
      reason: "expired",
      at: expect.any(Date),
    });
    expect(repository.lockInboundPhone).toHaveBeenCalledWith(
      expect.anything(),
      open.phoneAtLaunch,
    );
    expect(repository.lockConversation).toHaveBeenCalledWith(
      expect.anything(),
      conversationId,
    );
    expect(repository.findCampaignByIdForShare).toHaveBeenCalledWith(
      expect.anything(),
      campaignId,
    );
    expect(repository.hasInboundBeyondSnapshot).toHaveBeenCalledWith(
      expect.anything(),
      {
        phoneE164: open.phoneAtLaunch,
        conversationId,
        snapshotIngressIds: [],
      },
    );
    const orderedCalls = [
      repository.lockInboundPhone.mock.invocationCallOrder[0],
      repository.lockConversation.mock.invocationCallOrder[0],
      repository.findCampaignByIdForShare.mock.invocationCallOrder[0],
      repository.hasInboundBeyondSnapshot.mock.invocationCallOrder[0],
      conversations.findById.mock.invocationCallOrder[1],
      conversations.close.mock.invocationCallOrder[0],
    ];
    expect(orderedCalls).toEqual([...orderedCalls].sort((a, b) => a! - b!));
    expect(repository.cancelQueuedOutboxForConversation).toHaveBeenCalled();
    expect(auditAppend).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "feedback_conversation.expired" }),
    );
  });

  it("drops expiry when staff takeover wins before the conversation lock", async () => {
    const { service, conversations, repository } = createService();
    const snapshot = openConversation();
    const human = {
      ...openConversation(),
      control: { mode: "human", source: "staff_action", changedAt: new Date() },
    };
    let latest = snapshot;
    conversations.findById.mockImplementation(async () => latest);
    repository.lockConversation.mockImplementation(async () => {
      latest = human;
    });
    repository.findCampaignByIdForShare.mockResolvedValue(launchedCampaign());

    const result = await service.expireConversation({
      conversationId,
      correlationId: "corr-takeover",
      now: THREE_DAYS_LATER,
    });

    expect(result).toBe(false);
    expect(repository.lockConversation).toHaveBeenCalled();
    expect(
      repository.lockConversation.mock.invocationCallOrder[0],
    ).toBeLessThan(conversations.findById.mock.invocationCallOrder[1]!);
    expect(conversations.close).not.toHaveBeenCalled();
    expect(repository.cancelQueuedOutboxForConversation).not.toHaveBeenCalled();
  });

  it.each(["paused", "closed"] as const)(
    "freezes expiry while the campaign is %s",
    async (status) => {
      const { service, conversations, repository } = createService();
      const snapshot = openConversation();
      conversations.findById.mockResolvedValue(snapshot);
      repository.findCampaignByIdForShare.mockResolvedValue({
        ...launchedCampaign(),
        status,
      });

      const result = await service.expireConversation({
        conversationId,
        correlationId: `corr-campaign-${status}`,
        now: THREE_DAYS_LATER,
      });

      expect(result).toBe(false);
      expect(repository.findCampaignByIdForShare).toHaveBeenCalledWith(
        expect.anything(),
        campaignId,
      );
      expect(conversations.close).not.toHaveBeenCalled();
      expect(
        repository.cancelQueuedOutboxForConversation,
      ).not.toHaveBeenCalled();
    },
  );

  it("drops expiry for pending inbound or a correction beyond its Mongo snapshot", async () => {
    const { service, conversations, repository } = createService();
    const snapshot = {
      ...openConversation(),
      messages: [
        {
          id: "da43e49c-fc88-4930-aefd-96c706c4ba7d",
          seq: 1,
          actor: "participant",
          text: "4, και τελικά 5",
          providerMessageId: "wamid.snapshot",
          ingressId,
          outboxId: null,
          attention: null,
          at: CONVERSATION_CREATED_AT,
        },
      ],
    };
    conversations.findById.mockResolvedValue(snapshot);
    repository.findCampaignByIdForShare.mockResolvedValue(launchedCampaign());
    repository.hasInboundBeyondSnapshot.mockResolvedValue(true);

    const result = await service.expireConversation({
      conversationId,
      correlationId: "corr-new-inbound",
      now: THREE_DAYS_LATER,
    });

    expect(result).toBe(false);
    expect(repository.hasInboundBeyondSnapshot).toHaveBeenCalledWith(
      expect.anything(),
      {
        phoneE164: snapshot.phoneAtLaunch,
        conversationId,
        snapshotIngressIds: [ingressId],
      },
    );
    expect(conversations.findById).toHaveBeenCalledTimes(1);
    expect(conversations.close).not.toHaveBeenCalled();
  });

  it("re-enqueues stuck pending ingress rows under the stable job id", async () => {
    const { service, repository, materializeWakeups, checkpoints } =
      createService();
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
      {
        olderThan: new Date("2026-07-25T00:05:00.000Z"),
        limit: 50,
      },
      expect.anything(),
    );
    expect(checkpoints.savePendingIngress).toHaveBeenCalledBefore(
      materializeWakeups.ensurePendingQueued,
    );
    expect(materializeWakeups.ensurePendingQueued).toHaveBeenCalledWith({
      ingressId,
      correlationId: `corr-1:${ingressId}`,
    });
  });

  it("leaves fresh pending ingress rows untouched", async () => {
    const { service, repository, materializeWakeups } = createService();
    repository.listPendingIngressOlderThan.mockResolvedValue([]);

    const now = new Date("2026-07-25T00:10:00.000Z");
    const result = await service.sweepIngress("corr-1", now);

    expect(result).toEqual({ examined: 0, requeued: 0, failed: 0 });
    expect(repository.listPendingIngressOlderThan).toHaveBeenCalledWith(
      {
        olderThan: new Date("2026-07-25T00:05:00.000Z"),
        limit: 50,
      },
      expect.anything(),
    );
    expect(materializeWakeups.ensurePendingQueued).not.toHaveBeenCalled();
  });

  it("reports a terminal-job repair race as failed so maintenance retries it", async () => {
    const { service, repository, materializeWakeups } = createService();
    repository.listPendingIngressOlderThan.mockResolvedValue([
      {
        id: ingressId,
        processingStatus: "pending",
        createdAt: new Date("2026-07-25T00:00:00.000Z"),
      },
    ]);
    materializeWakeups.ensurePendingQueued.mockRejectedValue(
      new Error("terminal removal lost an unresolved race"),
    );

    await expect(
      service.sweepIngress("corr-race", new Date("2026-07-25T00:10:00.000Z")),
    ).resolves.toEqual({ examined: 1, requeued: 0, failed: 1 });
  });

  it("passes 50 poison rows after an allocated-page crash and wraps finitely", async () => {
    const { service, repository, materializeWakeups } = createService();
    const rows = Array.from({ length: 51 }, (_, index) =>
      pendingIngress(index + 1),
    );
    repository.listPendingIngressOlderThan.mockImplementation(
      async (input: {
        olderThan: Date;
        limit: number;
        after?: FeedbackPendingIngressRecoveryCursor;
      }) =>
        rows
          .filter(
            (row) =>
              row.createdAt <= input.olderThan &&
              (!input.after ||
                row.createdAt > input.after.createdAt ||
                (row.createdAt.getTime() === input.after.createdAt.getTime() &&
                  row.id > input.after.ingressId)),
          )
          .slice(0, input.limit),
    );
    materializeWakeups.ensurePendingQueued.mockImplementation(
      async ({ ingressId: candidateId }: { ingressId: string }) => {
        if (candidateId !== rows[50]?.id) {
          throw new Error("poison ingress");
        }
        return `feedback-materialize-v1-${candidateId}`;
      },
    );

    // The process commits allocation of rows 1..50 and dies before publishing.
    const allocated = await (
      service as unknown as {
        allocatePendingIngressRecoveryPage(olderThan: Date): Promise<unknown[]>;
      }
    ).allocatePendingIngressRecoveryPage(INGRESS_RECOVERY_CUTOFF);
    expect(allocated).toHaveLength(50);
    expect(materializeWakeups.ensurePendingQueued).not.toHaveBeenCalled();

    // A new pass/replica starts beyond that committed page and reaches row 51.
    await expect(
      service.sweepIngress("after-crash", INGRESS_RECOVERY_NOW),
    ).resolves.toEqual({ examined: 1, requeued: 1, failed: 0 });
    expect(materializeWakeups.ensurePendingQueued).toHaveBeenCalledWith({
      ingressId: rows[50]?.id,
      correlationId: `after-crash:${rows[50]?.id}`,
    });

    materializeWakeups.ensurePendingQueued.mockClear();
    await expect(
      service.sweepIngress("after-wrap", INGRESS_RECOVERY_NOW),
    ).resolves.toEqual({ examined: 50, requeued: 0, failed: 50 });
    expect(materializeWakeups.ensurePendingQueued).toHaveBeenCalledWith({
      ingressId: rows[0]?.id,
      correlationId: `after-wrap:${rows[0]?.id}`,
    });
  });
});

const CONVERSATION_CREATED_AT = new Date("2026-07-24T00:00:00.000Z");
/** Exactly one reminder spacing of silence: the first rung is due, not the second. */
const ONE_DAY_LATER = new Date("2026-07-25T00:00:00.000Z");
/** Exactly the expiry threshold of silence. */
const THREE_DAYS_LATER = new Date("2026-07-27T00:00:00.000Z");
const INGRESS_RECOVERY_NOW = new Date("2026-07-25T00:10:00.000Z");
const INGRESS_RECOVERY_CUTOFF = new Date("2026-07-25T00:05:00.000Z");

function pendingIngress(ordinal: number) {
  return {
    id: `00000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`,
    processingStatus: "pending" as const,
    createdAt: new Date(INGRESS_RECOVERY_CUTOFF.getTime() - 60_000 + ordinal),
  };
}

function openConversation() {
  return {
    _id: conversationId,
    campaignId,
    respondentParticipantId: participantId,
    phoneAtLaunch: "+306900000001",
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
    findById: ReturnType<typeof vi.fn>;
    markReminded: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    appendMessage: ReturnType<typeof vi.fn>;
  };
  repository: {
    findCampaignById: ReturnType<typeof vi.fn>;
    findCampaignByIdForShare: ReturnType<typeof vi.fn>;
    insertOutboxIfAbsent: ReturnType<typeof vi.fn>;
    insertOutboxLogIfAbsent: ReturnType<typeof vi.fn>;
    cancelQueuedOutboxForConversation: ReturnType<typeof vi.fn>;
    lockConversation: ReturnType<typeof vi.fn>;
    listPendingIngressOlderThan: ReturnType<typeof vi.fn>;
    lockInboundPhone: ReturnType<typeof vi.fn>;
    hasInboundBeyondSnapshot: ReturnType<typeof vi.fn>;
  };
  participants: {
    findById: ReturnType<typeof vi.fn>;
  };
  materializeWakeups: {
    ensurePendingQueued: ReturnType<typeof vi.fn>;
  };
  checkpoints: {
    lockPendingIngress: ReturnType<typeof vi.fn>;
    savePendingIngress: ReturnType<typeof vi.fn>;
  };
  auditAppend: ReturnType<typeof vi.fn>;
} {
  const conversations = {
    findById: vi.fn(),
    markReminded: vi.fn().mockResolvedValue({ changed: true }),
    close: vi.fn(),
    appendMessage: vi
      .fn()
      .mockResolvedValue({ appended: true, message: {}, conversation: {} }),
  };
  const repository = {
    findCampaignById: vi.fn(),
    findCampaignByIdForShare: vi.fn(),
    insertOutboxIfAbsent: vi.fn(),
    insertOutboxLogIfAbsent: vi.fn().mockResolvedValue({
      row: { id: "log-1" },
      inserted: true,
    }),
    cancelQueuedOutboxForConversation: vi.fn().mockResolvedValue(0),
    lockConversation: vi.fn().mockResolvedValue(undefined),
    listPendingIngressOlderThan: vi.fn().mockResolvedValue([]),
    lockInboundPhone: vi.fn().mockResolvedValue(undefined),
    hasInboundBeyondSnapshot: vi.fn().mockResolvedValue(false),
  };
  const participants = {
    findById: vi.fn().mockResolvedValue({
      id: participantId,
      preferredName: "Roula",
      emailNormalized: "roula@example.com",
      postEventFeedbackWhatsappOptIn: true,
    }),
  };
  const materializeWakeups = {
    ensurePendingQueued: vi
      .fn()
      .mockResolvedValue(`feedback-materialize-v1-${ingressId}`),
  };
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
  const checkpoints = pendingIngressCheckpointDouble();

  return {
    service: new PostEventFeedbackSweepService(
      materializeWakeups as unknown as FeedbackMaterializeWakeupService,
      config as unknown as ConfigService<Environment, true>,
      database as unknown as DatabaseService,
      checkpoints as unknown as FeedbackMaintenanceCheckpointRepository,
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
      noopSummaries(),
    ),
    conversations,
    repository,
    participants,
    materializeWakeups,
    checkpoints,
    auditAppend,
  };
}

function pendingIngressCheckpointDouble(
  initial?: FeedbackPendingIngressRecoveryCursor,
): {
  readonly lockPendingIngress: ReturnType<typeof vi.fn>;
  readonly savePendingIngress: ReturnType<typeof vi.fn>;
} {
  let cursor = initial;
  return {
    lockPendingIngress: vi.fn().mockImplementation(async () => cursor),
    savePendingIngress: vi
      .fn()
      .mockImplementation(
        async (
          _transaction: unknown,
          next: FeedbackPendingIngressRecoveryCursor | undefined,
        ) => {
          cursor = next;
        },
      ),
  };
}
