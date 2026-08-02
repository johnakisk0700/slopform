import { randomUUID } from "node:crypto";

import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import type { Queue } from "bullmq";
import {
  FEEDBACK_EXTRACTION_ORIGIN_STAFF,
  type FeedbackAnswerRow,
  type FeedbackCampaignRow,
  type FeedbackExtractionMeta,
  type FeedbackNoteRow,
  type ParticipantRow,
} from "@join-the-six/database";

import { AuditRepository } from "../../../infrastructure/audit/audit.repository.js";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { FeedbackCampaignRepository } from "../campaign/campaign.repository.js";
import {
  appendAnswerCorrection,
  type FeedbackAnswerCorrection,
} from "../extraction/answer-corrections.js";
import { FeedbackResultsRepository } from "../extraction/results.repository.js";
import {
  contradictedPostEventFeedbackQuestionKeys,
  isScoredPostEventFeedbackQuestion,
} from "../question-set.js";
import { FeedbackOutboxRepository } from "../outbox/outbox.repository.js";
import { FeedbackOutboundLogService } from "../outbox/outbound-log.service.js";
import { FEEDBACK_QUEUE } from "../../../infrastructure/queue/queue.constants.js";
import {
  FeedbackConversationCapacityError,
  FeedbackConversationNotFoundError,
  FeedbackConversationRepository,
  FeedbackConversationTransitionError,
} from "../post-event-feedback-conversation.repository.js";
import type { FeedbackConversationDocument } from "../post-event-feedback-conversation.document.js";
import { EventsRepository } from "../../events/events.repository.js";
import { EventsService } from "../../events/events.service.js";
import { ParticipantsRepository } from "../../participants/participants.repository.js";
import { FeedbackOutboundTranscriptService } from "../outbox/outbound-transcript.service.js";
import {
  conversationCapabilities,
  deliveryFor,
  displayNameFor,
  toAnswerView,
  toListItem,
  toNoteView,
} from "./conversation.view.js";
import {
  inspectFeedbackExtractJobs,
  unreadParticipantSeqs,
} from "./inspect-extract-jobs.js";
import { FeedbackCampaignNotFoundError } from "../campaign/campaign.service.js";
import { PostEventFeedbackCampaignSummaryService } from "../summary/summary.service.js";
import type {
  AddFeedbackConversationAnswerInput,
  AddFeedbackConversationNoteInput,
  CloseFeedbackConversationInput,
  CorrectFeedbackConversationAnswerInput,
  FeedbackAnswerView,
  FeedbackAnswerWithdrawalView,
  FeedbackCampaignConversationsView,
  FeedbackCampaignResultsQuery,
  FeedbackConversationCorrelationId,
  FeedbackConversationDetailView,
  FeedbackConversationExtractionView,
  FeedbackConversationPrincipal,
  FeedbackConversationResultsView,
  FeedbackNoteView,
} from "./conversation.schemas.js";
import {
  createFeedbackExtractJobId,
  createFeedbackExtractParkedJobId,
  FEEDBACK_EXTRACT_QUIET_WINDOW_MS,
  FEEDBACK_JOB_NAMES,
  FEEDBACK_JOB_SCHEMA_VERSION,
  feedbackExtractJobDataSchema,
  type FeedbackJobData,
  type FeedbackJobName,
} from "../jobs.schemas.js";

export class FeedbackConversationActionNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = FeedbackConversationActionNotAllowedError.name;
  }
}

export class FeedbackNoteNotFoundError extends Error {
  constructor(id: string) {
    super(`Feedback note ${id} was not found`);
    this.name = FeedbackNoteNotFoundError.name;
  }
}

export class FeedbackAnswerNotFoundError extends Error {
  constructor(id: string) {
    super(`Feedback answer ${id} was not found`);
    this.name = FeedbackAnswerNotFoundError.name;
  }
}

export class FeedbackAttentionReasonNotFoundError extends Error {
  constructor(id: string) {
    super(`Feedback attention reason ${id} was not found`);
    this.name = FeedbackAttentionReasonNotFoundError.name;
  }
}

/**
 * Staff-facing conversation inbox read model and actions (WP7b). Capability
 * flags are computed server-side so the admin UI does not hardcode transition
 * rules; staff sends only create `message_outbox` rows (kind `staff`) for the
 * WP6 relay.
 */
@Injectable()
export class PostEventFeedbackConversationService {
  constructor(
    @InjectQueue(FEEDBACK_QUEUE)
    private readonly queue: Queue<FeedbackJobData, void, FeedbackJobName>,
    private readonly database: DatabaseService,
    private readonly campaigns: FeedbackCampaignRepository,
    private readonly results: FeedbackResultsRepository,
    private readonly outbox: FeedbackOutboxRepository,
    private readonly conversations: FeedbackConversationRepository,
    private readonly events: EventsRepository,
    private readonly eventsService: EventsService,
    private readonly participants: ParticipantsRepository,
    private readonly audit: AuditRepository,
    private readonly outboundTranscript: FeedbackOutboundTranscriptService,
    private readonly outboundLog: FeedbackOutboundLogService,
    private readonly summaries: PostEventFeedbackCampaignSummaryService,
  ) {}

