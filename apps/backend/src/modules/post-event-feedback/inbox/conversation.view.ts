import {
  FEEDBACK_EXTRACTION_ORIGIN_STAFF,
  type FeedbackAnswerRow,
  type FeedbackNoteRow,
  type MessageOutboxRow,
  type ParticipantRow,
} from "@slopform/database";

import { latestAnswerCorrection } from "../extraction/answer-corrections.js";
import {
  resolveFeedbackConversationWork,
  type FeedbackConversationDocument,
  type FeedbackConversationLifecycleReason,
  type FeedbackConversationSummary,
} from "../post-event-feedback-conversation.document.js";
import type {
  FeedbackAnswerView,
  FeedbackCampaignConversationsView,
  FeedbackConversationAutomationView,
  FeedbackConversationCapabilities,
  FeedbackConversationDetailView,
  FeedbackConversationExtractionView,
  FeedbackConversationResultsView,
  FeedbackNoteOrigin,
  FeedbackNoteView,
} from "./conversation.schemas.js";

export interface FeedbackConversationActiveLeaseView {
  readonly claimExpiresAt: Date;
}

/** Extraction facts derived solely from the Mongo-authoritative aggregate. */
export function toExtractionView(
  conversation: FeedbackConversationDocument,
): FeedbackConversationExtractionView {
  return {
    unreadParticipantMessages: conversation.messages.filter(
      (message) =>
        message.actor === "participant" &&
        message.seq > conversation.extraction.cursorSeq,
    ).length,
    lastRunAt: conversation.extraction.lastRunAt?.toISOString() ?? null,
    model: conversation.extraction.model,
  };
}

/**
 * One coherent automation projection from durable scheduling and execution.
 *
 * A live claim takes precedence because work is executing even if another
 * participant message advanced MongoDB's revision in the meantime. A provider
 * park then outranks its future retry schedule; `nextActionAt` still says when
 * that retry (or eventual expiry) is due.
 */
export function toAutomationView(
  conversation: FeedbackConversationDocument,
  activeLease: FeedbackConversationActiveLeaseView | undefined,
): FeedbackConversationAutomationView {
  const work = resolveFeedbackConversationWork(conversation.work);
  const state: FeedbackConversationAutomationView["state"] = activeLease
    ? "running"
    : conversation.extraction.parkedSince !== null
      ? "parked"
      : work.nextActionAt
        ? "scheduled"
        : "idle";

  return {
    state,
    nextActionAt: work.nextActionAt?.toISOString() ?? null,
    revision: work.revision,
    claimExpiresAt:
      state === "running" && activeLease
        ? activeLease.claimExpiresAt.toISOString()
        : null,
  };
}

/** Capability flags the admin UI trusts instead of hardcoding transition rules. */
export function conversationCapabilities(conversation: {
  readonly lifecycle: {
    readonly state: "open" | "closed";
    readonly reason?: FeedbackConversationLifecycleReason | null;
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
    origin: resultOrigin(answer.extractionMeta),
    correction: answerCorrection(answer.extractionMeta),
    createdAt: answer.createdAt.toISOString(),
    updatedAt: answer.updatedAt.toISOString(),
  };
}

/**
 * Two values from the newest correction, or null on a row no human has touched.
 *
 * `createdAt` stops meaning "when this value was decided" the moment a
 * correction lands, and this is what lets the admin say so instead of showing a
 * number with no author.
 */
function answerCorrection(
  extractionMeta: FeedbackAnswerRow["extractionMeta"],
): FeedbackAnswerView["correction"] {
  const correction = latestAnswerCorrection(extractionMeta);
  return correction ? { at: correction.at, by: correction.by } : null;
}

/**
 * Two values, not the raw provenance blob. A model extraction and the
 * deterministic fallback both quote a participant message, so both read as
 * `conversation`; only what an operator wrote by hand reads as `staff`. Rows
 * written before `origin` existed are extraction output, which is what the
 * default says. One function for answers and notes because the fact is the
 * same one on both.
 */
function resultOrigin(
  extractionMeta: FeedbackAnswerRow["extractionMeta"],
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
    origin: resultOrigin(note.extractionMeta),
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
