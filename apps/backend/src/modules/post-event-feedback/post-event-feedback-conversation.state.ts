import { randomUUID } from "node:crypto";

import {
  POST_EVENT_FEEDBACK_SAFETY_CATEGORIES,
  feedbackConversationMessageAttentionSchema,
  strongerRecommendedAction,
  type PostEventFeedbackAttentionReason,
  type PostEventFeedbackRecommendedAction,
  type PostEventFeedbackSafetyCategory,
} from "./attention.js";
import {
  FEEDBACK_CONVERSATION_MAX_ATTENTION_REASONS,
  accumulateFeedbackExtractionUsage,
  canTransitionGoalStatus,
  resolveFeedbackConversationWork,
  sortTranscript,
  type FeedbackConversationDocument,
  type FeedbackConversationExtractionUsage,
  type FeedbackConversationGoal,
  type FeedbackConversationLifecycleReason,
  type FeedbackConversationMessage,
} from "./post-event-feedback-conversation.document.js";
import { FeedbackConversationTransitionError } from "./post-event-feedback-conversation.errors.js";

export interface FeedbackConversationTransitionResult {
  readonly changed: boolean;
  readonly conversation: FeedbackConversationDocument;
}

export type FeedbackConversationExpectedWork = {
  readonly revision: number;
  readonly epoch: number;
};

export function admitsExactWorkFence(
  conversation: FeedbackConversationDocument,
  expected: FeedbackConversationExpectedWork,
  fenceEpoch: number | undefined,
): boolean {
  if (fenceEpoch === undefined) {
    return false;
  }
  const work = resolveFeedbackConversationWork(conversation.work);
  return work.revision === expected.revision && fenceEpoch === expected.epoch;
}

export function admitsAwaitingHumanWorkFence(
  conversation: FeedbackConversationDocument,
  expected: FeedbackConversationExpectedWork,
  fenceEpoch: number | undefined,
  toSeq: number,
): boolean {
  if (fenceEpoch === undefined || fenceEpoch !== expected.epoch) {
    return false;
  }
  const work = resolveFeedbackConversationWork(conversation.work);
  if (work.revision === expected.revision) {
    return true;
  }
  return (
    work.revision > expected.revision &&
    conversation.messages.some(
      (message) => message.actor === "participant" && message.seq > toSeq,
    )
  );
}

export function applyMarkWorkDue(
  conversation: FeedbackConversationDocument,
  nextActionAt: Date,
  at: Date,
): FeedbackConversationDocument {
  const work = resolveFeedbackConversationWork(conversation.work);
  return touchUpdatedAt(
    {
      ...conversation,
      work: {
        ...work,
        revision: work.revision + 1,
        nextActionAt,
      },
    },
    at,
  );
}

export function applySettleWorkExecution(
  conversation: FeedbackConversationDocument,
  input: {
    readonly revision: number;
    readonly nextActionAt: Date | null;
    readonly at: Date;
  },
): FeedbackConversationTransitionResult {
  const work = resolveFeedbackConversationWork(conversation.work);
  if (work.revision !== input.revision) {
    return { changed: false, conversation };
  }
  return {
    changed: true,
    conversation: touchUpdatedAt(
      {
        ...conversation,
        work: {
          ...work,
          revision:
            input.nextActionAt === null ? work.revision : work.revision + 1,
          nextActionAt: input.nextActionAt,
        },
      },
      input.at,
    ),
  };
}

export function applyTakeOver(
  conversation: FeedbackConversationDocument,
  input: {
    readonly source: Exclude<
      FeedbackConversationDocument["control"]["source"],
      "launch"
    >;
    readonly at: Date;
  },
): FeedbackConversationTransitionResult {
  if (
    conversation.control.mode !== "bot" ||
    conversation.lifecycle.state !== "open"
  ) {
    return { changed: false, conversation };
  }
  return {
    changed: true,
    conversation: touchUpdatedAt(
      {
        ...conversation,
        control: { mode: "human", source: input.source, changedAt: input.at },
        awaitingHuman: false,
      },
      input.at,
    ),
  };
}

