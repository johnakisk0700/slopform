import { randomUUID } from "node:crypto";

import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Queue } from "bullmq";

import type { Environment } from "../../infrastructure/config/environment.js";
import { FEEDBACK_QUEUE } from "../../infrastructure/queue/queue.constants.js";
import { FeedbackConversationRepository } from "../conversations/feedback-conversation.repository.js";
import { FEEDBACK_CONVERSATION_MAX_MESSAGES } from "../conversations/feedback-conversation.schemas.js";
import { EventsRepository } from "../events/events.repository.js";
import { EventsService } from "../events/events.service.js";
import { ParticipantsRepository } from "../participants/participants.repository.js";
import {
  assistantModelSchema,
  type AssistantModel,
} from "../assistant/assistant.schemas.js";
import { feedbackPhoneE164ToChatJid } from "./feedback-simulator-phone.js";
import {
  feedbackSimulatorCandidateSlotSchema,
  feedbackSimulatorRubricSchema,
  type FeedbackSimulatorCandidateSlot,
  type FeedbackSimulatorCatalogResponseDto,
  type FeedbackSimulatorPreflightInput,
  type FeedbackSimulatorPreflightView,
  type FeedbackSimulatorRunStage,
  type FeedbackSimulatorRunView,
  type FeedbackSimulatorThreadResponseDto,
  type InjectFeedbackSimulatorMessageResponseDto,
  type StartFeedbackSimulatorRunInput,
} from "./feedback-simulator.schemas.js";
import { FeedbackOutboundTranscriptService } from "./feedback-outbound-transcript.service.js";
import {
  PostEventFeedbackEnqueueError,
  PostEventFeedbackIngressService,
  type RecordObservedMessageResult,
} from "./post-event-feedback-ingress.service.js";
import { resolveFeedbackExtractionModel } from "./post-event-feedback-extraction.service.js";
import {
  createFeedbackClosingDedupeKey,
  createFeedbackFallbackDedupeKey,
  createFeedbackHandoffDedupeKey,
  createFeedbackReplyDedupeKey,
} from "./post-event-feedback-extraction.schemas.js";
import {
  POST_EVENT_FEEDBACK_REAL_MODEL_CORPUS,
  type PostEventFeedbackRealModelCorpusCase,
} from "./post-event-feedback-real-model-corpus.js";
import { POST_EVENT_FEEDBACK_ANSWER_QUESTION_KEYS } from "./post-event-feedback-question-set.js";
import {
  boundObservedMessageText,
  createFeedbackExtractJobId,
  FEEDBACK_EXTRACT_QUIET_WINDOW_MS,
  type FeedbackJobData,
  type FeedbackJobName,
} from "./post-event-feedback.schemas.js";
import { PostEventFeedbackRepository } from "./post-event-feedback.repository.js";

const FEEDBACK_SIMULATOR_RUN_LIMIT = 100;
const FEEDBACK_SIMULATOR_NON_MODEL_SCENARIO_IDS = new Set([
  "number_changed_owner",
  "refuses_a_question",
  "discloses_as_the_very_last_thing",
]);
export const FEEDBACK_SIMULATOR_EVAL_MODELS = [
  "openai/gpt-5.6-luna",
  "qwen/qwen3.7-max",
] as const satisfies readonly AssistantModel[];

interface FeedbackSimulatorRunRecord {
  readonly id: string;
  readonly correlationId: string;
  readonly campaignId: string;
  readonly conversationId: string;
  readonly scenarioId: string;
  readonly scenarioTitle: string;
  readonly phoneE164: string;
  readonly expectedModel: AssistantModel;
  readonly configuredModel: AssistantModel;
  readonly startedAt: Date;
  readonly baselineMessageCount: number;
  readonly baselineOutboxCount: number;
  readonly totalMessages: number;
  readonly targetCursorSeq: number;
  readonly candidateBindings: readonly {
    readonly slot: FeedbackSimulatorCandidateSlot;
    readonly participantId: string;
    readonly displayName: string;
  }[];
  readonly renderedMessages: readonly string[];
  readonly rubric: FeedbackSimulatorRunView["rubric"];
  readonly ingressIds: string[];
  injectionError: string | null;
}

interface FeedbackSimulatorExtractionJobs {
  readonly active: boolean;
  readonly pending: boolean;
  readonly failedReason: string | null;
  readonly nextExtractionAt: Date | null;
}

export class FeedbackSimulatorScenarioNotFoundError extends Error {
  constructor(id: string) {
    super(`Unknown feedback simulator scenario: ${id}`);
    this.name = FeedbackSimulatorScenarioNotFoundError.name;
  }
}

export class FeedbackSimulatorRunNotFoundError extends Error {
  constructor(id: string) {
    super(`Feedback simulator run ${id} was not found`);
    this.name = FeedbackSimulatorRunNotFoundError.name;
  }
}

export class FeedbackSimulatorRunRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = FeedbackSimulatorRunRejectedError.name;
  }
}

@Injectable()
export class FeedbackSimulatorService {
  private readonly runs = new Map<string, FeedbackSimulatorRunRecord>();
  private readonly reservedConversationIds = new Set<string>();

  constructor(
    @InjectQueue(FEEDBACK_QUEUE)
    private readonly queue: Queue<FeedbackJobData, void, FeedbackJobName>,
    private readonly config: ConfigService<Environment, true>,
    private readonly ingress: PostEventFeedbackIngressService,
    private readonly repository: PostEventFeedbackRepository,
    private readonly conversations: FeedbackConversationRepository,
    private readonly events: EventsRepository,
    private readonly eventsService: EventsService,
    private readonly participants: ParticipantsRepository,
    private readonly outboundTranscript: FeedbackOutboundTranscriptService,
  ) {}

  getCatalog(): FeedbackSimulatorCatalogResponseDto {
    this.assertEnabled();
    return {
      activeModel: this.configuredModel(),
      availableModels: [...FEEDBACK_SIMULATOR_EVAL_MODELS],
      quietWindowMs: FEEDBACK_EXTRACT_QUIET_WINDOW_MS,
      timingPolicy: "single_quiet_window_batch",
      scenarios: POST_EVENT_FEEDBACK_REAL_MODEL_CORPUS.filter(
        isFeedbackSimulatorEligibleScenario,
      ).map((scenario) => ({
        id: scenario.id,
        title: scenario.title,
        messageCount: scenario.messages.length,
        requiredCandidateCount: scenario.requiredCandidateCount,
        rubric: feedbackSimulatorRubricSchema.parse(scenario.rubric),
      })),
    };
  }

