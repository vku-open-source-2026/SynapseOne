// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Machine-only collection prefixes (reference TS implementation).
 *
 * With `SYNAPSEONE_BASE_MACHINE_COLLECTION_PREFIXES=synapsedx_`, tenant
 * sessions (including member-minted user-bound API keys and workflow runAs
 * principals) must not see or mutate reserved collections, while account-level
 * machine keys and service-account credentials keep access. Names must never
 * leak through listing or search.
 */
process.env.SYNAPSEONE_BASE_MACHINE_COLLECTION_PREFIXES = 'synapsedx_';

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createApp } from './index';
import { __clearBaseMem } from './store';

let server: Server;
let base = '';

function userHeaders(org = 'tenant-a', sub = 'user-1'): Record<string, string> {
  return { 'content-type': 'application/json', 'x-synapseone-user': sub, 'x-synapseone-org': org, 'x-synapseone-kind': 'user' };
}

function keyHeaders(account = 'acct-a', org = 'tenant-a'): Record<string, string> {
  return { 'content-type': 'application/json', 'x-synapseone-kind': 'apikey', 'x-synapseone-account': account, 'x-synapseone-org': org };
}

function userBoundKeyHeaders(account = 'acct-a', org = 'tenant-a', owner = 'owner-1'): Record<string, string> {
  return { ...keyHeaders(account, org), 'x-synapseone-user': owner };
}

function serviceAccountHeaders(account = 'acct-a', org = 'tenant-a', sub = 'sa-1'): Record<string, string> {
  return { 'content-type': 'application/json', 'x-synapseone-kind': 'service-account', 'x-synapseone-account': account, 'x-synapseone-org': org, 'x-synapseone-user': sub };
}

async function call(method: string, path: string, body?: any, h: Record<string, string> = userHeaders()): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: h,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
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

test('reserved collections are machine-only for load, list and create', async () => {
  const machine = keyHeaders();
  const user = userHeaders();

  const created = await call('POST', '/v1/base/collections', { name: 'synapsedx_capability_audit' }, machine);
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const doc = await call('POST', '/v1/base/collections/synapsedx_capability_audit/documents', { id: 'audit-1', data: { title: 'bridge audit' } }, machine);
  assert.equal(doc.status, 201, JSON.stringify(doc.json));

  // Normal tenant collection for contrast.
  assert.equal((await call('POST', '/v1/base/collections', { name: 'assets' }, user)).status, 201);
  assert.equal((await call('POST', '/v1/base/collections/assets/documents', { id: 'asset-1', data: { title: 'bridge asset' } }, user)).status, 201);

  // Tenant session: no read, no write, no create, no query.
  assert.equal((await call('GET', '/v1/base/collections/synapsedx_capability_audit/documents/audit-1', undefined, user)).status, 404);
  assert.equal((await call('DELETE', '/v1/base/collections/synapsedx_capability_audit/documents/audit-1', undefined, user)).status, 404);
  assert.equal((await call('POST', '/v1/base/collections', { name: 'synapsedx_shadow' }, user)).status, 404);
  assert.equal((await call('POST', '/v1/base/collections/synapsedx_capability_audit/query', { limit: 10 }, user)).status, 404);

  const listed = await call('GET', '/v1/base/collections', undefined, user);
  assert.equal(listed.status, 200);
  const names = listed.json.map((c: any) => c.name);
  assert.ok(names.includes('assets'), JSON.stringify(names));
  assert.ok(!names.some((n: string) => n.startsWith('synapsedx_')), `reserved names leaked: ${JSON.stringify(names)}`);

  // A member-minted user-bound key is not machine.
  assert.equal((await call('GET', '/v1/base/collections/synapsedx_capability_audit/documents/audit-1', undefined, userBoundKeyHeaders())).status, 404);
  assert.equal((await call('POST', '/v1/base/collections', { name: 'synapsedx_userkey' }, userBoundKeyHeaders())).status, 404);

  // Account-level key and service-account credential keep access.
  assert.equal((await call('GET', '/v1/base/collections/synapsedx_capability_audit/documents/audit-1', undefined, machine)).status, 200);
  assert.equal((await call('GET', '/v1/base/collections/synapsedx_capability_audit/documents/audit-1', undefined, serviceAccountHeaders())).status, 200);
  assert.equal((await call('POST', '/v1/base/collections', { name: 'synapsedx_service_created' }, serviceAccountHeaders())).status, 201);
});

test('search never returns reserved collection rows to a tenant', async () => {
  const machine = keyHeaders();
  const user = userHeaders();
  assert.equal((await call('POST', '/v1/base/collections', { name: 'synapsedx_capability_audit' }, machine)).status, 201);
  assert.equal((await call('POST', '/v1/base/collections/synapsedx_capability_audit/documents', { id: 'audit-1', data: { title: 'bridge audit' } }, machine)).status, 201);
  assert.equal((await call('POST', '/v1/base/collections', { name: 'assets' }, user)).status, 201);
  assert.equal((await call('POST', '/v1/base/collections/assets/documents', { id: 'asset-1', data: { title: 'bridge asset' } }, user)).status, 201);

  // Machine reindexes every collection in the org (including the reserved one).
  const reindexed = await call('POST', '/v1/search/reindex', {}, machine);
  assert.equal(reindexed.status, 200, JSON.stringify(reindexed.json));

  const tenantSearch = await call('POST', '/v1/search', { query: 'bridge' }, user);
  assert.equal(tenantSearch.status, 200);
  const hits = tenantSearch.json.items as any[];
  assert.ok(hits.length > 0, JSON.stringify(tenantSearch.json));
  for (const hit of hits) {
    const collection = String(hit.metadata?.collection || '');
    assert.ok(!collection.startsWith('synapsedx_'), `reserved search row leaked: ${JSON.stringify(hit)}`);
  }

  const machineSearch = await call('POST', '/v1/search', { query: 'bridge' }, machine);
  assert.equal(machineSearch.status, 200);
  assert.ok(
    (machineSearch.json.items as any[]).some((hit) => hit.metadata?.collection === 'synapsedx_capability_audit'),
    JSON.stringify(machineSearch.json),
  );
});
