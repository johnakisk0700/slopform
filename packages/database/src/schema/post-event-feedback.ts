import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { events } from "./events.js";
import { participants } from "./participants.js";

export const FEEDBACK_CAMPAIGN_STATUSES = [
  "launched",
  "paused",
  "closed",
] as const;

export type FeedbackCampaignStatus =
  (typeof FEEDBACK_CAMPAIGN_STATUSES)[number];

export const FEEDBACK_ANSWER_QUESTION_KEYS = [
  "event_score",
  "liked",
  "meet_again",
  "avoid",
] as const;

export type FeedbackAnswerQuestionKey =
  (typeof FEEDBACK_ANSWER_QUESTION_KEYS)[number];

export const FEEDBACK_NOTE_TYPES = ["activity_interest", "general"] as const;

export type FeedbackNoteType = (typeof FEEDBACK_NOTE_TYPES)[number];

export const FEEDBACK_NOTE_STATUSES = ["new", "dismissed"] as const;

export type FeedbackNoteStatus = (typeof FEEDBACK_NOTE_STATUSES)[number];

export const PROVIDER_MESSAGE_DIRECTIONS = ["inbound", "outbound"] as const;

export type ProviderMessageDirection =
  (typeof PROVIDER_MESSAGE_DIRECTIONS)[number];

export const PROVIDER_MESSAGE_PROCESSING_STATUSES = [
  "pending",
  "materialized",
  "ignored_unmatched",
  "failed",
] as const;

export type ProviderMessageProcessingStatus =
  (typeof PROVIDER_MESSAGE_PROCESSING_STATUSES)[number];

export const MESSAGE_OUTBOX_KINDS = [
  "intro",
  "reply",
  "reminder",
  "staff",
  "system",
] as const;

export type MessageOutboxKind = (typeof MESSAGE_OUTBOX_KINDS)[number];

export const MESSAGE_OUTBOX_STATUSES = [
  "pending",
  "held",
  "sending",
  "sent",
  "failed",
  "cancelled",
] as const;

export type MessageOutboxStatus = (typeof MESSAGE_OUTBOX_STATUSES)[number];

export const MESSAGE_OUTBOX_DELIVERY_STATUSES = [
  "error",
  "pending",
  "sent",
  "delivered",
  "read",
  "played",
] as const;

export type MessageOutboxDeliveryStatus =
  (typeof MESSAGE_OUTBOX_DELIVERY_STATUSES)[number];

/** Launch-time question copy and structure stored on the campaign row. */
export type FeedbackCampaignQuestions = Record<string, unknown>;

/**
 * Where a recorded answer or note came from. Absent on rows written before the
 * field existed, which are all extraction output. `staff` is the one origin
 * that is not derived from participant testimony at all.
 */
export const FEEDBACK_EXTRACTION_ORIGIN_STAFF = "staff";

/**
 * Extraction provenance recorded with each answer/note (D12). `candidateIds`
 * is the live D16 set supplied to that run.
 */
export type FeedbackExtractionMeta = {
  readonly model?: string;
  readonly confidence?: number;
  readonly origin?: string;
  readonly candidateIds: readonly string[];
  readonly [key: string]: unknown;
};

export const feedbackCampaigns = pgTable(
  "feedback_campaigns",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventId: uuid("event_id").notNull(),
    questionSetVersion: integer("question_set_version").notNull(),
    questions: jsonb("questions").$type<FeedbackCampaignQuestions>().notNull(),
    status: text("status").notNull().default("launched"),
    launchedAt: timestamp("launched_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    launchedBy: text("launched_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.eventId],
      foreignColumns: [events.id],
      name: "feedback_campaigns_event_id_events_id_fk",
    }).onDelete("restrict"),
    check(
      "feedback_campaigns_question_set_version_check",
      sql`${table.questionSetVersion} >= 1`,
    ),
    check(
      "feedback_campaigns_questions_object_check",
      sql`jsonb_typeof(${table.questions}) = 'object'`,
    ),
    check(
      "feedback_campaigns_status_check",
      sql`${table.status} in ('launched', 'paused', 'closed')`,
    ),
    check(
      "feedback_campaigns_launched_by_length_check",
      sql`char_length(btrim(${table.launchedBy})) between 1 and 200`,
    ),
    uniqueIndex("feedback_campaigns_event_id_uidx").on(table.eventId),
    index("feedback_campaigns_status_launched_at_idx").on(
      table.status,
      table.launchedAt,
    ),
  ],
);

