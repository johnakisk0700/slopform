CREATE TABLE "feedback_sim_outbound" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outbox_id" uuid NOT NULL,
	"phone_e164" text NOT NULL,
	"body" text NOT NULL,
	"provider_message_id" text NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_sim_outbound_body_length_check" CHECK (char_length(btrim("feedback_sim_outbound"."body")) between 1 and 4096),
	CONSTRAINT "feedback_sim_outbound_phone_e164_length_check" CHECK (char_length(btrim("feedback_sim_outbound"."phone_e164")) between 8 and 20)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_sim_outbound_provider_message_id_uidx" ON "feedback_sim_outbound" USING btree ("provider_message_id");--> statement-breakpoint
CREATE INDEX "feedback_sim_outbound_phone_sent_idx" ON "feedback_sim_outbound" USING btree ("phone_e164","sent_at");