export function applyMarkAwaitingHuman(
  conversation: FeedbackConversationDocument,
  at: Date,
): FeedbackConversationTransitionResult {
  if (
    conversation.lifecycle.state !== "open" ||
    conversation.control.mode !== "bot"
  ) {
    return { changed: false, conversation };
  }
  const work = resolveFeedbackConversationWork(conversation.work);
  if (conversation.awaitingHuman && work.nextActionAt === null) {
    return { changed: false, conversation };
  }
  return {
    changed: true,
    conversation: touchUpdatedAt(
      {
        ...conversation,
        awaitingHuman: true,
        work: { ...work, nextActionAt: null },
      },
      at,
    ),
  };
}

export function applyRecordHostileTurn(
  conversation: FeedbackConversationDocument,
  input: { readonly expectedCount: number; readonly at: Date },
): FeedbackConversationTransitionResult {
  if (conversation.hostileTurns !== input.expectedCount) {
    return { changed: false, conversation };
  }
  return {
    changed: true,
    conversation: touchUpdatedAt(
      { ...conversation, hostileTurns: input.expectedCount + 1 },
      input.at,
    ),
  };
}

export function applyMarkExtractionFallbackAckSent(
  conversation: FeedbackConversationDocument,
  at: Date,
): FeedbackConversationTransitionResult {
  if (conversation.extractionFallbackAckSent) {
    return { changed: false, conversation };
  }
  return {
    changed: true,
    conversation: touchUpdatedAt(
      { ...conversation, extractionFallbackAckSent: true },
      at,
    ),
  };
}

export function applyParkExtraction(
  conversation: FeedbackConversationDocument,
  at: Date,
): FeedbackConversationTransitionResult {
  return {
    changed: true,
    conversation: touchUpdatedAt(
      {
        ...conversation,
        extraction: {
          ...conversation.extraction,
          parkedSince: conversation.extraction.parkedSince ?? at,
          parkedRuns: conversation.extraction.parkedRuns + 1,
        },
      },
      at,
    ),
  };
}

export function applyMarkExtractionParkedNoticeSent(
  conversation: FeedbackConversationDocument,
  at: Date,
): FeedbackConversationTransitionResult {
  if (conversation.extraction.parkedNoticeSentAt != null) {
    return { changed: false, conversation };
  }
  return {
    changed: true,
    conversation: touchUpdatedAt(
      {
        ...conversation,
        extraction: {
          ...conversation.extraction,
          parkedNoticeSentAt: at,
        },
      },
      at,
    ),
  };
}

export function applyResumeBot(
  conversation: FeedbackConversationDocument,
  at: Date,
): FeedbackConversationTransitionResult {
  if (conversation.lifecycle.state === "closed") {
    throw new FeedbackConversationTransitionError(
      "A closed feedback conversation cannot resume bot control",
    );
  }
  if (conversation.control.mode !== "human") {
    return { changed: false, conversation };
  }
  const work = resolveFeedbackConversationWork(conversation.work);
  const latestParticipantSeq = conversation.messages.reduce(
    (latest, message) =>
      message.actor === "participant" && message.seq > latest
        ? message.seq
        : latest,
    0,
  );
  const hasUnreadTestimony =
    latestParticipantSeq > conversation.extraction.cursorSeq;
  return {
    changed: true,
    conversation: touchUpdatedAt(
      {
        ...conversation,
        control: { mode: "bot", source: "staff_action", changedAt: at },
        awaitingHuman: false,
        work: {
          ...work,
          revision: work.revision + 1,
          nextActionAt: hasUnreadTestimony ? at : work.nextActionAt,
        },
      },
      at,
    ),
  };
}

export function applyClose(
  conversation: FeedbackConversationDocument,
  input: {
    readonly reason: FeedbackConversationLifecycleReason;
    readonly at: Date;
    readonly terminalOutboxId: string | null;
    readonly staffClose: FeedbackConversationDocument["staffClose"];
  },
): FeedbackConversationTransitionResult {
  if (input.reason === "stopped") {
    if (conversation.lifecycle.reason === "stopped") {
      return { changed: false, conversation };
    }
  } else if (conversation.lifecycle.state !== "open") {
    return { changed: false, conversation };
  }
  const closed = touchUpdatedAt(
    {
      ...conversation,
      lifecycle: {
        state: "closed",
        reason: input.reason,
        closedAt: input.at,
        terminalOutboxId: input.terminalOutboxId,
      },
      staffClose: input.staffClose ?? null,
    },
    input.at,
  );
  return {
    changed: true,
    conversation: applyLowerSettledAttention(closed, input.at),
  };
}

