// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Last-admin guard: every deactivation/demotion path shares one transaction
 * lock, so two concurrent requests cannot remove the final administrator.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createOrganization, upsertUser, setOrgAdmin, setOrgAdminGuarded,
  setUserActiveGuarded, countActiveOrgAdmins,
} from './db';

const saved: Record<string, string | undefined> = {};

describe('last active organization administrator guard', () => {
  before(() => {
    for (const key of ['NODE_ENV', 'DATABASE_URL']) saved[key] = process.env[key];
    delete process.env.NODE_ENV;
    delete process.env.DATABASE_URL;
  });

  it('serializes concurrent demotions and keeps at least one admin', async () => {
    const org = await createOrganization(`guard-${Date.now()}`, 'Guard Org');
    const a = await upsertUser(org.id, 'a@guard.test');
    const b = await upsertUser(org.id, 'b@guard.test');
    await setOrgAdmin(a.id, true);
    await setOrgAdmin(b.id, true);
    assert.equal(await countActiveOrgAdmins(org.id), 2);

    const results = await Promise.all([
      setOrgAdminGuarded(a.id, false),
      setOrgAdminGuarded(b.id, false),
    ]);
    const removed = results.filter((r) => r.ok);
    const denied = results.filter((r) => !r.ok && r.reason === 'last_admin');
    assert.equal(removed.length, 1, JSON.stringify(results));
    assert.equal(denied.length, 1, JSON.stringify(results));
    assert.equal(await countActiveOrgAdmins(org.id), 1);
  });

  it('refuses to deactivate the last active admin but allows a non-last one', async () => {
    const org = await createOrganization(`guard-active-${Date.now()}`, 'Guard Active');
    const a = await upsertUser(org.id, 'a@guard-active.test');
    const b = await upsertUser(org.id, 'b@guard-active.test');
    await setOrgAdmin(a.id, true);
    await setOrgAdmin(b.id, true);

    const first = await setUserActiveGuarded(a.id, false);
    assert.equal(first.ok, true);
    assert.equal(await countActiveOrgAdmins(org.id), 1);
    const last = await setUserActiveGuarded(b.id, false);
    assert.equal(last.ok, false);
    if (!last.ok) assert.equal(last.reason, 'last_admin');
    assert.equal(await countActiveOrgAdmins(org.id), 1);
  });

  after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
});
