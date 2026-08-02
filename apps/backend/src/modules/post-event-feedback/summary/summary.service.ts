import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createOpenAI } from "@ai-sdk/openai";
import {
  APICallError,
  NoContentGeneratedError,
  RetryError,
  generateText,
  type LanguageModel,
} from "ai";
import type { Queue } from "bullmq";
import type {
  FeedbackCampaignRow,
  FeedbackCampaignSummaryRow,
  FeedbackCampaignSummaryTrigger,
} from "@join-the-six/database";

import { AuditRepository } from "../../../infrastructure/audit/audit.repository.js";
import { withProviderCallSlot } from "../../../infrastructure/ai/provider-call-limiter.js";
import type { Environment } from "../../../infrastructure/config/environment.js";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { FEEDBACK_QUEUE } from "../../../infrastructure/queue/queue.constants.js";
import {
  assistantModelAdapter,
  isRetryableProviderError,
} from "../../assistant/assistant-models.js";
import {
  assistantModelSchema,
  type AssistantModel,
} from "../../assistant/assistant.schemas.js";
import { ParticipantsRepository } from "../../participants/participants.repository.js";
import { FeedbackCampaignRepository } from "../campaign/campaign.repository.js";
import { FeedbackCampaignNotFoundError } from "../campaign/campaign.service.js";
import type { FeedbackCampaignSummaryView } from "../campaign/campaign.schemas.js";
import { FeedbackResultsRepository } from "../extraction/results.repository.js";
import { FEEDBACK_PROVIDER_ACCOUNT_FAULT_STATUS_CODES } from "../extraction/model.service.js";
import { FeedbackConversationRepository } from "../post-event-feedback-conversation.repository.js";
import {
  createFeedbackSummarizeCampaignJobId,
  FEEDBACK_JOB_NAMES,
  FEEDBACK_JOB_SCHEMA_VERSION,
  feedbackSummarizeCampaignJobDataSchema,
  parseFeedbackSummarizeCampaignAttempt,
  type FeedbackSummarizeCampaignJobData,
} from "../jobs.schemas.js";
import { getPostEventFeedbackQuestionSet } from "../question-set.js";
import { buildFeedbackCampaignSummaryPrompt } from "./prompt.js";

export const DEFAULT_FEEDBACK_SUMMARY_MODEL =
  "openai/gpt-5.6-terra" as const satisfies AssistantModel;

