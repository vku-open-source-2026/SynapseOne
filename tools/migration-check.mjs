#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Guard Drizzle journal ordering. The migrator skips entries whose `when` is
 * older than the last applied migration, so a newly generated migration must
 * always carry a timestamp greater than every previous entry.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const roots = ['apps/base-service', 'apps/iam-service', 'apps/workflow-service', 'apps/lds-service'];
let failed = false;

/**
 * Named constraints (FOREIGN KEY / UNIQUE / CHECK / PRIMARY KEY) declared in
 * the latest migration's SQL must be recorded under the same name in that
 * entry's snapshot. #84: 0008 SQL created `..._fkey` while the snapshot
 * recorded a different `..._fk` name, so a future `drizzle-kit generate`
 * would emit a destructive rename and fresh installs would diverge from
 * production. Only the latest entry is gated: earlier entries predate
 * consistent per-entry snapshots and are grandfathered.
 */
function checkSnapshotAgreement(root, entry) {
  const snapName = `${String(entry.idx).padStart(4, '0')}_snapshot.json`;
  const snapPath = join(root, 'drizzle', 'meta', snapName);
  if (!existsSync(snapPath)) return; // older entries predate per-entry snapshots
  const sqlFiles = readdirSync(join(root, 'drizzle'))
    .filter((name) => name.startsWith(entry.tag) && name.endsWith('.sql'));
  if (!sqlFiles.length) return;
  const snapshot = readFileSync(snapPath, 'utf8');
  const names = new Set();
  for (const file of sqlFiles) {
    const sql = readFileSync(join(root, 'drizzle', file), 'utf8');
    for (const match of sql.matchAll(/CONSTRAINT\s+"([^"]+)"/g)) names.add(match[1]);
  }
  for (const name of names) {
    if (!snapshot.includes(`"${name}"`)) {
      console.error(`migration-check: ${root} entry ${entry.tag} declares CONSTRAINT "${name}" but ${snapName} records a different name (snapshot/SQL drift)`);
      failed = true;
    }
  }
}

for (const root of roots) {
  const path = join(root, 'drizzle', 'meta', '_journal.json');
  let journal;
  try {
    journal = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    continue; // service has no migration journal
  }
  let previous = -1;
  let previousSnapshotId = null;
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
    const snapshotPath = join(root, 'drizzle', 'meta', `${String(entry.idx).padStart(4, '0')}_snapshot.json`);
    if (existsSync(snapshotPath)) {
      const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
      if (previousSnapshotId && snapshot.prevId !== previousSnapshotId) {
        console.error(`migration-check: ${snapshotPath} prevId does not chain to the previous snapshot`);
        failed = true;
      }
      previousSnapshotId = snapshot.id;
    }
  }
  const entries = journal.entries || [];
  if (entries.length) checkSnapshotAgreement(root, entries[entries.length - 1]);
}

if (failed) process.exit(1);
console.log('migration-check: OK (journal timestamps are strictly increasing; snapshots agree with SQL constraint names)');
