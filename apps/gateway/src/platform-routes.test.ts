// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Regression tests for gateway scope completeness (R1) and platform token
 * isolation. Read-only credentials must never write to newly added services.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scopeAllows } from './scopes';
import { propagatePrincipal, createApp } from './index';

describe('scope completeness for newer services', () => {
  const writes: Array<[string, string]> = [
    ['/v1/ocs/buckets/b/objects/k', 'PUT'],
    ['/v1/notifications', 'POST'],
    ['/v1/warehouse/datasets', 'POST'],
    ['/v1/secrets', 'POST'],
    ['/v1/scim/tokens', 'POST'],
    ['/v1/human-tasks', 'POST'],
    ['/v1/search/reindex', 'POST'],
    ['/v1/accounts/a1/credentials', 'POST'],
  ];
  it('rejects a read-only scope on every write route', () => {
    for (const [path, method] of writes) {
      assert.equal(scopeAllows(['*:read'], path, method), false, `${method} ${path}`);
    }
  });
  it('accepts a matching write scope', () => {
    assert.equal(scopeAllows(['*:write'], '/v1/ocs/buckets/b/objects/k', 'PUT'), true);
    assert.equal(scopeAllows(['storage:write'], '/v1/ocs/buckets/b/objects/k', 'PUT'), true);
    assert.equal(scopeAllows(['notifications:write'], '/v1/notifications', 'POST'), true);
    assert.equal(scopeAllows(['warehouse:write'], '/v1/warehouse/datasets', 'POST'), true);
  });
  it('uses the route service for ambiguous account credential paths', () => {
    assert.equal(scopeAllows(['workflow:write'], '/v1/accounts/a1/credentials', 'POST', {
      service: 'workflow',
      action: 'workflow:Write',
    }), true);
    assert.equal(scopeAllows(['iam:write'], '/v1/accounts/a1/credentials', 'POST', {
      service: 'workflow',
      action: 'workflow:Write',
    }), false);
  });
});

describe('platform scope overrides', () => {
  it('enforces platform:Admin for admin-only endpoints', () => {
    assert.equal(scopeAllows(['platform:write'], '/v1/platform/admins', 'POST', {
      service: 'platform',
      action: 'platform:Admin',
    }), false);
    assert.equal(scopeAllows(['platform:admin'], '/v1/platform/admins', 'POST', {
      service: 'platform',
      action: 'platform:Admin',
    }), true);
  });
  it('allows platform:Read for profile reads', () => {
    assert.equal(scopeAllows(['platform:read'], '/v1/platform/me', 'GET', {
      service: 'platform',
      action: 'platform:Read',
    }), true);
  });
});

describe('platform principal propagation', () => {
  it('preserves the platform-admin kind instead of hardcoding user', () => {
    const req: any = { headers: {}, principal: { type: 'jwt', sub: 'u1', kind: 'platform-admin', scopes: ['platform:read'] } };
    propagatePrincipal(req);
    assert.equal(req.headers['x-synapseone-kind'], 'platform-admin');
    assert.equal(req.headers['x-synapseone-org'], undefined);
  });
});

describe('production authz fail-closed guard', () => {
  it('refuses to boot with AUTHZ_MODE=off when required', () => {
    const saved = {
      NODE_ENV: process.env.NODE_ENV,
      AUTHZ_MODE: process.env.AUTHZ_MODE,
      AUTHZ_MODE_REQUIRED: process.env.AUTHZ_MODE_REQUIRED,
    };
    process.env.NODE_ENV = 'production';
    process.env.AUTHZ_MODE = 'off';
    process.env.AUTHZ_MODE_REQUIRED = 'true';
    try {
      assert.throws(() => createApp(), /AUTHZ_MODE=off is forbidden/);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
