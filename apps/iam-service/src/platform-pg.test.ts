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
  createAccount,
  upsertUser,
  grantPlatformAdmin,
  revokePlatformAdminGuarded,
  countActivePlatformOwners,
} from './db';
import { upsertOrgQuota, getEffectiveQuota, listAllQuotas, deleteOrgQuota } from './quotas';
import { createApiKeyRecord, rotateApiKey, verifyApiKey, findApiKeyById } from './tokens';

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
    const rotatedColumn = await db.execute(sql`
      select column_name from information_schema.columns
      where table_name = 'api_keys' and column_name = 'rotated_at'
    `);
    assert.equal(rotatedColumn.rows.length, 1, 'api_keys.rotated_at exists');
    const journal = await db.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations_iam`);
    assert.ok(Number(journal.rows[0].n) >= 18, 'IAM migration journal includes org quota windows and API-key rotation marker');

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

  it('persists nullable quota windows and paginates filtered overrides correctly', async () => {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const slug = `quota-pg-${suffix}`;
    const org = await createOrganization(slug, 'Quota PG QA');
    await upsertOrgQuota(org.id, 'ai', {
      requestsPerMin: 11,
      requestsPer5h: null,
      requestsPerDay: 22_000,
      tokensPerDay: null,
    }, 'pg-test');
    const effective = await getEffectiveQuota(org.id, 'ai');
    assert.equal(effective.requestsPerMin, 11);
    assert.equal(effective.requestsPerDay, 22_000);
    assert.equal(effective.requestsPer5h, 30 * 300);
    assert.equal(effective.overrides.requestsPer5h, false);
    assert.equal(effective.overrides.requestsPerDay, true);

    const page = await listAllQuotas({ service: 'ai', q: slug, limit: 1, offset: 0 });
    assert.equal(page.total, 1);
    assert.equal(page.items[0].org_id, org.id);
    assert.equal(page.items[0].requests_per_5h, null);
    assert.equal((await listAllQuotas({ q: 'no-such-quota-org' })).total, 0);
    assert.equal(await deleteOrgQuota(org.id, 'ai'), true);
  });

  it('rotates API keys exactly once under PostgreSQL concurrency', async () => {
    const org = await createOrganization(`rotate-pg-${Date.now()}`, 'Rotate PG QA');
    const account = await createAccount(org.id, 'prod', 'Production');
    const original = await createApiKeyRecord(account.id, null, 'rotate', ['base:read'], null);
    const results = await Promise.all([rotateApiKey(original.id, 0), rotateApiKey(original.id, 0)]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(await verifyApiKey(original.value), null);
    const winner = results.find(Boolean)!;
    assert.equal((await verifyApiKey(winner.value))?.account_id, account.id);
  });

  it('preserves a non-expiring successor during PostgreSQL grace rotation', async () => {
    const org = await createOrganization(`rotate-null-expiry-pg-${Date.now()}`, 'Rotate Null Expiry PG QA');
    const account = await createAccount(org.id, 'prod', 'Production');
    const original = await createApiKeyRecord(account.id, null, 'permanent', ['*'], null);
    const rotated = await rotateApiKey(original.id, 300);
    assert.ok(rotated);
    assert.equal((await findApiKeyById(rotated.id))?.expires_at, null);
    assert.ok(Date.parse((await findApiKeyById(original.id))!.expires_at!) <= Date.now() + 300_000);
    assert.equal((await verifyApiKey(rotated.value))?.account_id, account.id);
  });

  it('preserves a long successor expiry during short PostgreSQL grace rotation', async () => {
    const org = await createOrganization(`rotate-long-expiry-pg-${Date.now()}`, 'Rotate Long Expiry PG QA');
    const account = await createAccount(org.id, 'prod', 'Production');
    const expiry = new Date(Date.now() + 30 * 86_400_000);
    const original = await createApiKeyRecord(account.id, null, 'long', ['*'], expiry);
    const rotated = await rotateApiKey(original.id, 300);
    assert.ok(rotated);
    assert.equal((await findApiKeyById(rotated.id))?.expires_at, expiry.toISOString());
    assert.ok(Date.parse((await findApiKeyById(original.id))!.expires_at!) <= Date.now() + 300_000);
  });

  it('caps PostgreSQL rotation grace at the original expiry', async () => {
    const org = await createOrganization(`rotate-expiry-pg-${Date.now()}`, 'Rotate Expiry PG QA');
    const account = await createAccount(org.id, 'prod', 'Production');
    const expiry = new Date(Date.now() + 60_000);
    const original = await createApiKeyRecord(account.id, null, 'short', ['*'], expiry);
    const rotated = await rotateApiKey(original.id, 3600);
    assert.ok(rotated);
    assert.equal(Date.parse(rotated.oldKeyExpiresAt), expiry.getTime());
    assert.equal((await findApiKeyById(rotated.id))?.expires_at, expiry.toISOString());
    assert.equal((await findApiKeyById(original.id))?.expires_at, expiry.toISOString());
    assert.equal((await verifyApiKey(original.value))?.account_id, account.id);
  });
});
