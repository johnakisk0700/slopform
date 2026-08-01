CREATE TABLE "message_outbox_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outbox_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"origin" text NOT NULL,
	"correlation_id" text NOT NULL,
	"decision" jsonb NOT NULL,
	"conversation_state" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_outbox_log_origin_check" CHECK ("message_outbox_log"."origin" in ('extraction_reply', 'extraction_fallback_fence', 'extraction_fallback_ack', 'extraction_parked_notice', 'stop_ack', 'media_notice', 'staff_message', 'campaign_intro', 'reminder')),
	CONSTRAINT "message_outbox_log_correlation_id_length_check" CHECK (char_length(btrim("message_outbox_log"."correlation_id")) between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "message_outbox_log" ADD CONSTRAINT "message_outbox_log_outbox_id_message_outbox_id_fk" FOREIGN KEY ("outbox_id") REFERENCES "public"."message_outbox"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_outbox_log" ADD CONSTRAINT "message_outbox_log_campaign_id_feedback_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."feedback_campaigns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "message_outbox_log_outbox_id_uidx" ON "message_outbox_log" USING btree ("outbox_id");--> statement-breakpoint
CREATE INDEX "message_outbox_log_conversation_id_idx" ON "message_outbox_log" USING btree ("conversation_id");