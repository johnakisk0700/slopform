import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Queue } from "bullmq";

import type { Environment } from "../../../infrastructure/config/environment.js";
import { AuditRepository } from "../../../infrastructure/audit/audit.repository.js";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { FeedbackCampaignRepository } from "../campaign/campaign.repository.js";
import {
  FEEDBACK_SWEEP_BATCH_SIZE,
  FeedbackIngressRepository,
} from "../ingress/ingress.repository.js";
import { FeedbackOutboxRepository } from "../outbox/outbox.repository.js";
import { FEEDBACK_INGRESS_QUEUE } from "../../../infrastructure/queue/queue.constants.js";
import { FeedbackConversationRepository } from "../post-event-feedback-conversation.repository.js";
import type { FeedbackConversationDocument } from "../post-event-feedback-conversation.document.js";
import { ParticipantsRepository } from "../../participants/participants.repository.js";
import { latestParticipantMessage } from "../conversation-reader.js";
import { FeedbackOutboundTranscriptService } from "../outbox/outbound-transcript.service.js";
import {
  createFeedbackReminderDedupeKey,
  renderPostEventFeedbackCopy,
  resolveCampaignCopy,
  type PostEventFeedbackQuestionSetCopy,
} from "../question-set.js";
import {
  createFeedbackMaterializeJobId,
  FEEDBACK_JOB_NAMES,
  FEEDBACK_JOB_SCHEMA_VERSION,
  feedbackMaterializeJobDataSchema,
  type FeedbackJobData,
  type FeedbackJobName,
} from "../jobs.schemas.js";

export type FeedbackReminderSweepResult = {
  readonly examined: number;
  readonly reminded: number;
  readonly skipped: number;
};

export type FeedbackExpirySweepResult = {
  readonly examined: number;
  readonly expired: number;
  readonly skipped: number;
};

export type FeedbackIngressSweepResult = {
  readonly examined: number;
  readonly requeued: number;
  readonly failed: number;
};

/**
 * Bounded, idempotent reminder / expiry / ingress-recovery sweeps (WP7). Each
 * item reloads authoritative state before acting; nothing claims exactly-once.
 */
@Injectable()
export class PostEventFeedbackSweepService {
  private readonly logger = new Logger(PostEventFeedbackSweepService.name);

  constructor(
    // Recovery re-enqueues materialization, which lives on the ingress queue.
    // The sweep jobs that call this service are themselves scheduled onto
    // FEEDBACK_QUEUE by the sweep scheduler; only the produced job moves.
    @InjectQueue(FEEDBACK_INGRESS_QUEUE)
    private readonly queue: Queue<FeedbackJobData, void, FeedbackJobName>,
    private readonly config: ConfigService<Environment, true>,
    private readonly database: DatabaseService,
    private readonly campaigns: FeedbackCampaignRepository,
    private readonly ingress: FeedbackIngressRepository,
    private readonly outbox: FeedbackOutboxRepository,
    private readonly conversations: FeedbackConversationRepository,
    private readonly participants: ParticipantsRepository,
    private readonly audit: AuditRepository,
    private readonly outboundTranscript: FeedbackOutboundTranscriptService,
  ) {}

  async sweepReminders(
    correlationId: string,
    now = new Date(),
  ): Promise<FeedbackReminderSweepResult> {
    const reminderHours = this.config.get("FEEDBACK_REMINDER_AFTER_HOURS", {
      infer: true,
    });
    const maxReminders = this.config.get("FEEDBACK_MAX_REMINDERS", {
      infer: true,
    });
    // The first rung is the loosest threshold, so it selects every conversation
    // any rung could be due for. `remindOne` picks the rung.
    const olderThan = new Date(now.getTime() - reminderHours * 3_600_000);
    const candidates = await this.conversations.listOpenDueForReminder({
      olderThan,
      maxReminders,
      limit: FEEDBACK_SWEEP_BATCH_SIZE,
    });

    let reminded = 0;
    let skipped = 0;
    for (const candidate of candidates) {
      const applied = await this.remindOne(candidate, correlationId, now, {
        reminderHours,
        maxReminders,
      });
      if (applied) {
        reminded += 1;
      } else {
        skipped += 1;
      }
    }

    this.logger.log({
      event: "feedback.sweep.reminders",
      correlationId,
      examined: candidates.length,
      reminded,
      skipped,
    });

    return { examined: candidates.length, reminded, skipped };
  }