  async listForCampaign(
    campaignId: string,
  ): Promise<FeedbackCampaignConversationsView> {
    const campaign = await this.requireCampaign(campaignId);
    const [summaries, event] = await Promise.all([
      this.conversations.listForCampaign(campaign.id),
      this.events.findById(campaign.eventId),
    ]);
    const displayNames = await this.resolveDisplayNames(
      summaries.map((summary) => summary.respondentParticipantId),
    );

    return {
      campaign: {
        id: campaign.id,
        eventId: campaign.eventId,
        eventTitle: event?.title ?? null,
        status:
          campaign.status as FeedbackCampaignConversationsView["campaign"]["status"],
        questionSetVersion: campaign.questionSetVersion,
        launchedAt: campaign.launchedAt.toISOString(),
        conversationCount: summaries.length,
        openCount: summaries.filter(
          (summary) => summary.lifecycle.state === "open",
        ).length,
        needsAttentionCount: summaries.filter(
          (summary) => summary.needsAttention,
        ).length,
        // The provider incident, reported once for the campaign it is happening
        // to. It sits beside `needsAttentionCount` and not inside it on purpose:
        // that number means «this many conversations want a person», and a
        // parked conversation wants a working provider. Rolling them together is
        // how one outage became thirty-six things to read.
        extractionParkedCount: summaries.filter(
          (summary) => summary.extractionParked,
        ).length,
      },
      conversations: summaries.map((summary) =>
        toListItem(summary, displayNames),
      ),
    };
  }

  async get(
    campaignId: string,
    conversationId: string,
  ): Promise<FeedbackConversationDetailView> {
    const conversation = await this.requireConversationInCampaign(
      campaignId,
      conversationId,
    );
    return this.toDetailView(conversation);
  }

  async listConversationResults(
    campaignId: string,
    conversationId: string,
  ): Promise<FeedbackConversationResultsView> {
    await this.requireConversationInCampaign(campaignId, conversationId);
    const [answers, notes] = await Promise.all([
      this.results.listAnswersByConversation(conversationId),
      this.results.listNotesByConversation(conversationId),
    ]);
    return this.toResultsView(answers, notes);
  }

  async listCampaignResults(
    campaignId: string,
    query: FeedbackCampaignResultsQuery,
  ): Promise<FeedbackConversationResultsView> {
    await this.requireCampaign(campaignId);
    const [answers, notes] = await Promise.all([
      this.results.listAnswersByCampaign(campaignId, {
        ...(query.questionKey ? { questionKey: query.questionKey } : {}),
        ...(query.participantId ? { participantId: query.participantId } : {}),
      }),
      this.results.listNotesByCampaign(campaignId, {
        ...(query.participantId ? { participantId: query.participantId } : {}),
        ...(query.reviewStatus ? { reviewStatus: query.reviewStatus } : {}),
      }),
    ]);
    return this.toResultsView(answers, notes);
  }

  async takeOver(
    campaignId: string,
    conversationId: string,
    actorId: FeedbackConversationPrincipal,
    requestId: FeedbackConversationCorrelationId,
  ): Promise<FeedbackConversationDetailView> {
    const conversation = await this.requireConversationInCampaign(
      campaignId,
      conversationId,
    );
    const capabilities = conversationCapabilities(conversation);
    if (!capabilities.canTakeOver) {
      throw new FeedbackConversationActionNotAllowedError(
        "Take over is only available while the conversation is open under bot control",
      );
    }

    const at = new Date();
    const transition = await this.conversations.takeOver({
      conversationId: conversation._id,
      source: "staff_action",
      at,
    });

    if (transition.changed) {
      await this.database.transaction(async (transaction) => {
        await this.audit.append(transaction, {
          actorType: "admin",
          actorId,
          action: "feedback_conversation.taken_over",
          entityType: "feedback_conversation",
          entityId: conversation._id,
          requestId,
          context: { campaignId, controlSource: "staff_action" },
        });
      });
    }

    return this.toDetailView(transition.conversation);
  }

  async resumeBot(
    campaignId: string,
    conversationId: string,
    actorId: FeedbackConversationPrincipal,
    requestId: FeedbackConversationCorrelationId,
  ): Promise<FeedbackConversationDetailView> {
    const conversation = await this.requireConversationInCampaign(
      campaignId,
      conversationId,
    );
    const capabilities = conversationCapabilities(conversation);
    if (!capabilities.canResumeBot) {
      throw new FeedbackConversationActionNotAllowedError(
        "Resume bot is only available while the conversation is open under human control",
      );
    }

    const at = new Date();
    let transition;
    try {
      transition = await this.conversations.resumeBot({
        conversationId: conversation._id,
        at,
      });
    } catch (error) {
      if (error instanceof FeedbackConversationTransitionError) {
        throw new FeedbackConversationActionNotAllowedError(error.message);
      }
      throw error;
    }

    if (transition.changed) {
      await this.database.transaction(async (transaction) => {
        await this.audit.append(transaction, {
          actorType: "admin",
          actorId,
          action: "feedback_conversation.bot_resumed",
          entityType: "feedback_conversation",
          entityId: conversation._id,
          requestId,
          context: { campaignId },
        });
      });

      // Anything the participant said while a person held the conversation is
      // sitting behind the extraction cursor: those runs correctly stood down
      // on `skipped_human_control` and nothing re-queues them. Handing back
      // without this, the answer waits for a brand-new message that may never
      // come — «τελικά βάλε 4, όχι 3» simply never lands.
      await this.enqueueExtractionForUnreadTestimony(
        transition.conversation,
        requestId,
      );
    }

    return this.toDetailView(transition.conversation);
  }

