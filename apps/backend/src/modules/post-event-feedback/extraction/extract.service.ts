import { decideExtractionTurn } from "./turn-decision.js";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type {
  AppTransaction,
  FeedbackAnswerQuestionKey,
  FeedbackCampaignRow,
  FeedbackExtractionMeta,
  FeedbackNoteType,
  MessageOutboxRow,
  MessageOutboxStatus,
} from "@slopform/database";

import { AuditRepository } from "../../../infrastructure/audit/audit.repository.js";
import { isCorrectedAnswer } from "./answer-corrections.js";
import {
  FEEDBACK_OPERATOR_ALERT,
  type FeedbackOperatorAlert,
} from "../operator-alert.js";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { FeedbackCampaignRepository } from "../campaign/campaign.repository.js";
import { FeedbackResultsRepository } from "./results.repository.js";
import { FeedbackOutboxRepository } from "../outbox/outbox.repository.js";
import { FeedbackIngressRepository } from "../ingress/ingress.repository.js";
import {
  FeedbackConversationCapacityError,
  FeedbackConversationRepository,
} from "../post-event-feedback-conversation.repository.js";
import type { FeedbackConversationDocument } from "../post-event-feedback-conversation.document.js";
import { EventsService } from "../../events/events.service.js";
import { ParticipantsRepository } from "../../participants/participants.repository.js";
import { latestParticipantMessage } from "../conversation-reader.js";
import {
  isCompleting,
  resolveGoalStatuses,
  type GoalStatusUpdate,
} from "./goal-progress.js";
import {
  countsAsHostileTurn,
  groupSafetySignalsByMessage,
  isSafetyOrHandoffAttention,
  operatorAttentionRaises,
  respondentSourceMessageIds,
  stopsForHostility,
  type FeedbackHostilityRaise,
} from "./operator-attention.js";
import {
  answeredAnything,
  resolveOutbound,
  withCampaignReaskCap,
  withPolicyAnswers,
  withSafetyAssurance,
  type OutboundReply,
} from "./outbound-reply.js";
import { isUnansweredPolicyQuestion } from "./policy-answers.js";
import { FeedbackOutboundLogService } from "../outbox/outbound-log.service.js";
import { FeedbackOutboundTranscriptService } from "../outbox/outbound-transcript.service.js";
import {
  PostEventFeedbackMetrics,
  type FeedbackExtractOutcome,
} from "../metrics.service.js";
import {
  contradictedPostEventFeedbackQuestionKeys,
  noteSignature,
  resolveCampaignCopy,
} from "../question-set.js";
import {
  validateFeedbackExtractionProposal,
  type FeedbackExtractionValidationResult,
} from "./validate-proposal.js";
import {
  FeedbackExtractionGenerationError,
  FeedbackProviderCallGuardError,
  PostEventFeedbackExtractionModel,
  combineFeedbackExtractionUsage,
  type FeedbackExtractionUsage,
} from "./model.service.js";
import { FEEDBACK_EXTRACT_QUIET_WINDOW_MS } from "../jobs.schemas.js";
import {
  createFeedbackClosingDedupeKey,
  FEEDBACK_CLOSING_DEDUPE_PREFIX,
  type FeedbackExtractionContext,
} from "./extraction.schemas.js";
import {
  buildFeedbackExtractionPrompt,
  estimatePromptTokens,
} from "./prompt.js";
import { PostEventFeedbackCampaignSummaryService } from "../summary/summary.service.js";
import type { FeedbackConversationExecutionClaim } from "./execution-fence.repository.js";
import { FeedbackConversationExecutionFence } from "./execution-fence.service.js";

const FEEDBACK_MODEL_VISIBLE_OUTBOX_STATUSES = new Set<MessageOutboxStatus>([
  "attempting",
  "ambiguous",
  "sending",
  "sent",
]);

export class PostEventFeedbackConversationNotFoundError extends Error {
  constructor(conversationId: string) {
    super(`Feedback conversation ${conversationId} was not found`);
    this.name = PostEventFeedbackConversationNotFoundError.name;
  }
}

export class PostEventFeedbackCampaignNotFoundError extends Error {
  constructor(campaignId: string) {
    super(`Feedback campaign ${campaignId} was not found`);
    this.name = PostEventFeedbackCampaignNotFoundError.name;
  }
}

export const FEEDBACK_CONVERSATION_EXECUTION_GUARD_REASONS = [
  "authoritative_state_changed",
  "execution_claim_lost",
  "execution_invariant_broken",
] as const;

export type FeedbackConversationExecutionGuardReason =
  (typeof FEEDBACK_CONVERSATION_EXECUTION_GUARD_REASONS)[number];

/**
 * Stops one provider/effects boundary without laundering orchestration state
 * into a model-generation failure.
 *
 * The queue adapter decides terminal behavior from `reason`: an ordinary state
 * change is a successful supersession, a lost lease remains retryable, and a
 * missing or inconsistent execution projection is quarantined as unrecoverable.
 */
export class FeedbackConversationExecutionGuardError extends FeedbackProviderCallGuardError {
  constructor(
    conversationId: string,
    readonly reason: FeedbackConversationExecutionGuardReason,
  ) {
    super(`Feedback execution guard rejected ${conversationId}: ${reason}`);
    this.name = FeedbackConversationExecutionGuardError.name;
  }
}

export interface ExtractFeedbackInput {
  readonly conversationId: string;
  readonly correlationId: string;
  readonly executionClaim?: FeedbackConversationExecutionClaim;
}

export interface ExtractFeedbackResult {
  readonly outcome: FeedbackExtractOutcome;
  readonly conversationId: string;
  readonly cursorSeq: number;
  readonly answersWritten: number;
  readonly notesWritten: number;
  readonly outboxId?: string;
  readonly model?: string;
}

/**
 * Loads live candidates, calls the model, then validates and commits results,
 * outbound intent and the consumed cursor together under the execution fence.
 */
