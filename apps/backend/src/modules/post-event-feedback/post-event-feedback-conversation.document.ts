import { createHash } from "node:crypto";

import { BSON, type Filter } from "mongodb";
import { z } from "zod";

import { FEEDBACK_ANSWER_QUESTION_KEYS } from "@join-the-six/database";

import {
  CURRENT_POST_EVENT_FEEDBACK_QUESTION_SET_VERSION,
  getPostEventFeedbackQuestionSet,
  type PostEventFeedbackQuestionSetCopy,
  type PostEventFeedbackQuestionSetVersion,
} from "./question-set.js";
import {
  feedbackConversationAttentionReasonSchema,
  feedbackConversationMessageAttentionSchema,
} from "./attention.js";
import { ConversationPersistenceError } from "../conversations/conversation-persistence.errors.js";

// Schema v2 is the purpose-specific post-event feedback document. It shares the
// `conversation_threads` collection with the schema-v1 assistant aggregate and
// is discriminated by `schemaVersion` + `purpose`; neither reader reinterprets
// the other's documents.
export const FEEDBACK_CONVERSATION_SCHEMA_VERSION = 2 as const;
export const FEEDBACK_CONVERSATION_PURPOSE = "post_event_feedback" as const;
export const FEEDBACK_CONVERSATION_CHANNEL = "whatsapp" as const;
/**
 * The longest body we will *send*. WhatsApp accepts 4096 characters in a text
 * message, so this bounds our own copy and every staff-written message.
 */
export const FEEDBACK_CONVERSATION_MESSAGE_MAX_TEXT_LENGTH = 4_096;

/**
 * The longest body a transcript entry may *hold*.
 *
 * Deliberately far above the send limit, because the two are not the same
 * constraint and conflating them cost real testimony: an inbound message longer
 * than one we are allowed to send was cut to 4096 before an operator ever saw
 * it. People write their way up to the hard thing, so the tail is exactly where
 * a disclosure lives — «και το τελευταίο που δεν είπα πριν…».
 *
 * Total document size is guarded separately by
 * `FEEDBACK_CONVERSATION_MAX_DOCUMENT_BYTES`, which is what actually protects
 * MongoDB; this limit only stops one absurd message.
 */
export const FEEDBACK_CONVERSATION_MESSAGE_MAX_STORED_TEXT_LENGTH = 64_000;
// A feedback conversation is a short questionnaire. The message cap is the
// binding guard; the byte budget is the backstop for multi-byte-heavy content
// and stays far below MongoDB's 16 MiB BSON document limit.
export const FEEDBACK_CONVERSATION_MAX_MESSAGES = 150;
export const FEEDBACK_CONVERSATION_MAX_DOCUMENT_BYTES = 4_194_304;
// Generous against the message cap: a conversation raising a reason on every
// second message is already pathological, and the bound exists so a repeated
// raise cannot grow the document without limit, not to ration honest reasons.
export const FEEDBACK_CONVERSATION_MAX_ATTENTION_REASONS = 50;

export const feedbackConversationPhoneSchema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{7,14}$/u, "Expected an E.164 phone number");

/**
 * What kind of ending this was. Five words, and each is a different fact about
 * the person, which is why they are not collapsible.
 *
 * `completed` — the questionnaire finished with something in it.
 * `declined` — they answered the questions by refusing them, and nothing was
 * recorded. Πάνος Μούλαρος wrote «δε λεω τιποτα» three times and was filed as
 * `completed`, in the column a campaign's response rate is read from; the
 * closing copy was already withheld from him by `answeredAnything`, so the
 * sentence he read and the word we stored disagreed. Not `stopped`: he never
 * withdrew consent, and losing the difference between «leave me alone about
 * this dinner» and «never message me again» would be losing the more important
 * one.
 * `stopped` — they opted out.
 * `expired` — the sweep closed it; nobody ended anything.
 * `cancelled` — a human closed it.
 *
 * Exported so the read models, the harness vocabularies and the HTTP boundary
 * stop hand-copying the list. A sixth ending would otherwise typecheck in five
 * files and be missing from three.
 */
