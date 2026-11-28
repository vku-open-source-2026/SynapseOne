// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Global MFA kill-switch integration tests. Enrolments stay persisted while
 * password/OIDC/context sign-in and platform administration stop requiring MFA.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createApp } from './index';
import { beginTotpEnrolment, enableTotp } from './mfa';
import {
  bumpAuthVersion, createOrganization, grantPlatformAdmin, markEmailVerified,
  queryAudit, setUserPassword, upsertUser,
} from './db';
import { hashPassword } from './passwords';
import { signPlatformAccess } from './tokens';

const PASSWORD = 'global-mfa-kill-switch-password';
const TARGET_PASSWORD = 'context-target-kill-switch-password';
const PLATFORM_PASSWORD = 'platform-kill-switch-password';
const savedEnv: Record<string, string | undefined> = {};
const envKeys = [
  'NODE_ENV', 'DATABASE_URL', 'SYNAPSEONE_INTERNAL_SECRET', 'IAM_ALLOW_DEV_LOGIN',
  'IAM_LOGIN_MAX_FAILURES', 'PLATFORM_ADMIN_ENABLED', 'PLATFORM_ADMIN_REQUIRE_MFA',
  'PLATFORM_ADMIN_REQUIRE_STEP_UP', 'PLATFORM_ORG_SLUG', 'SYNAPSEONE_MFA_ENABLED',
];

let base = '';
let server: Server | null = null;
let tenantToken = '';
let tenantUserId = '';
let tenantOrgId = '';
let tenantEmail = '';
let tenantOrgSlug = '';
let targetOrgId = '';
let platformOrgId = '';
let platformUserId = '';
let platformEmail = '';
let platformOrgSlug = '';

async function call(method: string, path: string, body?: any, token?: string, extra: Record<string, string> = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, data, headers: response.headers };
}

async function withMfaDisabled<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.SYNAPSEONE_MFA_ENABLED;
  process.env.SYNAPSEONE_MFA_ENABLED = 'false';
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.SYNAPSEONE_MFA_ENABLED;
    else process.env.SYNAPSEONE_MFA_ENABLED = previous;
  }
}

