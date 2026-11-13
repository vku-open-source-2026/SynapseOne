// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * First-party credential lifecycle + delegated token exchange tests (#22).
 * In-memory IAM, ephemeral HTTP server, no external network.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import jwt from 'jsonwebtoken';
import { createApp } from './index';
import { getJwtSecret, verifyAccess, revokeAllRefresh } from './tokens';
import { setUserActive } from './db';

// Lifecycle tokens are opt-in; these tests assert the dev/mailer-less flow.
process.env.IAM_EXPOSE_LIFECYCLE_TOKENS = 'true';

let base = '';
let server: Server;

before(async () => {
  const app = createApp();
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function call(method: string, path: string, body?: any, token?: string, extra: Record<string, string> = {}) {
  const r = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: r.status, data };
}

const PASSWORD = 'correct horse battery staple';

async function register(orgSlug: string, email: string, password = PASSWORD) {
  const r = await call('POST', '/v1/auth/register', { email, password, orgSlug, displayName: 'Test User' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
}

describe('first-party credential lifecycle', () => {
  it('registers a new org, logs in with a password and verifies email', async () => {
    const reg = await register('cred-new', 'new@cred.local');
    assert.ok(reg.accessToken);
    assert.ok(reg.refreshToken);
    assert.ok(reg.emailVerificationToken, 'dev exposes the verification token');
    assert.equal(reg.user.email, 'new@cred.local');

    const wrong = await call('POST', '/v1/auth/login', { email: 'new@cred.local', password: 'wrong password 123', orgSlug: 'cred-new' });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.data.error, 'invalid_credentials');

    const login = await call('POST', '/v1/auth/login', { email: 'new@cred.local', password: PASSWORD, orgSlug: 'cred-new' });
    assert.equal(login.status, 200);
    assert.ok(login.data.accessToken);

    const verify = await call('POST', '/v1/auth/email/verify', { token: reg.emailVerificationToken });
    assert.equal(verify.status, 200);
    assert.equal(verify.data.emailVerified, true);
    const reused = await call('POST', '/v1/auth/email/verify', { token: reg.emailVerificationToken });
    assert.equal(reused.status, 400);
  });

  it('rejects existing access tokens after the account is disabled', async () => {
    const reg = await register('cred-disabled', 'disabled@cred.local');
    const before = await call('GET', '/v1/orgs', undefined, reg.accessToken);
    assert.equal(before.status, 200);
    await setUserActive(reg.user.id, false);
    const after = await call('GET', '/v1/orgs', undefined, reg.accessToken);
    assert.equal(after.status, 401);
    assert.equal(after.data.error, 'account_deactivated');
    const me = await call('GET', '/v1/auth/me', undefined, reg.accessToken);
    assert.equal(me.status, 401);
    assert.equal(me.data.error, 'account_deactivated');
  });

  it('rejects access tokens after a session revocation epoch bump', async () => {
    const reg = await register('cred-revoke', 'revoke@cred.local');
    const before = await call('GET', '/v1/orgs', undefined, reg.accessToken);
    assert.equal(before.status, 200);
    await revokeAllRefresh(reg.user.id);
    const after = await call('GET', '/v1/orgs', undefined, reg.accessToken);
    assert.equal(after.status, 401);
    assert.equal(after.data.error, 'token_revoked');
    const verify = await call('GET', '/v1/auth/verify', undefined, reg.accessToken);
    assert.equal(verify.status, 401);
    assert.equal(verify.data.error, 'token_revoked');
  });

  it('never returns password material on auth or user endpoints', async () => {
    const reg = await register('cred-hash', 'hash@cred.local');
    const login = await call('POST', '/v1/auth/login', { email: 'hash@cred.local', password: PASSWORD, orgSlug: 'cred-hash' });
    const me = await call('GET', '/v1/auth/me', undefined, login.data.accessToken);
    const orgs = await call('GET', '/v1/orgs', undefined, login.data.accessToken);
    const users = await call('GET', `/v1/orgs/${orgs.data[0].id}/users`, undefined, login.data.accessToken);
    const invite = await call('POST', `/v1/orgs/${orgs.data[0].id}/users`, { email: 'second@cred.local' }, login.data.accessToken);

    for (const [label, payload] of [
      ['register', reg],
      ['login', login.data],
      ['me', me.data],
      ['users', users.data],
      ['invite', invite.data],
    ] as const) {
      assert.ok(!JSON.stringify(payload).includes('password_hash'), `${label} leaked password_hash`);
      assert.ok(!JSON.stringify(payload).includes('scrypt$'), `${label} leaked a password hash`);
    }
  });

  it('requires an invitation to join an existing organization', async () => {
    const admin = await register('cred-join', 'admin@cred.local');
    const stranger = await call('POST', '/v1/auth/register', {
      email: 'stranger@cred.local', password: PASSWORD, orgSlug: 'cred-join',
    });
    assert.equal(stranger.status, 403);
    assert.equal(stranger.data.error, 'org_membership_required');

    // Admin invites the user (creates the user row), then registration works.
    const orgs = await call('GET', '/v1/orgs', undefined, admin.accessToken);
    const orgId = orgs.data[0].id;
    const invited = await call('POST', `/v1/orgs/${orgId}/users`, { email: 'invited@cred.local' }, admin.accessToken);
    assert.equal(invited.status, 201, JSON.stringify(invited.data));
    assert.equal(typeof invited.data.inviteToken, 'string');
    const noCode = await call('POST', '/v1/auth/register', {
      email: 'invited@cred.local', password: PASSWORD, orgSlug: 'cred-join',
    });
    assert.equal(noCode.status, 403);
    assert.equal(noCode.data.error, 'invite_required');
    const reg = await call('POST', '/v1/auth/invite/accept', {
      token: invited.data.inviteToken, password: PASSWORD,
    });
    assert.equal(reg.status, 201, JSON.stringify(reg.data));
    assert.equal(typeof reg.data.accessToken, 'string');
  });

  it('changes and resets passwords, revoking old sessions', async () => {
    const reg = await register('cred-reset', 'reset@cred.local');
    const changed = await call('POST', '/v1/auth/password/change', {
      currentPassword: PASSWORD, newPassword: 'a brand new passphrase',
    }, reg.accessToken);
    assert.equal(changed.status, 200, JSON.stringify(changed.data));
    assert.ok(changed.data.revokedSessions >= 1);

    const oldLogin = await call('POST', '/v1/auth/login', { email: 'reset@cred.local', password: PASSWORD, orgSlug: 'cred-reset' });
    assert.equal(oldLogin.status, 401);
    const newLogin = await call('POST', '/v1/auth/login', {
      email: 'reset@cred.local', password: 'a brand new passphrase', orgSlug: 'cred-reset',
    });
    assert.equal(newLogin.status, 200);

    const forgot = await call('POST', '/v1/auth/password/forgot', { email: 'reset@cred.local', orgSlug: 'cred-reset' });
    assert.equal(forgot.status, 202);
    assert.ok(forgot.data.resetToken);
    const reset = await call('POST', '/v1/auth/password/reset', {
      token: forgot.data.resetToken, newPassword: 'third time lucky pass',
    });
    assert.equal(reset.status, 200, JSON.stringify(reset.data));
    const thirdLogin = await call('POST', '/v1/auth/login', {
      email: 'reset@cred.local', password: 'third time lucky pass', orgSlug: 'cred-reset',
    });
    assert.equal(thirdLogin.status, 200);
    // Single use.
    const replay = await call('POST', '/v1/auth/password/reset', { token: forgot.data.resetToken, newPassword: 'another password 42' });
    assert.equal(replay.status, 400);

    // An unknown account never leaks existence.
    const ghost = await call('POST', '/v1/auth/password/forgot', { email: 'ghost@cred.local', orgSlug: 'cred-reset' });
    assert.equal(ghost.status, 202);
    assert.equal(ghost.data.resetToken, undefined);
  });

  it('enforces password policy and rejects unknown tokens', async () => {
    const weak = await call('POST', '/v1/auth/register', { email: 'weak@cred.local', password: 'short', orgSlug: 'cred-weak' });
    assert.equal(weak.status, 400);
    assert.equal(weak.data.error, 'weak_password');
    const bad = await call('POST', '/v1/auth/password/reset', { token: 'synapseone_reset_notarealtoken', newPassword: PASSWORD });
    assert.equal(bad.status, 400);
  });

  it('lists and revokes sessions', async () => {
    const reg = await register('cred-sessions', 'sessions@cred.local');
    const list = await call('GET', '/v1/auth/sessions', undefined, reg.accessToken);
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.data) && list.data.length >= 1);
    const id = list.data[0].id;
    const revoked = await call('DELETE', `/v1/auth/sessions/${id}`, undefined, reg.accessToken);
    assert.equal(revoked.status, 200);
    const again = await call('DELETE', `/v1/auth/sessions/${id}`, undefined, reg.accessToken);
    assert.equal(again.status, 404);
  });
});

