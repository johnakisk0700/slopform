import type {
  FeedbackConversationRow,
  FeedbackConversationStoredAttentionReason,
  FeedbackConversationStoredGoal,
  FeedbackConversationStoredMessage,
  FeedbackConversationStoredUsage,
} from "@slopform/database";

import { ConversationPersistenceError } from "../conversations/conversation-persistence.errors.js";
import { feedbackConversationMessageAttentionSchema } from "./attention.js";
import {
  FEEDBACK_CONVERSATION_CHANNEL,
  FEEDBACK_CONVERSATION_MAX_MESSAGES,
  FEEDBACK_CONVERSATION_MAX_MESSAGES_BYTES,
  FEEDBACK_CONVERSATION_PURPOSE,
  FEEDBACK_CONVERSATION_SCHEMA_VERSION,
  feedbackConversationDocumentSchema,
  feedbackConversationSummarySchema,
  resolveFeedbackConversationWork,
  type FeedbackConversationDocument,
  type FeedbackConversationGoal,
  type FeedbackConversationMessage,
  type FeedbackConversationRespondent,
  type FeedbackConversationSummary,
  type FeedbackConversationWork,
} from "./post-event-feedback-conversation.document.js";

export type FeedbackConversationDerived = {
  readonly executionEpoch?: number;
  readonly campaignResumeGeneration?: number;
};

export type FeedbackConversationSerializedJson = {
  readonly messages: FeedbackConversationStoredMessage[];
  readonly goals: FeedbackConversationStoredGoal[];
  readonly attentionReasons: FeedbackConversationStoredAttentionReason[];
  readonly usage: FeedbackConversationStoredUsage | null;
};

export function conversationMessagesExceedCapacity(
  messages: readonly unknown[],
): boolean {
  if (messages.length > FEEDBACK_CONVERSATION_MAX_MESSAGES) {
    return true;
  }
  return (
    Buffer.byteLength(JSON.stringify(messages), "utf8") >
    FEEDBACK_CONVERSATION_MAX_MESSAGES_BYTES
  );
}

export function serializeConversationJson(document: {
  readonly messages: readonly FeedbackConversationMessage[];
  readonly goals: readonly FeedbackConversationGoal[];
  readonly attentionReasons: FeedbackConversationDocument["attentionReasons"];
  readonly extraction: FeedbackConversationDocument["extraction"];
}): FeedbackConversationSerializedJson {
  return {
    messages: document.messages.map(serializeStoredMessage),
    goals: document.goals.map((goal) => ({
      key: goal.key,
      ordinal: goal.ordinal,
      prompt: goal.prompt,
      status: goal.status,
    })),
    attentionReasons: document.attentionReasons.map(serializeAttentionReason),
    usage: document.extraction.usage
      ? {
          inputTokens: document.extraction.usage.inputTokens,
          outputTokens: document.extraction.usage.outputTokens,
          totalTokens: document.extraction.usage.totalTokens,
        }
      : null,
  };
}

export function reviveConversationJson(stored: {
  readonly messages: readonly FeedbackConversationStoredMessage[] | null;
  readonly attentionReasons:
    readonly FeedbackConversationStoredAttentionReason[] | null;
}): {
  readonly messages: FeedbackConversationMessage[];
  readonly attentionReasons: FeedbackConversationDocument["attentionReasons"];
} {
  return {
    messages: (stored.messages ?? []).map(reviveStoredMessage),
    attentionReasons: (stored.attentionReasons ?? []).map(
      reviveAttentionReason,
    ),
  };
}

