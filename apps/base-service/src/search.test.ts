// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Tenant-scoped search (#46): reindex, full-text/semantic modes, ACLs,
 * facets, cursor pagination and deleted-document removal.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'http';
import { createApp } from './index';
import { __clearBaseMem } from './store';
import { __clearSearchMem } from './search';

let server: Server;
let base = '';

function headers(org = 'tenant-a', sub = 'analyst-1'): Record<string, string> {
  return { 'content-type': 'application/json', 'x-synapseone-user': sub, 'x-synapseone-org': org, 'x-synapseone-kind': 'user' };
}

async function call(method: string, path: string, body?: any, h: Record<string, string> = headers()): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json };
}

async function seed(): Promise<void> {
  const col = await call('POST', '/v1/base/collections', { name: 'incidents', description: 'Incident reports' });
  assert.equal(col.status, 201, JSON.stringify(col.json));
  const docs = [
    { id: 'inc-1', data: { title: 'Bridge flooding', body: 'River levels rose above the bridge deck after heavy rain.', type: 'incident', status: 'open', acl: ['*'] } },
    { id: 'inc-2', data: { title: 'Power outage downtown', body: 'Transformer failure left three blocks without electricity.', type: 'incident', status: 'closed', acl: ['analyst-1'] } },
    { id: 'inc-3', data: { title: 'Water pump maintenance', body: 'Preventive maintenance on the north water pump station.', type: 'maintenance', status: 'open' } },
  ];
  for (const doc of docs) {
    const r = await call('POST', '/v1/base/collections/incidents/documents', doc);
    assert.equal(r.status, 201, JSON.stringify(r.json));
  }
  const colB = await call('POST', '/v1/base/collections', { name: 'secret-plans', description: 'Tenant B only' }, headers('tenant-b', 'analyst-b'));
  assert.equal(colB.status, 201, JSON.stringify(colB.json));
  const b = await call('POST', '/v1/base/collections/secret-plans/documents', { id: 'b-1', data: { title: 'Bridge plan', body: 'Tenant B bridge secret.' } }, headers('tenant-b', 'analyst-b'));
  assert.equal(b.status, 201, JSON.stringify(b.json));
}

before(async () => {
  const app = createApp();
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
beforeEach(() => { __clearBaseMem(); __clearSearchMem(); });

test('reindex is idempotent and search returns stable, highlighted hits', async () => {
  await seed();
  const first = await call('POST', '/v1/search/reindex', {});
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.equal(first.json.indexed, 3);
  const second = await call('POST', '/v1/search/reindex', {});
  assert.equal(second.status, 200);
  assert.equal(second.json.indexed, 3, 'reindex must replace, not duplicate');
  assert.equal(second.json.status.indexed, 3);

  const a = await call('POST', '/v1/search', { query: 'bridge flooding' });
  const b = await call('POST', '/v1/search', { query: 'bridge flooding' });
  assert.equal(a.status, 200);
  assert.ok(a.json.items.length >= 1);
  assert.equal(a.json.items[0].documentId, 'inc-1');
  assert.ok(a.json.items[0].highlights.includes('bridge'));
  assert.match(a.json.items[0].snippet, /<mark>bridge<\/mark>/i);
  assert.deepEqual(a.json.items.map((x: any) => x.score), b.json.items.map((x: any) => x.score));

  const status = await call('GET', '/v1/search/status');
  assert.equal(status.status, 200);
  assert.equal(status.json.indexed, 3);
  assert.equal(status.json.collections, 1);
});

test('tenant isolation and document ACLs are enforced', async () => {
  await seed();
  await call('POST', '/v1/search/reindex', {});
  await call('POST', '/v1/search/reindex', {}, headers('tenant-b', 'analyst-b'));

  const bridge = await call('POST', '/v1/search', { query: 'bridge' });
  assert.ok(bridge.json.items.every((hit: any) => hit.collectionId !== undefined));
  assert.equal(bridge.json.items.some((hit: any) => hit.documentId === 'b-1'), false);

  const privateDoc = await call('POST', '/v1/search', { query: 'transformer outage' }, headers('tenant-a', 'analyst-2'));
  assert.equal(privateDoc.json.items.some((hit: any) => hit.documentId === 'inc-2'), false, 'ACL must hide analyst-1-only doc');
  const publicDoc = await call('POST', '/v1/search', { query: 'bridge flooding' }, headers('tenant-a', 'analyst-2'));
  assert.equal(publicDoc.json.items.some((hit: any) => hit.documentId === 'inc-1'), true, 'public doc stays visible');

  const crossTenant = await call('POST', '/v1/search', { query: 'bridge' }, headers('tenant-b', 'analyst-b'));
  assert.equal(crossTenant.json.items.some((hit: any) => hit.documentId === 'inc-1'), false);
  assert.equal(crossTenant.json.items.some((hit: any) => hit.documentId === 'b-1'), true);
});

test('semantic and hybrid modes return relevant hits', async () => {
  await seed();
  await call('POST', '/v1/search/reindex', {});
  const semantic = await call('POST', '/v1/search', { query: 'electricity outage', mode: 'semantic' });
  assert.equal(semantic.status, 200);
  assert.ok(semantic.json.items.length >= 1);
  assert.equal(semantic.json.items[0].documentId, 'inc-2');
  assert.equal(semantic.json.items[0].mode, 'semantic');
  const hybrid = await call('POST', '/v1/search', { query: 'water pump', mode: 'hybrid' });
  assert.equal(hybrid.status, 200);
  assert.ok(hybrid.json.items.some((hit: any) => hit.documentId === 'inc-3'));
});

test('facets, filters and cursor pagination', async () => {
  await seed();
  await call('POST', '/v1/search/reindex', {});
  const page1 = await call('POST', '/v1/search', { query: 'incident', limit: 1 });
  assert.equal(page1.status, 200);
  assert.equal(page1.json.items.length, 1);
  assert.ok(page1.json.nextCursor);
  assert.ok(page1.json.facets.collection.length >= 1);
  assert.ok(page1.json.facets.type.some((f: any) => f.value === 'incident'));
  const page2 = await call('POST', '/v1/search', { query: 'incident', limit: 1, cursor: page1.json.nextCursor });
  assert.equal(page2.status, 200);
  assert.notEqual(page2.json.items[0].documentId, page1.json.items[0].documentId);

  const filtered = await call('POST', '/v1/search', { query: 'maintenance', filters: { status: 'open' } });
  assert.ok(filtered.json.items.every((hit: any) => hit.metadata.status === 'open'));
});

test('deleted documents disappear after reindex; empty indexes return an empty result', async () => {
  await seed();
  await call('POST', '/v1/search/reindex', {});
  const del = await call('DELETE', '/v1/base/collections/incidents/documents/inc-1');
  assert.equal(del.status, 200, JSON.stringify(del.json));
  await call('POST', '/v1/search/reindex', {});
  const result = await call('POST', '/v1/search', { query: 'bridge flooding' });
  assert.equal(result.json.items.some((hit: any) => hit.documentId === 'inc-1'), false);

  __clearBaseMem();
  __clearSearchMem();
  const empty = await call('POST', '/v1/search', { query: 'anything' });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.json.items, []);
  assert.equal(empty.json.total, 0);
});

test('anonymous callers are denied', async () => {
  const r = await call('POST', '/v1/search', { query: 'bridge' }, { 'content-type': 'application/json', 'x-synapseone-anon': '1' });
  assert.equal(r.status, 401);
});
