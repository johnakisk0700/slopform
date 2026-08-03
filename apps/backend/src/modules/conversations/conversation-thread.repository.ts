import { Injectable } from "@nestjs/common";
import {
  type Collection,
  type Filter,
  MongoServerError,
  type UpdateFilter,
} from "mongodb";
import { z } from "zod";

import { MongoService } from "../../infrastructure/mongo/mongo.service.js";
import { ConversationPersistenceError } from "./conversation-persistence.errors.js";
import {
  CONVERSATION_THREAD_COLLECTION,
  CONVERSATION_THREAD_MAX_TURNS,
  CONVERSATION_THREAD_SCHEMA_VERSION,
  type ConversationThreadDocument,
  type ConversationTurn,
  conversationMessageSchema,
  conversationThreadDocumentSchema,
  conversationTurnErrorSchema,
  conversationTurnSchema,
  conversationTurnToolCallSchema,
  conversationTurnUsageSchema,
} from "./conversation-thread.schemas.js";

const assistantConversationSummarySchema = z
  .object({
    _id: z.uuid(),
    title: z.string().trim().min(1).max(160),
    turns: z
      .array(
        z
          .object({
            id: z.uuid(),
            sequence: z.number().int().positive(),
            status: z.enum(["queued", "running", "succeeded", "failed"]),
            model: z.string().trim().min(1).max(200).nullable(),
          })
          .strict(),
      )
      .max(CONVERSATION_THREAD_MAX_TURNS),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .strict()
  .superRefine((summary, context) => {
    for (const [index, turn] of summary.turns.entries()) {
      if (turn.sequence !== index + 1) {
        context.addIssue({
          code: "custom",
          message: "Assistant conversation summary has invalid turn order",
        });
        break;
      }
    }
  });

export type AssistantConversationSummary = z.infer<
  typeof assistantConversationSummarySchema
>;

export interface AssistantConversationSnapshot {
  readonly id: string;
  readonly ownerId: string;
  readonly title: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly branchedFrom?: {
    readonly threadId: string;
    readonly turnId: string;
    readonly sequence: number;
  } | null;
  readonly turns: readonly ConversationTurn[];
}

export class ConversationTerminalResultConflictError extends ConversationPersistenceError {
  constructor() {
    super("A conversation attempt already has a different terminal result");
    this.name = ConversationTerminalResultConflictError.name;
  }
}

@Injectable()
export class ConversationThreadRepository {
  private collectionPromise:
    Promise<Collection<ConversationThreadDocument>> | undefined;

  constructor(private readonly mongo: MongoService) {}

  async ping(): Promise<void> {
    await this.mongo.ping();
  }

  async createThread(
    document: ConversationThreadDocument,
  ): Promise<ConversationThreadDocument> {
    const parsed = conversationThreadDocumentSchema.parse(document);
    const collection = await this.collection();

    try {
      await collection.insertOne(parsed);
      return parsed;
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }
    }

    const existing = await collection.findOne({ _id: parsed._id });
    if (!existing) {
      throw new ConversationPersistenceError(
        "Conversation thread duplicate could not be resolved",
      );
    }
    const validated = conversationThreadDocumentSchema.parse(existing);
    assertThreadIdentity(validated, parsed);
    return validated;
  }

  async synchronizeAssistantThread(
    snapshot: AssistantConversationSnapshot,
  ): Promise<ConversationThreadDocument> {
    const seed = conversationThreadDocumentSchema.parse({
      _id: snapshot.id,
      schemaVersion: CONVERSATION_THREAD_SCHEMA_VERSION,
      purpose: "admin_assistant",
      channel: "admin",
      owner: { type: "staff", id: snapshot.ownerId },
      title: snapshot.title,
      state: "active",
      goals: [],
      humanTakeover: {
        status: "inactive",
        requestedAt: null,
        resolvedAt: null,
      },
      branchedFrom: snapshot.branchedFrom ?? null,
      turns: [...snapshot.turns],
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
    });
    const collection = await this.collection();

    try {
      await collection.insertOne(seed);
      return seed;
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }
    }

    const identity = assistantThreadFilter(snapshot.id, snapshot.ownerId);
    const current = await collection.findOne(identity);
    if (!current) {
      throw new ConversationPersistenceError(
        "Assistant conversation thread identity does not match PostgreSQL",
      );
    }

    const validatedCurrent = conversationThreadDocumentSchema.parse(current);
    const turnsById = new Map(
      validatedCurrent.turns.map((turn) => [turn.id, turn]),
    );
    const turnsBySequence = new Map(
      validatedCurrent.turns.map((turn) => [turn.sequence, turn]),
    );
    const missingTurns: ConversationTurn[] = [];

    for (const turn of seed.turns) {
      const existingTurn = turnsById.get(turn.id);
      if (existingTurn) {
        assertTurnIdentity(existingTurn, turn);
        continue;
      }
      if (turnsBySequence.has(turn.sequence)) {
        throw new ConversationPersistenceError(
          "Assistant conversation sequence belongs to a different turn",
        );
      }
      missingTurns.push(turn);
    }

    for (const turn of missingTurns) {
      await collection.updateOne(
        {
          ...identity,
          "turns.id": { $ne: turn.id },
          "turns.sequence": { $ne: turn.sequence },
        },
        {
          $push: { turns: turn },
          $max: { updatedAt: snapshot.updatedAt },
        },
      );
    }

    const synchronized = await collection.findOne(identity);
    if (!synchronized) {
      throw new ConversationPersistenceError(
        "Assistant conversation thread disappeared during synchronization",
      );
    }
    const validated = conversationThreadDocumentSchema.parse(synchronized);
    for (const turn of seed.turns) {
      const existingTurn = validated.turns.find(
        (candidate) => candidate.id === turn.id,
      );
      if (!existingTurn) {
        throw new ConversationPersistenceError(
          "Assistant conversation turn could not be synchronized",
        );
      }
      assertTurnIdentity(existingTurn, turn);
    }
    return validated;
  }

  async findAssistantThreadForOwner(
    id: string,
    ownerId: string,
  ): Promise<ConversationThreadDocument | undefined> {
    const collection = await this.collection();
    const document = await collection.findOne(
      assistantThreadFilter(id, ownerId),
    );
    return document
      ? conversationThreadDocumentSchema.parse(document)
      : undefined;
  }

  async listAssistantThreadsForOwner(
    ownerId: string,
    limit = 50,
  ): Promise<AssistantConversationSummary[]> {
    const collection = await this.collection();
    const documents = await collection
      .find(
        {
          purpose: "admin_assistant",
          channel: "admin",
          "owner.type": "staff",
          "owner.id": ownerId,
        },
        {
          projection: {
            _id: 1,
            title: 1,
            "turns.id": 1,
            "turns.sequence": 1,
            "turns.status": 1,
            "turns.model": 1,
            createdAt: 1,
            updatedAt: 1,
          },
        },
      )
      .sort({ updatedAt: -1 })
      .limit(limit)
      .toArray();
    return documents.map((document) =>
      assistantConversationSummarySchema.parse(document),
    );
  }

  async markTurnRunning(
    input: TurnIdentity & { readonly startedAt: Date },
  ): Promise<boolean> {
    const startedAt = z.date().parse(input.startedAt);
    return this.transitionTurn(
      input,
      input.attempt,
      ["queued", "running"],
      {
        "turns.$[turn].status": "running",
        "turns.$[turn].attempt": input.attempt,
        "turns.$[turn].startedAt": startedAt,
        "turns.$[turn].completedAt": null,
        "turns.$[turn].output": null,
        "turns.$[turn].partial": null,
        "turns.$[turn].reasoning": null,
        "turns.$[turn].toolCalls": [],
        "turns.$[turn].usage": null,
        "turns.$[turn].error": null,
      },
      startedAt,
    );
  }

  markTurnQueued(input: TurnIdentity): Promise<boolean> {
    return this.transitionTurn(
      input,
      input.attempt,
      ["queued", "running"],
      {
        "turns.$[turn].status": "queued",
        "turns.$[turn].attempt": input.attempt,
        "turns.$[turn].completedAt": null,
        "turns.$[turn].output": null,
        "turns.$[turn].partial": null,
        "turns.$[turn].reasoning": null,
        "turns.$[turn].toolCalls": [],
        "turns.$[turn].usage": null,
        "turns.$[turn].error": null,
      },
      new Date(),
    );
  }

  /**
   * Records the text one attempt has streamed so far. Shares the transition
   * fence, so a delta from a superseded attempt — or one that lands after the
   * turn settled — is dropped instead of overwriting the read model.
   */
  recordTurnPartial(
    input: TurnIdentity & {
      readonly partial: string;
      readonly reasoning: string | null;
      readonly toolCalls: readonly z.infer<
        typeof conversationTurnToolCallSchema
      >[];
    },
  ): Promise<boolean> {
    const partial = z.string().min(1).max(20_000).parse(input.partial);
    const toolCalls = z
      .array(conversationTurnToolCallSchema)
      .max(20)
      .parse(input.toolCalls);
    return this.transitionTurn(
      input,
      input.attempt,
      ["queued", "running"],
      {
        "turns.$[turn].partial": partial,
        ...(input.reasoning === null
          ? {}
          : {
              "turns.$[turn].reasoning": z
                .string()
                .max(20_000)
                .parse(input.reasoning),
            }),
        "turns.$[turn].toolCalls": toolCalls,
      },
      new Date(),
    );
  }

  async markTurnSucceeded(
    input: TurnIdentity & {
      readonly response: string;
      readonly reasoning?: string | null;
      readonly toolCalls?: readonly z.infer<
        typeof conversationTurnToolCallSchema
      >[];
      readonly usage?: z.infer<typeof conversationTurnUsageSchema> | null;
      readonly completedAt: Date;
    },
  ): Promise<boolean> {
    const output = conversationMessageSchema.parse({
      actor: "assistant",
      content: input.response,
    });
    const completedAt = z.date().parse(input.completedAt);
    const reasoning = z
      .string()
      .max(20_000)
      .nullable()
      .parse(input.reasoning ?? null);
    const toolCalls = z
      .array(conversationTurnToolCallSchema)
      .max(20)
      .parse(input.toolCalls ?? []);
    const usage = conversationTurnUsageSchema
      .nullable()
      .parse(input.usage ?? null);
    return this.transitionTerminalTurn(
      input,
      "succeeded",
      {
        "turns.$[turn].status": "succeeded",
        "turns.$[turn].attempt": input.attempt,
        "turns.$[turn].output": output,
        "turns.$[turn].partial": null,
        "turns.$[turn].reasoning": reasoning,
        "turns.$[turn].toolCalls": toolCalls,
        "turns.$[turn].usage": usage,
        "turns.$[turn].error": null,
        "turns.$[turn].completedAt": completedAt,
      },
      completedAt,
      (turn) =>
        turn.output?.actor === "assistant" &&
        turn.output.content === output.content,
    );
  }

  async markTurnFailed(
    input: TurnIdentity & {
      readonly code: string;
      readonly message: string;
      readonly completedAt: Date;
    },
  ): Promise<boolean> {
    const error = conversationTurnErrorSchema.parse({
      code: input.code,
      message: input.message,
    });
    const completedAt = z.date().parse(input.completedAt);
    return this.transitionTerminalTurn(
      input,
      "failed",
      {
        "turns.$[turn].status": "failed",
        "turns.$[turn].attempt": input.attempt,
        "turns.$[turn].output": null,
        "turns.$[turn].partial": null,
        "turns.$[turn].usage": null,
        "turns.$[turn].error": error,
        "turns.$[turn].completedAt": completedAt,
      },
      completedAt,
      (turn) =>
        turn.error?.code === error.code && turn.error.message === error.message,
    );
  }

  async prepareTurnRetry(input: TurnIdentity): Promise<boolean> {
    const transitioned = await this.transitionTurn(
      input,
      input.attempt - 1,
      ["failed"],
      {
        "turns.$[turn].status": "queued",
        "turns.$[turn].attempt": input.attempt,
        "turns.$[turn].startedAt": null,
        "turns.$[turn].completedAt": null,
        "turns.$[turn].output": null,
        "turns.$[turn].partial": null,
        "turns.$[turn].reasoning": null,
        "turns.$[turn].toolCalls": [],
        "turns.$[turn].usage": null,
        "turns.$[turn].error": null,
      },
      new Date(),
    );
    if (transitioned) {
      return true;
    }

    const current = await this.requireTurn(input);
    return current.status === "queued" && current.attempt === input.attempt;
  }

  private async transitionTurn(
    input: TurnIdentity,
    expectedAttempt: number,
    allowedStatuses: readonly ConversationTurn["status"][],
    set: Record<string, unknown>,
    updatedAt: Date,
  ): Promise<boolean> {
    const collection = await this.collection();
    const filter = assistantThreadFilter(input.threadId, input.ownerId);
    const update = {
      $set: set,
      $max: { updatedAt },
    } as UpdateFilter<ConversationThreadDocument>;
    const result = await collection.updateOne(
      {
        ...filter,
        turns: {
          $elemMatch: {
            id: input.turnId,
            attempt: expectedAttempt,
            status: { $in: [...allowedStatuses] },
          },
        },
      },
      update,
      {
        arrayFilters: [
          {
            "turn.id": input.turnId,
            "turn.attempt": expectedAttempt,
            "turn.status": { $in: [...allowedStatuses] },
          },
        ],
      },
    );
    if (result.matchedCount > 0) {
      return true;
    }

    await this.requireTurn(input);
    return false;
  }

  private async transitionTerminalTurn(
    input: TurnIdentity,
    terminalStatus: "succeeded" | "failed",
    set: Record<string, unknown>,
    updatedAt: Date,
    matchesTerminalValue: (turn: ConversationTurn) => boolean,
  ): Promise<boolean> {
    const transitioned = await this.transitionTurn(
      input,
      input.attempt,
      ["queued", "running"],
      set,
      updatedAt,
    );
    if (transitioned) {
      return true;
    }

    const current = await this.requireTurn(input);
    if (
      current.attempt !== input.attempt ||
      current.status !== terminalStatus
    ) {
      return false;
    }
    if (!matchesTerminalValue(current)) {
      throw new ConversationTerminalResultConflictError();
    }
    return true;
  }

  private async requireTurn(input: TurnIdentity): Promise<ConversationTurn> {
    const collection = await this.collection();
    const existing = await collection.findOne(
      {
        ...assistantThreadFilter(input.threadId, input.ownerId),
        "turns.id": input.turnId,
      },
      { projection: { turns: { $elemMatch: { id: input.turnId } } } },
    );
    const turn = existing?.turns[0];
    if (!turn) {
      throw new ConversationPersistenceError(
        "Conversation turn was not found for its owner",
      );
    }
    return conversationTurnSchema.parse(turn);
  }

  private collection(): Promise<Collection<ConversationThreadDocument>> {
    if (!this.collectionPromise) {
      const pending = this.prepareCollection().catch((error: unknown) => {
        if (this.collectionPromise === pending) {
          this.collectionPromise = undefined;
        }
        throw error;
      });
      this.collectionPromise = pending;
    }
    return this.collectionPromise;
  }

  private async prepareCollection(): Promise<
    Collection<ConversationThreadDocument>
  > {
    const collection = await this.mongo.collection<ConversationThreadDocument>(
      CONVERSATION_THREAD_COLLECTION,
    );
    await collection.createIndexes([
      {
        name: "conversation_owner_purpose_updated_idx",
        key: {
          "owner.type": 1,
          "owner.id": 1,
          purpose: 1,
          updatedAt: -1,
        },
      },
      {
        name: "conversation_purpose_state_updated_idx",
        key: { purpose: 1, state: 1, updatedAt: 1 },
      },
    ]);
    return collection;
  }
}

