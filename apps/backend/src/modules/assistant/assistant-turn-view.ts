import type { AssistantTurnRow } from "@join-the-six/database";

import type { AssistantConversationSnapshot } from "../conversations/conversation-thread.repository.js";
import type {
  ConversationThreadDocument,
  ConversationTurn,
} from "../conversations/conversation-thread.schemas.js";
import {
  conversationTurnToolCallSchema,
  conversationTurnUsageSchema,
} from "../conversations/conversation-thread.schemas.js";
import type { AssistantThreadRecord } from "./assistant.repository.js";
import {
  DEFAULT_ASSISTANT_SERVICE_TIER,
  assistantFailureCodeSchema,
  assistantModelSchema,
  assistantReasoningEffortSchema,
  assistantServiceTierSchema,
  type AssistantModel,
  type AssistantReasoningEffort,
  type AssistantServiceTier,
  type AssistantThreadView,
  type AssistantTurnView,
  type CreateAssistantTurnInput,
} from "./assistant.schemas.js";
import { AssistantTurnConflictError } from "./assistant.service.js";

export function toThreadView(
  conversation: ConversationThreadDocument,
): AssistantThreadView {
  return {
    id: conversation._id,
    title: conversation.title,
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt.toISOString(),
    turns: conversation.turns.map((turn) => toTurnView(turn)),
  };
}

export function toTurnView(turn: ConversationTurn): AssistantTurnView {
  const { effort, model, requestId, serviceTier } =
    requireAssistantTurnMetadata(turn);
  const base = {
    id: turn.id,
    requestId,
    sequence: turn.sequence,
    model,
    effort,
    serviceTier,
    toolCalls: turn.toolCalls ?? [],
    usage: turn.usage ?? null,
    user: {
      role: "user" as const,
      content: turn.input.content,
    },
    attempt: turn.attempt,
    createdAt: turn.createdAt.toISOString(),
    startedAt: turn.startedAt?.toISOString() ?? null,
  };

  switch (turn.status) {
    case "queued":
    case "running":
      return {
        ...base,
        status: turn.status,
        assistant: null,
        partial: turn.partial,
        reasoning: turn.reasoning,
        error: null,
        completedAt: null,
      };
    case "succeeded":
      if (
        !turn.output ||
        turn.output.actor !== "assistant" ||
        !turn.completedAt
      ) {
        throw new Error(
          "Succeeded assistant turn has invalid MongoDB conversation state",
        );
      }
      return {
        ...base,
        status: "succeeded",
        assistant: {
          role: "assistant",
          content: turn.output.content,
        },
        partial: null,
        reasoning: turn.reasoning,
        error: null,
        completedAt: turn.completedAt.toISOString(),
      };
    case "failed":
      if (!turn.error || !turn.completedAt) {
        throw new Error(
          "Failed assistant turn has invalid MongoDB conversation state",
        );
      }
      return {
        ...base,
        status: "failed",
        assistant: null,
        partial: null,
        reasoning: turn.reasoning,
        error: {
          code: assistantFailureCodeSchema.parse(turn.error.code),
          message: turn.error.message,
        },
        completedAt: turn.completedAt.toISOString(),
      };
    default:
      throw new Error("Assistant turn has unsupported persisted status");
  }
}

export function toConversationSnapshot(
  record: AssistantThreadRecord,
): AssistantConversationSnapshot {
  return {
    id: record.thread.id,
    ownerId: record.thread.createdBy,
    title: record.thread.title,
    createdAt: record.thread.createdAt,
    updatedAt: record.thread.updatedAt,
    turns: record.turns.map(toConversationTurn),
  };
}

function toConversationTurn(turn: AssistantTurnRow): ConversationTurn {
  const status = asTurnStatus(turn.status);
  if (status === "succeeded" && !turn.assistantContent) {
    throw new Error("Succeeded assistant operation is missing its response");
  }
  if (
    status === "failed" &&
    (!turn.errorCode || !turn.errorMessage || !turn.completedAt)
  ) {
    throw new Error("Failed assistant operation has invalid persisted state");
  }

  return {
    id: turn.id,
    requestId: turn.requestId,
    sequence: turn.sequence,
    status,
    attempt: turn.attempt,
    model: turn.model,
    reasoningEffort: turn.effort,
    serviceTier: turn.serviceTier,
    input: { actor: "admin", content: turn.userContent },
    output:
      status === "succeeded" && turn.assistantContent
        ? { actor: "assistant", content: turn.assistantContent }
        : null,
    partial: isNonterminalTurnStatus(status) ? turn.streamedContent : null,
    reasoning: turn.reasoningContent,
    toolCalls: conversationTurnToolCallSchema
      .array()
      .max(20)
      .parse(turn.toolCalls),
    usage: usageFromRow(turn),
    error:
      status === "failed" && turn.errorCode && turn.errorMessage
        ? { code: turn.errorCode, message: turn.errorMessage }
        : null,
    createdAt: turn.createdAt,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
  };
}

