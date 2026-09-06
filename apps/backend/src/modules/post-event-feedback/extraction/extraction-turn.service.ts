import { Injectable, Logger } from "@nestjs/common";
import type {
  FeedbackAnswerQuestionKey,
  FeedbackCampaignRow,
  FeedbackNoteType,
  MessageOutboxStatus,
} from "@slopform/database";

import { isCorrectedAnswer } from "./answer-corrections.js";
import { FeedbackResultsRepository } from "./results.repository.js";
import { FeedbackOutboxRepository } from "../outbox/outbox.repository.js";
import type { FeedbackConversationDocument } from "../post-event-feedback-conversation.document.js";
import { EventsService } from "../../events/events.service.js";
import { ParticipantsRepository } from "../../participants/participants.repository.js";
import { latestParticipantMessage } from "../conversation-reader.js";
import { isCompleting, resolveGoalStatuses } from "./goal-progress.js";
import {
  countsAsHostileTurn,
  stopsForHostility,
} from "./operator-attention.js";
import {
  answeredAnything,
  resolveOutbound,
  withCampaignReaskCap,
  withPolicyAnswers,
  withSafetyAssurance,
} from "./outbound-reply.js";
import { isUnansweredPolicyQuestion } from "./policy-answers.js";
import { PostEventFeedbackMetrics } from "../metrics.service.js";
import { resolveCampaignCopy } from "../question-set.js";
import { validateFeedbackExtractionProposal } from "./validate-proposal.js";
import {
  FeedbackExtractionGenerationError,
  PostEventFeedbackExtractionModel,
  combineFeedbackExtractionUsage,
  type FeedbackAttentionClassificationGenerationResult,
  type FeedbackExtractionGenerationResult,
  type FeedbackExtractionUsage,
  type FeedbackProviderCallGuard,
} from "./model.service.js";
import {
  createFeedbackClosingDedupeKey,
  type FeedbackExtractionContext,
} from "./extraction.schemas.js";
import {
  buildFeedbackExtractionPrompt,
  estimatePromptTokens,
  type FeedbackExtractionPrompt,
} from "./prompt.js";
import type { PostEventFeedbackQuestionSetCopy } from "../question-set.js";
import { decideExtractionTurn } from "./turn-decision.js";
import { FeedbackConversationExecutionGuardError } from "./execution-guard.js";
import { FeedbackExtractionGuards } from "./extraction-guards.service.js";
import type {
  ExtractPlannedTurn,
  ExtractRunSnapshot,
} from "./extract.types.js";

const FEEDBACK_MODEL_VISIBLE_OUTBOX_STATUSES = new Set<MessageOutboxStatus>([
  "attempting",
  "ambiguous",
  "sending",
  "sent",
]);

interface PreparedModelContext {
  readonly context: FeedbackExtractionContext;
  readonly copy: PostEventFeedbackQuestionSetCopy;
  readonly prompt: FeedbackExtractionPrompt;
  readonly estimatedPromptTokens: number;
  readonly beforeProviderCall: FeedbackProviderCallGuard | undefined;
}

interface GeneratedProposalResult {
  readonly generated: FeedbackExtractionGenerationResult;
  readonly attention: FeedbackAttentionClassificationGenerationResult;
  readonly validated: ReturnType<typeof validateFeedbackExtractionProposal>;
  readonly runUsages: FeedbackExtractionUsage[];
}

/**
 * Builds live model context and produces one validated, planned extraction
 * turn. Provider calls stay here; persistence does not.
 */
@Injectable()
export class FeedbackExtractionTurnService {
  private readonly logger = new Logger(FeedbackExtractionTurnService.name);

  constructor(
    private readonly events: EventsService,
    private readonly results: FeedbackResultsRepository,
    private readonly participants: ParticipantsRepository,
    private readonly outbox: FeedbackOutboxRepository,
    private readonly generation: PostEventFeedbackExtractionModel,
    private readonly metrics: PostEventFeedbackMetrics,
    private readonly guards: FeedbackExtractionGuards,
  ) {}

  async plan(snapshot: ExtractRunSnapshot): Promise<ExtractPlannedTurn> {
    const prepared = await this.prepareModelContext(snapshot);
    const generated = await this.buyAndValidateProposals(snapshot, prepared);
    return this.resolveParticipantReply(snapshot, prepared, generated);
  }

