import { Injectable } from "@nestjs/common";
import type {
  AppTransaction,
  ProviderMessageIngressRow,
} from "@slopform/database";

import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { FeedbackIngressRepository } from "./ingress.repository.js";
import { FeedbackOutboxRepository } from "../outbox/outbox.repository.js";

/**
 * One ingress-row replay: open a transaction, lock the row FOR UPDATE, no-op
 * unless it is still pending, optionally take the conversation advisory lock,
 * then run the caller's writes on that same tx. This is the deduplication/lock
 * invariant shared by every materialize route — not a generic transaction helper.
 */
@Injectable()
export class PendingFeedbackIngressService {
  constructor(
    private readonly database: DatabaseService,
    private readonly ingress: FeedbackIngressRepository,
    private readonly outbox: FeedbackOutboxRepository,
  ) {}

  /**
   * Serializes concurrent materialize executions on the ingress row and keeps
   * every side effect of one delivery in a single transaction. A replay that
   * finds a terminal row performs nothing and reports no work.
   *
   * Repositories in `work` must receive the supplied `transaction`. There is
   * no ambient context and no hidden repository transaction.
   */
  async applyPending<T>(
    ingressId: string,
    work: (
      transaction: AppTransaction,
      ingress: ProviderMessageIngressRow,
    ) => Promise<T>,
    conversationLockId?: string,
  ): Promise<T | undefined> {
    return this.database.transaction(async (transaction) => {
      const row = await this.ingress.findIngressByIdForUpdate(
        transaction,
        ingressId,
      );
      if (!row || row.processingStatus !== "pending") {
        return undefined;
      }
      if (conversationLockId) {
        await this.outbox.lockConversation(transaction, conversationLockId);
      }
      return work(transaction, row);
    });
  }
}
