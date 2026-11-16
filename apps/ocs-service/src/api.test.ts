// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * SynapseOCS legacy default-bucket tests: tenant scoping, binary upload/download,
 * checksums, listing, quotas, multipart and presign behaviour.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { createHash } from 'node:crypto';
import { createApp, assertProductionConfig } from './index';
import { createBackend, validateKey } from './backend';
import { presignUrl } from './s3';

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
      ...(isRaw ? { 'Content-Type': h['Content-Type'] || 'image/png' } : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : isRaw ? new Uint8Array(body) : JSON.stringify(body),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json: any = null;
  try { json = buf.length ? JSON.parse(buf.toString('utf8')) : null; } catch { /* binary */ }
  return { status: res.status, json, buf, headers: res.headers };
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-test-'));
  const app = createApp(createBackend({ STORAGE_BACKEND: 'fs', STORAGE_FS_ROOT: root, NODE_ENV: 'test' }));
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(root, 'objects'), { recursive: true, force: true });
  fs.rmSync(path.join(root, 'meta'), { recursive: true, force: true });
});

test('health and metrics', async () => {
  const health = await request('GET', '/health', undefined, {});
  assert.equal(health.status, 200);
  assert.equal(health.json.service, 'storage');
  assert.equal(health.json.backend, 'fs');
  const metrics = await request('GET', '/metrics', undefined, {});
  assert.match(metrics.buf.toString(), /synapseone_storage_up 1/);
});

test('uploads, downloads, heads and deletes binary objects', async () => {
  const body = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
  const put = await request('PUT', '/v1/storage/objects/reports/2026/photo.png', body, {
    ...headers(), 'Content-Type': 'image/png', 'x-object-checksum-sha256': createHash('sha256').update(body).digest('hex'),
  });
  assert.equal(put.status, 201, JSON.stringify(put.json));
  assert.equal(put.json.object.size, body.length);
  assert.equal(put.json.object.contentType, 'image/png');

  const get = await request('GET', '/v1/storage/objects/reports/2026/photo.png');
  assert.equal(get.status, 200);
  assert.deepEqual(get.buf, body);
  assert.equal(get.headers.get('content-type'), 'image/png');
  assert.equal(get.headers.get('x-object-checksum-sha256'), createHash('sha256').update(body).digest('hex'));

  const head = await request('HEAD', '/v1/storage/objects/reports/2026/photo.png');
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(body.length));

  const list = await request('GET', '/v1/storage/objects?prefix=reports/');
  assert.equal(list.status, 200);
  assert.equal(list.json.objects.length, 1);
  assert.equal(list.json.objects[0].key, 'reports/2026/photo.png');

  const del = await request('DELETE', '/v1/storage/objects/reports/2026/photo.png');
  assert.equal(del.status, 200);
  assert.equal((await request('GET', '/v1/storage/objects/reports/2026/photo.png')).status, 404);
});