  private async enqueueExtractionForUnreadTestimony(
    conversation: FeedbackConversationDocument,
    correlationId: string,
  ): Promise<void> {
    const latestSeq = conversation.messages
      .filter((message) => message.actor === "participant")
      .reduce((highest, message) => Math.max(highest, message.seq), 0);
    if (latestSeq <= conversation.extraction.cursorSeq) {
      return;
    }

    const data = feedbackExtractJobDataSchema.parse({
      schemaVersion: FEEDBACK_JOB_SCHEMA_VERSION,
      conversationId: conversation._id,
      correlationId,
    });
    // The same deterministic id and quiet window the materializer uses, so a
    // resume that races an inbound message collapses onto one run.
    await this.queue.add(FEEDBACK_JOB_NAMES.extractV1, data, {
      jobId: createFeedbackExtractJobId(conversation._id, latestSeq),
      delay: FEEDBACK_EXTRACT_QUIET_WINDOW_MS,
      attempts: 5,
      backoff: { type: "exponential", delay: 1_000 },
      removeOnComplete: 1_000,
      removeOnFail: 5_000,
      stackTraceLimit: 10,
    });
  }

  /**
   * Staff close with lifecycle reason `cancelled` (D17). The operator's why —
   * abusive, handled offline, and the rest — is recorded beside that, not
   * instead of it: every human close answers the state-machine question the
   * same way, and splitting the lifecycle enum would drag STOP-override and
   * the badge vocabulary into an intent taxonomy.
   *
   * Idempotent: a second close on an already-closed conversation returns the
   * current read model without error. A STOP-closed conversation exposes no
   * close capability and is rejected.
   */
  async close(
    campaignId: string,
    conversationId: string,
    input: CloseFeedbackConversationInput,
    actorId: FeedbackConversationPrincipal,
    requestId: FeedbackConversationCorrelationId,
  ): Promise<FeedbackConversationDetailView> {
    const conversation = await this.requireConversationInCampaign(
      campaignId,
      conversationId,
    );
    const capabilities = conversationCapabilities(conversation);
    if (
      conversation.lifecycle.state === "closed" &&
      conversation.lifecycle.reason === "stopped"
    ) {
      throw new FeedbackConversationActionNotAllowedError(
        "A STOP-closed conversation cannot be closed by staff",
      );
    }
    if (
      conversation.lifecycle.state === "closed" &&
      conversation.lifecycle.reason !== "stopped"
    ) {
      // Idempotent staff close: already cancelled / completed / declined / expired.
      return this.toDetailView(conversation);
    }
    if (!capabilities.canClose) {
      throw new FeedbackConversationActionNotAllowedError(
        "Close is only available while the conversation is open",
      );
    }

    const at = new Date();
    const staffClose = {
      reason: input.reason,
      note: input.note ?? null,
    };
    const transition = await this.conversations.close({
      conversationId: conversation._id,
      reason: "cancelled",
      at,
      staffClose,
    });

    if (transition.changed) {
      await this.database.transaction(async (transaction) => {
        await this.outbox.cancelQueuedOutboxForConversation(
          transaction,
          conversation._id,
        );
        await this.audit.append(transaction, {
          actorType: "admin",
          actorId,
          action: "feedback_conversation.closed",
          entityType: "feedback_conversation",
          entityId: conversation._id,
          requestId,
          context: {
            campaignId,
            reason: "cancelled",
            staffReason: staffClose.reason,
            ...(staffClose.note ? { staffNote: staffClose.note } : {}),
          },
        });
      });

      await this.summaries.notifyIfLastConversationClosed(
        campaignId,
        requestId,
        true,
      );
    }

    return this.toDetailView(transition.conversation);
  }

  /**
   * Dismisses one reason the operator has dealt with.
   *
   * Per reason and with nothing to fill in: by the time somebody clicks this
   * they have read the message it points at, and a confirmation dialog asking
   * them to say so again is how a badge stops being cleared at all. The
   * repository lowers `needsAttention` only when this was the last unresolved
   * entry, so clearing a revised score cannot take a safety disclosure down
   * with it.
   *
   * Idempotent on an already-resolved entry: a double click or a retried
   * request returns the current read model rather than a second audit row.
   * An id this conversation never carried is a 404, not a silent success —
   * that is a client pointing at the wrong thing.
   */
  async resolveAttentionReason(
    campaignId: string,
    conversationId: string,
    reasonId: string,
    actorId: FeedbackConversationPrincipal,
    requestId: FeedbackConversationCorrelationId,
  ): Promise<FeedbackConversationDetailView> {
    const conversation = await this.requireConversationInCampaign(
      campaignId,
      conversationId,
    );
    const reason = conversation.attentionReasons.find(
      (candidate) => candidate.id === reasonId,
    );
    if (!reason) {
      throw new FeedbackAttentionReasonNotFoundError(reasonId);
    }
    if (reason.resolvedAt !== null) {
      return this.toDetailView(conversation);
    }

    const at = new Date();
    const transition = await this.conversations.resolveAttentionReason({
      conversationId: conversation._id,
      reasonId,
      resolvedBy: actorId,
      at,
    });

    if (transition.changed) {
      await this.database.transaction(async (transaction) => {
        await this.audit.append(transaction, {
          actorType: "admin",
          actorId,
          action: "feedback_conversation.attention_resolved",
          entityType: "feedback_conversation",
          entityId: conversation._id,
          requestId,
          context: {
            campaignId,
            reasonId,
            kind: reason.kind,
            // Whether this was the last one standing, which is the difference
            // between clearing an item and clearing the conversation.
            stillNeedsAttention: transition.conversation.needsAttention,
          },
        });
      });
    }

    return this.toDetailView(transition.conversation);
  }