  private async prepareModelContext(
    snapshot: ExtractRunSnapshot,
  ): Promise<PreparedModelContext> {
    const context = await this.buildContext(
      snapshot.conversation,
      snapshot.campaign,
    );
    const copy = resolveCampaignCopy(
      snapshot.campaign.questions,
      snapshot.campaign.questionSetVersion,
    );
    const prompt = buildFeedbackExtractionPrompt({ context, copy });
    const executionClaim = snapshot.executionClaim;
    return {
      context,
      copy,
      prompt,
      estimatedPromptTokens: estimatePromptTokens(prompt),
      beforeProviderCall: executionClaim
        ? () =>
            this.guards.assertProviderEntry(
              executionClaim,
              snapshot.conversation,
            )
        : undefined,
    };
  }

  private async buyAndValidateProposals(
    snapshot: ExtractRunSnapshot,
    prepared: PreparedModelContext,
  ): Promise<GeneratedProposalResult> {
    const questionKeys = prepared.context.goals.map((goal) => goal.key);
    const beforeProviderCall = prepared.beforeProviderCall;
    const [generated, attention] = await Promise.all(
      beforeProviderCall
        ? [
            this.generation.propose(
              prepared.prompt,
              questionKeys,
              beforeProviderCall,
            ),
            this.generation.classifyAttention(
              prepared.context.messages,
              prepared.context.newParticipantMessageIds,
              beforeProviderCall,
            ),
          ]
        : [
            this.generation.propose(prepared.prompt, questionKeys),
            this.generation.classifyAttention(
              prepared.context.messages,
              prepared.context.newParticipantMessageIds,
            ),
          ],
    );
    this.metrics.recordExtractTokens(
      {
        phase: "feedback_extraction",
        model: generated.model,
        estimatedPromptTokens: prepared.estimatedPromptTokens,
        inputTokens: generated.usage.inputTokens,
        outputTokens: generated.usage.outputTokens,
        totalTokens: generated.usage.totalTokens,
      },
      snapshot.correlationId,
    );
    this.metrics.recordExtractTokens(
      {
        phase: "attention_classification",
        model: attention.model,
        estimatedPromptTokens: attention.estimatedPromptTokens,
        inputTokens: attention.usage.inputTokens,
        outputTokens: attention.usage.outputTokens,
        totalTokens: attention.usage.totalTokens,
      },
      snapshot.correlationId,
    );

    const validated = validateFeedbackExtractionProposal(
      generated.proposal,
      prepared.context,
      attention.signals,
    );
    if (validated.rejections.length > 0) {
      this.logger.warn({
        event: "feedback.extract.rejected_proposals",
        correlationId: snapshot.correlationId,
        conversationId: snapshot.conversation._id,
        rejections: validated.rejections,
      });
    }

    // `handoff_discards_testimony` fails the whole run (retryable
    // `validation_failed`). Continuing would freeze `awaitingHuman` and advance
    // past unread testimony. Exhausted retries land in deterministic fallback.
    if (
      validated.rejections.some(
        (rejection) => rejection.reason === "handoff_discards_testimony",
      )
    ) {
      throw new FeedbackExtractionGenerationError(
        "extraction_failed",
        true,
        "validation_failed",
      );
    }

    return {
      generated,
      attention,
      validated,
      runUsages: [generated.usage, attention.usage],
    };
  }