  async sweepExpiry(
    correlationId: string,
    now = new Date(),
  ): Promise<FeedbackExpirySweepResult> {
    const expireHours = this.config.get("FEEDBACK_EXPIRE_AFTER_HOURS", {
      infer: true,
    });
    const olderThan = new Date(now.getTime() - expireHours * 3_600_000);
    const candidates = await this.conversations.listOpenDueForExpiry({
      olderThan,
      limit: FEEDBACK_SWEEP_BATCH_SIZE,
    });

    let expired = 0;
    let skipped = 0;
    for (const candidate of candidates) {
      const applied = await this.expireOne(
        candidate,
        correlationId,
        now,
        expireHours,
      );
      if (applied) {
        expired += 1;
      } else {
        skipped += 1;
      }
    }

    this.logger.log({
      event: "feedback.sweep.expiry",
      correlationId,
      examined: candidates.length,
      expired,
      skipped,
    });

    return { examined: candidates.length, expired, skipped };
  }

  /**
   * Closes WP4's documented gap: `pending` ingress rows whose materialize
   * enqueue was lost are re-enqueued under the stable job id.
   */
  async sweepIngress(
    correlationId: string,
    now = new Date(),
  ): Promise<FeedbackIngressSweepResult> {
    const minutes = this.config.get(
      "FEEDBACK_INGRESS_PENDING_RECOVERY_MINUTES",
      {
        infer: true,
      },
    );
    const olderThan = new Date(now.getTime() - minutes * 60_000);
    const rows = await this.ingress.listPendingIngressOlderThan(
      olderThan,
      FEEDBACK_SWEEP_BATCH_SIZE,
    );

    let requeued = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        const data = feedbackMaterializeJobDataSchema.parse({
          schemaVersion: FEEDBACK_JOB_SCHEMA_VERSION,
          ingressId: row.id,
          correlationId: `${correlationId}:${row.id}`,
        });
        await this.queue.add(FEEDBACK_JOB_NAMES.materializeV1, data, {
          jobId: createFeedbackMaterializeJobId(row.id),
          attempts: 5,
          backoff: { type: "exponential", delay: 1_000 },
          removeOnComplete: 1_000,
          removeOnFail: 5_000,
          stackTraceLimit: 10,
        });
        requeued += 1;
      } catch (error) {
        failed += 1;
        this.logger.error({
          event: "feedback.sweep.ingress_requeue_failed",
          correlationId,
          ingressId: row.id,
          error: { name: error instanceof Error ? error.name : "Error" },
        });
      }
    }

    this.logger.log({
      event: "feedback.sweep.ingress",
      correlationId,
      examined: rows.length,
      requeued,
      failed,
    });

    return { examined: rows.length, requeued, failed };
  }

  private async remindOne(
    candidate: FeedbackConversationDocument,
    correlationId: string,
    now: Date,
    policy: { readonly reminderHours: number; readonly maxReminders: number },
  ): Promise<boolean> {
    const conversation = await this.conversations.findById(candidate._id);
    if (!conversation) {
      return false;
    }
    if (
      conversation.lifecycle.state !== "open" ||
      conversation.control.mode !== "bot"
    ) {
      return false;
    }

    // A flagged conversation is waiting for a person, and an automated «πες μας
    // και για τα υπόλοιπα» is the worst thing that can arrive in it. Somebody
    // who disclosed self-harm, or who asked for a human and was promised one,
    // must not be chased about the dinner a day later. Expiry deliberately does
    // not get the same guard: it sends nothing and releases the phone.
    if (conversation.needsAttention) {
      return false;
    }

    // Which rung this conversation is on, and whether it has been silent long
    // enough to earn it. Nudge N is due after N spacings of silence, so the
    // ladder needs no separate per-rung timestamps.
    const ordinal = conversation.reminderCount + 1;
    if (ordinal > policy.maxReminders) {
      return false;
    }
    if (
      silenceMs(conversation, now) <
      ordinal * policy.reminderHours * 3_600_000
    ) {
      return false;
    }

    const campaign = await this.campaigns.findCampaignById(
      conversation.campaignId,
    );
    if (campaign?.status !== "launched") {
      return false;
    }

    const participant = await this.participants.findById(
      conversation.respondentParticipantId,
    );
    if (!participant?.postEventFeedbackWhatsappOptIn) {
      return false;
    }

    const copy = resolveCampaignCopy(campaign.questions);
    const displayName =
      participant.preferredName?.trim() || participant.emailNormalized;

    const reminder = await this.database.transaction(async (transaction) => {
      const enqueued = await this.outbox.insertOutboxIfAbsent(transaction, {
        conversationId: conversation._id,
        campaignId: conversation.campaignId,
        kind: "reminder",
        body: renderReminderBody(conversation, copy, displayName),
        dedupeKey: createFeedbackReminderDedupeKey(conversation._id, ordinal),
      });
      if (enqueued.inserted) {
        await this.audit.append(transaction, {
          actorType: "system",
          actorId: "feedback_sweep",
          action: "feedback_conversation.reminded",
          entityType: "feedback_conversation",
          entityId: conversation._id,
          requestId: correlationId,
          context: {
            campaignId: conversation.campaignId,
            outboxId: enqueued.row.id,
            ordinal,
          },
        });
      }
      return enqueued;
    });

    // Before `markReminded`, and whether or not this sweep inserted the row: a
    // crash between the committed reminder and the append leaves the counter
    // where it was, so the next sweep re-selects the conversation, recomputes
    // the same ordinal and repairs the transcript through the same idempotent
    // `outboxId`. The dedupe key stops it being sent twice.
    await this.outboundTranscript.record(reminder.row, now, correlationId);

    await this.conversations.markReminded({
      conversationId: conversation._id,
      at: now,
      expectedCount: conversation.reminderCount,
    });
    return reminder.inserted;
  }

  private async expireOne(
    candidate: FeedbackConversationDocument,
    correlationId: string,
    now: Date,
    expireHours: number,
  ): Promise<boolean> {
    const conversation = await this.conversations.findById(candidate._id);
    if (!conversation) {
      return false;
    }
    if (
      conversation.lifecycle.state !== "open" ||
      conversation.control.mode !== "bot"
    ) {
      return false;
    }

    // Silence, not age. Somebody who opened WhatsApp on day three and started
    // answering is mid conversation; closing them because the campaign is old
    // shut the door on the rest of what they had to say.
    if (silenceMs(conversation, now) < expireHours * 3_600_000) {
      return false;
    }

    const campaign = await this.campaigns.findCampaignById(
      conversation.campaignId,
    );
    if (!campaign || campaign.status === "closed") {
      return false;
    }

    // Deliberately no opt-in check. Expiry sends nothing — it closes the
    // conversation and cancels whatever was queued — so withholding it from a
    // participant who opted out protects nobody and costs a great deal: the row
    // stays open forever, holds the partial unique index on `phoneAtLaunch`, and
    // the next campaign's `createFromLaunch` throws a phone conflict on that
    // number. An opt-out is a reason to stop messaging somebody, never a reason
    // to leave their conversation open.
    const closed = await this.conversations.close({
      conversationId: conversation._id,
      reason: "expired",
      at: now,
    });
    if (!closed.changed) {
      return false;
    }

    await this.database.transaction(async (transaction) => {
      const cancelledOutboxCount =
        await this.outbox.cancelQueuedOutboxForConversation(
          transaction,
          conversation._id,
        );
      await this.audit.append(transaction, {
        actorType: "system",
        actorId: "feedback_sweep",
        action: "feedback_conversation.expired",
        entityType: "feedback_conversation",
        entityId: conversation._id,
        requestId: correlationId,
        context: {
          campaignId: conversation.campaignId,
          cancelledOutboxCount,
        },
      });
    });

    return true;
  }
}

