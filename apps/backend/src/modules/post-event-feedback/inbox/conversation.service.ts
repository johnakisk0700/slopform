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
import { FeedbackResultsRepository } from "../extraction/results.repository.js";
import { FeedbackOutboxRepository } from "../outbox/outbox.repository.js";
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
import type {
  AddFeedbackConversationNoteInput,
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
   * Staff close with reason `cancelled` (D17). Idempotent: a second close on an
   * already-closed conversation returns the current read model without error.
   * A STOP-closed conversation exposes no close capability and is rejected.
   */
  async close(
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
      // Idempotent staff close: already cancelled / completed / expired.
      return this.toDetailView(conversation);
    }
    if (!capabilities.canClose) {
      throw new FeedbackConversationActionNotAllowedError(
        "Close is only available while the conversation is open",
      );
    }

    const at = new Date();
    const transition = await this.conversations.close({
      conversationId: conversation._id,
      reason: "cancelled",
      at,
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
          context: { campaignId, reason: "cancelled" },
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
      remindedAt: conversation.remindedAt?.toISOString() ?? null,
      createdAt: conversation.createdAt.toISOString(),
      updatedAt: conversation.updatedAt.toISOString(),
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
   */
  private async toExtractionView(
    conversation: FeedbackConversationDocument,
  ): Promise<FeedbackConversationExtractionView> {
    const unreadSeqs = unreadParticipantSeqs(conversation);
    const [jobs, notes] = await Promise.all([
      inspectFeedbackExtractJobs(this.queue, conversation._id, unreadSeqs),
      unreadSeqs.length > 0
        ? this.results.listNotesByConversation(conversation._id)
        : Promise.resolve([]),
    ]);
    const fallbackRecorded = notes.some(
      (note) => note.extractionMeta.origin === "deterministic_fallback",
    );
    const lastRunFailed = jobs.failedReason !== null || fallbackRecorded;

    return {
      unreadParticipantMessages: unreadSeqs.length,
      lastRunAt: conversation.extraction.lastRunAt?.toISOString() ?? null,
      model: conversation.extraction.model,
      nextRunAt: jobs.nextExtractionAt?.toISOString() ?? null,
      runInFlight: jobs.active,
      runQueued: jobs.pending,
      lastRunFailed,
      failedReason: jobs.failedReason,
    };
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
