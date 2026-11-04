// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { findRoute, expandEnv, propagatePrincipal, compileRoutePath, parseTrustProxy, RouteRule, createApp, verifyApiKeyUpstream } from './index';
import { featureForRoute, isUsageExcluded, isUsageTelemetryEnabled } from './usage';
import { scopeAllows } from './scopes';

// No analytics side effects while booting ephemeral test apps.
process.env.USAGE_TELEMETRY = 'false';

const routes: RouteRule[] = [
  { path: '/v1/auth', target: 'http://iam:4001', auth: 'none' },
  { path: '/v1/orgs', target: 'http://iam:4001', auth: 'either' },
  { path: '/v1/workflows', target: 'http://workflow:4002', auth: 'either' },
];

describe('findRoute', () => {
  it('exact match', () => {
    assert.equal(findRoute(routes, '/v1/orgs')?.path, '/v1/orgs');
  });
  it('subpath match', () => {
    assert.equal(findRoute(routes, '/v1/auth/login')?.path, '/v1/auth');
  });
  it('no false prefix (/v1/organizations != /v1/orgs)', () => {
    assert.equal(findRoute(routes, '/v1/organizations'), undefined);
  });
  it('unknown path', () => {
    assert.equal(findRoute(routes, '/nope'), undefined);
  });
  it('longest prefix wins', () => {
    const rs: RouteRule[] = [
      ...routes,
      { path: '/v1/workflows', target: 'x', auth: 'either' },
    ];
    assert.equal(findRoute(rs, '/v1/workflows/123/execute')?.target, 'http://workflow:4002');
  });
});

describe('wildcard routes (LDS public export surface)', () => {
  const rs: RouteRule[] = [
    { path: '/v1/lds', target: 'http://lds:4004', auth: 'either' },
    { path: '/v1/lds/licenses', target: 'http://lds:4004', auth: 'none' },
    { path: '/v1/lds/datasources/*/entities/*', target: 'http://lds:4004', auth: 'none' },
    ...routes,
  ];
  for (const r of rs) (r as any).compiled = compileRoutePath(r.path);

  it('single wildcard segment matches one path segment only', () => {
    assert.equal(findRoute(rs, '/v1/lds/datasources/abc-123/entities')?.auth, 'none');
    assert.equal(findRoute(rs, '/v1/lds/datasources/abc-123/entities/urn%3Ax%3Ay')?.auth, 'none');
    assert.equal(findRoute(rs, '/v1/lds/datasources/abc-123/entities/e1/extra')?.auth, 'none');
    // siblings and nested ids stay on the authenticated rule
    assert.equal(findRoute(rs, '/v1/lds/datasources/abc-123/records')?.auth, 'either');
    assert.equal(findRoute(rs, '/v1/lds/datasources/abc-123/attributes')?.auth, 'either');
    assert.equal(findRoute(rs, '/v1/lds/datasources')?.auth, 'either');
    // wildcard must not eat empty or multi segments
    assert.equal(findRoute(rs, '/v1/lds/datasources//entities')?.auth, 'either');
    assert.equal(findRoute(rs, '/v1/lds/datasources/a/b/entities')?.auth, 'either');
  });
  it('static route shadows the generic prefix for licenses', () => {
    assert.equal(findRoute(rs, '/v1/lds/licenses')?.auth, 'none');
    assert.equal(findRoute(rs, '/v1/lds/licenses/sub')?.auth, 'none');
  });
  it('non-matching shapes fall through', () => {
    assert.equal(findRoute(rs, '/v1/lds')?.path, '/v1/lds'); // exact hit on the generic rule
    assert.equal(findRoute(rs, '/v1/ldsz')?.path, undefined);
    // unknown subpaths under /v1/lds/* stay on the authenticated generic rule
    assert.equal(findRoute(rs, '/v1/lds/licenses-extra')?.path, '/v1/lds');
  });
  it('compileRoutePath validates malformed wildcard patterns', () => {
    assert.throws(() => compileRoutePath('/x/*//y'));
    assert.throws(() => compileRoutePath('x/*'));
  });
});

