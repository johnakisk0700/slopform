import { Injectable, Logger } from "@nestjs/common";
import type {
  AppTransaction,
  FeedbackCampaignRow,
} from "@join-the-six/database";

import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import {
  FeedbackCampaignRepository,
  type FeedbackCampaignResumeCandidate,
} from "./campaign.repository.js";
import { FeedbackConversationRepository } from "../post-event-feedback-conversation.repository.js";
import { FeedbackConversationWakeupService } from "../reconciliation/wakeup.service.js";
import { FeedbackMaintenanceCheckpointRepository } from "../sweeps/maintenance-checkpoint.repository.js";

export const FEEDBACK_CAMPAIGN_RESUME_RECOVERY_LIMIT = 100;
export const FEEDBACK_CAMPAIGN_RESUME_RECOVERY_BATCH_SIZE = 50;

export interface FeedbackCampaignResumeRepairResult {
  readonly examined: number;
  readonly applied: number;
  readonly conversationsMarked: number;
  readonly wakeupsPublished: number;
}

type AppliedResume = {
  readonly campaignId: string;
  readonly generation: number;
  readonly dueAt: Date;
  readonly conversationsMarked: number;
};

/**
 * Completes the PostgreSQL -> MongoDB half of campaign resume.
 *
 * PostgreSQL owns the durable generation and pins campaign lifecycle with a
 * row lock. MongoDB admits that generation idempotently on every open
 * aggregate, then PostgreSQL acknowledges it. A crash at either store boundary
 * therefore leaves either pending intent or already-applied Mongo generations
 * for the next pass; BullMQ publication remains disposable.
 */
@Injectable()
export class FeedbackCampaignResumeRepairService {
  private readonly logger = new Logger(
    FeedbackCampaignResumeRepairService.name,
  );

  constructor(
    private readonly database: DatabaseService,
    private readonly campaigns: FeedbackCampaignRepository,
    private readonly checkpoints: FeedbackMaintenanceCheckpointRepository,
    private readonly conversations: FeedbackConversationRepository,
    private readonly wakeups: FeedbackConversationWakeupService,
  ) {}

  async repairCampaign(
    campaignId: string,
    correlationId: string,
  ): Promise<FeedbackCampaignResumeRepairResult> {
    const applied = await this.database.transaction(async (transaction) => {
      const campaign = await this.campaigns.findPendingResumeIntentForUpdate(
        transaction,
        campaignId,
      );
      return campaign
        ? this.applyLockedResume(transaction, campaign)
        : undefined;
    });

    if (!applied) return emptyResult();
    const wakeupsPublished = await this.publishWakeups(applied, correlationId);
    return {
      examined: 1,
      applied: 1,
      conversationsMarked: applied.conversationsMarked,
      wakeupsPublished,
    };
  }

  /**
   * Bounded autonomous repair. PostgreSQL allocates keyset pages behind one
   * durable checkpoint and commits that cursor before any MongoDB work. Each
   * exact generation is then re-locked and applied independently, so a crash
   * or poisonous aggregate cannot retain the global prefix.
   */
  async recover(
    correlationId: string,
    limit = FEEDBACK_CAMPAIGN_RESUME_RECOVERY_LIMIT,
  ): Promise<FeedbackCampaignResumeRepairResult> {
    const boundedLimit = Math.min(
      Math.max(1, limit),
      FEEDBACK_CAMPAIGN_RESUME_RECOVERY_LIMIT,
    );
    let examined = 0;
    let appliedCount = 0;
    let conversationsMarked = 0;
    let wakeupsPublished = 0;
    const errors: unknown[] = [];

    while (examined < boundedLimit) {
      const pageLimit = Math.min(
        FEEDBACK_CAMPAIGN_RESUME_RECOVERY_BATCH_SIZE,
        boundedLimit - examined,
      );
      const allocation = await this.allocateRecoveryPage({
        limit: pageLimit,
        wrapAtTail: examined === 0,
      });
      if (allocation.candidates.length === 0) break;

      for (const candidate of allocation.candidates) {
        examined += 1;
        let applied: AppliedResume | undefined;
        try {
          applied = await this.database.transaction(async (transaction) => {
            const campaign =
              await this.campaigns.findPendingResumeCandidateForUpdate(
                transaction,
                {
                  campaignId: candidate.campaignId,
                  generation: candidate.generation,
                },
              );
            return campaign
              ? this.applyLockedResume(transaction, campaign)
              : undefined;
          });
        } catch (error) {
          errors.push(error);
          this.logger.error({
            event: "feedback.campaign_resume.repair_failed",
            correlationId,
            campaignId: candidate.campaignId,
            generation: candidate.generation,
            error: { name: error instanceof Error ? error.name : "Error" },
          });
          continue;
        }

        if (!applied) continue;
        appliedCount += 1;
        conversationsMarked += applied.conversationsMarked;
        wakeupsPublished += await this.publishWakeups(applied, correlationId);
      }

      if (allocation.reachedTail) break;
    }

    const result = {
      examined,
      applied: appliedCount,
      conversationsMarked,
      wakeupsPublished,
    };
    if (errors.length > 0) {
      throw new FeedbackCampaignResumeRecoveryError(result, errors);
    }
    return result;
  }