describe('delegated token exchange', () => {
  async function fixture(orgSlug: string) {
    const owner = await register(orgSlug, `owner@${orgSlug}.local`);
    const orgs = await call('GET', '/v1/orgs', undefined, owner.accessToken);
    const orgId = orgs.data[0].id;
    const acc = await call('POST', `/v1/orgs/${orgId}/accounts`, { slug: 'svc', displayName: 'Service' }, owner.accessToken);
    assert.equal(acc.status, 201, JSON.stringify(acc.data));
    const accountId = acc.data.id;
    const sa = await call('POST', `/v1/accounts/${accountId}/service-accounts`, { slug: 'tier2', description: 'Tier 2' }, owner.accessToken);
    assert.equal(sa.status, 201, JSON.stringify(sa.data));
    // A wildcard API key mints the (narrower) service-account token.
    const key = await call('POST', `/v1/accounts/${accountId}/keys`, { name: 'tier2-bootstrap', scopes: ['*'] }, owner.accessToken);
    assert.equal(key.status, 201, JSON.stringify(key.data));
    const saToken = await call(
      'POST',
      `/v1/service-accounts/${sa.data.id}/token`,
      { scopes: ['faststore:get', 'base:read'] },
      undefined,
      { 'X-API-Key': key.data.apiKey },
    );
    assert.equal(saToken.status, 200, JSON.stringify(saToken.data));
    // The target user is a normal member of the same org.
    const target = await call('POST', `/v1/orgs/${orgId}/users`, { email: `target@${orgSlug}.local` }, owner.accessToken);
    assert.equal(target.status, 201, JSON.stringify(target.data));
    return { owner, orgId, accountId, saToken: saToken.data.accessToken, targetUserId: target.data.id };
  }

  it('exchanges a service credential for a user-bound delegated token', async () => {
    const f = await fixture('xfersame');
    const ex = await call('POST', '/v1/auth/exchange', {
      userId: f.targetUserId,
      scopes: ['faststore:get'],
      audience: 'synapsedx',
      ttlSeconds: 300,
    }, f.saToken);
    assert.equal(ex.status, 200, JSON.stringify(ex.data));
    assert.equal(ex.data.delegated, true);
    assert.equal(ex.data.ttlSeconds, undefined);
    assert.ok(ex.data.expiresIn <= 300);
    const claims: any = verifyAccess(ex.data.accessToken);
    assert.equal(claims.sub, f.targetUserId);
    assert.equal(claims.org, f.orgId);
    assert.equal(claims.account, f.accountId);
    assert.equal(claims.kind, 'delegated');
    assert.equal(claims.aud, 'synapsedx');
    assert.deepEqual(claims.scopes, ['faststore:get']);
    assert.ok(claims.act?.sub, 'records the acting service identity');

    // The delegated token is a real credential for IAM reads.
    const orgs = await call('GET', '/v1/orgs', undefined, ex.data.accessToken);
    assert.equal(orgs.status, 200);
    assert.equal(orgs.data[0].id, f.orgId);

    // The exchange is audited.
    const audit = await call('GET', '/v1/audit?limit=200', undefined, f.owner.accessToken);
    assert.ok(audit.data.some((r: any) => r.action === 'iam:token:exchange'));
  });

  it('refuses cross-tenant targets and scope escalation', async () => {
    const f = await fixture('xferone');
    const other = await fixture('xfertwo');
    const cross = await call('POST', '/v1/auth/exchange', { userId: other.targetUserId }, f.saToken);
    assert.equal(cross.status, 403);
    assert.equal(cross.data.error, 'cross_tenant');

    const escalate = await call('POST', '/v1/auth/exchange', {
      userId: f.targetUserId, scopes: ['*'],
    }, f.saToken);
    assert.equal(escalate.status, 403);
    assert.equal(escalate.data.error, 'scope_escalation');

    // Unknown target user → 404.
    const missing = await call('POST', '/v1/auth/exchange', { userId: '00000000-0000-4000-8000-000000000000' }, f.saToken);
    assert.equal(missing.status, 404);
  });

  it('refuses user JWTs and requires a service credential', async () => {
    const f = await fixture('xferauth');
    const asUser = await call('POST', '/v1/auth/exchange', { userId: f.targetUserId }, f.owner.accessToken);
    assert.equal(asUser.status, 403);
    assert.equal(asUser.data.error, 'exchange_requires_service_credential');
    const anonymous = await call('POST', '/v1/auth/exchange', { userId: f.targetUserId });
    assert.equal(anonymous.status, 401);
  });

  it('rejects expired delegated tokens', () => {
    const expired = jwt.sign(
      { sub: 'u', org: 'o', account: 'a', kind: 'delegated', iss: 'synapseone-iam' },
      getJwtSecret(),
      { expiresIn: -1, algorithm: 'HS256' },
    );
    assert.throws(() => verifyAccess(expired), /expired|jwt/i);
  });
});

