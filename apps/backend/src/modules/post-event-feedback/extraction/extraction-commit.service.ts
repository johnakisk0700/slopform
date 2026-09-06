import { Injectable, Logger } from "@nestjs/common";
import type {
  AppTransaction,
  FeedbackCampaignRow,
  FeedbackExtractionMeta,
  MessageOutboxRow,
} from "@slopform/database";

import { AuditRepository } from "../../../infrastructure/audit/audit.repository.js";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { EventsService } from "../../events/events.service.js";
import type { FeedbackConversationDocument } from "../post-event-feedback-conversation.document.js";
import { FeedbackConversationRepository } from "../post-event-feedback-conversation.repository.js";
import { FeedbackIngressRepository } from "../ingress/ingress.repository.js";
import { FeedbackOutboxRepository } from "../outbox/outbox.repository.js";
import { FeedbackOutboundLogService } from "../outbox/outbound-log.service.js";
import { FeedbackOutboundTranscriptService } from "../outbox/outbound-transcript.service.js";
import {
  contradictedPostEventFeedbackQuestionKeys,
  noteSignature,
} from "../question-set.js";
import { decideExtractionTurn } from "./turn-decision.js";
import { skipExtractOutcome } from "./extract-admission.js";
import {
  PostEventFeedbackConversationNotFoundError,
  type ExtractCommitResult,
  type ExtractConversationState,
  type ExtractFeedbackResult,
  type ExtractPersistWritten,
  type ExtractPlannedTurn,
  type ExtractRunSnapshot,
} from "./extract.types.js";
import {
  FeedbackConversationExecutionGuardError,
  executionSnapshotGuardReason,
} from "./execution-guard.js";
import type { FeedbackConversationExecutionClaim } from "./execution-fence.repository.js";
import { FeedbackConversationExecutionFence } from "./execution-fence.service.js";
import { FeedbackResultsRepository } from "./results.repository.js";
import {
  groupSafetySignalsByMessage,
  isSafetyOrHandoffAttention,
  operatorAttentionRaises,
  respondentSourceMessageIds,
  type FeedbackHostilityRaise,
} from "./operator-attention.js";
import type { OutboundReply } from "./outbound-reply.js";
import type { GoalStatusUpdate } from "./goal-progress.js";
import type { FeedbackExtractionContext } from "./extraction.schemas.js";
import { FEEDBACK_CLOSING_DEDUPE_PREFIX } from "./extraction.schemas.js";
import type { FeedbackExtractionValidationResult } from "./validate-proposal.js";
import {
  FeedbackExtractionGenerationError,
  type FeedbackExtractionUsage,
} from "./model.service.js";

/**
 * One persist transaction for results, supersession, outbox, audit, state and
 * terminal transcript identity. Capacity brake is a later, separate transaction.
 */
@Injectable()
export class FeedbackExtractionCommitService {
  private readonly logger = new Logger(FeedbackExtractionCommitService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly ingress: FeedbackIngressRepository,
    private readonly events: EventsService,
    private readonly results: FeedbackResultsRepository,
    private readonly executionFence: FeedbackConversationExecutionFence,
    private readonly conversations: FeedbackConversationRepository,
    private readonly outbox: FeedbackOutboxRepository,
    private readonly audit: AuditRepository,
    private readonly outboundTranscript: FeedbackOutboundTranscriptService,
    private readonly outboundLog: FeedbackOutboundLogService,
  ) {}