function usageFromRow(turn: AssistantTurnRow): ConversationTurn["usage"] {
  if (
    turn.inputTokens === null &&
    turn.outputTokens === null &&
    turn.reasoningTokens === null &&
    turn.cachedInputTokens === null &&
    turn.totalTokens === null &&
    turn.estimatedCostEurMicros === null &&
    turn.pricingVersion === null
  ) {
    return null;
  }
  return conversationTurnUsageSchema.parse({
    inputTokens: turn.inputTokens,
    outputTokens: turn.outputTokens,
    reasoningTokens: turn.reasoningTokens,
    cachedInputTokens: turn.cachedInputTokens,
    totalTokens: turn.totalTokens,
    estimatedCostEurMicros: turn.estimatedCostEurMicros,
    pricingVersion: turn.pricingVersion,
  });
}

export function requireConversationTurn(
  conversation: ConversationThreadDocument,
  id: string,
): ConversationTurn {
  const turn = conversation.turns.find((candidate) => candidate.id === id);
  if (!turn) {
    throw new Error("Assistant turn is missing from MongoDB conversation");
  }
  return turn;
}

export function requireAssistantTurnMetadata(turn: ConversationTurn): {
  readonly requestId: string;
  readonly model: AssistantModel;
  readonly effort: AssistantReasoningEffort;
  readonly serviceTier: AssistantServiceTier;
} {
  if (!turn.requestId) {
    throw new Error("Assistant turn is missing its request id");
  }
  return {
    requestId: turn.requestId,
    model: assistantModelSchema.parse(turn.model),
    effort: assistantReasoningEffortSchema.parse(turn.reasoningEffort),
    // Turns written before the fast lane existed carry no tier, and they all ran
    // on the standard one — the only tier that existed. Reading them as standard
    // is a statement of fact, not a default papering over missing data.
    serviceTier: assistantServiceTierSchema.parse(
      turn.serviceTier ?? DEFAULT_ASSISTANT_SERVICE_TIER,
    ),
  };
}

export function titleFromContent(content: string): string {
  const oneLine = content.replace(/\s+/gu, " ").trim();
  return oneLine.length <= 80
    ? oneLine
    : `${oneLine.slice(0, 77).trimEnd()}...`;
}

export function assertIdempotentReplay(
  turn: AssistantTurnRow,
  input: CreateAssistantTurnInput,
  model: AssistantModel,
  effort: AssistantReasoningEffort,
  serviceTier: AssistantServiceTier,
): void {
  if (
    turn.model !== model ||
    turn.effort !== effort ||
    turn.serviceTier !== serviceTier ||
    turn.userContent !== input.content
  ) {
    throw new AssistantTurnConflictError(
      "The request id was already used with different turn content",
    );
  }
}

export function assertConversationProjectionIdentity(
  projection: AssistantTurnRow,
  conversation: ConversationTurn,
): void {
  if (
    conversation.requestId !== projection.requestId ||
    conversation.sequence !== projection.sequence ||
    conversation.input.actor !== "admin" ||
    conversation.input.content !== projection.userContent ||
    conversation.model !== projection.model ||
    conversation.reasoningEffort !== projection.effort ||
    (conversation.serviceTier ?? DEFAULT_ASSISTANT_SERVICE_TIER) !==
      projection.serviceTier
  ) {
    throw new Error(
      "Assistant conversation turn does not match its execution projection",
    );
  }
}

function asTurnStatus(value: string): ConversationTurn["status"] {
  if (
    value === "queued" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed"
  ) {
    return value;
  }
  throw new Error("Assistant turn has unsupported persisted status");
}

export function isNonterminalTurnStatus(value: string): boolean {
  return value === "queued" || value === "running";
}

export function isTerminalTurnStatus(
  value: ConversationTurn["status"],
): value is "succeeded" | "failed" {
  return value === "succeeded" || value === "failed";
}