export const DEFAULT_FEEDBACK_SUMMARY_REASONING_EFFORT = "xhigh" as const;

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
      "Feedback campaign summaries are disabled while the simulator is enabled",
    );
    this.name = FeedbackSummaryDisabledInSimulatorError.name;
  }
}

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
    @InjectQueue(FEEDBACK_QUEUE)
    private readonly queue: Queue,
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
    if (this.simulatorEnabled) {
      throw new FeedbackSummaryDisabledInSimulatorError();
    }

    const existing = await this.campaigns.findSummaryByCampaignId(campaignId);
    if (existing?.status === "pending") {
      return toSummaryView(existing);
    }

    const openConversationCount =
      await this.conversations.countOpenForCampaign(campaignId);
    const isPartial = openConversationCount > 0;
    const attempt = (existing?.attempt ?? 0) + 1;
    const requestedAt = new Date();

    const summary = await this.database.transaction(async (transaction) => {
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

    const data = feedbackSummarizeCampaignJobDataSchema.parse({
      schemaVersion: FEEDBACK_JOB_SCHEMA_VERSION,
      campaignId,
      correlationId,
    });
    await this.queue.add(FEEDBACK_JOB_NAMES.summarizeCampaignV1, data, {
      jobId: createFeedbackSummarizeCampaignJobId(campaignId, attempt),
      attempts: 5,
      backoff: { type: "exponential", delay: 1_000 },
      removeOnComplete: 1_000,
      removeOnFail: 5_000,
      stackTraceLimit: 10,
    });

    return toSummaryView(summary);
  }

  async maybeRequestAfterConversationClosed(
    campaignId: string,
    correlationId: string,
  ): Promise<void> {
    if (this.simulatorEnabled) {
      this.logger.debug({
        event: "feedback_campaign.summary_auto_suppressed_simulator",
        campaignId,
        correlationId,
      });
      return;
    }

    const openCount = await this.conversations.countOpenForCampaign(campaignId);
    if (openCount > 0) {
      return;
    }

    const existing = await this.campaigns.findSummaryByCampaignId(campaignId);
    if (existing?.status === "pending") {
      return;
    }

    await this.request(campaignId, "all_closed", correlationId);
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
    input: FeedbackSummarizeCampaignJobData,
    jobId: string,
  ): Promise<void> {
    const attempt = parseFeedbackSummarizeCampaignAttempt(
      jobId,
      input.campaignId,
    );
    if (attempt === undefined) {
      return;
    }

    const summary = await this.campaigns.findSummaryByCampaignId(
      input.campaignId,
    );
    if (
      !summary ||
      summary.status !== "pending" ||
      summary.attempt !== attempt
    ) {
      return;
    }

    // A stale job must not smuggle a Terra call into a deterministic or Luna
    // rehearsal after the simulator gate was enabled. Mark it terminal so the
    // admin does not stare at a permanently pending row.
    if (this.simulatorEnabled) {
      await this.markTerminalFailure(
        input.campaignId,
        attempt,
        "disabled_in_simulator",
      );
      this.logger.warn({
        event: "feedback_campaign.summary_run_suppressed_simulator",
        campaignId: input.campaignId,
        correlationId: input.correlationId,
        attempt,
      });
      return;
    }

    const campaign = await this.requireCampaign(input.campaignId);
    const questionSet = getPostEventFeedbackQuestionSet(
      campaign.questionSetVersion,
    );
    const answers = await this.results.listAnswersByCampaign(input.campaignId);
    const notes = await this.results.listNotesByCampaign(input.campaignId);
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

    const prompt = buildFeedbackCampaignSummaryPrompt({
      questionSetVersion: questionSet.version,
      questionDefinitions: questionSet.answerQuestions,
      isPartial: summary.isPartial,
      openConversationCount: summary.openConversationCount,
      closedConversationCount,
      answers,
      notes,
      displayNames,
    });

    try {
      const body = await this.generateSummary(prompt);
      const generatedAt = new Date();
      await this.database.transaction(async (transaction) => {
        await this.campaigns.markSummaryReady(transaction, {
          campaignId: input.campaignId,
          attempt,
          body,
          model: this.model,
          reasoningEffort: this.reasoningEffort,
          answerCount: answers.length,
          noteCount: notes.length,
          generatedAt,
        });
      });
    } catch (error) {
      const detail = classifySummaryFailureDetail(error);
      const retryable = isSummaryFailureRetryable(error);
      // Stay `pending` on retryable failures so BullMQ can re-enter `run`.
      // Only a permanent rejection (or the processor's last attempt) may mark
      // failed — otherwise retries find a non-pending row and exit as no-ops.
      if (!retryable) {
        const generatedAt = new Date();
        await this.database.transaction(async (transaction) => {
          await this.campaigns.markSummaryFailed(transaction, {
            campaignId: input.campaignId,
            attempt,
            error: detail.slice(0, 2_000),
            generatedAt,
          });
        });
        throw new FeedbackSummaryGenerationError(false, detail);
      }
      throw error;
    }
  }

  /**
   * Terminal failure after BullMQ's last attempt: durable `failed` so the admin
   * can re-request. Safe to call when the row is no longer pending (no-op).
   */
  async markTerminalFailure(
    campaignId: string,
    attempt: number,
    detail: string,
  ): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await this.campaigns.markSummaryFailed(transaction, {
        campaignId,
        attempt,
        error: detail.slice(0, 2_000),
        generatedAt: new Date(),
      });
    });
  }

  private async generateSummary(prompt: string): Promise<string> {
    const model = this.resolveProviderModel();
    const result = await withProviderCallSlot(() =>
      generateText({
        model,
        messages: [{ role: "user", content: prompt }],
        maxOutputTokens: 8_192,
        maxRetries: 0,
        timeout: { totalMs: FEEDBACK_SUMMARY_TIMEOUT_MILLISECONDS },
        providerOptions: {
          openai: { reasoningEffort: this.reasoningEffort },
        },
      }),
    );
    const body = result.text.trim();
    if (!body) {
      throw new FeedbackSummaryGenerationError(true, "empty_response");
    }
    if (body.length > FEEDBACK_SUMMARY_BODY_MAX_LENGTH) {
      throw new FeedbackSummaryGenerationError(false, "response_too_long");
    }
    return body;
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
  const candidate = configured ?? DEFAULT_FEEDBACK_SUMMARY_MODEL;
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
  const candidate = configured ?? DEFAULT_FEEDBACK_SUMMARY_REASONING_EFFORT;
  if (
    !(FEEDBACK_SUMMARY_REASONING_EFFORTS as readonly string[]).includes(
      candidate,
    )
  ) {
    throw new Error(`Unknown FEEDBACK_SUMMARY_REASONING_EFFORT: ${candidate}`);
  }
  return candidate as FeedbackSummaryReasoningEffort;
}

function toSummaryView(
  summary: FeedbackCampaignSummaryRow | undefined,
): FeedbackCampaignSummaryView {
  if (!summary) {
    return {
      status: "none",
      body: null,
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
    };
  }

  return {
    status: summary.status as FeedbackCampaignSummaryView["status"],
    body: summary.body,
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
