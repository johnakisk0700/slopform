ALTER TABLE "message_outbox" ADD COLUMN "dispatch_context" jsonb;--> statement-breakpoint
UPDATE "message_outbox" AS o
SET "dispatch_context" = jsonb_build_object(
	'schemaVersion', 1,
	'purpose', 'extraction_reply',
	'evidence', jsonb_build_object(
		'latestMessageSeq', l."conversation_state"->'latestMessageSeq',
		'control', l."conversation_state"->'control',
		'work', l."conversation_state"->'work',
		'participantIngressIds', l."conversation_state"->'participantIngressIds'
	)
)
FROM "message_outbox_log" AS l
WHERE l."outbox_id" = o."id"
	AND l."conversation_id" = o."conversation_id"
	AND l."campaign_id" = o."campaign_id"
	AND l."decision"->>'origin' = l."origin"
	AND o."dispatch_context" IS NULL
	AND l."origin" = 'extraction_reply'
	AND o."kind" = 'reply'
	AND l."decision"->'closingReason' = 'null'::jsonb
	AND (
		o."dedupe_key" ~ ('^feedback-reply-' || o."conversation_id"::text || '-[0-9]+$')
		OR o."dedupe_key" ~ ('^feedback-handoff-' || o."conversation_id"::text || '-[0-9]+$')
		OR o."dedupe_key" = 'feedback-hostility-stop-' || o."conversation_id"::text
	);--> statement-breakpoint
UPDATE "message_outbox" AS o
SET "dispatch_context" = jsonb_build_object(
	'schemaVersion', 1,
	'purpose', 'extraction_closing',
	'closingReason', l."decision"->>'closingReason'
)
FROM "message_outbox_log" AS l
WHERE l."outbox_id" = o."id"
	AND l."conversation_id" = o."conversation_id"
	AND l."campaign_id" = o."campaign_id"
	AND l."decision"->>'origin' = l."origin"
	AND o."dispatch_context" IS NULL
	AND l."origin" = 'extraction_reply'
	AND o."kind" = 'reply'
	AND (l."decision"->>'closingReason') IN ('completed', 'declined')
	AND (
		o."dedupe_key" = 'feedback-closing-' || o."conversation_id"::text
		OR o."dedupe_key" ~ ('^feedback-closing-' || o."conversation_id"::text || '-[0-9]+(-r[0-9]+)?$')
	);--> statement-breakpoint
UPDATE "message_outbox" AS o
SET "dispatch_context" = jsonb_build_object('schemaVersion', 1, 'purpose', 'campaign_intro')
FROM "message_outbox_log" AS l
WHERE l."outbox_id" = o."id"
	AND l."conversation_id" = o."conversation_id"
	AND l."campaign_id" = o."campaign_id"
	AND l."decision"->>'origin' = l."origin"
	AND o."dispatch_context" IS NULL
	AND l."origin" = 'campaign_intro'
	AND o."kind" = 'intro'
	AND o."dedupe_key" = 'feedback-intro-' || o."conversation_id"::text;--> statement-breakpoint
UPDATE "message_outbox" AS o
SET "dispatch_context" = jsonb_build_object(
	'schemaVersion', 1,
	'purpose', 'reminder',
	'rung', l."decision"->'rung'
)
FROM "message_outbox_log" AS l
WHERE l."outbox_id" = o."id"
	AND l."conversation_id" = o."conversation_id"
	AND l."campaign_id" = o."campaign_id"
	AND l."decision"->>'origin' = l."origin"
	AND o."dispatch_context" IS NULL
	AND l."origin" = 'reminder'
	AND o."kind" = 'reminder'
	AND (l."decision"->>'rung') IS NOT NULL
	AND o."dedupe_key" = 'feedback-reminder-' || o."conversation_id"::text || '-' || (l."decision"->>'rung');--> statement-breakpoint
UPDATE "message_outbox" AS o
SET "dispatch_context" = jsonb_build_object(
	'schemaVersion', 1,
	'purpose', 'staff_message',
	'staffActorId', l."decision"->>'staffActorId'
)
FROM "message_outbox_log" AS l
WHERE l."outbox_id" = o."id"
	AND l."conversation_id" = o."conversation_id"
	AND l."campaign_id" = o."campaign_id"
	AND l."decision"->>'origin' = l."origin"
	AND o."dispatch_context" IS NULL
	AND l."origin" = 'staff_message'
	AND o."kind" = 'staff'
	AND (l."decision"->>'staffActorId') IS NOT NULL
	AND o."dedupe_key" LIKE 'feedback-staff-' || o."conversation_id"::text || '-%';--> statement-breakpoint