  async preflightScenarioRun(
    input: FeedbackSimulatorPreflightInput,
    correlationId: string,
  ): Promise<FeedbackSimulatorPreflightView> {
    this.assertEnabled();
    const { configuredModel, scenario } = this.resolveScenarioSelection(input);
    const workers = await this.queue.getWorkers();
    const workerRegistered = workers.length > 0;
    const [campaign, conversation] = await Promise.all([
      this.repository.findCampaignById(input.campaignId),
      this.conversations.findById(input.conversationId),
    ]);
    if (!campaign || !conversation) {
      throw new FeedbackSimulatorRunRejectedError(
        "The selected campaign or conversation no longer exists.",
      );
    }
    if (conversation.campaignId !== campaign.id) {
      throw new FeedbackSimulatorRunRejectedError(
        "The selected conversation does not belong to this campaign.",
      );
    }

    const [
      event,
      participant,
      candidates,
      answers,
      notes,
      outbox,
      ingress,
      simulatedSends,
    ] = await Promise.all([
      this.events.findById(campaign.eventId),
      this.participants.findById(conversation.respondentParticipantId),
      this.eventsService.listFeedbackCandidatesForRespondent(
        campaign.eventId,
        conversation.respondentParticipantId,
      ),
      this.repository.listAnswersByConversation(conversation._id),
      this.repository.listNotesByConversation(conversation._id),
      this.repository.listOutboxByConversation(conversation._id),
      this.repository.listIngressByPhoneE164(conversation.phoneAtLaunch),
      this.repository.listSimOutboundByPhoneE164(conversation.phoneAtLaunch),
    ]);

    if (event?.status !== "finished") {
      throw new FeedbackSimulatorRunRejectedError(
        "Real-model simulation requires a campaign for a finished event.",
      );
    }
    if (campaign.status !== "launched") {
      throw new FeedbackSimulatorRunRejectedError(
        "Real-model simulation requires a launched campaign.",
      );
    }
    if (
      conversation.lifecycle.state !== "open" ||
      conversation.control.mode !== "bot"
    ) {
      throw new FeedbackSimulatorRunRejectedError(
        "Real-model simulation requires an open conversation under bot control.",
      );
    }
    if (participant?.postEventFeedbackWhatsappOptIn !== true) {
      throw new FeedbackSimulatorRunRejectedError(
        "The selected participant is not currently opted in to post-event feedback.",
      );
    }

    const usableIntroRows = outbox.filter(
      (row) => row.kind === "intro" && row.status === "sent",
    );
    if (usableIntroRows.length !== 1 || outbox.length !== 1) {
      throw new FeedbackSimulatorRunRejectedError(
        "A clean simulator baseline requires exactly one intro outbox row and no reminder, reply, staff, or system outbox rows.",
      );
    }
    const intro = usableIntroRows[0];
    if (!intro) {
      throw new FeedbackSimulatorRunRejectedError(
        "The selected conversation has no usable intro outbox row.",
      );
    }
    if (!simulatedSends.some((row) => row.outboxId === intro.id)) {
      throw new FeedbackSimulatorRunRejectedError(
        "The intro outbox is marked sent but is missing from the simulated transport sink.",
      );
    }
    const introTranscriptRepairRequired = !conversation.messages.some(
      (message) => message.outboxId === intro.id,
    );
    const transcriptIsClean = conversation.messages.every(
      (message) => message.actor === "bot" && message.outboxId === intro.id,
    );
    if (
      answers.length > 0 ||
      notes.length > 0 ||
      !transcriptIsClean ||
      conversation.messages.length > 1 ||
      conversation.extraction.cursorSeq !== 0 ||
      !hasCleanSimulatorGoals(conversation.goals) ||
      conversation.needsAttention
    ) {
      throw new FeedbackSimulatorRunRejectedError(
        "The selected conversation is not a clean intro baseline. It already contains testimony, extraction state, non-intro transcript messages, results, or attention state.",
      );
    }
    if (ingress.some((row) => row.processingStatus === "pending")) {
      throw new FeedbackSimulatorRunRejectedError(
        "The selected phone has pending ingress that could contaminate this run. Wait for it to settle before starting a scenario.",
      );
    }
    const effectiveMessageCount =
      conversation.messages.length + (introTranscriptRepairRequired ? 1 : 0);
    if (
      effectiveMessageCount + scenario.messages.length >
      FEEDBACK_CONVERSATION_MAX_MESSAGES
    ) {
      throw new FeedbackSimulatorRunRejectedError(
        "The selected scenario would exceed the conversation transcript limit.",
      );
    }
    if (candidates.items.length < scenario.requiredCandidateCount) {
      throw new FeedbackSimulatorRunRejectedError(
        `Scenario ${scenario.id} requires ${scenario.requiredCandidateCount} live candidates, but this event offers ${candidates.items.length} for the selected respondent.`,
      );
    }

    const candidateBindings = candidates.items
      .slice(0, scenario.requiredCandidateCount)
      .map((candidate, index) => ({
        slot: feedbackSimulatorCandidateSlotSchema.parse(
          `candidate${index + 1}`,
        ),
        participantId: candidate.participantId,
        displayName: candidate.displayName,
      }));

    return {
      correlationId,
      eventId: campaign.eventId,
      campaignId: campaign.id,
      conversationId: conversation._id,
      respondentParticipantId: conversation.respondentParticipantId,
      scenarioId: scenario.id,
      scenarioTitle: scenario.title,
      model: {
        expected: input.expectedModel,
        configured: configuredModel,
      },
      workerRegistered,
      timingPolicy: "single_quiet_window_batch",
      baseline: {
        clean: true,
        currentMessageCount: conversation.messages.length,
        effectiveMessageCount,
        introTranscriptRepairRequired,
      },
      candidateBindings,
      renderedMessages: scenario.messages.map((message) =>
        renderFeedbackSimulatorTemplate(
          message.textTemplate,
          candidateBindings,
        ),
      ),
      rubric: feedbackSimulatorRubricSchema.parse(scenario.rubric),
      warning: workerRegistered
        ? "The confirmed run makes paid provider calls (one extraction plus one or more attention-classification batches), permanently consumes this clean conversation, and does not clean up normal persisted outputs."
        : "Read-only baseline validation passed, but no feedback worker is registered in Redis. Start requires the worker and will reject before any repair or ingress write.",
    };
  }