  /**
   * Staff send under human control only. Creates a `kind=staff` outbox row for
   * the WP6 relay and appends the actor-labelled transcript entry correlated by
   * `outboxId` so the detail read model can surface delivery state.
   */
  async sendStaffMessage(
    campaignId: string,
    conversationId: string,
    text: string,
    actorId: FeedbackConversationPrincipal,
    requestId: FeedbackConversationCorrelationId,
  ): Promise<FeedbackConversationDetailView> {
    const conversation = await this.requireConversationInCampaign(
      campaignId,
      conversationId,
    );
    const capabilities = conversationCapabilities(conversation);
    if (!capabilities.canSendStaffMessage) {
      throw new FeedbackConversationActionNotAllowedError(
        "Staff send is only available while the conversation is open under human control",
      );
    }

    const at = new Date();
    const dedupeKey = `feedback-staff-${conversation._id}-${randomUUID()}`;

    const outbox = await this.database.transaction(async (transaction) => {
      const inserted = await this.outbox.insertOutboxIfAbsent(transaction, {
        conversationId: conversation._id,
        campaignId: conversation.campaignId,
        kind: "staff",
        body: text,
        dedupeKey,
        createdByStaff: actorId,
      });
      await this.outboundLog.record(transaction, {
        outbox: inserted,
        conversation,
        decision: {
          origin: "staff_message",
          staffActorId: actorId,
        },
        correlationId: requestId,
      });
      await this.audit.append(transaction, {
        actorType: "admin",
        actorId,
        action: "feedback_conversation.staff_message_enqueued",
        entityType: "feedback_conversation",
        entityId: conversation._id,
        requestId,
        context: {
          campaignId,
          outboxId: inserted.row.id,
          dedupeKey,
        },
      });
      return inserted.row;
    });

    // The shared outbound path: actor `staff` (the row's kind), idempotent by
    // `outboxId`, and it cancels the row when the transcript cannot hold the
    // message. Staff sends are synchronous, so the refusal is surfaced to the
    // operator instead of being left for a background retry.
    const recorded = await this.outboundTranscript.record(outbox, at);
    if (recorded.outcome === "cancelled") {
      throw new FeedbackConversationCapacityError();
    }

    return this.toDetailView(recorded.conversation);
  }

  /**
   * A note an operator writes by hand, stored as an ordinary `feedback_notes`
   * row so it reaches the same conversation pane, Results tab and review queue
   * as everything else.
   *
   * It fabricates nothing on the way in. `extraction_meta` records
   * `origin: staff` and the acting user; there is no model and no confidence,
   * because none ran. `source_message_ids` is empty because the note quotes no
   * message — an operator typed it — and the table's check constraint permits
   * that for exactly this origin. The subject, when one is given, must be a
   * current D16 candidate of the campaign's event, resolved through the same
   * `EventsService` helper extraction uses; anyone else is refused rather than
   * quietly stored as an undirected note.
   */
  async addStaffNote(
    campaignId: string,
    conversationId: string,
    input: AddFeedbackConversationNoteInput,
    actorId: FeedbackConversationPrincipal,
    requestId: FeedbackConversationCorrelationId,
  ): Promise<FeedbackNoteView> {
    const conversation = await this.requireConversationInCampaign(
      campaignId,
      conversationId,
    );
    const campaign = await this.requireCampaign(campaignId);

    const candidates =
      await this.eventsService.listFeedbackCandidatesForRespondent(
        campaign.eventId,
        conversation.respondentParticipantId,
      );
    const candidateIds = candidates.items.map(
      (candidate) => candidate.participantId,
    );

    const subjectParticipantId = input.subjectParticipantId ?? null;
    if (
      subjectParticipantId !== null &&
      !candidateIds.includes(subjectParticipantId)
    ) {
      throw new FeedbackConversationActionNotAllowedError(
        "A note can only be directed at a current feedback candidate of this event",
      );
    }

    const extractionMeta: FeedbackExtractionMeta = {
      origin: FEEDBACK_EXTRACTION_ORIGIN_STAFF,
      staffUserId: actorId,
      candidateIds,
    };

    const note = await this.database.transaction(async (transaction) => {
      const row = await this.results.insertNote(transaction, {
        campaignId: campaign.id,
        conversationId: conversation._id,
        respondentParticipantId: conversation.respondentParticipantId,
        subjectParticipantId,
        noteType: input.noteType,
        text: input.text,
        sourceMessageIds: [],
        extractionMeta,
        status: "new",
      });

      await this.audit.append(transaction, {
        actorType: "admin",
        actorId,
        action: "feedback_note.staff_created",
        entityType: "feedback_note",
        entityId: row.id,
        requestId,
        context: {
          campaignId,
          conversationId: conversation._id,
          noteType: input.noteType,
          subjectResolved: subjectParticipantId !== null,
        },
      });

      return row;
    });

    const displayNames = await this.resolveDisplayNames([
      note.respondentParticipantId,
      ...(note.subjectParticipantId ? [note.subjectParticipantId] : []),
    ]);
    return toNoteView(note, displayNames);
  }