UPDATE "message_outbox" AS o
SET "dispatch_context" = jsonb_build_object(
	'schemaVersion', 1,
	'purpose', 'stop_ack',
	'sourceIngressId', l."decision"->>'sourceIngressId'
)
FROM "message_outbox_log" AS l
WHERE l."outbox_id" = o."id"
	AND l."conversation_id" = o."conversation_id"
	AND l."campaign_id" = o."campaign_id"
	AND l."decision"->>'origin' = l."origin"
	AND o."dispatch_context" IS NULL
	AND l."origin" = 'stop_ack'
	AND o."kind" = 'system'
	AND (l."decision"->>'sourceIngressId') IS NOT NULL
	AND o."dedupe_key" = 'feedback-stop-ack-' || o."conversation_id"::text;--> statement-breakpoint
UPDATE "message_outbox" AS o
SET "dispatch_context" = jsonb_build_object(
	'schemaVersion', 1,
	'purpose', 'media_notice',
	'sourceIngressId', l."decision"->>'sourceIngressId'
)
FROM "message_outbox_log" AS l
WHERE l."outbox_id" = o."id"
	AND l."conversation_id" = o."conversation_id"
	AND l."campaign_id" = o."campaign_id"
	AND l."decision"->>'origin' = l."origin"
	AND o."dispatch_context" IS NULL
	AND l."origin" = 'media_notice'
	AND o."kind" = 'system'
	AND (l."decision"->>'sourceIngressId') IS NOT NULL
	AND o."dedupe_key" = 'feedback-media-notice-' || o."conversation_id"::text;--> statement-breakpoint
UPDATE "message_outbox" AS o
SET "dispatch_context" = jsonb_build_object('schemaVersion', 1, 'purpose', 'extraction_parked_notice')
FROM "message_outbox_log" AS l
WHERE l."outbox_id" = o."id"
	AND l."conversation_id" = o."conversation_id"
	AND l."campaign_id" = o."campaign_id"
	AND l."decision"->>'origin' = l."origin"
	AND o."dispatch_context" IS NULL
	AND l."origin" = 'extraction_parked_notice'
	AND o."kind" = 'system'
	AND o."dedupe_key" = 'feedback-parked-' || o."conversation_id"::text || '-notice';--> statement-breakpoint
UPDATE "message_outbox" AS o
SET "dispatch_context" = jsonb_build_object('schemaVersion', 1, 'purpose', 'extraction_fallback_fence')
FROM "message_outbox_log" AS l
WHERE l."outbox_id" = o."id"
	AND l."conversation_id" = o."conversation_id"
	AND l."campaign_id" = o."campaign_id"
	AND l."decision"->>'origin' = l."origin"
	AND o."dispatch_context" IS NULL
	AND l."origin" = 'extraction_fallback_fence'
	AND o."kind" = 'system'
	AND o."dedupe_key" ~ ('^feedback-fallback-' || o."conversation_id"::text || '-[0-9]+$');--> statement-breakpoint
UPDATE "message_outbox" AS o
SET "dispatch_context" = jsonb_build_object('schemaVersion', 1, 'purpose', 'extraction_fallback_ack')
FROM "message_outbox_log" AS l
WHERE l."outbox_id" = o."id"
	AND l."conversation_id" = o."conversation_id"
	AND l."campaign_id" = o."campaign_id"
	AND l."decision"->>'origin' = l."origin"
	AND o."dispatch_context" IS NULL
	AND l."origin" = 'extraction_fallback_ack'
	AND o."kind" = 'system'
	AND o."dedupe_key" = 'feedback-fallback-' || o."conversation_id"::text || '-ack';--> statement-breakpoint
UPDATE "message_outbox"
SET "dispatch_context" = jsonb_build_object('schemaVersion', 1, 'purpose', 'unusable_legacy')
WHERE "dispatch_context" IS NULL;--> statement-breakpoint
UPDATE "message_outbox"
SET
	"status" = 'cancelled',
	"claim_expires_at" = NULL,
	"last_error" = 'dispatch_context_unusable',
	"updated_at" = now()
WHERE "dispatch_context"->>'purpose' = 'unusable_legacy'
	AND "status" IN ('pending', 'held', 'claimed')
	AND "send_started_at" IS NULL;--> statement-breakpoint
ALTER TABLE "message_outbox" ALTER COLUMN "dispatch_context" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "message_outbox" ADD CONSTRAINT "message_outbox_dispatch_context_object_check" CHECK (jsonb_typeof("message_outbox"."dispatch_context") = 'object');
