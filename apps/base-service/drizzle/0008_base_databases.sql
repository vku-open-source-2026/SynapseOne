-- SPDX-License-Identifier: Apache-2.0
-- SPDX-FileCopyrightText: 2026 VKU.VIC
-- SynapseBase database namespace: a tenant-scoped database contains many
-- collections, so the same collection name can exist in independent apps.
--
-- This migration is replay-safe: every statement is conditional and the
-- backfill is idempotent. Existing collections are attached to a `default`
-- database in their current tenant scope; legacy /v1/base/collections routes
-- keep resolving that default database.

CREATE TABLE IF NOT EXISTS "synapseone_base_databases" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"org_id" text,
	"account_id" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_base_databases_scope_name"
  ON "synapseone_base_databases" USING btree (coalesce("org_id", ''), coalesce("account_id", ''), "name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_base_databases_tenant"
  ON "synapseone_base_databases" USING btree ("org_id", "account_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_base_databases_org_name"
  ON "synapseone_base_databases" USING btree ("org_id", "name")
  WHERE "synapseone_base_databases"."org_id" is not null;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_base_databases_account_name"
  ON "synapseone_base_databases" USING btree ("account_id", "name")
  WHERE "synapseone_base_databases"."org_id" is null and "synapseone_base_databases"."account_id" is not null;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_base_databases_global_name"
  ON "synapseone_base_databases" USING btree ("name")
  WHERE "synapseone_base_databases"."org_id" is null and "synapseone_base_databases"."account_id" is null;
--> statement-breakpoint
ALTER TABLE "synapseone_base_collections" ADD COLUMN IF NOT EXISTS "database_id" text;
--> statement-breakpoint
-- Clear dangling references from a partially applied/aborted earlier run.
UPDATE "synapseone_base_collections" AS collection
SET "database_id" = NULL
WHERE collection."database_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "synapseone_base_databases" AS database
    WHERE database."id" = collection."database_id"
  );
--> statement-breakpoint
-- One default database per tenant scope that still has unassigned collections.
INSERT INTO "synapseone_base_databases" ("id", "name", "description", "org_id", "account_id")
SELECT gen_random_uuid()::text, 'default', 'Default database (migrated collections)', scope.org_id, scope.account_id
FROM (
  SELECT DISTINCT "org_id", "account_id"
  FROM "synapseone_base_collections"
  WHERE "database_id" IS NULL
) AS scope
WHERE NOT EXISTS (
  SELECT 1
  FROM "synapseone_base_databases" AS existing
  WHERE existing."name" = 'default'
    AND existing."org_id" IS NOT DISTINCT FROM scope."org_id"
    AND existing."account_id" IS NOT DISTINCT FROM scope."account_id"
);
--> statement-breakpoint
UPDATE "synapseone_base_collections" AS collection
SET "database_id" = database."id"
FROM "synapseone_base_databases" AS database
WHERE collection."database_id" IS NULL
  AND database."name" = 'default'
  AND database."org_id" IS NOT DISTINCT FROM collection."org_id"
  AND database."account_id" IS NOT DISTINCT FROM collection."account_id";
--> statement-breakpoint
ALTER TABLE "synapseone_base_collections" ALTER COLUMN "database_id" SET NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "synapseone_base_collections"
    ADD CONSTRAINT "synapseone_base_collections_database_id_fkey"
    FOREIGN KEY ("database_id") REFERENCES "public"."synapseone_base_databases"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
-- Collection names are unique inside a database, not across the whole tenant.
DROP INDEX IF EXISTS "idx_base_collections_scope_name";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_base_collections_database_name"
  ON "synapseone_base_collections" USING btree ("database_id", "name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_base_collections_database"
  ON "synapseone_base_collections" USING btree ("database_id", "created_at");
