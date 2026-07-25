ALTER TABLE "assistant_turns" DROP CONSTRAINT "assistant_turns_model_check";--> statement-breakpoint
ALTER TABLE "assistant_turns" ADD CONSTRAINT "assistant_turns_model_check" CHECK ("assistant_turns"."model" in ('openai/gpt-5.6-luna', 'openai/gpt-5.6-terra', 'google/gemini-3.6-flash', 'qwen/qwen3.7-max'));