  async commit(
    snapshot: ExtractRunSnapshot,
    planned: ExtractPlannedTurn,
  ): Promise<ExtractCommitResult> {
    return this.database.transaction(async (transaction) => {
      let closingReason = planned.closingReason;
      let goalStatuses = planned.goalStatuses;
      let withdrew = planned.withdrew;
      let hostility = planned.hostility;

      const written = await this.persistOn(transaction, {
        conversation: snapshot.conversation,
        campaign: snapshot.campaign,
        context: planned.context,
        validated: planned.validated,
        outbound: planned.outbound,
        ordinaryReply: planned.ordinaryReply,
        model: planned.model,
        correlationId: snapshot.correlationId,
        closingReason,
        goalStatuses,
        ...(snapshot.executionClaim
          ? { executionClaim: snapshot.executionClaim }
          : {}),
      });

      if (
        written.outboundSuppressedByNewerIngress ||
        written.executionSuperseded
      ) {
        const recomputed = this.recomputeTurnAfterSuppression(
          snapshot,
          planned,
          written,
          closingReason,
        );
        closingReason = recomputed.closingReason;
        goalStatuses = recomputed.goalStatuses;
        withdrew = recomputed.withdrew;
        hostility = recomputed.hostility;
      }

      if (written.outboundSuppressedByLegacyClosing) {
        this.logger.warn({
          event: "feedback.extract.legacy_closing_provider_crossed",
          correlationId: snapshot.correlationId,
          conversationId: snapshot.conversation._id,
        });
        closingReason = null;
      }

      await this.assertClaimStillCurrent(transaction, snapshot);

      if (written.outboundSuppressedByLegacyClosing) {
        await this.conversations.raiseAttention(transaction, {
          conversationId: snapshot.conversation._id,
          kind: "undelivered_message",
          messageId: null,
          at: new Date(),
        });
      }

      return this.applyStateAndTranscriptIdentity(transaction, snapshot, {
        planned,
        written,
        closingReason,
        goalStatuses,
        withdrew,
        hostility,
      });
    });
  }

