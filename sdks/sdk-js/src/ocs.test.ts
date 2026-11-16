// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/* SynapseOCS JS SDK contract tests: buckets, objects, copy, list, multipart. */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { SynapseOneClient } from './index';

let server: http.Server;
let base = '';
const calls: Array<{ method: string; path: string; body: string }> = [];

before(() => new Promise<void>((resolve) => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://x');
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      calls.push({ method: req.method || 'GET', path: url.pathname + url.search, body });
      res.setHeader('content-type', 'application/json');
      if (url.pathname === '/v1/ocs/buckets' && req.method === 'GET') {
        res.end(JSON.stringify({ buckets: [{ name: 'media', createdAt: 't' }], total: 1 }));
        return;
      }
      if (url.pathname === '/v1/ocs/buckets' && req.method === 'POST') {
        res.statusCode = 201;
        res.end(JSON.stringify({ bucket: { name: 'media', createdAt: 't' } }));
        return;
      }
      if (url.pathname.endsWith('/stats')) {
        res.end(JSON.stringify({ bucket: 'media', objects: 1, bytes: 5, quotaBytes: 100 }));
        return;
      }
      if (url.pathname.endsWith('/objects') && req.method === 'GET') {
        res.end(JSON.stringify({ bucket: 'media', prefix: '', objects: [{ key: 'a.txt', bucket: 'media', size: 5, contentType: 'text/plain', etag: 'e', createdAt: 't', updatedAt: 't' }], commonPrefixes: [], nextCursor: null }));
        return;
      }
      if (url.pathname.endsWith('/copy')) {
        res.statusCode = 201;
        res.end(JSON.stringify({ object: { key: 'b.txt', bucket: 'media', size: 5, contentType: 'text/plain', etag: 'e', createdAt: 't', updatedAt: 't' } }));
        return;
      }
      if (url.pathname.endsWith('/presign')) {
        res.end(JSON.stringify({ url: 'https://ocs.example/x', bucket: 'media', key: 'a.txt', method: 'GET', expiresIn: 60 }));
        return;
      }
      if (url.pathname.endsWith('/uploads')) {
        res.statusCode = 201;
        res.end(JSON.stringify({ uploadId: 'u1', bucket: 'media', key: 'a.txt', contentType: 'text/plain' }));
        return;
      }
      if (url.pathname.includes('/parts/')) {
        res.end(JSON.stringify({ partNumber: 1, etag: 'p1', size: 3 }));
        return;
      }
      if (url.pathname.endsWith('/complete')) {
        res.statusCode = 201;
        res.end(JSON.stringify({ object: { key: 'a.txt', bucket: 'media', size: 3, contentType: 'text/plain', etag: 'e', createdAt: 't', updatedAt: 't' } }));
        return;
      }
      if (req.method === 'PUT') {
        res.statusCode = 201;
        res.end(JSON.stringify({ object: { key: 'a.txt', bucket: 'media', size: 5, contentType: 'text/plain', etag: 'e', createdAt: 't', updatedAt: 't' } }));
        return;
      }
      if (req.method === 'HEAD') {
        res.setHeader('content-length', '5');
        res.setHeader('content-type', 'text/plain');
        res.setHeader('etag', '"e"');
        res.setHeader('x-object-key', 'a.txt');
        res.setHeader('x-ocs-bucket', 'media');
        res.end();
        return;
      }
      if (req.method === 'DELETE') {
        res.end(JSON.stringify({ ok: true, bucket: 'media', key: 'a.txt' }));
        return;
      }
      if (req.method === 'GET') {
        res.setHeader('content-type', 'text/plain');
        res.end('hello');
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  }).listen(0, '127.0.0.1', () => {
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    resolve();
  });
}));

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('SynapseOCS SDK', () => {
  it('manages buckets and stats', async () => {
    const client = new SynapseOneClient({ baseUrl: base });
    const created = await client.ocs.createBucket('media', { quotaBytes: 100 });
    assert.equal(created.bucket.name, 'media');
    const list = await client.ocs.listBuckets({ withStats: true });
    assert.equal(list.total, 1);
    const stats = await client.ocs.bucketStats('media');
    assert.equal(stats.objects, 1);
    const head = await client.ocs.headBucket('media');
    assert.equal(head?.['x-ocs-bucket'], 'media');
    await client.ocs.deleteBucket('media', { force: true });
    assert.ok(calls.some((call) => call.path.includes('force=true')));
  });

  it('puts, gets, heads, lists, copies and deletes objects', async () => {
    const client = new SynapseOneClient({ baseUrl: base });
    const object = await client.ocs.putObject('media', 'a.txt', 'hello', { contentType: 'text/plain' });
    assert.equal(object.key, 'a.txt');
    const body = await client.ocs.getObject('media', 'a.txt', { range: 'bytes=0-1' });
    assert.equal(Buffer.from(body).toString(), 'hello');
    const head = await client.ocs.headObject('media', 'a.txt');
    assert.equal(head?.etag, 'e');
    const list = await client.ocs.listObjects('media', { prefix: 'a' });
    assert.equal(list.objects[0].key, 'a.txt');
    const copy = await client.ocs.copyObject('media', { sourceKey: 'a.txt', destinationKey: 'b.txt' });
    assert.equal(copy.object.key, 'b.txt');
    await client.ocs.deleteObject('media', 'a.txt');
  });

  it('presigns and runs multipart uploads', async () => {
    const client = new SynapseOneClient({ baseUrl: base });
    const presigned = await client.ocs.presign('media', 'a.txt', { expiresIn: 60 });
    assert.equal(presigned.method, 'GET');
    const upload = await client.ocs.createMultipart('media', 'a.txt', 'text/plain');
    assert.equal(upload.uploadId, 'u1');
    const part = await client.ocs.uploadPart('media', 'u1', 'a.txt', 1, new Uint8Array([1, 2, 3]));
    assert.equal(part.etag, 'p1');
    const done = await client.ocs.completeMultipart('media', 'u1', 'a.txt', [{ partNumber: 1, etag: 'p1' }]);
    assert.equal(done.object.size, 3);
  });
});
