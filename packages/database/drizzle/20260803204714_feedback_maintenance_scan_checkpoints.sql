CREATE TABLE "feedback_maintenance_checkpoints" (
	"task" text PRIMARY KEY NOT NULL,
	"cursor_at" timestamp with time zone,
	"cursor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_maintenance_checkpoints_task_check" CHECK ("feedback_maintenance_checkpoints"."task" in ('conversation_due', 'summary_auto')),
	CONSTRAINT "feedback_maintenance_checkpoints_cursor_shape_check" CHECK (("feedback_maintenance_checkpoints"."task" = 'conversation_due' and (("feedback_maintenance_checkpoints"."cursor_at" is null and "feedback_maintenance_checkpoints"."cursor_id" is null) or ("feedback_maintenance_checkpoints"."cursor_at" is not null and "feedback_maintenance_checkpoints"."cursor_id" is not null))) or ("feedback_maintenance_checkpoints"."task" = 'summary_auto' and "feedback_maintenance_checkpoints"."cursor_at" is null))
);