  /**
   * After a persist transaction rejects on transcript capacity, the paid
   * snapshot is gone. Park the bot so reconcile cannot buy another model
   * call for a metadata write that cannot succeed.
   */
  async brakeAfterCapacity(
    snapshot: ExtractRunSnapshot,
  ): Promise<ExtractFeedbackResult> {
    const conversation = snapshot.conversation;
    this.logger.warn({
      event: "feedback.extract.transcript_capacity",
      correlationId: snapshot.correlationId,
      conversationId: conversation._id,
    });

    const outcome = await this.database.transaction(async (transaction) => {
      await this.results.lockConversation(transaction, conversation._id);

      if (snapshot.executionClaim) {
        if (
          !(await this.executionFence.renewWithin(
            transaction,
            snapshot.executionClaim,
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
      if (snapshot.executionClaim) {
        const guardReason = executionSnapshotGuardReason(
          current,
          conversation,
          snapshot.executionClaim,
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
        const skipped = skipExtractOutcome(current, current.messages.length);
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

    return {
      outcome,
      conversationId: conversation._id,
      cursorSeq: conversation.extraction.cursorSeq,
      answersWritten: 0,
      notesWritten: 0,
    };
  }

  private recomputeTurnAfterSuppression(
    snapshot: ExtractRunSnapshot,
    planned: ExtractPlannedTurn,
    written: ExtractPersistWritten,
    closingReason: "completed" | "declined" | null,
  ): {
    readonly closingReason: "completed" | "declined" | null;
    readonly goalStatuses: readonly GoalStatusUpdate[];
    readonly withdrew: boolean;
    readonly hostility: FeedbackHostilityRaise;
  } {
    const suppressionReason = written.executionSuperseded
      ? "superseded_by_newer_work"
      : "superseded_by_durable_ingress";
    this.logger.log({
      event: "feedback.extract.outbound_withheld",
      correlationId: snapshot.correlationId,
      conversationId: snapshot.conversation._id,
      cursorSeq: snapshot.cursorSeq,
      reason: suppressionReason,
    });
    const decided = decideExtractionTurn({
      conversation: snapshot.conversation,
      validated: planned.validated,
      recordedStatuses: planned.recordedStatuses,
      askedGoal: undefined,
      outboundSent: false,
      dutyOfCare: planned.dutyOfCare,
      stoppingForHostility: planned.stoppingForHostility,
      hostileWithoutAnswers: planned.hostileWithoutAnswers,
    });
    return {
      goalStatuses: decided.goalStatuses,
      withdrew: decided.withdrew,
      hostility: decided.hostility,
      closingReason: closingReason ? null : decided.closingReason,
    };
  }

  private async assertClaimStillCurrent(
    transaction: AppTransaction,
    snapshot: ExtractRunSnapshot,
  ): Promise<void> {
    if (
      snapshot.executionClaim &&
      !(await this.executionFence.isCurrent(
        transaction,
        snapshot.executionClaim,
      ))
    ) {
      throw new FeedbackConversationExecutionGuardError(
        snapshot.conversation._id,
        "execution_claim_lost",
      );
    }
  }

  private async applyStateAndTranscriptIdentity(
    transaction: AppTransaction,
    snapshot: ExtractRunSnapshot,
    input: {
      readonly planned: ExtractPlannedTurn;
      readonly written: ExtractPersistWritten;
      readonly closingReason: "completed" | "declined" | null;
      readonly goalStatuses: readonly GoalStatusUpdate[];
      readonly withdrew: boolean;
      readonly hostility: FeedbackHostilityRaise;
    },
  ): Promise<ExtractCommitResult> {
    let closingReason = input.closingReason;
    let effectiveOutbox = input.written.outbox;
    if (effectiveOutbox && closingReason === null) {
      await this.outboundTranscript.record(
        transaction,
        effectiveOutbox,
        new Date(),
        snapshot.correlationId,
      );
    }

    const terminalReason = closingReason;
    const state = await this.applyConversationStateOn(transaction, {
      conversation: snapshot.conversation,
      validated: input.planned.validated,
      goalStatuses: input.goalStatuses,
      closingReason,
      terminalOutboxId:
        closingReason !== null ? (effectiveOutbox?.id ?? null) : null,
      dutyOfCare: input.planned.dutyOfCare,
      withdrew: input.withdrew,
      hostility: input.hostility,
      awaitingHuman:
        input.written.outboundSuppressedByLegacyClosing ||
        input.planned.dutyOfCare ||
        input.withdrew ||
        input.hostility === "stopped",
      handoffOutboxId:
        closingReason === null &&
        (input.written.outboundSuppressedByLegacyClosing ||
          input.planned.dutyOfCare ||
          input.withdrew ||
          input.hostility === "stopped")
          ? (effectiveOutbox?.id ?? null)
          : null,
      hostileTurn: input.planned.hostileTurn,
      priorHostileTurns: snapshot.conversation.hostileTurns,
      newestParticipantMessageId: input.planned.newestParticipantMessageId,
      stalledOnMessageId: input.planned.stalledOnMessageId,
      unansweredDataQuestionMessageIds:
        input.planned.unansweredDataQuestionMessageIds,
      cursorSeq: snapshot.cursorSeq,
      model: input.planned.model,
      usage: input.planned.runUsage,
      serviceTier: input.planned.serviceTier,
      workSuperseded:
        input.written.executionSuperseded ||
        input.planned.replyRewriteSuperseded,
      ...(snapshot.executionClaim
        ? { executionClaim: snapshot.executionClaim }
        : {}),
    });

    if (effectiveOutbox && terminalReason !== null) {
      if (state.terminalCommitted) {
        await this.outboundTranscript.record(
          transaction,
          effectiveOutbox,
          new Date(),
          snapshot.correlationId,
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
      written: input.written,
      state,
      closingReason,
      raisedIncident: state.raisedIncident,
      ...(effectiveOutbox ? { effectiveOutbox } : {}),
    };
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
  ): Promise<ExtractPersistWritten> {
    const candidateIds = input.context.candidates.map(
      (candidate) => candidate.participantId,
    );
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
      throw new FeedbackExtractionGenerationError(
        "extraction_failed",
        true,
        "validation_failed",
      );
    }

    await this.results.lockConversation(transaction, input.conversation._id);

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
      readonly terminalOutboxId: string | null;
      readonly dutyOfCare: boolean;
      readonly withdrew: boolean;
      readonly hostility: FeedbackHostilityRaise;
      readonly awaitingHuman: boolean;
      readonly handoffOutboxId: string | null;
      readonly hostileTurn: boolean;
      readonly priorHostileTurns: number;
      readonly newestParticipantMessageId: string | null;
      readonly stalledOnMessageId: string | null;
      readonly unansweredDataQuestionMessageIds: readonly string[];
      readonly cursorSeq: number;
      readonly model: string;
      readonly usage: FeedbackExtractionUsage;
      readonly serviceTier: string | null;
      readonly workSuperseded: boolean;
      readonly executionClaim?: FeedbackConversationExecutionClaim;
    },
  ): Promise<ExtractConversationState> {
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
