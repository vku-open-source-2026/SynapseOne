// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Super admin API-key issuance + rate-limit/quota management.
 * Covers: platform key creation (tenant-scoped, step-up, audit),
 * per-org AI/Inference/Workflow quotas, validation, reset and the
 * internal gateway lookup.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createApp } from './index';
import { base32Decode, totp } from './mfa';
import { queryAudit } from './db';

const BOOTSTRAP = 'quotas-keys-bootstrap-secret';
const OWNER_PASSWORD = 'QuotasOwner!2345';
const TENANT_PASSWORD = 'QuotasTenant!2345';
const saved: Record<string, string | undefined> = {};

describe('platform api keys and quotas', () => {
  let base = '';
  let server: Server | null = null;
  let platformToken = '';
  let tenantOrgId = '';
  let tenantToken = '';
  let platformOrgId = '';
  let tenantSlug = '';
  let accountId = '';
  let recoveryCodes: string[] = [];
  let stepIndex = 0;

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
    return { status: r.status, json, headers: r.headers };
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
          'PLATFORM_BOOTSTRAP_SECRET', 'PLATFORM_ORG_SLUG', 'IAM_SENSITIVE_MUTATION_MODE', 'IAM_EXPOSE_LIFECYCLE_TOKENS',
          'VALKEY_URL', 'REDIS_URL', 'IAM_QUOTA_VALKEY_URL', 'AI_QUOTA_REQUESTS_PER_MIN',
          'AI_QUOTA_REQUESTS_PER_5H', 'AI_QUOTA_REQUESTS_PER_DAY', 'WORKFLOW_QUOTA_EXECUTIONS_PER_HOUR', 'SYNAPSEONE_MFA_ENABLED']) {
          saved[k] = process.env[k];
        }
        delete process.env.NODE_ENV;
        delete process.env.DATABASE_URL;
        delete process.env.SYNAPSEONE_INTERNAL_SECRET;
        process.env.IAM_ALLOW_DEV_LOGIN = 'false';
        process.env.PLATFORM_ADMIN_ENABLED = 'true';
        process.env.SYNAPSEONE_MFA_ENABLED = 'true';
        process.env.PLATFORM_ADMIN_REQUIRE_MFA = 'true';
        process.env.PLATFORM_ADMIN_REQUIRE_STEP_UP = 'true';
        process.env.PLATFORM_BOOTSTRAP_SECRET = BOOTSTRAP;
        process.env.PLATFORM_ORG_SLUG = 'synapseone-platform';
        process.env.IAM_SENSITIVE_MUTATION_MODE = 'audit';
        process.env.IAM_EXPOSE_LIFECYCLE_TOKENS = 'true';
        delete process.env.VALKEY_URL;
        delete process.env.REDIS_URL;
        delete process.env.IAM_QUOTA_VALKEY_URL;
        process.env.AI_QUOTA_REQUESTS_PER_MIN = '7';
        delete process.env.AI_QUOTA_REQUESTS_PER_5H;
        delete process.env.AI_QUOTA_REQUESTS_PER_DAY;
        process.env.WORKFLOW_QUOTA_EXECUTIONS_PER_HOUR = '5000000';
        const app = createApp();
        server = app.listen(0, '127.0.0.1', async () => {
          try {
            const a = server!.address();
            base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;

            const boot = await fetch(`${base}/internal/platform/bootstrap`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-platform-bootstrap-secret': BOOTSTRAP },
              body: JSON.stringify({ email: 'quotas-owner@test.local', displayName: 'Quotas Owner' }),
            });
            const bootJson: any = await boot.json();
            assert.equal(boot.status, 201, JSON.stringify(bootJson));
            platformOrgId = bootJson.organization.id;

            const accept = await call('POST', '/v1/auth/invite/accept', {
              token: bootJson.inviteToken,
              password: OWNER_PASSWORD,
              displayName: 'Quotas Owner',
            });
            assert.equal(accept.status, 201, JSON.stringify(accept.json));

            const login = await call('POST', '/v1/auth/login', {
              email: 'quotas-owner@test.local',
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

            tenantSlug = `quotas-${Date.now()}`;
            const orgStep = await stepUp('org:create');
            const org = await call('POST', '/v1/platform/orgs', {
              slug: tenantSlug,
              displayName: 'Quotas Tenant',
              adminEmail: `quotas-admin-${tenantSlug}@test.local`,
              adminDisplayName: 'Quotas Admin',
              reason: 'quotas test',
            }, platformToken, { 'x-platform-step-up': orgStep });
            assert.equal(org.status, 201, JSON.stringify(org.json));
            tenantOrgId = org.json.organization.id;

            const tenantAccept = await call('POST', '/v1/auth/invite/accept', {
              token: org.json.inviteToken,
              password: TENANT_PASSWORD,
              displayName: 'Quotas Admin',
            });
            assert.equal(tenantAccept.status, 201, JSON.stringify(tenantAccept.json));
            const tenantLogin = await call('POST', '/v1/auth/login', {
              email: `quotas-admin-${tenantSlug}@test.local`,
              password: TENANT_PASSWORD,
              orgSlug: tenantSlug,
            });
            assert.equal(tenantLogin.status, 200, JSON.stringify(tenantLogin.json));
            tenantToken = tenantLogin.json.accessToken;

            const acc = await call('POST', `/v1/platform/orgs/${tenantOrgId}/accounts`, {
              slug: 'production',
              displayName: 'Production',
              reason: 'quotas test',
            }, platformToken, { 'x-platform-step-up': await stepUp('org:account:create') });
            assert.equal(acc.status, 201, JSON.stringify(acc.json));
            accountId = acc.json.id;
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

  it('creates a tenant api key as super admin and enforces step-up + scope rules', async () => {
    // Missing step-up is rejected before any key is minted.
    const noProof = await call('POST', `/v1/platform/orgs/${tenantOrgId}/keys`, {
      accountId, scopes: ['base:read'],
    }, platformToken);
    assert.equal(noProof.status, 403);
    assert.equal(noProof.json.error, 'platform_step_up_required');

    // platform:* scopes are never allowed on tenant keys.
    // (Scope validation runs before the step-up is consumed, so no proof is needed.)
    const badScope = await call('POST', `/v1/platform/orgs/${tenantOrgId}/keys`, {
      accountId, scopes: ['platform:Admin'],
    }, platformToken);
    assert.equal(badScope.status, 400);
    assert.equal(badScope.json.error, 'invalid_scopes');

    // Cross-org account ids are rejected (also before any step-up is consumed).
    const cross = await call('POST', `/v1/platform/orgs/${tenantOrgId}/keys`, {
      accountId: '00000000-0000-0000-0000-000000000000', scopes: ['base:read'],
    }, platformToken);
    assert.equal(cross.status, 404);

    const resources = await call('GET', `/v1/platform/orgs/${tenantOrgId}/resources`, undefined, platformToken);
    assert.equal(resources.status, 200, JSON.stringify(resources.json));
    const allScopes = resources.json.keyScopeOptions;
    assert.ok(Array.isArray(allScopes));
    assert.ok(allScopes.length > 20, 'the catalog must support a real Select all operation');
    assert.ok(allScopes.includes('base:read'));
    assert.ok(allScopes.includes('workflow:Execute'));
    assert.ok(allScopes.includes('dns:write'));
    assert.ok(allScopes.includes('tunnel:write'));
    assert.ok(allScopes.includes('*'));
    assert.ok(!allScopes.some((scope: string) => scope.startsWith('platform:')));

    const created = await call('POST', `/v1/platform/orgs/${tenantOrgId}/keys`, {
      accountId, name: 'support-breakglass', scopes: allScopes, expiresInDays: 30, reason: 'support access',
    }, platformToken, { 'x-platform-step-up': await stepUp('org:key:create') });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.equal(created.headers.get('cache-control'), 'no-store');
    assert.ok(String(created.json.apiKey).startsWith('synapseone_'));
    assert.deepEqual(created.json.scopes, allScopes);

    // The plaintext works exactly once-visible: verify accepts it, and the
    // resources view lists the key metadata (never the secret).
    const verify = await call('POST', '/v1/keys/verify', { apiKey: created.json.apiKey });
    assert.equal(verify.status, 200, JSON.stringify(verify.json));
    assert.equal(verify.json.valid, true);

    const listedResources = await call('GET', `/v1/platform/orgs/${tenantOrgId}/resources`, undefined, platformToken);
    assert.equal(listedResources.status, 200, JSON.stringify(listedResources.json));
    const listed = listedResources.json.keys.find((k: any) => k.id === created.json.id);
    assert.ok(listed, 'created key is listed');
    assert.equal(listed.name, 'support-breakglass');
    assert.ok(listed.created_at);
    assert.ok(!JSON.stringify(listed).includes(created.json.apiKey));
    assert.ok(!('key_hash' in listed) && !('apiKey' in listed));

    const tenantKeys = await call('GET', `/v1/accounts/${accountId}/keys`, undefined, tenantToken);
    assert.equal(tenantKeys.status, 200, JSON.stringify(tenantKeys.json));
    assert.ok(!JSON.stringify(tenantKeys.json).includes(created.json.apiKey));

    // Rotation is the only way to obtain a replacement; the old plaintext is
    // never retrievable from any metadata endpoint.
    const rotated = await call('POST', `/v1/platform/orgs/${tenantOrgId}/keys/${created.json.id}/rotate`, {
      graceSeconds: 0, reason: 'rotation test',
    }, platformToken, { 'x-platform-step-up': await stepUp('org:key:rotate') });
    assert.equal(rotated.status, 201, JSON.stringify(rotated.json));
    assert.equal(rotated.headers.get('cache-control'), 'no-store');
    assert.notEqual(rotated.json.apiKey, created.json.apiKey);
    assert.equal((await call('POST', '/v1/keys/verify', { apiKey: created.json.apiKey })).status, 401);
    assert.equal((await call('POST', '/v1/keys/verify', { apiKey: rotated.json.apiKey })).status, 200);

    const audit = await queryAudit({ limit: 50, action: 'platform:org:key:create' });
    assert.ok(audit.some((e: any) => e.decision === true && e.context?.keyId === created.json.id));

    // Revocation still works through the existing endpoint.
    const revoke = await call('POST', `/v1/platform/orgs/${tenantOrgId}/keys/${rotated.json.id}/revoke`, { reason: 'test cleanup' }, platformToken, {
      'x-platform-step-up': await stepUp('org:key:revoke'),
    });
    assert.equal(revoke.status, 200, JSON.stringify(revoke.json));
    const verifyAfter = await call('POST', '/v1/keys/verify', { apiKey: rotated.json.apiKey });
    assert.equal(verifyAfter.status, 401);
  });

  it('manages per-org ai/inference/workflow quotas with validation and reset', async () => {
    const defaults = await call('GET', '/v1/platform/quotas/defaults', undefined, platformToken);
    assert.equal(defaults.status, 200, JSON.stringify(defaults.json));
    assert.ok(defaults.json.defaults.ai.requestsPerMin >= 1);
    assert.equal(defaults.json.defaults.ai.requestsPerMin, 7);
    assert.equal(defaults.json.defaults.ai.requestsPer5h, 2100);
    assert.equal(defaults.json.defaults.ai.requestsPerDay, 10080);
    assert.equal(defaults.json.defaults.workflow.concurrentExecutions, 10);
    assert.equal(defaults.json.defaults.workflow.executionsPerHour, 1_000_000);
    assert.ok(defaults.json.defaults.inference.requestsPerMin >= 1);
    assert.ok(defaults.json.defaults.workflow.requestsPerMin >= 1);

    const before = await call('GET', `/v1/platform/orgs/${tenantOrgId}/quotas`, undefined, platformToken);
    assert.equal(before.status, 200, JSON.stringify(before.json));
    assert.equal(before.json.quotas.ai.overridden, false);
    assert.equal(before.json.quotas.workflow.overridden, false);

    // Reused proofs are rejected: every mutation needs a fresh step-up.
    const staleProof = await stepUp('org:quota:update');
    const first = await call('PUT', `/v1/platform/orgs/${tenantOrgId}/quotas`, {
      service: 'ai', requestsPerMin: 120, requestsPer5h: 50000, requestsPerDay: 200000, tokensPerDay: 500000, reason: 'raise AI cap',
    }, platformToken, { 'x-platform-step-up': staleProof });
    assert.equal(first.status, 200, JSON.stringify(first.json));
    assert.equal(first.json.effective.requestsPerMin, 120);
    assert.equal(first.json.effective.requestsPer5h, 50000);
    assert.equal(first.json.effective.requestsPerDay, 200000);
    assert.equal(first.json.effective.overrides.requestsPer5h, true);
    assert.equal(first.json.effective.tokensPerDay, 500000);
    const replay = await call('PUT', `/v1/platform/orgs/${tenantOrgId}/quotas`, {
      service: 'ai', requestsPerMin: 130,
    }, platformToken, { 'x-platform-step-up': staleProof });
    assert.equal(replay.status, 403);
    assert.equal(replay.json.error, 'platform_step_up_required');

    // Service/field matrix is enforced (validation runs before step-up).
    const badService = await call('PUT', `/v1/platform/orgs/${tenantOrgId}/quotas`, {
      service: 'ocs', requestsPerMin: 10,
    }, platformToken);
    assert.equal(badService.status, 400);
    const badField = await call('PUT', `/v1/platform/orgs/${tenantOrgId}/quotas`, {
      service: 'ai', executionsPerHour: 10,
    }, platformToken);
    assert.equal(badField.status, 400);
    const badRange = await call('PUT', `/v1/platform/orgs/${tenantOrgId}/quotas`, {
      service: 'inference', requestsPerMin: 0,
    }, platformToken);
    assert.equal(badRange.status, 400);
    const badWindow = await call('PUT', `/v1/platform/orgs/${tenantOrgId}/quotas`, {
      service: 'ai', requestsPer5h: 0,
    }, platformToken);
    assert.equal(badWindow.status, 400);
    const empty = await call('PUT', `/v1/platform/orgs/${tenantOrgId}/quotas`, {
      service: 'ai',
    }, platformToken);
    assert.equal(empty.status, 400);

    const flow = await call('PUT', `/v1/platform/orgs/${tenantOrgId}/quotas`, {
      service: 'workflow', requestsPerMin: 200, executionsPerHour: 500, concurrentExecutions: 5,
    }, platformToken, { 'x-platform-step-up': await stepUp('org:quota:update') });
    assert.equal(flow.status, 200, JSON.stringify(flow.json));
    assert.equal(flow.json.effective.executionsPerHour, 500);

    const after = await call('GET', `/v1/platform/orgs/${tenantOrgId}/quotas`, undefined, platformToken);
    assert.equal(after.status, 200, JSON.stringify(after.json));
    assert.equal(after.json.quotas.ai.overridden, true);
    assert.equal(after.json.quotas.workflow.overridden, true);
    assert.equal(after.json.quotas.inference.overridden, false);

    const all = await call('GET', '/v1/platform/quotas?service=ai', undefined, platformToken);
    assert.equal(all.status, 200, JSON.stringify(all.json));
    assert.ok(all.json.items.some((q: any) => q.org_id === tenantOrgId && q.service === 'ai'));

    // Gateway lookup sees the same effective values.
    const internal = await call('GET', `/internal/quotas?orgId=${tenantOrgId}&service=ai`);
    assert.equal(internal.status, 200, JSON.stringify(internal.json));
    assert.equal(internal.json.requestsPerMin, 120);
    assert.equal(internal.json.requestsPer5h, 50000);

    const invalidCheck = await call('POST', '/internal/quota/check', {
      subject: 'org:test', service: 'ai', limits: { minute: 1, fiveHour: 0, day: 10 },
    });
    assert.equal(invalidCheck.status, 400);
    const unavailable = await call('POST', '/internal/quota/check', {
      subject: `org:${tenantOrgId}`, service: 'ai', limits: { minute: 1, fiveHour: 10, day: 100 },
    });
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.json.error, 'quota_unavailable');
    const invalidExecution = await call('POST', '/internal/workflow/execution/check', {
      subject: `org:${tenantOrgId}`, limits: { hour: 0, concurrent: 1 },
    });
    assert.equal(invalidExecution.status, 400);
    const executionUnavailable = await call('POST', '/internal/workflow/execution/check', {
      subject: `org:${tenantOrgId}`, limits: { hour: 10, concurrent: 1 },
    });
    assert.equal(executionUnavailable.status, 503);

    // Reset drops back to defaults.
    const reset = await call('DELETE', `/v1/platform/orgs/${tenantOrgId}/quotas/ai`, undefined, platformToken, {
      'x-platform-step-up': await stepUp('org:quota:update'),
    });
    assert.equal(reset.status, 200, JSON.stringify(reset.json));
    assert.equal(reset.json.effective.overridden, false);
  });

  it('lets tenants read only their own organization and effective quotas', async () => {
    const org = await call('GET', `/v1/orgs/${tenantOrgId}`, undefined, tenantToken);
    assert.equal(org.status, 200, JSON.stringify(org.json));
    assert.equal(org.json.id, tenantOrgId);
    assert.equal(org.headers.get('cache-control'), 'no-store');

    const quotas = await call('GET', `/v1/orgs/${tenantOrgId}/quotas`, undefined, tenantToken);
    assert.equal(quotas.status, 200, JSON.stringify(quotas.json));
    assert.equal(quotas.json.quotas.ai.overridden, false);
    assert.equal(quotas.json.quotas.ai.requestsPer5h, 2100);
    assert.equal(quotas.json.quotas.workflow.concurrentExecutions, 5);
    assert.equal(quotas.json.quotas.workflow.overridden, true);
    assert.ok(Array.isArray(quotas.json.overrides));

    const crossOrg = await call('GET', `/v1/orgs/${platformOrgId}`, undefined, tenantToken);
    assert.equal(crossOrg.status, 403);
    const crossQuotas = await call('GET', `/v1/orgs/${platformOrgId}/quotas`, undefined, tenantToken);
    assert.equal(crossQuotas.status, 403);
    const platformList = await call('GET', '/v1/platform/quotas', undefined, tenantToken);
    assert.equal(platformList.status, 403);
  });
});
