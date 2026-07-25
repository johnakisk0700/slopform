import { z } from "zod";

import { FEEDBACK_CONVERSATION_MESSAGE_MAX_TEXT_LENGTH } from "../conversations/feedback-conversation.schemas.js";

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

export const feedbackCorrelationIdSchema = z.string().min(1).max(128);

export const feedbackMaterializeJobDataSchema = z
  .object({
    schemaVersion: z.literal(FEEDBACK_JOB_SCHEMA_VERSION),
    ingressId: z.uuid(),
    correlationId: feedbackCorrelationIdSchema,
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
    correlationId: feedbackCorrelationIdSchema,
  })
  .strict();

export const feedbackRelayJobDataSchema = z
  .object({
    schemaVersion: z.literal(FEEDBACK_JOB_SCHEMA_VERSION),
    correlationId: feedbackCorrelationIdSchema,
  })
  .strict();

export const feedbackDeliverJobDataSchema = z
  .object({
    schemaVersion: z.literal(FEEDBACK_JOB_SCHEMA_VERSION),
    outboxId: z.uuid(),
    correlationId: feedbackCorrelationIdSchema,
  })
  .strict();

/** Identifier-only sweep envelope: the worker reloads every authoritative fact. */
export const feedbackSweepJobDataSchema = z
  .object({
    schemaVersion: z.literal(FEEDBACK_JOB_SCHEMA_VERSION),
    correlationId: feedbackCorrelationIdSchema,
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

/** Stable deliver job key: the outbox row id is the durable idempotency token. */
export function createFeedbackDeliverJobId(outboxId: string): string {
  return `feedback-deliver-v1-${outboxId}`;
}

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
      .max(FEEDBACK_CONVERSATION_MESSAGE_MAX_TEXT_LENGTH)
      .nullable(),
    observedAt: z.date(),
  })
  .strict();

export type ObservedProviderMessage = z.infer<
  typeof observedProviderMessageSchema
>;

/**
 * Bounds untrusted provider text to WhatsApp's own text-body limit, which is
 * also the transcript bound. An empty body (media, reaction, sticker) becomes
 * `null` metadata instead of an unusable empty message.
 */
export function boundObservedMessageText(
  text: string | null | undefined,
): string | null {
  const trimmed = text?.trim() ?? "";
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed.slice(0, FEEDBACK_CONVERSATION_MESSAGE_MAX_TEXT_LENGTH);
}
