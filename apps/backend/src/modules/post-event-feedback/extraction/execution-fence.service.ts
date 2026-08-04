import { Injectable, Logger } from "@nestjs/common";
import type { AppTransaction } from "@join-the-six/database";

import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import {
  FeedbackConversationExecutionFenceRepository,
  type FeedbackConversationExecutionClaim,
} from "./execution-fence.repository.js";

export const FEEDBACK_CONVERSATION_EXECUTION_LEASE_MS = 7 * 60_000;
export const FEEDBACK_CONVERSATION_EXECUTION_HEARTBEAT_MS = 60_000;

export interface FeedbackConversationExecutionHeartbeat {
  /** Stops future renewal and waits for an already-running renewal. */
  stop(): Promise<void>;
}

@Injectable()
export class FeedbackConversationExecutionFence {
  private readonly logger = new Logger(FeedbackConversationExecutionFence.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly repository: FeedbackConversationExecutionFenceRepository,
  ) {}

  tryClaim(
    conversationId: string,
    workRevision: number,
  ): Promise<FeedbackConversationExecutionClaim | undefined> {
    return this.database.transaction((transaction) =>
      this.repository.tryClaim(transaction, {
        conversationId,
        workRevision,
        leaseMs: FEEDBACK_CONVERSATION_EXECUTION_LEASE_MS,
      }),
    );
  }

  renew(
    claim: FeedbackConversationExecutionClaim,
  ): Promise<FeedbackConversationExecutionClaim | undefined> {
    return this.database.transaction((transaction) =>
      this.repository.renew(
        transaction,
        claim,
        FEEDBACK_CONVERSATION_EXECUTION_LEASE_MS,
      ),
    );
  }

  renewWithin(
    transaction: AppTransaction,
    claim: FeedbackConversationExecutionClaim,
  ): Promise<FeedbackConversationExecutionClaim | undefined> {
    return this.repository.renew(
      transaction,
      claim,
      FEEDBACK_CONVERSATION_EXECUTION_LEASE_MS,
    );
  }

  release(claim: FeedbackConversationExecutionClaim): Promise<boolean> {
    return this.database.transaction((transaction) =>
      this.repository.release(transaction, claim),
    );
  }

  isCurrent(
    transaction: AppTransaction,
    claim: FeedbackConversationExecutionClaim,
  ): Promise<boolean> {
    return this.repository.isCurrent(transaction, claim);
  }

  assertCurrent(claim: FeedbackConversationExecutionClaim): Promise<boolean> {
    return this.database.transaction((transaction) =>
      this.repository.isCurrent(transaction, claim),
    );
  }

  /**
   * Keeps a paid conversation execution fenced while it waits for provider
   * capacity and while multi-batch classification runs.
   *
   * The heartbeat never grants ownership: every renewal is token/epoch/revision
   * conditional in PostgreSQL. A failed renewal is logged and later provider
   * entry/persistence still performs its own authoritative `isCurrent` check.
   */
  startHeartbeat(
    claim: FeedbackConversationExecutionClaim,
    intervalMs = FEEDBACK_CONVERSATION_EXECUTION_HEARTBEAT_MS,
  ): FeedbackConversationExecutionHeartbeat {
    if (!Number.isInteger(intervalMs) || intervalMs < 1) {
      throw new Error(
        "Feedback execution heartbeat must be a positive integer",
      );
    }

    let stopped = false;
    let renewing: Promise<void> = Promise.resolve();
    let renewalRunning = false;
    const renew = (): void => {
      if (stopped || renewalRunning) return;
      renewalRunning = true;
      renewing = this.renew(claim)
        .then((renewed) => {
          if (!renewed) {
            this.logger.warn({
              event: "feedback.execution_fence.heartbeat_lost",
              conversationId: claim.conversationId,
              revision: claim.workRevision,
              epoch: claim.epoch,
            });
          }
        })
        .catch((error: unknown) => {
          this.logger.error({
            event: "feedback.execution_fence.heartbeat_failed",
            conversationId: claim.conversationId,
            revision: claim.workRevision,
            epoch: claim.epoch,
            error: { name: error instanceof Error ? error.name : "Error" },
          });
        })
        .finally(() => {
          renewalRunning = false;
        });
    };
    const timer = setInterval(renew, intervalMs);
    timer.unref();

    return {
      stop: async () => {
        stopped = true;
        clearInterval(timer);
        await renewing;
      },
    };
  }
}