export const feedbackAnswers = pgTable(
  "feedback_answers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    campaignId: uuid("campaign_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    respondentParticipantId: uuid("respondent_participant_id").notNull(),
    subjectParticipantId: uuid("subject_participant_id"),
    questionKey: text("question_key").notNull(),
    valueInt: integer("value_int"),
    sourceMessageIds: uuid("source_message_ids").array().notNull(),
    extractionMeta: jsonb("extraction_meta")
      .$type<FeedbackExtractionMeta>()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.campaignId],
      foreignColumns: [feedbackCampaigns.id],
      name: "feedback_answers_campaign_id_feedback_campaigns_id_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.respondentParticipantId],
      foreignColumns: [participants.id],
      name: "feedback_answers_respondent_participant_id_participants_id_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.subjectParticipantId],
      foreignColumns: [participants.id],
      name: "feedback_answers_subject_participant_id_participants_id_fk",
    }).onDelete("restrict"),
    check(
      "feedback_answers_question_key_check",
      sql`${table.questionKey} in ('event_score', 'liked', 'meet_again', 'avoid')`,
    ),
    check(
      "feedback_answers_value_int_check",
      sql`${table.valueInt} is null or ${table.valueInt} between 1 and 5`,
    ),
    check(
      "feedback_answers_source_message_ids_check",
      sql`cardinality(${table.sourceMessageIds}) >= 1`,
    ),
    check(
      "feedback_answers_extraction_meta_object_check",
      sql`jsonb_typeof(${table.extractionMeta}) = 'object'`,
    ),
    unique("feedback_answers_conversation_question_subject_uidx")
      .on(table.conversationId, table.questionKey, table.subjectParticipantId)
      .nullsNotDistinct(),
    index("feedback_answers_campaign_respondent_idx").on(
      table.campaignId,
      table.respondentParticipantId,
    ),
    index("feedback_answers_campaign_subject_idx").on(
      table.campaignId,
      table.subjectParticipantId,
    ),
    index("feedback_answers_conversation_idx").on(table.conversationId),
  ],
);

export const feedbackNotes = pgTable(
  "feedback_notes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    campaignId: uuid("campaign_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    respondentParticipantId: uuid("respondent_participant_id").notNull(),
    subjectParticipantId: uuid("subject_participant_id"),
    noteType: text("note_type").notNull(),
    text: text("text").notNull(),
    sourceMessageIds: uuid("source_message_ids").array().notNull(),
    extractionMeta: jsonb("extraction_meta")
      .$type<FeedbackExtractionMeta>()
      .notNull(),
    status: text("status").notNull().default("new"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.campaignId],
      foreignColumns: [feedbackCampaigns.id],
      name: "feedback_notes_campaign_id_feedback_campaigns_id_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.respondentParticipantId],
      foreignColumns: [participants.id],
      name: "feedback_notes_respondent_participant_id_participants_id_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.subjectParticipantId],
      foreignColumns: [participants.id],
      name: "feedback_notes_subject_participant_id_participants_id_fk",
    }).onDelete("restrict"),
    check(
      "feedback_notes_note_type_check",
      sql`${table.noteType} in ('activity_interest', 'general')`,
    ),
    check(
      "feedback_notes_text_length_check",
      sql`char_length(btrim(${table.text})) between 1 and 500`,
    ),
    // A note that claims conversation provenance must cite the message it came
    // from. A staff note cites nothing because nothing was said: an operator
    // typed it, and `extraction_meta.origin` is what says so.
    check(
      "feedback_notes_source_message_ids_check",
      sql`cardinality(${table.sourceMessageIds}) >= 1 or ${table.extractionMeta}->>'origin' = 'staff'`,
    ),
    check(
      "feedback_notes_extraction_meta_object_check",
      sql`jsonb_typeof(${table.extractionMeta}) = 'object'`,
    ),
    check(
      "feedback_notes_status_check",
      sql`${table.status} in ('new', 'dismissed')`,
    ),
    index("feedback_notes_campaign_respondent_idx").on(
      table.campaignId,
      table.respondentParticipantId,
    ),
    index("feedback_notes_campaign_subject_idx").on(
      table.campaignId,
      table.subjectParticipantId,
    ),
    index("feedback_notes_conversation_idx").on(table.conversationId),
    index("feedback_notes_status_idx").on(table.status),
  ],
);

