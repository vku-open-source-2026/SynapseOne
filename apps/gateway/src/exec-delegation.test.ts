// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Per-execution delegated grants (kind=exec-delegated):
 *  - data-plane only; IAM/keys/credentials/workflow/admin routes are denied;
 *  - canonical path policy blocks traversal/encoding bypasses;
 *  - the grant row is checked against IAM on EVERY request (no cache), so
 *    completion/release/runner revocation takes effect immediately.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import jwt from 'jsonwebtoken';

const SECRET = 'gateway-exec-delegation-test-secret-0123456789abcdef';

describe('exec-delegated grants', () => {
  let iam: http.Server | null = null;
  let upstream: http.Server | null = null;
  let gateway: http.Server | null = null;
  let base = '';
  let upstreamBase = '';
  let verifyCalls = 0;
  let verifyMode: 'ok' | 'revoked' | 'down' | 'malformed' | 'missing' | 'false' = 'ok';
  let upstreamHits = 0;
  let upstreamPath = '';
  let token = '';
  let unbound = '';

  before(async () => {
    iam = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{"status":"ok","version":"test"}');
      }
      if (req.url === '/v1/auth/verify') {
        verifyCalls += 1;
        if (verifyMode === 'down') {
          res.writeHead(503);
          return res.end('down');
        }
        if (verifyMode === 'revoked') {
          res.writeHead(401, { 'content-type': 'application/json' });
          return res.end('{"valid":false,"error":"token_revoked"}');
        }
        if (verifyMode === 'malformed') {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end('{not-json');
        }
        if (verifyMode === 'missing') {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end('{"type":"jwt"}');
        }
        if (verifyMode === 'false') {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end('{"valid":false}');
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{"valid":true,"type":"jwt"}');
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not_found"}');
    });
    await new Promise<void>((resolve) => iam!.listen(0, '127.0.0.1', () => resolve()));
    const iamAddr = iam.address();
    const iamPort = typeof iamAddr === 'object' && iamAddr ? iamAddr.port : 0;

    upstream = http.createServer((req, res) => {
      upstreamHits += 1;
      upstreamPath = req.url || '';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => upstream!.listen(0, '127.0.0.1', () => resolve()));
    const upAddr = upstream.address();
    const upPort = typeof upAddr === 'object' && upAddr ? upAddr.port : 0;
    upstreamBase = `http://127.0.0.1:${upPort}`;

    process.env.NODE_ENV = 'test';
    process.env.IAM_SERVICE_URL = `http://127.0.0.1:${iamPort}`;
    process.env.IAM_JWT_SECRET = SECRET;
    process.env.AUTHZ_MODE = 'off';
    process.env.AUTHZ_MODE_REQUIRED = 'false';
    process.env.GATEWAY_VERIFY_APIKEY = 'true';
    process.env.USAGE_TELEMETRY = 'false';
    process.env.GATEWAY_ROUTES_PATH = path.resolve(__dirname, '../routes.yaml');
    process.env.BASE_SERVICE_URL = upstreamBase;
    process.env.OCS_SERVICE_URL = upstreamBase;
    process.env.STORAGE_SERVICE_URL = upstreamBase;
    process.env.QUEUE_SERVICE_URL = upstreamBase;
    process.env.WORKFLOW_SERVICE_URL = upstreamBase;

    const { createApp } = await import('./index');
    gateway = createApp().listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => gateway!.once('listening', () => resolve()));
    const gwAddr = gateway.address();
    base = `http://127.0.0.1:${typeof gwAddr === 'object' && gwAddr ? gwAddr.port : 0}`;

    token = jwt.sign({
      sub: 'user-1',
      org: 'org-1',
      account: 'acc-1',
      kind: 'exec-delegated',
      scopes: ['base:read', 'storage:read', 'queue:write'],
      jti: '11111111-1111-4111-8111-111111111111',
      exec: 'exec-1',
      runner: 'runner-1',
      instance: 'instance-1',
    }, SECRET, { issuer: 'synapseone-iam', algorithm: 'HS256', expiresIn: 300 });
    unbound = jwt.sign({
      sub: 'user-1',
      org: 'org-1',
      kind: 'exec-delegated',
      scopes: ['base:read'],
    }, SECRET, { issuer: 'synapseone-iam', algorithm: 'HS256', expiresIn: 300 });
  });

  after(() => new Promise<void>((resolve) => {
    gateway?.close(() => upstream?.close(() => iam?.close(() => resolve())));
  }));

  beforeEach(() => {
    verifyCalls = 0;
    verifyMode = 'ok';
    upstreamHits = 0;
    upstreamPath = '';
  });

  async function call(method: string, target: string, bearer = token) {
    const r = await fetch(`${base}${target}`, {
      method,
      headers: { Authorization: `Bearer ${bearer}` },
    });
    const text = await r.text();
    let body: any = text;
    try { body = text ? JSON.parse(text) : null; } catch { /* text */ }
    return { status: r.status, body };
  }

  it('forwards data-plane and verifies the grant on every request (no cache)', async () => {
    const first = await call('GET', '/v1/base/collections');
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(upstreamHits, 1);
    assert.equal(verifyCalls, 1);
    const second = await call('GET', '/v1/base/collections');
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(upstreamHits, 2);
    assert.equal(verifyCalls, 2, 'grant verification must not be cached');
  });

  it('denies the request as soon as IAM reports the grant inactive', async () => {
    assert.equal((await call('GET', '/v1/base/collections')).status, 200);
    verifyMode = 'revoked';
    const revoked = await call('GET', '/v1/base/collections');
    assert.equal(revoked.status, 401);
    assert.equal(revoked.body.error, 'execution_grant_inactive');
    assert.equal(upstreamHits, 1);
    verifyMode = 'down';
    const down = await call('GET', '/v1/base/collections');
    assert.equal(down.status, 503);
    assert.equal(down.body.error, 'iam_unavailable');

    // A 200 from IAM is not enough: `valid:true` must be explicit.
    for (const [mode, error] of [
      ['malformed', 'execution_grant_invalid'],
      ['missing', 'execution_grant_invalid'],
      ['false', 'execution_grant_inactive'],
    ] as const) {
      verifyMode = mode;
      const rejected = await call('GET', '/v1/base/collections');
      assert.equal(rejected.status, 401, mode);
      assert.equal(rejected.body.error, error, mode);
      assert.equal(upstreamHits, 1);
    }
  });

  it('rejects IAM/key/credential/workflow/admin routes before upstream traffic', async () => {
    for (const target of [
      '/v1/keys',
      '/v1/credentials',
      '/v1/workflows',
      '/v1/workflows/x/execute',
      '/v1/accounts/a1/keys',
      '/v1/accounts/a1/credentials',
      '/v1/service-accounts',
      '/v1/roles',
      '/v1/policies',
      '/v1/workflow-runners',
    ]) {
      const out = await call('GET', target);
      assert.equal(out.status, 403, target);
      assert.equal(out.body.error, 'execution_scope_forbidden', target);
    }
    // Runner job protocol is API-key-only. A delegated user JWT is rejected at
    // authentication (401), before delegation policy or upstream traffic.
    const runner = await call('GET', '/v1/runner/jobs/exec-1/claim');
    assert.equal(runner.status, 401, '/v1/runner/jobs/exec-1/claim');
    assert.equal(runner.body.error, 'missing_api_key');
    assert.equal(upstreamHits, 0);
    assert.equal(verifyCalls, 0, 'denied paths do not need a grant check');
  });

  it('rejects normalized-path and double-encoding bypasses', async () => {
    for (const target of [
      '/v1/base/../keys',
      '/v1/base/%2e%2e/keys',
      '/v1/base/%252e%252e/keys',
      '/v1/base/../workflows',
      '/v1/ocs/../credentials',
    ]) {
      const out = await call('GET', target);
      assert.equal(out.status, 403, target);
    }
    assert.equal(upstreamHits, 0);
  });

  it('keeps legitimate encoded object paths and queue message ops', async () => {
    const object = await call('GET', '/v1/ocs/bucket/a%20b');
    assert.equal(object.status, 200, JSON.stringify(object.body));
    assert.equal(upstreamPath, '/v1/ocs/bucket/a%20b');
    const queue = await call('POST', '/v1/queue/queues/q/messages');
    assert.equal(queue.status, 200, JSON.stringify(queue.body));
    const purge = await call('POST', '/v1/queue/queues/q/purge');
    assert.equal(purge.status, 403);
  });

  it('rejects a grant token without execution/runner/instance bindings', async () => {
    const out = await call('GET', '/v1/base/collections', unbound);
    assert.equal(out.status, 401);
    assert.equal(out.body.error, 'invalid_token');
  });

  it('refuses universal/control-plane scopes on a data-plane path', async () => {
    for (const scopes of [['iam:*'], ['workflow:*'], ['platform:admin']]) {
      const broad = jwt.sign({
        sub: 'user-1',
        org: 'org-1',
        kind: 'exec-delegated',
        scopes,
        jti: '11111111-1111-4111-8111-111111111111',
        exec: 'exec-1',
        runner: 'runner-1',
        instance: 'instance-1',
      }, SECRET, { issuer: 'synapseone-iam', algorithm: 'HS256', expiresIn: 300 });
      const out = await call('GET', '/v1/base/collections', broad);
      assert.equal(out.status, 403, JSON.stringify(scopes));
      assert.equal(out.body.error, 'execution_scope_forbidden');
    }
    assert.equal(upstreamHits, 0);

    // A universal scope is accepted only on data-plane paths; it cannot reach
    // the control plane (the mint should narrow scopes anyway).
    const universal = jwt.sign({
      sub: 'user-1', org: 'org-1', kind: 'exec-delegated', scopes: ['*'],
      jti: '11111111-1111-4111-8111-111111111111', exec: 'exec-1',
      runner: 'runner-1', instance: 'instance-1',
    }, SECRET, { issuer: 'synapseone-iam', algorithm: 'HS256', expiresIn: 300 });
    const data = await call('GET', '/v1/base/collections', universal);
    assert.equal(data.status, 200, JSON.stringify(data.body));
    const control = await call('GET', '/v1/keys', universal);
    assert.equal(control.status, 403);
  });

  it('retires legacy platform-runner delegations but keeps ordinary delegated sessions', async () => {
    const legacy = jwt.sign({
      sub: 'user-1',
      org: 'org-1',
      kind: 'delegated',
      scopes: ['*'],
      act: { sub: 'platform-runner:runner-1' },
    }, SECRET, { issuer: 'synapseone-iam', algorithm: 'HS256', expiresIn: 300 });
    const retired = await call('GET', '/v1/base/collections', legacy);
    assert.equal(retired.status, 401);
    assert.equal(retired.body.error, 'execution_grant_legacy_forbidden');
    assert.equal(upstreamHits, 0);

    const ordinary = jwt.sign({
      sub: 'user-1',
      org: 'org-1',
      kind: 'delegated',
      scopes: ['*'],
      act: { sub: 'service-account:sa-1' },
    }, SECRET, { issuer: 'synapseone-iam', algorithm: 'HS256', expiresIn: 300 });
    const allowed = await call('GET', '/v1/base/collections', ordinary);
    assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
  });
});
