ALTER TABLE "events" ADD COLUMN "venue_provider" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "venue_place_id" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "venue_label" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "venue_type" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "venue_area" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "venue_price_level" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "venue_price_start_minor" integer;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "venue_price_end_minor" integer;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "venue_price_currency_code" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "venue_use_in_feedback" boolean;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "venue_context_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_venue_shape_check" CHECK ((
        "events"."venue_provider" is null and
        "events"."venue_place_id" is null and
        "events"."venue_label" is null and
        "events"."venue_type" is null and
        "events"."venue_area" is null and
        "events"."venue_price_level" is null and
        "events"."venue_price_start_minor" is null and
        "events"."venue_price_end_minor" is null and
        "events"."venue_price_currency_code" is null and
        "events"."venue_use_in_feedback" is null
      ) or (
        "events"."venue_provider" is not null and
        "events"."venue_provider" = 'google' and
        "events"."venue_place_id" is not null and
        "events"."venue_label" is not null and
        "events"."venue_use_in_feedback" is not null and
        "events"."venue_context_revision" >= 1
      ));--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_venue_place_id_nonempty_check" CHECK ("events"."venue_place_id" is null or "events"."venue_place_id" ~ '[^[:space:]]');--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_venue_label_length_check" CHECK ("events"."venue_label" is null or char_length(regexp_replace("events"."venue_label", '^[[:space:]]+|[[:space:]]+$', '', 'g')) between 1 and 200);--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_venue_type_length_check" CHECK ("events"."venue_type" is null or char_length(regexp_replace("events"."venue_type", '^[[:space:]]+|[[:space:]]+$', '', 'g')) between 1 and 100);--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_venue_area_length_check" CHECK ("events"."venue_area" is null or char_length(regexp_replace("events"."venue_area", '^[[:space:]]+|[[:space:]]+$', '', 'g')) between 1 and 200);--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_venue_price_level_check" CHECK ("events"."venue_price_level" is null or "events"."venue_price_level" in ('free', 'inexpensive', 'moderate', 'expensive', 'very_expensive'));--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_venue_price_range_check" CHECK ((
        "events"."venue_price_start_minor" is null and
        "events"."venue_price_end_minor" is null and
        "events"."venue_price_currency_code" is null
      ) or (
        "events"."venue_price_start_minor" is not null and
        "events"."venue_price_start_minor" >= 0 and
        ("events"."venue_price_end_minor" is null or "events"."venue_price_end_minor" >= "events"."venue_price_start_minor") and
        "events"."venue_price_currency_code" is not null and
        "events"."venue_price_currency_code" ~ '^[A-Z]{3}$'
      ));--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_venue_context_revision_check" CHECK ("events"."venue_context_revision" >= 0);
