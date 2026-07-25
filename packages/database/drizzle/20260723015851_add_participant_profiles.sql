CREATE TABLE "participant_interests" (
	"participant_id" uuid NOT NULL,
	"interest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "participant_interests_pk" PRIMARY KEY("participant_id","interest"),
	CONSTRAINT "participant_interests_interest_check" CHECK ("participant_interests"."interest" in ('travel', 'cooking_food', 'art_music', 'sports', 'technology', 'books', 'cinema', 'entrepreneurship', 'nature_outdoors', 'board_games'))
);
--> statement-breakpoint
CREATE TABLE "participant_source_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"participant_id" uuid NOT NULL,
	"source_system" text NOT NULL,
	"source_record_id" text NOT NULL,
	"source_user_id" text,
	"source_updated_at" timestamp with time zone,
	"payload_hash" text NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "participant_source_records_source_system_length_check" CHECK (char_length(btrim("participant_source_records"."source_system")) between 1 and 64),
	CONSTRAINT "participant_source_records_source_record_id_length_check" CHECK (char_length(btrim("participant_source_records"."source_record_id")) between 1 and 200),
	CONSTRAINT "participant_source_records_source_user_id_length_check" CHECK (char_length(btrim("participant_source_records"."source_user_id")) between 1 and 200),
	CONSTRAINT "participant_source_records_payload_hash_check" CHECK ("participant_source_records"."payload_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"preferred_name" text NOT NULL,
	"email_normalized" text NOT NULL,
	"phone_e164" text NOT NULL,
	"age_band" text NOT NULL,
	"preferred_neighborhood" text NOT NULL,
	"conversation_style" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "participants_preferred_name_length_check" CHECK (char_length(btrim("participants"."preferred_name")) between 1 and 120),
	CONSTRAINT "participants_email_normalized_check" CHECK (char_length("participants"."email_normalized") between 3 and 320 and "participants"."email_normalized" = lower(btrim("participants"."email_normalized"))),
	CONSTRAINT "participants_phone_e164_check" CHECK ("participants"."phone_e164" ~ '^\+[1-9][0-9]{7,14}$'),
	CONSTRAINT "participants_age_band_check" CHECK ("participants"."age_band" in ('18_24', '25_34', '35_44', '45_54', '55_plus')),
	CONSTRAINT "participants_preferred_neighborhood_check" CHECK ("participants"."preferred_neighborhood" in ('kolonaki', 'koukaki', 'exarcheia', 'pangrati', 'glyfada', 'chalandri', 'psyrri', 'nea_smyrni', 'marousi', 'petralona')),
	CONSTRAINT "participants_conversation_style_check" CHECK ("participants"."conversation_style" between 1 and 5)
);
--> statement-breakpoint
ALTER TABLE "participant_interests" ADD CONSTRAINT "participant_interests_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant_source_records" ADD CONSTRAINT "participant_source_records_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "participant_interests_interest_idx" ON "participant_interests" USING btree ("interest","participant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "participant_source_records_source_uidx" ON "participant_source_records" USING btree ("source_system","source_record_id");--> statement-breakpoint
CREATE INDEX "participant_source_records_participant_idx" ON "participant_source_records" USING btree ("participant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "participants_email_normalized_uidx" ON "participants" USING btree ("email_normalized");--> statement-breakpoint
CREATE INDEX "participants_matching_idx" ON "participants" USING btree ("preferred_neighborhood","age_band");