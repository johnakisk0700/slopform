CREATE TABLE "event_attendees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"table_no" integer,
	"present" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_attendees_table_no_check" CHECK ("event_attendees"."table_no" is null or "event_attendees"."table_no" between 1 and 999)
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_title_length_check" CHECK (char_length(btrim("events"."title")) between 1 and 200),
	CONSTRAINT "events_status_check" CHECK ("events"."status" in ('draft', 'scheduled', 'finished', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "participants" ADD COLUMN "post_event_feedback_whatsapp_opt_in" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "event_attendees" ADD CONSTRAINT "event_attendees_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_attendees" ADD CONSTRAINT "event_attendees_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "event_attendees_event_participant_uidx" ON "event_attendees" USING btree ("event_id","participant_id");--> statement-breakpoint
CREATE INDEX "event_attendees_event_present_idx" ON "event_attendees" USING btree ("event_id","present");--> statement-breakpoint
CREATE INDEX "event_attendees_participant_idx" ON "event_attendees" USING btree ("participant_id");--> statement-breakpoint
CREATE INDEX "events_status_starts_at_idx" ON "events" USING btree ("status","starts_at");