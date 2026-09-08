import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { Effect } from "effect";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import {
  attemptPromise,
  runWithOriginalError,
} from "../../../infrastructure/effect/promise.js";
import {
  EmbeddingProviderFailure,
  OpenRouterEmbeddingsClient,
} from "../../../integrations/openrouter/openrouter-embeddings.client.js";
import { TopicClusteringClient } from "../../../integrations/topic-clustering/topic-clustering.client.js";
import {
  ClusteringFailure,
  validateClusteringResult,
  type ClusteringResult,
} from "../../../integrations/topic-clustering/topic-clustering.protocol.js";
import {
  FeedbackLogger,
  FeedbackOperationLog,
} from "../feedback-operation-log.js";
import {
  TopicAnalysisRepository,
  type TopicAnalysisClaim,
} from "./topic-analysis.repository.js";
import {
  embeddingCacheIdentity,
  embeddingInput,
  hashTopicAnalysisValue,
  TOPIC_ANALYSIS_CONFIGURATION,
  TOPIC_ANALYSIS_LIMITS,
  TopicAnalysisClaimLost,
  TopicAnalysisFailure,
  topicAnalysisConfigurationSchema,
  topicAnalysisResultSchema,
  topicAnalysisSnapshotSchema,
  type TopicAnalysisResult,
  type TopicAnalysisSnapshot,
} from "./topic-analysis.schemas.js";

@Injectable()
export class TopicAnalysisRunner implements OnModuleDestroy {
  private readonly shutdown = new AbortController();
  private readonly logger = new FeedbackLogger(TopicAnalysisRunner.name);
  private active: Promise<"completed" | "busy" | "terminal"> | undefined;
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: TopicAnalysisRepository,
    private readonly embeddings: OpenRouterEmbeddingsClient,
    private readonly clustering: TopicClusteringClient,
  ) {}

  async run(analysisId: string): Promise<"completed" | "busy" | "terminal"> {
    if (this.shutdown.signal.aborted)
      throw new TopicAnalysisFailure("analysis_shutting_down", true);
    if (this.active) return "busy";
    this.active = this.executeRun(analysisId);
    try {
      return await this.active;
    } finally {
      this.active = undefined;
    }
  }

  private async executeRun(
    analysisId: string,
  ): Promise<"completed" | "busy" | "terminal"> {
    const acquired = await this.database.transaction((transaction) =>
      this.repository.claimRun(transaction, analysisId),
    );
    if (acquired.kind === "missing")
      throw new TopicAnalysisFailure("analysis_missing", false);
    if (acquired.kind !== "claimed") return acquired.kind;
    const { claim, run } = acquired;
    const operation = new FeedbackOperationLog(this.logger, {
      operation: "topic_analysis",
      correlationId: analysisId,
      campaignId: run.campaignId,
      executionEpoch: claim.epoch,
      attempt: claim.attempts,
    });
    try {
      const snapshot = topicAnalysisSnapshotSchema.parse(run.snapshot);
      const configuration = topicAnalysisConfigurationSchema.parse(
        run.configuration,
      );
      if (
        hashTopicAnalysisValue(snapshot) !== run.snapshotHash ||
        hashTopicAnalysisValue([
          run.campaignId,
          run.snapshotHash,
          configuration,
        ]) !== run.identityHash
      )
        throw new TopicAnalysisFailure("analysis_identity_invalid", false);
      const self = this;
      await runWithOriginalError(
        Effect.gen(function* () {
          operation.stage("embed_notes");
          const vectors = yield* attemptPromise(() =>
            self.embedSnapshot(snapshot, claim),
          );
          operation.stage("cluster_notes");
          yield* attemptPromise(() => self.renewClaim(claim, "clustering"));
          const clustered = yield* attemptPromise(() =>
            self.clustering.cluster(
              {
                version: 1,
                requestId: run.id,
                documents: snapshot.documents.map((document, index) => ({
                  id: document.id,
                  text: document.text,
                  embedding: vectors[index]!,
                })),
                options: {
                  minTopicSize: configuration.clustering.minTopicSize,
                  minSamples: configuration.clustering.minSamples,
                  randomSeed: configuration.clustering.randomSeed,
                },
              },
              self.shutdown.signal,
              (stage) => operation.stage(`cluster_${stage}`),
            ),
          );
          operation.stage("validate_result");
          const validated = validateClusteringResult(
            clustered,
            run.id,
            snapshot.documents.map((document) => document.id),
          );
          const result = buildTopicAnalysisResult(snapshot, validated);
          operation.stage("commit_result");
          yield* attemptPromise(() =>
            self.database.transaction((transaction) =>
              self.repository.completeRun(transaction, claim, result),
            ),
          );
        }),
      );
      operation.complete("completed");
      return "completed";
    } catch (error) {
      const failure = classifyTopicAnalysisFailure(error);
      operation.failed(failure);
      try {
        await this.database.transaction((transaction) =>
          this.repository.recordFailure(
            transaction,
            claim,
            failure.code,
            failure.retryable,
          ),
        );
      } catch (settlementError) {
        if (!(settlementError instanceof TopicAnalysisClaimLost))
          throw settlementError;
      }
      throw failure;
    }
  }

  private async embedSnapshot(
    snapshot: TopicAnalysisSnapshot,
    claim: TopicAnalysisClaim,
  ): Promise<number[][]> {
    const identities = snapshot.documents.map((document) =>
      embeddingCacheIdentity(snapshot.campaignId, document.text),
    );
    const cached = new Map(
      (
        await this.repository.findEmbeddings(
          identities.map((identity) => identity.cacheKey),
        )
      ).map((row) => [row.cacheKey, row.embedding]),
    );
    const missing = [
      ...new Map(
        snapshot.documents.map((document, index) => [
          identities[index]!.cacheKey,
          { document, identity: identities[index]! },
        ]),
      ).values(),
    ].filter((item) => !cached.has(item.identity.cacheKey));
    for (
      let index = 0;
      index < missing.length;
      index += TOPIC_ANALYSIS_LIMITS.batchDocuments
    ) {
      if (this.shutdown.signal.aborted)
        throw new TopicAnalysisFailure("analysis_shutting_down", true);
      const batch = missing.slice(
        index,
        index + TOPIC_ANALYSIS_LIMITS.batchDocuments,
      );
      const texts = batch.map((item) => embeddingInput(item.document.text));
      await this.renewClaim(claim, "embedding");
      // Reserve before the network call: an ambiguous crash spends budget even
      // though a response may never be observed or committed.
      const reserved = await this.database.transaction((transaction) =>
        this.repository.reserveEmbeddingRequest(
          transaction,
          claim,
          texts.reduce(
            (total, text) => total + Buffer.byteLength(text, "utf8") + 2,
            0,
          ),
        ),
      );
      if (!reserved)
        throw new TopicAnalysisFailure("embedding_budget_exhausted", false);
      const result = await this.embeddings.embed(
        { texts, ...TOPIC_ANALYSIS_CONFIGURATION.embedding },
        this.shutdown.signal,
      );
      const rows = batch.map((item, batchIndex) => ({
        ...item.identity,
        campaignId: snapshot.campaignId,
        embedding: validateStoredVector(result.vectors[batchIndex]!),
      }));
      await this.database.transaction((transaction) =>
        this.repository.recordEmbeddingBatch(
          transaction,
          claim,
          rows,
          result.usage,
        ),
      );
      for (const row of rows) cached.set(row.cacheKey, row.embedding);
    }
    return identities.map((identity) =>
      validateStoredVector(cached.get(identity.cacheKey)!),
    );
  }

  private async renewClaim(
    claim: TopicAnalysisClaim,
    stage: "embedding" | "clustering",
  ) {
    if (this.shutdown.signal.aborted)
      throw new TopicAnalysisFailure("analysis_shutting_down", true);
    await this.database.transaction((transaction) =>
      this.repository.renewClaim(transaction, claim, stage),
    );
  }

  async onModuleDestroy() {
    this.shutdown.abort();
    await this.active?.catch(() => undefined);
  }
}

