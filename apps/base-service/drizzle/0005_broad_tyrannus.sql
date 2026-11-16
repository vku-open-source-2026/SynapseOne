-- SPDX-License-Identifier: Apache-2.0
-- SPDX-FileCopyrightText: 2026 VKU.VIC
-- Tenant-scoped search index (#46). base_vectors already exists from 0002;
-- this migration only adds the new search projection.
CREATE TABLE IF NOT EXISTS "synapseone_search_index" (
	"id" text PRIMARY KEY NOT NULL,
	"collection_id" text NOT NULL,
	"document_id" text NOT NULL,
	"org_id" text,
	"account_id" text,
	"title" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"acl" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"embedding" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_search_document" ON "synapseone_search_index" USING btree ("collection_id","document_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_search_tenant" ON "synapseone_search_index" USING btree ("org_id","account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_search_collection" ON "synapseone_search_index" USING btree ("collection_id");
