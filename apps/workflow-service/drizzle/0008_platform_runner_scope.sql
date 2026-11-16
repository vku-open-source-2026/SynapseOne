ALTER TABLE "synapseone_workflow_runners" ADD COLUMN IF NOT EXISTS "scope" text DEFAULT 'tenant' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_synapseone_runners_scope" ON "synapseone_workflow_runners" USING btree ("scope");
