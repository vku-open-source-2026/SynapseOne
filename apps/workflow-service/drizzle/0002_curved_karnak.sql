CREATE TABLE "synapseone_human_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"execution_id" text,
	"workflow_id" text,
	"node_name" text DEFAULT '' NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"assignee" text,
	"candidate_roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"decision_schema" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"decision" jsonb,
	"note" text,
	"claimed_by" text,
	"claimed_at" timestamp with time zone,
	"completed_by" text,
	"completed_at" timestamp with time zone,
	"deadline" timestamp with time zone,
	"escalated_at" timestamp with time zone,
	"org_id" text,
	"account_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_synapseone_human_tasks_status" ON "synapseone_human_tasks" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_synapseone_human_tasks_execution" ON "synapseone_human_tasks" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX "idx_synapseone_human_tasks_tenant" ON "synapseone_human_tasks" USING btree ("org_id","account_id");--> statement-breakpoint
CREATE INDEX "idx_synapseone_human_tasks_deadline" ON "synapseone_human_tasks" USING btree ("status","deadline");