export const FEEDBACK_CONVERSATION_LIFECYCLE_REASONS = [
  "completed",
  "declined",
  "stopped",
  "expired",
  "cancelled",
] as const;

export const feedbackConversationLifecycleSchema = z
  .object({
    state: z.enum(["open", "closed"]),
    reason: z.enum(FEEDBACK_CONVERSATION_LIFECYCLE_REASONS).nullable(),
    closedAt: z.date().nullable(),
    /**
     * The one outbox row allowed to announce a terminal transition. It is
     * committed in the same MongoDB write as either the extraction cursor and
     * `completed` / `declined` lifecycle, or the deterministic STOP close. A
     * PostgreSQL row left behind by a crashed or superseded transition can
     * therefore never become a second goodbye or opt-out acknowledgement.
     *
     * `null` for expiry/cancellation and for documents written before this
     * fence existed. The default is deliberately conservative: old terminal
     * documents do not grant an arbitrary legacy row permission to send.
     */
    terminalOutboxId: z.uuid().nullable().optional(),
  })
  .strict()
  .superRefine((lifecycle, context) => {
    if (
      lifecycle.state === "open" &&
      (lifecycle.reason || lifecycle.closedAt)
    ) {
      context.addIssue({
        code: "custom",
        message: "An open conversation cannot carry a terminal reason",
      });
    }
    if (
      lifecycle.state === "closed" &&
      (!lifecycle.reason || !lifecycle.closedAt)
    ) {
      context.addIssue({
        code: "custom",
        message: "A closed conversation requires a reason and closedAt",
      });
    }
    if (
      lifecycle.terminalOutboxId &&
      (lifecycle.state !== "closed" ||
        (lifecycle.reason !== "completed" &&
          lifecycle.reason !== "declined" &&
          lifecycle.reason !== "stopped"))
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A terminal outbox id belongs only to a completed, declined or stopped lifecycle",
      });
    }
  });

/**
 * Why a human closed a conversation — operator intent, not lifecycle state.
 *
 * Deliberately **not** folded into `lifecycle.reason`. That enum answers a
 * state-machine question (may anything still act on this thread); every staff
 * close answers it the same way (`cancelled`). Putting abusive / unresponsive /
 * handled offline into that enum would drag the STOP-override guard, the
 * idempotency checks and the admin badge vocabulary into a taxonomy that
 * expresses why somebody clicked Close, not what kind of ending this is.
 *
 * Bounded and optional on the document so a month-later read can tell an
 * abusive thread from one handled by phone without opening `audit_events`.
 * Null on every non-staff close, and cleared when STOP overrides a softer
 * reason.
 */
export const FEEDBACK_STAFF_CLOSE_REASONS = [
  "abusive",
  "unresponsive",
  "handled_offline",
  "duplicate",
  "other",
] as const;

export const FEEDBACK_STAFF_CLOSE_NOTE_MAX_LENGTH = 500;

export const feedbackConversationStaffCloseSchema = z
  .object({
    reason: z.enum(FEEDBACK_STAFF_CLOSE_REASONS),
    note: z
      .string()
      .trim()
      .min(1)
      .max(FEEDBACK_STAFF_CLOSE_NOTE_MAX_LENGTH)
      .nullable(),
  })
  .strict();

export const feedbackConversationControlSchema = z
  .object({
    mode: z.enum(["bot", "human"]),
    source: z.enum(["launch", "staff_action", "external_outbound"]),
    changedAt: z.date(),
  })
  .strict()
  .superRefine((control, context) => {
    if (control.mode === "human" && control.source === "launch") {
      context.addIssue({
        code: "custom",
        message: "Human control requires a staff action or external outbound",
      });
    }
  });

export const feedbackConversationGoalKeySchema = z.enum(
  FEEDBACK_ANSWER_QUESTION_KEYS,
);

export const feedbackConversationGoalSchema = z
  .object({
    key: feedbackConversationGoalKeySchema,
    ordinal: z.number().int().positive(),
    prompt: z.string().trim().min(1).max(500),
    status: z.enum(["pending", "asked", "answered", "skipped"]),
  })
  .strict();

