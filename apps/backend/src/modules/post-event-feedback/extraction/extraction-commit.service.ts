import { Injectable } from "@nestjs/common";
import type {
  FeedbackExtractionPersistInput,
  FeedbackExtractionTranscriptCommitInput,
} from "./extraction-commit.types.js";
import type { AppTransaction, MessageOutboxRow } from "@slopform/database";

import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { EventsService } from "../../events/events.service.js";
import { FeedbackConversationRepository } from "../post-event-feedback-conversation.repository.js";
import { FeedbackIngressRepository } from "../ingress/ingress.repository.js";
import { FeedbackOutboxRepository } from "../outbox/outbox.repository.js";
import { FeedbackOutboundIntentService } from "../outbox/outbound-intent.service.js";
import { ordinaryDispatchEvidenceFromConversation } from "../outbox/dispatch-context.js";
import {
  FeedbackLogger,
  FeedbackOperationLog,
} from "../feedback-operation-log.js";
import { FeedbackOutboundTranscriptService } from "../outbox/outbound-transcript.service.js";
import {
  adjustAfterIngressOrWorkSuppression,
  decideExtractionTurn,
  deriveTurnPolicyFacts,
  type ExtractionTurnDecision,
} from "./turn-decision.js";
import type {
  CommitSuppression,
  ExtractCommitResult,
  ExtractPersistWritten,
  ExtractPlannedTurn,
  ExtractRunSnapshot,
} from "./extract.types.js";
import {
  FeedbackConversationExecutionGuardError,
  executionSnapshotGuardReason,
} from "./execution-guard.js";
import { FeedbackConversationExecutionFence } from "./execution-fence.service.js";
import { FeedbackResultsRepository } from "./results.repository.js";
import { FEEDBACK_CLOSING_DEDUPE_PREFIX } from "./extraction.schemas.js";
import { FeedbackExtractionGenerationError } from "../../../integrations/llm/feedback-extraction-model.service.js";
import { FeedbackExtractionResultsWriter } from "./extraction-results-writer.service.js";
import { FeedbackExtractionStateApplier } from "./extraction-state.service.js";

/**
 * One persist transaction for results, supersession, outbox, audit, state and
 * terminal transcript identity. Capacity brake is a later, separate transaction
 * after this one has rolled back.
 */
@Injectable()
export class FeedbackExtractionCommitService {
  private readonly logger = new FeedbackLogger(
    FeedbackExtractionCommitService.name,
  );

  constructor(
    private readonly database: DatabaseService,
    private readonly ingress: FeedbackIngressRepository,
    private readonly events: EventsService,
    private readonly results: FeedbackResultsRepository,
    private readonly executionFence: FeedbackConversationExecutionFence,
    private readonly conversations: FeedbackConversationRepository,
    private readonly outbox: FeedbackOutboxRepository,
    private readonly outboundTranscript: FeedbackOutboundTranscriptService,
    private readonly outboundIntent: FeedbackOutboundIntentService,
    private readonly resultsWriter: FeedbackExtractionResultsWriter,
    private readonly state: FeedbackExtractionStateApplier,
  ) {}

