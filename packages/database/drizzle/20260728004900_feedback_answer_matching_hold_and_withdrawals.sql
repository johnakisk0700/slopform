CREATE TABLE "feedback_answer_withdrawals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"question_key" text NOT NULL,
	"subject_participant_id" uuid,
	"answer_id" uuid NOT NULL,
	"withdrawn_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_by" text NOT NULL,
	CONSTRAINT "feedback_answer_withdrawals_conversation_question_subject_uidx" UNIQUE NULLS NOT DISTINCT("conversation_id","question_key","subject_participant_id"),
	CONSTRAINT "feedback_answer_withdrawals_question_key_check" CHECK ("feedback_answer_withdrawals"."question_key" in ('event_score', 'liked', 'meet_again', 'avoid')),
	CONSTRAINT "feedback_answer_withdrawals_withdrawn_by_length_check" CHECK (char_length(btrim("feedback_answer_withdrawals"."withdrawn_by")) between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "feedback_answers" ADD COLUMN "matching_hold" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "feedback_answer_withdrawals" ADD CONSTRAINT "feedback_answer_withdrawals_campaign_id_feedback_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."feedback_campaigns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_answer_withdrawals" ADD CONSTRAINT "feedback_answer_withdrawals_subject_participant_id_participants_id_fk" FOREIGN KEY ("subject_participant_id") REFERENCES "public"."participants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feedback_answer_withdrawals_campaign_withdrawn_at_idx" ON "feedback_answer_withdrawals" USING btree ("campaign_id","withdrawn_at");