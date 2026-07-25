import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { AssistantTurnRow } from "@join-the-six/database";

import type { Environment } from "../../infrastructure/config/environment.js";
import {
  ConversationTerminalResultConflictError,
  ConversationThreadRepository,
  type AssistantConversationSnapshot,
} from "../conversations/conversation-thread.repository.js";
import {
  CONVERSATION_THREAD_MAX_TURNS,
  type ConversationThreadDocument,
  type ConversationTurn,
} from "../conversations/conversation-thread.schemas.js";
import { assistantModelAdapter } from "./assistant-models.js";
import {
  AssistantActiveTurnPersistenceError,
  AssistantRepository,
  AssistantRequestReplayPersistenceError,
  AssistantThreadCapacityPersistenceError,
  type AssistantThreadRecord,
} from "./assistant.repository.js";
import {
  DEFAULT_ASSISTANT_MODEL,
  DEFAULT_ASSISTANT_REASONING_EFFORT,
  assistantFailureCodeSchema,
  assistantModelSchema,
  assistantReasoningEffortSchema,
  type AssistantFailureCode,
  type AssistantModel,
  type AssistantReasoningEffort,
  type AssistantThreadListView,
  type AssistantThreadView,
  type AssistantTurnView,
  type CreateAssistantThreadInput,
  type CreateAssistantTurnInput,
} from "./assistant.schemas.js";

export class AssistantThreadNotFoundError extends Error {
  constructor(id: string) {
    super(`Assistant thread ${id} was not found`);
    this.name = AssistantThreadNotFoundError.name;
  }
}

export class AssistantTurnNotFoundError extends Error {
  constructor(id: string) {
    super(`Assistant turn ${id} was not found`);
    this.name = AssistantTurnNotFoundError.name;
  }
}

export class AssistantTurnConflictError extends Error {
  constructor(message = "The assistant thread already has an active turn") {
    super(message);
    this.name = AssistantTurnConflictError.name;
  }
}

export class AssistantProviderUnavailableError extends Error {
  constructor() {
    super("The selected assistant model is not configured");
    this.name = AssistantProviderUnavailableError.name;
  }
}

export interface AssistantTurnCreation {
  readonly created: boolean;
  readonly enqueueRequired: boolean;
  readonly turn: AssistantTurnView;
}

export interface AssistantThreadCreation {
  readonly created: boolean;
  readonly enqueueRequired: boolean;
  readonly thread: AssistantThreadView;
  readonly turn: AssistantTurnView;
}

export interface AssistantTurnExecution {
  readonly turn: AssistantTurnRow;
  readonly messages: Array<{
    readonly role: "user" | "assistant";
    readonly content: string;
  }>;
}

@Injectable()
export class AssistantService {
  constructor(
    private readonly config: ConfigService<Environment, true>,
    private readonly repository: AssistantRepository,
    private readonly conversations: ConversationThreadRepository,
  ) {}

  async createThread(
    input: CreateAssistantThreadInput,
    createdBy: string,
  ): Promise<AssistantThreadCreation> {
    const model = input.model ?? DEFAULT_ASSISTANT_MODEL;
    const effort = input.effort ?? DEFAULT_ASSISTANT_REASONING_EFFORT;
    const replay = await this.repository.findRequestForOwner(
      input.requestId,
      createdBy,
    );
    if (replay) {
      if (replay.turn.sequence !== 1) {
        throw new AssistantTurnConflictError(
          "The request id already belongs to a different assistant operation",
        );
      }
      assertIdempotentReplay(replay.turn, input, model, effort);
      const record = await this.getRecord(replay.thread.id, createdBy);
      const conversation = await this.materializeConversation(
        record,
        replay.turn.id,
      );
      const conversationTurn = requireConversationTurn(
        conversation,
        replay.turn.id,
      );
      return {
        created: false,
        enqueueRequired: isNonterminalTurnStatus(conversationTurn.status),
        thread: this.toThreadView(conversation),
        turn: this.toTurnView(conversationTurn),
      };
    }

    this.assertProviderConfigured(model);
    const persisted = await this.repository.createThreadWithTurn({
      createdBy,
      requestId: input.requestId,
      title: titleFromContent(input.content),
      model,
      effort,
      content: input.content,
    });
    if (!persisted.created && persisted.turn.sequence !== 1) {
      throw new AssistantTurnConflictError(
        "The request id already belongs to a different assistant operation",
      );
    }
    assertIdempotentReplay(persisted.turn, input, model, effort);

    const record = await this.getRecord(persisted.thread.id, createdBy);
    const conversation = await this.materializeConversation(
      record,
      persisted.turn.id,
    );
    const conversationTurn = requireConversationTurn(
      conversation,
      persisted.turn.id,
    );
    return {
      created: persisted.created,
      enqueueRequired: isNonterminalTurnStatus(conversationTurn.status),
      thread: this.toThreadView(conversation),
      turn: this.toTurnView(conversationTurn),
    };
  }

