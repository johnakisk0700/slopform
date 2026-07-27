import type {
  FeedbackAnswerRow,
  FeedbackNoteRow,
  FeedbackSimOutboundRow,
  MessageOutboxRow,
  ProviderMessageIngressRow,
} from "@join-the-six/database";

import type { AssistantModel } from "../../assistant/assistant.schemas.js";
import { assistantModelSchema } from "../../assistant/assistant.schemas.js";
import type { FeedbackConversationDocument } from "../post-event-feedback-conversation.document.js";
import {
  createFeedbackClosingDedupeKey,
  createFeedbackFallbackAckDedupeKey,
  createFeedbackFallbackDedupeKey,
  createFeedbackHandoffDedupeKey,
  createFeedbackReplyDedupeKey,
} from "../extraction/extraction.schemas.js";
import type {
  FeedbackSimulatorRunStage,
  FeedbackSimulatorRunView,
} from "./simulator.schemas.js";

export function toRunView({
  run,
  conversation,
  ingressRows,
  answers,
  notes,
  outbox,
  simulatedSends,
  extractionJobs,
}: {
  readonly run: {
    readonly id: string;
    readonly correlationId: string;
    readonly campaignId: string;
    readonly conversationId: string;
    readonly scenarioId: string;
    readonly scenarioTitle: string;
    readonly expectedModel: AssistantModel;
    readonly configuredModel: AssistantModel;
    readonly startedAt: Date;
    readonly baselineOutboxCount: number;
    readonly totalMessages: number;
    readonly targetCursorSeq: number;
    readonly candidateBindings: readonly {
      readonly slot: FeedbackSimulatorRunView["candidateBindings"][number]["slot"];
      readonly participantId: string;
      readonly displayName: string;
    }[];
    readonly renderedMessages: readonly string[];
    readonly rubric: FeedbackSimulatorRunView["rubric"];
    readonly ingressIds: readonly string[];
    readonly injectionError: string | null;
  };
  readonly conversation: FeedbackConversationDocument | undefined;
  readonly ingressRows: readonly (ProviderMessageIngressRow | undefined)[];
  readonly answers: readonly FeedbackAnswerRow[];
  readonly notes: readonly FeedbackNoteRow[];
  readonly outbox: readonly MessageOutboxRow[];
  readonly simulatedSends: readonly FeedbackSimOutboundRow[];
  readonly extractionJobs: {
    readonly active: boolean;
    readonly pending: boolean;
    readonly failedReason: string | null;
    readonly nextExtractionAt: Date | null;
  };
}): FeedbackSimulatorRunView {
  const materializedMessages = ingressRows.filter(
    (row) => row?.processingStatus === "materialized",
  ).length;
  const failedMessages = ingressRows.filter(
    (row) =>
      row !== undefined &&
      row.processingStatus !== "pending" &&
      row.processingStatus !== "materialized",
  ).length;
  const currentCursorSeq = conversation?.extraction.cursorSeq ?? 0;
  const observedModel = assistantModelSchema.safeParse(
    conversation?.extraction.model,
  );
  const expectedOutboxDedupeKeys = new Set([
    createFeedbackReplyDedupeKey(run.conversationId, run.targetCursorSeq),
    createFeedbackHandoffDedupeKey(run.conversationId, run.targetCursorSeq),
    createFeedbackFallbackDedupeKey(run.conversationId, run.targetCursorSeq),
    createFeedbackFallbackAckDedupeKey(run.conversationId),
    createFeedbackClosingDedupeKey(run.conversationId),
  ]);
  const runOutbox = outbox.filter(
    (row, index) =>
      index >= run.baselineOutboxCount &&
      expectedOutboxDedupeKeys.has(row.dedupeKey),
  );
  const runOutboxIds = new Set(runOutbox.map((row) => row.id));
  const runSimulatedSends = simulatedSends.filter((row) =>
    runOutboxIds.has(row.outboxId),
  );
  const outboxFailed = runOutbox.some((row) =>
    ["failed", "cancelled"].includes(row.status),
  );
  const outboxMissing =
    currentCursorSeq >= run.targetCursorSeq && runOutbox.length === 0;
  const outboxSettled =
    runOutbox.length > 0 &&
    runOutbox.every((row) => row.status === "sent") &&
    runSimulatedSends.length >= runOutbox.length;

  const statusInput = {
    injectionFailed: run.injectionError !== null,
    injectedMessages: run.ingressIds.length,
    totalMessages: run.totalMessages,
    materializedMessages,
    failedMessages,
    currentCursorSeq,
    targetCursorSeq: run.targetCursorSeq,
    conversationAvailable: conversation !== undefined,
    conversationOpen:
      conversation?.lifecycle.state === "open" &&
      conversation.control.mode === "bot",
    extractionActive: extractionJobs.active,
    extractionPending: extractionJobs.pending,
    extractionFailed: extractionJobs.failedReason !== null,
    outboxFailed,
    outboxMissing,
    outboxSettled,
  };
  const stage = runStage(statusInput);
  const modelMismatch =
    currentCursorSeq >= run.targetCursorSeq &&
    (!observedModel.success || observedModel.data !== run.expectedModel);
  const finalStage: FeedbackSimulatorRunStage = modelMismatch
    ? "failed"
    : stage;
  const error =
    run.injectionError ??
    (failedMessages > 0
      ? "At least one injected message did not materialize into the selected conversation."
      : extractionJobs.failedReason) ??
    (outboxFailed
      ? "The reply outbox created by this run failed or was cancelled before simulated delivery."
      : null) ??
    (outboxMissing
      ? "Extraction advanced the run cursor without creating the expected reply outbox."
      : null) ??
    (!conversation
      ? "The selected conversation no longer exists."
      : modelMismatch
        ? `The worker processed this run with ${conversation.extraction.model ?? "no recorded model"}, not ${run.expectedModel}. The comparison is invalid.`
        : !statusInput.conversationOpen &&
            currentCursorSeq < run.targetCursorSeq
          ? "The conversation left open bot control before the scenario was processed."
          : null);

  return {
    id: run.id,
    correlationId: run.correlationId,
    campaignId: run.campaignId,
    conversationId: run.conversationId,
    scenarioId: run.scenarioId,
    scenarioTitle: run.scenarioTitle,
    stage: finalStage,
    startedAt: run.startedAt.toISOString(),
    updatedAt: new Date().toISOString(),
    nextExtractionAt:
      finalStage === "waiting_quiet_window"
        ? (extractionJobs.nextExtractionAt?.toISOString() ?? null)
        : null,
    model: {
      expected: run.expectedModel,
      configured: run.configuredModel,
      observed: observedModel.success ? observedModel.data : null,
    },
    progress: {
      percent: progressPercent({
        stage: finalStage,
        injectedMessages: run.ingressIds.length,
        materializedMessages,
        totalMessages: run.totalMessages,
      }),
      totalMessages: run.totalMessages,
      injectedMessages: run.ingressIds.length,
      materializedMessages,
      failedMessages,
      targetCursorSeq: run.targetCursorSeq,
      currentCursorSeq,
    },
    outputs: {
      answers: answers.length,
      notes: notes.length,
      outboxMessages: runOutbox.length,
      simulatedSends: runSimulatedSends.length,
    },
    tokenUsage: {
      availability: "not_persisted",
      estimatedPromptTokens: null,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
    },
    cost: {
      availability: "not_available",
      estimatedUsd: null,
      actualUsd: null,
    },
    error: error ? boundedErrorMessage(error, "Simulation failed.") : null,
    candidateBindings: [...run.candidateBindings],
    renderedMessages: [...run.renderedMessages],
    rubric: run.rubric,
  };
}