describe('authorization hardening (#23)', () => {
  it('narrows minted key scopes and refuses wildcard escalation', async () => {
    const owner = await register('authz-keys', 'owner@authz-keys.local');
    const orgs = await call('GET', '/v1/orgs', undefined, owner.accessToken);
    const orgId = orgs.data[0].id;
    const acc = await call('POST', `/v1/orgs/${orgId}/accounts`, { slug: 'prod', displayName: 'Prod' }, owner.accessToken);
    const accountId = acc.data.id;

    const narrow = await call('POST', `/v1/accounts/${accountId}/keys`, {
      name: 'narrow', scopes: ['faststore:get'],
    }, owner.accessToken);
    assert.equal(narrow.status, 201, JSON.stringify(narrow.data));

    // The narrow key cannot mint a wildcard (or any scope it does not hold).
    const escalated = await call('POST', `/v1/accounts/${accountId}/keys`, {
      name: 'escalated', scopes: ['*'],
    }, undefined, { 'X-API-Key': narrow.data.apiKey });
    assert.equal(escalated.status, 403);
    assert.equal(escalated.data.error, 'scope_escalation');

    // It can mint within its own scope.
    const same = await call('POST', `/v1/accounts/${accountId}/keys`, {
      name: 'copy', scopes: ['faststore:get'],
    }, undefined, { 'X-API-Key': narrow.data.apiKey });
    assert.equal(same.status, 201, JSON.stringify(same.data));

    // Omitting scopes is least-privilege read, not '*'.
    const defaulted = await call('POST', `/v1/accounts/${accountId}/keys`, { name: 'defaulted' }, owner.accessToken);
    assert.equal(defaulted.status, 201);
    const listed = await call('GET', `/v1/accounts/${accountId}/keys`, undefined, owner.accessToken);
    const row = listed.data.find((k: any) => k.id === defaulted.data.id);
    assert.deepEqual(row.scopes, ['*:read']);

    // /v1/keys/verify returns the owning org for usage attribution (#28).
    const verify = await call('POST', '/v1/keys/verify', { apiKey: narrow.data.apiKey });
    assert.equal(verify.status, 200);
    assert.equal(verify.data.org_id, orgId);
  });

  it('refuses to evaluate /v1/authorize for another tenant', async () => {
    const a = await register('authz-a', 'a@authz-a.local');
    const b = await register('authz-b', 'b@authz-b.local');
    const bOrgs = await call('GET', '/v1/orgs', undefined, b.accessToken);
    const bOrgId = bOrgs.data[0].id;
    const bUser = await call('POST', `/v1/orgs/${bOrgId}/users`, { email: 'victim@authz-b.local' }, b.accessToken);

    const cross = await call('POST', '/v1/authorize', {
      userId: bUser.data.id, action: 'base:read', resource: '*',
    }, a.accessToken);
    assert.equal(cross.status, 403);
    assert.equal(cross.data.error, 'cross_tenant');

    // No audit row leaked into the victim org's view.
    const victimAudit = await call('GET', '/v1/audit?limit=100', undefined, b.accessToken);
    assert.ok(!victimAudit.data.some((r: any) => r.action === 'base:read'));

    // Same-tenant evaluation still works and is audited to the caller org.
    const aOrgs = await call('GET', '/v1/orgs', undefined, a.accessToken);
    const aUser = await call('POST', `/v1/orgs/${aOrgs.data[0].id}/users`, { email: 'self@authz-a.local' }, a.accessToken);
    const ok = await call('POST', '/v1/authorize', {
      userId: aUser.data.id, action: 'base:read', resource: '*',
    }, a.accessToken);
    assert.equal(ok.status, 200);
    assert.equal(typeof ok.data.allowed, 'boolean');
  });
});