describe('global MFA kill switch', () => {
  before(async () => {
    for (const key of envKeys) savedEnv[key] = process.env[key];
    delete process.env.NODE_ENV;
    delete process.env.DATABASE_URL;
    delete process.env.SYNAPSEONE_INTERNAL_SECRET;
    process.env.SYNAPSEONE_MFA_ENABLED = 'true';
    process.env.IAM_ALLOW_DEV_LOGIN = 'false';
    process.env.IAM_LOGIN_MAX_FAILURES = '5';
    process.env.PLATFORM_ADMIN_ENABLED = 'true';
    process.env.PLATFORM_ADMIN_REQUIRE_MFA = 'true';
    process.env.PLATFORM_ADMIN_REQUIRE_STEP_UP = 'true';
    platformOrgSlug = `mfa-disabled-platform-${Date.now()}`;
    process.env.PLATFORM_ORG_SLUG = platformOrgSlug;

    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server!.once('listening', () => resolve()));
    const address = server!.address();
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

    const suffix = `${Date.now()}`;
    tenantEmail = `mfa-disabled-${suffix}@example.test`;
    tenantOrgSlug = `mfa-disabled-${suffix}`;
    const registered = await call('POST', '/v1/auth/register', { email: tenantEmail, password: PASSWORD, orgSlug: tenantOrgSlug });
    assert.equal(registered.status, 201, JSON.stringify(registered.data));
    tenantToken = registered.data.accessToken;
    tenantUserId = registered.data.user.id;
    tenantOrgId = registered.data.user.org_id;
    await markEmailVerified(tenantUserId);
    const tenantEnrolment = await beginTotpEnrolment(tenantUserId);
    assert.ok(tenantEnrolment);
    await enableTotp(tenantUserId);

    const targetOrg = await createOrganization(`mfa-disabled-target-${suffix}`, 'MFA Disabled Target');
    targetOrgId = targetOrg.id;
    const targetUser = await upsertUser(targetOrg.id, tenantEmail, 'Context Target');
    await setUserPassword(targetUser.id, await hashPassword(TARGET_PASSWORD));
    const targetEnrolment = await beginTotpEnrolment(targetUser.id);
    assert.ok(targetEnrolment);
    await enableTotp(targetUser.id);

    const platformOrg = await createOrganization(platformOrgSlug, 'MFA Disabled Platform', 'platform');
    platformOrgId = platformOrg.id;
    platformEmail = `platform-mfa-disabled-${suffix}@example.test`;
    const platformUser = await upsertUser(platformOrg.id, platformEmail, 'Platform Owner');
    platformUserId = platformUser.id;
    await setUserPassword(platformUser.id, await hashPassword(PLATFORM_PASSWORD));
    await grantPlatformAdmin({ userId: platformUser.id, role: 'owner', grantedBy: platformUser.id, reason: 'kill-switch test' });
    const platformEnrolment = await beginTotpEnrolment(platformUser.id);
    assert.ok(platformEnrolment);
    await enableTotp(platformUser.id);
  });

  after(() => new Promise<void>((resolve) => {
    server!.close(() => {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      resolve();
    });
  }));

  it('keeps password lockout while allowing an enrolled user to sign in without a challenge', async () => {
    await withMfaDisabled(async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const failed = await call('POST', '/v1/auth/login', {
          email: tenantEmail, password: 'wrong-password-123', orgSlug: tenantOrgSlug,
        });
        assert.equal(failed.status, 401);
        assert.equal(failed.data.error, 'invalid_credentials');
      }
      const locked = await call('POST', '/v1/auth/login', { email: tenantEmail, password: PASSWORD, orgSlug: tenantOrgSlug });
      assert.equal(locked.status, 429);
      assert.equal(locked.data.error, 'account_locked');
      assert.ok(Number(locked.headers.get('retry-after')) > 0);

      const unlocked = await call('POST', `/v1/users/${tenantUserId}/unlock`, {}, tenantToken);
      assert.equal(unlocked.status, 200, JSON.stringify(unlocked.data));
      const login = await call('POST', '/v1/auth/login', { email: tenantEmail, password: PASSWORD, orgSlug: tenantOrgSlug });
      assert.equal(login.status, 200, JSON.stringify(login.data));
      assert.ok(login.data.accessToken);
      assert.equal(login.data.user.id, tenantUserId);
      assert.equal(login.data.user.org_id, tenantOrgId);
      assert.equal(login.data.mfaToken, undefined);
      assert.equal(login.data.error, undefined);

      const audit = await queryAudit({ limit: 20, action: 'iam:auth:login' });
      assert.ok(audit.some((entry: any) => entry.actor_id === tenantUserId && entry.decision === true && entry.context?.method === 'password'));
    });
  });

  it('allows an enrolled user through dev login without a challenge when MFA is disabled', async () => {
    await withMfaDisabled(async () => {
      const previousDevLogin = process.env.IAM_ALLOW_DEV_LOGIN;
      process.env.IAM_ALLOW_DEV_LOGIN = 'true';
      try {
        const login = await call('POST', '/v1/auth/login', { email: tenantEmail, orgSlug: tenantOrgSlug });
        assert.equal(login.status, 200, JSON.stringify(login.data));
        assert.ok(login.data.accessToken);
        assert.equal(login.data.user.id, tenantUserId);
        assert.equal(login.data.mfaToken, undefined);
      } finally {
        if (previousDevLogin === undefined) delete process.env.IAM_ALLOW_DEV_LOGIN;
        else process.env.IAM_ALLOW_DEV_LOGIN = previousDevLogin;
      }
    });
  });

  it('switches to an enrolled target context without a challenge but still requires its password', async () => {
    await withMfaDisabled(async () => {
      const wrongPassword = await call('POST', '/v1/auth/contexts/switch', { orgId: targetOrgId, password: 'wrong-password-123' }, tenantToken);
      assert.equal(wrongPassword.status, 401);
      assert.equal(wrongPassword.data.error, 'invalid_credentials');
      assert.equal(wrongPassword.data.accessToken, undefined);

      const switched = await call('POST', '/v1/auth/contexts/switch', { orgId: targetOrgId, password: TARGET_PASSWORD }, tenantToken);
      assert.equal(switched.status, 200, JSON.stringify(switched.data));
      assert.ok(switched.data.accessToken);
      assert.equal(switched.data.user.org_id, targetOrgId);
      assert.equal(switched.data.mfaToken, undefined);
    });
  });

  it('reports MFA unavailable, rejects every MFA endpoint, and retains enrolment for re-enable', async () => {
    await withMfaDisabled(async () => {
      const status = await call('GET', '/v1/auth/mfa', undefined, tenantToken);
      assert.equal(status.status, 200);
      assert.equal(status.data.enabled, false);
      assert.equal(status.data.available, false);
      assert.equal(status.data.pending, false);
      assert.deepEqual(status.data.methods, []);
      assert.equal(status.data.recoveryCodesRemaining, 0);
      assert.equal(status.data.enabledAt, null);

      const endpoints: Array<[string, string, any]> = [
        ['POST', '/v1/auth/mfa/verify', { mfaToken: 'not-a-challenge', code: '000000' }],
        ['POST', '/v1/auth/mfa/totp/setup', {}],
        ['POST', '/v1/auth/mfa/totp/enable', { code: '000000' }],
        ['POST', '/v1/auth/mfa/recovery-codes', { code: '000000' }],
        ['POST', '/v1/auth/mfa/disable', { code: '000000' }],
      ];
      for (const [method, path, body] of endpoints) {
        const denied = await call(method, path, body, tenantToken);
        assert.equal(denied.status, 403, path);
        assert.equal(denied.data.error, 'mfa_disabled', path);
      }

      // Turning the feature back on restores the existing enrolment; disabling
      // it must not delete factors or recovery material.
      process.env.SYNAPSEONE_MFA_ENABLED = 'true';
      const restored = await call('GET', '/v1/auth/mfa', undefined, tenantToken);
      assert.equal(restored.status, 200);
      assert.equal(restored.data.enabled, true);
      assert.equal(restored.data.available, true);
      assert.equal(restored.data.recoveryCodesRemaining, 10);
      const challenged = await call('POST', '/v1/auth/login', { email: tenantEmail, password: PASSWORD, orgSlug: tenantOrgSlug });
      assert.equal(challenged.status, 401);
      assert.equal(challenged.data.error, 'mfa_required');
    });
  });

  it('exchanges and audits platform mutations without MFA or step-up while preserving session revocation', async () => {
    await withMfaDisabled(async () => {
      const login = await call('POST', '/v1/auth/login', { email: platformEmail, password: PLATFORM_PASSWORD, orgSlug: platformOrgSlug });
      assert.equal(login.status, 200, JSON.stringify(login.data));
      assert.ok(login.data.accessToken);
      assert.equal(login.data.mfaToken, undefined);

      const exchanged = await call('POST', '/v1/platform/session', {}, login.data.accessToken);
      assert.equal(exchanged.status, 200, JSON.stringify(exchanged.data));
      assert.ok(exchanged.data.accessToken);
      assert.equal(exchanged.data.mfaRequired, false);
      assert.equal(exchanged.data.stepUpRequired, false);
      assert.equal(exchanged.data.mfa.enabled, false);
      assert.equal(exchanged.data.mfa.available, false);
      assert.equal(exchanged.data.user.org_id, platformOrgId);

      const me = await call('GET', '/v1/platform/me', undefined, exchanged.data.accessToken);
      assert.equal(me.status, 200, JSON.stringify(me.data));
      assert.equal(me.data.mfaRequired, false);
      assert.equal(me.data.stepUpRequired, false);
      assert.equal(me.data.mfa.enabled, false);

      // Disabling MFA removes proof requirements, not platform RBAC or the
      // binding between platform privileges and the platform-org user row.
      const auditor = await upsertUser(platformOrgId, `auditor-${Date.now()}@example.test`, 'Platform Auditor');
      await grantPlatformAdmin({ userId: auditor.id, role: 'auditor', grantedBy: platformUserId, reason: 'kill-switch role boundary' });
      const auditorToken = signPlatformAccess({ userId: auditor.id, role: 'auditor', ver: Number(auditor.auth_version) || 0 }).token;
      assert.equal((await call('GET', '/v1/platform/overview', undefined, auditorToken)).status, 200);
      const auditorDenied = await call('POST', '/v1/platform/orgs', {
        slug: `auditor-denied-${Date.now()}`,
        displayName: 'Auditor Denied',
        adminEmail: `auditor-denied-${Date.now()}@example.test`,
      }, auditorToken);
      assert.equal(auditorDenied.status, 403);
      assert.equal(auditorDenied.data.error, 'platform_role_required');
      const tenantDenied = await call('GET', '/v1/platform/me', undefined, tenantToken);
      assert.equal(tenantDenied.status, 403);
      assert.equal(tenantDenied.data.error, 'platform_admin_required');

      const stepUp = await call('POST', '/v1/platform/step-up', { code: '000000', action: 'org:create' }, exchanged.data.accessToken);
      assert.equal(stepUp.status, 403);
      assert.equal(stepUp.data.error, 'mfa_disabled');

      const slug = `kill-switch-tenant-${Date.now()}`;
      const created = await call('POST', '/v1/platform/orgs', {
        slug,
        displayName: 'Kill Switch Tenant',
        adminEmail: `admin-${slug}@example.test`,
        reason: 'global MFA disabled',
      }, exchanged.data.accessToken);
      assert.equal(created.status, 201, JSON.stringify(created.data));
      assert.equal(created.data.organization.slug, slug);
      const audit = await queryAudit({ limit: 20, action: 'platform:org:create' });
      assert.ok(audit.some((entry: any) => entry.actor_id === platformUserId && entry.decision === true && entry.context?.slug === slug));

      await bumpAuthVersion(platformUserId);
      const revokedIdentity = await call('GET', '/v1/auth/me', undefined, login.data.accessToken);
      assert.equal(revokedIdentity.status, 401);
      assert.equal(revokedIdentity.data.error, 'token_revoked');
      const revokedPlatform = await call('GET', '/v1/platform/me', undefined, exchanged.data.accessToken);
      assert.equal(revokedPlatform.status, 401);
      assert.equal(revokedPlatform.data.error, 'token_revoked');
    });
  });
});
