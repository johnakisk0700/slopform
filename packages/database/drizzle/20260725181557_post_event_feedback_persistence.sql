CREATE TABLE "feedback_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"respondent_participant_id" uuid NOT NULL,
	"subject_participant_id" uuid,
	"question_key" text NOT NULL,
	"value_int" integer,
	"source_message_ids" uuid[] NOT NULL,
	"extraction_meta" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_answers_conversation_question_subject_uidx" UNIQUE NULLS NOT DISTINCT("conversation_id","question_key","subject_participant_id"),
	CONSTRAINT "feedback_answers_question_key_check" CHECK ("feedback_answers"."question_key" in ('event_score', 'liked', 'meet_again', 'avoid')),
	CONSTRAINT "feedback_answers_value_int_check" CHECK ("feedback_answers"."value_int" is null or "feedback_answers"."value_int" between 1 and 5),
	CONSTRAINT "feedback_answers_source_message_ids_check" CHECK (cardinality("feedback_answers"."source_message_ids") >= 1),
	CONSTRAINT "feedback_answers_extraction_meta_object_check" CHECK (jsonb_typeof("feedback_answers"."extraction_meta") = 'object')
);
--> statement-breakpoint
CREATE TABLE "feedback_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"question_set_version" integer NOT NULL,
	"questions" jsonb NOT NULL,
	"status" text DEFAULT 'launched' NOT NULL,
	"launched_at" timestamp with time zone NOT NULL,
	"launched_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_campaigns_question_set_version_check" CHECK ("feedback_campaigns"."question_set_version" >= 1),
	CONSTRAINT "feedback_campaigns_questions_object_check" CHECK (jsonb_typeof("feedback_campaigns"."questions") = 'object'),
	CONSTRAINT "feedback_campaigns_status_check" CHECK ("feedback_campaigns"."status" in ('launched', 'paused', 'closed')),
	CONSTRAINT "feedback_campaigns_launched_by_length_check" CHECK (char_length(btrim("feedback_campaigns"."launched_by")) between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "feedback_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"respondent_participant_id" uuid NOT NULL,
	"subject_participant_id" uuid,
	"note_type" text NOT NULL,
	"text" text NOT NULL,
	"source_message_ids" uuid[] NOT NULL,
	"extraction_meta" jsonb NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_notes_note_type_check" CHECK ("feedback_notes"."note_type" in ('activity_interest', 'general')),
	CONSTRAINT "feedback_notes_text_length_check" CHECK (char_length(btrim("feedback_notes"."text")) between 1 and 500),
	CONSTRAINT "feedback_notes_source_message_ids_check" CHECK (cardinality("feedback_notes"."source_message_ids") >= 1),
	CONSTRAINT "feedback_notes_extraction_meta_object_check" CHECK (jsonb_typeof("feedback_notes"."extraction_meta") = 'object'),
	CONSTRAINT "feedback_notes_status_check" CHECK ("feedback_notes"."status" in ('new', 'dismissed'))
);
--> statement-breakpoint
CREATE TABLE "message_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"body" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"dedupe_key" text NOT NULL,
	"created_by_staff" text,
	"provider_log_id" text,
	"provider_message_id" text,
	"delivery_status" text,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"played_at" timestamp with time zone,
	"delivery_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_outbox_kind_check" CHECK ("message_outbox"."kind" in ('intro', 'reply', 'reminder', 'staff', 'system')),
	CONSTRAINT "message_outbox_body_length_check" CHECK (char_length(btrim("message_outbox"."body")) between 1 and 10000),
	CONSTRAINT "message_outbox_status_check" CHECK ("message_outbox"."status" in ('pending', 'held', 'sending', 'sent', 'failed', 'cancelled')),
	CONSTRAINT "message_outbox_dedupe_key_length_check" CHECK (char_length(btrim("message_outbox"."dedupe_key")) between 1 and 200),
	CONSTRAINT "message_outbox_created_by_staff_length_check" CHECK ("message_outbox"."created_by_staff" is null or char_length(btrim("message_outbox"."created_by_staff")) between 1 and 200),
	CONSTRAINT "message_outbox_provider_log_id_length_check" CHECK ("message_outbox"."provider_log_id" is null or char_length(btrim("message_outbox"."provider_log_id")) between 1 and 200),
	CONSTRAINT "message_outbox_provider_message_id_length_check" CHECK ("message_outbox"."provider_message_id" is null or char_length(btrim("message_outbox"."provider_message_id")) between 1 and 200),
	CONSTRAINT "message_outbox_delivery_status_check" CHECK ("message_outbox"."delivery_status" is null or "message_outbox"."delivery_status" in ('error', 'pending', 'sent', 'delivered', 'read', 'played'))
);
--> statement-breakpoint
CREATE TABLE "provider_message_ingress" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_message_id" text NOT NULL,
	"chat_jid" text NOT NULL,
	"direction" text NOT NULL,
	"phone_e164" text,
	"text" text,
	"observed_at" timestamp with time zone NOT NULL,
	"processing_status" text DEFAULT 'pending' NOT NULL,
	"matched_conversation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_message_ingress_provider_message_id_length_check" CHECK (char_length(btrim("provider_message_ingress"."provider_message_id")) between 1 and 200),
	CONSTRAINT "provider_message_ingress_chat_jid_length_check" CHECK (char_length(btrim("provider_message_ingress"."chat_jid")) between 1 and 200),
	CONSTRAINT "provider_message_ingress_direction_check" CHECK ("provider_message_ingress"."direction" in ('inbound', 'outbound')),
	CONSTRAINT "provider_message_ingress_phone_e164_check" CHECK ("provider_message_ingress"."phone_e164" is null or "provider_message_ingress"."phone_e164" ~ '^\+[1-9][0-9]{1,14}$'),
	CONSTRAINT "provider_message_ingress_text_length_check" CHECK ("provider_message_ingress"."text" is null or char_length("provider_message_ingress"."text") between 1 and 10000),
	CONSTRAINT "provider_message_ingress_processing_status_check" CHECK ("provider_message_ingress"."processing_status" in ('pending', 'materialized', 'ignored_unmatched', 'failed')),
	CONSTRAINT "provider_message_ingress_unmatched_text_check" CHECK (("provider_message_ingress"."processing_status" = 'ignored_unmatched' and "provider_message_ingress"."text" is null and "provider_message_ingress"."matched_conversation_id" is null) or ("provider_message_ingress"."processing_status" <> 'ignored_unmatched'))
);
--> statement-breakpoint
ALTER TABLE "feedback_answers" ADD CONSTRAINT "feedback_answers_campaign_id_feedback_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."feedback_campaigns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_answers" ADD CONSTRAINT "feedback_answers_respondent_participant_id_participants_id_fk" FOREIGN KEY ("respondent_participant_id") REFERENCES "public"."participants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_answers" ADD CONSTRAINT "feedback_answers_subject_participant_id_participants_id_fk" FOREIGN KEY ("subject_participant_id") REFERENCES "public"."participants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_campaigns" ADD CONSTRAINT "feedback_campaigns_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_notes" ADD CONSTRAINT "feedback_notes_campaign_id_feedback_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."feedback_campaigns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_notes" ADD CONSTRAINT "feedback_notes_respondent_participant_id_participants_id_fk" FOREIGN KEY ("respondent_participant_id") REFERENCES "public"."participants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_notes" ADD CONSTRAINT "feedback_notes_subject_participant_id_participants_id_fk" FOREIGN KEY ("subject_participant_id") REFERENCES "public"."participants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_outbox" ADD CONSTRAINT "message_outbox_campaign_id_feedback_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."feedback_campaigns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feedback_answers_campaign_respondent_idx" ON "feedback_answers" USING btree ("campaign_id","respondent_participant_id");--> statement-breakpoint
CREATE INDEX "feedback_answers_campaign_subject_idx" ON "feedback_answers" USING btree ("campaign_id","subject_participant_id");--> statement-breakpoint
CREATE INDEX "feedback_answers_conversation_idx" ON "feedback_answers" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_campaigns_event_id_uidx" ON "feedback_campaigns" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "feedback_campaigns_status_launched_at_idx" ON "feedback_campaigns" USING btree ("status","launched_at");--> statement-breakpoint
CREATE INDEX "feedback_notes_campaign_respondent_idx" ON "feedback_notes" USING btree ("campaign_id","respondent_participant_id");--> statement-breakpoint
CREATE INDEX "feedback_notes_campaign_subject_idx" ON "feedback_notes" USING btree ("campaign_id","subject_participant_id");--> statement-breakpoint
CREATE INDEX "feedback_notes_conversation_idx" ON "feedback_notes" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "feedback_notes_status_idx" ON "feedback_notes" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "message_outbox_dedupe_key_uidx" ON "message_outbox" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "message_outbox_conversation_created_idx" ON "message_outbox" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "message_outbox_campaign_status_idx" ON "message_outbox" USING btree ("campaign_id","status");--> statement-breakpoint
CREATE INDEX "message_outbox_status_created_idx" ON "message_outbox" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "message_outbox_provider_message_id_idx" ON "message_outbox" USING btree ("provider_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_message_ingress_chat_provider_uidx" ON "provider_message_ingress" USING btree ("chat_jid","provider_message_id");--> statement-breakpoint
CREATE INDEX "provider_message_ingress_processing_observed_idx" ON "provider_message_ingress" USING btree ("processing_status","observed_at");--> statement-breakpoint
CREATE INDEX "provider_message_ingress_matched_conversation_idx" ON "provider_message_ingress" USING btree ("matched_conversation_id");