describe('propagatePrincipal: anonymous marker', () => {
  it('stamps anon marker only for auth:none routes without a principal', () => {
    const pub: any = { headers: { 'x-synapseone-anon': 'spoof' }, synapseoneRoute: { auth: 'none' } };
    propagatePrincipal(pub);
    assert.equal(pub.headers['x-synapseone-anon'], '1');
    const authed: any = { headers: { 'x-synapseone-anon': 'spoof' }, synapseoneRoute: { auth: 'either' } };
    propagatePrincipal(authed);
    assert.equal(authed.headers['x-synapseone-anon'], undefined);
    const withP: any = { headers: {}, principal: { type: 'jwt', sub: 'u' }, synapseoneRoute: { auth: 'either' } };
    propagatePrincipal(withP);
    assert.equal(withP.headers['x-synapseone-anon'], undefined);
    const platformDirect: any = { headers: {}, synapseoneRoute: undefined };
    propagatePrincipal(platformDirect);
    assert.equal(platformDirect.headers['x-synapseone-anon'], undefined);
  });
});

describe('propagatePrincipal', () => {
  it('strips spoofed headers when no principal', () => {
    const req: any = { headers: { 'x-synapseone-user': 'mallory', 'x-synapseone-kind': 'user', 'x-synapseone-internal': 'forged' } };
    propagatePrincipal(req);
    assert.equal(req.headers['x-synapseone-user'], undefined);
    assert.equal(req.headers['x-synapseone-kind'], undefined);
    // Without SYNAPSEONE_INTERNAL_SECRET (test env), nothing is (re-)set.
    assert.equal(req.headers['x-synapseone-internal'], undefined);
  });
  it('writes verified jwt principal', () => {
    const req: any = {
      headers: { 'x-synapseone-user': 'mallory' },
      principal: { type: 'jwt', sub: 'u1', org: 'o1', scopes: ['a', 'b'] },
    };
    propagatePrincipal(req);
    assert.equal(req.headers['x-synapseone-user'], 'u1');
    assert.equal(req.headers['x-synapseone-org'], 'o1');
    assert.equal(req.headers['x-synapseone-scopes'], 'a,b');
    assert.equal(req.headers['x-synapseone-kind'], 'user');
  });
  it('writes apikey kind', () => {
    const req: any = { headers: {}, principal: { type: 'apikey' } };
    propagatePrincipal(req);
    assert.equal(req.headers['x-synapseone-kind'], 'apikey');
  });
  it('writes verified apikey org+account+scopes', () => {
    const req: any = { headers: {}, principal: { type: 'apikey', org: 'o1', account: 'a1', scopes: ['x', 'y'] } };
    propagatePrincipal(req);
    assert.equal(req.headers['x-synapseone-org'], 'o1');
    assert.equal(req.headers['x-synapseone-account'], 'a1');
    assert.equal(req.headers['x-synapseone-scopes'], 'x,y');
  });
  it('drops spoofed legacy headers, keeps legacy tenant and mirrors the verified principal', () => {
    const req: any = {
      headers: {
        'x-synapsedx-user': 'mallory',
        'x-synapsedx-org': 'spoofed',
        'x-synapsedx-tenant': 'acme',
      },
      principal: { type: 'jwt', sub: 'u1', org: 'o1' },
    };
    propagatePrincipal(req);
    assert.equal(req.headers['x-synapseone-user'], 'u1');
    assert.equal(req.headers['x-synapseone-tenant'], 'acme');
    // Legacy copies are re-stamped from the verified principal, never trusted.
    assert.equal(req.headers['x-synapsedx-user'], 'u1');
    assert.equal(req.headers['x-synapsedx-org'], 'o1');
  });
});

