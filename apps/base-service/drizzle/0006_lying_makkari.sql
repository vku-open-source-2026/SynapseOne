-- SPDX-License-Identifier: Apache-2.0
-- SPDX-FileCopyrightText: 2026 VKU.VIC
ALTER TABLE "synapseone_search_index" ADD COLUMN IF NOT EXISTS "collection_name" text DEFAULT '' NOT NULL;
