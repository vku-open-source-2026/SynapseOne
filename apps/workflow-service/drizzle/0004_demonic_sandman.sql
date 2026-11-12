CREATE TABLE "synapseone_workflow_runners" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"mode" text DEFAULT 'custom' NOT NULL,
	"queue" text NOT NULL,
	"org_id" text,
	"account_id" text,
	"api_key_id" text,
	"key_prefix" text,
	"status" text DEFAULT 'waiting' NOT NULL,
	"version" text,
	"last_seen_at" timestamp with time zone,
	"last_error" text,
	"created_by" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "synapseone_executions" ADD COLUMN "queue_name" text;--> statement-breakpoint
ALTER TABLE "synapseone_executions" ADD COLUMN "runner" text;--> statement-breakpoint
ALTER TABLE "synapseone_executions" ADD COLUMN "worker_id" text;--> statement-breakpoint
ALTER TABLE "synapseone_executions" ADD COLUMN "attempt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "synapseone_executions" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "synapseone_executions" ADD COLUMN "workflow_revision" integer;--> statement-breakpoint
ALTER TABLE "synapseone_executions" ADD COLUMN "resume_node" text;--> statement-breakpoint
ALTER TABLE "synapseone_executions" ADD COLUMN "resume_output" jsonb;--> statement-breakpoint
CREATE INDEX "idx_synapseone_runners_tenant" ON "synapseone_workflow_runners" USING btree ("org_id","account_id");--> statement-breakpoint
CREATE INDEX "idx_synapseone_runners_queue" ON "synapseone_workflow_runners" USING btree ("queue");--> statement-breakpoint
CREATE INDEX "idx_synapseone_runners_seen" ON "synapseone_workflow_runners" USING btree ("last_seen_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_synapseone_exec_queue" ON "synapseone_executions" USING btree ("status","queue_name");