  async updateNoteReviewStatus(
    noteId: string,
    status: FeedbackNoteView["status"],
    actorId: FeedbackConversationPrincipal,
    requestId: FeedbackConversationCorrelationId,
  ): Promise<FeedbackNoteView> {
    const existing = await this.results.findNoteById(noteId);
    if (!existing) {
      throw new FeedbackNoteNotFoundError(noteId);
    }

    const updated = await this.database.transaction(async (transaction) => {
      const row =
        existing.status === status
          ? existing
          : await this.results.updateNoteStatus(transaction, noteId, status);
      if (!row) {
        throw new FeedbackNoteNotFoundError(noteId);
      }
      if (existing.status !== status) {
        await this.audit.append(transaction, {
          actorType: "admin",
          actorId,
          action: "feedback_note.review_status_updated",
          entityType: "feedback_note",
          entityId: row.id,
          requestId,
          context: {
            campaignId: row.campaignId,
            conversationId: row.conversationId,
            from: existing.status,
            to: status,
          },
        });
      }
      return row;
    });

    const displayNames = await this.resolveDisplayNames([
      updated.respondentParticipantId,
      ...(updated.subjectParticipantId ? [updated.subjectParticipantId] : []),
    ]);
    return toNoteView(updated, displayNames);
  }

  /**
   * An operator fixing a score the model read wrong.
   *
   * The row is edited in place and the correction is appended to
   * `extraction_meta.corrections`, so what the model proposed — its name, its
   * confidence, the candidate set of that run — stays on the row beside the
   * value a human decided. `audit_events` carries the same before and after and
   * is the durable copy.
   *
   * Deliberately **not** capability-gated, on the staff-note precedent: saying
   * what is true is not steering the conversation. A closed thread is in fact
   * the case this exists for — once it closes the model will never revisit it,
   * so a wrong number stays wrong for good unless a person can change it.
   *
   * Only a question whose value *is* a number may be corrected. On `liked`,
   * `meet_again` and `avoid` the subject is the answer and `value_int` is null;
   * writing a 3 there would assert something the question cannot express. The
   * wrong-person case is a withdrawal, not a value.
   *
   * Idempotent on the value already stored: a retried or double-clicked request
   * returns the row rather than appending a second identical correction. The
   * consequence, stated rather than hidden: re-affirming the model's own value
   * is not a way to freeze it.
   */
  async correctAnswerValue(
    campaignId: string,
    conversationId: string,
    answerId: string,
    input: CorrectFeedbackConversationAnswerInput,
    actorId: FeedbackConversationPrincipal,
    requestId: FeedbackConversationCorrelationId,
  ): Promise<FeedbackAnswerView> {
    const existing = await this.requireAnswerInConversation(
      campaignId,
      conversationId,
      answerId,
    );
    if (!isScoredPostEventFeedbackQuestion(existing.questionKey)) {
      throw new FeedbackConversationActionNotAllowedError(
        "Only a scored question's value can be corrected; withdraw an answer recorded about the wrong person instead",
      );
    }
    if (existing.valueInt === input.valueInt) {
      return this.toAnswerViewWithNames(existing);
    }

    const correction: FeedbackAnswerCorrection = {
      at: new Date().toISOString(),
      by: actorId,
      from: { valueInt: existing.valueInt },
      to: { valueInt: input.valueInt },
      ...(input.note ? { note: input.note } : {}),
    };

    const updated = await this.database.transaction(async (transaction) => {
      // The same advisory lock an extraction run persists under, so a
      // correction cannot interleave with a run writing the same row.
      await this.results.lockConversation(transaction, conversationId);
      // Re-read behind the lock: the provenance blob is what gets rewritten
      // here, and a run that landed between the guard above and this write would
      // otherwise have its model, confidence and candidate set replaced by the
      // older copy this request read.
      const locked =
        (await this.results.findAnswerById(answerId, transaction)) ?? existing;
      const row = await this.results.updateAnswerValue(transaction, {
        id: answerId,
        valueInt: input.valueInt,
        extractionMeta: appendAnswerCorrection(
          locked.extractionMeta,
          correction,
        ),
      });
      if (!row) {
        throw new FeedbackAnswerNotFoundError(answerId);
      }

      await this.audit.append(transaction, {
        actorType: "admin",
        actorId,
        action: "feedback_answer.corrected",
        entityType: "feedback_answer",
        entityId: row.id,
        requestId,
        context: {
          campaignId,
          conversationId,
          questionKey: row.questionKey,
          subjectParticipantId: row.subjectParticipantId,
          from: correction.from,
          to: correction.to,
          ...(correction.note ? { note: correction.note } : {}),
        },
      });

      return row;
    });

    return this.toAnswerViewWithNames(updated);
  }

