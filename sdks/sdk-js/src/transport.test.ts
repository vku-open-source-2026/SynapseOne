// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Transport contract tests: non-JSON guard, retries, timeouts, streaming and
 * typed health/readiness. Offline (local HTTP servers only).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { SynapseOneClient, SynapseOneError, DEFAULT_BASE_URL, parseChatDelta } from './index';

const requireCjs = createRequire(__dirname);
let server: http.Server;
let other: http.Server;
let base = '';
let otherBase = '';
let otherHits = 0;
let otherHeaders: Record<string, string | string[] | undefined> = {};
let finalHeaders: Record<string, string | string[] | undefined> = {};
let hits = new Map<string, number>();
let slowMs = 0;

before(
  () =>
    new Promise<void>((resolve) => {
      server = http
        .createServer((req, res) => {
          const url = req.url || '';
          hits.set(url, (hits.get(url) || 0) + 1);
          if (url === '/v1/redirect-same') {
            res.statusCode = 302;
            res.setHeader('Location', '/v1/final');
            res.end();
            return;
          }
          if (url === '/v1/final') {
            finalHeaders = { ...req.headers };
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, path: url }));
            return;
          }
          if (url === '/v1/redirect-cross') {
            res.statusCode = 302;
            res.setHeader('Location', `${otherBase}/capture`);
            res.end();
            return;
          }
          if (url === '/v1/redirect-loop') {
            res.statusCode = 302;
            res.setHeader('Location', '/v1/redirect-loop');
            res.end();
            return;
          }
          if (url === '/v1/stall-body') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.write('{"ok":');
            return; // headers + partial body, never finishes
          }
          if (url === '/v1/partial-body') {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '100' });
            res.write('short');
            res.socket?.destroy();
            return;
          }
          if (url === '/v1/bytes') {
            res.setHeader('Content-Type', 'application/octet-stream');
            res.end(Buffer.from([0, 1, 2, 254, 255]));
            return;
          }
          if (url === '/v1/large-json') {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ data: 'x'.repeat(200) }));
            return;
          }
          if (url === '/v1/echo-len') {
            const chunks: Buffer[] = [];
            req.on('data', (chunk) => chunks.push(chunk));
            req.on('end', () => {
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ len: Buffer.concat(chunks).length }));
            });
            return;
          }
          if (url === '/v1/orgs' && req.headers['x-test-html'] === '1') {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end('<!doctype html><html><body>console</body></html>');
            return;
          }
          if (url === '/v1/orgs' && req.headers['x-test-html'] === '2') {
            // HTML with a JSON content-type still has to be rejected by body sniffing.
            res.setHeader('Content-Type', 'application/json');
            res.end('<html><body>console</body></html>');
            return;
          }
          if (url === '/v1/flaky') {
            const n = hits.get(url) || 0;
            if (n < 3) {
              res.statusCode = 503;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'unavailable' }));
              return;
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, attempts: n }));
            return;
          }
          if (url === '/v1/retry-after') {
            const n = hits.get(url) || 0;
            if (n === 1) {
              res.statusCode = 429;
              res.setHeader('Retry-After', '0');
              res.end('{}');
              return;
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          if (url === '/v1/slow') {
            setTimeout(() => {
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ ok: true }));
            }, slowMs);
            return;
          }
          if (url === '/v1/never') {
            return; // leave the socket open
          }
          if (url === '/ready') {
            res.statusCode = 503;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ status: 'degraded', service: 'gateway', version: '0', upstreams: [{ name: 'base', ok: false }], time: 't' }));
            return;
          }
          if (url === '/health') {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ status: 'ok', service: 'gateway', version: '0', time: 't' }));
            return;
          }
          if (url === '/v1/inference/chat/completions') {
            res.setHeader('Content-Type', 'text/event-stream');
            res.write('data: {"choices":[{"delta":{"content":"he"}}]}\n\n');
            res.write('event: done\ndata: [DONE]\n\n');
            res.end();
            return;
          }
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, path: url }));
        })
        .listen(0, '127.0.0.1', () => {
          const a = server.address();
          base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
          resolve();
        });
    }),
);

before(
  () =>
    new Promise<void>((resolve) => {
      other = http
        .createServer((req, res) => {
          otherHits++;
          otherHeaders = { ...req.headers };
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, other: true }));
        })
        .listen(0, '127.0.0.1', () => {
          const a = other.address();
          otherBase = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
          resolve();
        });
    }),
);

after(() => new Promise<void>((resolve) => server.close(() => resolve())));
after(() => new Promise<void>((resolve) => other.close(() => resolve())));


