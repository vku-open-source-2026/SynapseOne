#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Backfill audit_log.org_id from the legacy context JSON. Batched and
 * idempotent: rerunning only touches rows where org_id is still NULL.
 * Usage: DATABASE_URL=... node tools/backfill-audit-org.mjs [batchSize]
 */
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}
const batch = Math.min(Math.max(Number(process.argv[2] || 1000), 1), 10000);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const pool = new pg.Pool({ connectionString: url, max: 2 });

let total = 0;
try {
  for (;;) {
    const { rows } = await pool.query(
      `SELECT id, context->>'org' AS org, context->>'callerOrg' AS caller_org
         FROM audit_log
        WHERE org_id IS NULL
          AND (context ? 'org' OR context ? 'callerOrg')
        ORDER BY created_at
        LIMIT $1`,
      [batch],
    );
    if (!rows.length) break;
    let changed = 0;
    for (const row of rows) {
      const candidate = row.org && UUID.test(row.org) ? row.org : row.caller_org;
      if (!candidate || !UUID.test(candidate)) continue;
      const r = await pool.query('UPDATE audit_log SET org_id = $1 WHERE id = $2 AND org_id IS NULL', [candidate, row.id]);
      changed += r.rowCount || 0;
    }
    total += changed;
    console.log(`backfill: processed ${rows.length}, updated ${changed}, total ${total}`);
    if (changed === 0) break;
  }
  console.log(`backfill complete: ${total} audit rows updated`);
} finally {
  await pool.end();
}