  async startScenarioRun(
    input: StartFeedbackSimulatorRunInput,
    correlationId: string,
  ): Promise<FeedbackSimulatorRunView> {
    this.assertEnabled();
    if (input.confirmPaidRun !== true) {
      throw new FeedbackSimulatorRunRejectedError(
        "Explicit paid-run confirmation is required. This can make multiple calls to the configured real model and permanently consumes the selected clean conversation.",
      );
    }
    const { configuredModel, scenario } = this.resolveScenarioSelection(input);

    if (
      this.reservedConversationIds.has(input.conversationId) ||
      [...this.runs.values()].some(
        (run) => run.conversationId === input.conversationId,
      )
    ) {
      throw new FeedbackSimulatorRunRejectedError(
        "This conversation already has a simulator run. Use a separate conversation with an equivalent clean baseline; candidate bindings can differ.",
      );
    }
    this.reservedConversationIds.add(input.conversationId);

    try {
      // Re-run the read-only preflight inside the reservation immediately
      // before any repair or ingress write. The CLI also calls it separately
      // for preview, but that earlier result is not a write-time guarantee.
      const preflight = await this.preflightScenarioRun(input, correlationId);
      if (!preflight.workerRegistered) {
        throw new FeedbackSimulatorRunRejectedError(
          "No feedback worker is registered in Redis. Start it before the confirmed run; no transcript repair or ingress write was performed.",
        );
      }

      const [campaign, initialConversation] = await Promise.all([
        this.repository.findCampaignById(input.campaignId),
        this.conversations.findById(input.conversationId),
      ]);
      if (!campaign || !initialConversation) {
        throw new FeedbackSimulatorRunRejectedError(
          "The selected campaign or conversation no longer exists.",
        );
      }
      if (initialConversation.campaignId !== campaign.id) {
        throw new FeedbackSimulatorRunRejectedError(
          "The selected conversation does not belong to this campaign.",
        );
      }

      const [
        event,
        participant,
        candidates,
        answers,
        notes,
        outbox,
        ingress,
        simulatedSends,
      ] = await Promise.all([
        this.events.findById(campaign.eventId),
        this.participants.findById(initialConversation.respondentParticipantId),
        this.eventsService.listFeedbackCandidatesForRespondent(
          campaign.eventId,
          initialConversation.respondentParticipantId,
        ),
        this.repository.listAnswersByConversation(initialConversation._id),
        this.repository.listNotesByConversation(initialConversation._id),
        this.repository.listOutboxByConversation(initialConversation._id),
        this.repository.listIngressByPhoneE164(
          initialConversation.phoneAtLaunch,
        ),
        this.repository.listSimOutboundByPhoneE164(
          initialConversation.phoneAtLaunch,
        ),
      ]);

      let conversation = initialConversation;
      const usableIntroRows = outbox.filter(
        (row) => row.kind === "intro" && row.status === "sent",
      );
      const intro = usableIntroRows[0];
      const transcriptIsClean =
        intro !== undefined &&
        conversation.messages.every(
          (message) => message.actor === "bot" && message.outboxId === intro.id,
        );
      if (
        usableIntroRows.length !== 1 ||
        outbox.length !== 1 ||
        !intro ||
        !simulatedSends.some((row) => row.outboxId === intro.id) ||
        !transcriptIsClean ||
        conversation.messages.length > 1 ||
        conversation.extraction.cursorSeq !== 0 ||
        !hasCleanSimulatorGoals(conversation.goals)
      ) {
        throw new FeedbackSimulatorRunRejectedError(
          "The write-time baseline changed after preflight. It must still have one sent intro in the simulated sink, only a matching intro transcript entry, pending goals, and extraction cursor 0.",
        );
      }
      const missingIntroRows = conversation.messages.some(
        (message) => message.outboxId === intro.id,
      )
        ? []
        : [intro];
      for (const intro of missingIntroRows) {
        const repair = await this.outboundTranscript.record(
          intro,
          intro.createdAt,
          correlationId,
        );
        if (repair.outcome === "cancelled") {
          throw new FeedbackSimulatorRunRejectedError(
            `The existing intro could not be repaired into the transcript (${repair.reason}). Use another clean conversation.`,
          );
        }
      }
      if (missingIntroRows.length > 0) {
        const repairedConversation = await this.conversations.findById(
          initialConversation._id,
        );
        if (!repairedConversation) {
          throw new FeedbackSimulatorRunRejectedError(
            "The selected conversation disappeared while its intro transcript was being repaired.",
          );
        }
        conversation = repairedConversation;
      }

      if (event?.status !== "finished") {
        throw new FeedbackSimulatorRunRejectedError(
          "Real-model simulation requires a campaign for a finished event.",
        );
      }
      if (campaign.status !== "launched") {
        throw new FeedbackSimulatorRunRejectedError(
          "Real-model simulation requires a launched campaign.",
        );
      }
      if (
        conversation.lifecycle.state !== "open" ||
        conversation.control.mode !== "bot"
      ) {
        throw new FeedbackSimulatorRunRejectedError(
          "Real-model simulation requires an open conversation under bot control.",
        );
      }
      if (participant?.postEventFeedbackWhatsappOptIn !== true) {
        throw new FeedbackSimulatorRunRejectedError(
          "The selected participant is not currently opted in to post-event feedback.",
        );
      }
      if (
        answers.length > 0 ||
        notes.length > 0 ||
        conversation.messages.some(
          (message) =>
            message.actor === "participant" || message.actor === "staff",
        ) ||
        conversation.needsAttention
      ) {
        throw new FeedbackSimulatorRunRejectedError(
          "The selected conversation already contains testimony, staff intervention, results, or attention state. Use an equivalent clean baseline; this run permanently consumes the conversation.",
        );
      }
      if (ingress.some((row) => row.processingStatus === "pending")) {
        throw new FeedbackSimulatorRunRejectedError(
          "The selected phone has pending ingress that could contaminate this run. Wait for it to settle before starting a scenario.",
        );
      }
      if (
        conversation.messages.length + scenario.messages.length >
        FEEDBACK_CONVERSATION_MAX_MESSAGES
      ) {
        throw new FeedbackSimulatorRunRejectedError(
          "The selected scenario would exceed the conversation transcript limit.",
        );
      }
      if (candidates.items.length < scenario.requiredCandidateCount) {
        throw new FeedbackSimulatorRunRejectedError(
          `Scenario ${scenario.id} requires ${scenario.requiredCandidateCount} live candidates, but this event offers ${candidates.items.length} for the selected respondent.`,
        );
      }

      const candidateBindings = candidates.items
        .slice(0, scenario.requiredCandidateCount)
        .map((candidate, index) => ({
          slot: feedbackSimulatorCandidateSlotSchema.parse(
            `candidate${index + 1}`,
          ),
          participantId: candidate.participantId,
          displayName: candidate.displayName,
        }));
      const renderedMessages = scenario.messages.map((message) =>
        renderFeedbackSimulatorTemplate(
          message.textTemplate,
          candidateBindings,
        ),
      );

      const run: FeedbackSimulatorRunRecord = {
        id: randomUUID(),
        correlationId,
        campaignId: campaign.id,
        conversationId: conversation._id,
        scenarioId: scenario.id,
        scenarioTitle: scenario.title,
        phoneE164: conversation.phoneAtLaunch,
        expectedModel: input.expectedModel,
        configuredModel,
        startedAt: new Date(),
        baselineMessageCount: conversation.messages.length,
        baselineOutboxCount: outbox.length,
        totalMessages: scenario.messages.length,
        targetCursorSeq:
          conversation.messages.length + scenario.messages.length,
        candidateBindings,
        renderedMessages,
        rubric: feedbackSimulatorRubricSchema.parse(scenario.rubric),
        ingressIds: [],
        injectionError: null,
      };
      this.rememberRun(run);

      for (const message of renderedMessages) {
        try {
          const result = await this.injectObservedMessage(
            {
              phoneE164: conversation.phoneAtLaunch,
              text: message,
              fromMe: false,
            },
            correlationId,
          );
          run.ingressIds.push(result.ingressId);
        } catch (error) {
          if (error instanceof PostEventFeedbackEnqueueError) {
            run.ingressIds.push(error.ingressId);
          }
          run.injectionError = boundedErrorMessage(
            error,
            "A scenario message could not be injected.",
          );
          break;
        }
      }

      return this.getScenarioRun(run.id);
    } finally {
      this.reservedConversationIds.delete(input.conversationId);
    }
  }

