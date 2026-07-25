import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const PARTICIPANT_AGE_BANDS = [
  "18_24",
  "25_34",
  "35_44",
  "45_54",
  "55_plus",
] as const;

export const PARTICIPANT_NEIGHBORHOODS = [
  "kolonaki",
  "koukaki",
  "exarcheia",
  "pangrati",
  "glyfada",
  "chalandri",
  "psyrri",
  "nea_smyrni",
  "marousi",
  "petralona",
] as const;

export const PARTICIPANT_INTERESTS = [
  "travel",
  "cooking_food",
  "art_music",
  "sports",
  "technology",
  "books",
  "cinema",
  "entrepreneurship",
  "nature_outdoors",
  "board_games",
] as const;

export const participants = pgTable(
  "participants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    preferredName: text("preferred_name"),
    emailNormalized: text("email_normalized").notNull(),
    phoneE164: text("phone_e164"),
    ageBand: text("age_band"),
    preferredNeighborhood: text("preferred_neighborhood"),
    conversationStyle: smallint("conversation_style"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "participants_preferred_name_length_check",
      sql`char_length(btrim(${table.preferredName})) between 1 and 120`,
    ),
    check(
      "participants_email_normalized_check",
      sql`char_length(${table.emailNormalized}) between 3 and 320 and ${table.emailNormalized} = lower(btrim(${table.emailNormalized}))`,
    ),
    check(
      "participants_phone_e164_check",
      sql`${table.phoneE164} ~ '^\\+[1-9][0-9]{7,14}$'`,
    ),
    check(
      "participants_age_band_check",
      sql`${table.ageBand} in ('18_24', '25_34', '35_44', '45_54', '55_plus')`,
    ),
    check(
      "participants_preferred_neighborhood_check",
      sql`${table.preferredNeighborhood} in ('kolonaki', 'koukaki', 'exarcheia', 'pangrati', 'glyfada', 'chalandri', 'psyrri', 'nea_smyrni', 'marousi', 'petralona')`,
    ),
    check(
      "participants_conversation_style_check",
      sql`${table.conversationStyle} between 1 and 5`,
    ),
    uniqueIndex("participants_email_normalized_uidx").on(table.emailNormalized),
    index("participants_matching_idx").on(
      table.preferredNeighborhood,
      table.ageBand,
    ),
  ],
);

export const participantInterests = pgTable(
  "participant_interests",
  {
    participantId: uuid("participant_id")
      .notNull()
      .references(() => participants.id, { onDelete: "cascade" }),
    interest: text("interest").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.participantId, table.interest],
      name: "participant_interests_pk",
    }),
    check(
      "participant_interests_interest_check",
      sql`${table.interest} in ('travel', 'cooking_food', 'art_music', 'sports', 'technology', 'books', 'cinema', 'entrepreneurship', 'nature_outdoors', 'board_games')`,
    ),
    index("participant_interests_interest_idx").on(
      table.interest,
      table.participantId,
    ),
  ],
);

export const participantSourceRecords = pgTable(
  "participant_source_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    participantId: uuid("participant_id")
      .notNull()
      .references(() => participants.id, { onDelete: "cascade" }),
    sourceSystem: text("source_system").notNull(),
    sourceRecordId: text("source_record_id").notNull(),
    sourceUserId: text("source_user_id"),
    sourceUpdatedAt: timestamp("source_updated_at", {
      withTimezone: true,
      mode: "date",
    }),
    payloadHash: text("payload_hash").notNull(),
    importedAt: timestamp("imported_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "participant_source_records_source_system_length_check",
      sql`char_length(btrim(${table.sourceSystem})) between 1 and 64`,
    ),
    check(
      "participant_source_records_source_record_id_length_check",
      sql`char_length(btrim(${table.sourceRecordId})) between 1 and 200`,
    ),
    check(
      "participant_source_records_source_user_id_length_check",
      sql`char_length(btrim(${table.sourceUserId})) between 1 and 200`,
    ),
    check(
      "participant_source_records_payload_hash_check",
      sql`${table.payloadHash} ~ '^[0-9a-f]{64}$'`,
    ),
    uniqueIndex("participant_source_records_source_uidx").on(
      table.sourceSystem,
      table.sourceRecordId,
    ),
    index("participant_source_records_participant_idx").on(table.participantId),
  ],
);

export type ParticipantInsert = typeof participants.$inferInsert;
export type ParticipantRow = typeof participants.$inferSelect;
export type ParticipantInterestInsert =
  typeof participantInterests.$inferInsert;
export type ParticipantInterestRow = typeof participantInterests.$inferSelect;
export type ParticipantSourceRecordInsert =
  typeof participantSourceRecords.$inferInsert;
export type ParticipantSourceRecordRow =
  typeof participantSourceRecords.$inferSelect;