export const feedbackConversationStoredMessageSchema = z
  .object({
    id: z.uuid(),
    seq: z.number().int().positive(),
    actor: z.enum(["bot", "participant", "staff", "system"]),
    text: z
      .string()
      .trim()
      .min(1)
      .max(FEEDBACK_CONVERSATION_MESSAGE_MAX_STORED_TEXT_LENGTH),
    providerMessageId: z.string().trim().min(1).max(200).nullable(),
    ingressId: z.uuid().nullable(),
    outboxId: z.uuid().nullable(),
    /**
     * Optional-on-read migration: schema-v2 conversations written before the
     * attention taxonomy parse as `null`; every new append persists the field.
     */
    attention: feedbackConversationMessageAttentionSchema
      .nullable()
      .default(null),
    at: z.date(),
  })
  .strict()
  .superRefine((message, context) => {
    if (message.actor === "participant" && !message.ingressId) {
      context.addIssue({
        code: "custom",
        message: "A participant message requires its durable ingress id",
      });
    }
    if (message.actor === "participant" && message.outboxId) {
      context.addIssue({
        code: "custom",
        message: "A participant message cannot originate from the outbox",
      });
    }
    if (message.actor !== "participant" && message.attention) {
      context.addIssue({
        code: "custom",
        message: "Only participant messages can carry attention metadata",
      });
    }
    if (message.actor === "bot" && !message.outboxId) {
      context.addIssue({
        code: "custom",
        message: "A bot message requires its outbox id",
      });
    }
    if (message.actor === "staff" && !message.outboxId && !message.ingressId) {
      context.addIssue({
        code: "custom",
        message:
          "A staff message requires an outbox id or an observed ingress id",
      });
    }
    if (message.actor === "system" && (message.outboxId || message.ingressId)) {
      context.addIssue({
        code: "custom",
        message: "A system message has no transport provenance",
      });
    }
  });

/**
 * What every extraction run of one conversation has cost so far, per component.
 *
 * Each component is nullable on its own because a provider reports what it feels
 * like reporting: OpenRouter has returned an input count with no output count,
 * and the deterministic rehearsal stub reports nothing at all. A component that
 * was never reported by some run is `null` for the accumulated total too — see
 * the accumulation rule on `advanceCursor`. A number that quietly omitted one
 * run's share would be read as a bill, and it would be wrong; `null` is read by
 * `scripts/run-feedback-burst.mjs` as «cost unavailable», which is the honest
 * claim.
 */
export const feedbackConversationExtractionUsageSchema = z
  .object({
    inputTokens: z.number().int().min(0).nullable(),
    outputTokens: z.number().int().min(0).nullable(),
    totalTokens: z.number().int().min(0).nullable(),
  })
  .strict();

