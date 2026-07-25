import { randomUUID } from "node:crypto";

import { Injectable } from "@nestjs/common";
import {
  BSON,
  type Collection,
  type Filter,
  MongoServerError,
  type UpdateFilter,
} from "mongodb";
import { z } from "zod";

import { MongoService } from "../../infrastructure/mongo/mongo.service.js";
import { ConversationPersistenceError } from "./conversation-persistence.errors.js";
import { CONVERSATION_THREAD_COLLECTION } from "./conversation-thread.schemas.js";
import {
  FEEDBACK_CONVERSATION_CHANNEL,
  FEEDBACK_CONVERSATION_MAX_DOCUMENT_BYTES,
  FEEDBACK_CONVERSATION_MAX_MESSAGES,
  FEEDBACK_CONVERSATION_PURPOSE,
  FEEDBACK_CONVERSATION_SCHEMA_VERSION,
  type FeedbackConversationActor,
  type FeedbackConversationControlSource,
  type FeedbackConversationDocument,
  type FeedbackConversationGoal,
  type FeedbackConversationLifecycleReason,
  type FeedbackConversationMessage,
  buildFeedbackConversationGoals,
  deriveFeedbackConversationId,
  feedbackConversationDocumentSchema,
  feedbackConversationMessageSchema,
} from "./feedback-conversation.schemas.js";

const FEEDBACK_CONVERSATION_APPEND_ATTEMPTS = 3;