test('rejects checksum mismatch, empty bodies and traversal keys', async () => {
  const body = Buffer.from('hello');
  const bad = await request('PUT', '/v1/storage/objects/a.txt', body, { ...headers(), 'x-object-checksum-sha256': 'deadbeef' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'checksum_mismatch');

  const empty = await request('PUT', '/v1/storage/objects/empty.txt', Buffer.alloc(0));
  assert.equal(empty.status, 400);

  assert.match(String(validateKey('../etc/passwd')), /traversal/);
  assert.match(String(validateKey('/absolute')), /start/);
  assert.equal(validateKey('ok/path-1.png'), null);
});

test('enforces tenant isolation (cross-tenant ids return 404)', async () => {
  await request('PUT', '/v1/storage/objects/secret.txt', Buffer.from('tenant-a only'), {
    ...headers('org-a'), 'Content-Type': 'text/plain',
  });
  const same = await request('GET', '/v1/storage/objects/secret.txt', undefined, headers('org-a'));
  assert.equal(same.status, 200);
  const other = await request('GET', '/v1/storage/objects/secret.txt', undefined, headers('org-b'));
  assert.equal(other.status, 404);
  const otherList = await request('GET', '/v1/storage/objects', undefined, headers('org-b'));
  assert.equal(otherList.json.objects.length, 0);
});

test('multipart upload assembles parts (filesystem backend)', async () => {
  const create = await request('POST', '/v1/storage/uploads', { key: 'big/video.bin', contentType: 'application/octet-stream' });
  assert.equal(create.status, 201, JSON.stringify(create.json));
  const id = create.json.uploadId;
  const part1 = Buffer.alloc(1024, 1);
  const part2 = Buffer.alloc(2048, 2);
  const p1 = await request('PUT', `/v1/storage/uploads/${id}/parts/1?key=big/video.bin`, part1, { ...headers(), 'Content-Type': 'application/octet-stream' });
  assert.equal(p1.status, 200, JSON.stringify(p1.json));
  const p2 = await request('PUT', `/v1/storage/uploads/${id}/parts/2?key=big/video.bin`, part2, { ...headers(), 'Content-Type': 'application/octet-stream' });
  assert.equal(p2.status, 200);
  const done = await request('POST', `/v1/storage/uploads/${id}/complete`, {
    key: 'big/video.bin',
    parts: [{ partNumber: 1, etag: p1.json.etag }, { partNumber: 2, etag: p2.json.etag }],
  });
  assert.equal(done.status, 201, JSON.stringify(done.json));
  assert.equal(done.json.object.size, 3072);
  const get = await request('GET', '/v1/storage/objects/big/video.bin');
  assert.equal(get.status, 200);
  assert.equal(get.buf.length, 3072);
  assert.equal(get.buf[0], 1);
  assert.equal(get.buf[1024], 2);
});

test('presign is unavailable on the filesystem backend', async () => {
  const r = await request('POST', '/v1/storage/presign', { key: 'a.txt', method: 'GET' });
  assert.equal(r.status, 501);
  assert.equal(r.json.error, 'presign_unsupported');
});

test('S3 SigV4 presigning produces a signed URL', () => {
  const url = presignUrl({
    endpoint: 'https://s3.example.com', bucket: 'b', region: 'us-east-1',
    accessKey: 'AKIA', secretKey: 'secret', pathStyle: true,
  }, 'GET', 'tenants/x/a.png', 900, new Date('2026-01-01T00:00:00Z'));
  assert.match(url, /^https:\/\/s3\.example\.com\/b\/tenants\/x\/a\.png\?/);
  assert.match(url, /X-Amz-Algorithm=AWS4-HMAC-SHA256/);
  assert.match(url, /X-Amz-Signature=[0-9a-f]{64}/);
  assert.match(url, /X-Amz-Expires=900/);
});

test('production fails closed without secret/backend/CORS', () => {
  assert.throws(() => assertProductionConfig({ NODE_ENV: 'production' }), /SYNAPSEONE_INTERNAL_SECRET/);
  assert.throws(
    () => assertProductionConfig({ NODE_ENV: 'production', SYNAPSEONE_INTERNAL_SECRET: 's' }),
    /STORAGE_BACKEND/,
  );
  assert.throws(
    () => assertProductionConfig({ NODE_ENV: 'production', SYNAPSEONE_INTERNAL_SECRET: 's', STORAGE_BACKEND: 'fs' }),
    /CORS_ORIGIN/,
  );
  assert.doesNotThrow(() => assertProductionConfig({
    NODE_ENV: 'production', SYNAPSEONE_INTERNAL_SECRET: 's', STORAGE_BACKEND: 'fs', CORS_ORIGIN: 'https://a.example',
  }));
  assert.throws(
    () => assertProductionConfig({ NODE_ENV: 'production', SYNAPSEONE_INTERNAL_SECRET: 's', STORAGE_BACKEND: 's3', CORS_ORIGIN: 'https://a.example' }),
    /STORAGE_S3_ENDPOINT/,
  );
});
