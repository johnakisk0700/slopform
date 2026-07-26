import { randomUUID } from "node:crypto";

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
import { CONVERSATION_THREAD_COLLECTION } from "./conversation-thread.schemas.js";
import {
  FEEDBACK_CONVERSATION_CHANNEL,
  FEEDBACK_CONVERSATION_PURPOSE,
  FEEDBACK_CONVERSATION_SCHEMA_VERSION,
  type FeedbackConversationActor,
  type FeedbackConversationControlSource,
  type FeedbackConversationDocument,
  type FeedbackConversationGoal,
  type FeedbackConversationLifecycleReason,
  type FeedbackConversationMessage,
  type FeedbackConversationSummary,
  assertMessageIdentity,
  buildFeedbackConversationGoals,
  deriveFeedbackConversationId,
  exceedsCapacity,
  feedbackConversationDocumentSchema,
  feedbackConversationFilter,
  feedbackConversationMessageSchema,
  feedbackConversationSummarySchema,
  goalStatusRank,
  lowerGoalStatuses,
  messageIdentityKeys,
  sortTranscript,
  type AppendFeedbackConversationMessageInput,
} from "./feedback-conversation.schemas.js";
import {
  POST_EVENT_FEEDBACK_SAFETY_CATEGORIES,
  feedbackConversationMessageAttentionSchema,
  strongerRecommendedAction,
  type PostEventFeedbackRecommendedAction,
  type PostEventFeedbackSafetyCategory,
} from "../post-event-feedback/attention.js";