@Injectable()
export class PostEventFeedbackExtractor {
  private readonly logger = new Logger(PostEventFeedbackExtractor.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly campaigns: FeedbackCampaignRepository,
    private readonly results: FeedbackResultsRepository,
    private readonly outbox: FeedbackOutboxRepository,
    private readonly ingress: FeedbackIngressRepository,
    private readonly conversations: FeedbackConversationRepository,
    private readonly events: EventsService,
    private readonly participants: ParticipantsRepository,
    private readonly generation: PostEventFeedbackExtractionModel,
    private readonly audit: AuditRepository,
    private readonly metrics: PostEventFeedbackMetrics,
    private readonly outboundTranscript: FeedbackOutboundTranscriptService,
    private readonly outboundLog: FeedbackOutboundLogService,
    @Inject(FEEDBACK_OPERATOR_ALERT)
    private readonly alert: FeedbackOperatorAlert,
    private readonly summaries: PostEventFeedbackCampaignSummaryService,
    private readonly executionFence: FeedbackConversationExecutionFence,
  ) {}

  async extract(input: ExtractFeedbackInput): Promise<ExtractFeedbackResult> {
    const conversation = await this.conversations.findById(
      input.conversationId,
    );
    if (!conversation) {
      throw new PostEventFeedbackConversationNotFoundError(
        input.conversationId,
      );
    }

    const cursorSeq = conversation.messages.length;
    const skipped = this.skipOutcome(conversation, cursorSeq);
    if (skipped) {
      return this.complete(
        {
          outcome: skipped,
          conversationId: conversation._id,
          cursorSeq: conversation.extraction.cursorSeq,
          answersWritten: 0,
          notesWritten: 0,
        },
        input.correlationId,
      );
    }

    // No participant testimony: skip the model; still advance the cursor.
    const pending = conversation.messages.filter(
      (message) => message.seq > conversation.extraction.cursorSeq,
    );
    if (!pending.some((message) => message.actor === "participant")) {
      await this.database.transaction(async (transaction) => {
        await this.results.lockConversation(transaction, conversation._id);
        if (
          input.executionClaim &&
          !(await this.executionFence.isCurrent(
            transaction,
            input.executionClaim,
          ))
        ) {
          throw new FeedbackConversationExecutionGuardError(
            conversation._id,
            "execution_claim_lost",
          );
        }
        await this.conversations.advanceCursor(transaction, {
          conversationId: conversation._id,
          toSeq: cursorSeq,
          at: new Date(),
          model: conversation.extraction.model,
          // Carry prior model/tier. Omit `usage` — null would erase paid totals.
          serviceTier: conversation.extraction.serviceTier,
          ...(input.executionClaim
            ? {
                workRevision: input.executionClaim.workRevision,
                executionEpoch: input.executionClaim.epoch,
              }
            : {}),
        });
      });
      return this.complete(
        {
          outcome: "skipped_no_new_testimony",
          conversationId: conversation._id,
          cursorSeq,
          answersWritten: 0,
          notesWritten: 0,
        },
        input.correlationId,
      );
    }

    const campaign = await this.campaigns.findCampaignById(
      conversation.campaignId,
    );
    if (!campaign) {
      throw new PostEventFeedbackCampaignNotFoundError(conversation.campaignId);
    }
    if (campaign.status !== "launched") {
      return this.complete(
        {
          outcome: "skipped_campaign_inactive",
          conversationId: conversation._id,
          cursorSeq: conversation.extraction.cursorSeq,
          answersWritten: 0,
          notesWritten: 0,
        },
        input.correlationId,
      );
    }
    const currentParticipant = await this.participants.findById(
      conversation.respondentParticipantId,
    );
    if (!currentParticipant?.postEventFeedbackWhatsappOptIn) {
      return this.complete(
        {
          outcome: "skipped_consent_withdrawn",
          conversationId: conversation._id,
          cursorSeq: conversation.extraction.cursorSeq,
          answersWritten: 0,
          notesWritten: 0,
        },
        input.correlationId,
      );
    }

    const context = await this.buildContext(conversation, campaign);
    const copy = resolveCampaignCopy(
      campaign.questions,
      campaign.questionSetVersion,
    );
    const prompt = buildFeedbackExtractionPrompt({ context, copy });
    const estimatedPromptTokens = estimatePromptTokens(prompt);
    const executionClaim = input.executionClaim;
    const beforeProviderCall = executionClaim
      ? () => this.assertExecutionCurrent(executionClaim, conversation)
      : undefined;

    const questionKeys = context.goals.map((goal) => goal.key);
    const [generated, attention] = await Promise.all(
      beforeProviderCall
        ? [
            this.generation.propose(prompt, questionKeys, beforeProviderCall),
            this.generation.classifyAttention(
              context.messages,
              context.newParticipantMessageIds,
              beforeProviderCall,
            ),
          ]
        : [
            this.generation.propose(prompt, questionKeys),
            this.generation.classifyAttention(
              context.messages,
              context.newParticipantMessageIds,
            ),
          ],
    );
    this.metrics.recordExtractTokens(
      {
        phase: "feedback_extraction",
        model: generated.model,
        estimatedPromptTokens,
        inputTokens: generated.usage.inputTokens,
        outputTokens: generated.usage.outputTokens,
        totalTokens: generated.usage.totalTokens,
      },
      input.correlationId,
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
      input.correlationId,
    );

    // Rewrite usage is appended later only if participant text is forwarded.
    const runUsages: FeedbackExtractionUsage[] = [
      generated.usage,
      attention.usage,
    ];

    let validated = validateFeedbackExtractionProposal(
      generated.proposal,
      context,
      attention.signals,
    );
    if (validated.rejections.length > 0) {
      this.logger.warn({
        event: "feedback.extract.rejected_proposals",
        correlationId: input.correlationId,
        conversationId: conversation._id,
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

    // Statuses from accepted validation, never `nextGoal`. `asked` waits for
    // the outbound that actually ships.
    const recordedStatuses = resolveGoalStatuses(
      conversation.goals,
      context,
      validated,
    );
    // Safety/handoff end bot speech. `skipOutcome` and the planner honour that.
    const urgentSafety = validated.safetySignals.some(
      (signal) => signal.recommendedAction === "urgent_human_follow_up",
    );
    const dutyOfCare = validated.handoff || urgentSafety;
    // Hostility from stored count plus this run, before writes. Replay must
    // not observe an incremented counter.
    const hostileTurn = countsAsHostileTurn({
      hostileMessageIds: attention.hostileMessageIds,
      safetySignalCount: validated.safetySignals.length,
    });
    const hostileTurns = conversation.hostileTurns + (hostileTurn ? 1 : 0);
    const stoppingForHostility = stopsForHostility({
      hostileTurn,
      hostileTurns,
      safetySignalCount: validated.safetySignals.length,
    });
    // Hostile turn with no answers. Shared by copy (`progressClosing`) and
    // lifecycle (`closingNow`) so sentence and stored word cannot drift.
    const hostileWithoutAnswers =
      hostileTurn && !answeredAnything(conversation, validated);
    // Closing copy only after the ladder is already finished. Withdrawal
    // settles goals after outbound so the model's goodbye ships; settling
    // stops reminders, it does not close. `hostileWithoutAnswers` withholds
    // campaign ending copy (model text still ships). Survivors are ordinary
    // replies and may be dropped if superseded.
    const progressClosing =
      isCompleting(conversation.goals, recordedStatuses) &&
      validated.safetySignals.length === 0 &&
      !hostileWithoutAnswers;
    // Dedupe on the latest participant message, not transcript length — a
    // replay that already sees the reply would otherwise send twice. Cap sits
    // before assurance so a refused re-ask leaves nothing to append to.
    const testimonySeq =
      latestParticipantMessage(conversation)?.seq ?? cursorSeq;
    let resolvedOutbound = resolveOutbound(
      conversation,
      validated,
      progressClosing,
      urgentSafety,
      testimonySeq,
      copy,
      recordedStatuses,
      stoppingForHostility,
    );
    // Low-effort rewrite only for text the outbound policy would forward.
    let replyRewriteSuperseded = false;
    if (resolvedOutbound?.generatedByModel && validated.reply) {
      try {
        const rewritten = beforeProviderCall
          ? await this.generation.rewriteReply(
              prompt,
              validated.reply,
              beforeProviderCall,
            )
          : await this.generation.rewriteReply(prompt, validated.reply);
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
          input.correlationId,
        );
        if (rewritten.reply === null) {
          // Failed rewrite → silence. Do not re-resolve with `reply: null`.
          resolvedOutbound = undefined;
          this.logger.warn({
            event: "feedback.extract.reply_withheld",
            correlationId: input.correlationId,
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
            copy,
            recordedStatuses,
            stoppingForHostility,
          );
        }
      } catch (error) {
        if (
          error instanceof FeedbackConversationExecutionGuardError &&
          error.reason === "authoritative_state_changed"
        ) {
          // Keep structured results; do not buy copy for a superseded snapshot.
          replyRewriteSuperseded = true;
          resolvedOutbound = undefined;
          this.logger.log({
            event: "feedback.extract.reply_withheld",
            correlationId: input.correlationId,
            conversationId: conversation._id,
            reason: "authoritative_state_changed_before_reply_rewrite",
          });
        } else {
          throw error;
        }
      }
    }
    const runUsage = combineFeedbackExtractionUsage(runUsages);
    const capped = withCampaignReaskCap(conversation, resolvedOutbound, copy);
    // Policy between cap and assurance. Assurance last; each sentence dedupes.
    const outbound = withSafetyAssurance(
      conversation,
      validated,
      withPolicyAnswers(
        conversation,
        capped.outbound,
        attention.policyQuestions,
      ),
      new Set(attention.describedIncidentMessageIds),
    );
    // Unanswered data-handling questions stay raised for a person.
    const unansweredDataQuestionMessageIds = [
      ...new Set(
        attention.policyQuestions
          .filter((match) => isUnansweredPolicyQuestion(match.question))
          .map((match) => match.messageId),
      ),
    ];
    const ordinaryReply =
      !progressClosing && !validated.handoff && !stoppingForHostility;
    const withheld = outbound
      ? await this.reviewBeforeSending({
          conversation,
          cursorSeq,
          // Ordinary copy and complete/decline are stale on newer testimony.
          // Handoff/safety/hostility survive.
          staleOnNewerTestimony: ordinaryReply || progressClosing,
          ...(input.executionClaim
            ? { executionClaim: input.executionClaim }
            : {}),
        })
      : undefined;
    if (withheld) {
      this.logger.log({
        event: "feedback.extract.outbound_withheld",
        correlationId: input.correlationId,
        conversationId: conversation._id,
        cursorSeq,
        reason: withheld,
      });
    }
    // Asked and withdrawal follow what actually ships.
    const sentOutbound = withheld ? undefined : outbound;
    let decided = decideExtractionTurn({
      conversation,
      validated,
      recordedStatuses,
      askedGoal: sentOutbound?.askedGoal,
      outboundSent: sentOutbound !== undefined,
      dutyOfCare,
      stoppingForHostility,
      hostileWithoutAnswers,
    });
    let { goalStatuses, withdrew, hostility } = decided;
    let closingReason: "completed" | "declined" | null =
      progressClosing && withheld ? null : decided.closingReason;
    if (replyRewriteSuperseded) {
      closingReason = null;
    }
    // Resolve the key before lifecycle. A goodbye that is a withdrawal keeps
    // an ordinary dispatchable key; a terminal close then joins the anchored
    // closing commitment.
    const outboundForPersistence =
      closingReason !== null && sentOutbound
        ? {
            ...sentOutbound,
            dedupeKey: createFeedbackClosingDedupeKey(
              conversation._id,
              testimonySeq,
              input.executionClaim?.workRevision,
            ),
          }
        : sentOutbound;

    let committed;
    try {
      committed = await this.database.transaction(async (transaction) => {
        const written = await this.persistOn(transaction, {
          conversation,
          campaign,
          context,
          validated,
          outbound: outboundForPersistence,
          ordinaryReply,
          model: generated.model,
          correlationId: input.correlationId,
          closingReason,
          goalStatuses,
          ...(input.executionClaim
            ? { executionClaim: input.executionClaim }
            : {}),
        });

        if (
          written.outboundSuppressedByNewerIngress ||
          written.executionSuperseded
        ) {
          const suppressionReason = written.executionSuperseded
            ? "superseded_by_newer_work"
            : "superseded_by_durable_ingress";
          this.logger.log({
            event: "feedback.extract.outbound_withheld",
            correlationId: input.correlationId,
            conversationId: conversation._id,
            cursorSeq,
            reason: suppressionReason,
          });
          decided = decideExtractionTurn({
            conversation,
            validated,
            recordedStatuses,
            askedGoal: undefined,
            outboundSent: false,
            dutyOfCare,
            stoppingForHostility,
            hostileWithoutAnswers,
          });
          goalStatuses = decided.goalStatuses;
          withdrew = decided.withdrew;
          hostility = decided.hostility;
          // Persist paid results; do not close over unread testimony.
          closingReason = closingReason ? null : decided.closingReason;
        }

        if (written.outboundSuppressedByLegacyClosing) {
          this.logger.warn({
            event: "feedback.extract.legacy_closing_provider_crossed",
            correlationId: input.correlationId,
            conversationId: conversation._id,
          });
          closingReason = null;
        }

        if (
          input.executionClaim &&
          !(await this.executionFence.isCurrent(
            transaction,
            input.executionClaim,
          ))
        ) {
          throw new FeedbackConversationExecutionGuardError(
            conversation._id,
            "execution_claim_lost",
          );
        }

        if (written.outboundSuppressedByLegacyClosing) {
          await this.conversations.raiseAttention(transaction, {
            conversationId: conversation._id,
            kind: "undelivered_message",
            messageId: null,
            at: new Date(),
          });
        }

        let effectiveOutbox = written.outbox;
        if (effectiveOutbox && closingReason === null) {
          await this.outboundTranscript.record(
            transaction,
            effectiveOutbox,
            new Date(),
            input.correlationId,
          );
        }

        const terminalReason = closingReason;
        const state = await this.applyConversationStateOn(transaction, {
          conversation,
          validated,
          goalStatuses,
          closingReason,
          terminalOutboxId:
            closingReason !== null ? (effectiveOutbox?.id ?? null) : null,
          dutyOfCare,
          withdrew,
          hostility,
          awaitingHuman:
            written.outboundSuppressedByLegacyClosing ||
            dutyOfCare ||
            withdrew ||
            hostility === "stopped",
          handoffOutboxId:
            closingReason === null &&
            (written.outboundSuppressedByLegacyClosing ||
              dutyOfCare ||
              withdrew ||
              hostility === "stopped")
              ? (effectiveOutbox?.id ?? null)
              : null,
          hostileTurn,
          priorHostileTurns: conversation.hostileTurns,
          newestParticipantMessageId:
            context.newParticipantMessageIds.at(-1) ?? null,
          stalledOnMessageId: capped.stalledOnMessageId,
          unansweredDataQuestionMessageIds,
          cursorSeq,
          model: generated.model,
          usage: runUsage,
          serviceTier: this.generation.serviceTier ?? null,
          workSuperseded: written.executionSuperseded || replyRewriteSuperseded,
          ...(input.executionClaim
            ? { executionClaim: input.executionClaim }
            : {}),
        });

        if (effectiveOutbox && terminalReason !== null) {
          if (state.terminalCommitted) {
            await this.outboundTranscript.record(
              transaction,
              effectiveOutbox,
              new Date(),
              input.correlationId,
            );
          } else {
            await this.outbox.cancelQueuedOutboxById(
              transaction,
              effectiveOutbox.id,
              "terminal_snapshot_superseded",
            );
            effectiveOutbox = undefined;
            closingReason = null;
          }
        }

        return {
          written,
          state,
          closingReason,
          effectiveOutbox,
          raisedIncident: state.raisedIncident,
        };
      });
    } catch (error) {
      if (!(error instanceof FeedbackConversationCapacityError)) {
        throw error;
      }
      return this.brakeAfterTranscriptCapacity(conversation, input);
    }

    if (committed.raisedIncident) {
      await this.alert.raise({
        conversationId: conversation._id,
        campaignId: conversation.campaignId,
        reason: "extraction_safety_signal",
        correlationId: input.correlationId,
        detail: [
          ...validated.safetySignals.map(
            (signal) => `${signal.category}:${signal.recommendedAction}`,
          ),
          ...(validated.handoff ? ["handoff"] : []),
        ],
      });
    }

    await this.summaries.notifyIfLastConversationClosed(
      conversation.campaignId,
      input.correlationId,
      committed.state.closedNow,
    );

    return this.complete(
      {
        outcome:
          committed.closingReason ??
          (validated.handoff ? "handoff" : "extracted"),
        conversationId: conversation._id,
        cursorSeq,
        answersWritten: committed.written.answersWritten,
        notesWritten: committed.written.notesWritten,
        ...(committed.effectiveOutbox
          ? { outboxId: committed.effectiveOutbox.id }
          : {}),
        model: generated.model,
      },
      input.correlationId,
    );
  }

  /**
   * Cheap exits from reloaded state (STOP, takeover, or a newer run may have
   * landed while the job waited).
   */
  private skipOutcome(
    conversation: FeedbackConversationDocument,
    latestSeq: number,
  ): FeedbackExtractOutcome | undefined {
    if (conversation.lifecycle.state === "closed") {
      return "skipped_closed";
    }
    if (conversation.control.mode === "human") {
      return "skipped_human_control";
    }
    // `awaitingHuman` is still bot control; the bot must not resume.
    if (conversation.awaitingHuman) {
      return "skipped_awaiting_human";
    }
    if (conversation.extraction.cursorSeq >= latestSeq) {
      return "skipped_cursor";
    }
    if (this.stillTyping(conversation)) {
      return "skipped_still_typing";
    }
    return undefined;
  }

  /**
   * Burst not over: stand down. Defensive for V1/old-binary wakes whose due
   * time can land while the participant is still typing. Newest-message run
   * always proceeds (`>=`); cursor stays put.
   */
  private stillTyping(conversation: FeedbackConversationDocument): boolean {
    const spokeAt = latestParticipantMessage(conversation)?.at;
    return (
      spokeAt !== undefined &&
      Date.now() - spokeAt.getTime() < FEEDBACK_EXTRACT_QUIET_WINDOW_MS
    );
  }

  private async buildContext(
    conversation: FeedbackConversationDocument,
    campaign: FeedbackCampaignRow,
  ): Promise<FeedbackExtractionContext> {
    // D16: candidates from current attendance, not a stored list.
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
      // Missing PG outbox row stays model-visible. Only a present
      // pre-send/failed/cancelled row hides the conversation turn.
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
      // No venue in the prompt → later enable cannot invalidate this run.
      venueContextRevision: venue.venue === null ? null : venue.contextRevision,
      // Kill switch: paused/closed campaign persists results but enqueues nothing.
      replyAllowed:
        conversation.lifecycle.state === "open" &&
        conversation.control.mode === "bot" &&
        participant?.postEventFeedbackWhatsappOptIn === true &&
        campaign.status === "launched",
    };
  }

  /**
   * Last look before a phone send. Snapshot is pre-provider; takeover, close
   * or consent withdraw can land during the call. Every reason but newer
   * testimony silences all outbound including close/handoff. Newer testimony
   * drops only an ordinary reply. Answers/notes/cursor still write. Reasons
   * are DB reads so replay agrees.
   */
  private async reviewBeforeSending(input: {
    readonly conversation: FeedbackConversationDocument;
    readonly cursorSeq: number;
    readonly staleOnNewerTestimony: boolean;
    readonly executionClaim?: FeedbackConversationExecutionClaim;
  }): Promise<string | undefined> {
    const current = await this.conversations.findById(input.conversation._id);
    if (!current) {
      if (input.executionClaim) {
        throw new FeedbackConversationExecutionGuardError(
          input.conversation._id,
          "execution_invariant_broken",
        );
      }
      return "conversation_missing";
    }
    if (input.executionClaim) {
      const guardReason = executionSnapshotGuardReason(
        current,
        input.conversation,
        input.executionClaim,
      );
      if (
        guardReason === "execution_claim_lost" ||
        guardReason === "execution_invariant_broken"
      ) {
        throw new FeedbackConversationExecutionGuardError(
          input.conversation._id,
          guardReason,
        );
      }
      if (guardReason === "authoritative_state_changed") {
        if (current.lifecycle.state !== "open") {
          return "conversation_closed";
        }
        if (current.control.mode !== "bot") {
          return "human_control";
        }
        return "superseded_by_newer_work";
      }
    }
    if (current.lifecycle.state !== "open") {
      return "conversation_closed";
    }
    if (current.control.mode !== "bot") {
      return "human_control";
    }

    const participant = await this.participants.findById(
      input.conversation.respondentParticipantId,
    );
    if (!participant?.postEventFeedbackWhatsappOptIn) {
      return "consent_withdrawn";
    }

    if (
      input.staleOnNewerTestimony &&
      current.messages.some(
        (message) =>
          message.actor === "participant" && message.seq > input.cursorSeq,
      )
    ) {
      return "superseded_by_newer_testimony";
    }
    return undefined;
  }

  /**
   * Provider-entry boundary, inside the limiter slot, before billing. Lock
   * order: ingress, conversation mutex, execution token, campaign, consent;
   * conversation read last. Commits before the network call.
   */
  private async assertExecutionCurrent(
    claim: FeedbackConversationExecutionClaim,
    snapshot: FeedbackConversationDocument,
  ): Promise<void> {
    if (claim.conversationId !== snapshot._id) {
      throw new FeedbackConversationExecutionGuardError(
        snapshot._id,
        "execution_invariant_broken",
      );
    }
    await this.database.transaction(async (transaction) => {
      // Ingress first: in-flight ACK commits before we inspect; later waits.
      await this.ingress.lockInboundPhone(transaction, snapshot.phoneAtLaunch);
      // Conversation mutex second (STOP / takeover / close / awaiting-human).
      await this.results.lockConversation(transaction, snapshot._id);

      const executionCurrent = await this.executionFence.isCurrent(
        transaction,
        claim,
      );
      const campaign = await this.campaigns.findCampaignByIdForShare(
        transaction,
        snapshot.campaignId,
      );
      const participant = await this.participants.findByIdForUpdate(
        transaction,
        snapshot.respondentParticipantId,
      );
      const newerInbound = await this.ingress.hasInboundBeyondSnapshot(
        transaction,
        {
          phoneE164: snapshot.phoneAtLaunch,
          conversationId: snapshot._id,
          snapshotIngressIds: snapshot.messages.flatMap((message) =>
            message.actor === "participant" && message.ingressId
              ? [message.ingressId]
              : [],
          ),
        },
      );
      if (!executionCurrent) {
        throw new FeedbackConversationExecutionGuardError(
          snapshot._id,
          "execution_claim_lost",
        );
      }
      if (!campaign || !participant) {
        throw new FeedbackConversationExecutionGuardError(
          snapshot._id,
          "execution_invariant_broken",
        );
      }
      if (
        campaign.status !== "launched" ||
        !participant.postEventFeedbackWhatsappOptIn ||
        newerInbound
      ) {
        throw new FeedbackConversationExecutionGuardError(
          snapshot._id,
          "authoritative_state_changed",
        );
      }

      // Conversation row last while the other fences are held. Passing this
      // read is provider entry.
      const conversation = await this.conversations.findById(
        snapshot._id,
        transaction,
      );
      const guardReason = executionSnapshotGuardReason(
        conversation,
        snapshot,
        claim,
      );
      if (guardReason) {
        throw new FeedbackConversationExecutionGuardError(
          snapshot._id,
          guardReason,
        );
      }
    });
  }

  /**
   * Writes paid snapshot results and the outbound row on the caller's
   * transaction. Does not open a nested transaction.
   */
  private async persistOn(
    transaction: AppTransaction,
    input: {
      readonly conversation: FeedbackConversationDocument;
      readonly campaign: FeedbackCampaignRow;
      readonly context: FeedbackExtractionContext;
      readonly validated: FeedbackExtractionValidationResult;
      readonly outbound: OutboundReply | undefined;
      readonly ordinaryReply: boolean;
      readonly model: string;
      readonly correlationId: string;
      readonly closingReason: "completed" | "declined" | null;
      readonly goalStatuses: readonly GoalStatusUpdate[];
      readonly executionClaim?: FeedbackConversationExecutionClaim;
    },
  ): Promise<{
    answersWritten: number;
    notesWritten: number;
    outbox?: MessageOutboxRow;
    outboundSuppressedByNewerIngress: boolean;
    outboundSuppressedByLegacyClosing: boolean;
    executionSuperseded: boolean;
  }> {
    const candidateIds = input.context.candidates.map(
      (candidate) => candidate.participantId,
    );
    // Record abuse-cited `avoid`; hold matching so it never seats.
    const heldMessageIds = respondentSourceMessageIds(
      input.validated.safetySignals,
    );

    let outboundSuppressedByNewerIngress = false;
    if (
      input.outbound &&
      (input.ordinaryReply || input.closingReason !== null)
    ) {
      await this.ingress.lockInboundPhone(
        transaction,
        input.conversation.phoneAtLaunch,
      );
      outboundSuppressedByNewerIngress =
        await this.ingress.hasInboundBeyondSnapshot(transaction, {
          phoneE164: input.conversation.phoneAtLaunch,
          conversationId: input.conversation._id,
          snapshotIngressIds: input.conversation.messages.flatMap((message) =>
            message.actor === "participant" && message.ingressId
              ? [message.ingressId]
              : [],
          ),
        });
    }

    const venueRevision = input.context.venueContextRevision;
    if (
      typeof venueRevision === "number" &&
      !(await this.events.feedbackVenueContextIsCurrent(
        transaction,
        input.campaign.eventId,
        venueRevision,
      ))
    ) {
      // Shared event lock: raced venue edit retries; later edit waits.
      throw new FeedbackExtractionGenerationError(
        "extraction_failed",
        true,
        "validation_failed",
      );
    }

    await this.results.lockConversation(transaction, input.conversation._id);

    // Execution after conversation mutex (same order as provider entry).
    if (
      input.executionClaim &&
      !(await this.executionFence.renewWithin(
        transaction,
        input.executionClaim,
      ))
    ) {
      throw new FeedbackConversationExecutionGuardError(
        input.conversation._id,
        "execution_claim_lost",
      );
    }

    const currentConversation = input.executionClaim
      ? await this.conversations.findById(input.conversation._id, transaction)
      : undefined;
    const executionGuardReason = input.executionClaim
      ? executionSnapshotGuardReason(
          currentConversation,
          input.conversation,
          input.executionClaim,
        )
      : undefined;
    if (
      executionGuardReason === "execution_claim_lost" ||
      executionGuardReason === "execution_invariant_broken"
    ) {
      throw new FeedbackConversationExecutionGuardError(
        input.conversation._id,
        executionGuardReason,
      );
    }
    const executionSuperseded =
      executionGuardReason === "authoritative_state_changed";

    let answersWritten = 0;
    for (const answer of input.validated.answers) {
      // Subject move: delete contradicted keys, do not keep a second opinion.
      if (answer.subjectParticipantId) {
        await this.results.deleteContradictedAnswers(transaction, {
          conversationId: input.conversation._id,
          subjectParticipantId: answer.subjectParticipantId,
          questionKeys: contradictedPostEventFeedbackQuestionKeys(
            answer.questionKey,
            input.context.goals.map((goal) => goal.key),
          ),
        });
      }
      const inserted = await this.results.insertAnswerIfAbsent(transaction, {
        campaignId: input.campaign.id,
        conversationId: input.conversation._id,
        respondentParticipantId: input.conversation.respondentParticipantId,
        subjectParticipantId: answer.subjectParticipantId,
        questionKey: answer.questionKey,
        valueInt: answer.valueInt,
        sourceMessageIds: answer.sourceMessageIds,
        extractionMeta: buildExtractionMeta({
          model: input.model,
          confidence: answer.confidence,
          candidateIds,
        }),
        matchingHold: answer.sourceMessageIds.some((messageId) =>
          heldMessageIds.has(messageId),
        ),
      });
      if (inserted) {
        answersWritten += 1;
      }
    }

    // Note replay guard: content signature inside the locked transaction.
    const storedNotes = await this.results.listNotesByConversation(
      input.conversation._id,
      transaction,
    );
    const storedNoteKeys = new Set(
      storedNotes.map((note) =>
        noteSignature(
          note.noteType,
          note.text,
          note.subjectParticipantId ?? null,
        ),
      ),
    );

    let notesWritten = 0;
    for (const note of input.validated.notes) {
      const signature = noteSignature(
        note.noteType,
        note.text,
        note.subjectParticipantId,
      );
      if (storedNoteKeys.has(signature)) {
        continue;
      }
      storedNoteKeys.add(signature);
      await this.results.insertNote(transaction, {
        campaignId: input.campaign.id,
        conversationId: input.conversation._id,
        respondentParticipantId: input.conversation.respondentParticipantId,
        subjectParticipantId: note.subjectParticipantId,
        noteType: note.noteType,
        text: note.text,
        sourceMessageIds: note.sourceMessageIds,
        extractionMeta: buildExtractionMeta({
          model: input.model,
          confidence: note.confidence,
          candidateIds,
          flaggedForReview: note.flaggedForReview,
          unresolvedSubjectName: note.unresolvedSubjectName,
        }),
      });
      notesWritten += 1;
    }

    // D13: incident audit is look-here, not the words (those are notes).
    if (isSafetyOrHandoffAttention(input.validated)) {
      await this.audit.append(transaction, {
        actorType: "system",
        actorId: "feedback_extraction",
        action:
          input.validated.safetySignals.length > 0
            ? "feedback_conversation.safety_signalled"
            : "feedback_conversation.handoff_requested",
        entityType: "feedback_conversation",
        entityId: input.conversation._id,
        requestId: input.correlationId,
        context: {
          campaignId: input.conversation.campaignId,
          model: input.model,
          confidence: input.validated.confidence,
          safetySignal: input.validated.safetySignals.length > 0,
          safetySignals: input.validated.safetySignals.map((signal) => ({
            category: signal.category,
            recommendedAction: signal.recommendedAction,
            sourceMessageIds: [...signal.sourceMessageIds],
            confidence: signal.confidence,
          })),
          handoff: input.validated.handoff,
        },
      });
    }

    let outbox: MessageOutboxRow | undefined;
    let outboundSuppressedByLegacyClosing = false;
    if (
      input.outbound &&
      input.closingReason !== null &&
      !outboundSuppressedByNewerIngress &&
      !executionSuperseded
    ) {
      const legacyClosing =
        await this.outbox.resolveLegacyClosingBeforeAnchoredInsert(
          transaction,
          `${FEEDBACK_CLOSING_DEDUPE_PREFIX}-${input.conversation._id}`,
        );
      outboundSuppressedByLegacyClosing =
        legacyClosing.outcome === "provider_crossed";
    }
    if (
      input.outbound &&
      !outboundSuppressedByNewerIngress &&
      !outboundSuppressedByLegacyClosing &&
      !executionSuperseded
    ) {
      const enqueued = await this.outbox.insertOutboxIfAbsent(transaction, {
        conversationId: input.conversation._id,
        campaignId: input.campaign.id,
        kind: "reply",
        body: input.outbound.body,
        dedupeKey: input.outbound.dedupeKey,
      });
      await this.outboundLog.record(transaction, {
        outbox: enqueued,
        conversation: input.conversation,
        decision: {
          origin: "extraction_reply",
          model: input.model,
          confidence: input.validated.confidence ?? null,
          closingReason: input.closingReason,
          askedGoal: input.outbound.askedGoal ?? null,
          venueContextRevision: input.context.venueContextRevision ?? null,
          goalStatuses: input.goalStatuses.map(({ key, status }) => ({
            key,
            status,
          })),
        },
        correlationId: input.correlationId,
      });
      outbox = enqueued.row;
    }

    return {
      answersWritten,
      notesWritten,
      outboundSuppressedByNewerIngress,
      outboundSuppressedByLegacyClosing,
      executionSuperseded,
      ...(outbox ? { outbox } : {}),
    };
  }

  /**
   * Goals, attention, cursor, terminal close and handoff on the caller's
   * transaction. Operator alerts are returned for the caller to fire after
   * commit.
   */
  private async applyConversationStateOn(
    transaction: AppTransaction,
    input: {
      readonly conversation: FeedbackConversationDocument;
      readonly validated: FeedbackExtractionValidationResult;
      readonly goalStatuses: readonly GoalStatusUpdate[];
      readonly closingReason: "completed" | "declined" | null;
      /** Exact outbox row atomically authorized by an extraction-driven close. */
      readonly terminalOutboxId: string | null;
      readonly dutyOfCare: boolean;
      readonly withdrew: boolean;
      readonly hostility: FeedbackHostilityRaise;
      /** This snapshot atomically consumes its cursor and silences the bot. */
      readonly awaitingHuman: boolean;
      /** Exact participant-facing commitment allowed to survive the bot brake. */
      readonly handoffOutboxId: string | null;
      /** Whether this run advances the hostility ladder by one rung. */
      readonly hostileTurn: boolean;
      /** The count this run decided from — the compare-and-set's expected value. */
      readonly priorHostileTurns: number;
      /** The anchor for a reason this run raised that cites no message itself. */
      readonly newestParticipantMessageId: string | null;
      /**
       * The bot message whose campaign copy the re-ask cap refused to repeat, or
       * null. Its own anchor, so the raise is filed once rather than once per
       * message the participant sends afterwards.
       */
      readonly stalledOnMessageId: string | null;
      /**
       * Messages that asked a data-handling question we have deliberately not
       * answered. Each earns an `unanswered_data_question` reason on its anchor.
       */
      readonly unansweredDataQuestionMessageIds: readonly string[];
      readonly cursorSeq: number;
      readonly model: string;
      /** What this run's two model calls cost, added to the conversation's total. */
      readonly usage: FeedbackExtractionUsage;
      /** The tier this run bought, or null. Overwrites — it is not a quantity. */
      readonly serviceTier: string | null;
      /** A newer work/control generation owns the next state transition. */
      readonly workSuperseded: boolean;
      readonly executionClaim?: FeedbackConversationExecutionClaim;
    },
  ): Promise<{
    readonly closedNow: boolean;
    readonly terminalCommitted: boolean;
    readonly raisedIncident: boolean;
  }> {
    const at = new Date();

    if (input.goalStatuses.length > 0) {
      await this.conversations.updateGoalStatuses(transaction, {
        conversationId: input.conversation._id,
        statuses: input.goalStatuses,
        at,
      });
    }

    for (const attention of groupSafetySignalsByMessage(
      input.validated.safetySignals,
    )) {
      await this.conversations.mergeMessageAttention(transaction, {
        conversationId: input.conversation._id,
        messageId: attention.messageId,
        categories: attention.categories,
        recommendedAction: attention.recommendedAction,
        confidence: attention.confidence,
        at,
      });
    }

    if (input.hostileTurn) {
      await this.conversations.recordHostileTurn(transaction, {
        conversationId: input.conversation._id,
        at,
        expectedCount: input.priorHostileTurns,
      });
    }

    const raises = operatorAttentionRaises(
      input.validated,
      input.newestParticipantMessageId,
      input.withdrew,
      input.hostility,
      input.stalledOnMessageId,
      input.unansweredDataQuestionMessageIds,
    );
    let raisedIncident = false;
    for (const raise of raises) {
      const attention = await this.conversations.raiseAttention(transaction, {
        conversationId: input.conversation._id,
        kind: raise.kind,
        messageId: raise.messageId,
        at,
      });
      raisedIncident ||=
        attention.changed &&
        (raise.kind === "safety" || raise.kind === "handoff");
    }

    if (input.workSuperseded) {
      return { closedNow: false, terminalCommitted: false, raisedIncident };
    }

    if (input.closingReason) {
      const closingReason = input.closingReason;
      await this.results.lockConversation(transaction, input.conversation._id);
      const transition = await this.conversations.advanceCursorAndClose(
        transaction,
        {
          conversationId: input.conversation._id,
          toSeq: input.cursorSeq,
          reason: closingReason,
          terminalOutboxId: input.terminalOutboxId,
          at,
          model: input.model,
          serviceTier: input.serviceTier,
          usage: input.usage,
          ...(input.executionClaim
            ? {
                workRevision: input.executionClaim.workRevision,
                executionEpoch: input.executionClaim.epoch,
              }
            : {}),
        },
      );
      const committed =
        transition.changed ||
        (transition.conversation.lifecycle.state === "closed" &&
          transition.conversation.lifecycle.reason === closingReason &&
          transition.conversation.lifecycle.terminalOutboxId ===
            input.terminalOutboxId);
      if (committed) {
        await this.outbox.cancelQueuedOutboxForConversationExceptId(
          transaction,
          input.conversation._id,
          input.terminalOutboxId,
        );
      }
      if (transition.changed) {
        return { closedNow: true, terminalCommitted: true, raisedIncident };
      }
      if (committed) {
        return { closedNow: false, terminalCommitted: true, raisedIncident };
      }

      if (
        transition.conversation.messages.some(
          (message) =>
            message.actor === "participant" && message.seq > input.cursorSeq,
        )
      ) {
        await this.conversations.advanceCursor(transaction, {
          conversationId: input.conversation._id,
          toSeq: input.cursorSeq,
          at,
          model: input.model,
          serviceTier: input.serviceTier,
          usage: input.usage,
        });
      }
      return { closedNow: false, terminalCommitted: false, raisedIncident };
    }

    if (input.awaitingHuman) {
      await this.results.lockConversation(transaction, input.conversation._id);
      const transition =
        await this.conversations.advanceCursorAndMarkAwaitingHuman(
          transaction,
          {
            conversationId: input.conversation._id,
            toSeq: input.cursorSeq,
            at,
            model: input.model,
            serviceTier: input.serviceTier,
            usage: input.usage,
            ...(input.executionClaim
              ? {
                  workRevision: input.executionClaim.workRevision,
                  executionEpoch: input.executionClaim.epoch,
                }
              : {}),
          },
        );
      const committed =
        transition.changed || transition.conversation.awaitingHuman;
      await this.outbox.cancelQueuedAutomatedOutboxForConversation(
        transaction,
        input.conversation._id,
        committed ? input.handoffOutboxId : null,
      );
      if (!committed) {
        const guardReason = input.executionClaim
          ? (executionSnapshotGuardReason(
              transition.conversation,
              input.conversation,
              input.executionClaim,
            ) ?? "execution_invariant_broken")
          : "authoritative_state_changed";
        throw new FeedbackConversationExecutionGuardError(
          input.conversation._id,
          guardReason,
        );
      }
    } else {
      await this.conversations.advanceCursor(transaction, {
        conversationId: input.conversation._id,
        toSeq: input.cursorSeq,
        at,
        model: input.model,
        serviceTier: input.serviceTier,
        usage: input.usage,
        ...(input.executionClaim
          ? {
              workRevision: input.executionClaim.workRevision,
              executionEpoch: input.executionClaim.epoch,
            }
          : {}),
      });
    }

    return { closedNow: false, terminalCommitted: false, raisedIncident };
  }

  /**
   * After a persist transaction rejects on transcript capacity, the paid
   * snapshot is gone. Park the bot so reconcile cannot buy another model
   * call for a metadata write that cannot succeed.
   */
  private async brakeAfterTranscriptCapacity(
    conversation: FeedbackConversationDocument,
    input: ExtractFeedbackInput,
  ): Promise<ExtractFeedbackResult> {
    this.logger.warn({
      event: "feedback.extract.transcript_capacity",
      correlationId: input.correlationId,
      conversationId: conversation._id,
    });

    const outcome = await this.database.transaction(async (transaction) => {
      await this.results.lockConversation(transaction, conversation._id);

      if (input.executionClaim) {
        if (
          !(await this.executionFence.renewWithin(
            transaction,
            input.executionClaim,
          ))
        ) {
          throw new FeedbackConversationExecutionGuardError(
            conversation._id,
            "execution_claim_lost",
          );
        }
      }

      // Campaign resume updates these rows without the conversation mutex.
      const current = await this.conversations.findByIdForUpdate(
        transaction,
        conversation._id,
      );
      if (input.executionClaim) {
        const guardReason = executionSnapshotGuardReason(
          current,
          conversation,
          input.executionClaim,
        );
        if (guardReason) {
          throw new FeedbackConversationExecutionGuardError(
            conversation._id,
            guardReason,
          );
        }
      } else {
        if (!current) {
          throw new PostEventFeedbackConversationNotFoundError(
            conversation._id,
          );
        }
        const skipped = this.skipOutcome(current, current.messages.length);
        if (
          skipped === "skipped_closed" ||
          skipped === "skipped_human_control" ||
          skipped === "skipped_awaiting_human"
        ) {
          return skipped;
        }
        if (
          (current.work?.revision ?? 0) !==
            (conversation.work?.revision ?? 0) ||
          current.control.changedAt.getTime() !==
            conversation.control.changedAt.getTime()
        ) {
          throw new FeedbackConversationExecutionGuardError(
            conversation._id,
            "authoritative_state_changed",
          );
        }
      }

      const at = new Date();
      await this.conversations.raiseAttention(transaction, {
        conversationId: conversation._id,
        kind: "transcript_full",
        messageId: null,
        at,
      });
      await this.conversations.markAwaitingHuman(transaction, {
        conversationId: conversation._id,
        at,
      });
      await this.outbox.cancelQueuedAutomatedOutboxForConversation(
        transaction,
        conversation._id,
      );
      return "skipped_awaiting_human" as const;
    });

    return this.complete(
      {
        outcome,
        conversationId: conversation._id,
        cursorSeq: conversation.extraction.cursorSeq,
        answersWritten: 0,
        notesWritten: 0,
      },
      input.correlationId,
    );
  }

  private complete(
    result: ExtractFeedbackResult,
    correlationId: string,
  ): ExtractFeedbackResult {
    this.metrics.recordExtractOutcome(result.outcome, correlationId);
    return result;
  }
}

/** Classifies the conversation half of one PostgreSQL execution claim. */
function executionSnapshotGuardReason(
  current: FeedbackConversationDocument | undefined,
  snapshot: FeedbackConversationDocument,
  claim: FeedbackConversationExecutionClaim,
): FeedbackConversationExecutionGuardReason | undefined {
  if (
    claim.conversationId !== snapshot._id ||
    !snapshot.work ||
    !current ||
    !current.work
  ) {
    return "execution_invariant_broken";
  }

  if (current.work.executionEpoch > claim.epoch) {
    return "execution_claim_lost";
  }
  if (current.work.executionEpoch < claim.epoch) {
    return "execution_invariant_broken";
  }
  if (current.work.revision > claim.workRevision) {
    return "authoritative_state_changed";
  }
  if (current.work.revision < claim.workRevision) {
    return "execution_invariant_broken";
  }
  if (
    current.lifecycle.state !== "open" ||
    current.control.mode !== "bot" ||
    current.awaitingHuman ||
    current.control.changedAt.getTime() !== snapshot.control.changedAt.getTime()
  ) {
    return "authoritative_state_changed";
  }
  return undefined;
}

/** D12: persist model, confidence, and this run's D16 candidate ids. */
function buildExtractionMeta(input: {
  readonly model: string;
  readonly confidence: number;
  readonly candidateIds: readonly string[];
  readonly flaggedForReview?: boolean;
  readonly unresolvedSubjectName?: string | null;
}): FeedbackExtractionMeta {
  return {
    model: input.model,
    confidence: input.confidence,
    candidateIds: [...input.candidateIds],
    ...(input.flaggedForReview ? { flaggedForReview: true } : {}),
    ...(input.unresolvedSubjectName
      ? { unresolvedSubjectName: input.unresolvedSubjectName }
      : {}),
  };
}
