import { Injectable } from "@nestjs/common";

import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { FeedbackConversationRepository } from "../post-event-feedback-conversation.repository.js";
import { FeedbackDispatchAttemptService } from "./dispatch-attempt.service.js";
import { FeedbackDispatchRecoveryService } from "./dispatch-recovery.service.js";
import type { FeedbackOutboxDispatchBatchResult } from "./dispatcher.types.js";
import { FeedbackOutboxRepository } from "./outbox.repository.js";

/**
 * One claim-and-send wave within a BullMQ outbox poll.
 *
 * PostgreSQL owns due work, claims and recovery;
 * Redis only grants deployment-wide provider start slots. This service
 * quarantines expired attempts, claims a bounded FIFO batch, then runs each
 * conversation on its own send lane. Claim commits before preparation, pacing
 * or transport.
 *
 * Caller: FeedbackOutboxDispatchProcessor (and deterministic scenario harnesses).
 */
@Injectable()
export class MessageOutboxDispatcherService {
  constructor(
    private readonly database: DatabaseService,
    private readonly outbox: FeedbackOutboxRepository,
    private readonly conversations: FeedbackConversationRepository,
    private readonly recovery: FeedbackDispatchRecoveryService,
    private readonly attempt: FeedbackDispatchAttemptService,
  ) {}

  /**
   * Processes one bounded claim batch. Per-row failures are isolated so one bad
   * conversation cannot strand every later row leased by this replica.
   */
  async dispatchBatch(
    now = new Date(),
  ): Promise<FeedbackOutboxDispatchBatchResult> {
    const quarantinedCount = await this.recovery.quarantineExpired(now);
    const terminalCandidates =
      await this.outbox.listTerminalDispatchCandidates();
    const terminalOutboxIds =
      await this.conversations.listCurrentTerminalOutboxIds(terminalCandidates);
    const claims = await this.database.transaction((transaction) =>
      this.outbox.claimDispatchBatch(
        transaction,
        now,
        undefined,
        undefined,
        terminalOutboxIds,
      ),
    );
    // The claim query returns at most one row per conversation, already in FIFO order.
    const items = await Promise.all(
      claims.map((claim) => this.attempt.dispatchClaimSafely(claim)),
    );

    return { claimedCount: claims.length, quarantinedCount, items };
  }
}