  /**
   * Withdraws an answer recorded about the wrong person.
   *
   * A separate operation from a correction because it is a separate assertion. A
   * wrong score keeps the claim and changes its magnitude; an `avoid` row
   * against somebody the respondent never mentioned is a claim about a third
   * party that has no correct value, and the row should stop existing.
   *
   * The whole row goes into the audit context before it goes. The deletion is
   * then invisible in the product, and for a false assertion about somebody who
   * was never named, that is the point.
   *
   * A tombstone is written in the same transaction, and it is what makes the
   * withdrawal a decision rather than a gap. Extraction is a loop: the
   * participant's own words are still in the transcript, so a later run reading
   * new testimony about the same question and the same person recorded the
   * answer again, and the operator who had already ruled on it was never told.
   * A correction is frozen against exactly that (`extraction_meta.corrections`)
   * and a withdrawal was not, so the promise «a human decided this» held for one
   * of the two operations. The tombstone cannot live on the row — the row is
   * gone, deliberately — so it lives on the slot the row occupied.
   *
   * Re-aiming the answer at the right person is deliberately not offered here:
   * the subject moves across the `NULLS NOT DISTINCT` uniqueness key and can
   * collide with an existing answer, and the new subject would have to be
   * revalidated against the live D16 candidate set. An operator who knows the
   * right person cannot record it yet — `cardinality(source_message_ids) >= 1`
   * forbids an operator-authored answer without a migration.
   */
  async withdrawAnswer(
    campaignId: string,
    conversationId: string,
    answerId: string,
    actorId: FeedbackConversationPrincipal,
    requestId: FeedbackConversationCorrelationId,
  ): Promise<FeedbackAnswerWithdrawalView> {
    const existing = await this.requireAnswerInConversation(
      campaignId,
      conversationId,
      answerId,
    );

    await this.database.transaction(async (transaction) => {
      await this.results.lockConversation(transaction, conversationId);
      const removed = await this.results.deleteAnswer(transaction, answerId);
      if (!removed) {
        throw new FeedbackAnswerNotFoundError(answerId);
      }

      await this.results.recordAnswerWithdrawal(transaction, {
        campaignId: removed.campaignId,
        conversationId: removed.conversationId,
        questionKey: removed.questionKey,
        subjectParticipantId: removed.subjectParticipantId,
        answerId: removed.id,
        withdrawnBy: actorId,
      });

      await this.audit.append(transaction, {
        actorType: "admin",
        actorId,
        action: "feedback_answer.withdrawn",
        entityType: "feedback_answer",
        entityId: removed.id,
        requestId,
        context: {
          campaignId,
          conversationId,
          // The whole withdrawn row, because nothing else will hold it: the
          // provenance, the value and the person it was about are all only
          // recoverable from here once the row is gone.
          answer: {
            id: removed.id,
            campaignId: removed.campaignId,
            conversationId: removed.conversationId,
            respondentParticipantId: removed.respondentParticipantId,
            subjectParticipantId: removed.subjectParticipantId,
            questionKey: removed.questionKey,
            valueInt: removed.valueInt,
            sourceMessageIds: removed.sourceMessageIds,
            extractionMeta: removed.extractionMeta,
            matchingHold: removed.matchingHold,
            createdAt: removed.createdAt.toISOString(),
            updatedAt: removed.updatedAt.toISOString(),
          },
        },
      });
    });

    return { id: existing.id };
  }

  /**
   * An answer an operator records by hand about one person.
   *
   * The counterpart of the withdrawal above, and the half that was missing: a
   * conversation could be emptied of a wrong `avoid` but never told who the
   * right person was, so an operator who learned on the phone that Νίκος is the
   * one the respondent wants to steer clear of had nowhere to put it and the
   * seating never heard. Only a directed question — on `event_score` the number
   * is the respondent's and an operator inventing one would be speaking for
   * them.
   *
   * Three things it does beyond inserting, all under the conversation's advisory
   * lock so an extraction run cannot interleave with any of them:
   *
   * - **It moves rather than duplicates.** Recording `avoid` about somebody
   *   currently under `liked` withdraws the `liked` row, the same rule an
   *   extraction run obeys when a participant changes their mind, and the same
   *   tombstone so the model does not put it back. The admin states this before
   *   the operator confirms.
   * - **It lifts the tombstone on the slot it is filling.** Otherwise the person
   *   an operator had just removed by mistake could never be added back, and
   *   nothing on screen would say why.
   * - **It records provenance honestly.** `origin: staff`, the acting user, and
   *   an empty `source_message_ids`, because no message says this — the table
   *   permits that for staff rows alone. Borrowing a message id would put the
   *   operator's assertion in the participant's mouth.
   *
   * The conversation's own goal statuses are deliberately untouched. Those say
   * what the bot asked and got, and a fact an operator learned elsewhere is not
   * the questionnaire making progress; marking the goal answered here would also
   * silence the bot's next question on the strength of a phone call.
   *
   * Idempotent on the slot: a retried or double-clicked request returns the row
   * that is already there rather than failing or writing a second one.
   */
  async addStaffAnswer(
    campaignId: string,
    conversationId: string,
    input: AddFeedbackConversationAnswerInput,
    actorId: FeedbackConversationPrincipal,
    requestId: FeedbackConversationCorrelationId,
  ): Promise<FeedbackAnswerView> {
    const conversation = await this.requireConversationInCampaign(
      campaignId,
      conversationId,
    );
    const campaign = await this.requireCampaign(campaignId);
    if (!conversation.goals.some((goal) => goal.key === input.questionKey)) {
      throw new FeedbackConversationActionNotAllowedError(
        "An answer can only be recorded for this conversation's question set",
      );
    }

    const candidates =
      await this.eventsService.listFeedbackCandidatesForRespondent(
        campaign.eventId,
        conversation.respondentParticipantId,
      );
    const candidateIds = candidates.items.map(
      (candidate) => candidate.participantId,
    );
    if (!candidateIds.includes(input.subjectParticipantId)) {
      throw new FeedbackConversationActionNotAllowedError(
        "An answer can only be recorded about a current feedback candidate of this event",
      );
    }

    const extractionMeta: FeedbackExtractionMeta = {
      origin: FEEDBACK_EXTRACTION_ORIGIN_STAFF,
      staffUserId: actorId,
      candidateIds,
    };

    const recorded = await this.database.transaction(async (transaction) => {
      await this.results.lockConversation(transaction, conversationId);
      const answers = await this.results.listAnswersByConversation(
        conversationId,
        transaction,
      );

      const alreadyRecorded = answers.find(
        (answer) =>
          answer.questionKey === input.questionKey &&
          answer.subjectParticipantId === input.subjectParticipantId,
      );
      if (alreadyRecorded) {
        return alreadyRecorded;
      }

      // `question_key` is plain text on the row (the check constraint is the
      // enum), so the comparison is against the rule's keys as strings.
      const contradicted = contradictedPostEventFeedbackQuestionKeys(
        input.questionKey,
        conversation.goals.map((goal) => goal.key),
      ) as readonly string[];
      const superseded = answers.filter(
        (answer) =>
          answer.subjectParticipantId === input.subjectParticipantId &&
          contradicted.includes(answer.questionKey),
      );
      for (const answer of superseded) {
        const removed = await this.results.deleteAnswer(transaction, answer.id);
        if (!removed) {
          continue;
        }
        // The same tombstone an ordinary withdrawal writes: this slot is empty
        // because a human said so, and a later run must not refill it.
        await this.results.recordAnswerWithdrawal(transaction, {
          campaignId: removed.campaignId,
          conversationId: removed.conversationId,
          questionKey: removed.questionKey,
          subjectParticipantId: removed.subjectParticipantId,
          answerId: removed.id,
          withdrawnBy: actorId,
        });
        await this.audit.append(transaction, {
          actorType: "admin",
          actorId,
          action: "feedback_answer.withdrawn",
          entityType: "feedback_answer",
          entityId: removed.id,
          requestId,
          context: {
            campaignId,
            conversationId,
            // Why this one went: it was not retracted on its own, it lost to
            // the answer recorded in the same breath.
            supersededBy: input.questionKey,
            answer: {
              id: removed.id,
              campaignId: removed.campaignId,
              conversationId: removed.conversationId,
              respondentParticipantId: removed.respondentParticipantId,
              subjectParticipantId: removed.subjectParticipantId,
              questionKey: removed.questionKey,
              valueInt: removed.valueInt,
              sourceMessageIds: removed.sourceMessageIds,
              extractionMeta: removed.extractionMeta,
              matchingHold: removed.matchingHold,
              createdAt: removed.createdAt.toISOString(),
              updatedAt: removed.updatedAt.toISOString(),
            },
          },
        });
      }

      const reinstated = await this.results.deleteAnswerWithdrawal(
        transaction,
        {
          conversationId,
          questionKey: input.questionKey,
          subjectParticipantId: input.subjectParticipantId,
        },
      );

      const row = await this.results.insertStaffAnswer(transaction, {
        campaignId: campaign.id,
        conversationId: conversation._id,
        respondentParticipantId: conversation.respondentParticipantId,
        subjectParticipantId: input.subjectParticipantId,
        questionKey: input.questionKey,
        extractionMeta,
      });
      if (!row) {
        throw new FeedbackConversationActionNotAllowedError(
          "The answer could not be recorded",
        );
      }

      await this.audit.append(transaction, {
        actorType: "admin",
        actorId,
        action: "feedback_answer.staff_recorded",
        entityType: "feedback_answer",
        entityId: row.id,
        requestId,
        context: {
          campaignId,
          conversationId,
          questionKey: row.questionKey,
          subjectParticipantId: row.subjectParticipantId,
          supersededAnswerIds: superseded.map((answer) => answer.id),
          // Whether this filled a slot a human had emptied, which is the one
          // case where a tombstone is deleted rather than written.
          reinstatedWithdrawnSlot: reinstated !== undefined,
        },
      });

      return row;
    });

    return this.toAnswerViewWithNames(recorded);
  }