  async getScenarioRun(runId: string): Promise<FeedbackSimulatorRunView> {
    const run = this.runs.get(runId);
    if (!run) {
      throw new FeedbackSimulatorRunNotFoundError(runId);
    }

    const [conversation, ingressRows, answers, notes, outbox, simulatedSends] =
      await Promise.all([
        this.conversations.findById(run.conversationId),
        Promise.all(
          run.ingressIds.map((ingressId) =>
            this.repository.findIngressById(ingressId),
          ),
        ),
        this.repository.listAnswersByConversation(run.conversationId),
        this.repository.listNotesByConversation(run.conversationId),
        this.repository.listOutboxByConversation(run.conversationId),
        this.repository.listSimOutboundByPhoneE164(run.phoneE164),
      ]);

    const extractionJobs = await this.inspectExtractionJobs(run);
    const materializedMessages = ingressRows.filter(
      (row) => row?.processingStatus === "materialized",
    ).length;
    const failedMessages = ingressRows.filter(
      (row) =>
        row !== undefined &&
        row.processingStatus !== "pending" &&
        row.processingStatus !== "materialized",
    ).length;
    const currentCursorSeq = conversation?.extraction.cursorSeq ?? 0;
    const observedModel = assistantModelSchema.safeParse(
      conversation?.extraction.model,
    );
    const expectedOutboxDedupeKeys = new Set([
      createFeedbackReplyDedupeKey(run.conversationId, run.targetCursorSeq),
      createFeedbackHandoffDedupeKey(run.conversationId, run.targetCursorSeq),
      createFeedbackFallbackDedupeKey(run.conversationId, run.targetCursorSeq),
      createFeedbackClosingDedupeKey(run.conversationId),
    ]);
    const runOutbox = outbox.filter(
      (row, index) =>
        index >= run.baselineOutboxCount &&
        expectedOutboxDedupeKeys.has(row.dedupeKey),
    );
    const runOutboxIds = new Set(runOutbox.map((row) => row.id));
    const runSimulatedSends = simulatedSends.filter((row) =>
      runOutboxIds.has(row.outboxId),
    );
    const outboxFailed = runOutbox.some((row) =>
      ["failed", "cancelled"].includes(row.status),
    );
    const outboxMissing =
      currentCursorSeq >= run.targetCursorSeq && runOutbox.length === 0;
    const outboxSettled =
      runOutbox.length > 0 &&
      runOutbox.every((row) => row.status === "sent") &&
      runSimulatedSends.length >= runOutbox.length;

    const statusInput = {
      injectionFailed: run.injectionError !== null,
      injectedMessages: run.ingressIds.length,
      totalMessages: run.totalMessages,
      materializedMessages,
      failedMessages,
      currentCursorSeq,
      targetCursorSeq: run.targetCursorSeq,
      conversationAvailable: conversation !== undefined,
      conversationOpen:
        conversation?.lifecycle.state === "open" &&
        conversation.control.mode === "bot",
      extractionActive: extractionJobs.active,
      extractionPending: extractionJobs.pending,
      extractionFailed: extractionJobs.failedReason !== null,
      outboxFailed,
      outboxMissing,
      outboxSettled,
    };
    const stage = deriveFeedbackSimulatorRunStage(statusInput);
    const modelMismatch =
      currentCursorSeq >= run.targetCursorSeq &&
      (!observedModel.success || observedModel.data !== run.expectedModel);
    const finalStage: FeedbackSimulatorRunStage = modelMismatch
      ? "failed"
      : stage;
    const error =
      run.injectionError ??
      (failedMessages > 0
        ? "At least one injected message did not materialize into the selected conversation."
        : extractionJobs.failedReason) ??
      (outboxFailed
        ? "The reply outbox created by this run failed or was cancelled before simulated delivery."
        : null) ??
      (outboxMissing
        ? "Extraction advanced the run cursor without creating the expected reply outbox."
        : null) ??
      (!conversation
        ? "The selected conversation no longer exists."
        : modelMismatch
          ? `The worker processed this run with ${conversation.extraction.model ?? "no recorded model"}, not ${run.expectedModel}. The comparison is invalid.`
          : !statusInput.conversationOpen &&
              currentCursorSeq < run.targetCursorSeq
            ? "The conversation left open bot control before the scenario was processed."
            : null);

    return {
      id: run.id,
      correlationId: run.correlationId,
      campaignId: run.campaignId,
      conversationId: run.conversationId,
      scenarioId: run.scenarioId,
      scenarioTitle: run.scenarioTitle,
      stage: finalStage,
      startedAt: run.startedAt.toISOString(),
      updatedAt: new Date().toISOString(),
      nextExtractionAt:
        finalStage === "waiting_quiet_window"
          ? (extractionJobs.nextExtractionAt?.toISOString() ?? null)
          : null,
      model: {
        expected: run.expectedModel,
        configured: run.configuredModel,
        observed: observedModel.success ? observedModel.data : null,
      },
      progress: {
        percent: feedbackSimulatorProgressPercent({
          stage: finalStage,
          injectedMessages: run.ingressIds.length,
          materializedMessages,
          totalMessages: run.totalMessages,
        }),
        totalMessages: run.totalMessages,
        injectedMessages: run.ingressIds.length,
        materializedMessages,
        failedMessages,
        targetCursorSeq: run.targetCursorSeq,
        currentCursorSeq,
      },
      outputs: {
        answers: answers.length,
        notes: notes.length,
        outboxMessages: runOutbox.length,
        simulatedSends: runSimulatedSends.length,
      },
      tokenUsage: {
        availability: "not_persisted",
        estimatedPromptTokens: null,
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
      },
      cost: {
        availability: "not_available",
        estimatedUsd: null,
        actualUsd: null,
      },
      error: error ? boundedErrorMessage(error, "Simulation failed.") : null,
      candidateBindings: [...run.candidateBindings],
      renderedMessages: [...run.renderedMessages],
      rubric: run.rubric,
    };
  }

