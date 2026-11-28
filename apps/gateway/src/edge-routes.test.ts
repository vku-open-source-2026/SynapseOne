// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import yaml from 'js-yaml';
import type { RouteRule } from './index';

const SECRET = 'gateway-edge-parity-test-secret-0123456789abcdef';
const TOKEN_ENV = 'SYNAPSEONE_GATEWAY_TEST_EDGE_ADMIN_TOKEN';
const EDGE_TOKEN = 'dns-server-admin-token';
const INTERNAL_SECRET = 'gateway-edge-internal-secret';
const ENV_KEYS = [
  'NODE_ENV',
  'IAM_SERVICE_URL',
  'IAM_JWT_SECRET',
  'SYNAPSEONE_INTERNAL_SECRET',
  'AUTHZ_MODE',
  'AUTHZ_MODE_REQUIRED',
  'GATEWAY_VERIFY_APIKEY',
  'GATEWAY_ROUTES_PATH',
  'GATEWAY_SESSION_CACHE_MS',
  'USAGE_TELEMETRY',
  TOKEN_ENV,
] as const;

function edgeRoute(overrides: Partial<RouteRule> = {}): RouteRule {
  return {
    path: '/v1/platform/edge/dns',
    target: 'http://edge:4014',
    auth: 'jwt',
    service: 'platform',
    stripPrefix: '/v1/platform/edge/dns',
    adminTokenEnv: 'SYNAPSEDNS_ADMIN_TOKEN',
    ...overrides,
  };
}