  private async requireAnswerInConversation(
    campaignId: string,
    conversationId: string,
    answerId: string,
  ): Promise<FeedbackAnswerRow> {
    await this.requireConversationInCampaign(campaignId, conversationId);
    const answer = await this.results.findAnswerById(answerId);
    // An answer belonging to another conversation is not this conversation's to
    // edit, and saying "not found" rather than "not yours" is the same answer
    // the note and attention-reason paths give.
    if (!answer || answer.conversationId !== conversationId) {
      throw new FeedbackAnswerNotFoundError(answerId);
    }
    return answer;
  }

  private async toAnswerViewWithNames(
    answer: FeedbackAnswerRow,
  ): Promise<FeedbackAnswerView> {
    const displayNames = await this.resolveDisplayNames([
      answer.respondentParticipantId,
      ...(answer.subjectParticipantId ? [answer.subjectParticipantId] : []),
    ]);
    return toAnswerView(answer, displayNames);
  }

  private async toDetailView(
    conversation: FeedbackConversationDocument,
  ): Promise<FeedbackConversationDetailView> {
    const [displayNames, outboxRows, extraction] = await Promise.all([
      this.resolveDisplayNames([conversation.respondentParticipantId]),
      this.outbox.listOutboxByConversation(conversation._id),
      this.toExtractionView(conversation),
    ]);
    const outboxById = new Map(outboxRows.map((row) => [row.id, row]));

    return {
      id: conversation._id,
      campaignId: conversation.campaignId,
      respondentParticipantId: conversation.respondentParticipantId,
      respondentDisplayName: displayNameFor(
        displayNames.get(conversation.respondentParticipantId),
      ),
      phoneAtLaunch: conversation.phoneAtLaunch,
      lifecycle: {
        state: conversation.lifecycle.state,
        reason: conversation.lifecycle.reason,
        closedAt: conversation.lifecycle.closedAt?.toISOString() ?? null,
      },
      control: {
        mode: conversation.control.mode,
        source: conversation.control.source,
        changedAt: conversation.control.changedAt.toISOString(),
      },
      goals: conversation.goals.map((goal) => ({
        key: goal.key,
        ordinal: goal.ordinal,
        prompt: goal.prompt,
        status: goal.status,
      })),
      messages: conversation.messages.map((message) => ({
        id: message.id,
        seq: message.seq,
        actor: message.actor,
        text: message.text,
        providerMessageId: message.providerMessageId,
        ingressId: message.ingressId,
        outboxId: message.outboxId,
        attention: message.attention,
        at: message.at.toISOString(),
        delivery: deliveryFor(message.outboxId, outboxById),
      })),
      extraction,
      needsAttention: conversation.needsAttention,
      attentionReasons: conversation.attentionReasons.map((reason) => ({
        id: reason.id,
        kind: reason.kind,
        messageId: reason.messageId,
        at: reason.at.toISOString(),
        resolvedAt: reason.resolvedAt?.toISOString() ?? null,
        resolvedBy: reason.resolvedBy,
      })),
      remindedAt: conversation.remindedAt?.toISOString() ?? null,
      createdAt: conversation.createdAt.toISOString(),
      updatedAt: conversation.updatedAt.toISOString(),
      staffClose: conversation.staffClose
        ? {
            reason: conversation.staffClose.reason,
            note: conversation.staffClose.note,
          }
        : null,
      capabilities: conversationCapabilities(conversation),
    };
  }