describe('usage telemetry helpers', () => {
  it('maps routes to stable feature keys', () => {
    assert.equal(featureForRoute('/v1/auth'), 'auth');
    assert.equal(featureForRoute('/v1/orgs'), 'iam');
    assert.equal(featureForRoute('/v1/roles'), 'iam');
    assert.equal(featureForRoute('/v1/workflows'), 'workflows');
    assert.equal(featureForRoute('/v1/executions'), 'workflows');
    assert.equal(featureForRoute('/webhook'), 'workflows');
    assert.equal(featureForRoute('/v1/lds/datasources/*/entities/*'), 'lds');
    assert.equal(featureForRoute('/v1/base'), 'base');
    assert.equal(featureForRoute('/v1/queue'), 'queue');
    assert.equal(featureForRoute('/v1/new-service'), 'new-service');
    assert.equal(featureForRoute('/'), 'other');
  });

  it('never counts its own usage endpoints', () => {
    assert.equal(isUsageExcluded('/v1/usage'), true);
    assert.equal(isUsageExcluded('/v1/usage/summary'), true);
    assert.equal(isUsageExcluded('/v1/usagex'), false);
    assert.equal(isUsageExcluded('/v1/workflows'), false);
  });

  it('can be disabled by env for tests', () => {
    assert.equal(isUsageTelemetryEnabled(), false);
  });
});

describe('expandEnv', () => {
  it('uses env when set, default otherwise', () => {
    process.env.SYNAPSEONE_TEST_VAR = 'from-env';
    assert.equal(expandEnv('${SYNAPSEONE_TEST_VAR:http://default}'), 'from-env');
    delete process.env.SYNAPSEONE_TEST_VAR;
    assert.equal(expandEnv('${SYNAPSEONE_TEST_VAR:http://default}'), 'http://default');
  });
});

describe('gateway hardening (live boot)', () => {  let base = '';
  let server: Server | null = null;
  before(
    () =>
      new Promise<void>((resolve) => {
        const app = createApp();
        server = app.listen(0, '127.0.0.1', () => {
          const a = server!.address();
          base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
          resolve();
        });
      }),
  );
  after(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

  it('health carries security headers', async () => {
    const r = await fetch(base + '/health');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('x-powered-by'), null);
  });
  it('protected routes reject anonymous callers', async () => {
    const r = await fetch(base + '/v1/orgs');
    assert.equal(r.status, 401);
  });
  it('unknown routes are 404 with request-id echo', async () => {
    const r = await fetch(base + '/no-such-route');
    assert.equal(r.status, 404);
    assert.ok(r.headers.get('x-request-id'));
  });
});

describe('verifyApiKeyUpstream', () => {  it('forwards the internal secret so IAM accepts the check', async () => {
    let seenInternal: string | null = null;
    const iam = (await import('node:http')).createServer((req, res) => {
      seenInternal = (req.headers['x-synapseone-internal'] as string) || null;
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ valid: true, account_id: 'a1', org_id: 'o1', scopes: ['*'] }));
      });
    });
    await new Promise<void>((resolve) => iam.listen(0, '127.0.0.1', resolve));
    try {
      const addr = iam.address();
      const iamBase = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
      const out = await verifyApiKeyUpstream('k', iamBase, 's3cret');
      assert.deepEqual(out, { id: undefined, account_id: 'a1', org_id: 'o1', user_id: null, scopes: ['*'] });
      assert.equal(seenInternal, 's3cret');
      const out2 = await verifyApiKeyUpstream('k', iamBase, undefined);
      assert.ok(out2);
    } finally {
      await new Promise<void>((resolve) => iam.close(() => resolve()));
    }
  });
  it('returns null on invalid key / unreachable IAM', async () => {
    const deny = (await import('node:http')).createServer((req, res) => {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ valid: false }));
    });
    await new Promise<void>((resolve) => deny.listen(0, '127.0.0.1', resolve));
    try {
      const addr = deny.address();
      const iamBase = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
      assert.equal(await verifyApiKeyUpstream('bad', iamBase), null);
    } finally {
      await new Promise<void>((resolve) => deny.close(() => resolve()));
    }
    await assert.rejects(() => verifyApiKeyUpstream('k', 'http://127.0.0.1:1', undefined), /iam_unreachable/);
  });
});

