import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createOpenAI } from "@ai-sdk/openai";
import {
  APICallError,
  NoContentGeneratedError,
  RetryError,
  generateObject,
  type LanguageModel,
} from "ai";
import type { Queue } from "bullmq";
import type {
  FeedbackCampaignRow,
  FeedbackCampaignSummaryRow,
  FeedbackCampaignSummaryTrigger,
} from "@join-the-six/database";

import { AuditRepository } from "../../../infrastructure/audit/audit.repository.js";
import { ProviderCallLimiter } from "../../../infrastructure/ai/provider-call-limiter.js";
import type { Environment } from "../../../infrastructure/config/environment.js";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { FEEDBACK_SUMMARY_QUEUE } from "../../../infrastructure/queue/queue.constants.js";
import {
  assistantModelAdapter,
  isRetryableProviderError,
} from "../../assistant/assistant-models.js";
import {
  assistantModelSchema,
  type AssistantModel,
} from "../../assistant/assistant.schemas.js";
import { ParticipantsRepository } from "../../participants/participants.repository.js";
import {
  FeedbackCampaignRepository,
  type FeedbackCampaignSummaryExecutionClaim,
  type FeedbackSummaryRecoveryCandidate,
} from "../campaign/campaign.repository.js";
import { FeedbackCampaignNotFoundError } from "../campaign/campaign.service.js";
import type { FeedbackCampaignSummaryView } from "../campaign/campaign.schemas.js";
import { FeedbackResultsRepository } from "../extraction/results.repository.js";
import { FEEDBACK_PROVIDER_ACCOUNT_FAULT_STATUS_CODES } from "../extraction/model.service.js";
import { FeedbackConversationRepository } from "../post-event-feedback-conversation.repository.js";
import { FeedbackMaintenanceCheckpointRepository } from "../sweeps/maintenance-checkpoint.repository.js";
import {
  createFeedbackSummarizeCampaignV2JobId,
  FEEDBACK_JOB_NAMES,
  FEEDBACK_JOB_SCHEMA_VERSION_V2,
  feedbackSummarizeCampaignV2JobDataSchema,
  type FeedbackSummarizeCampaignV2JobData,
} from "../jobs.schemas.js";
import { getPostEventFeedbackQuestionSet } from "../question-set.js";
import { buildFeedbackCampaignSummaryPrompt } from "./prompt.js";
import {
  buildFeedbackCampaignSummaryDocument,
  feedbackCampaignSummaryNarrativeSchema,
  parseFeedbackCampaignSummaryDocument,
  serializeFeedbackCampaignSummaryDocument,
} from "./summary-document.js";
import { buildFeedbackCampaignSummaryMetrics } from "./summary-metrics.js";

export const DEFAULT_FEEDBACK_SUMMARY_MODEL =
  "openai/gpt-5.6-terra" as const satisfies AssistantModel;

export const DEFAULT_FEEDBACK_SUMMARY_REASONING_EFFORT = "high" as const;

export const FEEDBACK_SUMMARY_REASONING_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type FeedbackSummaryReasoningEffort =
  (typeof FEEDBACK_SUMMARY_REASONING_EFFORTS)[number];

export const FEEDBACK_SUMMARY_TIMEOUT_MILLISECONDS = 300_000;
export const FEEDBACK_SUMMARY_EXECUTION_LEASE_MS = 7 * 60_000;
export const FEEDBACK_SUMMARY_EXECUTION_HEARTBEAT_MS = 60_000;
export const FEEDBACK_PENDING_SUMMARY_RECOVERY_BATCH_SIZE = 50;
export const FEEDBACK_PENDING_SUMMARY_RECOVERY_LIMIT = 500;
export const FEEDBACK_SUMMARY_RECOVERY_BATCH_SIZE = 100;
export const FEEDBACK_SUMMARY_RECOVERY_SCAN_LIMIT = 500;

export const FEEDBACK_SUMMARY_BODY_MAX_LENGTH = 50_000;

export class FeedbackSummaryGenerationError extends Error {
  constructor(
    readonly retryable: boolean,
    readonly detail: string = "",
  ) {
    super("Feedback campaign summary generation failed");
    this.name = FeedbackSummaryGenerationError.name;
  }
}