  async injectObservedMessage(
    input: {
      readonly phoneE164: string;
      readonly text: string;
      readonly fromMe: boolean;
    },
    correlationId: string,
  ): Promise<InjectFeedbackSimulatorMessageResponseDto> {
    this.assertEnabled();
    const observedAt = new Date();
    const providerMessageId = `sim-inject-${randomUUID()}`;
    const chatJid = feedbackPhoneE164ToChatJid(input.phoneE164);

    const result: RecordObservedMessageResult =
      await this.ingress.recordObservedMessage(
        {
          providerMessageId,
          chatJid,
          direction: input.fromMe ? "outbound" : "inbound",
          phoneE164: input.phoneE164,
          text: boundObservedMessageText(input.text),
          observedAt,
        },
        correlationId,
      );

    return {
      ingressId: result.ingressId,
      inserted: result.inserted,
    };
  }

  async getThreadByPhone(
    phoneE164: string,
  ): Promise<FeedbackSimulatorThreadResponseDto> {
    this.assertEnabled();
    const [ingressRows, outboundRows] = await Promise.all([
      this.repository.listIngressByPhoneE164(phoneE164),
      this.repository.listSimOutboundByPhoneE164(phoneE164),
    ]);

    const messages = [
      ...ingressRows
        .filter((row) => row.text !== null)
        .map((row) => ({
          id: `ingress:${row.id}`,
          source: "ingress" as const,
          direction: row.direction as "inbound" | "outbound",
          text: row.text as string,
          occurredAt: row.observedAt.toISOString(),
          ingressId: row.id,
        })),
      ...outboundRows.map((row) => ({
        id: `sim-outbound:${row.id}`,
        source: "sim_outbound" as const,
        direction: "outbound" as const,
        text: row.body,
        occurredAt: row.sentAt.toISOString(),
        outboxId: row.outboxId,
      })),
    ].sort((left, right) => {
      const byTime = left.occurredAt.localeCompare(right.occurredAt);
      return byTime !== 0 ? byTime : left.id.localeCompare(right.id);
    });

    return { phoneE164, messages };
  }