  async appendTurn(
    threadId: string,
    input: CreateAssistantTurnInput,
    createdBy: string,
  ): Promise<AssistantTurnCreation> {
    const model = input.model ?? DEFAULT_ASSISTANT_MODEL;
    const effort = input.effort ?? DEFAULT_ASSISTANT_REASONING_EFFORT;
    try {
      const replay = await this.repository.findRequestForOwner(
        input.requestId,
        createdBy,
      );
      if (replay) {
        if (replay.thread.id !== threadId || replay.turn.sequence === 1) {
          throw new AssistantTurnConflictError(
            "The request id already belongs to a different assistant operation",
          );
        }
        assertIdempotentReplay(replay.turn, input, model, effort);
        const record = await this.getRecord(threadId, createdBy);
        const conversation = await this.materializeConversation(
          record,
          replay.turn.id,
        );
        const conversationTurn = requireConversationTurn(
          conversation,
          replay.turn.id,
        );
        return {
          created: false,
          enqueueRequired: isNonterminalTurnStatus(conversationTurn.status),
          turn: this.toTurnView(conversationTurn),
        };
      }

      const conversation = await this.getConversation(threadId, createdBy);
      if (conversation.turns.length >= CONVERSATION_THREAD_MAX_TURNS) {
        throw new AssistantTurnConflictError(
          `Assistant threads support at most ${CONVERSATION_THREAD_MAX_TURNS} turns`,
        );
      }
      this.assertProviderConfigured(model);
      const persisted = await this.repository.appendTurn({
        threadId,
        createdBy,
        requestId: input.requestId,
        model,
        effort,
        content: input.content,
        maximumTurns: CONVERSATION_THREAD_MAX_TURNS,
      });
      if (!persisted) {
        throw new AssistantThreadNotFoundError(threadId);
      }
      assertIdempotentReplay(persisted.turn, input, model, effort);
      const record = await this.getRecord(threadId, createdBy);
      const materialized = await this.materializeConversation(
        record,
        persisted.turn.id,
      );
      const conversationTurn = requireConversationTurn(
        materialized,
        persisted.turn.id,
      );
      return {
        created: persisted.created,
        enqueueRequired: isNonterminalTurnStatus(conversationTurn.status),
        turn: this.toTurnView(conversationTurn),
      };
    } catch (error) {
      if (
        error instanceof AssistantActiveTurnPersistenceError ||
        error instanceof AssistantRequestReplayPersistenceError ||
        error instanceof AssistantThreadCapacityPersistenceError
      ) {
        throw new AssistantTurnConflictError(error.message);
      }
      throw error;
    }
  }

