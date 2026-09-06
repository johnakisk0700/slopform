import { Injectable } from "@nestjs/common";
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
import { resolveGoalStatuses } from "./goal-progress.js";
import {
  countsAsHostileTurn,
  stopsForHostility,
} from "./operator-attention.js";
import {
  resolveOutbound,
  withCampaignReaskCap,
  withPolicyAnswers,
  withSafetyAssurance,
} from "./outbound-reply.js";
import { isUnansweredPolicyQuestion } from "./policy-answers.js";
import {
  FeedbackLogger,
  FeedbackOperationLog,
} from "../feedback-operation-log.js";
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
  type FeedbackReplyGenerationResult,
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
import {
  decideExtractionTurn,
  deriveTurnPolicyFacts,
  suppressCloseAfterInitialWithholding,
} from "./turn-decision.js";
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
  private readonly logger = new FeedbackLogger(
    FeedbackExtractionTurnService.name,
  );

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
    const operation = new FeedbackOperationLog(this.logger, {
      operation: "extract_plan",
      ...this.turnLogContext(snapshot),
    });
    try {
      operation.stage("prepare_context");
      const prepared = await this.prepareModelContext(snapshot);
      operation.stage("generate_and_validate");
      const generated = await this.buyAndValidateProposals(snapshot, prepared);
      operation.stage("resolve_reply");
      const planned = await this.resolveParticipantReply(
        snapshot,
        prepared,
        generated,
      );
      operation.complete("planned");
      return planned;
    } catch (error) {
      if (
        error instanceof FeedbackConversationExecutionGuardError &&
        error.reason === "authoritative_state_changed"
      ) {
        operation.failed(error, "superseded");
      } else {
        operation.failed(error);
      }
      throw error;
    }
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
    const [generated, attention] = await Promise.all([
      this.proposeExtraction(snapshot, prepared, questionKeys),
      this.classifyAttention(snapshot, prepared),
    ]);
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
    const facts = deriveTurnPolicyFacts({
      conversation,
      validated,
      recordedStatuses,
      hostileTurn,
      stoppingForHostility,
    });
    const testimonySeq =
      latestParticipantMessage(conversation)?.seq ?? cursorSeq;
    let resolvedOutbound = resolveOutbound(
      conversation,
      validated,
      facts.progressClosing,
      facts.urgentSafety,
      testimonySeq,
      prepared.copy,
      recordedStatuses,
      stoppingForHostility,
    );

    const runUsages = [...generated.runUsages];
    let replyRewriteSuperseded = false;
    if (resolvedOutbound?.generatedByModel && validated.reply) {
      try {
        const rewritten = await this.rewriteReply(
          snapshot,
          prepared,
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
            facts.progressClosing,
            facts.urgentSafety,
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
    const withheld = outbound
      ? await this.guards.reviewBeforeEnqueue({
          conversation,
          cursorSeq,
          staleOnNewerTestimony: facts.ordinaryReply || facts.progressClosing,
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

    const outboundIntent = withheld ? undefined : outbound;
    const decided = decideExtractionTurn({
      conversation,
      validated,
      recordedStatuses,
      askedGoal: outboundIntent?.askedGoal,
      hasOutboundIntent: outboundIntent !== undefined,
      hostileTurn,
      stoppingForHostility,
    });
    const closingReason = suppressCloseAfterInitialWithholding({
      progressClosing: facts.progressClosing,
      withheld: withheld !== undefined,
      rewriteSuperseded: replyRewriteSuperseded,
      closingReason: decided.closingReason,
    });
    const outboundForPersistence =
      closingReason !== null && outboundIntent
        ? {
            ...outboundIntent,
            dedupeKey: createFeedbackClosingDedupeKey(
              conversation._id,
              testimonySeq,
              snapshot.executionClaim?.workRevision,
            ),
          }
        : outboundIntent;

    return {
      evidence: {
        context: prepared.context,
        validated,
        recordedStatuses,
        hostileTurn,
        stoppingForHostility,
        rewriteSuperseded: replyRewriteSuperseded,
        stalledOnMessageId: capped.stalledOnMessageId,
        unansweredDataQuestionMessageIds,
        newestParticipantMessageId:
          prepared.context.newParticipantMessageIds.at(-1) ?? null,
        runUsage,
        model: generated.generated.model,
        serviceTier: this.generation.serviceTier ?? null,
      },
      proposed: {
        goalStatuses: decided.goalStatuses,
        withdrew: decided.withdrew,
        hostility: decided.hostility,
        closingReason,
        outboundIntent: outboundForPersistence,
      },
    };
  }

  private turnLogContext(snapshot: ExtractRunSnapshot) {
    return {
      correlationId: snapshot.correlationId,
      conversationId: snapshot.conversation._id,
      campaignId: snapshot.campaign.id,
      ...(snapshot.executionClaim
        ? {
            workRevision: snapshot.executionClaim.workRevision,
            executionEpoch: snapshot.executionClaim.epoch,
          }
        : {}),
    };
  }

  private async proposeExtraction(
    snapshot: ExtractRunSnapshot,
    prepared: PreparedModelContext,
    questionKeys: FeedbackAnswerQuestionKey[],
  ): Promise<FeedbackExtractionGenerationResult> {
    const child = new FeedbackOperationLog(this.logger, {
      operation: "extract_propose",
      ...this.turnLogContext(snapshot),
    });
    child.stage("propose");
    try {
      const generated = prepared.beforeProviderCall
        ? await this.generation.propose(
            prepared.prompt,
            questionKeys,
            prepared.beforeProviderCall,
          )
        : await this.generation.propose(prepared.prompt, questionKeys);
      child.complete("generated");
      return generated;
    } catch (error) {
      child.failed(error);
      throw error;
    }
  }

  private async classifyAttention(
    snapshot: ExtractRunSnapshot,
    prepared: PreparedModelContext,
  ): Promise<FeedbackAttentionClassificationGenerationResult> {
    const child = new FeedbackOperationLog(this.logger, {
      operation: "extract_classify",
      ...this.turnLogContext(snapshot),
    });
    child.stage("classify");
    try {
      const attention = prepared.beforeProviderCall
        ? await this.generation.classifyAttention(
            prepared.context.messages,
            prepared.context.newParticipantMessageIds,
            prepared.beforeProviderCall,
          )
        : await this.generation.classifyAttention(
            prepared.context.messages,
            prepared.context.newParticipantMessageIds,
          );
      child.complete("classified");
      return attention;
    } catch (error) {
      child.failed(error);
      throw error;
    }
  }

  private async rewriteReply(
    snapshot: ExtractRunSnapshot,
    prepared: PreparedModelContext,
    draft: string,
  ): Promise<FeedbackReplyGenerationResult> {
    const child = new FeedbackOperationLog(this.logger, {
      operation: "extract_rewrite",
      ...this.turnLogContext(snapshot),
    });
    child.stage("rewrite");
    try {
      const rewritten = prepared.beforeProviderCall
        ? await this.generation.rewriteReply(
            prepared.prompt,
            draft,
            prepared.beforeProviderCall,
          )
        : await this.generation.rewriteReply(prepared.prompt, draft);
      child.complete("rewritten");
      return rewritten;
    } catch (error) {
      if (
        error instanceof FeedbackConversationExecutionGuardError &&
        error.reason === "authoritative_state_changed"
      ) {
        child.failed(error, "superseded");
      } else {
        child.failed(error);
      }
      throw error;
    }
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
