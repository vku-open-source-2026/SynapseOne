ALTER TABLE "synapseone_base_outbox" ADD COLUMN IF NOT EXISTS "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "synapseone_base_outbox" ADD COLUMN IF NOT EXISTS "last_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "synapseone_base_outbox" ADD COLUMN IF NOT EXISTS "dead_lettered_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_base_outbox_due" ON "synapseone_base_outbox" USING btree ("published_at","dead_lettered_at","next_attempt_at","occurred_at");
