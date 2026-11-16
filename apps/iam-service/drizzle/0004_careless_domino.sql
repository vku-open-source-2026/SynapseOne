-- SPDX-License-Identifier: Apache-2.0
-- SPDX-FileCopyrightText: 2026 VKU.VIC
-- SCIM provisioning tables + user active flag. Earlier migrations already
-- created password_reset_tokens and the usage token columns; keep this
-- migration strictly additive and idempotent.
CREATE TABLE IF NOT EXISTS "scim_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"account_id" uuid,
	"display_name" text NOT NULL,
	"external_id" text,
	"members" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scim_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"scopes" jsonb DEFAULT '["scim:read","scim:write"]'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "scim_groups" ADD CONSTRAINT "scim_groups_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "scim_tokens" ADD CONSTRAINT "scim_tokens_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "scim_groups_org_name_key" ON "scim_groups" USING btree ("org_id","display_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_scim_groups_org" ON "scim_groups" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "scim_tokens_hash_key" ON "scim_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_scim_tokens_org" ON "scim_tokens" USING btree ("org_id");
