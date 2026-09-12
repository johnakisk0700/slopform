import { createHash } from "node:crypto";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

export const TOPIC_ANALYSIS_LIMITS = {
  documents: 500,
  textCharacters: 500,
  inputBytes: 262_144,
  batchDocuments: 32,
  attempts: 3,
  requests: 48,
  lifetimeInputBytes: 786_432,
  leaseMs: 15 * 60_000,
} as const;

export const TOPIC_ANALYSIS_CONFIGURATION = {
  version: 1,
  inputVersion: "active-extracted-notes-v1",
  embedding: {
    model: "qwen/qwen3-embedding-8b",
    dimensions: 1024,
    instructionVersion: 1,
    instruction:
      "Instruct: Identify the topic of this post-event feedback note for clustering similar feedback.\nQuery: ",
    provider: {
      sort: "price",
      allow_fallbacks: false,
      require_parameters: true,
      max_price: { prompt: 0.01, request: 0 },
    },
  },
  clustering: {
    version: "bertopic-0.17.4-pca-hdbscan-v1",
    minTopicSize: 3,
    minSamples: 2,
    randomSeed: 42,
  },
} as const;

export const topicAnalysisConfigurationSchema = z
  .object({
    version: z.literal(1),
    inputVersion: z.literal("active-extracted-notes-v1"),
    embedding: z
      .object({
        model: z.literal("qwen/qwen3-embedding-8b"),
        dimensions: z.literal(1024),
        instructionVersion: z.literal(1),
        instruction: z.literal(
          TOPIC_ANALYSIS_CONFIGURATION.embedding.instruction,
        ),
        provider: z
          .object({
            sort: z.literal("price"),
            allow_fallbacks: z.literal(false),
            require_parameters: z.literal(true),
            max_price: z
              .object({ prompt: z.literal(0.01), request: z.literal(0) })
              .strict(),
          })
          .strict(),
      })
      .strict(),
    clustering: z
      .object({
        version: z.literal(TOPIC_ANALYSIS_CONFIGURATION.clustering.version),
        minTopicSize: z.literal(3),
        minSamples: z.literal(2),
        randomSeed: z.literal(42),
      })
      .strict(),
  })
  .strict();

export const topicAnalysisDocumentSchema = z
  .object({
    id: z.uuid(),
    conversationId: z.uuid(),
    respondentParticipantId: z.uuid(),
    subjectParticipantId: z.uuid().nullable(),
    noteType: z.enum(["general", "activity_interest"]),
    text: z.string().min(1).max(TOPIC_ANALYSIS_LIMITS.textCharacters),
    sourceMessageIds: z.array(z.uuid()).min(1).max(150),
    extractionModel: z.string().max(200).nullable(),
    extractionOrigin: z.string().max(100).nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export const topicAnalysisSnapshotSchema = z
  .object({
    version: z.literal(1),
    campaignId: z.uuid(),
    questionSetVersion: z.number().int().positive(),
    documents: z
      .array(topicAnalysisDocumentSchema)
      .min(1)
      .max(TOPIC_ANALYSIS_LIMITS.documents),
  })
  .strict();
export type TopicAnalysisSnapshot = z.infer<typeof topicAnalysisSnapshotSchema>;

export const topicAnalysisJobSchema = z
  .object({ schemaVersion: z.literal(1), analysisId: z.uuid() })
  .strict();
export const TOPIC_ANALYSIS_JOB_NAME = "feedback.analyze-topics.v1";
export const topicAnalysisJobId = (id: string) =>
  `feedback-analyze-topics-v1-${id}`;

const topicSchema = z
  .object({
    id: z.string().min(1).max(128),
    keywords: z.array(z.string().min(1).max(100)).max(20),
    representativeDocumentIds: z.array(z.uuid()).min(1).max(10),
    documentCount: z.number().int().positive(),
    respondentCount: z.number().int().positive(),
  })
  .strict();
const assignmentSchema = z
  .object({ documentId: z.uuid(), topicId: z.string().max(128).nullable() })
  .strict();
export const topicAnalysisResultSchema = z
  .object({
    version: z.literal(1),
    topics: z.array(topicSchema).max(500),
    assignments: z.array(assignmentSchema).min(1).max(500),
    documentCount: z.number().int().positive(),
    respondentCount: z.number().int().positive(),
    outlierDocumentCount: z.number().int().nonnegative(),
    outlierRespondentCount: z.number().int().nonnegative(),
  })
  .strict();
export type TopicAnalysisResult = z.infer<typeof topicAnalysisResultSchema>;

export const topicAnalysisStatusSchema = z
  .object({
    id: z.uuid(),
    campaignId: z.uuid(),
    status: z.enum(["pending", "running", "completed", "failed"]),
    stage: z.enum(["queued", "embedding", "clustering", "completed", "failed"]),
    snapshotHash: z.string(),
    configuration: topicAnalysisConfigurationSchema,
    inputScope: z.literal("active_extracted_notes"),
    documentCount: z.number().int().positive(),
    attempts: z.number().int().nonnegative(),
    reservedRequests: z.number().int().nonnegative(),
    observedResponses: z.number().int().nonnegative(),
    observedPromptTokens: z.number().int().nonnegative(),
    observedCostUsd: z.number().nonnegative().nullable(),
    errorCode: z.string().nullable(),
    createdAt: z.iso.datetime(),
    completedAt: z.iso.datetime().nullable(),
  })
  .strict();
export const topicAnalysisResultViewSchema = z
  .object({
    analysis: topicAnalysisStatusSchema,
    snapshot: topicAnalysisSnapshotSchema,
    result: topicAnalysisResultSchema,
  })
  .strict();
export class TopicAnalysisCampaignParametersDto extends createZodDto(
  z.object({ campaignId: z.uuid() }).strict(),
) {}
export class TopicAnalysisParametersDto extends createZodDto(
  z.object({ campaignId: z.uuid(), analysisId: z.uuid() }).strict(),
) {}
export class TopicAnalysisStatusDto extends createZodDto(
  topicAnalysisStatusSchema,
) {}
export class TopicAnalysisResultDto extends createZodDto(
  topicAnalysisResultViewSchema,
) {}
export type TopicAnalysisStatus = z.infer<typeof topicAnalysisStatusSchema>;

export function hashTopicAnalysisValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function embeddingInput(text: string): string {
  return TOPIC_ANALYSIS_CONFIGURATION.embedding.instruction + text;
}
export function embeddingCacheIdentity(campaignId: string, text: string) {
  const configurationHash = hashTopicAnalysisValue(
    TOPIC_ANALYSIS_CONFIGURATION.embedding,
  );
  const inputHash = hashTopicAnalysisValue(embeddingInput(text));
  return {
    configurationHash,
    inputHash,
    cacheKey: hashTopicAnalysisValue([
      campaignId,
      configurationHash,
      inputHash,
    ]),
  };
}

export class TopicAnalysisFailure extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = "TopicAnalysisFailure";
  }
}
export class TopicAnalysisClaimLost extends TopicAnalysisFailure {
  constructor() {
    super("analysis_claim_lost", true);
  }
}
