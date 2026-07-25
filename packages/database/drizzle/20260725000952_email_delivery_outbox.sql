CREATE TABLE "email_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_by" text NOT NULL,
	"request_id" uuid NOT NULL,
	"request_fingerprint" text NOT NULL,
	"recipient_email" text NOT NULL,
	"subject" text NOT NULL,
	"text_body" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "email_deliveries_created_by_length_check" CHECK (char_length(btrim("email_deliveries"."created_by")) between 1 and 200),
	CONSTRAINT "email_deliveries_fingerprint_check" CHECK ("email_deliveries"."request_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "email_deliveries_recipient_length_check" CHECK (char_length("email_deliveries"."recipient_email") between 3 and 320),
	CONSTRAINT "email_deliveries_subject_length_check" CHECK (char_length(btrim("email_deliveries"."subject")) between 1 and 200),
	CONSTRAINT "email_deliveries_body_length_check" CHECK (char_length(btrim("email_deliveries"."text_body")) between 1 and 100000),
	CONSTRAINT "email_deliveries_status_check" CHECK ("email_deliveries"."status" in ('queued', 'processing', 'retry_scheduled', 'blocked', 'sent', 'failed')),
	CONSTRAINT "email_deliveries_attempt_count_check" CHECK ("email_deliveries"."attempt_count" >= 0),
	CONSTRAINT "email_deliveries_lease_check" CHECK (("email_deliveries"."status" = 'processing' and "email_deliveries"."lease_token" is not null and "email_deliveries"."lease_until" is not null) or ("email_deliveries"."status" <> 'processing' and "email_deliveries"."lease_token" is null and "email_deliveries"."lease_until" is null)),
	CONSTRAINT "email_deliveries_next_attempt_check" CHECK (("email_deliveries"."status" = 'retry_scheduled' and "email_deliveries"."next_attempt_at" is not null) or ("email_deliveries"."status" <> 'retry_scheduled' and "email_deliveries"."next_attempt_at" is null)),
	CONSTRAINT "email_deliveries_error_check" CHECK (("email_deliveries"."status" in ('retry_scheduled', 'blocked', 'failed') and "email_deliveries"."last_error_code" is not null) or ("email_deliveries"."status" in ('queued', 'processing', 'sent') and "email_deliveries"."last_error_code" is null)),
	CONSTRAINT "email_deliveries_completion_check" CHECK (("email_deliveries"."status" in ('blocked', 'sent', 'failed') and "email_deliveries"."completed_at" is not null) or ("email_deliveries"."status" in ('queued', 'processing', 'retry_scheduled') and "email_deliveries"."completed_at" is null))
);
--> statement-breakpoint
CREATE TABLE "email_delivery_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"status" text DEFAULT 'processing' NOT NULL,
	"error_code" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "email_delivery_attempts_number_check" CHECK ("email_delivery_attempts"."attempt_number" >= 1),
	CONSTRAINT "email_delivery_attempts_status_check" CHECK ("email_delivery_attempts"."status" in ('processing', 'retry_scheduled', 'blocked', 'sent', 'failed', 'unknown')),
	CONSTRAINT "email_delivery_attempts_completion_check" CHECK (("email_delivery_attempts"."status" = 'processing' and "email_delivery_attempts"."completed_at" is null) or ("email_delivery_attempts"."status" <> 'processing' and "email_delivery_attempts"."completed_at" is not null)),
	CONSTRAINT "email_delivery_attempts_error_check" CHECK (("email_delivery_attempts"."status" in ('retry_scheduled', 'blocked', 'failed', 'unknown') and "email_delivery_attempts"."error_code" is not null) or ("email_delivery_attempts"."status" in ('processing', 'sent') and "email_delivery_attempts"."error_code" is null))
);
--> statement-breakpoint
CREATE TABLE "email_outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_id" uuid NOT NULL,
	"event_type" text DEFAULT 'email.delivery.requested.v1' NOT NULL,
	"correlation_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"publish_attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "email_outbox_events_type_check" CHECK ("email_outbox_events"."event_type" = 'email.delivery.requested.v1'),
	CONSTRAINT "email_outbox_events_correlation_length_check" CHECK (char_length(btrim("email_outbox_events"."correlation_id")) between 1 and 128),
	CONSTRAINT "email_outbox_events_status_check" CHECK ("email_outbox_events"."status" in ('pending', 'publishing', 'dispatched', 'consumed')),
	CONSTRAINT "email_outbox_events_attempts_check" CHECK ("email_outbox_events"."publish_attempts" >= 0),
	CONSTRAINT "email_outbox_events_lease_check" CHECK (("email_outbox_events"."status" = 'publishing' and "email_outbox_events"."lease_token" is not null and "email_outbox_events"."lease_until" is not null) or ("email_outbox_events"."status" <> 'publishing' and "email_outbox_events"."lease_token" is null and "email_outbox_events"."lease_until" is null)),
	CONSTRAINT "email_outbox_events_published_check" CHECK (("email_outbox_events"."status" in ('dispatched', 'consumed') and "email_outbox_events"."dispatched_at" is not null) or ("email_outbox_events"."status" in ('pending', 'publishing') and "email_outbox_events"."dispatched_at" is null)),
	CONSTRAINT "email_outbox_events_consumed_check" CHECK (("email_outbox_events"."status" = 'consumed' and "email_outbox_events"."consumed_at" is not null) or ("email_outbox_events"."status" <> 'consumed' and "email_outbox_events"."consumed_at" is null))
);
--> statement-breakpoint
ALTER TABLE "email_delivery_attempts" ADD CONSTRAINT "email_delivery_attempts_delivery_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."email_deliveries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_outbox_events" ADD CONSTRAINT "email_outbox_events_delivery_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."email_deliveries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_deliveries_owner_request_uidx" ON "email_deliveries" USING btree ("created_by","request_id");--> statement-breakpoint
CREATE INDEX "email_deliveries_owner_created_idx" ON "email_deliveries" USING btree ("created_by","created_at");--> statement-breakpoint
CREATE INDEX "email_deliveries_due_idx" ON "email_deliveries" USING btree ("status","next_attempt_at","created_at");--> statement-breakpoint
CREATE INDEX "email_deliveries_lease_idx" ON "email_deliveries" USING btree ("status","lease_until");--> statement-breakpoint
CREATE UNIQUE INDEX "email_delivery_attempts_delivery_number_uidx" ON "email_delivery_attempts" USING btree ("delivery_id","attempt_number");--> statement-breakpoint
CREATE INDEX "email_delivery_attempts_delivery_started_idx" ON "email_delivery_attempts" USING btree ("delivery_id","started_at");--> statement-breakpoint
CREATE INDEX "email_outbox_events_claim_idx" ON "email_outbox_events" USING btree ("status","available_at","created_at");--> statement-breakpoint
CREATE INDEX "email_outbox_events_lease_idx" ON "email_outbox_events" USING btree ("status","lease_until");