ALTER TABLE "synapseone_executions" ADD COLUMN IF NOT EXISTS "resource_requirements" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "synapseone_inference_jobs" ADD COLUMN IF NOT EXISTS "resource_requirements" jsonb DEFAULT '{}'::jsonb NOT NULL;