describe('mutation audit trail + filters (#32)', () => {
  it('records IAM mutations and supports action/resource/time/pagination filters', async () => {
    const owner = await register('audit-org', 'owner@audit-org.local');
    const orgs = await call('GET', '/v1/orgs', undefined, owner.accessToken);
    const orgId = orgs.data[0].id;
    const acc = await call('POST', `/v1/orgs/${orgId}/accounts`, { slug: 'audit-acc', displayName: 'Audit' }, owner.accessToken);
    assert.equal(acc.status, 201);
    const accountId = acc.data.id;
    const role = await call('POST', `/v1/accounts/${accountId}/roles`, { slug: 'reader' }, owner.accessToken);
    assert.equal(role.status, 201);
    const key = await call('POST', `/v1/accounts/${accountId}/keys`, { name: 'audited', scopes: ['base:read'] }, owner.accessToken);
    assert.equal(key.status, 201);

    const accounts = await call('GET', '/v1/audit?action=iam:account:create', undefined, owner.accessToken);
    assert.equal(accounts.status, 200);
    assert.ok(accounts.data.some((r: any) => r.resource === `account:${accountId}`));

    const roles = await call('GET', `/v1/audit?resource=role:${role.data.id}`, undefined, owner.accessToken);
    assert.ok(roles.data.length >= 1);
    assert.equal(roles.data[0].action, 'iam:role:create');

    const keys = await call('GET', '/v1/audit?action=iam:key:create', undefined, owner.accessToken);
    assert.ok(keys.data.some((r: any) => r.context?.keyId === key.data.id));

    // Time window: the future has no rows; the past includes them.
    const future = new Date(Date.now() + 60_000).toISOString();
    const empty = await call('GET', `/v1/audit?from=${encodeURIComponent(future)}`, undefined, owner.accessToken);
    assert.deepEqual(empty.data, []);
    const past = new Date(Date.now() - 60_000).toISOString();
    const recent = await call('GET', `/v1/audit?from=${encodeURIComponent(past)}&limit=1`, undefined, owner.accessToken);
    assert.equal(recent.data.length, 1);
    const page2 = await call('GET', `/v1/audit?from=${encodeURIComponent(past)}&limit=1&offset=1`, undefined, owner.accessToken);
    assert.equal(page2.data.length, 1);
    assert.notEqual(page2.data[0].id, recent.data[0].id);

    // Another org sees none of it.
    const other = await register('audit-other', 'other@audit-other.local');
    const otherAudit = await call('GET', '/v1/audit?limit=200', undefined, other.accessToken);
    assert.ok(!otherAudit.data.some((r: any) => r.resource === `account:${accountId}`));

    // Invalid filters fail closed.
    assert.equal((await call('GET', '/v1/audit?limit=0', undefined, owner.accessToken)).status, 400);
    assert.equal((await call('GET', '/v1/audit?from=nope', undefined, owner.accessToken)).status, 400);
    assert.equal((await call('GET', '/v1/audit?actor=nope', undefined, owner.accessToken)).status, 400);
  });
});
