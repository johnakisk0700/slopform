import { Injectable } from "@nestjs/common";

import type { AppTransaction, MessageOutboxRow } from "@slopform/database";

import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import {
  FeedbackLogger,
  FeedbackOperationLog,
} from "../feedback-operation-log.js";
import {
  FEEDBACK_OUTBOX_RECOVERY_MS,
  FeedbackOutboxRepository,
} from "./outbox.repository.js";
import { FeedbackDispatchSettlementService } from "./dispatch-settlement.service.js";

/**
 * Recovers expired `attempting` rows and leftover legacy `sending` rows before
 * a claim pass. Each row uses its own conversation-mutex transaction; a failed
 * park rolls that quarantine back. Never auto-resends.
 *
 * Caller: MessageOutboxDispatcherService.dispatchBatch.
 */
@Injectable()
export class FeedbackDispatchRecoveryService {
  private readonly logger = new FeedbackLogger(
    FeedbackDispatchRecoveryService.name,
  );

  constructor(
    private readonly database: DatabaseService,
    private readonly outbox: FeedbackOutboxRepository,
    private readonly settlement: FeedbackDispatchSettlementService,
  ) {}

  async quarantineExpired(now: Date): Promise<number> {
    const [expiredAttempts, staleLegacySending] = await Promise.all([
      this.outbox.findExpiredDispatchAttempts(now),
      this.outbox.findStaleLegacySending(now),
    ]);
    const parkByConversation = new Map<string, Promise<void>>();
    const parkOnce = (
      row: MessageOutboxRow,
      transaction: AppTransaction,
    ): Promise<void> => {
      const existing = parkByConversation.get(row.conversationId);
      if (existing) return existing;
      const pending = this.settlement.parkUncertainDelivery(row, transaction);
      parkByConversation.set(row.conversationId, pending);
      return pending;
    };
    const quarantined = await Promise.all([
      ...expiredAttempts.map(async (row) => {
        if (!row.claimToken) return false;
        try {
          return this.database
            .transaction(async (transaction) => {
              await this.outbox.lockConversation(
                transaction,
                row.conversationId,
              );
              const quarantined =
                await this.outbox.quarantineExpiredDispatchAttempt(
                  row.id,
                  row.claimToken!,
                  transaction,
                );
              if (!quarantined) return false;
              await parkOnce(quarantined, transaction);
              return true;
            })
            .catch((error: unknown) => {
              this.logQuarantineProjectionFailure(row, error);
              throw error;
            });
        } catch (error) {
          this.logQuarantineProjectionFailure(row, error);
          return false;
        }
      }),
      ...staleLegacySending.map(async (row) => {
        try {
          return this.database
            .transaction(async (transaction) => {
              await this.outbox.lockConversation(
                transaction,
                row.conversationId,
              );
              const quarantined =
                await this.outbox.quarantineStaleLegacySending(
                  row.id,
                  FEEDBACK_OUTBOX_RECOVERY_MS,
                  transaction,
                );
              if (!quarantined) return false;
              await parkOnce(quarantined, transaction);
              return true;
            })
            .catch((error: unknown) => {
              this.logQuarantineProjectionFailure(row, error);
              throw error;
            });
        } catch (error) {
          this.logQuarantineProjectionFailure(row, error);
          return false;
        }
      }),
    ]);
    return quarantined.filter(Boolean).length;
  }

  private logQuarantineProjectionFailure(
    row: MessageOutboxRow,
    error: unknown,
  ): void {
    this.logger.error({
      event: "feedback.outbox.quarantine_projection_failed",
      outboxId: row.id,
      conversationId: row.conversationId,
      error: { name: error instanceof Error ? error.name : "Error" },
    });
    const quarantine = new FeedbackOperationLog(this.logger, {
      operation: "dispatch_batch",
      correlationId: row.id,
      outboxId: row.id,
      conversationId: row.conversationId,
      campaignId: row.campaignId,
    });
    quarantine.stage("quarantine");
    quarantine.failed(error);
  }
}
