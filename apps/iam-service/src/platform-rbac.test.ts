// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Platform RBAC regression matrix: owner/operator/auditor boundaries and
 * immediate revocation. Runs against the in-memory IAM app.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createApp } from './index';
import { base32Decode, totp } from './mfa';
import { getOrgBySlug, grantPlatformAdmin, revokePlatformAdmin, upsertUser } from './db';
import { signPlatformAccess } from './tokens';

const BOOTSTRAP = 'rbac-bootstrap-secret';
const saved: Record<string, string | undefined> = {};

describe('platform RBAC matrix', () => {
  let base = '';
  let server: Server | null = null;
  let ownerToken = '';
  let operatorToken = '';
  let auditorToken = '';
  let operatorId = '';
  let auditorId = '';

  const call = async (method: string, path: string, body?: any, token?: string) => {
    const r = await fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: r.status, json };
  };

  async function mfaUser(email: string): Promise<{ id: string; token: string }> {
    const login = await call('POST', '/v1/auth/login', { email, orgSlug: 'synapseone-platform' });
    assert.equal(login.status, 200, JSON.stringify(login.json));
    const setup = await call('POST', '/v1/auth/mfa/totp/setup', {}, login.json.accessToken);
    assert.equal(setup.status, 200, JSON.stringify(setup.json));
    const enable = await call('POST', '/v1/auth/mfa/totp/enable', {
      code: totp(base32Decode(setup.json.secret)),
    }, login.json.accessToken);
    assert.equal(enable.status, 200, JSON.stringify(enable.json));
    return { id: login.json.user.id, token: signPlatformAccess({ userId: login.json.user.id, role: 'auditor' }).token };
  }

  before(() => new Promise<void>((resolve, reject) => {
    for (const k of ['NODE_ENV', 'DATABASE_URL', 'SYNAPSEONE_INTERNAL_SECRET', 'IAM_ALLOW_DEV_LOGIN',
      'PLATFORM_ADMIN_ENABLED', 'PLATFORM_ADMIN_REQUIRE_MFA', 'PLATFORM_ADMIN_REQUIRE_STEP_UP',
      'PLATFORM_BOOTSTRAP_SECRET', 'PLATFORM_ORG_SLUG']) {
      saved[k] = process.env[k];
    }
    delete process.env.NODE_ENV;
    delete process.env.DATABASE_URL;
    delete process.env.SYNAPSEONE_INTERNAL_SECRET;
    process.env.IAM_ALLOW_DEV_LOGIN = 'true';
    process.env.PLATFORM_ADMIN_ENABLED = 'true';
    process.env.PLATFORM_ADMIN_REQUIRE_MFA = 'true';
    process.env.PLATFORM_ADMIN_REQUIRE_STEP_UP = 'true';
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
          body: JSON.stringify({ email: 'rbac-owner@test.local', displayName: 'RBAC Owner' }),
        });
        const bootText = await boot.text();
        assert.equal(boot.status, 201, bootText);
        const bootJson: any = JSON.parse(bootText);
        const accepted = await call('POST', '/v1/auth/invite/accept', {
          token: bootJson.inviteToken,
          password: 'RbacOwnerTest!2345',
        });
        assert.equal(accepted.status, 201, JSON.stringify(accepted.json));
        const setup = await call('POST', '/v1/auth/mfa/totp/setup', {}, accepted.json.accessToken);
        assert.equal(setup.status, 200);
        const enable = await call('POST', '/v1/auth/mfa/totp/enable', {
          code: totp(base32Decode(setup.json.secret)),
        }, accepted.json.accessToken);
        assert.equal(enable.status, 200);
        const session = await call('POST', '/v1/platform/session', {
          recoveryCode: enable.json.recoveryCodes[0],
        }, accepted.json.accessToken);
        assert.equal(session.status, 200, JSON.stringify(session.json));
        ownerToken = session.json.accessToken;

        const org = await getOrgBySlug('synapseone-platform');
        assert.ok(org);
        const op = await upsertUser(org!.id, 'rbac-operator@test.local', 'RBAC Operator');
        const au = await upsertUser(org!.id, 'rbac-auditor@test.local', 'RBAC Auditor');
        const opMfa = await mfaUser('rbac-operator@test.local');
        const auMfa = await mfaUser('rbac-auditor@test.local');
        operatorId = opMfa.id;
        auditorId = auMfa.id;
        await grantPlatformAdmin({ userId: op.id, role: 'operator', reason: 'rbac test' });
        await grantPlatformAdmin({ userId: au.id, role: 'auditor', reason: 'rbac test' });
        operatorToken = signPlatformAccess({ userId: op.id, role: 'operator' }).token;
        auditorToken = signPlatformAccess({ userId: au.id, role: 'auditor' }).token;
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  }));

  after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  });

  it('auditor can read but cannot mutate', async () => {
    assert.equal((await call('GET', '/v1/platform/overview', undefined, auditorToken)).status, 200);
    assert.equal((await call('GET', '/v1/platform/audit?limit=3', undefined, auditorToken)).status, 200);
    const denied = await call('POST', '/v1/platform/orgs', {
      slug: 'rbac-auditor-org',
      displayName: 'Denied',
      adminEmail: 'denied@test.local',
    }, auditorToken);
    assert.equal(denied.status, 403);
    assert.equal(denied.json.error, 'platform_role_required');
  });

  it('operator can operate but cannot manage platform administrators', async () => {
    assert.equal((await call('GET', '/v1/platform/users?limit=1', undefined, operatorToken)).status, 200);
    const denied = await call('POST', '/v1/platform/admins', {
      email: 'rbac-new-owner@test.local',
      role: 'owner',
    }, operatorToken);
    assert.equal(denied.status, 403);
    assert.equal(denied.json.error, 'platform_role_required');
    assert.equal((await call('GET', '/v1/platform/admins', undefined, operatorToken)).status, 403);
  });

  it('owner can list administrators', async () => {
    const r = await call('GET', '/v1/platform/admins', undefined, ownerToken);
    assert.equal(r.status, 200);
    assert.ok(r.json.items.some((a: any) => a.user_id === operatorId && a.role === 'operator'));
    assert.ok(r.json.items.some((a: any) => a.user_id === auditorId && a.role === 'auditor'));
  });

  it('revoked administrator is rejected on the next request', async () => {
    assert.equal((await revokePlatformAdmin(auditorId)), true);
    const r = await call('GET', '/v1/platform/overview', undefined, auditorToken);
    assert.equal(r.status, 403);
    assert.equal(r.json.error, 'platform_admin_inactive');
  });
});
