// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createApp } from './index';
import { createOrganization, upsertUser, grantPlatformAdmin, setOrganizationStatus, setUserPassword, markEmailVerified, listUserRowsByEmail } from './db';
import { hashPassword } from './passwords';
import { base32Decode, beginTotpEnrolment, enableTotp, totp } from './mfa';
import { signAccess } from './tokens';

let server: Server; let base = '';
let savedInternalSecret: string | undefined;
const PASSWORD = 'context-switch-strong-password';
const TARGET_PASSWORD = 'target-tenant-strong-password';
const EMAIL = `context-${Date.now()}@example.test`;

async function call(method: string, path: string, body?: any, token?: string) {
  const r = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: r.status, data: json };
}

before(async () => {
  // dotenv may have loaded a deployment secret from .env; this suite models a
  // direct IAM integration test, so do not require the gateway stamp.
  savedInternalSecret = process.env.SYNAPSEONE_INTERNAL_SECRET;
  delete process.env.SYNAPSEONE_INTERNAL_SECRET;
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const a = server.address(); base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
});
after(() => new Promise<void>((resolve) => server.close(() => {
  if (savedInternalSecret !== undefined) process.env.SYNAPSEONE_INTERNAL_SECRET = savedInternalSecret;
  resolve();
})));

describe('authorized identity contexts', () => {
  it('lists only real memberships and switches tenant context without impersonation', async () => {
    const previousSlug = process.env.PLATFORM_ORG_SLUG;
    const previousEnabled = process.env.PLATFORM_ADMIN_ENABLED;
    const previousMfa = process.env.PLATFORM_ADMIN_REQUIRE_MFA;
    const platformSlug = `ctxplatform${Date.now()}`;
    process.env.PLATFORM_ORG_SLUG = platformSlug;
    process.env.PLATFORM_ADMIN_ENABLED = 'true';
    process.env.PLATFORM_ADMIN_REQUIRE_MFA = 'true';
    try {
    const orgASlug = `ctxa${Date.now()}`;
    const reg = await call('POST', '/v1/auth/register', { email: EMAIL, password: PASSWORD, orgSlug: orgASlug, displayName: 'Context User' });
    assert.equal(reg.status, 201, JSON.stringify(reg.data));
    const orgB = await createOrganization(`ctxb${Date.now()}`, 'Context B');
    const orgBUser = await upsertUser(orgB.id, EMAIL, 'Context User');
    await setUserPassword(orgBUser.id, await hashPassword(TARGET_PASSWORD));
    const targetMetadata = (await listUserRowsByEmail(EMAIL)).find(user => user.id === orgBUser.id);
    assert.ok(targetMetadata);
    assert.equal(targetMetadata.password_hash, undefined, 'discovery metadata must not contain password hashes in either backend');
    const platformOrg = await createOrganization(platformSlug, 'Context Platform', 'platform');
    const platformUser = await upsertUser(platformOrg.id, EMAIL, 'Context User');
    await grantPlatformAdmin({ userId: platformUser.id, role: 'owner', grantedBy: platformUser.id, reason: 'context test' });
    const enrolment = await beginTotpEnrolment(platformUser.id);
    assert.ok(enrolment?.secret);
    await enableTotp(platformUser.id);

    const token = reg.data.accessToken;
    // Password login is not email verification. The self-registered org-A row
    // must not enumerate the victim org-B/platform rows that share this email.
    const passwordLogin = await call('POST', '/v1/auth/login', { email: EMAIL, password: PASSWORD, orgSlug: orgASlug });
    assert.equal(passwordLogin.status, 200, JSON.stringify(passwordLogin.data));
    assert.ok(!passwordLogin.data.user.email_verified);
    const unverified = await call('GET', '/v1/auth/contexts', undefined, passwordLogin.data.accessToken);
    assert.equal(unverified.status, 200, JSON.stringify(unverified.data));
    assert.equal(unverified.data.current.type, 'tenant');
    assert.equal(unverified.data.current.orgId, reg.data.user.org_id);
    assert.equal(unverified.data.contexts.length, 1);
    assert.equal(unverified.data.contexts[0].orgId, reg.data.user.org_id);
    assert.equal(unverified.data.preferred.id, unverified.data.current.id);
    assert.equal(unverified.data.platformPreferred, false);
    const leaked = JSON.stringify(unverified.data);
    for (const secret of [orgB.id, orgBUser.id, orgB.slug, platformOrg.id, platformUser.id, platformSlug, '"role":"owner"']) {
      assert.ok(!leaked.includes(secret), `unverified contexts leaked ${secret}`);
    }

    // After the caller proves ownership of the email, legitimate dual contexts
    // become visible again.
    await markEmailVerified(reg.data.user.id);
    const contexts = await call('GET', '/v1/auth/contexts', undefined, token);
    assert.equal(contexts.status, 200, JSON.stringify(contexts.data));
    assert.equal(contexts.data.current.type, 'tenant');
    assert.equal(contexts.data.preferred.type, 'platform');
    assert.equal(contexts.data.platformPreferred, true);
    assert.ok(contexts.data.contexts.some((c: any) => c.orgId === orgB.id));
    assert.ok(contexts.data.contexts.some((c: any) => c.type === 'platform' && c.role === 'owner'));

    // SECURITY: a tenant row that shares the platform account's email must not
    // exchange into the platform organization, even with that tenant row's own
    // password/MFA factor. Platform privileges remain bound to the caller's row.
    const tenantMfa = await beginTotpEnrolment(reg.data.user.id);
    assert.ok(tenantMfa?.secret);
    await enableTotp(reg.data.user.id);
    const noCode = await call('POST', '/v1/platform/session', {}, token);
    assert.equal(noCode.status, 403, JSON.stringify(noCode.data));
    assert.equal(noCode.data.error, 'platform_admin_required');
    const crossEmail = await call('POST', '/v1/platform/session', {
      code: totp(base32Decode(tenantMfa!.secret)),
    }, token);
    assert.equal(crossEmail.status, 403, JSON.stringify(crossEmail.data));
    assert.equal(crossEmail.data.error, 'platform_admin_required');
    assert.equal(crossEmail.data.identitySession, undefined);
    assert.equal(crossEmail.data.accessToken, undefined);

    // The legitimate platform-org row can still exchange with its own factor.
    const platformAccess = signAccess({
      sub: platformUser.id, email: platformUser.email, org: platformUser.org_id, ver: Number(platformUser.auth_version) || 0,
    });
    // A real platform-org owner whose local email flag is still false (the
    // seeded/production bootstrap case) always sees its own platform context and
    // can still obtain a platform session.
    assert.ok(!platformUser.email_verified);
    const platformContexts = await call('GET', '/v1/auth/contexts', undefined, platformAccess.token);
    assert.equal(platformContexts.status, 200, JSON.stringify(platformContexts.data));
    assert.equal(platformContexts.data.current.type, 'platform');
    assert.equal(platformContexts.data.preferred.type, 'platform');
    assert.equal(platformContexts.data.contexts.length, 1);
    assert.equal(platformContexts.data.contexts[0].orgId, platformOrg.id);
    const exchanged = await call('POST', '/v1/platform/session', {
      code: totp(base32Decode(enrolment!.secret)),
    }, platformAccess.token);
    assert.equal(exchanged.status, 200, JSON.stringify(exchanged.data));
    assert.equal(exchanged.data.role, 'owner');
    assert.equal(exchanged.data.user.org_id, platformOrg.id);
    assert.equal(exchanged.data.identitySession, undefined);
    const platformMe = await call('GET', '/v1/platform/me', undefined, exchanged.data.accessToken);
    assert.equal(platformMe.status, 200, JSON.stringify(platformMe.data));

    // A context switch must authenticate the target row itself: no password,
    // wrong password and an unverified same-email row never mint a target token.
    const noPassword = await call('POST', '/v1/auth/contexts/switch', { orgId: orgB.id }, token);
    assert.equal(noPassword.status, 401, JSON.stringify(noPassword.data));
    assert.equal(noPassword.data.error, 'target_password_required');
    assert.equal(noPassword.data.accessToken, undefined);

    const wrongPassword = await call('POST', '/v1/auth/contexts/switch', { orgId: orgB.id, password: 'wrong-password-123' }, token);
    assert.equal(wrongPassword.status, 401, JSON.stringify(wrongPassword.data));
    assert.equal(wrongPassword.data.error, 'invalid_credentials');
    assert.equal(wrongPassword.data.accessToken, undefined);

    const switched = await call('POST', '/v1/auth/contexts/switch', { orgId: orgB.id, password: TARGET_PASSWORD }, token);
    assert.equal(switched.status, 200, JSON.stringify(switched.data));
    assert.ok(switched.data.accessToken);
    const me = await call('GET', '/v1/auth/me', undefined, switched.data.accessToken);
    assert.equal(me.status, 200);
    assert.equal(me.data.user.org_id, orgB.id);

    // The target row's own MFA cannot be skipped. The response is a challenge,
    // not a session; only /v1/auth/mfa/verify can complete it.
    const targetMfa = await beginTotpEnrolment(orgBUser.id);
    assert.ok(targetMfa?.secret);
    await enableTotp(orgBUser.id);
    const targetChallenge = await call('POST', '/v1/auth/contexts/switch', { orgId: orgB.id, password: TARGET_PASSWORD }, token);
    assert.equal(targetChallenge.status, 401, JSON.stringify(targetChallenge.data));
    assert.equal(targetChallenge.data.error, 'mfa_required');
    assert.ok(targetChallenge.data.mfaToken);
    assert.equal(targetChallenge.data.accessToken, undefined);
    const targetVerified = await call('POST', '/v1/auth/mfa/verify', {
      mfaToken: targetChallenge.data.mfaToken,
      code: totp(base32Decode(targetMfa!.secret)),
    });
    assert.equal(targetVerified.status, 200, JSON.stringify(targetVerified.data));
    assert.equal(targetVerified.data.user.org_id, orgB.id);
    const switchedToken = targetVerified.data.accessToken;

    // A self-registered row in another org with the same email but no password
    // cannot be selected as a context.
    const orgC = await createOrganization(`ctxc${Date.now()}`, 'Context C');
    await upsertUser(orgC.id, EMAIL, 'Context User');
    const noTargetPassword = await call('POST', '/v1/auth/contexts/switch', { orgId: orgC.id, password: TARGET_PASSWORD }, token);
    assert.equal(noTargetPassword.status, 403, JSON.stringify(noTargetPassword.data));
    assert.equal(noTargetPassword.data.error, 'target_login_required');
    assert.equal(noTargetPassword.data.accessToken, undefined);

    // A suspended caller cannot switch, even into an active target.
    await setOrganizationStatus(reg.data.user.org_id, 'suspended', platformUser.id, 'caller suspension');
    const blocked = await call('POST', '/v1/auth/contexts/switch', { orgId: orgB.id, password: TARGET_PASSWORD }, token);
    assert.equal(blocked.status, 403, JSON.stringify(blocked.data));
    assert.equal(blocked.data.error, 'org_suspended');
    await setOrganizationStatus(reg.data.user.org_id, 'active', platformUser.id, '');

    const platformSwitch = await call('POST', '/v1/auth/contexts/switch', { orgId: platformOrg.id, password: TARGET_PASSWORD }, token);
    assert.equal(platformSwitch.status, 409);
    assert.equal(platformSwitch.data.error, 'platform_context_login_required');

    await setOrganizationStatus(orgB.id, 'suspended', platformUser.id, 'context test suspension');
    const stale = await call('GET', '/v1/auth/me', undefined, switchedToken);
    assert.equal(stale.status, 403);
    assert.equal(stale.data.error, 'org_suspended');
    const login = await call('POST', '/v1/auth/login', { email: EMAIL, orgSlug: orgB.slug, password: PASSWORD });
    assert.equal(login.status, 403);
    assert.equal(login.data.error, 'org_suspended');
    await setOrganizationStatus(orgB.id, 'active', platformUser.id, '');
    } finally {
      if (previousSlug === undefined) delete process.env.PLATFORM_ORG_SLUG;
      else process.env.PLATFORM_ORG_SLUG = previousSlug;
      if (previousEnabled === undefined) delete process.env.PLATFORM_ADMIN_ENABLED;
      else process.env.PLATFORM_ADMIN_ENABLED = previousEnabled;
      if (previousMfa === undefined) delete process.env.PLATFORM_ADMIN_REQUIRE_MFA;
      else process.env.PLATFORM_ADMIN_REQUIRE_MFA = previousMfa;
    }
  });
});
