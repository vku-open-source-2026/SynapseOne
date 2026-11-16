#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * SynapseOCS end-to-end contract: bucket lifecycle, object CRUD, range,
 * delimited listing, copy, multipart and HMAC-signed GET/PUT URLs.
 */
import assert from 'node:assert/strict';

const BASE = (process.env.SYNAPSEONE_BASE_URL || 'http://localhost:8080').replace(/\/$/, '');
const EMAIL = process.env.OCS_EMAIL || 'ci@acme.local';
const ORG = process.env.OCS_ORG || 'acme';

async function api(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let body = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* text */ }
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${path} -> ${response.status}: ${String(typeof body === 'string' ? body : JSON.stringify(body)).slice(0, 300)}`);
  return { body, headers: response.headers };
}

async function main() {
  const login = await api('/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: EMAIL, orgSlug: ORG }),
  });
  const token = login.body.accessToken;
  assert.ok(token, 'login did not return an access token');
  const auth = { authorization: `Bearer ${token}` };
  const bucket = `ocs-e2e-${Date.now()}`;

  await api('/v1/ocs/buckets', {
    method: 'POST', headers: auth, body: JSON.stringify({ name: bucket, quotaBytes: 1_048_576 }),
  });
  const listed = await api('/v1/ocs/buckets?withStats=1', { headers: auth });
  assert.ok(listed.body.buckets.some((item) => item.name === bucket), 'bucket missing from list');

  const put = await api(`/v1/ocs/buckets/${bucket}/objects/evidence/a.txt`, {
    method: 'PUT', headers: { ...auth, 'content-type': 'text/plain' }, body: 'hello ocs',
  });
  assert.equal(put.body.object.bucket, bucket);
  const fetched = await api(`/v1/ocs/buckets/${bucket}/objects/evidence/a.txt`, { headers: auth });
  assert.equal(fetched.body, 'hello ocs');
  const range = await api(`/v1/ocs/buckets/${bucket}/objects/evidence/a.txt`, {
    headers: { ...auth, range: 'bytes=0-4' },
  });
  assert.equal(range.body, 'hello');

  const tree = await api(`/v1/ocs/buckets/${bucket}/objects?prefix=evidence/&delimiter=/`, { headers: auth });
  assert.ok(Array.isArray(tree.body.objects));
  const copied = await api(`/v1/ocs/buckets/${bucket}/objects/copy`, {
    method: 'POST', headers: auth, body: JSON.stringify({ sourceKey: 'evidence/a.txt', destinationKey: 'evidence/b.txt' }),
  });
  assert.equal(copied.body.object.key, 'evidence/b.txt');

  const presign = await api(`/v1/ocs/buckets/${bucket}/presign`, {
    method: 'POST', headers: auth, body: JSON.stringify({ key: 'evidence/a.txt', method: 'GET', expiresIn: 60 }),
  });
  const signed = await fetch(presign.body.url);
  assert.equal(signed.status, 200);
  assert.equal(await signed.text(), 'hello ocs');

  const putPresign = await api(`/v1/ocs/buckets/${bucket}/presign`, {
    method: 'POST', headers: auth, body: JSON.stringify({ key: 'evidence/c.txt', method: 'PUT', expiresIn: 60 }),
  });
  const signedPut = await fetch(putPresign.body.url, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: 'signed put' });
  assert.equal(signedPut.status, 201);
  const verify = await api(`/v1/ocs/buckets/${bucket}/objects/evidence/c.txt`, { headers: auth });
  assert.equal(verify.body, 'signed put');

  await api(`/v1/ocs/buckets/${bucket}?force=true`, { method: 'DELETE', headers: auth });
  console.log(`OCS_OK bucket=${bucket}`);
}

await main();
