CREATE TABLE "synapseone_base_outbox" (
	"event_id" text PRIMARY KEY NOT NULL,
	"org_id" text,
	"account_id" text,
	"collection_id" text NOT NULL,
	"collection_name" text DEFAULT '' NOT NULL,
	"document_id" text NOT NULL,
	"operation" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"published_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE INDEX "idx_base_outbox_unpublished" ON "synapseone_base_outbox" USING btree ("published_at","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_base_outbox_collection" ON "synapseone_base_outbox" USING btree ("collection_id","occurred_at");