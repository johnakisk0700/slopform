import {
  FEEDBACK_EXTRACTION_ORIGIN_STAFF,
  type FeedbackAnswerRow,
  type FeedbackNoteRow,
  type MessageOutboxRow,
  type ParticipantRow,
} from "@join-the-six/database";

import type { FeedbackConversationSummary } from "../../conversations/feedback-conversation.schemas.js";
import type {
  FeedbackCampaignConversationsView,
  FeedbackConversationCapabilities,
  FeedbackConversationDetailView,
  FeedbackConversationResultsView,
  FeedbackNoteOrigin,
  FeedbackNoteView,
} from "../post-event-feedback-conversation.schemas.js";

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

export function toListItem(
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

export function toAnswerView(
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

/**
 * Two values, not the raw provenance blob. A model extraction and the
 * deterministic fallback both quote a participant message, so both read as
 * `conversation`; only a hand-written note reads as `staff`. Rows written
 * before `origin` existed are extraction output, which is what the default
 * says.
 */
function noteOrigin(
  extractionMeta: FeedbackNoteRow["extractionMeta"],
): FeedbackNoteOrigin {
  return extractionMeta.origin === FEEDBACK_EXTRACTION_ORIGIN_STAFF
    ? "staff"
    : "conversation";
}

export function toNoteView(
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
    origin: noteOrigin(note.extractionMeta),
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

export function displayNameFor(
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

export function deliveryFor(
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
