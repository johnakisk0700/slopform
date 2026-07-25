import { randomUUID } from "node:crypto";

import { Injectable } from "@nestjs/common";
import type {
  FeedbackAnswerRow,
  FeedbackCampaignRow,
  FeedbackNoteRow,
  MessageOutboxRow,
  ParticipantRow,
} from "@join-the-six/database";

import { AuditRepository } from "../../infrastructure/audit/audit.repository.js";
import { DatabaseService } from "../../infrastructure/database/database.service.js";
import {
  FeedbackConversationCapacityError,
  FeedbackConversationNotFoundError,
  FeedbackConversationRepository,
  FeedbackConversationTransitionError,
  type FeedbackConversationSummary,
} from "../conversations/feedback-conversation.repository.js";
import type { FeedbackConversationDocument } from "../conversations/feedback-conversation.schemas.js";
import { EventsRepository } from "../events/events.repository.js";
import { ParticipantsRepository } from "../participants/participants.repository.js";
import { FeedbackOutboundTranscriptService } from "./feedback-outbound-transcript.service.js";
import { FeedbackCampaignNotFoundError } from "./post-event-feedback-campaign.service.js";
import type {
  FeedbackCampaignConversationsView,
  FeedbackCampaignResultsQuery,
  FeedbackConversationCapabilities,
  FeedbackConversationCorrelationId,
  FeedbackConversationDetailView,
  FeedbackConversationPrincipal,
  FeedbackConversationResultsView,
  FeedbackNoteView,
} from "./post-event-feedback-conversation.schemas.js";
import { PostEventFeedbackRepository } from "./post-event-feedback.repository.js";

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
    private readonly database: DatabaseService,
    private readonly repository: PostEventFeedbackRepository,
    private readonly conversations: FeedbackConversationRepository,
    private readonly events: EventsRepository,
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
      this.repository.listAnswersByConversation(conversationId),
      this.repository.listNotesByConversation(conversationId),
    ]);
    return this.toResultsView(answers, notes);
  }

  async listCampaignResults(
    campaignId: string,
    query: FeedbackCampaignResultsQuery,
  ): Promise<FeedbackConversationResultsView> {
    await this.requireCampaign(campaignId);
    const [answers, notes] = await Promise.all([
      this.repository.listAnswersByCampaign(campaignId, {
        ...(query.questionKey ? { questionKey: query.questionKey } : {}),
        ...(query.participantId ? { participantId: query.participantId } : {}),
      }),
      this.repository.listNotesByCampaign(campaignId, {
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
    }

    return this.toDetailView(transition.conversation);
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
        await this.repository.cancelQueuedOutboxForConversation(
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
      const inserted = await this.repository.insertOutboxIfAbsent(transaction, {
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

  async updateNoteReviewStatus(
    noteId: string,
    status: FeedbackNoteView["status"],
    actorId: FeedbackConversationPrincipal,
    requestId: FeedbackConversationCorrelationId,
  ): Promise<FeedbackNoteView> {
    const existing = await this.repository.findNoteById(noteId);
    if (!existing) {
      throw new FeedbackNoteNotFoundError(noteId);
    }

    const updated = await this.database.transaction(async (transaction) => {
      const row =
        existing.status === status
          ? existing
          : await this.repository.updateNoteStatus(transaction, noteId, status);
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
    const [displayNames, outboxRows] = await Promise.all([
      this.resolveDisplayNames([conversation.respondentParticipantId]),
      this.repository.listOutboxByConversation(conversation._id),
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
        at: message.at.toISOString(),
        delivery: deliveryFor(message.outboxId, outboxById),
      })),
      needsAttention: conversation.needsAttention,
      remindedAt: conversation.remindedAt?.toISOString() ?? null,
      createdAt: conversation.createdAt.toISOString(),
      updatedAt: conversation.updatedAt.toISOString(),
      capabilities: conversationCapabilities(conversation),
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
    const campaign = await this.repository.findCampaignById(campaignId);
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

/** Capability flags the admin UI trusts instead of hardcoding transition rules. */
export function conversationCapabilities(conversation: {
  readonly lifecycle: {
    readonly state: "open" | "closed";
    readonly reason?: "completed" | "stopped" | "expired" | "cancelled" | null;
  };
  readonly control: {
    readonly mode: "bot" | "human";
    readonly source?: "launch" | "staff_action" | "external_outbound";
  };
}): FeedbackConversationCapabilities {
  const open = conversation.lifecycle.state === "open";
  // STOP-closed (and every other closed state) exposes no conversation actions.
  return {
    canTakeOver: open && conversation.control.mode === "bot",
    canResumeBot: open && conversation.control.mode === "human",
    canClose: open,
    canSendStaffMessage: open && conversation.control.mode === "human",
  };
}

function toListItem(
  summary: FeedbackConversationSummary,
  displayNames: Map<string, ParticipantRow>,
): FeedbackCampaignConversationsView["conversations"][number] {
  return {
    id: summary._id,
    campaignId: summary.campaignId,
    respondentParticipantId: summary.respondentParticipantId,
    respondentDisplayName: displayNameFor(
      displayNames.get(summary.respondentParticipantId),
    ),
    phoneAtLaunch: summary.phoneAtLaunch,
    lifecycle: {
      state: summary.lifecycle.state,
      reason: summary.lifecycle.reason,
    },
    control: {
      mode: summary.control.mode,
      source: summary.control.source,
    },
    goals: summary.goals.map((goal) => ({
      key: goal.key as FeedbackCampaignConversationsView["conversations"][number]["goals"][number]["key"],
      ordinal: goal.ordinal,
      status: goal.status,
    })),
    messageCount: summary.messageCount,
    lastMessageAt: summary.lastMessageAt?.toISOString() ?? null,
    lastMessageActor: summary.lastMessageActor,
    needsAttention: summary.needsAttention,
    remindedAt: summary.remindedAt?.toISOString() ?? null,
    createdAt: summary.createdAt.toISOString(),
    updatedAt: summary.updatedAt.toISOString(),
    capabilities: conversationCapabilities(summary),
  };
}

function toAnswerView(
  answer: FeedbackAnswerRow,
  displayNames: Map<string, ParticipantRow>,
): FeedbackConversationResultsView["answers"][number] {
  return {
    id: answer.id,
    campaignId: answer.campaignId,
    conversationId: answer.conversationId,
    questionKey:
      answer.questionKey as FeedbackConversationResultsView["answers"][number]["questionKey"],
    valueInt: answer.valueInt,
    respondentParticipantId: answer.respondentParticipantId,
    respondentDisplayName: displayNameFor(
      displayNames.get(answer.respondentParticipantId),
    ),
    subjectParticipantId: answer.subjectParticipantId,
    subjectDisplayName: answer.subjectParticipantId
      ? displayNameFor(displayNames.get(answer.subjectParticipantId))
      : null,
    sourceMessageIds: answer.sourceMessageIds,
    createdAt: answer.createdAt.toISOString(),
    updatedAt: answer.updatedAt.toISOString(),
  };
}

function toNoteView(
  note: FeedbackNoteRow,
  displayNames: Map<string, ParticipantRow>,
): FeedbackNoteView {
  return {
    id: note.id,
    campaignId: note.campaignId,
    conversationId: note.conversationId,
    noteType: note.noteType as FeedbackNoteView["noteType"],
    text: note.text,
    status: note.status as FeedbackNoteView["status"],
    respondentParticipantId: note.respondentParticipantId,
    respondentDisplayName: displayNameFor(
      displayNames.get(note.respondentParticipantId),
    ),
    subjectParticipantId: note.subjectParticipantId,
    subjectDisplayName: note.subjectParticipantId
      ? displayNameFor(displayNames.get(note.subjectParticipantId))
      : null,
    sourceMessageIds: note.sourceMessageIds,
    createdAt: note.createdAt.toISOString(),
    updatedAt: note.updatedAt.toISOString(),
  };
}

function displayNameFor(
  participant: ParticipantRow | undefined,
): string | null {
  if (!participant) {
    return null;
  }
  const preferred = participant.preferredName?.trim();
  return preferred && preferred.length > 0
    ? preferred
    : participant.emailNormalized;
}

function deliveryFor(
  outboxId: string | null,
  outboxById: Map<string, MessageOutboxRow>,
): FeedbackConversationDetailView["messages"][number]["delivery"] {
  if (!outboxId) {
    return null;
  }
  const row = outboxById.get(outboxId);
  if (!row) {
    return null;
  }
  return {
    outboxId: row.id,
    outboxStatus: row.status as NonNullable<
      FeedbackConversationDetailView["messages"][number]["delivery"]
    >["outboxStatus"],
    deliveryStatus: (row.deliveryStatus ?? null) as NonNullable<
      FeedbackConversationDetailView["messages"][number]["delivery"]
    >["deliveryStatus"],
    sentAt: row.sentAt?.toISOString() ?? null,
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    readAt: row.readAt?.toISOString() ?? null,
    playedAt: row.playedAt?.toISOString() ?? null,
  };
}