  /**
   * Allocates one page and advances the shared cursor in the same transaction.
   * The returned identifiers are only hints: processing re-locks and validates
   * the exact generation after this transaction has committed.
   */
  private async allocateRecoveryPage(input: {
    readonly limit: number;
    readonly wrapAtTail: boolean;
  }): Promise<{
    readonly candidates: FeedbackCampaignResumeCandidate[];
    readonly reachedTail: boolean;
  }> {
    return this.database.transaction(async (transaction) => {
      const after = await this.checkpoints.lockCampaignResume(transaction);
      let candidates = await this.campaigns.listPendingResumeCandidates(
        {
          ...(after ? { after } : {}),
          limit: input.limit,
        },
        transaction,
      );

      if (candidates.length === 0 && after) {
        await this.checkpoints.saveCampaignResume(transaction, undefined);
        if (!input.wrapAtTail) {
          return { candidates: [], reachedTail: true };
        }
        candidates = await this.campaigns.listPendingResumeCandidates(
          { limit: input.limit },
          transaction,
        );
      }

      if (candidates.length === 0) {
        return { candidates, reachedTail: true };
      }

      const last = candidates.at(-1);
      if (!last) {
        throw new Error("Campaign resume recovery page had no tail");
      }
      const reachedTail = candidates.length < input.limit;
      await this.checkpoints.saveCampaignResume(transaction, {
        dueAt: last.dueAt,
        campaignId: last.campaignId,
      });
      return { candidates, reachedTail };
    });
  }

  private async applyLockedResume(
    transaction: AppTransaction,
    campaign: FeedbackCampaignRow,
  ): Promise<AppliedResume> {
    if (
      !campaign.resumeDueAt ||
      campaign.resumeAppliedGeneration >= campaign.resumeGeneration
    ) {
      throw new Error("Locked campaign did not contain pending resume intent");
    }

    const conversationsMarked = await this.conversations.markCampaignWorkDue({
      campaignId: campaign.id,
      generation: campaign.resumeGeneration,
      nextActionAt: campaign.resumeDueAt,
      at: new Date(),
    });
    const acknowledged = await this.campaigns.acknowledgeResumeIntent(
      transaction,
      {
        campaignId: campaign.id,
        generation: campaign.resumeGeneration,
      },
    );
    if (!acknowledged) {
      throw new Error("Campaign resume intent changed while row-locked");
    }

    return {
      campaignId: campaign.id,
      generation: campaign.resumeGeneration,
      dueAt: campaign.resumeDueAt,
      conversationsMarked,
    };
  }

  private async publishWakeups(
    applied: AppliedResume,
    correlationId: string,
  ): Promise<number> {
    try {
      const recovered = await this.wakeups.recoverDue(
        `${correlationId.slice(0, 80)}-resume-${applied.generation}`,
        new Date(),
        applied.campaignId,
      );
      return recovered.queued;
    } catch (error) {
      // MongoDB remains authoritative after the acknowledgement. Losing this
      // disposable publication only delays work until conversation recovery.
      this.logger.error({
        event: "feedback.campaign_resume.wakeup_failed",
        correlationId,
        campaignId: applied.campaignId,
        generation: applied.generation,
        error: { name: error instanceof Error ? error.name : "Error" },
      });
      return 0;
    }
  }
}

export class FeedbackCampaignResumeRecoveryError extends AggregateError {
  constructor(
    readonly result: FeedbackCampaignResumeRepairResult,
    errors: readonly unknown[],
  ) {
    super(errors, "One or more campaign resume intents failed repair");
    this.name = FeedbackCampaignResumeRecoveryError.name;
  }
}

function emptyResult(): FeedbackCampaignResumeRepairResult {
  return {
    examined: 0,
    applied: 0,
    conversationsMarked: 0,
    wakeupsPublished: 0,
  };
}
