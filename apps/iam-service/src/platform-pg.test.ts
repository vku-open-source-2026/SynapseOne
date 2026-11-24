// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * PostgreSQL-only platform-owner concurrency test. Run explicitly against a
 * disposable database:
 *   DATABASE_URL=postgres://... IAM_TEST_DATABASE_URL=1 \
 *     node --test dist/platform-pg.test.js
 * The default in-memory suite skips it.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import {
  ensureTables,
  getDb,
  createOrganization,
  upsertUser,
  grantPlatformAdmin,
  revokePlatformAdminGuarded,
  countActivePlatformOwners,
} from './db';

const enabled = process.env.IAM_TEST_DATABASE_URL === '1' && !!process.env.DATABASE_URL;

describe('platform owner guards on PostgreSQL', { skip: !enabled }, () => {
  before(async () => {
    await ensureTables();
  });

  it('returns the current auth_version so re-login after revocation is valid', async () => {
    const db = getDb()!;
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const org = await createOrganization(`authver-pg-${suffix}`, 'Auth Version PG QA');
    const user = await upsertUser(org.id, `authver-${suffix}@example.test`);
    assert.equal(user.auth_version, 0);
    await db.execute(sql`update users set auth_version = 7 where id = ${user.id}`);
    const again = await upsertUser(org.id, `authver-${suffix}@example.test`);
    assert.equal(again.auth_version, 7, 'upsertUser must project auth_version for issueSession');
  });

  it('applies the consumed_at migration and serializes concurrent owner revocation', async () => {
    const db = getDb()!;
    const column = await db.execute(sql`
      select column_name from information_schema.columns
      where table_name = 'refresh_tokens' and column_name = 'consumed_at'
    `);
    assert.equal(column.rows.length, 1, 'refresh_tokens.consumed_at exists');
    const journal = await db.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations_iam`);
    assert.ok(Number(journal.rows[0].n) >= 13, 'IAM migration journal is applied');

    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const baseline = await countActivePlatformOwners();
    const platformOrg = await createOrganization(`platform-pg-${suffix}`, 'Platform PG QA', 'platform');
    const first = await upsertUser(platformOrg.id, `owner-a-${suffix}@example.test`);
    const second = await upsertUser(platformOrg.id, `owner-b-${suffix}@example.test`);
    await grantPlatformAdmin({ userId: first.id, role: 'owner', grantedBy: first.id });
    await grantPlatformAdmin({ userId: second.id, role: 'owner', grantedBy: first.id });
    assert.equal(await countActivePlatformOwners(), baseline + 2);

    const results = await Promise.all([
      revokePlatformAdminGuarded(first.id),
      revokePlatformAdminGuarded(second.id),
    ]);
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(results.find((result) => !result.ok)?.reason, 'last_owner');
    assert.equal(await countActivePlatformOwners(), baseline + 1);
  });
});
