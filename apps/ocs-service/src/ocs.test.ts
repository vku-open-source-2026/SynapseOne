// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/* SynapseOCS: bucket, object, copy, range, list and multipart contract tests. */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { createApp } from './index';
import { createBackend } from './backend';

let server: Server;
let base = '';
let root = '';

function headers(org = 'org-a', sub = 'user-1'): Record<string, string> {
  return { 'x-synapseone-user': sub, 'x-synapseone-org': org, 'x-synapseone-kind': 'user' };
}

async function request(method: string, p: string, body?: Buffer | any, h: Record<string, string> = headers()) {
  const isRaw = Buffer.isBuffer(body);
  const res = await fetch(base + p, {
    method,
    headers: {
      ...h,
      ...(isRaw ? { 'Content-Type': h['Content-Type'] || 'application/octet-stream' } : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : isRaw ? new Uint8Array(body) : JSON.stringify(body),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json: any = null;
  try { json = buf.length ? JSON.parse(buf.toString('utf8')) : null; } catch { /* binary */ }
  return { status: res.status, json, buf, headers: res.headers };
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocs-test-'));
  const app = createApp(createBackend({ STORAGE_BACKEND: 'fs', STORAGE_FS_ROOT: root, NODE_ENV: 'test' }));
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(root, 'objects'), { recursive: true, force: true });
  fs.rmSync(path.join(root, 'meta'), { recursive: true, force: true });
  fs.rmSync(path.join(root, 'uploads'), { recursive: true, force: true });
});

test('health advertises SynapseOCS and the bucket capability', async () => {
  const health = await request('GET', '/health', undefined, {});
  assert.equal(health.status, 200);
  assert.equal(health.json.product, 'SynapseOCS');
  assert.equal(health.json.capabilities.buckets, true);
  assert.equal(health.json.backend, 'fs');
  const metrics = await request('GET', '/metrics', undefined, {});
  assert.match(metrics.buf.toString(), /synapseone_ocs_up 1/);
});

test('bucket create, list, head, stats and tenant isolation', async () => {
  const created = await request('POST', '/v1/ocs/buckets', { name: 'city-assets', quotaBytes: 4096 });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.bucket.name, 'city-assets');
  assert.equal(created.json.bucket.quotaBytes, 4096);

  const list = await request('GET', '/v1/ocs/buckets?withStats=1');
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.buckets.map((bucket: any) => bucket.name), ['city-assets', 'default']);
  const head = await request('HEAD', '/v1/ocs/buckets/city-assets');
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('x-ocs-bucket'), 'city-assets');

  const otherTenant = await request('GET', '/v1/ocs/buckets/city-assets', undefined, headers('org-b'));
  assert.equal(otherTenant.status, 404);
  const duplicate = await request('POST', '/v1/ocs/buckets', { name: 'city-assets' });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.json.error, 'bucket_exists');
  const reserved = await request('POST', '/v1/ocs/buckets', { name: 'default' });
  assert.equal(reserved.status, 409);
  const invalid = await request('POST', '/v1/ocs/buckets', { name: 'Bad Name' });
  assert.equal(invalid.status, 400);
});

test('object put/get/head/list with prefix and delimiter, range and conditional GET', async () => {
  await request('POST', '/v1/ocs/buckets', { name: 'docs' });
  const body = Buffer.from('0123456789');
  const put = await request('PUT', '/v1/ocs/buckets/docs/objects/2026/10/report.txt', body, {
    ...headers(), 'Content-Type': 'text/plain', 'x-object-checksum-sha256': '84d89877f0d4041efb6bf91a16f0248f2fd573e6af05c19f96bedb9f882f7882',
  });
  assert.equal(put.status, 201, JSON.stringify(put.json));
  assert.equal(put.json.object.bucket, 'docs');
  assert.equal(put.json.object.key, '2026/10/report.txt');

  const get = await request('GET', '/v1/ocs/buckets/docs/objects/2026/10/report.txt');
  assert.equal(get.status, 200);
  assert.equal(get.buf.toString(), '0123456789');
  const etag = get.headers.get('etag')!;
  assert.match(etag, /^".+"$/);

  const ranged = await request('GET', '/v1/ocs/buckets/docs/objects/2026/10/report.txt', undefined, { ...headers(), Range: 'bytes=2-5' });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.buf.toString(), '2345');
  assert.equal(ranged.headers.get('content-range'), 'bytes 2-5/10');

  const notModified = await request('GET', '/v1/ocs/buckets/docs/objects/2026/10/report.txt', undefined, { ...headers(), 'If-None-Match': etag });
  assert.equal(notModified.status, 304);
  const precondition = await request('GET', '/v1/ocs/buckets/docs/objects/2026/10/report.txt', undefined, { ...headers(), 'If-Match': '"nope"' });
  assert.equal(precondition.status, 412);

  const delimiter = await request('GET', '/v1/ocs/buckets/docs/objects?prefix=2026/&delimiter=/');
  assert.equal(delimiter.status, 200);
  assert.deepEqual(delimiter.json.commonPrefixes, ['2026/10/']);
  assert.equal(delimiter.json.objects.length, 0);
  const flat = await request('GET', '/v1/ocs/buckets/docs/objects?prefix=2026/');
  assert.equal(flat.json.objects.length, 1);

  const copied = await request('POST', '/v1/ocs/buckets/docs/objects/copy', {
    sourceKey: '2026/10/report.txt', destinationKey: 'archive/report.txt',
  });
  assert.equal(copied.status, 201, JSON.stringify(copied.json));
  assert.equal((await request('GET', '/v1/ocs/buckets/docs/objects/archive/report.txt')).buf.toString(), '0123456789');

  const del = await request('DELETE', '/v1/ocs/buckets/docs/objects/archive/report.txt');
  assert.equal(del.status, 200);
  assert.equal((await request('HEAD', '/v1/ocs/buckets/docs/objects/archive/report.txt')).status, 404);
});

