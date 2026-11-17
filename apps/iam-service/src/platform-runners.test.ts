// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * IAM tests for owner-scoped platform runner credentials.
 * A platform runner key has no account/user owner, is restricted to the runner
 * scope families, is verified by the gateway like an API key, and yields a
 * short-lived per-execution delegation for the queued user.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createApp } from './index';
import { createOrganization, grantPlatformAdmin, upsertUser } from './db';
import { signPlatformAccess, verifyAccess } from './tokens';

const INTERNAL = 'platform-runner-iam-test-secret';
const saved: Record<string, string | undefined> = {};

describe('platform runner credentials', () => {
  let base = '';
  let server: Server | null = null;
  let platformToken = '';
  let userId = '';

  async function call(method: string, path: string, body: any, headers: Record<string, string> = {}) {
    const r = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json: any = text;
    try { json = text ? JSON.parse(text) : null; } catch { /* keep text */ }
    return { status: r.status, json };
  }

  before(async () => {
    for (const k of ['NODE_ENV', 'DATABASE_URL', 'SYNAPSEONE_INTERNAL_SECRET', 'IAM_ALLOW_DEV_LOGIN',
      'PLATFORM_ADMIN_ENABLED', 'PLATFORM_ADMIN_REQUIRE_MFA', 'PLATFORM_ADMIN_REQUIRE_STEP_UP', 'PLATFORM_ORG_SLUG']) {
      saved[k] = process.env[k];
    }
    delete process.env.NODE_ENV;
    delete process.env.DATABASE_URL;
    process.env.SYNAPSEONE_INTERNAL_SECRET = INTERNAL;
    process.env.PLATFORM_ADMIN_ENABLED = 'true';
    process.env.PLATFORM_ADMIN_REQUIRE_MFA = 'false';
    process.env.PLATFORM_ADMIN_REQUIRE_STEP_UP = 'false';
    process.env.PLATFORM_ORG_SLUG = 'synapseone-platform';

    const org = await createOrganization('synapseone-platform', 'SynapseOne Platform', 'platform');
    const user = await upsertUser(org.id, 'platform-owner@test.local', 'Platform Owner');
    userId = user.id;
    await grantPlatformAdmin({ userId: user.id, role: 'owner', grantedBy: user.id, reason: 'test' });
    platformToken = signPlatformAccess({ userId: user.id, role: 'owner' }).token;

    const app = createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const a = server!.address();
        base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
        resolve();
      });
    });
  });

  after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  });

  it('mints a platform runner key with no tenant binding and verifies it', async () => {
    const out = await call('POST', '/internal/platform-runners/keys', {
      runnerId: 'runner-platform-1',
      name: 'system-eu',
      createdBy: userId,
      scopes: ['workflow:*', 'queue:consume', 'queue:ack', 'queue:nack', 'queue:heartbeat', 'inference:*'],
    }, { 'x-synapseone-internal': INTERNAL });
    assert.equal(out.status, 201, JSON.stringify(out.json));
    assert.match(out.json.apiKey, /^synapseone_pr_/);
    assert.equal(out.json.runnerId, 'runner-platform-1');
    // Platform runner keys are never immortal: an omitted expiry defaults to
    // a bounded rotation window.
    assert.equal(typeof out.json.expiresAt, 'string');
    assert.ok(new Date(out.json.expiresAt).getTime() > Date.now());

    const verified = await call('POST', '/v1/keys/verify', { apiKey: out.json.apiKey }, {
      'x-synapseone-internal': INTERNAL,
    });
    assert.equal(verified.status, 200, JSON.stringify(verified.json));
    assert.equal(verified.json.valid, true);
    assert.equal(verified.json.kind, 'platform-runner');
    assert.equal(verified.json.runner_id, 'runner-platform-1');
    assert.equal(verified.json.account_id, undefined);
    assert.equal(verified.json.org_id, undefined);

    const preflight = await call('GET', '/v1/auth/verify', undefined, { 'x-api-key': out.json.apiKey });
    assert.equal(preflight.status, 200, JSON.stringify(preflight.json));
    assert.equal(preflight.json.kind, 'platform-runner');
    assert.equal(preflight.json.runner_id, 'runner-platform-1');
  });

  it('refuses master scopes and data-plane scopes on a system key', async () => {
    for (const scopes of [['*'], ['base:read'], ['iam:*']]) {
      const out = await call('POST', '/internal/platform-runners/keys', {
        runnerId: 'runner-platform-2',
        scopes,
      }, { 'x-synapseone-internal': INTERNAL });
      assert.equal(out.status, 400, JSON.stringify(out.json));
      assert.equal(out.json.error, 'invalid_scopes');
    }
  });

  it('rejects an expiry beyond the maximum runner-key rotation window', async () => {
    const out = await call('POST', '/internal/platform-runners/keys', {
      runnerId: 'runner-platform-expiry',
      expiresAt: new Date(Date.now() + 365 * 86_400_000).toISOString(),
    }, { 'x-synapseone-internal': INTERNAL });
    assert.equal(out.status, 400, JSON.stringify(out.json));
    assert.equal(out.json.error, 'expiry_too_long');
  });

  it('delegates one execution to the platform runner with tenant context', async () => {
    const tenantOrg = await createOrganization('tenant-delegate', 'Tenant Delegate');
    const tenantUser = await upsertUser(tenantOrg.id, 'runner-target@test.local', 'Runner Target');
    const out = await call('POST', '/internal/platform-runners/delegate', {
      userId: tenantUser.id,
      runnerId: 'runner-platform-1',
      instanceId: 'connector-1',
      executionId: 'exec-123',
      scopes: ['base:read', 'queue:write'],
    }, { 'x-synapseone-internal': INTERNAL });
    assert.equal(out.status, 200, JSON.stringify(out.json));
    assert.ok(out.json.accessToken);
    const claims: any = verifyAccess(out.json.accessToken);
    assert.equal(claims.kind, 'exec-delegated');
    assert.equal(claims.delegated, true);
    assert.equal(claims.sub, tenantUser.id);
    assert.equal(claims.org, tenantOrg.id);
    assert.equal(claims.exec, 'exec-123');
    assert.equal(claims.runner, 'runner-platform-1');
    assert.equal(claims.instance, 'connector-1');
    assert.equal(claims.act.kind, 'platform-runner');
    assert.equal(claims.act.sub, 'platform-runner:runner-platform-1');
    assert.equal(claims.act.exec, 'exec-123');
    assert.equal(claims.act.instance, 'connector-1');
    assert.deepEqual(claims.scopes, ['base:read', 'queue:write']);

    const before = await call('GET', '/v1/auth/verify', undefined, {
      Authorization: `Bearer ${out.json.accessToken}`,
      'x-synapseone-internal': INTERNAL,
    });
    assert.equal(before.status, 200, JSON.stringify(before.json));
    assert.equal(before.json.valid, true);

    const revoked = await call('POST', '/internal/platform-runners/delegations/revoke', {
      executionId: 'exec-123',
    }, { 'x-synapseone-internal': INTERNAL });
    assert.equal(revoked.status, 200, JSON.stringify(revoked.json));
    assert.equal(revoked.json.revoked, 1);

    const after = await call('GET', '/v1/auth/verify', undefined, {
      Authorization: `Bearer ${out.json.accessToken}`,
      'x-synapseone-internal': INTERNAL,
    });
    assert.equal(after.status, 401, JSON.stringify(after.json));
    assert.equal(after.json.error, 'delegation_revoked');

    // A grant cannot outlive its lease: a 1s grant is unusable once it expires
    // even if no explicit revoke has happened.
    const shortLived = await call('POST', '/internal/platform-runners/delegate', {
      userId: tenantUser.id,
      runnerId: 'runner-platform-1',
      instanceId: 'connector-1',
      executionId: 'exec-expire',
      scopes: ['base:read'],
      ttlSeconds: 1,
    }, { 'x-synapseone-internal': INTERNAL });
    assert.equal(shortLived.status, 200, JSON.stringify(shortLived.json));
    assert.equal(shortLived.json.expiresIn, 1);
    await new Promise((resolve) => setTimeout(resolve, 2200));
    const expired = await call('GET', '/v1/auth/verify', undefined, {
      Authorization: `Bearer ${shortLived.json.accessToken}`,
      'x-synapseone-internal': INTERNAL,
    });
    assert.equal(expired.status, 401, JSON.stringify(expired.json));
    assert.equal(expired.json.error, 'token_expired');
  });

  it('refuses wildcard/non-data scopes on execution delegation', async () => {
    const tenantOrg = await createOrganization('tenant-delegate-bad', 'Tenant Delegate Bad');
    const tenantUser = await upsertUser(tenantOrg.id, 'runner-bad@test.local', 'Runner Bad');
    for (const [i, scopes] of [['*'], ['*:write'], ['iam:*'], ['platform:admin']].entries()) {
      const out = await call('POST', '/internal/platform-runners/delegate', {
        userId: tenantUser.id,
        runnerId: 'runner-platform-1',
        instanceId: 'connector-1',
        executionId: `exec-bad-${i}`,
        scopes,
      }, { 'x-synapseone-internal': INTERNAL });
      assert.equal(out.status, 403, `${scopes}: ${JSON.stringify(out.json)}`);
    }
    const missing = await call('POST', '/internal/platform-runners/delegate', {
      userId: tenantUser.id,
      runnerId: 'runner-platform-1',
      instanceId: 'connector-1',
      executionId: 'exec-no-scopes',
    }, { 'x-synapseone-internal': INTERNAL });
    assert.equal(missing.status, 400);
    assert.equal(missing.json.error, 'scopes_required');
  });

  it('revokes a runner key through the internal control plane', async () => {
    const created = await call('POST', '/internal/platform-runners/keys', {
      runnerId: 'runner-platform-3',
      scopes: ['workflow:*', 'queue:consume'],
    }, { 'x-synapseone-internal': INTERNAL });
    assert.equal(created.status, 201);

    const revoked = await call('DELETE', `/internal/platform-runners/keys/${created.json.id}`, undefined, {
      'x-synapseone-internal': INTERNAL,
    });
    assert.equal(revoked.status, 200, JSON.stringify(revoked.json));
    assert.equal(revoked.json.revoked, true);

    const verified = await call('POST', '/v1/keys/verify', { apiKey: created.json.apiKey }, {
      'x-synapseone-internal': INTERNAL,
    });
    assert.equal(verified.status, 401);
  });

  it('requires the internal secret and an active platform owner for the public surface', async () => {
    const noSecret = await call('POST', '/internal/platform-runners/keys', {
      runnerId: 'runner-platform-4',
      scopes: ['workflow:*'],
    });
    assert.equal(noSecret.status, 401);

    const me = await call('GET', '/v1/platform/me', undefined, {
      Authorization: `Bearer ${platformToken}`,
      'x-synapseone-internal': INTERNAL,
    });
    assert.equal(me.status, 200, JSON.stringify(me.json));
    assert.equal(me.json.role, 'owner');
  });
});