  async commit(
    snapshot: ExtractRunSnapshot,
    planned: ExtractPlannedTurn,
  ): Promise<ExtractCommitResult> {
    const operation = new FeedbackOperationLog(this.logger, {
      operation: "extract_commit",
      correlationId: snapshot.correlationId,
      conversationId: snapshot.conversation._id,
      campaignId: snapshot.campaign.id,
      ...(snapshot.executionClaim
        ? {
            workRevision: snapshot.executionClaim.workRevision,
            executionEpoch: snapshot.executionClaim.epoch,
          }
        : {}),
    });
    try {
      operation.stage("begin_transaction");
      const result = await this.database.transaction(async (transaction) => {
        return this.commitOn(transaction, snapshot, planned, operation);
      });
      operation.complete("committed");
      return result;
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

  private async commitOn(
    transaction: AppTransaction,
    snapshot: ExtractRunSnapshot,
    planned: ExtractPlannedTurn,
    operation: FeedbackOperationLog,
  ): Promise<ExtractCommitResult> {
    const facts = deriveTurnPolicyFacts({
      conversation: snapshot.conversation,
      validated: planned.evidence.validated,
      recordedStatuses: planned.evidence.recordedStatuses,
      hostileTurn: planned.evidence.hostileTurn,
      stoppingForHostility: planned.evidence.stoppingForHostility,
    });
    let disposition = planned.proposed;

    // Admission already selected this snapshot. Persist paid facts and
    // judge current reply eligibility in this transaction.
    operation.stage("persist_results_and_intent");
    const written = await this.persistOn(transaction, {
      conversation: snapshot.conversation,
      campaign: snapshot.campaign,
      context: planned.evidence.context,
      validated: planned.evidence.validated,
      outbound: disposition.outboundIntent,
      ordinaryReply: facts.ordinaryReply,
      model: planned.evidence.model,
      correlationId: snapshot.correlationId,
      closingReason: disposition.closingReason,
      goalStatuses: disposition.goalStatuses,
      ...(snapshot.executionClaim
        ? { executionClaim: snapshot.executionClaim }
        : {}),
    });

    const suppression: CommitSuppression = {
      newerIngress: written.outboundSuppressedByNewerIngress,
      newerWork: written.executionSuperseded,
      legacyClosingProviderCrossed: written.outboundSuppressedByLegacyClosing,
    };

    if (suppression.newerIngress || suppression.newerWork) {
      const adjusted = adjustAfterIngressOrWorkSuppression(
        disposition,
        this.recomputeTurnAfterSuppression(snapshot, planned, written),
      );
      disposition = {
        ...adjusted,
        outboundIntent: undefined,
      };
    }

    if (suppression.legacyClosingProviderCrossed) {
      this.logger.warn({
        event: "feedback.extract.legacy_closing_provider_crossed",
        correlationId: snapshot.correlationId,
        conversationId: snapshot.conversation._id,
      });
      disposition = { ...disposition, closingReason: null };
    }

    operation.stage("verify_claim");
    await this.assertClaimStillCurrent(transaction, snapshot);

    operation.stage("apply_state_and_transcript");
    if (suppression.legacyClosingProviderCrossed) {
      await this.conversations.raiseAttention(transaction, {
        conversationId: snapshot.conversation._id,
        kind: "undelivered_message",
        messageId: null,
        at: new Date(),
      });
    }

    const result = await this.applyStateAndTranscriptIdentity(
      transaction,
      snapshot,
      {
        planned,
        written,
        closingReason: disposition.closingReason,
        goalStatuses: disposition.goalStatuses,
        withdrew: disposition.withdrew,
        hostility: disposition.hostility,
      },
    );
    operation.stage("commit_transaction");
    return result;
  }

  private recomputeTurnAfterSuppression(
    snapshot: ExtractRunSnapshot,
    planned: ExtractPlannedTurn,
    written: ExtractPersistWritten,
  ): ExtractionTurnDecision {
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
    return decideExtractionTurn({
      conversation: snapshot.conversation,
      validated: planned.evidence.validated,
      recordedStatuses: planned.evidence.recordedStatuses,
      askedGoal: undefined,
      hasOutboundIntent: false,
      hostileTurn: planned.evidence.hostileTurn,
      stoppingForHostility: planned.evidence.stoppingForHostility,
    });
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

  /**
   * Ordinary transcript, then conversation state, then terminal transcript
   * or cancel of that exact losing outbox.
   */
  private async applyStateAndTranscriptIdentity(
    transaction: AppTransaction,
    snapshot: ExtractRunSnapshot,
    input: FeedbackExtractionTranscriptCommitInput,
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

    const evidence = input.planned.evidence;
    const facts = deriveTurnPolicyFacts({
      conversation: snapshot.conversation,
      validated: evidence.validated,
      recordedStatuses: evidence.recordedStatuses,
      hostileTurn: evidence.hostileTurn,
      stoppingForHostility: evidence.stoppingForHostility,
    });
    const terminalReason = closingReason;
    const state = await this.state.apply(transaction, {
      conversation: snapshot.conversation,
      validated: evidence.validated,
      goalStatuses: input.goalStatuses,
      closingReason,
      terminalOutboxId:
        closingReason !== null ? (effectiveOutbox?.id ?? null) : null,
      withdrew: input.withdrew,
      hostility: input.hostility,
      awaitingHuman:
        input.written.outboundSuppressedByLegacyClosing ||
        facts.dutyOfCare ||
        input.withdrew ||
        input.hostility === "stopped",
      handoffOutboxId:
        closingReason === null &&
        (input.written.outboundSuppressedByLegacyClosing ||
          facts.dutyOfCare ||
          input.withdrew ||
          input.hostility === "stopped")
          ? (effectiveOutbox?.id ?? null)
          : null,
      hostileTurn: evidence.hostileTurn,
      priorHostileTurns: snapshot.conversation.hostileTurns,
      newestParticipantMessageId: evidence.newestParticipantMessageId,
      stalledOnMessageId: evidence.stalledOnMessageId,
      unansweredDataQuestionMessageIds:
        evidence.unansweredDataQuestionMessageIds,
      cursorSeq: snapshot.cursorSeq,
      model: evidence.model,
      usage: evidence.runUsage,
      serviceTier: evidence.serviceTier,
      workSuperseded:
        input.written.executionSuperseded || evidence.rewriteSuperseded,
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
   * Paid snapshot facts and outbound intent on the caller's transaction.
   * Does not open a nested transaction. Reply eligibility is judged here;
   * paid answers/notes still write when the reply is withheld.
   */
  private async persistOn(
    transaction: AppTransaction,
    input: FeedbackExtractionPersistInput,
  ): Promise<ExtractPersistWritten> {
    let outboundSuppressedByNewerIngress = false;
    // Ordinary/closing replies: lock the launch phone and see if newer
    // durable ingress arrived after the paid snapshot.
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
    // Venue facts used in the paid prompt must still be current.
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

    // Conversation mutex, then renew the execution fence before freshness.
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

    // Paid answers, notes, and safety/handoff audit — independent of reply.
    const writtenResults = await this.resultsWriter.write(transaction, {
      conversation: input.conversation,
      campaign: input.campaign,
      context: input.context,
      validated: input.validated,
      model: input.model,
      correlationId: input.correlationId,
    });

    let outbox: MessageOutboxRow | undefined;
    let outboundSuppressedByLegacyClosing = false;
    // A closing already past provider entry is not replaced.
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
    // Dispatch evidence stays the original snapshot; do not refresh.
    if (
      input.outbound &&
      !outboundSuppressedByNewerIngress &&
      !outboundSuppressedByLegacyClosing &&
      !executionSuperseded
    ) {
      const enqueued = await this.outboundIntent.enqueue(transaction, {
        dispatch:
          input.closingReason === null
            ? {
                schemaVersion: 1,
                purpose: "extraction_reply",
                evidence: ordinaryDispatchEvidenceFromConversation(
                  input.conversation,
                ),
              }
            : {
                schemaVersion: 1,
                purpose: "extraction_closing",
                closingReason: input.closingReason,
              },
        message: {
          conversationId: input.conversation._id,
          campaignId: input.campaign.id,
          body: input.outbound.body,
          dedupeKey: input.outbound.dedupeKey,
        },
        history: {
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
        },
      });
      outbox = enqueued.row;
    }

    return {
      answersWritten: writtenResults.answersWritten,
      notesWritten: writtenResults.notesWritten,
      outboundSuppressedByNewerIngress,
      outboundSuppressedByLegacyClosing,
      executionSuperseded,
      ...(outbox ? { outbox } : {}),
    };
  }
}
