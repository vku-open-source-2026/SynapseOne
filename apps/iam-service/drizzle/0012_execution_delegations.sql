CREATE TABLE IF NOT EXISTS "execution_delegations" (
	"jti" uuid PRIMARY KEY NOT NULL,
	"execution_id" text NOT NULL,
	"runner_id" text NOT NULL,
	"instance_id" text,
	"user_id" uuid NOT NULL,
	"org_id" uuid,
	"account_id" uuid,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_execution_delegations_execution" ON "execution_delegations" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_execution_delegations_runner" ON "execution_delegations" USING btree ("runner_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_execution_delegations_expiry" ON "execution_delegations" USING btree ("expires_at") WHERE "execution_delegations"."revoked_at" is null;