  async list(createdBy: string): Promise<AssistantThreadListView> {
    const inventories =
      await this.repository.listThreadTurnInventoriesForOwner(createdBy);
    let conversations =
      await this.conversations.listAssistantThreadsForOwner(createdBy);
    const existingById = new Map(
      conversations.map((conversation) => [conversation._id, conversation]),
    );
    let materialized = false;
    for (const inventory of inventories) {
      const existing = existingById.get(inventory.thread.id);
      if (
        existing &&
        inventory.turnIds.every((turnId) =>
          existing.turns.some((candidate) => candidate.id === turnId),
        )
      ) {
        continue;
      }
      const record = await this.getRecord(
        inventory.thread.id,
        inventory.thread.createdBy,
      );
      await this.synchronizeConversation(record);
      materialized = true;
    }
    if (materialized) {
      conversations =
        await this.conversations.listAssistantThreadsForOwner(createdBy);
    }

    const items: AssistantThreadListView["items"] = [];
    for (const conversation of conversations) {
      const last = conversation.turns.at(-1);
      if (!last) {
        throw new Error("Assistant thread has no turns");
      }
      const model = assistantModelSchema.parse(last.model);
      items.push({
        id: conversation._id,
        title: conversation.title,
        lastModel: model,
        lastStatus: last.status,
        createdAt: conversation.createdAt.toISOString(),
        updatedAt: conversation.updatedAt.toISOString(),
      });
    }

    return { items };
  }

  async getThread(id: string, createdBy: string): Promise<AssistantThreadView> {
    const conversation = await this.getConversation(id, createdBy);
    return this.toThreadView(conversation);
  }

  async getTurn(
    threadId: string,
    turnId: string,
    createdBy: string,
  ): Promise<AssistantTurnView> {
    const conversation = await this.getConversation(threadId, createdBy);
    const turn = conversation.turns.find(
      (candidate) => candidate.id === turnId,
    );
    if (!turn) {
      throw new AssistantTurnNotFoundError(turnId);
    }
    return this.toTurnView(turn);
  }

  async retryTurn(
    threadId: string,
    turnId: string,
    createdBy: string,
  ): Promise<AssistantTurnView> {
    const conversation = await this.getConversation(threadId, createdBy);
    const conversationTurn = conversation.turns.find(
      (candidate) => candidate.id === turnId,
    );
    if (!conversationTurn) {
      throw new AssistantTurnNotFoundError(turnId);
    }
    const { model } = requireAssistantTurnMetadata(conversationTurn);
    this.assertProviderConfigured(model);

    const current = await this.repository.findTurnForOwner(
      threadId,
      turnId,
      createdBy,
    );
    if (!current) {
      throw new AssistantTurnNotFoundError(turnId);
    }
    if (
      current.model !== model ||
      current.effort !== conversationTurn.reasoningEffort ||
      current.sequence !== conversationTurn.sequence
    ) {
      throw new Error(
        "Assistant execution projection does not match its MongoDB turn",
      );
    }
    if (!(
      (current.status === "failed" &&
        ((conversationTurn.status === "failed" &&
          current.attempt === conversationTurn.attempt) ||
          (conversationTurn.status === "queued" &&
            current.attempt + 1 === conversationTurn.attempt))) ||
      (current.status === "queued" &&
        ((conversationTurn.status === "failed" &&
          current.attempt === conversationTurn.attempt + 1) ||
          (conversationTurn.status === "queued" &&
            current.attempt === conversationTurn.attempt)))
    )) {
      throw new AssistantTurnConflictError("Only a failed turn can be retried");
    }

    const turn =
      current.status === "failed"
        ? await this.repository.retryFailedTurn({
            threadId,
            turnId,
            createdBy,
          })
        : current;
    if (!turn) {
      throw new AssistantTurnConflictError(
        "Only the latest failed turn can be retried",
      );
    }

    const prepared = await this.conversations.prepareTurnRetry({
      threadId,
      ownerId: createdBy,
      turnId,
      attempt: turn.attempt,
    });
    if (!prepared) {
      throw new AssistantTurnConflictError(
        "The assistant turn changed while its retry was prepared",
      );
    }
    const updatedConversation = await this.requireConversation(
      threadId,
      createdBy,
    );
    return this.toTurnView(
      requireConversationTurn(updatedConversation, turn.id),
    );
  }

