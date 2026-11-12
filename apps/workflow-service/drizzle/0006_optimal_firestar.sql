CREATE TABLE "synapseone_inference_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text DEFAULT 'chat' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"request" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"error" text,
	"org_id" text,
	"account_id" text,
	"runner_id" text,
	"instance_id" text,
	"queue_name" text,
	"attempt" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "synapseone_workflow_runners" ADD COLUMN "kind" text DEFAULT 'workflow' NOT NULL;--> statement-breakpoint
ALTER TABLE "synapseone_workflow_runners" ADD COLUMN "inference_queue" text;--> statement-breakpoint
CREATE INDEX "idx_synapseone_inference_jobs_status" ON "synapseone_inference_jobs" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_synapseone_inference_jobs_tenant" ON "synapseone_inference_jobs" USING btree ("org_id","account_id");--> statement-breakpoint
CREATE INDEX "idx_synapseone_inference_jobs_runner" ON "synapseone_inference_jobs" USING btree ("runner_id","created_at" DESC NULLS LAST);