ALTER TABLE "synapseone_workflow_runners" ADD COLUMN "audience" text DEFAULT 'account' NOT NULL;
--> statement-breakpoint
UPDATE "synapseone_workflow_runners" SET "audience" = 'org' WHERE "account_id" IS NULL;