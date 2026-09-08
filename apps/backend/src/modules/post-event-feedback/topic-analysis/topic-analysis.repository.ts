import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import {
  feedbackCampaigns,
  feedbackNotes,
  feedbackTopicAnalyses as runs,
  feedbackTopicAnalysisSlot as slot,
  feedbackTopicEmbeddings as embeddings,
  type AppTransaction,
  type FeedbackTopicAnalysisInsert,
  type FeedbackTopicAnalysisRow,
  type FeedbackTopicEmbeddingInsert,
} from "@slopform/database";
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import {
  TOPIC_ANALYSIS_LIMITS,
  TopicAnalysisClaimLost,
  type TopicAnalysisResult,
} from "./topic-analysis.schemas.js";

export type TopicAnalysisClaim = {
  id: string;
  token: string;
  epoch: number;
  attempts: number;
};

@Injectable()
export class TopicAnalysisRepository {
  constructor(private readonly database: DatabaseService) {}

  async findCampaign(transaction: AppTransaction, campaignId: string) {
    const [campaign] = await transaction
      .select({
        id: feedbackCampaigns.id,
        questionSetVersion: feedbackCampaigns.questionSetVersion,
      })
      .from(feedbackCampaigns)
      .where(eq(feedbackCampaigns.id, campaignId));
    return campaign;
  }

  listExtractedNotes(transaction: AppTransaction, campaignId: string) {
    return transaction
      .select({
        id: feedbackNotes.id,
        conversationId: feedbackNotes.conversationId,
        respondentParticipantId: feedbackNotes.respondentParticipantId,
        subjectParticipantId: feedbackNotes.subjectParticipantId,
        noteType: feedbackNotes.noteType,
        text: feedbackNotes.text,
        sourceMessageIds: feedbackNotes.sourceMessageIds,
        extractionModel: sql<
          string | null
        >`${feedbackNotes.extractionMeta}->>'model'`,
        extractionOrigin: sql<
          string | null
        >`${feedbackNotes.extractionMeta}->>'origin'`,
        createdAt: feedbackNotes.createdAt,
        updatedAt: feedbackNotes.updatedAt,
      })
      .from(feedbackNotes)
      .where(
        and(
          eq(feedbackNotes.campaignId, campaignId),
          eq(feedbackNotes.status, "new"),
          sql`coalesce(${feedbackNotes.extractionMeta}->>'origin', '') not in ('staff', 'deterministic_fallback')`,
        ),
      )
      .orderBy(asc(feedbackNotes.id))
      .limit(TOPIC_ANALYSIS_LIMITS.documents + 1);
  }

