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
import { ConversationPersistenceError } from "../conversations/conversation-persistence.errors.js";
import { CONVERSATION_THREAD_COLLECTION } from "../conversations/conversation-thread.schemas.js";
import {
  FEEDBACK_CONVERSATION_CHANNEL,
  FEEDBACK_CONVERSATION_PURPOSE,
  FEEDBACK_CONVERSATION_SCHEMA_VERSION,
  type FeedbackConversationActor,
  type FeedbackConversationControlSource,
  type FeedbackConversationDocument,
  type FeedbackConversationExtractionUsage,
  type FeedbackConversationGoal,
  type FeedbackConversationLifecycleReason,
  type FeedbackConversationMessage,
  type FeedbackConversationRespondent,
  type FeedbackConversationSummary,
  assertMessageIdentity,
  buildFeedbackConversationGoals,
  deriveFeedbackConversationId,
  exceedsCapacity,
  feedbackConversationDocumentSchema,
  feedbackConversationFilter,
  feedbackConversationRespondentSchema,
  feedbackConversationStoredMessageSchema,
  feedbackConversationSummarySchema,
  canTransitionGoalStatus,
  lowerGoalStatuses,
  messageIdentityKeys,
  sortTranscript,
  type AppendFeedbackConversationMessageInput,
} from "./post-event-feedback-conversation.document.js";
import {
  POST_EVENT_FEEDBACK_SAFETY_CATEGORIES,
  feedbackConversationMessageAttentionSchema,
  strongerRecommendedAction,
  type PostEventFeedbackAttentionReason,
  type PostEventFeedbackRecommendedAction,
  type PostEventFeedbackSafetyCategory,
} from "./attention.js";

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

export interface FeedbackConversationExtractionAccounting {
  readonly conversationId: string;
  readonly extraction: {
    readonly model: string | null;
    readonly usage: FeedbackConversationExtractionUsage | null;
    readonly serviceTier: string | null;
  };
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
      hostileTurns: 0,
      extractionFallbackAckSent: false,
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
   * Who a batch of conversations is with, and nothing else.
   *
   * The outbound-queue screen starts from `message_outbox` rows, which know a
   * `conversation_id` and no human being. One `$in` read resolves the whole
   * page — the alternative is a `findById` per row, which is the same load
   * amplifier as a per-row Redis lookup wearing a different hat. Conversations
   * whose document is missing are simply absent from the result; the caller
   * renders the D18 fallback rather than being handed a fabricated name.
   */
  async listRespondentsByIds(
    conversationIds: readonly string[],
  ): Promise<FeedbackConversationRespondent[]> {
    const unique = [...new Set(conversationIds)];
    if (unique.length === 0) {
      return [];
    }
    const collection = await this.collection();
    const documents = await collection
      .find(
        {
          schemaVersion: FEEDBACK_CONVERSATION_SCHEMA_VERSION,
          purpose: FEEDBACK_CONVERSATION_PURPOSE,
          _id: { $in: unique },
        } as Filter<FeedbackConversationDocument>,
        {
          projection: {
            _id: 1,
            respondentParticipantId: 1,
            phoneAtLaunch: 1,
          },
        },
      )
      .toArray();

    return documents.map((document) =>
      feedbackConversationRespondentSchema.parse(document),
    );
  }