  private async resolveParticipantReply(
    snapshot: ExtractRunSnapshot,
    prepared: PreparedModelContext,
    generated: GeneratedProposalResult,
  ): Promise<ExtractPlannedTurn> {
    const { conversation, cursorSeq } = snapshot;
    let validated = generated.validated;
    const recordedStatuses = resolveGoalStatuses(
      conversation.goals,
      prepared.context,
      validated,
    );
    const urgentSafety = validated.safetySignals.some(
      (signal) => signal.recommendedAction === "urgent_human_follow_up",
    );
    const dutyOfCare = validated.handoff || urgentSafety;
    const hostileTurn = countsAsHostileTurn({
      hostileMessageIds: generated.attention.hostileMessageIds,
      safetySignalCount: validated.safetySignals.length,
    });
    const hostileTurns = conversation.hostileTurns + (hostileTurn ? 1 : 0);
    const stoppingForHostility = stopsForHostility({
      hostileTurn,
      hostileTurns,
      safetySignalCount: validated.safetySignals.length,
    });
    const hostileWithoutAnswers =
      hostileTurn && !answeredAnything(conversation, validated);
    const progressClosing =
      isCompleting(conversation.goals, recordedStatuses) &&
      validated.safetySignals.length === 0 &&
      !hostileWithoutAnswers;
    const testimonySeq =
      latestParticipantMessage(conversation)?.seq ?? cursorSeq;
    let resolvedOutbound = resolveOutbound(
      conversation,
      validated,
      progressClosing,
      urgentSafety,
      testimonySeq,
      prepared.copy,
      recordedStatuses,
      stoppingForHostility,
    );

    const runUsages = [...generated.runUsages];
    let replyRewriteSuperseded = false;
    if (resolvedOutbound?.generatedByModel && validated.reply) {
      try {
        const rewritten = prepared.beforeProviderCall
          ? await this.generation.rewriteReply(
              prepared.prompt,
              validated.reply,
              prepared.beforeProviderCall,
            )
          : await this.generation.rewriteReply(
              prepared.prompt,
              validated.reply,
            );
        runUsages.push(rewritten.usage);
        this.metrics.recordExtractTokens(
          {
            phase: "feedback_reply",
            model: rewritten.model,
            estimatedPromptTokens: rewritten.estimatedPromptTokens,
            inputTokens: rewritten.usage.inputTokens,
            outputTokens: rewritten.usage.outputTokens,
            totalTokens: rewritten.usage.totalTokens,
          },
          snapshot.correlationId,
        );
        if (rewritten.reply === null) {
          resolvedOutbound = undefined;
          this.logger.warn({
            event: "feedback.extract.reply_withheld",
            correlationId: snapshot.correlationId,
            conversationId: conversation._id,
            reason: "reply_generation_failed",
          });
        } else {
          validated = { ...validated, reply: rewritten.reply };
          resolvedOutbound = resolveOutbound(
            conversation,
            validated,
            progressClosing,
            urgentSafety,
            testimonySeq,
            prepared.copy,
            recordedStatuses,
            stoppingForHostility,
          );
        }
      } catch (error) {
        if (
          error instanceof FeedbackConversationExecutionGuardError &&
          error.reason === "authoritative_state_changed"
        ) {
          replyRewriteSuperseded = true;
          resolvedOutbound = undefined;
          this.logger.log({
            event: "feedback.extract.reply_withheld",
            correlationId: snapshot.correlationId,
            conversationId: conversation._id,
            reason: "authoritative_state_changed_before_reply_rewrite",
          });
        } else {
          throw error;
        }
      }
    }

    const runUsage = combineFeedbackExtractionUsage(runUsages);
    const capped = withCampaignReaskCap(
      conversation,
      resolvedOutbound,
      prepared.copy,
    );
    const outbound = withSafetyAssurance(
      conversation,
      validated,
      withPolicyAnswers(
        conversation,
        capped.outbound,
        generated.attention.policyQuestions,
      ),
      new Set(generated.attention.describedIncidentMessageIds),
    );
    const unansweredDataQuestionMessageIds = [
      ...new Set(
        generated.attention.policyQuestions
          .filter((match) => isUnansweredPolicyQuestion(match.question))
          .map((match) => match.messageId),
      ),
    ];
    const ordinaryReply =
      !progressClosing && !validated.handoff && !stoppingForHostility;
    const withheld = outbound
      ? await this.guards.reviewBeforeSending({
          conversation,
          cursorSeq,
          staleOnNewerTestimony: ordinaryReply || progressClosing,
          ...(snapshot.executionClaim
            ? { executionClaim: snapshot.executionClaim }
            : {}),
        })
      : undefined;
    if (withheld) {
      this.logger.log({
        event: "feedback.extract.outbound_withheld",
        correlationId: snapshot.correlationId,
        conversationId: conversation._id,
        cursorSeq,
        reason: withheld,
      });
    }

    const sentOutbound = withheld ? undefined : outbound;
    const decided = decideExtractionTurn({
      conversation,
      validated,
      recordedStatuses,
      askedGoal: sentOutbound?.askedGoal,
      outboundSent: sentOutbound !== undefined,
      dutyOfCare,
      stoppingForHostility,
      hostileWithoutAnswers,
    });
    let closingReason: "completed" | "declined" | null =
      progressClosing && withheld ? null : decided.closingReason;
    if (replyRewriteSuperseded) {
      closingReason = null;
    }
    const outboundForPersistence =
      closingReason !== null && sentOutbound
        ? {
            ...sentOutbound,
            dedupeKey: createFeedbackClosingDedupeKey(
              conversation._id,
              testimonySeq,
              snapshot.executionClaim?.workRevision,
            ),
          }
        : sentOutbound;

    return {
      context: prepared.context,
      validated,
      recordedStatuses,
      outbound: outboundForPersistence,
      ordinaryReply,
      dutyOfCare,
      stoppingForHostility,
      hostileTurn,
      hostileWithoutAnswers,
      replyRewriteSuperseded,
      goalStatuses: decided.goalStatuses,
      withdrew: decided.withdrew,
      hostility: decided.hostility,
      closingReason,
      stalledOnMessageId: capped.stalledOnMessageId,
      unansweredDataQuestionMessageIds,
      newestParticipantMessageId:
        prepared.context.newParticipantMessageIds.at(-1) ?? null,
      runUsage,
      model: generated.generated.model,
      serviceTier: this.generation.serviceTier ?? null,
    };
  }