export class FeedbackSummaryDisabledInSimulatorError extends Error {
  constructor() {
    super(
      "Automatic feedback campaign summaries are disabled while the simulator is enabled",
    );
    this.name = FeedbackSummaryDisabledInSimulatorError.name;
  }
}

export class FeedbackSummaryExecutionSupersededError extends Error {
  constructor() {
    super("Feedback campaign summary execution was superseded");
    this.name = FeedbackSummaryExecutionSupersededError.name;
  }
}

export type FeedbackCampaignSummaryRunOutcome =
  "completed" | "claim_busy" | "skipped_stale";

export type FeedbackCampaignSummaryRunOptions = {
  readonly terminalOnFailure: boolean;
};

type FeedbackSummaryExecutionHeartbeat = {
  stop(): Promise<void>;
};

@Injectable()
export class PostEventFeedbackCampaignSummaryService {
  private readonly logger = new Logger(
    PostEventFeedbackCampaignSummaryService.name,
  );
  private readonly openAiProvider: ReturnType<typeof createOpenAI> | undefined;
  private readonly model: AssistantModel;
  private readonly reasoningEffort: FeedbackSummaryReasoningEffort;
  private readonly simulatorEnabled: boolean;

  constructor(
    private readonly config: ConfigService<Environment, true>,
    private readonly database: DatabaseService,
    private readonly campaigns: FeedbackCampaignRepository,
    private readonly conversations: FeedbackConversationRepository,
    private readonly results: FeedbackResultsRepository,
    private readonly participants: ParticipantsRepository,
    private readonly audit: AuditRepository,
    private readonly checkpoints: FeedbackMaintenanceCheckpointRepository,
    @InjectQueue(FEEDBACK_SUMMARY_QUEUE)
    private readonly queue: Queue,
    @Optional()
    private readonly providerCalls: ProviderCallLimiter = new ProviderCallLimiter(),
  ) {
    const openAiKey = this.config.get("OPENAI_API_KEY", { infer: true });
    this.openAiProvider = openAiKey
      ? createOpenAI({ apiKey: openAiKey })
      : undefined;
    this.model = resolveFeedbackSummaryModel(
      this.config.get("FEEDBACK_SUMMARY_MODEL", { infer: true }),
    );
    this.reasoningEffort = resolveFeedbackSummaryReasoningEffort(
      this.config.get("FEEDBACK_SUMMARY_REASONING_EFFORT", { infer: true }),
    );
    this.simulatorEnabled = this.config.get("FEEDBACK_SIMULATOR_ENABLED", {
      infer: true,
    });
  }

  async get(campaignId: string): Promise<FeedbackCampaignSummaryView> {
    await this.requireCampaign(campaignId);
    const summary = await this.campaigns.findSummaryByCampaignId(campaignId);
    return toSummaryView(summary);
  }

  async request(
    campaignId: string,
    trigger: FeedbackCampaignSummaryTrigger,
    correlationId: string,
    actorId?: string,
  ): Promise<FeedbackCampaignSummaryView> {
    await this.requireCampaign(campaignId);
    if (this.simulatorEnabled && trigger !== "manual") {
      throw new FeedbackSummaryDisabledInSimulatorError();
    }

    const summary = await this.database.transaction(async (transaction) => {
      // The campaign row exists before the one-row summary projection and is
      // therefore the stable serialization key for concurrent first requests.
      // Conversation creation holds this same lock across its MongoDB write,
      // so the open-count snapshot and summary intent are ordered with every
      // new thread. The loser observes the winner's complete cross-store
      // mutation instead of persisting a false all-closed snapshot.
      const campaign = await this.campaigns.findCampaignByIdForUpdate(
        transaction,
        campaignId,
      );
      if (!campaign) {
        throw new FeedbackCampaignNotFoundError(campaignId);
      }
      const existing = await this.campaigns.findSummaryByCampaignId(
        campaignId,
        transaction,
      );
      if (existing?.status === "pending") {
        return existing;
      }

      const openConversationCount =
        await this.conversations.countOpenForCampaign(campaignId);
      const isPartial = openConversationCount > 0;
      const requestedAt = new Date();
      const attempt = (existing?.attempt ?? 0) + 1;
      const pending = await this.campaigns.upsertSummaryPending(transaction, {
        campaignId,
        attempt,
        isPartial,
        trigger,
        openConversationCount,
        requestedAt,
      });
      await this.audit.append(transaction, {
        actorType: actorId ? "admin" : "system",
        actorId: actorId ?? "feedback_summary",
        action: "feedback_campaign.summary_requested",
        entityType: "feedback_campaign",
        entityId: campaignId,
        requestId: correlationId,
        context: {
          attempt,
          trigger,
          isPartial,
          openConversationCount,
        },
      });
      return pending;
    });

    await this.ensurePendingQueued(summary, correlationId);

    return toSummaryView(summary);
  }