  /**
   * One batched, projection-only read for rehearsal token accounting.
   *
   * The production burst runner cannot inspect the operator laptop's MongoDB:
   * that is a different database. Keeping this read in the repository lets the
   * guarded dev HTTP surface return the durable ledger without exposing a
   * MongoDB credential to the runner or loading full transcripts.
   */
  async listExtractionAccountingForCampaigns(
    campaignIds: readonly string[],
  ): Promise<FeedbackConversationExtractionAccounting[]> {
    const unique = [...new Set(campaignIds)];
    if (unique.length === 0) {
      return [];
    }
    const collection = await this.collection();
    const documents = await collection
      .find(
        {
          schemaVersion: FEEDBACK_CONVERSATION_SCHEMA_VERSION,
          purpose: FEEDBACK_CONVERSATION_PURPOSE,
          campaignId: { $in: unique },
        } as Filter<FeedbackConversationDocument>,
        {
          projection: {
            _id: 1,
            "extraction.model": 1,
            "extraction.usage": 1,
            "extraction.serviceTier": 1,
          },
        },
      )
      .toArray();

    return documents.map((document) => ({
      conversationId: document._id,
      extraction: {
        model: document.extraction.model ?? null,
        usage: document.extraction.usage ?? null,
        serviceTier: document.extraction.serviceTier ?? null,
      },
    }));
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
            // Projected as a boolean rather than the timestamp: the campaign
            // summary counts parked conversations, and a list row has nothing to
            // say about when one particular provider incident started.
            extractionParked: {
              $ne: [{ $ifNull: ["$extraction.parkedSince", null] }, null],
            },
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

  /** Open conversations still accepting feedback in one campaign. */
  async countOpenForCampaign(campaignId: string): Promise<number> {
    const collection = await this.collection();
    return collection.countDocuments({
      schemaVersion: FEEDBACK_CONVERSATION_SCHEMA_VERSION,
      purpose: FEEDBACK_CONVERSATION_PURPOSE,
      campaignId,
      "lifecycle.state": "open",
    });
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

      const message = feedbackConversationStoredMessageSchema.parse({
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
        // Named here rather than left to the caller because this is the only
        // place that knows the document is full, and every caller — inbound,
        // outbound transcript, post-closure text — hits it the same way. The
        // anchor is null: the message that would have said what happened is the
        // one there was no room for.
        await this.raiseAttention({
          conversationId: current._id,
          kind: "transcript_full",
          messageId: null,
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

  /**
   * Counts one more run that read abuse aimed at us.
   *
   * `expectedCount` is a compare-and-set for the same reason `markReminded`'s is,
   * and it is what makes a replay safe without a second field. The extractor
   * decides the rung from its own snapshot, so a replayed run reads the same
   * `hostileTurns` it read the first time, tries to write the same successor, and
   * finds the value already there — one increment per run, however many times the
   * job is retried. Two concurrent runs on one conversation resolve the same way:
   * one writes, the loser leaves the ladder where it is rather than spending a
   * rung twice on a single message.
   *
   * A conversation written before the counter existed has no field at all; it has
   * been hostile zero times, so it is allowed onto the first rung.
   */
  async recordHostileTurn(input: {
    readonly conversationId: string;
    readonly at: Date;
    readonly expectedCount: number;
  }): Promise<FeedbackConversationTransitionResult> {
    const at = z.date().parse(input.at);
    const expectedCount = z.number().int().min(0).parse(input.expectedCount);
    const updated = await this.transition(
      input.conversationId,
      {
        $or:
          expectedCount === 0
            ? [{ hostileTurns: 0 }, { hostileTurns: { $exists: false } }]
            : [{ hostileTurns: expectedCount }],
      } as Filter<FeedbackConversationDocument>,
      { hostileTurns: expectedCount + 1 },
      at,
    );
    if (updated) {
      return { changed: true, conversation: updated };
    }

    const current = await this.requireConversation(input.conversationId);
    return { changed: false, conversation: current };
  }

  /**
   * Records that the deterministic fallback acknowledgement was queued. Later
   * permanent failures in the same conversation still file notes, but must not
   * speak the same apology again.
   *
   * Idempotent: a replayed dead run or a second outage after the flag is already
   * set is a no-op rather than a second send.
   */
  async markExtractionFallbackAckSent(input: {
    readonly conversationId: string;
    readonly at: Date;
  }): Promise<FeedbackConversationTransitionResult> {
    const at = z.date().parse(input.at);
    const updated = await this.transition(
      input.conversationId,
      {
        $or: [
          { extractionFallbackAckSent: false },
          { extractionFallbackAckSent: { $exists: false } },
        ],
      } as Filter<FeedbackConversationDocument>,
      { extractionFallbackAckSent: true },
      at,
    );
    if (updated) {
      return { changed: true, conversation: updated };
    }

    const current = await this.requireConversation(input.conversationId);
    return { changed: false, conversation: current };
  }

  /**
   * Parks extraction on a provider incident, and counts this run.
   *
   * `parkedSince` is set by the first park and then left alone, because it is
   * what «stuck for half an hour» is measured against — recomputing it on every
   * failing run would push the threshold away exactly as fast as the outage
   * lasted, and the participant would never be told anything. `parkedRuns` counts
   * regardless, so the caller can derive a fresh retry job id and know when to
   * stop re-queueing.
   *
   * Written as an aggregation-pipeline update because that is what makes
   * «keep the old value, increment the other» one atomic statement. Two runs
   * parking the same conversation concurrently therefore agree on the start and
   * both get counted, instead of one of them resetting the clock.
   *
   * No lifecycle guard: a conversation that closed under a parked run is still
   * parked, and hiding that would make the campaign's count disagree with what
   * actually happened. Nothing downstream speaks to a closed conversation — the
   * notice and the retry check lifecycle for themselves.
   */
  async parkExtraction(input: {
    readonly conversationId: string;
    readonly at: Date;
  }): Promise<FeedbackConversationTransitionResult> {
    const at = z.date().parse(input.at);
    const collection = await this.collection();
    const updated = await collection.findOneAndUpdate(
      feedbackConversationFilter(input.conversationId),
      [
        {
          $set: {
            "extraction.parkedSince": {
              $ifNull: ["$extraction.parkedSince", at],
            },
            "extraction.parkedRuns": {
              $add: [{ $ifNull: ["$extraction.parkedRuns", 0] }, 1],
            },
            updatedAt: { $max: ["$updatedAt", at] },
          },
        },
      ],
      { returnDocument: "after" },
    );
    if (!updated) {
      throw new FeedbackConversationNotFoundError(input.conversationId);
    }
    return {
      changed: true,
      conversation: feedbackConversationDocumentSchema.parse(updated),
    };
  }

  /**
   * Records that the participant has been told, once, that extraction is stuck.
   *
   * The same shape as `markExtractionFallbackAckSent` and for the same reason:
   * the outbox `dedupe_key` is what makes the send happen once, and this is what
   * makes the *decision* to send happen once, so a parked conversation that wakes
   * up every few minutes for hours does not re-derive an apology it already made.
   */
  async markExtractionParkedNoticeSent(input: {
    readonly conversationId: string;
    readonly at: Date;
  }): Promise<FeedbackConversationTransitionResult> {
    const at = z.date().parse(input.at);
    const updated = await this.transition(
      input.conversationId,
      {
        $or: [
          { "extraction.parkedNoticeSentAt": null },
          { "extraction.parkedNoticeSentAt": { $exists: false } },
        ],
      } as Filter<FeedbackConversationDocument>,
      { "extraction.parkedNoticeSentAt": at },
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
   *
   * Closing also lowers the badge — but only when there is nothing unresolved
   * left to lower it for. Both halves of that matter:
   *
   * The lowering is a real bug fix. The inbox buckets on attention *before*
   * lifecycle, so a conversation that was flagged and then closed sat pinned
   * above every open conversation for good, and closing it — the one action an
   * operator has for «I am done with this» — did nothing about the flag.
   *
   * The condition is the other half. A closed conversation with a standing
   * reason still wants a person: «σβήστε ό,τι σας είπα» does not stop being a
   * request because the questionnaire ended, and auto-resolving reasons here
   * would mark them handled by nobody, with a `resolvedBy` we would have to
   * invent. So close never touches an unresolved reason. It lowers the flag when
   * every reason is already dismissed, and when there are no reasons at all —
   * which is the pre-reason bare flag, and the only thing that can raise the
   * badge without saying why. What is left is what the operator dismisses, and
   * dismissing the last one lowers the badge on its own.
   */
  async close(input: {
    readonly conversationId: string;
    readonly reason: FeedbackConversationLifecycleReason;
    readonly at: Date;
    /**
     * Staff-only close intent. Absent on every bot close; when present the
     * lifecycle reason is still `cancelled` and this is what the admin reads
     * a month later. Cleared to null on any close that does not pass it so a
     * STOP cannot leave an earlier "abusive" label standing.
     */
    readonly staffClose?: FeedbackConversationDocument["staffClose"];
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
        // Always written: a STOP that overrides a staff-cancelled thread must
        // drop the operator reason, not leave "abusive" on a consent withdrawal.
        staffClose: input.staffClose ?? null,
      },
      closedAt,
    );
    if (updated) {
      return {
        changed: true,
        conversation: await this.lowerSettledAttention(updated, closedAt),
      };
    }

    const current = await this.requireConversation(input.conversationId);
    return { changed: false, conversation: current };
  }

  /**
   * Drops a badge that nothing unresolved is holding up.
   *
   * Guarded on `needsAttention: true` and on the reason list being clean, so a
   * reason raised between the close and this write keeps its badge: the guard is
   * the whole point, not a formality.
   */
  private async lowerSettledAttention(
    conversation: FeedbackConversationDocument,
    at: Date,
  ): Promise<FeedbackConversationDocument> {
    if (
      !conversation.needsAttention ||
      conversation.attentionReasons.some((reason) => reason.resolvedAt === null)
    ) {
      return conversation;
    }
    const lowered = await this.transition(
      conversation._id,
      {
        needsAttention: true,
        attentionReasons: { $not: { $elemMatch: { resolvedAt: null } } },
      } as Filter<FeedbackConversationDocument>,
      { needsAttention: false },
      at,
    );
    return lowered ?? conversation;
  }

  /**
   * Advances the extraction cursor monotonically, and adds this run's tokens to
   * the conversation's running total. A replayed or late run that does not move
   * the cursor is an idempotent no-op — and therefore bills nothing twice.
   *
   * Written as an aggregation-pipeline update for the reason `parkExtraction`
   * is: «add to what is already there» cannot be said with a literal `$set`, and
   * splitting it into a read and a write would let two runs of the same
   * conversation each add to a total the other had not yet written.
   *
   * `usage` is **absent** — not null — on a run that called no model, and an
   * absent usage leaves the accumulator untouched. That distinction is the whole
   * safeguard: `skipped_no_new_testimony` advances the cursor without a provider
   * call, and a null passed as «nothing this run» would have erased every token
   * the earlier runs paid for. `serviceTier` follows `model` instead: it is
   * always written, so callers that want the old one preserved pass it back.
   */
  async advanceCursor(input: {
    readonly conversationId: string;
    readonly toSeq: number;
    readonly at: Date;
    readonly model?: string | null;
    readonly serviceTier?: string | null;
    readonly usage?: FeedbackConversationExtractionUsage;
  }): Promise<FeedbackConversationTransitionResult> {
    const toSeq = z.number().int().positive().parse(input.toSeq);
    const lastRunAt = z.date().parse(input.at);
    const collection = await this.collection();
    const updated = await collection.findOneAndUpdate(
      {
        ...feedbackConversationFilter(input.conversationId),
        "extraction.cursorSeq": { $lt: toSeq },
        $expr: { $lte: [toSeq, { $size: "$messages" }] },
      } as Filter<FeedbackConversationDocument>,
      [
        {
          $set: {
            "extraction.cursorSeq": toSeq,
            "extraction.lastRunAt": lastRunAt,
            "extraction.model": input.model ?? null,
            "extraction.serviceTier": input.serviceTier ?? null,
            ...(input.usage
              ? { "extraction.usage": accumulatedUsage(input.usage) }
              : {}),
            // A run that moved the cursor is a run that reached the provider, so
            // the incident this conversation was parked on is over for it.
            // Clearing here rather than in a recovery path of its own keeps
            // «parked» defined by one fact — the last run could not read this
            // conversation — and takes the campaign's count down on its own as
            // the backlog drains.
            //
            // `parkedNoticeSentAt` deliberately survives. It is not part of the
            // park; it is the record that a machine has already apologised to
            // this person once, and re-arming it would let a second brief outage
            // send the same sentence again.
            "extraction.parkedSince": null,
            "extraction.parkedRuns": 0,
            updatedAt: { $max: ["$updatedAt", lastRunAt] },
          },
        },
      ],
      { returnDocument: "after" },
    );
    if (updated) {
      return {
        changed: true,
        conversation: feedbackConversationDocumentSchema.parse(updated),
      };
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
   * Advances goal statuses along `pending < asked < skipped < answered`, with
   * one deliberate demotion: `skipped → asked`.
   *
   * The rank still implements D16's "an answered goal is never auto-reopened":
   * a later run cannot demote a recorded answer back to a question, however
   * confident the model is. A skipped goal may still become answered when the
   * participant changes their mind (that adds a fact). It may also become
   * `asked` again when a *sent* question-shaped reply carries `askedGoal` for
   * it — the bot re-opened the decision on purpose (WP-9δ / rule 9δ hold
   * question); leaving it skipped closes the conversation under that question.
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
        goal !== undefined && canTransitionGoalStatus(goal.status, entry.status)
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

  /**
   * Raises the badge and records why, in one write.
   *
   * The only way to raise it. There is deliberately no bare setter any more:
   * every situation that wants a person now has a name in the reason vocabulary,
   * and a flag with no reason is a badge an operator can neither read nor
   * dismiss — which is the defect this replaced.
   *
   * Idempotent on the pair that identifies the situation: re-reading the same
   * hostile message, or a retried job, must not stack three identical rows an
   * operator then has to dismiss three times. A *new* message of the same kind
   * is a new row, because it is a new thing to look at. A kind with no anchor
   * (a full transcript, a send that never went out) therefore stands once until
   * it is dismissed, which is the right count for «there is something here you
   * cannot see» — it is one piece of news, however many times it recurs.
   */
  async raiseAttention(input: {
    readonly conversationId: string;
    readonly kind: PostEventFeedbackAttentionReason;
    readonly messageId: string | null;
    readonly at: Date;
  }): Promise<FeedbackConversationTransitionResult> {
    const at = z.date().parse(input.at);
    const collection = await this.collection();
    const updated = await collection.findOneAndUpdate(
      {
        ...feedbackConversationFilter(input.conversationId),
        attentionReasons: {
          $not: {
            $elemMatch: {
              kind: input.kind,
              messageId: input.messageId,
              resolvedAt: null,
            },
          },
        },
      },
      {
        $set: { needsAttention: true },
        $push: {
          attentionReasons: {
            id: randomUUID(),
            kind: input.kind,
            messageId: input.messageId,
            at,
            resolvedAt: null,
            resolvedBy: null,
          },
        },
        $max: { updatedAt: at },
      } as UpdateFilter<FeedbackConversationDocument>,
      { returnDocument: "after" },
    );

    if (updated) {
      return {
        changed: true,
        conversation: feedbackConversationDocumentSchema.parse(updated),
      };
    }
    const current = await this.requireConversation(input.conversationId);
    return { changed: false, conversation: current };
  }

  /**
   * Dismisses one reason, and lowers the badge only when it was the last one.
   *
   * Recomputing `needsAttention` here is what keeps the count honest. It stays
   * stored rather than derived because the inbox filters and counts on it, but
   * nothing else may write it once a conversation carries reasons — otherwise
   * the badge and the list disagree and the operator believes the badge.
   */
  async resolveAttentionReason(input: {
    readonly conversationId: string;
    readonly reasonId: string;
    readonly resolvedBy: string;
    readonly at: Date;
  }): Promise<FeedbackConversationTransitionResult> {
    const at = z.date().parse(input.at);
    const collection = await this.collection();
    const updated = await collection.findOneAndUpdate(
      {
        ...feedbackConversationFilter(input.conversationId),
        attentionReasons: {
          $elemMatch: { id: input.reasonId, resolvedAt: null },
        },
      },
      {
        $set: {
          "attentionReasons.$[reason].resolvedAt": at,
          "attentionReasons.$[reason].resolvedBy": input.resolvedBy,
        },
        $max: { updatedAt: at },
      } as UpdateFilter<FeedbackConversationDocument>,
      {
        arrayFilters: [
          { "reason.id": input.reasonId, "reason.resolvedAt": null },
        ],
        returnDocument: "after",
      },
    );

    if (!updated) {
      const current = await this.requireConversation(input.conversationId);
      return { changed: false, conversation: current };
    }

    const resolved = feedbackConversationDocumentSchema.parse(updated);
    if (
      resolved.attentionReasons.some((reason) => reason.resolvedAt === null)
    ) {
      return { changed: true, conversation: resolved };
    }
    const lowered = await this.transition(
      input.conversationId,
      { needsAttention: true },
      { needsAttention: false },
      at,
    );
    return { changed: true, conversation: lowered ?? resolved };
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

/**
 * The `$set` expression that adds one run's tokens to the stored totals.
 *
 * Per component, because providers report per component, and the three are not
 * derivable from one another once any of them is missing.
 *
 * This is the aggregation-pipeline spelling of
 * `accumulateFeedbackExtractionUsage`, which states the rule and is what the
 * in-memory double runs. The rule lives there; this builds the statement that
 * lets the database apply it in one atomic write.
 */
function accumulatedUsage(
  usage: FeedbackConversationExtractionUsage,
): Record<string, unknown> {
  return {
    inputTokens: accumulatedUsageComponent("inputTokens", usage.inputTokens),
    outputTokens: accumulatedUsageComponent("outputTokens", usage.outputTokens),
    totalTokens: accumulatedUsageComponent("totalTokens", usage.totalTokens),
  };
}

/**
 * One component of the running total, with the null-poisoning rule.
 *
 * Null is absorbing in both directions. A run that did not report this component
 * makes the total null and there is nothing to compute — the literal short
 * circuit below. A total that is *already* null stays null however many
 * fully-reported runs follow, because the tokens that were never counted are not
 * recoverable and a sum that silently omits them is a smaller number presented as
 * the same kind of fact. The CLI reads null as «cost unavailable», which is what
 * we actually know.
 *
 * The starting point distinguishes «no usage recorded yet» from «this component
 * was never reported». An absent or null `extraction.usage` is a conversation
 * whose first run is landing now, so the prior is zero and the sums begin;
 * inside a stored usage object, a null component is the poison and stays.
 */
function accumulatedUsageComponent(
  component: keyof FeedbackConversationExtractionUsage,
  reported: number | null,
): unknown {
  if (reported === null) {
    return null;
  }
  return {
    $let: {
      vars: {
        prior: {
          $cond: [
            { $eq: [{ $type: "$extraction.usage" }, "object"] },
            { $ifNull: [`$extraction.usage.${component}`, null] },
            0,
          ],
        },
      },
      in: {
        $cond: [
          { $eq: ["$$prior", null] },
          null,
          { $add: ["$$prior", reported] },
        ],
      },
    },
  };
}