  private configuredModel(): AssistantModel {
    const configured = this.config.get("FEEDBACK_EXTRACTION_MODEL", {
      infer: true,
    });
    return resolveFeedbackExtractionModel(configured);
  }

  private resolveScenarioSelection(input: FeedbackSimulatorPreflightInput): {
    readonly configuredModel: AssistantModel;
    readonly scenario: PostEventFeedbackRealModelCorpusCase;
  } {
    const scenario = POST_EVENT_FEEDBACK_REAL_MODEL_CORPUS.find(
      (candidate) => candidate.id === input.scenarioId,
    );
    if (!scenario) {
      throw new FeedbackSimulatorScenarioNotFoundError(input.scenarioId);
    }
    if (!isFeedbackSimulatorSingleTurnScenario(scenario)) {
      throw new FeedbackSimulatorRunRejectedError(
        `Scenario ${scenario.id} spans more than one extraction quiet window. This runner deliberately exposes only single-window cases; compressing a multi-turn rubric into one burst would invalidate it.`,
      );
    }
    if (FEEDBACK_SIMULATOR_NON_MODEL_SCENARIO_IDS.has(scenario.id)) {
      throw new FeedbackSimulatorRunRejectedError(
        `Scenario ${scenario.id} is not valid for the runner's clean intro baseline and one real extraction call, so it is excluded.`,
      );
    }
    if (
      !FEEDBACK_SIMULATOR_EVAL_MODELS.some(
        (model) => model === input.expectedModel,
      )
    ) {
      throw new FeedbackSimulatorRunRejectedError(
        `Real-model simulation is scoped to ${FEEDBACK_SIMULATOR_EVAL_MODELS.join(" and ")}.`,
      );
    }

    const configuredModel = this.configuredModel();
    if (input.expectedModel !== configuredModel) {
      throw new FeedbackSimulatorRunRejectedError(
        `The API is configured for ${configuredModel}. Restart the API and worker with FEEDBACK_EXTRACTION_MODEL=${input.expectedModel} before starting this run.`,
      );
    }
    return { configuredModel, scenario };
  }

  private assertEnabled(): void {
    if (
      this.config.get("NODE_ENV", { infer: true }) === "production" ||
      this.config.get("FEEDBACK_SIMULATOR_ENABLED", { infer: true }) !== true ||
      this.config.get("TRANSPORT_MODE", { infer: true }) !== "simulated"
    ) {
      throw new FeedbackSimulatorRunRejectedError(
        "The feedback simulator requires non-production, FEEDBACK_SIMULATOR_ENABLED=true, and TRANSPORT_MODE=simulated.",
      );
    }
  }

  private rememberRun(run: FeedbackSimulatorRunRecord): void {
    while (this.runs.size >= FEEDBACK_SIMULATOR_RUN_LIMIT) {
      const oldest = this.runs.keys().next().value as string | undefined;
      if (!oldest) {
        break;
      }
      this.runs.delete(oldest);
    }
    this.runs.set(run.id, run);
  }

  private async inspectExtractionJobs(
    run: FeedbackSimulatorRunRecord,
  ): Promise<FeedbackSimulatorExtractionJobs> {
    const jobIds = Array.from({ length: run.totalMessages }, (_entry, index) =>
      createFeedbackExtractJobId(
        run.conversationId,
        run.baselineMessageCount + index + 1,
      ),
    );
    const jobs = await Promise.all(
      jobIds.map((jobId) => this.queue.getJob(jobId)),
    );
    const states = await Promise.all(
      jobs.map((job) => (job ? job.getState() : Promise.resolve("unknown"))),
    );

    const active = states.includes("active");
    const pending = states.some((state) =>
      ["delayed", "waiting", "waiting-children", "prioritized"].includes(state),
    );
    const failedIndex = states.findIndex((state) => state === "failed");
    const failedReason =
      failedIndex === -1
        ? null
        : boundedErrorMessage(
            jobs[failedIndex]?.failedReason,
            "The extraction job failed.",
          );
    const delayedTimes = jobs.flatMap((job, index) => {
      if (!job || states[index] !== "delayed") {
        return [];
      }
      return [new Date(job.timestamp + Number(job.opts.delay ?? 0))];
    });

    return {
      active,
      pending,
      failedReason,
      nextExtractionAt:
        delayedTimes.length === 0
          ? null
          : delayedTimes.reduce((earliest, candidate) =>
              candidate < earliest ? candidate : earliest,
            ),
    };
  }
}

