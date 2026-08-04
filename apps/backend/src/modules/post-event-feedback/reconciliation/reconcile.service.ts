import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import type { Environment } from "../../../infrastructure/config/environment.js";
import { FeedbackCampaignRepository } from "../campaign/campaign.repository.js";
import { FeedbackConversationExecutionFence } from "../extraction/execution-fence.service.js";
import type { FeedbackConversationExecutionClaim } from "../extraction/execution-fence.repository.js";
import {
  FeedbackConversationExecutionGuardError,
  PostEventFeedbackExtractor,
} from "../extraction/extract.service.js";
import {
  FEEDBACK_EXTRACT_QUIET_WINDOW_MS,
  FEEDBACK_EXTRACTION_PARK_MAX_MS,
  FEEDBACK_EXTRACTION_PARK_RETRY_MS,
  type FeedbackReconcileConversationJobData,
} from "../jobs.schemas.js";
import { FeedbackConversationRepository } from "../post-event-feedback-conversation.repository.js";
import { ParticipantsRepository } from "../../participants/participants.repository.js";
import { PostEventFeedbackSweepService } from "../sweeps/sweep.service.js";
import {
  deriveFeedbackConversationReconciliationPlan,
  type FeedbackConversationReconciliationPlan,
} from "./planner.js";
import { FeedbackConversationWakeupService } from "./wakeup.service.js";

export type FeedbackConversationReconcileOutcome =
  | "conversation_missing"
  | "claim_busy"
  | "stale_revision"
  | "settled"
  | "superseded";

@Injectable()
export class FeedbackConversationReconcileService {
  private readonly logger = new Logger(
    FeedbackConversationReconcileService.name,
  );

  constructor(
    private readonly config: ConfigService<Environment, true>,
    private readonly campaigns: FeedbackCampaignRepository,
    private readonly participants: ParticipantsRepository,
    private readonly conversations: FeedbackConversationRepository,
    private readonly executionFence: FeedbackConversationExecutionFence,
    private readonly extractor: PostEventFeedbackExtractor,
    private readonly sweeps: PostEventFeedbackSweepService,
    private readonly wakeups: FeedbackConversationWakeupService,
  ) {}

  async reconcile(
    input: FeedbackReconcileConversationJobData,
  ): Promise<FeedbackConversationReconcileOutcome> {
    const claim = await this.executionFence.tryClaim(
      input.conversationId,
      input.revision,
    );
    if (!claim) {
      return "claim_busy";
    }

    const heartbeat = this.executionFence.startHeartbeat(claim);
    try {
      const at = new Date();
      const begun = await this.conversations.beginWorkExecution({
        conversationId: input.conversationId,
        revision: input.revision,
        epoch: claim.epoch,
        at,
      });
      if (!begun.changed) {
        return "stale_revision";
      }

      const initialPlan = await this.plan(begun.conversation, at);
      try {
        await this.executeOne(initialPlan, input, claim, at);
      } catch (error) {
        if (
          error instanceof FeedbackConversationExecutionGuardError &&
          error.reason === "authoritative_state_changed"
        ) {
          // New testimony, takeover, pause or cancellation is ordinary
          // supersession. Do not settle from the obsolete snapshot: either its
          // transition owns a newer revision or the unchanged due intent stays
          // discoverable to maintenance. This execution consumes no retry.
          return "superseded";
        }
        throw error;
      }

      const current = await this.conversations.findById(input.conversationId);
      const settledAt = new Date();
      const nextActionAt = current
        ? nextActionAtForPlan(await this.plan(current, settledAt), settledAt)
        : null;
      const settled = await this.conversations.settleWorkExecution({
        conversationId: input.conversationId,
        revision: input.revision,
        epoch: claim.epoch,
        nextActionAt,
        at: settledAt,
      });
      if (!settled.changed) {
        return current ? "superseded" : "conversation_missing";
      }

      // A successor schedule receives a new Mongo revision during settlement,
      // hence a different job id while this job is still active. If Redis is
      // unavailable, maintenance rediscovers the same durable intent.
      try {
        await this.wakeups.ensureQueued({
          conversationId: input.conversationId,
          work: settled.work,
          correlationId: input.correlationId,
          now: settledAt,
        });
      } catch (error) {
        this.logger.error({
          event: "feedback.reconciliation.successor_enqueue_failed",
          conversationId: input.conversationId,
          revision: settled.work.revision,
          error: { name: error instanceof Error ? error.name : "Error" },
        });
      }
      return "settled";
    } finally {
      try {
        await heartbeat.stop();
      } finally {
        await this.executionFence.release(claim);
      }
    }
  }

  private async plan(
    conversation: Parameters<
      typeof deriveFeedbackConversationReconciliationPlan
    >[0]["conversation"],
    now: Date,
  ): Promise<FeedbackConversationReconciliationPlan> {
    const [campaign, participant] = await Promise.all([
      this.campaigns.findCampaignById(conversation.campaignId),
      this.participants.findById(conversation.respondentParticipantId),
    ]);
    return deriveFeedbackConversationReconciliationPlan({
      conversation,
      campaignStatus:
        campaign?.status === "launched" ||
        campaign?.status === "paused" ||
        campaign?.status === "closed"
          ? campaign.status
          : null,
      consentGranted: participant?.postEventFeedbackWhatsappOptIn === true,
      now,
      policy: {
        quietWindowMs: FEEDBACK_EXTRACT_QUIET_WINDOW_MS,
        reminderIntervalMs:
          this.config.get("FEEDBACK_REMINDER_AFTER_HOURS", { infer: true }) *
          3_600_000,
        expireAfterMs:
          this.config.get("FEEDBACK_EXPIRE_AFTER_HOURS", { infer: true }) *
          3_600_000,
        maxReminders: this.config.get("FEEDBACK_MAX_REMINDERS", {
          infer: true,
        }),
        parkRetryMs: FEEDBACK_EXTRACTION_PARK_RETRY_MS,
        parkMaxMs: FEEDBACK_EXTRACTION_PARK_MAX_MS,
      },
    });
  }

  private async executeOne(
    plan: FeedbackConversationReconciliationPlan,
    input: FeedbackReconcileConversationJobData,
    claim: FeedbackConversationExecutionClaim,
    now: Date,
  ): Promise<void> {
    if (plan.kind === "extract" || plan.kind === "retry_parked") {
      await this.extractor.extract({
        conversationId: input.conversationId,
        correlationId: input.correlationId,
        executionClaim: claim,
      });
      return;
    }
    if (plan.kind === "remind") {
      await this.sweeps.remindConversation({
        conversationId: input.conversationId,
        ordinal: plan.ordinal,
        correlationId: input.correlationId,
        now,
      });
      return;
    }
    if (plan.kind === "expire") {
      await this.sweeps.expireConversation({
        conversationId: input.conversationId,
        correlationId: input.correlationId,
        now,
      });
    }
  }
}

function nextActionAtForPlan(
  plan: FeedbackConversationReconciliationPlan,
  now: Date,
): Date | null {
  if (plan.kind === "idle") return null;
  if (plan.kind === "wait") return plan.until;
  return now;
}
