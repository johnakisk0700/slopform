import { randomUUID } from "node:crypto";

import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Queue } from "bullmq";

import type { Environment } from "../../../infrastructure/config/environment.js";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { isFeedbackSimulatorEnabled } from "../../../infrastructure/config/enabled-modules.js";
import { FEEDBACK_QUEUE } from "../../../infrastructure/queue/queue.constants.js";
import { FeedbackConversationRepository } from "../post-event-feedback-conversation.repository.js";
import { FEEDBACK_CONVERSATION_MAX_MESSAGES } from "../post-event-feedback-conversation.document.js";
import { EventsRepository } from "../../events/events.repository.js";
import { EventsService } from "../../events/events.service.js";
import { ParticipantsRepository } from "../../participants/participants.repository.js";
import type { AssistantModel } from "../../assistant/assistant.schemas.js";
import { phoneE164ToChatJid } from "../../../integrations/wasender/wasender.jid.js";
import { FeedbackCampaignRepository } from "../campaign/campaign.repository.js";
import { FeedbackResultsRepository } from "../extraction/results.repository.js";
import { FeedbackConversationExecutionFenceRepository } from "../extraction/execution-fence.repository.js";
import { FeedbackIngressRepository } from "../ingress/ingress.repository.js";
import { FeedbackOutboxRepository } from "../outbox/outbox.repository.js";
import { FeedbackSimOutboundRepository } from "./sim-outbound.repository.js";
import {
  feedbackSimulatorCandidateSlotSchema,
  feedbackSimulatorRubricSchema,
  type FeedbackSimulatorCandidateSlot,
  type FeedbackSimulatorCatalogResponseDto,
  type FeedbackSimulatorPreflightInput,
  type FeedbackSimulatorPreflightView,
  type FeedbackSimulatorRunView,
  type FeedbackSimulatorThreadResponseDto,
  type InjectFeedbackSimulatorMessageResponseDto,
  type StartFeedbackSimulatorRunInput,
} from "./simulator.schemas.js";
import { FeedbackOutboundTranscriptService } from "../outbox/outbound-transcript.service.js";
import {
  PostEventFeedbackEnqueueError,
  PostEventFeedbackIngressService,
  type RecordObservedMessageResult,
} from "../ingress/ingress.service.js";
import {
  POST_EVENT_FEEDBACK_REAL_MODEL_CORPUS,
  POST_EVENT_FEEDBACK_REAL_MODEL_CORPUS_QUESTION_SET_VERSION,
  type PostEventFeedbackRealModelCorpusCase,
} from "../post-event-feedback-real-model-corpus.js";
import { getPostEventFeedbackQuestionSet } from "../question-set.js";
import {
  boundObservedMessageText,
  FEEDBACK_EXTRACT_QUIET_WINDOW_MS,
  type FeedbackJobData,
  type FeedbackJobName,
} from "../jobs.schemas.js";
import { feedbackSimulatorDurableAutomation, toRunView } from "./run-status.js";
import {
  attestFeedbackWorkers,
  resolveFeedbackWorkerControlProfile,
  type FeedbackWorkerAttestation,
  type FeedbackWorkerControlProfile,
} from "../worker-attestation.js";

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
    private readonly database: DatabaseService,
    private readonly executionFences: FeedbackConversationExecutionFenceRepository,
    private readonly config: ConfigService<Environment, true>,
    private readonly ingress: PostEventFeedbackIngressService,
    private readonly campaigns: FeedbackCampaignRepository,
    private readonly results: FeedbackResultsRepository,
    private readonly ingressRepository: FeedbackIngressRepository,
    private readonly outbox: FeedbackOutboxRepository,
    private readonly simOutbound: FeedbackSimOutboundRepository,
    private readonly conversations: FeedbackConversationRepository,
    private readonly events: EventsRepository,
    private readonly eventsService: EventsService,
    private readonly participants: ParticipantsRepository,
    private readonly outboundTranscript: FeedbackOutboundTranscriptService,
  ) {}

  async getCatalog(): Promise<FeedbackSimulatorCatalogResponseDto> {
    this.assertEnabled();
    const activeProfile = this.configuredWorkerProfile();
    const workerAttestation = await this.workerAttestation(activeProfile);
    return {
      activeModel: activeProfile.model,
      activeExtractionReasoningEffort: activeProfile.extractionReasoningEffort,
      activeReplyReasoningEffort: activeProfile.replyReasoningEffort,
      activeAttentionReasoningEffort: activeProfile.attentionReasoningEffort,
      activeServiceTier: activeProfile.serviceTier,
      activeTransportMode: "simulated",
      activeSimulatedTransport: activeProfile.simulatedTransport,
      workerAttestation,
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
    const workerAttestation = await this.workerAttestation();
    const workerRegistered = workerAttestation.status === "verified";
    const [campaign, conversation] = await Promise.all([
      this.campaigns.findCampaignById(input.campaignId),
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
    if (
      campaign.questionSetVersion !==
      POST_EVENT_FEEDBACK_REAL_MODEL_CORPUS_QUESTION_SET_VERSION
    ) {
      throw new FeedbackSimulatorRunRejectedError(
        `The paid corpus is calibrated for questionnaire V${POST_EVENT_FEEDBACK_REAL_MODEL_CORPUS_QUESTION_SET_VERSION}, but the selected campaign uses V${campaign.questionSetVersion}.`,
      );
    }

    const [
      event,
      feedbackVenue,
      participant,
      candidates,
      answers,
      notes,
      outbox,
      ingress,
      simulatedSends,
    ] = await Promise.all([
      this.events.findById(campaign.eventId),
      this.eventsService.getFeedbackVenueContext(campaign.eventId),
      this.participants.findById(conversation.respondentParticipantId),
      this.eventsService.listFeedbackCandidatesForRespondent(
        campaign.eventId,
        conversation.respondentParticipantId,
      ),
      this.results.listAnswersByConversation(conversation._id),
      this.results.listNotesByConversation(conversation._id),
      this.outbox.listOutboxByConversation(conversation._id),
      this.ingressRepository.listIngressByPhoneE164(conversation.phoneAtLaunch),
      this.simOutbound.listSimOutboundByPhoneE164(conversation.phoneAtLaunch),
    ]);

    if (event?.status !== "finished") {
      throw new FeedbackSimulatorRunRejectedError(
        "Real-model simulation requires a campaign for a finished event.",
      );
    }
    if (feedbackVenue.venue === null) {
      throw new FeedbackSimulatorRunRejectedError(
        "Paid real-model simulation requires a configured event venue with useInFeedback enabled.",
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
      !hasCleanSimulatorGoals(
        conversation.goals,
        getPostEventFeedbackQuestionSet(
          campaign.questionSetVersion,
        ).answerQuestions.map((question) => question.key),
      ) ||
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
      workerAttestation,
      timingPolicy: "single_quiet_window_batch",
      baseline: {
        clean: true,
        currentMessageCount: conversation.messages.length,
        effectiveMessageCount,
        introTranscriptRepairRequired,
      },
      feedbackVenue: {
        contextRevision: feedbackVenue.contextRevision,
        venue: feedbackVenue.venue,
      },
      candidateBindings,
      renderedMessages: scenario.messages.map((message) =>
        renderFeedbackSimulatorTemplate(
          message.textTemplate,
          candidateBindings,
        ),
      ),
      rubric: feedbackSimulatorRubricSchema.parse(scenario.rubric),
      warning:
        workerAttestation.issue ??
        "The confirmed run makes paid provider calls (one extraction plus one or more attention-classification batches), permanently consumes this clean conversation, and does not clean up normal persisted outputs.",
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
    if (this.configuredWorkerProfile().extractionReasoningEffort === null) {
      throw new FeedbackSimulatorRunRejectedError(
        "Paid real-model simulation requires an explicit FEEDBACK_EXTRACTION_REASONING_EFFORT; provider-default reasoning is not a reproducible treatment. No transcript repair or ingress write was performed.",
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
          `${preflight.workerAttestation.issue ?? "The feedback worker attestation failed."} No transcript repair or ingress write was performed.`,
        );
      }

      const [campaign, initialConversation] = await Promise.all([
        this.campaigns.findCampaignById(input.campaignId),
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
        this.results.listAnswersByConversation(initialConversation._id),
        this.results.listNotesByConversation(initialConversation._id),
        this.outbox.listOutboxByConversation(initialConversation._id),
        this.ingressRepository.listIngressByPhoneE164(
          initialConversation.phoneAtLaunch,
        ),
        this.simOutbound.listSimOutboundByPhoneE164(
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
        !hasCleanSimulatorGoals(
          conversation.goals,
          getPostEventFeedbackQuestionSet(
            campaign.questionSetVersion,
          ).answerQuestions.map((question) => question.key),
        )
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

    const [
      conversation,
      ingressRows,
      answers,
      notes,
      outbox,
      simulatedSends,
      activeLease,
    ] = await Promise.all([
      this.conversations.findById(run.conversationId),
      Promise.all(
        run.ingressIds.map((ingressId) =>
          this.ingressRepository.findIngressById(ingressId),
        ),
      ),
      this.results.listAnswersByConversation(run.conversationId),
      this.results.listNotesByConversation(run.conversationId),
      this.outbox.listOutboxByConversation(run.conversationId),
      this.simOutbound.listSimOutboundByPhoneE164(run.phoneE164),
      this.database.transaction((transaction) =>
        this.executionFences.findActiveLease(transaction, run.conversationId),
      ),
    ]);

    const automation = feedbackSimulatorDurableAutomation({
      conversation,
      activeLease,
      targetCursorSeq: run.targetCursorSeq,
    });
    return toRunView({
      run,
      conversation,
      ingressRows,
      answers,
      notes,
      outbox,
      simulatedSends,
      automation,
    });
  }

  async injectObservedMessage(
    input: {
      readonly phoneE164: string;
      /** `null` is a voice note, photo or reaction — an inbound with no body. */
      readonly text: string | null;
      readonly fromMe: boolean;
      readonly idempotencyKey?: string;
    },
    correlationId: string,
  ): Promise<InjectFeedbackSimulatorMessageResponseDto> {
    this.assertEnabled();
    const observedAt = new Date();
    const providerMessageId = input.idempotencyKey
      ? `sim-inject-${input.idempotencyKey}`
      : `sim-inject-${randomUUID()}`;
    const chatJid = phoneE164ToChatJid(input.phoneE164);

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
      this.ingressRepository.listIngressByPhoneE164(phoneE164),
      this.simOutbound.listSimOutboundByPhoneE164(phoneE164),
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
    return this.configuredWorkerProfile().model;
  }

  private configuredWorkerProfile(): FeedbackWorkerControlProfile {
    return resolveFeedbackWorkerControlProfile({
      extractionStub:
        this.config.get("FEEDBACK_EXTRACTION_STUB", { infer: true }) === true,
      model: this.config.get("FEEDBACK_EXTRACTION_MODEL", { infer: true }),
      extractionReasoningEffort: this.config.get(
        "FEEDBACK_EXTRACTION_REASONING_EFFORT",
        { infer: true },
      ),
      replyReasoningEffort: this.config.get("FEEDBACK_REPLY_REASONING_EFFORT", {
        infer: true,
      }),
      attentionReasoningEffort: this.config.get(
        "FEEDBACK_ATTENTION_REASONING_EFFORT",
        { infer: true },
      ),
      serviceTier: this.config.get("FEEDBACK_EXTRACTION_SERVICE_TIER", {
        infer: true,
      }),
      transportMode: this.config.get("TRANSPORT_MODE", { infer: true }),
      simulatedTransportFaultMode: this.config.get(
        "FEEDBACK_SIMULATED_TRANSPORT_FAULT_MODE",
        { infer: true },
      ),
      simulatedTransportFaultPercent: this.config.get(
        "FEEDBACK_SIMULATED_TRANSPORT_FAULT_PERCENT",
        { infer: true },
      ),
      simulatedTransportSeed: this.config.get(
        "FEEDBACK_SIMULATED_TRANSPORT_SEED",
        { infer: true },
      ),
      simulatedTransportMaxDelayMs: this.config.get(
        "FEEDBACK_SIMULATED_TRANSPORT_MAX_DELAY_MS",
        { infer: true },
      ),
    });
  }

  private async workerAttestation(
    expected: FeedbackWorkerControlProfile = this.configuredWorkerProfile(),
  ): Promise<FeedbackWorkerAttestation> {
    return attestFeedbackWorkers(await this.queue.getWorkers(), expected);
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
    if (!this.isEnabled()) {
      throw new FeedbackSimulatorRunRejectedError(
        "The feedback simulator requires FEEDBACK_SIMULATOR_ENABLED=true and TRANSPORT_MODE=simulated; production additionally requires FEEDBACK_PRODUCTION_REHEARSAL_ENABLED=true.",
      );
    }
  }

  private isEnabled(): boolean {
    return isFeedbackSimulatorEnabled({
      nodeEnv: this.config.get("NODE_ENV", { infer: true }),
      productionRehearsalEnabled: this.config.get(
        "FEEDBACK_PRODUCTION_REHEARSAL_ENABLED",
        { infer: true },
      ),
      simulatorEnabled: this.config.get("FEEDBACK_SIMULATOR_ENABLED", {
        infer: true,
      }),
      transportMode: this.config.get("TRANSPORT_MODE", { infer: true }),
    });
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
}

export function isFeedbackSimulatorSingleTurnScenario(
  scenario: Pick<PostEventFeedbackRealModelCorpusCase, "messages">,
): boolean {
  // Production moves the due time after every fragment. A scenario therefore
  // belongs to one model turn while every adjacent gap stays inside the quiet
  // window; its cumulative typing time is irrelevant.
  return scenario.messages
    .slice(1)
    .every((message) => message.afterMs < FEEDBACK_EXTRACT_QUIET_WINDOW_MS);
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
  expectedQuestionKeys: readonly string[],
): boolean {
  return (
    goals.length === expectedQuestionKeys.length &&
    goals.every(
      (goal, index) =>
        goal.key === expectedQuestionKeys[index] &&
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
