// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Regression tests for gateway scope completeness (R1) and platform token
 * isolation. Read-only credentials must never write to newly added services.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scopeAllows } from './scopes';
import {
  propagatePrincipal,
  createApp,
  platformRunnerPathAllowed,
  canonicalPolicyPath,
  execDelegatedRequestAllowed,
  execDelegatedScopesAllowed,
} from './index';

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

describe('service-account attribution isolation', () => {
  it('stamps quota attribution without widening authorization org scope', () => {
    const req: any = {
      headers: { 'x-synapseone-org': 'forged', 'x-synapseone-quota-org': 'forged' },
      principal: { type: 'jwt', kind: 'service-account', sub: 'sa1', org: null, attributionOrg: 'org-1', account: 'acct-1', scopes: ['base:read'] },
    };
    propagatePrincipal(req);
    assert.equal(req.headers['x-synapseone-org'], undefined);
    assert.equal(req.headers['x-synapsedx-org'], undefined);
    assert.equal(req.headers['x-synapseone-account'], 'acct-1');
    assert.equal(req.headers['x-synapseone-quota-org'], 'org-1');
  });
});

describe('platform runner credentials', () => {
  it('propagates the platform-runner kind and bound runner id', () => {
    const req: any = {
      headers: {},
      principal: {
        type: 'apikey',
        kind: 'platform-runner',
        runnerId: 'runner-123',
        scopes: ['workflow:*', 'queue:consume'],
      },
    };
    propagatePrincipal(req);
    assert.equal(req.headers['x-synapseone-kind'], 'platform-runner');
    assert.equal(req.headers['x-synapseone-runner'], 'runner-123');
    assert.equal(req.headers['x-synapseone-org'], undefined);
    assert.equal(req.headers['x-synapseone-account'], undefined);
  });

  it('strips a client-supplied runner binding', () => {
    const req: any = {
      headers: { 'x-synapseone-runner': 'forged' },
      principal: { type: 'apikey', kind: 'apikey', account: 'a1' },
    };
    propagatePrincipal(req);
    assert.equal(req.headers['x-synapseone-runner'], undefined);
    assert.equal(req.headers['x-synapseone-kind'], 'apikey');
  });

  it('allows only the runner protocol, bootstrap and queue paths', () => {
    for (const path of [
      '/v1/auth/verify',
      '/v1/runner/jobs/exec-1/claim',
      '/v1/workflow-runners/runner-1/config',
      '/v1/workflow-runners/runner-1/heartbeat',
      '/v1/queue/queues/synapseone-wf-system/consume',
    ]) {
      assert.equal(platformRunnerPathAllowed(path), true, path);
    }
    for (const path of [
      '/v1/workflows',
      '/v1/base/collections',
      '/v1/lds/datasources',
      '/v1/keys',
      '/v1/platform/runners',
      '/v1/workflow-runners',
    ]) {
      assert.equal(platformRunnerPathAllowed(path), false, path);
    }
  });
});