export const providerMessageIngress = pgTable(
  "provider_message_ingress",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    providerMessageId: text("provider_message_id").notNull(),
    chatJid: text("chat_jid").notNull(),
    direction: text("direction").notNull(),
    phoneE164: text("phone_e164"),
    text: text("text"),
    observedAt: timestamp("observed_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    processingStatus: text("processing_status").notNull().default("pending"),
    matchedConversationId: uuid("matched_conversation_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "provider_message_ingress_provider_message_id_length_check",
      sql`char_length(btrim(${table.providerMessageId})) between 1 and 200`,
    ),
    check(
      "provider_message_ingress_chat_jid_length_check",
      sql`char_length(btrim(${table.chatJid})) between 1 and 200`,
    ),
    check(
      "provider_message_ingress_direction_check",
      sql`${table.direction} in ('inbound', 'outbound')`,
    ),
    check(
      "provider_message_ingress_phone_e164_check",
      sql`${table.phoneE164} is null or ${table.phoneE164} ~ '^\\+[1-9][0-9]{1,14}$'`,
    ),
    check(
      "provider_message_ingress_text_length_check",
      sql`${table.text} is null or char_length(${table.text}) between 1 and 10000`,
    ),
    check(
      "provider_message_ingress_processing_status_check",
      sql`${table.processingStatus} in ('pending', 'materialized', 'ignored_unmatched', 'failed')`,
    ),
    // D10, amended. An unmatched row still links to no conversation — nothing
    // said from a number we cannot identify is ever attributed to a
    // participant. It may now keep its body, because the rule that also
    // deleted it turned out to destroy the case that actually happens: somebody
    // signed up with an old number and replies from the new one, and «σόρρυ
    // άλλαξα νούμερο. 5, ο Νίκος ήταν φοβερός» was erased on arrival while
    // their real conversation was nudged at a number nobody reads.
    check(
      "provider_message_ingress_unmatched_text_check",
      sql`(${table.processingStatus} = 'ignored_unmatched' and ${table.matchedConversationId} is null) or (${table.processingStatus} <> 'ignored_unmatched')`,
    ),
    uniqueIndex("provider_message_ingress_chat_provider_uidx").on(
      table.chatJid,
      table.providerMessageId,
    ),
    index("provider_message_ingress_processing_observed_idx").on(
      table.processingStatus,
      table.observedAt,
    ),
    index("provider_message_ingress_matched_conversation_idx").on(
      table.matchedConversationId,
    ),
  ],
);

export const messageOutbox = pgTable(
  "message_outbox",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id").notNull(),
    campaignId: uuid("campaign_id").notNull(),
    kind: text("kind").notNull(),
    body: text("body").notNull(),
    status: text("status").notNull().default("pending"),
    dedupeKey: text("dedupe_key").notNull(),
    createdByStaff: text("created_by_staff"),
    providerLogId: text("provider_log_id"),
    providerMessageId: text("provider_message_id"),
    deliveryStatus: text("delivery_status"),
    sentAt: timestamp("sent_at", { withTimezone: true, mode: "date" }),
    deliveredAt: timestamp("delivered_at", {
      withTimezone: true,
      mode: "date",
    }),
    readAt: timestamp("read_at", { withTimezone: true, mode: "date" }),
    playedAt: timestamp("played_at", { withTimezone: true, mode: "date" }),
    deliveryUpdatedAt: timestamp("delivery_updated_at", {
      withTimezone: true,
      mode: "date",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.campaignId],
      foreignColumns: [feedbackCampaigns.id],
      name: "message_outbox_campaign_id_feedback_campaigns_id_fk",
    }).onDelete("restrict"),
    check(
      "message_outbox_kind_check",
      sql`${table.kind} in ('intro', 'reply', 'reminder', 'staff', 'system')`,
    ),
    check(
      "message_outbox_body_length_check",
      sql`char_length(btrim(${table.body})) between 1 and 10000`,
    ),
    check(
      "message_outbox_status_check",
      sql`${table.status} in ('pending', 'held', 'sending', 'sent', 'failed', 'cancelled')`,
    ),
    check(
      "message_outbox_dedupe_key_length_check",
      sql`char_length(btrim(${table.dedupeKey})) between 1 and 200`,
    ),
    check(
      "message_outbox_created_by_staff_length_check",
      sql`${table.createdByStaff} is null or char_length(btrim(${table.createdByStaff})) between 1 and 200`,
    ),
    check(
      "message_outbox_provider_log_id_length_check",
      sql`${table.providerLogId} is null or char_length(btrim(${table.providerLogId})) between 1 and 200`,
    ),
    check(
      "message_outbox_provider_message_id_length_check",
      sql`${table.providerMessageId} is null or char_length(btrim(${table.providerMessageId})) between 1 and 200`,
    ),
    check(
      "message_outbox_delivery_status_check",
      sql`${table.deliveryStatus} is null or ${table.deliveryStatus} in ('error', 'pending', 'sent', 'delivered', 'read', 'played')`,
    ),
    uniqueIndex("message_outbox_dedupe_key_uidx").on(table.dedupeKey),
    index("message_outbox_conversation_created_idx").on(
      table.conversationId,
      table.createdAt,
    ),
    index("message_outbox_campaign_status_idx").on(
      table.campaignId,
      table.status,
    ),
    index("message_outbox_status_created_idx").on(
      table.status,
      table.createdAt,
    ),
    index("message_outbox_provider_message_id_idx").on(table.providerMessageId),
  ],
);

export type FeedbackCampaignRow = typeof feedbackCampaigns.$inferSelect;
export type FeedbackAnswerRow = typeof feedbackAnswers.$inferSelect;
export type FeedbackNoteRow = typeof feedbackNotes.$inferSelect;
export type ProviderMessageIngressRow =
  typeof providerMessageIngress.$inferSelect;
export type MessageOutboxRow = typeof messageOutbox.$inferSelect;
