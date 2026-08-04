import { randomUUID } from "node:crypto";

import { Injectable } from "@nestjs/common";
import {
  feedbackCampaigns,
  feedbackCampaignSummaries,
  eventAttendees,
  events,
  participants,
  type AppTransaction,
  type FeedbackCampaignQuestions,
  type FeedbackCampaignRow,
  type FeedbackCampaignStatus,
  type FeedbackCampaignSummaryRow,
  type FeedbackCampaignSummaryTrigger,
} from "@join-the-six/database";
import { and, asc, desc, eq, gt, isNotNull, lt, or, sql } from "drizzle-orm";

import { currentDatabaseTime } from "../../../infrastructure/database/database-time.js";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";

export type FeedbackEligibleAttendee = {
  readonly participantId: string;
  readonly preferredName: string | null;
  readonly emailNormalized: string;
  readonly phoneE164: string;
};

export type FeedbackCampaignWithEventTitle = {
  readonly campaign: FeedbackCampaignRow;
  readonly eventTitle: string;
};

export type FeedbackSummaryRecoveryCandidate = {
  readonly campaignId: string;
  readonly summary: Pick<
    FeedbackCampaignSummaryRow,
    "status" | "trigger" | "requestedAt" | "isPartial" | "openConversationCount"
  > | null;
};

export type FeedbackCampaignSummaryExecutionClaim = {
  readonly campaignId: string;
  readonly attempt: number;
  readonly epoch: number;
  readonly token: string;
  readonly claimExpiresAt: Date;
};

export type FeedbackCampaignSummaryClaimResult =
  | {
      readonly outcome: "claimed";
      readonly claim: FeedbackCampaignSummaryExecutionClaim;
    }
  | { readonly outcome: "busy" }
  | { readonly outcome: "stale" };

export type FeedbackCampaignResumeCursor = {
  readonly dueAt: Date;
  readonly campaignId: string;
};

export type FeedbackCampaignResumeCandidate = FeedbackCampaignResumeCursor & {
  readonly generation: number;
};

export type FeedbackPendingSummaryCursor = {
  readonly requestedAt: Date;
  readonly campaignId: string;
};

type DatabaseExecutor = AppTransaction | DatabaseService["db"];

@Injectable()
export class FeedbackCampaignRepository {
  constructor(private readonly database: DatabaseService) {}

  async createCampaign(
    transaction: AppTransaction,
    input: {
      readonly eventId: string;
      readonly questionSetVersion: number;
      readonly questions: FeedbackCampaignQuestions;
      readonly launchedAt: Date;
      readonly launchedBy: string;
      readonly status?: FeedbackCampaignStatus;
    },
  ): Promise<FeedbackCampaignRow> {
    const [record] = await transaction
      .insert(feedbackCampaigns)
      .values({
        eventId: input.eventId,
        questionSetVersion: input.questionSetVersion,
        questions: input.questions,
        launchedAt: input.launchedAt,
        launchedBy: input.launchedBy,
        status: input.status ?? "launched",
      })
      .returning();

    if (!record) {
      throw new Error("Feedback campaign insert returned no row");
    }

    return record;
  }

