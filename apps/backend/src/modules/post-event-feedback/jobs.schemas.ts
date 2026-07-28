import { createHash } from "node:crypto";

import { z } from "zod";

import { correlationIdSchema } from "../../infrastructure/auth/auth.schemas.js";
import { FEEDBACK_CONVERSATION_MESSAGE_MAX_TEXT_LENGTH } from "./post-event-feedback-conversation.document.js";

/**
 * Versioned `feedback` queue contract. Both payloads are identifier-only: the
 * processor reloads every authoritative fact from PostgreSQL and MongoDB, so a
 * job never carries participant text, phone numbers or provider credentials.
 */
export const FEEDBACK_JOB_NAMES = {
  materializeV1: "feedback.materialize.v1",
  extractV1: "feedback.extract.v1",
  relayOutboxV1: "feedback.relay-outbox.v1",
  deliverV1: "feedback.deliver.v1",
  sweepRemindersV1: "feedback.sweep-reminders.v1",
  sweepExpiryV1: "feedback.sweep-expiry.v1",
  sweepIngressV1: "feedback.sweep-ingress.v1",
} as const;

export const FEEDBACK_JOB_SCHEMA_VERSION = 1;

export const feedbackMaterializeJobDataSchema = z
  .object({
    schemaVersion: z.literal(FEEDBACK_JOB_SCHEMA_VERSION),
    ingressId: z.uuid(),
    correlationId: correlationIdSchema,
  })
  .strict();

/**
 * WP5 owns the extraction processor. WP4 owns only the contract and the
 * enqueue, so the job name, payload and deterministic id cannot drift when the
 * consumer lands.
 */
export const feedbackExtractJobDataSchema = z
  .object({
    schemaVersion: z.literal(FEEDBACK_JOB_SCHEMA_VERSION),
    conversationId: z.uuid(),
    correlationId: correlationIdSchema,
  })
  .strict();

export const feedbackRelayJobDataSchema = z
  .object({
    schemaVersion: z.literal(FEEDBACK_JOB_SCHEMA_VERSION),
    correlationId: correlationIdSchema,
  })
  .strict();

export const feedbackDeliverJobDataSchema = z
  .object({
    schemaVersion: z.literal(FEEDBACK_JOB_SCHEMA_VERSION),
    outboxId: z.uuid(),
    correlationId: correlationIdSchema,
  })
  .strict();

/** Identifier-only sweep envelope: the worker reloads every authoritative fact. */
export const feedbackSweepJobDataSchema = z
  .object({
    schemaVersion: z.literal(FEEDBACK_JOB_SCHEMA_VERSION),
    correlationId: correlationIdSchema,
  })
  .strict();

export type FeedbackMaterializeJobData = z.infer<
  typeof feedbackMaterializeJobDataSchema
>;
export type FeedbackExtractJobData = z.infer<
  typeof feedbackExtractJobDataSchema
>;
export type FeedbackRelayJobData = z.infer<typeof feedbackRelayJobDataSchema>;
export type FeedbackDeliverJobData = z.infer<
  typeof feedbackDeliverJobDataSchema
>;
export type FeedbackSweepJobData = z.infer<typeof feedbackSweepJobDataSchema>;
export type FeedbackJobData =
  | FeedbackMaterializeJobData
  | FeedbackExtractJobData
  | FeedbackRelayJobData
  | FeedbackDeliverJobData
  | FeedbackSweepJobData;
export type FeedbackJobName =
  (typeof FEEDBACK_JOB_NAMES)[keyof typeof FEEDBACK_JOB_NAMES];

export function createFeedbackMaterializeJobId(ingressId: string): string {
  return `feedback-materialize-v1-${ingressId}`;
}