  /**
   * Recreates the disposable BullMQ wake-up for a durable pending summary.
   * A retained terminal job is removed only because the PostgreSQL row still
   * proves that the same attempt has not reached a terminal state.
   */
  async ensurePendingQueued(
    summary: FeedbackCampaignSummaryRow,
    correlationId: string,
  ): Promise<string> {
    if (summary.status !== "pending") {
      return createFeedbackSummarizeCampaignV2JobId(
        summary.campaignId,
        summary.attempt,
      );
    }

    const jobId = createFeedbackSummarizeCampaignV2JobId(
      summary.campaignId,
      summary.attempt,
    );
    const existing = await this.queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state !== "completed" && state !== "failed") {
        return jobId;
      }
      try {
        await existing.remove();
      } catch {
        // An active transition won the race. Its completion or the next
        // maintenance pass will settle the same durable attempt.
        return jobId;
      }
    }

    const data = feedbackSummarizeCampaignV2JobDataSchema.parse({
      schemaVersion: FEEDBACK_JOB_SCHEMA_VERSION_V2,
      campaignId: summary.campaignId,
      attempt: summary.attempt,
      correlationId,
    });
    await this.queue.add(FEEDBACK_JOB_NAMES.summarizeCampaignV2, data, {
      jobId,
      attempts: 5,
      backoff: { type: "exponential", delay: 1_000, jitter: 0.5 },
      removeOnComplete: { age: 86_400, count: 1_000 },
      removeOnFail: { age: 604_800, count: 5_000 },
      stackTraceLimit: 10,
    });
    return jobId;
  }

  /**
   * Converts a retained V1 summary wake-up without entering the model.
   * PostgreSQL must still name the same pending attempt; stale V1 jobs become
   * no-ops, while a live attempt is published onto the deterministic V2 queue.
   */
  async convertLegacyWakeup(input: {
    readonly campaignId: string;
    readonly attempt: number;
    readonly correlationId: string;
  }): Promise<string | undefined> {
    const summary = await this.campaigns.findSummaryByCampaignId(
      input.campaignId,
    );
    if (
      !summary ||
      summary.status !== "pending" ||
      summary.attempt !== input.attempt
    ) {
      return undefined;
    }
    return this.ensurePendingQueued(summary, input.correlationId);
  }

  async recoverPending(correlationId: string, limit = 50): Promise<number> {
    const boundedLimit = Math.min(
      Math.max(1, limit),
      FEEDBACK_PENDING_SUMMARY_RECOVERY_LIMIT,
    );
    let examined = 0;
    const errors: unknown[] = [];
    while (examined < boundedLimit) {
      const pageLimit = Math.min(
        FEEDBACK_PENDING_SUMMARY_RECOVERY_BATCH_SIZE,
        boundedLimit - examined,
      );
      const allocation = await this.allocatePendingRecoveryPage({
        limit: pageLimit,
        wrapAtTail: examined === 0,
      });
      if (allocation.summaries.length === 0) break;

      examined += allocation.summaries.length;
      for (const summary of allocation.summaries) {
        try {
          await this.ensurePendingQueued(summary, correlationId);
        } catch (error) {
          errors.push(error);
          this.logger.error({
            event: "feedback_campaign.pending_summary_recovery_item_failed",
            campaignId: summary.campaignId,
            attempt: summary.attempt,
            correlationId,
            error: { name: error instanceof Error ? error.name : "Error" },
          });
        }
      }

      if (allocation.reachedTail) break;
    }
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        "Feedback pending summary recovery had item failures",
      );
    }
    return examined;
  }

  /**
   * Commits the shared `(requested_at, campaign_id)` boundary before touching
   * BullMQ. Retained live jobs and enqueue failures therefore cannot pin the
   * oldest durable summary intents forever.
   */
  private async allocatePendingRecoveryPage(input: {
    readonly limit: number;
    readonly wrapAtTail: boolean;
  }): Promise<{
    readonly summaries: FeedbackCampaignSummaryRow[];
    readonly reachedTail: boolean;
  }> {
    return this.database.transaction(async (transaction) => {
      const after = await this.checkpoints.lockPendingSummary(transaction);
      let summaries = await this.campaigns.listPendingSummaries(
        {
          ...(after ? { after } : {}),
          limit: input.limit,
        },
        transaction,
      );

      if (summaries.length === 0 && after) {
        await this.checkpoints.savePendingSummary(transaction, undefined);
        if (!input.wrapAtTail) {
          return { summaries: [], reachedTail: true };
        }
        summaries = await this.campaigns.listPendingSummaries(
          { limit: input.limit },
          transaction,
        );
      }

      if (summaries.length === 0) {
        return { summaries, reachedTail: true };
      }

      const last = summaries.at(-1);
      if (!last) {
        throw new Error("Pending summary recovery page had no tail");
      }
      const reachedTail = summaries.length < input.limit;
      await this.checkpoints.savePendingSummary(transaction, {
        requestedAt: last.requestedAt,
        campaignId: last.campaignId,
      });
      return { summaries, reachedTail };
    });
  }

  /**
   * Repairs both halves of summary intent: pending rows whose disposable Bull
   * wake-up disappeared, and automatic requests lost after MongoDB committed
   * the last close but before PostgreSQL recorded a summary row.
   */
  async recover(correlationId: string): Promise<{
    readonly pending: number;
    readonly examined: number;
    readonly requested: number;
  }> {
    let pending = 0;
    let automatic = { examined: 0, requested: 0 };
    const errors: unknown[] = [];
    try {
      pending = await this.recoverPending(correlationId);
    } catch (error) {
      errors.push(error);
    }
    try {
      automatic = await this.recoverAutomaticIntent(correlationId);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Feedback summary recovery failed");
    }
    return { pending, ...automatic };
  }

  async recoverAutomaticIntent(
    correlationId: string,
  ): Promise<{ readonly examined: number; readonly requested: number }> {
    if (this.simulatorEnabled) {
      return { examined: 0, requested: 0 };
    }

    let examined = 0;
    let requested = 0;
    const errors: unknown[] = [];
    while (examined < FEEDBACK_SUMMARY_RECOVERY_SCAN_LIMIT) {
      const pageLimit = Math.min(
        FEEDBACK_SUMMARY_RECOVERY_BATCH_SIZE,
        FEEDBACK_SUMMARY_RECOVERY_SCAN_LIMIT - examined,
      );
      const allocation = await this.allocateAutomaticRecoveryPage({
        limit: pageLimit,
        wrapAtTail: examined === 0,
      });
      const { candidates } = allocation;
      if (candidates.length === 0) {
        break;
      }

      examined += candidates.length;
      let lifecycle: Map<
        string,
        Awaited<
          ReturnType<
            FeedbackConversationRepository["listLifecycleStatsForCampaigns"]
          >
        >[number]
      >;
      try {
        lifecycle = new Map(
          (
            await this.conversations.listLifecycleStatsForCampaigns(
              candidates.map((candidate) => candidate.campaignId),
            )
          ).map((stats) => [stats.campaignId, stats] as const),
        );
      } catch (error) {
        errors.push(error);
        this.logger.error({
          event: "feedback_campaign.summary_recovery_page_failed",
          correlationId,
          campaignCount: candidates.length,
          error: { name: error instanceof Error ? error.name : "Error" },
        });
        if (allocation.reachedTail) break;
        continue;
      }

      for (const candidate of candidates) {
        try {
          const stats = lifecycle.get(candidate.campaignId);
          if (!stats || stats.totalCount === 0 || stats.openCount > 0) {
            continue;
          }
          if (
            !stats.latestClosedAt ||
            !summaryNeedsFinalRefresh(candidate.summary, stats.latestClosedAt)
          ) {
            continue;
          }
          if (
            await this.maybeRequestAfterConversationClosed(
              candidate.campaignId,
              correlationId,
            )
          ) {
            requested += 1;
          }
        } catch (error) {
          errors.push(error);
          this.logger.error({
            event: "feedback_campaign.summary_recovery_item_failed",
            campaignId: candidate.campaignId,
            correlationId,
            error: { name: error instanceof Error ? error.name : "Error" },
          });
        }
      }

      if (allocation.reachedTail) break;
    }
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        "Feedback automatic summary recovery had item failures",
      );
    }
    return { examined, requested };
  }

  /**
   * Reserves one campaign page behind the globally shared PostgreSQL cursor.
   * Candidate processing happens only after this transaction commits, so a
   * slow/poisonous campaign cannot hold the allocator lock or pin later pages.
   */
  private async allocateAutomaticRecoveryPage(input: {
    readonly limit: number;
    readonly wrapAtTail: boolean;
  }): Promise<{
    readonly candidates: FeedbackSummaryRecoveryCandidate[];
    readonly reachedTail: boolean;
  }> {
    return this.database.transaction(async (transaction) => {
      const after = await this.checkpoints.lockAutomaticSummary(transaction);
      let candidates = await this.campaigns.listSummaryRecoveryCandidates(
        {
          ...(after ? { afterCampaignId: after } : {}),
          limit: input.limit,
        },
        transaction,
      );

      if (candidates.length === 0 && after) {
        await this.checkpoints.saveAutomaticSummary(transaction, undefined);
        if (!input.wrapAtTail) {
          return { candidates: [], reachedTail: true };
        }
        candidates = await this.campaigns.listSummaryRecoveryCandidates(
          { limit: input.limit },
          transaction,
        );
      }

      if (candidates.length === 0) {
        return { candidates, reachedTail: true };
      }

      const last = candidates.at(-1);
      if (!last) {
        throw new Error("Summary recovery page unexpectedly had no tail");
      }
      const reachedTail = candidates.length < input.limit;
      await this.checkpoints.saveAutomaticSummary(
        transaction,
        reachedTail ? undefined : last.campaignId,
      );
      return { candidates, reachedTail };
    });
  }

  async maybeRequestAfterConversationClosed(
    campaignId: string,
    correlationId: string,
  ): Promise<boolean> {
    if (this.simulatorEnabled) {
      this.logger.debug({
        event: "feedback_campaign.summary_auto_suppressed_simulator",
        campaignId,
        correlationId,
      });
      return false;
    }

    const openCount = await this.conversations.countOpenForCampaign(campaignId);
    if (openCount > 0) {
      return false;
    }

    const existing = await this.campaigns.findSummaryByCampaignId(campaignId);
    if (existing?.status === "pending") {
      return false;
    }

    await this.request(campaignId, "all_closed", correlationId);
    return true;
  }

  async notifyIfLastConversationClosed(
    campaignId: string,
    correlationId: string,
    closed: boolean,
  ): Promise<void> {
    if (!closed) {
      return;
    }
    try {
      await this.maybeRequestAfterConversationClosed(campaignId, correlationId);
    } catch (error) {
      this.logger.error({
        event: "feedback_campaign.summary_enqueue_failed",
        campaignId,
        correlationId,
        error: {
          name: error instanceof Error ? error.name : "UnknownError",
        },
      });
    }
  }

  async run(
    input: FeedbackSummarizeCampaignV2JobData,
    options: FeedbackCampaignSummaryRunOptions,
  ): Promise<FeedbackCampaignSummaryRunOutcome> {
    const claimResult = await this.database.transaction((transaction) =>
      this.campaigns.tryClaimSummaryExecution(transaction, {
        campaignId: input.campaignId,
        attempt: input.attempt,
        leaseMs: FEEDBACK_SUMMARY_EXECUTION_LEASE_MS,
      }),
    );
    if (claimResult.outcome === "busy") {
      return "claim_busy";
    }
    if (claimResult.outcome === "stale") {
      return "skipped_stale";
    }

    const { claim } = claimResult;
    const heartbeat = this.startExecutionHeartbeat(claim);
    try {
      const summary = await this.campaigns.findSummaryByCampaignId(
        input.campaignId,
      );
      if (
        !summary ||
        summary.status !== "pending" ||
        summary.attempt !== input.attempt
      ) {
        return "skipped_stale";
      }

      // Automatic summaries remain suppressed so a retained all-closed job
      // cannot smuggle a Terra call into a deterministic or Luna rehearsal.
      // An explicit admin request is different: the manual trigger is durable
      // evidence that the operator chose the separately billed summary call.
      if (this.simulatorEnabled && summary.trigger !== "manual") {
        const marked = await this.markClaimedFailure(
          claim,
          "disabled_in_simulator",
        );
        if (!marked) {
          return "claim_busy";
        }
        this.logger.warn({
          event: "feedback_campaign.summary_run_suppressed_simulator",
          campaignId: input.campaignId,
          correlationId: input.correlationId,
          attempt: input.attempt,
        });
        return "completed";
      }

      try {
        const campaign = await this.requireCampaign(input.campaignId);
        const questionSet = getPostEventFeedbackQuestionSet(
          campaign.questionSetVersion,
        );
        const answers = await this.results.listAnswersByCampaign(
          input.campaignId,
        );
        const notes = await this.results.listNotesByCampaign(input.campaignId);
        const attention =
          await this.conversations.listAttentionEvidenceForCampaign(
            input.campaignId,
          );
        const participantIds = [
          ...new Set(
            [
              ...answers.flatMap((answer) => [
                answer.respondentParticipantId,
                answer.subjectParticipantId,
              ]),
              ...notes.flatMap((note) => [
                note.respondentParticipantId,
                note.subjectParticipantId,
              ]),
              ...attention.map((item) => item.respondentParticipantId),
            ].filter((id): id is string => Boolean(id)),
          ),
        ];
        const rows = await this.participants.findByIds(participantIds);
        const displayNames = new Map(rows.map((row) => [row.id, row]));

        const summaries = await this.conversations.listForCampaign(
          input.campaignId,
        );
        const closedConversationCount = summaries.filter(
          (item) => item.lifecycle.state === "closed",
        ).length;

        const metrics = buildFeedbackCampaignSummaryMetrics({
          questionSetVersion: questionSet.version,
          questionDefinitions: questionSet.answerQuestions,
          answers,
        });
        const prompt = buildFeedbackCampaignSummaryPrompt({
          questionSetVersion: questionSet.version,
          questionDefinitions: questionSet.answerQuestions,
          isPartial: summary.isPartial,
          openConversationCount: summary.openConversationCount,
          closedConversationCount,
          answers,
          notes,
          displayNames,
          metrics,
          attention,
        });

        const narrative = await this.generateSummary(prompt, claim);
        const body = serializeFeedbackCampaignSummaryDocument(
          buildFeedbackCampaignSummaryDocument({ metrics, narrative }),
        );
        if (body.length > FEEDBACK_SUMMARY_BODY_MAX_LENGTH) {
          throw new FeedbackSummaryGenerationError(false, "response_too_long");
        }
        const ready = await this.database.transaction((transaction) =>
          this.campaigns.markSummaryReady(transaction, {
            claim,
            body,
            model: this.model,
            reasoningEffort: this.reasoningEffort,
            answerCount: answers.length,
            noteCount: notes.length,
            generatedAt: new Date(),
          }),
        );
        return ready ? "completed" : "claim_busy";
      } catch (error) {
        if (error instanceof FeedbackSummaryExecutionSupersededError) {
          return "claim_busy";
        }

        const detail = classifySummaryFailureDetail(error);
        const retryable = isSummaryFailureRetryable(error);
        if (!retryable || options.terminalOnFailure) {
          const marked = await this.markClaimedFailure(claim, detail);
          if (!marked) {
            return "claim_busy";
          }
        }
        if (!retryable) {
          throw new FeedbackSummaryGenerationError(false, detail);
        }
        throw error;
      }
    } finally {
      await heartbeat.stop();
      await this.database.transaction((transaction) =>
        this.campaigns.releaseSummaryExecutionClaim(transaction, claim),
      );
    }
  }

  private async markClaimedFailure(
    claim: FeedbackCampaignSummaryExecutionClaim,
    detail: string,
  ): Promise<boolean> {
    const failed = await this.database.transaction((transaction) =>
      this.campaigns.markSummaryFailed(transaction, {
        claim,
        error: detail.slice(0, 2_000),
        generatedAt: new Date(),
      }),
    );
    return failed !== undefined;
  }

  private async generateSummary(
    prompt: string,
    claim: FeedbackCampaignSummaryExecutionClaim,
  ) {
    const model = this.resolveProviderModel();
    const result = await this.providerCalls.run(async () => {
      // Renew after the deployment-wide limiter grants capacity, immediately
      // before provider entry. The new seven-minute horizon outlives the
      // provider's five-minute timeout even if the periodic heartbeat dies.
      const renewed = await this.database.transaction((transaction) =>
        this.campaigns.renewSummaryExecutionClaim(
          transaction,
          claim,
          FEEDBACK_SUMMARY_EXECUTION_LEASE_MS,
        ),
      );
      if (!renewed) {
        throw new FeedbackSummaryExecutionSupersededError();
      }
      return generateObject({
        model,
        schema: feedbackCampaignSummaryNarrativeSchema,
        schemaName: "feedback_campaign_summary_narrative",
        schemaDescription:
          "Short Greek operator lists for a post-event feedback campaign summary. Metrics are counted separately and must not be restated here.",
        messages: [{ role: "user", content: prompt }],
        maxOutputTokens: 4_096,
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(FEEDBACK_SUMMARY_TIMEOUT_MILLISECONDS),
        providerOptions: {
          openai: { reasoningEffort: this.reasoningEffort },
        },
      });
    });
    return feedbackCampaignSummaryNarrativeSchema.parse(result.object);
  }

  private startExecutionHeartbeat(
    claim: FeedbackCampaignSummaryExecutionClaim,
    intervalMs = FEEDBACK_SUMMARY_EXECUTION_HEARTBEAT_MS,
  ): FeedbackSummaryExecutionHeartbeat {
    let stopped = false;
    let renewalRunning = false;
    let pendingRenewal: Promise<void> = Promise.resolve();
    const renew = (): void => {
      if (stopped || renewalRunning) {
        return;
      }
      renewalRunning = true;
      pendingRenewal = this.database
        .transaction((transaction) =>
          this.campaigns.renewSummaryExecutionClaim(
            transaction,
            claim,
            FEEDBACK_SUMMARY_EXECUTION_LEASE_MS,
          ),
        )
        .then((renewed) => {
          if (!renewed) {
            this.logger.warn({
              event: "feedback.summary_execution.heartbeat_lost",
              campaignId: claim.campaignId,
              attempt: claim.attempt,
              epoch: claim.epoch,
            });
          }
        })
        .catch((error: unknown) => {
          this.logger.error({
            event: "feedback.summary_execution.heartbeat_failed",
            campaignId: claim.campaignId,
            attempt: claim.attempt,
            epoch: claim.epoch,
            error: { name: error instanceof Error ? error.name : "Error" },
          });
        })
        .finally(() => {
          renewalRunning = false;
        });
    };
    const timer = setInterval(renew, intervalMs);
    timer.unref();
    return {
      stop: async () => {
        stopped = true;
        clearInterval(timer);
        await pendingRenewal;
      },
    };
  }

  private resolveProviderModel(): LanguageModel {
    const adapter = assistantModelAdapter(this.model);
    if (adapter.provider !== "openai") {
      throw new FeedbackSummaryGenerationError(
        false,
        "summary_requires_openai_direct",
      );
    }
    if (!this.openAiProvider) {
      throw new FeedbackSummaryGenerationError(false, "missing_openai_key");
    }
    return this.openAiProvider(adapter.providerModelId);
  }

  private async requireCampaign(
    campaignId: string,
  ): Promise<FeedbackCampaignRow> {
    const campaign = await this.campaigns.findCampaignById(campaignId);
    if (!campaign) {
      throw new FeedbackCampaignNotFoundError(campaignId);
    }
    return campaign;
  }
}