describe('platform edge route parity', () => {
  let gateway: http.Server | null = null;
  let iam: http.Server | null = null;
  let upstream: http.Server | null = null;
  let tempDir = '';
  let base = '';
  let adminToken = '';
  let operatorToken = '';
  let auditorToken = '';
  let tenantToken = '';
  let serviceAccountToken = '';
  let upstreamHits = 0;
  let seen: {
    url?: string; authorization?: string; apiKey?: string | string[];
    org?: string | string[]; ownerOrg?: string | string[]; internal?: string | string[]; kind?: string | string[]; scopes?: string | string[];
  } = {};
  let api: typeof import('./index');
  const savedEnv: Partial<Record<typeof ENV_KEYS[number], string>> = {};

  before(async () => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];

    iam = http.createServer((req, res) => {
      if (req.url === '/v1/auth/verify') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"valid":true,"type":"jwt","org_id":"org-1"}');
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not_found"}');
    });
    await new Promise<void>((resolve) => iam!.listen(0, '127.0.0.1', resolve));
    const iamPort = (iam.address() as { port: number }).port;

    upstream = http.createServer((req, res) => {
      upstreamHits += 1;
      seen = {
        url: req.url,
        authorization: req.headers.authorization,
        apiKey: req.headers['x-api-key'],
        org: req.headers['x-synapseone-org'],
        ownerOrg: req.headers['x-synapseone-owner-org'],
        internal: req.headers['x-synapseone-internal'],
        kind: req.headers['x-synapseone-kind'],
        scopes: req.headers['x-synapseone-scopes'],
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true,"upstream":true}');
    });
    await new Promise<void>((resolve) => upstream!.listen(0, '127.0.0.1', resolve));
    const upstreamPort = (upstream.address() as { port: number }).port;

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-edge-'));
    const routesPath = path.join(tempDir, 'routes.yaml');
    fs.writeFileSync(routesPath, [
      'routes:',
      '  - path: /v1/platform/edge/dns',
      `    target: http://127.0.0.1:${upstreamPort}`,
      '    auth: jwt',
      '    service: platform',
      '    stripPrefix: /v1/platform/edge/dns',
      `    adminTokenEnv: ${TOKEN_ENV}`,
      '    actions:',
      '      - { method: GET, path: /v1/platform/edge/dns/*, action: platform:Read }',
      '      - { method: POST, path: /v1/platform/edge/dns/*, action: platform:Write }',
      '      - { method: DELETE, path: /v1/platform/edge/dns/*, action: platform:Write }',
      '  - path: /v1/tunnel',
      `    target: http://127.0.0.1:${upstreamPort}`,
      '    auth: either',
      '    service: tunnel',
      '    stripPrefix: /v1/tunnel',
      '    actions:',
      '      - { method: DELETE, path: /v1/tunnel/*, action: tunnel:Write }',
      '',
    ].join('\n'));

    process.env.NODE_ENV = 'test';
    process.env.IAM_SERVICE_URL = `http://127.0.0.1:${iamPort}`;
    process.env.IAM_JWT_SECRET = SECRET;
    process.env.SYNAPSEONE_INTERNAL_SECRET = INTERNAL_SECRET;
    process.env.AUTHZ_MODE = 'off';
    process.env.AUTHZ_MODE_REQUIRED = 'false';
    process.env.GATEWAY_VERIFY_APIKEY = 'true';
    process.env.GATEWAY_ROUTES_PATH = routesPath;
    process.env.GATEWAY_SESSION_CACHE_MS = '0';
    process.env.USAGE_TELEMETRY = 'false';
    process.env[TOKEN_ENV] = EDGE_TOKEN;

    api = await import('./index');
    gateway = api.createApp().listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => gateway!.once('listening', () => resolve()));
    base = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`;
    adminToken = jwt.sign({ sub: 'admin-edge', kind: 'platform-admin', scopes: ['*'] }, SECRET, {
      issuer: 'synapseone-iam',
      algorithm: 'HS256',
      expiresIn: 120,
    });
    operatorToken = jwt.sign({ sub: 'operator-edge', kind: 'platform-admin', scopes: ['platform:read', 'platform:write'] }, SECRET, {
      issuer: 'synapseone-iam', algorithm: 'HS256', expiresIn: 120,
    });
    auditorToken = jwt.sign({ sub: 'auditor-edge', kind: 'platform-admin', scopes: ['platform:read'] }, SECRET, {
      issuer: 'synapseone-iam', algorithm: 'HS256', expiresIn: 120,
    });
    tenantToken = jwt.sign({ sub: 'tenant-edge', org: 'org-1', kind: 'user', scopes: ['*'] }, SECRET, {
      issuer: 'synapseone-iam',
      algorithm: 'HS256',
      expiresIn: 120,
    });
    serviceAccountToken = jwt.sign({ sub: 'service-edge', account: 'acct-1', kind: 'service-account', scopes: ['tunnel:read', 'tunnel:write'] }, SECRET, {
      issuer: 'synapseone-iam', algorithm: 'HS256', expiresIn: 120,
    });
  });

  after(async () => {
    if (gateway) await new Promise<void>((resolve) => gateway!.close(() => resolve()));
    if (iam) await new Promise<void>((resolve) => iam!.close(() => resolve()));
    if (upstream) await new Promise<void>((resolve) => upstream!.close(() => resolve()));
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    for (const key of ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('ships both edge rules with scoped server-token settings', () => {
    const doc = yaml.load(fs.readFileSync(path.resolve(__dirname, '../routes.yaml'), 'utf8')) as any;
    for (const [routePath, target, tokenEnv] of [
      ['/v1/platform/edge/dns', '${SYNAPSEDNS_SERVICE_URL:-http://synapsedns:4014}', 'SYNAPSEDNS_ADMIN_TOKEN'],
      ['/v1/platform/edge/tunnel', '${SYNAPSETUNNEL_SERVICE_URL:-http://synapsetunnel:4015}', 'SYNAPSETUNNEL_ADMIN_TOKEN'],
    ]) {
      const route = doc.routes.find((candidate: any) => candidate.path === routePath);
      assert.ok(route, routePath);
      assert.equal(route.target, target);
      assert.equal(route.auth, 'jwt');
      assert.equal(route.service, 'platform');
      assert.equal(route.stripPrefix, routePath);
      assert.equal(route.adminTokenEnv, tokenEnv);
      assert.ok(route.actions.some((action: any) => action.method === 'DELETE' && action.action === 'platform:Write'));
    }
  });

  it('ships organization-scoped DNS and Tunnel routes without admin-token rewriting', () => {
    const doc = yaml.load(fs.readFileSync(path.resolve(__dirname, '../routes.yaml'), 'utf8')) as any;
    for (const [routePath, service] of [['/v1/dns', 'dns'], ['/v1/tunnel', 'tunnel']]) {
      const route = doc.routes.find((candidate: any) => candidate.path === routePath);
      assert.ok(route, routePath);
      assert.equal(route.auth, 'either');
      assert.equal(route.service, service);
      assert.equal(route.adminTokenEnv, undefined);
      assert.equal(route.stripPrefix, routePath);
      assert.ok(route.actions.some((action: any) => action.method === 'DELETE' && action.action === `${service}:Write`));
    }
  });

  it('stamps verified organization identity on tenant Tunnel requests and rejects platform tokens', async () => {
    const path = `${base}/v1/tunnel/v1/connectors`;
    const response = await fetch(path, {
      headers: {
        Authorization: `Bearer ${tenantToken}`,
        'X-SynapseOne-Org': 'attacker-org',
        'X-SynapseOne-Internal': 'attacker-secret',
        'X-SynapseOne-Kind': 'platform-admin',
      },
    });
    assert.equal(response.status, 200);
    assert.equal(seen.url, '/v1/connectors');
    assert.equal(seen.authorization, `Bearer ${tenantToken}`);
    assert.equal(seen.org, 'org-1');
    assert.equal(seen.ownerOrg, 'org-1');
    assert.equal(seen.internal, INTERNAL_SECRET);
    assert.equal(seen.kind, 'user');
    assert.equal(seen.scopes, '*');
    const beforeHits = upstreamHits;
    const platform = await fetch(path, { headers: { Authorization: `Bearer ${adminToken}` } });
    assert.equal(platform.status, 403);
    assert.equal((await platform.json() as any).error, 'platform_token_tenant_forbidden');
    assert.equal(upstreamHits, beforeHits);

    const serviceAccount = await fetch(path, {
      headers: { Authorization: `Bearer ${serviceAccountToken}`, 'X-SynapseOne-Org': 'attacker-org' },
    });
    assert.equal(serviceAccount.status, 200);
    assert.equal(seen.org, undefined);
    assert.equal(seen.ownerOrg, 'org-1');
    assert.equal(seen.kind, 'service-account');
  });

  it('rewrites only the pathname and preserves the query byte-for-byte', () => {
    assert.equal(
      api.rewriteProxyPath('/v1/platform/edge/dns/zones/example.com?type=TXT&value=a%2Fb&type=MX', '/v1/platform/edge/dns'),
      '/zones/example.com?type=TXT&value=a%2Fb&type=MX',
    );
    assert.equal(api.rewriteProxyPath('/v1/platform/edge/dns?dryRun=1', '/v1/platform/edge/dns'), '/?dryRun=1');
    assert.equal(api.rewriteProxyPath('/v1/platform/edge/dns', '/v1/platform/edge/dns'), '/');
    assert.throws(
      () => api.rewriteProxyPath('/v1/platform/edge/dns-other?x=1', '/v1/platform/edge/dns'),
      /path-segment boundary/,
    );
  });

  it('validates stripPrefix and adminTokenEnv narrowly', () => {
    assert.doesNotThrow(() => api.validateRouteRule(edgeRoute()));
    assert.doesNotThrow(() => api.validateRouteRule(edgeRoute({ stripPrefix: '/v1/platform/edge' })));
    assert.throws(() => api.validateRouteRule(edgeRoute({ stripPrefix: '/v1/platform/edge/*' })), /invalid stripPrefix/);
    assert.throws(() => api.validateRouteRule(edgeRoute({ stripPrefix: '/v1/platform/edge/dns/zones' })), /must equal the route path or be its path-segment ancestor/);
    assert.throws(() => api.validateRouteRule(edgeRoute({ auth: 'either' })), /adminTokenEnv is only allowed/);
    assert.throws(() => api.validateRouteRule(edgeRoute({ service: 'iam' })), /adminTokenEnv is only allowed/);
    assert.throws(() => api.validateRouteRule(edgeRoute({
      path: '/v1/platform-other/edge/dns',
      stripPrefix: '/v1/platform-other/edge/dns',
    })), /adminTokenEnv is only allowed/);
    assert.throws(() => api.validateRouteRule(edgeRoute({ adminTokenEnv: '' })), /invalid adminTokenEnv/);
  });

  it('allows only platform-admin JWTs to reach the edge upstream', async () => {
    const beforeHits = upstreamHits;
    const anonymous = await fetch(`${base}/v1/platform/edge/dns/zones`);
    assert.equal(anonymous.status, 401);
    const tenant = await fetch(`${base}/v1/platform/edge/dns/zones`, {
      headers: { Authorization: `Bearer ${tenantToken}` },
    });
    assert.equal(tenant.status, 403);
    assert.equal((await tenant.json() as any).error, 'platform_admin_required');
    assert.equal(upstreamHits, beforeHits);
  });

  it('allows auditor reads but reserves mutations for operator/owner scopes', async () => {
    const path = `${base}/v1/platform/edge/dns/zones`;
    const read = await fetch(path, { headers: { Authorization: `Bearer ${auditorToken}` } });
    assert.equal(read.status, 200);
    const beforeHits = upstreamHits;
    const denied = await fetch(path, { method: 'POST', headers: { Authorization: `Bearer ${auditorToken}` } });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json() as any).error, 'scope_denied');
    assert.equal(upstreamHits, beforeHits);
    for (const method of ['POST', 'DELETE']) {
      const allowed = await fetch(path, { method, headers: { Authorization: `Bearer ${operatorToken}` } });
      assert.equal(allowed.status, 200, method);
    }
  });

  it('replaces caller credentials and forwards the rewritten pathname and query', async () => {
    const response = await fetch(
      `${base}/v1/platform/edge/dns/zones/example.com?type=TXT&value=a%2Fb&type=MX`,
      { headers: { Authorization: `Bearer ${adminToken}`, 'X-API-Key': 'caller-api-key' } },
    );
    assert.equal(response.status, 200);
    assert.equal(seen.url, '/zones/example.com?type=TXT&value=a%2Fb&type=MX');
    assert.equal(seen.authorization, `Bearer ${EDGE_TOKEN}`);
    assert.equal(seen.apiKey, undefined);

    const exact = await fetch(`${base}/v1/platform/edge/dns?dryRun=1`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(exact.status, 200);
    assert.equal(seen.url, '/?dryRun=1');
  });

  it('fails closed with 503 when the server token is missing or blank', async () => {
    const beforeHits = upstreamHits;
    try {
      for (const value of [undefined, '   ']) {
        if (value === undefined) delete process.env[TOKEN_ENV];
        else process.env[TOKEN_ENV] = value;
        const response = await fetch(`${base}/v1/platform/edge/dns/zones`, {
          headers: { Authorization: `Bearer ${adminToken}` },
        });
        assert.equal(response.status, 503);
        assert.equal((await response.json() as any).error, 'edge_not_configured');
        assert.equal(upstreamHits, beforeHits);
      }
    } finally {
      process.env[TOKEN_ENV] = EDGE_TOKEN;
    }
  });
});
