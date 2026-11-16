// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License").
 * SynapseBase API tests: boot the real Express app (memory store) and cover
 * CRUD, object<->data mapping, query operators, pagination, optimistic
 * versions, atomic increments, batch writes, changes and tenant isolation.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'http';
import http from 'node:http';
import { createApp, relayOutboxOnce } from './index';
import { __clearBaseMem } from './store';
import { __auditEvents, __clearAudit, __flushAudit } from './audit';

let server: Server;
let base = '';

function headers(org = 'tenant-a', sub = 'user-1'): Record<string, string> {
  return { 'content-type': 'application/json', 'x-synapseone-user': sub, 'x-synapseone-org': org, 'x-synapseone-kind': 'user' };
}

async function call(method: string, path: string, body?: any, h: Record<string, string> = headers(), rawBody = false): Promise<{ status: number; json: any }> {
  const payload = body === undefined ? undefined : rawBody ? String(body) : JSON.stringify(body);
  const res = await fetch(`${base}${path}`, { method, headers: h, body: payload });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json };
}

before(async () => {
  const app = createApp();
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
beforeEach(() => __clearBaseMem());

async function createCollection(extra: any = {}): Promise<any> {
  const r = await call('POST', '/v1/base/collections', { name: 'users', ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json;
}

test('health and metrics are served', async () => {
  const health = await call('GET', '/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.service, 'base');
  assert.equal(health.json.db, 'memory');
  const metrics = await fetch(`${base}/metrics`);
  assert.equal(metrics.status, 200);
  const text = await metrics.text();
  assert.match(text, /synapseone_base_up 1/);
});

test('collection CRUD + tenant isolation', async () => {
  const col = await createCollection({ description: 'Users' });
  assert.equal(col.orgId, 'tenant-a');
  assert.deepEqual(col.mapping, { additional: false, fields: {} });

  const list = await call('GET', '/v1/base/collections');
  assert.equal(list.status, 200);
  assert.equal(list.json.length, 1);

  const foreign = await call('GET', '/v1/base/collections/users', undefined, headers('tenant-b'));
  assert.equal(foreign.status, 404);
  const cross = await call('POST', '/v1/base/collections', { name: 'other', orgId: 'tenant-b' });
  assert.equal(cross.status, 403);

  const patched = await call('PATCH', '/v1/base/collections/users', { description: 'Accounts' });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.description, 'Accounts');

  const dup = await call('POST', '/v1/base/collections', { name: 'users' });
  assert.equal(dup.status, 409);

  const del = await call('DELETE', '/v1/base/collections/users');
  assert.equal(del.status, 200);
  assert.equal((await call('GET', '/v1/base/collections/users')).status, 404);
});

test('API-key headers without a user are account-scoped, never platform (#17)', async () => {
  const orgCol = await createCollection({ name: 'orgdata' });
  assert.equal(orgCol.orgId, 'tenant-a');

  const keyH = { 'content-type': 'application/json', 'x-synapseone-kind': 'apikey', 'x-synapseone-account': 'acc-9' };
  const mine = await call('POST', '/v1/base/collections', { name: 'keydata' }, keyH);
  assert.equal(mine.status, 201, JSON.stringify(mine.json));
  assert.equal(mine.json.orgId, undefined);
  assert.equal(mine.json.accountId, 'acc-9');

  // The key sees only its own account rows; filters cannot widen the scope.
  const list = await call('GET', '/v1/base/collections', undefined, keyH);
  assert.deepEqual(list.json.map((c: any) => c.name), ['keydata']);
  const widened = await call('GET', '/v1/base/collections?orgId=tenant-a', undefined, keyH);
  assert.deepEqual(widened.json, []);
  assert.equal((await call('GET', '/v1/base/collections/orgdata', undefined, keyH)).status, 404);

  // Nor can it create rows for another org/account.
  assert.equal((await call('POST', '/v1/base/collections', { name: 'evil', orgId: 'tenant-a' }, keyH)).status, 403);
  assert.equal((await call('POST', '/v1/base/collections', { name: 'evil2', accountId: 'acc-other' }, keyH)).status, 403);

  // org principals still never see account-bound rows
  assert.equal((await call('GET', '/v1/base/collections/keydata')).status, 404);
});

test('document CRUD, version conflict and atomic increment', async () => {
  await createCollection();
  const created = await call('POST', '/v1/base/collections/users/documents', { id: 'u1', data: { name: 'Alice', score: 10 } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.version, 1);

  const dup = await call('POST', '/v1/base/collections/users/documents', { id: 'u1', data: {} });
  assert.equal(dup.status, 409);

  const got = await call('GET', '/v1/base/collections/users/documents/u1');
  assert.equal(got.json.data.name, 'Alice');

  const replaced = await call('PUT', '/v1/base/collections/users/documents/u1', { data: { name: 'Alice B' }, ifVersion: 1 });
  assert.equal(replaced.status, 200);
  assert.equal(replaced.json.version, 2);
  const stale = await call('PUT', '/v1/base/collections/users/documents/u1', { data: { name: 'X' }, ifVersion: 1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error, 'version_conflict');

  const patched = await call('PATCH', '/v1/base/collections/users/documents/u1', { data: { score: 5, nickname: 'Al' }, unset: ['name'] });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.data.score, 5);
  assert.equal(patched.json.data.name, undefined);

  const inc = await call('POST', '/v1/base/collections/users/documents/u1/increment', { field: 'score', by: 7 });
  assert.equal(inc.status, 200);
  assert.equal(inc.json.data.score, 12);

  const badInc = await call('POST', '/v1/base/collections/users/documents/u1/increment', { field: 'nickname', by: 1 });
  assert.equal(badInc.status, 400);

  const del = await call('DELETE', '/v1/base/collections/users/documents/u1');
  assert.equal(del.status, 200);
  assert.equal((await call('GET', '/v1/base/collections/users/documents/u1')).status, 404);
});

test('object <-> data mapping is enforced and reversible', async () => {
  await createCollection({
    mapping: {
      fields: {
        fullName: { path: 'profile.name', type: 'string', required: true },
        age: { path: 'profile.age', type: 'number' },
        joinedAt: { path: 'meta.joinedAt', type: 'date' },
      },
    },
  });

  // Service accepts a logical object and stores nested data.
  const created = await call('POST', '/v1/base/collections/users/documents', {
    id: 'm1', object: { fullName: 'Bảo', age: 31, joinedAt: '2026-01-02T00:00:00Z' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.deepEqual(created.json.data, { profile: { name: 'Bảo', age: 31 }, meta: { joinedAt: '2026-01-02T00:00:00Z' } });

  // Reading as object returns logical fields only (no profiles/meta leakage).
  const got = await call('GET', '/v1/base/collections/users/documents/m1?as=object');
  assert.equal(got.status, 200);
  assert.deepEqual(got.json.object, { fullName: 'Bảo', age: 31, joinedAt: '2026-01-02T00:00:00Z' });

  // Missing required / wrong type / unknown key are rejected.
  const missing = await call('POST', '/v1/base/collections/users/documents', { object: { age: 1 } });
  assert.equal(missing.status, 400);
  const wrong = await call('POST', '/v1/base/collections/users/documents', { object: { fullName: 'X', age: 'old' } });
  assert.equal(wrong.status, 400);
  const unknown = await call('POST', '/v1/base/collections/users/documents', { object: { fullName: 'X', nope: 1 } });
  assert.equal(unknown.status, 400);

  // Raw data writes must satisfy the mapping required fields.
  const rawBad = await call('POST', '/v1/base/collections/users/documents', { data: { profile: { age: 2 } } });
  assert.equal(rawBad.status, 400);

  // Partial object patch.
  const patch = await call('PATCH', '/v1/base/collections/users/documents/m1', { object: { age: 32 } });
  assert.equal(patch.status, 200);
  assert.equal(patch.json.data.profile.age, 32);

  const query = await call('POST', '/v1/base/collections/users/query', { as: 'object', where: { age: { gte: 30 } } });
  assert.equal(query.status, 200);
  assert.equal(query.json.items[0].object.fullName, 'Bảo');

  const badMapping = await call('PATCH', '/v1/base/collections/users', { mapping: { fields: { x: { path: '../x' } } } });
  assert.equal(badMapping.status, 400);
  assert.equal(badMapping.json.error, 'invalid_mapping');
});

test('query: operators, ordering, projection, cursor and as=object', async () => {
  await createCollection();
  const docs = [
    { id: 'a', data: { name: 'Alpha', age: 10, tags: ['x'], nested: { city: 'Da Nang' } } },
    { id: 'b', data: { name: 'Beta', age: 20, tags: ['y'] } },
    { id: 'c', data: { name: 'Gamma', age: 30, tags: ['x', 'y'] } },
    { id: 'd', data: { name: 'Delta', age: 40 } },
  ];
  for (const d of docs) {
    const r = await call('POST', '/v1/base/collections/users/documents', d);
    assert.equal(r.status, 201);
  }

  const gt = await call('POST', '/v1/base/collections/users/query', { where: { age: { gt: 15 } }, orderBy: { field: 'age', direction: 'desc' } });
  assert.equal(gt.status, 200, JSON.stringify(gt.json));
  assert.deepEqual(gt.json.items.map((x: any) => x.id), ['d', 'c', 'b']);

  const complex = await call('POST', '/v1/base/collections/users/query', {
    where: { and: [{ age: { gte: 20 } }, { or: [{ tags: { contains: 'x' } }, { name: { startsWith: 'D' } }] }] },
  });
  assert.deepEqual(complex.json.items.map((x: any) => x.id).sort(), ['c', 'd']);

  const missing = await call('POST', '/v1/base/collections/users/query', { where: { nested: { exists: false } } });
  assert.deepEqual(missing.json.items.map((x: any) => x.id).sort(), ['b', 'c', 'd']);

  const projected = await call('POST', '/v1/base/collections/users/query', { where: { $id: { eq: 'a' } }, select: ['name', 'nested.city'] });
  assert.deepEqual(projected.json.items[0].data, { name: 'Alpha', nested: { city: 'Da Nang' } });

  const page1 = await call('POST', '/v1/base/collections/users/query', { orderBy: 'id', limit: 2 });
  assert.equal(page1.json.items.length, 2);
  assert.equal(page1.json.total, 4);
  assert.ok(page1.json.nextCursor);
  const page2 = await call('POST', '/v1/base/collections/users/query', { orderBy: 'id', limit: 2, cursor: page1.json.nextCursor });
  assert.deepEqual(page2.json.items.map((x: any) => x.id), ['c', 'd']);
  assert.equal(page2.json.nextCursor, null);

  const bad = await call('POST', '/v1/base/collections/users/query', { where: { age: { gt: 1 } }, limit: 5000 });
  assert.equal(bad.status, 400);
});

test('batch writes and change feed', async () => {
  await createCollection();
  const batch = await call('POST', '/v1/base/collections/users/documents:batch', {
    operations: [
      { op: 'create', id: 'a', data: { n: 1 } },
      { op: 'set', id: 'b', data: { n: 2 } },
      { op: 'update', id: 'b', data: { n: 3 } },
      { op: 'increment', id: 'b', field: 'n', by: 2 },
      { op: 'delete', id: 'a' },
      { op: 'nope', id: 'x' },
    ],
  });
  assert.equal(batch.status, 200);
  assert.equal(batch.json.results.length, 6);
  assert.equal(batch.json.results[0].ok, true);
  assert.equal(batch.json.results[4].ok, true);
  assert.equal(batch.json.results[5].ok, false);
  const b = await call('GET', '/v1/base/collections/users/documents/b');
  assert.equal(b.json.data.n, 5);

  const since = new Date(Date.now() - 60_000).toISOString();
  const changes = await call('GET', `/v1/base/collections/users/changes?since=${encodeURIComponent(since)}`);
  assert.equal(changes.status, 200);
  assert.ok(changes.json.changes.some((c: any) => c.id === 'b' && c.data.n === 5));
  const tombstone = changes.json.changes.find((c: any) => c.id === 'a' && c.operation === 'delete');
  assert.ok(tombstone);
  assert.equal(tombstone.deleted, true);
  assert.ok(tombstone.eventId);
  assert.ok(changes.json.nextAfter);
  const invalid = await call('GET', '/v1/base/collections/users/changes?since=nope');
  assert.equal(invalid.status, 400);
});

test('a rolled-back document write emits no outbox event', async () => {
  await createCollection();
  const first = await call('POST', '/v1/base/collections/users/documents', { id: 'dup', data: { n: 1 } });
  assert.equal(first.status, 201);
  const since = new Date(Date.now() - 60_000).toISOString();
  const before = await call('GET', `/v1/base/collections/users/changes?since=${encodeURIComponent(since)}`);
  const failed = await call('POST', '/v1/base/collections/users/documents', { id: 'dup', data: { n: 2 } });
  assert.equal(failed.status, 409);
  const after = await call('GET', `/v1/base/collections/users/changes?since=${encodeURIComponent(since)}`);
  assert.equal(after.json.changes.length, before.json.changes.length);
  assert.equal(after.json.changes.filter((c: any) => c.id === 'dup').length, 1);
});

test('outbox relay publishes once even when called twice', async () => {
  const received: any[] = [];
  const stream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST') received.push(JSON.parse(raw || '{}'));
      res.statusCode = 201;
      res.end(JSON.stringify({ ok: true, events: [] }));
    });
  });
  await new Promise<void>((resolve) => stream.listen(0, '127.0.0.1', () => resolve()));
  const addr = stream.address();
  process.env.STREAM_SERVICE_URL = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  process.env.BASE_OUTBOX_STREAM_TOPIC = 'base-changes';
  try {
    await createCollection();
    await call('POST', '/v1/base/collections/users/documents', { id: 'relay-1', data: { n: 1 } });
    const first = await relayOutboxOnce();
    assert.equal(first, 1);
    assert.equal(received.length, 1);
    assert.equal(received[0].events[0].payload.document_id, 'relay-1');
    assert.equal(received[0].events[0].payload.event_id.startsWith('backfill:'), false);
    const second = await relayOutboxOnce();
    assert.equal(second, 0);
  } finally {
    delete process.env.STREAM_SERVICE_URL;
    delete process.env.BASE_OUTBOX_STREAM_TOPIC;
    await new Promise<void>((resolve) => stream.close(() => resolve()));
  }
});

test('backfill is idempotent and produces replayable events', async () => {
  await createCollection();
  await call('POST', '/v1/base/collections/users/documents', { id: 'snap-1', data: { n: 1 } });
  const first = await call('POST', '/internal/base/collections/users/backfill', { limit: 100 });
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.equal(first.json.enqueued, 1);
  const second = await call('POST', '/internal/base/collections/users/backfill', { limit: 100 });
  assert.equal(second.status, 200);
  assert.equal(second.json.enqueued, 0);
  const changes = await call('GET', `/v1/base/collections/users/changes?since=${encodeURIComponent('1970-01-01T00:00:00.000Z')}&limit=100`);
  const backfilled = changes.json.changes.filter((c: any) => c.id === 'snap-1' && c.eventId.startsWith('backfill:'));
  assert.equal(backfilled.length, 1);
});

test('anonymous callers are rejected', async () => {
  const r = await call('GET', '/v1/base/collections', undefined, { 'x-synapseone-anon': '1' } as any);
  assert.equal(r.status, 401);
});

test('synapsebase vector: mapping validation, vector search and hybrid metadata filter', async () => {
  // 1. Create collection with vector mapping
  const col = await createCollection({
    name: 'kb_articles',
    mapping: {
      fields: {
        title: { path: 'title', type: 'string', required: true },
        category: { path: 'meta.category', type: 'string' },
        embedding: { path: 'vec', type: 'vector', dimension: 3, metric: 'cosine' },
      },
    },
  });
  assert.equal(col.name, 'kb_articles');
  assert.equal(col.mapping.fields.embedding.type, 'vector');
  assert.equal(col.mapping.fields.embedding.dimension, 3);

  // 2. Insert valid documents with vectors
  const d1 = await call('POST', '/v1/base/collections/kb_articles/documents', {
    id: 'doc1',
    object: { title: 'Intro to AI', category: 'ai', embedding: [1, 0, 0] },
  });
  assert.equal(d1.status, 201, JSON.stringify(d1.json));

  const d2 = await call('POST', '/v1/base/collections/kb_articles/documents', {
    id: 'doc2',
    object: { title: 'Database Indexing', category: 'db', embedding: [0, 1, 0] },
  });
  assert.equal(d2.status, 201);

  const d3 = await call('POST', '/v1/base/collections/kb_articles/documents', {
    id: 'doc3',
    object: { title: 'AI in Databases', category: 'ai', embedding: [0.707106, 0.707106, 0] },
  });
  assert.equal(d3.status, 201);

  // 3. Validation errors
  const badDim = await call('POST', '/v1/base/collections/kb_articles/documents', {
    id: 'bad1',
    object: { title: 'Wrong Dim', embedding: [1, 0] },
  });
  assert.equal(badDim.status, 400);
  assert.match(badDim.json.message, /dimension mismatch/);

  const nonFinite = await call('POST', '/v1/base/collections/kb_articles/documents', {
    id: 'bad2',
    object: { title: 'NaN Dim', embedding: [1, null, 0] },
  });
  assert.equal(nonFinite.status, 400);

  // 4. Vector search with cosine similarity
  const search1 = await call('POST', '/v1/base/collections/kb_articles/vector-search', {
    vector: [1, 0, 0],
    limit: 2,
  });
  assert.equal(search1.status, 200, JSON.stringify(search1.json));
  assert.equal(search1.json.items.length, 2);
  assert.equal(search1.json.items[0].id, 'doc1');
  assert.ok(search1.json.items[0].similarity > 0.99);
  assert.equal(search1.json.items[1].id, 'doc3');
  assert.ok(search1.json.items[1].similarity > 0.7);

  // 5. Hybrid search: vector search + metadata filter (category == 'db')
  const searchFiltered = await call('POST', '/v1/base/collections/kb_articles/vector-search', {
    vector: [1, 0, 0],
    where: { category: { eq: 'db' } },
    as: 'object',
  });
  assert.equal(searchFiltered.status, 200);
  assert.equal(searchFiltered.json.items.length, 1);
  assert.equal(searchFiltered.json.items[0].id, 'doc2');
  assert.equal(searchFiltered.json.items[0].object.title, 'Database Indexing');

  // 6. Vector search via POST /query with vectorSearch block
  const querySearch = await call('POST', '/v1/base/collections/kb_articles/query', {
    vectorSearch: {
      vector: [0, 1, 0],
      limit: 1,
    },
    as: 'object',
  });
  assert.equal(querySearch.status, 200);
  assert.equal(querySearch.json.items.length, 1);
  assert.equal(querySearch.json.items[0].id, 'doc2');

  // 7. Test distance metrics: L2
  const searchL2 = await call('POST', '/v1/base/collections/kb_articles/vector-search', {
    vector: [1, 0, 0],
    metric: 'l2',
  });
  assert.equal(searchL2.status, 200);
  assert.equal(searchL2.json.items[0].id, 'doc1');
  assert.equal(searchL2.json.items[0].distance, 0);
});

test('text and geospatial operators (#29)', async () => {
  await createCollection({ name: 'assets' });
  const docs = [
    { name: 'Broken streetlight', description: 'The streetlight on Main Street is broken', location: { lat: 10.7769, lng: 106.7009 } },
    { name: 'Flooded road', description: 'Road closed due to flooding', location: { lat: 10.78, lng: 106.71 } },
    { name: 'Park bench', description: 'A quiet bench in the park', location: { lat: 21.0278, lng: 105.8342 } },
  ];
  for (let i = 0; i < docs.length; i++) {
    const r = await call('POST', '/v1/base/collections/assets/documents', { id: `asset-${i}`, data: docs[i] });
    assert.equal(r.status, 201, JSON.stringify(r.json));
  }

  const text = await call('POST', '/v1/base/collections/assets/query', {
    where: { field: 'description', op: 'text', value: 'streetlight BROKEN' },
  });
  assert.equal(text.status, 200, JSON.stringify(text.json));
  assert.equal(text.json.total, 1);
  assert.equal(text.json.items[0].id, 'asset-0');

  // `$text` searches all string values, not field names (same as the SQL path).
  const anyText = await call('POST', '/v1/base/collections/assets/query', {
    where: { field: '$text', op: 'text', value: 'bench park' },
  });
  assert.equal(anyText.status, 200, JSON.stringify(anyText.json));
  assert.deepEqual(anyText.json.items.map((i: any) => i.id), ['asset-2']);

  const near = await call('POST', '/v1/base/collections/assets/query', {
    where: { field: 'location', op: 'near', value: { lat: 10.7769, lng: 106.7009, maxDistanceKm: 5 } },
  });
  assert.equal(near.status, 200, JSON.stringify(near.json));
  assert.deepEqual(near.json.items.map((i: any) => i.id).sort(), ['asset-0', 'asset-1']);

  const within = await call('POST', '/v1/base/collections/assets/query', {
    where: { field: 'location', op: 'within', value: { bbox: [106.69, 10.77, 106.72, 10.79] } },
  });
  assert.equal(within.status, 200, JSON.stringify(within.json));
  assert.deepEqual(within.json.items.map((i: any) => i.id).sort(), ['asset-0', 'asset-1']);

  const polygon = await call('POST', '/v1/base/collections/assets/query', {
    where: {
      field: 'location',
      op: 'within',
      value: { type: 'Polygon', coordinates: [[[106.69, 10.77], [106.72, 10.77], [106.72, 10.79], [106.69, 10.79], [106.69, 10.77]]] },
    },
  });
  assert.equal(polygon.status, 200, JSON.stringify(polygon.json));
  assert.equal(polygon.json.total, 2);

  const bad = await call('POST', '/v1/base/collections/assets/query', {
    where: { field: 'location', op: 'near', value: { lat: 'x' } },
  });
  assert.equal(bad.status, 400);
});

test('document listing exposes an opt-in total/cursor envelope (#29)', async () => {
  await createCollection({ name: 'paged' });
  for (let i = 0; i < 5; i++) {
    await call('POST', '/v1/base/collections/paged/documents', { id: `p-${i}`, data: { i } });
  }
  const page = await call('GET', '/v1/base/collections/paged/documents?limit=2&withTotal=1');
  assert.equal(page.status, 200);
  assert.equal(page.json.total, 5);
  assert.equal(page.json.items.length, 2);
  assert.ok(page.json.nextCursor);
  const next = await call('POST', '/v1/base/collections/paged/query', { limit: 2, cursor: page.json.nextCursor });
  assert.deepEqual(next.json.items.map((i: any) => i.id), ['p-2', 'p-3']);

  // Default stays a bare array (backwards compatible) with X-Total-Count.
  const res = await fetch(`${base}/v1/base/collections/paged/documents?limit=2`, { headers: headers() });
  assert.equal(res.headers.get('x-total-count'), '5');
  const bare = await res.json();
  assert.ok(Array.isArray(bare));
});

test('large collections are scanned in batches instead of failing at 10k (#29)', async () => {
  const { createCollectionRec, createDocumentRec, listAllDocumentRecs } = await import('./store');
  const col = await createCollectionRec({ name: 'bulk', mapping: { fields: {} }, org_id: 'bulk-org' });
  const total = 10_050;
  for (let i = 0; i < total; i++) {
    await createDocumentRec(col.id, `doc-${String(i).padStart(6, '0')}`, { i });
  }
  const docs = await listAllDocumentRecs(col.id, { max: total, pageSize: 1000 });
  assert.equal(docs.length, total);
});

test('mutation audit records actor, tenant, action and result (#32)', async () => {
  __clearAudit();
  await createCollection({ name: 'audited' });
  const created = await call('POST', '/v1/base/collections/audited/documents', {
    id: 'audit-doc',
    data: { description: 'super-secret-value' },
  });
  assert.equal(created.status, 201);
  await new Promise((r) => setImmediate(r));

  const events = __auditEvents();
  const write = events.find((e) => e.action === 'base:collections.documents:create');
  assert.ok(write, JSON.stringify(events));
  assert.equal(write.actorType, 'user');
  assert.equal(write.actorId, 'user-1');
  assert.equal(write.orgId, 'tenant-a');
  assert.equal(write.result, 'allowed');
  assert.equal(write.statusCode, 201);
  assert.equal((write.context.params as any).collection, 'audited');
  assert.ok(!JSON.stringify(events).includes('super-secret-value'), 'request bodies must never enter the audit trail');

  // Read-only POSTs (query) are not mutations.
  const before = __auditEvents().length;
  await call('POST', '/v1/base/collections/audited/query', { limit: 1 });
  await new Promise((r) => setImmediate(r));
  assert.equal(__auditEvents().length, before);

  // Failed mutations are recorded as denied.
  await call('DELETE', '/v1/base/collections/audited/documents/missing');
  await new Promise((r) => setImmediate(r));
  const denied = __auditEvents().find(
    (e) => e.action === 'base:collections.documents:delete' && e.result === 'denied',
  );
  assert.ok(denied, JSON.stringify(__auditEvents()));
  assert.equal(denied.statusCode, 404);
});

test('audit events flush to IAM with the internal secret and no PII (#32)', async () => {
  const received: any[] = [];
  const stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ headers: req.headers, body: JSON.parse(body) });
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end('{"ok":true,"accepted":1}');
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', () => resolve()));
  const addr = stub.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const savedUrl = process.env.AUDIT_INGEST_URL;
  const savedSecret = process.env.SYNAPSEONE_INTERNAL_SECRET;
  process.env.AUDIT_INGEST_URL = `http://127.0.0.1:${port}/v1/audit/ingest`;
  process.env.SYNAPSEONE_INTERNAL_SECRET = 'audit-test-secret';
  try {
    __clearAudit();
    await createCollection({ name: 'flushed' });
    await new Promise((r) => setImmediate(r));
    await __flushAudit();
    assert.equal(received.length, 1);
    assert.equal(received[0].headers['x-synapseone-internal'], 'audit-test-secret');
    const event = received[0].body.events[0];
    assert.equal(event.action, 'base:collections:create');
    assert.equal(event.actorId, 'user-1');
    assert.equal(event.orgId, 'tenant-a');
    assert.equal(event.result, 'allowed');
    assert.equal(event.statusCode, 201);
    assert.ok(!JSON.stringify(event).includes('content-type'));
  } finally {
    if (savedUrl === undefined) delete process.env.AUDIT_INGEST_URL;
    else process.env.AUDIT_INGEST_URL = savedUrl;
    if (savedSecret === undefined) delete process.env.SYNAPSEONE_INTERNAL_SECRET;
    else process.env.SYNAPSEONE_INTERNAL_SECRET = savedSecret;
    __clearAudit();
    await new Promise<void>((resolve) => stub.close(() => resolve()));
  }
});
