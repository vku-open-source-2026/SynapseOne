-- SPDX-License-Identifier: Apache-2.0
-- SPDX-FileCopyrightText: 2026 VKU.VIC
--
-- FORWARD-ONLY runtime repair for databases that already applied
-- 0008_base_databases as b689005809761801e734296931df26c1772a42f43ede50bea5cd247e72b3a5eb.
--
-- That applied migration made database_id NOT NULL and did not install the
-- legacy-insert trigger. The deployed 0.9.4-base-db image is in that state.
-- Do NOT edit or re-run the applied 0008. Add this as a new journal entry with
-- `when` strictly greater than 1797000000000 (proposed 1797000000001).
--
-- Effects:
--   * installs the fill trigger so old (pre-multiDB) binaries can INSERT a
--     collection without database_id;
--   * drops NOT NULL after the trigger exists, restoring the expand phase;
--   * does not rewrite rows (production currently has zero NULL database_id and
--     zero empty-string tenant scopes; the guard below fails loudly otherwise).
--
-- This is safe to replay: function replace, trigger drop/recreate, and DROP
-- NOT NULL are idempotent. A later contract migration must set NOT NULL again
-- after all old binaries are drained.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'synapseone_base_collections'
      AND column_name = 'database_id'
  ) THEN
    RAISE EXCEPTION '0009 repair requires the applied 0008 database_id column';
  END IF;
  IF EXISTS (
    SELECT 1 FROM synapseone_base_collections WHERE database_id IS NULL
  ) THEN
    RAISE EXCEPTION '0009 repair found NULL database_id rows; inspect before dropping NOT NULL';
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "synapseone_base_collections_fill_database_id"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  target_id text;
BEGIN
  IF NEW."database_id" IS NULL THEN
    SELECT "id" INTO target_id
    FROM "public"."synapseone_base_databases"
    WHERE "name" = 'default'
      AND "org_id" IS NOT DISTINCT FROM NEW."org_id"
      AND "account_id" IS NOT DISTINCT FROM NEW."account_id"
    ORDER BY "created_at" ASC, "id" ASC
    LIMIT 1;

    IF target_id IS NULL THEN
      INSERT INTO "public"."synapseone_base_databases"
        ("id", "name", "description", "org_id", "account_id")
      VALUES
        (gen_random_uuid()::text, 'default',
         'Default database (restored by 0009 runtime repair)',
         NEW."org_id", NEW."account_id")
      ON CONFLICT DO NOTHING;

      SELECT "id" INTO target_id
      FROM "public"."synapseone_base_databases"
      WHERE "name" = 'default'
        AND "org_id" IS NOT DISTINCT FROM NEW."org_id"
        AND "account_id" IS NOT DISTINCT FROM NEW."account_id"
      ORDER BY "created_at" ASC, "id" ASC
      LIMIT 1;
    END IF;

    IF target_id IS NULL THEN
      RAISE EXCEPTION '0009 repair could not resolve the default database for a legacy insert';
    END IF;

    NEW."database_id" := target_id;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "synapseone_base_collections_fill_database_id" ON "synapseone_base_collections";
--> statement-breakpoint
CREATE TRIGGER "synapseone_base_collections_fill_database_id"
  BEFORE INSERT ON "synapseone_base_collections"
  FOR EACH ROW
  EXECUTE FUNCTION "synapseone_base_collections_fill_database_id"();
--> statement-breakpoint
ALTER TABLE "synapseone_base_collections"
  ALTER COLUMN "database_id" DROP NOT NULL;
--> statement-breakpoint
COMMENT ON COLUMN "synapseone_base_collections"."database_id" IS
  'Expand repaired forward from applied 0008: nullable again for old-binary compatibility; trigger fills the scope default. Do not contract until old binaries are drained.';
