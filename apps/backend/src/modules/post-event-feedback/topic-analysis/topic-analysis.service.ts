import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { type FeedbackTopicAnalysisRow } from "@slopform/database";
import { AuditRepository } from "../../../infrastructure/audit/audit.repository.js";
import type { Environment } from "../../../infrastructure/config/environment.js";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { TopicAnalysisRepository } from "./topic-analysis.repository.js";
import {
  embeddingInput,
  hashTopicAnalysisValue,
  TOPIC_ANALYSIS_CONFIGURATION,
  TOPIC_ANALYSIS_LIMITS,
  topicAnalysisConfigurationSchema,
  topicAnalysisResultSchema,
  topicAnalysisSnapshotSchema,
  type TopicAnalysisStatus,
} from "./topic-analysis.schemas.js";
import { TopicAnalysisWakeup } from "./topic-analysis.wakeup.js";

@Injectable()
export class TopicAnalysisService {
  constructor(
    private readonly config: ConfigService<Environment, true>,
    private readonly database: DatabaseService,
    private readonly repository: TopicAnalysisRepository,
    private readonly audit: AuditRepository,
    private readonly wakeup: TopicAnalysisWakeup,
  ) {}

  async start(campaignId: string, userId: string) {
    if (!this.config.get("FEEDBACK_TOPIC_ANALYSIS_ENABLED", { infer: true }))
      throw new ForbiddenException("Topic analysis is disabled");
    const { run } = await this.database.transaction(async (transaction) => {
      const campaign = await this.repository.findCampaign(
        transaction,
        campaignId,
      );
      if (!campaign) throw new NotFoundException("Feedback campaign not found");
      const notes = await this.repository.listExtractedNotes(
        transaction,
        campaignId,
      );
      if (!notes.length)
        throw new BadRequestException("No active extracted notes to analyze");
      if (notes.length > TOPIC_ANALYSIS_LIMITS.documents)
        throw new BadRequestException(
          "Topic analysis supports at most 500 active extracted notes",
        );
      const parsed = topicAnalysisSnapshotSchema.safeParse({
        version: 1,
        campaignId,
        questionSetVersion: campaign.questionSetVersion,
        documents: notes.map((note) => ({
          ...note,
          createdAt: note.createdAt.toISOString(),
          updatedAt: note.updatedAt.toISOString(),
        })),
      });
      if (!parsed.success)
        throw new BadRequestException(
          "Extracted note provenance exceeds topic analysis limits",
        );
      const snapshot = parsed.data;
      const inputBytes = snapshot.documents.reduce(
        (total, document) =>
          total + Buffer.byteLength(embeddingInput(document.text), "utf8") + 2,
        0,
      );
      if (
        inputBytes > TOPIC_ANALYSIS_LIMITS.inputBytes ||
        Buffer.byteLength(JSON.stringify(snapshot)) > 1_500_000
      )
        throw new BadRequestException(
          "Extracted notes exceed the topic analysis input budget",
        );
      const snapshotHash = hashTopicAnalysisValue(snapshot);
      const outcome = await this.repository.createOrFind(transaction, {
        campaignId,
        snapshotHash,
        snapshot,
        configuration: TOPIC_ANALYSIS_CONFIGURATION,
        identityHash: hashTopicAnalysisValue([
          campaignId,
          snapshotHash,
          TOPIC_ANALYSIS_CONFIGURATION,
        ]),
        requestedBy: userId,
      });
      if (outcome.created)
        await this.audit.append(transaction, {
          actorType: "user",
          actorId: userId,
          action: "feedback.topic_analysis.requested",
          entityType: "feedback_topic_analysis",
          entityId: outcome.run.id,
          context: {
            campaignId,
            snapshotHash,
            documentCount: snapshot.documents.length,
          },
        });
      return outcome;
    });
    // Durable intent survives queue loss; the worker sweep repairs publication.
    if (run.status === "pending") await this.wakeup.publish(run.id);
    return toTopicAnalysisStatus(run);
  }

  async get(campaignId: string, analysisId: string) {
    return toTopicAnalysisStatus(await this.requireRun(campaignId, analysisId));
  }

  async getResult(campaignId: string, analysisId: string) {
    const run = await this.requireRun(campaignId, analysisId);
    if (run.status !== "completed")
      throw new ConflictException("Topic analysis has no completed result");
    return {
      analysis: toTopicAnalysisStatus(run),
      snapshot: topicAnalysisSnapshotSchema.parse(run.snapshot),
      result: topicAnalysisResultSchema.parse(run.result),
    };
  }

  private async requireRun(campaignId: string, analysisId: string) {
    const run = await this.repository.findById(analysisId);
    if (!run || run.campaignId !== campaignId)
      throw new NotFoundException("Topic analysis not found");
    return run;
  }
}

export function toTopicAnalysisStatus(
  run: FeedbackTopicAnalysisRow,
): TopicAnalysisStatus {
  const snapshot = topicAnalysisSnapshotSchema.parse(run.snapshot);
  return {
    id: run.id,
    campaignId: run.campaignId,
    status: run.status as TopicAnalysisStatus["status"],
    stage: run.stage as TopicAnalysisStatus["stage"],
    snapshotHash: run.snapshotHash,
    configuration: topicAnalysisConfigurationSchema.parse(run.configuration),
    inputScope: "active_extracted_notes",
    documentCount: snapshot.documents.length,
    attempts: run.attempts,
    reservedRequests: run.reservedRequests,
    observedResponses: run.observedResponses,
    observedPromptTokens: run.observedPromptTokens,
    observedCostUsd: run.observedCostUsd,
    errorCode: run.errorCode,
    createdAt: run.createdAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
  };
}
