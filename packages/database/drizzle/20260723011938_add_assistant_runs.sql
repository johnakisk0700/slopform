CREATE TABLE "assistant_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_by" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"model" text NOT NULL,
	"messages" jsonb NOT NULL,
	"response" text,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "assistant_runs_created_by_length_check" CHECK (char_length(btrim("assistant_runs"."created_by")) between 1 and 200),
	CONSTRAINT "assistant_runs_status_check" CHECK ("assistant_runs"."status" in ('queued', 'running', 'succeeded', 'failed')),
	CONSTRAINT "assistant_runs_model_check" CHECK ("assistant_runs"."model" in ('qwen/qwen3.7-max', 'qwen/qwen3.6-plus', 'openai/gpt-5.4-mini')),
	CONSTRAINT "assistant_runs_messages_array_check" CHECK (jsonb_typeof("assistant_runs"."messages") = 'array' and jsonb_array_length("assistant_runs"."messages") between 1 and 50),
	CONSTRAINT "assistant_runs_error_fields_check" CHECK (("assistant_runs"."status" = 'failed' and "assistant_runs"."error_code" is not null and "assistant_runs"."error_message" is not null) or ("assistant_runs"."status" <> 'failed' and "assistant_runs"."error_code" is null and "assistant_runs"."error_message" is null)),
	CONSTRAINT "assistant_runs_result_check" CHECK (("assistant_runs"."status" = 'succeeded' and "assistant_runs"."response" is not null and "assistant_runs"."completed_at" is not null) or ("assistant_runs"."status" <> 'succeeded' and "assistant_runs"."response" is null)),
	CONSTRAINT "assistant_runs_completion_check" CHECK (("assistant_runs"."status" in ('succeeded', 'failed') and "assistant_runs"."completed_at" is not null) or ("assistant_runs"."status" in ('queued', 'running') and "assistant_runs"."completed_at" is null))
);
--> statement-breakpoint
CREATE INDEX "assistant_runs_status_created_idx" ON "assistant_runs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "assistant_runs_owner_created_idx" ON "assistant_runs" USING btree ("created_by","created_at");