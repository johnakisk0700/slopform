import { randomUUID } from "node:crypto";

import { Injectable } from "@nestjs/common";
import {
  feedbackConversationExecutions,
  type AppTransaction,
  type FeedbackConversationExecutionRow,
} from "@join-the-six/database";
import { and, eq, gt, sql } from "drizzle-orm";

import { currentDatabaseTime } from "../../../infrastructure/database/database-time.js";

export interface FeedbackConversationExecutionClaim {
  readonly conversationId: string;
  readonly workRevision: number;
  readonly epoch: number;
  readonly token: string;
  readonly leaseUntil: Date;
}

/** Read-model-safe subset of a currently live execution lease. */
export interface FeedbackConversationActiveExecutionLease {
  readonly claimExpiresAt: Date;
}

@Injectable()
export class FeedbackConversationExecutionFenceRepository {
  /**
   * Reads the live lease without selecting its fencing token or epoch.
   *
   * PostgreSQL's clock decides expiry, matching claim and renewal semantics;
   * application clock skew cannot make a dead execution look active.
   */
  async findActiveLease(
    transaction: AppTransaction,
    conversationId: string,
  ): Promise<FeedbackConversationActiveExecutionLease | undefined> {
    const [lease] = await transaction
      .select({
        claimExpiresAt: feedbackConversationExecutions.leaseUntil,
      })
      .from(feedbackConversationExecutions)
      .where(
        and(
          eq(feedbackConversationExecutions.conversationId, conversationId),
          gt(feedbackConversationExecutions.leaseUntil, sql`clock_timestamp()`),
        ),
      )
      .limit(1);
    if (!lease?.claimExpiresAt) {
      return undefined;
    }
    return {
      claimExpiresAt: lease.claimExpiresAt,
    };
  }

  async tryClaim(
    transaction: AppTransaction,
    input: {
      readonly conversationId: string;
      readonly workRevision: number;
      readonly leaseMs: number;
    },
  ): Promise<FeedbackConversationExecutionClaim | undefined> {
    await transaction
      .insert(feedbackConversationExecutions)
      .values({ conversationId: input.conversationId })
      .onConflictDoNothing({
        target: feedbackConversationExecutions.conversationId,
      });

    const [current] = await transaction
      .select()
      .from(feedbackConversationExecutions)
      .where(
        eq(feedbackConversationExecutions.conversationId, input.conversationId),
      )
      .limit(1)
      .for("update");
    if (!current) {
      throw new Error("Feedback execution fence disappeared during claim");
    }

    const databaseNow = await currentDatabaseTime(transaction);
    if (current.leaseUntil && current.leaseUntil > databaseNow) {
      return undefined;
    }

    const token = randomUUID();
    const leaseUntil = new Date(databaseNow.getTime() + input.leaseMs);
    const [claimed] = await transaction
      .update(feedbackConversationExecutions)
      .set({
        epoch: current.epoch + 1,
        workRevision: input.workRevision,
        leaseToken: token,
        leaseUntil,
        updatedAt: databaseNow,
      })
      .where(
        and(
          eq(
            feedbackConversationExecutions.conversationId,
            input.conversationId,
          ),
          eq(feedbackConversationExecutions.epoch, current.epoch),
        ),
      )
      .returning();
    return claimed ? toClaim(claimed) : undefined;
  }

  async renew(
    transaction: AppTransaction,
    claim: FeedbackConversationExecutionClaim,
    leaseMs: number,
  ): Promise<FeedbackConversationExecutionClaim | undefined> {
    const databaseNow = await currentDatabaseTime(transaction);
    const leaseUntil = new Date(databaseNow.getTime() + leaseMs);
    const [renewed] = await transaction
      .update(feedbackConversationExecutions)
      .set({ leaseUntil, updatedAt: databaseNow })
      .where(
        and(
          matchesClaim(claim),
          gt(feedbackConversationExecutions.leaseUntil, databaseNow),
        ),
      )
      .returning();
    return renewed ? toClaim(renewed) : undefined;
  }

  async release(
    transaction: AppTransaction,
    claim: FeedbackConversationExecutionClaim,
  ): Promise<boolean> {
    const [released] = await transaction
      .update(feedbackConversationExecutions)
      .set({
        leaseToken: null,
        leaseUntil: null,
        updatedAt: await currentDatabaseTime(transaction),
      })
      .where(matchesClaim(claim))
      .returning({
        conversationId: feedbackConversationExecutions.conversationId,
      });
    return released !== undefined;
  }

  /** Locks and validates the claim inside the caller's effects transaction. */
  async isCurrent(
    transaction: AppTransaction,
    claim: FeedbackConversationExecutionClaim,
  ): Promise<boolean> {
    const [current] = await transaction
      .select()
      .from(feedbackConversationExecutions)
      .where(matchesClaim(claim))
      .limit(1)
      .for("update");
    if (!current?.leaseUntil) {
      return false;
    }
    return current.leaseUntil > (await currentDatabaseTime(transaction));
  }
}

function matchesClaim(claim: FeedbackConversationExecutionClaim) {
  return and(
    eq(feedbackConversationExecutions.conversationId, claim.conversationId),
    eq(feedbackConversationExecutions.epoch, claim.epoch),
    eq(feedbackConversationExecutions.workRevision, claim.workRevision),
    eq(feedbackConversationExecutions.leaseToken, claim.token),
  );
}

function toClaim(
  row: FeedbackConversationExecutionRow,
): FeedbackConversationExecutionClaim {
  if (!row.leaseToken || !row.leaseUntil) {
    throw new Error("Feedback execution claim is missing lease fields");
  }
  return {
    conversationId: row.conversationId,
    workRevision: row.workRevision,
    epoch: row.epoch,
    token: row.leaseToken,
    leaseUntil: row.leaseUntil,
  };
}
