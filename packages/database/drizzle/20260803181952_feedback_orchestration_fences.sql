CREATE TABLE "feedback_conversation_executions" (
	"conversation_id" uuid PRIMARY KEY NOT NULL,
	"epoch" integer DEFAULT 0 NOT NULL,
	"work_revision" integer DEFAULT 0 NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_conversation_executions_epoch_check" CHECK ("feedback_conversation_executions"."epoch" >= 0),
	CONSTRAINT "feedback_conversation_executions_work_revision_check" CHECK ("feedback_conversation_executions"."work_revision" >= 0),
	CONSTRAINT "feedback_conversation_executions_lease_pair_check" CHECK (("feedback_conversation_executions"."lease_token" is null) = ("feedback_conversation_executions"."lease_until" is null))
);
--> statement-breakpoint
ALTER TABLE "message_outbox" DROP CONSTRAINT "message_outbox_status_check";--> statement-breakpoint
ALTER TABLE "message_outbox" ADD COLUMN "claim_token" uuid;--> statement-breakpoint
ALTER TABLE "message_outbox" ADD COLUMN "claim_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "message_outbox" ADD COLUMN "send_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "message_outbox" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "message_outbox" ADD COLUMN "last_error" text;--> statement-breakpoint
CREATE INDEX "feedback_conversation_executions_lease_until_idx" ON "feedback_conversation_executions" USING btree ("lease_until");--> statement-breakpoint
CREATE INDEX "message_outbox_dispatch_recovery_idx" ON "message_outbox" USING btree ("status","claim_expires_at","created_at","id") WHERE "message_outbox"."status" in ('pending', 'claimed', 'attempting');--> statement-breakpoint
ALTER TABLE "message_outbox" ADD CONSTRAINT "message_outbox_claim_pair_check" CHECK ("message_outbox"."claim_expires_at" is null or "message_outbox"."claim_token" is not null);--> statement-breakpoint
ALTER TABLE "message_outbox" ADD CONSTRAINT "message_outbox_claimed_fields_check" CHECK ("message_outbox"."status" <> 'claimed' or ("message_outbox"."claim_token" is not null and "message_outbox"."claim_expires_at" is not null and "message_outbox"."send_started_at" is null));--> statement-breakpoint
ALTER TABLE "message_outbox" ADD CONSTRAINT "message_outbox_attempting_fields_check" CHECK ("message_outbox"."status" <> 'attempting' or ("message_outbox"."claim_token" is not null and "message_outbox"."claim_expires_at" is not null and "message_outbox"."send_started_at" is not null and "message_outbox"."attempt_count" >= 1));--> statement-breakpoint
ALTER TABLE "message_outbox" ADD CONSTRAINT "message_outbox_ambiguous_fields_check" CHECK ("message_outbox"."status" <> 'ambiguous' or ("message_outbox"."claim_expires_at" is null and (("message_outbox"."claim_token" is not null and "message_outbox"."send_started_at" is not null and "message_outbox"."attempt_count" >= 1) or ("message_outbox"."claim_token" is null and "message_outbox"."send_started_at" is null and "message_outbox"."attempt_count" = 0 and "message_outbox"."last_error" = 'legacy_sending_cutover_ambiguous'))));--> statement-breakpoint
ALTER TABLE "message_outbox" ADD CONSTRAINT "message_outbox_send_started_at_check" CHECK ("message_outbox"."send_started_at" is null or "message_outbox"."status" in ('attempting', 'ambiguous', 'sent', 'failed', 'cancelled'));--> statement-breakpoint
ALTER TABLE "message_outbox" ADD CONSTRAINT "message_outbox_attempt_count_check" CHECK ("message_outbox"."attempt_count" >= 0);--> statement-breakpoint
ALTER TABLE "message_outbox" ADD CONSTRAINT "message_outbox_last_error_length_check" CHECK ("message_outbox"."last_error" is null or char_length(btrim("message_outbox"."last_error")) between 1 and 2000);--> statement-breakpoint
ALTER TABLE "message_outbox" ADD CONSTRAINT "message_outbox_status_check" CHECK ("message_outbox"."status" in ('pending', 'held', 'claimed', 'attempting', 'ambiguous', 'sending', 'sent', 'failed', 'cancelled'));