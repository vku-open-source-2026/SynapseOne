CREATE TABLE IF NOT EXISTS "synapseone_workflow_cron_claims" (
	"workflow_id" text PRIMARY KEY NOT NULL,
	"slot_key" text NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "synapseone_workflow_webhook_deliveries" (
	"workflow_id" text NOT NULL,
	"delivery_key" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "synapseone_workflow_webhook_deliveries_workflow_id_delivery_key_pk" PRIMARY KEY("workflow_id","delivery_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "synapseone_workflow_webhook_rate_buckets" (
	"workflow_id" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "synapseone_workflow_webhook_rate_buckets_workflow_id_window_start_pk" PRIMARY KEY("workflow_id","window_start")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_synapseone_webhook_deliveries_expiry" ON "synapseone_workflow_webhook_deliveries" USING btree ("expires_at");
