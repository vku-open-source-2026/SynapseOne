// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Regression tests for the privilege-escalation paths found during the
 * Super Admin security review. Runs with enforcement enabled.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createApp } from './index';

const saved: Record<string, string | undefined> = {};

describe('iam sensitive mutation hardening', () => {
  let base = '';
  let server: Server | null = null;
  let adminToken = '';
  let memberToken = '';
  let adminId = '';
  let memberId = '';
  let orgId = '';
  let accountId = '';
  let roleId = '';

  const h = (token: string) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });

  async function call(method: string, path: string, body: any, token: string) {
    const r = await fetch(base + path, { method, headers: h(token), body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: r.status, json };
  }

  before(
    () =>
      new Promise<void>((resolve, reject) => {
        for (const k of ['NODE_ENV', 'DATABASE_URL', 'SYNAPSEONE_INTERNAL_SECRET', 'IAM_ALLOW_DEV_LOGIN',
          'IAM_SENSITIVE_MUTATION_MODE', 'IAM_ALLOW_DIRECT_ORG_CREATE']) saved[k] = process.env[k];
        delete process.env.NODE_ENV;
        delete process.env.DATABASE_URL;
        delete process.env.SYNAPSEONE_INTERNAL_SECRET;
        process.env.IAM_ALLOW_DEV_LOGIN = 'true';
        process.env.IAM_SENSITIVE_MUTATION_MODE = 'enforce';
        process.env.IAM_ALLOW_DIRECT_ORG_CREATE = 'false';
        const app = createApp();
        server = app.listen(0, '127.0.0.1', async () => {
          try {
            const a = server!.address();
            base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
            const adminLogin = await fetch(`${base}/v1/auth/login`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ email: 'sec-admin@test.local', orgSlug: 'secorg' }),
            });
            const adminJson: any = await adminLogin.json();
            adminToken = adminJson.accessToken;
            adminId = adminJson.user.id;
            orgId = adminJson.user.org_id;
            const memberLogin = await fetch(`${base}/v1/auth/login`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ email: 'sec-member@test.local', orgSlug: 'secorg' }),
            });
            const memberJson: any = await memberLogin.json();
            memberToken = memberJson.accessToken;
            memberId = memberJson.user.id;
            const acc = await call('POST', `/v1/orgs/${orgId}/accounts`, { slug: 'prod', displayName: 'Production' }, adminToken);
            assert.equal(acc.status, 201, JSON.stringify(acc.json));
            accountId = acc.json.id;
            const role = await call('POST', `/v1/accounts/${accountId}/roles`, { slug: 'member-role' }, adminToken);
            assert.equal(role.status, 201, JSON.stringify(role.json));
            roleId = role.json.id;
            resolve();
          } catch (e) {
            reject(e);
          }
        });
      }),
  );

  after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  });

  it('member cannot create an account, role, policy, key, service account or assign a role', async () => {
    assert.equal((await call('POST', `/v1/orgs/${orgId}/accounts`, { slug: 'evil', displayName: 'Evil' }, memberToken)).status, 403);
    assert.equal((await call('POST', `/v1/accounts/${accountId}/roles`, { slug: 'evil' }, memberToken)).status, 403);
    assert.equal((await call('POST', `/v1/accounts/${accountId}/policies`, { slug: 'evil', document: { Version: '2026-01-01', Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }] } }, memberToken)).status, 403);
    assert.equal((await call('POST', `/v1/accounts/${accountId}/service-accounts`, { slug: 'evil' }, memberToken)).status, 403);
    assert.equal((await call('POST', `/v1/accounts/${accountId}/keys`, { name: 'evil' }, memberToken)).status, 403);
    assert.equal((await call('POST', `/v1/users/${adminId}/assign`, { roleId }, memberToken)).status, 403);
  });

  it('member cannot mint a key for the org administrator, but can mint a self-bound key', async () => {
    const steal = await call('POST', `/v1/accounts/${accountId}/keys`, { name: 'steal', userId: adminId, scopes: ['*'] }, memberToken);
    assert.equal(steal.status, 403);
    assert.equal(steal.json.error, 'key_owner_forbidden');
    const self = await call('POST', `/v1/accounts/${accountId}/keys`, { name: 'self', userId: memberId, scopes: ['*:read'] }, memberToken);
    assert.equal(self.status, 201, JSON.stringify(self.json));
  });

  it('member cannot issue SCIM tokens; org admin can', async () => {
    const denied = await call('POST', '/v1/scim/tokens', { description: 'evil' }, memberToken);
    assert.equal(denied.status, 403);
    const ok = await call('POST', '/v1/scim/tokens', { description: 'ok' }, adminToken);
    assert.equal(ok.status, 201);
  });

  it('direct organization creation is disabled and audited', async () => {
    const denied = await call('POST', '/v1/orgs', { slug: 'orphan', displayName: 'Orphan' }, memberToken);
    assert.equal(denied.status, 403);
    assert.equal(denied.json.error, 'platform_org_create_required');
  });

  it('audit reads are org-admin only', async () => {
    const denied = await fetch(`${base}/v1/audit`, { headers: h(memberToken) });
    assert.equal(denied.status, 403);
    const ok = await fetch(`${base}/v1/audit`, { headers: h(adminToken) });
    assert.equal(ok.status, 200);
  });

  it('org-admin grants are audited with old/new values', async () => {
    const grant = await call('PUT', `/v1/users/${memberId}/org-admin`, { isOrgAdmin: true, reason: 'test grant' }, adminToken);
    assert.equal(grant.status, 200);
    const audit = await fetch(`${base}/v1/audit?action=iam:user:org-admin`, { headers: h(adminToken) });
    const rows: any[] = await audit.json();
    assert.ok(rows.some((r) => r.context?.newValue === true && r.context?.targetUserId === memberId));
  });
});