export function applyLowerSettledAttention(
  conversation: FeedbackConversationDocument,
  at: Date,
): FeedbackConversationDocument {
  if (
    !conversation.needsAttention ||
    conversation.attentionReasons.some((reason) => reason.resolvedAt === null)
  ) {
    return conversation;
  }
  return touchUpdatedAt({ ...conversation, needsAttention: false }, at);
}

export function applyAdvanceCursor(
  conversation: FeedbackConversationDocument,
  input: {
    readonly toSeq: number;
    readonly at: Date;
    readonly model?: string | null;
    readonly serviceTier?: string | null;
    readonly usage?: FeedbackConversationExtractionUsage;
    readonly expectedWork?: FeedbackConversationExpectedWork;
    readonly fenceEpoch?: number;
  },
): FeedbackConversationTransitionResult {
  assertCursorInsideTranscript(conversation, input.toSeq);
  if (
    input.expectedWork &&
    !admitsExactWorkFence(conversation, input.expectedWork, input.fenceEpoch)
  ) {
    return { changed: false, conversation };
  }
  if (conversation.extraction.cursorSeq >= input.toSeq) {
    return { changed: false, conversation };
  }
  return {
    changed: true,
    conversation: touchUpdatedAt(
      {
        ...conversation,
        extraction: advancedExtraction(conversation, {
          toSeq: input.toSeq,
          at: input.at,
          model: input.model ?? null,
          serviceTier: input.serviceTier ?? null,
          ...(input.usage !== undefined ? { usage: input.usage } : {}),
        }),
      },
      input.at,
    ),
  };
}

export function applyAdvanceCursorAndMarkAwaitingHuman(
  conversation: FeedbackConversationDocument,
  input: {
    readonly toSeq: number;
    readonly at: Date;
    readonly model: string;
    readonly serviceTier: string | null;
    readonly usage: FeedbackConversationExtractionUsage;
    readonly expectedWork?: FeedbackConversationExpectedWork;
    readonly fenceEpoch?: number;
  },
): FeedbackConversationTransitionResult {
  assertCursorInsideTranscript(conversation, input.toSeq);
  if (
    conversation.lifecycle.state !== "open" ||
    conversation.control.mode !== "bot"
  ) {
    return { changed: false, conversation };
  }
  if (input.expectedWork) {
    if (
      !admitsAwaitingHumanWorkFence(
        conversation,
        input.expectedWork,
        input.fenceEpoch,
        input.toSeq,
      )
    ) {
      return { changed: false, conversation };
    }
    if (conversation.extraction.cursorSeq > input.toSeq) {
      return { changed: false, conversation };
    }
  } else if (conversation.extraction.cursorSeq >= input.toSeq) {
    return { changed: false, conversation };
  }
  const advancesCursor = conversation.extraction.cursorSeq < input.toSeq;
  return {
    changed: true,
    conversation: touchUpdatedAt(
      {
        ...conversation,
        extraction: advancesCursor
          ? advancedExtraction(conversation, input)
          : conversation.extraction,
        awaitingHuman: true,
      },
      input.at,
    ),
  };
}

export function applyAdvanceCursorAndClose(
  conversation: FeedbackConversationDocument,
  input: {
    readonly toSeq: number;
    readonly reason: "completed" | "declined";
    readonly terminalOutboxId: string | null;
    readonly at: Date;
    readonly model: string;
    readonly serviceTier: string | null;
    readonly usage: FeedbackConversationExtractionUsage;
    readonly expectedWork?: FeedbackConversationExpectedWork;
    readonly fenceEpoch?: number;
  },
): FeedbackConversationTransitionResult {
  assertCursorInsideTranscript(conversation, input.toSeq);
  if (
    conversation.lifecycle.state !== "open" ||
    conversation.control.mode !== "bot" ||
    conversation.awaitingHuman
  ) {
    return { changed: false, conversation };
  }
  if (
    input.expectedWork &&
    !admitsExactWorkFence(conversation, input.expectedWork, input.fenceEpoch)
  ) {
    return { changed: false, conversation };
  }
  if (
    conversation.messages.some(
      (message) => message.actor === "participant" && message.seq > input.toSeq,
    )
  ) {
    return { changed: false, conversation };
  }
  const advancesCursor = conversation.extraction.cursorSeq < input.toSeq;
  return {
    changed: true,
    conversation: touchUpdatedAt(
      {
        ...conversation,
        extraction: advancesCursor
          ? advancedExtraction(conversation, input)
          : conversation.extraction,
        lifecycle: {
          state: "closed",
          reason: input.reason,
          closedAt: input.at,
          terminalOutboxId: input.terminalOutboxId,
        },
      },
      input.at,
    ),
  };
}