const FEEDBACK_CONVERSATION_APPEND_ATTEMPTS = 3;
const FEEDBACK_CONVERSATION_ATTENTION_MERGE_ATTEMPTS = 3;

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
      reminderCount: 0,
      awaitingHuman: false,
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
   * The most recently closed conversation on a number, for traffic that arrives
   * after the questionnaire ended.
   *
   * The closing copy says «Ό,τι άλλο θες να μας πεις, είμαστε εδώ», and people
   * take it literally — a correction, a second thought, or the disclosure they
   * worked up to saying. `findOpenByPhone` cannot see any of it, so those
   * messages used to fall through to the unmatched path and have their bodies
   * destroyed. This is deliberately not `findOpenByPhone` with a widened filter:
   * an open conversation is the one that may still be *spoken to*, and keeping
   * the two lookups apart is what stops a closed thread resuming by accident.
   */
  async findLatestClosedByPhone(
    phoneAtLaunch: string,
  ): Promise<FeedbackConversationDocument | undefined> {
    const collection = await this.collection();
    const document = await collection.findOne(
      {
        schemaVersion: FEEDBACK_CONVERSATION_SCHEMA_VERSION,
        purpose: FEEDBACK_CONVERSATION_PURPOSE,
        "lifecycle.state": "closed",
        phoneAtLaunch,
      } as Filter<FeedbackConversationDocument>,
      { sort: { updatedAt: -1 } },
    );
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
        attention: null,
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
          // Stored in the order the participant *spoke*, not the order the
          // webhooks arrived. WhatsApp tells us when each fragment was
          // observed, and two fragments of one thought can be delivered
          // backwards — which silently rewrites what the thought said: «5 λέω»
          // before «ο Νίκο» reads as a different sentence from «ο Νίκο» before
          // «5 λέω». `seq` is untouched by the sort and stays in arrival order,
          // because the extraction cursor is a `seq` and must not be reshuffled
          // underneath a run.
          $push: {
            messages: { $each: [message], $sort: { at: 1, seq: 1 } },
          },
          $max: { updatedAt: message.at },
        } as UpdateFilter<FeedbackConversationDocument>,
      );
      if (result.matchedCount > 0) {
        return {
          appended: true,
          message,
          conversation: {
            ...current,
            messages: sortTranscript([...current.messages, message]),
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
   * Merges a bounded attention classification into one participant message.
   *
   * A replayed model run may add categories or raise the recommended action.
   * It cannot downgrade or erase an earlier model classification, and an
   * optimistic element guard prevents a concurrent merge from being overwritten.
   */
  async mergeMessageAttention(input: {
    readonly conversationId: string;
    readonly messageId: string;
    readonly categories: readonly PostEventFeedbackSafetyCategory[];
    readonly recommendedAction: PostEventFeedbackRecommendedAction;
    readonly confidence: number;
    readonly at: Date;
  }): Promise<FeedbackConversationTransitionResult> {
    const at = z.date().parse(input.at);
    const collection = await this.collection();

    for (
      let attempt = 0;
      attempt < FEEDBACK_CONVERSATION_ATTENTION_MERGE_ATTEMPTS;
      attempt += 1
    ) {
      const current = await this.requireConversation(input.conversationId);
      const message = current.messages.find(
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
        confidence: Math.max(
          message.attention?.confidence ?? 0,
          input.confidence,
        ),
      });

      if (
        message.attention &&
        JSON.stringify(message.attention) === JSON.stringify(attention)
      ) {
        return { changed: false, conversation: current };
      }

      const updated = await collection.findOneAndUpdate(
        {
          ...feedbackConversationFilter(input.conversationId),
          messages: {
            $elemMatch: {
              id: input.messageId,
              attention: message.attention,
            },
          },
        } as Filter<FeedbackConversationDocument>,
        {
          $set: { "messages.$[message].attention": attention },
          $max: { updatedAt: at },
        } as UpdateFilter<FeedbackConversationDocument>,
        {
          returnDocument: "after",
          arrayFilters: [{ "message.id": input.messageId }],
        },
      );
      if (updated) {
        return {
          changed: true,
          conversation: feedbackConversationDocumentSchema.parse(updated),
        };
      }
    }

    throw new ConversationPersistenceError(
      "Concurrent updates prevented merging message attention metadata",
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
        // A person has arrived, so the wait is over either way.
        awaitingHuman: false,
      },
      changedAt,
    );
    if (updated) {
      return { changed: true, conversation: updated };
    }

    const current = await this.requireConversation(input.conversationId);
    return { changed: false, conversation: current };
  }

  /**
   * The bot steps back and waits for a person, without giving up control.
   *
   * Idempotent and one-way here: only a human engaging clears it, through
   * `takeOver` or `resumeBot`. A replayed extraction run therefore re-asserts
   * the same quiet state instead of speaking again.
   */
  async markAwaitingHuman(input: {
    readonly conversationId: string;
    readonly at: Date;
  }): Promise<FeedbackConversationTransitionResult> {
    const at = z.date().parse(input.at);
    const updated = await this.transition(
      input.conversationId,
      { "lifecycle.state": "open" },
      { awaitingHuman: true },
      at,
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
        // Handing back is a deliberate "the bot may speak again".
        awaitingHuman: false,
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

  /**
   * Advances goal statuses monotonically along
   * `pending < asked < skipped < answered`.
   *
   * The rank is the guard that implements D16's "an answered goal is never
   * auto-reopened": a later run that wants to ask a question again cannot
   * downgrade a recorded answer, however confident the model is. A goal that
   * was skipped may still be answered if the participant changes their mind,
   * because that direction adds a fact rather than discarding one.
   */
  async updateGoalStatuses(input: {
    readonly conversationId: string;
    readonly statuses: readonly {
      readonly key: FeedbackConversationGoal["key"];
      readonly status: FeedbackConversationGoal["status"];
    }[];
    readonly at: Date;
  }): Promise<FeedbackConversationTransitionResult> {
    const at = z.date().parse(input.at);
    const current = await this.requireConversation(input.conversationId);
    const statuses = [
      ...new Map(input.statuses.map((entry) => [entry.key, entry])).values(),
    ].filter((entry) => {
      const goal = current.goals.find(
        (candidate) => candidate.key === entry.key,
      );
      return (
        goal !== undefined &&
        goalStatusRank(entry.status) > goalStatusRank(goal.status)
      );
    });
    if (statuses.length === 0) {
      return { changed: false, conversation: current };
    }

    const set: Record<string, unknown> = {};
    const arrayFilters = statuses.map((entry, index) => {
      const identifier = `goal${index}`;
      set[`goals.$[${identifier}].status`] = entry.status;
      return {
        [`${identifier}.key`]: entry.key,
        [`${identifier}.status`]: { $in: lowerGoalStatuses(entry.status) },
      };
    });

    const collection = await this.collection();
    const updated = await collection.findOneAndUpdate(
      feedbackConversationFilter(input.conversationId),
      {
        $set: set,
        $max: { updatedAt: at },
      } as UpdateFilter<FeedbackConversationDocument>,
      { returnDocument: "after", arrayFilters },
    );
    if (!updated) {
      throw new FeedbackConversationNotFoundError(input.conversationId);
    }

    const conversation = feedbackConversationDocumentSchema.parse(updated);
    // A concurrent run may have advanced the same goal further in between; the
    // array filter then leaves it alone, which is the intended outcome.
    const changed = statuses.some(
      (entry) =>
        conversation.goals.find((goal) => goal.key === entry.key)?.status !==
        current.goals.find((goal) => goal.key === entry.key)?.status,
    );
    return { changed, conversation };
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

  /**
   * Advances the nudge ladder by one rung.
   *
   * `expectedCount` is a compare-and-set, not a hint: two sweeps racing on the
   * same conversation both read count 1, both try to write 2, and exactly one
   * matches. The loser reports `changed: false` and sends nothing, so a
   * concurrent sweep cannot double-nudge somebody.
   */
  async markReminded(input: {
    readonly conversationId: string;
    readonly at: Date;
    readonly expectedCount: number;
  }): Promise<FeedbackConversationTransitionResult> {
    const at = z.date().parse(input.at);
    const expectedCount = z.number().int().min(0).parse(input.expectedCount);
    const updated = await this.transition(
      input.conversationId,
      {
        "lifecycle.state": "open",
        // A conversation written before the ladder existed has no counter at
        // all; it has been nudged zero times, so let it onto the first rung.
        $or:
          expectedCount === 0
            ? [{ reminderCount: 0 }, { reminderCount: { $exists: false } }]
            : [{ reminderCount: expectedCount }],
      } as Filter<FeedbackConversationDocument>,
      { remindedAt: at, reminderCount: expectedCount + 1 },
      at,
    );
    if (updated) {
      return { changed: true, conversation: updated };
    }

    const current = await this.requireConversation(input.conversationId);
    return { changed: false, conversation: current };
  }

  /**
   * Approximate reminder candidates. The sweep reloads each conversation and
   * re-checks campaign status, control, opt-in and how long the participant has
   * actually been silent.
   *
   * `createdAt` is deliberately the coarse filter even though the rule is about
   * silence. Silence can never exceed a conversation's age, so an age filter is
   * a correct superset of what is due and needs no denormalized field kept in
   * step with the transcript. The exact rung is decided in the sweep, against
   * the loaded document.
   */
  async listOpenDueForReminder(input: {
    readonly olderThan: Date;
    readonly maxReminders: number;
    readonly limit?: number;
  }): Promise<FeedbackConversationDocument[]> {
    const maxReminders = z.number().int().min(0).parse(input.maxReminders);
    return this.listOpenBotConversations({
      olderThan: input.olderThan,
      limit: input.limit,
      extraFilter: {
        // Everything still on the ladder, including conversations predating it.
        $or: [
          { reminderCount: { $lt: maxReminders } },
          { reminderCount: { $exists: false } },
        ],
      },
    });
  }

  /**
   * Approximate expiry candidates, filtered by age for the same reason as
   * `listOpenDueForReminder`: age is a correct superset of silence, and the
   * sweep decides on the loaded transcript.
   *
   * The sweep reloads state and skips human-controlled conversations before
   * closing.
   */
  async listOpenDueForExpiry(input: {
    readonly olderThan: Date;
    readonly limit?: number;
  }): Promise<FeedbackConversationDocument[]> {
    return this.listOpenBotConversations({
      olderThan: input.olderThan,
      limit: input.limit,
      extraFilter: {},
    });
  }

  private async listOpenBotConversations(input: {
    readonly olderThan: Date;
    // Explicitly `| undefined` rather than optional: the callers forward their
    // own optional `limit`, which `exactOptionalPropertyTypes` refuses to widen.
    readonly limit: number | undefined;
    readonly extraFilter: Filter<FeedbackConversationDocument>;
  }): Promise<FeedbackConversationDocument[]> {
    const olderThan = z.date().parse(input.olderThan);
    const limit = z
      .number()
      .int()
      .positive()
      .max(500)
      .parse(input.limit ?? 50);
    const collection = await this.collection();
    const documents = await collection
      .find({
        schemaVersion: FEEDBACK_CONVERSATION_SCHEMA_VERSION,
        purpose: FEEDBACK_CONVERSATION_PURPOSE,
        "lifecycle.state": "open",
        "control.mode": "bot",
        ...input.extraFilter,
        createdAt: { $lte: olderThan },
      } as Filter<FeedbackConversationDocument>)
      .sort({ createdAt: 1, _id: 1 })
      .limit(limit)
      .toArray();
    return documents.map((document) =>
      feedbackConversationDocumentSchema.parse(document),
    );
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

function isDuplicateKeyError(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === 11_000;
}