export const feedbackConversationExtractionSchema = z
  .object({
    cursorSeq: z.number().int().min(0),
    lastRunAt: z.date().nullable(),
    model: z.string().trim().min(1).max(200).nullable(),
    /**
     * Tokens accumulated across every run of this conversation, or null before
     * the first run that reached a model.
     *
     * Durable where `PostEventFeedbackMetrics.recordExtractTokens` is not: that
     * one logs, process-local, and a restart takes the rehearsal's bill with it.
     * A paid burst is read back off these documents hours later, so the number
     * has to survive the worker that produced it.
     *
     * Defaulted rather than required for the same reason `reminderCount` is —
     * every conversation written before today lacks the field, and a document
     * that will not parse is a conversation the inbox cannot show.
     */
    usage: feedbackConversationExtractionUsageSchema.nullable().default(null),
    /**
     * The service tier the **last** run bought, or null.
     *
     * Last-write-wins rather than accumulated: it is a property of a call, not a
     * quantity, and the only reader — the cost script — needs it to pick a price
     * table (`priority` selects OpenAI's fast-lane rates). Null covers both «no
     * tier configured» and «this model does not route through OpenAI», which are
     * the same fact as far as a price is concerned: the standard rate applies.
     *
     * Stored as a plain string rather than the `FeedbackExtractionServiceTier`
     * enum so that a document keeps parsing when that enum next changes. What is
     * on disk is a record of what was sent, not a promise about what is offered.
     */
    serviceTier: z.string().trim().min(1).max(50).nullable().default(null),
    /**
     * When this conversation was first parked on a provider incident, or null.
     *
     * Parking is what a terminal `provider_error` does instead of speaking to
     * the participant and asking for a person. The distinction it encodes is the
     * whole point: a content filter or a schema failure is something about *this*
     * conversation, while an unreachable provider or an exhausted balance is one
     * incident affecting every conversation at once. On 2026-07-27 the second
     * kind was handled as the first, and thirty-six rows each demanded a human
     * for a fault none of them caused.
     *
     * It is deliberately **not** `needsAttention` and **not** `awaitingHuman`:
     * nobody has to read a parked conversation, and the bot has promised nothing.
     * The operator surface is the campaign's parked count — one number for one
     * incident — and the detail pane's durable automation block, which reports
     * `parked` together with the aggregate's next action time.
     *
     * Timestamped rather than boolean because two decisions are measured from
     * it: when the participant is owed a word, and when re-queueing gives up.
     */
    parkedSince: z.date().nullable().default(null),
    /**
     * How many runs have parked since `parkedSince`. The reconciler uses this to
     * report retry progress without relying on retained queue rows.
     */
    parkedRuns: z.number().int().min(0).default(0),
    /**
     * When the participant was told, once, that something stuck on our side.
     *
     * Kept beside the park rather than inside it because it outlives it: like
     * `extractionFallbackAckSent`, it is **not** cleared when extraction
     * recovers. Somebody who has already had one apology from a machine does not
     * need a second one the next time the provider hiccups.
     */
    parkedNoticeSentAt: z.date().nullable().default(null),
  })
  .strict();

/**
 * Durable scheduling intent for the conversation reconciler.
 *
 * MongoDB owns whether the aggregate still wants work; PostgreSQL owns the
 * execution lease and its fencing token. `executionEpoch` is only the MongoDB
 * mirror of the epoch PostgreSQL granted, so a stale execution cannot settle a
 * newer one. Keeping the lease itself out of this document avoids two lock
 * authorities that can disagree after a crash.
 *
 * The field is optional on the enclosing document for the bridge release:
 * documents written before reconciliation remain readable. New writers persist
 * the complete object, and maintenance/backfill can mark legacy documents due
 * without reinterpreting their business state.
 */
export const feedbackConversationWorkSchema = z
  .object({
    /** Monotonic version of the durable work requested for this aggregate. */
    revision: z.number().int().min(0),
    /** Earliest time the current revision should be reconciled, or no intent. */
    nextActionAt: z.date().nullable(),
    /** Highest PostgreSQL execution epoch this aggregate has admitted. */
    executionEpoch: z.number().int().min(0),
    /**
     * Highest PostgreSQL campaign-resume generation admitted by this
     * aggregate. Optional for documents written before durable resume repair.
     */
    campaignResumeGeneration: z.number().int().min(0).optional(),
  })
  .strict();

export type FeedbackConversationWork = z.infer<
  typeof feedbackConversationWorkSchema
>;

export function resolveFeedbackConversationWork(
  work: FeedbackConversationWork | undefined,
): FeedbackConversationWork {
  return work ?? { revision: 0, nextActionAt: null, executionEpoch: 0 };
}

