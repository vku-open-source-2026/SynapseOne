// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Account lifecycle: an organization can retire one account without
 * suspending another. Retirement blocks account-bound credentials and
 * contexts; reactivation never restores revoked credentials.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createApp } from './index';

const INTERNAL = 'account-lifecycle-test-secret';
const saved: Record<string, string | undefined> = {};
const PASSWORD = 'AccountLifecycle!2345';

describe('account lifecycle', () => {
  let base = '';
  let server: Server | null = null;

  const call = async (method: string, path: string, body?: any, headers: Record<string, string> = {}) => {
    const r = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-synapseone-internal': INTERNAL, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json: any;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: r.status, json };
  };

  before(() => new Promise<void>((resolve, reject) => {
    for (const k of ['NODE_ENV', 'DATABASE_URL', 'SYNAPSEONE_INTERNAL_SECRET', 'IAM_SENSITIVE_MUTATION_MODE', 'IAM_ALLOW_DEV_LOGIN']) {
      saved[k] = process.env[k];
    }
    delete process.env.NODE_ENV;
    delete process.env.DATABASE_URL;
    process.env.SYNAPSEONE_INTERNAL_SECRET = INTERNAL;
    process.env.IAM_SENSITIVE_MUTATION_MODE = 'enforce';
    process.env.IAM_ALLOW_DEV_LOGIN = 'false';
    const app = createApp();
    server = app.listen(0, '127.0.0.1', async () => {
      try {
        const a = server!.address();
        base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
        resolve();
      } catch (e) { reject(e); }
    });
  }));

  after(() => new Promise<void>((resolve) => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    server ? server.close(() => resolve()) : resolve();
  }));

  it('retires one account, blocks its credentials, and preserves the other account', async () => {
    const suffix = `${Date.now()}`;
    const reg = await call('POST', '/v1/auth/register', {
      email: `acct-${suffix}@example.test`,
      password: PASSWORD,
      orgSlug: `acct-${suffix}`,
      displayName: 'Account Admin',
    });
    assert.equal(reg.status, 201, JSON.stringify(reg.json));
    const token = reg.json.accessToken;
    const orgId = reg.json.user.org_id;
    const h = { Authorization: `Bearer ${token}` };

    const a1 = await call('POST', `/v1/orgs/${orgId}/accounts`, { slug: 'primary', displayName: 'Primary' }, h);
    const a2 = await call('POST', `/v1/orgs/${orgId}/accounts`, { slug: 'staging', displayName: 'Staging' }, h);
    assert.equal(a1.status, 201, JSON.stringify(a1.json));
    assert.equal(a2.status, 201, JSON.stringify(a2.json));

    const key1 = await call('POST', `/v1/accounts/${a1.json.id}/keys`, { name: 'retire-me', scopes: ['base:read'] }, h);
    const key2 = await call('POST', `/v1/accounts/${a2.json.id}/keys`, { name: 'keep-me', scopes: ['base:read'] }, h);
    assert.equal(key1.status, 201, JSON.stringify(key1.json));
    assert.equal(key2.status, 201, JSON.stringify(key2.json));

    const sa = await call('POST', `/v1/accounts/${a1.json.id}/service-accounts`, { slug: 'retire-sa' }, h);
    assert.equal(sa.status, 201, JSON.stringify(sa.json));
    const saToken = await call('POST', `/v1/service-accounts/${sa.json.id}/token`, {}, h);
    assert.equal(saToken.status, 200, JSON.stringify(saToken.json));

    const retired = await call('POST', `/v1/accounts/${a1.json.id}/retire`, { reason: 'migration complete' }, h);
    assert.equal(retired.status, 200, JSON.stringify(retired.json));
    assert.equal(retired.json.account.status, 'retired');
    assert.ok(retired.json.revokedKeys >= 1);
    assert.ok(retired.json.revokedServiceAccounts >= 1);
    const retiredDetail = await call('GET', `/v1/accounts/${a1.json.id}`, undefined, h);
    assert.equal(retiredDetail.status, 200, JSON.stringify(retiredDetail.json));
    assert.equal(retiredDetail.json.account.status, 'retired');

    const oldKey = await call('GET', '/v1/auth/verify', undefined, { 'x-api-key': key1.json.apiKey });
    assert.equal(oldKey.status, 401, JSON.stringify(oldKey.json));
    const oldSa = await call('GET', '/v1/auth/verify', undefined, { Authorization: `Bearer ${saToken.json.accessToken}` });
    assert.equal(oldSa.status, 403, JSON.stringify(oldSa.json));
    assert.ok(['service_account_revoked', 'account_retired'].includes(oldSa.json.error), JSON.stringify(oldSa.json));

    const otherKey = await call('GET', '/v1/auth/verify', undefined, { 'x-api-key': key2.json.apiKey });
    assert.equal(otherKey.status, 200, JSON.stringify(otherKey.json));

    const listed = await call('GET', `/v1/orgs/${orgId}/accounts`, undefined, h);
    const primary = (listed.json as any[]).find((a) => a.id === a1.json.id);
    const staging = (listed.json as any[]).find((a) => a.id === a2.json.id);
    assert.equal(primary.status, 'retired');
    assert.equal(staging.status, 'active');

    const reactivated = await call('POST', `/v1/accounts/${a1.json.id}/reactivate`, {}, h);
    assert.equal(reactivated.status, 200, JSON.stringify(reactivated.json));
    assert.equal(reactivated.json.account.status, 'active');
    const stillRevoked = await call('GET', '/v1/auth/verify', undefined, { 'x-api-key': key1.json.apiKey });
    assert.equal(stillRevoked.status, 401, JSON.stringify(stillRevoked.json));
  });

  it('updates mutable metadata and reads credentials by id', async () => {
    const suffix = `${Date.now()}`;
    const reg = await call('POST', '/v1/auth/register', {
      email: `meta-${suffix}@example.test`, password: PASSWORD, orgSlug: `meta-${suffix}`, displayName: 'Meta Admin',
    });
    assert.equal(reg.status, 201, JSON.stringify(reg.json));
    const h = { Authorization: `Bearer ${reg.json.accessToken}` };
    const orgId = reg.json.user.org_id;

    const org = await call('PATCH', `/v1/orgs/${orgId}`, { displayName: 'Renamed Org' }, h);
    assert.equal(org.status, 200, JSON.stringify(org.json));
    assert.equal(org.json.display_name, 'Renamed Org');

    const account = await call('POST', `/v1/orgs/${orgId}/accounts`, { slug: 'meta', displayName: 'Meta' }, h);
    assert.equal(account.status, 201, JSON.stringify(account.json));
    const accountId = account.json.id;
    const renamed = await call('PATCH', `/v1/accounts/${accountId}`, { displayName: 'Meta Renamed' }, h);
    assert.equal(renamed.status, 200, JSON.stringify(renamed.json));
    assert.equal(renamed.json.display_name, 'Meta Renamed');

    const role = await call('POST', `/v1/accounts/${accountId}/roles`, { slug: 'reader', description: 'read' }, h);
    assert.equal(role.status, 201, JSON.stringify(role.json));
    const roleUpdate = await call('PATCH', `/v1/roles/${role.json.id}`, { description: 'read-only access' }, h);
    assert.equal(roleUpdate.status, 200, JSON.stringify(roleUpdate.json));
    assert.equal(roleUpdate.json.description, 'read-only access');

    const policy = await call('POST', `/v1/accounts/${accountId}/policies`, {
      slug: 'reader-policy',
      document: { Version: '2026-01-01', Statement: [{ Effect: 'Allow', Action: 'base:Read', Resource: '*' }] },
    }, h);
    assert.equal(policy.status, 201, JSON.stringify(policy.json));
    const policyUpdate = await call('PATCH', `/v1/policies/${policy.json.id}`, {
      description: 'updated',
      document: { Version: '2026-01-01', Statement: [{ Effect: 'Allow', Action: 'base:Read', Resource: 'arn:synapseone:*:*:base:*' }] },
    }, h);
    assert.equal(policyUpdate.status, 200, JSON.stringify(policyUpdate.json));
    assert.equal(policyUpdate.json.description, 'updated');
    const badPolicy = await call('PATCH', `/v1/policies/${policy.json.id}`, { document: { Statement: [] } }, h);
    assert.equal(badPolicy.status, 400, JSON.stringify(badPolicy.json));

    const key = await call('POST', `/v1/accounts/${accountId}/keys`, { name: 'meta-key', scopes: ['base:read'] }, h);
    assert.equal(key.status, 201, JSON.stringify(key.json));
    const keyRead = await call('GET', `/v1/keys/${key.json.id}`, undefined, h);
    assert.equal(keyRead.status, 200, JSON.stringify(keyRead.json));
    assert.equal(keyRead.json.name, 'meta-key');
    assert.equal(keyRead.json.key_hash, undefined);
    assert.equal(keyRead.json.apiKey, undefined);

    // Machine credentials stay account-bound even though humans get an
    // org-level fallback: an account-A key must not read sibling account B.
    const sibling = await call('POST', `/v1/orgs/${orgId}/accounts`, { slug: 'meta-sibling', displayName: 'Sibling' }, h);
    assert.equal(sibling.status, 201, JSON.stringify(sibling.json));
    const crossAccount = await call('GET', `/v1/accounts/${sibling.json.id}/keys`, undefined, { 'x-api-key': key.json.apiKey });
    assert.equal(crossAccount.status, 403, JSON.stringify(crossAccount.json));

    const sa = await call('POST', `/v1/accounts/${accountId}/service-accounts`, { slug: 'meta-sa' }, h);
    assert.equal(sa.status, 201, JSON.stringify(sa.json));
    const saRead = await call('GET', `/v1/service-accounts/${sa.json.id}`, undefined, h);
    assert.equal(saRead.status, 200, JSON.stringify(saRead.json));
    assert.equal(saRead.json.slug, 'meta-sa');
    assert.ok(Array.isArray(saRead.json.roles));

    const me = await call('PATCH', `/v1/users/${reg.json.user.id}`, { displayName: 'Renamed Admin' }, h);
    assert.equal(me.status, 200, JSON.stringify(me.json));
    assert.equal(me.json.display_name, 'Renamed Admin');
  });

  it('paginates, searches and sorts tenant management collections', async () => {
    const suffix = `${Date.now()}`;
    const reg = await call('POST', '/v1/auth/register', {
      email: `page-${suffix}@example.test`, password: PASSWORD, orgSlug: `page-${suffix}`,
    });
    assert.equal(reg.status, 201, JSON.stringify(reg.json));
    const h = { Authorization: `Bearer ${reg.json.accessToken}` };
    const orgId = reg.json.user.org_id;

    for (const [slug, name] of [['alpha', 'Alpha'], ['beta', 'Beta'], ['gamma', 'Gamma']]) {
      const created = await call('POST', `/v1/orgs/${orgId}/accounts`, { slug, displayName: name }, h);
      assert.equal(created.status, 201, JSON.stringify(created.json));
    }
    const first = await call('GET', `/v1/orgs/${orgId}/accounts?paged=1&limit=2&sort=slug`, undefined, h);
    assert.equal(first.status, 200, JSON.stringify(first.json));
    assert.equal(first.json.total, 3);
    assert.equal(first.json.items.length, 2);
    assert.equal(first.json.items[0].slug, 'alpha');
    assert.equal(first.json.nextOffset, 2);
    const second = await call('GET', `/v1/orgs/${orgId}/accounts?paged=1&limit=2&offset=2&sort=slug`, undefined, h);
    assert.equal(second.status, 200, JSON.stringify(second.json));
    assert.equal(second.json.items.length, 1);
    assert.equal(second.json.nextOffset, null);
    const searched = await call('GET', `/v1/orgs/${orgId}/accounts?paged=1&q=bet`, undefined, h);
    assert.equal(searched.json.total, 1);
    assert.equal(searched.json.items[0].slug, 'beta');
    const descending = await call('GET', `/v1/orgs/${orgId}/accounts?paged=1&sort=slug&order=desc`, undefined, h);
    assert.equal(descending.json.items[0].slug, 'gamma');
    const invalid = await call('GET', `/v1/orgs/${orgId}/accounts?paged=1&sort=not-a-field`, undefined, h);
    assert.equal(invalid.status, 400, JSON.stringify(invalid.json));

    const accountId = (await call('GET', `/v1/orgs/${orgId}/accounts?paged=1&q=alpha`, undefined, h)).json.items[0].id;
    for (const slug of ['one', 'two', 'three']) {
      const role = await call('POST', `/v1/accounts/${accountId}/roles`, { slug, description: slug }, h);
      assert.equal(role.status, 201, JSON.stringify(role.json));
    }
    const roles = await call('GET', `/v1/accounts/${accountId}/roles?paged=1&limit=2&sort=slug`, undefined, h);
    assert.equal(roles.status, 200, JSON.stringify(roles.json));
    assert.equal(roles.json.total, 3);
    assert.equal(roles.json.items.length, 2);

    for (const name of ['z-key', 'a-key', 'm-key']) {
      const key = await call('POST', `/v1/accounts/${accountId}/keys`, { name, scopes: ['base:read'] }, h);
      assert.equal(key.status, 201, JSON.stringify(key.json));
    }
    const keys = await call('GET', `/v1/accounts/${accountId}/keys?paged=1&limit=2&status=active&sort=name`, undefined, h);
    assert.equal(keys.status, 200, JSON.stringify(keys.json));
    assert.equal(keys.json.total, 3);
    assert.equal(keys.json.items[0].name, 'a-key');
  });

  it('rejects retirement by a non-admin member', async () => {
    const suffix = `${Date.now()}`;
    const reg = await call('POST', '/v1/auth/register', {
      email: `acct-owner-${suffix}@example.test`, password: PASSWORD, orgSlug: `acct-owner-${suffix}`,
    });
    assert.equal(reg.status, 201, JSON.stringify(reg.json));
    const token = reg.json.accessToken;
    const orgId = reg.json.user.org_id;
    const h = { Authorization: `Bearer ${token}` };
    const account = await call('POST', `/v1/orgs/${orgId}/accounts`, { slug: 'protected', displayName: 'Protected' }, h);
    assert.equal(account.status, 201, JSON.stringify(account.json));
    const invite = await call('POST', `/v1/orgs/${orgId}/users`, { email: `member-${suffix}@example.test` }, h);
    assert.equal(invite.status, 201, JSON.stringify(invite.json));
    const memberPassword = 'MemberRetire!2345';
    const accept = await call('POST', '/v1/auth/invite/accept', { token: invite.json.inviteToken, password: memberPassword });
    assert.equal(accept.status, 201, JSON.stringify(accept.json));
    const memberToken = accept.json.accessToken;
    const denied = await call('POST', `/v1/accounts/${account.json.id}/retire`, { reason: 'not allowed' }, { Authorization: `Bearer ${memberToken}` });
    assert.equal(denied.status, 403, JSON.stringify(denied.json));
    assert.equal(denied.json.error, 'org_admin_required');
  });
});
