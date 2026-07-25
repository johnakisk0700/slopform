import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Queue } from "bullmq";

import type { Environment } from "../../infrastructure/config/environment.js";
import { AuditRepository } from "../../infrastructure/audit/audit.repository.js";
import { DatabaseService } from "../../infrastructure/database/database.service.js";
import { FEEDBACK_QUEUE } from "../../infrastructure/queue/queue.constants.js";
import { FeedbackConversationRepository } from "../conversations/feedback-conversation.repository.js";
import type { FeedbackConversationDocument } from "../conversations/feedback-conversation.schemas.js";
import { ParticipantsRepository } from "../participants/participants.repository.js";
import {
  buildPostEventFeedbackQuestionLaunchSnapshot,
  createFeedbackReminderDedupeKey,
  renderPostEventFeedbackCopy,
  type PostEventFeedbackQuestionSetCopy,
} from "./post-event-feedback-question-set.js";
import {
  createFeedbackMaterializeJobId,
  FEEDBACK_JOB_NAMES,
  FEEDBACK_JOB_SCHEMA_VERSION,
  feedbackMaterializeJobDataSchema,
  type FeedbackJobData,
  type FeedbackJobName,
} from "./post-event-feedback.schemas.js";
import {
  FEEDBACK_SWEEP_BATCH_SIZE,
  PostEventFeedbackRepository,
} from "./post-event-feedback.repository.js";

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
    @InjectQueue(FEEDBACK_QUEUE)
    private readonly queue: Queue<FeedbackJobData, void, FeedbackJobName>,
    private readonly config: ConfigService<Environment, true>,
    private readonly database: DatabaseService,
    private readonly repository: PostEventFeedbackRepository,
    private readonly conversations: FeedbackConversationRepository,
    private readonly participants: ParticipantsRepository,
    private readonly audit: AuditRepository,
  ) {}

  async sweepReminders(
    correlationId: string,
    now = new Date(),
  ): Promise<FeedbackReminderSweepResult> {
    const hours = this.config.get("FEEDBACK_REMINDER_AFTER_HOURS", {
      infer: true,
    });
    const olderThan = new Date(now.getTime() - hours * 60 * 60_000);
    const candidates = await this.conversations.listOpenDueForReminder({
      olderThan,
      limit: FEEDBACK_SWEEP_BATCH_SIZE,
    });

    let reminded = 0;
    let skipped = 0;
    for (const candidate of candidates) {
      const applied = await this.remindOne(candidate, correlationId, now);
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
    const hours = this.config.get("FEEDBACK_EXPIRE_AFTER_HOURS", {
      infer: true,
    });
    const olderThan = new Date(now.getTime() - hours * 60 * 60_000);
    const candidates = await this.conversations.listOpenDueForExpiry({
      olderThan,
      limit: FEEDBACK_SWEEP_BATCH_SIZE,
    });

    let expired = 0;
    let skipped = 0;
    for (const candidate of candidates) {
      const applied = await this.expireOne(candidate, correlationId, now);
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
    const rows = await this.repository.listPendingIngressOlderThan(
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
  ): Promise<boolean> {
    const conversation = await this.conversations.findById(candidate._id);
    if (!conversation) {
      return false;
    }
    if (
      conversation.lifecycle.state !== "open" ||
      conversation.control.mode !== "bot" ||
      conversation.remindedAt !== null
    ) {
      return false;
    }
    if (hasParticipantReply(conversation)) {
      return false;
    }

    const campaign = await this.repository.findCampaignById(
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

    const copy = resolveCopy(campaign.questions);
    const displayName =
      participant.preferredName?.trim() || participant.emailNormalized;

    const inserted = await this.database.transaction(async (transaction) => {
      const reminder = await this.repository.insertOutboxIfAbsent(transaction, {
        conversationId: conversation._id,
        campaignId: conversation.campaignId,
        kind: "reminder",
        body: renderPostEventFeedbackCopy(copy.reminder, displayName),
        dedupeKey: createFeedbackReminderDedupeKey(conversation._id),
      });
      if (!reminder.inserted) {
        return false;
      }
      await this.audit.append(transaction, {
        actorType: "system",
        actorId: "feedback_sweep",
        action: "feedback_conversation.reminded",
        entityType: "feedback_conversation",
        entityId: conversation._id,
        requestId: correlationId,
        context: {
          campaignId: conversation.campaignId,
          outboxId: reminder.row.id,
        },
      });
      return true;
    });

    if (!inserted) {
      await this.conversations.markReminded({
        conversationId: conversation._id,
        at: now,
      });
      return false;
    }

    await this.conversations.markReminded({
      conversationId: conversation._id,
      at: now,
    });
    return true;
  }

  private async expireOne(
    candidate: FeedbackConversationDocument,
    correlationId: string,
    now: Date,
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

    const campaign = await this.repository.findCampaignById(
      conversation.campaignId,
    );
    if (!campaign || campaign.status === "closed") {
      return false;
    }

    const participant = await this.participants.findById(
      conversation.respondentParticipantId,
    );
    if (!participant?.postEventFeedbackWhatsappOptIn) {
      return false;
    }

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
        await this.repository.cancelQueuedOutboxForConversation(
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

function hasParticipantReply(
  conversation: FeedbackConversationDocument,
): boolean {
  return conversation.messages.some(
    (message) => message.actor === "participant",
  );
}

function resolveCopy(questions: unknown): PostEventFeedbackQuestionSetCopy {
  const record = questions as { copy?: PostEventFeedbackQuestionSetCopy };
  if (record.copy) {
    return record.copy;
  }
  return buildPostEventFeedbackQuestionLaunchSnapshot().copy;
}