export function deriveFeedbackSimulatorRunStage(input: {
  readonly injectionFailed: boolean;
  readonly injectedMessages: number;
  readonly totalMessages: number;
  readonly materializedMessages: number;
  readonly failedMessages: number;
  readonly currentCursorSeq: number;
  readonly targetCursorSeq: number;
  readonly conversationAvailable: boolean;
  readonly conversationOpen: boolean;
  readonly extractionActive: boolean;
  readonly extractionPending: boolean;
  readonly extractionFailed: boolean;
  readonly outboxFailed: boolean;
  readonly outboxMissing: boolean;
  readonly outboxSettled: boolean;
}): FeedbackSimulatorRunStage {
  if (
    input.injectionFailed ||
    input.failedMessages > 0 ||
    !input.conversationAvailable ||
    input.extractionFailed ||
    input.outboxFailed ||
    input.outboxMissing
  ) {
    return "failed";
  }
  if (input.injectedMessages < input.totalMessages) {
    return "injecting";
  }
  if (input.materializedMessages < input.totalMessages) {
    return "materializing";
  }
  if (input.currentCursorSeq >= input.targetCursorSeq) {
    return input.outboxSettled ? "processed" : "delivering_simulated_outbox";
  }
  if (!input.conversationOpen) {
    return "failed";
  }
  if (input.extractionActive) {
    return "extracting";
  }
  if (input.extractionPending) {
    return "waiting_quiet_window";
  }
  return "waiting_quiet_window";
}

export function feedbackSimulatorProgressPercent(input: {
  readonly stage: FeedbackSimulatorRunStage;
  readonly injectedMessages: number;
  readonly materializedMessages: number;
  readonly totalMessages: number;
}): number {
  if (input.stage === "processed") {
    return 100;
  }
  if (input.stage === "delivering_simulated_outbox") {
    return 95;
  }
  const injection = Math.min(
    25,
    Math.round((input.injectedMessages / input.totalMessages) * 25),
  );
  const materialization = Math.min(
    35,
    Math.round((input.materializedMessages / input.totalMessages) * 35),
  );
  const extraction =
    input.stage === "extracting" ? 25 : input.stage === "failed" ? 0 : 0;
  return Math.min(99, injection + materialization + extraction);
}

export function isFeedbackSimulatorSingleTurnScenario(
  scenario: Pick<PostEventFeedbackRealModelCorpusCase, "messages">,
): boolean {
  const elapsedAfterFirstMessage = scenario.messages
    .slice(1)
    .reduce((elapsed, message) => elapsed + message.afterMs, 0);
  return elapsedAfterFirstMessage < FEEDBACK_EXTRACT_QUIET_WINDOW_MS;
}

function isFeedbackSimulatorEligibleScenario(
  scenario: PostEventFeedbackRealModelCorpusCase,
): boolean {
  return (
    isFeedbackSimulatorSingleTurnScenario(scenario) &&
    !FEEDBACK_SIMULATOR_NON_MODEL_SCENARIO_IDS.has(scenario.id)
  );
}

function hasCleanSimulatorGoals(
  goals: readonly {
    readonly key: string;
    readonly ordinal: number;
    readonly status: string;
  }[],
): boolean {
  return (
    goals.length === POST_EVENT_FEEDBACK_ANSWER_QUESTION_KEYS.length &&
    goals.every(
      (goal, index) =>
        goal.key === POST_EVENT_FEEDBACK_ANSWER_QUESTION_KEYS[index] &&
        goal.ordinal === index + 1 &&
        goal.status === "pending",
    )
  );
}

function boundedErrorMessage(error: unknown, fallback: string): string {
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : fallback;
  const normalized = message.trim() || fallback;
  return normalized.slice(0, 500);
}

export function renderFeedbackSimulatorTemplate(
  template: string,
  bindings: readonly {
    readonly slot: string;
    readonly displayName: string;
  }[],
): string {
  const names = new Map(
    bindings.map((binding) => [binding.slot, binding.displayName]),
  );
  return template.replace(/\{(candidate[1-7])\}/gu, (_match, slot: string) => {
    const displayName = names.get(slot);
    if (!displayName) {
      throw new FeedbackSimulatorRunRejectedError(
        `Scenario template requires an unresolved candidate slot: ${slot}.`,
      );
    }
    return displayName;
  });
}
