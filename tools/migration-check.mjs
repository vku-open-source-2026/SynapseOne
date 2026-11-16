#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Guard Drizzle journal ordering. The migrator skips entries whose `when` is
 * older than the last applied migration, so a newly generated migration must
 * always carry a timestamp greater than every previous entry.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const roots = ['apps/base-service', 'apps/iam-service', 'apps/workflow-service', 'apps/lds-service'];
let failed = false;

for (const root of roots) {
  const path = join(root, 'drizzle', 'meta', '_journal.json');
  let journal;
  try {
    journal = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    continue; // service has no migration journal
  }
  let previous = -1;
  for (const entry of journal.entries || []) {
    if (!Number.isFinite(entry.when) || entry.when <= previous) {
      console.error(`migration-check: ${path} entry ${entry.idx} (${entry.tag}) is not newer than the previous entry`);
      failed = true;
    }
    previous = entry.when;
    const files = readdirSync(join(root, 'drizzle')).filter((name) => name.startsWith(entry.tag));
    if (!files.length) {
      console.error(`migration-check: ${path} entry ${entry.tag} has no SQL file`);
      failed = true;
    }
  }
}

if (failed) process.exit(1);
console.log('migration-check: OK (journal timestamps are strictly increasing)');