/**
 * How long an extraction run waits before it reads the transcript.
 *
 * WhatsApp is typed, not dictated: one thought routinely arrives as «τον Νίκο
 * τον βρήκα» / «πολύ καλό, 5». Answering the first fragment costs a model call,
 * sends a reply to half a sentence and leaves the other half to be understood
 * without its own beginning. Waiting is the whole fix — the run then opens on a
 * finished thought.
 *
 * It is a leading-edge window, not a rolling debounce: the first message starts
 * the clock and everything typed inside it collapses into one run. A rolling
 * timer would need `remove` + re-`add`, which races an already-active job for a
 * case the fixed window mostly covers anyway.
 *
 * That shape sets the value. Collapse depends on how long the burst takes, not
 * on how many messages it contains, so a window shorter than an ordinary typing
 * pause collapses nothing: at 12s, somebody sending a fragment every 20 seconds
 * opened a run — and got a reply — for every single one. 45s covers ordinary
 * WhatsApp typing. Somebody composing for two minutes still splits, which is
 * inherent to a fixed window and accepted; latency here is free, so the value
 * can rise again if real traffic says it should.
 *
 * The delay costs nothing in correctness. The run reads the transcript live and
 * a superseded job already has a free exit through the extraction cursor, so a
 * later position simply finds its work done. It also makes STOP cheaper: STOP is
 * applied by the materializer and closes the conversation, and a waiting run
 * then exits on `skipped_closed` without ever calling the provider.
 */
export const FEEDBACK_EXTRACT_QUIET_WINDOW_MS = 45_000;

/**
 * Extraction is serialized per conversation by transcript position, so a burst
 * of inbound messages collapses onto the newest transcript state instead of
 * queueing one model run per message.
 */
export function createFeedbackExtractJobId(
  conversationId: string,
  latestSeq: number,
): string {
  return `feedback-extract-v1-${conversationId}-${latestSeq}`;
}

/**
 * How long a run parked on a provider incident waits before trying again.
 *
 * The queue's own ladder is five attempts of exponential backoff from one
 * second, so it is spent inside twenty seconds — long enough for a blip,
 * nowhere near long enough for an outage, a rate-limit ceiling or an empty
 * balance. Once those attempts are gone nothing re-reads the conversation, and
 * on 2026-07-27 that is why thirty-six conversations needed a person: not
 * because the testimony was hard, but because the only ladder we had was
 * twenty seconds long.
 *
 * Five minutes is chosen against what actually ends an incident: somebody
 * topping up an account, a provider recovering, a model id corrected on a
 * deploy. All of those are minutes, so retrying faster only bills failures. It
 * also has to be comfortably shorter than
 * `FEEDBACK_EXTRACTION_PARK_NOTICE_AFTER_MS`, because a parked run waking up is
 * what notices that the participant is owed a word.
 */
export const FEEDBACK_EXTRACTION_PARK_RETRY_MS = 5 * 60_000;

/**
 * How long a conversation keeps re-queueing before it stops asking.
 *
 * A ceiling, not a diagnosis. Six hours of five-minute retries is roughly
 * seventy attempts, which is long enough to cover any outage somebody is
 * actually working on and short enough that a misconfigured model id does not
 * bill a request every five minutes for a week. It is well inside
 * `FEEDBACK_EXPIRE_AFTER_HOURS`, so the expiry sweep is not racing it.
 *
 * Reaching it changes nothing the participant can see: the conversation stays
 * parked and stays in the campaign's parked count, which is the number an
 * operator reads. It stops only the re-queueing.
 */
export const FEEDBACK_EXTRACTION_PARK_MAX_MS = 6 * 3_600_000;

/**
 * The retry a parked run queues for itself.
 *
 * A separate id from the run that parked, because that one is *this* job: BullMQ
 * refuses a second `add` for an id it still holds, and it holds this one until
 * the failure that is about to be thrown. The park counter is what keeps
 * successive retries distinct, and it is stored on the conversation, so the
 * inbox can derive the id of the retry currently outstanding and report its due
 * time honestly instead of showing a conversation that failed and stopped.
 */