export const feedbackConversationDocumentSchema = z
  .object({
    _id: z.uuid(),
    schemaVersion: z.literal(FEEDBACK_CONVERSATION_SCHEMA_VERSION),
    purpose: z.literal(FEEDBACK_CONVERSATION_PURPOSE),
    channel: z.literal(FEEDBACK_CONVERSATION_CHANNEL),
    campaignId: z.uuid(),
    respondentParticipantId: z.uuid(),
    phoneAtLaunch: feedbackConversationPhoneSchema,
    lifecycle: feedbackConversationLifecycleSchema,
    control: feedbackConversationControlSchema,
    goals: z.array(feedbackConversationGoalSchema).min(1).max(10),
    messages: z
      .array(feedbackConversationStoredMessageSchema)
      .max(FEEDBACK_CONVERSATION_MAX_MESSAGES),
    extraction: feedbackConversationExtractionSchema,
    /** Optional-on-read bridge; every new conversation writes it explicitly. */
    work: feedbackConversationWorkSchema.optional(),
    needsAttention: z.boolean(),
    /**
     * Why it is asking for a person, newest last, resolved entries kept.
     *
     * `needsAttention` stays because the inbox counts and filters on it, but it
     * is now a summary of this list rather than the only record: it is true
     * exactly while some entry is unresolved. The list is what lets the admin
     * say *what* the problem is and link to the message that caused it, and
     * what lets an operator dismiss one reason without dismissing the rest.
     *
     * Defaulted rather than required so conversations written before the list
     * existed parse as "flagged, reason unknown" instead of failing validation.
     * Those are readable in the admin as a flag with nothing to show, which is
     * exactly what they are.
     */
    attentionReasons: z
      .array(feedbackConversationAttentionReasonSchema)
      .max(FEEDBACK_CONVERSATION_MAX_ATTENTION_REASONS)
      .default([]),
    /** When the most recent nudge was queued. `null` until the first one. */
    remindedAt: z.date().nullable(),
    /**
     * How many nudges have been sent, capped by `FEEDBACK_MAX_REMINDERS`.
     *
     * `remindedAt` alone cannot express the ladder: a single timestamp is
     * either set or not, so the second reminder could never be due and a
     * half-finished participant was asked once and then left. The count is the
     * ledger; the timestamp stays for the admin pane.
     *
     * Defaulted rather than required so conversations written before the
     * ladder existed parse as "never nudged" instead of failing validation.
     */
    reminderCount: z.number().int().min(0).max(10).default(0),
    /**
     * The bot has stopped talking and is waiting for a person to arrive.
     *
     * Four things set it: an explicit handoff, an urgent safety signal the bot
     * must not answer, a withdrawal, and the hostility exit line. They differ in
     * what was promised — only the first two promise anybody anything — and
     * agree on the one fact this flag carries, which is that the next message
     * must not restart the questionnaire.
     *
     * This is the state between the bot's last word and somebody pressing "take
     * over".
     * It had no representation, so control was still `bot`, every guard passed,
     * and the questionnaire resumed on the very next message — the participant
     * was told a human would be in touch and then asked again who they liked.
     *
     * Deliberately **not** `control.mode: "human"`: D17 says a handoff is a
     * promise and control moves when a person actually takes it. Nor
     * `needsAttention`, which is raised for routine operator work like a
     * subjectless note, and which the amended D13 pointedly does not treat as a
     * reason to stop the conversation.
     *
     * Cleared when a person engages — takes over, or hands back to the bot.
     */
    awaitingHuman: z.boolean().default(false),
    /**
     * How many extraction runs have now read a message abusive toward us.
     *
     * On the document because hostility accumulates across runs and a run holds
     * no memory of the last one: Μπάμπης Διπλογαμωσταυρίδης sent his four
     * clusters ninety seconds apart, which is four separate extractions, and
     * anything short of a stored number makes each of them the first.
     *
     * Counted per **run**, not per message. The thing being rationed is our
     * replies, and one burst of five insults draws one reply — so counting
     * messages would spend the whole allowance on somebody who typed fast, and
     * «two or three calm replies» would stop being true of what he experienced.
     *
     * A run that also produced safety signals never counts here, however heavy
     * its language: Ειρήνη Καταγγελού described being touched at the table, and
     * a counter that ticked on her wording would carry her to the exit line
     * three disclosures later. See `FEEDBACK_CALM_REPLIES_BEFORE_HOSTILITY_STOP`.
     *
     * Deliberately not derived from the `hostile_to_bot` attention reasons: an
     * operator dismissing one of those would silently return the bot's voice to
     * a conversation it had already given up on.
     *
     * Defaulted rather than required so conversations written before the counter
     * existed parse as "never hostile" instead of failing validation.
     */
    hostileTurns: z
      .number()
      .int()
      .min(0)
      .max(FEEDBACK_CONVERSATION_MAX_MESSAGES)
      .default(0),
    /**
     * The participant has already received the deterministic extraction-fallback
     * acknowledgement for this conversation.
     *
     * Provider outages can outlast several participant messages; each dead run
     * used to enqueue the same canned apology plus the current goal question,
     * which read as a machine looping at somebody who was still trying to
     * answer. After the first one goes out, later permanent failures still file
     * notes and raise attention, but the thread stays quiet until extraction
     * works again or a person takes over.
     *
     * Deliberately **not** cleared when extraction next succeeds: the
     * participant was already told once, and sending the same line again after
     * a brief recovery adds nothing — it only re-opens the "broken bot"
     * impression. A second outage late in the questionnaire is rarer than
     * sounding like a stuck recording.
     *
     * Defaulted rather than required so conversations written before the ledger
     * existed parse as "not yet acknowledged" instead of failing validation.
     */
    extractionFallbackAckSent: z.boolean().default(false),
    /**
     * Why a human closed this conversation, when they did.
     *
     * Null for every bot close (`completed` / `declined` / `stopped` / `expired`)
     * and for
     * conversations written before staff closes carried a reason. Cleared when
     * STOP overrides a softer close, so an abusive label cannot survive a
     * consent withdrawal that superseded it.
     *
     * Optional rather than defaulted: callers outside this inbox (extraction
     * fixtures, older documents) omit it, and the read model treats absence as
     * null. Writing always sets it explicitly on close.
     */
    staffClose: feedbackConversationStaffCloseSchema.nullable().optional(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .strict()
  .superRefine((conversation, context) => {
    if (conversation.updatedAt < conversation.createdAt) {
      context.addIssue({
        code: "custom",
        message: "Conversation updatedAt cannot precede createdAt",
      });
    }

    const goalKeys = new Set<string>();
    for (const [index, goal] of conversation.goals.entries()) {
      if (goalKeys.has(goal.key) || goal.ordinal !== index + 1) {
        context.addIssue({
          code: "custom",
          message:
            "Conversation goals require unique keys and contiguous ordered ordinals",
        });
        break;
      }
      goalKeys.add(goal.key);
    }

    const messageIds = new Set<string>();
    const provenanceIds = new Set<string>();
    const sequences = new Set<number>();
    for (const message of conversation.messages) {
      const provenance = [
        message.ingressId,
        message.outboxId,
        message.providerMessageId,
      ].filter((value): value is string => Boolean(value));
      // `seq` must be a contiguous 1..N set, but it is deliberately **not**
      // tied to the array index. Array order is what a human reads and follows
      // observation time, so an out-of-order webhook is shown where the
      // participant actually said it; `seq` is arrival order and is what the
      // extraction cursor advances through, so it must never be renumbered.
      // Binding the two meant the transcript could only be stored in the order
      // the provider happened to deliver.
      if (
        messageIds.has(message.id) ||
        sequences.has(message.seq) ||
        message.seq > conversation.messages.length ||
        message.at > conversation.updatedAt ||
        provenance.some((value) => provenanceIds.has(value))
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Conversation messages require unique ids, unique provenance, contiguous sequence numbers and conversation-bounded timestamps",
        });
        break;
      }
      sequences.add(message.seq);
      messageIds.add(message.id);
      for (const value of provenance) {
        provenanceIds.add(value);
      }
    }

    if (conversation.extraction.cursorSeq > conversation.messages.length) {
      context.addIssue({
        code: "custom",
        message: "The extraction cursor cannot pass the transcript",
      });
    }
  });

export type FeedbackConversationDocument = z.infer<
  typeof feedbackConversationDocumentSchema
>;
export type FeedbackConversationMessage = z.infer<
  typeof feedbackConversationStoredMessageSchema
>;
export type FeedbackConversationGoal = z.infer<
  typeof feedbackConversationGoalSchema
>;
export type FeedbackConversationLifecycleReason = NonNullable<
  FeedbackConversationDocument["lifecycle"]["reason"]
>;
export type FeedbackConversationStaffClose = NonNullable<
  NonNullable<FeedbackConversationDocument["staffClose"]>
>;
export type FeedbackConversationStaffCloseReason =
  FeedbackConversationStaffClose["reason"];
export type FeedbackConversationControlSource =
  FeedbackConversationDocument["control"]["source"];
export type FeedbackConversationExtractionUsage = z.infer<
  typeof feedbackConversationExtractionUsageSchema
>;

/**
 * The accumulation rule for `extraction.usage`, stated once.
 *
 * `advanceCursor` performs this inside an aggregation pipeline — the increment
 * has to be one atomic statement, so it cannot call a function — but this is the
 * normative spelling, and it is what the in-memory double runs. Anything reading
 * either one should read this comment.
 *
 * A `null` stored total means no run has reported yet, so the first report
 * becomes the total verbatim, nulls included. From then on **null is absorbing
 * in both directions**: a component that either side left unreported makes the
 * accumulated component null, and no later fully-reported run brings it back.
 * That permanence is the point. The tokens behind the gap were spent and never
 * counted; a sum that skipped them is not a smaller bill, it is a wrong one, and
 * `scripts/run-feedback-burst.mjs` reads null as «cost unavailable» — which is
 * the only thing we actually know.
 */
export function accumulateFeedbackExtractionUsage(
  stored: FeedbackConversationExtractionUsage | null,
  reported: FeedbackConversationExtractionUsage,
): FeedbackConversationExtractionUsage {
  if (!stored) {
    return { ...reported };
  }
  return {
    inputTokens: addReportedTokens(stored.inputTokens, reported.inputTokens),
    outputTokens: addReportedTokens(stored.outputTokens, reported.outputTokens),
    totalTokens: addReportedTokens(stored.totalTokens, reported.totalTokens),
  };
}

function addReportedTokens(
  prior: number | null,
  reported: number | null,
): number | null {
  return prior === null || reported === null ? null : prior + reported;
}
export type FeedbackConversationActor = FeedbackConversationMessage["actor"];

/**
 * Builds the ordered goal set from the versioned WP0 question definitions. The
 * campaign owns the copy snapshot taken at launch; the keys and their order
 * stay owned by the question set.
 */
export function buildFeedbackConversationGoals(
  copy?: PostEventFeedbackQuestionSetCopy,
  questionSetVersion: PostEventFeedbackQuestionSetVersion = CURRENT_POST_EVENT_FEEDBACK_QUESTION_SET_VERSION,
): FeedbackConversationGoal[] {
  const questionSet = getPostEventFeedbackQuestionSet(questionSetVersion);
  const resolvedCopy = copy ?? questionSet.copy;
  return questionSet.answerQuestions.map((question, index) =>
    feedbackConversationGoalSchema.parse({
      key: question.key,
      ordinal: index + 1,
      prompt: resolvedCopy[question.key],
      status: "pending",
    }),
  );
}

/**
 * Deterministic conversation identity: `uuidv5(campaignId, participantId)`.
 * Launch replay therefore collides on `_id` instead of creating a second
 * conversation, and at most one conversation per (campaign, participant) can
 * ever exist.
 */
export function deriveFeedbackConversationId(
  campaignId: string,
  respondentParticipantId: string,
): string {
  const namespace = z.uuid().parse(campaignId);
  const name = z.string().trim().min(1).parse(respondentParticipantId);
  return uuidV5(namespace, name);
}

/**
 * Stable identity for the STOP acknowledgement across the PostgreSQL/MongoDB
 * commit gap. If PostgreSQL rolls back after MongoDB records the lifecycle
 * anchor, ingress replay recreates the same id instead of producing an
 * acknowledgement the lifecycle can no longer authorize.
 */
export function deriveFeedbackStopAckOutboxId(conversationId: string): string {
  return uuidV5(z.uuid().parse(conversationId), "feedback-stop-ack");
}

function uuidV5(namespace: string, name: string): string {
  const digest = createHash("sha1")
    .update(uuidToBytes(namespace))
    .update(Buffer.from(name, "utf8"))
    .digest();
  const bytes = digest.subarray(0, 16);
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x50, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

function uuidToBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replaceAll("-", ""), "hex");
}

