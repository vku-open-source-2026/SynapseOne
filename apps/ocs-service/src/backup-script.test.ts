// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * tools/backup/s3-backup.mjs against an in-memory S3 API: incremental
 * snapshots, restore with Content-Type, idempotent restore and retention.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const SCRIPT = path.resolve(__dirname, '..', '..', '..', 'tools', 'backup', 's3-backup.mjs');
const CLIENT = path.resolve(__dirname, 's3.js');
const BUCKET = 'core';

type Obj = { body: Buffer; type: string; etag: string };
const store = new Map<string, Obj>();
let gets = 0;

function etagOf(body: Buffer): string {
  return createHash('md5').update(body).digest('hex');
}
function put(key: string, text: string, type: string) {
  const body = Buffer.from(text);
  store.set(key, { body, type, etag: etagOf(body) });
}
const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Minimal path-style S3 API (ListObjectsV2, GET, HEAD, PUT), SeaweedFS-style
// `&#34;` quoting in listed ETags. Signatures are not checked.
const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://x');
  const prefix = `/${BUCKET}/`;
  if (url.pathname === prefix && url.searchParams.get('list-type') === '2') {
    const p = url.searchParams.get('prefix') || '';
    const items = [...store.entries()].filter(([k]) => k.startsWith(p)).sort(([a], [b]) => a.localeCompare(b));
    const contents = items
      .map(([k, o]) => `<Contents><Key>${xmlEscape(k)}</Key><Size>${o.body.length}</Size><ETag>&#34;${o.etag}&#34;</ETag></Contents>`)
      .join('');
    res.setHeader('content-type', 'application/xml');
    res.end(`<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`);
    return;
  }
  const key = decodeURIComponent(url.pathname.slice(prefix.length));
  if (req.method === 'PUT') {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const etag = etagOf(body);
      store.set(key, { body, type: String(req.headers['content-type'] || 'application/octet-stream'), etag });
      res.setHeader('etag', `"${etag}"`);
      res.end();
    });
    return;
  }
  const o = store.get(key);
  if (!o) {
    res.statusCode = 404;
    res.end();
    return;
  }
  res.setHeader('content-type', o.type);
  res.setHeader('etag', `"${o.etag}"`);
  res.setHeader('content-length', String(o.body.length));
  if (req.method === 'HEAD') return void res.end();
  gets++;
  res.end(o.body);
});

let dir = '';
let endpoint = '';

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-backup-'));
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(dir, { recursive: true, force: true });
});

function run(...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [SCRIPT, ...args], {
      env: {
        ...process.env,
        S3_BACKUP_CLIENT_MODULE: CLIENT,
        STORAGE_S3_ENDPOINT: endpoint,
        STORAGE_S3_BUCKET: BUCKET,
        STORAGE_S3_ACCESS_KEY: 'k',
        STORAGE_S3_SECRET_KEY: 's',
        BACKUP_DIR: dir,
        BACKUP_RETENTION_DAYS: '1',
      },
    }, (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(stdout)));
  });
}

const snapshots = () => fs.readdirSync(path.join(dir, 'snapshots')).filter((n) => n.endsWith('.json')).sort();
const blobCount = () => fs.readdirSync(path.join(dir, 'blobs')).reduce((n, shard) => n + fs.readdirSync(path.join(dir, 'blobs', shard)).length, 0);
const pause = () => new Promise((r) => setTimeout(r, 1100)); // snapshot names have 1 s resolution

test('snapshots are incremental and keep Content-Type', async () => {
  put('tenants/a/doc.json', '{"v":1}', 'application/json');
  put('tenants/a/x y&z.bin', 'binary', 'application/octet-stream');
  put('tenants/b/pic', 'png', 'image/png');

  gets = 0;
  assert.match(await run('once'), /3 objects, .* \(3 downloaded, 0 unchanged\)/);
  assert.equal(gets, 3);
  await pause();
  gets = 0;
  assert.match(await run('once'), /\(0 downloaded, 3 unchanged\)/);
  assert.equal(gets, 0, 'unchanged objects are not downloaded again');

  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'snapshots', snapshots()[0]), 'utf8'));
  const byKey = Object.fromEntries(manifest.objects.map((o: { key: string }) => [o.key, o]));
  assert.equal(byKey['tenants/a/x y&z.bin'].contentType, 'application/octet-stream', 'keys arrive XML-decoded');
  assert.equal(byKey['tenants/b/pic'].contentType, 'image/png');
  assert.ok(!JSON.stringify(manifest).includes('&#34;'), 'ETags arrive XML-decoded');
});

test('restore puts objects back and is idempotent', async () => {
  const first = snapshots()[0].replace(/\.json$/, '');
  store.clear();
  assert.match(await run('restore', 'latest', '--dry-run'), /3 restored, 0 already identical, 0 failed/);
  assert.equal(store.size, 0, 'dry-run writes nothing');

  assert.match(await run('restore', 'latest'), /3 restored, 0 already identical, 0 failed/);
  assert.equal(store.get('tenants/b/pic')?.type, 'image/png');
  assert.equal(store.get('tenants/a/x y&z.bin')?.body.toString(), 'binary');
  assert.match(await run('restore', first), /0 restored, 3 already identical/);

  put('tenants/a/doc.json', '{"v":2}', 'application/json');
  assert.match(await run('restore', first, '--prefix', 'tenants/a/'), /1 restored, 1 already identical/);
  assert.equal(store.get('tenants/a/doc.json')?.body.toString(), '{"v":1}');
});

test('retention removes old snapshots and unreferenced blobs', async () => {
  // Age every existing snapshot past the 1-day retention.
  for (const name of snapshots()) {
    const file = path.join(dir, 'snapshots', name);
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    m.createdAt = '2020-01-01T00:00:00.000Z';
    fs.writeFileSync(file, JSON.stringify(m));
  }
  store.delete('tenants/b/pic');
  put('tenants/c/new.txt', 'new', 'text/plain');
  await pause();
  const out = await run('once');
  assert.match(out, /expired snapshot/);
  assert.match(out, /removed 1 unreferenced blobs/);
  assert.equal(snapshots().length, 1);
  assert.equal(blobCount(), 3);
  assert.match(await run('list'), /3 objects/);
});