export function createFeedbackExtractParkedJobId(
  conversationId: string,
  latestSeq: number,
  parkedRun: number,
): string {
  return `feedback-extract-v1-${conversationId}-${latestSeq}-parked-${parkedRun}`;
}

/** Stable deliver job key: the outbox row id is the durable idempotency token. */
export function createFeedbackDeliverJobId(outboxId: string): string {
  return `feedback-deliver-v1-${outboxId}`;
}

/**
 * The upper bound on an observed body, as a defence against an absurd payload
 * rather than a formatting rule.
 *
 * It is deliberately far above the transcript's own 4 096-character limit. The
 * `provider_message_ingress.text` column is unbounded PostgreSQL text, so
 * nothing forces the durable record down to the transcript's size — and the two
 * limits used to be the same number, which meant a long message was cut at the
 * webhook edge before anything durable was written, silently, at both edges.
 * The tail is where somebody puts what they worked up to saying.
 */
export const FEEDBACK_OBSERVED_TEXT_HARD_LIMIT = 64_000;

/**
 * Application-level contract for one observed provider message. The Wasender
 * adapter and the later development simulator both normalize into this shape;
 * neither writes provider payloads into the durable stores directly.
 */
export const observedProviderMessageSchema = z
  .object({
    providerMessageId: z.string().trim().min(1).max(200),
    chatJid: z.string().trim().min(1).max(200),
    direction: z.enum(["inbound", "outbound"]),
    phoneE164: z
      .string()
      .regex(/^\+[1-9]\d{7,14}$/u, "Expected an E.164 phone number")
      .nullable(),
    text: z
      .string()
      .trim()
      .min(1)
      .max(FEEDBACK_OBSERVED_TEXT_HARD_LIMIT)
      .nullable(),
    observedAt: z.date(),
  })
  .strict();

export type ObservedProviderMessage = z.infer<
  typeof observedProviderMessageSchema
>;

/**
 * Normalizes untrusted provider text for the durable ingress row. An empty body
 * (media, reaction, sticker) becomes `null` metadata instead of an unusable
 * empty message; anything else is kept whole.
 *
 * Fitting the transcript is a separate concern, handled where the transcript is
 * written, so that a message too long to render is still a message we hold.
 */
/**
 * Marks an observed body that arrived under a provider message id we have
 * already acknowledged, with different words.
 *
 * WhatsApp lets people edit what they sent, and a provider may redeliver the
 * same id with the corrected text. `(chat_jid, provider_message_id)` is unique,
 * so the second delivery hit `ON CONFLICT DO NOTHING` and the correction
 * evaporated — a participant deliberately fixed «ο Κώστας ήταν χάλια» to «ο
 * Κώστας τελικά ήταν οκ», about a real person, and we kept the first version.
 *
 * The suffix is derived from the text, so the same edit redelivered twice
 * collapses on the unique key exactly as an ordinary duplicate does, while a
 * *different* edit gets its own row. The whole id stays inside the column's
 * 200-character bound.
 */
export function createFeedbackEditedProviderMessageId(
  providerMessageId: string,
  text: string,
): string {
  const digest = createHash("sha256").update(text).digest("hex").slice(0, 12);
  const suffix = `${EDITED_PROVIDER_MESSAGE_MARKER}${digest}`;
  return `${providerMessageId.slice(0, 200 - suffix.length)}${suffix}`;
}

export function isFeedbackEditedProviderMessageId(
  providerMessageId: string,
): boolean {
  return providerMessageId.includes(EDITED_PROVIDER_MESSAGE_MARKER);
}

const EDITED_PROVIDER_MESSAGE_MARKER = "#edited-";

export function boundObservedMessageText(
  text: string | null | undefined,
): string | null {
  const trimmed = text?.trim() ?? "";
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed.slice(0, FEEDBACK_OBSERVED_TEXT_HARD_LIMIT);
}
