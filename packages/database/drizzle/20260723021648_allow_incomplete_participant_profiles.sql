ALTER TABLE "participants" ALTER COLUMN "preferred_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "participants" ALTER COLUMN "phone_e164" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "participants" ALTER COLUMN "age_band" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "participants" ALTER COLUMN "preferred_neighborhood" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "participants" ALTER COLUMN "conversation_style" DROP NOT NULL;
