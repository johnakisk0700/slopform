DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM "assistant_runs" LIMIT 1) THEN
		RAISE EXCEPTION 'assistant_runs contains data; export and migrate it explicitly before applying durable assistant threads';
	END IF;
END $$;--> statement-breakpoint
CREATE TABLE "assistant_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_by" text NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assistant_threads_created_by_length_check" CHECK (char_length(btrim("assistant_threads"."created_by")) between 1 and 200),
	CONSTRAINT "assistant_threads_title_length_check" CHECK (char_length(btrim("assistant_threads"."title")) between 1 and 160)
);
--> statement-breakpoint
CREATE TABLE "assistant_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"created_by" text NOT NULL,
	"request_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"model" text NOT NULL,
	"effort" text DEFAULT 'low' NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"user_content" text NOT NULL,
	"assistant_content" text,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "assistant_turns_created_by_length_check" CHECK (char_length(btrim("assistant_turns"."created_by")) between 1 and 200),
	CONSTRAINT "assistant_turns_sequence_check" CHECK ("assistant_turns"."sequence" >= 1),
	CONSTRAINT "assistant_turns_attempt_check" CHECK ("assistant_turns"."attempt" >= 1),
	CONSTRAINT "assistant_turns_status_check" CHECK ("assistant_turns"."status" in ('queued', 'running', 'succeeded', 'failed')),
	CONSTRAINT "assistant_turns_model_check" CHECK ("assistant_turns"."model" in ('openai/gpt-5.6-luna', 'openai/gpt-5.6-terra', 'google/gemini-3.6-flash')),
	CONSTRAINT "assistant_turns_effort_check" CHECK ("assistant_turns"."effort" in ('low', 'medium', 'high')),
	CONSTRAINT "assistant_turns_user_content_length_check" CHECK (char_length(btrim("assistant_turns"."user_content")) between 1 and 20000),
	CONSTRAINT "assistant_turns_error_fields_check" CHECK (("assistant_turns"."status" = 'failed' and "assistant_turns"."error_code" is not null and "assistant_turns"."error_message" is not null) or ("assistant_turns"."status" <> 'failed' and "assistant_turns"."error_code" is null and "assistant_turns"."error_message" is null)),
	CONSTRAINT "assistant_turns_error_code_check" CHECK ("assistant_turns"."error_code" is null or "assistant_turns"."error_code" in ('provider_unavailable', 'provider_rejected', 'generation_failed')),
	CONSTRAINT "assistant_turns_result_check" CHECK (("assistant_turns"."status" = 'succeeded' and "assistant_turns"."assistant_content" is not null and char_length(btrim("assistant_turns"."assistant_content")) >= 1 and "assistant_turns"."completed_at" is not null) or ("assistant_turns"."status" <> 'succeeded' and "assistant_turns"."assistant_content" is null)),
	CONSTRAINT "assistant_turns_completion_check" CHECK (("assistant_turns"."status" in ('succeeded', 'failed') and "assistant_turns"."completed_at" is not null) or ("assistant_turns"."status" in ('queued', 'running') and "assistant_turns"."completed_at" is null))
);
--> statement-breakpoint
DROP TABLE "assistant_runs" CASCADE;--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_threads_id_owner_uidx" ON "assistant_threads" USING btree ("id","created_by");--> statement-breakpoint
ALTER TABLE "assistant_turns" ADD CONSTRAINT "assistant_turns_thread_owner_fk" FOREIGN KEY ("thread_id","created_by") REFERENCES "public"."assistant_threads"("id","created_by") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assistant_threads_owner_updated_idx" ON "assistant_threads" USING btree ("created_by","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_turns_thread_sequence_uidx" ON "assistant_turns" USING btree ("thread_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_turns_owner_request_id_uidx" ON "assistant_turns" USING btree ("created_by","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_turns_one_active_per_thread_uidx" ON "assistant_turns" USING btree ("thread_id") WHERE "assistant_turns"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "assistant_turns_status_created_idx" ON "assistant_turns" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "assistant_turns_thread_created_idx" ON "assistant_turns" USING btree ("thread_id","created_at");