describe('transport', () => {
  it('exposes the API gateway as the default URL constant', () => {
    assert.equal(DEFAULT_BASE_URL, 'https://api.synapseone.space');
  });

  it('rejects a 200 text/html response with a typed error naming the base URL', async () => {
    const c = new SynapseOneClient({ baseUrl: base, maxAttempts: 1 });
    let err: any;
    try {
      await c.http.req('/v1/orgs', { headers: { 'x-test-html': '1' } });
      assert.fail('expected a typed error');
    } catch (e: any) {
      err = e;
    }
    assert.ok(err instanceof SynapseOneError);
    assert.equal(err.code, 'non_json_response');
    assert.equal(err.status, 200);
    assert.match(err.message, /api\.synapseone\.space/);
    assert.equal(err.baseUrl, base);
  });

  it('rejects HTML bodies even when the content type says JSON', async () => {
    const c = new SynapseOneClient({ baseUrl: base, maxAttempts: 1 });
    await assert.rejects(
      () => c.http.req('/v1/orgs', { headers: { 'x-test-html': '2' } }),
      (e: any) => e instanceof SynapseOneError && e.code === 'non_json_response',
    );
  });

  it('retries idempotent requests on 503 and eventually succeeds', async () => {
    hits.delete('/v1/flaky');
    const c = new SynapseOneClient({ baseUrl: base, maxAttempts: 3, retryBaseMs: 1 });
    const out: any = await c.http.req('/v1/flaky');
    assert.equal(out.ok, true);
    assert.equal(hits.get('/v1/flaky'), 3);
  });

  it('stops after maxAttempts and surfaces the last status', async () => {
    hits.delete('/v1/flaky');
    const c = new SynapseOneClient({ baseUrl: base, maxAttempts: 2, retryBaseMs: 1 });
    await assert.rejects(() => c.http.req('/v1/flaky'), (e: any) => e.status === 503);
    assert.equal(hits.get('/v1/flaky'), 2);
  });

  it('honours Retry-After', async () => {
    hits.delete('/v1/retry-after');
    const c = new SynapseOneClient({ baseUrl: base, maxAttempts: 2, retryBaseMs: 5 });
    const out: any = await c.http.req('/v1/retry-after');
    assert.equal(out.ok, true);
    assert.equal(hits.get('/v1/retry-after'), 2);
  });

  it('does not retry non-idempotent POSTs unless asked', async () => {
    hits.delete('/v1/flaky');
    const c = new SynapseOneClient({ baseUrl: base, maxAttempts: 3, retryBaseMs: 1 });
    await assert.rejects(
      () => c.http.req('/v1/flaky', { method: 'POST', body: '{}' }),
      (e: any) => e.status === 503,
    );
    assert.equal(hits.get('/v1/flaky'), 1);
  });

  it('applies a per-call timeout override', async () => {
    const c = new SynapseOneClient({ baseUrl: base, maxAttempts: 1 });
    const started = Date.now();
    await assert.rejects(
      () => c.http.req('/v1/never', undefined, { timeoutMs: 50 }),
      (e: any) => e instanceof SynapseOneError && e.code === 'timeout',
    );
    assert.ok(Date.now() - started < 2000);
  });

  it('keeps the timeout armed while a stalled response body is read', async () => {
    const c = new SynapseOneClient({ baseUrl: base, maxAttempts: 1 });
    const started = Date.now();
    await assert.rejects(
      () => c.http.req('/v1/stall-body', undefined, { timeoutMs: 50 }),
      (e: any) => e instanceof SynapseOneError && e.code === 'timeout',
    );
    assert.ok(Date.now() - started < 2000);
  });

  it('follows same-origin redirects with credentials intact', async () => {
    const c = new SynapseOneClient({ baseUrl: base, token: 'jwt-1', apiKey: 'key-1', tenant: 'acme', maxAttempts: 1 });
    const out: any = await c.http.req('/v1/redirect-same');
    assert.equal(out.path, '/v1/final');
    assert.equal(finalHeaders['authorization'], 'Bearer jwt-1');
    assert.equal(finalHeaders['x-api-key'], 'key-1');
    assert.equal(finalHeaders['x-synapseone-tenant'], 'acme');
  });

  it('refuses an untrusted cross-origin redirect before sending anything', async () => {
    otherHits = 0;
    const c = new SynapseOneClient({ baseUrl: base, token: 'jwt-1', apiKey: 'key-1', maxAttempts: 1 });
    await assert.rejects(
      () => c.http.req('/v1/redirect-cross'),
      (e: any) => e instanceof SynapseOneError && e.code === 'redirect_not_allowed',
    );
    assert.equal(otherHits, 0);
  });

  it('follows a trusted cross-origin redirect without forwarding credentials', async () => {
    otherHits = 0;
    otherHeaders = {};
    const c = new SynapseOneClient({
      baseUrl: base,
      token: 'jwt-1',
      apiKey: 'key-1',
      tenant: 'acme',
      trustedRedirectOrigins: [otherBase],
      maxAttempts: 1,
    });
    const out: any = await c.http.req('/v1/redirect-cross');
    assert.equal(out.other, true);
    assert.equal(otherHits, 1);
    assert.equal(otherHeaders['authorization'], undefined);
    assert.equal(otherHeaders['x-api-key'], undefined);
    assert.equal(otherHeaders['x-synapseone-tenant'], undefined);
    assert.equal(otherHeaders['cookie'], undefined);
  });

  it('caps redirect loops instead of hanging', async () => {
    const c = new SynapseOneClient({ baseUrl: base, maxRedirects: 2, maxAttempts: 1 });
    await assert.rejects(
      () => c.http.req('/v1/redirect-loop'),
      (e: any) => e instanceof SynapseOneError && e.code === 'too_many_redirects',
    );
  });

  it('rejects a truncated body instead of returning partial JSON', async () => {
    const c = new SynapseOneClient({ baseUrl: base, maxAttempts: 1 });
    await assert.rejects(
      () => c.http.req('/v1/partial-body', undefined, { timeoutMs: 1000 }),
      (e: any) => e instanceof SynapseOneError && e.code === 'network_error',
    );
  });

  it('returns exact binary bytes and accepts ArrayBuffer uploads', async () => {
    const c = new SynapseOneClient({ baseUrl: base, maxAttempts: 1 });
    const bytes = await c.http.reqBinary('/v1/bytes');
    assert.deepEqual([...bytes], [0, 1, 2, 254, 255]);
    const uploaded = await c.http.upload<{ len: number }>(
      '/v1/echo-len',
      new Uint8Array([7, 8, 9]).buffer,
      { method: 'PUT' },
    );
    assert.equal(uploaded.len, 3);
  });

  it('rejects an oversized response instead of silently truncating it', async () => {
    const c = new SynapseOneClient({ baseUrl: base, maxJsonBytes: 32, maxAttempts: 1 });
    await assert.rejects(
      () => c.http.req('/v1/large-json'),
      (e: any) => e instanceof SynapseOneError && e.code === 'response_too_large',
    );
  });

  it('supports a caller AbortSignal', async () => {
    const c = new SynapseOneClient({ baseUrl: base, maxAttempts: 1 });
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 20);
    await assert.rejects(
      () => c.http.req('/v1/never', undefined, { timeoutMs: 5000, signal: ctl.signal }),
      (e: any) => e.code === 'timeout' || e.code === 'network_error',
    );
  });

  it('returns a degraded readiness payload instead of throwing (default)', async () => {
    const c = new SynapseOneClient({ baseUrl: base, maxAttempts: 1 });
    const ready = await c.health.ready();
    assert.equal(ready.status, 'degraded');
    assert.equal(ready.upstreams[0].name, 'base');
    await assert.rejects(() => c.health.ready({ throwOnDegraded: true }), (e: any) => e.status === 503);
  });

  it('projects status() into ok/tier1/upstreams', async () => {
    const c = new SynapseOneClient({ baseUrl: base, maxAttempts: 1 });
    const status = await c.health.status();
    assert.equal(status.ok, false);
    assert.equal(status.tier1.reachable, true);
    assert.equal(status.upstreams.length, 1);
  });

  it('streams SSE chat deltas without buffering', async () => {
    const c = new SynapseOneClient({ baseUrl: base, maxAttempts: 1 });
    const events: string[] = [];
    for await (const ev of c.inference.chatStream([{ role: 'user', content: 'hi' }])) {
      events.push(ev.data);
    }
    assert.equal(events.length, 2);
    assert.equal(parseChatDelta(events[0]), 'he');
    assert.equal(parseChatDelta(events[1]), null);
  });

  it('all documented package subpaths resolve', () => {
    const pkg = requireCjs(path.join(__dirname, '..', 'package.json'));
    const expected = ['.', './iam', './workflow', './ai', './lds', './base', './faststore', './queue', './stream', './inference', './health', './storage', './ocs', './notifications', './search', './warehouse', './lakehouse'];
    for (const sub of expected) {
      assert.ok(pkg.exports[sub], `missing exports entry ${sub}`);
      const target = path.join(__dirname, '..', pkg.exports[sub].require);
      assert.doesNotThrow(() => requireCjs(target), `cannot require ${sub}`);
    }
  });
});
