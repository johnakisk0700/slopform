CREATE TABLE "feedback_conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"campaign_id" uuid NOT NULL,
	"respondent_participant_id" uuid NOT NULL,
	"phone_at_launch" text NOT NULL,
	"lifecycle_state" text NOT NULL,
	"lifecycle_reason" text,
	"closed_at" timestamp with time zone,
	"terminal_outbox_id" uuid,
	"staff_close_reason" text,
	"staff_close_note" text,
	"control_mode" text NOT NULL,
	"control_source" text NOT NULL,
	"control_changed_at" timestamp with time zone NOT NULL,
	"needs_attention" boolean DEFAULT false NOT NULL,
	"awaiting_human" boolean DEFAULT false NOT NULL,
	"hostile_turns" integer DEFAULT 0 NOT NULL,
	"extraction_fallback_ack_sent" boolean DEFAULT false NOT NULL,
	"reminder_count" integer DEFAULT 0 NOT NULL,
	"reminded_at" timestamp with time zone,
	"cursor_seq" integer DEFAULT 0 NOT NULL,
	"extraction_last_run_at" timestamp with time zone,
	"extraction_model" text,
	"extraction_service_tier" text,
	"parked_since" timestamp with time zone,
	"parked_runs" integer DEFAULT 0 NOT NULL,
	"parked_notice_sent_at" timestamp with time zone,
	"work_revision" integer DEFAULT 0 NOT NULL,
	"work_next_action_at" timestamp with time zone,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"goals" jsonb NOT NULL,
	"attention_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"extraction_usage" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_conversations_phone_at_launch_check" CHECK ("feedback_conversations"."phone_at_launch" ~ '^\+[1-9][0-9]{7,14}$'),
	CONSTRAINT "feedback_conversations_lifecycle_state_check" CHECK ("feedback_conversations"."lifecycle_state" in ('open', 'closed')),
	CONSTRAINT "feedback_conversations_lifecycle_reason_check" CHECK ("feedback_conversations"."lifecycle_reason" is null or "feedback_conversations"."lifecycle_reason" in ('completed', 'declined', 'stopped', 'expired', 'cancelled')),
	CONSTRAINT "feedback_conversations_lifecycle_pair_check" CHECK (("feedback_conversations"."lifecycle_state" = 'open' and "feedback_conversations"."lifecycle_reason" is null and "feedback_conversations"."closed_at" is null and "feedback_conversations"."terminal_outbox_id" is null) or ("feedback_conversations"."lifecycle_state" = 'closed' and "feedback_conversations"."lifecycle_reason" is not null and "feedback_conversations"."closed_at" is not null)),
	CONSTRAINT "feedback_conversations_terminal_outbox_check" CHECK ("feedback_conversations"."terminal_outbox_id" is null or ("feedback_conversations"."lifecycle_state" = 'closed' and "feedback_conversations"."lifecycle_reason" in ('completed', 'declined', 'stopped'))),
	CONSTRAINT "feedback_conversations_staff_close_reason_check" CHECK ("feedback_conversations"."staff_close_reason" is null or "feedback_conversations"."staff_close_reason" in ('abusive', 'unresponsive', 'handled_offline', 'duplicate', 'other')),
	CONSTRAINT "feedback_conversations_staff_close_pair_check" CHECK ("feedback_conversations"."staff_close_note" is null or "feedback_conversations"."staff_close_reason" is not null),
	CONSTRAINT "feedback_conversations_staff_close_note_length_check" CHECK ("feedback_conversations"."staff_close_note" is null or char_length(btrim("feedback_conversations"."staff_close_note")) between 1 and 500),
	CONSTRAINT "feedback_conversations_control_mode_check" CHECK ("feedback_conversations"."control_mode" in ('bot', 'human')),
	CONSTRAINT "feedback_conversations_control_source_check" CHECK ("feedback_conversations"."control_source" in ('launch', 'staff_action', 'external_outbound')),
	CONSTRAINT "feedback_conversations_control_pair_check" CHECK ("feedback_conversations"."control_mode" <> 'human' or "feedback_conversations"."control_source" <> 'launch'),
	CONSTRAINT "feedback_conversations_hostile_turns_check" CHECK ("feedback_conversations"."hostile_turns" between 0 and 150),
	CONSTRAINT "feedback_conversations_reminder_count_check" CHECK ("feedback_conversations"."reminder_count" between 0 and 10),
	CONSTRAINT "feedback_conversations_cursor_seq_check" CHECK ("feedback_conversations"."cursor_seq" >= 0),
	CONSTRAINT "feedback_conversations_extraction_model_length_check" CHECK ("feedback_conversations"."extraction_model" is null or char_length(btrim("feedback_conversations"."extraction_model")) between 1 and 200),
	CONSTRAINT "feedback_conversations_extraction_service_tier_length_check" CHECK ("feedback_conversations"."extraction_service_tier" is null or char_length(btrim("feedback_conversations"."extraction_service_tier")) between 1 and 50),
	CONSTRAINT "feedback_conversations_parked_runs_check" CHECK ("feedback_conversations"."parked_runs" >= 0),
	CONSTRAINT "feedback_conversations_work_revision_check" CHECK ("feedback_conversations"."work_revision" >= 0),
	CONSTRAINT "feedback_conversations_updated_at_check" CHECK ("feedback_conversations"."updated_at" >= "feedback_conversations"."created_at"),
	CONSTRAINT "feedback_conversations_messages_array_check" CHECK (jsonb_typeof("feedback_conversations"."messages") = 'array'),
	CONSTRAINT "feedback_conversations_messages_length_check" CHECK (jsonb_array_length("feedback_conversations"."messages") <= 150),
	CONSTRAINT "feedback_conversations_messages_size_check" CHECK (pg_column_size("feedback_conversations"."messages") <= 4194304),
	CONSTRAINT "feedback_conversations_goals_array_check" CHECK (jsonb_typeof("feedback_conversations"."goals") = 'array'),
	CONSTRAINT "feedback_conversations_goals_length_check" CHECK (jsonb_array_length("feedback_conversations"."goals") between 1 and 10),
	CONSTRAINT "feedback_conversations_attention_reasons_array_check" CHECK (jsonb_typeof("feedback_conversations"."attention_reasons") = 'array'),
	CONSTRAINT "feedback_conversations_attention_reasons_length_check" CHECK (jsonb_array_length("feedback_conversations"."attention_reasons") <= 50),
	CONSTRAINT "feedback_conversations_extraction_usage_object_check" CHECK ("feedback_conversations"."extraction_usage" is null or jsonb_typeof("feedback_conversations"."extraction_usage") = 'object')
);
--> statement-breakpoint
ALTER TABLE "feedback_campaigns" DROP CONSTRAINT "feedback_campaigns_resume_intent_pair_check";--> statement-breakpoint
ALTER TABLE "feedback_campaigns" DROP CONSTRAINT "feedback_campaigns_resume_generation_check";--> statement-breakpoint
ALTER TABLE "feedback_maintenance_checkpoints" DROP CONSTRAINT "feedback_maintenance_checkpoints_task_check";--> statement-breakpoint
ALTER TABLE "feedback_maintenance_checkpoints" DROP CONSTRAINT "feedback_maintenance_checkpoints_cursor_shape_check";--> statement-breakpoint
DROP INDEX "feedback_campaigns_resume_pending_idx";--> statement-breakpoint
ALTER TABLE "feedback_conversations" ADD CONSTRAINT "feedback_conversations_campaign_id_feedback_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."feedback_campaigns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_conversations" ADD CONSTRAINT "feedback_conversations_respondent_participant_id_participants_id_fk" FOREIGN KEY ("respondent_participant_id") REFERENCES "public"."participants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_conversations_campaign_respondent_uidx" ON "feedback_conversations" USING btree ("campaign_id","respondent_participant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_conversations_open_phone_uidx" ON "feedback_conversations" USING btree ("phone_at_launch") WHERE "feedback_conversations"."lifecycle_state" = 'open';--> statement-breakpoint
CREATE INDEX "feedback_conversations_campaign_updated_idx" ON "feedback_conversations" USING btree ("campaign_id","updated_at");--> statement-breakpoint
CREATE INDEX "feedback_conversations_work_due_idx" ON "feedback_conversations" USING btree ("work_next_action_at","id") WHERE "feedback_conversations"."work_next_action_at" is not null;--> statement-breakpoint
CREATE INDEX "feedback_conversations_closed_phone_idx" ON "feedback_conversations" USING btree ("phone_at_launch","updated_at") WHERE "feedback_conversations"."lifecycle_state" = 'closed';--> statement-breakpoint
CREATE INDEX "feedback_conversations_attention_updated_idx" ON "feedback_conversations" USING btree ("updated_at") WHERE "feedback_conversations"."needs_attention" is true;--> statement-breakpoint
CREATE INDEX "feedback_conversations_lifecycle_state_idx" ON "feedback_conversations" USING btree ("lifecycle_state","updated_at");--> statement-breakpoint
ALTER TABLE "feedback_campaigns" DROP COLUMN "resume_applied_generation";--> statement-breakpoint
ALTER TABLE "feedback_campaigns" DROP COLUMN "resume_due_at";--> statement-breakpoint
ALTER TABLE "feedback_campaigns" ADD CONSTRAINT "feedback_campaigns_resume_generation_check" CHECK ("feedback_campaigns"."resume_generation" >= 0);--> statement-breakpoint
-- Retire the scan cursor before narrowing its allowed task values.
DELETE FROM "feedback_maintenance_checkpoints" WHERE "task" = 'campaign_resume';--> statement-breakpoint
ALTER TABLE "feedback_maintenance_checkpoints" ADD CONSTRAINT "feedback_maintenance_checkpoints_task_check" CHECK ("feedback_maintenance_checkpoints"."task" in ('conversation_due', 'ingress_pending', 'summary_auto', 'summary_pending'));--> statement-breakpoint
ALTER TABLE "feedback_maintenance_checkpoints" ADD CONSTRAINT "feedback_maintenance_checkpoints_cursor_shape_check" CHECK (("feedback_maintenance_checkpoints"."task" in ('conversation_due', 'ingress_pending', 'summary_pending') and (("feedback_maintenance_checkpoints"."cursor_at" is null and "feedback_maintenance_checkpoints"."cursor_id" is null) or ("feedback_maintenance_checkpoints"."cursor_at" is not null and "feedback_maintenance_checkpoints"."cursor_id" is not null))) or ("feedback_maintenance_checkpoints"."task" = 'summary_auto' and "feedback_maintenance_checkpoints"."cursor_at" is null));