describe('trust proxy and per-client rate limits (#41)', () => {
  it('rejects a blanket TRUST_PROXY=true', () => {
    assert.throws(() => parseTrustProxy('true'), /forbidden/);
    assert.equal(parseTrustProxy(undefined), false);
    assert.equal(parseTrustProxy('0'), false);
    assert.equal(parseTrustProxy('1'), 1);
    assert.equal(parseTrustProxy('loopback,172.16.0.0/12'), 'loopback,172.16.0.0/12');
  });

  it('keys rate-limit buckets per client behind the edge and ignores spoofed hops', async () => {
    const prev = process.env.TRUST_PROXY;
    process.env.TRUST_PROXY = '1';
    process.env.IAM_SERVICE_URL = 'http://127.0.0.1:1';
    process.env.WORKFLOW_SERVICE_URL = 'http://127.0.0.1:1';
    process.env.AI_SERVICE_URL = 'http://127.0.0.1:1';
    process.env.LDS_SERVICE_URL = 'http://127.0.0.1:1';
    process.env.BASE_SERVICE_URL = 'http://127.0.0.1:1';
    process.env.FASTSTORE_SERVICE_URL = 'http://127.0.0.1:1';
    process.env.QUEUE_SERVICE_URL = 'http://127.0.0.1:1';
    const app = createApp();
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const addr = server.address();
    const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    try {
      const hit = (xff: string) => fetch(`${base}/ready`, { headers: { 'x-forwarded-for': xff } });
      // Client A exhausts its own bucket.
      let lastA = 0;
      for (let i = 0; i < 31; i++) lastA = (await hit('203.0.113.10')).status;
      assert.equal(lastA, 429);
      // Client B is unaffected.
      assert.notEqual((await hit('203.0.113.20')).status, 429);
      // A spoofed left-most entry appends to the real client at the trusted hop
      // (nginx appends), so it cannot poison client B's bucket.
      assert.notEqual((await hit('198.51.100.99, 203.0.113.20')).status, 429);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (prev === undefined) delete process.env.TRUST_PROXY;
      else process.env.TRUST_PROXY = prev;
    }
  });
});

describe('routes.yaml validation', () => {
  it('createApp fails fast on unknown auth mode', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gw-')), 'routes.yaml');
    fs.writeFileSync(tmp, 'routes:\n  - path: /v1/x\n    target: http://x:1\n    auth: bogus\n');
    const prev = process.env.GATEWAY_ROUTES_PATH;
    process.env.GATEWAY_ROUTES_PATH = tmp;
    try {
      assert.throws(() => createApp(), /invalid auth mode/);
    } finally {
      if (prev === undefined) delete process.env.GATEWAY_ROUTES_PATH;
      else process.env.GATEWAY_ROUTES_PATH = prev;
      fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
    }
  });
});

