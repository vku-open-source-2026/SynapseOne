ALTER TABLE "synapseone_executions" ADD COLUMN IF NOT EXISTS "target_runner_id" text;
--> statement-breakpoint
ALTER TABLE "synapseone_inference_jobs" ADD COLUMN IF NOT EXISTS "target_runner_id" text;
