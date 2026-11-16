// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Principal authorization (gateway enforcement point), org administrators,
 * managed policies, service-account roles, API-key rotation and sessions.
 * Runs against the in-memory DB (no DATABASE_URL here).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createApp } from './index';
import { scopesAllow } from './authz';

const SECRET = 'test-secret-authz';

describe('iam principal authorization', () => {
  let base = '';
  let server: Server | null = null;
  const saved: Record<string, string | undefined> = {};

  const H = (token?: string, extra: Record<string, string> = {}) => ({
    'Content-Type': 'application/json',
    'x-synapseone-internal': SECRET,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  });
  async function call(method: string, path: string, body?: any, token?: string, extra: Record<string, string> = {}) {
    const r = await fetch(base + path, { method, headers: H(token, extra), body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, json: (text ? JSON.parse(text) : null) as any };
  }
  const decide = (principal: any, action: string, resource = 'arn:synapseone:o:a:base:x') =>
    call('POST', '/internal/authorize', { principal, action, resource });

  let adminToken = '';
  let adminId = '';
  let memberToken = '';
  let memberId = '';
  let memberRefresh = '';
  let orgId = '';
  let accId = '';

  before(
    () =>
      new Promise<void>((resolve, reject) => {
        for (const k of ['SYNAPSEONE_INTERNAL_SECRET', 'NODE_ENV', 'DATABASE_URL', 'IAM_ALLOW_DEV_LOGIN']) saved[k] = process.env[k];
        process.env.SYNAPSEONE_INTERNAL_SECRET = SECRET;
        delete process.env.DATABASE_URL;
        delete process.env.NODE_ENV;
        const app = createApp();
        server = app.listen(0, '127.0.0.1', async () => {
          try {
            const a = server!.address();
            base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
            const admin = await call('POST', '/v1/auth/login', { email: 'root@authz.local', orgSlug: 'authzorg' });
            assert.equal(admin.status, 200);
            adminToken = admin.json.accessToken;
            adminId = admin.json.user.id;
            orgId = admin.json.user.org_id;
            const member = await call('POST', '/v1/auth/login', { email: 'member@authz.local', orgSlug: 'authzorg' });
            memberToken = member.json.accessToken;
            memberId = member.json.user.id;
            memberRefresh = member.json.refreshToken;
            const acc = await call('POST', `/v1/orgs/${orgId}/accounts`, { slug: 'prod', displayName: 'Production' }, adminToken);
            assert.equal(acc.status, 201);
            accId = acc.json.id;
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
    server?.close();
  });

  async function roleWithManaged(slug: string, managed: string): Promise<string> {
    const role = await call('POST', `/v1/accounts/${accId}/roles`, { slug }, adminToken);
    assert.equal(role.status, 201);
    const pol = await call('POST', `/v1/accounts/${accId}/policies`, { slug: `${slug}-pol`, managed }, adminToken);
    assert.equal(pol.status, 201, JSON.stringify(pol.json));
    const att = await call('POST', `/v1/roles/${role.json.id}/attach`, { policyId: pol.json.id }, adminToken);
    assert.equal(att.status, 200);
    return role.json.id;
  }

  it('scope patterns match AWS-style actions', () => {
    assert.equal(scopesAllow(['*'], 'base:Read'), true);
    assert.equal(scopesAllow(['storage:*'], 'storage:Write'), true);
    assert.equal(scopesAllow(['storage:*'], 'base:Read'), false);
    assert.equal(scopesAllow(['workflow:Execute'], 'workflow:Execute'), true);
    assert.equal(scopesAllow([], 'base:Read'), false);
    // Gateway scope grammar (main's default key scope is `*:read`).
    assert.equal(scopesAllow(['*:read'], 'base:Read'), true);
    assert.equal(scopesAllow(['*:read'], 'base:Write'), false);
    assert.equal(scopesAllow(['base:read'], 'base:Read'), true);
    assert.equal(scopesAllow(['base:read'], 'queue:Read'), false);
    assert.equal(scopesAllow(['base:write'], 'base:Delete'), true);
    assert.equal(scopesAllow(['*:write'], 'workflow:Execute'), true);
    assert.equal(scopesAllow(['workflow:execute'], 'workflow:Execute'), true);
  });

  it('first user of an org becomes its administrator; later users do not', async () => {
    const me = await call('GET', '/v1/auth/me', undefined, adminToken);
    assert.equal(me.json.user.is_org_admin, true);
    const other = await call('GET', '/v1/auth/me', undefined, memberToken);
    assert.equal(other.json.user.is_org_admin, false);
  });

  it('/internal/authorize requires the internal secret', async () => {
    const r = await fetch(base + '/internal/authorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ principal: { kind: 'user', sub: adminId }, action: 'base:Read', resource: '*' }),
    });
    assert.equal(r.status, 401);
  });

  it('non-UUID subjects are denied as unknown principals (not 400)', async () => {
    const r = await decide({ kind: 'user', sub: 'e2e-tester-id' }, 'base:Read');
    assert.equal(r.status, 200);
    assert.equal(r.json.allowed, false);
    assert.equal(r.json.reason, 'unknown-principal');
  });

  it('org admin is allowed; member without roles is implicitly denied', async () => {
    const a = await decide({ kind: 'user', sub: adminId }, 'iam:Write');
    assert.equal(a.json.allowed, true);
    assert.equal(a.json.reason, 'org-admin');
    const m = await decide({ kind: 'user', sub: memberId }, 'base:Read');
    assert.equal(m.json.allowed, false);
    assert.equal(m.json.reason, 'implicit-deny');
  });

  it('managed ReadOnlyAccess grants reads only and denials are audited', async () => {
    const roleId = await roleWithManaged('readers', 'ReadOnlyAccess');
    assert.equal((await call('POST', `/v1/users/${memberId}/assign`, { roleId }, adminToken)).status, 200);
    assert.equal((await decide({ kind: 'user', sub: memberId }, 'base:Read')).json.allowed, true);
    const w = await decide({ kind: 'user', sub: memberId }, 'base:Write');
    assert.equal(w.json.allowed, false);
    const audit = await call('GET', '/v1/audit?allowed=false', undefined, adminToken);
    assert.ok(audit.json.some((e: any) => e.action === 'base:Write' && e.actor_id === memberId));
  });

  it('explicit Deny wins even for an org admin', async () => {
    const role = await call('POST', `/v1/accounts/${accId}/roles`, { slug: 'no-delete' }, adminToken);
    const pol = await call('POST', `/v1/accounts/${accId}/policies`, {
      slug: 'deny-storage-delete',
      document: { Version: '2026-01-01', Statement: [{ Effect: 'Deny', Action: 'storage:Delete', Resource: '*' }] },
    }, adminToken);
    await call('POST', `/v1/roles/${role.json.id}/attach`, { policyId: pol.json.id }, adminToken);
    await call('POST', `/v1/users/${adminId}/assign`, { roleId: role.json.id }, adminToken);
    const d = await decide({ kind: 'user', sub: adminId }, 'storage:Delete');
    assert.equal(d.json.allowed, false);
    assert.equal(d.json.reason, 'explicit-deny');
    assert.equal((await decide({ kind: 'user', sub: adminId }, 'storage:Write')).json.allowed, true);
  });

  it('API keys are capped by scopes and inherit their owner permissions', async () => {
    // Owner-bound key: member holds ReadOnlyAccess, key scoped to storage only.
    const owned = await call('POST', `/v1/accounts/${accId}/keys`, { name: 'owned', userId: memberId, scopes: ['storage:*'] }, adminToken);
    assert.equal(owned.status, 201);
    const verified = await call('POST', '/v1/keys/verify', { apiKey: owned.json.apiKey });
    assert.equal(verified.json.id, owned.json.id);
    assert.equal(verified.json.user_id, memberId);
    const kp = { kind: 'apikey', keyId: owned.json.id };
    assert.equal((await decide(kp, 'storage:Read')).json.allowed, true);
    assert.equal((await decide(kp, 'storage:Write')).json.reason, 'implicit-deny');
    assert.equal((await decide(kp, 'base:Read')).json.reason, 'scope-deny');
    // Account-level key (no owner): bounded by scopes alone.
    const acct = await call('POST', `/v1/accounts/${accId}/keys`, { name: 'ci', scopes: ['queue:*'] }, adminToken);
    const ap = { kind: 'apikey', keyId: acct.json.id };
    assert.equal((await decide(ap, 'queue:Write')).json.reason, 'scope-only');
    assert.equal((await decide(ap, 'iam:Write')).json.allowed, false);
    const list = await call('GET', `/v1/accounts/${accId}/keys`, undefined, adminToken);
    const row = list.json.find((k: any) => k.id === owned.json.id);
    assert.ok(row.last_used_at, 'verify stamps last_used_at');
  });

  it('service accounts gain permissions from roles, capped by token scopes', async () => {
    const sa = await call('POST', `/v1/accounts/${accId}/service-accounts`, { slug: 'etl' }, adminToken);
    assert.equal(sa.status, 201);
    const sp = { kind: 'service-account', sub: sa.json.id, scopes: ['*'] };
    assert.equal((await decide(sp, 'base:Write')).json.reason, 'scope-only');
    const roleId = await roleWithManaged('etl-readers', 'ReadOnlyAccess');
    assert.equal((await call('POST', `/v1/service-accounts/${sa.json.id}/roles`, { roleId }, adminToken)).status, 200);
    const roles = await call('GET', `/v1/service-accounts/${sa.json.id}/roles`, undefined, adminToken);
    assert.deepEqual(roles.json.map((r: any) => r.id), [roleId]);
    assert.equal((await decide(sp, 'base:Read')).json.reason, 'policy-allow');
    assert.equal((await decide(sp, 'base:Write')).json.reason, 'implicit-deny');
    assert.equal((await decide({ ...sp, scopes: ['queue:*'] }, 'base:Read')).json.reason, 'scope-deny');
    assert.equal((await call('DELETE', `/v1/service-accounts/${sa.json.id}/roles/${roleId}`, undefined, adminToken)).status, 200);
  });

  it('managed policy catalog and validation', async () => {
    const list = await call('GET', '/v1/managed-policies', undefined, adminToken);
    const names = list.json.map((p: any) => p.name);
    for (const n of ['AdministratorAccess', 'PowerUserAccess', 'ReadOnlyAccess', 'StorageFullAccess']) assert.ok(names.includes(n));
    const bad = await call('POST', `/v1/accounts/${accId}/policies`, { slug: 'x', managed: 'GodMode' }, adminToken);
    assert.equal(bad.status, 400);
  });

  it('API key rotation: immediate revoke or grace overlap', async () => {
    const k = await call('POST', `/v1/accounts/${accId}/keys`, { name: 'deploy', scopes: ['*'] }, adminToken);
    const hard = await call('POST', `/v1/keys/${k.json.id}/rotate`, {}, adminToken);
    assert.equal(hard.status, 201);
    assert.equal(hard.json.rotatedFrom, k.json.id);
    assert.equal((await call('POST', '/v1/keys/verify', { apiKey: k.json.apiKey })).status, 401);
    assert.equal((await call('POST', '/v1/keys/verify', { apiKey: hard.json.apiKey })).status, 200);
    const soft = await call('POST', `/v1/keys/${hard.json.id}/rotate`, { graceSeconds: 300 }, adminToken);
    assert.equal(soft.status, 201);
    assert.equal((await call('POST', '/v1/keys/verify', { apiKey: hard.json.apiKey })).status, 200, 'old key valid during grace');
    assert.equal((await call('POST', '/v1/keys/verify', { apiKey: soft.json.apiKey })).status, 200);
    assert.equal((await call('POST', `/v1/keys/${k.json.id}/rotate`, {}, adminToken)).status, 409);
    assert.equal((await call('POST', `/v1/keys/${hard.json.id}/rotate`, { graceSeconds: -1 }, adminToken)).status, 400);
  });

  it('sessions: list own, revoke one, others are invisible', async () => {
    const second = await call('POST', '/v1/auth/login', { email: 'member@authz.local', orgSlug: 'authzorg' });
    const mine = await call('GET', '/v1/auth/sessions', undefined, memberToken);
    assert.equal(mine.status, 200);
    assert.ok(mine.json.length >= 2);
    const target = mine.json[mine.json.length - 1].id;
    assert.equal((await call('DELETE', `/v1/auth/sessions/${target}`, undefined, adminToken)).status, 404, 'not the owner');
    assert.equal((await call('DELETE', `/v1/auth/sessions/${target}`, undefined, memberToken)).status, 200);
    const after = await call('GET', '/v1/auth/sessions', undefined, second.json.accessToken);
    // Main's session listing keeps revoked rows and marks them with revoked_at.
    const revoked = after.json.find((s: any) => s.id === target);
    assert.ok(!revoked || revoked.revoked_at, 'revoked session is gone or marked revoked');
    // Exactly one of the two logins was revoked: its refresh token no longer works.
    const r1 = (await call('POST', '/v1/auth/refresh', { refreshToken: memberRefresh })).status;
    const r2 = (await call('POST', '/v1/auth/refresh', { refreshToken: second.json.refreshToken })).status;
    assert.deepEqual([r1, r2].sort(), [200, 401]);
    assert.equal((await call('GET', '/v1/auth/sessions')).status, 401);
  });

  it('only org admins manage admins; the last admin is protected', async () => {
    const byMember = await call('PUT', `/v1/users/${memberId}/org-admin`, { isOrgAdmin: true }, memberToken);
    assert.equal(byMember.status, 403);
    assert.equal(byMember.json.error, 'org_admin_required');
    const last = await call('PUT', `/v1/users/${adminId}/org-admin`, { isOrgAdmin: false }, adminToken);
    assert.equal(last.status, 409);
    const grant = await call('PUT', `/v1/users/${memberId}/org-admin`, { isOrgAdmin: true }, adminToken);
    assert.equal(grant.status, 200);
    assert.equal(grant.json.is_org_admin, true);
    const revoke = await call('PUT', `/v1/users/${memberId}/org-admin`, { isOrgAdmin: false }, adminToken);
    assert.equal(revoke.json.is_org_admin, false);
  });
});
