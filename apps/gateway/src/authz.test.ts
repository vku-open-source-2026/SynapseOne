// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Central authorization: action/resource mapping, audit vs enforce modes,
 * decision caching and fail-closed behavior.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { actionFor, resourceFor, authzMiddleware, clearAuthzCache, iamPrincipal, verbForMethod, type AuthzRoute } from './authz';

const base: AuthzRoute = {
  path: '/v1/base',
  service: 'base',
  actions: [{ method: 'POST', path: '/v1/base/collections/*/query', action: 'base:Read' }],
};

function fakeRes() {
  const res: any = { statusCode: 200, headers: {} as Record<string, string>, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: any) => { res.body = b; return res; };
  res.setHeader = (k: string, v: string) => { res.headers[k.toLowerCase()] = v; };
  return res;
}

async function run(mw: any, req: any) {
  const res = fakeRes();
  let nexted = false;
  await mw(req, res, () => { nexted = true; });
  return { res, nexted };
}

describe('authz mapping', () => {
  it('maps HTTP methods to verbs', () => {
    assert.equal(verbForMethod('GET'), 'Read');
    assert.equal(verbForMethod('HEAD'), 'Read');
    assert.equal(verbForMethod('DELETE'), 'Delete');
    assert.equal(verbForMethod('PUT'), 'Write');
    assert.equal(verbForMethod('PATCH'), 'Write');
  });
  it('applies per-path overrides for RPC-style POSTs', () => {
    assert.equal(actionFor(base, 'POST', '/v1/base/collections/users/query'), 'base:Read');
    assert.equal(actionFor(base, 'POST', '/v1/base/collections/users/documents'), 'base:Write');
    assert.equal(actionFor(base, 'GET', '/v1/base/collections/users/query'), 'base:Read');
    assert.equal(actionFor({ path: '/v1/x' }, 'GET', '/v1/x'), null);
  });
  it('builds tenant-qualified ARNs', () => {
    const p = { type: 'jwt' as const, sub: 'u1', org: 'org-1', account: undefined };
    assert.equal(resourceFor(base, p, '/v1/base/collections/users'), 'arn:synapseone:org-1:-:base:collections/users');
    assert.equal(resourceFor(base, p, '/v1/base'), 'arn:synapseone:org-1:-:base:');
    assert.equal(resourceFor({ path: '/v1/orgs', service: 'iam' }, p, '/v1/orgs/o1/users'), 'arn:synapseone:org-1:-:iam:orgs/o1/users');
  });
  it('principal body: keys by id, users/SAs by subject, unverifiable → null', () => {
    assert.deepEqual(iamPrincipal({ type: 'apikey', keyId: 'k1', account: 'a1' }), { kind: 'apikey', keyId: 'k1', account: 'a1' });
    assert.equal(iamPrincipal({ type: 'apikey' }), null);
    assert.equal((iamPrincipal({ type: 'jwt', kind: 'service-account', sub: 's1', scopes: ['x:*'] }) as any).kind, 'service-account');
    assert.equal((iamPrincipal({ type: 'jwt', sub: 'u1' }) as any).scopes, undefined);
  });
  it('every authenticated route in routes.yaml declares a valid service', () => {
    const doc: any = yaml.load(fs.readFileSync(path.join(__dirname, '..', 'routes.yaml'), 'utf8'));
    for (const r of doc.routes) {
      if (r.auth === 'none') continue;
      assert.match(String(r.service || ''), /^[a-z][a-z0-9-]*$/, `route ${r.path} has no service`);
      for (const o of r.actions || []) assert.match(o.action, /^[a-z][a-z0-9-]*:[A-Za-z]+$/);
    }
  });
});

describe('authz middleware', () => {
  const saved = process.env.AUTHZ_MODE;
  let calls = 0;
  let verdict = { allowed: false, reason: 'implicit-deny' };
  let fail = false;
  const decide = async () => {
    calls++;
    if (fail) throw new Error('down');
    return verdict;
  };
  const mw = authzMiddleware({ iamBase: 'http://iam', internalSecret: 's', decide });
  const req = (over: any = {}) => ({
    method: 'POST',
    path: '/v1/base/collections/c/documents',
    synapseoneRoute: { ...base, auth: 'either' },
    principal: { type: 'jwt', sub: 'u1', org: 'o1' },
    ...over,
  });

  beforeEach(() => { calls = 0; fail = false; verdict = { allowed: false, reason: 'implicit-deny' }; clearAuthzCache(); });
  afterEach(() => { if (saved === undefined) delete process.env.AUTHZ_MODE; else process.env.AUTHZ_MODE = saved; });

  it('off (default): never calls IAM', async () => {
    delete process.env.AUTHZ_MODE;
    const { nexted } = await run(mw, req());
    assert.equal(nexted, true);
    assert.equal(calls, 0);
  });

  it('enforce: deny → 403 access_denied with action/resource', async () => {
    process.env.AUTHZ_MODE = 'enforce';
    const { res, nexted } = await run(mw, req());
    assert.equal(nexted, false);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error, 'access_denied');
    assert.equal(res.body.action, 'base:Write');
    assert.equal(res.body.resource, 'arn:synapseone:o1:-:base:collections/c/documents');
  });

  it('audit: deny is flagged but the request proceeds', async () => {
    process.env.AUTHZ_MODE = 'audit';
    const { res, nexted } = await run(mw, req());
    assert.equal(nexted, true);
    assert.match(res.headers['x-synapseone-authz'], /would-deny; action=base:Write/);
  });

  it('allow decisions are cached per principal/action/resource', async () => {
    process.env.AUTHZ_MODE = 'enforce';
    verdict = { allowed: true, reason: 'policy-allow' };
    assert.equal((await run(mw, req())).nexted, true);
    assert.equal((await run(mw, req())).nexted, true);
    assert.equal(calls, 1);
    await run(mw, req({ principal: { type: 'jwt', sub: 'u2', org: 'o1' } }));
    assert.equal(calls, 2);
  });

  it('enforce fails closed when IAM is unreachable; audit fails open', async () => {
    fail = true;
    process.env.AUTHZ_MODE = 'enforce';
    const closed = await run(mw, req());
    assert.equal(closed.res.statusCode, 503);
    process.env.AUTHZ_MODE = 'audit';
    assert.equal((await run(mw, req())).nexted, true);
  });

  it('skips public routes, unauthenticated requests and routes without a service', async () => {
    process.env.AUTHZ_MODE = 'enforce';
    assert.equal((await run(mw, req({ synapseoneRoute: { path: '/v1/auth', auth: 'none' } }))).nexted, true);
    assert.equal((await run(mw, req({ principal: undefined }))).nexted, true);
    assert.equal((await run(mw, req({ synapseoneRoute: { path: '/v1/x', auth: 'either' } }))).nexted, true);
    assert.equal(calls, 0);
  });
});
