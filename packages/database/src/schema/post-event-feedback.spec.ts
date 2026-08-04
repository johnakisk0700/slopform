import { readFileSync } from "node:fs";

import { sql } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  feedbackAnswers,
  feedbackAnswerWithdrawals,
  feedbackCampaigns,
  feedbackCampaignSummaries,
  feedbackMaintenanceCheckpoints,
  feedbackNotes,
  messageOutbox,
  providerMessageIngress,
} from "./post-event-feedback.js";

const dialect = new PgDialect();

describe("post-event feedback database constraints", () => {
  it("pairs durable maintenance checkpoint cursors by scan shape", () => {
    const config = getTableConfig(feedbackMaintenanceCheckpoints);
    const columns = new Map(
      config.columns.map((column) => [column.name, column]),
    );
    const checks = new Map(
      config.checks.map((check) => [
        check.name,
        dialect.sqlToQuery(check.value).sql,
      ]),
    );

    expect(columns.get("task")?.primary).toBe(true);
    expect(columns.get("cursor_at")?.notNull).toBe(false);
    expect(columns.get("cursor_id")?.notNull).toBe(false);
    expect(checks.get("feedback_maintenance_checkpoints_task_check")).toContain(
      "conversation_due",
    );
    expect(checks.get("feedback_maintenance_checkpoints_task_check")).toContain(
      "ingress_pending",
    );
    expect(checks.get("feedback_maintenance_checkpoints_task_check")).toContain(
      "summary_pending",
    );
    expect(checks.get("feedback_maintenance_checkpoints_task_check")).toContain(
      "campaign_resume",
    );
    expect(
      checks.get("feedback_maintenance_checkpoints_cursor_shape_check"),
    ).toContain("summary_auto");
    expect(
      checks.get("feedback_maintenance_checkpoints_cursor_shape_check"),
    ).toContain("cursor_at");

    const migration = readFileSync(
      new URL(
        "../../drizzle/20260803204714_feedback_maintenance_scan_checkpoints.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(migration).toContain(
      'CREATE TABLE "feedback_maintenance_checkpoints"',
    );
    expect(migration).toContain('"task" text PRIMARY KEY NOT NULL');
    expect(migration).not.toMatch(/^INSERT /mu);

    const ingressMigration = readFileSync(
      new URL(
        "../../drizzle/20260803212625_feedback_ingress_recovery_checkpoint.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(ingressMigration).toContain("'ingress_pending'");
    expect(ingressMigration).toContain(
      'CREATE INDEX "provider_message_ingress_pending_recovery_idx"',
    );

    const fairnessMigration = readFileSync(
      new URL(
        "../../drizzle/20260803215114_feedback_maintenance_fairness_checkpoints.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(fairnessMigration).toContain("'summary_pending'");
    expect(fairnessMigration).toContain("'campaign_resume'");
    expect(fairnessMigration).toContain(
      'CREATE INDEX "feedback_campaign_summaries_pending_recovery_idx"',
    );
    expect(fairnessMigration).not.toMatch(/^INSERT /mu);
  });

  it("uniquely scopes one campaign per event and restricts event deletes", () => {
    const config = getTableConfig(feedbackCampaigns);
    const indexes = new Map(
      config.indexes.map((index) => [index.config.name, index]),
    );
    const eventFk = config.foreignKeys.find((fk) =>
      fk.getName().includes("event_id"),
    );
    const uniqueIndex = indexes.get("feedback_campaigns_event_id_uidx");

    expect(uniqueIndex?.config.unique).toBe(true);
    expect(
      uniqueIndex?.config.columns.map((column) =>
        "name" in column ? column.name : undefined,
      ),
    ).toEqual(["event_id"]);
    expect(eventFk?.onDelete).toBe("restrict");
  });

  it("keeps one checked durable resume generation on the campaign row", () => {
    const config = getTableConfig(feedbackCampaigns);
    const columns = new Map(
      config.columns.map((column) => [column.name, column]),
    );
    const checks = new Map(
      config.checks.map((check) => [
        check.name,
        dialect.sqlToQuery(check.value).sql,
      ]),
    );
    const indexes = new Map(
      config.indexes.map((index) => [index.config.name, index]),
    );

    expect(columns.get("resume_generation")?.default).toBe(0);
    expect(columns.get("resume_applied_generation")?.default).toBe(0);
    expect(columns.get("resume_due_at")?.notNull).toBe(false);
    expect(checks.get("feedback_campaigns_resume_generation_check")).toContain(
      "resume_applied_generation",
    );
    expect(checks.get("feedback_campaigns_resume_intent_pair_check")).toContain(
      "resume_due_at",
    );
    expect(indexes.has("feedback_campaigns_resume_pending_idx")).toBe(true);

    const migration = readFileSync(
      new URL(
        "../../drizzle/20260803204136_feedback_campaign_resume_repair_intent.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(migration).toContain(
      'ADD COLUMN "resume_generation" integer DEFAULT 0 NOT NULL',
    );
    expect(migration).toContain(
      'ADD COLUMN "resume_applied_generation" integer DEFAULT 0 NOT NULL',
    );
    expect(migration).toContain(
      'CREATE INDEX "feedback_campaigns_resume_pending_idx"',
    );
  });

  it("fences campaign summaries with a paired live claim and monotonic epoch", () => {
    const config = getTableConfig(feedbackCampaignSummaries);
    const columns = new Map(
      config.columns.map((column) => [column.name, column]),
    );
    const checks = new Map(
      config.checks.map((check) => [
        check.name,
        dialect.sqlToQuery(check.value).sql,
      ]),
    );
    const indexes = new Map(
      config.indexes.map((index) => [index.config.name, index]),
    );

    expect(columns.get("execution_epoch")?.notNull).toBe(true);
    expect(columns.get("execution_epoch")?.default).toBe(0);
    expect(columns.get("claim_token")?.notNull).toBe(false);
    expect(columns.get("claim_expires_at")?.notNull).toBe(false);
    expect(
      checks.get("feedback_campaign_summaries_claim_pair_check"),
    ).toContain("is null");
    expect(
      checks.get("feedback_campaign_summaries_terminal_claim_check"),
    ).toContain("status");
    const pendingRecoveryIndex = indexes.get(
      "feedback_campaign_summaries_pending_recovery_idx",
    );
    expect(
      pendingRecoveryIndex?.config.columns.map((column) =>
        "name" in column ? column.name : undefined,
      ),
    ).toEqual(["requested_at", "campaign_id"]);
    expect(
      dialect.sqlToQuery(pendingRecoveryIndex?.config.where ?? sql``).sql,
    ).toContain("status");

    const migration = readFileSync(
      new URL(
        "../../drizzle/20260803191158_feedback_summary_execution_fence.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(migration).toContain(
      'ADD COLUMN "execution_epoch" integer DEFAULT 0 NOT NULL',
    );
    expect(migration).toContain('ADD COLUMN "claim_token" uuid');
    expect(migration).toContain('ADD COLUMN "claim_expires_at"');
    expect(migration).not.toMatch(/^UPDATE /mu);
  });

  it("enforces answer uniqueness with NULLS NOT DISTINCT including null subjects", () => {
    const config = getTableConfig(feedbackAnswers);
    const unique = config.uniqueConstraints.find(
      (constraint) =>
        constraint.name ===
        "feedback_answers_conversation_question_subject_uidx",
    );
    const participantFks = config.foreignKeys.filter((fk) =>
      fk.getName().includes("participant_id"),
    );
    const campaignFk = config.foreignKeys.find((fk) =>
      fk.getName().includes("campaign_id"),
    );

    expect(unique?.nullsNotDistinct).toBe(true);
    expect(unique?.columns.map((column) => column.name)).toEqual([
      "conversation_id",
      "question_key",
      "subject_participant_id",
    ]);
    expect(campaignFk?.onDelete).toBe("restrict");
    expect(participantFks.map((fk) => fk.onDelete)).toEqual([
      "restrict",
      "restrict",
    ]);
    expect(
      config.foreignKeys.some((fk) => fk.getName().includes("event_attendee")),
    ).toBe(false);
  });

  it("defaults matching_hold to false so no existing answer arrives held", () => {
    const column = getTableConfig(feedbackAnswers).columns.find(
      (candidate) => candidate.name === "matching_hold",
    );

    // A hold says «a consumer turning answers into seating must skip this row».
    // Nullable would give that a third state nobody can act on, and no default
    // would make every row written before the column mean nothing in particular.
    expect(column?.notNull).toBe(true);
    expect(column?.default).toBe(false);
  });

  it("tombstones a withdrawn answer on the same slot key the answer used", () => {
    const config = getTableConfig(feedbackAnswerWithdrawals);
    const unique = config.uniqueConstraints.find(
      (constraint) =>
        constraint.name ===
        "feedback_answer_withdrawals_conversation_question_subject_uidx",
    );

    // The same `NULLS NOT DISTINCT (conversation, question, subject)` the answers
    // table enforces, because the tombstone has to occupy exactly the space the
    // row it replaces did — that is what makes it consultable before a write.
    expect(unique?.nullsNotDistinct).toBe(true);
    expect(unique?.columns.map((column) => column.name)).toEqual([
      "conversation_id",
      "question_key",
      "subject_participant_id",
    ]);
    expect(config.foreignKeys.every((fk) => fk.onDelete === "restrict")).toBe(
      true,
    );
    // And no foreign key on `answer_id`: the row it names was deleted on
    // purpose. The whole of it lives in the `feedback_answer.withdrawn` audit
    // event under that id.
    expect(
      config.foreignKeys.some((fk) => fk.getName().includes("answer_id")),
    ).toBe(false);
  });

  it("keeps notes subject-nullable with RESTRICT participant and campaign FKs", () => {
    const config = getTableConfig(feedbackNotes);
    const checks = new Map(
      config.checks.map((check) => [
        check.name,
        dialect.sqlToQuery(check.value).sql,
      ]),
    );
    const subjectColumn = config.columns.find(
      (column) => column.name === "subject_participant_id",
    );
    const campaignFk = config.foreignKeys.find((fk) =>
      fk.getName().includes("campaign_id"),
    );

    expect(subjectColumn?.notNull).toBe(false);
    expect(checks.get("feedback_notes_note_type_check")).toContain(
      "'activity_interest', 'general'",
    );
    expect(checks.get("feedback_notes_text_length_check")).toContain(
      "between 1 and 500",
    );
    expect(checks.get("feedback_notes_status_check")).toContain(
      "'new', 'dismissed'",
    );
    expect(campaignFk?.onDelete).toBe("restrict");
    expect(config.foreignKeys.every((fk) => fk.onDelete === "restrict")).toBe(
      true,
    );
  });

  it("dedupes provider ingress on (chat_jid, provider_message_id)", () => {
    const config = getTableConfig(providerMessageIngress);
    const indexes = new Map(
      config.indexes.map((index) => [index.config.name, index]),
    );
    const uniqueIndex = indexes.get(
      "provider_message_ingress_chat_provider_uidx",
    );
    const fifoIndex = indexes.get(
      "provider_message_ingress_processing_order_idx",
    );
    const recoveryIndex = indexes.get(
      "provider_message_ingress_pending_recovery_idx",
    );
    const ingressOrder = config.columns.find(
      (column) => column.name === "ingress_order",
    );
    const checks = new Map(
      config.checks.map((check) => [
        check.name,
        dialect.sqlToQuery(check.value).sql,
      ]),
    );

    expect(uniqueIndex?.config.unique).toBe(true);
    expect(
      uniqueIndex?.config.columns.map((column) =>
        "name" in column ? column.name : undefined,
      ),
    ).toEqual(["chat_jid", "provider_message_id"]);
    expect(ingressOrder?.notNull).toBe(true);
    expect(ingressOrder?.hasDefault).toBe(true);
    expect(
      fifoIndex?.config.columns.map((column) =>
        "name" in column ? column.name : undefined,
      ),
    ).toEqual(["processing_status", "ingress_order"]);
    expect(
      recoveryIndex?.config.columns.map((column) =>
        "name" in column ? column.name : undefined,
      ),
    ).toEqual(["created_at", "id"]);
    expect(
      recoveryIndex?.config.where
        ? dialect.sqlToQuery(recoveryIndex.config.where).sql
        : undefined,
    ).toContain("processing_status");
    expect(
      checks.get("provider_message_ingress_unmatched_text_check"),
    ).toContain("ignored_unmatched");
    expect(config.foreignKeys).toHaveLength(0);
  });

  it("uniquely scopes outbox rows by dedupe_key and folds delivery columns in", () => {
    const config = getTableConfig(messageOutbox);
    const indexes = new Map(
      config.indexes.map((index) => [index.config.name, index]),
    );
    const uniqueIndex = indexes.get("message_outbox_dedupe_key_uidx");
    const checks = new Map(
      config.checks.map((check) => [
        check.name,
        dialect.sqlToQuery(check.value).sql,
      ]),
    );
    const campaignFk = config.foreignKeys.find((fk) =>
      fk.getName().includes("campaign_id"),
    );
    const columnNames = new Set(config.columns.map((column) => column.name));

    expect(uniqueIndex?.config.unique).toBe(true);
    expect(
      uniqueIndex?.config.columns.map((column) =>
        "name" in column ? column.name : undefined,
      ),
    ).toEqual(["dedupe_key"]);
    expect(checks.get("message_outbox_status_check")).toContain("'held'");
    expect(checks.get("message_outbox_delivery_status_check")).toContain(
      "'error', 'pending', 'sent', 'delivered', 'read', 'played'",
    );
    expect(campaignFk?.onDelete).toBe("restrict");
    expect(columnNames.has("delivery_status")).toBe(true);
    expect(columnNames.has("provider_message_id")).toBe(true);
    expect(columnNames.has("sent_at")).toBe(true);
  });

  it("persists the five feedback tables with NULLS NOT DISTINCT and RESTRICT FKs", () => {
    const migration = readFileSync(
      new URL(
        "../../drizzle/20260725181557_post_event_feedback_persistence.sql",
        import.meta.url,
      ),
      "utf8",
    );

    expect(migration).toContain('CREATE TABLE "feedback_campaigns"');
    expect(migration).toContain('CREATE TABLE "feedback_answers"');
    expect(migration).toContain('CREATE TABLE "feedback_notes"');
    expect(migration).toContain('CREATE TABLE "provider_message_ingress"');
    expect(migration).toContain('CREATE TABLE "message_outbox"');
    expect(migration).toContain("NULLS NOT DISTINCT");
    expect(migration).toContain(
      '"conversation_id","question_key","subject_participant_id"',
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "provider_message_ingress_chat_provider_uidx"',
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "message_outbox_dedupe_key_uidx"',
    );
    expect(migration).toContain("ON DELETE restrict");
    expect(migration).not.toContain("event_attendees");
    expect(migration).not.toContain("message_deliveries");
  });

  it("adds the matching hold and the withdrawal tombstones in one migration", () => {
    const migration = readFileSync(
      new URL(
        "../../drizzle/20260728004900_feedback_answer_matching_hold_and_withdrawals.sql",
        import.meta.url,
      ),
      "utf8",
    );

    // One migration on one table's neighbourhood, because two would have been
    // two locks and two reviews for one release.
    expect(migration).toContain(
      'ALTER TABLE "feedback_answers" ADD COLUMN "matching_hold" boolean DEFAULT false NOT NULL',
    );
    expect(migration).toContain('CREATE TABLE "feedback_answer_withdrawals"');
    expect(migration).toContain("NULLS NOT DISTINCT");
    expect(migration).toContain("ON DELETE restrict");
    // Backfill-free by construction: an existing answer is not held, and no
    // answer withdrawn before today can be reconstructed as a tombstone —
    // `audit_events` has those, and inventing rows from them would be guessing
    // that nobody has re-answered since.
    expect(migration).not.toMatch(/^UPDATE /mu);
  });

  it("persists the dev-only simulated outbound sink without business FKs", () => {
    const migration = readFileSync(
      new URL(
        "../../drizzle/20260725191018_feedback_sim_outbound.sql",
        import.meta.url,
      ),
      "utf8",
    );

    expect(migration).toContain('CREATE TABLE "feedback_sim_outbound"');
    expect(migration).toContain(
      'CREATE INDEX "feedback_sim_outbound_phone_sent_idx"',
    );
    expect(migration).not.toContain("REFERENCES");
  });
});
