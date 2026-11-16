// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Workflow credential owner isolation (store layer).
 *
 * HTTP-created credentials may carry owner_sub. Legacy rows created without it
 * keep owner_sub null and retain the pre-existing org/account visibility
 * behavior. These tests use the in-memory store so they do not need Postgres.
 */
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  __clearCredentials,
  createCredentialRec,
  getCredentialRec,
  listCredentialRecs,
  rotateCredentialRec,
  toPublicCredential,
} from './store';

describe('workflow credential owner isolation', () => {
  beforeEach(() => {
    __clearCredentials();
    process.env.SYNAPSEONE_CREDENTIAL_KEY = 'a'.repeat(64);
  });

  it('round-trips owner_sub and leaves legacy rows null', async () => {
    const owned = await createCredentialRec({
      account_id: 'acct-a',
      org_id: 'org-a',
      owner_sub: 'user-1',
      name: 'owned',
      kind: 'bearer',
      secret: 'owned-secret',
    });
    const legacy = await createCredentialRec({
      account_id: 'acct-a',
      org_id: 'org-a',
      name: 'legacy',
      kind: 'bearer',
      secret: 'legacy-secret',
    });

    assert.equal(owned.owner_sub, 'user-1');
    assert.equal(legacy.owner_sub, null);

    const reloaded = await getCredentialRec(owned.id);
    assert.equal(reloaded?.owner_sub, 'user-1');
    const legacyReloaded = await getCredentialRec(legacy.id);
    assert.equal(legacyReloaded?.owner_sub, null);

    const listed = await listCredentialRecs('acct-a', 'org-a');
    assert.equal(listed.length, 2);
    assert.equal(listed.find((item) => item.id === owned.id)?.owner_sub, 'user-1');
    assert.equal(listed.find((item) => item.id === legacy.id)?.owner_sub, null);
  });

  it('preserves owner_sub across secret rotation', async () => {
    const owned = await createCredentialRec({
      account_id: 'acct-a',
      org_id: 'org-a',
      owner_sub: 'user-1',
      name: 'rotated',
      kind: 'api-key',
      secret: 'before',
    });

    const rotated = await rotateCredentialRec(owned.id, 'after');
    assert.equal(rotated?.owner_sub, 'user-1');
    assert.equal(rotated?.id, owned.id);
    const reloaded = await getCredentialRec(owned.id);
    assert.equal(reloaded?.owner_sub, 'user-1');
  });

  it('exposes optional public owner metadata only when owner_sub is set', async () => {
    const owned = await createCredentialRec({
      account_id: 'acct-a',
      org_id: 'org-a',
      owner_sub: 'user-1',
      name: 'public-owned',
      kind: 'bearer',
      secret: 'x',
    });
    const legacy = await createCredentialRec({
      account_id: 'acct-a',
      org_id: 'org-a',
      name: 'public-legacy',
      kind: 'bearer',
      secret: 'y',
    });

    const publicOwned = toPublicCredential(owned);
    assert.equal(publicOwned.owner, 'user-1');
    assert.equal('secret' in publicOwned, false);
    assert.equal('secret_enc' in publicOwned, false);

    const publicLegacy = toPublicCredential(legacy);
    assert.equal('owner' in publicLegacy, false);
  });
});
