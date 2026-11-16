// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Synapse Faststore document-cache tests: fail-open misses, tenant header
 * forwarding, write/read/delete round-trip and batch invalidation.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { Server } from 'node:http';

let server: Server;
let cache: typeof import('./cache');
const stored = new Map<string, any>();
const requests: Array<{ method: string; path: string; headers: http.IncomingHttpHeaders; body: string }> = [];

function req(headers: Record<string, string> = { 'x-synapseone-org': 'tenant-a', 'x-synapseone-user': 'user-1' }): any {
  return { headers };
}

before(async () => {
  server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requests.push({ method: request.method || '', path: request.url || '', headers: request.headers, body });
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      const key = decodeURIComponent(url.pathname.split('/').pop() || '');
      response.setHeader('content-type', 'application/json');
      if (request.method === 'GET' && url.pathname.startsWith('/v1/faststore/keys/')) {
        if (!stored.has(key)) { response.statusCode = 404; response.end(JSON.stringify({ error: 'not_found' })); return; }
        response.statusCode = 200;
        response.end(JSON.stringify({ key, type: 'string', value: stored.get(key), ttlSeconds: 60 }));
        return;
      }
      if (request.method === 'PUT' && url.pathname.startsWith('/v1/faststore/keys/')) {
        if (!String(request.headers['content-type'] || '').includes('application/json')) {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: 'invalid_request', message: 'value is required' }));
          return;
        }
        const parsed = JSON.parse(body || '{}');
        stored.set(key, parsed.value);
        response.statusCode = 201;
        response.end(JSON.stringify({ ok: true, key, created: true }));
        return;
      }
      if (request.method === 'DELETE' && url.pathname.startsWith('/v1/faststore/keys/')) {
        const existed = stored.delete(key);
        response.statusCode = 200;
        response.end(JSON.stringify({ key, deleted: existed }));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/faststore/batch') {
        const parsed = JSON.parse(body || '{}');
        for (const op of parsed.operations || []) {
          if (op.op === 'delete') stored.delete(op.key);
        }
        response.statusCode = 200;
        response.end(JSON.stringify({ results: [] }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'not_found' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  process.env.FASTSTORE_SERVICE_URL = `http://127.0.0.1:${port}`;
  process.env.SYNAPSEONE_INTERNAL_SECRET = 'test-internal-secret';
  process.env.BASE_CACHE_TTL_SECONDS = '30';
  process.env.BASE_CACHE_TIMEOUT_MS = '1000';
  cache = await import('./cache');
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  stored.clear();
  requests.length = 0;
  cache.__resetCacheMetrics();
});

function doc(id = 'doc-1') {
  return {
    collection_id: 'collection-1',
    id,
    data: { name: 'Central' },
    version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

test('misses fall through and writes populate the cache', async () => {
  const first = await cache.getCachedDocument(req(), 'collection-1', 'doc-1');
  assert.equal(first, null);
  assert.equal(cache.cacheMetrics().misses, 1);

  await cache.setCachedDocument(req(), doc());
  const second = await cache.getCachedDocument(req(), 'collection-1', 'doc-1');
  assert.deepEqual(second, doc());
  assert.equal(cache.cacheMetrics().hits, 1);
});

test('forwards only tenant scope plus the internal secret', async () => {
  await cache.getCachedDocument(req({ 'x-synapseone-org': 'tenant-a', 'x-synapseone-user': 'user-1' }), 'collection-1', 'doc-1');
  const call = requests.at(-1)!;
  assert.equal(call.headers['x-synapseone-org'], 'tenant-a');
  assert.equal(call.headers['x-synapseone-user'], 'user-1');
  assert.equal(call.headers['x-synapseone-internal'], 'test-internal-secret');
  assert.equal(call.headers['authorization'], undefined);
});

test('does not call Faststore without a tenant scope', async () => {
  const result = await cache.getCachedDocument(req({}), 'collection-1', 'doc-1');
  assert.equal(result, null);
  assert.equal(requests.length, 0);
});

test('invalidates one document and a batch of documents', async () => {
  stored.set(cache.documentCacheKey('collection-1', 'doc-1'), doc());
  stored.set(cache.documentCacheKey('collection-1', 'doc-2'), doc('doc-2'));

  await cache.deleteCachedDocument(req(), 'collection-1', 'doc-1');
  assert.equal(stored.has(cache.documentCacheKey('collection-1', 'doc-1')), false);

  await cache.deleteCachedDocuments(req(), 'collection-1', ['doc-2']);
  assert.equal(stored.has(cache.documentCacheKey('collection-1', 'doc-2')), false);
  assert.equal(cache.cacheMetrics().deletes, 2);
});

test('wrongly-shaped cache values are treated as errors, not documents', async () => {
  stored.set(cache.documentCacheKey('collection-1', 'doc-1'), { collection_id: 'collection-1', id: 'doc-1' });
  const result = await cache.getCachedDocument(req(), 'collection-1', 'doc-1');
  assert.equal(result, null);
  assert.equal(cache.cacheMetrics().errors, 1);
});
