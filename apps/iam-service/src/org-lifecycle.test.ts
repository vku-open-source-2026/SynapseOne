// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Platform Organization lifecycle tests (in-memory IAM).
 * Covers the cross-organization resources view, platform-managed roles and
 * policies, API-key/service-account revocation, suspension enforcement and
 * reactivation. The reserved platform organization must never be suspendable.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createApp } from './index';
import { base32Decode, totp } from './mfa';
import { queryAudit, createOrganization, createAccount } from './db';

const BOOTSTRAP = 'lifecycle-bootstrap-secret';
const OWNER_PASSWORD = 'LifecycleOwner!2345';
const TENANT_PASSWORD = 'LifecycleTenant!2345';
const saved: Record<string, string | undefined> = {};

describe('platform organization lifecycle', () => {
  let base = '';
  let server: Server | null = null;
  let platformToken = '';
  let platformOrgId = '';
  let tenantOrgId = '';
  let tenantSlug = '';
  let tenantAdminId = '';
  let tenantToken = '';
  let accountId = '';
  let saId = '';
  let saToken = '';
  let secondSaToken = '';
  let tenantRoleId = '';
  let recoveryCodes: string[] = [];
  let stepIndex = 0;
  let otherAccountId = '';
  let secondSaId = '';

  const headers = (token?: string, extra: Record<string, string> = {}) => ({
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  });

  async function call(method: string, path: string, body?: any, token?: string, extra: Record<string, string> = {}) {
    const r = await fetch(base + path, {
      method,
      headers: headers(token, extra),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: r.status, json };
  }

  async function stepUp(action: string) {
    const recoveryCode = recoveryCodes[stepIndex++];
    assert.ok(recoveryCode, `no recovery code left for ${action}`);
    const r = await call('POST', '/v1/platform/step-up', { recoveryCode, action }, platformToken);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json.stepUpToken as string;
  }

  before(
    () =>
      new Promise<void>((resolve, reject) => {
        for (const k of ['NODE_ENV', 'DATABASE_URL', 'SYNAPSEONE_INTERNAL_SECRET', 'IAM_ALLOW_DEV_LOGIN',
          'PLATFORM_ADMIN_ENABLED', 'PLATFORM_ADMIN_REQUIRE_MFA', 'PLATFORM_ADMIN_REQUIRE_STEP_UP',
          'PLATFORM_BOOTSTRAP_SECRET', 'PLATFORM_ORG_SLUG', 'IAM_SENSITIVE_MUTATION_MODE']) {
          saved[k] = process.env[k];
        }
        delete process.env.NODE_ENV;
        delete process.env.DATABASE_URL;
        delete process.env.SYNAPSEONE_INTERNAL_SECRET;
        process.env.IAM_ALLOW_DEV_LOGIN = 'false';
        process.env.PLATFORM_ADMIN_ENABLED = 'true';
        process.env.PLATFORM_ADMIN_REQUIRE_MFA = 'true';
        process.env.PLATFORM_ADMIN_REQUIRE_STEP_UP = 'true';
        process.env.PLATFORM_BOOTSTRAP_SECRET = BOOTSTRAP;
        process.env.PLATFORM_ORG_SLUG = 'synapseone-platform';
        process.env.IAM_SENSITIVE_MUTATION_MODE = 'audit';
        const app = createApp();
        server = app.listen(0, '127.0.0.1', async () => {
          try {
            const a = server!.address();
            base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;

            const boot = await fetch(`${base}/internal/platform/bootstrap`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-platform-bootstrap-secret': BOOTSTRAP },
              body: JSON.stringify({ email: 'lifecycle-owner@test.local', displayName: 'Lifecycle Owner' }),
            });
            const bootJson: any = await boot.json();
            assert.equal(boot.status, 201, JSON.stringify(bootJson));
            platformOrgId = bootJson.organization.id;

            const accept = await call('POST', '/v1/auth/invite/accept', {
              token: bootJson.inviteToken,
              password: OWNER_PASSWORD,
              displayName: 'Lifecycle Owner',
            });
            assert.equal(accept.status, 201, JSON.stringify(accept.json));

            const login = await call('POST', '/v1/auth/login', {
              email: 'lifecycle-owner@test.local',
              password: OWNER_PASSWORD,
              orgSlug: 'synapseone-platform',
            });
            assert.equal(login.status, 200, JSON.stringify(login.json));
            const ownerToken = login.json.accessToken;

            const setup = await call('POST', '/v1/auth/mfa/totp/setup', {}, ownerToken);
            assert.equal(setup.status, 200, JSON.stringify(setup.json));
            const enable = await call('POST', '/v1/auth/mfa/totp/enable', {
              code: totp(base32Decode(setup.json.secret)),
            }, ownerToken);
            assert.equal(enable.status, 200, JSON.stringify(enable.json));
            recoveryCodes = enable.json.recoveryCodes;
            assert.equal(recoveryCodes.length, 10);

            const session = await call('POST', '/v1/platform/session', {
              recoveryCode: recoveryCodes[stepIndex++],
            }, ownerToken);
            assert.equal(session.status, 200, JSON.stringify(session.json));
            platformToken = session.json.accessToken;

            tenantSlug = `lifecycle-${Date.now()}`;
            const orgStep = await stepUp('org:create');
            const org = await call('POST', '/v1/platform/orgs', {
              slug: tenantSlug,
              displayName: 'Lifecycle Tenant',
              adminEmail: `lifecycle-admin-${tenantSlug}@test.local`,
              adminDisplayName: 'Lifecycle Admin',
              reason: 'lifecycle test',
            }, platformToken, { 'x-platform-step-up': orgStep });
            assert.equal(org.status, 201, JSON.stringify(org.json));
            tenantOrgId = org.json.organization.id;

            const tenantAccept = await call('POST', '/v1/auth/invite/accept', {
              token: org.json.inviteToken,
              password: TENANT_PASSWORD,
              displayName: 'Lifecycle Admin',
            });
            assert.equal(tenantAccept.status, 201, JSON.stringify(tenantAccept.json));
            const tenantLogin = await call('POST', '/v1/auth/login', {
              email: `lifecycle-admin-${tenantSlug}@test.local`,
              password: TENANT_PASSWORD,
              orgSlug: tenantSlug,
            });
            assert.equal(tenantLogin.status, 200, JSON.stringify(tenantLogin.json));
            tenantToken = tenantLogin.json.accessToken;
            tenantAdminId = tenantLogin.json.user.id;
            assert.equal(tenantLogin.json.user.org_id, tenantOrgId);

            const acc = await call('POST', `/v1/orgs/${tenantOrgId}/accounts`, {
              slug: 'production',
              displayName: 'Production',
            }, tenantToken);
            assert.equal(acc.status, 201, JSON.stringify(acc.json));
            accountId = acc.json.id;
            const duplicate = await call('POST', `/v1/orgs/${tenantOrgId}/accounts`, {
              slug: 'production',
              displayName: 'Production duplicate',
            }, tenantToken);
            assert.equal(duplicate.status, 409, JSON.stringify(duplicate.json));
            assert.equal(duplicate.json.error, 'conflict');

            // A second organization/account proves the cross-org guard without
            // spending another platform step-up.
            const otherOrg = await createOrganization(`lifecycle-other-${Date.now()}`, 'Lifecycle Other');
            otherAccountId = (await createAccount(otherOrg.id, 'production', 'Production')).id;
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

  it('exposes org resources and lets an operator role create roles/policies', async () => {
    const roleStep = await stepUp('org:role:create');
    const role = await call('POST', `/v1/platform/orgs/${tenantOrgId}/roles`, {
      accountId,
      slug: 'platform-managed',
      description: 'Created from platform administration',
    }, platformToken, { 'x-platform-step-up': roleStep });
    assert.equal(role.status, 201, JSON.stringify(role.json));
    tenantRoleId = role.json.id;

    const policyStep = await stepUp('org:policy:create');
    const policy = await call('POST', `/v1/platform/orgs/${tenantOrgId}/policies`, {
      accountId,
      slug: 'platform-readonly',
      description: 'Read-only policy',
      document: {
        Version: '2026-01-01',
        Statement: [{ Effect: 'Allow', Action: ['workflow:read'], Resource: ['*'] }],
      },
    }, platformToken, { 'x-platform-step-up': policyStep });
    assert.equal(policy.status, 201, JSON.stringify(policy.json));

    const detailUser = await call('GET', `/v1/platform/users/${tenantAdminId}`, undefined, platformToken);
    assert.equal(detailUser.status, 200, JSON.stringify(detailUser.json));
    assert.equal(detailUser.json.orgAdminCount, 1);

    // The last active org admin cannot be disabled (mirrors the org-admin
    // revoke guard). No step-up is consumed because this is denied first.
    const disableStep = await stepUp('user:disable');
    const lastDisable = await call('POST', `/v1/platform/users/${tenantAdminId}/disable`, {}, platformToken, { 'x-platform-step-up': disableStep });
    assert.equal(lastDisable.status, 409, JSON.stringify(lastDisable.json));
    assert.equal(lastDisable.json.error, 'last_admin');
    const stillActive = await call('GET', `/v1/platform/users/${tenantAdminId}`, undefined, platformToken);
    assert.equal(stillActive.status, 200, JSON.stringify(stillActive.json));
    assert.equal(stillActive.json.user.active, true);

    const resources = await call('GET', `/v1/platform/orgs/${tenantOrgId}/resources`, undefined, platformToken);
    assert.equal(resources.status, 200, JSON.stringify(resources.json));
    assert.equal(resources.json.organization.status, 'active');
    assert.equal(resources.json.accounts.length, 1);
    assert.equal(resources.json.users.length, 1);
    assert.equal(resources.json.users[0].id, tenantAdminId);
    assert.ok(resources.json.roles.some((r: any) => r.slug === 'platform-managed' && r.account_id === accountId));
    assert.ok(resources.json.policies.some((p: any) => p.slug === 'platform-readonly'));
    assert.equal(resources.json.counts.orgAdmins, 1);
    const serialized = JSON.stringify(resources.json);
    assert.ok(!serialized.includes('password_hash') && !serialized.includes('passwordHash'));

    // Cross-org account IDs are rejected before any step-up is consumed.
    const cross = await call('POST', `/v1/platform/orgs/${tenantOrgId}/roles`, {
      accountId: otherAccountId,
      slug: 'cross-org',
    }, platformToken);
    assert.equal(cross.status, 403);
    assert.equal(cross.json.error, 'cross_org');

    const audit = await queryAudit({ limit: 50, action: 'platform:org:role:create' });
    assert.ok(audit.some((e: any) => e.decision === true && e.context?.roleId === tenantRoleId));
  });

  it('revokes tenant API keys and service accounts through the platform plane', async () => {
    const key = await call('POST', `/v1/accounts/${accountId}/keys`, {
      name: 'lifecycle-key',
      scopes: ['*:read'],
    }, tenantToken);
    assert.equal(key.status, 201, JSON.stringify(key.json));
    const keyId = key.json.id;
    const apiKey = key.json.apiKey;

    const verifyBefore = await call('POST', '/v1/keys/verify', { apiKey });
    assert.equal(verifyBefore.status, 200, JSON.stringify(verifyBefore.json));
    assert.equal(verifyBefore.json.valid, true);
    const listed = await call('GET', `/v1/platform/orgs/${tenantOrgId}/resources`, undefined, platformToken);
    assert.equal(listed.status, 200);
    assert.ok(listed.json.keys.some((k: any) => k.id === keyId && k.name === 'lifecycle-key' && !k.revoked_at));

    const sa = await call('POST', `/v1/accounts/${accountId}/service-accounts`, {
      slug: 'lifecycle-sa',
      description: 'Lifecycle machine identity',
    }, tenantToken);
    assert.equal(sa.status, 201, JSON.stringify(sa.json));
    saId = sa.json.id;
    const mint = await call('POST', `/v1/service-accounts/${saId}/token`, {}, tenantToken);
    assert.equal(mint.status, 200, JSON.stringify(mint.json));
    saToken = mint.json.accessToken;
    const saBefore = await call('GET', '/v1/auth/verify', undefined, saToken);
    assert.equal(saBefore.status, 200, JSON.stringify(saBefore.json));

    const keyStep = await stepUp('org:key:revoke');
    const revokedKey = await call('POST', `/v1/platform/orgs/${tenantOrgId}/keys/${keyId}/revoke`, { reason: 'key compromise' }, platformToken, {
      'x-platform-step-up': keyStep,
    });
    assert.equal(revokedKey.status, 200, JSON.stringify(revokedKey.json));
    const verifyAfter = await call('POST', '/v1/keys/verify', { apiKey });
    assert.equal(verifyAfter.status, 401);

    const keyAgain = await call('POST', `/v1/platform/orgs/${tenantOrgId}/keys/${keyId}/revoke`, {}, platformToken);
    assert.equal(keyAgain.status, 409);
    assert.equal(keyAgain.json.error, 'key_already_revoked');

    const saStep = await stepUp('org:service-account:revoke');
    const revokedSa = await call('POST', `/v1/platform/orgs/${tenantOrgId}/service-accounts/${saId}/revoke`, {}, platformToken, {
      'x-platform-step-up': saStep,
    });
    assert.equal(revokedSa.status, 200, JSON.stringify(revokedSa.json));
    const saAfter = await call('GET', '/v1/auth/verify', undefined, saToken);
    assert.equal(saAfter.status, 403);
    assert.equal(saAfter.json.error, 'service_account_revoked');
    // A revoked service account cannot mint a fresh token either.
    const remint = await call('POST', `/v1/service-accounts/${saId}/token`, {}, tenantToken);
    assert.equal(remint.status, 403);
    assert.equal(remint.json.error, 'service_account_revoked');

    const saAgain = await call('POST', `/v1/platform/orgs/${tenantOrgId}/service-accounts/${saId}/revoke`, {}, platformToken);
    assert.equal(saAgain.status, 409);
    assert.equal(saAgain.json.error, 'service_account_already_revoked');
    const keyAudit = await queryAudit({ limit: 50, action: 'platform:org:key:revoke' });
    assert.ok(keyAudit.some((e: any) => e.decision === true && e.context?.reason === 'key compromise'));

    // Keep a live machine identity for the suspension assertions.
    const sa2 = await call('POST', `/v1/accounts/${accountId}/service-accounts`, { slug: 'lifecycle-sa-2' }, tenantToken);
    assert.equal(sa2.status, 201, JSON.stringify(sa2.json));
    secondSaId = sa2.json.id;
    const mint2 = await call('POST', `/v1/service-accounts/${secondSaId}/token`, {}, tenantToken);
    assert.equal(mint2.status, 200, JSON.stringify(mint2.json));
    secondSaToken = mint2.json.accessToken;
    assert.equal((await call('GET', '/v1/auth/verify', undefined, secondSaToken)).status, 200);
  });

  it('suspends, blocks tenant access and reactivates without touching the platform org', async () => {
    const reserved = await call('POST', `/v1/platform/orgs/${platformOrgId}/suspend`, { reason: 'must never happen' }, platformToken);
    assert.equal(reserved.status, 403);
    assert.equal(reserved.json.error, 'platform_org_protected');

    const suspendStep = await stepUp('org:suspend');
    const suspended = await call('POST', `/v1/platform/orgs/${tenantOrgId}/suspend`, {
      reason: 'Lifecycle suspension test',
    }, platformToken, { 'x-platform-step-up': suspendStep });
    assert.equal(suspended.status, 200, JSON.stringify(suspended.json));
    assert.equal(suspended.json.organization.status, 'suspended');
    assert.equal(suspended.json.organization.suspend_reason, 'Lifecycle suspension test');

    // Suspension bumps auth_version, so pre-suspension access tokens are
    // revoked outright (not merely blocked while the org stays suspended).
    const me = await call('GET', '/v1/auth/me', undefined, tenantToken);
    assert.equal(me.status, 401);
    assert.equal(me.json.error, 'token_revoked');
    const contexts = await call('GET', '/v1/auth/contexts', undefined, tenantToken);
    assert.equal(contexts.status, 401);
    assert.equal(contexts.json.error, 'token_revoked');
    const login = await call('POST', '/v1/auth/login', {
      email: `lifecycle-admin-${tenantSlug}@test.local`,
      password: TENANT_PASSWORD,
      orgSlug: tenantSlug,
    });
    assert.equal(login.status, 403);
    assert.equal(login.json.error, 'org_suspended');
    const saVerify = await call('GET', '/v1/auth/verify', undefined, secondSaToken);
    assert.equal(saVerify.status, 403);
    assert.equal(saVerify.json.error, 'org_suspended');

    // Suspension revokes every refresh token/API key and bumps auth_version.
    const resources = await call('GET', `/v1/platform/orgs/${tenantOrgId}/resources`, undefined, platformToken);
    assert.equal(resources.status, 200);
    assert.equal(resources.json.organization.status, 'suspended');
    assert.ok(resources.json.keys.every((k: any) => k.revoked_at));
    assert.equal(resources.json.serviceAccounts.find((s: any) => s.id === secondSaId).revoked_at, null);

    const reactivateStep = await stepUp('org:reactivate');
    const reactivated = await call('POST', `/v1/platform/orgs/${tenantOrgId}/reactivate`, {}, platformToken, {
      'x-platform-step-up': reactivateStep,
    });
    assert.equal(reactivated.status, 200, JSON.stringify(reactivated.json));
    assert.equal(reactivated.json.organization.status, 'active');

    const oldToken = await call('GET', '/v1/auth/me', undefined, tenantToken);
    assert.equal(oldToken.status, 401);
    assert.equal(oldToken.json.error, 'token_revoked');
    const loginAgain = await call('POST', '/v1/auth/login', {
      email: `lifecycle-admin-${tenantSlug}@test.local`,
      password: TENANT_PASSWORD,
      orgSlug: tenantSlug,
    });
    assert.equal(loginAgain.status, 200, JSON.stringify(loginAgain.json));
    const meAgain = await call('GET', '/v1/auth/me', undefined, loginAgain.json.accessToken);
    assert.equal(meAgain.status, 200);

    const audit = await queryAudit({ limit: 50, action: 'platform:org:suspend' });
    assert.ok(audit.some((e: any) => e.decision === true && e.context?.reason === 'Lifecycle suspension test'));
    const reactivateAudit = await queryAudit({ limit: 50, action: 'platform:org:reactivate' });
    assert.ok(reactivateAudit.length > 0);
  });
});
