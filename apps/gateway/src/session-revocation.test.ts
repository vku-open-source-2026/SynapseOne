// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { validateJwtSession, validateJwtSessionDetailed, clearSessionCache } from './index';

let server: http.Server;
let base = '';
let calls = 0;
let mode: 'ok' | 'revoked' | 'down' = 'ok';

before(async () => {
  server = http.createServer((req, res) => {
    calls++;
    if (req.url !== '/v1/auth/verify') { res.writeHead(404); return res.end(); }
    if (mode === 'down') { res.writeHead(503); return res.end('down'); }
    res.writeHead(mode === 'ok' ? 200 : 401, { 'Content-Type': 'application/json' });
    const token = String(req.headers.authorization || '').replace('Bearer ', '');
    res.end(JSON.stringify(mode === 'ok' ? { valid: true, ...(token.startsWith('tok-sa') ? { org_id: 'org-sa' } : {}) } : { valid: false, error: 'token_revoked' }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
});
after(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => { clearSessionCache(); calls = 0; mode = 'ok'; });

describe('gateway JWT session revocation check', () => {
  it('accepts an active user token and caches the positive result', async () => {
    assert.equal(await validateJwtSession('tok-active', { kind: 'user', sub: 'u1' }, base), null);
    assert.equal(await validateJwtSession('tok-active', { kind: 'user', sub: 'u1' }, base), null);
    assert.equal(calls, 1);
  });

  it('rejects a revoked token', async () => {
    mode = 'revoked';
    const r = await validateJwtSession('tok-revoked', { kind: 'user', sub: 'u1' }, base);
    assert.deepEqual(r, { status: 401, error: 'token_revoked' });
  });

  it('fails closed when IAM is unavailable', async () => {
    mode = 'down';
    const r = await validateJwtSession('tok-down', { kind: 'user', sub: 'u1' }, base);
    assert.deepEqual(r, { status: 503, error: 'iam_unavailable' });
  });

  it('introspects machine service-account tokens for revocation and suspended orgs', async () => {
    const validation = await validateJwtSessionDetailed('tok-sa', { kind: 'service-account', sub: 'sa1' }, base);
    assert.equal(validation.rejection, null);
    assert.equal(validation.attributionOrg, 'org-sa');
    assert.equal(calls, 1);
    mode = 'revoked';
    const revoked = await validateJwtSession('tok-sa-2', { kind: 'service-account', sub: 'sa1' }, base);
    assert.deepEqual(revoked, { status: 401, error: 'token_revoked' });
  });

  it('returns service-account attribution directly when authorization cache TTL is zero', async () => {
    const saved = process.env.GATEWAY_SESSION_CACHE_MS;
    process.env.GATEWAY_SESSION_CACHE_MS = '0';
    try {
      for (let i = 0; i < 2; i++) {
        const validation = await validateJwtSessionDetailed('tok-sa-zero', { kind: 'service-account', sub: 'sa1' }, base);
        assert.equal(validation.rejection, null);
        assert.equal(validation.attributionOrg, 'org-sa');
      }
      assert.equal(calls, 2, 'TTL=0 must not create an authorization cache entry');
    } finally {
      if (saved === undefined) delete process.env.GATEWAY_SESSION_CACHE_MS;
      else process.env.GATEWAY_SESSION_CACHE_MS = saved;
      clearSessionCache();
    }
  });
});