export function applyUpdateGoalStatuses(
  conversation: FeedbackConversationDocument,
  input: {
    readonly statuses: readonly {
      readonly key: FeedbackConversationGoal["key"];
      readonly status: FeedbackConversationGoal["status"];
    }[];
    readonly at: Date;
  },
): FeedbackConversationTransitionResult {
  const statuses = [
    ...new Map(input.statuses.map((entry) => [entry.key, entry])).values(),
  ].filter((entry) => {
    const goal = conversation.goals.find(
      (candidate) => candidate.key === entry.key,
    );
    return (
      goal !== undefined && canTransitionGoalStatus(goal.status, entry.status)
    );
  });
  if (statuses.length === 0) {
    return applyReconcileStoppedWithoutAnswers(conversation, input.at);
  }
  const updated = touchUpdatedAt(
    {
      ...conversation,
      goals: conversation.goals.map((goal) => {
        const next = statuses.find((entry) => entry.key === goal.key);
        return next && canTransitionGoalStatus(goal.status, next.status)
          ? { ...goal, status: next.status }
          : goal;
      }),
    },
    input.at,
  );
  const changed = statuses.some(
    (entry) =>
      updated.goals.find((goal) => goal.key === entry.key)?.status !==
      conversation.goals.find((goal) => goal.key === entry.key)?.status,
  );
  const reconciled = applyReconcileStoppedWithoutAnswers(updated, input.at);
  return {
    changed: changed || reconciled.changed,
    conversation: reconciled.conversation,
  };
}

export function applyReconcileStoppedWithoutAnswers(
  conversation: FeedbackConversationDocument,
  at: Date,
): FeedbackConversationTransitionResult {
  if (
    conversation.lifecycle.reason !== "stopped" ||
    !conversation.goals.some((goal) => goal.status === "answered")
  ) {
    return { changed: false, conversation };
  }
  const staleReason = conversation.attentionReasons.find(
    (reason) =>
      reason.kind === "stopped_without_answers" && reason.resolvedAt === null,
  );
  if (!staleReason) {
    return { changed: false, conversation };
  }
  return applyResolveAttentionReason(conversation, {
    reasonId: staleReason.id,
    resolvedBy: "system:feedback_extraction",
    at,
  });
}

export function applyRaiseAttention(
  conversation: FeedbackConversationDocument,
  input: {
    readonly kind: PostEventFeedbackAttentionReason;
    readonly messageId: string | null;
    readonly at: Date;
  },
): FeedbackConversationTransitionResult {
  if (
    conversation.attentionReasons.some(
      (reason) =>
        reason.kind === input.kind &&
        reason.messageId === input.messageId &&
        reason.resolvedAt === null,
    )
  ) {
    return { changed: false, conversation };
  }
  if (
    conversation.attentionReasons.length >=
    FEEDBACK_CONVERSATION_MAX_ATTENTION_REASONS
  ) {
    throw new FeedbackConversationTransitionError(
      "The feedback conversation reached its attention-reason capacity",
    );
  }
  return {
    changed: true,
    conversation: touchUpdatedAt(
      {
        ...conversation,
        needsAttention: true,
        attentionReasons: [
          ...conversation.attentionReasons,
          {
            id: randomUUID(),
            kind: input.kind,
            messageId: input.messageId,
            at: input.at,
            resolvedAt: null,
            resolvedBy: null,
          },
        ],
      },
      input.at,
    ),
  };
}

export function applyResolveAttentionReason(
  conversation: FeedbackConversationDocument,
  input: {
    readonly reasonId: string;
    readonly resolvedBy: string;
    readonly at: Date;
  },
): FeedbackConversationTransitionResult {
  const target = conversation.attentionReasons.find(
    (reason) => reason.id === input.reasonId && reason.resolvedAt === null,
  );
  if (!target) {
    return { changed: false, conversation };
  }
  const attentionReasons = conversation.attentionReasons.map((reason) =>
    reason.id === input.reasonId
      ? {
          ...reason,
          resolvedAt: input.at,
          resolvedBy: input.resolvedBy,
        }
      : reason,
  );
  return {
    changed: true,
    conversation: touchUpdatedAt(
      {
        ...conversation,
        attentionReasons,
        needsAttention: attentionReasons.some(
          (reason) => reason.resolvedAt === null,
        ),
      },
      input.at,
    ),
  };
}