export const feedbackConversationSummarySchema = z
  .object({
    _id: z.uuid(),
    campaignId: z.uuid(),
    respondentParticipantId: z.uuid(),
    phoneAtLaunch: z.string().trim().min(1),
    lifecycle: z
      .object({
        state: z.enum(["open", "closed"]),
        reason: z.enum(FEEDBACK_CONVERSATION_LIFECYCLE_REASONS).nullable(),
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
    /**
     * Extraction is parked on a provider incident for this conversation.
     *
     * Projected into the list read for one reason: the campaign summary counts
     * it. A provider outage is one incident, so the operator gets one number for
     * the campaign rather than a badge on every row it touched.
     */
    extractionParked: z.boolean(),
    remindedAt: z.date().nullable(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .strict();

export type FeedbackConversationSummary = z.infer<
  typeof feedbackConversationSummarySchema
>;

/**
 * The narrowest projection that answers "who is this conversation with".
 *
 * Deliberately not `feedbackConversationSummarySchema`: the outbound-queue
 * screen resolves a page of conversation ids to people, and the summary's
 * goals, transcript counts and lifecycle would all be read and parsed for
 * nothing.
 */
export const feedbackConversationRespondentSchema = z
  .object({
    _id: z.uuid(),
    respondentParticipantId: z.uuid(),
    phoneAtLaunch: z.string().trim().min(1),
  })
  .strict();

export type FeedbackConversationRespondent = z.infer<
  typeof feedbackConversationRespondentSchema
>;

export function feedbackConversationFilter(
  id: string,
): Filter<FeedbackConversationDocument> {
  return {
    _id: id,
    schemaVersion: FEEDBACK_CONVERSATION_SCHEMA_VERSION,
    purpose: FEEDBACK_CONVERSATION_PURPOSE,
  } as Filter<FeedbackConversationDocument>;
}

/**
 * Goal progress is mostly a monotonic ladder. `answered` outranks everything
 * and never demotes — D16. `skipped → asked` is the one deliberate step down:
 * a sent hold question re-opens a skip the bot itself just banked (WP-9δ).
 */
const GOAL_STATUS_RANK: Record<FeedbackConversationGoal["status"], number> = {
  pending: 0,
  asked: 1,
  skipped: 2,
  answered: 3,
};

/**
 * The in-memory mirror of the `$sort` the `$push` applies, so the returned
 * document matches what MongoDB now holds without a second read.
 *
 * `seq` breaks the tie, which keeps the order total: two fragments can share an
 * observation timestamp, and an unstable sort there would make the transcript
 * differ between two readers of the same conversation.
 */
export function sortTranscript(
  messages: readonly FeedbackConversationMessage[],
): FeedbackConversationMessage[] {
  return [...messages].sort(
    (left, right) =>
      left.at.getTime() - right.at.getTime() || left.seq - right.seq,
  );
}

export function goalStatusRank(
  status: FeedbackConversationGoal["status"],
): number {
  return GOAL_STATUS_RANK[status];
}

/**
 * Whether a goal may move from `from` to `to`.
 *
 * Rank-up is always allowed. The sole demotion is `skipped → asked`: the bot
 * re-opened a decline with a question-shaped reply (`askedGoal` on a sent
 * outbound). `answered → *` never succeeds — a recorded answer is not a
 * question again.
 */
export function canTransitionGoalStatus(
  from: FeedbackConversationGoal["status"],
  to: FeedbackConversationGoal["status"],
): boolean {
  if (from === to) {
    return false;
  }
  if (from === "skipped" && to === "asked") {
    return true;
  }
  return goalStatusRank(to) > goalStatusRank(from);
}

/**
 * Statuses the Mongo array filter accepts when writing `status` — every prior
 * state `canTransitionGoalStatus` allows, including the skipped→asked reopen.
 */
export function lowerGoalStatuses(
  status: FeedbackConversationGoal["status"],
): FeedbackConversationGoal["status"][] {
  return (
    Object.keys(GOAL_STATUS_RANK) as FeedbackConversationGoal["status"][]
  ).filter((candidate) => canTransitionGoalStatus(candidate, status));
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

export function messageIdentityKeys(message: {
  readonly id?: string | undefined;
  readonly ingressId?: string | null | undefined;
  readonly outboxId?: string | null | undefined;
}): string[] {
  return [message.id, message.ingressId, message.outboxId].filter(
    (value): value is string => Boolean(value),
  );
}

export function assertMessageIdentity(
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

export function exceedsCapacity(
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