const feedbackConversationSummarySchema = z
  .object({
    _id: z.uuid(),
    campaignId: z.uuid(),
    respondentParticipantId: z.uuid(),
    phoneAtLaunch: z.string().trim().min(1),
    lifecycle: z
      .object({
        state: z.enum(["open", "closed"]),
        reason: z
          .enum(["completed", "stopped", "expired", "cancelled"])
          .nullable(),
      })
      .strict(),
    control: z
      .object({
        mode: z.enum(["bot", "human"]),
        source: z.enum(["launch", "staff_action", "external_outbound"]),
      })
      .strict(),
    goals: z.array(
      z
        .object({
          key: z.string().trim().min(1),
          ordinal: z.number().int().positive(),
          status: z.enum(["pending", "asked", "answered", "skipped"]),
        })
        .strict(),
    ),
    messageCount: z.number().int().min(0),
    lastMessageAt: z.date().nullable(),
    lastMessageActor: z
      .enum(["bot", "participant", "staff", "system"])
      .nullable(),
    cursorSeq: z.number().int().min(0),
    needsAttention: z.boolean(),
    remindedAt: z.date().nullable(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .strict();

export type FeedbackConversationSummary = z.infer<
  typeof feedbackConversationSummarySchema
>;

export interface FeedbackConversationLaunchInput {
  readonly campaignId: string;
  readonly respondentParticipantId: string;
  readonly phoneAtLaunch: string;
  readonly launchedAt: Date;
  readonly goals?: readonly FeedbackConversationGoal[];
}

export interface FeedbackConversationCreationResult {
  readonly created: boolean;
  readonly conversation: FeedbackConversationDocument;
}

export interface FeedbackConversationTransitionResult {
  readonly changed: boolean;
  readonly conversation: FeedbackConversationDocument;
}

export interface AppendFeedbackConversationMessageInput {
  readonly conversationId: string;
  readonly actor: FeedbackConversationActor;
  readonly text: string;
  readonly at: Date;
  readonly id?: string;
  readonly providerMessageId?: string | null;
  readonly ingressId?: string | null;
  readonly outboxId?: string | null;
}

export interface FeedbackConversationAppendResult {
  readonly appended: boolean;
  readonly message: FeedbackConversationMessage;
  readonly conversation: FeedbackConversationDocument;
}

export class FeedbackConversationNotFoundError extends ConversationPersistenceError {
  constructor(id: string) {
    super(`Feedback conversation ${id} was not found`);
    this.name = FeedbackConversationNotFoundError.name;
  }
}

export class FeedbackConversationPhoneConflictError extends ConversationPersistenceError {
  constructor() {
    super("Another open feedback conversation already uses this phone number");
    this.name = FeedbackConversationPhoneConflictError.name;
  }
}

export class FeedbackConversationCapacityError extends ConversationPersistenceError {
  constructor() {
    super(
      "The feedback conversation reached its transcript capacity and needs human attention",
    );
    this.name = FeedbackConversationCapacityError.name;
  }
}

export class FeedbackConversationTransitionError extends ConversationPersistenceError {
  constructor(message: string) {
    super(message);
    this.name = FeedbackConversationTransitionError.name;
  }
}

/**
 * Owns every `post_event_feedback` schema-v2 document. Schema-v1 assistant
 * documents share the collection and are never read or rewritten here.
 */
@Injectable()
export class FeedbackConversationRepository {
  private collectionPromise:
    Promise<Collection<FeedbackConversationDocument>> | undefined;

  constructor(private readonly mongo: MongoService) {}

  /**
   * Creates the conversation for one launched campaign recipient. The
   * deterministic `_id` makes launch replay idempotent, and a conversation
   * already closed by STOP is returned as-is instead of being recreated.
   */
  async createFromLaunch(
    input: FeedbackConversationLaunchInput,
  ): Promise<FeedbackConversationCreationResult> {
    const document = feedbackConversationDocumentSchema.parse({
      _id: deriveFeedbackConversationId(
        input.campaignId,
        input.respondentParticipantId,
      ),
      schemaVersion: FEEDBACK_CONVERSATION_SCHEMA_VERSION,
      purpose: FEEDBACK_CONVERSATION_PURPOSE,
      channel: FEEDBACK_CONVERSATION_CHANNEL,
      campaignId: input.campaignId,
      respondentParticipantId: input.respondentParticipantId,
      phoneAtLaunch: input.phoneAtLaunch,
      lifecycle: { state: "open", reason: null, closedAt: null },
      control: { mode: "bot", source: "launch", changedAt: input.launchedAt },
      goals: input.goals ? [...input.goals] : buildFeedbackConversationGoals(),
      messages: [],
      extraction: { cursorSeq: 0, lastRunAt: null, model: null },
      needsAttention: false,
      remindedAt: null,
      createdAt: input.launchedAt,
      updatedAt: input.launchedAt,
    });
    const collection = await this.collection();

    try {
      await collection.insertOne(document);
      return { created: true, conversation: document };
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }
    }

    const existing = await this.findById(document._id);
    if (!existing) {
      // The deterministic id is free, so the rejected key was the partial
      // unique index that keeps one open conversation per phone (D9).
      throw new FeedbackConversationPhoneConflictError();
    }
    if (
      existing.campaignId !== document.campaignId ||
      existing.respondentParticipantId !== document.respondentParticipantId
    ) {
      throw new ConversationPersistenceError(
        "Feedback conversation id belongs to a different campaign or respondent",
      );
    }
    return { created: false, conversation: existing };
  }

  async findById(
    id: string,
  ): Promise<FeedbackConversationDocument | undefined> {
    const collection = await this.collection();
    const document = await collection.findOne(feedbackConversationFilter(id));
    return document
      ? feedbackConversationDocumentSchema.parse(document)
      : undefined;
  }

  /**
   * Resolves inbound traffic to its conversation (D9). The partial unique index
   * guarantees at most one open feedback conversation per phone number.
   */
  async findOpenByPhone(
    phoneAtLaunch: string,
  ): Promise<FeedbackConversationDocument | undefined> {
    const collection = await this.collection();
    const document = await collection.findOne({
      schemaVersion: FEEDBACK_CONVERSATION_SCHEMA_VERSION,
      purpose: FEEDBACK_CONVERSATION_PURPOSE,
      "lifecycle.state": "open",
      phoneAtLaunch,
    } as Filter<FeedbackConversationDocument>);
    return document
      ? feedbackConversationDocumentSchema.parse(document)
      : undefined;
  }

  /**
   * Compact campaign-grouped list read. Transcripts stay out of list responses;
   * only counts and last-message metadata are projected.
   */
  async listForCampaign(
    campaignId: string,
    limit = 100,
  ): Promise<FeedbackConversationSummary[]> {
    const boundedLimit = z.number().int().positive().max(500).parse(limit);
    const collection = await this.collection();
    const documents = await collection
      .aggregate([
        {
          $match: {
            schemaVersion: FEEDBACK_CONVERSATION_SCHEMA_VERSION,
            purpose: FEEDBACK_CONVERSATION_PURPOSE,
            campaignId,
          },
        },
        { $sort: { updatedAt: -1 } },
        { $limit: boundedLimit },
        {
          $project: {
            _id: 1,
            campaignId: 1,
            respondentParticipantId: 1,
            phoneAtLaunch: 1,
            "lifecycle.state": 1,
            "lifecycle.reason": 1,
            "control.mode": 1,
            "control.source": 1,
            "goals.key": 1,
            "goals.ordinal": 1,
            "goals.status": 1,
            messageCount: { $size: "$messages" },
            lastMessageAt: { $last: "$messages.at" },
            lastMessageActor: { $last: "$messages.actor" },
            cursorSeq: "$extraction.cursorSeq",
            needsAttention: 1,
            remindedAt: 1,
            createdAt: 1,
            updatedAt: 1,
          },
        },
      ])
      .toArray();
    return documents.map((document) =>
      feedbackConversationSummarySchema.parse({
        ...document,
        lastMessageAt: document["lastMessageAt"] ?? null,
        lastMessageActor: document["lastMessageActor"] ?? null,
        remindedAt: document["remindedAt"] ?? null,
      }),
    );
  }

  /**
   * Appends one transcript message. The append is idempotent by
   * `ingressId`/`outboxId` (or by the caller's stable id for system messages)
   * and keeps `seq` contiguous through an optimistic size fence.
   */
  async appendMessage(
    input: AppendFeedbackConversationMessageInput,
  ): Promise<FeedbackConversationAppendResult> {
    const dedupeKeys = messageIdentityKeys(input);
    if (dedupeKeys.length === 0) {
      throw new ConversationPersistenceError(
        "A feedback conversation message requires an ingress id, an outbox id or a stable id",
      );
    }
    const collection = await this.collection();

    for (
      let attempt = 0;
      attempt < FEEDBACK_CONVERSATION_APPEND_ATTEMPTS;
      attempt += 1
    ) {
      const current = await this.requireConversation(input.conversationId);
      const existing = current.messages.find((message) =>
        messageIdentityKeys(message).some((key) => dedupeKeys.includes(key)),
      );
      if (existing) {
        assertMessageIdentity(existing, input);
        return { appended: false, message: existing, conversation: current };
      }

      const message = feedbackConversationMessageSchema.parse({
        id: input.id ?? randomUUID(),
        seq: current.messages.length + 1,
        actor: input.actor,
        text: input.text,
        providerMessageId: input.providerMessageId ?? null,
        ingressId: input.ingressId ?? null,
        outboxId: input.outboxId ?? null,
        at: input.at,
      });

      if (exceedsCapacity(current, message)) {
        await this.setNeedsAttention({
          conversationId: current._id,
          needsAttention: true,
          at: input.at,
        });
        throw new FeedbackConversationCapacityError();
      }

      const result = await collection.updateOne(
        {
          ...feedbackConversationFilter(current._id),
          messages: { $size: current.messages.length },
        } as Filter<FeedbackConversationDocument>,
        {
          $push: { messages: message },
          $max: { updatedAt: message.at },
        } as UpdateFilter<FeedbackConversationDocument>,
      );
      if (result.matchedCount > 0) {
        return {
          appended: true,
          message,
          conversation: {
            ...current,
            messages: [...current.messages, message],
            updatedAt:
              message.at > current.updatedAt ? message.at : current.updatedAt,
          },
        };
      }
    }

    throw new ConversationPersistenceError(
      "Concurrent appends prevented ordering a feedback conversation message",
    );
  }

  /**
   * Moves the conversation to human control. An external outbound observation
   * uses the same transition so two writers never speak concurrently.
   */
  async takeOver(input: {
    readonly conversationId: string;
    readonly source: Exclude<FeedbackConversationControlSource, "launch">;
    readonly at: Date;
  }): Promise<FeedbackConversationTransitionResult> {
    const changedAt = z.date().parse(input.at);
    const updated = await this.transition(
      input.conversationId,
      { "control.mode": "bot" },
      {
        control: { mode: "human", source: input.source, changedAt },
      },
      changedAt,
    );
    if (updated) {
      return { changed: true, conversation: updated };
    }

    const current = await this.requireConversation(input.conversationId);
    return { changed: false, conversation: current };
  }

  /** Returns bot control. A closed conversation is never resumed. */
  async resumeBot(input: {
    readonly conversationId: string;
    readonly at: Date;
  }): Promise<FeedbackConversationTransitionResult> {
    const changedAt = z.date().parse(input.at);
    const updated = await this.transition(
      input.conversationId,
      { "control.mode": "human", "lifecycle.state": "open" },
      {
        control: { mode: "bot", source: "staff_action", changedAt },
      },
      changedAt,
    );
    if (updated) {
      return { changed: true, conversation: updated };
    }

    const current = await this.requireConversation(input.conversationId);
    if (current.lifecycle.state === "closed") {
      throw new FeedbackConversationTransitionError(
        "A closed feedback conversation cannot resume bot control",
      );
    }
    return { changed: false, conversation: current };
  }

  /**
   * Closes the conversation with a terminal reason. The first closure wins,
   * except that a STOP always overrides a softer reason. Nothing reopens a
   * closed conversation, so a STOP is final.
   */
  async close(input: {
    readonly conversationId: string;
    readonly reason: FeedbackConversationLifecycleReason;
    readonly at: Date;
  }): Promise<FeedbackConversationTransitionResult> {
    const closedAt = z.date().parse(input.at);
    const guard: Filter<FeedbackConversationDocument> =
      input.reason === "stopped"
        ? ({
            "lifecycle.reason": { $ne: "stopped" },
          } as Filter<FeedbackConversationDocument>)
        : ({
            "lifecycle.state": "open",
          } as Filter<FeedbackConversationDocument>);
    const updated = await this.transition(
      input.conversationId,
      guard,
      {
        lifecycle: { state: "closed", reason: input.reason, closedAt },
      },
      closedAt,
    );
    if (updated) {
      return { changed: true, conversation: updated };
    }

    const current = await this.requireConversation(input.conversationId);
    return { changed: false, conversation: current };
  }

  /**
   * Advances the extraction cursor monotonically. A replayed or late run that
   * does not move the cursor is an idempotent no-op.
   */
  async advanceCursor(input: {
    readonly conversationId: string;
    readonly toSeq: number;
    readonly at: Date;
    readonly model?: string | null;
  }): Promise<FeedbackConversationTransitionResult> {
    const toSeq = z.number().int().positive().parse(input.toSeq);
    const lastRunAt = z.date().parse(input.at);
    const updated = await this.transition(
      input.conversationId,
      {
        "extraction.cursorSeq": { $lt: toSeq },
        $expr: { $lte: [toSeq, { $size: "$messages" }] },
      } as Filter<FeedbackConversationDocument>,
      {
        "extraction.cursorSeq": toSeq,
        "extraction.lastRunAt": lastRunAt,
        "extraction.model": input.model ?? null,
      },
      lastRunAt,
    );
    if (updated) {
      return { changed: true, conversation: updated };
    }

    const current = await this.requireConversation(input.conversationId);
    if (toSeq > current.messages.length) {
      throw new FeedbackConversationTransitionError(
        "The extraction cursor cannot pass the transcript",
      );
    }
    return { changed: false, conversation: current };
  }

  /** Flags or clears the operator attention badge. */
  async setNeedsAttention(input: {
    readonly conversationId: string;
    readonly needsAttention: boolean;
    readonly at: Date;
  }): Promise<FeedbackConversationTransitionResult> {
    const at = z.date().parse(input.at);
    const updated = await this.transition(
      input.conversationId,
      { needsAttention: !input.needsAttention },
      { needsAttention: input.needsAttention },
      at,
    );
    if (updated) {
      return { changed: true, conversation: updated };
    }

    const current = await this.requireConversation(input.conversationId);
    return { changed: false, conversation: current };
  }

  private async transition(
    id: string,
    guard: Filter<FeedbackConversationDocument>,
    set: Record<string, unknown>,
    updatedAt: Date,
  ): Promise<FeedbackConversationDocument | undefined> {
    const collection = await this.collection();
    const updated = await collection.findOneAndUpdate(
      { ...feedbackConversationFilter(id), ...guard },
      {
        $set: set,
        $max: { updatedAt },
      } as UpdateFilter<FeedbackConversationDocument>,
      { returnDocument: "after" },
    );
    return updated
      ? feedbackConversationDocumentSchema.parse(updated)
      : undefined;
  }

  private async requireConversation(
    id: string,
  ): Promise<FeedbackConversationDocument> {
    const conversation = await this.findById(id);
    if (!conversation) {
      throw new FeedbackConversationNotFoundError(id);
    }
    return conversation;
  }

  private collection(): Promise<Collection<FeedbackConversationDocument>> {
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
    Collection<FeedbackConversationDocument>
  > {
    const collection =
      await this.mongo.collection<FeedbackConversationDocument>(
        CONVERSATION_THREAD_COLLECTION,
      );
    await collection.createIndexes([
      {
        name: "feedback_conversation_open_phone_unique_idx",
        key: { phoneAtLaunch: 1 },
        unique: true,
        partialFilterExpression: {
          purpose: FEEDBACK_CONVERSATION_PURPOSE,
          "lifecycle.state": "open",
        },
      },
      {
        name: "feedback_conversation_campaign_updated_idx",
        key: { campaignId: 1, updatedAt: -1 },
      },
    ]);
    return collection;
  }
}

function feedbackConversationFilter(
  id: string,
): Filter<FeedbackConversationDocument> {
  return {
    _id: id,
    schemaVersion: FEEDBACK_CONVERSATION_SCHEMA_VERSION,
    purpose: FEEDBACK_CONVERSATION_PURPOSE,
  } as Filter<FeedbackConversationDocument>;
}

function messageIdentityKeys(message: {
  readonly id?: string | undefined;
  readonly ingressId?: string | null | undefined;
  readonly outboxId?: string | null | undefined;
}): string[] {
  return [message.id, message.ingressId, message.outboxId].filter(
    (value): value is string => Boolean(value),
  );
}

function assertMessageIdentity(
  existing: FeedbackConversationMessage,
  replayed: AppendFeedbackConversationMessageInput,
): void {
  if (
    existing.actor !== replayed.actor ||
    existing.text !== replayed.text.trim()
  ) {
    throw new ConversationPersistenceError(
      "A feedback conversation message was replayed with different content",
    );
  }
}

function exceedsCapacity(
  conversation: FeedbackConversationDocument,
  message: FeedbackConversationMessage,
): boolean {
  if (conversation.messages.length >= FEEDBACK_CONVERSATION_MAX_MESSAGES) {
    return true;
  }
  return (
    BSON.calculateObjectSize(conversation) + BSON.calculateObjectSize(message) >
    FEEDBACK_CONVERSATION_MAX_DOCUMENT_BYTES
  );
}

function isDuplicateKeyError(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === 11_000;
}
