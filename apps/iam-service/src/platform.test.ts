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
import { queryAudit } from './db';

const BOOTSTRAP = 'bootstrap-test-secret';
const saved: Record<string, string | undefined> = {};

describe('platform super admin', () => {
  let base = '';
  let server: Server | null = null;
  let platformToken = '';
  let normalToken = '';
  let platformUserId = '';
  let platformSecret = '';
  let platformRecoveryCode = '';
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
          'PLATFORM_ADMIN_ENABLED', 'PLATFORM_ADMIN_REQUIRE_MFA', 'PLATFORM_BOOTSTRAP_SECRET', 'PLATFORM_ORG_SLUG']) {
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
            const login = await call('POST', '/v1/auth/login', { email: 'platform-owner@test.local', orgSlug: 'synapseone-platform' });
            assert.equal(login.status, 200);
            normalToken = login.json.accessToken;
            const setup = await call('POST', '/v1/auth/mfa/totp/setup', {}, normalToken);
            assert.equal(setup.status, 200);
            platformSecret = setup.json.secret;
            const enable = await call('POST', '/v1/auth/mfa/totp/enable', { code: totp(base32Decode(setup.json.secret)) }, normalToken);
            assert.equal(enable.status, 200);
            platformRecoveryCode = enable.json.recoveryCodes[0];
            const session = await call('POST', '/v1/platform/session', { recoveryCode: platformRecoveryCode }, normalToken);
            assert.equal(session.status, 200, JSON.stringify(session.json));
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

  it('creates a tenant organization with a first admin', async () => {
    const slug = `tenant-${Date.now()}`;
    const created = await call('POST', '/v1/platform/orgs', {
      slug,
      displayName: 'Tenant Co',
      adminEmail: `admin-${slug}@test.local`,
      adminDisplayName: 'Tenant Admin',
    }, platformToken);
    assert.equal(created.status, 201, JSON.stringify(created.json));
    tenantOrgId = created.json.organization.id;
    tenantUserId = created.json.admin.id;
    assert.equal(created.json.admin.is_org_admin, true);

    const orgs = await call('GET', `/v1/platform/orgs?q=${encodeURIComponent(slug)}`, undefined, platformToken);
    assert.equal(orgs.status, 200);
    assert.equal(orgs.json.items.length, 1);
    assert.equal(orgs.json.items[0].counts.orgAdmins, 1);

    const detail = await call('GET', `/v1/platform/orgs/${tenantOrgId}`, undefined, platformToken);
    assert.equal(detail.status, 200);
    assert.equal(detail.json.organization.slug, slug);
  });

  it('searches users and requires step-up for sensitive actions', async () => {
    const users = await call('GET', `/v1/platform/users?orgId=${tenantOrgId}`, undefined, platformToken);
    assert.equal(users.status, 200);
    assert.equal(users.json.items.length, 1);
    assert.equal(users.json.items[0].id, tenantUserId);

    const noStep = await call('PUT', `/v1/platform/users/${tenantUserId}/org-admin`, { isOrgAdmin: false, reason: 'test' }, platformToken);
    assert.equal(noStep.status, 403);
    assert.equal(noStep.json.error, 'platform_step_up_required');

    const invalid = await call('POST', '/v1/platform/step-up', { code: '000000' }, platformToken);
    assert.equal(invalid.status, 401);

    const nextCode = totp(base32Decode(platformSecret), Date.now() + 30_000);
    const step = await call('POST', '/v1/platform/step-up', { code: nextCode }, platformToken);
    assert.equal(step.status, 200, JSON.stringify(step.json));
    stepUpToken = step.json.stepUpToken;
    assert.ok(stepUpToken);

    const reset = await call('POST', `/v1/platform/users/${tenantUserId}/reset-mfa`, {}, platformToken, {
      'x-platform-step-up': stepUpToken,
    });
    assert.equal(reset.status, 200, JSON.stringify(reset.json));
  });

  it('lists platform administrators and protects the last owner', async () => {
    const admins = await call('GET', '/v1/platform/admins', undefined, platformToken);
    assert.equal(admins.status, 200);
    assert.ok(admins.json.items.some((a: any) => a.user_id === platformUserId && a.role === 'owner'));
    const revoke = await call('DELETE', `/v1/platform/admins/${platformUserId}`, undefined, platformToken);
    assert.equal(revoke.status, 409);
    assert.equal(revoke.json.error, 'last_owner');
  });
});
