ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_type_length_check" CHECK (char_length(btrim("audit_events"."actor_type")) between 1 and 64);--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_id_length_check" CHECK (char_length(btrim("audit_events"."actor_id")) between 1 and 200);--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_action_length_check" CHECK (char_length(btrim("audit_events"."action")) between 1 and 120);--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_entity_type_length_check" CHECK (char_length(btrim("audit_events"."entity_type")) between 1 and 64);--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_entity_id_length_check" CHECK (char_length(btrim("audit_events"."entity_id")) between 1 and 200);--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_request_id_length_check" CHECK (char_length(btrim("audit_events"."request_id")) between 1 and 128);--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_context_object_check" CHECK (jsonb_typeof("audit_events"."context") = 'object');--> statement-breakpoint
ALTER TABLE "reference_records" ADD CONSTRAINT "reference_records_label_length_check" CHECK (char_length(btrim("reference_records"."label")) between 1 and 120);