/**
 * How long the participant has been silent.
 *
 * Measured from the last thing *they* said, falling back to the launch when
 * they never said anything — our own reminders deliberately do not reset it, or
 * nudging somebody would postpone their own expiry indefinitely.
 */
function silenceMs(
  conversation: FeedbackConversationDocument,
  now: Date,
): number {
  const spokeAt = latestParticipantMessage(conversation)?.at;
  return now.getTime() - (spokeAt ?? conversation.createdAt).getTime();
}

/**
 * What the nudge actually says.
 *
 * Somebody who has answered nothing gets the generic invitation. Somebody who
 * started and stopped gets the question they stopped at, because the generic
 * copy — «θα χαρούμε να μάθουμε πώς σου φάνηκε η βραδιά» — reads as "we lost
 * what you sent" to a person who answered two questions yesterday. That group
 * is exactly the one the ladder was built to reach, so nudging them with copy
 * written for a stranger would undo the point of reaching them.
 *
 * The question comes from `goal.prompt`, the campaign's own snapshot, so a
 * conversation is never nudged with wording its campaign did not launch with.
 */
function renderReminderBody(
  conversation: FeedbackConversationDocument,
  copy: PostEventFeedbackQuestionSetCopy,
  displayName: string,
): string {
  const openGoal = conversation.goals.find(
    (goal) => goal.status === "pending" || goal.status === "asked",
  );
  const hasAnswered = conversation.goals.some(
    (goal) => goal.status === "answered",
  );
  const followUp = copy.reminder_followup;

  if (!hasAnswered || !openGoal || !followUp) {
    return renderPostEventFeedbackCopy(copy.reminder, displayName);
  }
  return renderPostEventFeedbackCopy(followUp, displayName).replaceAll(
    "{question}",
    openGoal.prompt,
  );
}
