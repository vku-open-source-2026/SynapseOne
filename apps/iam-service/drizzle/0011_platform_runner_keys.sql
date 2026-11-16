CREATE TABLE IF NOT EXISTS "platform_runner_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"runner_id" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"key_prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_by" uuid,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_runner_keys_key_hash_key" ON "platform_runner_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_platform_runner_keys_runner" ON "platform_runner_keys" USING btree ("runner_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_platform_runner_keys_expiry" ON "platform_runner_keys" USING btree ("expires_at") WHERE "platform_runner_keys"."revoked_at" is null;