interface TurnIdentity {
  readonly threadId: string;
  readonly ownerId: string;
  readonly turnId: string;
  readonly attempt: number;
}

function assistantThreadFilter(
  id: string,
  ownerId: string,
): Filter<ConversationThreadDocument> {
  return {
    _id: id,
    purpose: "admin_assistant",
    channel: "admin",
    "owner.type": "staff",
    "owner.id": ownerId,
  };
}

function isDuplicateKeyError(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === 11_000;
}

function assertThreadIdentity(
  existing: ConversationThreadDocument,
  expected: ConversationThreadDocument,
): void {
  if (
    existing.purpose !== expected.purpose ||
    existing.channel !== expected.channel ||
    existing.owner.type !== expected.owner.type ||
    existing.owner.id !== expected.owner.id ||
    !sameBranchOrigin(existing.branchedFrom, expected.branchedFrom)
  ) {
    throw new ConversationPersistenceError(
      "Conversation thread id belongs to a different owner or purpose",
    );
  }
}

function sameBranchOrigin(
  left: ConversationThreadDocument["branchedFrom"],
  right: ConversationThreadDocument["branchedFrom"],
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.threadId === right.threadId &&
    left.turnId === right.turnId &&
    left.sequence === right.sequence
  );
}

function assertTurnIdentity(
  existing: ConversationTurn,
  expected: ConversationTurn,
): void {
  if (
    existing.requestId !== expected.requestId ||
    existing.sequence !== expected.sequence ||
    existing.input.actor !== expected.input.actor ||
    existing.input.content !== expected.input.content ||
    existing.model !== expected.model ||
    existing.reasoningEffort !== expected.reasoningEffort
  ) {
    throw new ConversationPersistenceError(
      "Conversation turn id was replayed with different content",
    );
  }
}
