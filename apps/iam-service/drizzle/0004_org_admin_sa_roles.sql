-- SPDX-License-Identifier: Apache-2.0
-- SPDX-FileCopyrightText: 2026 VKU.VIC
-- Org administrators, service-account roles, API-key last use (token management).
CREATE TABLE IF NOT EXISTS "service_account_roles" (
	"service_account_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	CONSTRAINT "service_account_roles_service_account_id_role_id_pk" PRIMARY KEY("service_account_id","role_id")
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "last_used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_org_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "service_account_roles" ADD CONSTRAINT "service_account_roles_service_account_id_service_accounts_id_fk" FOREIGN KEY ("service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "service_account_roles" ADD CONSTRAINT "service_account_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
-- Backfill: every user that existed before policy enforcement keeps the
-- full in-org access it effectively had (tenant isolation only).
UPDATE "users" SET "is_org_admin" = true WHERE "is_org_admin" = false;
