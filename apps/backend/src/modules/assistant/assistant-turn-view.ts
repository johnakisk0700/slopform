import type { AssistantTurnRow } from "@join-the-six/database";

import type { AssistantConversationSnapshot } from "../conversations/conversation-thread.repository.js";
import type {
  ConversationThreadDocument,
  ConversationTurn,
} from "../conversations/conversation-thread.schemas.js";
import type { AssistantThreadRecord } from "./assistant.repository.js";
import {
  assistantFailureCodeSchema,
  assistantModelSchema,
  assistantReasoningEffortSchema,
  type AssistantModel,
  type AssistantReasoningEffort,
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
  const { effort, model, requestId } = requireAssistantTurnMetadata(turn);
  const base = {
    id: turn.id,
    requestId,
    sequence: turn.sequence,
    model,
    effort,
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
    input: { actor: "admin", content: turn.userContent },
    output:
      status === "succeeded" && turn.assistantContent
        ? { actor: "assistant", content: turn.assistantContent }
        : null,
    error:
      status === "failed" && turn.errorCode && turn.errorMessage
        ? { code: turn.errorCode, message: turn.errorMessage }
        : null,
    createdAt: turn.createdAt,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
  };
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
} {
  if (!turn.requestId) {
    throw new Error("Assistant turn is missing its request id");
  }
  return {
    requestId: turn.requestId,
    model: assistantModelSchema.parse(turn.model),
    effort: assistantReasoningEffortSchema.parse(turn.reasoningEffort),
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
): void {
  if (
    turn.model !== model ||
    turn.effort !== effort ||
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
    conversation.reasoningEffort !== projection.effort
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