test('bucket delete refuses non-empty buckets unless force is set', async () => {
  await request('POST', '/v1/ocs/buckets', { name: 'trash-me' });
  await request('PUT', '/v1/ocs/buckets/trash-me/objects/a.txt', Buffer.from('a'), { ...headers(), 'Content-Type': 'text/plain' });
  const refused = await request('DELETE', '/v1/ocs/buckets/trash-me');
  assert.equal(refused.status, 409);
  assert.equal(refused.json.error, 'bucket_not_empty');
  const forced = await request('DELETE', '/v1/ocs/buckets/trash-me?force=true');
  assert.equal(forced.status, 200);
  assert.equal(forced.json.deletedObjects, 1);
  assert.equal((await request('HEAD', '/v1/ocs/buckets/trash-me')).status, 404);
  const defaultDelete = await request('DELETE', '/v1/ocs/buckets/default');
  assert.equal(defaultDelete.status, 403);
});

test('multipart upload and presign are bucket-aware', async () => {
  await request('POST', '/v1/ocs/buckets', { name: 'media' });
  const created = await request('POST', '/v1/ocs/buckets/media/uploads', { key: 'video.bin', contentType: 'application/octet-stream' });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const id = created.json.uploadId;
  const part1 = await request('PUT', `/v1/ocs/buckets/media/uploads/${id}/parts/1?key=video.bin`, Buffer.alloc(10, 1), { ...headers(), 'Content-Type': 'application/octet-stream' });
  const part2 = await request('PUT', `/v1/ocs/buckets/media/uploads/${id}/parts/2?key=video.bin`, Buffer.alloc(20, 2), { ...headers(), 'Content-Type': 'application/octet-stream' });
  const completed = await request('POST', `/v1/ocs/buckets/media/uploads/${id}/complete`, {
    key: 'video.bin', parts: [{ partNumber: 1, etag: part1.json.etag }, { partNumber: 2, etag: part2.json.etag }],
  });
  assert.equal(completed.status, 201, JSON.stringify(completed.json));
  assert.equal(completed.json.object.size, 30);
  assert.equal((await request('GET', '/v1/ocs/buckets/media/objects/video.bin')).buf.length, 30);

  const presign = await request('POST', '/v1/ocs/buckets/media/presign', { key: 'video.bin', method: 'GET' });
  assert.equal(presign.status, 200, JSON.stringify(presign.json));
  const signedUrl = new URL(presign.json.url);
  assert.equal(signedUrl.pathname, '/v1/ocs/signed');
  const token = signedUrl.searchParams.get('token');
  assert.ok(token);
  const signedGet = await request('GET', `/v1/ocs/signed?token=${encodeURIComponent(token!)}`, undefined, {});
  assert.equal(signedGet.status, 200);
  assert.equal(signedGet.buf.length, 30);

  const putPresign = await request('POST', '/v1/ocs/buckets/media/presign', { key: 'signed.txt', method: 'PUT' });
  const putToken = new URL(putPresign.json.url).searchParams.get('token');
  const signedPut = await request('PUT', `/v1/ocs/signed?token=${encodeURIComponent(putToken!)}`, Buffer.from('signed'), { 'Content-Type': 'text/plain' });
  assert.equal(signedPut.status, 201, JSON.stringify(signedPut.json));
  assert.equal((await request('GET', '/v1/ocs/buckets/media/objects/signed.txt')).buf.toString(), 'signed');

  const wrongMethod = await request('DELETE', `/v1/ocs/signed?token=${encodeURIComponent(token!)}`, undefined, {});
  assert.equal(wrongMethod.status, 403);
  assert.equal(wrongMethod.json.error, 'presign_method_mismatch');
});

test('legacy storage remains the default bucket and reserved keys are rejected', async () => {
  await request('PUT', '/v1/storage/objects/legacy.txt', Buffer.from('legacy'), { ...headers(), 'Content-Type': 'text/plain' });
  const list = await request('GET', '/v1/ocs/buckets/default/objects');
  assert.equal(list.status, 200);
  assert.equal(list.json.objects.length, 1);
  assert.equal(list.json.objects[0].key, 'legacy.txt');
  assert.equal((await request('GET', '/v1/ocs/buckets/default/objects/legacy.txt')).buf.toString(), 'legacy');
  const reserved = await request('PUT', '/v1/ocs/buckets/default/objects/@ocs/evil', Buffer.from('x'), { ...headers(), 'Content-Type': 'text/plain' });
  assert.equal(reserved.status, 400);
  assert.equal(reserved.json.error, 'invalid_key');
});