export function applyMarkReminded(
  conversation: FeedbackConversationDocument,
  input: { readonly expectedCount: number; readonly at: Date },
): FeedbackConversationTransitionResult {
  if (
    conversation.lifecycle.state !== "open" ||
    conversation.reminderCount !== input.expectedCount
  ) {
    return { changed: false, conversation };
  }
  return {
    changed: true,
    conversation: touchUpdatedAt(
      {
        ...conversation,
        remindedAt: input.at,
        reminderCount: input.expectedCount + 1,
      },
      input.at,
    ),
  };
}

export function applyMergeMessageAttention(
  conversation: FeedbackConversationDocument,
  input: {
    readonly messageId: string;
    readonly categories: readonly PostEventFeedbackSafetyCategory[];
    readonly recommendedAction: PostEventFeedbackRecommendedAction;
    readonly confidence: number;
    readonly at: Date;
  },
): FeedbackConversationTransitionResult {
  const message = conversation.messages.find(
    (candidate) => candidate.id === input.messageId,
  );
  if (!message) {
    throw new FeedbackConversationTransitionError(
      `Feedback message ${input.messageId} was not found`,
    );
  }
  if (message.actor !== "participant") {
    throw new FeedbackConversationTransitionError(
      "Only participant messages can carry attention metadata",
    );
  }
  const categories = POST_EVENT_FEEDBACK_SAFETY_CATEGORIES.filter(
    (category) =>
      message.attention?.categories.includes(category) ||
      input.categories.includes(category),
  );
  const attention = feedbackConversationMessageAttentionSchema.parse({
    categories,
    recommendedAction: message.attention
      ? strongerRecommendedAction(
          message.attention.recommendedAction,
          input.recommendedAction,
        )
      : input.recommendedAction,
    confidence: Math.max(message.attention?.confidence ?? 0, input.confidence),
  });
  if (
    message.attention &&
    JSON.stringify(message.attention) === JSON.stringify(attention)
  ) {
    return { changed: false, conversation };
  }
  return {
    changed: true,
    conversation: touchUpdatedAt(
      {
        ...conversation,
        messages: conversation.messages.map((candidate) =>
          candidate.id === input.messageId
            ? { ...candidate, attention }
            : candidate,
        ),
      },
      input.at,
    ),
  };
}

export function applyAppendMessage(
  conversation: FeedbackConversationDocument,
  message: FeedbackConversationMessage,
): FeedbackConversationDocument {
  return touchUpdatedAt(
    {
      ...conversation,
      messages: sortTranscript([...conversation.messages, message]),
    },
    message.at,
  );
}

function advancedExtraction(
  conversation: FeedbackConversationDocument,
  input: {
    readonly toSeq: number;
    readonly at: Date;
    readonly model: string | null;
    readonly serviceTier: string | null;
    readonly usage?: FeedbackConversationExtractionUsage;
  },
): FeedbackConversationDocument["extraction"] {
  return {
    ...conversation.extraction,
    cursorSeq: Math.max(conversation.extraction.cursorSeq, input.toSeq),
    lastRunAt: input.at,
    model: input.model,
    serviceTier: input.serviceTier,
    ...(input.usage
      ? {
          usage: accumulateFeedbackExtractionUsage(
            conversation.extraction.usage,
            input.usage,
          ),
        }
      : {}),
    parkedSince: null,
    parkedRuns: 0,
  };
}

function assertCursorInsideTranscript(
  conversation: FeedbackConversationDocument,
  toSeq: number,
): void {
  if (toSeq > conversation.messages.length) {
    throw new FeedbackConversationTransitionError(
      "The extraction cursor cannot pass the transcript",
    );
  }
}

function touchUpdatedAt(
  conversation: FeedbackConversationDocument,
  at: Date,
): FeedbackConversationDocument {
  return {
    ...conversation,
    updatedAt: conversation.updatedAt > at ? conversation.updatedAt : at,
  };
}