  async start(
    turnId: string,
    attempt: number,
  ): Promise<AssistantTurnExecution> {
    const current = await this.getTurnRow(turnId);
    if (
      current.attempt !== attempt ||
      current.status === "succeeded" ||
      current.status === "failed"
    ) {
      return { turn: current, messages: [] };
    }

    const record = await this.getRecord(current.threadId, current.createdBy);
    let conversation = await this.materializeConversation(record, current.id);
    const persistedTurn = requireConversationTurn(conversation, current.id);
    if (
      persistedTurn.attempt !== attempt ||
      persistedTurn.status === "succeeded" ||
      persistedTurn.status === "failed"
    ) {
      await this.repairProjectionFromTerminalTurn(current, persistedTurn);
      return { turn: await this.getTurnRow(turnId), messages: [] };
    }

    const running = await this.repository.markRunning(turnId, attempt);
    const turn = running ?? (await this.getTurnRow(turnId));
    if (turn.attempt !== attempt || turn.status !== "running") {
      return { turn, messages: [] };
    }

    const startedAt = turn.startedAt ?? new Date();
    const markedRunning = await this.conversations.markTurnRunning({
      threadId: turn.threadId,
      ownerId: turn.createdBy,
      turnId: turn.id,
      attempt,
      startedAt,
    });
    conversation = await this.requireConversation(
      turn.threadId,
      turn.createdBy,
    );
    if (!markedRunning) {
      await this.repairProjectionFromTerminalTurn(
        turn,
        requireConversationTurn(conversation, turn.id),
      );
      return { turn: await this.getTurnRow(turnId), messages: [] };
    }

    const messages: AssistantTurnExecution["messages"] = [];
    for (const item of conversation.turns) {
      if (item.sequence > turn.sequence) {
        break;
      }
      if (item.id === turn.id) {
        messages.push({ role: "user", content: item.input.content });
        continue;
      }
      if (item.status === "succeeded" && item.output) {
        messages.push({ role: "user", content: item.input.content });
        messages.push({
          role: "assistant",
          content: item.output.content,
        });
      }
    }
    return { turn, messages };
  }

  async markQueued(id: string, attempt: number): Promise<void> {
    const turn = await this.getTurnRow(id);
    if (
      turn.attempt !== attempt ||
      turn.status === "succeeded" ||
      turn.status === "failed"
    ) {
      return;
    }
    const updated = await this.conversations.markTurnQueued({
      threadId: turn.threadId,
      ownerId: turn.createdBy,
      turnId: turn.id,
      attempt,
    });
    if (!updated) {
      const conversation = await this.requireConversation(
        turn.threadId,
        turn.createdBy,
      );
      await this.repairProjectionFromTerminalTurn(
        turn,
        requireConversationTurn(conversation, turn.id),
      );
      return;
    }
    await this.repository.markQueued(id, attempt);
  }

  async markSucceeded(
    id: string,
    attempt: number,
    response: string,
  ): Promise<void> {
    const turn = await this.getTurnRow(id);
    if (
      turn.attempt !== attempt ||
      turn.status === "succeeded" ||
      turn.status === "failed"
    ) {
      return;
    }
    const completedAt = new Date();
    let updated: boolean;
    try {
      updated = await this.conversations.markTurnSucceeded({
        threadId: turn.threadId,
        ownerId: turn.createdBy,
        turnId: turn.id,
        attempt,
        response,
        completedAt,
      });
    } catch (error) {
      if (
        !(error instanceof ConversationTerminalResultConflictError) ||
        !(await this.repairProjectionFromCurrentTerminalTurn(turn))
      ) {
        throw error;
      }
      return;
    }
    if (!updated) {
      await this.repairProjectionFromCurrentTerminalTurn(turn);
      return;
    }
    await this.repository.markSucceeded(id, attempt, response);
  }