  /**
   * Document fields plus a single Redis lookup for extract jobs covering the
   * unread window. Detail-only: the polled list must not do this per row.
   *
   * Failure is reported from a retained failed job, or — when the job has
   * already aged out of Redis — from a durable note with
   * `origin: deterministic_fallback`. The fallback does not advance the
   * cursor, so unread testimony plus that note is still the unrepaired
   * failure; inventing "idle" because the queue row is gone would hide it.
   *
   * A conversation parked on a provider incident is the one case where a retained
   * failed job is *not* the news. Its positional job did fail, and a retry is
   * queued five minutes out with nothing for a human to do in between, so
   * reporting failure here would render «η ανάγνωση απέτυχε · απάντησε η
   * εναλλακτική διαδικασία» about a run where no fallback answered anybody. The
   * park is reported through the fields that already say it honestly — the queued
   * retry and its due time.
   */
  private async toExtractionView(
    conversation: FeedbackConversationDocument,
  ): Promise<FeedbackConversationExtractionView> {
    const unreadSeqs = unreadParticipantSeqs(conversation);
    const parked = conversation.extraction.parkedSince !== null;
    const [jobs, notes] = await Promise.all([
      inspectFeedbackExtractJobs(
        this.queue,
        conversation._id,
        unreadSeqs,
        this.parkedRetryJobIds(conversation, unreadSeqs),
      ),
      unreadSeqs.length > 0
        ? this.results.listNotesByConversation(conversation._id)
        : Promise.resolve([]),
    ]);
    const fallbackRecorded = notes.some(
      (note) => note.extractionMeta.origin === "deterministic_fallback",
    );
    const lastRunFailed =
      !parked && (jobs.failedReason !== null || fallbackRecorded);

    return {
      unreadParticipantMessages: unreadSeqs.length,
      lastRunAt: conversation.extraction.lastRunAt?.toISOString() ?? null,
      model: conversation.extraction.model,
      nextRunAt: jobs.nextExtractionAt?.toISOString() ?? null,
      runInFlight: jobs.active,
      runQueued: jobs.pending,
      lastRunFailed,
      failedReason: lastRunFailed ? jobs.failedReason : null,
    };
  }

  /**
   * The id of the retry a parked conversation is currently waiting on.
   *
   * Derived, not searched: the park counter is on the document and the newest
   * unread participant seq is the position the parked run was reading, which is
   * exactly the pair the fallback used to enqueue it. An empty list for every
   * conversation that is not parked keeps the Redis lookup the same size it was.
   */
  private parkedRetryJobIds(
    conversation: FeedbackConversationDocument,
    unreadSeqs: readonly number[],
  ): readonly string[] {
    const latestUnread = unreadSeqs.at(-1);
    if (
      conversation.extraction.parkedSince === null ||
      latestUnread === undefined
    ) {
      return [];
    }
    return [
      createFeedbackExtractParkedJobId(
        conversation._id,
        latestUnread,
        conversation.extraction.parkedRuns,
      ),
    ];
  }

  private async toResultsView(
    answers: readonly FeedbackAnswerRow[],
    notes: readonly FeedbackNoteRow[],
  ): Promise<FeedbackConversationResultsView> {
    const participantIds = [
      ...answers.flatMap((answer) => [
        answer.respondentParticipantId,
        ...(answer.subjectParticipantId ? [answer.subjectParticipantId] : []),
      ]),
      ...notes.flatMap((note) => [
        note.respondentParticipantId,
        ...(note.subjectParticipantId ? [note.subjectParticipantId] : []),
      ]),
    ];
    const displayNames = await this.resolveDisplayNames(participantIds);
    return {
      answers: answers.map((answer) => toAnswerView(answer, displayNames)),
      notes: notes.map((note) => toNoteView(note, displayNames)),
    };
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

  private async requireConversationInCampaign(
    campaignId: string,
    conversationId: string,
  ): Promise<FeedbackConversationDocument> {
    await this.requireCampaign(campaignId);
    const conversation = await this.conversations.findById(conversationId);
    if (!conversation || conversation.campaignId !== campaignId) {
      throw new FeedbackConversationNotFoundError(conversationId);
    }
    return conversation;
  }

  private async resolveDisplayNames(
    participantIds: readonly string[],
  ): Promise<Map<string, ParticipantRow>> {
    const unique = [...new Set(participantIds.filter(Boolean))];
    const rows = await this.participants.findByIds(unique);
    return new Map(rows.map((row) => [row.id, row]));
  }
}