export function toDocument(
  row: FeedbackConversationRow,
  derived: FeedbackConversationDerived = {},
): FeedbackConversationDocument {
  const revived = reviveConversationJson({
    messages: row.messages,
    attentionReasons: row.attentionReasons,
  });
  const work: FeedbackConversationWork = {
    revision: row.workRevision,
    nextActionAt: row.workNextActionAt,
    executionEpoch: derived.executionEpoch ?? 0,
    ...(derived.campaignResumeGeneration !== undefined
      ? { campaignResumeGeneration: derived.campaignResumeGeneration }
      : {}),
  };
  return feedbackConversationDocumentSchema.parse({
    _id: row.id,
    schemaVersion: FEEDBACK_CONVERSATION_SCHEMA_VERSION,
    purpose: FEEDBACK_CONVERSATION_PURPOSE,
    channel: FEEDBACK_CONVERSATION_CHANNEL,
    campaignId: row.campaignId,
    respondentParticipantId: row.respondentParticipantId,
    phoneAtLaunch: row.phoneAtLaunch,
    lifecycle: {
      state: row.lifecycleState,
      reason: row.lifecycleReason,
      closedAt: row.closedAt,
      terminalOutboxId: row.terminalOutboxId,
    },
    control: {
      mode: row.controlMode,
      source: row.controlSource,
      changedAt: row.controlChangedAt,
    },
    goals: row.goals,
    messages: revived.messages,
    extraction: {
      cursorSeq: row.cursorSeq,
      lastRunAt: row.extractionLastRunAt,
      model: row.extractionModel,
      usage: row.extractionUsage ?? null,
      serviceTier: row.extractionServiceTier,
      parkedSince: row.parkedSince,
      parkedRuns: row.parkedRuns,
      parkedNoticeSentAt: row.parkedNoticeSentAt,
    },
    work,
    needsAttention: row.needsAttention,
    attentionReasons: revived.attentionReasons,
    remindedAt: row.remindedAt,
    reminderCount: row.reminderCount,
    awaitingHuman: row.awaitingHuman,
    hostileTurns: row.hostileTurns,
    extractionFallbackAckSent: row.extractionFallbackAckSent,
    staffClose: row.staffCloseReason
      ? { reason: row.staffCloseReason, note: row.staffCloseNote }
      : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

export function toSummary(input: {
  readonly row: Pick<
    FeedbackConversationRow,
    | "id"
    | "campaignId"
    | "respondentParticipantId"
    | "phoneAtLaunch"
    | "lifecycleState"
    | "lifecycleReason"
    | "controlMode"
    | "controlSource"
    | "goals"
    | "cursorSeq"
    | "needsAttention"
    | "remindedAt"
    | "createdAt"
    | "updatedAt"
  >;
  readonly messageCount: number;
  readonly lastMessageAt: Date | string | null;
  readonly lastMessageActor: FeedbackConversationMessage["actor"] | null;
  readonly extractionParked: boolean;
}): FeedbackConversationSummary {
  return feedbackConversationSummarySchema.parse({
    _id: input.row.id,
    campaignId: input.row.campaignId,
    respondentParticipantId: input.row.respondentParticipantId,
    phoneAtLaunch: input.row.phoneAtLaunch,
    lifecycle: {
      state: input.row.lifecycleState,
      reason: input.row.lifecycleReason,
    },
    control: {
      mode: input.row.controlMode,
      source: input.row.controlSource,
    },
    goals: input.row.goals.map((goal) => ({
      key: goal.key,
      ordinal: goal.ordinal,
      status: goal.status,
    })),
    messageCount: input.messageCount,
    lastMessageAt: reviveNullableDate(input.lastMessageAt),
    lastMessageActor: input.lastMessageActor,
    cursorSeq: input.row.cursorSeq,
    needsAttention: input.row.needsAttention,
    extractionParked: input.extractionParked,
    remindedAt: input.row.remindedAt,
    createdAt: input.row.createdAt,
    updatedAt: input.row.updatedAt,
  });
}

export function toRespondent(
  row: Pick<
    FeedbackConversationRow,
    "id" | "respondentParticipantId" | "phoneAtLaunch"
  >,
): FeedbackConversationRespondent {
  return {
    _id: row.id,
    respondentParticipantId: row.respondentParticipantId,
    phoneAtLaunch: row.phoneAtLaunch,
  };
}

export function toRowUpdate(
  document: FeedbackConversationDocument,
): Omit<
  FeedbackConversationRow,
  | "id"
  | "campaignId"
  | "respondentParticipantId"
  | "phoneAtLaunch"
  | "createdAt"
> {
  const serialized = serializeConversationJson(document);
  const staffClose = document.staffClose ?? null;
  const work = resolveFeedbackConversationWork(document.work);
  return {
    lifecycleState: document.lifecycle.state,
    lifecycleReason: document.lifecycle.reason,
    closedAt: document.lifecycle.closedAt,
    terminalOutboxId: document.lifecycle.terminalOutboxId ?? null,
    staffCloseReason: staffClose?.reason ?? null,
    staffCloseNote: staffClose?.note ?? null,
    controlMode: document.control.mode,
    controlSource: document.control.source,
    controlChangedAt: document.control.changedAt,
    needsAttention: document.needsAttention,
    awaitingHuman: document.awaitingHuman,
    hostileTurns: document.hostileTurns,
    extractionFallbackAckSent: document.extractionFallbackAckSent,
    reminderCount: document.reminderCount,
    remindedAt: document.remindedAt,
    cursorSeq: document.extraction.cursorSeq,
    extractionLastRunAt: document.extraction.lastRunAt,
    extractionModel: document.extraction.model,
    extractionServiceTier: document.extraction.serviceTier,
    parkedSince: document.extraction.parkedSince,
    parkedRuns: document.extraction.parkedRuns,
    parkedNoticeSentAt: document.extraction.parkedNoticeSentAt,
    workRevision: work.revision,
    workNextActionAt: work.nextActionAt,
    messages: serialized.messages,
    goals: serialized.goals,
    attentionReasons: serialized.attentionReasons,
    extractionUsage: serialized.usage,
    updatedAt: document.updatedAt,
  };
}

export function toLaunchInsert(
  document: FeedbackConversationDocument,
): FeedbackConversationRow {
  return {
    id: document._id,
    campaignId: document.campaignId,
    respondentParticipantId: document.respondentParticipantId,
    phoneAtLaunch: document.phoneAtLaunch,
    createdAt: document.createdAt,
    ...toRowUpdate(document),
  };
}

function serializeStoredMessage(
  message: FeedbackConversationMessage,
): FeedbackConversationStoredMessage {
  return {
    id: message.id,
    seq: message.seq,
    actor: message.actor,
    text: message.text,
    providerMessageId: message.providerMessageId,
    ingressId: message.ingressId,
    outboxId: message.outboxId,
    attention: message.attention,
    at: message.at.toISOString(),
  };
}

function reviveStoredMessage(
  message: FeedbackConversationStoredMessage,
): FeedbackConversationMessage {
  return {
    ...message,
    at: reviveDate(message.at),
    attention: message.attention
      ? feedbackConversationMessageAttentionSchema.parse(message.attention)
      : null,
  };
}

function serializeAttentionReason(
  reason: FeedbackConversationDocument["attentionReasons"][number],
): FeedbackConversationStoredAttentionReason {
  return {
    id: reason.id,
    kind: reason.kind,
    messageId: reason.messageId,
    at: reason.at.toISOString(),
    resolvedAt: reason.resolvedAt ? reason.resolvedAt.toISOString() : null,
    resolvedBy: reason.resolvedBy,
  };
}

function reviveAttentionReason(
  reason: FeedbackConversationStoredAttentionReason,
): FeedbackConversationDocument["attentionReasons"][number] {
  return {
    id: reason.id,
    kind: reason.kind as FeedbackConversationDocument["attentionReasons"][number]["kind"],
    messageId: reason.messageId,
    at: reviveDate(reason.at),
    resolvedAt: reason.resolvedAt ? reviveDate(reason.resolvedAt) : null,
    resolvedBy: reason.resolvedBy,
  };
}

function reviveNullableDate(value: Date | string | null): Date | null {
  if (value === null) {
    return null;
  }
  return reviveDate(value);
}

function reviveDate(value: Date | string): Date {
  if (value instanceof Date) {
    return value;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ConversationPersistenceError(
      "Conversation JSON contained an invalid timestamp",
    );
  }
  return parsed;
}