export function validateStoredVector(vector: number[]): number[] {
  const rounded = vector?.map(Math.fround);
  if (
    !rounded ||
    rounded.length !== TOPIC_ANALYSIS_CONFIGURATION.embedding.dimensions ||
    rounded.some((value) => !Number.isFinite(value)) ||
    !rounded.some((value) => value !== 0)
  )
    throw new TopicAnalysisFailure("embedding_cache_invalid", false);
  return rounded;
}

export function buildTopicAnalysisResult(
  snapshot: TopicAnalysisSnapshot,
  clustered: ClusteringResult,
): TopicAnalysisResult {
  const respondents = new Map(
    snapshot.documents.map((document) => [
      document.id,
      document.respondentParticipantId,
    ]),
  );
  const countRespondents = (ids: string[]) =>
    new Set(ids.map((id) => respondents.get(id))).size;
  const outliers = clustered.assignments
    .filter((assignment) => assignment.topicId === null)
    .map((assignment) => assignment.documentId);
  return topicAnalysisResultSchema.parse({
    version: 1,
    assignments: clustered.assignments,
    topics: clustered.topics.map((topic) => {
      const ids = clustered.assignments
        .filter((assignment) => assignment.topicId === topic.id)
        .map((assignment) => assignment.documentId);
      return {
        ...topic,
        documentCount: ids.length,
        respondentCount: countRespondents(ids),
      };
    }),
    documentCount: snapshot.documents.length,
    respondentCount: new Set(respondents.values()).size,
    outlierDocumentCount: outliers.length,
    outlierRespondentCount: countRespondents(outliers),
  });
}

function classifyTopicAnalysisFailure(error: unknown): TopicAnalysisFailure {
  if (error instanceof TopicAnalysisFailure) return error;
  if (
    error instanceof EmbeddingProviderFailure ||
    error instanceof ClusteringFailure
  )
    return new TopicAnalysisFailure(error.code, error.retryable);
  if (error instanceof Error && error.name === "ZodError")
    return new TopicAnalysisFailure(
      "analysis_persisted_contract_invalid",
      false,
    );
  return new TopicAnalysisFailure("analysis_dependency_failed", true);
}