export function runStage(input: {
  readonly injectionFailed: boolean;
  readonly injectedMessages: number;
  readonly totalMessages: number;
  readonly materializedMessages: number;
  readonly failedMessages: number;
  readonly currentCursorSeq: number;
  readonly targetCursorSeq: number;
  readonly conversationAvailable: boolean;
  readonly conversationOpen: boolean;
  readonly extractionActive: boolean;
  readonly extractionPending: boolean;
  readonly extractionFailed: boolean;
  readonly outboxFailed: boolean;
  readonly outboxMissing: boolean;
  readonly outboxSettled: boolean;
}): FeedbackSimulatorRunStage {
  if (
    input.injectionFailed ||
    input.failedMessages > 0 ||
    !input.conversationAvailable ||
    input.extractionFailed ||
    input.outboxFailed ||
    input.outboxMissing
  ) {
    return "failed";
  }
  if (input.injectedMessages < input.totalMessages) {
    return "injecting";
  }
  if (input.materializedMessages < input.totalMessages) {
    return "materializing";
  }
  if (input.currentCursorSeq >= input.targetCursorSeq) {
    return input.outboxSettled ? "processed" : "delivering_simulated_outbox";
  }
  if (!input.conversationOpen) {
    return "failed";
  }
  if (input.extractionActive) {
    return "extracting";
  }
  if (input.extractionPending) {
    return "waiting_quiet_window";
  }
  return "waiting_quiet_window";
}

function progressPercent(input: {
  readonly stage: FeedbackSimulatorRunStage;
  readonly injectedMessages: number;
  readonly materializedMessages: number;
  readonly totalMessages: number;
}): number {
  if (input.stage === "processed") {
    return 100;
  }
  if (input.stage === "delivering_simulated_outbox") {
    return 95;
  }
  const injection = Math.min(
    25,
    Math.round((input.injectedMessages / input.totalMessages) * 25),
  );
  const materialization = Math.min(
    35,
    Math.round((input.materializedMessages / input.totalMessages) * 35),
  );
  const extraction =
    input.stage === "extracting" ? 25 : input.stage === "failed" ? 0 : 0;
  return Math.min(99, injection + materialization + extraction);
}

function boundedErrorMessage(error: unknown, fallback: string): string {
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : fallback;
  const normalized = message.trim() || fallback;
  return normalized.slice(0, 500);
}
