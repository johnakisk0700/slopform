import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger } from "@nestjs/common";
import type { Queue } from "bullmq";

import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { FEEDBACK_CONVERSATION_QUEUE } from "../../../infrastructure/queue/queue.constants.js";
import {
  createFeedbackReconcileConversationJobId,
  FEEDBACK_JOB_NAMES,
  FEEDBACK_JOB_SCHEMA_VERSION_V2,
  feedbackReconcileConversationJobDataSchema,
  type FeedbackJobData,
  type FeedbackJobName,
} from "../jobs.schemas.js";
import type {
  FeedbackConversationDocument,
  FeedbackConversationWork,
} from "../post-event-feedback-conversation.document.js";
import { FeedbackConversationRepository } from "../post-event-feedback-conversation.repository.js";
import { FeedbackMaintenanceCheckpointRepository } from "../sweeps/maintenance-checkpoint.repository.js";
import { FEEDBACK_RECONCILIATION_INVARIANT_FAILURE_REASON } from "./reconcile-failure.js";

const LIVE_JOB_STATES = new Set([
  "active",
  "delayed",
  "prioritized",
  "waiting",
  "waiting-children",
]);

export const FEEDBACK_RECONCILIATION_RECOVERY_BATCH_SIZE = 100;
export const FEEDBACK_RECONCILIATION_RECOVERY_SCAN_LIMIT = 500;
export const FEEDBACK_RECONCILIATION_BOOTSTRAP_BATCH_SIZE = 100;
export const FEEDBACK_RECONCILIATION_HANDOFF_REPAIR_BATCH_SIZE = 100;

/**
 * Persists work before publishing its disposable BullMQ wake-up.
 *
 * MongoDB is the authority: a failed `add` leaves discoverable intent, while a
 * duplicate `add` collapses on the revision-derived id. Queue retention can
 * therefore affect observability, never whether the conversation still owes
 * work.
 */
@Injectable()
export class FeedbackConversationWakeupService {
  private readonly logger = new Logger(FeedbackConversationWakeupService.name);

  constructor(
    @InjectQueue(FEEDBACK_CONVERSATION_QUEUE)
    private readonly queue: Queue<FeedbackJobData, void, FeedbackJobName>,
    private readonly conversations: FeedbackConversationRepository,
    private readonly database: DatabaseService,
    private readonly checkpoints: FeedbackMaintenanceCheckpointRepository,
  ) {}

  async schedule(input: {
    readonly conversationId: string;
    readonly nextActionAt: Date;
    readonly correlationId: string;
    readonly at?: Date;
  }): Promise<string> {
    const at = input.at ?? new Date();
    const transition = await this.conversations.markWorkDue({
      conversationId: input.conversationId,
      nextActionAt: input.nextActionAt,
      at,
    });
    const jobId = await this.ensureQueued({
      conversationId: input.conversationId,
      work: transition.work,
      correlationId: input.correlationId,
      now: at,
    });
    if (!jobId) {
      throw new Error("Scheduled feedback work unexpectedly had no due time");
    }
    return jobId;
  }

  async ensureQueued(input: {
    readonly conversationId: string;
    readonly work: FeedbackConversationWork;
    readonly correlationId: string;
    readonly now?: Date;
  }): Promise<string | undefined> {
    if (!input.work.nextActionAt) {
      return undefined;
    }

    const jobId = createFeedbackReconcileConversationJobId(
      input.conversationId,
      input.work.revision,
    );
    const existing = await this.queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (LIVE_JOB_STATES.has(state)) {
        return jobId;
      }
      if (
        state === "failed" &&
        existing.failedReason ===
          FEEDBACK_RECONCILIATION_INVARIANT_FAILURE_REASON
      ) {
        return jobId;
      }
      try {
        await existing.remove();
      } catch {
        // A state transition won the race. The durable intent remains visible
        // and the next maintenance pass will make the same decision.
        return jobId;
      }
    }

