CREATE TABLE "feedback_campaign_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"status" text NOT NULL,
	"body" text,
	"model" text,
	"reasoning_effort" text,
	"is_partial" boolean NOT NULL,
	"trigger" text NOT NULL,
	"error" text,
	"attempt" integer NOT NULL,
	"open_conversation_count" integer NOT NULL,
	"answer_count" integer DEFAULT 0 NOT NULL,
	"note_count" integer DEFAULT 0 NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"generated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_campaign_summaries_status_check" CHECK ("feedback_campaign_summaries"."status" in ('pending', 'ready', 'failed')),
	CONSTRAINT "feedback_campaign_summaries_trigger_check" CHECK ("feedback_campaign_summaries"."trigger" in ('manual', 'all_closed')),
	CONSTRAINT "feedback_campaign_summaries_attempt_check" CHECK ("feedback_campaign_summaries"."attempt" >= 1),
	CONSTRAINT "feedback_campaign_summaries_open_conversation_count_check" CHECK ("feedback_campaign_summaries"."open_conversation_count" >= 0),
	CONSTRAINT "feedback_campaign_summaries_answer_count_check" CHECK ("feedback_campaign_summaries"."answer_count" >= 0),
	CONSTRAINT "feedback_campaign_summaries_note_count_check" CHECK ("feedback_campaign_summaries"."note_count" >= 0),
	CONSTRAINT "feedback_campaign_summaries_body_length_check" CHECK ("feedback_campaign_summaries"."body" is null or char_length(btrim("feedback_campaign_summaries"."body")) between 1 and 50000),
	CONSTRAINT "feedback_campaign_summaries_error_length_check" CHECK ("feedback_campaign_summaries"."error" is null or char_length(btrim("feedback_campaign_summaries"."error")) between 1 and 2000),
	CONSTRAINT "feedback_campaign_summaries_model_length_check" CHECK ("feedback_campaign_summaries"."model" is null or char_length(btrim("feedback_campaign_summaries"."model")) between 1 and 200),
	CONSTRAINT "feedback_campaign_summaries_reasoning_effort_length_check" CHECK ("feedback_campaign_summaries"."reasoning_effort" is null or char_length(btrim("feedback_campaign_summaries"."reasoning_effort")) between 1 and 20)
);
--> statement-breakpoint
ALTER TABLE "feedback_campaign_summaries" ADD CONSTRAINT "feedback_campaign_summaries_campaign_id_feedback_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."feedback_campaigns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_campaign_summaries_campaign_id_uidx" ON "feedback_campaign_summaries" USING btree ("campaign_id");