export function resolveFeedbackSummaryModel(
  configured: string | undefined,
): AssistantModel {
  const candidate = configured?.trim() || DEFAULT_FEEDBACK_SUMMARY_MODEL;
  const parsed = assistantModelSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(`Unknown FEEDBACK_SUMMARY_MODEL: ${candidate}`);
  }
  if (assistantModelAdapter(parsed.data).provider !== "openai") {
    throw new Error(
      `FEEDBACK_SUMMARY_MODEL must route OpenAI direct: ${candidate}`,
    );
  }
  return parsed.data;
}

export function resolveFeedbackSummaryReasoningEffort(
  configured: string | undefined,
): FeedbackSummaryReasoningEffort {
  const candidate =
    configured?.trim() || DEFAULT_FEEDBACK_SUMMARY_REASONING_EFFORT;
  if (
    !(FEEDBACK_SUMMARY_REASONING_EFFORTS as readonly string[]).includes(
      candidate,
    )
  ) {
    throw new Error(`Unknown FEEDBACK_SUMMARY_REASONING_EFFORT: ${candidate}`);
  }
  return candidate as FeedbackSummaryReasoningEffort;
}

function summaryNeedsFinalRefresh(
  summary: FeedbackSummaryRecoveryCandidate["summary"],
  latestClosedAt: Date,
): boolean {
  return (
    !summary ||
    summary.isPartial ||
    summary.openConversationCount > 0 ||
    summary.requestedAt < latestClosedAt
  );
}

