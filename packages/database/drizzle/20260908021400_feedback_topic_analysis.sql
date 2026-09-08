CREATE TABLE "feedback_topic_analyses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"identity_hash" text NOT NULL,
	"snapshot_hash" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"configuration" jsonb NOT NULL,
	"requested_by" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"stage" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"execution_epoch" integer DEFAULT 0 NOT NULL,
	"claim_token" uuid,
	"claim_expires_at" timestamp with time zone,
	"next_wakeup_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reserved_requests" integer DEFAULT 0 NOT NULL,
	"reserved_input_bytes" integer DEFAULT 0 NOT NULL,
	"observed_prompt_tokens" integer DEFAULT 0 NOT NULL,
	"observed_responses" integer DEFAULT 0 NOT NULL,
	"observed_cost_usd" double precision,
	"result" jsonb,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "feedback_topic_analyses_status_check" CHECK ("feedback_topic_analyses"."status" in ('pending', 'running', 'completed', 'failed')),
	CONSTRAINT "feedback_topic_analyses_terminal_check" CHECK (("feedback_topic_analyses"."status" = 'completed' and "feedback_topic_analyses"."result" is not null and "feedback_topic_analyses"."completed_at" is not null) or ("feedback_topic_analyses"."status" <> 'completed' and "feedback_topic_analyses"."result" is null)),
	CONSTRAINT "feedback_topic_analyses_budget_check" CHECK ("feedback_topic_analyses"."attempts" between 0 and 3 and "feedback_topic_analyses"."reserved_requests" between 0 and 48 and "feedback_topic_analyses"."reserved_input_bytes" between 0 and 786432 and "feedback_topic_analyses"."observed_prompt_tokens" >= 0 and "feedback_topic_analyses"."observed_responses" between 0 and 48),
	CONSTRAINT "feedback_topic_analyses_snapshot_check" CHECK (jsonb_typeof("feedback_topic_analyses"."snapshot") = 'object' and octet_length("feedback_topic_analyses"."snapshot"::text) <= 2097152),
	CONSTRAINT "feedback_topic_analyses_config_check" CHECK (jsonb_typeof("feedback_topic_analyses"."configuration") = 'object' and octet_length("feedback_topic_analyses"."configuration"::text) <= 8192),
	CONSTRAINT "feedback_topic_analyses_result_check" CHECK ("feedback_topic_analyses"."result" is null or (jsonb_typeof("feedback_topic_analyses"."result") = 'object' and octet_length("feedback_topic_analyses"."result"::text) <= 2097152)),
	CONSTRAINT "feedback_topic_analyses_claim_check" CHECK (("feedback_topic_analyses"."claim_token" is null) = ("feedback_topic_analyses"."claim_expires_at" is null))
);
--> statement-breakpoint
CREATE TABLE "feedback_topic_analysis_slot" (
	"id" integer PRIMARY KEY NOT NULL,
	"claim_token" uuid,
	"claim_expires_at" timestamp with time zone,
	CONSTRAINT "feedback_topic_analysis_slot_singleton_check" CHECK ("feedback_topic_analysis_slot"."id" = 1),
	CONSTRAINT "feedback_topic_analysis_slot_claim_check" CHECK (("feedback_topic_analysis_slot"."claim_token" is null) = ("feedback_topic_analysis_slot"."claim_expires_at" is null))
);
--> statement-breakpoint
CREATE TABLE "feedback_topic_embeddings" (
	"cache_key" text PRIMARY KEY NOT NULL,
	"campaign_id" uuid NOT NULL,
	"configuration_hash" text NOT NULL,
	"input_hash" text NOT NULL,
	"embedding" real[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_topic_embeddings_dimensions_check" CHECK (array_ndims("feedback_topic_embeddings"."embedding") = 1 and cardinality("feedback_topic_embeddings"."embedding") = 1024 and array_position("feedback_topic_embeddings"."embedding", null) is null and not ("feedback_topic_embeddings"."embedding" && array['NaN'::real, 'Infinity'::real, '-Infinity'::real]))
);
--> statement-breakpoint
ALTER TABLE "feedback_topic_analyses" ADD CONSTRAINT "feedback_topic_analyses_campaign_id_feedback_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."feedback_campaigns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_topic_embeddings" ADD CONSTRAINT "feedback_topic_embeddings_campaign_id_feedback_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."feedback_campaigns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_topic_analyses_identity_uidx" ON "feedback_topic_analyses" USING btree ("campaign_id","identity_hash");--> statement-breakpoint
CREATE INDEX "feedback_topic_analyses_due_idx" ON "feedback_topic_analyses" USING btree ("next_wakeup_at","id") WHERE "feedback_topic_analyses"."status" in ('pending', 'running');--> statement-breakpoint
CREATE INDEX "feedback_topic_embeddings_campaign_idx" ON "feedback_topic_embeddings" USING btree ("campaign_id");