  async markFailed(
    id: string,
    attempt: number,
    code: AssistantFailureCode,
    message: string,
  ): Promise<boolean> {
    const turn = await this.getTurnRow(id);
    if (
      turn.attempt !== attempt ||
      turn.status === "succeeded" ||
      turn.status === "failed"
    ) {
      return false;
    }
    const record = await this.getRecord(turn.threadId, turn.createdBy);
    const conversation = await this.materializeConversation(record, turn.id);
    const conversationTurn = requireConversationTurn(conversation, turn.id);
    if (
      conversationTurn.attempt === turn.attempt &&
      isTerminalTurnStatus(conversationTurn.status)
    ) {
      await this.repairProjectionFromTerminalTurn(turn, conversationTurn);
      return false;
    }
    const completedAt = new Date();
    let updated: boolean;
    try {
      updated = await this.conversations.markTurnFailed({
        threadId: turn.threadId,
        ownerId: turn.createdBy,
        turnId: turn.id,
        attempt,
        code,
        message,
        completedAt,
      });
    } catch (error) {
      if (
        !(error instanceof ConversationTerminalResultConflictError) ||
        !(await this.repairProjectionFromCurrentTerminalTurn(turn))
      ) {
        throw error;
      }
      return false;
    }
    if (!updated) {
      await this.repairProjectionFromCurrentTerminalTurn(turn);
      return false;
    }
    return this.repository.markFailed(id, attempt, code, message);
  }

  findStaleNonterminalTurns(
    staleBefore: Date,
    limit = 100,
  ): Promise<AssistantTurnRow[]> {
    return this.repository.findStaleNonterminalTurns(staleBefore, limit);
  }

  private async getRecord(
    id: string,
    createdBy: string,
  ): Promise<AssistantThreadRecord> {
    const record = await this.repository.findThreadRecordForOwner(
      id,
      createdBy,
    );
    if (!record) {
      throw new AssistantThreadNotFoundError(id);
    }
    return record;
  }

  private async getTurnRow(id: string): Promise<AssistantTurnRow> {
    const turn = await this.repository.findTurnById(id);
    if (!turn) {
      throw new AssistantTurnNotFoundError(id);
    }
    return turn;
  }

  private synchronizeConversation(
    record: AssistantThreadRecord,
  ): Promise<ConversationThreadDocument> {
    return this.conversations.synchronizeAssistantThread(
      toConversationSnapshot(record),
    );
  }

  private async materializeConversation(
    record: AssistantThreadRecord,
    requiredTurnId?: string,
  ): Promise<ConversationThreadDocument> {
    let current = await this.conversations.findAssistantThreadForOwner(
      record.thread.id,
      record.thread.createdBy,
    );
    if (!current) {
      return this.synchronizeConversation(record);
    }
    if (!requiredTurnId) {
      return current;
    }

    let conversationTurn = current.turns.find(
      (turn) => turn.id === requiredTurnId,
    );
    if (!conversationTurn) {
      return this.synchronizeConversation(record);
    }

    const projectionTurn = record.turns.find(
      (turn) => turn.id === requiredTurnId,
    );
    if (!projectionTurn) {
      throw new Error(
        "Assistant conversation turn is missing from its execution projection",
      );
    }
    assertConversationProjectionIdentity(projectionTurn, conversationTurn);

    if (
      isNonterminalTurnStatus(projectionTurn.status) &&
      conversationTurn.status === "failed" &&
      projectionTurn.attempt === conversationTurn.attempt + 1
    ) {
      await this.conversations.prepareTurnRetry({
        threadId: record.thread.id,
        ownerId: record.thread.createdBy,
        turnId: requiredTurnId,
        attempt: projectionTurn.attempt,
      });
      current = await this.requireConversation(
        record.thread.id,
        record.thread.createdBy,
      );
      conversationTurn = requireConversationTurn(current, requiredTurnId);
      assertConversationProjectionIdentity(projectionTurn, conversationTurn);
    }

    if (conversationTurn.attempt !== projectionTurn.attempt) {
      throw new Error(
        "Assistant conversation attempt does not match its execution projection",
      );
    }
    if (
      isNonterminalTurnStatus(projectionTurn.status) &&
      isTerminalTurnStatus(conversationTurn.status)
    ) {
      await this.repairProjectionFromTerminalTurn(
        projectionTurn,
        conversationTurn,
      );
    }

    return current;
  }