function toSummaryView(
  summary: FeedbackCampaignSummaryRow | undefined,
): FeedbackCampaignSummaryView {
  if (!summary) {
    return {
      status: "none",
      body: null,
      document: null,
      model: null,
      reasoningEffort: null,
      isPartial: false,
      trigger: null,
      error: null,
      attempt: null,
      openConversationCount: null,
      answerCount: null,
      noteCount: null,
      requestedAt: null,
      generatedAt: null,
      executionEpoch: null,
      claimExpiresAt: null,
    };
  }

  return {
    status: summary.status as FeedbackCampaignSummaryView["status"],
    body: summary.body,
    document: parseFeedbackCampaignSummaryDocument(summary.body),
    model: summary.model,
    reasoningEffort: summary.reasoningEffort,
    isPartial: summary.isPartial,
    trigger: summary.trigger as FeedbackCampaignSummaryView["trigger"],
    error: summary.error,
    attempt: summary.attempt,
    openConversationCount: summary.openConversationCount,
    answerCount: summary.answerCount,
    noteCount: summary.noteCount,
    requestedAt: summary.requestedAt.toISOString(),
    generatedAt: summary.generatedAt?.toISOString() ?? null,
    executionEpoch: summary.executionEpoch,
    claimExpiresAt: summary.claimExpiresAt?.toISOString() ?? null,
  };
}