  async createOrFind(
    transaction: AppTransaction,
    input: FeedbackTopicAnalysisInsert,
  ) {
    const [created] = await transaction
      .insert(runs)
      .values(input)
      .onConflictDoNothing({ target: [runs.campaignId, runs.identityHash] })
      .returning();
    if (created) return { run: created, created: true };
    const [existing] = await transaction
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.campaignId, input.campaignId),
          eq(runs.identityHash, input.identityHash),
        ),
      );
    if (!existing) throw new Error("Topic analysis identity disappeared");
    return { run: existing, created: false };
  }

  async findById(id: string) {
    const [run] = await this.database.db
      .select()
      .from(runs)
      .where(eq(runs.id, id));
    return run;
  }

  /** Lock ordering is deployment slot, then run; all writers use it. */
  async claimRun(
    transaction: AppTransaction,
    id: string,
  ): Promise<
    | {
        kind: "claimed";
        claim: TopicAnalysisClaim;
        run: FeedbackTopicAnalysisRow;
      }
    | { kind: "busy" | "terminal" | "missing" }
  > {
    await transaction.insert(slot).values({ id: 1 }).onConflictDoNothing();
    const [capacity] = await transaction
      .select({
        token: slot.claimToken,
        available: sql<boolean>`${slot.claimExpiresAt} is null or ${slot.claimExpiresAt} <= clock_timestamp()`,
      })
      .from(slot)
      .where(eq(slot.id, 1))
      .for("update");
    const [run] = await transaction
      .select()
      .from(runs)
      .where(eq(runs.id, id))
      .for("update");
    if (!run) return { kind: "missing" };
    if (run.status === "completed" || run.status === "failed")
      return { kind: "terminal" };
    if (!capacity?.available) return { kind: "busy" };
    if (run.attempts >= TOPIC_ANALYSIS_LIMITS.attempts) {
      await transaction
        .update(runs)
        .set({
          status: "failed",
          stage: "failed",
          errorCode: "attempts_exhausted",
          completedAt: sql`clock_timestamp()`,
          claimToken: null,
          claimExpiresAt: null,
        })
        .where(eq(runs.id, id));
      return { kind: "terminal" };
    }
    const token = randomUUID();
    const expires = sql`clock_timestamp() + interval '15 minutes'`;
    await transaction
      .update(slot)
      .set({ claimToken: token, claimExpiresAt: expires })
      .where(eq(slot.id, 1));
    const [claimed] = await transaction
      .update(runs)
      .set({
        status: "running",
        stage: "embedding",
        attempts: run.attempts + 1,
        executionEpoch: run.executionEpoch + 1,
        claimToken: token,
        claimExpiresAt: expires,
        nextWakeupAt: expires,
        errorCode: null,
      })
      .where(eq(runs.id, id))
      .returning();
    if (!claimed) throw new Error("Topic analysis claim disappeared");
    return {
      kind: "claimed",
      claim: {
        id,
        token,
        epoch: claimed.executionEpoch,
        attempts: claimed.attempts,
      },
      run: claimed,
    };
  }

  /** A live token is checked under both row locks before any cache/result write. */
  async lockClaim(transaction: AppTransaction, claim: TopicAnalysisClaim) {
    const [capacity] = await transaction
      .select()
      .from(slot)
      .where(
        and(
          eq(slot.id, 1),
          eq(slot.claimToken, claim.token),
          sql`${slot.claimExpiresAt} > clock_timestamp()`,
        ),
      )
      .for("update");
    if (!capacity) throw new TopicAnalysisClaimLost();
    const [run] = await transaction
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.id, claim.id),
          eq(runs.status, "running"),
          eq(runs.claimToken, claim.token),
          eq(runs.executionEpoch, claim.epoch),
          sql`${runs.claimExpiresAt} > clock_timestamp()`,
        ),
      )
      .for("update");
    if (!run) throw new TopicAnalysisClaimLost();
    return run;
  }

  async renewClaim(
    transaction: AppTransaction,
    claim: TopicAnalysisClaim,
    stage: "embedding" | "clustering",
  ) {
    await this.lockClaim(transaction, claim);
    const expires = sql`clock_timestamp() + interval '15 minutes'`;
    await transaction
      .update(slot)
      .set({ claimExpiresAt: expires })
      .where(eq(slot.id, 1));
    await transaction
      .update(runs)
      .set({ stage, claimExpiresAt: expires, nextWakeupAt: expires })
      .where(eq(runs.id, claim.id));
  }

  async reserveEmbeddingRequest(
    transaction: AppTransaction,
    claim: TopicAnalysisClaim,
    inputBytes: number,
  ) {
    const run = await this.lockClaim(transaction, claim);
    if (
      run.reservedRequests >= TOPIC_ANALYSIS_LIMITS.requests ||
      run.reservedInputBytes + inputBytes >
        TOPIC_ANALYSIS_LIMITS.lifetimeInputBytes
    )
      return false;
    await transaction
      .update(runs)
      .set({
        reservedRequests: run.reservedRequests + 1,
        reservedInputBytes: run.reservedInputBytes + inputBytes,
      })
      .where(eq(runs.id, claim.id));
    return true;
  }

  async findEmbeddings(cacheKeys: string[]) {
    if (!cacheKeys.length) return [];
    return this.database.db
      .select({
        cacheKey: embeddings.cacheKey,
        embedding: embeddings.embedding,
      })
      .from(embeddings)
      .where(inArray(embeddings.cacheKey, cacheKeys));
  }

  async recordEmbeddingBatch(
    transaction: AppTransaction,
    claim: TopicAnalysisClaim,
    rows: FeedbackTopicEmbeddingInsert[],
    usage: { promptTokens: number; costUsd: number | null },
  ) {
    const run = await this.lockClaim(transaction, claim);
    await transaction.insert(embeddings).values(rows).onConflictDoNothing();
    await transaction
      .update(runs)
      .set({
        observedResponses: run.observedResponses + 1,
        observedPromptTokens: run.observedPromptTokens + usage.promptTokens,
        observedCostUsd:
          usage.costUsd === null
            ? run.observedCostUsd
            : (run.observedCostUsd ?? 0) + usage.costUsd,
      })
      .where(eq(runs.id, claim.id));
  }

  async completeRun(
    transaction: AppTransaction,
    claim: TopicAnalysisClaim,
    result: TopicAnalysisResult,
  ) {
    await this.lockClaim(transaction, claim);
    await transaction
      .update(runs)
      .set({
        status: "completed",
        stage: "completed",
        result,
        completedAt: sql`clock_timestamp()`,
        errorCode: null,
        claimToken: null,
        claimExpiresAt: null,
      })
      .where(eq(runs.id, claim.id));
    await transaction
      .update(slot)
      .set({ claimToken: null, claimExpiresAt: null })
      .where(eq(slot.id, 1));
  }

  async recordFailure(
    transaction: AppTransaction,
    claim: TopicAnalysisClaim,
    code: string,
    retryable: boolean,
  ) {
    const run = await this.lockClaim(transaction, claim);
    const retry = retryable && run.attempts < TOPIC_ANALYSIS_LIMITS.attempts;
    await transaction
      .update(runs)
      .set({
        status: retry ? "pending" : "failed",
        stage: retry ? "queued" : "failed",
        errorCode: code,
        completedAt: retry ? null : sql`clock_timestamp()`,
        claimToken: null,
        claimExpiresAt: null,
        nextWakeupAt: sql`clock_timestamp() + interval '30 seconds'`,
      })
      .where(eq(runs.id, claim.id));
    await transaction
      .update(slot)
      .set({ claimToken: null, claimExpiresAt: null })
      .where(eq(slot.id, 1));
    return retry;
  }

  /** Commit allocation before publication, so unavailable Redis rotates fairly. */
  async allocateDueWakeups(transaction: AppTransaction) {
    const due = await transaction
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          inArray(runs.status, ["pending", "running"]),
          lte(runs.nextWakeupAt, sql`clock_timestamp()`),
          or(
            isNull(runs.claimExpiresAt),
            lte(runs.claimExpiresAt, sql`clock_timestamp()`),
          ),
        ),
      )
      .orderBy(asc(runs.nextWakeupAt), asc(runs.id))
      .limit(20)
      .for("update", { skipLocked: true });
    if (due.length)
      await transaction
        .update(runs)
        .set({ nextWakeupAt: sql`clock_timestamp() + interval '30 seconds'` })
        .where(
          inArray(
            runs.id,
            due.map((row) => row.id),
          ),
        );
    return due;
  }
}