  private async buildContext(
    conversation: FeedbackConversationDocument,
    campaign: FeedbackCampaignRow,
  ): Promise<FeedbackExtractionContext> {
    const transcriptOutboxIds = conversation.messages.flatMap((message) =>
      message.outboxId ? [message.outboxId] : [],
    );
    const [
      candidates,
      acceptedAnswers,
      acceptedNotes,
      participant,
      venue,
      outboxStatuses,
    ] = await Promise.all([
      this.events.listFeedbackCandidatesForRespondent(
        campaign.eventId,
        conversation.respondentParticipantId,
      ),
      this.results.listAnswersByConversation(conversation._id),
      this.results.listNotesByConversation(conversation._id),
      this.participants.findById(conversation.respondentParticipantId),
      this.events.getFeedbackVenueContext(campaign.eventId),
      this.outbox.listOutboxStatusesByIds(transcriptOutboxIds),
    ]);
    const outboxStatusById = new Map(
      outboxStatuses.map(({ outboxId, status }) => [outboxId, status]),
    );
    const modelVisibleMessages = conversation.messages.filter((message) => {
      if (message.actor === "participant" || !message.outboxId) return true;

      const status = outboxStatusById.get(message.outboxId);
      return (
        status === undefined ||
        FEEDBACK_MODEL_VISIBLE_OUTBOX_STATUSES.has(status)
      );
    });

    return {
      respondentParticipantId: conversation.respondentParticipantId,
      respondentDisplayName: participant?.preferredName?.trim() || null,
      candidates: candidates.items,
      messages: modelVisibleMessages.map((message) => ({
        id: message.id,
        seq: message.seq,
        actor: message.actor,
        occurredAt: message.at.toISOString(),
        text: message.text,
      })),
      newParticipantMessageIds: conversation.messages
        .filter(
          (message) =>
            message.actor === "participant" &&
            message.seq > conversation.extraction.cursorSeq,
        )
        .map((message) => message.id),
      goals: conversation.goals,
      acceptedAnswers: acceptedAnswers.map((answer) => ({
        questionKey: answer.questionKey as FeedbackAnswerQuestionKey,
        subjectParticipantId: answer.subjectParticipantId,
        valueInt: answer.valueInt,
        correctedByOperator: isCorrectedAnswer(answer.extractionMeta),
      })),
      acceptedNotes: acceptedNotes.map((note) => ({
        noteType: note.noteType as FeedbackNoteType,
        text: note.text,
        subjectParticipantId: note.subjectParticipantId,
      })),
      venue: venue.venue,
      venueContextRevision: venue.venue === null ? null : venue.contextRevision,
      replyAllowed:
        conversation.lifecycle.state === "open" &&
        conversation.control.mode === "bot" &&
        participant?.postEventFeedbackWhatsappOptIn === true &&
        campaign.status === "launched",
    };
  }
}