function classifySummaryFailureDetail(error: unknown): string {
  if (error instanceof FeedbackSummaryGenerationError) {
    return error.detail || "generation_failed";
  }
  if (APICallError.isInstance(error)) {
    if (
      error.statusCode !== undefined &&
      FEEDBACK_PROVIDER_ACCOUNT_FAULT_STATUS_CODES.includes(error.statusCode)
    ) {
      return `provider_account_fault_${error.statusCode}`;
    }
    return error.isRetryable ? "provider_retryable" : "provider_rejected";
  }
  if (RetryError.isInstance(error)) {
    return isRetryableProviderError(error.lastError)
      ? "provider_retryable"
      : "provider_rejected";
  }
  if (NoContentGeneratedError.isInstance(error)) {
    return "empty_response";
  }
  return "unknown";
}

function isSummaryFailureRetryable(error: unknown): boolean {
  if (error instanceof FeedbackSummaryGenerationError) {
    return error.retryable;
  }
  if (APICallError.isInstance(error)) {
    if (
      error.statusCode !== undefined &&
      FEEDBACK_PROVIDER_ACCOUNT_FAULT_STATUS_CODES.includes(error.statusCode)
    ) {
      return false;
    }
    return error.isRetryable;
  }
  if (RetryError.isInstance(error)) {
    return isRetryableProviderError(error.lastError);
  }
  if (NoContentGeneratedError.isInstance(error)) {
    return true;
  }
  return true;
}