  async findCampaignById(
    id: string,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<FeedbackCampaignRow | undefined> {
    const [record] = await executor
      .select()
      .from(feedbackCampaigns)
      .where(eq(feedbackCampaigns.id, id))
      .limit(1);

    return record;
  }

  async findCampaignByIdForUpdate(
    transaction: AppTransaction,
    id: string,
  ): Promise<FeedbackCampaignRow | undefined> {
    const [record] = await transaction
      .select()
      .from(feedbackCampaigns)
      .where(eq(feedbackCampaigns.id, id))
      .limit(1)
      .for("update");

    return record;
  }

  /**
   * Pins campaign lifecycle for the rest of the caller's transaction while
   * still allowing other dispatchers to prepare messages from the same
   * campaign in parallel. Campaign pause/close takes an UPDATE lock, so it
   * either wins before this read or waits until the provider-entry marker has
   * committed.
   */
  async findCampaignByIdForShare(
    transaction: AppTransaction,
    id: string,
  ): Promise<FeedbackCampaignRow | undefined> {
    const [record] = await transaction
      .select()
      .from(feedbackCampaigns)
      .where(eq(feedbackCampaigns.id, id))
      .limit(1)
      .for("share");

    return record;
  }

  async findCampaignByEventId(
    eventId: string,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<FeedbackCampaignRow | undefined> {
    const [record] = await executor
      .select()
      .from(feedbackCampaigns)
      .where(eq(feedbackCampaigns.eventId, eventId))
      .limit(1);

    return record;
  }

  /**
   * Staff campaign picker: newest launch first, with the event title joined
   * so the list does not need a second events round-trip.
   */
  async listCampaignsNewestFirst(
    executor: DatabaseExecutor = this.database.db,
    limit = 200,
  ): Promise<FeedbackCampaignWithEventTitle[]> {
    const boundedLimit = Math.min(Math.max(1, limit), 200);
    const rows = await executor
      .select({
        campaign: feedbackCampaigns,
        eventTitle: events.title,
      })
      .from(feedbackCampaigns)
      .innerJoin(events, eq(events.id, feedbackCampaigns.eventId))
      .orderBy(desc(feedbackCampaigns.launchedAt), desc(feedbackCampaigns.id))
      .limit(boundedLimit);

    return rows.map((row) => ({
      campaign: row.campaign,
      eventTitle: row.eventTitle,
    }));
  }

  async updateCampaignStatus(
    transaction: AppTransaction,
    id: string,
    status: FeedbackCampaignStatus,
    options: { readonly resumeDueAt?: Date } = {},
  ): Promise<FeedbackCampaignRow | undefined> {
    const resumeRequested = status === "launched" && options.resumeDueAt;
    const [record] = await transaction
      .update(feedbackCampaigns)
      .set(
        resumeRequested
          ? {
              status,
              resumeGeneration: sql`${feedbackCampaigns.resumeGeneration} + 1`,
              resumeDueAt: resumeRequested,
              updatedAt: new Date(),
            }
          : status === "launched"
            ? { status, updatedAt: new Date() }
            : {
                status,
                // Pause/close cancels a resume repair that lost the lifecycle
                // race. The campaign row lock orders this with an in-flight
                // MongoDB hand-off.
                resumeAppliedGeneration: feedbackCampaigns.resumeGeneration,
                resumeDueAt: null,
                updatedAt: new Date(),
              },
      )
      .where(eq(feedbackCampaigns.id, id))
      .returning();

    return record;
  }

  /**
   * Locks one specific pending resume generation. The lock is intentionally
   * held while MongoDB admits that generation, serializing pause/close and a
   * concurrent repair without pretending the two stores share a transaction.
   */
  async findPendingResumeIntentForUpdate(
    transaction: AppTransaction,
    campaignId: string,
  ): Promise<FeedbackCampaignRow | undefined> {
    const [record] = await transaction
      .select()
      .from(feedbackCampaigns)
      .where(
        and(
          eq(feedbackCampaigns.id, campaignId),
          eq(feedbackCampaigns.status, "launched"),
          lt(
            feedbackCampaigns.resumeAppliedGeneration,
            feedbackCampaigns.resumeGeneration,
          ),
          isNotNull(feedbackCampaigns.resumeDueAt),
        ),
      )
      .limit(1)
      .for("update");

    return record;
  }

  /**
   * Re-locks the exact generation selected by maintenance after its allocation
   * transaction committed. A concurrent pause, acknowledgement or later
   * resume generation makes the allocated candidate stale instead of applying
   * work to a different lifecycle state.
   */
  async findPendingResumeCandidateForUpdate(
    transaction: AppTransaction,
    input: { readonly campaignId: string; readonly generation: number },
  ): Promise<FeedbackCampaignRow | undefined> {
    const [record] = await transaction
      .select()
      .from(feedbackCampaigns)
      .where(
        and(
          eq(feedbackCampaigns.id, input.campaignId),
          eq(feedbackCampaigns.status, "launched"),
          eq(feedbackCampaigns.resumeGeneration, input.generation),
          lt(feedbackCampaigns.resumeAppliedGeneration, input.generation),
          isNotNull(feedbackCampaigns.resumeDueAt),
        ),
      )
      .limit(1)
      .for("update");

    return record;
  }

  /**
   * Reads one deterministic resume-intent page. A task-specific checkpoint row
   * serializes allocation across replicas; candidate campaign rows are not
   * locked until processing starts after allocation commits.
   */
  async listPendingResumeCandidates(
    input: {
      readonly after?: FeedbackCampaignResumeCursor;
      readonly limit?: number;
    } = {},
    executor: DatabaseExecutor = this.database.db,
  ): Promise<FeedbackCampaignResumeCandidate[]> {
    const boundedLimit = Math.min(Math.max(1, input.limit ?? 100), 500);
    const rows = await executor
      .select({
        campaignId: feedbackCampaigns.id,
        generation: feedbackCampaigns.resumeGeneration,
        dueAt: feedbackCampaigns.resumeDueAt,
      })
      .from(feedbackCampaigns)
      .where(
        and(
          eq(feedbackCampaigns.status, "launched"),
          lt(
            feedbackCampaigns.resumeAppliedGeneration,
            feedbackCampaigns.resumeGeneration,
          ),
          isNotNull(feedbackCampaigns.resumeDueAt),
          input.after
            ? or(
                gt(feedbackCampaigns.resumeDueAt, input.after.dueAt),
                and(
                  eq(feedbackCampaigns.resumeDueAt, input.after.dueAt),
                  gt(feedbackCampaigns.id, input.after.campaignId),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(asc(feedbackCampaigns.resumeDueAt), asc(feedbackCampaigns.id))
      .limit(boundedLimit);

    return rows.map((row) => {
      if (!row.dueAt) {
        throw new Error("Pending campaign resume intent had no due timestamp");
      }
      return {
        campaignId: row.campaignId,
        generation: row.generation,
        dueAt: row.dueAt,
      };
    });
  }

  async acknowledgeResumeIntent(
    transaction: AppTransaction,
    input: { readonly campaignId: string; readonly generation: number },
  ): Promise<boolean> {
    const [record] = await transaction
      .update(feedbackCampaigns)
      .set({
        resumeAppliedGeneration: input.generation,
        resumeDueAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(feedbackCampaigns.id, input.campaignId),
          eq(feedbackCampaigns.status, "launched"),
          eq(feedbackCampaigns.resumeGeneration, input.generation),
          lt(feedbackCampaigns.resumeAppliedGeneration, input.generation),
        ),
      )
      .returning({ id: feedbackCampaigns.id });

    return Boolean(record);
  }

  /**
   * Present attendees who opted in and have an E.164 phone — the launch and
   * start-conversation eligibility gate (finished-event check lives in the
   * service).
   */
  async listEligibleAttendeesForEvent(
    eventId: string,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<FeedbackEligibleAttendee[]> {
    const rows = await executor
      .select({
        participantId: eventAttendees.participantId,
        preferredName: participants.preferredName,
        emailNormalized: participants.emailNormalized,
        phoneE164: participants.phoneE164,
      })
      .from(eventAttendees)
      .innerJoin(
        participants,
        eq(participants.id, eventAttendees.participantId),
      )
      .where(
        and(
          eq(eventAttendees.eventId, eventId),
          eq(eventAttendees.present, true),
          eq(participants.postEventFeedbackWhatsappOptIn, true),
          isNotNull(participants.phoneE164),
        ),
      )
      .orderBy(
        asc(participants.preferredName),
        asc(participants.emailNormalized),
      );

    return rows.flatMap((row) => {
      if (!row.phoneE164) {
        return [];
      }
      return [
        {
          participantId: row.participantId,
          preferredName: row.preferredName,
          emailNormalized: row.emailNormalized,
          phoneE164: row.phoneE164,
        },
      ];
    });
  }

  async findSummaryByCampaignId(
    campaignId: string,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<FeedbackCampaignSummaryRow | undefined> {
    const [record] = await executor
      .select()
      .from(feedbackCampaignSummaries)
      .where(eq(feedbackCampaignSummaries.campaignId, campaignId))
      .limit(1);

    return record;
  }

  /** Durable summary intents whose BullMQ wake-up may have been lost. */
  async listPendingSummaries(
    input: {
      readonly after?: FeedbackPendingSummaryCursor;
      readonly limit?: number;
    } = {},
    executor: DatabaseExecutor = this.database.db,
  ): Promise<FeedbackCampaignSummaryRow[]> {
    const boundedLimit = Math.min(Math.max(1, input.limit ?? 50), 500);
    return executor
      .select()
      .from(feedbackCampaignSummaries)
      .where(
        and(
          eq(feedbackCampaignSummaries.status, "pending"),
          input.after
            ? or(
                gt(
                  feedbackCampaignSummaries.requestedAt,
                  input.after.requestedAt,
                ),
                and(
                  eq(
                    feedbackCampaignSummaries.requestedAt,
                    input.after.requestedAt,
                  ),
                  gt(
                    feedbackCampaignSummaries.campaignId,
                    input.after.campaignId,
                  ),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(
        asc(feedbackCampaignSummaries.requestedAt),
        asc(feedbackCampaignSummaries.campaignId),
      )
      .limit(boundedLimit);
  }

  /**
   * Bounded keyset scan used to reconstruct an automatic summary request that
   * was lost between MongoDB's terminal close and PostgreSQL's summary intent.
   *
   * Every campaign is a candidate: a manual or earlier all-closed summary may
   * predate a conversation created later. MongoDB lifecycle statistics decide
   * whether the projection is actually stale. UUID primary-key order is only a
   * fairness cursor; business ordering does not belong in a repair scan.
   */
  async listSummaryRecoveryCandidates(
    input: { readonly afterCampaignId?: string; readonly limit?: number } = {},
    executor: DatabaseExecutor = this.database.db,
  ): Promise<FeedbackSummaryRecoveryCandidate[]> {
    const boundedLimit = Math.min(Math.max(1, input.limit ?? 100), 500);
    const rows = await executor
      .select({
        campaignId: feedbackCampaigns.id,
        summaryCampaignId: feedbackCampaignSummaries.campaignId,
        summaryStatus: feedbackCampaignSummaries.status,
        summaryTrigger: feedbackCampaignSummaries.trigger,
        summaryRequestedAt: feedbackCampaignSummaries.requestedAt,
        summaryIsPartial: feedbackCampaignSummaries.isPartial,
        summaryOpenConversationCount:
          feedbackCampaignSummaries.openConversationCount,
      })
      .from(feedbackCampaigns)
      .leftJoin(
        feedbackCampaignSummaries,
        eq(feedbackCampaignSummaries.campaignId, feedbackCampaigns.id),
      )
      .where(
        input.afterCampaignId
          ? gt(feedbackCampaigns.id, input.afterCampaignId)
          : undefined,
      )
      .orderBy(asc(feedbackCampaigns.id))
      .limit(boundedLimit);

    return rows.map((row) => ({
      campaignId: row.campaignId,
      summary:
        row.summaryCampaignId &&
        row.summaryStatus &&
        row.summaryTrigger &&
        row.summaryRequestedAt &&
        row.summaryIsPartial !== null &&
        row.summaryOpenConversationCount !== null
          ? {
              status: row.summaryStatus as FeedbackCampaignSummaryRow["status"],
              trigger:
                row.summaryTrigger as FeedbackCampaignSummaryRow["trigger"],
              requestedAt: row.summaryRequestedAt,
              isPartial: row.summaryIsPartial,
              openConversationCount: row.summaryOpenConversationCount,
            }
          : null,
    }));
  }

  async upsertSummaryPending(
    transaction: AppTransaction,
    input: {
      readonly campaignId: string;
      readonly attempt: number;
      readonly isPartial: boolean;
      readonly trigger: FeedbackCampaignSummaryTrigger;
      readonly openConversationCount: number;
      readonly requestedAt: Date;
    },
  ): Promise<FeedbackCampaignSummaryRow> {
    const existing = await this.findSummaryByCampaignId(
      input.campaignId,
      transaction,
    );

    if (existing) {
      const [record] = await transaction
        .update(feedbackCampaignSummaries)
        .set({
          status: "pending",
          body: null,
          model: null,
          reasoningEffort: null,
          error: null,
          attempt: input.attempt,
          claimToken: null,
          claimExpiresAt: null,
          isPartial: input.isPartial,
          trigger: input.trigger,
          openConversationCount: input.openConversationCount,
          answerCount: 0,
          noteCount: 0,
          requestedAt: input.requestedAt,
          generatedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(feedbackCampaignSummaries.campaignId, input.campaignId))
        .returning();

      if (!record) {
        throw new Error("Feedback campaign summary update returned no row");
      }
      return record;
    }

    const [record] = await transaction
      .insert(feedbackCampaignSummaries)
      .values({
        campaignId: input.campaignId,
        status: "pending",
        attempt: input.attempt,
        isPartial: input.isPartial,
        trigger: input.trigger,
        openConversationCount: input.openConversationCount,
        requestedAt: input.requestedAt,
      })
      .returning();

    if (!record) {
      throw new Error("Feedback campaign summary insert returned no row");
    }
    return record;
  }

  /**
   * Serializes one paid summary execution per durable attempt. PostgreSQL's
   * clock owns expiry so application clock skew cannot create two entrants.
   */
  async tryClaimSummaryExecution(
    transaction: AppTransaction,
    input: {
      readonly campaignId: string;
      readonly attempt: number;
      readonly leaseMs: number;
    },
  ): Promise<FeedbackCampaignSummaryClaimResult> {
    const [current] = await transaction
      .select()
      .from(feedbackCampaignSummaries)
      .where(eq(feedbackCampaignSummaries.campaignId, input.campaignId))
      .limit(1)
      .for("update");

    if (
      !current ||
      current.status !== "pending" ||
      current.attempt !== input.attempt
    ) {
      return { outcome: "stale" };
    }

    const databaseNow = await currentDatabaseTime(transaction);
    if (current.claimExpiresAt && current.claimExpiresAt > databaseNow) {
      return { outcome: "busy" };
    }

    const token = randomUUID();
    const claimExpiresAt = new Date(databaseNow.getTime() + input.leaseMs);
    const [claimed] = await transaction
      .update(feedbackCampaignSummaries)
      .set({
        executionEpoch: current.executionEpoch + 1,
        claimToken: token,
        claimExpiresAt,
        updatedAt: databaseNow,
      })
      .where(
        and(
          eq(feedbackCampaignSummaries.campaignId, input.campaignId),
          eq(feedbackCampaignSummaries.attempt, input.attempt),
          eq(feedbackCampaignSummaries.status, "pending"),
          eq(feedbackCampaignSummaries.executionEpoch, current.executionEpoch),
        ),
      )
      .returning();

    return claimed
      ? { outcome: "claimed", claim: toSummaryExecutionClaim(claimed) }
      : { outcome: "stale" };
  }

  async renewSummaryExecutionClaim(
    transaction: AppTransaction,
    claim: FeedbackCampaignSummaryExecutionClaim,
    leaseMs: number,
  ): Promise<FeedbackCampaignSummaryExecutionClaim | undefined> {
    const databaseNow = await currentDatabaseTime(transaction);
    const claimExpiresAt = new Date(databaseNow.getTime() + leaseMs);
    const [renewed] = await transaction
      .update(feedbackCampaignSummaries)
      .set({ claimExpiresAt, updatedAt: databaseNow })
      .where(
        and(
          matchesSummaryExecutionClaim(claim),
          gt(feedbackCampaignSummaries.claimExpiresAt, databaseNow),
        ),
      )
      .returning();
    return renewed ? toSummaryExecutionClaim(renewed) : undefined;
  }

  async releaseSummaryExecutionClaim(
    transaction: AppTransaction,
    claim: FeedbackCampaignSummaryExecutionClaim,
  ): Promise<boolean> {
    const [released] = await transaction
      .update(feedbackCampaignSummaries)
      .set({
        claimToken: null,
        claimExpiresAt: null,
        updatedAt: await currentDatabaseTime(transaction),
      })
      .where(matchesSummaryExecutionClaim(claim))
      .returning({ campaignId: feedbackCampaignSummaries.campaignId });
    return released !== undefined;
  }

  async markSummaryReady(
    transaction: AppTransaction,
    input: {
      readonly claim: FeedbackCampaignSummaryExecutionClaim;
      readonly body: string;
      readonly model: string;
      readonly reasoningEffort: string;
      readonly answerCount: number;
      readonly noteCount: number;
      readonly generatedAt: Date;
    },
  ): Promise<FeedbackCampaignSummaryRow | undefined> {
    const [record] = await transaction
      .update(feedbackCampaignSummaries)
      .set({
        status: "ready",
        body: input.body,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        error: null,
        answerCount: input.answerCount,
        noteCount: input.noteCount,
        generatedAt: input.generatedAt,
        claimToken: null,
        claimExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          matchesSummaryExecutionClaim(input.claim),
          gt(feedbackCampaignSummaries.claimExpiresAt, sql`clock_timestamp()`),
        ),
      )
      .returning();

    return record;
  }

  async markSummaryFailed(
    transaction: AppTransaction,
    input: {
      readonly claim: FeedbackCampaignSummaryExecutionClaim;
      readonly error: string;
      readonly generatedAt: Date;
    },
  ): Promise<FeedbackCampaignSummaryRow | undefined> {
    const [record] = await transaction
      .update(feedbackCampaignSummaries)
      .set({
        status: "failed",
        error: input.error,
        generatedAt: input.generatedAt,
        claimToken: null,
        claimExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          matchesSummaryExecutionClaim(input.claim),
          gt(feedbackCampaignSummaries.claimExpiresAt, sql`clock_timestamp()`),
        ),
      )
      .returning();

    return record;
  }
}

function matchesSummaryExecutionClaim(
  claim: FeedbackCampaignSummaryExecutionClaim,
) {
  return and(
    eq(feedbackCampaignSummaries.campaignId, claim.campaignId),
    eq(feedbackCampaignSummaries.attempt, claim.attempt),
    eq(feedbackCampaignSummaries.status, "pending"),
    eq(feedbackCampaignSummaries.executionEpoch, claim.epoch),
    eq(feedbackCampaignSummaries.claimToken, claim.token),
  );
}

function toSummaryExecutionClaim(
  row: FeedbackCampaignSummaryRow,
): FeedbackCampaignSummaryExecutionClaim {
  if (!row.claimToken || !row.claimExpiresAt) {
    throw new Error("Feedback summary execution claim is missing lease fields");
  }
  return {
    campaignId: row.campaignId,
    attempt: row.attempt,
    epoch: row.executionEpoch,
    token: row.claimToken,
    claimExpiresAt: row.claimExpiresAt,
  };
}