    const data = feedbackReconcileConversationJobDataSchema.parse({
      schemaVersion: FEEDBACK_JOB_SCHEMA_VERSION_V2,
      conversationId: input.conversationId,
      revision: input.work.revision,
      correlationId: input.correlationId,
    });
    const now = input.now ?? new Date();
    await this.queue.add(FEEDBACK_JOB_NAMES.reconcileConversationV2, data, {
      jobId,
      delay: Math.max(0, input.work.nextActionAt.getTime() - now.getTime()),
      attempts: 5,
      backoff: { type: "exponential", delay: 1_000, jitter: 0.5 },
      removeOnComplete: true,
      removeOnFail: { age: 604_800, count: 5_000 },
      stackTraceLimit: 10,
    });
    return jobId;
  }

  async recoverDue(
    correlationId: string,
    now = new Date(),
    campaignId?: string,
  ): Promise<{ readonly examined: number; readonly queued: number }> {
    if (!campaignId) {
      try {
        const repaired = await this.conversations.repairLegacyAwaitingHuman({
          at: now,
          limit: FEEDBACK_RECONCILIATION_HANDOFF_REPAIR_BATCH_SIZE,
        });
        if (repaired > 0) {
          this.logger.log({
            event: "feedback.reconciliation.legacy_handoff_repaired",
            correlationId,
            repaired,
          });
        }
      } catch (error) {
        // The bridge is independent from native V2 recovery. A bad legacy page
        // must not hide current due work from this maintenance pass.
        this.logger.error({
          event: "feedback.reconciliation.legacy_handoff_repair_failed",
          correlationId,
          error: { name: error instanceof Error ? error.name : "Error" },
        });
      }
      try {
        const seeded = await this.conversations.seedMissingWork({
          dueAt: now,
          limit: FEEDBACK_RECONCILIATION_BOOTSTRAP_BATCH_SIZE,
        });
        if (seeded > 0) {
          this.logger.log({
            event: "feedback.reconciliation.legacy_work_seeded",
            correlationId,
            seeded,
          });
        }
      } catch (error) {
        // Compatibility bootstrap must not block recovery of conversations
        // that already speak the V2 durable-work contract.
        this.logger.error({
          event: "feedback.reconciliation.legacy_work_seed_failed",
          correlationId,
          error: { name: error instanceof Error ? error.name : "Error" },
        });
      }
    }
    const scanLimit = campaignId
      ? FEEDBACK_RECONCILIATION_RECOVERY_BATCH_SIZE
      : FEEDBACK_RECONCILIATION_RECOVERY_SCAN_LIMIT;
    let examined = 0;
    let queued = 0;

    while (examined < scanLimit) {
      const pageLimit = Math.min(
        FEEDBACK_RECONCILIATION_RECOVERY_BATCH_SIZE,
        scanLimit - examined,
      );
      const allocation = campaignId
        ? {
            conversations: await this.conversations.listDueWork({
              dueAt: now,
              limit: pageLimit,
              campaignId,
            }),
            reachedTail: true,
          }
        : await this.allocateGlobalRecoveryPage({
            dueAt: now,
            limit: pageLimit,
            wrapAtTail: examined === 0,
          });
      const { conversations } = allocation;
      if (conversations.length === 0) {
        break;
      }

      examined += conversations.length;
      queued += await this.publishRecoveryPage(
        conversations,
        correlationId,
        now,
      );
      if (campaignId || allocation.reachedTail) {
        break;
      }
    }
    return { examined, queued };
  }

  /**
   * Allocates one globally unique keyset page under a PostgreSQL row lock.
   * The MongoDB read is deliberately the only cross-store operation inside the
   * short transaction. The cursor advances before publication, so a worker
   * crash may defer this page until the finite wrap but can never pin the scan
   * or consume the Mongo-owned work revision.
   */
  private async allocateGlobalRecoveryPage(input: {
    readonly dueAt: Date;
    readonly limit: number;
    readonly wrapAtTail: boolean;
  }): Promise<{
    readonly conversations: FeedbackConversationDocument[];
    readonly reachedTail: boolean;
  }> {
    return this.database.transaction(async (transaction) => {
      const after = await this.checkpoints.lockConversationDue(transaction);
      let conversations = await this.conversations.listDueWork({
        dueAt: input.dueAt,
        limit: input.limit,
        ...(after ? { after } : {}),
      });

      if (conversations.length === 0 && after) {
        await this.checkpoints.saveConversationDue(transaction, undefined);
        if (!input.wrapAtTail) {
          return { conversations: [], reachedTail: true };
        }
        conversations = await this.conversations.listDueWork({
          dueAt: input.dueAt,
          limit: input.limit,
        });
      }

      if (conversations.length === 0) {
        return { conversations, reachedTail: true };
      }

      const last = conversations.at(-1);
      if (!last?.work?.nextActionAt) {
        throw new Error("Due-work recovery page ended without a dated cursor");
      }
      const reachedTail = conversations.length < input.limit;
      await this.checkpoints.saveConversationDue(
        transaction,
        reachedTail
          ? undefined
          : {
              nextActionAt: last.work.nextActionAt,
              conversationId: last._id,
            },
      );
      return { conversations, reachedTail };
    });
  }

  private async publishRecoveryPage(
    conversations: readonly FeedbackConversationDocument[],
    correlationId: string,
    now: Date,
  ): Promise<number> {
    let queued = 0;
    for (const conversation of conversations) {
      if (!conversation.work?.nextActionAt) {
        this.logger.error({
          event: "feedback.reconciliation.invalid_due_work",
          conversationId: conversation._id,
          correlationId,
        });
        continue;
      }
      try {
        const jobId = await this.ensureQueued({
          conversationId: conversation._id,
          work: conversation.work,
          correlationId: recoveryCorrelationId(correlationId, conversation._id),
          now,
        });
        if (jobId) queued += 1;
      } catch (error) {
        this.logger.error({
          event: "feedback.reconciliation.recovery_item_failed",
          conversationId: conversation._id,
          correlationId,
          error: { name: error instanceof Error ? error.name : "Error" },
        });
      }
    }
    return queued;
  }
}

function recoveryCorrelationId(
  correlationId: string,
  conversationId: string,
): string {
  return `${correlationId.slice(0, 80)}-${conversationId}`;
}