describe('exec-delegated path policy', () => {
  it('normalizes one encoding layer and resolves dot segments', () => {
    assert.equal(canonicalPolicyPath('/v1/base/x'), '/v1/base/x');
    assert.equal(canonicalPolicyPath('/v1//base/./x'), '/v1/base/x');
    assert.equal(canonicalPolicyPath('/v1/base/../iam/orgs'), '/v1/iam/orgs');
    assert.equal(canonicalPolicyPath('/v1/base/%2e%2e/iam/orgs'), '/v1/iam/orgs');
    assert.equal(canonicalPolicyPath('/v1/ocs/bucket/a%20b'), '/v1/ocs/bucket/a b');
    assert.equal(canonicalPolicyPath('/v1/base/%252e%252e/v1/iam'), null);
    assert.equal(canonicalPolicyPath('/v1/base/%zz'), null);
    assert.equal(canonicalPolicyPath('/v1/base/..\\iam'), null);
    assert.equal(canonicalPolicyPath('/v1/base/%00'), null);
    assert.equal(canonicalPolicyPath('/../v1/base'), null);
    assert.equal(canonicalPolicyPath('v1/base'), null);
  });

  it('allows only data-plane services and queue message operations', () => {
    for (const path of [
      '/v1/base/collections',
      '/v1/search/x',
      '/v1/lds/datasources',
      '/v1/faststore/x',
      '/v1/ocs/bucket/key',
      '/v1/storage/bucket/key',
      '/v1/warehouse/datasets',
      '/v1/stream/topics/x',
      '/v1/notifications/x',
      '/v1/inference/x',
      '/v1/inference-jobs/x',
    ]) {
      assert.equal(execDelegatedRequestAllowed('GET', path, canonicalPolicyPath(path)!), true, path);
    }
    for (const path of [
      '/v1/orgs',
      '/v1/accounts/a1/keys',
      '/v1/accounts/a1/credentials',
      '/v1/keys',
      '/v1/credentials',
      '/v1/users',
      '/v1/roles',
      '/v1/service-accounts',
      '/v1/policies',
      '/v1/workflows',
      '/v1/workflows/x/execute',
      '/v1/executions',
      '/v1/human-tasks',
      '/v1/workflow-runners',
      '/v1/runner/jobs/x/claim',
      '/v1/platform/runners',
      '/v1/audit',
      '/v1/usage',
      '/v1/secrets',
      '/v1/scim/tokens',
      '/v1/queue/queues',
      '/v1/queue/queues/q/purge',
      '/v1/queue/queues/q/stats',
    ]) {
      assert.equal(execDelegatedRequestAllowed('GET', path, canonicalPolicyPath(path)!), false, path);
    }
    assert.equal(
      execDelegatedRequestAllowed('POST', '/v1/queue/queues/q/messages', canonicalPolicyPath('/v1/queue/queues/q/messages')!),
      true,
    );
    assert.equal(
      execDelegatedRequestAllowed('GET', '/v1/queue/queues/q/messages', canonicalPolicyPath('/v1/queue/queues/q/messages')!),
      false,
    );
  });

  it('rejects traversal and double-encoding spellings', () => {
    for (const raw of [
      '/v1/base/../iam/orgs',
      '/v1/base/%2e%2e/iam/orgs',
      '/v1/base/%252e%252e/v1/iam/orgs',
      '/v1/base/../workflows',
      '/%76%31/base',
      '/v1/ocs/../keys',
      '/v1/queue/queues/../x/messages',
      '/v1/queue/queues/q/%2e%2e/stats',
    ]) {
      const canonical = canonicalPolicyPath(raw);
      const allowed = canonical ? execDelegatedRequestAllowed('POST', raw, canonical) : false;
      assert.equal(allowed, false, raw);
    }
  });

  it('allows data-plane scope families only', () => {
    assert.equal(execDelegatedScopesAllowed(['base:read']), true);
    assert.equal(execDelegatedScopesAllowed(['base:*']), true);
    assert.equal(execDelegatedScopesAllowed(['ocs:write']), true);
    assert.equal(execDelegatedScopesAllowed(['queue:consume']), true);
    // Universal scopes are accepted but remain path-limited to data-plane.
    assert.equal(execDelegatedScopesAllowed(['*']), true);
    assert.equal(execDelegatedScopesAllowed(['*:read']), true);
    for (const scopes of [
      [], ['iam:*'], ['workflow:*'], ['platform:admin'],
      ['keys:write'], ['credentials:read'], ['unknown:read'],
    ]) {
      assert.equal(execDelegatedScopesAllowed(scopes as string[]), false, JSON.stringify(scopes));
    }
  });

  it('refuses encoded platform-runner prefixes', () => {
    assert.equal(platformRunnerPathAllowed('/v1/workflow-runners/r1/config'), true);
    assert.equal(platformRunnerPathAllowed('/v1/workflow-runners/../v1/platform/runners'), false);
    assert.equal(platformRunnerPathAllowed('/v1/workflow-runners/%2e%2e/v1/platform/runners'), false);
    assert.equal(platformRunnerPathAllowed('/v1/%77orkflow-runners/r1/config'), false);
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
