// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createApp } from './index';
import { createOrganization, upsertUser, grantPlatformAdmin, setOrganizationStatus } from './db';

let server: Server; let base = '';
const PASSWORD = 'context-switch-strong-password';
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
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const a = server.address(); base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('authorized identity contexts', () => {
  it('lists only real memberships and switches tenant context without impersonation', async () => {
    const reg = await call('POST', '/v1/auth/register', { email: EMAIL, password: PASSWORD, orgSlug: `ctxa${Date.now()}`, displayName: 'Context User' });
    assert.equal(reg.status, 201, JSON.stringify(reg.data));
    const orgB = await createOrganization(`ctxb${Date.now()}`, 'Context B');
    await upsertUser(orgB.id, EMAIL, 'Context User');
    const platformOrg = await createOrganization(`ctxplatform${Date.now()}`, 'Context Platform', 'platform');
    const platformUser = await upsertUser(platformOrg.id, EMAIL, 'Context User');
    await grantPlatformAdmin({ userId: platformUser.id, role: 'owner', grantedBy: platformUser.id, reason: 'context test' });

    const token = reg.data.accessToken;
    const contexts = await call('GET', '/v1/auth/contexts', undefined, token);
    assert.equal(contexts.status, 200, JSON.stringify(contexts.data));
    assert.equal(contexts.data.current.type, 'tenant');
    assert.ok(contexts.data.contexts.some((c: any) => c.orgId === orgB.id));
    assert.ok(contexts.data.contexts.some((c: any) => c.type === 'platform' && c.role === 'owner'));

    const switched = await call('POST', '/v1/auth/contexts/switch', { orgId: orgB.id }, token);
    assert.equal(switched.status, 200, JSON.stringify(switched.data));
    assert.ok(switched.data.accessToken);
    const me = await call('GET', '/v1/auth/me', undefined, switched.data.accessToken);
    assert.equal(me.status, 200);
    assert.equal(me.data.user.org_id, orgB.id);

    const platformSwitch = await call('POST', '/v1/auth/contexts/switch', { orgId: platformOrg.id }, token);
    assert.equal(platformSwitch.status, 409);
    assert.equal(platformSwitch.data.error, 'platform_context_login_required');

    await setOrganizationStatus(orgB.id, 'suspended', platformUser.id, 'context test suspension');
    const stale = await call('GET', '/v1/auth/me', undefined, switched.data.accessToken);
    assert.equal(stale.status, 403);
    assert.equal(stale.data.error, 'org_suspended');
    const login = await call('POST', '/v1/auth/login', { email: EMAIL, orgSlug: orgB.slug, password: PASSWORD });
    assert.equal(login.status, 403);
    assert.equal(login.data.error, 'org_suspended');
    await setOrganizationStatus(orgB.id, 'active', platformUser.id, '');
  });
});
