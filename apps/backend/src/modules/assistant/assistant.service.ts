import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { AssistantTurnRow } from "@slopform/database";

import type { Environment } from "../../infrastructure/config/environment.js";
import {
  ConversationTerminalResultConflictError,
  ConversationThreadRepository,
} from "../conversations/conversation-thread.repository.js";
import {
  CONVERSATION_THREAD_MAX_TURNS,
  type ConversationThreadDocument,
  type ConversationTurn,
} from "../conversations/conversation-thread.schemas.js";
import {
  assistantModelAdapter,
  assistantModelSupportsServiceTier,
} from "./assistant-models.js";
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
  DEFAULT_ASSISTANT_SERVICE_TIER,
  assistantFailureCodeSchema,
  assistantModelSchema,
  type AssistantFailureCode,
  type AssistantModel,
  type AssistantServiceTier,
  type AssistantThreadListView,
  type AssistantThreadView,
  type AssistantToolCall,
  type AssistantTurnView,
  type AssistantUsage,
  type BranchAssistantThreadInput,
  type CreateAssistantThreadInput,
  type CreateAssistantTurnInput,
} from "./assistant.schemas.js";
import {
  assertConversationProjectionIdentity,
  assertIdempotentReplay,
  isNonterminalTurnStatus,
  isTerminalTurnStatus,
  requireAssistantTurnMetadata,
  requireConversationTurn,
  titleFromContent,
  toConversationSnapshot,
  toThreadView,
  toTurnView,
} from "./assistant-turn-view.js";

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
    const serviceTier = resolveServiceTier(model, input.serviceTier);
    const replay = await this.repository.findRequestForOwner(
      input.requestId,
      createdBy,
    );
    if (replay) {
      if (replay.turn.sequence !== 1 || isBranchTurn(replay.turn)) {
        throw new AssistantTurnConflictError(
          "The request id already belongs to a different assistant operation",
        );
      }
      assertIdempotentReplay(replay.turn, input, model, effort, serviceTier);
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
        thread: toThreadView(conversation),
        turn: toTurnView(conversationTurn),
      };
    }

    this.assertProviderConfigured(model);
    const persisted = await this.repository.createThreadWithTurn({
      createdBy,
      requestId: input.requestId,
      title: titleFromContent(input.content),
      model,
      effort,
      serviceTier,
      content: input.content,
    });
    if (
      !persisted.created &&
      (persisted.turn.sequence !== 1 || isBranchTurn(persisted.turn))
    ) {
      throw new AssistantTurnConflictError(
        "The request id already belongs to a different assistant operation",
      );
    }
    assertIdempotentReplay(persisted.turn, input, model, effort, serviceTier);

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
      thread: toThreadView(conversation),
      turn: toTurnView(conversationTurn),
    };
  }

  async branchThread(
    sourceThreadId: string,
    input: BranchAssistantThreadInput,
    createdBy: string,
  ): Promise<AssistantThreadCreation> {
    const model = input.model ?? DEFAULT_ASSISTANT_MODEL;
    const effort = input.effort ?? DEFAULT_ASSISTANT_REASONING_EFFORT;
    const serviceTier = resolveServiceTier(model, input.serviceTier);
    const replay = await this.repository.findRequestForOwner(
      input.requestId,
      createdBy,
    );
    if (replay) {
      assertBranchReplay(replay.turn, sourceThreadId, input.sourceTurnId);
      assertIdempotentReplay(replay.turn, input, model, effort, serviceTier);
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
        thread: toThreadView(conversation),
        turn: toTurnView(conversationTurn),
      };
    }

    const source = await this.getConversation(sourceThreadId, createdBy);
    const sourceTurn = source.turns.find(
      (candidate) => candidate.id === input.sourceTurnId,
    );
    if (!sourceTurn) {
      throw new AssistantTurnNotFoundError(input.sourceTurnId);
    }
    this.assertProviderConfigured(model);

    const persisted = await this.repository.createBranchedThreadWithTurn({
      createdBy,
      requestId: input.requestId,
      title: titleFromContent(input.content),
      sourceThreadId,
      sourceTurnId: sourceTurn.id,
      sequence: sourceTurn.sequence,
      model,
      effort,
      serviceTier,
      content: input.content,
    });
    assertBranchReplay(persisted.turn, sourceThreadId, input.sourceTurnId);
    assertIdempotentReplay(persisted.turn, input, model, effort, serviceTier);

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
      thread: toThreadView(conversation),
      turn: toTurnView(conversationTurn),
    };
  }

  async appendTurn(
    threadId: string,
    input: CreateAssistantTurnInput,
    createdBy: string,
  ): Promise<AssistantTurnCreation> {
    const model = input.model ?? DEFAULT_ASSISTANT_MODEL;
    const effort = input.effort ?? DEFAULT_ASSISTANT_REASONING_EFFORT;
    const serviceTier = resolveServiceTier(model, input.serviceTier);
    try {
      const replay = await this.repository.findRequestForOwner(
        input.requestId,
        createdBy,
      );
      if (replay) {
        if (
          replay.thread.id !== threadId ||
          replay.turn.sequence === 1 ||
          isBranchTurn(replay.turn)
        ) {
          throw new AssistantTurnConflictError(
            "The request id already belongs to a different assistant operation",
          );
        }
        assertIdempotentReplay(replay.turn, input, model, effort, serviceTier);
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
          turn: toTurnView(conversationTurn),
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
        serviceTier,
        content: input.content,
        maximumTurns: CONVERSATION_THREAD_MAX_TURNS,
      });
      if (!persisted) {
        throw new AssistantThreadNotFoundError(threadId);
      }
      assertIdempotentReplay(persisted.turn, input, model, effort, serviceTier);
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
        turn: toTurnView(conversationTurn),
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
    return toThreadView(conversation);
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
    return toTurnView(turn);
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
    return toTurnView(requireConversationTurn(updatedConversation, turn.id));
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

  /**
   * Records the text one attempt has streamed so far, in the read model first
   * and the execution projection second. Both writes are fenced on the same
   * attempt, and both are best-effort by design: a lost partial only costs the
   * operator a moment of live text, never the answer, so a failure here must not
   * take down a generation the queue still owns.
   */
  async recordPartial(
    id: string,
    attempt: number,
    partial: string,
    reasoning: string | null = null,
    toolCalls: readonly AssistantToolCall[] = [],
  ): Promise<void> {
    const turn = await this.getTurnRow(id);
    if (
      turn.attempt !== attempt ||
      turn.status === "succeeded" ||
      turn.status === "failed"
    ) {
      return;
    }

    const applied = await this.conversations.recordTurnPartial({
      threadId: turn.threadId,
      ownerId: turn.createdBy,
      turnId: turn.id,
      attempt,
      partial,
      reasoning,
      toolCalls,
    });
    if (!applied) {
      return;
    }

    await this.repository.recordPartial(
      id,
      attempt,
      partial,
      reasoning,
      toolCalls,
    );
  }

  async markSucceeded(
    id: string,
    attempt: number,
    result: {
      readonly content: string;
      readonly reasoning: string | null;
      readonly toolCalls: readonly AssistantToolCall[];
      readonly usage: AssistantUsage;
    },
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
        response: result.content,
        reasoning: result.reasoning,
        toolCalls: result.toolCalls,
        usage: result.usage,
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
    await this.repository.markSucceeded(id, attempt, {
      response: result.content,
      reasoning: result.reasoning,
      toolCalls: result.toolCalls,
      usage: result.usage,
    });
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

  private async synchronizeConversation(
    record: AssistantThreadRecord,
  ): Promise<ConversationThreadDocument> {
    const snapshot = toConversationSnapshot(record);
    const origin = branchOriginFromRecord(record);
    if (!origin) {
      return this.conversations.synchronizeAssistantThread(snapshot);
    }

    const source = await this.getConversation(
      origin.threadId,
      record.thread.createdBy,
    );
    const sourceTurn = source.turns.find(
      (candidate) => candidate.id === origin.turnId,
    );
    if (!sourceTurn || sourceTurn.sequence !== origin.sequence) {
      throw new Error("Assistant branch source turn is missing from MongoDB");
    }

    return this.conversations.synchronizeAssistantThread({
      ...snapshot,
      branchedFrom: origin,
      turns: [
        ...source.turns.filter(
          (candidate) => candidate.sequence < origin.sequence,
        ),
        ...snapshot.turns,
      ],
    });
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
      await this.repository.markSucceeded(projection.id, projection.attempt, {
        response: conversationTurn.output.content,
        reasoning: conversationTurn.reasoning,
        toolCalls: conversationTurn.toolCalls ?? [],
        usage: conversationTurn.usage ?? null,
      });
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
}

/**
 * The tier the turn will actually run under.
 *
 * A request may ask for the fast lane on a model that cannot sell it. Recording
 * the request rather than the reality would price that turn at double for a
 * surcharge nobody paid, so the answer is normalised here, once, before anything
 * is persisted — and the idempotency check compares against the normalised value
 * for the same reason.
 */
function resolveServiceTier(
  model: AssistantModel,
  requested: AssistantServiceTier | undefined,
): AssistantServiceTier {
  const tier = requested ?? DEFAULT_ASSISTANT_SERVICE_TIER;
  return assistantModelSupportsServiceTier(model)
    ? tier
    : DEFAULT_ASSISTANT_SERVICE_TIER;
}

function isBranchTurn(turn: AssistantTurnRow): boolean {
  return turn.branchedFromThreadId !== null || turn.branchedFromTurnId !== null;
}

function assertBranchReplay(
  turn: AssistantTurnRow,
  sourceThreadId: string,
  sourceTurnId: string,
): void {
  if (
    turn.branchedFromThreadId !== sourceThreadId ||
    turn.branchedFromTurnId !== sourceTurnId
  ) {
    throw new AssistantTurnConflictError(
      "The request id already belongs to a different assistant operation",
    );
  }
}

function branchOriginFromRecord(record: AssistantThreadRecord): {
  readonly threadId: string;
  readonly turnId: string;
  readonly sequence: number;
} | null {
  const branchTurns = record.turns.filter(isBranchTurn);
  if (branchTurns.length === 0) return null;
  if (branchTurns.length !== 1) {
    throw new Error("Assistant thread has invalid branch lineage");
  }

  const [turn] = branchTurns;
  if (!turn?.branchedFromThreadId || !turn.branchedFromTurnId) {
    throw new Error("Assistant branch lineage is incomplete");
  }
  return {
    threadId: turn.branchedFromThreadId,
    turnId: turn.branchedFromTurnId,
    sequence: turn.sequence,
  };
}
