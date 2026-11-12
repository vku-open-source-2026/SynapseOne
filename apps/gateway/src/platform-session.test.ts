// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Regression: `/v1/platform/session` must reach IAM for a normal user JWT.
 * Central tenant-policy enforcement must not pre-empt the platform-admin
 * exchange (IAM owns that decision and audits denials).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import jwt from 'jsonwebtoken';

const SECRET = 'gateway-platform-session-test-secret-0123456789abcdef';

describe('platform session exchange boundary', () => {
  let iam: http.Server | null = null;
  let gateway: http.Server | null = null;
  let base = '';
  let token = '';
  let sessionHits = 0;

  before(async () => {
    iam = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{"status":"ok","version":"test"}');
      }
      if (req.url === '/v1/platform/session') {
        sessionHits += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{"accessToken":"fake-platform-token"}');
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not_found"}');
    });
    await new Promise<void>((resolve) => iam!.listen(0, '127.0.0.1', () => resolve()));
    const addr = iam.address();
    const iamPort = typeof addr === 'object' && addr ? addr.port : 0;

    process.env.NODE_ENV = 'test';
    process.env.IAM_SERVICE_URL = `http://127.0.0.1:${iamPort}`;
    process.env.IAM_JWT_SECRET = SECRET;
    process.env.AUTHZ_MODE = 'enforce';
    process.env.AUTHZ_MODE_REQUIRED = 'false';
    process.env.GATEWAY_VERIFY_APIKEY = 'true';
    process.env.USAGE_TELEMETRY = 'false';
    process.env.GATEWAY_ROUTES_PATH = path.resolve(__dirname, '../routes.yaml');

    const { createApp } = await import('./index');
    gateway = createApp().listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => gateway!.once('listening', () => resolve()));
    const gwAddr = gateway.address();
    base = `http://127.0.0.1:${typeof gwAddr === 'object' && gwAddr ? gwAddr.port : 0}`;
    token = jwt.sign({ sub: 'tenant-user-1', org: 'org-1', kind: 'user', scopes: ['*'] }, SECRET, {
      issuer: 'synapseone-iam',
      algorithm: 'HS256',
      expiresIn: 120,
    });
  });

  after(() => new Promise<void>((resolve) => {
    gateway?.close(() => iam?.close(() => resolve()));
  }));

  it('passes a tenant user JWT to IAM instead of denying at the gateway', async () => {
    const beforeHits = sessionHits;
    const r = await fetch(`${base}/v1/platform/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ code: '000000' }),
    });
    const body: any = await r.json();
    assert.equal(r.status, 200, JSON.stringify(body));
    assert.equal(body.accessToken, 'fake-platform-token');
    assert.equal(sessionHits, beforeHits + 1);
  });

  it('still rejects a tenant JWT on platform-admin APIs at the gateway', async () => {
    const r = await fetch(`${base}/v1/platform/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body: any = await r.json();
    assert.equal(r.status, 403);
    assert.equal(body.error, 'platform_admin_required');
  });
});