describe('per-route scope enforcement (#23)', () => {
  it('maps routes/methods to service scopes', () => {
    assert.equal(scopeAllows(['*'], '/v1/faststore/keys/a', 'POST'), true);
    assert.equal(scopeAllows(['*:read'], '/v1/faststore/keys/a', 'GET'), true);
    assert.equal(scopeAllows(['*:read'], '/v1/faststore/keys/a', 'PUT'), false);
    assert.equal(scopeAllows(['faststore:get'], '/v1/faststore/keys/a', 'GET'), true);
    assert.equal(scopeAllows(['faststore:get'], '/v1/faststore/keys/a', 'PUT'), false);
    assert.equal(scopeAllows(['faststore:*'], '/v1/faststore/keys/a', 'PUT'), true);
    assert.equal(scopeAllows(['faststore:write'], '/v1/faststore/keys/a', 'POST'), true);
    assert.equal(scopeAllows(['base:read'], '/v1/faststore/keys/a', 'GET'), false);
    assert.equal(scopeAllows(['workflow:execute'], '/v1/workflows/w1/execute', 'POST'), true);
    assert.equal(scopeAllows(['iam:write'], '/v1/orgs/o1/accounts', 'POST'), true);
    assert.equal(scopeAllows(['iam:read'], '/v1/orgs/o1/accounts', 'POST'), false);
    // Public/auth routes are not scope-gated.
    assert.equal(scopeAllows([], '/v1/auth/login', 'POST'), true);
    assert.equal(scopeAllows([], '/health', 'GET'), true);
  });

  it('returns 403 scope_denied for a read-only API key on a write route', async () => {
    const http = await import('node:http');
    const iam = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/v1/keys/verify') {
        res.end(JSON.stringify({ valid: true, account_id: 'a1', org_id: 'o1', scopes: ['faststore:get'] }));
        return;
      }
      res.end(JSON.stringify({ ok: true }));
    });
    const upstream = http.createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, upstream: true }));
    });
    await new Promise<void>((resolve) => iam.listen(0, '127.0.0.1', resolve));
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const port = (s: any) => (typeof s.address() === 'object' ? s.address().port : 0);
    const prev = {
      IAM_SERVICE_URL: process.env.IAM_SERVICE_URL,
      FASTSTORE_SERVICE_URL: process.env.FASTSTORE_SERVICE_URL,
    };
    process.env.IAM_SERVICE_URL = `http://127.0.0.1:${port(iam)}`;
    process.env.FASTSTORE_SERVICE_URL = `http://127.0.0.1:${port(upstream)}`;
    const app = createApp();
    const gw = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base = `http://127.0.0.1:${port(gw)}`;
    try {
      const read = await fetch(`${base}/v1/faststore/keys/a`, { headers: { 'X-API-Key': 'k' } });
      assert.equal(read.status, 200);
      const write = await fetch(`${base}/v1/faststore/keys/a`, { method: 'PUT', headers: { 'X-API-Key': 'k', 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(write.status, 403);
      const denied = await write.json();
      assert.equal(denied.error, 'scope_denied');
    } finally {
      await new Promise<void>((resolve) => gw.close(() => resolve()));
      await new Promise<void>((resolve) => iam.close(() => resolve()));
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe('inference quota (#26)', () => {
  it('returns 429 + Retry-After after the per-tenant budget', async () => {
    const http = await import('node:http');
    const iam = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/v1/keys/verify') {
        res.end(JSON.stringify({ valid: true, account_id: 'a1', org_id: 'o1', scopes: ['*'] }));
        return;
      }
      res.end(JSON.stringify({ ok: true }));
    });
    const upstream = http.createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => iam.listen(0, '127.0.0.1', resolve));
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const port = (s: any) => (typeof s.address() === 'object' ? s.address().port : 0);
    const prev = {
      IAM_SERVICE_URL: process.env.IAM_SERVICE_URL,
      INFERENCE_SERVICE_URL: process.env.INFERENCE_SERVICE_URL,
      INFERENCE_RATE_LIMIT_PER_MIN: process.env.INFERENCE_RATE_LIMIT_PER_MIN,
    };
    process.env.IAM_SERVICE_URL = `http://127.0.0.1:${port(iam)}`;
    process.env.INFERENCE_SERVICE_URL = `http://127.0.0.1:${port(upstream)}`;
    process.env.INFERENCE_RATE_LIMIT_PER_MIN = '2';
    const app = createApp();
    const gw = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base = `http://127.0.0.1:${port(gw)}`;
    try {
      const hit = () => fetch(`${base}/v1/inference/chat/completions`, {
        method: 'POST',
        headers: { 'X-API-Key': 'k', 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal((await hit()).status, 200);
      assert.equal((await hit()).status, 200);
      const limited = await hit();
      assert.equal(limited.status, 429);
      assert.ok(Number(limited.headers.get('retry-after')) >= 1);
      const body = await limited.json();
      assert.equal(body.error, 'quota_exceeded');
    } finally {
      await new Promise<void>((resolve) => gw.close(() => resolve()));
      await new Promise<void>((resolve) => iam.close(() => resolve()));
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
