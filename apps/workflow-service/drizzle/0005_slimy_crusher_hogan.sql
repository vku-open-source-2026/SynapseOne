CREATE TABLE "synapseone_workflow_runner_instances" (
	"id" text PRIMARY KEY NOT NULL,
	"runner_id" text NOT NULL,
	"hostname" text DEFAULT '' NOT NULL,
	"version" text,
	"queue" text DEFAULT '' NOT NULL,
	"concurrency" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_synapseone_runner_instances_runner" ON "synapseone_workflow_runner_instances" USING btree ("runner_id");--> statement-breakpoint
CREATE INDEX "idx_synapseone_runner_instances_seen" ON "synapseone_workflow_runner_instances" USING btree ("last_seen_at" DESC NULLS LAST);