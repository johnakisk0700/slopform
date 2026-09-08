import { Injectable } from "@nestjs/common";

import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { FeedbackConversationRepository } from "../post-event-feedback-conversation.repository.js";
import { FeedbackDispatchAttemptService } from "./dispatch-attempt.service.js";
import { FeedbackDispatchRecoveryService } from "./dispatch-recovery.service.js";
import type {
  FeedbackOutboxDispatchBatchResult,
  FeedbackOutboxDispatchItemResult,
} from "./dispatcher.types.js";
import { FeedbackOutboxRepository } from "./outbox.repository.js";
import type { FeedbackOutboxClaimedRow } from "./outbox.types.js";

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
    // Different conversations use bounded parallel lanes. Claims for one
    // conversation are still serialized as a second line of defence around
    // the repository's cross-replica FIFO eligibility predicate.
    const resultsById = new Map<string, FeedbackOutboxDispatchItemResult>();
    await Promise.all(
      groupClaimsByConversation(claims).map(async (conversationClaims) => {
        for (const claim of conversationClaims) {
          resultsById.set(
            claim.id,
            await this.attempt.dispatchClaimSafely(claim),
          );
        }
      }),
    );
    const items = claims.map((claim) => {
      const result = resultsById.get(claim.id);
      if (!result) {
        throw new Error(`Feedback outbox claim ${claim.id} was not dispatched`);
      }
      return result;
    });

    return { claimedCount: claims.length, quarantinedCount, items };
  }
}

function groupClaimsByConversation(
  claims: readonly FeedbackOutboxClaimedRow[],
): FeedbackOutboxClaimedRow[][] {
  const groups = new Map<string, FeedbackOutboxClaimedRow[]>();
  for (const claim of claims) {
    const existing = groups.get(claim.conversationId);
    if (existing) {
      existing.push(claim);
    } else {
      groups.set(claim.conversationId, [claim]);
    }
  }
  for (const group of groups.values()) {
    group.sort(
      (left, right) =>
        left.createdAt.getTime() - right.createdAt.getTime() ||
        left.id.localeCompare(right.id),
    );
  }
  return [...groups.values()];
}
