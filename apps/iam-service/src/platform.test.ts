// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Platform Super Admin control-plane tests (in-memory IAM).
 * Covers bootstrap, MFA-gated session exchange, cross-tenant reads, org creation,
 * step-up-protected actions and last-owner protection.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createApp } from './index';
import { base32Decode, totp } from './mfa';
import { queryAudit, grantPlatformAdmin, revokePlatformAdmin } from './db';
import { signPlatformAccess } from './tokens';

const BOOTSTRAP = 'bootstrap-test-secret';
const saved: Record<string, string | undefined> = {};

describe('platform super admin', () => {
  let base = '';
  let server: Server | null = null;
  let platformToken = '';
  let normalToken = '';
  let platformUserId = '';
  let platformSecret = '';
  let platformRecoveryCodes: string[] = [];
  let stepUpToken = '';
  let tenantOrgId = '';
  let tenantUserId = '';

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

  before(
    () =>
      new Promise<void>((resolve, reject) => {
        for (const k of ['NODE_ENV', 'DATABASE_URL', 'SYNAPSEONE_INTERNAL_SECRET', 'IAM_ALLOW_DEV_LOGIN',
          'PLATFORM_ADMIN_ENABLED', 'PLATFORM_ADMIN_REQUIRE_MFA', 'PLATFORM_BOOTSTRAP_SECRET', 'PLATFORM_ORG_SLUG',
          'PLATFORM_SESSION_TTL_SECONDS']) {
          saved[k] = process.env[k];
        }
        delete process.env.NODE_ENV;
        delete process.env.DATABASE_URL;
        delete process.env.SYNAPSEONE_INTERNAL_SECRET;
        process.env.IAM_ALLOW_DEV_LOGIN = 'true';
        process.env.PLATFORM_ADMIN_ENABLED = 'true';
        process.env.PLATFORM_ADMIN_REQUIRE_MFA = 'true';
        process.env.PLATFORM_BOOTSTRAP_SECRET = BOOTSTRAP;
        process.env.PLATFORM_ORG_SLUG = 'synapseone-platform';
        process.env.PLATFORM_SESSION_TTL_SECONDS = '604800';
        const app = createApp();
        server = app.listen(0, '127.0.0.1', async () => {
          try {
            const a = server!.address();
            base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
            const boot = await fetch(`${base}/internal/platform/bootstrap`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-platform-bootstrap-secret': BOOTSTRAP },
              body: JSON.stringify({ email: 'platform-owner@test.local', displayName: 'Platform Owner' }),
            });
            const bootText = await boot.text();
            assert.equal(boot.status, 201, bootText);
            const bootJson: any = JSON.parse(bootText);
            platformUserId = bootJson.user.id;
            assert.equal(typeof bootJson.inviteToken, 'string');
            const accept = await call('POST', '/v1/auth/invite/accept', {
              token: bootJson.inviteToken,
              password: 'PlatformOwnerTest!2345',
              displayName: 'Platform Owner',
            });
            assert.equal(accept.status, 201, JSON.stringify(accept.json));
            const replayInvite = await call('POST', '/v1/auth/invite/accept', {
              token: bootJson.inviteToken,
              password: 'PlatformOwnerTest!2345',
            });
            assert.equal(replayInvite.status, 400);
            const login = await call('POST', '/v1/auth/login', {
              email: 'platform-owner@test.local',
              password: 'PlatformOwnerTest!2345',
              orgSlug: 'synapseone-platform',
            });
            assert.equal(login.status, 200);
            normalToken = login.json.accessToken;
            const setup = await call('POST', '/v1/auth/mfa/totp/setup', {}, normalToken);
            assert.equal(setup.status, 200);
            platformSecret = setup.json.secret;
            const enable = await call('POST', '/v1/auth/mfa/totp/enable', { code: totp(base32Decode(setup.json.secret)) }, normalToken);
            assert.equal(enable.status, 200);
            platformRecoveryCodes = enable.json.recoveryCodes;
            assert.equal(platformRecoveryCodes.length, 10);

            // Sign in again with a fresh TOTP: the platform exchange can reuse
            // that signed MFA proof without asking for a second code in a row.
            const loginWithMfa = await call('POST', '/v1/auth/login', {
              email: 'platform-owner@test.local',
              password: 'PlatformOwnerTest!2345',
              orgSlug: 'synapseone-platform',
            });
            assert.equal(loginWithMfa.status, 401);
            assert.equal(loginWithMfa.json.error, 'mfa_required');
            const verified = await call('POST', '/v1/auth/mfa/verify', {
              mfaToken: loginWithMfa.json.mfaToken,
              recoveryCode: platformRecoveryCodes[8],
            });
            assert.equal(verified.status, 200, JSON.stringify(verified.json));
            const noSecondOtp = await call('POST', '/v1/platform/session', {}, verified.json.accessToken);
            assert.equal(noSecondOtp.status, 200, JSON.stringify(noSecondOtp.json));
            assert.equal(noSecondOtp.json.expiresIn, 604800);
            assert.equal(noSecondOtp.json.role, 'owner');

            const session = await call('POST', '/v1/platform/session', { recoveryCode: platformRecoveryCodes[0] }, normalToken);
            assert.equal(session.status, 200, JSON.stringify(session.json));
            assert.equal(session.json.expiresIn, 604800);
            platformToken = session.json.accessToken;
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

  it('rejects platform routes for tenant users and audits the session denial', async () => {
    const tenant = await call('POST', '/v1/auth/login', { email: 'tenant@test.local', orgSlug: 'tenantorg' });
    assert.equal(tenant.status, 200);
    const r = await call('GET', '/v1/platform/me', undefined, tenant.json.accessToken);
    assert.equal(r.status, 403);
    assert.equal(r.json.error, 'platform_admin_required');

    const exchange = await call('POST', '/v1/platform/session', { code: '000000' }, tenant.json.accessToken);
    assert.equal(exchange.status, 403);
    assert.equal(exchange.json.error, 'platform_admin_required');
    const rows = await queryAudit({ limit: 20, action: 'platform:session:exchange' });
    assert.ok(rows.some((a: any) => a.decision === false && a.context?.reason === 'not_platform_admin'));
  });

  it('returns the platform profile and overview', async () => {
    const me = await call('GET', '/v1/platform/me', undefined, platformToken);
    assert.equal(me.status, 200);
    assert.equal(me.json.role, 'owner');
    const overview = await call('GET', '/v1/platform/overview', undefined, platformToken);
    assert.equal(overview.status, 200);
    assert.equal(typeof overview.json.tenancy.organizations, 'number');
    assert.equal(typeof overview.json.usage.requests, 'number');
  });

  it('creates a tenant organization with a first admin and a one-time invite', async () => {
    const slug = `tenant-${Date.now()}`;
    const step = await call('POST', '/v1/platform/step-up', {
      recoveryCode: platformRecoveryCodes[4],
      action: 'org:create',
    }, platformToken);
    assert.equal(step.status, 200, JSON.stringify(step.json));
    const created = await call('POST', '/v1/platform/orgs', {
      slug,
      displayName: 'Tenant Co',
      adminEmail: `admin-${slug}@test.local`,
      adminDisplayName: 'Tenant Admin',
    }, platformToken, { 'x-platform-step-up': step.json.stepUpToken });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    tenantOrgId = created.json.organization.id;
    tenantUserId = created.json.admin.id;
    assert.equal(created.json.admin.is_org_admin, true);
    assert.equal(typeof created.json.inviteToken, 'string');

    const orgs = await call('GET', `/v1/platform/orgs?q=${encodeURIComponent(slug)}`, undefined, platformToken);
    assert.equal(orgs.status, 200);
    assert.equal(orgs.json.items.length, 1);
    assert.equal(orgs.json.items[0].counts.orgAdmins, 1);

    const detail = await call('GET', `/v1/platform/orgs/${tenantOrgId}`, undefined, platformToken);
    assert.equal(detail.status, 200);
    assert.equal(detail.json.organization.slug, slug);
  });

  it('creates a tenant account with step-up', async () => {
    const step = await call('POST', '/v1/platform/step-up', {
      recoveryCode: platformRecoveryCodes[5],
      action: 'org:account:create',
    }, platformToken);
    assert.equal(step.status, 200, JSON.stringify(step.json));
    const account = await call('POST', `/v1/platform/orgs/${tenantOrgId}/accounts`, {
      slug: 'production',
      displayName: 'Production',
      reason: 'test',
    }, platformToken, { 'x-platform-step-up': step.json.stepUpToken });
    assert.equal(account.status, 201, JSON.stringify(account.json));
    assert.equal(account.json.slug, 'production');
    const detail = await call('GET', `/v1/platform/orgs/${tenantOrgId}`, undefined, platformToken);
    assert.equal(detail.json.counts.accounts, 1);
  });

  it('rejects a platform row whose user belongs to a tenant organization', async () => {
    if (!tenantUserId) return; // tenant user is created by the next test
    const badAdmin = await grantPlatformAdmin({ userId: tenantUserId, role: 'operator', reason: 'test' });
    const token = signPlatformAccess({ userId: tenantUserId, role: badAdmin.role });
    const r = await call('GET', '/v1/platform/me', undefined, token.token);
    assert.equal(r.status, 403);
    assert.equal(r.json.error, 'platform_admin_org_required');
    await revokePlatformAdmin(tenantUserId);
  });

  it('searches users and requires step-up for sensitive actions', async () => {
    const users = await call('GET', `/v1/platform/users?orgId=${tenantOrgId}`, undefined, platformToken);
    assert.equal(users.status, 200);
    assert.equal(users.json.items.length, 1);
    assert.equal(users.json.items[0].id, tenantUserId);

    const noStep = await call('PUT', `/v1/platform/users/${tenantUserId}/org-admin`, { isOrgAdmin: false, reason: 'test' }, platformToken);
    assert.equal(noStep.status, 403);
    assert.equal(noStep.json.error, 'platform_step_up_required');

    const invalid = await call('POST', '/v1/platform/step-up', { code: '000000', action: 'user:reset-mfa' }, platformToken);
    assert.equal(invalid.status, 401);
    const badAction = await call('POST', '/v1/platform/step-up', { recoveryCode: platformRecoveryCodes[5], action: 'not:allowed' }, platformToken);
    assert.equal(badAction.status, 400);

    const step = await call('POST', '/v1/platform/step-up', {
      recoveryCode: platformRecoveryCodes[1],
      action: 'user:reset-mfa',
    }, platformToken);
    assert.equal(step.status, 200, JSON.stringify(step.json));
    stepUpToken = step.json.stepUpToken;
    assert.ok(stepUpToken);

    const reset = await call('POST', `/v1/platform/users/${tenantUserId}/reset-mfa`, {}, platformToken, {
      'x-platform-step-up': stepUpToken,
    });
    assert.equal(reset.status, 200, JSON.stringify(reset.json));

    const replay = await call('POST', `/v1/platform/users/${tenantUserId}/reset-mfa`, {}, platformToken, {
      'x-platform-step-up': stepUpToken,
    });
    assert.equal(replay.status, 403);
    assert.equal(replay.json.error, 'platform_step_up_required');

    // A proof minted for one action cannot authorize another action.
    const mismatched = await call('POST', '/v1/platform/step-up', {
      recoveryCode: platformRecoveryCodes[2],
      action: 'user:reset-mfa',
    }, platformToken);
    assert.equal(mismatched.status, 200, JSON.stringify(mismatched.json));
    const disableWithMismatch = await call('POST', `/v1/platform/users/${tenantUserId}/disable`, {}, platformToken, {
      'x-platform-step-up': mismatched.json.stepUpToken,
    });
    assert.equal(disableWithMismatch.status, 403);
    assert.equal(disableWithMismatch.json.error, 'platform_step_up_required');
  });

  it('lists platform administrators and protects the last owner from demotion or revocation', async () => {
    const admins = await call('GET', '/v1/platform/admins', undefined, platformToken);
    assert.equal(admins.status, 200);
    assert.ok(admins.json.items.some((a: any) => a.user_id === platformUserId && a.role === 'owner'));

    const revoke = await call('DELETE', `/v1/platform/admins/${platformUserId}`, undefined, platformToken);
    assert.equal(revoke.status, 409);
    assert.equal(revoke.json.error, 'last_owner');

    const step = await call('POST', '/v1/platform/step-up', {
      recoveryCode: platformRecoveryCodes[3],
      action: 'admin:grant',
    }, platformToken);
    assert.equal(step.status, 200, JSON.stringify(step.json));
    const demote = await call('POST', '/v1/platform/admins', {
      email: 'platform-owner@test.local',
      role: 'auditor',
      reason: 'test demotion guard',
    }, platformToken, { 'x-platform-step-up': step.json.stepUpToken });
    assert.equal(demote.status, 409, JSON.stringify(demote.json));
    assert.equal(demote.json.error, 'last_owner');
  });
});