  private async getConversation(
    id: string,
    ownerId: string,
  ): Promise<ConversationThreadDocument> {
    const conversation = await this.conversations.findAssistantThreadForOwner(
      id,
      ownerId,
    );
    if (conversation) {
      return conversation;
    }

    const record = await this.getRecord(id, ownerId);
    return this.synchronizeConversation(record);
  }

  private async requireConversation(
    id: string,
    ownerId: string,
  ): Promise<ConversationThreadDocument> {
    const conversation = await this.conversations.findAssistantThreadForOwner(
      id,
      ownerId,
    );
    if (!conversation) {
      throw new Error("Assistant conversation is missing from MongoDB");
    }
    return conversation;
  }

  private async repairProjectionFromTerminalTurn(
    projection: AssistantTurnRow,
    conversationTurn: ConversationTurn,
  ): Promise<void> {
    if (conversationTurn.attempt !== projection.attempt) {
      return;
    }
    if (
      conversationTurn.status === "succeeded" &&
      conversationTurn.output?.actor === "assistant"
    ) {
      await this.repository.markSucceeded(
        projection.id,
        projection.attempt,
        conversationTurn.output.content,
      );
      return;
    }
    if (conversationTurn.status === "failed" && conversationTurn.error) {
      await this.repository.markFailed(
        projection.id,
        projection.attempt,
        assistantFailureCodeSchema.parse(conversationTurn.error.code),
        conversationTurn.error.message,
      );
    }
  }

  private async repairProjectionFromCurrentTerminalTurn(
    projection: AssistantTurnRow,
  ): Promise<boolean> {
    const conversation = await this.requireConversation(
      projection.threadId,
      projection.createdBy,
    );
    const conversationTurn = requireConversationTurn(
      conversation,
      projection.id,
    );
    if (
      conversationTurn.attempt !== projection.attempt ||
      !isTerminalTurnStatus(conversationTurn.status)
    ) {
      return false;
    }
    await this.repairProjectionFromTerminalTurn(projection, conversationTurn);
    return true;
  }

  private assertProviderConfigured(model: AssistantModel): void {
    const adapter = assistantModelAdapter(model);
    const key =
      adapter.provider === "openrouter"
        ? this.config.get("OPENROUTER_API_KEY", { infer: true })
        : this.config.get("OPENAI_API_KEY", { infer: true });
    if (!key) {
      throw new AssistantProviderUnavailableError();
    }
  }

  private toThreadView(
    conversation: ConversationThreadDocument,
  ): AssistantThreadView {
    return {
      id: conversation._id,
      title: conversation.title,
      createdAt: conversation.createdAt.toISOString(),
      updatedAt: conversation.updatedAt.toISOString(),
      turns: conversation.turns.map((turn) => this.toTurnView(turn)),
    };
  }

  private toTurnView(turn: ConversationTurn): AssistantTurnView {
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
}

function toConversationSnapshot(
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

function requireConversationTurn(
  conversation: ConversationThreadDocument,
  id: string,
): ConversationTurn {
  const turn = conversation.turns.find((candidate) => candidate.id === id);
  if (!turn) {
    throw new Error("Assistant turn is missing from MongoDB conversation");
  }
  return turn;
}

function requireAssistantTurnMetadata(turn: ConversationTurn): {
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

function titleFromContent(content: string): string {
  const oneLine = content.replace(/\s+/gu, " ").trim();
  return oneLine.length <= 80
    ? oneLine
    : `${oneLine.slice(0, 77).trimEnd()}...`;
}

function assertIdempotentReplay(
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

function assertConversationProjectionIdentity(
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

function isNonterminalTurnStatus(value: string): boolean {
  return value === "queued" || value === "running";
}

function isTerminalTurnStatus(
  value: ConversationTurn["status"],
): value is "succeeded" | "failed" {
  return value === "succeeded" || value === "failed";
}
