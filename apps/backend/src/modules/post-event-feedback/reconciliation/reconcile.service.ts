import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { AppTransaction } from "@slopform/database";

import type { Environment } from "../../../infrastructure/config/environment.js";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { FeedbackCampaignRepository } from "../campaign/campaign.repository.js";
import {
  FEEDBACK_CONVERSATION_EXECUTION_LEASE_MS,
  FeedbackConversationExecutionFence,
} from "../extraction/execution-fence.service.js";
import {
  FeedbackConversationExecutionFenceRepository,
  type FeedbackConversationExecutionClaim,
} from "../extraction/execution-fence.repository.js";
import {
  FeedbackConversationExecutionGuardError,
  PostEventFeedbackExtractor,
} from "../extraction/extract.service.js";
import {
  FeedbackLogger,
  FeedbackOperationLog,
} from "../feedback-operation-log.js";
import {
  FEEDBACK_EXTRACT_QUIET_WINDOW_MS,
  FEEDBACK_EXTRACTION_PARK_MAX_MS,
  FEEDBACK_EXTRACTION_PARK_RETRY_MS,
  type FeedbackReconcileConversationJobData,
} from "../jobs.schemas.js";
import { FeedbackConversationRepository } from "../post-event-feedback-conversation.repository.js";
import { FeedbackOutboxRepository } from "../outbox/outbox.repository.js";
import { resolveFeedbackConversationWork } from "../post-event-feedback-conversation.document.js";
import { ParticipantsRepository } from "../../participants/participants.repository.js";
import { FeedbackConversationInactivityService } from "./conversation-inactivity.service.js";
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
  private readonly logger = new FeedbackLogger(
    FeedbackConversationReconcileService.name,
  );

  constructor(
    private readonly config: ConfigService<Environment, true>,
    private readonly database: DatabaseService,
    private readonly campaigns: FeedbackCampaignRepository,
    private readonly participants: ParticipantsRepository,
    private readonly conversations: FeedbackConversationRepository,
    private readonly outbox: FeedbackOutboxRepository,
    private readonly executionClaims: FeedbackConversationExecutionFenceRepository,
    private readonly executionFence: FeedbackConversationExecutionFence,
    private readonly extractor: PostEventFeedbackExtractor,
    private readonly inactivity: FeedbackConversationInactivityService,
    private readonly wakeups: FeedbackConversationWakeupService,
  ) {}

  async reconcile(
    input: FeedbackReconcileConversationJobData,
  ): Promise<FeedbackConversationReconcileOutcome> {
    const operation = new FeedbackOperationLog(this.logger, {
      operation: "reconcile",
      correlationId: input.correlationId,
      conversationId: input.conversationId,
      workRevision: input.revision,
    });
    try {
      const outcome = await this.runReconcile(input, operation);
      operation.complete(outcome);
      return outcome;
    } catch (error) {
      operation.failed(error);
      throw error;
    }
  }

  private async runReconcile(
    input: FeedbackReconcileConversationJobData,
    operation: FeedbackOperationLog,
  ): Promise<FeedbackConversationReconcileOutcome> {
    const at = new Date();
    operation.stage("admit_claim");
    const admitted = await this.database.transaction(async (transaction) => {
      await this.outbox.lockConversation(transaction, input.conversationId);
      const conversation = await this.conversations.findByIdForUpdate(
        transaction,
        input.conversationId,
      );
      if (!conversation) {
        return { outcome: "conversation_missing" as const };
      }
      const work = resolveFeedbackConversationWork(conversation.work);
      if (
        work.revision !== input.revision ||
        work.nextActionAt === null ||
        work.nextActionAt > at
      ) {
        return { outcome: "stale_revision" as const };
      }
      const claim = await this.executionClaims.tryClaim(transaction, {
        conversationId: input.conversationId,
        workRevision: input.revision,
        leaseMs: FEEDBACK_CONVERSATION_EXECUTION_LEASE_MS,
      });
      if (!claim) {
        return { outcome: "claim_busy" as const };
      }
      return { outcome: "claimed" as const, claim, conversation };
    });

    if (admitted.outcome !== "claimed") {
      return admitted.outcome;
    }

    const claim = admitted.claim;
    operation.enrich({ executionEpoch: claim.epoch });
    const heartbeat = this.executionFence.startHeartbeat(claim);
    try {
      operation.stage("plan");
      const initialPlan = await this.plan(admitted.conversation, at);
      try {
        operation.stage("execute_action");
        await this.executeOne(initialPlan, input, claim, at);
      } catch (error) {
        if (
          error instanceof FeedbackConversationExecutionGuardError &&
          error.reason === "authoritative_state_changed"
        ) {
          return "superseded";
        }
        throw error;
      }

      const settledAt = new Date();
      operation.stage("settle_work");
      const settled = await this.database.transaction(async (transaction) => {
        await this.outbox.lockConversation(transaction, input.conversationId);
        if (!(await this.executionFence.isCurrent(transaction, claim))) {
          throw new FeedbackConversationExecutionGuardError(
            input.conversationId,
            "execution_claim_lost",
          );
        }
        const current = await this.conversations.findByIdForUpdate(
          transaction,
          input.conversationId,
        );
        if (!current) return undefined;
        const nextActionAt = nextActionAtForPlan(
          await this.plan(current, settledAt, transaction),
          settledAt,
        );
        return this.conversations.settleWorkExecution(transaction, {
          conversationId: input.conversationId,
          revision: input.revision,
          epoch: claim.epoch,
          nextActionAt,
          at: settledAt,
        });
      });
      if (!settled) return "conversation_missing";
      if (!settled.changed) {
        return "superseded";
      }

      operation.stage("enqueue_successor");
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
        const successor = new FeedbackOperationLog(this.logger, {
          operation: "reconcile",
          correlationId: input.correlationId,
          conversationId: input.conversationId,
          workRevision: settled.work.revision,
        });
        successor.stage("enqueue_successor");
        successor.failed(error);
      }
      return "settled";
    } catch (error) {
      operation.failed(error);
      throw error;
    } finally {
      try {
        await this.releaseClaim(claim, input, heartbeat);
      } catch (error) {
        // An earlier failure is already recorded; cleanup keeps its own record.
        operation.stage("cleanup");
        operation.failed(error);
        throw error;
      }
    }
  }

  private async releaseClaim(
    claim: FeedbackConversationExecutionClaim,
    input: FeedbackReconcileConversationJobData,
    heartbeat: { stop(): Promise<void> },
  ): Promise<void> {
    const stop = new FeedbackOperationLog(this.logger, {
      operation: "reconcile_cleanup",
      correlationId: input.correlationId,
      conversationId: input.conversationId,
      workRevision: input.revision,
      executionEpoch: claim.epoch,
    });
    try {
      stop.stage("stop_heartbeat");
      await heartbeat.stop();
      stop.complete("stopped");
    } catch (error) {
      stop.failed(error);
      throw error;
    } finally {
      const release = new FeedbackOperationLog(this.logger, {
        operation: "reconcile_cleanup",
        correlationId: input.correlationId,
        conversationId: input.conversationId,
        workRevision: input.revision,
        executionEpoch: claim.epoch,
      });
      release.stage("release_claim");
      try {
        await this.executionFence.release(claim);
        release.complete("released");
      } catch (error) {
        release.failed(error);
        throw error;
      }
    }
  }

  private async plan(
    conversation: Parameters<
      typeof deriveFeedbackConversationReconciliationPlan
    >[0]["conversation"],
    now: Date,
    transaction?: AppTransaction,
  ): Promise<FeedbackConversationReconciliationPlan> {
    const [campaign, participant] = await Promise.all([
      this.campaigns.findCampaignById(conversation.campaignId, transaction),
      this.participants.findById(
        conversation.respondentParticipantId,
        transaction,
      ),
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
      await this.inactivity.remindConversation({
        conversationId: input.conversationId,
        ordinal: plan.ordinal,
        correlationId: input.correlationId,
        now,
      });
      return;
    }
    if (plan.kind === "expire") {
      await this.inactivity.expireConversation({
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
